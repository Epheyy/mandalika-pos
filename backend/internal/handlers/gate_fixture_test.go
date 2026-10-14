package handlers

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mandalika/pos-backend/internal/db"
)

// gatePool connects to the isolated, empty, migrated synthetic fixture of one
// PostgreSQL gate (prefix like "SO" -> MANDALIKA_SO_TEST_DSN) after the same
// identity checks every gate performs. It skips when the fixture is not configured.
func gatePool(t *testing.T, prefix string, port uint16) (*pgxpool.Pool, context.Context) {
	t.Helper()
	dsn := os.Getenv(fmt.Sprintf("MANDALIKA_%s_TEST_DSN", prefix))
	if dsn == "" {
		t.Skip("isolated PostgreSQL fixture not configured")
	}
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	short := strings.ToLower(prefix)
	if cfg.ConnConfig.Host != "127.0.0.1" || cfg.ConnConfig.Port != port ||
		cfg.ConnConfig.Database != "mandalika_"+short+"_synthetic" || cfg.ConnConfig.User != short+"_test" {
		t.Fatal("refusing non-fixture target")
	}
	cfg.MaxConns = 32
	ctx := context.Background()
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	var dir string
	if err = pool.QueryRow(ctx, "SHOW data_directory").Scan(&dir); err != nil {
		t.Fatal(err)
	}
	expected := os.Getenv(fmt.Sprintf("MANDALIKA_%s_TEST_DATA_DIR", prefix))
	if expected == "" || filepath.Clean(dir) != filepath.Clean(expected) {
		t.Fatal("test cluster directory mismatch")
	}
	var tables int
	if err = pool.QueryRow(ctx, "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'").Scan(&tables); err != nil || tables != 0 {
		t.Fatalf("fixture must be empty: tables=%d err=%v", tables, err)
	}
	if err = (&db.DB{Pool: pool}).Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	return pool, ctx
}
