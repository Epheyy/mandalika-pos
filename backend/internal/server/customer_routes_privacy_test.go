package server

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/mandalika/pos-backend/internal/auth"
)

// A30 route guard on the REAL router: every route under /customers, /tags and /segments must
// refuse a cashier, a cashier who was granted manage_customers, and a manager without
// manage_customers. The guards run before any database access, so the harness's lazy pool is
// enough. A new route added to those prefixes without the customer-reader guard fails here.
// (/sync/customers/lookup is the one cashier-facing customer route and is deliberately outside.)
func TestCustomerRoutesRefusePhoneOnlyCallers(t *testing.T) {
	router, _ := newRouteHarness(t)
	routes, ok := router.(chi.Routes)
	if !ok {
		t.Fatal("router does not expose its routes")
	}

	token := func(role string, perms ...string) string {
		t.Helper()
		tok, err := auth.IssueAccess(routeHarnessSecret, time.Hour, adminUID, role, "", perms)
		if err != nil {
			t.Fatal(err)
		}
		return tok
	}
	callers := []struct{ name, token string }{
		{"cashier", token("cashier", "create_order")},
		{"cashier with manage_customers", token("cashier", "create_order", "manage_customers")},
		{"manager without manage_customers", token("manager", "view_reports")},
	}

	const uuid = "22222222-2222-2222-2222-222222222222"
	type route struct{ method, path string }
	var found []route
	err := chi.Walk(routes, func(method, pattern string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		pattern = strings.ReplaceAll(pattern, "/*", "")
		for _, prefix := range []string{"/api/v1/customers", "/api/v1/tags", "/api/v1/segments"} {
			if pattern == prefix || strings.HasPrefix(pattern, prefix+"/") {
				path := pattern
				for _, param := range []string{"{id}", "{iid}", "{key}"} {
					path = strings.ReplaceAll(path, param, uuid)
				}
				found = append(found, route{method, path})
				return nil
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	// The walk must really see the routes (guards against a prefix typo making this vacuous).
	if len(found) < 20 {
		t.Fatalf("only %d customer routes found: %v", len(found), found)
	}
	want := map[route]bool{
		{http.MethodGet, "/api/v1/customers"}:                     false,
		{http.MethodGet, "/api/v1/customers/" + uuid}:             false,
		{http.MethodGet, "/api/v1/customers/by-phone"}:            false,
		{http.MethodPost, "/api/v1/customers/import"}:             false,
		{http.MethodGet, "/api/v1/tags"}:                          false,
		{http.MethodGet, "/api/v1/segments"}:                      false,
		{http.MethodGet, "/api/v1/customers/dup-candidates"}:      false,
		{http.MethodGet, "/api/v1/customers/" + uuid + "/points"}: false,
	}
	for _, r := range found {
		if _, tracked := want[r]; tracked {
			want[r] = true
		}
	}
	for r, seen := range want {
		if !seen {
			t.Errorf("expected route not found by the walk: %s %s", r.method, r.path)
		}
	}

	for _, r := range found {
		for _, c := range callers {
			rec := send(router, r.method, r.path, c.token, `{}`)
			if rec.Code != http.StatusForbidden {
				t.Errorf("%s %s as %s = %d, want 403 (body %s)", r.method, r.path, c.name, rec.Code, rec.Body)
			}
		}
	}
}
