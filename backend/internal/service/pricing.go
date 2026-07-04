// Package service holds server-authoritative business logic ported verbatim
// from the legacy client (CashierScreen.tsx §9). The client/offline values are
// provisional; these functions are the single source of truth for money,
// loyalty and tier at order time.
package service

import (
	"log/slog"
	"math"
	"sort"
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

// bundleApplications reports how many complete sets `items` supports, capped by
// MaxApplications (0 = unlimited). Save-time validation rejects overlapping
// slots, so per-slot unit counting never double-claims a unit.
func bundleApplications(c *BundleConfig, items []LineItem) int {
	if c == nil || len(c.Slots) == 0 {
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
	if c == nil || c.BuyQuantity < 1 || c.GetQuantity < 1 {
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
	if c == nil || len(c.GetProductIDs) == 0 || c.BuyQuantity < 1 || c.GetQuantity < 1 {
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
