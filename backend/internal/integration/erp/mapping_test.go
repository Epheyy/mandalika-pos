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
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := ProductNameFromFG(tc.in, nil); got != tc.want {
				t.Fatalf("ProductNameFromFG(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestGroupKey(t *testing.T) {
	k30 := GroupKey("Mandalika Oud 30ml", f64(30))
	k50 := GroupKey("Mandalika Oud 50ml", f64(50))
	if k30 != k50 {
		t.Fatalf("siblings must share a key: %q vs %q", k30, k50)
	}
	if want := "pos:mandalika oud"; k30 != want {
		t.Fatalf("key = %q, want %q", k30, want)
	}
	if norm := GroupKey("  MANDALIKA   oud 50 ml ", f64(50)); norm != k50 {
		t.Fatalf("normalisation: %q vs %q", norm, k50)
	}
	if other := GroupKey("Mandalika Rose 50ml", f64(50)); other == k50 {
		t.Fatalf("different fragrance must change key, both %q", other)
	}
}

// Regression (ERP local pull 2026-10-23): one fragrance whose sizes sit in different
// ERP categories must group into one POS product, not one product per category.
func TestGroupKeyIgnoresCategory(t *testing.T) {
	if a, b := GroupKey("Santal Noir 30ml", f64(30)), GroupKey("Santal Noir 100ml", f64(100)); a != b {
		t.Fatalf("one fragrance split across categories: %q vs %q", a, b)
	}
}

func TestCategoryGroupKey(t *testing.T) {
	edp, mist := str("Eau de Parfum"), str("Body Mist")
	a, b := CategoryGroupKey("Santal Noir 100ml", edp, f64(100)), CategoryGroupKey("Santal Noir 100ml", mist, f64(100))
	if a == b {
		t.Fatalf("tie-breaker must separate categories, both %q", a)
	}
	if want := "pos:santal noir|eau de parfum"; a != want {
		t.Fatalf("key = %q, want %q", a, want)
	}
	if a == GroupKey("Santal Noir 100ml", f64(100)) {
		t.Fatal("tie-breaker key must differ from the plain key")
	}
	if none := CategoryGroupKey("Santal Noir 100ml", nil, f64(100)); none != "pos:santal noir|" {
		t.Fatalf("nil category key = %q", none)
	}
}
