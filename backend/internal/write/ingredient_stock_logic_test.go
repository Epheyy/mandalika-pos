package write

import "testing"

func TestValidateIngredientGoodsReceipt(t *testing.T) {
	cases := []struct {
		name    string
		kind    string
		items   []IngredientGoodsReceiptItem
		wantErr bool
	}{
		{"ok warehouse", "warehouse", []IngredientGoodsReceiptItem{{IngredientID: "i", Qty: 5}}, false},
		{"ok outlet", "outlet", []IngredientGoodsReceiptItem{{IngredientID: "i", Qty: 0.001}}, false},
		{"bad kind", "shelf", []IngredientGoodsReceiptItem{{Qty: 1}}, true},
		{"no items", "outlet", nil, true},
		{"zero qty", "outlet", []IngredientGoodsReceiptItem{{Qty: 0}}, true},
		{"negative qty", "outlet", []IngredientGoodsReceiptItem{{Qty: -3}}, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := validateIngredientGoodsReceipt(c.kind, c.items)
			if (err != nil) != c.wantErr {
				t.Fatalf("validateIngredientGoodsReceipt(%q) err=%v wantErr=%v", c.kind, err, c.wantErr)
			}
		})
	}
}

func TestValidateIngredientLocationAdjust(t *testing.T) {
	cases := []struct {
		name    string
		kind    string
		newQty  float64
		reason  string
		wantErr bool
	}{
		{"ok", "outlet", 10.5, "stok opname", false},
		{"bad kind", "shelf", 10, "x", true},
		{"no reason", "warehouse", 10, "", true},
		{"negative qty", "outlet", -0.001, "x", true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := validateIngredientLocationAdjust(c.kind, c.newQty, c.reason)
			if (err != nil) != c.wantErr {
				t.Fatalf("validateIngredientLocationAdjust err=%v wantErr=%v", err, c.wantErr)
			}
		})
	}
}
