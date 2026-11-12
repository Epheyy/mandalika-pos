package write

import "testing"

func TestValidateBundleDiscount(t *testing.T) {
	cfg := func(kind string, sizes ...string) *BundleDiscountConfigInput {
		return &BundleDiscountConfigInput{Kind: kind, Sizes: sizes}
	}
	cases := []struct {
		name  string
		value float64
		c     *BundleDiscountConfigInput
		want  string
	}{
		{"valid percent with line and size", 10, &BundleDiscountConfigInput{Kind: "percentage", Lines: []string{"EXTRAIT DE PARFUM"}, Sizes: []string{"110ml"}}, ""},
		{"valid fixed, all lines and sizes", 50000, cfg("fixed"), ""},
		{"missing config", 10, nil, "Pilih persen atau nominal"},
		{"missing kind", 10, cfg(""), "Pilih persen atau nominal"},
		{"unknown kind", 10, cfg("bogo"), "Pilih persen atau nominal"},
		{"percent zero", 0, cfg("percentage"), "Diskon persen harus 1–99"},
		{"percent 100", 100, cfg("percentage"), "Diskon persen harus 1–99"},
		{"percent fractional", 10.5, cfg("percentage"), "Diskon persen harus 1–99"},
		{"percent 99 ok", 99, cfg("percentage"), ""},
		{"fixed zero", 0, cfg("fixed"), "Diskon nominal harus bilangan bulat > 0"},
		{"fixed fractional", 1000.5, cfg("fixed"), "Diskon nominal harus bilangan bulat > 0"},
		{"bad size", 10, cfg("percentage", "120"), "Ukuran harus seperti 120ml"},
		{"bad size uppercase", 10, cfg("percentage", "120ML"), "Ukuran harus seperti 120ml"},
		{"blank line", 10, &BundleDiscountConfigInput{Kind: "percentage", Lines: []string{" "}}, "Lini tidak dikenal:  "},
		{"unknown line", 10, &BundleDiscountConfigInput{Kind: "percentage", Lines: []string{"EXTRAIT DE PARFUM", "FOO"}}, "Lini tidak dikenal: FOO"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := validateBundleDiscount(c.value, c.c)
			if c.want == "" {
				if err != nil {
					t.Fatalf("unexpected error %v", err)
				}
				return
			}
			if err == nil || err.Error() != c.want {
				t.Fatalf("err=%v want %q", err, c.want)
			}
		})
	}
}

func TestValidatePromotionBasicsBundleDiscountMinPurchase(t *testing.T) {
	min := 100000.0
	zero := 0.0
	p := Promotion{Type: "bundle_discount", IsActive: true, Value: 10, MinPurchase: &min,
		BundleDiscountConfig: &BundleDiscountConfigInput{Kind: "percentage"}}
	err := validateBundleDiscountPromotion(p)
	if err == nil || err.Error() != "Diskon Bundle tidak memakai minimal belanja" {
		t.Fatalf("err=%v", err)
	}
	p.MinPurchase = &zero
	if err := validateBundleDiscountPromotion(p); err != nil {
		t.Fatalf("zero minPurchase should pass: %v", err)
	}
	p.MinPurchase = nil
	if err := validateBundleDiscountPromotion(p); err != nil {
		t.Fatalf("nil minPurchase should pass: %v", err)
	}
}

func TestDefaultBundleDiscountCombinable(t *testing.T) {
	no := false
	got := defaultBundleDiscountCombinable(Promotion{Type: "bundle_discount"})
	if got.Combinable == nil || !*got.Combinable {
		t.Fatalf("nil combinable on bundle_discount must default to true, got %v", got.Combinable)
	}
	got = defaultBundleDiscountCombinable(Promotion{Type: "bundle_discount", Combinable: &no})
	if got.Combinable == nil || *got.Combinable {
		t.Fatalf("explicit false must stay false")
	}
	if got = defaultBundleDiscountCombinable(Promotion{Type: "percentage"}); got.Combinable != nil {
		t.Fatalf("other types untouched")
	}
}
