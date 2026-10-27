package service

import (
	"fmt"
	"log/slog"
	"math"
	"math/big"
	"math/bits"
	"sort"
)

// C4a per-line refund: the sale stores, for every order line, the share of the order total
// that line is worth (order_items.net_amount). A later partial refund returns a unit at
// that share. Everything here is whole rupiah in int64; floats only appear at the edge
// (OrderItem / PricingInput are float64 like the rest of the engine).
//
// Layers:
//   - AllocateNet is the PURE integer allocator (also read by the golden fixture file
//     testdata/allocate_golden.json, which the TypeScript twin will share).
//   - DiscountComponents turns a PricingInput into per-component amounts + eligible lines,
//     mirroring the exact predicates of Compute/calcPromotionDiscount without changing them.
//   - allocateOrderLines / refundGroups glue both to createOrderCore.

// AllocLine is one sale line as the allocator sees it. Base is the line subtotal as priced
// (already includes bundle and BXGY separate-set repricing). LineNo is the 0-based index in
// the sale payload items; it breaks remainder ties (lower line_no first).
type AllocLine struct {
	LineNo int   `json:"lineNo"`
	Base   int64 `json:"base"`
}

// AllocComponent is one order-level discount component. Eligible lists the indices (into
// AllocInput.Lines) it may be spread over; nil means every line. Amount is whole rupiah.
type AllocComponent struct {
	Amount   int64 `json:"amount"`
	Eligible []int `json:"eligible"`
}

// AllocInput is the full allocator input. Total is the stored order total (after tax,
// surcharge, rounding and redeemed points) and the allocation sums to exactly this.
type AllocInput struct {
	Lines      []AllocLine      `json:"lines"`
	Components []AllocComponent `json:"components"`
	Total      int64            `json:"total"`
}

// AllocateNet spreads the order total over the lines: every net >= 0, sum(net) == Total,
// deterministic (largest remainder, ties to the lower LineNo). ok=false when no valid
// allocation exists (negative input, every line free but a positive residual, inconsistent
// totals); the caller then stores no per-line data and the order stays whole-order-refund.
//
// Steps (plan 2.4): each component is spread over its eligible lines proportional to their
// current base and subtracted (an amount above the eligible base is clamped to it); then the
// residual Total - sum(post-discount base) = tax + surcharge + rounding - redeemed points is
// spread over all lines proportional to the post-discount base, a negative residual the same
// way (it is subtracted). A line at 0 therefore stays 0.
func AllocateNet(in AllocInput) (nets []int64, ok bool) {
	n := len(in.Lines)
	if n == 0 || in.Total < 0 {
		return nil, false
	}
	cur := make([]int64, n)
	for i, l := range in.Lines {
		if l.Base < 0 {
			return nil, false
		}
		cur[i] = l.Base
	}
	for _, c := range in.Components {
		if c.Amount <= 0 {
			continue
		}
		w := make([]int64, n)
		var sum int64
		if c.Eligible == nil {
			copy(w, cur)
		} else {
			for _, idx := range c.Eligible {
				if idx < 0 || idx >= n {
					return nil, false
				}
				w[idx] = cur[idx]
			}
		}
		for _, v := range w {
			sum += v
		}
		amt := c.Amount
		if amt > sum {
			amt = sum
		}
		if amt == 0 {
			continue
		}
		shares := spreadLargestRemainder(amt, w, in.Lines)
		for i, s := range shares {
			cur[i] -= s
		}
	}

	var sum int64
	for _, v := range cur {
		sum += v
	}
	resid := in.Total - sum
	if resid != 0 {
		if sum == 0 {
			return nil, false // nothing to spread over: every line is free
		}
		mag := resid
		if mag < 0 {
			mag = -mag
		}
		if resid < 0 && mag > sum {
			return nil, false
		}
		shares := spreadLargestRemainder(mag, cur, in.Lines)
		for i, s := range shares {
			if resid > 0 {
				cur[i] += s
			} else {
				cur[i] -= s
			}
		}
	}

	var check int64
	for _, v := range cur {
		if v < 0 {
			return nil, false
		}
		check += v
	}
	if check != in.Total {
		return nil, false
	}
	return cur, true
}

