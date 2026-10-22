package handlers

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mandalika/pos-backend/internal/ledger"
)

// Step 5 ERP outbox (plan §5): every ledger document part is queued in erp_outbox in
// the same transaction as its movements. Opt-in only, same isolation contract as the
// other PostgreSQL gates (MANDALIKA_OB_TEST_DSN, fresh synthetic cluster on port 56470).
// Every subtest seeds what it needs, so any one runs alone with
// -run TestErpOutboxPostgres/<name>.
const (
	obOutlet   = "00000000-0000-4000-8f70-00000000000a"
	obProductP = "00000000-0000-4000-8f70-0000000000a1"
	obRefSale  = "00000000-0000-4000-8f70-0000000000c1"
	obRefCount = "00000000-0000-4000-8f70-0000000000c2"
	obRefRoll  = "00000000-0000-4000-8f70-0000000000c3"
)

func obSetup(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	for _, q := range []string{
		fmt.Sprintf(`INSERT INTO outlets(id,name) VALUES('%s','OB outlet') ON CONFLICT DO NOTHING`, obOutlet),
		fmt.Sprintf(`INSERT INTO products(id,name) VALUES('%s','OB product P') ON CONFLICT DO NOTHING`, obProductP),
	} {
		if _, err := pool.Exec(ctx, q); err != nil {
			t.Fatal(err)
		}
	}
}

