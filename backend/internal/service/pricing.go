// Package service holds server-authoritative business logic ported verbatim
// from the legacy client (CashierScreen.tsx §9). The client/offline values are
// provisional; these functions are the single source of truth for money,
// loyalty and tier at order time.
package service

import (
	"log/slog"
	"math"
	"sort"

	"github.com/mandalika/pos-backend/internal/promotionkeys"
)

// Money is whole-rupiah (IDR has no minor unit in this system). The legacy
// client computes in JS numbers with Math.round; we mirror that exactly with
// float64 + math.Round so golden-value parity holds.

type DiscountKind string

const (
	DiscountPercentage DiscountKind = "percentage"
	DiscountFixed      DiscountKind = "fixed"
	DiscountBuyXGetY   DiscountKind = "buy_x_get_y"
	DiscountTiered     DiscountKind = "tiered"
)

// LineItem mirrors CartItem for pricing. Subtotal is price*quantity as quoted
// by the client and is honored (offline price quote, plan §5).
type LineItem struct {
	ProductID   string
	VariantSize string // pid|size matching for buy_x_get_y; empty = product-level line
	Price       float64
	Quantity    int
	Subtotal    float64
}

// Tier is one threshold step in a tiered discount promotion.
type Tier struct {
	MinSubtotal float64      `json:"minSubtotal"`
	Kind        DiscountKind `json:"kind"`
	Value       float64      `json:"value"`
}

// TieredConfig holds the ordered (or unordered) tier steps for a tiered promo.
type TieredConfig struct {
	Tiers []Tier `json:"tiers"`
}

// pickTier returns the highest tier whose MinSubtotal <= sub, or nil if none.
func pickTier(c *TieredConfig, sub float64) *Tier {
	if c == nil {
		return nil
	}
	var best *Tier
	for i := range c.Tiers {
		t := &c.Tiers[i]
		if sub >= t.MinSubtotal && (best == nil || t.MinSubtotal > best.MinSubtotal) {
			best = t
		}
	}
	return best
}

const DiscountBundle DiscountKind = "bundle"

// BundleSlot is one slot of a bundle: any one of ProductKeys satisfies it,
// Quantity units per set. Keys are pid or pid|size (keyMatchesLine).
type BundleSlot struct {
	ProductKeys []string `json:"productKeys"`
	Quantity    int      `json:"quantity"`
}

// BundleConfig (promotions.bundle_config jsonb) is a fixed-price bundle: the
// consumed set is priced at BundlePrice; the saving is realized by zeroing the
// cheapest consumed units (materialized as reward lines), not a lump discount.
type BundleConfig struct {
	Slots           []BundleSlot `json:"slots"`
	BundlePrice     float64      `json:"bundlePrice"`
	MaxApplications int          `json:"maxApplications"`
}

func bundleKeysOverlap(c *BundleConfig) bool {
	if c == nil {
		return false
	}
	groups := make([][]string, 0, len(c.Slots))
	for _, slot := range c.Slots {
		groups = append(groups, slot.ProductKeys)
	}
	return promotionkeys.GroupsOverlap(groups)
}

func bxgyKeysOverlap(c *BXGYConfig) bool {
	return c != nil && promotionkeys.SetsOverlap(c.BuyProductIDs, c.GetProductIDs)
}

// bundleApplications reports how many complete sets `items` supports, capped by
// MaxApplications (0 = unlimited). Save-time validation rejects overlapping
// slots, so per-slot unit counting never double-claims a unit.
func bundleApplications(c *BundleConfig, items []LineItem) int {
	if c == nil || len(c.Slots) == 0 || bundleKeysOverlap(c) {
		return 0
	}
	n := -1
	for _, slot := range c.Slots {
		if slot.Quantity < 1 || len(slot.ProductKeys) == 0 {
			return 0
		}
		units := 0
		for _, it := range items {
			if keyMatchesLine(slot.ProductKeys, it.ProductID, it.VariantSize) {
				units += it.Quantity
			}
		}
		k := units / slot.Quantity
		if n < 0 || k < n {
			n = k
		}
	}
	if n < 0 {
		n = 0
	}
	if c.MaxApplications > 0 && n > c.MaxApplications {
		n = c.MaxApplications
	}
	return n
}

