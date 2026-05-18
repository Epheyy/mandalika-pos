package config

import (
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
