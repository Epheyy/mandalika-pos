package service

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"

	"github.com/mandalika/pos-backend/internal/bundles"
)

// bundleDiscountGoldenCase is one case of testdata/set_bundle_discount_golden.json, shared with
// the POS twin (apps/pos setBundleDiscount.golden.test.ts).
type bundleDiscountGoldenCase struct {
	Name   string   `json:"name"`
	Price  int64    `json:"price"`
	Line   string   `json:"line"`
	Size   string   `json:"size"`
	Basis  [3]int64 `json:"basis"`
	Promos []struct {
		ID    string   `json:"id"`
		Kind  string   `json:"kind"`
		Value float64  `json:"value"`
		Lines []string `json:"lines"`
		Sizes []string `json:"sizes"`
	} `json:"promos"`
	Expected struct {
		Discount    int64    `json:"discount"`
		PromotionID string   `json:"promotionId"`
		Shares      [3]int64 `json:"shares"`
		DiscShares  [3]int64 `json:"discShares"`
	} `json:"expected"`
}

func TestSetBundleDiscountGolden(t *testing.T) {
	raw, err := os.ReadFile("testdata/set_bundle_discount_golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []bundleDiscountGoldenCase
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases) == 0 {
		t.Fatal("empty golden file")
	}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			var specs []PromoSpec
			for _, p := range c.Promos {
				specs = append(specs, PromoSpec{
					Kind: DiscountBundleDiscount, Value: p.Value, ID: p.ID,
					BundleDiscount: &BundleDiscountConfig{Kind: DiscountKind(p.Kind), Lines: p.Lines, Sizes: p.Sizes},
				})
			}
			d, id := bestBundleDiscount(c.Price, c.Line, c.Size, c.Basis, specs)
			if d != c.Expected.Discount || id != c.Expected.PromotionID {
				t.Fatalf("discount = %d (%q), want %d (%q)", d, id, c.Expected.Discount, c.Expected.PromotionID)
			}
			shares, err := bundles.Split(c.Price-d, c.Basis)
			if err != nil {
				t.Fatal(err)
			}
			discShares, err := bundles.Split(d, c.Basis)
			if err != nil {
				t.Fatal(err)
			}
			if shares != c.Expected.Shares || discShares != c.Expected.DiscShares {
				t.Fatalf("shares %v discShares %v, want %v %v", shares, discShares, c.Expected.Shares, c.Expected.DiscShares)
			}
		})
	}
}

func TestCalcPromotionDiscountBundleDiscountIsZero(t *testing.T) {
	items := []LineItem{{ProductID: "p", Price: 1000, Quantity: 1, Subtotal: 1000}}
	spec := PromoSpec{Kind: DiscountBundleDiscount, Value: 10, BundleDiscount: &BundleDiscountConfig{Kind: DiscountPercentage}}
	if got := calcPromotionDiscount(&spec, items, 1000); got != 0 {
		t.Fatalf("discount = %v, want 0", got)
	}
	if got := promoEligibleLines(&spec, items); got != nil {
		t.Fatalf("eligible lines = %v, want nil", got)
	}
}

func TestPriceSetBundleAppliesBiggestDiskonBundle(t *testing.T) {
	specs := []PromoSpec{
		{Kind: DiscountBundleDiscount, ID: "b", Value: 10, BundleDiscount: &BundleDiscountConfig{Kind: DiscountPercentage}},
		{Kind: DiscountBundleDiscount, ID: "a", Value: 100000, BundleDiscount: &BundleDiscountConfig{Kind: DiscountFixed}},
	}
	got, warns := priceSetBundle(champGroup(850000), champPrices(), false, specs)
	if !got.ok || len(warns) != 0 {
		t.Fatalf("ok=%v warns=%v", got.ok, warns)
	}
	if got.discount != 100000 || got.promotionID != "a" ||
		!reflect.DeepEqual(got.shares, [3]int64{596027, 124172, 29801}) ||
		!reflect.DeepEqual(got.discShares, [3]int64{79471, 16556, 3973}) {
		t.Fatalf("got %+v", got)
	}
}

// Two combinable Diskon Bundles plus a non-combinable code: the gate trips (online 422; offline
// resolvePromos keeps the sale and joins ViolationNotCombinable into the warning). loadPromoSpec
// feeds each spec's combinable flag into this same gate.
func TestResolvePromosBundleDiscountNotCombinable(t *testing.T) {
	if v := combinabilityViolation([]bool{true, true, false}); v == nil || *v != ViolationNotCombinable {
		t.Fatalf("got %v, want not_combinable", v)
	}
	if v := combinabilityViolation([]bool{true, true}); v != nil {
		t.Fatalf("two combinable Diskon Bundles must coexist, got %v", *v)
	}
	if v := combinabilityViolation([]bool{false, true}); v == nil {
		t.Fatal("a non-combinable Diskon Bundle must block a second discount")
	}
}
