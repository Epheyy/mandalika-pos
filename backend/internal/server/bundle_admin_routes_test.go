package server

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/coverage"
)

// Bundle prices, outlet group assignments and price groups are admin-only on the REAL router:
// even an all-outlets manager holding manage_products is refused, before any database access.
func TestBundlePriceRoutesAdminOnly(t *testing.T) {
	router, issue := newRouteHarness(t)
	const outlet = "44444444-4444-4444-8444-444444444444"
	const id = "22222222-2222-2222-2222-222222222222"
	const adminMsg = "Hanya admin yang bisa mengubah harga bundle."

	token := func(role string, perms []string, cov coverage.Coverage) string {
		t.Helper()
		tok, err := auth.IssueAccessCov(routeHarnessSecret, time.Hour, adminUID, role, outlet, perms, 0, cov)
		if err != nil {
			t.Fatal(err)
		}
		return tok
	}
	errorOf := func(method, path, tok string) (int, string) {
		t.Helper()
		rec := send(router, method, path, tok, `{}`)
		var out struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
		return rec.Code, out.Error
	}

	routes := []struct{ method, path string }{
		{http.MethodPut, "/api/v1/settings/bundles"},
		{http.MethodPost, "/api/v1/price-groups"},
		{http.MethodPut, "/api/v1/price-groups/" + id},
		{http.MethodDelete, "/api/v1/price-groups/" + id},
	}
	perms := []string{"manage_products"}
	refused := map[string]string{
		"covered-only manager": token("manager", perms, coverage.Coverage{OutletIDs: []string{outlet}}),
		"all-outlets manager":  token("manager", perms, coverage.Coverage{All: true}),
		"cashier":              token("cashier", nil, coverage.Coverage{}),
	}
	for who, tok := range refused {
		for _, r := range routes {
			if code, msg := errorOf(r.method, r.path, tok); code != http.StatusForbidden || msg != adminMsg {
				t.Errorf("%s %s as %s = %d %q, want 403 %q", r.method, r.path, who, code, msg, adminMsg)
			}
		}
	}

	// An admin token reaches the handler (it may fail later on the unreachable database, never 403/404/405).
	admin := issue("admin", adminUID)
	for _, r := range routes {
		code, msg := errorOf(r.method, r.path, admin)
		if code == http.StatusForbidden || code == http.StatusNotFound || code == http.StatusMethodNotAllowed || msg == adminMsg {
			t.Errorf("%s %s as admin = %d %q, must reach its handler", r.method, r.path, code, msg)
		}
	}

	// Reading the settings stays open to any signed-in user.
	if code, msg := errorOf(http.MethodGet, "/api/v1/settings/bundles", refused["cashier"]); code == http.StatusForbidden || code == http.StatusNotFound {
		t.Errorf("GET /settings/bundles as cashier = %d %q, must stay readable", code, msg)
	}
}
