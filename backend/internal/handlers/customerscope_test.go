package handlers

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/mandalika/pos-backend/internal/auth"
)

func scopeReq(role string, perms ...string) *http.Request {
	r := httptest.NewRequest(http.MethodGet, "/customers", nil)
	ctx := r.Context()
	if role != "" {
		ctx = context.WithValue(ctx, auth.CtxRole, role)
	}
	ctx = context.WithValue(ctx, auth.CtxPerms, perms)
	return r.WithContext(ctx)
}

func TestCustomerScopeResolver(t *testing.T) {
	cases := []struct {
		name string
		role string
		perm []string
		want CustomerAccess
	}{
		{"admin sees all", "admin", nil, CustomerAll},
		{"manager with manage_customers sees all", "manager", []string{"manage_customers"}, CustomerAll},
		{"manager without manage_customers is phone-only", "manager", []string{"view_reports"}, CustomerPhoneOnly},
		{"cashier is phone-only", "cashier", nil, CustomerPhoneOnly},
		{"cashier with manage_customers stays phone-only", "cashier", []string{"manage_customers"}, CustomerPhoneOnly},
		{"missing role is phone-only", "", []string{"manage_customers"}, CustomerPhoneOnly},
		{"unknown role with manage_customers sees all", "supervisor", []string{"manage_customers"}, CustomerAll},
	}
	for _, c := range cases {
		if got := customerScope(scopeReq(c.role, c.perm...)); got != c.want {
			t.Errorf("%s: got %v want %v", c.name, got, c.want)
		}
	}
}

func TestRequireCustomerReaderGuard(t *testing.T) {
	ok := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	guard := RequireCustomerReader()(ok)
	for _, c := range []struct {
		role string
		perm []string
		want int
	}{
		{"admin", nil, http.StatusNoContent},
		{"manager", []string{"manage_customers"}, http.StatusNoContent},
		{"manager", nil, http.StatusForbidden},
		{"cashier", nil, http.StatusForbidden},
		{"cashier", []string{"manage_customers"}, http.StatusForbidden},
	} {
		w := httptest.NewRecorder()
		guard.ServeHTTP(w, scopeReq(c.role, c.perm...))
		if w.Code != c.want {
			t.Errorf("%s %v: got %d want %d", c.role, c.perm, w.Code, c.want)
		}
	}
}
