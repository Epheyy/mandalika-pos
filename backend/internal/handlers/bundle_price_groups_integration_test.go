package handlers

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// bundlePriceGroupMigrationSubtest pins the schema of migration 0105. It leaves the database
// exactly as the migration made it: later price-group subtests share it.
func bundlePriceGroupMigrationSubtest(t *testing.T, pool *pgxpool.Pool, ctx context.Context) {
	t.Run("price_groups_migration", func(t *testing.T) {
		const (
			standarID = "5ad7a12d-0000-4000-8000-000000000001"
			premiumID = "5ad7a12d-0000-4000-8000-000000000002"
		)
		rows, err := pool.Query(ctx, `SELECT id::text, name, is_default, sort_order FROM price_groups ORDER BY sort_order`)
		if err != nil {
			t.Fatal(err)
		}
		type grp struct {
			id, name string
			def      bool
			sort     int
		}
		var got []grp
		for rows.Next() {
			var g grp
			if err := rows.Scan(&g.id, &g.name, &g.def, &g.sort); err != nil {
				t.Fatal(err)
			}
			got = append(got, g)
		}
		rows.Close()
		want := []grp{{standarID, "Standar", true, 0}, {premiumID, "Premium", false, 1}}
		if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
			t.Fatalf("price_groups = %v, want %v", got, want)
		}

		var defID, colDef string
		if err := pool.QueryRow(ctx, `SELECT id::text FROM price_groups WHERE is_default`).Scan(&defID); err != nil {
			t.Fatal(err)
		}
		if err := pool.QueryRow(ctx, `SELECT column_default FROM information_schema.columns
			WHERE table_name='bundle_prices' AND column_name='group_id'`).Scan(&colDef); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(colDef, defID) {
			t.Fatalf("bundle_prices.group_id default = %q, want it to contain %s", colDef, defID)
		}

		var nullable string
		var outletDef *string
		if err := pool.QueryRow(ctx, `SELECT is_nullable, column_default FROM information_schema.columns
			WHERE table_name='outlets' AND column_name='price_group_id'`).Scan(&nullable, &outletDef); err != nil {
			t.Fatal(err)
		}
		if nullable != "YES" || outletDef != nil {
			t.Fatalf("outlets.price_group_id nullable=%s default=%v, want YES and NULL", nullable, outletDef)
		}

		var pk []string
		prow, err := pool.Query(ctx, `SELECT a.attname FROM pg_index i
			JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
			WHERE i.indrelid = 'bundle_prices'::regclass AND i.indisprimary
			ORDER BY array_position(i.indkey::int2[], a.attnum)`)
		if err != nil {
			t.Fatal(err)
		}
		for prow.Next() {
			var c string
			if err := prow.Scan(&c); err != nil {
				t.Fatal(err)
			}
			pk = append(pk, c)
		}
		prow.Close()
		if strings.Join(pk, ",") != "group_id,line,size" {
			t.Fatalf("bundle_prices PK = %v, want group_id,line,size", pk)
		}

		// Rollback safety: an insert that ignores group_id (the pre-groups write path) lands in the default group.
		var gid string
		if err := pool.QueryRow(ctx, `INSERT INTO bundle_prices(line,size,price,updated_by) VALUES('','130ml',1,NULL)
			RETURNING group_id::text`).Scan(&gid); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `DELETE FROM bundle_prices WHERE line='' AND size='130ml'`); err != nil {
			t.Fatal(err)
		}
		if gid != defID {
			t.Fatalf("group_id-less insert landed in %s, want default %s", gid, defID)
		}

		expect23505 := func(name, q string, args ...any) {
			t.Helper()
			tx, err := pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(ctx)
			_, err = tx.Exec(ctx, q, args...)
			var pe *pgconn.PgError
			if !errors.As(err, &pe) || pe.Code != "23505" {
				t.Fatalf("%s: err = %v, want 23505", name, err)
			}
		}
		expect23505("second default", `INSERT INTO price_groups(name,is_default,sort_order) VALUES('Lain',true,5)`)
		expect23505("case-insensitive name", `INSERT INTO price_groups(name,sort_order) VALUES('standar',5)`)

		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		if _, err := tx.Exec(ctx, `INSERT INTO bundle_prices(group_id,line,size,price) VALUES($1,'','130ml',1)`, premiumID); err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(ctx, `DELETE FROM price_groups WHERE id=$1`, premiumID); err != nil {
			t.Fatal(err)
		}
		var left int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM bundle_prices WHERE group_id=$1`, premiumID).Scan(&left); err != nil {
			t.Fatal(err)
		}
		if left != 0 {
			t.Fatalf("deleting Premium left %d bundle_prices rows, want cascade", left)
		}

		var rev int64
		if err := pool.QueryRow(ctx, `SELECT revision FROM bundle_price_revision`).Scan(&rev); err != nil {
			t.Fatal(err)
		}
		if rev != 1 {
			t.Fatalf("bundle_price_revision = %d, want 1", rev)
		}
	})
}