// spreadLargestRemainder splits total (>= 0) over weights (>= 0, sum > 0) proportionally.
// Each line gets floor(total*w/sum); the leftover units go one each to the largest
// fractional remainders, ties to the lower LineNo (then lower index). Lines with weight 0
// never get a share, so a free line stays free.
func spreadLargestRemainder(total int64, weights []int64, lines []AllocLine) []int64 {
	n := len(weights)
	out := make([]int64, n)
	var sum int64
	for _, w := range weights {
		sum += w
	}
	if total <= 0 || sum <= 0 {
		return out
	}
	bigTotal, bigSum := big.NewInt(total), big.NewInt(sum)
	rems := make([]*big.Int, n)
	var assigned int64
	for i, w := range weights {
		if w == 0 {
			rems[i] = new(big.Int)
			continue
		}
		num := new(big.Int).Mul(bigTotal, big.NewInt(w))
		q, r := new(big.Int).QuoRem(num, bigSum, new(big.Int))
		out[i] = q.Int64()
		rems[i] = r
		assigned += out[i]
	}
	left := total - assigned
	if left <= 0 {
		return out
	}
	order := make([]int, 0, n)
	for i := range weights {
		if rems[i].Sign() > 0 {
			order = append(order, i)
		}
	}
	sort.SliceStable(order, func(a, b int) bool {
		if c := rems[order[a]].Cmp(rems[order[b]]); c != 0 {
			return c > 0
		}
		return lines[order[a]].LineNo < lines[order[b]].LineNo
	})
	for k := int64(0); k < left && int(k) < len(order); k++ {
		out[order[k]]++
	}
	return out
}

// RefundCum is the cumulative refund value of the first n of qty units of a line worth net:
// the last unit settles the exact remainder, earlier units are floored.
func RefundCum(net, qty, n int64) int64 {
	if qty <= 0 || n <= 0 || net <= 0 {
		return 0
	}
	if n >= qty {
		return net
	}
	hi, lo := bits.Mul64(uint64(net), uint64(n)) // n < qty, so hi < qty: Div64 cannot overflow
	q, _ := bits.Div64(hi, lo, uint64(qty))
	return int64(q)
}

// RefundAmountForUnits is what returning k more units is worth when prior units of this
// line were already refunded: cum(prior+k) - cum(prior). Summed over any split of the units
// it equals net exactly once all qty units are back.
func RefundAmountForUnits(net, qty, priorRefunded, k int64) int64 {
	return RefundCum(net, qty, priorRefunded+k) - RefundCum(net, qty, priorRefunded)
}

// DiscountComponents lists the order-level discount components of a sale in the order the
// allocator spreads them (each promo/code in stack order, then the manual discount), each
// with the lines it applies to. It mirrors Compute and calcPromotionDiscount exactly
// (same amounts, same eligibility predicates) but never changes them: it is a read-only
// companion, so every existing pricing result stays byte-identical.
//
// Amounts are float64 in the engine; they are rounded to whole rupiah (math.Round, half away
// from zero). Today every engine amount already is a whole number (percentages are rounded
// by the engine, fixed values are rupiah), so the rounding only matters for odd fractional
// config values; the residual spread absorbs any difference so Sum(net) == total regardless.
// The cumulative amount is capped at the subtotal, as Compute caps manual+promo.
func DiscountComponents(in PricingInput) []AllocComponent {
	var subtotal float64
	for _, i := range in.Items {
		subtotal += i.Subtotal
	}
	budget := roundRupiah(subtotal)
	var out []AllocComponent
	add := func(amount float64, eligible []int) {
		a := roundRupiah(amount)
		if a > budget {
			a = budget
		}
		if a <= 0 {
			return
		}
		budget -= a
		out = append(out, AllocComponent{Amount: a, Eligible: eligible})
	}
	for k := range in.Promos {
		p := &in.Promos[k]
		amount := calcPromotionDiscount(p, in.Items, subtotal)
		if amount <= 0 {
			continue
		}
		add(amount, promoEligibleLines(p, in.Items))
	}
	if in.ManualDiscount > 0 {
		manual := 0.0
		if in.ManualKind == DiscountPercentage {
			manual = math.Round(subtotal * (in.ManualDiscount / 100))
		} else {
			manual = math.Min(in.ManualDiscount, subtotal)
		}
		add(manual, nil) // manual applies to the whole cart
	}
	return out
}

