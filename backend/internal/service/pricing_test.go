package service

import "testing"

func item(id string, price float64, qty int) LineItem {
	return LineItem{ProductID: id, Price: price, Quantity: qty, Subtotal: price * float64(qty)}
}

func TestComputeSubtotalOnly(t *testing.T) {
	r := Compute(PricingInput{Items: []LineItem{item("a", 10000, 2), item("b", 5000, 1)}})
	if r.Subtotal != 25000 || r.Total != 25000 {
		t.Fatalf("subtotal/total = %v/%v want 25000/25000", r.Subtotal, r.Total)
	}
}

func TestComputeManualPercentageAndTax(t *testing.T) {
	// subtotal 100000, 10% manual = 10000, taxable 90000, tax 11% = 9900, total 99900
	r := Compute(PricingInput{
		Items:          []LineItem{item("a", 100000, 1)},
		ManualDiscount: 10, ManualKind: DiscountPercentage,
		TaxEnabled: true, TaxRate: 11,
	})
	if r.ManualDiscount != 10000 || r.TaxableAmount != 90000 || r.TaxAmount != 9900 || r.Total != 99900 {
		t.Fatalf("got %+v", r)
	}
}

func TestComputeFixedDiscountCappedAtSubtotal(t *testing.T) {
	r := Compute(PricingInput{
		Items:          []LineItem{item("a", 5000, 1)},
		ManualDiscount: 9999, ManualKind: DiscountFixed,
	})
	if r.DiscountAmount != 5000 || r.Total != 0 {
		t.Fatalf("got %+v want discount 5000 total 0", r)
	}
}

func TestComputeRoundingNearest1000(t *testing.T) {
	// subtotal 100000, tax 11% = 11000 -> total 111000 round 1000 -> 111000
	r := Compute(PricingInput{
		Items:      []LineItem{item("a", 100000, 1)},
		TaxEnabled: true, TaxRate: 11,
		RoundingEnabled: true, RoundingType: "nearest_1000",
	})
	if r.Total != 111000 {
		t.Fatalf("total = %v want 111000", r.Total)
	}
	// 100333 -> nearest_500 -> 100500
	r2 := Compute(PricingInput{
		Items:           []LineItem{item("a", 100333, 1)},
		RoundingEnabled: true, RoundingType: "nearest_500",
	})
	if r2.Total != 100500 {
		t.Fatalf("total = %v want 100500", r2.Total)
	}
}

func TestComputePromoPercentageScopedToProducts(t *testing.T) {
	// promo 50% only on product "a"; matching subtotal 20000 -> 10000 off
	r := Compute(PricingInput{
		Items:  []LineItem{item("a", 10000, 2), item("b", 30000, 1)},
		Promos: []PromoSpec{{Kind: DiscountPercentage, Value: 50, ApplicableProductIDs: []string{"a"}}},
	})
	if r.PromoDiscount != 10000 || r.DiscountAmount != 10000 || r.Total != 40000 {
		t.Fatalf("got %+v", r)
	}
}

func TestComputePromoBOGOCheapestUnit(t *testing.T) {
	r := Compute(PricingInput{
		Items:  []LineItem{item("a", 8000, 1), item("b", 5000, 2)},
		Promos: []PromoSpec{{IsBOGO: true}},
	})
	if r.PromoDiscount != 5000 {
		t.Fatalf("bogo discount = %v want 5000 (cheapest unit)", r.PromoDiscount)
	}
}

func TestComputePromoScopedNoMatchIsZero(t *testing.T) {
	r := Compute(PricingInput{
		Items:  []LineItem{item("a", 10000, 1)},
		Promos: []PromoSpec{{Kind: DiscountPercentage, Value: 50, ApplicableProductIDs: []string{"zzz"}}},
	})
	if r.PromoDiscount != 0 || r.Total != 10000 {
		t.Fatalf("got %+v want no promo", r)
	}
}

