package handlers

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/coverage"
	"github.com/mandalika/pos-backend/internal/read"
)

const (
	covA = "00000000-0000-4000-8f30-00000000000a"
	covB = "00000000-0000-4000-8f30-00000000000b"
	covC = "00000000-0000-4000-8f30-00000000000c"
)

func covReq(role, active string, cov coverage.Coverage, query string) *http.Request {
	r := httptest.NewRequest(http.MethodGet, "/x"+query, nil)
	ctx := context.WithValue(r.Context(), auth.CtxRole, role)
	ctx = context.WithValue(ctx, auth.CtxOutletID, active)
	ctx = context.WithValue(ctx, auth.CtxCoverage, cov)
	return r.WithContext(ctx)
}

func TestScopeFollowsCoverage(t *testing.T) {
	all := coverage.Coverage{All: true}
	ab := coverage.Coverage{OutletIDs: []string{covA, covB}}
	one := coverage.Coverage{OutletIDs: []string{covA}}
	for _, c := range []struct {
		name   string
		role   string
		active string
		cov    coverage.Coverage
		query  string
		want   read.Scope
	}{
		{"admin no outlet is cross-outlet", "admin", "", all, "", read.Scope{CrossAll: true}},
		{"admin all", "admin", covA, all, "?outletId=all", read.Scope{CrossAll: true}},
		{"admin named", "admin", covA, all, "?outletId=" + covC, read.Scope{OutletID: covC}},
		{"admin active", "admin", covA, all, "", read.Scope{OutletID: covA}},
		{"manager-all no header", "manager", "", all, "", read.Scope{CrossAll: true}},
		{"manager-all all", "manager", covA, all, "?outletId=all", read.Scope{CrossAll: true}},
		{"manager-all named", "manager", "", all, "?outletId=" + covC, read.Scope{OutletID: covC}},
		{"manager-all header", "manager", covB, all, "", read.Scope{OutletID: covB}},
		{"manager [A,B] active B", "manager", covB, ab, "", read.Scope{OutletID: covB}},
		{"manager [A,B] active A names B", "manager", covA, ab, "?outletId=" + covB, read.Scope{OutletID: covB}},
		{"manager [A,B] all never widens", "manager", covA, ab, "?outletId=all", read.Scope{OutletID: covA}},
		{"manager [A,B] uncovered name ignored", "manager", covA, ab, "?outletId=" + covC, read.Scope{OutletID: covA}},
		{"manager single outlet", "manager", covA, one, "", read.Scope{OutletID: covA}},
		{"unassigned manager", "manager", "", coverage.Coverage{}, "", read.Scope{OutletID: read.NoOutlet}},
		{"unassigned manager all", "manager", "", coverage.Coverage{}, "?outletId=all", read.Scope{OutletID: read.NoOutlet}},
		{"cashier no outlet", "cashier", "", coverage.Coverage{}, "", read.Scope{OutletID: read.NoOutlet}},
		{"cashier cannot name an outlet", "cashier", covA, one, "?outletId=" + covB, read.Scope{OutletID: covA}},
	} {
		if got := scope(covReq(c.role, c.active, c.cov, c.query)); got != c.want {
			t.Errorf("%s: scope = %+v, want %+v", c.name, got, c.want)
		}
	}
}

func TestNoActiveOutlet(t *testing.T) {
	for sc, want := range map[read.Scope]bool{
		{CrossAll: true}:          false,
		{OutletID: covA}:          false,
		{OutletID: ""}:            true,
		{OutletID: read.NoOutlet}: true,
	} {
		if got := noActiveOutlet(sc); got != want {
			t.Errorf("noActiveOutlet(%+v) = %v, want %v", sc, got, want)
		}
	}
}

func TestCanEditOutletIDUsesCoverage(t *testing.T) {
	ab := coverage.Coverage{OutletIDs: []string{covA, covB}}
	if !canEditOutletID(covReq("manager", covA, ab, ""), covB) {
		t.Error("manager [A,B] must edit B")
	}
	if canEditOutletID(covReq("manager", covA, ab, ""), covC) {
		t.Error("manager [A,B] must not edit C")
	}
	if !canEditOutletID(covReq("admin", "", coverage.Coverage{All: true}, ""), covC) {
		t.Error("admin edits any outlet")
	}
}

func TestLocationHelpersFollowCoverage(t *testing.T) {
	all := coverage.Coverage{All: true}
	one := coverage.Coverage{OutletIDs: []string{covA}}
	if !locationInScope(covReq("manager", "", all, ""), "outlet", covC) {
		t.Error("manager-all: any outlet location in scope")
	}
	if !movementLocationAllowed(covReq("manager", "", all, ""), "outlet", covC) {
		t.Error("manager-all: any movement location allowed")
	}
	if locationInScope(covReq("manager", covA, one, ""), "outlet", covB) {
		t.Error("manager active A: outlet B must be out of scope")
	}
	if movementLocationAllowed(covReq("manager", covA, one, ""), "outlet", covB) {
		t.Error("manager active A: outlet B movements must be refused")
	}
	if locationInScope(covReq("manager", "", coverage.Coverage{}, ""), "outlet", read.NoOutlet) {
		t.Error("unassigned manager must match no location")
	}
}
