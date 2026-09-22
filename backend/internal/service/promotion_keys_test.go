package service

import "testing"

func TestSemanticPromotionRuntimeRegression(t *testing.T) {
	cfg := &BundleConfig{BundlePrice: 50, Slots: []BundleSlot{{ProductKeys: []string{"P"}, Quantity: 1}, {ProductKeys: []string{"P|M", "Q"}, Quantity: 1}}}
	paid := []LineItem{{ProductID: "P", VariantSize: "M", Price: 100, Quantity: 1}}
	if n := bundleApplications(cfg, paid); n != 0 {
		t.Errorf("invalid semantic overlap matched %d applications", n)
	}
	if nets, ok := bundleFreedNets(cfg, paid, []bundleFreedUnit{{ProductID: "Q", VariantSize: "M", FullPrice: 20}}); ok {
		t.Errorf("first-slot assignment accepted invalid rule: %v", nets)
	}
	c := &BXGYConfig{BuyQuantity: 1, GetQuantity: 1, BuyProductIDs: []string{"P"}, GetProductIDs: []string{"P|M"}, GetDiscountKind: DiscountPercentage, GetDiscountValue: 100}
	if n := bxgyRewardDue(c, paid); n != 0 {
		t.Errorf("overlapping buy/get rewarded %d units", n)
	}
}
