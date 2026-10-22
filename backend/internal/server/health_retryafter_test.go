package server

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/mandalika/pos-backend/internal/cache"
)

func TestHealthzDbDownSendsRetryAfter(t *testing.T) {
	disabled, _ := cache.Connect(context.Background(), "", cache.Options{})
	rec := httptest.NewRecorder()
	healthHandler(fakePing{err: errors.New("down")}, disabled)(rec, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if rec.Code != http.StatusServiceUnavailable || rec.Header().Get("Retry-After") != "5" {
		t.Fatalf("%d Retry-After=%q", rec.Code, rec.Header().Get("Retry-After"))
	}
}