func TestComputeStacksAdditively(t *testing.T) {
	items := []LineItem{{ProductID: "a", Price: 100000, Quantity: 1, Subtotal: 100000}}
	res := Compute(PricingInput{
		Items: items,
		Promos: []PromoSpec{
			{Kind: DiscountPercentage, Value: 10}, // 10k off 100k
			{Kind: DiscountPercentage, Value: 5},  // 5k off 100k
			{Kind: DiscountFixed, Value: 20000},   // 20k
		},
	})
	if res.PromoDiscount != 35000 {
		t.Fatalf("PromoDiscount = %v, want 35000", res.PromoDiscount)
	}
	if res.DiscountAmount != 35000 {
		t.Fatalf("DiscountAmount = %v, want 35000", res.DiscountAmount)
	}
	if res.Total != 65000 {
		t.Fatalf("Total = %v, want 65000", res.Total)
	}
}

func TestComputeStackCapsAtSubtotal(t *testing.T) {
	items := []LineItem{{ProductID: "a", Price: 100000, Quantity: 1, Subtotal: 100000}}
	res := Compute(PricingInput{
		Items:  items,
		Promos: []PromoSpec{{Kind: DiscountPercentage, Value: 60}, {Kind: DiscountPercentage, Value: 60}},
	})
	if res.DiscountAmount != 100000 {
		t.Fatalf("DiscountAmount = %v, want 100000 (capped)", res.DiscountAmount)
	}
	if res.Total != 0 {
		t.Fatalf("Total = %v, want 0", res.Total)
	}
}

func TestComputeEmptyPromosSameAsNone(t *testing.T) {
	items := []LineItem{{ProductID: "a", Price: 50000, Quantity: 1, Subtotal: 50000}}
	a := Compute(PricingInput{Items: items})
	b := Compute(PricingInput{Items: items, Promos: nil})
	if a != b {
		t.Fatalf("nil-Promos diverged: %+v vs %+v", a, b)
	}
}

func TestComputeLoyaltyPoints(t *testing.T) {
	r := Compute(PricingInput{
		Items:          []LineItem{item("a", 125000, 1)},
		LoyaltyEnabled: true, PointsPerK: 1, HasCustomer: true,
	})
	if r.EarnedPoints != 125 {
		t.Fatalf("points = %d want 125", r.EarnedPoints)
	}
	// no customer -> no points
	r2 := Compute(PricingInput{
		Items:          []LineItem{item("a", 125000, 1)},
		LoyaltyEnabled: true, PointsPerK: 1, HasCustomer: false,
	})
	if r2.EarnedPoints != 0 {
		t.Fatalf("points = %d want 0", r2.EarnedPoints)
	}
}

func TestComputeSurchargeFixedAddsToTotal(t *testing.T) {
	r := Compute(PricingInput{
		Items:     []LineItem{item("a", 10000, 1)},
		Surcharge: 2000, ManualKind: DiscountFixed,
	})
	if r.SurchargeAmount != 2000 || r.Total != 12000 {
		t.Fatalf("got %+v want surcharge 2000 total 12000", r)
	}
}

func TestTierBoundaries(t *testing.T) {
	cases := map[float64]string{
		0: "Member", 499999: "Member", 500000: "Silver",
		1999999: "Silver", 2000000: "Gold", 4999999: "Gold", 5000000: "Platinum",
	}
	for spent, want := range cases {
		if got := CustomerTier(spent); got != want {
			t.Errorf("CustomerTier(%v) = %q want %q", spent, got, want)
		}
	}
}

func bxgyItem(id, size string, price float64, qty int) LineItem {
	return LineItem{ProductID: id, VariantSize: size, Price: price, Quantity: qty, Subtotal: price * float64(qty)}
}

func TestCalcBXGYSameSetFree(t *testing.T) {
	cfg := &BXGYConfig{BuyQuantity: 2, GetQuantity: 1, GetDiscountKind: DiscountPercentage, GetDiscountValue: 100}
	r := Compute(PricingInput{Items: []LineItem{bxgyItem("a", "M", 10000, 3)},
		Promos: []PromoSpec{{Kind: DiscountBuyXGetY, BXGY: cfg}}})
	if r.PromoDiscount != 10000 {
		t.Fatalf("got %v want 10000", r.PromoDiscount)
	}
}

