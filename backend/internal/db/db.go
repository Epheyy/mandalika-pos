package db

import (
	"context"
	"embed"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

type DB struct {
	Pool *pgxpool.Pool
}

// DefaultMaxConns is the pool size used when the caller passes no valid budget.
const DefaultMaxConns = 10

// poolConfig parses the URL and applies the connection budget and retirement
// policy. maxConns < 1 means "unset" and falls back to DefaultMaxConns.
func poolConfig(url string, maxConns int) (*pgxpool.Config, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, fmt.Errorf("parse db url: %w", err)
	}
	if maxConns < 1 {
		maxConns = DefaultMaxConns
	}
	// Explicit budget (A32): instances x MaxConns must fit the Neon pooled endpoint;
	// pgx's default (max(4, NumCPU)) is neither bounded by us nor visible in config.
	// MinConns 0 so an idle instance holds no connection open. This explicit value
	// overrides any pool_max_conns in the DATABASE_URL query string.
	cfg.MaxConns = int32(maxConns)
	cfg.MinConns = 0
	// Neon (serverless Postgres) silently drops idle connections, so a stale
	// pooled connection makes the FIRST query after an idle period fail (it
	// surfaced as intermittent 400s on the first write after the app sat idle).
	// Retire idle/old connections — and sweep for them frequently — well before
	// Neon does, so the pool never hands out a dead connection. When the whole
	// app has been idle, every connection is swept and the next request opens a
	// fresh one. Zero per-request overhead (no acquire-time ping).
	cfg.MaxConnIdleTime = time.Minute
	cfg.MaxConnLifetime = 30 * time.Minute
	cfg.MaxConnLifetimeJitter = 5 * time.Minute
	cfg.HealthCheckPeriod = 30 * time.Second
	return cfg, nil
}

// Connect opens the pool with at most maxConns connections (maxConns < 1 = default).
func Connect(ctx context.Context, url string, maxConns int) (*DB, error) {
	cfg, err := poolConfig(url, maxConns)
	if err != nil {
		return nil, err
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("pgx pool: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		return nil, fmt.Errorf("db ping: %w", err)
	}
	return &DB{Pool: pool}, nil
}

func (d *DB) Close() { d.Pool.Close() }

// migrationLockKey is the transaction-scoped advisory lock that serializes
// schema changes across instances (Cloud Run can run many at once). It must be
// transaction-scoped: DATABASE_URL points at a PgBouncer transaction-mode pooler,
// where session-level locks would leak across clients.
const migrationLockKey int64 = 7261950045001

// Migrate applies any embedded *.sql files not yet recorded in schema_migrations.
// Filenames are applied in lexical order (e.g. 0001_init.sql, 0002_*.sql).
// Each file runs in its own transaction that first takes the advisory lock and
// then re-checks schema_migrations, so concurrent starters apply a file once.
func (d *DB) Migrate(ctx context.Context) error {
	if err := d.inLockedTx(ctx, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `
			CREATE TABLE IF NOT EXISTS schema_migrations (
				name text PRIMARY KEY,
				applied_at timestamptz NOT NULL DEFAULT now()
			)`)
		return err
	}); err != nil {
		return err
	}

	entries, err := migrationsFS.ReadDir("migrations")
	if err != nil {
		return err
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".sql") {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)

	for _, name := range names {
		sqlBytes, err := migrationsFS.ReadFile("migrations/" + name)
		if err != nil {
			return err
		}
		if err := d.inLockedTx(ctx, func(tx pgx.Tx) error {
			var exists bool
			if err := tx.QueryRow(ctx,
				`SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE name=$1)`, name,
			).Scan(&exists); err != nil {
				return err
			}
			if exists {
				return nil
			}
			if _, err := tx.Exec(ctx, string(sqlBytes)); err != nil {
				return fmt.Errorf("migration %s: %w", name, err)
			}
			_, err := tx.Exec(ctx, `INSERT INTO schema_migrations (name) VALUES ($1)`, name)
			return err
		}); err != nil {
			return err
		}
	}
	return nil
}

// inLockedTx runs fn in a transaction holding the migration advisory lock.
func (d *DB) inLockedTx(ctx context.Context, fn func(pgx.Tx) error) error {
	tx, err := d.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, migrationLockKey); err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
