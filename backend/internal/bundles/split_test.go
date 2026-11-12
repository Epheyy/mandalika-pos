package bundles

import (
	"encoding/json"
	"math/rand"
	"os"
	"testing"
)

type splitCase struct {
	Name     string   `json:"name"`
	Amount   int64    `json:"amount"`
	Basis    [3]int64 `json:"basis"`
	Expected [3]int64 `json:"expected"`
	MinNet   int64    `json:"minNet"`
}

func loadSplitGolden(t *testing.T) []splitCase {
	t.Helper()
	raw, err := os.ReadFile("testdata/split_golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []splitCase
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases) < 5 {
		t.Fatalf("golden has %d cases, want at least 5", len(cases))
	}
	return cases
}

func TestSplitGolden(t *testing.T) {
	for _, c := range loadSplitGolden(t) {
		t.Run(c.Name, func(t *testing.T) {
			got, err := Split(c.Amount, c.Basis)
			if err != nil {
				t.Fatalf("Split: %v", err)
			}
			if got != c.Expected {
				t.Fatalf("Split(%d, %v) = %v, want %v", c.Amount, c.Basis, got, c.Expected)
			}
		})
	}
}

func TestMinNetGolden(t *testing.T) {
	for _, c := range loadSplitGolden(t) {
		t.Run(c.Name, func(t *testing.T) {
			if got := MinNet(c.Basis); got != c.MinNet {
				t.Fatalf("MinNet(%v) = %d, want %d", c.Basis, got, c.MinNet)
			}
		})
	}
}

func TestSplitRejectsNonPositiveBasis(t *testing.T) {
	cases := []struct {
		name   string
		amount int64
		basis  [3]int64
	}{
		{"zero atomizer", 850000, [3]int64{1200000, 0, 60000}},
		{"zero large", 850000, [3]int64{0, 250000, 60000}},
		{"zero vial", 850000, [3]int64{1200000, 250000, 0}},
		{"negative basis", 850000, [3]int64{1200000, -1, 60000}},
		{"basis over max", 850000, [3]int64{MaxBundleMoney + 1, 250000, 60000}},
		{"amount over max", MaxBundleMoney + 1, [3]int64{1200000, 250000, 60000}},
		{"negative amount", -1, [3]int64{1200000, 250000, 60000}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if _, err := Split(c.amount, c.basis); err == nil {
				t.Fatalf("Split(%d, %v) accepted, want error", c.amount, c.basis)
			}
		})
	}
}

func TestSplitAtLimitsDoesNotOverflow(t *testing.T) {
	got, err := Split(MaxBundleMoney, [3]int64{MaxBundleMoney, MaxBundleMoney, MaxBundleMoney})
	if err != nil {
		t.Fatal(err)
	}
	if got[0]+got[1]+got[2] != MaxBundleMoney {
		t.Fatalf("shares %v do not sum to the amount", got)
	}
}

func TestSplitSharesSumToAmount(t *testing.T) {
	rng := rand.New(rand.NewSource(20261112))
	for i := 0; i < 1000; i++ {
		basis := [3]int64{1 + rng.Int63n(2_000_000), 1 + rng.Int63n(400_000), 1 + rng.Int63n(100_000)}
		amount := rng.Int63n(2_000_000)
		got, err := Split(amount, basis)
		if err != nil {
			t.Fatal(err)
		}
		if got[0]+got[1]+got[2] != amount {
			t.Fatalf("Split(%d, %v) = %v: sum != amount", amount, basis, got)
		}
		if amount >= MinNet(basis) {
			for k, sh := range got {
				if sh < 1 {
					t.Fatalf("Split(%d, %v) = %v: share %d is %d (amount >= MinNet %d)", amount, basis, got, k, sh, MinNet(basis))
				}
			}
		}
	}
}
