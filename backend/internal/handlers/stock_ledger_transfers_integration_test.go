package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sort"
	"strings"
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

const slWarehouse = "00000000-0000-4000-8f67-0000000000d1"

type slMovement struct {
	Product, Size          string
	Qty, Before, After     int
	LocType, LocID, RefNum string
	Flags                  []string
}

func slMovements(t *testing.T, ctx context.Context, pool *pgxpool.Pool, kind, refID string) []slMovement {
	t.Helper()
	rows, err := pool.Query(ctx, `SELECT product_id::text, variant_size, qty, qty_before, qty_after,
	       location_type, location_id::text, coalesce(ref_number,''), flags
	  FROM stock_movements WHERE kind=$1 AND ref_id=$2 ORDER BY seq`, kind, refID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []slMovement
	for rows.Next() {
		var m slMovement
		if err := rows.Scan(&m.Product, &m.Size, &m.Qty, &m.Before, &m.After, &m.LocType, &m.LocID, &m.RefNum, &m.Flags); err != nil {
			t.Fatal(err)
		}
		out = append(out, m)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

// sortMovements orders rows by (product, size) so a comparison ignores insert order.
func sortMovements(in []slMovement) []slMovement {
	out := append([]slMovement(nil), in...)
	sort.Slice(out, func(i, j int) bool { return out[i].Product+out[i].Size < out[j].Product+out[j].Size })
	return out
}

// slTransfers drives send/receive/cancel through the real handlers and repo: ledger
// rows land in the writer's transaction, a keyed replay adds none, and stock_movements
// always sums to live stock (plan §2, §3.1).
func slTransfers(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	slSetup(t, ctx, pool)
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`INSERT INTO warehouses(id,name) VALUES($1,'SL warehouse') ON CONFLICT DO NOTHING`, slWarehouse)
	exec(`INSERT INTO warehouse_variant_stock(warehouse_id,product_id,variant_size,stock) VALUES($1,$2,'tr-a',20),($1,$3,'tr-b',5)
	      ON CONFLICT (warehouse_id,product_id,variant_size) DO UPDATE SET stock = EXCLUDED.stock`, slWarehouse, slProductP, slProductQ)
	slBackfill(t, ctx, pool, ledger.BackfillOptions{RunID: "tr-open"})
	assertLedgerInvariant(t, ctx, pool)

	repo := write.New(pool)
	h := &Handlers{Write: repo}
	router := chi.NewRouter()
	router.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), auth.CtxUserID, "u-sl")))
		})
	})
	router.Post("/transfers/{id}/send", h.SendTransfer)
	router.Post("/transfers/{id}/cancel", h.CancelTransfer)
	post := func(path, key string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, path, nil)
		req.Header.Set("Idempotency-Key", key)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		return w
	}
	whStock := func(product, size string) int {
		t.Helper()
		var n int
		if err := pool.QueryRow(ctx, `SELECT stock FROM warehouse_variant_stock WHERE warehouse_id=$1 AND product_id=$2 AND variant_size=$3`,
			slWarehouse, product, size).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	total := func() int { return slCount(t, ctx, pool, `true`) }
	wh := write.TransferLoc{Kind: "warehouse", ID: slWarehouse}
	dst := write.TransferLoc{Kind: "outlet", ID: slOutletA}
	draft := func(items ...write.TransferItemInput) string {
		t.Helper()
		id, err := repo.CreateTransfer(ctx, "", write.TransferCreate{Source: wh, Dest: dst, Items: items})
		if err != nil {
			t.Fatal(err)
		}
		return id
	}
	column := func(id, col string) string {
		t.Helper()
		var v string
		if err := pool.QueryRow(ctx, `SELECT `+col+` FROM transfers WHERE id=$1`, id).Scan(&v); err != nil {
			t.Fatal(err)
		}
		return v
	}
	wantOK := func(w *httptest.ResponseRecorder, what string) {
		t.Helper()
		if w.Code != 200 || strings.TrimSpace(w.Body.String()) != `{"ok":true}` {
			t.Fatalf("%s: %d %s", what, w.Code, w.Body.String())
		}
	}

	t1 := draft(write.TransferItemInput{ProductID: slProductP, VariantSize: "tr-a", Qty: 10},
		write.TransferItemInput{ProductID: slProductQ, VariantSize: "tr-b", Qty: 3})
	// the same product/size twice: two lines, two rows, one chain. Create refuses that
	// shape now, so the second line is added directly (legacy data still holds it).
	t2 := draft(write.TransferItemInput{ProductID: slProductP, VariantSize: "tr-a", Qty: 2})
	if _, err := pool.Exec(ctx, `INSERT INTO transfer_items (transfer_id, product_id, variant_size, sent_qty)
		VALUES ($1,$2,'tr-a',3)`, t2, slProductP); err != nil {
		t.Fatal(err)
	}

	// send, keyed: one transfer_out row per line at the warehouse
	wantOK(post("/transfers/"+t1+"/send", "sl-send-1"), "send")
	sj := column(t1, "surat_jalan_no")
	wantOut := []slMovement{
		{slProductP, "tr-a", -10, 20, 10, "warehouse", slWarehouse, sj, []string{}},
		{slProductQ, "tr-b", -3, 5, 2, "warehouse", slWarehouse, sj, []string{}},
	}
	if got := slMovements(t, ctx, pool, "transfer_out", t1); !reflect.DeepEqual(sortMovements(got), sortMovements(wantOut)) {
		t.Fatalf("transfer_out rows = %+v, want %+v", got, wantOut)
	}
	assertLedgerInvariant(t, ctx, pool)

	// replay with the same key: same answer, nothing written
	before := total()
	wantOK(post("/transfers/"+t1+"/send", "sl-send-1"), "send replay")
	if total() != before || whStock(slProductP, "tr-a") != 10 || column(t1, "surat_jalan_no") != sj {
		t.Fatalf("a keyed replay must change nothing (movements %d -> %d)", before, total())
	}
	// the same key for a different transfer is a conflict and touches nothing
	if w := post("/transfers/"+t2+"/send", "sl-send-1"); w.Code != http.StatusConflict {
		t.Fatalf("key reuse for another transfer: %d, want 409", w.Code)
	}
	if total() != before || column(t2, "status") != "draft" {
		t.Fatal("a key conflict must leave the other transfer untouched")
	}

	// receive 9 of 10 on one line: transfer_in at the outlet, variance flagged
	rcv := write.TransferReceive{DiscrepancyReason: "rusak", Items: []write.TransferReceiveItem{
		{ProductID: slProductP, VariantSize: "tr-a", ReceivedQty: 9}, {ProductID: slProductQ, VariantSize: "tr-b", ReceivedQty: 3}}}
	meta := write.ReceiveMeta{ReceivedVia: "backoffice", IdempotencyKey: "sl-recv-1"}
	if err := repo.ReceiveTransfer(ctx, t1, rcv, meta); err != nil {
		t.Fatal(err)
	}
	tt := column(t1, "tanda_terima_no")
	wantIn := []slMovement{
		{slProductP, "tr-a", 9, 0, 9, "outlet", slOutletA, tt, []string{"variance", "sent:10"}},
		{slProductQ, "tr-b", 3, 0, 3, "outlet", slOutletA, tt, []string{}},
	}
	if got := slMovements(t, ctx, pool, "transfer_in", t1); !reflect.DeepEqual(sortMovements(got), sortMovements(wantIn)) {
		t.Fatalf("transfer_in rows = %+v, want %+v", got, wantIn)
	}
	assertLedgerInvariant(t, ctx, pool)
	before = total()
	if err := repo.ReceiveTransfer(ctx, t1, rcv, meta); err != nil || total() != before {
		t.Fatalf("receive replay: err=%v movements %d -> %d", err, before, total())
	}

	// send then cancel the duplicate-line transfer, both keyed
	wantOK(post("/transfers/"+t2+"/send", "sl-send-2"), "send t2")
	if got := slMovements(t, ctx, pool, "transfer_out", t2); len(got) != 2 || got[0].Qty+got[1].Qty != -5 ||
		got[0].Before != 10 || got[1].After != 5 || got[0].After != got[1].Before {
		t.Fatalf("t2 transfer_out chain = %+v", got)
	}
	assertLedgerInvariant(t, ctx, pool)
	wantOK(post("/transfers/"+t2+"/cancel", "sl-cancel-1"), "cancel")
	cancelled := slMovements(t, ctx, pool, "transfer_cancel", t2)
	if len(cancelled) != 2 || cancelled[0].Qty+cancelled[1].Qty != 5 || cancelled[1].After != 10 ||
		cancelled[0].RefNum != column(t2, "transfer_no") || cancelled[0].LocType != "warehouse" {
		t.Fatalf("transfer_cancel rows = %+v", cancelled)
	}
	assertLedgerInvariant(t, ctx, pool)
	before = total()
	wantOK(post("/transfers/"+t2+"/cancel", "sl-cancel-1"), "cancel replay")
	if total() != before || whStock(slProductP, "tr-a") != 10 {
		t.Fatalf("cancel replay: movements %d -> %d, stock %d", before, total(), whStock(slProductP, "tr-a"))
	}
	assertLedgerInvariant(t, ctx, pool)

	slTransferExtras(t, ctx, pool, h, post)
}

