package service

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/mandalika/pos-backend/internal/apperr"
	"github.com/mandalika/pos-backend/internal/write"
)

// Helpers for the global row-lock order documented on CreateOrder (A42). They only
// ACQUIRE locks (and create missing stock rows); every stock/code/customer
// mutation stays in its original place.

// lockCodes locks the discount_codes rows named by codes in the database's code
// order and returns the locked codes in that order. activeOnly restricts to active
// rows (the sale path loads only active codes); refund passes false because it
// restores usage on a code even after it was deactivated. Unknown codes match no
// row. codes is never modified.
func lockCodes(ctx context.Context, tx pgx.Tx, codes []string, activeOnly bool) ([]string, error) {
	distinct := make([]string, 0, len(codes))
	seen := make(map[string]bool, len(codes))
	for _, c := range codes {
		if c != "" && !seen[c] {
			seen[c] = true
			distinct = append(distinct, c)
		}
	}
	if len(distinct) == 0 {
		return nil, nil
	}
	q := `SELECT code FROM discount_codes WHERE code = ANY($1)`
	if activeOnly {
		q += ` AND is_active=true`
	}
	rows, err := tx.Query(ctx, q+` ORDER BY code FOR UPDATE`, distinct)
	if err != nil {
		return nil, fmt.Errorf("lock discount codes: %w", err)
	}
	defer rows.Close()
	var locked []string
	for rows.Next() {
		var c string
		if err := rows.Scan(&c); err != nil {
			return nil, fmt.Errorf("lock discount codes: %w", err)
		}
		locked = append(locked, c)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("lock discount codes: %w", err)
	}
	return locked, nil
}

// lockResolvedCustomer resolves a (possibly merged-away) customer id to its keeper,
// locks that row, and re-resolves under the lock: a merge that committed between
// the first resolve and the lock would otherwise leave the sale's aggregates on a
// tombstone. If the keeper moved, the new keeper is locked too (the merge that
// moved it has committed, so this cannot extend a live cycle beyond a retryable
// deadlock). A missing row is not an error (a customer created on-device may not
// be synced yet; downstream behavior is unchanged).
func lockResolvedCustomer(ctx context.Context, tx pgx.Tx, id string) (string, error) {
	cur, err := resolveMergedCustomer(ctx, tx, id)
	if err != nil {
		return "", err
	}
	for attempt := 0; attempt < 3; attempt++ {
		if _, err := tx.Exec(ctx, `SELECT 1 FROM customers WHERE id=$1 FOR UPDATE`, cur); err != nil {
			return "", fmt.Errorf("lock customer: %w", err)
		}
		next, err := resolveMergedCustomer(ctx, tx, cur)
		if err != nil {
			return "", err
		}
		if next == cur {
			return cur, nil
		}
		cur = next
	}
	// The keeper kept moving (concurrent merges): nothing is locked for the final id,
	// so never hand it back as if it were; the caller's retry starts over.
	return "", apperr.Wrap(apperr.Busy, write.ErrBusy)
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