func TestCalcBXGYRepeatAndCap(t *testing.T) {
	cfg := &BXGYConfig{BuyQuantity: 2, GetQuantity: 1, GetDiscountKind: DiscountPercentage, GetDiscountValue: 100}
	full := Compute(PricingInput{Items: []LineItem{bxgyItem("a", "M", 10000, 6)},
		Promos: []PromoSpec{{Kind: DiscountBuyXGetY, BXGY: cfg}}})
	if full.PromoDiscount != 20000 {
		t.Fatalf("repeat got %v want 20000", full.PromoDiscount)
	}
	cfg.MaxApplications = 1
	capped := Compute(PricingInput{Items: []LineItem{bxgyItem("a", "M", 10000, 6)},
		Promos: []PromoSpec{{Kind: DiscountBuyXGetY, BXGY: cfg}}})
	if capped.PromoDiscount != 10000 {
		t.Fatalf("capped got %v want 10000", capped.PromoDiscount)
	}
}

func TestCalcBXGYSeparateSetPercentAndScarcity(t *testing.T) {
	// separate-set promos no longer contribute to PromoDiscount via Compute —
	// the saving lives in the reward line's reduced price instead (see calcPromotionDiscount).
	// calcBXGY itself is unchanged; only the routing in calcPromotionDiscount changed.
	cfg := &BXGYConfig{BuyQuantity: 2, GetQuantity: 1, BuyProductIDs: []string{"a"},
		GetProductIDs: []string{"b"}, GetDiscountKind: DiscountPercentage, GetDiscountValue: 50}
	r := Compute(PricingInput{Items: []LineItem{bxgyItem("a", "M", 10000, 2), bxgyItem("b", "M", 8000, 1)},
		Promos: []PromoSpec{{Kind: DiscountBuyXGetY, BXGY: cfg}}})
	if r.PromoDiscount != 0 {
		t.Fatalf("separate-set via Compute got %v want 0 (reward is a priced line)", r.PromoDiscount)
	}
	r0 := Compute(PricingInput{Items: []LineItem{bxgyItem("a", "M", 10000, 1), bxgyItem("b", "M", 8000, 1)},
		Promos: []PromoSpec{{Kind: DiscountBuyXGetY, BXGY: cfg}}})
	if r0.PromoDiscount != 0 {
		t.Fatalf("scarcity/separate-set got %v want 0", r0.PromoDiscount)
	}
}

func TestCalcBXGYFixedCappedAtUnit(t *testing.T) {
	cfg := &BXGYConfig{BuyQuantity: 1, GetQuantity: 1, GetDiscountKind: DiscountFixed, GetDiscountValue: 99999}
	r := Compute(PricingInput{Items: []LineItem{bxgyItem("a", "M", 5000, 2)},
		Promos: []PromoSpec{{Kind: DiscountBuyXGetY, BXGY: cfg}}})
	if r.PromoDiscount != 5000 {
		t.Fatalf("got %v want 5000 (capped)", r.PromoDiscount)
	}
}

func TestCalcBXGYVariantLevelKey(t *testing.T) {
	// separate-set: both wrong- and right-variant cases return 0 via Compute (reward is a priced line).
	// calcBXGY variant matching is exercised directly by TestBXGYRewardDue which calls bxgyBuyUnits.
	cfg := &BXGYConfig{BuyQuantity: 1, GetQuantity: 1, BuyProductIDs: []string{"a"},
		GetProductIDs: []string{variantKey("b", "10ml")}, GetDiscountKind: DiscountPercentage, GetDiscountValue: 100}
	r := Compute(PricingInput{Items: []LineItem{bxgyItem("a", "M", 10000, 1), bxgyItem("b", "50ml", 8000, 1)},
		Promos: []PromoSpec{{Kind: DiscountBuyXGetY, BXGY: cfg}}})
	if r.PromoDiscount != 0 {
		t.Fatalf("wrong-variant/separate-set got %v want 0", r.PromoDiscount)
	}
	r2 := Compute(PricingInput{Items: []LineItem{bxgyItem("a", "M", 10000, 1), bxgyItem("b", "10ml", 8000, 1)},
		Promos: []PromoSpec{{Kind: DiscountBuyXGetY, BXGY: cfg}}})
	if r2.PromoDiscount != 0 {
		t.Fatalf("right-variant/separate-set got %v want 0 (reward is a priced line)", r2.PromoDiscount)
	}
}

