package server

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/cors"
)

func TestCORSExposesRetryAfter(t *testing.T) {
	h := cors.Handler(corsOptions([]string{"https://localhost"}))(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Retry-After", "5")
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	req := httptest.NewRequest(http.MethodGet, "/api/v1/sync/version", nil)
	req.Header.Set("Origin", "https://localhost")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if got := rec.Header().Get("Access-Control-Expose-Headers"); got != "Retry-After" {
		t.Fatalf("Access-Control-Expose-Headers=%q, want Retry-After", got)
	}
	if rec.Header().Get("Access-Control-Allow-Origin") != "https://localhost" {
		t.Fatalf("allowed origin not echoed: %v", rec.Header())
	}
}
