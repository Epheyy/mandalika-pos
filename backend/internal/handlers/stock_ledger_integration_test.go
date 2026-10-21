package handlers

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mandalika/pos-backend/internal/ledger"
)

// Step 2 stock ledger (plan §2): stock_movements must always sum to live stock. Opt-in
// only, same isolation contract as the other PostgreSQL gates (MANDALIKA_SL_TEST_DSN,
// fresh synthetic cluster on port 56467). Each writer-conversion commit adds a subtest
// that drives its writer, replays it, and calls assertLedgerInvariant. Every subtest
// seeds the shared fixtures itself, so any one runs alone with
// -run TestStockLedgerPostgres/<name>.
const (
	slOutletA  = "00000000-0000-4000-8f67-00000000000a" // record-roundtrip
	slOutletB  = "00000000-0000-4000-8f67-00000000000b" // record-split
	slOutletC  = "00000000-0000-4000-8f67-00000000000c" // record-deltas, refund-link
	slProductP = "00000000-0000-4000-8f67-0000000000a1"
	slProductQ = "00000000-0000-4000-8f67-0000000000a2"
	slVariant  = "00000000-0000-4000-8f67-0000000000b1"
	slRefID    = "00000000-0000-4000-8f67-0000000000c1"
)

// assertLedgerInvariant fails if any (location, product, size) has live stock different
// from the sum of its movements (plan §2.4).
func assertLedgerInvariant(t *testing.T, ctx context.Context, q ledger.Querier) {
	t.Helper()
	bad, err := ledger.InvariantViolations(ctx, q)
	if err != nil {
		t.Fatal(err)
	}
	if len(bad) > 0 {
		t.Fatalf("ledger invariant broken for %d keys, first: %+v", len(bad), bad[0])
	}
}

// assertLedgerInvariantFails asserts the invariant reports exactly want violations.
func assertLedgerInvariantFails(t *testing.T, ctx context.Context, q ledger.Querier, want int) {
	t.Helper()
	bad, err := ledger.InvariantViolations(ctx, q)
	if err != nil {
		t.Fatal(err)
	}
	if len(bad) != want {
		t.Fatalf("invariant violations = %d, want %d: %+v", len(bad), want, bad)
	}
}

// slSetup seeds the shared outlets and products; idempotent.
func slSetup(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	for _, q := range []string{
		fmt.Sprintf(`INSERT INTO outlets(id,name) VALUES('%s','SL outlet A'),('%s','SL outlet B'),('%s','SL outlet C') ON CONFLICT DO NOTHING`, slOutletA, slOutletB, slOutletC),
		fmt.Sprintf(`INSERT INTO products(id,name) VALUES('%s','SL product P'),('%s','SL product Q') ON CONFLICT DO NOTHING`, slProductP, slProductQ),
	} {
		if _, err := pool.Exec(ctx, q); err != nil {
			t.Fatal(err)
		}
	}
}

// slBackfillErr runs Backfill in its own transaction: dry runs and failures roll back.
func slBackfillErr(ctx context.Context, pool *pgxpool.Pool, opts ledger.BackfillOptions) (ledger.BackfillReport, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return ledger.BackfillReport{}, err
	}
	rep, err := ledger.Backfill(ctx, tx, opts)
	if err != nil || opts.DryRun {
		_ = tx.Rollback(ctx)
		return rep, err
	}
	return rep, tx.Commit(ctx)
}

func slBackfill(t *testing.T, ctx context.Context, pool *pgxpool.Pool, opts ledger.BackfillOptions) ledger.BackfillReport {
	t.Helper()
	rep, err := slBackfillErr(ctx, pool, opts)
	if err != nil {
		t.Fatal(err)
	}
	return rep
}

