package observability

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Sentry events carry the panic text and stack; both go through the shared
// redactor so customer data and tokens never leave the process (A37).
func TestCaptureErrorRedactsMessageAndStack(t *testing.T) {
	var got string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		got = string(b)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	s, err := NewSentry("http://publickey@"+strings.TrimPrefix(srv.URL, "http://")+"/1", "test", "r")
	if err != nil {
		t.Fatal(err)
	}
	s.CaptureError(context.Background(), errors.New("boom for budi@example.com 081234567890 Bearer CANARY.AAA.BBB"), map[string]string{"path": "/x"})
	if got == "" {
		t.Fatal("no event received")
	}
	for _, canary := range []string{"budi@example.com", "081234567890", "CANARY"} {
		if strings.Contains(got, canary) {
			t.Fatalf("%q leaked to Sentry: %s", canary, got)
		}
	}
	if !strings.Contains(got, "[REDACTED]") {
		t.Fatalf("expected redaction markers: %s", got)
	}
}