// bundleAllocate returns the NET price of each consumed unit after zeroing the
// cheapest units first until the discount D = sum(prices) - bundlePrice*nApp is
// spent. D is floored at 0. The returned slice aligns to the input order.
func bundleAllocate(prices []float64, bundlePrice float64, nApp int) []float64 {
	nets := make([]float64, len(prices))
	copy(nets, prices)
	d := 0.0
	for _, p := range prices {
		d += p
	}
	d -= bundlePrice * float64(nApp)
	if d <= 0 {
		return nets
	}
	// indices sorted by price ascending (cheapest first).
	idx := make([]int, len(prices))
	for i := range idx {
		idx[i] = i
	}
	sort.SliceStable(idx, func(a, b int) bool { return prices[idx[a]] < prices[idx[b]] })
	for _, i := range idx {
		if d <= 0 {
			break
		}
		if prices[i] <= d {
			nets[i] = 0
			d -= prices[i]
		} else {
			nets[i] = prices[i] - d
			d = 0
		}
	}
	return nets
}

// bundleFreedUnit is one physical unit the client marked GRATIS (a reward line's
// unit) under a bundle promo, carrying its catalog full price + product key.
type bundleFreedUnit struct {
	ProductID   string
	VariantSize string
	FullPrice   float64
}

// bundleSlotIndex returns the index of the first slot whose keys match
// (productID,size), or -1. Save-time rejects overlapping slots, so at most one
// slot ever matches a given unit.
func bundleSlotIndex(c *BundleConfig, productID, size string) int {
	for i, slot := range c.Slots {
		if keyMatchesLine(slot.ProductKeys, productID, size) {
			return i
		}
	}
	return -1
}

// bundleFreedNets is the PURE core of resolveBundleLines (no DB, no tx — unit
// tested). Given a bundle config, the PAID (non-reward) lines and the qty-expanded
// freed units (with their catalog full prices), it:
//
//	(a) confirms a complete set exists (bundleApplications >= 1), every freed unit
//	    is slot-eligible, no slot is over-freed, and — the security crux — no PAID
//	    eligible unit is strictly cheaper than the most expensive FREED unit in the
//	    same slot (the "free the cheapest" invariant that blocks the free-the-
//	    expensive-anchor exploit); and
//	(b) reprices each freed unit via bundleAllocate over the reconstructed CONSUMED
//	    set (freed units + the PRICIEST paid anchors needed to complete nApp sets —
//	    mirroring the POS, which keeps the pricier consumed unit as the anchor and
//	    frees the cheapest; cheaper excess paid units are STANDALONE extras outside
//	    the bundle, never over-discounted).
//
// Returns per-unit nets aligned to `freed`, ok=false on any illegality. The freed
// units are placed before anchors of equal price so equal-price ties zero the freed
// unit (customer-favouring, matches the POS-computed selection).
func bundleFreedNets(cfg *BundleConfig, paid []LineItem, freed []bundleFreedUnit) (nets []float64, ok bool) {
	if cfg == nil || len(freed) == 0 || bundleKeysOverlap(cfg) {
		return nil, false
	}

	// Application count over the combined owned units (bundleApplications ignores
	// price, so freed units carry their full price harmlessly here).
	owned := make([]LineItem, 0, len(paid)+len(freed))
	owned = append(owned, paid...)
	for _, f := range freed {
		owned = append(owned, LineItem{ProductID: f.ProductID, VariantSize: f.VariantSize, Price: f.FullPrice, Quantity: 1})
	}
	nApp := bundleApplications(cfg, owned)
	if nApp < 1 {
		return nil, false
	}

	// Partition owned units into their (single) matching slot. freedIdx>=0 indexes
	// `freed`; -1 marks a paid unit.
	type ownedUnit struct {
		price    float64
		freedIdx int
	}
	slots := make([][]ownedUnit, len(cfg.Slots))
	for i, f := range freed {
		si := bundleSlotIndex(cfg, f.ProductID, f.VariantSize)
		if si < 0 {
			return nil, false // freed unit not eligible for any slot (tamper)
		}
		slots[si] = append(slots[si], ownedUnit{price: f.FullPrice, freedIdx: i})
	}
	for _, p := range paid {
		si := bundleSlotIndex(cfg, p.ProductID, p.VariantSize)
		if si < 0 {
			continue // not part of this bundle
		}
		for n := 0; n < p.Quantity; n++ {
			slots[si] = append(slots[si], ownedUnit{price: p.Price, freedIdx: -1})
		}
	}

	// Reconstruct the flat consumed price list (across all slots) + a parallel
	// freedIdx list, then let bundleAllocate spread the single discount pool.
	var consumed []float64
	var consumedFreed []int
	for si, slot := range cfg.Slots {
		need := nApp * slot.Quantity
		var freedUnits, paidUnits []ownedUnit
		for _, u := range slots[si] {
			if u.freedIdx >= 0 {
				freedUnits = append(freedUnits, u)
			} else {
				paidUnits = append(paidUnits, u)
			}
		}
		if len(freedUnits) > need {
			return nil, false // over-freed this slot
		}
		sort.SliceStable(paidUnits, func(a, b int) bool { return paidUnits[a].price < paidUnits[b].price })
		anchorsNeeded := need - len(freedUnits)
		if anchorsNeeded > len(paidUnits) {
			return nil, false // not enough real units to complete nApp sets (guard)
		}
		// "free the cheapest of the CONSUMED set": the bundle consumes the PRICIEST
		// anchorsNeeded paid units as anchors (the tail of the ascending sort), mirroring
		// the POS, which keeps the pricier consumed unit as the anchor and frees the
		// cheapest. Cheaper paid units beyond that are STANDALONE extras bought at full
		// price outside the bundle, so they are NEVER compared — a cashier may make a
		// pricier eligible unit the freebie and pay full price for a cheaper eligible unit
		// as an ordinary standalone item. No unit actually CONSUMED as an anchor may be
		// cheaper than a freed unit: freeing a pricier consumed unit while a cheaper
		// CONSUMED unit stays paid would underpay the set (the real exploit) → reject.
		anchors := paidUnits[len(paidUnits)-anchorsNeeded:] // priciest anchorsNeeded; empty when anchorsNeeded==0
		if len(freedUnits) > 0 && anchorsNeeded > 0 {
			maxFreed := 0.0
			for _, f := range freedUnits {
				if f.price > maxFreed {
					maxFreed = f.price
				}
			}
			for _, p := range anchors {
				if p.price < maxFreed {
					return nil, false
				}
			}
		}
		for _, f := range freedUnits { // freed first → equal-price ties zero the freed unit
			consumed = append(consumed, f.price)
			consumedFreed = append(consumedFreed, f.freedIdx)
		}
		for _, p := range anchors {
			consumed = append(consumed, p.price)
			consumedFreed = append(consumedFreed, -1)
		}
	}

	allocated := bundleAllocate(consumed, cfg.BundlePrice, nApp)
	nets = make([]float64, len(freed))
	for i, fi := range consumedFreed {
		if fi >= 0 {
			nets[fi] = allocated[i]
		}
	}
	return nets, true
}

