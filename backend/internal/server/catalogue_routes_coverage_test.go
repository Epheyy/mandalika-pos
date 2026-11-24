package server

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/coverage"
)

// Catalogue coverage on the REAL router (spec 2026-11-24-catalogue-coverage-design.md): a
// covered-only manager holding manage_products is refused every shared-catalogue write by
// RequireCatalogueWide, but still reaches the per-outlet config routes and upload signing
// (their handlers, not this middleware, apply coverage). The refusal runs before any database
// access, so the harness's lazy pool is enough.
func TestCatalogueRoutesFollowCoverage(t *testing.T) {
	router, _ := newRouteHarness(t)
	const outlet = "44444444-4444-4444-8444-444444444444"
	const id = "22222222-2222-2222-2222-222222222222"
	const catalogueMsg = "Hanya admin atau Manajer Semua Outlet yang dapat mengubah katalog."

	token := func(cov coverage.Coverage, home string) string {
		t.Helper()
		tok, err := auth.IssueAccessCov(routeHarnessSecret, time.Hour, adminUID, "manager", home, []string{"manage_products"}, 0, cov)
		if err != nil {
			t.Fatal(err)
		}
		return tok
	}
	covered := token(coverage.Coverage{OutletIDs: []string{outlet}}, outlet)
	errorOf := func(method, path, tok string) (int, string) {
		t.Helper()
		rec := send(router, method, path, tok, `{}`)
		var out struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
		return rec.Code, out.Error
	}

	gated := []struct{ method, path string }{
		{http.MethodPost, "/api/v1/products/import"},
		{http.MethodPost, "/api/v1/products"},
		{http.MethodPut, "/api/v1/products/" + id},
		{http.MethodDelete, "/api/v1/products/" + id},
		{http.MethodPost, "/api/v1/categories"},
		{http.MethodPut, "/api/v1/categories/" + id},
		{http.MethodDelete, "/api/v1/categories/" + id},
		{http.MethodPut, "/api/v1/settings/bundles"},
	}
	for _, r := range gated {
		if code, msg := errorOf(r.method, r.path, covered); code != http.StatusForbidden || msg != catalogueMsg {
			t.Errorf("%s %s as covered-only manager = %d %q, want 403 %q", r.method, r.path, code, msg, catalogueMsg)
		}
	}

	open := []struct{ method, path string }{
		{http.MethodGet, "/api/v1/products/" + id + "/outlet-config"},
		{http.MethodPut, "/api/v1/products/" + id + "/outlet-config"},
		{http.MethodPost, "/api/v1/uploads/sign"},
	}
	all := token(coverage.Coverage{All: true}, "")
	for _, r := range open {
		if code, msg := errorOf(r.method, r.path, covered); code == http.StatusNotFound || code == http.StatusMethodNotAllowed || msg == catalogueMsg {
			t.Errorf("%s %s as covered-only manager = %d %q, must reach its handler", r.method, r.path, code, msg)
		}
	}
	for _, r := range append(gated, open...) {
		if code, msg := errorOf(r.method, r.path, all); msg == catalogueMsg || code == http.StatusNotFound {
			t.Errorf("%s %s as all-outlets manager = %d %q, must pass the catalogue check", r.method, r.path, code, msg)
		}
	}
}
