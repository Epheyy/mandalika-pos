package write

import "testing"

func TestValidateGoodsReceipt(t *testing.T) {
	cases := []struct {
		name    string
		kind    string
		items   []GoodsReceiptItem
		wantErr bool
	}{
		{"ok warehouse", "warehouse", []GoodsReceiptItem{{ProductID: "p", VariantSize: "30ml", Qty: 5}}, false},
		{"ok outlet", "outlet", []GoodsReceiptItem{{ProductID: "p", VariantSize: "30ml", Qty: 1}}, false},
		{"bad kind", "shelf", []GoodsReceiptItem{{Qty: 1}}, true},
		{"no items", "outlet", nil, true},
		{"zero qty", "outlet", []GoodsReceiptItem{{Qty: 0}}, true},
		{"negative qty", "outlet", []GoodsReceiptItem{{Qty: -3}}, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := validateGoodsReceipt(c.kind, c.items)
			if (err != nil) != c.wantErr {
				t.Fatalf("validateGoodsReceipt(%q) err=%v wantErr=%v", c.kind, err, c.wantErr)
			}
		})
	}
}

func TestValidateLocationAdjust(t *testing.T) {
	cases := []struct {
		name    string
		kind    string
		newQty  int
		reason  string
		wantErr bool
	}{
		{"ok", "outlet", 10, "stok opname", false},
		{"bad kind", "shelf", 10, "x", true},
		{"no reason", "warehouse", 10, "", true},
		{"negative qty", "outlet", -1, "x", true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := validateLocationAdjust(c.kind, c.newQty, c.reason)
			if (err != nil) != c.wantErr {
				t.Fatalf("validateLocationAdjust err=%v wantErr=%v", err, c.wantErr)
			}
		})
	}
}
