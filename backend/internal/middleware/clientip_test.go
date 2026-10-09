package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/mandalika/pos-backend/internal/clientip"
)

func TestClientIPMiddleware(t *testing.T) {
	const remote = "10.0.0.9:4321"
	var gotIP, gotBucket, gotRemote string
	h := ClientIP(1)(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		gotIP = clientip.ClientIP(r)
		gotBucket = clientip.ClientIPBucket(r)
		gotRemote = r.RemoteAddr
	}))

	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.RemoteAddr = remote
	r.Header.Set("X-Forwarded-For", "6.6.6.6, 2001:db8:1:2::9")
	r.Header.Set("True-Client-IP", "7.7.7.7")
	h.ServeHTTP(httptest.NewRecorder(), r)

	if gotIP != "2001:db8:1:2::9" {
		t.Fatalf("ClientIP = %q", gotIP)
	}
	if gotBucket != "2001:db8:1:2::/64" {
		t.Fatalf("bucket = %q", gotBucket)
	}
	if gotRemote != remote {
		t.Fatalf("RemoteAddr rewritten to %q", gotRemote)
	}
}

func TestClientIPMiddlewareFallback(t *testing.T) {
	var gotIP string
	h := ClientIP(1)(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		gotIP = clientip.ClientIP(r)
	}))
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.RemoteAddr = "10.0.0.9:4321"
	r.Header.Set("X-Forwarded-For", "garbage")
	h.ServeHTTP(httptest.NewRecorder(), r)
	if gotIP != "10.0.0.9" {
		t.Fatalf("ClientIP = %q", gotIP)
	}
}
