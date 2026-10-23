package main

import (
	"context"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"

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

// The CLI writes the catalog without the server, so it must drop the server's read cache
// itself; when it cannot, it says so (never printing the URL) instead of failing the run.
func TestBustReadCache(t *testing.T) {
	mr := miniredis.RunT(t)
	mr.Set("rd:GET:/api/v1/products:all:", "stale")
	mr.Set("rl:keep", "1")
	var out strings.Builder
	bustReadCache(context.Background(), &config.Config{RedisURL: "redis://" + mr.Addr()}, true, &out)
	if mr.Exists("rd:GET:/api/v1/products:all:") {
		t.Fatal("read-cache key survived the bust")
	}
	if !mr.Exists("rl:keep") {
		t.Fatal("bust removed a key outside the read-cache prefix")
	}
	if out.Len() != 0 {
		t.Fatalf("unexpected warning %q", out.String())
	}

	tests := []struct {
		name     string
		url      string
		redisSet bool
		want     string
	}{
		{"unset falls back to dev redis: skip", "redis://" + mr.Addr(), false, "REDIS_URL not set"},
		{"set but empty (disabled)", "", true, "read cache not cleared"},
		{"unparseable keeps the password out", "rediss://default:p%zz-secret@redis.invalid:6379", true, "REDIS_URL unparseable"},
		{"unreachable", "redis://127.0.0.1:1/0", true, "read cache not cleared"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			mr.Set("rd:k", "v")
			var out strings.Builder
			start := time.Now()
			bustReadCache(context.Background(), &config.Config{RedisURL: tc.url}, tc.redisSet, &out)
			if !strings.Contains(out.String(), tc.want) || strings.Contains(out.String(), "secret") {
				t.Fatalf("warning %q, want %q and no secret", out.String(), tc.want)
			}
			if d := time.Since(start); d > 5*time.Second {
				t.Fatalf("bust took %s, want it bounded", d)
			}
			if !tc.redisSet && !mr.Exists("rd:k") {
				t.Fatal("an unset REDIS_URL must not touch the fallback Redis")
			}
		})
	}
}
