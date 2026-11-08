package write

import (
	"encoding/json"
	"math"
	"testing"
)

func TestValidateLoyaltyRates(t *testing.T) {
	cases := []struct {
		name        string
		ppk, redeem float64
		wantErr     bool
	}{
		{"defaults", 1, 100, false},
		{"fraction ok", 0.5, 50, false},
		{"negative earn", -1, 100, true},
		{"zero earn", 0, 100, true},
		{"negative redeem", 1, -5, true},
		{"zero redeem", 1, 0, true},
		{"nan", math.NaN(), 100, true},
		{"inf", 1, math.Inf(1), true},
		{"earn too big", MaxPointsPerThousand + 1, 100, true},
		{"redeem too big", 1, MaxRedemptionRate + 1, true},
	}
	for _, c := range cases {
		if err := validateLoyaltyRates(c.ppk, c.redeem); (err != nil) != c.wantErr {
			t.Errorf("%s: err=%v wantErr=%v", c.name, err, c.wantErr)
		}
	}
}

func TestValidateReceiptSettings(t *testing.T) {
	cases := map[string]bool{
		`{}`:                 false,
		`{"copies":1}`:       false,
		`{"copies":5}`:       false,
		`{"copies":0}`:       true,
		`{"copies":6}`:       true,
		`{"copies":-2}`:      true,
		`{"copies":2.5}`:     true,
		`{"copies":"3"}`:     true,
		`{"copies":null}`:    false,
		`{"autoPrint":true}`: false,
	}
	for raw, wantErr := range cases {
		if err := validateReceiptSettings(json.RawMessage(raw)); (err != nil) != wantErr {
			t.Errorf("%s: err=%v wantErr=%v", raw, err, wantErr)
		}
	}
}

func TestValidateUnitCost(t *testing.T) {
	f := func(v float64) *float64 { return &v }
	for name, c := range map[string]struct {
		in      *float64
		wantErr bool
	}{
		"absent": {nil, false}, "zero": {f(0), false}, "positive": {f(1500.5), false},
		"negative": {f(-1), true}, "nan": {f(math.NaN()), true}, "inf": {f(math.Inf(1)), true},
	} {
		if err := validateUnitCost(c.in); (err != nil) != c.wantErr {
			t.Errorf("%s: err=%v", name, err)
		}
	}
	if err := validateGoodsReceipt("outlet", []GoodsReceiptItem{{Qty: 1, UnitCost: f(-5)}}); err == nil {
		t.Error("goods receipt with negative cost accepted")
	}
	if err := validateIngredientGoodsReceipt("outlet", []IngredientGoodsReceiptItem{{Qty: 1, UnitCost: f(-5)}}); err == nil {
		t.Error("ingredient receipt with negative cost accepted")
	}
}
