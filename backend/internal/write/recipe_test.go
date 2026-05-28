package write

import "testing"

func strp(s string) *string   { return &s }
func f64p(f float64) *float64 { return &f }

func TestVersionMatches(t *testing.T) {
	cases := []struct {
		name             string
		expected, actual *string
		want             bool
	}{
		{"both nil (first save)", nil, nil, true},
		{"expected nil, current set", nil, strp("v1"), false},
		{"expected set, current nil", strp("v1"), nil, false},
		{"equal", strp("v1"), strp("v1"), true},
		{"different", strp("v1"), strp("v2"), false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := versionMatches(c.expected, c.actual); got != c.want {
				t.Fatalf("versionMatches=%v want %v", got, c.want)
			}
		})
	}
}

func TestComputeTotalCost(t *testing.T) {
	snaps := map[string]ingredientSnap{
		"a": {cost: f64p(100)},
		"b": {cost: f64p(50)},
		"c": {cost: nil},
	}
	items := []RecipeSaveItem{{IngredientID: "a", Qty: 2}, {IngredientID: "b", Qty: 3}}
	got := computeTotalCost(items, snaps)
	if got == nil || *got != 350 {
		t.Fatalf("total=%v want 350", got)
	}
	withNil := append(items, RecipeSaveItem{IngredientID: "c", Qty: 1})
	if computeTotalCost(withNil, snaps) != nil {
		t.Fatalf("expected nil total when a line lacks cost")
	}
	if computeTotalCost([]RecipeSaveItem{{IngredientID: "x", Qty: 1}}, snaps) != nil {
		t.Fatalf("expected nil total for unknown ingredient")
	}
}

func TestNewlyAddedInactive(t *testing.T) {
	prior := map[string]bool{"keep": true}
	if newlyAddedInactive("keep", false, prior) {
		t.Fatalf("pre-existing inactive line must be allowed")
	}
	if !newlyAddedInactive("fresh", false, prior) {
		t.Fatalf("freshly added inactive line must be rejected")
	}
	if newlyAddedInactive("fresh", true, prior) {
		t.Fatalf("active ingredient must always be allowed")
	}
}
