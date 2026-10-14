package service

import (
	"context"
	"fmt"
	"sort"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Helpers for the global row-lock order documented on CreateOrder (A42). They only
// ACQUIRE locks (and create missing stock rows); every stock/code/customer
// mutation stays in its original place.

// lockCodesSorted locks the active discount_codes rows named by codes, in code
// order. Unknown or inactive codes simply match no row (the caller's per-code
// load reports them exactly as before). codes is never modified.
func lockCodesSorted(ctx context.Context, tx pgx.Tx, codes []string) error {
	distinct := make([]string, 0, len(codes))
	seen := make(map[string]bool, len(codes))
	for _, c := range codes {
		if c != "" && !seen[c] {
			seen[c] = true
			distinct = append(distinct, c)
		}
	}
	if len(distinct) == 0 {
		return nil
	}
	sort.Strings(distinct)
	if _, err := tx.Exec(ctx,
		`SELECT id FROM discount_codes WHERE code = ANY($1) AND is_active=true ORDER BY code FOR UPDATE`,
		distinct); err != nil {
		return fmt.Errorf("lock discount codes: %w", err)
	}
	return nil
}

// lockStockRowsSorted creates any missing stock rows and then locks every row the
// sale touches in (product_id, variant_size) order. Both steps run in the sorted
// order: a concurrent uncommitted INSERT of the same new key is itself a lock wait,
// so reversed carts can deadlock inside the lazy row creation as well. The caller's
// per-item loop (unchanged) then re-acquires locks this tx already holds.
func lockStockRowsSorted(ctx context.Context, tx pgx.Tx, outletID string, items []OrderItem) error {
	type key struct{ pid, size string }
	seen := make(map[key]bool, len(items))
	var pids, sizes []string
	for _, it := range items {
		if _, err := uuid.Parse(it.ProductID); err != nil {
			return nil // malformed id: leave the per-item loop to fail exactly as before
		}
		k := key{it.ProductID, it.VariantSize}
		if !seen[k] {
			seen[k] = true
			pids = append(pids, it.ProductID)
			sizes = append(sizes, it.VariantSize)
		}
	}
	if len(pids) < 2 {
		return nil // one row cannot deadlock with itself
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO outlet_variant_stock (outlet_id, product_id, variant_size, stock)
		SELECT $1::uuid, k.pid, k.size, 0
		  FROM (SELECT DISTINCT u.pid, u.size FROM unnest($2::uuid[], $3::text[]) AS u(pid, size)) k
		 WHERE EXISTS (SELECT 1 FROM product_variants pv WHERE pv.product_id=k.pid AND pv.size=k.size)
		 ORDER BY k.pid, k.size
		ON CONFLICT (outlet_id, product_id, variant_size) DO NOTHING`,
		outletID, pids, sizes); err != nil {
		return fmt.Errorf("ensure stock rows: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		SELECT stock FROM outlet_variant_stock
		 WHERE outlet_id=$1 AND (product_id, variant_size) IN (
		   SELECT u.pid, u.size FROM unnest($2::uuid[], $3::text[]) AS u(pid, size))
		 ORDER BY product_id, variant_size FOR UPDATE`,
		outletID, pids, sizes); err != nil {
		return fmt.Errorf("lock stock rows: %w", err)
	}
	return nil
}
