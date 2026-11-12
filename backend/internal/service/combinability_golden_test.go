package service

import (
	"encoding/json"
	"os"
	"testing"
)

// Same fixture file is read by POS combinabilityParity.test.ts. Engine code is never
// adjusted to make a vector pass.
func TestCombinabilityGolden(t *testing.T) {
	raw, err := os.ReadFile("testdata/combinability_golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name  string `json:"name"`
		Items []struct {
			Source     string `json:"source"`
			Combinable bool   `json:"combinable"`
		} `json:"items"`
		Allowed bool `json:"allowed"`
	}
	if err = json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases) != 6 {
		t.Fatal("golden fixture count changed", len(cases))
	}
	for _, tc := range cases {
		t.Run(tc.Name, func(t *testing.T) {
			flags := make([]bool, 0, len(tc.Items))
			for _, it := range tc.Items {
				flags = append(flags, it.Combinable)
			}
			if got := combinabilityViolation(flags) == nil; got != tc.Allowed {
				t.Fatalf("allowed=%v want %v", got, tc.Allowed)
			}
		})
	}
}
