package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/mandalika/pos-backend/internal/config"
)

const erpTestSchedulerToken = "ERP-SCHEDULER-SYNTHETIC-TOKEN-0123456789ab"

// clearERPEnv keeps a developer shell from changing the results.
func clearERPEnv(t *testing.T) {
	t.Helper()
	for _, k := range []string{"ERP_RELAY_ENABLED", "ERP_BASE_URL", "ERP_API_KEY", "ERP_SCHEDULER_TOKEN", "ERP_BRAND", "ERP_RELAY_MAX_ATTEMPTS"} {
		t.Setenv(k, "")
	}
}

// Every rejection below happens before any DB access, so the lazy pool of the
// shared route harness is enough.
func TestErpAdminRoutesRequireAdmin(t *testing.T) {
	clearERPEnv(t)
	router, issue := newRouteHarness(t)
	const id = "22222222-2222-2222-2222-222222222222"
	for _, rt := range []struct{ method, path string }{
		{http.MethodPost, "/api/v1/admin/erp/relay"},
		{http.MethodGet, "/api/v1/admin/erp/outbox"},
		{http.MethodGet, "/api/v1/admin/erp/outbox/" + id},
		{http.MethodPost, "/api/v1/admin/erp/outbox/" + id + "/retry"},
	} {
		for _, tc := range []struct {
			name, token string
			want        int
		}{
			{"no token", "", http.StatusUnauthorized},
			{"cashier", issue("cashier", adminUID), http.StatusForbidden},
			{"manager", issue("manager", adminUID), http.StatusForbidden},
		} {
			t.Run(rt.method+" "+rt.path+" "+tc.name, func(t *testing.T) {
				rec := send(router, rt.method, rt.path, tc.token, "")
				if rec.Code != tc.want {
					t.Fatalf("status %d want %d body=%s", rec.Code, tc.want, rec.Body)
				}
			})
		}
	}
}

func TestErpAdminOutboxRejectsBadInputBeforeDB(t *testing.T) {
	clearERPEnv(t)
	router, issue := newRouteHarness(t)
	tok := issue("admin", adminUID)
	for _, path := range []string{"/api/v1/admin/erp/outbox/not-a-uuid"} {
		if rec := send(router, http.MethodGet, path, tok, ""); rec.Code != http.StatusBadRequest {
			t.Errorf("%s: status %d want 400 body=%s", path, rec.Code, rec.Body)
		}
	}
	if rec := send(router, http.MethodPost, "/api/v1/admin/erp/outbox/nope/retry", tok, ""); rec.Code != http.StatusBadRequest {
		t.Errorf("retry bad id: status %d want 400", rec.Code)
	}
	// Disabled relay answers without touching the DB.
	rec := send(router, http.MethodPost, "/api/v1/admin/erp/relay", tok, "")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"disabled":true`) {
		t.Fatalf("disabled relay: status %d body=%s", rec.Code, rec.Body)
	}
}

func TestErpSchedulerRouteSecret(t *testing.T) {
	post := func(router http.Handler, secret string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/internal/erp/relay", nil)
		if secret != "" {
			req.Header.Set("X-Scheduler-Secret", secret)
		}
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		return rec
	}

	t.Run("not configured is 503", func(t *testing.T) {
		clearERPEnv(t)
		router, _ := newRouteHarness(t)
		if rec := post(router, erpTestSchedulerToken); rec.Code != http.StatusServiceUnavailable {
			t.Fatalf("status %d want 503 body=%s", rec.Code, rec.Body)
		}
	})
	t.Run("configured", func(t *testing.T) {
		clearERPEnv(t)
		router, _ := newRouteHarnessCfg(t, func(c *config.Config) { c.ERPSchedulerToken = erpTestSchedulerToken })
		if rec := post(router, ""); rec.Code != http.StatusUnauthorized {
			t.Fatalf("missing header: status %d want 401", rec.Code)
		}
		if rec := post(router, "wrong-secret"); rec.Code != http.StatusUnauthorized {
			t.Fatalf("wrong header: status %d want 401", rec.Code)
		}
		rec := post(router, erpTestSchedulerToken)
		if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"disabled":true`) {
			t.Fatalf("right secret, relay off: status %d body=%s", rec.Code, rec.Body)
		}
	})
}
