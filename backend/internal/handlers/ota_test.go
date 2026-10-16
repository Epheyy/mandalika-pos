package handlers

import (
	"bytes"
	"encoding/json"
	"errors"
	"log/slog"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/mandalika/pos-backend/internal/ota"
)

func TestValidateOtaPublish(t *testing.T) {
	valid := ota.Release{Version: "1.0.1", URL: "https://x/a.zip", Checksum: "abc", NativeVersionCode: 9, CommitSHA: "0123456789abcdef0123456789abcdef01234567"}
	tests := []struct {
		name   string
		mutate func(r *ota.Release)
		want   error
	}{
		{"valid", func(r *ota.Release) {}, nil},
		{"missing version", func(r *ota.Release) { r.Version = "" }, errOtaMissingFields},
		{"missing url", func(r *ota.Release) { r.URL = "" }, errOtaMissingFields},
		{"missing checksum", func(r *ota.Release) { r.Checksum = "" }, errOtaMissingFields},
		{"missing commit sha", func(r *ota.Release) { r.CommitSHA = "" }, errOtaCommitSha},
		{"short commit sha", func(r *ota.Release) { r.CommitSHA = "0123abc" }, errOtaCommitSha},
		{"uppercase commit sha", func(r *ota.Release) { r.CommitSHA = "0123456789ABCDEF0123456789ABCDEF01234567" }, errOtaCommitSha},
		{"non-hex commit sha", func(r *ota.Release) { r.CommitSHA = "g123456789abcdef0123456789abcdef01234567" }, errOtaCommitSha},
		{"native code zero", func(r *ota.Release) { r.NativeVersionCode = 0 }, errOtaNativeVersionCode},
		{"native code over int32", func(r *ota.Release) { r.NativeVersionCode = math.MaxInt32 + 1 }, errOtaNativeVersionCode},
		{"native code max int32", func(r *ota.Release) { r.NativeVersionCode = math.MaxInt32 }, nil},
		{"native code negative", func(r *ota.Release) { r.NativeVersionCode = -1 }, errOtaNativeVersionCode},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := valid
			tt.mutate(&r)
			if got := validateOtaPublish(r); !errors.Is(got, tt.want) {
				t.Errorf("got %v want %v", got, tt.want)
			}
		})
	}
}

// A nil Repo proves the early return never reaches the DB (it would panic).
func TestOtaCheckWithoutUsableVersionCodeIsNoRelease(t *testing.T) {
	bodies := []string{`{}`, `{"version_code":"0"}`, `{"version_code":"abc"}`, `{"version_name":"builtin"}`, `{not json`}
	for _, b := range bodies {
		t.Run(b, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/api/v1/ota/check", strings.NewReader(b))
			rec := httptest.NewRecorder()
			(&Handlers{}).OtaCheck(rec, req)
			if rec.Code != http.StatusOK {
				t.Fatalf("status %d", rec.Code)
			}
			var got struct {
				Message string `json:"message"`
			}
			if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
				t.Fatal(err)
			}
			if got.Message != "no release" {
				t.Errorf("message %q", got.Message)
			}
		})
	}
}

func TestOtaOpaqueID(t *testing.T) {
	tests := []struct{ name, in, want string }{
		{"uuid kept", "0b9f3e5c-7d3a-4b8e-9f10-2a6c1d5e7f80", "0b9f3e5c-7d3a-4b8e-9f10-2a6c1d5e7f80"},
		{"trimmed", "  abc  ", "abc"},
		{"empty", "", ""},
		{"newline injection dropped", "abc\nlevel=ERROR msg=forged", ""},
		{"spaces dropped", "a b", ""},
		{"too long dropped", strings.Repeat("a", otaMaxIDLen+1), ""},
		{"max length kept", strings.Repeat("a", otaMaxIDLen), strings.Repeat("a", otaMaxIDLen)},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := otaOpaqueID(tt.in); got != tt.want {
				t.Errorf("got %q want %q", got, tt.want)
			}
		})
	}
}

func captureLogs(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelInfo})))
	t.Cleanup(func() { slog.SetDefault(prev) })
	return &buf
}

// The adoption trail: /ota/check logs Capgo's opaque device_id/custom_id and nothing else about
// the caller (no IP, headers or body). Early-return path, so a nil Repo proves no DB hit.
func TestOtaCheckLogsOpaqueIDs(t *testing.T) {
	buf := captureLogs(t)
	body := `{"platform":"android","version_name":"builtin","device_id":"dev-123","custom_id":"outlet-9","version_code":"abc"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/ota/check", strings.NewReader(body))
	req.RemoteAddr = "203.0.113.7:4444"
	req.Header.Set("User-Agent", "secret-agent")
	rec := httptest.NewRecorder()
	(&Handlers{}).OtaCheck(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d", rec.Code)
	}
	out := buf.String()
	for _, want := range []string{"ota check", "device_id=dev-123", "custom_id=outlet-9", "version_name=builtin", "offered=false"} {
		if !strings.Contains(out, want) {
			t.Errorf("log missing %q:\n%s", want, out)
		}
	}
	for _, leak := range []string{"203.0.113.7", "secret-agent"} {
		if strings.Contains(out, leak) {
			t.Errorf("log leaks %q:\n%s", leak, out)
		}
	}
	if strings.Contains(rec.Body.String(), "dev-123") {
		t.Errorf("response echoes the device id: %s", rec.Body.String())
	}
}

func TestOtaCheckDropsHostileIDs(t *testing.T) {
	buf := captureLogs(t)
	body := `{"device_id":"x\ny","custom_id":12345}`
	rec := httptest.NewRecorder()
	(&Handlers{}).OtaCheck(rec, httptest.NewRequest(http.MethodPost, "/api/v1/ota/check", strings.NewReader(body)))
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d", rec.Code)
	}
	if out := buf.String(); strings.Contains(out, "x\ny") || strings.Contains(out, "x\\ny") || !strings.Contains(out, `device_id=""`) {
		t.Errorf("hostile id not dropped:\n%s", out)
	}
}
