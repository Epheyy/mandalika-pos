package write

import "testing"

func TestValidateBundleSettings(t *testing.T) {
	const ext = "EXTRAIT DE PARFUM"
	std := []BundlePriceIn{{"100ml", 650000}, {"110ml", 725000}, {"120ml", 795000}}
	cases := []struct {
		name string
		in   BundleSettingsInput
		want string
	}{
		{"ok", BundleSettingsInput{std, []BundleLinePriceIn{{ext, "120ml", 850000}}}, ""},
		{"empty is ok", BundleSettingsInput{}, ""},
		{"line price without standard", BundleSettingsInput{
			[]BundlePriceIn{{"100ml", 650000}}, []BundleLinePriceIn{{ext, "110ml", 800000}}},
			"Harga lini 110ml butuh harga standar 110ml"},
		{"bad size", BundleSettingsInput{[]BundlePriceIn{{"120", 795000}}, nil}, "Ukuran harus seperti 120ml"},
		{"15ml is not a large size", BundleSettingsInput{[]BundlePriceIn{{"15ml", 100000}}, nil}, "Ukuran 15ml bukan ukuran botol besar"},
		{"price over the cap", BundleSettingsInput{[]BundlePriceIn{{"120ml", 2000000000}}, nil}, "Harga bundle maksimal Rp 1.000.000.000"},
		{"zero price", BundleSettingsInput{[]BundlePriceIn{{"120ml", 0}}, nil}, "Harga bundle harus bilangan bulat > 0"},
		{"negative price", BundleSettingsInput{[]BundlePriceIn{{"120ml", -1}}, nil}, "Harga bundle harus bilangan bulat > 0"},
		{"fractional price", BundleSettingsInput{[]BundlePriceIn{{"120ml", 650000.5}}, nil}, "Harga bundle harus bilangan bulat > 0"},
		{"unknown line", BundleSettingsInput{std, []BundleLinePriceIn{{"GLITTER", "120ml", 1000}}}, "Lini tidak dikenal: GLITTER"},
		{"duplicate standard size", BundleSettingsInput{
			[]BundlePriceIn{{"120ml", 795000}, {"120ml", 800000}}, nil}, "Ukuran 120ml dobel"},
		{"duplicate line price", BundleSettingsInput{std,
			[]BundleLinePriceIn{{ext, "120ml", 850000}, {ext, "120ml", 860000}}}, "Ukuran 120ml dobel"},
	}
	for _, c := range cases {
		err := validateBundleSettings(c.in, bundleLineNames)
		got := ""
		if err != nil {
			got = err.Error()
		}
		if got != c.want {
			t.Errorf("%s: err = %q, want %q", c.name, got, c.want)
		}
	}
}
