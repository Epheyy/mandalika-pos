package erpmap

import (
	"encoding/json"
	"os"
	"slices"
	"strings"
	"testing"
)

type sampleFG struct {
	Code     string   `json:"code"`
	Name     string   `json:"name"`
	Category *string  `json:"category"`
	Size     *float64 `json:"size"`
	Unit     *string  `json:"unit"`
	Gender   string   `json:"gender"`
	IsOthers bool     `json:"is_others"`
}

// loadSample reads the production rows captured read-only on 2026-10-26 (testdata).
func loadSample(t *testing.T) []sampleFG {
	t.Helper()
	b, err := os.ReadFile("testdata/fg_sample_2026-10-26.json")
	if err != nil {
		t.Fatal(err)
	}
	var doc struct{ Items []sampleFG }
	if err := json.Unmarshal(b, &doc); err != nil {
		t.Fatal(err)
	}
	return doc.Items
}

func TestFragranceCode(t *testing.T) {
	for code, want := range map[string]string{
		"PP120E-24H": "24H", "15GM-NO1": "NO1", "A10M-HOL-EX": "HOL-EX", "PP120E-ONL-R": "ONL-R",
		"V2E-GOR": "GOR", "15GL-UNS": "UNS", " pp100p-day ": "DAY",
		"KEM-CAN": "", "KEM-KAR": "", "HAME-THE": "", "HAMP-THE": "", "SN030": "", "": "",
	} {
		if got := FragranceCode(code); got != want {
			t.Errorf("FragranceCode(%q) = %q, want %q", code, got, want)
		}
	}
}