// BXGYConfig is the buy_x_get_y rule (stored as promotions.bxgy_config jsonb).
type BXGYConfig struct {
	BuyQuantity      int          `json:"buyQuantity"`
	GetQuantity      int          `json:"getQuantity"`
	BuyProductIDs    []string     `json:"buyProductIds"`
	GetProductIDs    []string     `json:"getProductIds"`
	GetDiscountKind  DiscountKind `json:"getDiscountKind"`
	GetDiscountValue float64      `json:"getDiscountValue"`
	MaxApplications  int          `json:"maxApplications"`
}

// PromoSpec is the resolved promotion (from a Promotion or a DiscountCode).
type PromoSpec struct {
	Kind                 DiscountKind // percentage | fixed | bogo | buy_x_get_y | tiered
	Value                float64
	ApplicableProductIDs []string // empty = applies to whole cart
	IsBOGO               bool
	BXGY                 *BXGYConfig
	Tiered               *TieredConfig
	Bundle               *BundleConfig
}

type PricingInput struct {
	Items           []LineItem
	ManualDiscount  float64      // discountRunning
	ManualKind      DiscountKind // discountType (manual discount only)
	Surcharge       float64      // surchargeRunning
	SurchargeKind   DiscountKind // surchargeType (independent of discount)
	Promos          []PromoSpec  // applied promotions/codes; additive, empty = none
	TaxEnabled      bool
	TaxRate         float64 // percent, e.g. 11
	RoundingEnabled bool
	RoundingType    string // nearest_1000 | nearest_500 | none
	LoyaltyEnabled  bool
	PointsPerK      float64 // pointsPerThousand
	HasCustomer     bool
}

type PricingResult struct {
	Subtotal        float64 `json:"subtotal"`
	ManualDiscount  float64 `json:"manualDiscount"`
	PromoDiscount   float64 `json:"promoDiscount"`
	DiscountAmount  float64 `json:"discountAmount"`
	TaxableAmount   float64 `json:"taxableAmount"`
	TaxAmount       float64 `json:"taxAmount"`
	SurchargeAmount float64 `json:"surchargeAmount"`
	Total           float64 `json:"total"`
	EarnedPoints    int     `json:"earnedPoints"`
}

