package config

import (
	"bytes"
	"log/slog"
	"strings"
	"testing"
	"time"
)

func base(env string) *Config {
	return &Config{
		Env:           env,
		CORSOrigins:   []string{"https://admin.mandalika.app"},
		DatabaseURL:   "postgres://u:p@db.neon.tech/mandalika?sslmode=require",
		AccessSecret:  []byte(strings.Repeat("a", 48)),
		RefreshSecret: []byte(strings.Repeat("b", 48)),
		SeedAdminPass: "S0me-Str0ng-Pass!",
		AccessTTL:     15 * time.Minute,
	}
}

func TestValidate(t *testing.T) {
	tests := []struct {
		name    string
		mutate  func(*Config)
		wantErr string
	}{
		{"dev skips validation", func(c *Config) { c.Env = "development"; c.AccessSecret = []byte("dev-access") }, ""},
		{"valid prod passes", func(c *Config) {}, ""},
		{"weak access secret", func(c *Config) { c.AccessSecret = []byte("dev-access") }, "JWT_ACCESS_SECRET"},
		{"short refresh secret", func(c *Config) { c.RefreshSecret = []byte("short") }, "JWT_REFRESH_SECRET"},
		{"identical secrets", func(c *Config) { c.RefreshSecret = c.AccessSecret }, "must differ"},
		{"weak seed pass", func(c *Config) { c.SeedAdminPass = "change-me-now" }, "SEED_ADMIN_PASSWORD"},
		{"wildcard cors", func(c *Config) { c.CORSOrigins = []string{"*"} }, "wildcard"},
		{"localhost cors", func(c *Config) { c.CORSOrigins = []string{"https://x", "http://localhost:5173"} }, "local origin"},
		{"native origins allowed", func(c *Config) {
			c.CORSOrigins = []string{"https://admin.mandalika.app", "https://localhost", "capacitor://localhost"}
		}, ""},
		{"http cors", func(c *Config) { c.CORSOrigins = []string{"http://admin.mandalika.app"} }, "https"},
		{"db no tls", func(c *Config) { c.DatabaseURL = "postgres://u:p@db.neon.tech/m?sslmode=disable" }, "TLS"},
		{"db localhost", func(c *Config) { c.DatabaseURL = "postgres://u:p@localhost/m" }, "managed database"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			c := base("production")
			tt.mutate(c)
			err := c.Validate()
			if tt.wantErr == "" {
				if err != nil {
					t.Fatalf("want nil, got %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
				t.Fatalf("want error containing %q, got %v", tt.wantErr, err)
			}
		})
	}
}

func TestParseHopsAndValidate(t *testing.T) {
	tests := []struct {
		in   string
		want int
	}{
		{"", 1}, {"  ", 1}, {"0", 0}, {"1", 1}, {" 2 ", 2},
		{"-1", -1}, {"abc", -1}, {"1.5", -1},
	}
	for _, tt := range tests {
		t.Run(tt.in, func(t *testing.T) {
			if got := parseHops(tt.in); got != tt.want {
				t.Fatalf("parseHops(%q) = %d, want %d", tt.in, got, tt.want)
			}
		})
	}
	for _, env := range []string{"development", "production"} {
		c := base(env)
		c.TrustedProxyHops = -1
		if err := c.Validate(); err == nil || !strings.Contains(err.Error(), "TRUSTED_PROXY_HOPS") {
			t.Fatalf("%s: want TRUSTED_PROXY_HOPS error, got %v", env, err)
		}
	}
}

func TestValidateHopsUpperBound(t *testing.T) {
	c := base("development")
	c.TrustedProxyHops = MaxTrustedProxyHops
	if err := c.Validate(); err != nil {
		t.Fatalf("max allowed: %v", err)
	}
	c.TrustedProxyHops = MaxTrustedProxyHops + 1
	if err := c.Validate(); err == nil || !strings.Contains(err.Error(), "TRUSTED_PROXY_HOPS") {
		t.Fatalf("want error, got %v", err)
	}
}

func TestParseLegacyUntilAndValidate(t *testing.T) {
	for _, tc := range []struct {
		in   string
		zero bool
		ok   bool
	}{
		{"", true, true},
		{"  ", true, true},
		{"2026-11-01", false, true},
		{"2026-11-01T10:00:00+07:00", false, true},
		{"01/11/2026", true, false},
		{"soon", true, false},
	} {
		got, ok := parseLegacyUntil(tc.in)
		if ok != tc.ok || got.IsZero() != tc.zero {
			t.Errorf("parseLegacyUntil(%q) = %v, %v", tc.in, got, ok)
		}
	}
	if d, _ := parseLegacyUntil("2026-11-01"); !d.Equal(time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)) {
		t.Errorf("bare date must be start of day UTC, got %v", d)
	}
	c := base("development")
	c.syncLegacyUntilBad = true
	if err := c.Validate(); err == nil || !strings.Contains(err.Error(), "SYNC_LEGACY_ENVELOPE_UNTIL") {
		t.Errorf("a malformed cutoff must fail fast even in development, got %v", err)
	}
}

func TestParseDBMaxConnsAndValidate(t *testing.T) {
	for _, tc := range []struct {
		in   string
		want int
		ok   bool
	}{
		{"", DefaultDBMaxConns, true}, {"  ", DefaultDBMaxConns, true},
		{"1", 1, true}, {" 7 ", 7, true}, {"25", 25, true}, {"100", 100, true},
		{"101", 0, false}, {"4294967306", 0, false}, {"0", 0, false}, {"-3", 0, false}, {"abc", 0, false}, {"2.5", 0, false},
	} {
		got, ok := parseDBMaxConns(tc.in)
		if ok != tc.ok || (ok && got != tc.want) {
			t.Errorf("parseDBMaxConns(%q) = %d, %v; want %d, %v", tc.in, got, ok, tc.want, tc.ok)
		}
	}
	c := base("development")
	c.dbMaxConnsBad = true
	if err := c.Validate(); err == nil || !strings.Contains(err.Error(), "DB_MAX_CONNS") {
		t.Errorf("a malformed DB_MAX_CONNS must fail fast even in development, got %v", err)
	}
}

// Production with REDIS_URL unset gets a clear warning but still starts: Redis is
// optional, and unset silently means the localhost default (no Redis in prod).
func TestValidateWarnsWhenProdRedisURLUnset(t *testing.T) {
	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))
	t.Cleanup(func() { slog.SetDefault(prev) })

	c := base("production")
	c.redisURLUnset = true
	if err := c.Validate(); err != nil {
		t.Fatalf("an unset REDIS_URL must not fail startup: %v", err)
	}
	if !strings.Contains(buf.String(), "REDIS_URL is unset") {
		t.Fatalf("expected a warning, got %q", buf.String())
	}

	buf.Reset()
	c.redisURLUnset = false // set (even set-but-empty = disabled): no warning
	if err := c.Validate(); err != nil || strings.Contains(buf.String(), "REDIS_URL") {
		t.Fatalf("no warning expected: err=%v log=%q", err, buf.String())
	}
	buf.Reset()
	dev := base("development")
	dev.redisURLUnset = true
	_ = dev.Validate()
	if strings.Contains(buf.String(), "REDIS_URL") {
		t.Fatal("development must not warn")
	}
}
