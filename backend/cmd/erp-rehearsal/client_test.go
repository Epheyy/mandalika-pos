package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestReplaySafe(t *testing.T) {
	key := map[string]string{"Idempotency-Key": "k"}
	cases := []struct {
		method, path string
		h            map[string]string
		want         bool
	}{
		{"GET", "/products?outletId=x", nil, true},
		{"PUT", "/products/p1", nil, true},
		{"POST", "/api/v1/auth/login", nil, true},
		{"POST", "/internal/erp/catalog-pull?mode=full", nil, true},
		{"POST", "/internal/erp/relay", nil, true},
		{"POST", "/_stub/fg", nil, true},
		{"POST", "/_stub/fault?status=503&count=1", nil, true},
		{"POST", "/sync/batch", nil, true},
		{"POST", "/inventory/goods-receipt?kind=outlet&id=o", key, true},
		{"POST", "/transfers/t1/send", key, true},
		{"POST", "/inventory/goods-receipt?kind=outlet&id=o", nil, false},
		{"POST", "/products", nil, false},
		{"POST", "/transfers", nil, false},
		{"POST", "/transfers/t1/receive", nil, false},
		{"POST", "/shifts", nil, false},
		{"POST", "/inventory/adjust?kind=outlet&id=o", nil, false},
		{"POST", "/admin/erp/outbox/x/retry", nil, false},
		{"DELETE", "/products/p1", nil, true},
	}
	for _, c := range cases {
		if got := replaySafe(c.method, c.path, c.h); got != c.want {
			t.Errorf("replaySafe(%s %s, key=%v) = %v, want %v", c.method, c.path, c.h != nil, got, c.want)
		}
	}
}

// dropFirst answers with a hijacked, closed connection (a transport failure, no HTTP
// response) for the first n requests, then with status.
func dropFirst(t *testing.T, n int32, status int) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if hits.Add(1) <= n {
			conn, _, err := w.(http.Hijacker).Hijack()
			if err == nil {
				_ = conn.Close()
			}
			return
		}
		w.WriteHeader(status)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	t.Cleanup(srv.Close)
	return srv, &hits
}

func fastBackoff(t *testing.T) {
	t.Helper()
	saved := retryBackoff
	retryBackoff = []time.Duration{time.Millisecond, time.Millisecond, time.Millisecond, time.Millisecond}
	t.Cleanup(func() { retryBackoff = saved })
}

func TestCallRetriesTransportFailureOnReplaySafeRequest(t *testing.T) {
	fastBackoff(t)
	srv, hits := dropFirst(t, 2, http.StatusOK)
	c := newHTTP(srv.URL, nil)
	var logged []string
	c.onRetry = func(msg string) { logged = append(logged, msg) }
	out, err := c.call("POST", "/sync/batch", nil, obj{"items": []obj{}})
	if err != nil || out.Code != http.StatusOK {
		t.Fatalf("call = %+v, %v; want 200 after retries", out, err)
	}
	if hits.Load() != 3 || len(logged) != 2 || !strings.Contains(logged[0], "transport retry 1/4 of POST /sync/batch") {
		t.Fatalf("hits=%d logged=%q", hits.Load(), logged)
	}
}

func TestCallGivesUpAfterFourRetries(t *testing.T) {
	fastBackoff(t)
	srv, hits := dropFirst(t, 100, http.StatusOK)
	if _, err := newHTTP(srv.URL, nil).call("GET", "/x", nil, nil); err == nil {
		t.Fatal("want the transport error after the last retry")
	}
	if hits.Load() != 5 {
		t.Fatalf("attempts = %d, want 5", hits.Load())
	}
}

func TestCallSendsUnsafeWriteOnce(t *testing.T) {
	fastBackoff(t)
	srv, hits := dropFirst(t, 1, http.StatusOK)
	if _, err := newHTTP(srv.URL, nil).call("POST", "/products", nil, obj{"name": "x"}); err == nil {
		t.Fatal("want the transport error: POST /products must not be replayed")
	}
	if hits.Load() != 1 {
		t.Fatalf("attempts = %d, want 1", hits.Load())
	}
}

func TestCallNeverRetriesAnHTTPResponse(t *testing.T) {
	fastBackoff(t)
	srv, hits := dropFirst(t, 0, http.StatusServiceUnavailable)
	out, err := newHTTP(srv.URL, nil).call("GET", "/x", nil, nil)
	if err != nil || out.Code != http.StatusServiceUnavailable || hits.Load() != 1 {
		t.Fatalf("out=%+v err=%v hits=%d; want one 503, no retry", out, err, hits.Load())
	}
}
