package config

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/joho/godotenv"
)

type Config struct {
	Port             string
	Env              string
	CORSOrigins      []string
	DatabaseURL      string
	RedisURL         string
	AccessSecret     []byte
	RefreshSecret    []byte
	AccessTTL        time.Duration
	RefreshTTL       time.Duration
	SeedAdminEmail   string
	SeedAdminPass    string
	SeedAdminName    string
	CloudinaryName   string
	CloudinaryKey    string
	CloudinarySecret string
	SentryDSN        string
	RateLimitRPS     int
	RateLimitBurst   int
}

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func atoi(k string, def int) int {
	if v := os.Getenv(k); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func splitTrim(s string) []string {
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// Load reads .env (if present) then environment. Env always overrides .env.
func Load() *Config {
	_ = godotenv.Load()
	return &Config{
		Port:             getenv("PORT", "8080"),
		Env:              getenv("ENV", "development"),
		CORSOrigins:      splitTrim(getenv("CORS_ORIGINS", "http://localhost:5173")),
		DatabaseURL:      getenv("DATABASE_URL", "postgres://mandalika:mandalika@localhost:5432/mandalika_pos?sslmode=disable"),
		RedisURL:         getenv("REDIS_URL", "redis://localhost:6379/0"),
		AccessSecret:     []byte(getenv("JWT_ACCESS_SECRET", "dev-access")),
		RefreshSecret:    []byte(getenv("JWT_REFRESH_SECRET", "dev-refresh")),
		AccessTTL:        time.Duration(atoi("JWT_ACCESS_TTL_MIN", 15)) * time.Minute,
		RefreshTTL:       time.Duration(atoi("JWT_REFRESH_TTL_HOURS", 168)) * time.Hour,
		SeedAdminEmail:   getenv("SEED_ADMIN_EMAIL", "admin@mandalika.local"),
		SeedAdminPass:    getenv("SEED_ADMIN_PASSWORD", ""),
		SeedAdminName:    getenv("SEED_ADMIN_NAME", "Administrator"),
		CloudinaryName:   getenv("CLOUDINARY_CLOUD_NAME", ""),
		CloudinaryKey:    getenv("CLOUDINARY_API_KEY", ""),
		CloudinarySecret: getenv("CLOUDINARY_API_SECRET", ""),
		SentryDSN:        getenv("SENTRY_DSN", ""),
		RateLimitRPS:     atoi("RATE_LIMIT_RPS", 20),
		RateLimitBurst:   atoi("RATE_LIMIT_BURST", 40),
	}
}

func (c *Config) IsProd() bool { return strings.EqualFold(c.Env, "production") }

// nativeOrigins are the Capacitor WebView origins that are valid in
// production CORS even though they contain "localhost".
var nativeOrigins = map[string]bool{
	"https://localhost":     true, // Capacitor Android
	"capacitor://localhost": true, // Capacitor iOS
}

// weakSecrets are the committed dev defaults that must never reach production.
var weakSecrets = map[string]bool{
	"":                         true,
	"dev-access":               true,
	"dev-refresh":              true,
	"change-me-access-secret":  true,
	"change-me-refresh-secret": true,
	"change-me-now":            true,
}

// Validate fails fast in production on insecure or default configuration.
// Development keeps permissive defaults so `make run` works out of the box.
func (c *Config) Validate() error {
	if !c.IsProd() {
		return nil
	}
	var errs []string

	if len(c.AccessSecret) < 32 || weakSecrets[string(c.AccessSecret)] {
		errs = append(errs, "JWT_ACCESS_SECRET must be strong (>=32 bytes, not a dev default)")
	}
	if len(c.RefreshSecret) < 32 || weakSecrets[string(c.RefreshSecret)] {
		errs = append(errs, "JWT_REFRESH_SECRET must be strong (>=32 bytes, not a dev default)")
	}
	if string(c.AccessSecret) == string(c.RefreshSecret) {
		errs = append(errs, "JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must differ")
	}
	if weakSecrets[c.SeedAdminPass] {
		errs = append(errs, "SEED_ADMIN_PASSWORD must be set to a strong value")
	}

	if len(c.CORSOrigins) == 0 {
		errs = append(errs, "CORS_ORIGINS must be set in production")
	}
	for _, o := range c.CORSOrigins {
		// Capacitor's native WebView origin is https://localhost (Android)
		// or capacitor://localhost (iOS). Those are the legitimate "native
		// origins" the criterion allows — permit them exactly. Everything
		// else containing localhost/127.0.0.1 is a dev origin and rejected.
		if nativeOrigins[o] {
			continue
		}
		switch {
		case o == "*":
			errs = append(errs, "CORS_ORIGINS must not be a wildcard in production")
		case strings.Contains(o, "localhost"), strings.Contains(o, "127.0.0.1"):
			errs = append(errs, fmt.Sprintf("CORS_ORIGINS must not contain a dev/local origin in production: %s", o))
		case strings.HasPrefix(o, "http://"):
			errs = append(errs, fmt.Sprintf("CORS_ORIGINS must be https in production: %s", o))
		}
	}

	if strings.Contains(c.DatabaseURL, "sslmode=disable") {
		errs = append(errs, "DATABASE_URL must use TLS in production (use sslmode=require)")
	}
	if strings.Contains(c.DatabaseURL, "@localhost") || strings.Contains(c.DatabaseURL, "@127.0.0.1") {
		errs = append(errs, "DATABASE_URL must point at the managed database, not localhost, in production")
	}

	if len(errs) > 0 {
		return errors.New("invalid production config:\n  - " + strings.Join(errs, "\n  - "))
	}
	return nil
}