// contains reports membership; mirrors Array.includes.
func contains(ids []string, id string) bool {
	for _, v := range ids {
		if v == id {
			return true
		}
	}
	return false
}

// keyMatchesLine: a "pid" key matches any variant; a "pid|size" key matches that variant only.
func keyMatchesLine(keys []string, productID, size string) bool {
	if contains(keys, productID) {
		return true
	}
	return size != "" && contains(keys, variantKey(productID, size))
}

func bxgyExpand(items []LineItem, keys []string, emptyMatchesAll bool) []float64 {
	var prices []float64
	for _, i := range items {
		match := emptyMatchesAll
		if len(keys) > 0 {
			match = keyMatchesLine(keys, i.ProductID, i.VariantSize)
		}
		if !match {
			continue
		}
		for n := 0; n < i.Quantity; n++ {
			prices = append(prices, i.Price)
		}
	}
	return prices
}

func calcBXGY(c *BXGYConfig, items []LineItem) float64 {
	if c == nil || c.BuyQuantity < 1 || c.GetQuantity < 1 || bxgyKeysOverlap(c) {
		slog.Warn("buy_x_get_y: invalid config, 0 discount", "config", c)
		return 0
	}
	var getPool []float64
	var nApp int
	if len(c.GetProductIDs) == 0 {
		pool := bxgyExpand(items, c.BuyProductIDs, true)
		nApp = len(pool) / (c.BuyQuantity + c.GetQuantity)
		getPool = pool
	} else {
		var buyPool []float64
		if len(c.BuyProductIDs) == 0 {
			for _, i := range items {
				if keyMatchesLine(c.GetProductIDs, i.ProductID, i.VariantSize) {
					continue
				}
				for n := 0; n < i.Quantity; n++ {
					buyPool = append(buyPool, i.Price)
				}
			}
		} else {
			buyPool = bxgyExpand(items, c.BuyProductIDs, false)
		}
		getPool = bxgyExpand(items, c.GetProductIDs, false)
		nApp = len(buyPool) / c.BuyQuantity
		if g := len(getPool) / c.GetQuantity; g < nApp {
			nApp = g
		}
	}
	if c.MaxApplications > 0 && nApp > c.MaxApplications {
		nApp = c.MaxApplications
	}
	if nApp <= 0 {
		return 0
	}
	nDiscount := nApp * c.GetQuantity
	sort.Float64s(getPool)
	if nDiscount > len(getPool) {
		nDiscount = len(getPool)
	}
	var total float64
	for k := 0; k < nDiscount; k++ {
		switch c.GetDiscountKind {
		case DiscountPercentage:
			total += math.Round(getPool[k] * (c.GetDiscountValue / 100))
		case DiscountFixed:
			total += math.Min(c.GetDiscountValue, getPool[k])
		}
	}
	return total
}

// bxgyBuyUnits counts qty-expanded paid units that satisfy the buy set. Empty
// BuyProductIDs => any unit NOT in the get set (buy∩get overlap is rejected at save).
func bxgyBuyUnits(c *BXGYConfig, items []LineItem) int {
	n := 0
	for _, i := range items {
		var isBuy bool
		if len(c.BuyProductIDs) > 0 {
			isBuy = keyMatchesLine(c.BuyProductIDs, i.ProductID, i.VariantSize)
		} else {
			isBuy = !keyMatchesLine(c.GetProductIDs, i.ProductID, i.VariantSize)
		}
		if isBuy {
			n += i.Quantity
		}
	}
	return n
}

// bxgyRewardDue is the number of reward units the cart earns (separate-set only).
func bxgyRewardDue(c *BXGYConfig, items []LineItem) int {
	if c == nil || len(c.GetProductIDs) == 0 || c.BuyQuantity < 1 || c.GetQuantity < 1 || bxgyKeysOverlap(c) {
		return 0
	}
	nApp := bxgyBuyUnits(c, items) / c.BuyQuantity
	if c.MaxApplications > 0 && nApp > c.MaxApplications {
		nApp = c.MaxApplications
	}
	if nApp < 0 {
		nApp = 0
	}
	return nApp * c.GetQuantity
}

// bxgyRewardNet is the per-unit price charged for a reward (0 for free).
func bxgyRewardNet(c *BXGYConfig, fullPrice float64) float64 {
	switch c.GetDiscountKind {
	case DiscountPercentage:
		return fullPrice - math.Round(fullPrice*(c.GetDiscountValue/100))
	case DiscountFixed:
		if n := fullPrice - c.GetDiscountValue; n > 0 {
			return n
		}
		return 0
	}
	return fullPrice
}

