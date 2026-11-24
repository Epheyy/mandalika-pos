package handlers

import (
	"strings"
	"testing"

	"github.com/google/uuid"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/mandalika/pos-backend/internal/api"
	"github.com/mandalika/pos-backend/internal/coverage"
)

func ocUUID(n byte) openapi_types.UUID {
	var u uuid.UUID
	u[15] = n
	return openapi_types.UUID(u)
}

func TestFilterOutletConfig(t *testing.T) {
	a, b, c := ocUUID(1), ocUUID(2), ocUUID(3)
	rows := []api.OutletVariantConfig{
		{OutletId: a, VariantSize: "50ml"}, {OutletId: b, VariantSize: "50ml"}, {OutletId: c, VariantSize: "50ml"},
		{OutletId: a, VariantSize: "100ml"},
	}
	got := filterOutletConfig(rows, coverage.Coverage{OutletIDs: []string{a.String(), strings.ToUpper(b.String())}})
	if len(got) != 3 || got[0].OutletId != a || got[1].OutletId != b || got[2].OutletId != a || got[2].VariantSize != "100ml" {
		t.Fatalf("covered {A,B} = %+v", got)
	}
	if got := filterOutletConfig(rows, coverage.Coverage{All: true}); len(got) != 4 {
		t.Fatalf("All = %d rows, want 4", len(got))
	}
	got = filterOutletConfig(rows, coverage.Coverage{})
	if got == nil || len(got) != 0 {
		t.Fatalf("empty coverage = %#v, want empty non-nil", got)
	}
}

func TestUncoveredOutlet(t *testing.T) {
	a, b := ocUUID(1), ocUUID(2)
	cov := coverage.Coverage{OutletIDs: []string{a.String()}}
	if id, bad := uncoveredOutlet([]api.OutletConfigItemInput{{OutletId: a}, {OutletId: b}}, cov); !bad || id != b.String() {
		t.Fatalf("[A,B] = %q,%v, want B,true", id, bad)
	}
	upper := coverage.Coverage{OutletIDs: []string{strings.ToUpper(a.String())}}
	if id, bad := uncoveredOutlet([]api.OutletConfigItemInput{{OutletId: a}}, upper); bad {
		t.Fatalf("case-different covered id refused: %q", id)
	}
	if id, bad := uncoveredOutlet(nil, cov); bad || id != "" {
		t.Fatalf("empty items = %q,%v", id, bad)
	}
}
