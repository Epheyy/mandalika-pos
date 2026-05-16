package config

import (
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

// Load reads .env (if present) then environment. Env always overrides .env.
func Load() *Config {
	_ = godotenv.Load()
	return &Config{
		Port:             getenv("PORT", "8080"),
		Env:              getenv("ENV", "development"),
		CORSOrigins:      strings.Split(getenv("CORS_ORIGINS", "http://localhost:5173"), ","),
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
	}
}
