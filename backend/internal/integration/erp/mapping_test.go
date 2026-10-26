package erp

import (
	"testing"
	"time"

	"github.com/mandalika/pos-backend/internal/integration/erp/erpapi"
)

func f64(v float64) *float64 { return &v }
func str(s string) *string   { return &s }

func TestFGActive(t *testing.T) {
	now := time.Now()
	tests := []struct {
		name   string
		status erpapi.IntegrationFGStatus
		del    *time.Time
		want   bool
	}{
		{"active", erpapi.ACTIVE, nil, true},
		{"favourite", erpapi.FAVOURITE, nil, true},
		{"new launching", erpapi.NEWLAUNCHING, nil, true},
		{"pending is not sellable (Q3)", erpapi.PENDING, nil, false},
		{"discontinue", erpapi.DISCONTINUE, nil, false},
		{"deleted active", erpapi.ACTIVE, &now, false},
		{"deleted discontinue", erpapi.DISCONTINUE, &now, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := FGActive(erpapi.IntegrationFG{Status: tc.status, DeletedAt: tc.del})
			if got != tc.want {
				t.Fatalf("FGActive = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestSizeLabel(t *testing.T) {
	tests := []struct {
		name string
		size *float64
		unit *string
		want string
	}{
		{"nil size", nil, nil, "Satuan"},
		{"nil size with unit", nil, str("PCS"), "Satuan"},
		{"integer nil unit", f64(50), nil, "50ml"},
		{"stock unit Pcs is not the size unit (ERP pull 2026-10-23)", f64(110), str("Pcs"), "110ml"},
		{"stock unit PCS upper", f64(50), str("PCS"), "50ml"},
		{"stock unit Botol", f64(30), str("Botol"), "30ml"},
		{"unknown unit falls back to ml", f64(100), str("set"), "100ml"},
		{"ml unit", f64(50), str("ml"), "50ml"},
		{"litre unit", f64(1), str("L"), "1l"},
		{"kg unit", f64(0.5), str("kg"), "0.5kg"},
		{"g unit", f64(15), str("g"), "15g"},
		{"integer empty unit", f64(30), str(""), "30ml"},
		{"integer ML upper", f64(100), str("ML"), "100ml"},
		{"fraction", f64(7.5), nil, "7.5ml"},
		{"gr unit", f64(50), str("gr"), "50gr"},
		{"GR upper lowered", f64(250), str(" GR "), "250gr"},
		{"fraction gr", f64(2.5), str("gr"), "2.5gr"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := SizeLabel(tc.size, tc.unit); got != tc.want {
				t.Fatalf("SizeLabel = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestProductNameFromFG(t *testing.T) {
	tests := []struct {
		name, in, want string
	}{
		{"suffix token", "Mandalika Oud 50ml", "Mandalika Oud"},
		{"spaced upper", "Mandalika Oud 50 ML", "Mandalika Oud"},
		{"middle token", "Mandalika 30 ml Oud", "Mandalika Oud"},
		{"decimal", "Rose 7.5ml", "Rose"},
		{"comma decimal", "Rose 7,5 ml", "Rose"},
		{"no token", "Mandalika   Oud", "Mandalika Oud"},
		{"only token falls back", "50ml", "50ml"},
		{"digits glued to word untouched", "Oud50ml", "Oud50ml"},
		{"ERP size-line suffix", "24HOURS - 100ML PARFUM INTENSE", "24HOURS"},
		{"ERP suffix with M", "NO1 - 110ML M EXTRAIT", "NO1"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := ProductNameFromFG(tc.in); got != tc.want {
				t.Fatalf("ProductNameFromFG(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

func gfg(code, name string, others bool) erpapi.IntegrationFG {
	return erpapi.IntegrationFG{Code: code, Name: name, IsOthers: others}
}

// Mapping v3 §6.2: the fragrance part of the code groups, not the name. ONLY THE BRAVE
// PP120E-ONL and PP120E-ONL-R ("… - 120ML EXTRAIT REWORK") share a stripped name but are two
// groups; the name rule would have collided.
func TestGroupKeyByFragranceCode(t *testing.T) {
	for _, c := range []struct {
		fg   erpapi.IntegrationFG
		want string
	}{
		{gfg("PP120E-24H", "24HOURS", false), "erp:24H"},
		{gfg("PP100P-24H", "24HOURS - 100ML PARFUM INTENSE", false), "erp:24H"},
		{gfg("15GL-NO1", "NO1", false), "erp:NO1"},
		{gfg("PP120E-ONL", "ONLY THE BRAVE", false), "erp:ONL"},
		{gfg("PP120E-ONL-R", "ONLY THE BRAVE - 120ML EXTRAIT REWORK", false), "erp:ONL-R"},
		{gfg("A10M-HOL-EX", "HOLY SWEET ELIXIR", false), "erp:HOL-EX"},
		{gfg("DW110E-GOR", "GORGEOUS TUBEROSE", true), "erp:DW110E-GOR"}, // others: one product per item
		{gfg("KEM-CAN", "CANVAS BAG MANDALIKA", true), "erp:KEM-CAN"},
		{gfg("SN030", "Santal Noir 30ml", false), "pos:santal noir"}, // no fragrance part: name rule
		{gfg("SN110", "  SANTAL   noir 110 ml ", false), "pos:santal noir"},
	} {
		if got := GroupKey(c.fg); got != c.want {
			t.Errorf("GroupKey(%s %q) = %q, want %q", c.fg.Code, c.fg.Name, got, c.want)
		}
	}
}

func TestOthersProductName(t *testing.T) {
	if got := OthersProductName(" 24HOURS ", "DP120E-24H"); got != "24HOURS (DP120E-24H)" {
		t.Fatalf("OthersProductName = %q", got)
	}
}

func TestGroupGendersMajorityThenLowestCode(t *testing.T) {
	g := func(code string, gender erpapi.IntegrationFGGender, others bool) erpapi.IntegrationFG {
		return erpapi.IntegrationFG{Code: code, Name: "x", Gender: gender, IsOthers: others}
	}
	got := GroupGenders([]erpapi.IntegrationFG{
		// GORGEOUS TUBEROSE: 5 WOMEN, 2 UNISEX (production 2026-10-26)
		g("A10M-GOR", erpapi.WOMEN, false), g("15GL-GOR", erpapi.WOMEN, false), g("15GW-GOR", erpapi.WOMEN, false),
		g("V2E-GOR", erpapi.WOMEN, false), g("V2P-GOR", erpapi.WOMEN, false),
		g("PW110E-GOR", erpapi.UNISEX, false), g("PW110P-GOR", erpapi.UNISEX, false),
		g("DW110E-GOR", erpapi.UNISEX, true), g("DW110P-GOR", erpapi.UNISEX, true), // others do not vote
		// a tie: the lowest code's gender wins
		g("V2P-TIE", erpapi.MEN, false), g("A10M-TIE", erpapi.WOMEN, false),
		g("V2E-BAD", "", false), // no valid gender: no entry
	})
	want := map[string]erpapi.IntegrationFGGender{"erp:GOR": erpapi.WOMEN, "erp:TIE": erpapi.WOMEN}
	if len(got) != len(want) {
		t.Fatalf("GroupGenders = %v, want %v", got, want)
	}
	for k, w := range want {
		if got[k] != w {
			t.Errorf("GroupGenders[%s] = %q, want %q", k, got[k], w)
		}
	}
}
