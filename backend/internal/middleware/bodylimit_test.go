package middleware

import (
	"bytes"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func fixedLimit(n int64) func(*http.Request) int64 {
	return func(*http.Request) int64 { return n }
}

func TestBodyLimitRejectsSizedOversizedBodyWithoutRunningHandler(t *testing.T) {
	ran := false
	h := BodyLimit(fixedLimit(10))(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { ran = true }))
	req := httptest.NewRequest(http.MethodPost, "/x", strings.NewReader(strings.Repeat("a", 11)))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413", rec.Code)
	}
	if ran {
		t.Fatal("next handler must not run for a sized oversized body")
	}
	if got := strings.TrimSpace(rec.Body.String()); got != `{"data":null,"error":"request body too large"}` {
		t.Fatalf("body = %q", got)
	}
}

func TestBodyLimitChunkedOversizedBodyFailsWithMaxBytesError(t *testing.T) {
	var readErr error
	h := BodyLimit(fixedLimit(10))(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, readErr = io.ReadAll(r.Body)
	}))
	req := httptest.NewRequest(http.MethodPost, "/x", io.NopCloser(strings.NewReader(strings.Repeat("a", 50))))
	req.ContentLength = -1
	h.ServeHTTP(httptest.NewRecorder(), req)
	var tooBig *http.MaxBytesError
	if !errors.As(readErr, &tooBig) {
		t.Fatalf("read error = %v, want *http.MaxBytesError", readErr)
	}
}

func TestBodyLimitPassesUnderLimitBodyIntact(t *testing.T) {
	var got []byte
	h := BodyLimit(fixedLimit(10))(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got, _ = io.ReadAll(r.Body)
	}))
	req := httptest.NewRequest(http.MethodPost, "/x", bytes.NewReader([]byte("0123456789")))
	h.ServeHTTP(httptest.NewRecorder(), req)
	if string(got) != "0123456789" {
		t.Fatalf("body = %q", got)
	}
}
