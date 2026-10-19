package api

import (
	"encoding/json"
	"testing"
)

// Order and shift money is float64 (format: double): float32 rounded values above
// 2^24 (Rp 16.7M), so a Rp 20,000,001 order would have been served as 20000000.
func TestOrderAndShiftMoneyKeepsRupiahAbove2Pow24(t *testing.T) {
	raw, err := json.Marshal(Order{Total: 20000001, Subtotal: 20000001})
	if err != nil {
		t.Fatal(err)
	}
	var o struct{ Total, Subtotal float64 }
	if err := json.Unmarshal(raw, &o); err != nil || o.Total != 20000001 || o.Subtotal != 20000001 {
		t.Fatalf("order money rounded: %s", raw)
	}
	raw, err = json.Marshal(Shift{TotalSales: 20000001})
	if err != nil {
		t.Fatal(err)
	}
	var sh struct{ TotalSales float64 }
	if err := json.Unmarshal(raw, &sh); err != nil || sh.TotalSales != 20000001 {
		t.Fatalf("shift money rounded: %s", raw)
	}
}
