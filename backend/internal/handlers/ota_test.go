package handlers

import (
	"errors"
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