// promoEligibleLines returns the line indices a promo's discount is attributed to, or nil
// for "every line". It uses the same predicate calcPromotionDiscount / calcBXGY use:
//   - scoped percentage/fixed/BOGO: ApplicableProductIDs via contains(ProductID) (NOT the
//     variant-aware keyMatchesLine: the engine matches scoped promos by product id only);
//   - BXGY same-set (the only BXGY that discounts here): the lines calcBXGY counted into the
//     get pool, i.e. keyMatchesLine over BuyProductIDs, or every line when that list is empty;
//   - tiered and whole-cart promos: every line (base > 0 is implicit: weight is the base).
func promoEligibleLines(p *PromoSpec, items []LineItem) []int {
	switch p.Kind {
	case DiscountBuyXGetY:
		if p.BXGY == nil || len(p.BXGY.BuyProductIDs) == 0 {
			return nil
		}
		return matchingLines(items, func(i LineItem) bool {
			return keyMatchesLine(p.BXGY.BuyProductIDs, i.ProductID, i.VariantSize)
		})
	case DiscountTiered, DiscountBundle:
		return nil
	}
	if len(p.ApplicableProductIDs) == 0 {
		return nil
	}
	return matchingLines(items, func(i LineItem) bool { return contains(p.ApplicableProductIDs, i.ProductID) })
}

func matchingLines(items []LineItem, match func(LineItem) bool) []int {
	idx := []int{}
	for i, it := range items {
		if match(it) {
			idx = append(idx, i)
		}
	}
	return idx
}

func roundRupiah(f float64) int64 { return int64(math.Round(f)) }

// maxLineNo is the largest line_no the smallint column holds.
const maxLineNo = math.MaxInt16

// allocatedLine is what createOrderCore stores per inserted order_items row.
type allocatedLine struct {
	lineNo int
	net    int64
}

// allocateOrderLines runs the allocator for the lines about to be inserted. items and
// in.Items are aligned (post reward/bundle resolution, payload order preserved); each item
// carries its payload index in payloadLine. total is the stored orders.total. ok=false (with
// a logged reason) means "store NULL line_no/net_amount for the whole order": the sale is
// never rejected for this, it just becomes whole-order-refund only.
func allocateOrderLines(items []OrderItem, pin PricingInput, total float64) (lines []allocatedLine, ok bool) {
	if len(items) == 0 || len(items) != len(pin.Items) {
		return nil, false
	}
	if math.IsNaN(total) || math.IsInf(total, 0) || math.Abs(total-math.Round(total)) > 0.004 {
		slog.Warn("per-line refund allocation skipped: order total is not whole rupiah", "total", total)
		return nil, false
	}
	in := AllocInput{Total: roundRupiah(total), Components: DiscountComponents(pin)}
	in.Lines = make([]AllocLine, len(items))
	seen := make(map[int]bool, len(items))
	for i, it := range items {
		if it.payloadLine < 0 || it.payloadLine > maxLineNo || seen[it.payloadLine] {
			slog.Warn("per-line refund allocation skipped: bad line index", "line", it.payloadLine)
			return nil, false
		}
		seen[it.payloadLine] = true
		in.Lines[i] = AllocLine{LineNo: it.payloadLine, Base: roundRupiah(pin.Items[i].Subtotal)}
	}
	nets, ok := AllocateNet(in)
	if !ok {
		slog.Warn("per-line refund allocation skipped: no valid allocation",
			"total", in.Total, "lines", len(items), "components", len(in.Components))
		return nil, false
	}
	lines = make([]allocatedLine, len(items))
	for i := range items {
		lines[i] = allocatedLine{lineNo: items[i].payloadLine, net: nets[i]}
	}
	return lines, true
}

