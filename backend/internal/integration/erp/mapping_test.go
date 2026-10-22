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
		{"pending counts as active", erpapi.PENDING, nil, true},
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
	edp, oil := str("Eau de Parfum"), str("Oil")
	k30 := GroupKey("Mandalika Oud 30ml", edp, f64(30))
	k50 := GroupKey("Mandalika Oud 50ml", edp, f64(50))
	if k30 != k50 {
		t.Fatalf("siblings must share a key: %q vs %q", k30, k50)
	}
	if want := "pos:eau de parfum|mandalika oud"; k30 != want {
		t.Fatalf("key = %q, want %q", k30, want)
	}
	if other := GroupKey("Mandalika Oud 50ml", oil, f64(50)); other == k50 {
		t.Fatalf("different category must change key, both %q", other)
	}
	if norm := GroupKey("  MANDALIKA   oud 50 ml ", str(" eau  DE parfum "), f64(50)); norm != k50 {
		t.Fatalf("normalisation: %q vs %q", norm, k50)
	}
	if none := GroupKey("Mandalika Oud 50ml", nil, f64(50)); none != "pos:|mandalika oud" {
		t.Fatalf("nil category key = %q", none)
	}
}
