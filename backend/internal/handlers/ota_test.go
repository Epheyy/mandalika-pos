package handlers

import (
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/mandalika/pos-backend/internal/ota"
)

func TestValidateOtaPublish(t *testing.T) {
	valid := ota.Release{Version: "1.0.1", URL: "https://x/a.zip", Checksum: "abc", NativeVersionCode: 9}
	tests := []struct {
		name   string
		mutate func(r *ota.Release)
		want   error
	}{
		{"valid", func(r *ota.Release) {}, nil},
		{"missing version", func(r *ota.Release) { r.Version = "" }, errOtaMissingFields},
		{"missing url", func(r *ota.Release) { r.URL = "" }, errOtaMissingFields},
		{"missing checksum", func(r *ota.Release) { r.Checksum = "" }, errOtaMissingFields},
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
