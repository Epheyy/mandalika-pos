package write

import (
	"strings"
	"testing"
)

func TestValidateBundleGroups(t *testing.T) {
	std := func(name string, sizes ...string) bundleGroupState {
		m := map[string]float64{}
		for _, s := range sizes {
			m[s] = 1000
		}
		return bundleGroupState{ID: "d", Name: name, IsDefault: true, Standard: m}
	}
	prem := func(listed bool, sizes ...string) bundleGroupState {
		m := map[string]float64{}
		for _, s := range sizes {
			m[s] = 2000
		}
		return bundleGroupState{ID: "p", Name: "Premium", Listed: listed, Standard: m}
	}
	cases := []struct {
		name   string
		groups []bundleGroupState
		want   string
	}{
		{"listed group prices a size the default lacks",
			[]bundleGroupState{std("Standar", "120ml"), prem(true, "120ml", "130ml")},
			"Harga Premium 130ml butuh harga Standar 130ml"},
		{"unlisted group keeps a size the default dropped",
			[]bundleGroupState{std("Standar", "120ml"), prem(false, "100ml", "120ml")},
			"Ukuran 100ml masih punya harga di kelompok Premium. Hapus harga itu dulu."},
		{"both dropped is fine",
			[]bundleGroupState{std("Standar", "120ml"), prem(true, "120ml")}, ""},
		{"renamed default shows its name",
			[]bundleGroupState{std("Reguler", "120ml"), prem(true, "130ml")},
			"Harga Premium 130ml butuh harga Reguler 130ml"},
		{"smallest size is reported first",
			[]bundleGroupState{std("Standar"), prem(true, "130ml", "100ml")},
			"Harga Premium 100ml butuh harga Standar 100ml"},
	}
	for _, c := range cases {
		err := validateBundleGroups(c.groups)
		got := ""
		if err != nil {
			got = err.Error()
		}
		if got != c.want {
			t.Errorf("%s: err = %q, want %q", c.name, got, c.want)
		}
	}
}

func TestValidateBundlePricesGroupLabel(t *testing.T) {
	std := []BundlePriceIn{{"100ml", 650000}}
	lines := []BundleLinePriceIn{{"EXTRAIT DE PARFUM", "120ml", 850000}}
	for label, want := range map[string]string{
		"":        "Harga lini 120ml butuh harga standar 120ml",
		"Premium": "Harga lini Premium 120ml butuh harga standar Premium 120ml",
	} {
		err := validateBundlePrices(std, lines, bundleLineNames, label)
		if err == nil || err.Error() != want {
			t.Errorf("label %q: err = %v, want %q", label, err, want)
		}
	}
}

func TestBundlePriceRowsChanged(t *testing.T) {
	a := []bundlePriceRow{{"g1", "", "120ml", 1}, {"g2", "EXT", "120ml", 2}}
	cases := []struct {
		name  string
		after []bundlePriceRow
		want  bool
	}{
		{"same rows another order", []bundlePriceRow{a[1], a[0]}, false},
		{"changed price", []bundlePriceRow{a[0], {"g2", "EXT", "120ml", 3}}, true},
		{"added row", append([]bundlePriceRow{a[1], a[0]}, bundlePriceRow{"g1", "", "100ml", 1}), true},
		{"removed row", a[:1], true},
	}
	for _, c := range cases {
		if got := bundlePriceRowsChanged(a, c.after); got != c.want {
			t.Errorf("%s: = %v, want %v", c.name, got, c.want)
		}
	}
}

func TestNormalizePriceGroupName(t *testing.T) {
	got, err := normalizePriceGroupName("  VIP ")
	if err != nil || got != "VIP" {
		t.Fatalf("normalizePriceGroupName(\"  VIP \") = %q, %v, want VIP", got, err)
	}
	for _, in := range []string{"", "   "} {
		if _, err := normalizePriceGroupName(in); err == nil || err.Error() != "Nama kelompok wajib diisi" {
			t.Errorf("normalizePriceGroupName(%q) err = %v, want the wajib error", in, err)
		}
	}
	if _, err := normalizePriceGroupName(strings.Repeat("a", 41)); err == nil || err.Error() != "Nama kelompok maksimal 40 karakter" {
		t.Errorf("41 runes err = %v, want the maksimal error", err)
	}
	multi := strings.Repeat("é", 40)
	if got, err := normalizePriceGroupName(multi); err != nil || got != multi {
		t.Errorf("40 multi-byte runes = %q, %v, want OK", got, err)
	}
}
