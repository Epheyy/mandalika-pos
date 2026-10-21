package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/ledger"
	"github.com/mandalika/pos-backend/internal/service"
	"github.com/mandalika/pos-backend/internal/write"
)

type slCompleteFn func(id, key string, items []write.StockCountItem) *httptest.ResponseRecorder

// slCountEnv is what the stock count subtests share: the real handler behind a router,
// and small helpers over the pool.
type slCountEnv struct {
	t        *testing.T
	ctx      context.Context
	pool     *pgxpool.Pool
	repo     *write.Repo
	h        *Handlers
	complete slCompleteFn
}

func (e *slCountEnv) one(sql string, args ...any) int {
	e.t.Helper()
	var n int
	if err := e.pool.QueryRow(e.ctx, sql, args...).Scan(&n); err != nil {
		e.t.Fatal(err)
	}
	return n
}

func (e *slCountEnv) outletSeq() int {
	return e.one(`SELECT coalesce((SELECT seq::int FROM outlet_stock_seq WHERE outlet_id=$1),0)`, slOutletC)
}

func (e *slCountEnv) allSeq() int {
	return e.one(`SELECT coalesce(sum(seq),0)::int FROM outlet_stock_seq`)
}

func (e *slCountEnv) movements() int { return slCount(e.t, e.ctx, e.pool, `true`) }

func (e *slCountEnv) outletStock(size string) int {
	return e.one(`SELECT stock FROM outlet_variant_stock WHERE outlet_id=$1 AND variant_size=$2`, slOutletC, size)
}

// start creates a count over labelled lines and starts it.
func (e *slCountEnv) start(outlet, wh string, items []write.StockCountItem) string {
	e.t.Helper()
	id, err := e.repo.CreateStockCount(e.ctx, outlet, "", write.StockCountCreate{Name: "SL count", WarehouseID: wh, Items: items})
	if err != nil {
		e.t.Fatal(err)
	}
	if err := e.repo.UpdateStockCount(e.ctx, id, outlet, write.StockCountUpdate{Status: "in_progress"}); err != nil {
		e.t.Fatal(err)
	}
	return id
}

func slCountLine(pid, size string, actual *int) write.StockCountItem {
	return write.StockCountItem{ProductID: pid, ProductName: "SL", VariantSize: size, ActualQty: actual}
}

func slInt(v int) *int { return &v }

func newSLCountEnv(t *testing.T, ctx context.Context, pool *pgxpool.Pool) *slCountEnv {
	repo := write.New(pool)
	h := &Handlers{Write: repo, Store: &auth.Store{Pool: pool}}
	router := chi.NewRouter()
	router.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			c := context.WithValue(r.Context(), auth.CtxUserID, "u-sl")
			next.ServeHTTP(w, r.WithContext(context.WithValue(c, auth.CtxOutletID, slOutletC)))
		})
	})
	router.Post("/stock-counts/{id}/complete", h.CompleteStockCount)
	e := &slCountEnv{t: t, ctx: ctx, pool: pool, repo: repo, h: h}
	e.complete = func(id, key string, items []write.StockCountItem) *httptest.ResponseRecorder {
		t.Helper()
		var body []byte
		if items != nil {
			body, _ = json.Marshal(map[string]any{"items": items})
		}
		req := httptest.NewRequest(http.MethodPost, "/stock-counts/"+id+"/complete", bytes.NewReader(body))
		if key != "" {
			req.Header.Set("Idempotency-Key", key)
		}
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		return w
	}
	return e
}

// slStockCounts drives stock count completion through the real handler and repo: one
// `count` row per non-zero delta with the before/after the count saw, the outlet stock
// seq bumped once, a replay (keyed or not) writing nothing, an injected deadlock
// retried to one effect, and a 450-line count split into three documents.
func slStockCounts(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	slSetup(t, ctx, pool)
	for _, q := range []string{
		fmt.Sprintf(`INSERT INTO warehouses(id,name) VALUES('%s','SL warehouse') ON CONFLICT DO NOTHING`, slWarehouse),
		fmt.Sprintf(`INSERT INTO outlet_variant_stock(outlet_id,product_id,variant_size,stock)
		   VALUES('%s','%s','sc-a',10),('%s','%s','sc-b',8),('%s','%s','sc-c',5)
		   ON CONFLICT (outlet_id,product_id,variant_size) DO UPDATE SET stock = EXCLUDED.stock`,
			slOutletC, slProductP, slOutletC, slProductP, slOutletC, slProductQ),
		fmt.Sprintf(`INSERT INTO warehouse_variant_stock(warehouse_id,product_id,variant_size,stock)
		   VALUES('%s','%s','sc-w',6),('%s','%s','sc-w2',2)
		   ON CONFLICT (warehouse_id,product_id,variant_size) DO UPDATE SET stock = EXCLUDED.stock`,
			slWarehouse, slProductP, slWarehouse, slProductQ),
	} {
		if _, err := pool.Exec(ctx, q); err != nil {
			t.Fatal(err)
		}
	}
	slBackfill(t, ctx, pool, ledger.BackfillOptions{RunID: "sc-open"})
	assertLedgerInvariant(t, ctx, pool)
	e := newSLCountEnv(t, ctx, pool)

	slOutletAndWarehouseCounts(e)
	slKeyedCounts(e)
	slBigCount(e)
}

