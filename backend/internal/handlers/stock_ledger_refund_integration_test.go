package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/config"
	"github.com/mandalika/pos-backend/internal/ledger"
	mw "github.com/mandalika/pos-backend/internal/middleware"
	"github.com/mandalika/pos-backend/internal/read"
	"github.com/mandalika/pos-backend/internal/service"
	syncpkg "github.com/mandalika/pos-backend/internal/sync"
	"github.com/mandalika/pos-backend/internal/write"
)

const (
	slrUser   = "00000000-0000-4000-8f67-000000000e01"
	slrShift  = "00000000-0000-4000-8f67-000000000e02"
	slrSecret = "SL-REFUND-SYNTHETIC-KEY"
	slrSize   = "rf-size"
)

// slRefund drives refunds through the real router (POST /orders, POST
// /orders/{id}/refund, POST /sync/batch): the refund rows cover exactly the lines
// RefundTx restocked, chain per (product, size), link to a recorded sale movement and
// are never repeated by a replay (plan §2.3, D11).
func slRefund(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	slSetup(t, ctx, pool)
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`INSERT INTO users(id,email,password_hash,display_name,role,outlet_id) VALUES($1,'slr@example.invalid','x','SL refund cashier','cashier',$2) ON CONFLICT DO NOTHING`, slrUser, slOutletC)
	exec(`INSERT INTO shifts(id,outlet_id,cashier_id,cashier_name,status,opened_at,starting_cash) VALUES($1,$2,$3,'SL refund cashier','open',now(),0) ON CONFLICT DO NOTHING`, slrShift, slOutletC, slrUser)
	rd, wr, svc := read.New(pool), write.New(pool), service.NewOrderService(pool)
	h := New(rd, nil, auth.NewStore(pool), wr, svc, syncpkg.New(pool, rd, svc, wr), nil)
	secret := []byte(slrSecret)
	token, err := auth.IssueAccess(secret, time.Hour, slrUser, "cashier", slOutletC, []string{"create_order", "process_refund"})
	if err != nil {
		t.Fatal(err)
	}
	authWrap := mw.RequireAuth(&config.Config{AccessSecret: secret})
	router := chi.NewRouter()
	router.With(authWrap, mw.RequirePermission("create_order")).Post("/orders", h.CreateOrder)
	router.With(authWrap, mw.RequirePermission("process_refund")).Post("/orders/{id}/refund", h.RefundOrder)
	router.With(authWrap).Post("/sync/batch", h.SyncBatch)
	do := func(path string, body any, key string) (int, string) {
		t.Helper()
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		r := httptest.NewRequest("POST", path, strings.NewReader(string(raw)))
		r.Header.Set("Authorization", "Bearer "+token)
		r.Header.Set("Content-Type", "application/json")
		if key != "" {
			r.Header.Set("Idempotency-Key", key)
		}
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		return w.Code, w.Body.String()
	}

	n := 0
	id := func(group string) string { n++; return fmt.Sprintf("00000000-0000-4000-8f67-%s%011d", group, n) }
	product := func(withVariant bool, stock int) string {
		pid := id("1")
		exec(`INSERT INTO products(id,name) VALUES($1,$2)`, pid, "SLR product "+pid[len(pid)-4:])
		if withVariant {
			exec(`INSERT INTO product_variants(product_id,size,price,stock,sku) VALUES($1,$2,100000,0,$3)`, pid, slrSize, "SLR"+pid[len(pid)-6:])
			exec(`INSERT INTO outlet_variant_stock(outlet_id,product_id,variant_size,stock) VALUES($1,$2,$3,$4)`, slOutletC, pid, slrSize, stock)
		}
		return pid
	}
	line := func(pid, size string, qty int, bundle bool) map[string]any {
		return map[string]any{"productId": pid, "productName": "SLR", "variantSize": size, "price": 100000,
			"quantity": qty, "subtotal": 100000 * qty, "isBundle": bundle}
	}
	sale := func(key string, items ...map[string]any) string {
		t.Helper()
		total := 0
		for _, it := range items {
			total += it["subtotal"].(int)
		}
		p := map[string]any{"orderUuid": id("2"), "paymentMethod": "cash", "amountPaid": total, "shiftId": slrShift, "items": items}
		if code, body := do("/orders", p, key); code != 200 && code != 201 {
			t.Fatalf("sale %s: %d %s", key, code, body)
		}
		var oid string
		if err := pool.QueryRow(ctx, `SELECT id::text FROM orders WHERE idempotency_key=$1`, key).Scan(&oid); err != nil {
			t.Fatal(err)
		}
		return oid
	}
	itemID := func(orderID, pid, size string, qty int) string {
		t.Helper()
		var s string
		if err := pool.QueryRow(ctx, `SELECT id::text FROM order_items WHERE order_id=$1 AND product_id=$2 AND variant_size=$3 AND quantity=$4`, orderID, pid, size, qty).Scan(&s); err != nil {
			t.Fatal(err)
		}
		return s
	}
	refundRows := func(orderID string) []slMovement {
		return slMovements(t, ctx, pool, "refund", orderID)
	}
	refund := func(orderID string) int {
		code, _ := do("/orders/"+orderID+"/refund", map[string]any{"reason": "slr"}, "")
		return code
	}
	stock := func(pid string) int {
		t.Helper()
		var s int
		if err := pool.QueryRow(ctx, `SELECT stock FROM outlet_variant_stock WHERE outlet_id=$1 AND product_id=$2 AND variant_size=$3`, slOutletC, pid, slrSize).Scan(&s); err != nil {
			t.Fatal(err)
		}
		return s
	}
	orderNumber := func(orderID string) string {
		t.Helper()
		var s string
		if err := pool.QueryRow(ctx, `SELECT order_number FROM orders WHERE id=$1`, orderID).Scan(&s); err != nil {
			t.Fatal(err)
		}
		return s
	}

	// ---- restocked lines only, chained duplicates, NULL refund_of (sales do not record yet) ----
	pN, pD, pB, pU := product(true, 10), product(true, 10), product(false, 0), product(false, 0)
	o1 := sale("slr-sale-1",
		line(pN, slrSize, 2, false), line(pD, slrSize, 1, false), line(pD, slrSize, 2, false),
		line(pB, "bundle", 1, true), line(pU, "zz", 1, false))
	slBackfill(t, ctx, pool, ledger.BackfillOptions{RunID: "slr-open-1"})
	assertLedgerInvariant(t, ctx, pool)
	if stock(pN) != 8 || stock(pD) != 7 {
		t.Fatalf("sale stock N=%d D=%d, want 8/7", stock(pN), stock(pD))
	}
	if code := refund(o1); code != 200 && code != 201 {
		t.Fatalf("refund o1: %d", code)
	}
	rn := orderNumber(o1)
	// RefundTx's order is (product_id, variant_size, item id): the two D lines chain in item-id order.
	d1, d2 := itemID(o1, pD, slrSize, 1), itemID(o1, pD, slrSize, 2)
	firstQty, secondQty := 1, 2
	if d2 < d1 {
		firstQty, secondQty = 2, 1
	}
	got := refundRows(o1)
	if len(got) != 3 {
		t.Fatalf("refund rows = %+v, want 3 (N, D, D only)", got)
	}
	wantD := []slMovement{
		{pD, slrSize, firstQty, 7, 7 + firstQty, "outlet", slOutletC, rn, []string{}},
		{pD, slrSize, secondQty, 7 + firstQty, 10, "outlet", slOutletC, rn, []string{}},
	}
	var gotD []slMovement
	for _, m := range got {
		switch m.Product {
		case pN:
			if want := (slMovement{pN, slrSize, 2, 8, 10, "outlet", slOutletC, rn, []string{}}); !reflect.DeepEqual(m, want) {
				t.Fatalf("N refund row %+v, want %+v", m, want)
			}
		case pD:
			gotD = append(gotD, m)
		default:
			t.Fatalf("unexpected refund row for %s", m.Product)
		}
	}
	if !reflect.DeepEqual(gotD, wantD) {
		t.Fatalf("duplicate-key refund rows %+v, want %+v", gotD, wantD)
	}
	if c := slCount(t, ctx, pool, `kind='refund' AND ref_id=$1 AND refund_of_movement_id IS NOT NULL`, o1); c != 0 {
		t.Fatalf("%d refund rows linked to a sale movement that was never recorded", c)
	}
	assertLedgerInvariant(t, ctx, pool)

	// ---- a refused second refund writes nothing ----
	before := slCount(t, ctx, pool, `kind='refund'`)
	if code := refund(o1); code != 409 {
		t.Fatalf("second refund = %d, want 409", code)
	}
	if after := slCount(t, ctx, pool, `kind='refund'`); after != before {
		t.Fatalf("refused refund wrote %d movements", after-before)
	}

	// ---- refund_of link: a recorded sale movement is linked ----
	pL := product(true, 5)
	slBackfill(t, ctx, pool, ledger.BackfillOptions{RunID: "slr-open-2"})
	o2 := sale("slr-sale-2", line(pL, slrSize, 1, false))
	i2 := itemID(o2, pL, slrSize, 1)
	if _, err := slRecord(ctx, pool, ledger.Document{
		Key: "sale:" + o2, Kind: ledger.KindSale, LocationType: ledger.LocOutlet, LocationID: slOutletC,
		RefType: "order", RefID: o2, OccurredAt: time.Now().UTC(),
		Lines: []ledger.Line{{ProductID: pL, VariantSize: slrSize, Qty: -1, QtyBefore: 5, QtyAfter: 4, DedupeKey: "sale:" + i2, RefLine: i2}},
	}, false); err != nil {
		t.Fatal(err)
	}
	assertLedgerInvariant(t, ctx, pool)
	if code := refund(o2); code != 200 && code != 201 {
		t.Fatalf("refund o2: %d", code)
	}
	var linked bool
	if err := pool.QueryRow(ctx, `SELECT refund_of_movement_id = $1::uuid FROM stock_movements WHERE dedupe_key=$2`,
		ledger.MovementID("sale:"+i2), "refund:"+i2).Scan(&linked); err != nil || !linked {
		t.Fatalf("refund must link to the sale movement (linked=%v err=%v)", linked, err)
	}
	assertLedgerInvariant(t, ctx, pool)

	// ---- sync refund: one set of rows, a replay of the same batch adds none ----
	pS := product(true, 6)
	o3 := sale("slr-sale-3", line(pS, slrSize, 2, false))
	slBackfill(t, ctx, pool, ledger.BackfillOptions{RunID: "slr-open-3"}) // anchors the post-sale 4
	batch := map[string]any{"items": []any{map[string]any{"type": "refund", "idempotencyKey": "slr-sync-1", "payload": map[string]any{"orderId": o3, "reason": "sync"}}}}
	for i := 0; i < 2; i++ {
		code, body := do("/sync/batch", batch, "")
		if code != 200 || !strings.Contains(body, `"ok"`) {
			t.Fatalf("sync refund pass %d: %d %s", i, code, body)
		}
		if c := len(refundRows(o3)); c != 1 {
			t.Fatalf("after sync pass %d: %d refund rows, want 1", i, c)
		}
	}
	if m := refundRows(o3)[0]; m.Qty != 2 || m.Before != 4 || m.After != 6 {
		t.Fatalf("sync refund row %+v", m)
	}
	assertLedgerInvariant(t, ctx, pool)

	// ---- variant AND stock row deleted before the refund: no row, an exception instead ----
	pG := product(true, 5)
	o4 := sale("slr-sale-4", line(pG, slrSize, 1, false))
	slBackfill(t, ctx, pool, ledger.BackfillOptions{RunID: "slr-open-4"}) // anchors the post-sale 4
	exec(`DELETE FROM product_variants WHERE product_id=$1`, pG)
	exec(`DELETE FROM outlet_variant_stock WHERE product_id=$1`, pG)
	if code := refund(o4); code != 200 && code != 201 {
		t.Fatalf("refund o4: %d", code)
	}
	if c := len(refundRows(o4)); c != 0 {
		t.Fatalf("a gone variant must not be restocked in the ledger, got %d rows", c)
	}
	var exc int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM sale_stock_exceptions x JOIN order_items oi ON oi.id=x.order_item_id WHERE oi.order_id=$1 AND x.kind='refund_unresolved_variant'`, o4).Scan(&exc); err != nil || exc != 1 {
		t.Fatalf("refund_unresolved_variant rows = %d err=%v, want 1", exc, err)
	}
	// the catalog delete took the stock away without a movement; reconcile it so the invariant stays honest
	if _, err := slRecord(ctx, pool, ledger.Document{
		Key: "adjust:slr-gone", Kind: ledger.KindAdjust, LocationType: ledger.LocOutlet, LocationID: slOutletC,
		RefType: "backfill", OccurredAt: time.Now().UTC(),
		Lines: []ledger.Line{{ProductID: pG, VariantSize: slrSize, Qty: -4, QtyBefore: 4, QtyAfter: 0, DedupeKey: "adjust:slr-gone"}},
	}, false); err != nil {
		t.Fatal(err)
	}
	assertLedgerInvariant(t, ctx, pool)
}
