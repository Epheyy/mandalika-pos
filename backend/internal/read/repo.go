package read

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrNotFound = errors.New("not found")

type Repo struct{ Pool *pgxpool.Pool }

func New(p *pgxpool.Pool) *Repo { return &Repo{Pool: p} }

// Scope is the resolved outlet boundary for outlet-scoped tables.
// CrossAll = admin requested every outlet; OutletID = the single active outlet.
type Scope struct {
	CrossAll bool
	OutletID string
	// SellableOnly excludes products flagged not-for-customers (POS pull only).
	SellableOnly bool
}

// listJSON runs a query whose first column is a per-row JSON object and whose
// optional second column is a window total; unmarshals each row into T.
func listJSON[T any](ctx context.Context, p *pgxpool.Pool, sql string, args ...any) ([]T, int, error) {
	rows, err := p.Query(ctx, sql, args...)
	if err != nil {
		return nil, 0, fmt.Errorf("query: %w", err)
	}
	defer rows.Close()
	out := []T{}
	total := 0
	for rows.Next() {
		var raw []byte
		if len(rows.FieldDescriptions()) > 1 {
			if err := rows.Scan(&raw, &total); err != nil {
				return nil, 0, fmt.Errorf("scan: %w", err)
			}
		} else if err := rows.Scan(&raw); err != nil {
			return nil, 0, fmt.Errorf("scan: %w", err)
		}
		var v T
		if err := json.Unmarshal(raw, &v); err != nil {
			return nil, 0, fmt.Errorf("unmarshal: %w", err)
		}
		out = append(out, v)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}
	if len(rows.FieldDescriptions()) <= 1 {
		total = len(out)
	}
	return out, total, nil
}

// pagedRows is the slice of pgx.Rows decodePaged needs (a seam for pgx-free unit tests).
type pagedRows interface {
	Next() bool
	Scan(dest ...any) error
	Err() error
}

// decodePaged reads (object, total) rows. A NULL object is the "empty page" row: it carries
// only the total, so a page past the end (or an empty filter) still reports the real count.
func decodePaged[T any](rows pagedRows) ([]T, int, error) {
	out := []T{}
	total := 0
	for rows.Next() {
		var raw []byte
		if err := rows.Scan(&raw, &total); err != nil {
			return nil, 0, fmt.Errorf("scan: %w", err)
		}
		if raw == nil {
			continue
		}
		var v T
		if err := json.Unmarshal(raw, &v); err != nil {
			return nil, 0, fmt.Errorf("unmarshal: %w", err)
		}
		out = append(out, v)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}
	return out, total, nil
}

// jitOffSQL turns JIT off for the rest of the current transaction only.
const jitOffSQL = `SELECT set_config('jit','off',true)`

// pagedBatch sends jitOffSQL and sql as one pgx batch (one round trip, one Sync = one implicit
// transaction, so the local setting reaches the statement and resets afterwards) and hands the
// statement's rows to read. The caller must fully consume rows inside read.
func pagedBatch(ctx context.Context, p *pgxpool.Pool, sql string, args []any, read func(pgx.Rows) error) error {
	b := &pgx.Batch{}
	b.Queue(jitOffSQL)
	b.Queue(sql, args...)
	br := p.SendBatch(ctx, b)
	defer br.Close()
	if _, err := br.Exec(); err != nil {
		return fmt.Errorf("jit off: %w", err)
	}
	rows, err := br.Query()
	if err != nil {
		return fmt.Errorf("query: %w", err)
	}
	defer rows.Close()
	return read(rows)
}

// pagedCountJSON runs a statement whose rows are (json object or NULL, total) with JIT off.
func pagedCountJSON[T any](ctx context.Context, p *pgxpool.Pool, sql string, args ...any) ([]T, int, error) {
	var out []T
	var total int
	err := pagedBatch(ctx, p, sql, args, func(rows pgx.Rows) error {
		var err error
		out, total, err = decodePaged[T](rows)
		return err
	})
	if err != nil {
		return nil, 0, err
	}
	return out, total, nil
}

// RowQuerier is the single-row query surface of a pool or a transaction.
type RowQuerier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

func oneJSON[T any](ctx context.Context, p RowQuerier, sql string, args ...any) (T, error) {
	var v T
	var raw []byte
	err := p.QueryRow(ctx, sql, args...).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return v, ErrNotFound
	}
	if err != nil {
		return v, fmt.Errorf("query: %w", err)
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		return v, fmt.Errorf("unmarshal: %w", err)
	}
	return v, nil
}

func off(page, limit int) int {
	if page < 1 {
		page = 1
	}
	return (page - 1) * limit
}
