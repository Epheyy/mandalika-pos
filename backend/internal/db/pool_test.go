package db

import "testing"

func TestPoolConfigBudget(t *testing.T) {
	cfg, err := poolConfig("postgres://u:p@127.0.0.1:5432/d?sslmode=disable", 7)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.MaxConns != 7 || cfg.MinConns != 0 {
		t.Fatalf("MaxConns=%d MinConns=%d, want 7/0", cfg.MaxConns, cfg.MinConns)
	}
	// An unset (zero) or invalid budget falls back to the documented default rather
	// than pgx's NumCPU-derived one.
	for _, n := range []int{0, -1} {
		cfg, err := poolConfig("postgres://u:p@127.0.0.1:5432/d?sslmode=disable", n)
		if err != nil {
			t.Fatal(err)
		}
		if cfg.MaxConns != DefaultMaxConns {
			t.Fatalf("maxConns=%d: got %d, want default %d", n, cfg.MaxConns, DefaultMaxConns)
		}
	}
}
