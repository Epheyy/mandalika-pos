package erp

import (
	"context"
	"strings"
	"testing"

	"github.com/mandalika/pos-backend/internal/integration/erp/erpapi"
)

func TestValidPOSOutletCode(t *testing.T) {
	for _, c := range []string{"BSD", "TSM-CBB", "A1", "ABCDEFGHIJ0123456789"} {
		if !ValidPOSOutletCode(c) {
			t.Errorf("ValidPOSOutletCode(%q) = false, want true", c)
		}
	}
	for _, c := range []string{"A", "-BSD", "BSD-", "BS D", "bsd", "ABCDEFGHIJ01234567890", ""} {
		if ValidPOSOutletCode(c) {
			t.Errorf("ValidPOSOutletCode(%q) = true, want false", c)
		}
	}
}

// The type allowlist is checked before any DB access (the ERP stub cannot emit an unknown type).
func TestCreateOutletRefusesUnsupportedType(t *testing.T) {
	for _, ty := range []erpapi.IntegrationOutletType{"", "WAREHOUSE"} {
		out, err := createOutlet(context.Background(), nil, erpapi.IntegrationOutlet{Slug: "wh", Code: "WH-1", Name: "Warehouse", Type: ty})
		if err != nil || !out.skipped || !strings.Contains(out.note, "not created: type not supported") {
			t.Errorf("type %q -> %+v, %v", ty, out, err)
		}
	}
}
