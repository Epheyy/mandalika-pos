package ingressmodel

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/cache"
	"github.com/mandalika/pos-backend/internal/config"
	mw "github.com/mandalika/pos-backend/internal/middleware"
	"github.com/redis/go-redis/v9"
)

func request(h http.Header) *http.Request {
	r := httptest.NewRequest("POST", "https://model.invalid/api/v1/orders", nil)
	r.RemoteAddr = "192.0.2.200:43100" // synthetic transport peer, never changed
	r.Header = h
	return r
}

func serve(h http.Handler, r *http.Request) int {
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w.Code
}

func redisFixture(t *testing.T) (*cache.Cache, *miniredis.Miniredis) {
	t.Helper()
	s := miniredis.NewMiniRedis()
	if err := s.StartAddr("127.0.0.1:0"); err != nil {
		t.Fatal(err)
	}
	r := redis.NewClient(&redis.Options{Addr: s.Addr(), MaxRetries: -1, DialTimeout: 100 * time.Millisecond, ReadTimeout: 100 * time.Millisecond, WriteTimeout: 100 * time.Millisecond})
	addr := s.Addr()
	t.Cleanup(func() {
		_ = r.Close()
		s.Close()
		c, err := net.DialTimeout("tcp", addr, 100*time.Millisecond)
		if err == nil {
			_ = c.Close()
			t.Error("synthetic Redis listener remained open")
		}
	})
	return &cache.Cache{R: r}, s
}

func TestEdgeReplacementAndAppendCounterexample(t *testing.T) {
	in := http.Header{Header: {"198.51.100.9", "198.51.100.10"}, strings.ToLower(Header): {"198.51.100.11"}, "X-Forwarded-For": {"203.0.113.99"}}
	out := Edge(in, "192.0.2.10")
	ip, err := Parse(out)
	if err != nil || ip.String() != "192.0.2.10" || len(in[Header]) != 2 {
		t.Fatalf("replacement or detached input: %v %v", ip, err)
	}
	bad := in.Clone()
	bad.Add(Header, "192.0.2.10")
	if _, err := Parse(bad); err == nil {
		t.Fatal("append counterexample accepted")
	}
}

func TestIdentityAgreementAndRawPeer(t *testing.T) {
	for _, tc := range []struct{ input, normalized string }{
		{"192.0.2.1", "192.0.2.1"},
		{"2001:0db8:0000:0000:0000:0000:0000:0001", "2001:db8::1"},
		{"::ffff:192.0.2.1", "192.0.2.1"},
		{"2001:db8::2", "2001:db8::2"},
	} {
		t.Run(tc.input, func(t *testing.T) {
			called := false
			h := Select(true, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				called = true
				id, ok := Selected(r)
				if !ok || id.Client.String() != tc.normalized || id.RawPeer != r.RemoteAddr || r.RemoteAddr != "192.0.2.200:43100" {
					t.Fatalf("identity mismatch: %+v", id)
				}
				for _, prefix := range []string{"api", "auth", "ota"} {
					if got := GeneralKey(prefix, id, time.Unix(1800, 0), time.Minute); got != "rl:"+prefix+":"+tc.normalized+":30" {
						t.Fatal(got)
					}
				}
				if LoginKey(id, "Cashier@example.invalid") != "rl:login:"+tc.normalized+":Cashier@example.invalid" {
					t.Fatal("login split/normalization/case drift")
				}
				w.WriteHeader(204)
			}))
			if serve(h, request(Edge(nil, tc.input))) != 204 || !called {
				t.Fatal("not dispatched")
			}
		})
	}
}