func slCount(t *testing.T, ctx context.Context, pool *pgxpool.Pool, where string, args ...any) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM stock_movements WHERE `+where, args...).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// slRecord runs fn(tx) in a transaction and commits; an error rolls back and is returned.
func slRecord(ctx context.Context, pool *pgxpool.Pool, doc ledger.Document, deltas bool, apply ...string) (ledger.Result, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return ledger.Result{}, err
	}
	for _, q := range apply {
		if _, err = tx.Exec(ctx, q); err != nil {
			_ = tx.Rollback(ctx)
			return ledger.Result{}, err
		}
	}
	record := ledger.Record
	if deltas {
		record = ledger.RecordDeltas
	}
	res, err := record(ctx, tx, doc)
	if err != nil {
		_ = tx.Rollback(ctx)
		return ledger.Result{}, err
	}
	return res, tx.Commit(ctx)
}

func TestStockLedgerPostgres(t *testing.T) {
	pool, ctx := gatePool(t, "SL", 56467)
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}

	t.Run("invariant-empty", func(t *testing.T) {
		slSetup(t, ctx, pool)
		assertLedgerInvariant(t, ctx, pool)
	})

	t.Run("record-roundtrip", func(t *testing.T) {
		slSetup(t, ctx, pool)
		exec(`INSERT INTO outlet_variant_stock(outlet_id,product_id,variant_size,stock) VALUES($1,$2,'50ml',10)`, slOutletA, slProductP)
		now := time.Now().UTC()
		inA := `location_id=$1`

		dry := slBackfill(t, ctx, pool, ledger.BackfillOptions{DryRun: true, RunID: "o1", OccurredAt: now})
		if dry.WouldInsert < 1 || dry.Inserted != 0 || slCount(t, ctx, pool, inA, slOutletA) != 0 {
			t.Fatalf("dry run must plan rows and insert nothing: %+v", dry)
		}
		first := slBackfill(t, ctx, pool, ledger.BackfillOptions{RunID: "o1", OccurredAt: now})
		if first.Inserted != first.Candidates || first.Inserted < 1 {
			t.Fatalf("opening: %+v", first)
		}
		var id string
		var qty, before, after int
		err := pool.QueryRow(ctx, `SELECT id::text, qty, qty_before, qty_after FROM stock_movements WHERE kind='opening' AND location_id=$1`, slOutletA).Scan(&id, &qty, &before, &after)
		if err != nil || qty != 10 || before != 0 || after != 10 {
			t.Fatalf("opening row qty/before/after = %d/%d/%d err=%v", qty, before, after, err)
		}
		if want := ledger.MovementID(fmt.Sprintf("opening:outlet:%s:%s:50ml", slOutletA, slProductP)); id != want {
			t.Fatalf("movement id %s, want %s", id, want)
		}
		assertLedgerInvariant(t, ctx, pool)

		// Idempotent: a re-run under a NEW run id has nothing to do and does not fail.
		if again := slBackfill(t, ctx, pool, ledger.BackfillOptions{RunID: "o2", OccurredAt: now}); again.Candidates != 0 || again.Inserted != 0 {
			t.Fatalf("opening must be idempotent: %+v", again)
		}
		if _, err := slBackfillErr(ctx, pool, ledger.BackfillOptions{OccurredAt: now}); err == nil {
			t.Fatal("a backfill without a run id must fail")
		}

		// A new key plus a REUSED run id must fail and roll back, not silently do less.
		exec(`INSERT INTO outlet_variant_stock(outlet_id,product_id,variant_size,stock) VALUES($1,$2,'30ml',4)`, slOutletA, slProductQ)
		if _, err := slBackfillErr(ctx, pool, ledger.BackfillOptions{RunID: "o1", OccurredAt: now}); err == nil || !strings.Contains(err.Error(), "already used") {
			t.Fatalf("reused run id: err = %v", err)
		}
		assertLedgerInvariantFails(t, ctx, pool, 1)
		slBackfill(t, ctx, pool, ledger.BackfillOptions{RunID: "o3", OccurredAt: now})
		assertLedgerInvariant(t, ctx, pool)

		// An old revision changes stock without a movement: opening mode ignores it,
		// reanchor repairs it, and a run id is single-use.
		exec(`UPDATE outlet_variant_stock SET stock = 13 WHERE outlet_id=$1 AND product_id=$2 AND variant_size='50ml'`, slOutletA, slProductP)
		assertLedgerInvariantFails(t, ctx, pool, 1)
		if skip := slBackfill(t, ctx, pool, ledger.BackfillOptions{RunID: "o4", OccurredAt: now}); skip.Inserted != 0 {
			t.Fatalf("opening mode must not touch an already-opened key: %+v", skip)
		}
		dryRe := slBackfill(t, ctx, pool, ledger.BackfillOptions{DryRun: true, Reanchor: true, RunID: "r1", OccurredAt: now})
		if dryRe.WouldInsert != 1 || dryRe.Inserted != 0 || slCount(t, ctx, pool, `kind='adjust'`) != 0 {
			t.Fatalf("dry reanchor: %+v", dryRe)
		}
		if re := slBackfill(t, ctx, pool, ledger.BackfillOptions{Reanchor: true, RunID: "r1", OccurredAt: now}); re.Inserted != 1 {
			t.Fatalf("reanchor: %+v", re)
		}
		assertLedgerInvariant(t, ctx, pool)
		if again := slBackfill(t, ctx, pool, ledger.BackfillOptions{Reanchor: true, RunID: "r1", OccurredAt: now}); again.Inserted != 0 {
			t.Fatalf("reanchor without drift: %+v", again)
		}
		exec(`UPDATE outlet_variant_stock SET stock = 14 WHERE outlet_id=$1 AND product_id=$2 AND variant_size='50ml'`, slOutletA, slProductP)
		if _, err := slBackfillErr(ctx, pool, ledger.BackfillOptions{Reanchor: true, RunID: "r1", OccurredAt: now}); err == nil || !strings.Contains(err.Error(), "already used") {
			t.Fatalf("reanchor with a reused run id and new drift: err = %v", err)
		}
		slBackfill(t, ctx, pool, ledger.BackfillOptions{Reanchor: true, RunID: "r2", OccurredAt: now})
		assertLedgerInvariant(t, ctx, pool)
		if n := slCount(t, ctx, pool, `kind='adjust' AND ref_type='backfill' AND location_id=$1`, slOutletA); n != 2 {
			t.Fatalf("want two reanchor adjusts (+3, +1), got %d", n)
		}
	})

	t.Run("record-split", func(t *testing.T) {
		slSetup(t, ctx, pool)
		const n = 450
		exec(`INSERT INTO outlet_variant_stock(outlet_id,product_id,variant_size,stock)
		      SELECT $1, $2, 's' || lpad(g::text, 3, '0'), 1 FROM generate_series(1, $3::int) g`, slOutletB, slProductQ, n)
		doc := ledger.Document{
			Key: "count:sl-split", Kind: ledger.KindCount, LocationType: ledger.LocOutlet, LocationID: slOutletB,
			RefType: "stock_count", OccurredAt: time.Now().UTC(),
		}
		for i := 1; i <= n; i++ {
			size := fmt.Sprintf("s%03d", i)
			doc.Lines = append(doc.Lines, ledger.Line{
				ProductID: slProductQ, VariantSize: size, Qty: 1, QtyBefore: 0, QtyAfter: 1,
				DedupeKey: fmt.Sprintf("count:sl-split:%s", size),
			})
		}
		res, err := slRecord(ctx, pool, doc, false)
		if err != nil {
			t.Fatal(err)
		}
		wantInserted := []int{200, 200, 50}
		if len(res.Parts) != 3 {
			t.Fatalf("parts = %d, want 3", len(res.Parts))
		}
		for i, p := range res.Parts {
			if p.Part != i+1 || p.DocumentID != ledger.DocumentID(doc.Key, i+1) || p.Inserted != wantInserted[i] {
				t.Fatalf("part %d = %+v", i, p)
			}
			if got := slCount(t, ctx, pool, `document_id=$1`, p.DocumentID); got != p.Lines {
				t.Fatalf("document %s holds %d rows, want %d", p.DocumentID, got, p.Lines)
			}
		}
		replay, err := slRecord(ctx, pool, doc, false)
		if err != nil {
			t.Fatal(err)
		}
		for _, p := range replay.Parts {
			if p.Inserted != 0 {
				t.Fatalf("replay inserted %d rows into %s", p.Inserted, p.DocumentID)
			}
		}
		if got := slCount(t, ctx, pool, `ref_type='stock_count' AND location_id=$1`, slOutletB); got != n {
			t.Fatalf("rows after replay = %d, want %d", got, n)
		}
		// Seeded at 1 per key and each line moved 0 -> 1, so it still balances.
		assertLedgerInvariant(t, ctx, pool)
	})

	t.Run("record-deltas", func(t *testing.T) {
		slSetup(t, ctx, pool)
		exec(`INSERT INTO outlet_variant_stock(outlet_id,product_id,variant_size,stock) VALUES($1,$2,'rd',10)
		      ON CONFLICT (outlet_id,product_id,variant_size) DO UPDATE SET stock = 10`, slOutletC, slProductP)
		slBackfill(t, ctx, pool, ledger.BackfillOptions{RunID: "rd-open"})

		// Two deltas on one key, applied -3 then -2. The dedupe keys sort in the REVERSE
		// of application order, so a sort by dedupe key would break the chain.
		doc := ledger.Document{
			Key: "adjust:sl-deltas", Kind: ledger.KindAdjust, LocationType: ledger.LocOutlet, LocationID: slOutletC,
			RefType: "stock_adjustment", RefID: slRefID, RefNumber: "ADJ-1", Actor: "sl-test", DeviceID: "dev-1",
			OccurredAt: time.Now().UTC(),
			Lines: []ledger.Line{
				{ProductID: slProductP, VariantSize: "rd", VariantID: slVariant, Qty: -3, DedupeKey: "z-first"},
				{ProductID: slProductP, VariantSize: "rd", VariantID: slVariant, Qty: -2, DedupeKey: "a-second", Flags: []string{"shortage"}},
			},
		}
		apply := []string{
			fmt.Sprintf(`UPDATE outlet_variant_stock SET stock = stock - 3 WHERE outlet_id='%s' AND product_id='%s' AND variant_size='rd'`, slOutletC, slProductP),
			fmt.Sprintf(`UPDATE outlet_variant_stock SET stock = stock - 2 WHERE outlet_id='%s' AND product_id='%s' AND variant_size='rd'`, slOutletC, slProductP),
		}
		if _, err := slRecord(ctx, pool, doc, true, apply...); err != nil {
			t.Fatal(err)
		}
		rows, err := pool.Query(ctx, `SELECT dedupe_key, qty, qty_before, qty_after, variant_id IS NOT NULL, ref_id IS NOT NULL, actor, flags
		                              FROM stock_movements WHERE document_id=$1 ORDER BY seq`, ledger.DocumentID(doc.Key, 0))
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		want := []struct {
			key           string
			qty, bef, aft int
			flags         string
		}{{"z-first", -3, 10, 7, ""}, {"a-second", -2, 7, 5, "shortage"}}
		i := 0
		for rows.Next() {
			var key, actor string
			var qty, bef, aft int
			var hasVariant, hasRef bool
			var flags []string
			if err := rows.Scan(&key, &qty, &bef, &aft, &hasVariant, &hasRef, &actor, &flags); err != nil {
				t.Fatal(err)
			}
			if i >= len(want) || key != want[i].key || qty != want[i].qty || bef != want[i].bef || aft != want[i].aft || !hasVariant || !hasRef || actor != "sl-test" || strings.Join(flags, ",") != want[i].flags {
				t.Fatalf("row %d = %s %d %d->%d variant=%v ref=%v actor=%s flags=%v", i, key, qty, bef, aft, hasVariant, hasRef, actor, flags)
			}
			i++
		}
		rows.Close()
		if i != 2 {
			t.Fatalf("rows = %d, want 2", i)
		}
		assertLedgerInvariant(t, ctx, pool)

		replay, err := slRecord(ctx, pool, doc, true)
		if err != nil || replay.Parts[0].Inserted != 0 {
			t.Fatalf("replay = %+v err=%v", replay, err)
		}

		missing := doc
		missing.Key = "adjust:sl-missing"
		missing.Lines = []ledger.Line{{ProductID: slProductQ, VariantSize: "nope", Qty: -1, DedupeKey: "missing-1"}}
		if _, err := slRecord(ctx, pool, missing, true); err == nil || !strings.Contains(err.Error(), "no stock row") {
			t.Fatalf("missing stock row: err = %v", err)
		}
		if slCount(t, ctx, pool, `dedupe_key='missing-1'`) != 0 {
			t.Fatal("a failed RecordDeltas must leave nothing behind")
		}
		assertLedgerInvariant(t, ctx, pool)
	})

	t.Run("transfers", func(t *testing.T) { slTransfers(t, ctx, pool) })
	t.Run("inventory", func(t *testing.T) { slInventory(t, ctx, pool) })
	t.Run("stock-count", func(t *testing.T) { slStockCounts(t, ctx, pool) })

	t.Run("refund-link", func(t *testing.T) {
		slSetup(t, ctx, pool)
		exec(`INSERT INTO outlet_variant_stock(outlet_id,product_id,variant_size,stock) VALUES($1,$2,'rf',1),($1,$2,'rf2',1)
		      ON CONFLICT (outlet_id,product_id,variant_size) DO UPDATE SET stock = 1`, slOutletC, slProductP)
		slBackfill(t, ctx, pool, ledger.BackfillOptions{RunID: "rf-open"})
		base := ledger.Document{
			Kind: ledger.KindRefund, LocationType: ledger.LocOutlet, LocationID: slOutletC,
			RefType: "order", OccurredAt: time.Now().UTC(),
		}
		// A refund pointing at a sale movement that does not exist must still insert (NULL link).
		missing := base
		missing.Key = "refund:sl-1"
		missing.Lines = []ledger.Line{{ProductID: slProductP, VariantSize: "rf", Qty: 1, QtyBefore: 1, QtyAfter: 2, DedupeKey: "refund:sl-1:i1",
			RefundOfMovementID: "00000000-0000-4000-8f67-0000000000ff"}}
		exec(`UPDATE outlet_variant_stock SET stock = 2 WHERE outlet_id=$1 AND product_id=$2 AND variant_size='rf'`, slOutletC, slProductP)
		if _, err := slRecord(ctx, pool, missing, false); err != nil {
			t.Fatalf("a dangling refund link must not abort the writer: %v", err)
		}
		var linked bool
		if err := pool.QueryRow(ctx, `SELECT refund_of_movement_id IS NOT NULL FROM stock_movements WHERE dedupe_key='refund:sl-1:i1'`).Scan(&linked); err != nil || linked {
			t.Fatalf("dangling link must be stored as NULL (linked=%v err=%v)", linked, err)
		}
		// A link to an existing movement is kept.
		real := base
		real.Key = "refund:sl-2"
		real.Lines = []ledger.Line{{ProductID: slProductP, VariantSize: "rf2", Qty: 1, QtyBefore: 1, QtyAfter: 2, DedupeKey: "refund:sl-2:i1",
			RefundOfMovementID: ledger.MovementID("refund:sl-1:i1")}}
		exec(`UPDATE outlet_variant_stock SET stock = 2 WHERE outlet_id=$1 AND product_id=$2 AND variant_size='rf2'`, slOutletC, slProductP)
		if _, err := slRecord(ctx, pool, real, false); err != nil {
			t.Fatal(err)
		}
		if err := pool.QueryRow(ctx, `SELECT refund_of_movement_id = $1::uuid FROM stock_movements WHERE dedupe_key='refund:sl-2:i1'`, ledger.MovementID("refund:sl-1:i1")).Scan(&linked); err != nil || !linked {
			t.Fatalf("existing link must be kept (linked=%v err=%v)", linked, err)
		}
		assertLedgerInvariant(t, ctx, pool)
	})
}
