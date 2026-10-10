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
	router := New(cfg, &db.DB{Pool: pool}, &cache.Cache{R: rc}, nil)

	issue := func(role string) string {
		t.Helper()
		tok, err := auth.IssueAccess(secret, time.Hour, "33333333-3333-3333-3333-333333333333", role, "", nil)
		if err != nil {
			t.Fatal(err)
		}
		return tok
	}
	const path = "/api/v1/users/22222222-2222-2222-2222-222222222222/reset-password"
	for _, tc := range []struct {
		name, token string
		want        int
	}{
		{"no token", "", http.StatusUnauthorized},
		{"cashier", issue("cashier"), http.StatusForbidden},
		{"manager", issue("manager"), http.StatusForbidden},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(`{"password":"longenough1"}`))
			if tc.token != "" {
				req.Header.Set("Authorization", "Bearer "+tc.token)
			}
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)
			if rec.Code != tc.want {
				t.Fatalf("status %d want %d body=%s", rec.Code, tc.want, rec.Body)
			}
		})
	}
}