func TestInvalidIdentityCannotDispatchOrTouchRedis(t *testing.T) {
	c, s := redisFixture(t)
	cases := map[string]http.Header{
		"missing": {}, "empty": {Header: {""}}, "duplicate": {Header: {"192.0.2.1", "192.0.2.2"}},
		"case-duplicate": {Header: {"192.0.2.1"}, strings.ToLower(Header): {"192.0.2.2"}},
		"comma":          {Header: {"192.0.2.1,192.0.2.2"}}, "port": {Header: {"192.0.2.1:8080"}},
		"ipv6-port": {Header: {"[2001:db8::1]:80"}}, "zone": {Header: {"fe80::1%eth0"}},
		"oversize": {Header: {strings.Repeat("a", 46)}}, "whitespace": {Header: {" 192.0.2.1"}},
		"invalid": {Header: {"not-an-address"}}, "newline": {Header: {"192.0.2.1\n"}},
		"unicode": {Header: {"１９２.0.2.1"}}, "empty-field": {Header: nil},
	}
	for name, hdr := range cases {
		t.Run(name, func(t *testing.T) {
			hdr.Set("X-Forwarded-For", "203.0.113.7")
			hdr.Set("X-Real-IP", "203.0.113.8")
			hdr.Set("True-Client-IP", "203.0.113.9")
			h := Select(true, Limit(c, "api", 1200, time.Minute, time.Unix(1800, 0), http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Fatal("business dispatch") })))
			if got := serve(h, request(hdr)); got != 503 || len(s.Keys()) != 0 {
				t.Fatalf("status=%d keys=%v", got, s.Keys())
			}
		})
	}
}

func TestBypassBlockedDespiteHeaderHostAndForwardedHints(t *testing.T) {
	for _, route := range []string{"numbered", "hashed", "internal", "tag", "alternate-lb", "unknown"} {
		t.Run(route, func(t *testing.T) {
			r := request(Edge(nil, "192.0.2.1"))
			r.Host = "canonical.example.invalid"
			r.Header.Set("X-Route-Trusted", "true")
			h := Select(false, http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Fatal("bypass dispatched") }))
			if serve(h, r) != 403 {
				t.Fatal("route spoof accepted")
			}
		})
	}
}

func TestObservedPeersNotForwardedHeadersChooseBuckets(t *testing.T) {
	c, s := redisFixture(t)
	h := Select(true, Limit(c, "api", 1200, time.Minute, time.Unix(1800, 0), http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(204) })))
	for i, peer := range []string{"192.0.2.1", "192.0.2.1", "192.0.2.2"} {
		hdr := http.Header{"X-Forwarded-For": {fmt.Sprintf("203.0.113.%d", i+1)}, "X-Real-IP": {"198.51.100.1"}, "True-Client-IP": {"198.51.100.2"}}
		if serve(h, request(Edge(hdr, peer))) != 204 {
			t.Fatal("request failed")
		}
	}
	if len(s.Keys()) != 2 {
		t.Fatal(s.Keys())
	}
	if n, _ := s.Get("rl:api:192.0.2.1:30"); n != "2" {
		t.Fatal(n)
	}
}

func TestExistingThresholdsWindowsAndRedisFailure(t *testing.T) {
	c, s := redisFixture(t)
	id := Identity{Client: netip.MustParseAddr("2001:db8::1"), Valid: true}
	now := time.Unix(1800, 0)
	for _, tc := range []struct {
		prefix string
		max    int
	}{{"api", 1200}, {"auth", 10}, {"ota", 120}} {
		t.Run(tc.prefix, func(t *testing.T) {
			key := GeneralKey(tc.prefix, id, now, time.Minute)
			s.Set(key, strconvI(tc.max-1)) // bounded boundary proof, not thousands of requests
			s.SetTTL(key, time.Minute)
			h := Select(true, Limit(c, tc.prefix, tc.max, time.Minute, now, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(204) })))
			if serve(h, request(Edge(nil, "2001:db8::1"))) != 204 || serve(h, request(Edge(nil, "2001:db8::1"))) != 429 {
				t.Fatal("threshold drift")
			}
			if s.TTL(key) != time.Minute {
				t.Fatal("window drift")
			}
		})
	}
	key := LoginKey(id, "Cashier@example.invalid")
	s.Set(key, "9")
	if LoginLimited(c, id, "Cashier@example.invalid") || !LoginLimited(c, id, "Cashier@example.invalid") || s.TTL(key) != 5*time.Minute {
		t.Fatal("login threshold/sliding expiry drift")
	}
	s.SetError("ERR synthetic Redis outage")
	h := Select(true, Limit(c, "api", 1200, time.Minute, now, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(204) })))
	if serve(h, request(Edge(nil, "2001:db8::1"))) != 204 || LoginLimited(c, id, "Cashier@example.invalid") {
		t.Fatal("valid-identity Redis fail-open drift")
	}
	if serve(h, request(nil)) != 503 {
		t.Fatal("Redis error bypassed identity validation")
	}
}

