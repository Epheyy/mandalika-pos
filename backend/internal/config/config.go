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

// MaxTrustedProxyHops is the largest TRUSTED_PROXY_HOPS accepted; anything
// higher is clearly a misconfiguration.
const MaxTrustedProxyHops = 10

type Config struct {
	Port             string
	Env              string
	CORSOrigins      []string
	DatabaseURL      string
	// RedisURL: unset = local dev default; set-but-empty = Redis disabled (the
	// cache is optional; Postgres is the auth authority).
	RedisURL         string
	RedisDialTimeout time.Duration
	RedisOpTimeout   time.Duration
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
	// TrustedProxyHops is the number of trusted proxies appending to
	// X-Forwarded-For, counted from the right:
	//   1 = Cloud Run default *.run.app URL (Google front end appends one entry)
	//   2 = behind an external HTTPS load balancer (appends client + LB)
	//   0 = local dev / direct connections (ignore X-Forwarded-For)
	// A negative value means TRUSTED_PROXY_HOPS was not a non-negative integer;
	// Validate rejects it, and also anything above MaxTrustedProxyHops.
	TrustedProxyHops int
	// SyncLegacyEnvelopeUntil is the instant after which /sync/batch refuses items
	// that carry no capture-time envelope (A04). Zero = unset: accept and warn.
	SyncLegacyEnvelopeUntil time.Time
	// syncLegacyUntilBad is set when SYNC_LEGACY_ENVELOPE_UNTIL did not parse;
	// Validate fails fast so a typo can never silently mean "no cutoff".
	syncLegacyUntilBad bool
	// DBMaxConns is the pgxpool size PER INSTANCE (env DB_MAX_CONNS, default
	// DefaultDBMaxConns). Budget: Cloud Run max-instances x DBMaxConns client
	// connections must fit the Neon pooled endpoint (deploy-backend.sh: 4 x 10 = 40).
	DBMaxConns int
	// dbMaxConnsBad is set when DB_MAX_CONNS is not an integer >= 1; Validate fails
	// fast so a typo never silently means "pgx default".
	dbMaxConnsBad bool
}

// DefaultDBMaxConns is the per-instance pool size when DB_MAX_CONNS is unset.
const DefaultDBMaxConns = 10

// MaxDBMaxConns caps DB_MAX_CONNS; anything larger is a misconfiguration (and the
// pool size is an int32, so an absurd value must never wrap).
const MaxDBMaxConns = 100

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

// redisURL distinguishes unset (dev default) from explicitly empty (disabled).
func redisURL() string {
	if v, ok := os.LookupEnv("REDIS_URL"); ok {
		return strings.TrimSpace(v)
	}
	return "redis://localhost:6379/0"
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

// parseHops parses TRUSTED_PROXY_HOPS: unset/blank defaults to 1; anything
// that is not a non-negative integer yields -1 so Validate fails fast.
func parseHops(v string) int {
	v = strings.TrimSpace(v)
	if v == "" {
		return 1
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < 0 {
		return -1
	}
	return n
}

// parseDBMaxConns parses DB_MAX_CONNS: blank defaults to DefaultDBMaxConns; anything
// that is not an integer in [1, MaxDBMaxConns] is rejected (ok=false) so Validate
// fails fast.
func parseDBMaxConns(v string) (n int, ok bool) {
	v = strings.TrimSpace(v)
	if v == "" {
		return DefaultDBMaxConns, true
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < 1 || n > MaxDBMaxConns {
		return 0, false
	}
	return n, true
}

// parseLegacyUntil parses SYNC_LEGACY_ENVELOPE_UNTIL: blank = unset (zero time),
// otherwise RFC 3339 or a bare YYYY-MM-DD, which means 00:00 UTC of that day, i.e.
// 07:00 WIB: write an explicit offset (e.g. 2026-11-01T00:00:00+07:00) for a WIB midnight.
func parseLegacyUntil(v string) (t time.Time, ok bool) {
	v = strings.TrimSpace(v)
	if v == "" {
		return time.Time{}, true
	}
	if t, err := time.Parse(time.RFC3339, v); err == nil {
		return t, true
	}
	if t, err := time.Parse("2006-01-02", v); err == nil {
		return t, true
	}
	return time.Time{}, false
}

// Load reads .env (if present) then environment. Env always overrides .env.
func Load() *Config {
	_ = godotenv.Load()
	legacyUntil, legacyOK := parseLegacyUntil(os.Getenv("SYNC_LEGACY_ENVELOPE_UNTIL"))
	dbMaxConns, dbMaxConnsOK := parseDBMaxConns(os.Getenv("DB_MAX_CONNS"))
	return &Config{
		DBMaxConns:       dbMaxConns,
		dbMaxConnsBad:    !dbMaxConnsOK,
		Port:             getenv("PORT", "8080"),
		Env:              getenv("ENV", "development"),
		CORSOrigins:      splitTrim(getenv("CORS_ORIGINS", "http://localhost:5173")),
		DatabaseURL:      getenv("DATABASE_URL", "postgres://mandalika:mandalika@localhost:5432/mandalika_pos?sslmode=disable"),
		RedisURL:         redisURL(),
		RedisDialTimeout: time.Duration(atoi("REDIS_DIAL_TIMEOUT_MS", 1000)) * time.Millisecond,
		RedisOpTimeout:   time.Duration(atoi("REDIS_OP_TIMEOUT_MS", 500)) * time.Millisecond,
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
		TrustedProxyHops: parseHops(os.Getenv("TRUSTED_PROXY_HOPS")),

		SyncLegacyEnvelopeUntil: legacyUntil,
		syncLegacyUntilBad:      !legacyOK,
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
	if c.TrustedProxyHops < 0 {
		return errors.New("invalid config: TRUSTED_PROXY_HOPS must be an integer >= 0")
	}
	if c.TrustedProxyHops > MaxTrustedProxyHops {
		return fmt.Errorf("invalid config: TRUSTED_PROXY_HOPS must be <= %d (got %d)", MaxTrustedProxyHops, c.TrustedProxyHops)
	}
	if c.syncLegacyUntilBad {
		return errors.New("invalid config: SYNC_LEGACY_ENVELOPE_UNTIL must be RFC 3339 or YYYY-MM-DD")
	}
	if c.dbMaxConnsBad {
		return errors.New("invalid config: DB_MAX_CONNS must be an integer between 1 and 100")
	}
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
