package main

import (
	"io"
	"testing"
	"time"

	"github.com/mandalika/pos-backend/internal/config"
	"github.com/mandalika/pos-backend/internal/integration/erp"
)

func TestParseFlags(t *testing.T) {
	tests := []struct {
		name    string
		args    []string
		want    options
		wantErr bool
	}{
		{"defaults", nil, options{erp.ModeIncremental, 25 * time.Second}, false},
		{"full with long budget", []string{"-mode", "full", "-budget", "5m"}, options{erp.ModeFull, 5 * time.Minute}, false},
		{"auto upper case", []string{"-mode", "AUTO"}, options{erp.ModeAuto, 25 * time.Second}, false},
		{"unknown mode", []string{"-mode", "weekly"}, options{}, true},
		{"zero budget", []string{"-budget", "0s"}, options{}, true},
		{"bad flag", []string{"-nope"}, options{}, true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parseFlags(tc.args, io.Discard)
			if (err != nil) != tc.wantErr || got != tc.want {
				t.Fatalf("got %+v err=%v, want %+v err=%v", got, err, tc.want, tc.wantErr)
			}
		})
	}
}

func TestCheckConfigAndExitCode(t *testing.T) {
	if checkConfig(&config.Config{ERPBaseURL: "u"}) == nil || checkConfig(&config.Config{ERPAPIKey: "k"}) == nil {
		t.Fatal("missing base URL or key must be refused")
	}
	if checkConfig(&config.Config{ERPBaseURL: "u", ERPAPIKey: "k"}) != nil {
		t.Fatal("complete config must pass")
	}
	for status, want := range map[string]int{
		erp.StatusCompleted: 0, erp.StatusPartial: 0, erp.StatusSkippedLocked: 0, erp.StatusFailed: 1,
	} {
		if got := exitCode(status); got != want {
			t.Fatalf("exitCode(%s) = %d, want %d", status, got, want)
		}
	}
}
