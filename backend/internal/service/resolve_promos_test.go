package service

import (
	"testing"
)

// TestDedupeNonEmpty covers the I1 fix: duplicate codes must be collapsed to one
// entry before resolvePromos processes them.  A duplicate without deduplication
// would double-increment usage_count and falsely trip the combinability gate
// (two entries → len>1 → "not combinable" for a single real code).
// C1 (persist resolved code strings) is structural and is proven by the e2e suite
// (cmd/spe2e) which validates the applied_discount_codes column after sync.
func TestDedupeNonEmpty(t *testing.T) {
	cases := []struct {
		name string
		in   []string
		want []string
	}{
		{
			name: "duplicates and empties are removed",
			in:   []string{"a", "a", "", "b"},
			want: []string{"a", "b"},
		},
		{
			name: "nil input returns nil",
			in:   nil,
			want: nil,
		},
		{
			name: "all empty returns nil",
			in:   []string{"", ""},
			want: nil,
		},
		{
			name: "single entry preserved",
			in:   []string{"x"},
			want: []string{"x"},
		},
		{
			name: "order preserved",
			in:   []string{"b", "a", "b", "c"},
			want: []string{"b", "a", "c"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := dedupeNonEmpty(tc.in)
			if len(got) != len(tc.want) {
				t.Fatalf("dedupeNonEmpty(%v) = %v; want %v", tc.in, got, tc.want)
			}
			for i := range tc.want {
				if got[i] != tc.want[i] {
					t.Errorf("dedupeNonEmpty(%v)[%d] = %q; want %q", tc.in, i, got[i], tc.want[i])
				}
			}
		})
	}
}

func TestCombinabilityGate(t *testing.T) {
	// >1 discount with any non-combinable -> violation.
	if v := combinabilityViolation([]bool{true, false}); v == nil {
		t.Fatal("expected violation for [combinable, non-combinable]")
	}
	// all combinable -> ok.
	if v := combinabilityViolation([]bool{true, true, true}); v != nil {
		t.Fatalf("expected no violation, got %v", *v)
	}
	// single discount is always fine, even if non-combinable.
	if v := combinabilityViolation([]bool{false}); v != nil {
		t.Fatalf("single discount must never gate, got %v", *v)
	}
	// zero discounts -> ok.
	if v := combinabilityViolation(nil); v != nil {
		t.Fatalf("no discounts must not gate, got %v", *v)
	}
}