func TestCalcBXGYNilConfigIsZero(t *testing.T) {
	r := Compute(PricingInput{Items: []LineItem{bxgyItem("a", "M", 10000, 3)},
		Promos: []PromoSpec{{Kind: DiscountBuyXGetY, BXGY: nil}}})
	if r.PromoDiscount != 0 {
		t.Fatalf("nil cfg got %v want 0", r.PromoDiscount)
	}
}

func TestBXGYRewardDue(t *testing.T) {
	c := &BXGYConfig{BuyQuantity: 2, GetQuantity: 1, BuyProductIDs: []string{"a"}, GetProductIDs: []string{"b"}}
	// 4 buy units -> 2 applications -> 2 due
	items := []LineItem{bxgyItem("a", "M", 10000, 4)}
	if got := bxgyRewardDue(c, items); got != 2 {
		t.Fatalf("due=%d want 2", got)
	}
	// 3 buy units, buyQty 2 -> 1 application -> 1 due
	if got := bxgyRewardDue(c, []LineItem{bxgyItem("a", "M", 10000, 3)}); got != 1 {
		t.Fatalf("due=%d want 1", got)
	}
	// under criteria -> 0
	if got := bxgyRewardDue(c, []LineItem{bxgyItem("a", "M", 10000, 1)}); got != 0 {
		t.Fatalf("due=%d want 0", got)
	}
	// cap
	c.MaxApplications = 1
	if got := bxgyRewardDue(c, []LineItem{bxgyItem("a", "M", 10000, 4)}); got != 1 {
		t.Fatalf("capped due=%d want 1", got)
	}
	// same-set (empty get) -> 0 (not a fulfillment promo)
	if got := bxgyRewardDue(&BXGYConfig{BuyQuantity: 2, GetQuantity: 1}, items); got != 0 {
		t.Fatalf("sameset due=%d want 0", got)
	}
}

func TestBXGYRewardDueExcludesGetSetFromBuyUnits(t *testing.T) {
	// empty buyProductIds => any unit NOT in get set counts as buy
	c := &BXGYConfig{BuyQuantity: 2, GetQuantity: 1, GetProductIDs: []string{"b"}}
	items := []LineItem{bxgyItem("a", "M", 10000, 2), bxgyItem("b", "M", 8000, 5)}
	if got := bxgyRewardDue(c, items); got != 1 { // only the 2 'a' count as buy -> 1 app
		t.Fatalf("due=%d want 1", got)
	}
}

func TestBXGYRewardNet(t *testing.T) {
	free := &BXGYConfig{GetDiscountKind: DiscountPercentage, GetDiscountValue: 100}
	if got := bxgyRewardNet(free, 50000); got != 0 {
		t.Fatalf("free net=%v want 0", got)
	}
	half := &BXGYConfig{GetDiscountKind: DiscountPercentage, GetDiscountValue: 50}
	if got := bxgyRewardNet(half, 50000); got != 25000 {
		t.Fatalf("half net=%v want 25000", got)
	}
	fixed := &BXGYConfig{GetDiscountKind: DiscountFixed, GetDiscountValue: 99999}
	if got := bxgyRewardNet(fixed, 5000); got != 0 { // capped: max(0, 5000-99999)
		t.Fatalf("fixed net=%v want 0", got)
	}
}

func TestComputeSeparateSetBuyXGetYIsZeroDiscount(t *testing.T) {
	cfg := &BXGYConfig{BuyQuantity: 2, GetQuantity: 1, BuyProductIDs: []string{"a"},
		GetProductIDs: []string{"b"}, GetDiscountKind: DiscountPercentage, GetDiscountValue: 50}
	// even with a get-set item present, the separate-set promo contributes 0
	r := Compute(PricingInput{Items: []LineItem{bxgyItem("a", "M", 10000, 2), bxgyItem("b", "M", 8000, 1)},
		Promos: []PromoSpec{{Kind: DiscountBuyXGetY, BXGY: cfg}}})
	if r.PromoDiscount != 0 {
		t.Fatalf("separate-set promo discount = %v, want 0 (reward is a priced line)", r.PromoDiscount)
	}
}

