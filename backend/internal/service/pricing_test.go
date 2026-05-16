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
		Items: []LineItem{item("a", 10000, 2), item("b", 30000, 1)},
		Promo: &PromoSpec{Kind: DiscountPercentage, Value: 50, ApplicableProductIDs: []string{"a"}},
	})
	if r.PromoDiscount != 10000 || r.DiscountAmount != 10000 || r.Total != 40000 {
		t.Fatalf("got %+v", r)
	}
}

func TestComputePromoBOGOCheapestUnit(t *testing.T) {
	r := Compute(PricingInput{
		Items: []LineItem{item("a", 8000, 1), item("b", 5000, 2)},
		Promo: &PromoSpec{IsBOGO: true},
	})
	if r.PromoDiscount != 5000 {
		t.Fatalf("bogo discount = %v want 5000 (cheapest unit)", r.PromoDiscount)
	}
}

func TestComputePromoScopedNoMatchIsZero(t *testing.T) {
	r := Compute(PricingInput{
		Items: []LineItem{item("a", 10000, 1)},
		Promo: &PromoSpec{Kind: DiscountPercentage, Value: 50, ApplicableProductIDs: []string{"zzz"}},
	})
	if r.PromoDiscount != 0 || r.Total != 10000 {
		t.Fatalf("got %+v want no promo", r)
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
		if got := Tier(spent); got != want {
			t.Errorf("Tier(%v) = %q want %q", spent, got, want)
		}
	}
}
