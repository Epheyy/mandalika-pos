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
	slsUser   = "00000000-0000-4000-8f68-000000000e01"
	slsSecret = "SL-SALE-SYNTHETIC-KEY"
	slsSize   = "sl-size"
)

// slSale drives sales through the real router (POST /orders, POST /sync/batch, refund):
// the sale rows cover exactly the lines that moved stock, chain per (product, size),
// flag the shortages the A44 exception rows record, and are never repeated by a replay
// (plan §2.3 row 1, D10).
func slSale(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	slSetup(t, ctx, pool)
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`INSERT INTO users(id,email,password_hash,display_name,role,outlet_id) VALUES($1,'sls@example.invalid','x','SL sale cashier','cashier',$2) ON CONFLICT DO NOTHING`, slsUser, slOutletC)
	exec(`INSERT INTO shifts(id,outlet_id,cashier_id,cashier_name,status,opened_at,starting_cash) VALUES(gen_random_uuid(),$1,$2,'SL sale cashier','open',now(),0) ON CONFLICT DO NOTHING`, slOutletC, slsUser)
	var slsShift string // one open shift per outlet: reuse whichever is open on outlet C
	if err := pool.QueryRow(ctx, `SELECT id::text FROM shifts WHERE outlet_id=$1 AND status='open'`, slOutletC).Scan(&slsShift); err != nil {
		t.Fatal(err)
	}
	rd, wr, svc := read.New(pool), write.New(pool), service.NewOrderService(pool)
	h := New(rd, nil, auth.NewStore(pool), wr, svc, syncpkg.New(pool, rd, svc, wr), nil)
	secret := []byte(slsSecret)
	token, err := auth.IssueAccess(secret, time.Hour, slsUser, "cashier", slOutletC, []string{"create_order", "process_refund"})
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
	one := func(sql string, args ...any) int {
		t.Helper()
		var n int
		if err := pool.QueryRow(ctx, sql, args...).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}

	n := 0
	id := func(group string) string { n++; return fmt.Sprintf("00000000-0000-4000-8f68-%s%011d", group, n) }
	product := func(withVariant bool, stock int) string {
		pid := id("1")
		exec(`INSERT INTO products(id,name) VALUES($1,$2)`, pid, "SLS product "+pid[len(pid)-4:])
		if withVariant {
			exec(`INSERT INTO product_variants(product_id,size,price,stock,sku) VALUES($1,$2,100000,0,$3)`, pid, slsSize, "SLS"+pid[len(pid)-6:])
			exec(`INSERT INTO outlet_variant_stock(outlet_id,product_id,variant_size,stock) VALUES($1,$2,$3,$4)`, slOutletC, pid, slsSize, stock)
		}
		return pid
	}
	line := func(pid, size string, qty int, bundle bool) map[string]any {
		return map[string]any{"productId": pid, "productName": "SLS", "variantSize": size, "price": 100000,
			"quantity": qty, "subtotal": 100000 * qty, "isBundle": bundle}
	}
	payload := func(items ...map[string]any) map[string]any {
		total := 0
		for _, it := range items {
			total += it["subtotal"].(int)
		}
		return map[string]any{"orderUuid": id("2"), "paymentMethod": "cash", "amountPaid": total, "shiftId": slsShift, "items": items}
	}
	orderID := func(key string) string {
		t.Helper()
		var oid string
		if err := pool.QueryRow(ctx, `SELECT id::text FROM orders WHERE idempotency_key=$1`, key).Scan(&oid); err != nil {
			t.Fatal(err)
		}
		return oid
	}
	sale := func(key string, p map[string]any) string {
		t.Helper()
		if code, body := do("/orders", p, key); code != 200 && code != 201 {
			t.Fatalf("sale %s: %d %s", key, code, body)
		}
		return orderID(key)
	}
	syncSale := func(key string, p map[string]any) {
		t.Helper()
		batch := map[string]any{"items": []any{map[string]any{"type": "order", "idempotencyKey": key, "payload": p}}}
		if code, body := do("/sync/batch", batch, ""); code != 200 || !(strings.Contains(body, `"ok"`) || strings.Contains(body, `"duplicate"`)) {
			t.Fatalf("sync sale %s: %d %s", key, code, body)
		}
	}
	rows := func(oid string) []slMovement { return slMovements(t, ctx, pool, "sale", oid) }
	byProduct := func(ms []slMovement, pid string) []slMovement {
		var out []slMovement
		for _, m := range ms {
			if m.Product == pid {
				out = append(out, m)
			}
		}
		return out
	}
	orderNumber := func(oid string) string {
		t.Helper()
		var s string
		if err := pool.QueryRow(ctx, `SELECT order_number FROM orders WHERE id=$1`, oid).Scan(&s); err != nil {
			t.Fatal(err)
		}
		return s
	}
	stockSeq := func() int {
		return one(`SELECT coalesce((SELECT seq::int FROM outlet_stock_seq WHERE outlet_id=$1),0)`, slOutletC)
	}

	// ---- direct sale: normal, duplicated key, bundle without variant, unresolved variant ----
	pN, pD, pB, pU := product(true, 10), product(true, 10), product(false, 0), product(false, 0)
	pS := product(true, 2) // oversell: two lines of one key, the second goes negative
	pT := product(true, 1) // oversell: single line, 1 -> -2
	slBackfill(t, ctx, pool, ledger.BackfillOptions{RunID: "sls-open-1"})
	seq0 := stockSeq()
	o1 := sale("sls-sale-1", payload(
		line(pN, slsSize, 2, false), line(pD, slsSize, 1, false), line(pD, slsSize, 2, false),
		line(pB, "bundle", 1, true), line(pU, "zz", 1, false)))
	if d := stockSeq() - seq0; d != 1 {
		t.Fatalf("outlet_stock_seq bumped %d times by one sale, want 1", d)
	}
	rn := orderNumber(o1)
	got := rows(o1)
	if len(got) != 3 {
		t.Fatalf("sale rows = %+v, want 3 (N, D, D only)", got)
	}
	if want := []slMovement{{pN, slsSize, -2, 10, 8, "outlet", slOutletC, rn, []string{}}}; !reflect.DeepEqual(byProduct(got, pN), want) {
		t.Fatalf("N sale rows %+v, want %+v", byProduct(got, pN), want)
	}
	wantD := []slMovement{
		{pD, slsSize, -1, 10, 9, "outlet", slOutletC, rn, []string{}},
		{pD, slsSize, -2, 9, 7, "outlet", slOutletC, rn, []string{}},
	}
	if !reflect.DeepEqual(byProduct(got, pD), wantD) {
		t.Fatalf("duplicate-key sale rows %+v, want %+v", byProduct(got, pD), wantD)
	}
	if c := len(byProduct(got, pB)) + len(byProduct(got, pU)); c != 0 {
		t.Fatalf("%d rows for the bundle / unresolved lines, want none", c)
	}
	assertLedgerInvariant(t, ctx, pool)

	// ---- oversell: shortage flags == the A44 shortage exception rows ----
	o2 := sale("sls-sale-2", payload(
		line(pT, slsSize, 3, false), line(pS, slsSize, 1, false), line(pS, slsSize, 2, false)))
	got = rows(o2)
	rn2 := orderNumber(o2)
	if want := []slMovement{{pT, slsSize, -3, 1, -2, "outlet", slOutletC, rn2, []string{"shortage"}}}; !reflect.DeepEqual(byProduct(got, pT), want) {
		t.Fatalf("T sale rows %+v, want %+v", byProduct(got, pT), want)
	}
	wantS := []slMovement{
		{pS, slsSize, -1, 2, 1, "outlet", slOutletC, rn2, []string{}},
		{pS, slsSize, -2, 1, -1, "outlet", slOutletC, rn2, []string{"shortage"}},
	}
	if !reflect.DeepEqual(byProduct(got, pS), wantS) {
		t.Fatalf("S sale rows %+v, want %+v", byProduct(got, pS), wantS)
	}
	flagged := func(q string) []string {
		t.Helper()
		rs, err := pool.Query(ctx, q, o2)
		if err != nil {
			t.Fatal(err)
		}
		defer rs.Close()
		var out []string
		for rs.Next() {
			var s string
			if err := rs.Scan(&s); err != nil {
				t.Fatal(err)
			}
			out = append(out, s)
		}
		return out
	}
	fromLedger := flagged(`SELECT ref_line::text FROM stock_movements WHERE kind='sale' AND ref_id=$1 AND 'shortage' = ANY(flags) ORDER BY 1`)
	fromExc := flagged(`SELECT order_item_id::text FROM sale_stock_exceptions WHERE order_id=$1 AND kind='shortage' ORDER BY 1`)
	if len(fromLedger) != 2 || !reflect.DeepEqual(fromLedger, fromExc) {
		t.Fatalf("shortage-flagged movements %v != shortage exceptions %v", fromLedger, fromExc)
	}
	assertLedgerInvariant(t, ctx, pool)

	// ---- replays add nothing: POST /orders by key, and a replayed sync batch ----
	before := slCount(t, ctx, pool, `kind='sale'`)
	if code, body := do("/orders", payload(line(pN, slsSize, 1, false)), "sls-sale-1"); code != 200 && code != 201 {
		t.Fatalf("replay: %d %s", code, body)
	}
	if after := slCount(t, ctx, pool, `kind='sale'`); after != before {
		t.Fatalf("a replayed POST /orders wrote %d sale movements", after-before)
	}
	pY := product(true, 5)
	slBackfill(t, ctx, pool, ledger.BackfillOptions{RunID: "sls-open-2"})
	sp := payload(line(pY, slsSize, 2, false))
	for i := 0; i < 2; i++ {
		syncSale("sls-sync-1", sp)
		if c := one(`SELECT count(*) FROM stock_movements m JOIN orders o ON o.id=m.ref_id WHERE m.kind='sale' AND o.idempotency_key='sls-sync-1'`); c != 1 {
			t.Fatalf("sync pass %d: %d sale rows, want 1", i, c)
		}
	}
	o3 := orderID("sls-sync-1")
	if m := rows(o3); len(m) != 1 || m[0].Qty != -2 || m[0].Before != 5 || m[0].After != 3 {
		t.Fatalf("sync sale rows %+v", m)
	}
	assertLedgerInvariant(t, ctx, pool)

	// ---- lazy row, bundle with a variant, Rp0 line, uppercase id, sync clientCreatedAt ----
	pL := id("1") // variant exists, no stock row yet: the sale creates it at 0
	exec(`INSERT INTO products(id,name) VALUES($1,'SLS lazy')`, pL)
	exec(`INSERT INTO product_variants(product_id,size,price,stock,sku) VALUES($1,$2,100000,0,$3)`, pL, slsSize, "SLS"+pL[len(pL)-6:])
	pBV, pZ, pUp, pC := product(true, 5), product(true, 5), product(true, 5), product(true, 5)
	slBackfill(t, ctx, pool, ledger.BackfillOptions{RunID: "sls-open-3"})
	zero := line(pZ, slsSize, 1, false)
	zero["price"], zero["subtotal"] = 0, 0
	o4 := sale("sls-sale-4", payload(
		line(pL, slsSize, 2, false), line(pBV, slsSize, 1, true), zero,
		line(strings.ToUpper(pUp), slsSize, 1, false)))
	rn4, got4 := orderNumber(o4), rows(o4)
	if len(got4) != 4 {
		t.Fatalf("o4 sale rows = %+v, want 4", got4)
	}
	for _, w := range []slMovement{
		{pL, slsSize, -2, 0, -2, "outlet", slOutletC, rn4, []string{"shortage"}},
		{pBV, slsSize, -1, 5, 4, "outlet", slOutletC, rn4, []string{}},
		{pZ, slsSize, -1, 5, 4, "outlet", slOutletC, rn4, []string{}},
		{pUp, slsSize, -1, 5, 4, "outlet", slOutletC, rn4, []string{}}, // canonical (lowercase) id
	} {
		if g := byProduct(got4, w.Product); !reflect.DeepEqual(g, []slMovement{w}) {
			t.Fatalf("o4 rows for %s = %+v, want %+v", w.Product, g, w)
		}
	}
	assertLedgerInvariant(t, ctx, pool)
	capAt := time.Now().UTC().Add(-time.Hour).Truncate(time.Second)
	cp := payload(line(pC, slsSize, 1, false))
	cp["clientCreatedAt"] = capAt.Format(time.RFC3339)
	syncSale("sls-sync-2", cp)
	var occ time.Time
	if err := pool.QueryRow(ctx, `SELECT m.occurred_at FROM stock_movements m JOIN orders o ON o.id=m.ref_id WHERE m.kind='sale' AND o.idempotency_key='sls-sync-2'`).Scan(&occ); err != nil || !occ.Equal(capAt) {
		t.Fatalf("occurred_at = %v (err %v), want clientCreatedAt %v", occ, err, capAt)
	}
	assertLedgerInvariant(t, ctx, pool)

	// ---- refund of a ledger sale links every restocked line to its sale movement ----
	rcode, rbody := do("/orders/"+o1+"/refund", map[string]any{"reason": "sls"}, "")
	if rcode != 200 && rcode != 201 {
		t.Fatalf("refund o1: %d %s", rcode, rbody)
	}
	if c := slCount(t, ctx, pool, `kind='refund' AND ref_id=$1`, o1); c != 3 {
		t.Fatalf("%d refund rows, want 3", c)
	}
	if c := slCount(t, ctx, pool, `kind='refund' AND ref_id=$1 AND refund_of_movement_id IN
	    (SELECT id FROM stock_movements WHERE kind='sale' AND ref_id=$1)`, o1); c != 3 {
		t.Fatalf("%d of 3 refund rows link to a sale movement", c)
	}
	assertLedgerInvariant(t, ctx, pool)
}
