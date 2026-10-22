package erp

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestClientSendsHeadersAndExactBody(t *testing.T) {
	body := []byte(`{"b":1,  "a":2}`) // odd spacing: must arrive untouched
	var gotBody []byte
	var gotHdr http.Header
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotBody, _ = io.ReadAll(r.Body)
		gotHdr, gotPath = r.Header.Clone(), r.URL.Path
		_, _ = w.Write([]byte(`{"success":true}`))
	}))
	defer srv.Close()

	c := NewStockDocClient(srv.URL+"/api/integration/v1/", "secret-key", 0)
	resp, err := c.PostStockDocument(context.Background(), "doc-1", body)
	if err != nil || resp.Status != 200 {
		t.Fatalf("resp=%+v err=%v", resp, err)
	}
	if gotPath != "/api/integration/v1/stock-documents" {
		t.Errorf("path = %s", gotPath)
	}
	if !bytes.Equal(gotBody, body) {
		t.Errorf("body = %q, want %q", gotBody, body)
	}
	for k, want := range map[string]string{
		"Authorization": "Bearer secret-key", "Idempotency-Key": "doc-1", "Content-Type": "application/json",
		"Accept": "application/json", "User-Agent": "mandalika-pos-relay",
	} {
		if got := gotHdr.Get(k); got != want {
			t.Errorf("%s = %q, want %q", k, got, want)
		}
	}
}

func TestParseRetryAfter(t *testing.T) {
	now := time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC)
	cases := map[string]time.Duration{
		"":        0,
		"120":     120 * time.Second,
		"-5":      0,
		"999999":  time.Hour,
		"garbage": 0,
		now.Add(90 * time.Second).Format(http.TimeFormat): 90 * time.Second,
		now.Add(-time.Minute).Format(http.TimeFormat):     0,
		now.Add(48 * time.Hour).Format(http.TimeFormat):   time.Hour,
	}
	for in, want := range cases {
		if got := parseRetryAfter(in, now); got != want {
			t.Errorf("parseRetryAfter(%q) = %v, want %v", in, got, want)
		}
	}
}

func TestClientReadsRetryAfterHeader(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "120")
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	defer srv.Close()
	resp, err := NewStockDocClient(srv.URL, "k", 0).PostStockDocument(context.Background(), "d", []byte(`{}`))
	if err != nil || resp.Status != 429 || resp.RetryAfter != 120*time.Second {
		t.Errorf("resp=%+v err=%v", resp, err)
	}
}

func TestClientCapsResponseBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(strings.Repeat("x", 200<<10)))
	}))
	defer srv.Close()
	resp, err := NewStockDocClient(srv.URL, "k", 0).PostStockDocument(context.Background(), "d", []byte(`{}`))
	if err != nil || len(resp.Body) != maxResponseBytes {
		t.Errorf("len=%d err=%v, want %d", len(resp.Body), err, maxResponseBytes)
	}
}

func TestClientErrorDoesNotLeakKey(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	url := srv.URL
	srv.Close() // nothing listens any more

	c := NewStockDocClient(url, "super-secret-key", time.Second)
	_, err := c.PostStockDocument(context.Background(), "d", []byte(`{}`))
	if err == nil {
		t.Fatal("expected a transport error")
	}
	if strings.Contains(err.Error(), "super-secret-key") {
		t.Errorf("error leaks the key: %v", err)
	}
	// The key is scrubbed even when a lower layer put it in the message.
	if got := c.scrub(io.ErrUnexpectedEOF).Error(); strings.Contains(got, "super-secret-key") {
		t.Errorf("scrub leaks: %s", got)
	}
}