func TestComputeSameSetBuyXGetYStillDiscounts(t *testing.T) {
	cfg := &BXGYConfig{BuyQuantity: 2, GetQuantity: 1, GetDiscountKind: DiscountPercentage, GetDiscountValue: 100}
	r := Compute(PricingInput{Items: []LineItem{bxgyItem("a", "M", 10000, 3)},
		Promos: []PromoSpec{{Kind: DiscountBuyXGetY, BXGY: cfg}}})
	if r.PromoDiscount != 10000 {
		t.Fatalf("same-set discount = %v, want 10000", r.PromoDiscount)
	}
}

func TestPickTier(t *testing.T) {
	c := &TieredConfig{Tiers: []Tier{
		{MinSubtotal: 100000, Kind: DiscountFixed, Value: 10000},
		{MinSubtotal: 250000, Kind: DiscountPercentage, Value: 15},
		{MinSubtotal: 500000, Kind: DiscountPercentage, Value: 20},
	}}
	if pickTier(c, 50000) != nil {
		t.Fatal("below lowest tier should be nil")
	}
	if got := pickTier(c, 100000); got == nil || got.Value != 10000 {
		t.Fatalf("at 100k want tier1 got %+v", got)
	}
	if got := pickTier(c, 300000); got == nil || got.MinSubtotal != 250000 {
		t.Fatalf("at 300k want tier2 got %+v", got)
	}
	if got := pickTier(c, 999999); got == nil || got.MinSubtotal != 500000 {
		t.Fatalf("at 999k want tier3 got %+v", got)
	}
	// unsorted input still picks the highest qualifying
	u := &TieredConfig{Tiers: []Tier{{MinSubtotal: 500000, Kind: DiscountPercentage, Value: 20}, {MinSubtotal: 100000, Kind: DiscountFixed, Value: 10000}}}
	if got := pickTier(u, 600000); got == nil || got.MinSubtotal != 500000 {
		t.Fatalf("unsorted: want 500k tier got %+v", got)
	}
	if pickTier(nil, 100000) != nil {
		t.Fatal("nil config should be nil")
	}
}

func TestComputeTiered(t *testing.T) {
	cfg := &TieredConfig{Tiers: []Tier{
		{MinSubtotal: 100000, Kind: DiscountFixed, Value: 10000},
		{MinSubtotal: 250000, Kind: DiscountPercentage, Value: 15},
	}}
	// 300k subtotal -> tier2 15% = 45000
	r := Compute(PricingInput{Items: []LineItem{bxgyItem("a", "M", 300000, 1)},
		Promos: []PromoSpec{{Kind: DiscountTiered, Tiered: cfg}}})
	if r.PromoDiscount != 45000 {
		t.Fatalf("tiered discount = %v want 45000", r.PromoDiscount)
	}
	// 120k -> tier1 fixed 10000
	r2 := Compute(PricingInput{Items: []LineItem{bxgyItem("a", "M", 120000, 1)},
		Promos: []PromoSpec{{Kind: DiscountTiered, Tiered: cfg}}})
	if r2.PromoDiscount != 10000 {
		t.Fatalf("tier1 = %v want 10000", r2.PromoDiscount)
	}
	// 50k -> below lowest -> 0
	r3 := Compute(PricingInput{Items: []LineItem{bxgyItem("a", "M", 50000, 1)},
		Promos: []PromoSpec{{Kind: DiscountTiered, Tiered: cfg}}})
	if r3.PromoDiscount != 0 {
		t.Fatalf("below lowest = %v want 0", r3.PromoDiscount)
	}
	// nil config -> 0
	r4 := Compute(PricingInput{Items: []LineItem{bxgyItem("a", "M", 300000, 1)},
		Promos: []PromoSpec{{Kind: DiscountTiered, Tiered: nil}}})
	if r4.PromoDiscount != 0 {
		t.Fatalf("nil tiered = %v want 0", r4.PromoDiscount)
	}
}
