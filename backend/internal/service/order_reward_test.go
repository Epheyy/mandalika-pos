package service

import "testing"

func li(pid, size string, price float64, qty int) LineItem {
	return LineItem{ProductID: pid, VariantSize: size, Price: price, Quantity: qty, Subtotal: price * float64(qty)}
}

func TestRewardLineEntitlement(t *testing.T) {
	c := &BXGYConfig{BuyQuantity: 2, GetQuantity: 1, BuyProductIDs: []string{"a"},
		GetProductIDs: []string{"b|10ml"}, GetDiscountKind: DiscountPercentage, GetDiscountValue: 100}
	paid := []LineItem{li("a", "M", 10000, 2)} // 1 application -> D=1
	// honored: 1 reward of b|10ml at net 0
	ok, net := rewardLineEntitled(c, paid, 0, "b", "10ml", 8000)
	if !ok || net != 0 {
		t.Fatalf("entitled ok=%v net=%v want true,0", ok, net)
	}
	// over-quota: the 2nd reward (alreadyHonored=1, D=1) is rejected
	if ok, _ := rewardLineEntitled(c, paid, 1, "b", "10ml", 8000); ok {
		t.Fatal("over-quota reward must be rejected")
	}
	// wrong product
	if ok, _ := rewardLineEntitled(c, paid, 0, "zzz", "M", 8000); ok {
		t.Fatal("wrong-product reward must be rejected")
	}
	// wrong variant (b|50ml not in get set)
	if ok, _ := rewardLineEntitled(c, paid, 0, "b", "50ml", 8000); ok {
		t.Fatal("wrong-variant reward must be rejected")
	}
}