func TestProductNameStripsTheSizeLineSuffix(t *testing.T) {
	for in, want := range map[string]string{
		"24HOURS - 100ML EXTRAIT":               "24HOURS",
		"24HOURS - 2ML PARFUM INTENSE":          "24HOURS",
		"NO1 - 110ML M PARFUM INTENSE":          "NO1",
		"ONLY THE BRAVE - 120ML EXTRAIT REWORK": "ONLY THE BRAVE",
		"DAY - 100ML M EXTRAIT":                 "DAY",
		"GORGEOUS TUBEROSE":                     "GORGEOUS TUBEROSE",
		"Santal Noir 50ml":                      "Santal Noir",
		"  Holy   Sweet  ":                      "Holy Sweet",
		"50ml":                                  "50ml",
	} {
		if got := ProductName(in); got != want {
			t.Errorf("ProductName(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestVariantLabel(t *testing.T) {
	f := func(v float64) *float64 { return &v }
	s := func(v string) *string { return &v }
	pcs := s("Pcs")
	cases := []struct {
		others   bool
		size     *float64
		unit     *string
		category *string
		want     string
	}{
		{false, f(120), pcs, s("EXT"), "120ml EXTRAIT DE PARFUM"},
		{false, f(2), pcs, s("PERFUME INTENSE"), "2ml PARFUM INTENSE"},
		{false, f(10), pcs, s("ATOMIZER"), "10ml ATOMIZER"},
		{false, f(15), pcs, s(" glass  man "), "15ml GLASS MAN"},
		{false, f(15), pcs, s("LEATHER"), "15ml LEATHER"},
		{false, f(15), pcs, s("GLITTER"), "15ml GLITTER"},
		{false, f(15), pcs, s("GLASS WOMAN"), "15ml GLASS WOMAN"},
		{false, f(50), pcs, s("Body Mist"), "50ml BODY MIST"}, // unknown: upper-cased pass-through
		{false, f(7.5), nil, s("EXT"), "7.5ml EXTRAIT DE PARFUM"},
		{false, f(50), s("gr"), nil, "50gr"},
		{false, f(30), pcs, s("  "), "30ml"},
		{false, nil, pcs, s("EXT"), "EXTRAIT DE PARFUM"},
		{false, nil, nil, nil, "Satuan"},
		{true, f(1), pcs, s("CANVAS BAG"), "Satuan"},
		{true, f(110), pcs, s("DISPLAY EXT"), "Satuan"},
	}
	for _, c := range cases {
		if got := VariantLabel(c.others, c.size, c.unit, c.category); got != c.want {
			t.Errorf("VariantLabel(%v, %v, %v) = %q, want %q", c.others, c.size, c.category, got, c.want)
		}
	}
	if l, known := Line("DISPLAY EXT"); known || l != "DISPLAY EXT" {
		t.Errorf("Line(DISPLAY EXT) = %q, %v; an unknown category passes through, reported", l, known)
	}
}

// TestRealCatalogGroupsOneProductPerFragrance checks the v3 rules on the production rows:
// every sellable fragrance group has one product name and unique labels, and the labels the
// POS already uses for NO1, GORGEOUS TUBEROSE, HOLY SWEET, ONLY THE BRAVE and UNSTOPPABLE are
// exactly what the rule produces (so the corrected and linked SKUs keep their labels).
func TestRealCatalogGroupsOneProductPerFragrance(t *testing.T) {
	groups := map[string][]sampleFG{}
	for _, fg := range loadSample(t) {
		if fg.IsOthers {
			if got := VariantLabel(true, fg.Size, fg.Unit, fg.Category); got != Unitless {
				t.Errorf("others %s label %q", fg.Code, got)
			}
			continue
		}
		fc := FragranceCode(fg.Code)
		if fc == "" {
			t.Fatalf("sellable %s has no fragrance code", fg.Code)
		}
		groups[fc] = append(groups[fc], fg)
	}
	type want struct {
		name   string
		labels []string
	}
	exp := map[string]want{
		"24H": {"24HOURS", []string{"100ml EXTRAIT DE PARFUM", "100ml PARFUM INTENSE", "10ml ATOMIZER", "120ml EXTRAIT DE PARFUM",
			"120ml PARFUM INTENSE", "15ml GLASS MAN", "2ml EXTRAIT DE PARFUM", "2ml PARFUM INTENSE"}},
		"DAY": {"DAY", []string{"100ml EXTRAIT DE PARFUM", "100ml PARFUM INTENSE", "10ml ATOMIZER", "120ml EXTRAIT DE PARFUM",
			"120ml PARFUM INTENSE", "15ml GLASS MAN", "2ml EXTRAIT DE PARFUM", "2ml PARFUM INTENSE"}},
		"CHA": {"CHAMPION", []string{"10ml ATOMIZER", "120ml EXTRAIT DE PARFUM", "120ml PARFUM INTENSE", "2ml EXTRAIT DE PARFUM", "2ml PARFUM INTENSE"}},
		"NO1": {"NO1", []string{"100ml EXTRAIT DE PARFUM", "100ml PARFUM INTENSE", "10ml ATOMIZER", "120ml EXTRAIT DE PARFUM",
			"120ml PARFUM INTENSE", "15ml GLASS MAN", "15ml LEATHER", "2ml EXTRAIT DE PARFUM", "2ml PARFUM INTENSE"}},
		"ONL": {"ONLY THE BRAVE", []string{"100ml EXTRAIT DE PARFUM", "100ml PARFUM INTENSE", "10ml ATOMIZER", "120ml EXTRAIT DE PARFUM",
			"120ml PARFUM INTENSE", "15ml GLASS MAN", "15ml LEATHER", "2ml EXTRAIT DE PARFUM", "2ml PARFUM INTENSE"}},
		"ONL-R": {"ONLY THE BRAVE", []string{"120ml EXTRAIT DE PARFUM"}}, // rework: its own group (the store disambiguates the name)
		"GOR": {"GORGEOUS TUBEROSE", []string{"10ml ATOMIZER", "110ml EXTRAIT DE PARFUM", "110ml PARFUM INTENSE", "15ml GLASS WOMAN",
			"15ml GLITTER", "2ml EXTRAIT DE PARFUM", "2ml PARFUM INTENSE"}},
		"HOL": {"HOLY SWEET", []string{"10ml ATOMIZER", "110ml EXTRAIT DE PARFUM", "110ml PARFUM INTENSE", "15ml GLASS WOMAN",
			"15ml GLITTER", "2ml EXTRAIT DE PARFUM", "2ml PARFUM INTENSE"}},
		// PW110E-HOL-EX is coded E but filed PERFUME INTENSE: the category wins (§6.3).
		"HOL-EX": {"HOLY SWEET ELIXIR", []string{"10ml ATOMIZER", "110ml PARFUM INTENSE", "2ml EXTRAIT DE PARFUM"}},
	}
	for fc, fgs := range groups {
		names := map[string]bool{}
		var labels []string
		for _, fg := range fgs {
			names[ProductName(fg.Name)] = true
			labels = append(labels, VariantLabel(false, fg.Size, fg.Unit, fg.Category))
		}
		slices.Sort(labels)
		if len(names) != 1 {
			t.Errorf("group %s has %d product names: %v", fc, len(names), names)
		}
		if len(slices.Compact(slices.Clone(labels))) != len(labels) {
			t.Errorf("group %s has duplicate labels: %v", fc, labels)
		}
		w, ok := exp[fc]
		if !ok {
			continue
		}
		delete(exp, fc)
		if !names[w.name] {
			t.Errorf("group %s name %v, want %q", fc, names, w.name)
		}
		if strings.Join(labels, "|") != strings.Join(w.labels, "|") {
			t.Errorf("group %s labels\n got %v\nwant %v", fc, labels, w.labels)
		}
	}
	if len(exp) > 0 {
		t.Errorf("groups missing from the sample: %v", exp)
	}
	pos := map[string][]string{ // the POS labels on test Neon (sandbox report §2)
		"NO1": {"10ml ATOMIZER", "120ml EXTRAIT DE PARFUM", "120ml PARFUM INTENSE", "2ml EXTRAIT DE PARFUM", "2ml PARFUM INTENSE"},
		"ONL": {"10ml ATOMIZER", "120ml EXTRAIT DE PARFUM", "120ml PARFUM INTENSE", "2ml EXTRAIT DE PARFUM", "2ml PARFUM INTENSE"},
		"GOR": {"10ml ATOMIZER", "110ml EXTRAIT DE PARFUM", "110ml PARFUM INTENSE", "2ml EXTRAIT DE PARFUM", "2ml PARFUM INTENSE"},
		"HOL": {"10ml ATOMIZER", "110ml EXTRAIT DE PARFUM", "110ml PARFUM INTENSE", "2ml EXTRAIT DE PARFUM", "2ml PARFUM INTENSE"},
		"UNS": {"10ml ATOMIZER", "110ml EXTRAIT DE PARFUM", "110ml PARFUM INTENSE", "2ml EXTRAIT DE PARFUM", "2ml PARFUM INTENSE"},
	}
	for fc, posLabels := range pos {
		var got []string
		for _, fg := range groups[fc] {
			got = append(got, VariantLabel(false, fg.Size, fg.Unit, fg.Category))
		}
		for _, l := range posLabels {
			if !slices.Contains(got, l) {
				t.Errorf("group %s: POS label %q is not produced by the rule (got %v)", fc, l, got)
			}
		}
	}
}