// slOutletAndWarehouseCounts: an outlet count of one up, one down and one unchanged
// line, its unkeyed replay, and a warehouse count.
func slOutletAndWarehouseCounts(e *slCountEnv) {
	t, ctx, pool := e.t, e.ctx, e.pool
	c1 := e.start(slOutletC, "", []write.StockCountItem{
		slCountLine(slProductP, "sc-a", nil), slCountLine(slProductP, "sc-b", nil), slCountLine(slProductQ, "sc-c", nil)})
	seq0 := e.outletSeq()
	counted := []write.StockCountItem{
		slCountLine(slProductP, "sc-a", slInt(14)), slCountLine(slProductP, "sc-b", slInt(3)), slCountLine(slProductQ, "sc-c", slInt(5))}
	w := e.complete(c1, "", counted)
	if w.Code != 200 {
		t.Fatalf("complete: %d %s", w.Code, w.Body.String())
	}
	want := []slMovement{
		{slProductP, "sc-a", 4, 10, 14, "outlet", slOutletC, "", []string{}},
		{slProductP, "sc-b", -5, 8, 3, "outlet", slOutletC, "", []string{}},
	}
	if got := slMovements(t, ctx, pool, "count", c1); !reflect.DeepEqual(sortMovements(got), want) {
		t.Fatalf("count rows = %+v, want %+v", got, want)
	}
	cols := e.one(`SELECT count(*)::int FROM stock_movements WHERE kind='count' AND ref_id=$1 AND ref_type='stock_count'
	     AND actor='u-sl' AND ref_line IS NOT NULL AND document_id=$2`, c1, ledger.DocumentID("count:"+c1, 0))
	if e.outletSeq() != seq0+1 || cols != 2 {
		t.Fatalf("seq %d -> %d, ref/actor/document columns ok for %d of 2 rows", seq0, e.outletSeq(), cols)
	}
	assertLedgerInvariant(t, ctx, pool)

	// the completed count replayed (unkeyed): nothing written, seq unchanged, same answer
	before, seq1 := e.movements(), e.outletSeq()
	rw := e.complete(c1, "", counted)
	if rw.Code != 200 || e.movements() != before || e.outletSeq() != seq1 || rw.Body.String() != w.Body.String() {
		t.Fatalf("unkeyed replay: %d, movements %d -> %d, seq %d -> %d", rw.Code, before, e.movements(), seq1, e.outletSeq())
	}

	// warehouse count: rows at the warehouse, no seq bump
	cw := e.start("", slWarehouse, []write.StockCountItem{slCountLine(slProductP, "sc-w", nil), slCountLine(slProductQ, "sc-w2", nil)})
	seqAll := e.allSeq()
	if w := e.complete(cw, "", []write.StockCountItem{slCountLine(slProductP, "sc-w", slInt(9)), slCountLine(slProductQ, "sc-w2", slInt(2))}); w.Code != 200 {
		t.Fatalf("warehouse complete: %d %s", w.Code, w.Body.String())
	}
	wantW := []slMovement{{slProductP, "sc-w", 3, 6, 9, "warehouse", slWarehouse, "", []string{}}}
	if got := slMovements(t, ctx, pool, "count", cw); !reflect.DeepEqual(got, wantW) || e.allSeq() != seqAll {
		t.Fatalf("warehouse count rows = %+v, seq %d -> %d", got, seqAll, e.allSeq())
	}
	assertLedgerInvariant(t, ctx, pool)
}

