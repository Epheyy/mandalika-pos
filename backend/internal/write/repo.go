// Package write holds the reference-data CRUD (Backoffice-only). Every mutation
// bumps the per-outlet content_version so POS raises its sync wall (plan §5a).
package write

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/mandalika/pos-backend/internal/apperr"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrNotFound = apperr.New(apperr.NotFound, "not found")

type Repo struct{ Pool *pgxpool.Pool }

func New(p *pgxpool.Pool) *Repo { return &Repo{Pool: p} }

// BumpContentVersion increments every outlet's content_version and stamps a
// manifest entry for the changed resource (plan §5a). Reference data is global,
// so all outlets must resync. Run inside the caller's tx.
func bumpVersion(ctx context.Context, q pgx.Tx, resource string) error {
	_, err := q.Exec(ctx, `
		INSERT INTO content_versions (outlet_id, version, data_manifest, updated_at)
		SELECT id, 2,
		       jsonb_build_object($1::text, 1), now()
		  FROM outlets
		ON CONFLICT (outlet_id) DO UPDATE SET
		  version = content_versions.version + 1,
		  data_manifest = content_versions.data_manifest ||
		    jsonb_build_object($1::text,
		      COALESCE((content_versions.data_manifest->>$1)::int,0) + 1),
		  updated_at = now()`, resource)
	return err
}

// bumpVersionOutlets bumps the content version for only the given outlets — used
// for per-outlet writes (e.g. outlet-config) so a change at one outlet doesn't
// force every outlet to resync. Run inside the caller's tx.
func bumpVersionOutlets(ctx context.Context, q pgx.Tx, resource string, outletIDs []string) error {
	for _, oid := range outletIDs {
		if _, err := q.Exec(ctx, `
			INSERT INTO content_versions (outlet_id, version, data_manifest, updated_at)
			VALUES ($2, 2, jsonb_build_object($1::text,1), now())
			ON CONFLICT (outlet_id) DO UPDATE SET
			  version = content_versions.version + 1,
			  data_manifest = content_versions.data_manifest ||
			    jsonb_build_object($1::text, COALESCE((content_versions.data_manifest->>$1)::int,0)+1),
			  updated_at = now()`, resource, oid); err != nil {
			return err
		}
	}
	return nil
}

// tx runs fn in a transaction, bumping the content version for resource.
func (r *Repo) tx(ctx context.Context, resource string, fn func(pgx.Tx) error) error {
	t, err := r.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer t.Rollback(ctx)
	if err := fn(t); err != nil {
		return err
	}
	if err := bumpVersion(ctx, t, resource); err != nil {
		return fmt.Errorf("bump version: %w", err)
	}
	return t.Commit(ctx)
}

func jsonb(v any) ([]byte, error) {
	if v == nil {
		return []byte("null"), nil
	}
	return json.Marshal(v)
}

// ── shared helpers ────────────────────────────────────────

func (r *Repo) delete(ctx context.Context, resource, table, id string) error {
	return r.tx(ctx, resource, func(t pgx.Tx) error {
		ct, e := t.Exec(ctx, `DELETE FROM `+table+` WHERE id=$1`, id)
		if e == nil && ct.RowsAffected() == 0 {
			return ErrNotFound
		}
		return e
	})
}

func nullStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func nullUUID(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func nullDate(s string) any {
	if s == "" {
		return nil
	}
	return s
}
