package service

import (
	"encoding/json"
	"os"
	"testing"
)

// Same fixture file is read by POS linkedTierParity.test.ts. No backend pricing
// changes or database/current-catalog substitution to force agreement.
func TestLinkedTierGolden(t *testing.T) {
	raw, err := os.ReadFile("testdata/linked_tier_golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name            string
		Subtotal        float64
		Config          *TieredConfig
		Discount, Total float64
	}
	if err = json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases) != 16 {
		t.Fatal("golden fixture count changed", len(cases))
	}
	for _, tc := range cases {
		t.Run(tc.Name, func(t *testing.T) {
			result := Compute(PricingInput{Items: []LineItem{{ProductID: "p", VariantSize: "120ml", Price: tc.Subtotal, Quantity: 1, Subtotal: tc.Subtotal}}, Promos: []PromoSpec{{Kind: DiscountTiered, Value: 95, Tiered: tc.Config}}})
			if result.PromoDiscount != tc.Discount || result.Total != tc.Total {
				t.Fatalf("got %+v want discount=%v total=%v", result, tc.Discount, tc.Total)
			}
		})
	}
}
