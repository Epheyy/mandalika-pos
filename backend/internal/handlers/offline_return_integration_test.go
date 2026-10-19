package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"path/filepath"
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

// A41 offline returns. Opt-in only, same isolation contract as the other gates. A refund
// may name its sale by the client orderUuid (the sale was made on this tablet and its
// server id is unknown): the server resolves it inside the refund's own transaction.
func TestOfflineReturnPostgres(t *testing.T) {
	dsn := os.Getenv("MANDALIKA_OF_TEST_DSN")
	if dsn == "" {
		t.Skip("isolated PostgreSQL fixture not configured")
	}
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ConnConfig.Host != "127.0.0.1" || cfg.ConnConfig.Port != 56465 || cfg.ConnConfig.Database != "mandalika_of_synthetic" || cfg.ConnConfig.User != "of_test" {
		t.Fatal("refusing non-fixture target")
	}
	cfg.ConnConfig.RuntimeParams["timezone"] = "UTC"
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
	expected := os.Getenv("MANDALIKA_OF_TEST_DATA_DIR")
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
	str := func(sql string, args ...any) string {
		cur.Helper()
		var s *string
		if err := pool.QueryRow(ctx, sql, args...).Scan(&s); err != nil {
			cur.Fatalf("%s: %v", sql, err)
		}
		if s == nil {
			return "<null>"
		}
		return *s
	}
	const (
		outW    = "00000000-0000-4000-8e00-000000000001"
		userW   = "00000000-0000-4000-8e00-000000000011"
		product = "00000000-0000-4000-8e00-000000000021"
		promo   = "00000000-0000-4000-8e00-000000000031"
		device  = "00000000-0000-4000-8e00-0000000000d1"
		outB    = "00000000-0000-4000-8e00-000000000002"
		userB   = "00000000-0000-4000-8e00-000000000012"
	)
	exec(`INSERT INTO outlets(id,name) VALUES($1,'OF Jakarta')`, outW)
	exec(`INSERT INTO users(id,email,password_hash,display_name,role,outlet_id) VALUES($1,'w@example.invalid','x','OF cashier','cashier',$2)`, userW, outW)
	exec(`INSERT INTO products(id,name) VALUES($1,'OF product')`, product)
	exec(`INSERT INTO product_variants(product_id,size,price,stock,sku) VALUES($1,'110ml',100000,1000,'OF')`, product)
	exec(`INSERT INTO outlet_variant_stock(outlet_id,product_id,variant_size,stock) VALUES($1,$2,'110ml',1000)`, outW, product)
	exec(`INSERT INTO outlets(id,name) VALUES($1,'OF Bandung')`, outB)
	exec(`INSERT INTO users(id,email,password_hash,display_name,role,outlet_id) VALUES($1,'b@example.invalid','x','OF cashier B','cashier',$2)`, userB, outB)
	exec(`INSERT INTO outlet_variant_stock(outlet_id,product_id,variant_size,stock) VALUES($1,$2,'110ml',1000)`, outB, product)
	rd, wr, svc := read.New(pool), write.New(pool), service.NewOrderService(pool)
	eng := syncpkg.New(pool, rd, svc, wr)
	secret := []byte("OF-INTEGRATION-SYNTHETIC-KEY-0123456789")
	key := syncpkg.DeriveContactKey(secret)
	eng.ContactKey = key
	h := New(rd, nil, auth.NewStore(pool), wr, svc, eng, nil)
	tok, err := auth.IssueAccess(secret, time.Hour, userW, "cashier", outW, []string{"create_order", "process_refund"})
	if err != nil {
		t.Fatal(err)
	}
	tokB, err := auth.IssueAccess(secret, time.Hour, userB, "cashier", outB, []string{"create_order", "process_refund"})
	if err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	authWrap := mw.RequireAuth(&config.Config{AccessSecret: secret})
	router.With(authWrap).Post("/sync/batch", h.SyncBatch)
	router.With(authWrap).Get("/sync/version", h.SyncVersion)
	tokNow := tok
	call := func(method, path string, body any) (int, map[string]any) {
		cur.Helper()
		rdr := bytes.NewReader(nil)
		if body != nil {
			raw, err := json.Marshal(body)
			if err != nil {
				cur.Fatal(err)
			}
			rdr = bytes.NewReader(raw)
		}
		r := httptest.NewRequest(method, path, rdr)
		r.Header.Set("Authorization", "Bearer "+tokNow)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		var out map[string]any
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		return w.Code, out
	}
	seq := 0
	sale := func(extra map[string]any) map[string]any {
		seq++
		p := map[string]any{
			"orderUuid": fmt.Sprintf("00000000-0000-4000-8e03-%012d", seq), "deviceId": device,
			"paymentMethod": "cash", "amountPaid": 100000,
			"items": []map[string]any{{"productId": product, "productName": "OF product", "variantSize": "110ml", "price": 100000, "quantity": 1, "subtotal": 100000}},
		}
		for k, v := range extra {
			p[k] = v
		}
		return p
	}
	envFor := func(outlet, user string, offline time.Duration) map[string]any {
		return map[string]any{"v": 1, "outletId": outlet, "userId": user, "deviceId": device,
			"capturedAt": time.Now().UTC().Format(time.RFC3339Nano), "offlineMs": offline.Milliseconds()}
	}
	env := func() map[string]any { return envFor(outW, userW, time.Hour) }
	item := func(typ, name string, p, e map[string]any) map[string]any {
		return map[string]any{"type": typ, "idempotencyKey": device + ":" + name, "payload": p, "envelope": e}
	}
	batch := func(items ...map[string]any) []map[string]any {
		cur.Helper()
		raw := make([]any, len(items))
		for i, it := range items {
			raw[i] = it
		}
		code, out := call("POST", "/sync/batch", map[string]any{"items": raw})
		if code != 200 {
			cur.Fatalf("batch %d %v", code, out)
		}
		var res []map[string]any
		for _, r := range out["data"].(map[string]any)["results"].([]any) {
			res = append(res, r.(map[string]any))
		}
		return res
	}
	one := func(it map[string]any) map[string]any { cur.Helper(); return batch(it)[0] }
	wantOK := func(res map[string]any) {
		cur.Helper()
		if res["status"] != "ok" {
			cur.Fatalf("want ok, got %v", res)
		}
	}
	wantRefusal := func(res map[string]any, code string) {
		cur.Helper()
		if res["status"] != "error" || res["code"] != code || res["retryable"] != false {
			cur.Fatalf("want non-retryable %s, got %v", code, res)
		}
	}
	stock := func(outlet string) string {
		return str(`SELECT stock::text FROM outlet_variant_stock WHERE outlet_id=$1 AND product_id=$2`, outlet, product)
	}
	status := func(p map[string]any) string {
		return str(`SELECT status FROM orders WHERE order_uuid=$1`, p["orderUuid"].(string))
	}
	serverID := func(p map[string]any) string {
		return str(`SELECT id::text FROM orders WHERE order_uuid=$1`, p["orderUuid"].(string))
	}
	uuidRefund := func(p map[string]any, extra map[string]any) map[string]any {
		r := map[string]any{"orderId": "", "saleOrderUuid": p["orderUuid"], "deviceId": device, "reason": "salah beli"}
		for k, v := range extra {
			r[k] = v
		}
		return r
	}

	sub("1 sale and uuid refund in one batch: refunded, stock restored once", func(t *testing.T) {
		p := sale(nil)
		res := batch(item("order", "s1", p, env()), item("refund", "r1", uuidRefund(p, nil), env()))
		wantOK(res[0])
		wantOK(res[1])
		if id := serverID(p); res[1]["orderId"] != id {
			t.Errorf("refund result must carry the resolved server id %s, got %v", id, res[1])
		}
		if got := status(p); got != "refunded" {
			t.Errorf("status=%s", got)
		}
		if got := stock(outW); got != "1000" {
			t.Errorf("stock must be restored exactly once, got %s", got)
		}
	})

	sub("2 replay of the same refund key returns the same id and changes nothing", func(t *testing.T) {
		p := sale(nil)
		wantOK(one(item("order", "s2", p, env())))
		first := one(item("refund", "r2", uuidRefund(p, nil), env()))
		wantOK(first)
		after := stock(outW)
		again := one(item("refund", "r2", uuidRefund(p, nil), env()))
		wantOK(again)
		if again["orderId"] != first["orderId"] {
			t.Errorf("replay id %v != %v", again["orderId"], first["orderId"])
		}
		if got := stock(outW); got != after {
			t.Errorf("replay changed stock %s -> %s", after, got)
		}
	})

	sub("3 a second refund after the uuid refund is refused, by id or by uuid", func(t *testing.T) {
		p := sale(nil)
		wantOK(one(item("order", "s3", p, env())))
		wantOK(one(item("refund", "r3a", uuidRefund(p, nil), env())))
		wantRefusal(one(item("refund", "r3b", map[string]any{"orderId": serverID(p), "reason": "lagi"}, env())), "conflict")
		wantRefusal(one(item("refund", "r3c", uuidRefund(p, nil), env())), "conflict")
		if got := stock(outW); got != "1000" {
			t.Errorf("stock restored twice? %s", got)
		}
	})

	sub("4 refund for a missing sale goes to review with no effect", func(t *testing.T) {
		before := stock(outW)
		wantRefusal(one(item("refund", "r4", uuidRefund(sale(nil), nil), env())), "conflict")
		if got := stock(outW); got != before {
			t.Errorf("stock changed %s -> %s", before, got)
		}
		if n := str(`SELECT count(*)::text FROM operation_receipts WHERE idempotency_key=$1`, device+":r4"); n != "0" {
			t.Errorf("a refused refund must not store a receipt, rows=%s", n)
		}
	})

	sub("5 another device or another outlet: review, sale untouched", func(t *testing.T) {
		p := sale(nil)
		wantOK(one(item("order", "s5", p, env())))
		wantRefusal(one(item("refund", "r5a", uuidRefund(p, map[string]any{"deviceId": "00000000-0000-4000-8e00-0000000000d2"}), env())), "conflict")
		tokNow = tokB
		res := one(item("refund", "r5b", uuidRefund(p, nil), envFor(outB, userB, time.Hour)))
		tokNow = tok
		wantRefusal(res, "conflict")
		if got := status(p); got != "completed" {
			t.Errorf("sale was changed: %s", got)
		}
	})

	sub("6 id and uuid naming different orders are rejected", func(t *testing.T) {
		a, b := sale(nil), sale(nil)
		wantOK(one(item("order", "s6a", a, env())))
		wantOK(one(item("order", "s6b", b, env())))
		wantRefusal(one(item("refund", "r6", uuidRefund(a, map[string]any{"orderId": serverID(b)}), env())), "rejected")
		for _, p := range []map[string]any{a, b} {
			if got := status(p); got != "completed" {
				t.Errorf("a mismatched refund changed %v: %s", p["orderUuid"], got)
			}
		}
	})

	sub("7 a sale refused as offline_expired leaves nothing for the uuid refund", func(t *testing.T) {
		p := sale(nil)
		wantRefusal(one(item("order", "s7", p, envFor(outW, userW, syncpkg.OfflineCap+time.Hour))), "offline_expired")
		wantRefusal(one(item("refund", "r7", uuidRefund(p, nil), env())), "conflict")
		if n := str(`SELECT count(*)::text FROM orders WHERE order_uuid=$1`, p["orderUuid"].(string)); n != "0" {
			t.Errorf("refused sale must not exist, rows=%s", n)
		}
	})
}
