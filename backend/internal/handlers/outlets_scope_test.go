package handlers

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/mandalika/pos-backend/internal/auth"
)

func updateOutletReq(role, ownOutlet, targetID string) *http.Request {
	rc := chi.NewRouteContext()
	rc.URLParams.Add("id", targetID)
	r := httptest.NewRequest(http.MethodPut, "/outlets/"+targetID, strings.NewReader("{}"))
	ctx := context.WithValue(r.Context(), chi.RouteCtxKey, rc)
	ctx = context.WithValue(ctx, auth.CtxRole, role)
	ctx = context.WithValue(ctx, auth.CtxOutletID, ownOutlet)
	return r.WithContext(ctx)
}

// A non-admin is refused for any outlet but their own, before the body or DB is touched.
func TestUpdateOutletRefusesOtherOutlet(t *testing.T) {
	for _, c := range []struct{ role, own string }{
		{"manager", "outlet-a"},
		{"manager", ""},
		{"cashier", "outlet-a"},
	} {
		w := httptest.NewRecorder()
		(&Handlers{}).UpdateOutlet(w, updateOutletReq(c.role, c.own, "outlet-b"))
		if w.Code != http.StatusForbidden || !strings.Contains(w.Body.String(), "outlet not permitted") {
			t.Errorf("%s/%q: got %d %s", c.role, c.own, w.Code, w.Body.String())
		}
	}
}

// An admin is never refused, even when the token or X-Outlet-Id carries an outlet.
func TestUpdateOutletAdminWithOutletNotRefused(t *testing.T) {
	for _, own := range []string{"", "outlet-a"} {
		r := updateOutletReq("admin", own, "outlet-b")
		r.Body = http.NoBody // empty body: fails decode (400) before any DB use
		w := httptest.NewRecorder()
		(&Handlers{}).UpdateOutlet(w, r)
		if w.Code == http.StatusForbidden {
			t.Errorf("admin with outlet %q got 403", own)
		}
	}
}

func TestUpdateOutletScopeAllowsOwnAndAdmin(t *testing.T) {
	if !canEditOutletID(updateOutletReq("manager", "outlet-a", "outlet-a"), "outlet-a") {
		t.Error("manager should reach own outlet")
	}
	if !canEditOutletID(updateOutletReq("admin", "", "outlet-b"), "outlet-b") {
		t.Error("admin should reach any outlet")
	}
}
