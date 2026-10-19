package read

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/oapi-codegen/nullable"

	"github.com/mandalika/pos-backend/internal/api"
)

func TestWithoutCustomerNamesDropsOnlyTheName(t *testing.T) {
	const cid = "00000000-0000-4000-8f20-0000000000c1"
	in := []api.DiscountCode{{
		Code:         "VIP",
		CustomerId:   nullable.NewNullableWithValue(cid),
		CustomerName: nullable.NewNullableWithValue("Alice Priv"),
	}}

	out := WithoutCustomerNames(in)

	raw, err := json.Marshal(out)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "customerName") || strings.Contains(string(raw), "Alice") {
		t.Errorf("customer name survived: %s", raw)
	}
	if !strings.Contains(string(raw), cid) {
		t.Errorf("customerId must stay (POS wrong_customer rule): %s", raw)
	}
	// The input is not mutated (rows can be shared with a cache build).
	if !in[0].CustomerName.IsSpecified() {
		t.Error("input slice was mutated")
	}
}
