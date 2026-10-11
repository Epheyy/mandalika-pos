package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/config"
	"github.com/mandalika/pos-backend/internal/db"
	mw "github.com/mandalika/pos-backend/internal/middleware"
	"github.com/mandalika/pos-backend/internal/read"
	"github.com/mandalika/pos-backend/internal/service"
	syncpkg "github.com/mandalika/pos-backend/internal/sync"
	"github.com/mandalika/pos-backend/internal/write"
)

// A06 refund parity: the direct POST /orders/{id}/refund and the /sync/batch
// "refund" item must enforce the same rules and leave the same effects. Opt-in
// only, same isolation contract as the other PostgreSQL gates. Every case speaks
// raw JSON over HTTP so the gate compiles (and fails behaviourally) against code
// that predates the shared rules.
func TestRefundParityPostgres(t *testing.T) {
	dsn := os.Getenv("MANDALIKA_RF_TEST_DSN")
	if dsn == "" {
		t.Skip("isolated PostgreSQL fixture not configured")
	}
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ConnConfig.Host != "127.0.0.1" || cfg.ConnConfig.Port != 56449 || cfg.ConnConfig.Database != "mandalika_rf_synthetic" || cfg.ConnConfig.User != "rf_test" {
		t.Fatal("refusing non-fixture target")
	}
	ctx := context.Background()
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	var dir string
	if err = pool.QueryRow(ctx, "SHOW data_directory").Scan(&dir); err != nil {
		t.Fatal(err)
	}
	expected := os.Getenv("MANDALIKA_RF_TEST_DATA_DIR")
	if expected == "" || filepath.Clean(dir) != filepath.Clean(expected) {
		t.Fatal("test cluster directory mismatch")
	}
	var tables int
	if err = pool.QueryRow(ctx, "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'").Scan(&tables); err != nil || tables != 0 {
		t.Fatalf("fixture must be empty: tables=%d err=%v", tables, err)
	}
	if err = (&db.DB{Pool: pool}).Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	// Subtests share these helpers; failures must target the running subtest.
	cur := t
	sub := func(name string, fn func(t *testing.T)) {
		t.Run(name, func(st *testing.T) {
			prev := cur
			cur = st
			defer func() { cur = prev }()
			fn(st)
		})
	}
	exec := func(sql string, args ...any) {
		cur.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			cur.Fatal(err)
		}
	}
	count := func(sql string, args ...any) (n int) {
		cur.Helper()
		if err := pool.QueryRow(ctx, sql, args...).Scan(&n); err != nil {
			cur.Fatal(err)
		}
		return
	}
	const (
		outX    = "00000000-0000-4000-8f00-000000000001"
		outY    = "00000000-0000-4000-8f00-000000000002"
		userX   = "00000000-0000-4000-8f00-000000000011"
		userY   = "00000000-0000-4000-8f00-000000000012"
		adminU  = "00000000-0000-4000-8f00-000000000013"
		product = "00000000-0000-4000-8f00-000000000021"
		device  = "rfdev"
		ghost   = "00000000-0000-4000-8f00-0000000000ff"
	)
	exec(`INSERT INTO outlets(id,name) VALUES($1,'RF outlet X'),($2,'RF outlet Y')`, outX, outY)
	exec(`INSERT INTO users(id,email,password_hash,display_name,role,outlet_id) VALUES
		($1,'x@example.invalid','x','RF cashier X','cashier',$3),
		($2,'y@example.invalid','x','RF cashier Y','cashier',$4)`, userX, userY, outX, outY)
	exec(`INSERT INTO users(id,email,password_hash,display_name,role) VALUES($1,'adm@example.invalid','x','RF admin','admin')`, adminU)
	exec(`INSERT INTO products(id,name) VALUES($1,'RF product')`, product)
	exec(`INSERT INTO product_variants(product_id,size,price,stock,sku) VALUES($1,'110ml',100000,1000,'RF')`, product)
	for _, o := range []string{outX, outY} {
		exec(`INSERT INTO outlet_variant_stock(outlet_id,product_id,variant_size,stock) VALUES($1,$2,'110ml',1000)`, o, product)
	}
	rd, wr, svc := read.New(pool), write.New(pool), service.NewOrderService(pool)
	h := New(rd, nil, auth.NewStore(pool), wr, svc, syncpkg.New(pool, rd, svc, wr), nil)
	secret := []byte("RF-INTEGRATION-SYNTHETIC-KEY")
	issue := func(user, role, outlet string, perms ...string) string {
		tok, err := auth.IssueAccess(secret, time.Hour, user, role, outlet, perms)
		if err != nil {
			t.Fatal(err)
		}
		return tok
	}
	tokX := issue(userX, "cashier", outX, "create_order", "process_refund")
	tokXNoPerm := issue(userX, "cashier", outX, "create_order")
	tokAdminX := issue(adminU, "admin", outX) // admin pinned to X (the batch needs an outlet)
	tokAdminAll := issue(adminU, "admin", "") // admin on "Semua outlet"
	authWrap := mw.RequireAuth(&config.Config{AccessSecret: secret})
	router := chi.NewRouter()
	router.With(authWrap).Post("/sync/batch", h.SyncBatch)
	router.With(authWrap, mw.RequirePermission("process_refund")).Post("/orders/{id}/refund", h.RefundOrder)

	// direct posts the refund body and returns status + raw body.
	direct := func(token, id string, body string) (int, string) {
		cur.Helper()
		r := httptest.NewRequest("POST", "/orders/"+id+"/refund", strings.NewReader(body))
		r.Header.Set("Authorization", "Bearer "+token)
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		return w.Code, w.Body.String()
	}
	type result struct {
		Key       string `json:"idempotencyKey"`
		Status    string `json:"status"`
		OrderID   string `json:"orderId"`
		Code      string `json:"code"`
		Retryable *bool  `json:"retryable"`
		Error     string `json:"error"`
	}
	flush := func(token string, item map[string]any) result {
		cur.Helper()
		raw, err := json.Marshal(map[string]any{"items": []any{item}})
		if err != nil {
			cur.Fatal(err)
		}
		r := httptest.NewRequest("POST", "/sync/batch", bytes.NewReader(raw))
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		var out struct {
			Data struct {
				Results []result `json:"results"`
			} `json:"data"`
		}
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &out) != nil || len(out.Data.Results) != 1 {
			cur.Fatalf("batch %d %s", w.Code, w.Body.String())
		}
		return out.Data.Results[0]
	}
	seq := 0
	// batchRefund posts one enveloped refund captured at outlet X; a nil reason
	// omits the field.
	batchRefund := func(token, user, name, orderID string, reason any) result {
		cur.Helper()
		payload := map[string]any{"orderId": orderID}
		if reason != nil {
			payload["reason"] = reason
		}
		return flush(token, map[string]any{
			"type": "refund", "idempotencyKey": device + ":" + name, "payload": payload,
			"envelope": map[string]any{"v": 1, "outletId": outX, "userId": user, "deviceId": device, "capturedAt": time.Now().UTC().Format(time.RFC3339)},
		})
	}
	stock := func(outlet string) int {
		return count(`SELECT stock FROM outlet_variant_stock WHERE outlet_id=$1 AND product_id=$2 AND variant_size='110ml'`, outlet, product)
	}
	// newOrder inserts an order with 2 units, a customer holding points and a
	// discount code, so a refund has every effect to apply.
	type fixture struct{ id, customer, code string }
	newOrder := func(outlet, status string) fixture {
		cur.Helper()
		seq++
		f := fixture{
			id:       fmt.Sprintf("00000000-0000-4000-8f01-%012d", seq),
			customer: fmt.Sprintf("00000000-0000-4000-8f02-%012d", seq),
			code:     fmt.Sprintf("RFCODE%d", seq),
		}
		cashier := userX
		if outlet == outY {
			cashier = userY
		}
		exec(`INSERT INTO customers(id,name,phone,points) VALUES($1,'RF customer',$2,100)`, f.customer, fmt.Sprintf("rf-%d", seq))
		exec(`INSERT INTO discount_codes(code,type,value,usage_count) VALUES($1,'fixed',1000,5)`, f.code)
		exec(`INSERT INTO orders(id,order_number,order_uuid,idempotency_key,outlet_id,cashier_id,cashier_name,subtotal,total,payment_method,status,customer_id,points_earned,discount_code,applied_discount_codes)
			VALUES($1,$2,gen_random_uuid(),$3,$4,$5,'RF cashier',100,100,'cash',$6,$7,10,$8,to_jsonb(ARRAY[$8]::text[]))`,
			f.id, fmt.Sprintf("RF-%06d", seq), fmt.Sprintf("rf-order-key-%d", seq), outlet, cashier, status, f.customer, f.code)
		exec(`INSERT INTO order_items(order_id,product_id,product_name,variant_size,price,quantity,subtotal) VALUES($1,$2,'RF product','110ml',50,2,100)`, f.id, product)
		return f
	}
	// world is everything a refused refund must not touch.
	type world struct {
		refunded, reasons, stamps, receipts, ledger, points, usage, stockX, stockY int
	}
	snap := func() world {
		return world{
			count(`SELECT count(*) FROM orders WHERE status='refunded'`),
			count(`SELECT count(*) FROM orders WHERE refund_reason IS NOT NULL`),
			count(`SELECT count(*) FROM orders WHERE refunded_at IS NOT NULL`),
			count(`SELECT count(*) FROM operation_receipts`),
			count(`SELECT count(*) FROM point_transactions`),
			count(`SELECT COALESCE(sum(points),0)::int FROM customers`),
			count(`SELECT COALESCE(sum(usage_count),0)::int FROM discount_codes`),
			stock(outX), stock(outY),
		}
	}
	wantDirectReject := func(name string, want, got int, body string, before world) {
		cur.Helper()
		if got != want {
			cur.Fatalf("%s: direct status=%d want %d body=%s", name, got, want, body)
		}
		for _, leak := range []string{"SQLSTATE", "invalid input syntax", "uuid"} {
			if strings.Contains(body, leak) {
				cur.Fatalf("%s: database text leaked: %s", name, body)
			}
		}
		if after := snap(); after != before {
			cur.Fatalf("%s: a refused refund had effects: before=%+v after=%+v", name, before, after)
		}
	}
	wantBatchReject := func(name, code string, r result, before world) {
		cur.Helper()
		if r.Status != "error" || r.Code != code || r.Retryable == nil || *r.Retryable {
			cur.Fatalf("%s: want non-retryable %s, got %+v", name, code, r)
		}
		if after := snap(); after != before {
			cur.Fatalf("%s: a refused refund had effects: before=%+v after=%+v", name, before, after)
		}
	}
	// wantRefunded asserts every effect of one refund, applied exactly once.
	wantRefunded := func(name string, f fixture, outlet string, stockBefore int, reason string) {
		cur.Helper()
		var status string
		var rr *string
		var at *time.Time
		if err := pool.QueryRow(ctx, `SELECT status, refund_reason, refunded_at FROM orders WHERE id=$1`, f.id).Scan(&status, &rr, &at); err != nil {
			cur.Fatal(err)
		}
		if status != "refunded" || rr == nil || *rr != reason || at == nil {
			cur.Fatalf("%s: order status=%s reason=%v at=%v", name, status, rr, at)
		}
		if got := stock(outlet); got != stockBefore+2 {
			cur.Fatalf("%s: stock %d want %d", name, got, stockBefore+2)
		}
		if got := count(`SELECT points FROM customers WHERE id=$1`, f.customer); got != 90 {
			cur.Fatalf("%s: points %d want 90", name, got)
		}
		if got := count(`SELECT count(*) FROM point_transactions WHERE order_id=$1`, f.id); got != 1 {
			cur.Fatalf("%s: ledger rows %d want 1", name, got)
		}
		if got := count(`SELECT usage_count FROM discount_codes WHERE code=$1`, f.code); got != 4 {
			cur.Fatalf("%s: usage_count %d want 4", name, got)
		}
	}
	wantOK := func(name string, r result) {
		cur.Helper()
		if r.Status != "ok" {
			cur.Fatalf("%s: want ok, got %+v", name, r)
		}
	}
	body := func(reason string) string {
		b, _ := json.Marshal(map[string]string{"reason": reason})
		return string(b)
	}

	sub("1 permitted cashier refunds an own completed order", func(t *testing.T) {
		d, b := newOrder(outX, "completed"), newOrder(outX, "completed")
		s0 := stock(outX)
		if code, out := direct(tokX, d.id, body("rusak")); code != 201 {
			t.Fatalf("direct %d %s", code, out)
		}
		wantRefunded("direct", d, outX, s0, "rusak")
		s1 := stock(outX)
		wantOK("batch", batchRefund(tokX, userX, "c1", b.id, "rusak"))
		wantRefunded("batch", b, outX, s1, "rusak")
	})
	sub("2 no process_refund permission", func(t *testing.T) {
		o := newOrder(outX, "completed")
		before := snap()
		code, out := direct(tokXNoPerm, o.id, body("rusak"))
		wantDirectReject("direct", 403, code, out, before)
		wantBatchReject("batch", "forbidden", batchRefund(tokXNoPerm, userX, "c2", o.id, "rusak"), before)
	})
	sub("3 admin role needs no explicit permission", func(t *testing.T) {
		d, b := newOrder(outX, "completed"), newOrder(outX, "completed")
		s0 := stock(outX)
		if code, out := direct(tokAdminX, d.id, body("rusak")); code != 201 {
			t.Fatalf("direct %d %s", code, out)
		}
		wantRefunded("direct", d, outX, s0, "rusak")
		s1 := stock(outX)
		wantOK("batch", batchRefund(tokAdminX, adminU, "c3", b.id, "rusak"))
		wantRefunded("batch", b, outX, s1, "rusak")
	})
	sub("4 reason empty or missing is refused", func(t *testing.T) {
		o := newOrder(outX, "completed")
		before := snap()
		code, out := direct(tokX, o.id, body(""))
		wantDirectReject("direct empty", 400, code, out, before)
		code, out = direct(tokX, o.id, `{}`)
		wantDirectReject("direct missing", 400, code, out, before)
		wantBatchReject("batch empty", "rejected", batchRefund(tokX, userX, "c4a", o.id, ""), before)
		wantBatchReject("batch missing", "rejected", batchRefund(tokX, userX, "c4b", o.id, nil), before)
	})
	sub("5 whitespace-only reason is refused", func(t *testing.T) {
		o := newOrder(outX, "completed")
		before := snap()
		code, out := direct(tokX, o.id, body("   \t "))
		wantDirectReject("direct", 400, code, out, before)
		wantBatchReject("batch", "rejected", batchRefund(tokX, userX, "c5", o.id, "   \t "), before)
	})
	sub("6 reason length is capped at 500 runes", func(t *testing.T) {
		o := newOrder(outX, "completed")
		before := snap()
		long := strings.Repeat("é", 501) // multibyte: 501 runes, 1002 bytes
		code, out := direct(tokX, o.id, body(long))
		wantDirectReject("direct 501", 400, code, out, before)
		wantBatchReject("batch 501", "rejected", batchRefund(tokX, userX, "c6a", o.id, long), before)
		edge := strings.Repeat("é", 500)
		d, b := newOrder(outX, "completed"), newOrder(outX, "completed")
		s0 := stock(outX)
		if code, out := direct(tokX, d.id, body(edge)); code != 201 {
			t.Fatalf("direct 500 %d %s", code, out)
		}
		wantRefunded("direct 500", d, outX, s0, edge)
		s1 := stock(outX)
		wantOK("batch 500", batchRefund(tokX, userX, "c6b", b.id, edge))
		wantRefunded("batch 500", b, outX, s1, edge)
	})
	sub("7 reason is trimmed before it is stored", func(t *testing.T) {
		d, b := newOrder(outX, "completed"), newOrder(outX, "completed")
		s0 := stock(outX)
		if code, out := direct(tokX, d.id, body("  rusak  ")); code != 201 {
			t.Fatalf("direct %d %s", code, out)
		}
		wantRefunded("direct", d, outX, s0, "rusak")
		s1 := stock(outX)
		wantOK("batch", batchRefund(tokX, userX, "c7", b.id, "  rusak  "))
		wantRefunded("batch", b, outX, s1, "rusak")
	})
	sub("8 another outlet's order is a conflict", func(t *testing.T) {
		o := newOrder(outY, "completed")
		before := snap()
		code, out := direct(tokX, o.id, body("rusak"))
		wantDirectReject("direct", 409, code, out, before)
		wantBatchReject("batch", "conflict", batchRefund(tokX, userX, "c8", o.id, "rusak"), before)
	})
	sub("9 unknown order id is a conflict", func(t *testing.T) {
		before := snap()
		code, out := direct(tokX, ghost, body("rusak"))
		wantDirectReject("direct", 409, code, out, before)
		wantBatchReject("batch", "conflict", batchRefund(tokX, userX, "c9", ghost, "rusak"), before)
	})
	sub("10 malformed order id never leaks database text", func(t *testing.T) {
		before := snap()
		code, out := direct(tokX, "abc", body("rusak"))
		wantDirectReject("direct", 400, code, out, before)
		wantBatchReject("batch", "rejected", batchRefund(tokX, userX, "c10", "abc", "rusak"), before)
	})
	sub("11 an already refunded order is a conflict (Q1)", func(t *testing.T) {
		d, b := newOrder(outX, "completed"), newOrder(outX, "completed")
		if code, out := direct(tokX, d.id, body("rusak")); code != 201 {
			t.Fatalf("first direct %d %s", code, out)
		}
		wantOK("first batch", batchRefund(tokX, userX, "c11a", b.id, "rusak"))
		before := snap()
		code, out := direct(tokX, d.id, body("rusak lagi"))
		wantDirectReject("direct", 409, code, out, before)
		// A different key is a different operation: the second payout is refused.
		wantBatchReject("batch", "conflict", batchRefund(tokX, userX, "c11b", b.id, "rusak lagi"), before)
	})
	sub("12 only a completed order is refundable", func(t *testing.T) {
		o := newOrder(outX, "cancelled")
		before := snap()
		code, out := direct(tokX, o.id, body("rusak"))
		wantDirectReject("direct", 409, code, out, before)
		wantBatchReject("batch", "conflict", batchRefund(tokX, userX, "c12", o.id, "rusak"), before)
		if got := count(`SELECT count(*) FROM orders WHERE id=$1 AND status='cancelled'`, o.id); got != 1 {
			t.Fatal("cancelled order was changed")
		}
	})
	sub("13 same-key replay returns ok without a second restock", func(t *testing.T) {
		o := newOrder(outX, "completed")
		s0 := stock(outX)
		first := batchRefund(tokX, userX, "c13", o.id, "rusak")
		wantOK("first", first)
		after := snap()
		again := batchRefund(tokX, userX, "c13", o.id, "rusak")
		wantOK("replay", again)
		if again.OrderID != first.OrderID || again.OrderID != o.id {
			t.Fatalf("replay id %q first %q", again.OrderID, first.OrderID)
		}
		if snap() != after {
			t.Fatal("a replay had effects")
		}
		wantRefunded("replay", o, outX, s0, "rusak")
	})
	sub("14 a committed refund replays even after the permission was removed", func(t *testing.T) {
		o := newOrder(outX, "completed")
		first := batchRefund(tokX, userX, "c14", o.id, "rusak")
		wantOK("first", first)
		after := snap()
		again := batchRefund(tokXNoPerm, userX, "c14", o.id, "rusak")
		wantOK("replay without permission", again)
		if again.OrderID != first.OrderID {
			t.Fatalf("replay id %q first %q", again.OrderID, first.OrderID)
		}
		if snap() != after {
			t.Fatal("a replay had effects")
		}
		// A key that never committed stays forbidden.
		fresh := newOrder(outX, "completed")
		before := snap()
		wantBatchReject("uncommitted key", "forbidden", batchRefund(tokXNoPerm, userX, "c14b", fresh.id, "rusak"), before)
	})
	sub("15 admin with no outlet refunds at the order's own outlet (Q4)", func(t *testing.T) {
		o := newOrder(outY, "completed")
		s0, sx := stock(outY), stock(outX)
		if code, out := direct(tokAdminAll, o.id, body("rusak")); code != 201 {
			t.Fatalf("direct %d %s", code, out)
		}
		wantRefunded("admin all-outlets", o, outY, s0, "rusak")
		if stock(outX) != sx {
			t.Fatal("stock moved at the wrong outlet")
		}
		// No new authority: a non-admin with no outlet is refused.
		exec(`UPDATE users SET outlet_id=NULL WHERE id=$1`, userY)
		defer exec(`UPDATE users SET outlet_id=$1 WHERE id=$2`, outY, userY)
		o2 := newOrder(outY, "completed")
		before := snap()
		code, out := direct(issue(userY, "cashier", "", "process_refund"), o2.id, body("rusak"))
		wantDirectReject("non-admin without outlet", 403, code, out, before)
	})
}
