package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/cache"
	"github.com/mandalika/pos-backend/internal/config"
	"github.com/mandalika/pos-backend/internal/db"
)

// The reset-password route must sit behind RequireAuth + RequireRole("admin").
// Both rejections happen before any DB access, so a lazy (never-dialled) pool
// and an in-memory Redis are enough to exercise the real router.
func TestResetPasswordRouteRequiresAdmin(t *testing.T) {
	router, issue := newRouteHarness(t)
	const path = "/api/v1/users/22222222-2222-2222-2222-222222222222/reset-password"
	for _, tc := range []struct {
		name, token string
		want        int
	}{
		{"no token", "", http.StatusUnauthorized},
		{"cashier", issue("cashier", adminUID), http.StatusForbidden},
		{"manager", issue("manager", adminUID), http.StatusForbidden},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := send(router, http.MethodPost, path, tc.token, `{"password":"longenough1"}`)
			if rec.Code != tc.want {
				t.Fatalf("status %d want %d body=%s", rec.Code, tc.want, rec.Body)
			}
		})
	}
}

// A non-canonical spelling of the admin's own id must still hit the self-reset 403.
func TestResetPasswordRouteBlocksSelfInAnySpelling(t *testing.T) {
	router, issue := newRouteHarness(t)
	tok := issue("admin", adminUID)
	for _, id := range []string{
		strings.ToUpper(adminUID),
		"{" + adminUID + "}",
		strings.ReplaceAll(adminUID, "-", ""),
	} {
		rec := send(router, http.MethodPost, "/api/v1/users/"+id+"/reset-password", tok, `{"password":"longenough1"}`)
		if rec.Code != http.StatusForbidden {
			t.Errorf("id %q: status %d want 403 body=%s", id, rec.Code, rec.Body)
		}
	}
}

// Password changes are admin-reset only: PUT /users/{id} must reject `password`.
func TestUpdateUserRejectsPasswordField(t *testing.T) {
	router, issue := newRouteHarness(t)
	rec := send(router, http.MethodPut, "/api/v1/users/22222222-2222-2222-2222-222222222222",
		issue("admin", adminUID), `{"displayName":"x","password":"longenough1"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status %d want 400 body=%s", rec.Code, rec.Body)
	}
}

const adminUID = "33333333-3333-3333-3333-333333333333"

func send(router http.Handler, method, path, token, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec
}

func newRouteHarness(t *testing.T) (http.Handler, func(role, uid string) string) {
	t.Helper()
	secret := []byte("RESET-ROUTE-SYNTHETIC-KEY-NOT-A-PRODUCTION-SECRET")
	mr := miniredis.RunT(t)
	rc := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = rc.Close() })
	pool, err := pgxpool.New(context.Background(), "postgres://x:x@127.0.0.1:1/x")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	cfg := &config.Config{AccessSecret: secret, RateLimitRPS: 100}
	router := New(cfg, &db.DB{Pool: pool}, cache.NewFromClient(rc), nil)
	issue := func(role, uid string) string {
		t.Helper()
		tok, err := auth.IssueAccess(secret, time.Hour, uid, role, "", nil)
		if err != nil {
			t.Fatal(err)
		}
		return tok
	}
	return router, issue
}
