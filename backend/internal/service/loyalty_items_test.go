package service

import "testing"

func TestLoyaltyProductSetSkipsRewardsAndBundlePieces(t *testing.T) {
	items := []OrderItem{
		{ProductID: "paid", VariantSize: "100ml"},
		{ProductID: "free", IsReward: true},
		{ProductID: "large", VariantSize: "50ml", BundleGroup: 1, BundleRole: "large"},
		{ProductID: "vial", BundleRole: "vial"},
	}
	got := loyaltyProductSet(items)
	for _, k := range []string{"paid", variantKey("paid", "100ml")} {
		if !got[k] {
			t.Errorf("expected %q in set", k)
		}
	}
	for _, k := range []string{"free", "large", variantKey("large", "50ml"), "vial"} {
		if got[k] {
			t.Errorf("%q must not be in the loyalty product set", k)
		}
	}
}

func TestLoyaltyProductSetKeepsStandaloneSaleOfBundleProduct(t *testing.T) {
	// The same product sold on its own (no bundle fields) still counts.
	got := loyaltyProductSet([]OrderItem{
		{ProductID: "large", VariantSize: "50ml", BundleGroup: 1, BundleRole: "large"},
		{ProductID: "large", VariantSize: "50ml"},
	})
	if !got["large"] || !got[variantKey("large", "50ml")] {
		t.Fatalf("standalone line must count: %v", got)
	}
}