func obCount(t *testing.T, ctx context.Context, pool *pgxpool.Pool, table, where string, args ...any) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM `+table+` WHERE `+where, args...).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// obRecord runs ledger.Record in its own transaction; commit unless rollback is set.
func obRecord(ctx context.Context, pool *pgxpool.Pool, doc ledger.Document, rollback bool) (ledger.Result, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return ledger.Result{}, err
	}
	res, err := ledger.Record(ctx, tx, doc)
	if err != nil || rollback {
		return res, errors.Join(err, tx.Rollback(ctx))
	}
	return res, tx.Commit(ctx)
}

func obSaleDoc(key, refID string, lines ...ledger.Line) ledger.Document {
	return ledger.Document{
		Key: key, Kind: ledger.KindSale, LocationType: ledger.LocOutlet, LocationID: obOutlet,
		RefType: "order", RefID: refID, RefNumber: "OB-0001", OccurredAt: time.Now().UTC(), Lines: lines,
	}
}

func TestErpOutboxPostgres(t *testing.T) {
	pool, ctx := gatePool(t, "OB", 56470)

	t.Run("same-tx", func(t *testing.T) {
		obSetup(t, ctx, pool)
		doc := obSaleDoc("sale:ob-same", obRefSale,
			ledger.Line{ProductID: obProductP, VariantSize: "50ml", Qty: -2, QtyBefore: 5, QtyAfter: 3, DedupeKey: "sale:ob-same:1"},
			ledger.Line{ProductID: obProductP, VariantSize: "50ml", Qty: -4, QtyBefore: 3, QtyAfter: -1, DedupeKey: "sale:ob-same:2", Flags: []string{"shortage"}})
		res, err := obRecord(ctx, pool, doc, false)
		if err != nil {
			t.Fatal(err)
		}
		if len(res.Parts) != 1 || res.Parts[0].Inserted != 2 {
			t.Fatalf("parts = %+v, want one part with 2 inserted", res.Parts)
		}
		id := res.Parts[0].DocumentID
		var kind, lt, refType, refID, refNumber, status string
		var part, partCount, attempts int
		var payloadNull bool
		err = pool.QueryRow(ctx, `SELECT kind, location_type, ref_type, ref_id::text, ref_number, part, part_count,
		  status, attempts, payload IS NULL FROM erp_outbox WHERE document_id=$1`, id).
			Scan(&kind, &lt, &refType, &refID, &refNumber, &part, &partCount, &status, &attempts, &payloadNull)
		if err != nil {
			t.Fatal(err)
		}
		if kind != "sale" || lt != "outlet" || refType != "order" || refID != obRefSale || refNumber != "OB-0001" ||
			part != 0 || partCount != 1 || status != "pending" || attempts != 0 || !payloadNull {
			t.Fatalf("outbox row = %s %s %s %s %s %d/%d %s %d payloadNull=%v", kind, lt, refType, refID, refNumber,
				part, partCount, status, attempts, payloadNull)
		}
		if n := obCount(t, ctx, pool, "stock_movements", "document_id=$1", id); n != 2 {
			t.Fatalf("movements = %d, want 2", n)
		}
	})

	t.Run("rollback-leaves-nothing", func(t *testing.T) {
		obSetup(t, ctx, pool)
		doc := obSaleDoc("sale:ob-roll", obRefRoll,
			ledger.Line{ProductID: obProductP, VariantSize: "50ml", Qty: -1, QtyBefore: 1, QtyAfter: 0, DedupeKey: "sale:ob-roll:1"})
		if _, err := obRecord(ctx, pool, doc, true); err != nil {
			t.Fatal(err)
		}
		id := ledger.DocumentID(doc.Key, 0)
		if n := obCount(t, ctx, pool, "erp_outbox", "document_id=$1", id); n != 0 {
			t.Fatalf("outbox rows after rollback = %d", n)
		}
		if n := obCount(t, ctx, pool, "stock_movements", "document_id=$1", id); n != 0 {
			t.Fatalf("movements after rollback = %d", n)
		}
	})

	t.Run("replay-no-duplicate", func(t *testing.T) {
		obSetup(t, ctx, pool)
		doc := obSaleDoc("sale:ob-replay", obRefSale,
			ledger.Line{ProductID: obProductP, VariantSize: "100ml", Qty: -1, QtyBefore: 2, QtyAfter: 1, DedupeKey: "sale:ob-replay:1"})
		for i, want := range []int{1, 0} {
			res, err := obRecord(ctx, pool, doc, false)
			if err != nil {
				t.Fatal(err)
			}
			if res.Parts[0].Inserted != want {
				t.Fatalf("call %d inserted %d, want %d", i, res.Parts[0].Inserted, want)
			}
		}
		id := ledger.DocumentID(doc.Key, 0)
		if n := obCount(t, ctx, pool, "erp_outbox", "document_id=$1", id); n != 1 {
			t.Fatalf("outbox rows after replay = %d, want 1", n)
		}
		// A document whose every line is already recorded under another document is
		// never queued empty.
		stolen := obSaleDoc("sale:ob-replay-other", obRefSale, doc.Lines...)
		if _, err := obRecord(ctx, pool, stolen, false); err != nil {
			t.Fatal(err)
		}
		if n := obCount(t, ctx, pool, "erp_outbox", "doc_key=$1", stolen.Key); n != 0 {
			t.Fatalf("empty document queued: %d rows", n)
		}
	})

	t.Run("grow-queued-document-refused", func(t *testing.T) {
		obSetup(t, ctx, pool)
		first := ledger.Line{ProductID: obProductP, VariantSize: "grow", Qty: -1, QtyBefore: 3, QtyAfter: 2, DedupeKey: "sale:ob-grow:1"}
		if _, err := obRecord(ctx, pool, obSaleDoc("sale:ob-grow", obRefSale, first), false); err != nil {
			t.Fatal(err)
		}
		more := ledger.Line{ProductID: obProductP, VariantSize: "grow", Qty: -1, QtyBefore: 2, QtyAfter: 1, DedupeKey: "sale:ob-grow:2"}
		_, err := obRecord(ctx, pool, obSaleDoc("sale:ob-grow", obRefSale, first, more), false)
		if err == nil || !strings.Contains(err.Error(), "already queued") {
			t.Fatalf("growing a queued document must fail, got %v", err)
		}
		if n := obCount(t, ctx, pool, "stock_movements", "dedupe_key=$1", more.DedupeKey); n != 0 {
			t.Fatalf("refused movement was committed (%d rows)", n)
		}
	})

	t.Run("split-450", func(t *testing.T) {
		obSetup(t, ctx, pool)
		doc := ledger.Document{
			Key: "count:ob-450", Kind: ledger.KindCount, LocationType: ledger.LocOutlet, LocationID: obOutlet,
			RefType: "stock_count", RefID: obRefCount, OccurredAt: time.Now().UTC(),
		}
		for i := 0; i < 450; i++ {
			doc.Lines = append(doc.Lines, ledger.Line{ProductID: obProductP, VariantSize: fmt.Sprintf("s%03d", i),
				Qty: 1, QtyBefore: 0, QtyAfter: 1, DedupeKey: fmt.Sprintf("count:ob-450:%d", i)})
		}
		res, err := obRecord(ctx, pool, doc, false)
		if err != nil {
			t.Fatal(err)
		}
		if len(res.Parts) != 3 {
			t.Fatalf("parts = %d", len(res.Parts))
		}
		rows, err := pool.Query(ctx, `SELECT o.document_id::text, o.part, o.part_count, o.ref_id::text,
		  (SELECT count(*) FROM stock_movements m WHERE m.document_id = o.document_id)
		  FROM erp_outbox o WHERE o.doc_key=$1 ORDER BY o.part`, doc.Key)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		total, i := 0, 0
		for rows.Next() {
			var id, ref string
			var part, count, lines int
			if err := rows.Scan(&id, &part, &count, &ref, &lines); err != nil {
				t.Fatal(err)
			}
			i++
			if part != i || count != 3 || ref != obRefCount || id != res.Parts[i-1].DocumentID || lines > ledger.MaxLinesPerDocument {
				t.Fatalf("part row %d = %s %d/%d ref %s lines %d", i, id, part, count, ref, lines)
			}
			total += lines
		}
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}
		if i != 3 || total != 450 {
			t.Fatalf("rows %d lines %d, want 3 and 450", i, total)
		}
	})

	t.Run("backfill-opening-enqueued", func(t *testing.T) {
		obSetup(t, ctx, pool)
		if _, err := pool.Exec(ctx, `INSERT INTO outlet_variant_stock(outlet_id,product_id,variant_size,stock)
		  VALUES($1,$2,'open-1',7) ON CONFLICT DO NOTHING`, obOutlet, obProductP); err != nil {
			t.Fatal(err)
		}
		// Backfill, not RunBackfill: earlier subtests leave ledger-only keys (movements
		// without a stock row) that would trip RunBackfill's invariant check.
		if rep := slBackfill(t, ctx, pool, ledger.BackfillOptions{RunID: "ob-open", OccurredAt: time.Now().UTC()}); rep.Inserted < 1 {
			t.Fatalf("backfill inserted nothing: %+v", rep)
		}
		key := "opening:ob-open:outlet:" + obOutlet
		var kind, refType, refID string
		var part, partCount int
		if err := pool.QueryRow(ctx, `SELECT kind, ref_type, ref_id::text, part, part_count FROM erp_outbox WHERE doc_key=$1`, key).
			Scan(&kind, &refType, &refID, &part, &partCount); err != nil {
			t.Fatal(err)
		}
		if kind != "opening" || refType != "backfill" || refID != ledger.DocumentID(key, 0) || part != 0 || partCount != 1 {
			t.Fatalf("opening outbox row = %s %s %s %d/%d", kind, refType, refID, part, partCount)
		}
		if n := obCount(t, ctx, pool, "stock_movements", "document_id=$1 AND kind='opening'", ledger.DocumentID(key, 0)); n < 1 {
			t.Fatal("opening movement missing")
		}
	})

}
