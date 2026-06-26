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
	Kind                 DiscountKind // percentage | fixed | bogo | buy_x_get_y
	Value                float64
	ApplicableProductIDs []string // empty = applies to whole cart
	IsBOGO               bool
	BXGY                 *BXGYConfig
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
		return calcBXGY(p.BXGY, items)
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

// Tier ports getTier (CashierScreen.tsx:385-389).
func Tier(totalSpent float64) string {
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