type slPost func(path, key string) *httptest.ResponseRecorder

// slTransferExtras covers an injected deadlock (real receipt claim + real writer), an
// outlet source (the only path where BumpStockSeq follows the ledger call), a draft
// cancel, a zero-received line, and a key reused for another operation.
func slTransferExtras(t *testing.T, ctx context.Context, pool *pgxpool.Pool, h *Handlers, post slPost) {
	t.Helper()
	repo := h.Write
	one := func(sql string, args ...any) int {
		t.Helper()
		var n int
		if err := pool.QueryRow(ctx, sql, args...).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	total := func() int { return slCount(t, ctx, pool, `true`) }
	seq := func() int {
		return one(`SELECT seq::int FROM outlet_stock_seq WHERE outlet_id=$1`, slOutletA)
	}
	draft := func(src, dst write.TransferLoc, items ...write.TransferItemInput) string {
		t.Helper()
		id, err := repo.CreateTransfer(ctx, "", write.TransferCreate{Source: src, Dest: dst, Items: items})
		if err != nil {
			t.Fatal(err)
		}
		return id
	}
	wh := write.TransferLoc{Kind: "warehouse", ID: slWarehouse}
	outA := write.TransferLoc{Kind: "outlet", ID: slOutletA}
	item := func(p, size string, qty int) write.TransferItemInput {
		return write.TransferItemInput{ProductID: p, VariantSize: size, Qty: qty}
	}
	whStock := func(p, size string) int {
		return one(`SELECT stock FROM warehouse_variant_stock WHERE warehouse_id=$1 AND product_id=$2 AND variant_size=$3`, slWarehouse, p, size)
	}
	outStock := func(p, size string) int {
		return one(`SELECT stock FROM outlet_variant_stock WHERE outlet_id=$1 AND product_id=$2 AND variant_size=$3`, slOutletA, p, size)
	}
	okBody := func(w *httptest.ResponseRecorder, what string) {
		t.Helper()
		if w.Code != 200 || strings.TrimSpace(w.Body.String()) != `{"ok":true}` {
			t.Fatalf("%s: %d %s", what, w.Code, w.Body.String())
		}
	}

	// injected 40P01 on attempt 1, after the REAL effect ran: claim, stock and ledger roll back
	attempts := 0
	h.receipts = func(c context.Context, claim service.ReceiptClaim, effect service.ReceiptEffect) (json.RawMessage, bool, error) {
		return service.RunWithReceipt(c, pool, claim, func(tx pgx.Tx) (json.RawMessage, error) {
			out, err := effect(tx)
			if attempts++; err == nil && attempts == 1 {
				return nil, &pgconn.PgError{Code: "40P01"}
			}
			return out, err
		})
	}
	t3 := draft(wh, outA, item(slProductP, "tr-a", 1))
	okBody(post("/transfers/"+t3+"/send", "sl-dl-send"), "send with injected deadlock")
	if attempts != 2 || one(`SELECT count(*)::int FROM operation_receipts WHERE idempotency_key='sl-dl-send'`) != 1 ||
		slCount(t, ctx, pool, `kind='transfer_out' AND ref_id=$1`, t3) != 1 || whStock(slProductP, "tr-a") != 9 {
		t.Fatalf("deadlock retry: attempts=%d, want one receipt, one row, stock 9 (got %d)", attempts, whStock(slProductP, "tr-a"))
	}
	assertLedgerInvariant(t, ctx, pool)
	attempts = 0
	okBody(post("/transfers/"+t3+"/cancel", "sl-dl-cancel"), "cancel with injected deadlock")
	if attempts != 2 || slCount(t, ctx, pool, `kind='transfer_cancel' AND ref_id=$1`, t3) != 1 || whStock(slProductP, "tr-a") != 10 {
		t.Fatalf("cancel deadlock retry: attempts=%d stock=%d", attempts, whStock(slProductP, "tr-a"))
	}
	h.receipts = nil
	assertLedgerInvariant(t, ctx, pool)

	// outlet source: ledger rows at the outlet, stock seq bumped exactly once per step
	t4 := draft(outA, wh, item(slProductP, "tr-a", 4), item(slProductQ, "tr-b", 2))
	seq0 := seq()
	okBody(post("/transfers/"+t4+"/send", "sl-o-send"), "outlet send")
	out := slMovements(t, ctx, pool, "transfer_out", t4)
	if len(out) != 2 || out[0].LocType != "outlet" || out[0].LocID != slOutletA || out[0].Qty != -4 || out[0].Before != 9 || out[0].After != 5 || seq() != seq0+1 {
		t.Fatalf("outlet transfer_out = %+v seq %d -> %d", out, seq0, seq())
	}
	if slCount(t, ctx, pool, `ref_id=$1 AND ref_line IS NULL`, t4) != 0 || slCount(t, ctx, pool, `ref_id=$1 AND actor='u-sl'`, t4) != 2 {
		t.Fatal("ref_line must be the transfer item id and actor the keyed caller on every row")
	}
	assertLedgerInvariant(t, ctx, pool)
	// zero-received line: the Q line writes no transfer_in row
	if err := repo.ReceiveTransfer(ctx, t4, write.TransferReceive{DiscrepancyReason: "hilang", Items: []write.TransferReceiveItem{
		{ProductID: slProductP, VariantSize: "tr-a", ReceivedQty: 4}, {ProductID: slProductQ, VariantSize: "tr-b", ReceivedQty: 0}}},
		write.ReceiveMeta{ReceivedVia: "backoffice", IdempotencyKey: "sl-o-recv"}); err != nil {
		t.Fatal(err)
	}
	if in := slMovements(t, ctx, pool, "transfer_in", t4); len(in) != 1 || in[0].Product != slProductP || in[0].LocType != "warehouse" || len(in[0].Flags) != 0 {
		t.Fatalf("zero-received: transfer_in rows = %+v", in)
	}
	assertLedgerInvariant(t, ctx, pool)

	t7 := draft(outA, wh, item(slProductP, "tr-a", 2))
	okBody(post("/transfers/"+t7+"/send", "sl-o-send2"), "outlet send 2")
	seq1 := seq()
	okBody(post("/transfers/"+t7+"/cancel", "sl-o-cancel"), "outlet cancel")
	c := slMovements(t, ctx, pool, "transfer_cancel", t7)
	if len(c) != 1 || c[0].LocType != "outlet" || c[0].Qty != 2 || c[0].After != outStock(slProductP, "tr-a") || seq() != seq1+1 {
		t.Fatalf("outlet transfer_cancel = %+v seq %d -> %d", c, seq1, seq())
	}
	assertLedgerInvariant(t, ctx, pool)

	// a draft cancel moves no stock and writes no movement
	t5 := draft(wh, outA, item(slProductQ, "tr-b", 1))
	before := total()
	okBody(post("/transfers/"+t5+"/cancel", "sl-draft-cancel"), "draft cancel")
	if total() != before || whStock(slProductQ, "tr-b") != 2 {
		t.Fatalf("draft cancel wrote %d movements", total()-before)
	}
	// a send key reused for a cancel (same user, other op type) is a conflict
	t6 := draft(wh, outA, item(slProductQ, "tr-b", 1))
	okBody(post("/transfers/"+t6+"/send", "sl-reuse"), "send t6")
	before = total()
	if w := post("/transfers/"+t6+"/cancel", "sl-reuse"); w.Code != http.StatusConflict || total() != before {
		t.Fatalf("send key reused for cancel: %d, want 409 and no writes", w.Code)
	}
	assertLedgerInvariant(t, ctx, pool)
}
