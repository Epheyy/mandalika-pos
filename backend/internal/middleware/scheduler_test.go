package middleware

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/mandalika/pos-backend/internal/config"
)

func TestRequireSchedulerSecret(t *testing.T) {
	const token = "0123456789abcdef0123456789abcdef-secret"
	tests := []struct {
		name       string
		cfgToken   string
		header     *string
		wantStatus int
		wantNext   bool
	}{
		{"unset token", "", ptr("anything"), http.StatusServiceUnavailable, false},
		{"unset token, no header", "", nil, http.StatusServiceUnavailable, false},
		{"missing header", token, nil, http.StatusUnauthorized, false},
		{"empty header", token, ptr(""), http.StatusUnauthorized, false},
		{"wrong value", token, ptr("0123456789abcdef0123456789abcdef-secrex"), http.StatusUnauthorized, false},
		{"wrong length (prefix)", token, ptr(token[:10]), http.StatusUnauthorized, false},
		{"wrong length (longer)", token, ptr(token + "x"), http.StatusUnauthorized, false},
		{"right value", token, ptr(token), http.StatusOK, true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			called := false
			h := RequireSchedulerSecret(&config.Config{ERPSchedulerToken: tc.cfgToken})(
				http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
					called = true
					w.WriteHeader(http.StatusOK)
				}))
			req := httptest.NewRequest(http.MethodPost, "/x", nil)
			if tc.header != nil {
				req.Header.Set(SchedulerSecretHeader, *tc.header)
			}
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			if rec.Code != tc.wantStatus || called != tc.wantNext {
				t.Fatalf("status=%d next=%v, want %d/%v", rec.Code, called, tc.wantStatus, tc.wantNext)
			}
			if body := rec.Body.String(); strings.Contains(body, token) || (tc.header != nil && *tc.header != "" && strings.Contains(body, *tc.header)) {
				t.Fatalf("response body echoes a secret: %q", body)
			}
		})
	}
}

func TestRequireSchedulerSecretDisabledMessage(t *testing.T) {
	h := RequireSchedulerSecret(&config.Config{})(http.NotFoundHandler())
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/x", nil))
	if !strings.Contains(rec.Body.String(), "scheduler endpoint disabled") {
		t.Fatalf("body = %q", rec.Body.String())
	}
}

func ptr(s string) *string { return &s }
