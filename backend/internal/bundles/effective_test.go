package bundles

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

type goldenPrices struct {
	Standard map[string]float64            `json:"standard"`
	Lines    map[string]map[string]float64 `json:"lines"`
}

func (g goldenPrices) prices() Prices { return Prices{Standard: g.Standard, Lines: g.Lines} }

type effectiveCase struct {
	Name     string        `json:"name"`
	Standar  goldenPrices  `json:"standar"`
	Group    *goldenPrices `json:"group"`
	Expected goldenPrices  `json:"expected"`
	PriceFor []struct {
		Line  string  `json:"line"`
		Size  string  `json:"size"`
		Price float64 `json:"price"`
		OK    bool    `json:"ok"`
	} `json:"priceFor"`
}

func loadEffectiveGolden(t *testing.T) []effectiveCase {
	t.Helper()
	raw, err := os.ReadFile("testdata/effective_golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []effectiveCase
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases) < 8 {
		t.Fatalf("golden has %d cases, want at least 8", len(cases))
	}
	return cases
}

// samePrices compares top-level maps with nil == empty; an empty inner Lines map is a failure.
func samePrices(t *testing.T, got, want Prices) {
	t.Helper()
	if len(got.Standard) != len(want.Standard) || (len(got.Standard) > 0 && !reflect.DeepEqual(got.Standard, want.Standard)) {
		t.Fatalf("Standard = %v, want %v", got.Standard, want.Standard)
	}
	for l, m := range got.Lines {
		if len(m) == 0 {
			t.Fatalf("Lines[%q] is an empty inner map", l)
		}
	}
	if len(got.Lines) != len(want.Lines) || (len(got.Lines) > 0 && !reflect.DeepEqual(got.Lines, want.Lines)) {
		t.Fatalf("Lines = %v, want %v", got.Lines, want.Lines)
	}
}

func TestEffectiveGolden(t *testing.T) {
	for _, c := range loadEffectiveGolden(t) {
		t.Run(c.Name, func(t *testing.T) {
			var group Prices
			if c.Group != nil {
				group = c.Group.prices()
			}
			got := Effective(c.Standar.prices(), group)
			samePrices(t, got, c.Expected.prices())
			for _, row := range c.PriceFor {
				price, ok := got.PriceFor(row.Line, row.Size)
				if price != row.Price || ok != row.OK {
					t.Errorf("PriceFor(%q, %q) = (%v, %v), want (%v, %v)", row.Line, row.Size, price, ok, row.Price, row.OK)
				}
			}
		})
	}
}

func clonePrices(p Prices) Prices {
	out := Prices{Standard: map[string]float64{}, Lines: map[string]map[string]float64{}}
	for k, v := range p.Standard {
		out.Standard[k] = v
	}
	for l, m := range p.Lines {
		out.Lines[l] = map[string]float64{}
		for k, v := range m {
			out.Lines[l][k] = v
		}
	}
	return out
}

func TestEffectiveDoesNotMutateInputs(t *testing.T) {
	standar := Prices{
		Standard: map[string]float64{"100ml": 1050000, "120ml": 1200000},
		Lines:    map[string]map[string]float64{"EXT": {"120ml": 1500000}, "PI": {"100ml": 1100000}},
	}
	group := Prices{
		Standard: map[string]float64{"120ml": 1400000, "130ml": 1600000},
		Lines:    map[string]map[string]float64{"PI": {"120ml": 1450000}},
	}
	wantStandar, wantGroup := clonePrices(standar), clonePrices(group)
	got := Effective(standar, group)
	got.Standard["100ml"] = 1
	got.Lines["PI"]["100ml"] = 1
	if !reflect.DeepEqual(standar, wantStandar) {
		t.Fatalf("standar mutated: %v", standar)
	}
	if !reflect.DeepEqual(group, wantGroup) {
		t.Fatalf("group mutated: %v", group)
	}
}
