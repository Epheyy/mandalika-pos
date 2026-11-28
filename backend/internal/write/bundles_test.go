package write

import "testing"

// bundleIn is the default-group slice of a save, positional for the table below.
type bundleIn struct {
	Standard   []BundlePriceIn
	LinePrices []BundleLinePriceIn
}

func TestValidateBundleSettings(t *testing.T) {
	const ext = "EXTRAIT DE PARFUM"
	std := []BundlePriceIn{{"100ml", 650000}, {"110ml", 725000}, {"120ml", 795000}}
	cases := []struct {
		name string
		in   bundleIn
		want string
	}{
		{"ok", bundleIn{std, []BundleLinePriceIn{{ext, "120ml", 850000}}}, ""},
		{"empty is ok", bundleIn{}, ""},
		{"line price without standard", bundleIn{
			[]BundlePriceIn{{"100ml", 650000}}, []BundleLinePriceIn{{ext, "110ml", 800000}}},
			"Harga lini 110ml butuh harga standar 110ml"},
		{"bad size", bundleIn{[]BundlePriceIn{{"120", 795000}}, nil}, "Ukuran harus seperti 120ml"},
		{"15ml is not a large size", bundleIn{[]BundlePriceIn{{"15ml", 100000}}, nil}, "Ukuran 15ml bukan ukuran botol besar"},
		{"price over the cap", bundleIn{[]BundlePriceIn{{"120ml", 2000000000}}, nil}, "Harga bundle maksimal Rp 1.000.000.000"},
		{"zero price", bundleIn{[]BundlePriceIn{{"120ml", 0}}, nil}, "Harga bundle harus bilangan bulat > 0"},
		{"negative price", bundleIn{[]BundlePriceIn{{"120ml", -1}}, nil}, "Harga bundle harus bilangan bulat > 0"},
		{"fractional price", bundleIn{[]BundlePriceIn{{"120ml", 650000.5}}, nil}, "Harga bundle harus bilangan bulat > 0"},
		{"unknown line", bundleIn{std, []BundleLinePriceIn{{"GLITTER", "120ml", 1000}}}, "Lini tidak dikenal: GLITTER"},
		{"duplicate standard size", bundleIn{
			[]BundlePriceIn{{"120ml", 795000}, {"120ml", 800000}}, nil}, "Ukuran 120ml dobel"},
		{"duplicate line price", bundleIn{std,
			[]BundleLinePriceIn{{ext, "120ml", 850000}, {ext, "120ml", 860000}}}, "Ukuran 120ml dobel"},
	}
	for _, c := range cases {
		err := validateBundlePrices(c.in.Standard, c.in.LinePrices, bundleLineNames, "")
		got := ""
		if err != nil {
			got = err.Error()
		}
		if got != c.want {
			t.Errorf("%s: err = %q, want %q", c.name, got, c.want)
		}
	}
}
