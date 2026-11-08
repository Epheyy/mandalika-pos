package write

import (
	"math"
	"testing"
)

func TestValidateIngredientDefaultUnitCost(t *testing.T) {
	f := func(v float64) *float64 { return &v }
	base := Ingredient{Name: "Rose", Unit: "ml"}
	cases := []struct {
		name string
		cost *float64
		ok   bool
	}{
		{"nil allowed", nil, true},
		{"zero allowed", f(0), true},
		{"positive allowed", f(12500.5), true},
		{"negative rejected", f(-1), false},
		{"NaN rejected", f(math.NaN()), false},
		{"+Inf rejected", f(math.Inf(1)), false},
		{"-Inf rejected", f(math.Inf(-1)), false},
		{"oversized rejected", f(MaxUnitCost * 10), false},
	}
	for _, c := range cases {
		in := base
		in.DefaultUnitCost = c.cost
		err := validateIngredient(in)
		if c.ok && err != nil {
			t.Errorf("%s: unexpected error %v", c.name, err)
		}
		if !c.ok && err == nil {
			t.Errorf("%s: expected error", c.name)
		}
	}
}