// slKeyedCounts covers the optional Idempotency-Key on complete: byte-identical
// replay, 409 for another payload, and an injected deadlock through the real receipt.
func slKeyedCounts(e *slCountEnv) {
	t, ctx, pool := e.t, e.ctx, e.pool
	items := func(a int) []write.StockCountItem {
		return []write.StockCountItem{slCountLine(slProductP, "sc-a", slInt(a)), slCountLine(slProductP, "sc-b", slInt(3))}
	}
	c2 := e.start(slOutletC, "", []write.StockCountItem{slCountLine(slProductP, "sc-a", nil), slCountLine(slProductP, "sc-b", nil)})
	seq0 := e.outletSeq()
	first := e.complete(c2, "sc-k1", items(12))
	if first.Code != 200 || slCount(t, ctx, pool, `kind='count' AND ref_id=$1`, c2) != 1 || e.outletStock("sc-a") != 12 || e.outletSeq() != seq0+1 {
		t.Fatalf("keyed complete: %d %s", first.Code, first.Body.String())
	}
	assertLedgerInvariant(t, ctx, pool)
	// the unkeyed replay of the finished count answers the same JSON as the keyed run
	if un := e.complete(c2, "", items(12)); !bytes.Equal(bytes.TrimSpace(un.Body.Bytes()), first.Body.Bytes()) {
		t.Fatalf("keyed body %s != unkeyed body %s", first.Body.String(), un.Body.String())
	}
	before := e.movements()
	if re := e.complete(c2, "sc-k1", items(12)); re.Code != 200 || re.Body.String() != first.Body.String() || e.movements() != before || e.outletSeq() != seq0+1 {
		t.Fatalf("keyed replay: %d %s (movements %d -> %d)", re.Code, re.Body.String(), before, e.movements())
	}
	if bad := e.complete(c2, "sc-k1", items(1)); bad.Code != http.StatusConflict || e.movements() != before || e.outletStock("sc-a") != 12 {
		t.Fatalf("same key, other items: %d, want 409 and nothing written", bad.Code)
	}
	assertLedgerInvariant(t, ctx, pool)

	// a NEW key on the completed count with other items: 409 via countConflict, no receipt
	seq2 := e.outletSeq()
	if bad := e.complete(c2, "sc-k2", items(1)); bad.Code != http.StatusConflict || e.movements() != before || e.outletSeq() != seq2 ||
		e.one(`SELECT count(*)::int FROM operation_receipts WHERE idempotency_key='sc-k2'`) != 0 {
		t.Fatalf("new key, completed count, other items: %d %s", bad.Code, bad.Body.String())
	}

	// injected 40P01 on attempt 1, after the REAL effect ran: one receipt, one effect
	c3 := e.start(slOutletC, "", []write.StockCountItem{slCountLine(slProductP, "sc-a", nil)})
	attempts := 0
	e.h.receipts = func(c context.Context, claim service.ReceiptClaim, effect service.ReceiptEffect) (json.RawMessage, bool, error) {
		return service.RunWithReceipt(c, pool, claim, func(tx pgx.Tx) (json.RawMessage, error) {
			out, err := effect(tx)
			if attempts++; err == nil && attempts == 1 {
				return nil, &pgconn.PgError{Code: "40P01"}
			}
			return out, err
		})
	}
	defer func() { e.h.receipts = nil }()
	seq1 := e.outletSeq()
	w := e.complete(c3, "sc-dl", []write.StockCountItem{slCountLine(slProductP, "sc-a", slInt(20))})
	receipts := e.one(`SELECT count(*)::int FROM operation_receipts WHERE idempotency_key='sc-dl'`)
	if w.Code != 200 || attempts != 2 || receipts != 1 || slCount(t, ctx, pool, `kind='count' AND ref_id=$1`, c3) != 1 ||
		e.outletStock("sc-a") != 20 || e.outletSeq() != seq1+1 {
		t.Fatalf("deadlock retry: %d attempts=%d receipts=%d stock=%d seq %d -> %d", w.Code, attempts, receipts, e.outletStock("sc-a"), seq1, e.outletSeq())
	}
	assertLedgerInvariant(t, ctx, pool)
}

// slBigCount completes a 450-line warehouse count: 450 rows in three documents.
func slBigCount(e *slCountEnv) {
	t, ctx, pool := e.t, e.ctx, e.pool
	if _, err := pool.Exec(ctx, `INSERT INTO warehouse_variant_stock(warehouse_id,product_id,variant_size,stock)
	      SELECT $1,$2,'big-'||lpad(g::text,3,'0'),5 FROM generate_series(0,449) g
	      ON CONFLICT (warehouse_id,product_id,variant_size) DO UPDATE SET stock = EXCLUDED.stock`, slWarehouse, slProductP); err != nil {
		t.Fatal(err)
	}
	slBackfill(t, ctx, pool, ledger.BackfillOptions{RunID: "sc-open-big"})
	assertLedgerInvariant(t, ctx, pool)
	labels := make([]write.StockCountItem, 450)
	counted := make([]write.StockCountItem, 450)
	for i := range labels {
		size := fmt.Sprintf("big-%03d", i)
		labels[i] = slCountLine(slProductP, size, nil)
		counted[i] = slCountLine(slProductP, size, slInt(6))
	}
	id := e.start("", slWarehouse, labels)
	if w := e.complete(id, "sc-big", counted); w.Code != 200 {
		t.Fatalf("450-line complete: %d %s", w.Code, w.Body.String())
	}
	rows, err := pool.Query(ctx, `SELECT document_id::text, count(*)::int FROM stock_movements WHERE kind='count' AND ref_id=$1 GROUP BY 1`, id)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	got := map[string]int{}
	for rows.Next() {
		var doc string
		var c int
		if err := rows.Scan(&doc, &c); err != nil {
			t.Fatal(err)
		}
		got[doc] = c
	}
	key := "count:" + id
	want := map[string]int{ledger.DocumentID(key, 1): 200, ledger.DocumentID(key, 2): 200, ledger.DocumentID(key, 3): 50}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("documents = %v, want %v", got, want)
	}
	assertLedgerInvariant(t, ctx, pool)
}