// refundGroupInfo marks a validated promo reward line (set by resolveRewardLines /
// resolveBundleLines on the line they honoured) and carries the promo config the buy
// side of the group is matched against.
type refundGroupInfo struct {
	kind     string // "bundle" | "bxgy"
	promoID  string
	bxgy     *BXGYConfig
	bundle   *BundleConfig
	groupKey string
}

// refundGroups returns, aligned to items, the refund_group of each line ("" = none).
// One group per validated promo per order, key "<kind>:<promotionId>:1", holding that
// promo's reward line(s) plus every paid line on its buy side (all-or-nothing, D-34):
//   - bundle: paid lines matching a slot (the freed unit and its anchors go back together);
//   - bxgy separate-set: paid lines in the buy set (empty buy list = any line outside the
//     get set, as bxgyBuyUnits).
//
// Groups that share a paid line are merged (union-find) into ONE group whose key is the
// lexicographically smallest of the merged keys, so a paid anchor can never be returned
// while any reward line it helped earn is kept. Conservative by design: extra paid units
// of the same product are in the group too, which only makes a return stricter. Loyalty
// reward lines carry no group and stay independent (D-35); the C3 giveaway is not a line.
func refundGroups(items []OrderItem) []string {
	out := make([]string, len(items))
	var groups []*refundGroupInfo
	byPromo := map[string]int{} // promoID -> index into groups
	for _, it := range items {
		g := it.group
		if !it.IsReward || g == nil {
			continue
		}
		if _, dup := byPromo[g.promoID]; dup {
			continue
		}
		cp := *g
		cp.groupKey = fmt.Sprintf("%s:%s:%d", g.kind, g.promoID, 1)
		byPromo[g.promoID] = len(groups)
		groups = append(groups, &cp)
	}
	if len(groups) == 0 {
		return out
	}
	parent := make([]int, len(groups))
	for i := range parent {
		parent[i] = i
	}
	var find func(int) int
	find = func(x int) int {
		for parent[x] != x {
			parent[x] = parent[parent[x]]
			x = parent[x]
		}
		return x
	}
	// matches[i] = groups a paid line i belongs to; union every group it touches.
	matches := make([][]int, len(items))
	for i, it := range items {
		if it.IsReward {
			continue
		}
		for gi, g := range groups {
			if paidLineInGroup(g, it) {
				matches[i] = append(matches[i], gi)
			}
		}
		for _, gi := range matches[i][min(1, len(matches[i])):] {
			parent[find(gi)] = find(matches[i][0])
		}
	}
	// merged key = smallest groupKey in the component.
	rootKey := map[int]string{}
	for gi, g := range groups {
		r := find(gi)
		if k, ok := rootKey[r]; !ok || g.groupKey < k {
			rootKey[r] = g.groupKey
		}
	}
	keyOf := func(gi int) string { return rootKey[find(gi)] }
	for i, it := range items {
		if it.IsReward {
			if it.group != nil {
				out[i] = keyOf(byPromo[it.group.promoID])
			}
			continue
		}
		if len(matches[i]) > 0 {
			out[i] = keyOf(matches[i][0])
		}
	}
	return out
}

func paidLineInGroup(g *refundGroupInfo, it OrderItem) bool {
	switch g.kind {
	case "bundle":
		return g.bundle != nil && bundleSlotIndex(g.bundle, it.ProductID, it.VariantSize) >= 0
	case "bxgy":
		c := g.bxgy
		if c == nil {
			return false
		}
		if len(c.BuyProductIDs) > 0 {
			return keyMatchesLine(c.BuyProductIDs, it.ProductID, it.VariantSize)
		}
		return !keyMatchesLine(c.GetProductIDs, it.ProductID, it.VariantSize)
	}
	return false
}
