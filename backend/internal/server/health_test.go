package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/mandalika/pos-backend/internal/cache"
)

type fakePing struct{ err error }

func (f fakePing) Ping(context.Context) error { return f.err }

func health(t *testing.T, db pinger, c *cache.Cache) (int, map[string]string) {
	t.Helper()
	rec := httptest.NewRecorder()
	healthHandler(db, c)(rec, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	var env struct {
		Data map[string]string `json:"data"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &env)
	return rec.Code, env.Data
}

func TestHealthzRedisIsOptional(t *testing.T) {
	disabled, _ := cache.Connect(context.Background(), "", cache.Options{})
	down, _ := cache.Connect(context.Background(), "redis://127.0.0.1:1/0",
		cache.Options{DialTimeout: 200 * time.Millisecond, OpTimeout: 200 * time.Millisecond})

	code, body := health(t, fakePing{}, disabled)
	if code != 200 || body["status"] != "degraded" || body["db"] != "ok" || body["redis"] != "disabled" {
		t.Fatalf("disabled: %d %v", code, body)
	}
	code, body = health(t, fakePing{}, down)
	if code != 200 || body["status"] != "degraded" || body["redis"] != "down" {
		t.Fatalf("down: %d %v", code, body)
	}
	if code, _ := health(t, fakePing{err: errors.New("boom")}, disabled); code != 503 {
		t.Fatalf("db down must be 503, got %d", code)
	}
}

func TestReadyzIsDependencyFree(t *testing.T) {
	router, _ := newRouteHarness(t) // lazy, never-dialled pool
	rec := send(router, http.MethodGet, "/readyz", "", "")
	if rec.Code != 200 {
		t.Fatalf("readyz %d", rec.Code)
	}
}

// Cloud Run swallows /healthz, so the deep check must also answer on /livez
// with the same handler: same status, same body, no auth, no leaked DSN.
func TestLivezServesSameDeepHealthAsHealthz(t *testing.T) {
	router, _ := newRouteHarness(t) // pool points at a dead address
	hz := send(router, http.MethodGet, "/healthz", "", "")
	lz := send(router, http.MethodGet, "/livez", "", "")
	if lz.Code != http.StatusServiceUnavailable || lz.Code != hz.Code {
		t.Fatalf("livez %d healthz %d, want identical 503 (db down)", lz.Code, hz.Code)
	}
	if body := lz.Body.String(); body != hz.Body.String() || strings.Contains(body, "postgres://") || strings.Contains(body, "127.0.0.1") {
		t.Fatalf("livez body %q healthz body %q", body, hz.Body.String())
	}
}