// calcPromotionDiscount ports CashierScreen.tsx:335-349 exactly.
func calcPromotionDiscount(p *PromoSpec, items []LineItem, sub float64) float64 {
	if p.Kind == DiscountBuyXGetY {
		// separate-set is fulfilled as a priced reward LINE (the saving lives in
		// that line's reduced price), so the promo itself contributes 0 here;
		// same-set still discounts the cheapest in-cart unit.
		if p.BXGY != nil && len(p.BXGY.GetProductIDs) > 0 {
			return 0
		}
		return calcBXGY(p.BXGY, items)
	}
	if p.Kind == DiscountTiered {
		t := pickTier(p.Tiered, sub)
		if t == nil {
			return 0
		}
		switch t.Kind {
		case DiscountPercentage:
			return math.Round(sub * (t.Value / 100))
		case DiscountFixed:
			return math.Min(t.Value, sub)
		}
		return 0
	}
	if p.Kind == DiscountBundle {
		// The saving is realized as zeroed reward lines (server resolveBundleLines),
		// so the promo itself contributes 0 to the additive discount stack — same
		// rationale as buy_x_get_y separate-set. Prevents double-discount.
		return 0
	}
	scoped := len(p.ApplicableProductIDs) > 0
	matching := items
	if scoped {
		matching = nil
		for _, i := range items {
			if contains(p.ApplicableProductIDs, i.ProductID) {
				matching = append(matching, i)
			}
		}
	}
	var matchingSub float64
	for _, i := range matching {
		matchingSub += i.Subtotal
	}
	if len(matching) == 0 && scoped {
		return 0
	}
	if p.IsBOGO {
		// cheapest of qty-expanded matching prices when >= 2 units.
		prices := []float64{}
		for _, i := range matching {
			for n := 0; n < i.Quantity; n++ {
				prices = append(prices, i.Price)
			}
		}
		if len(prices) < 2 {
			return 0
		}
		min := prices[0]
		for _, v := range prices {
			if v < min {
				min = v
			}
		}
		return min
	}
	switch p.Kind {
	case DiscountPercentage:
		base := sub
		if len(matching) > 0 {
			base = matchingSub
		}
		return math.Round(base * (p.Value / 100))
	case DiscountFixed:
		return math.Min(p.Value, sub)
	}
	return 0
}

// Compute ports the cashier total pipeline (CashierScreen.tsx:320-389).
func Compute(in PricingInput) PricingResult {
	var subtotal float64
	for _, i := range in.Items {
		subtotal += i.Subtotal
	}

	manual := 0.0
	if in.ManualDiscount > 0 {
		if in.ManualKind == DiscountPercentage {
			manual = math.Round(subtotal * (in.ManualDiscount / 100))
		} else {
			manual = math.Min(in.ManualDiscount, subtotal)
		}
	}

	surcharge := 0.0
	if in.Surcharge > 0 {
		if in.SurchargeKind == DiscountPercentage {
			surcharge = math.Round(subtotal * (in.Surcharge / 100))
		} else {
			surcharge = in.Surcharge
		}
	}

	promo := 0.0
	for i := range in.Promos {
		promo += calcPromotionDiscount(&in.Promos[i], in.Items, subtotal)
	}

	discount := math.Min(manual+promo, subtotal)
	taxable := subtotal - discount
	tax := 0.0
	if in.TaxEnabled {
		tax = math.Round(taxable * (in.TaxRate / 100))
	}
	total := taxable + tax + surcharge
	if in.RoundingEnabled {
		roundTo := 1.0
		switch in.RoundingType {
		case "nearest_1000":
			roundTo = 1000
		case "nearest_500":
			roundTo = 500
		}
		total = math.Round(total/roundTo) * roundTo
	}

	points := 0
	if in.LoyaltyEnabled && in.HasCustomer {
		points = int(math.Floor(total/1000) * in.PointsPerK)
	}

	return PricingResult{
		Subtotal:        subtotal,
		ManualDiscount:  manual,
		PromoDiscount:   promo,
		DiscountAmount:  discount,
		TaxableAmount:   taxable,
		TaxAmount:       tax,
		SurchargeAmount: surcharge,
		Total:           total,
		EarnedPoints:    points,
	}
}

// CustomerTier ports getTier (CashierScreen.tsx:385-389).
func CustomerTier(totalSpent float64) string {
	switch {
	case totalSpent >= 5_000_000:
		return "Platinum"
	case totalSpent >= 2_000_000:
		return "Gold"
	case totalSpent >= 500_000:
		return "Silver"
	default:
		return "Member"
	}
}
