package promotionkeys

import (
	"encoding/json"
	"testing"
)

func TestDiagnosticUsesSemanticContractWithoutEditing(t *testing.T) {
	for _, tc := range []struct{ name, kind, raw, reason string }{
		{"inactive bundle overlap", "bundle", `{"slots":[{"productKeys":["P"]},{"productKeys":["P|M"]}]}`, "semantic_overlap"},
		{"distinct variants", "bundle", `{"slots":[{"productKeys":["P|M"]},{"productKeys":["P|L"]}]}`, ""},
		{"within slot union", "bundle", `{"slots":[{"productKeys":["P","P|M"]},{"productKeys":["Q"]}]}`, ""},
		{"BXGY overlap", "buy_x_get_y", `{"buyProductIds":["P|M"],"getProductIds":["P"]}`, "semantic_overlap"},
		{"same set", "buy_x_get_y", `{"buyProductIds":["P"],"getProductIds":[]}`, ""},
		{"complement", "buy_x_get_y", `{"buyProductIds":[],"getProductIds":["P"]}`, ""},
		{"missing bundle", "bundle", `null`, "uninspectable_config"},
		{"wrong slots", "bundle", `{"slots":42}`, "uninspectable_config"},
		{"wrong keys", "buy_x_get_y", `{"getProductIds":42}`, "uninspectable_config"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := StoredPromotion{ID: "immutable", Type: tc.kind, BundleConfig: json.RawMessage(tc.raw), BXGYConfig: json.RawMessage(tc.raw)}
			before, _ := json.Marshal(p)
			got := Diagnose(p)
			after, _ := json.Marshal(p)
			if string(before) != string(after) {
				t.Fatal("input mutated")
			}
			if tc.reason == "" {
				if len(got) != 0 {
					t.Fatal(got)
				}
			} else if len(got) != 1 || got[0].Reason != tc.reason || got[0].ID != "immutable" || got[0].IsActive {
				t.Fatal(got)
			}
		})
	}
}