func strconvI(n int) string { return fmt.Sprint(n) }

func TestActualAuthAndOutletPermissionRemainIndependent(t *testing.T) {
	cfg := &config.Config{AccessSecret: []byte("synthetic-model-only-not-a-real-credential")}
	end := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(204) })
	h := Select(true, mw.RequireAuth(cfg)(mw.RequirePermission("process_refund")(end)))
	if serve(h, request(Edge(nil, "192.0.2.1"))) != 401 {
		t.Fatal("IP trusted without application authentication")
	}
	for _, tc := range []struct {
		name, outlet string
		perms        []string
		want         int
	}{
		{"missing-permission", "outlet-a", nil, 403},
		{"wrong-outlet", "outlet-b", []string{"process_refund"}, 403},
		{"authorized", "outlet-a", []string{"process_refund"}, 204},
	} {
		t.Run(tc.name, func(t *testing.T) {
			token, err := auth.IssueAccess(cfg.AccessSecret, time.Minute, "synthetic-user", "cashier", "outlet-a", tc.perms)
			if err != nil {
				t.Fatal(err)
			}
			r := request(Edge(nil, "192.0.2.1"))
			r.Header.Set("Authorization", "Bearer "+token)
			r.Header.Set("X-Outlet-Id", tc.outlet)
			if got := serve(h, r); got != tc.want {
				t.Fatalf("status=%d want=%d", got, tc.want)
			}
		})
	}
}

func TestHTTPMonitorHasNoIdentityBypass(t *testing.T) {
	c, _ := redisFixture(t)
	h := Select(true, Limit(c, "api", 1200, time.Minute, time.Unix(1800, 0), http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(204) })))
	for _, path := range []string{"/readyz", "/healthz", "/api/v1/ota/check"} {
		r := request(nil)
		r.URL.Path = path
		if serve(h, r) != 503 {
			t.Fatal("path bypass: " + path)
		}
		r.Header = Edge(nil, "192.0.2.11")
		if serve(h, r) != 204 {
			t.Fatal("qualified monitor failed")
		}
	}
	// Terminal handlers are inert: this is not a deployed health check or DB proof.
}

func TestMissingContextCannotUseRedisFailOpen(t *testing.T) {
	c, s := redisFixture(t)
	s.SetError("ERR synthetic")
	h := Limit(c, "api", 1200, time.Minute, time.Now(), http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Fatal("missing context bypass") }))
	if serve(h, request(Edge(nil, "192.0.2.1"))) != 503 {
		t.Fatal("missing context accepted")
	}
	if c.Incr(context.Background(), "synthetic-check", time.Minute) != 0 {
		t.Fatal("actual cache outage behavior changed")
	}
}

func TestInvalidLoginIdentityNeverCreatesBucket(t *testing.T) {
	c, s := redisFixture(t)
	for _, id := range []Identity{{}, {Valid: true}, {Client: netip.MustParseAddr("192.0.2.1")}} {
		if !LoginLimited(c, id, "cashier@example.invalid") || len(s.Keys()) != 0 {
			t.Fatal("invalid identity created a login bucket or bypassed limiting")
		}
	}
}
