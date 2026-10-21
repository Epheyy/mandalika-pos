package ledger

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5"
)

// BumpStockSeq advances the stock change counter (outlet_stock_seq) of each given
// outlet by exactly one and returns the new value per outlet.
//
// Contract (A15 Phase B; enforced by stockseq_guard_test.go):
//   - Call it EXACTLY ONCE per transaction per outlet, as the LAST stock/version
//     statement before Commit. The counter then orders by commit (a second writer
//     blocks on the row lock until the first commits) and is gapless (a rolled-back
//     transaction consumes nothing).
//   - Lock order: content_versions rows, then outlet_stock_seq rows in outlet_id order
//     (this helper sorts), never the other way round. Stock rows are always locked
//     before both (see the A42 note in service/order.go).
//   - Writers that change stock bump. Lazy zero rows, par level, availability, renames,
//     deletes and warehouse-only legs must not. EXCEPTION BY DESIGN: a sale and a refund
//     always bump once per committed transaction, even if no line moved stock (all
//     bundle or unresolved lines): the client counts "one own sale = exactly one bump"
//     to tell its own sales from foreign stock changes, so do not "fix" that.
//
// The keyed backoffice path's UPDATE operation_receipts SET outcome (RunWithReceipt) runs
// after the bump, like processed_keys on sales; it touches no stock or version row.
//
// The upsert covers outlets created after migration 0057 seeded the table.
func BumpStockSeq(ctx context.Context, tx pgx.Tx, outletIDs ...string) (map[string]int64, error) {
	seen := make(map[string]bool, len(outletIDs))
	ids := make([]string, 0, len(outletIDs))
	for _, id := range outletIDs {
		id = strings.ToLower(strings.TrimSpace(id))
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		ids = append(ids, id)
	}
	sort.Strings(ids)
	out := make(map[string]int64, len(ids))
	for _, id := range ids {
		var seq int64
		if err := tx.QueryRow(ctx, `
			INSERT INTO outlet_stock_seq (outlet_id, seq) VALUES ($1, 1)
			ON CONFLICT (outlet_id) DO UPDATE
			   SET seq = outlet_stock_seq.seq + 1, updated_at = now()
			RETURNING seq`, id).Scan(&seq); err != nil {
			return nil, fmt.Errorf("bump stock seq: %w", err)
		}
		out[id] = seq
	}
	return out, nil
}
