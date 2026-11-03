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

// A05 12 h offline cap and clock-skew bound. Opt-in only, same isolation contract as the
// other gates. An item captured more than 12 h after the tablet's last online contact is
// refused as offline_expired (non-retryable, review) with no effect; a key that already
// landed replays first; shift close and customer_create are exempt.
func TestOfflineCapPostgres(t *testing.T) {
	dsn := os.Getenv("MANDALIKA_OC_TEST_DSN")
	if dsn == "" {
		t.Skip("isolated PostgreSQL fixture not configured")
	}
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ConnConfig.Host != "127.0.0.1" || cfg.ConnConfig.Port != 26463 || cfg.ConnConfig.Database != "mandalika_oc_synthetic" || cfg.ConnConfig.User != "oc_test" {
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
	expected := os.Getenv("MANDALIKA_OC_TEST_DATA_DIR")
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
		outW    = "00000000-0000-4000-8c00-000000000001"
		userW   = "00000000-0000-4000-8c00-000000000011"
		product = "00000000-0000-4000-8c00-000000000021"
		promo   = "00000000-0000-4000-8c00-000000000031"
		device  = "ocdev"
	)
	exec(`INSERT INTO outlets(id,name) VALUES($1,'OC Jakarta')`, outW)
	exec(`INSERT INTO users(id,email,password_hash,display_name,role,outlet_id) VALUES($1,'w@example.invalid','x','OC cashier','cashier',$2)`, userW, outW)
	exec(`INSERT INTO products(id,name) VALUES($1,'OC product')`, product)
	exec(`INSERT INTO product_variants(product_id,size,price,stock,sku) VALUES($1,'110ml',100000,1000,'OC')`, product)
	exec(`INSERT INTO outlet_variant_stock(outlet_id,product_id,variant_size,stock) VALUES($1,$2,'110ml',1000)`, outW, product)
	rd, wr, svc := read.New(pool), write.New(pool), service.NewOrderService(pool)
	eng := syncpkg.New(pool, rd, svc, wr)
	secret := []byte("OC-INTEGRATION-SYNTHETIC-KEY-0123456789")
	key := syncpkg.DeriveContactKey(secret)
	eng.ContactKey = key
	h := New(rd, nil, auth.NewStore(pool), wr, svc, eng, nil)
	tok, err := auth.IssueAccess(secret, time.Hour, userW, "cashier", outW, []string{"create_order", "process_refund"})
	if err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	authWrap := mw.RequireAuth(&config.Config{AccessSecret: secret})
	router.With(authWrap).Post("/sync/batch", h.SyncBatch)
	router.With(authWrap).Get("/sync/version", h.SyncVersion)
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
		r.Header.Set("Authorization", "Bearer "+tok)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		var out map[string]any
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		return w.Code, out
	}
	seq := 0
	payload := func(extra map[string]any) map[string]any {
		seq++
		p := map[string]any{
			"orderUuid": fmt.Sprintf("00000000-0000-4000-8c03-%012d", seq), "paymentMethod": "cash", "amountPaid": 100000,
			"items": []map[string]any{{"productId": product, "productName": "OC product", "variantSize": "110ml", "price": 100000, "quantity": 1, "subtotal": 100000}},
		}
		for k, v := range extra {
			p[k] = v
		}
		return p
	}
	// env builds a capture envelope; extra carries the A05 evidence fields.
	env := func(extra map[string]any) map[string]any {
		e := map[string]any{"v": 1, "outletId": outW, "userId": userW, "deviceId": device, "capturedAt": time.Now().UTC().Format(time.RFC3339Nano)}
		for k, v := range extra {
			e[k] = v
		}
		return e
	}
	offline := func(d time.Duration) map[string]any { return map[string]any{"offlineMs": d.Milliseconds()} }
	signed := func(ago time.Duration) map[string]any {
		c := syncpkg.SignContact(key, device, time.Now().Add(-ago))
		return map[string]any{"contact": map[string]any{"at": c.At, "sig": c.Sig}}
	}
	send := func(typ, name string, p, e map[string]any) map[string]any {
		cur.Helper()
		item := map[string]any{"type": typ, "idempotencyKey": device + ":" + name, "payload": p, "envelope": e}
		code, out := call("POST", "/sync/batch", map[string]any{"items": []any{item}})
		if code != 200 {
			cur.Fatalf("batch %d %v", code, out)
		}
		return out["data"].(map[string]any)["results"].([]any)[0].(map[string]any)
	}
	wantStatus := func(res map[string]any, status string) {
		cur.Helper()
		if res["status"] != status {
			cur.Fatalf("want status %s, got %v", status, res)
		}
	}
	wantExpired := func(res map[string]any) {
		cur.Helper()
		if res["status"] != "error" || res["code"] != "offline_expired" || res["retryable"] != false {
			cur.Fatalf("want non-retryable offline_expired, got %v", res)
		}
	}
	stock := func() string {
		return str(`SELECT stock::text FROM outlet_variant_stock WHERE outlet_id=$1 AND product_id=$2`, outW, product)
	}
	over := syncpkg.OfflineCap + time.Hour

	sub("1 an order over the cap is refused with no effect", func(t *testing.T) {
		before := stock()
		wantExpired(send("order", "over-1", payload(nil), env(offline(over))))
		if n := str(`SELECT count(*)::text FROM orders WHERE idempotency_key=$1`, device+":over-1"); n != "0" {
			t.Errorf("refused order must not exist, rows=%s", n)
		}
		if n := str(`SELECT count(*)::text FROM processed_keys WHERE idempotency_key=$1`, device+":over-1"); n != "0" {
			t.Errorf("refused order must not claim its key, rows=%s", n)
		}
		if got := stock(); got != before {
			t.Errorf("stock changed %s -> %s", before, got)
		}
	})

	sub("2 a signed contact within the cap passes even when the device clock lies", func(t *testing.T) {
		e := env(offline(30 * time.Hour))
		for k, v := range signed(11 * time.Hour) {
			e[k] = v
		}
		wantStatus(send("order", "signed-ok", payload(nil), e), "ok")
		// A contact signed for another device does not rescue an over-cap item.
		bad := env(offline(over))
		c := syncpkg.SignContact(key, "other-device", time.Now().Add(-time.Minute))
		bad["contact"] = map[string]any{"at": c.At, "sig": c.Sig}
		wantExpired(send("order", "forged", payload(nil), bad))
	})

	sub("3 refund and cash_flow over the cap are refused; the order stays completed", func(t *testing.T) {
		wantStatus(send("order", "to-refund", payload(nil), env(offline(time.Hour))), "ok")
		id := str(`SELECT id::text FROM orders WHERE idempotency_key=$1`, device+":to-refund")
		wantExpired(send("refund", "refund-over", map[string]any{"orderId": id, "reason": "late"}, env(offline(over))))
		if got := str(`SELECT status FROM orders WHERE id=$1`, id); got != "completed" {
			t.Errorf("refused refund changed the order: %s", got)
		}
		wantExpired(send("cash_flow", "flow-over", map[string]any{"type": "in", "amount": 10, "description": "late"}, env(offline(over))))
		if n := str(`SELECT count(*)::text FROM cash_flows WHERE outlet_id=$1`, outW); n != "0" {
			t.Errorf("refused cash flow was stored: %s", n)
		}
		// A refused item stores no receipt either: the same key must be free to run later.
		if n := str(`SELECT count(*)::text FROM operation_receipts WHERE idempotency_key IN ($1,$2)`, device+":refund-over", device+":flow-over"); n != "0" {
			t.Errorf("refused refund/cash_flow left an operation receipt: %s", n)
		}
	})

	sub("4 shift_close and customer_create are exempt", func(t *testing.T) {
		shift := "00000000-0000-4000-8c02-000000000001"
		exec(`INSERT INTO shifts(id,outlet_id,cashier_id,cashier_name,status,opened_at,starting_cash) VALUES($1,$2,$3,'OC','open',now()-interval '20 hours',0)`, shift, outW, userW)
		wantStatus(send("shift_close", "close-over", map[string]any{"shiftId": shift, "closingCash": 0}, env(offline(over))), "ok")
		cust := "00000000-0000-4000-8c04-000000000001"
		wantStatus(send("customer_create", "cust-over", map[string]any{"customerId": cust, "name": "OC customer", "phone": "0800000001"}, env(offline(over))), "ok")
		if n := str(`SELECT count(*)::text FROM customers WHERE id=$1`, cust); n != "1" {
			t.Errorf("exempt customer_create did not land: %s", n)
		}
	})

	sub("5 a key that already landed replays as duplicate, never goes to review", func(t *testing.T) {
		p := payload(nil)
		wantStatus(send("order", "replay", p, env(offline(time.Hour))), "ok")
		wantStatus(send("order", "replay", p, env(offline(over))), "duplicate")
		if n := str(`SELECT count(*)::text FROM orders WHERE idempotency_key=$1`, device+":replay"); n != "1" {
			t.Errorf("replay duplicated the order: %s", n)
		}
	})

	sub("6 clock skew evaluates the promo at a bounded time and only flags it", func(t *testing.T) {
		now := time.Now().UTC()
		c := now.Add(-6 * time.Hour).Truncate(time.Microsecond) // Postgres keeps microseconds: an exact-equality check needs the same precision
		wib := time.FixedZone("WIB", 7*3600)
		if c.In(wib).Hour() == 23 {
			c = c.Add(-time.Hour)
		}
		from := c.In(wib).Truncate(time.Hour)
		exec(`INSERT INTO promotions(id,name,type,value,active_from_hour,active_to_hour) VALUES($1,'OC hours','percentage',10,$2,$3)`,
			promo, from.Format("15:04"), from.Add(time.Hour).Format("15:04"))
		e := env(offline(10 * time.Minute))
		for k, v := range signed(time.Hour) {
			e[k] = v
		}
		p := payload(map[string]any{"promotionId": promo, "promotionIds": []string{promo}, "clientCreatedAt": c.Format(time.RFC3339Nano)})
		wantStatus(send("order", "skew", p, e), "ok")
		reason := str(`SELECT discount_warning_reason FROM orders WHERE idempotency_key=$1`, device+":skew")
		if !strings.Contains(reason, "clock_skew") || !strings.Contains(reason, "outside_hours") {
			t.Errorf("discount_warning_reason=%q want clock_skew and outside_hours", reason)
		}
		if got := str(`SELECT (client_created_at = $2::timestamptz)::text FROM orders WHERE idempotency_key=$1`, device+":skew", c.Format(time.RFC3339Nano)); got != "true" {
			t.Errorf("client_created_at must stay the recorded fact")
		}
		if got := str(`SELECT (discount_amount > 0)::text FROM orders WHERE idempotency_key=$1`, device+":skew"); got != "true" {
			t.Errorf("the discount must be kept, only flagged")
		}
	})

	sub("7 /sync/version signs a contact only for a valid device id", func(t *testing.T) {
		const dev = "11111111-2222-4333-8444-555555555555"
		code, out := call("GET", "/sync/version?deviceId="+dev, nil)
		if code != 200 {
			t.Fatalf("%d %v", code, out)
		}
		c, ok := out["data"].(map[string]any)["contact"].(map[string]any)
		if !ok {
			t.Fatalf("no contact in %v", out)
		}
		if _, ok := syncpkg.VerifyContact(key, dev, syncpkg.ContactToken{At: c["at"].(string), Sig: c["sig"].(string)}, time.Now()); !ok {
			t.Errorf("returned contact does not verify: %v", c)
		}
		for _, q := range []string{"", "?deviceId=not-a-uuid"} {
			_, out := call("GET", "/sync/version"+q, nil)
			if _, has := out["data"].(map[string]any)["contact"]; has {
				t.Errorf("query %q must not return a contact", q)
			}
		}
	})
}
