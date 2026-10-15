package middleware

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"

	"github.com/mandalika/pos-backend/internal/cache"
)

func hit(h http.Handler, remote string) int {
	req := httptest.NewRequest(http.MethodPost, "/auth/login", nil)
	req.RemoteAddr = remote + ":1234"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec.Code
}

func limited(c *cache.Cache) http.Handler {
	ok := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(200) })
	return RateLimit(c, "auth", 10, time.Minute)(ok)
}

func disabledCache(t *testing.T) *cache.Cache {
	t.Helper()
	c, err := cache.Connect(context.Background(), "", cache.Options{})
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestRateLimitEnforcedFromMemoryWhenRedisDown(t *testing.T) {
	down, err := cache.Connect(context.Background(), "redis://127.0.0.1:1/0",
		cache.Options{DialTimeout: 200 * time.Millisecond, OpTimeout: 200 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	for name, c := range map[string]*cache.Cache{"refused": down, "disabled": disabledCache(t)} {
		t.Run(name, func(t *testing.T) {
			h := limited(c)
			for i := 1; i <= 10; i++ {
				if code := hit(h, "198.51.100.7"); code != 200 {
					t.Fatalf("request %d: %d", i, code)
				}
			}
			if code := hit(h, "198.51.100.7"); code != 429 {
				t.Fatalf("request 11: %d want 429", code)
			}
			if code := hit(h, "198.51.100.8"); code != 200 {
				t.Fatalf("other IP must not share the bucket: %d", code)
			}
		})
	}
}

func TestRateLimitWithRedisUnchanged(t *testing.T) {
	mr := miniredis.RunT(t)
	rc := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = rc.Close() })
	h := limited(cache.NewFromClient(rc))
	for i := 1; i <= 10; i++ {
		if code := hit(h, "198.51.100.7"); code != 200 {
			t.Fatalf("request %d: %d", i, code)
		}
	}
	if code := hit(h, "198.51.100.7"); code != 429 {
		t.Fatalf("request 11: %d want 429", code)
	}
	if len(mr.Keys()) != 1 {
		t.Fatalf("expected the counter in redis, keys=%v", mr.Keys())
	}
}

// Redis command volume (Upstash bills per command): the first hit of a window is
// INCR + EXPIRE, every later hit is a single INCR (no MULTI/EXEC transaction).
func TestRateLimitRedisCommandVolume(t *testing.T) {
	mr := miniredis.RunT(t)
	rc := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = rc.Close() })
	h := limited(cache.NewFromClient(rc))
	if code := hit(h, "198.51.100.9"); code != 200 { // warm the connection handshake
		t.Fatal(code)
	}
	before := mr.CommandCount()
	for i := 0; i < 5; i++ {
		hit(h, "198.51.100.9")
	}
	if got := mr.CommandCount() - before; got != 5 {
		t.Fatalf("5 later hits in one window used %d redis commands, want 5 (one INCR each)", got)
	}
}
