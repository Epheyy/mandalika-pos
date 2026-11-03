package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
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

// A09 tender rules. Opt-in only, same isolation contract as the S0C gate: a
// freshly-created loopback cluster, verified data directory, empty database.
// Rules (owner answers 2026-10-11): direct POST /orders rejects only a cash
// shortfall (422); /sync/batch never rejects on tender, it accepts and flags.
// Tolerance is Rp1: |captured-due| <= 1 is neither a shortfall nor a mismatch.
func TestTenderRulesPostgres(t *testing.T) {
	dsn := os.Getenv("MANDALIKA_TD_TEST_DSN")
	if dsn == "" {
		t.Skip("isolated PostgreSQL fixture not configured")
	}
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ConnConfig.Host != "127.0.0.1" || cfg.ConnConfig.Port != 26447 || cfg.ConnConfig.Database != "mandalika_td_synthetic" || cfg.ConnConfig.User != "td_test" {
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
	expected := os.Getenv("MANDALIKA_TD_TEST_DATA_DIR")
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
	// Subtests share these helpers; failures must target the running subtest, not
	// the parent (a parent Fatal from a subtest goroutine would skip the rest).
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
	const outlet = "00000000-0000-4000-8000-000000000001"
	const user = "00000000-0000-4000-8000-000000000002"
	const product = "00000000-0000-4000-8000-000000000003"
	exec(`INSERT INTO outlets(id,name) VALUES($1,'Synthetic outlet')`, outlet)
	exec(`INSERT INTO users(id,email,password_hash,display_name,role,outlet_id) VALUES($1,'synthetic@example.invalid','not-a-login-hash','Synthetic cashier','cashier',$2)`, user, outlet)
	exec(`INSERT INTO products(id,name) VALUES($1,'Synthetic product')`, product)
	exec(`INSERT INTO product_variants(product_id,size,price,stock,sku) VALUES($1,'110ml',100000,1000,'SYNTHETIC')`, product)
	exec(`INSERT INTO outlet_variant_stock(outlet_id,product_id,variant_size,stock) VALUES($1,$2,'110ml',1000)`, outlet, product)
	rd, wr, osvc := read.New(pool), write.New(pool), service.NewOrderService(pool)
	h := New(rd, nil, auth.NewStore(pool), wr, osvc, syncpkg.New(pool, rd, osvc, wr), nil)
	secret := []byte("TD-INTEGRATION-SYNTHETIC-KEY")
	token, err := auth.IssueAccess(secret, time.Hour, user, "cashier", outlet, []string{"create_order"})
	if err != nil {
		t.Fatal(err)
	}
	authWrap := mw.RequireAuth(&config.Config{AccessSecret: secret})
	direct := authWrap(mw.RequirePermission("create_order")(http.HandlerFunc(h.CreateOrder)))
	batch := authWrap(http.HandlerFunc(h.SyncBatch))
	router := chi.NewRouter()
	router.With(authWrap).Get("/orders/{id}", h.Order)
	if _, err = h.Sync.Version(ctx, outlet); err != nil {
		t.Fatal(err)
	}

	request := func(handler http.Handler, method, path, key string, body any) *httptest.ResponseRecorder {
		cur.Helper()
		rdr := strings.NewReader("")
		if body != nil {
			raw, err := json.Marshal(body)
			if err != nil {
				cur.Fatal(err)
			}
			rdr = strings.NewReader(string(raw))
		}
		r := httptest.NewRequest(method, path, rdr)
		r.Header.Set("Authorization", "Bearer "+token)
		if key != "" {
			r.Header.Set("Idempotency-Key", key)
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	seq := 0
	// payload builds a 100000 sale (one line) with the given tender.
	payload := func(method string, paid any) map[string]any {
		seq++
		p := map[string]any{
			"orderUuid": fmt.Sprintf("00000000-0000-4000-8002-%012d", seq), "paymentMethod": method,
			"items": []map[string]any{{"productId": product, "productName": "Synthetic product", "variantSize": "110ml", "price": 100000, "quantity": 1, "subtotal": 100000}},
		}
		if paid != nil {
			p["amountPaid"] = paid
		}
		return p
	}
	type result struct {
		code   int
		status string // batch item status, "" for direct
	}
	send := func(route, key string, p map[string]any) result {
		cur.Helper()
		if route == "direct" {
			w := request(direct, "POST", "/orders", key, p)
			return result{code: w.Code}
		}
		w := request(batch, "POST", "/sync/batch", "", map[string]any{"items": []any{map[string]any{"type": "order", "idempotencyKey": key, "payload": p}}})
		var out struct {
			Data syncpkg.BatchResult `json:"data"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil || w.Code != 200 || len(out.Data.Results) != 1 {
			cur.Fatalf("batch %d %s", w.Code, w.Body.String())
		}
		return result{code: w.Code, status: out.Data.Results[0].Status}
	}
	type row struct {
		total, paid, change float64
		warn                bool
		reason              *string
	}
	load := func(key string) row {
		cur.Helper()
		var r row // via to_jsonb so the gate also runs (and fails behaviourally) before migration 0046
		if err := pool.QueryRow(ctx, `SELECT total,amount_paid,change,
			COALESCE((to_jsonb(o)->>'tender_warning')::boolean,false),to_jsonb(o)->>'tender_warning_reason'
			FROM orders o WHERE idempotency_key=$1`, key).Scan(&r.total, &r.paid, &r.change, &r.warn, &r.reason); err != nil {
			cur.Fatalf("load %s: %v", key, err)
		}
		return r
	}
	orderCount := func() (n int) {
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM orders`).Scan(&n); err != nil {
			cur.Fatal(err)
		}
		return
	}
	stock := func() (n int) {
		if err := pool.QueryRow(ctx, `SELECT stock FROM outlet_variant_stock WHERE outlet_id=$1 AND product_id=$2`, outlet, product).Scan(&n); err != nil {
			cur.Fatal(err)
		}
		return
	}
	reasonOf := func(r row) string {
		if r.reason == nil {
			return ""
		}
		return *r.reason
	}
	const short, mismatch = "cash_short", "noncash_amount_mismatch"
	// expectStored asserts the stored tender columns of an accepted order.
	expectStored := func(name string, r row, total, paid, change float64, reason string) {
		cur.Helper()
		if r.total != total || r.paid != paid || r.change != change || r.warn != (reason != "") || reasonOf(r) != reason {
			cur.Fatalf("%s: total=%v paid=%v change=%v warn=%v reason=%q; want total=%v paid=%v change=%v reason=%q",
				name, r.total, r.paid, r.change, r.warn, reasonOf(r), total, paid, change, reason)
		}
	}

	sub("1b 422 envelope, and same-key retry with sufficient cash then succeeds", func(t *testing.T) {
		p := payload("cash", 90000)
		w := request(direct, "POST", "/orders", "td-1b", p)
		var env struct {
			Error string         `json:"error"`
			Data  map[string]any `json:"data"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &env); err != nil || w.Code != 422 || env.Data != nil ||
			!strings.Contains(env.Error, "kurang dari total") || !strings.Contains(env.Error, "90000.00") || !strings.Contains(env.Error, "100000.00") {
			t.Fatalf("422 envelope: %d %s", w.Code, w.Body.String())
		}
		// The rejected attempt consumed nothing: the same key succeeds with enough cash.
		p["amountPaid"] = 100000
		if w := request(direct, "POST", "/orders", "td-1b", p); w.Code != 201 {
			t.Fatalf("retry after 422: %d %s", w.Code, w.Body.String())
		}
		expectStored("retry after 422", load("td-1b"), 100000, 100000, 0, "")
	})
	sub("1 direct cash shortfall is rejected 422 with zero writes", func(t *testing.T) {
		beforeOrders, beforeStock := orderCount(), stock()
		got := send("direct", "td-1", payload("cash", 90000))
		if got.code != 422 {
			t.Fatalf("status=%d", got.code)
		}
		if orderCount() != beforeOrders || stock() != beforeStock {
			t.Fatal("rejected tender changed orders or stock")
		}
		var keys int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM processed_keys WHERE idempotency_key='td-1'`).Scan(&keys); err != nil || keys != 0 {
			t.Fatalf("idempotency key recorded for rejected sale: %d %v", keys, err)
		}
	})
	sub("2 batch cash shortfall is accepted and flagged cash_short", func(t *testing.T) {
		before := stock()
		got := send("batch", "td-2", payload("cash", 90000))
		if got.status != "ok" {
			t.Fatalf("status=%q", got.status)
		}
		expectStored("batch cash short", load("td-2"), 100000, 90000, 0, short)
		if stock() != before-1 {
			t.Fatalf("stock=%d want %d", stock(), before-1)
		}
	})
	sub("3 batch qris amount mismatch is accepted, captured amount kept, flagged", func(t *testing.T) {
		if got := send("batch", "td-3", payload("qris", 95000)); got.status != "ok" {
			t.Fatalf("status=%q", got.status)
		}
		expectStored("batch qris 95000", load("td-3"), 100000, 95000, 0, mismatch)
	})
	sub("4 direct qris amount mismatch is accepted and flagged (online rejects cash_short only)", func(t *testing.T) {
		if got := send("direct", "td-4", payload("qris", 95000)); got.code != 201 {
			t.Fatalf("status=%d", got.code)
		}
		expectStored("direct qris 95000", load("td-4"), 100000, 95000, 0, mismatch)
	})
	for _, route := range []string{"direct", "batch"} {
		sub("5 cash overpay gives change, no flag/"+route, func(t *testing.T) {
			key := "td-5-" + route
			send(route, key, payload("cash", 150000))
			expectStored("cash 150000", load(key), 100000, 150000, 50000, "")
		})
		sub("6 qris exact has no flag/"+route, func(t *testing.T) {
			key := "td-6-" + route
			send(route, key, payload("qris", 100000))
			expectStored("qris 100000", load(key), 100000, 100000, 0, "")
		})
		sub("7 zero total passes cash 0 and qris 0/"+route, func(t *testing.T) {
			for _, method := range []string{"cash", "qris"} {
				p := payload(method, 0)
				line := p["items"].([]map[string]any)[0]
				line["price"], line["subtotal"], line["isReward"] = 0, 0, true
				key := "td-7-" + route + "-" + method
				send(route, key, p)
				expectStored(method+" zero total", load(key), 0, 0, 0, "")
			}
		})
		sub("11 Rp1 tolerance/"+route, func(t *testing.T) {
			// Exactly due-Rp1 (and Rp1 over) is fine; no change is owed on the short side.
			send(route, "td-11a-"+route, payload("cash", 99999))
			expectStored("cash 99999", load("td-11a-"+route), 100000, 99999, 0, "")
			send(route, "td-11b-"+route, payload("qris", 99999))
			expectStored("qris 99999", load("td-11b-"+route), 100000, 99999, 0, "")
			send(route, "td-11c-"+route, payload("qris", 100001))
			expectStored("qris 100001", load("td-11c-"+route), 100000, 100001, 0, "")
			// Just beyond tolerance: 99998.99 is a shortfall.
			key := "td-11d-" + route
			got := send(route, key, payload("cash", 99998.99))
			if route == "direct" {
				if got.code != 422 {
					t.Fatalf("direct 99998.99 status=%d", got.code)
				}
			} else {
				if got.status != "ok" {
					t.Fatalf("batch 99998.99 status=%q", got.status)
				}
				expectStored("batch cash 99998.99", load(key), 100000, 99998.99, 0, short)
			}
			// Non-cash beyond tolerance is flagged either way.
			send(route, "td-11e-"+route, payload("qris", 99998))
			expectStored("qris 99998", load("td-11e-"+route), 100000, 99998, 0, mismatch)
		})
	}
	sub("3b batch custom method with missing amountPaid stores 0 and flags", func(t *testing.T) {
		send("batch", "td-3b", payload("bca", nil))
		expectStored("bca missing", load("td-3b"), 100000, 0, 0, mismatch)
	})
	sub("3c batch custom method over-pay keeps the amount and flags", func(t *testing.T) {
		send("batch", "td-3c", payload("bca", 120000))
		expectStored("bca 120000", load("td-3c"), 100000, 120000, 0, mismatch)
	})
	sub("12 points redemption: tender is judged against finalTotal within Rp1", func(t *testing.T) {
		const cust = "00000000-0000-4000-8000-000000000009"
		exec(`INSERT INTO customers(id,name,phone,points) VALUES($1,'Synthetic customer','td-not-a-number',1000)`, cust)
		// 10 points x 1000.5 = 10005 off: finalTotal 89995 (not a whole thousand).
		exec(`UPDATE loyalty_settings SET enabled=true,points_per_thousand=1,redemption_rate=1000.5`)
		defer exec(`UPDATE loyalty_settings SET enabled=false`)
		redeem := func(method string, paid float64) map[string]any {
			p := payload(method, paid)
			p["customerId"], p["pointsRedeemed"] = cust, 10
			return p
		}
		for _, route := range []string{"direct", "batch"} {
			send(route, "td-12a-"+route, redeem("cash", 89995))
			expectStored("cash == finalTotal", load("td-12a-"+route), 89995, 89995, 0, "")
			send(route, "td-12b-"+route, redeem("cash", 89994))
			expectStored("cash finalTotal-Rp1", load("td-12b-"+route), 89995, 89994, 0, "")
			send(route, "td-12c-"+route, redeem("qris", 100000))
			expectStored("qris at pre-redemption total", load("td-12c-"+route), 89995, 100000, 0, mismatch)
		}
		got := send("direct", "td-12d", redeem("cash", 89993))
		if got.code != 422 {
			t.Fatalf("direct finalTotal-Rp2 status=%d", got.code)
		}
		send("batch", "td-12e", redeem("cash", 89993))
		expectStored("batch finalTotal-Rp2", load("td-12e"), 89995, 89993, 0, short)
	})
	sub("13 rounding: tender is judged against the rounded total", func(t *testing.T) {
		exec(`UPDATE app_settings SET rounding_enabled=true,rounding_type='nearest_1000'`)
		defer exec(`UPDATE app_settings SET rounding_enabled=false,rounding_type='none'`)
		priced := func(method string, paid float64) map[string]any {
			p := payload(method, paid)
			line := p["items"].([]map[string]any)[0]
			line["price"], line["subtotal"] = 100500, 100500
			return p
		}
		for _, route := range []string{"direct", "batch"} {
			send(route, "td-13a-"+route, priced("cash", 101000))
			expectStored("cash at rounded total", load("td-13a-"+route), 101000, 101000, 0, "")
			send(route, "td-13b-"+route, priced("qris", 100500))
			expectStored("qris at unrounded", load("td-13b-"+route), 101000, 100500, 0, mismatch)
		}
		if got := send("direct", "td-13c", priced("cash", 100500)); got.code != 422 {
			t.Fatalf("direct cash at unrounded status=%d", got.code)
		}
	})
	sub("9 batch replay of a flagged order is a duplicate, one row, flag unchanged", func(t *testing.T) {
		before := orderCount()
		got := send("batch", "td-2", payload("cash", 90000))
		if got.status != "duplicate" || orderCount() != before {
			t.Fatalf("status=%q orders %d->%d", got.status, before, orderCount())
		}
		expectStored("replay", load("td-2"), 100000, 90000, 0, short)
	})
	sub("10 read path exposes tenderWarning and reason", func(t *testing.T) {
		var id string
		if err := pool.QueryRow(ctx, `SELECT id FROM orders WHERE idempotency_key='td-2'`).Scan(&id); err != nil {
			t.Fatal(err)
		}
		w := request(router, "GET", "/orders/"+id, "", nil)
		var out struct {
			Data map[string]any `json:"data"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil || w.Code != 200 {
			t.Fatalf("%d %s", w.Code, w.Body.String())
		}
		if out.Data["tenderWarning"] != true || out.Data["tenderWarningReason"] != short {
			t.Fatalf("read JSON: %v", out.Data)
		}
		var clean string
		if err := pool.QueryRow(ctx, `SELECT id FROM orders WHERE idempotency_key='td-6-direct'`).Scan(&clean); err != nil {
			t.Fatal(err)
		}
		w = request(router, "GET", "/orders/"+clean, "", nil)
		out.Data = nil
		if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil || out.Data["tenderWarning"] != false || out.Data["tenderWarningReason"] != nil {
			t.Fatalf("clean read JSON: %v", out.Data)
		}
	})
	// ---- Slice 8c: payment-method cash identity (live cash method id is "tunai").
	setMethods := func(js string) func() {
		exec(`UPDATE app_settings SET payment_methods=$1::jsonb`, js)
		return func() { exec(`UPDATE app_settings SET payment_methods='[]'::jsonb`) }
	}
	const tunaiConfig = `[{"id":"tunai","label":"Tunai","isEnabled":true},{"id":"qris","label":"QRIS","isEnabled":true}]`
	sub("14 tunai (no flag in config) is cash: short 422 direct / flagged batch, overpay gives change", func(t *testing.T) {
		defer setMethods(tunaiConfig)()
		if got := send("direct", "td-14a", payload("tunai", 90000)); got.code != 422 {
			t.Fatalf("direct tunai 90000 status=%d", got.code)
		}
		send("batch", "td-14b", payload("tunai", 90000))
		expectStored("batch tunai 90000", load("td-14b"), 100000, 90000, 0, short)
		for _, route := range []string{"direct", "batch"} {
			send(route, "td-14c-"+route, payload("tunai", 150000))
			expectStored("tunai 150000", load("td-14c-"+route), 100000, 150000, 50000, "")
			send(route, "td-14d-"+route, payload("TUNAI", 150000))
			expectStored("TUNAI 150000", load("td-14d-"+route), 100000, 150000, 50000, "")
		}
	})
	sub("15 old-APK shape: tunai with amountPaid == total has change 0 and no flag", func(t *testing.T) {
		defer setMethods(tunaiConfig)()
		for _, route := range []string{"direct", "batch"} {
			send(route, "td-15-"+route, payload("tunai", 100000))
			expectStored("tunai paid=total", load("td-15-"+route), 100000, 100000, 0, "")
		}
	})
	sub("16 explicit isCash flag wins over the id default; absent cash id still cash", func(t *testing.T) {
		defer setMethods(`[{"id":"kas_kecil","label":"Kas Kecil","isEnabled":true,"isCash":true},{"id":"tunai","label":"Tunai","isEnabled":true,"isCash":false}]`)()
		if got := send("direct", "td-16a", payload("kas_kecil", 90000)); got.code != 422 {
			t.Fatalf("direct kas_kecil 90000 status=%d", got.code)
		}
		send("batch", "td-16b", payload("tunai", 95000))
		expectStored("tunai isCash=false 95000", load("td-16b"), 100000, 95000, 0, mismatch)
		if got := send("direct", "td-16c", payload("cash", 90000)); got.code != 422 {
			t.Fatalf("direct cash (absent from config) status=%d", got.code)
		}
	})
	sub("17 shift close sums cash_sales over every cash-identified method, completed only", func(t *testing.T) {
		defer setMethods(`[{"id":"kas_kecil","label":"Kas Kecil","isEnabled":true,"isCash":true}]`)()
		const shift = "00000000-0000-4000-8300-0000000000a1"
		exec(`INSERT INTO shifts(id,outlet_id,cashier_id,cashier_name,status,opened_at) VALUES($1,$2,$3,'TD','open',now())`, shift, outlet, user)
		for i, o := range []struct {
			method, status string
			total          float64
		}{{"cash", "completed", 1000}, {"tunai", "completed", 2000}, {"kas_kecil", "completed", 4000}, {"qris", "completed", 8000}, {"bca", "completed", 16000}, {"tunai", "refunded", 32000}} {
			exec(`INSERT INTO orders(order_number,order_uuid,idempotency_key,outlet_id,cashier_id,cashier_name,subtotal,total,payment_method,status,shift_id)
			      VALUES($1,gen_random_uuid(),$1,$2,$3,'TD',$4,$4,$5,$6,$7)`, fmt.Sprintf("TD17-%d", i), outlet, user, o.total, o.method, o.status, shift)
		}
		if err := osvc.CloseShift(ctx, outlet, shift, 0, nil); err != nil {
			t.Fatal(err)
		}
		var cash, qris, totalSales float64
		if err := pool.QueryRow(ctx, `SELECT cash_sales,qris_sales,total_sales FROM shifts WHERE id=$1`, shift).Scan(&cash, &qris, &totalSales); err != nil {
			t.Fatal(err)
		}
		if cash != 7000 || qris != 8000 || totalSales != 31000 {
			t.Fatalf("cash_sales=%v qris_sales=%v total_sales=%v; want 7000/8000/31000", cash, qris, totalSales)
		}
	})
	sub("18 isCash round-trips write -> AppSettings read -> sync pull; invalid methods rejected", func(t *testing.T) {
		defer setMethods("[]")()
		raw := func(methods string) json.RawMessage {
			return json.RawMessage(`{"taxEnabled":false,"taxRate":0,"roundingEnabled":false,"roundingType":"none","autoOpenShift":false,"allowNegativeStock":true,"paymentMethods":` + methods + `,"receipt":{}}`)
		}
		if err := wr.UpdateAppSettings(ctx, raw(`[{"id":"kas_kecil","label":"Kas Kecil","isEnabled":true,"isCash":true},{"id":"qris","label":"QRIS","isEnabled":true,"isCash":false}]`)); err != nil {
			t.Fatal(err)
		}
		// Compare through JSON so the assertion is about the wire, not a Go field.
		flags := func(v any) map[string]any {
			b, err := json.Marshal(v)
			if err != nil {
				t.Fatal(err)
			}
			var m struct {
				PaymentMethods []map[string]any `json:"paymentMethods"`
			}
			if err := json.Unmarshal(b, &m); err != nil {
				t.Fatal(err)
			}
			out := map[string]any{}
			for _, pm := range m.PaymentMethods {
				out[fmt.Sprint(pm["id"])] = pm["isCash"]
			}
			return out
		}
		check := func(where string, got map[string]any) {
			if got["kas_kecil"] != true || got["qris"] != false {
				t.Fatalf("%s: isCash flags=%v", where, got)
			}
		}
		settings, err := rd.AppSettings(ctx)
		if err != nil {
			t.Fatal(err)
		}
		check("AppSettings read", flags(settings))
		bundle, err := h.Sync.Pull(ctx, read.Scope{OutletID: outlet}, outlet)
		if err != nil {
			t.Fatal(err)
		}
		b, _ := json.Marshal(bundle)
		var pulled struct {
			AppSettings any `json:"appSettings"`
		}
		if err := json.Unmarshal(b, &pulled); err != nil {
			t.Fatal(err)
		}
		check("sync pull bundle", flags(pulled.AppSettings))
		for name, methods := range map[string]string{
			"non-bool isCash":       `[{"id":"tunai","label":"Tunai","isEnabled":true,"isCash":"yes"}]`,
			"duplicate id":          `[{"id":"tunai","label":"A","isEnabled":true},{"id":"TUNAI","label":"B","isEnabled":true}]`,
			"empty id":              `[{"id":" ","label":"A","isEnabled":true}]`,
			"paymentMethods not []": `{"id":"tunai"}`,
		} {
			if err := wr.UpdateAppSettings(ctx, raw(methods)); err == nil {
				t.Fatalf("%s accepted", name)
			}
		}
		// Rejected writes leave the stored config untouched.
		settings, err = rd.AppSettings(ctx)
		if err != nil {
			t.Fatal(err)
		}
		check("after rejected writes", flags(settings))
	})
	sub("17b shift close: explicit isCash=false excludes tunai (incl. TUNAI); isCash=true on qris moves it out of the qris bucket", func(t *testing.T) {
		defer setMethods(`[{"id":"tunai","label":"Tunai","isEnabled":true,"isCash":false},{"id":"qris","label":"QRIS","isEnabled":true,"isCash":true}]`)()
		const shift = "00000000-0000-4000-8300-0000000000a2"
		exec(`INSERT INTO shifts(id,outlet_id,cashier_id,cashier_name,status,opened_at) VALUES($1,$2,$3,'TD','open',now())`, shift, outlet, user)
		for i, o := range []struct {
			method string
			total  float64
		}{{"tunai", 1000}, {"TUNAI", 2000}, {"qris", 4000}, {"cash", 8000}, {"card", 16000}} {
			exec(`INSERT INTO orders(order_number,order_uuid,idempotency_key,outlet_id,cashier_id,cashier_name,subtotal,total,payment_method,status,shift_id)
			      VALUES($1,gen_random_uuid(),$1,$2,$3,'TD',$4,$4,$5,'completed',$6)`, fmt.Sprintf("TD17B-%d", i), outlet, user, o.total, o.method, shift)
		}
		if err := osvc.CloseShift(ctx, outlet, shift, 0, nil); err != nil {
			t.Fatal(err)
		}
		var cash, qris, card, totalSales float64
		if err := pool.QueryRow(ctx, `SELECT cash_sales,qris_sales,card_sales,total_sales FROM shifts WHERE id=$1`, shift).Scan(&cash, &qris, &card, &totalSales); err != nil {
			t.Fatal(err)
		}
		if cash != 12000 || qris != 0 || card != 16000 || totalSales != 31000 {
			t.Fatalf("cash=%v qris=%v card=%v total=%v; want 12000/0/16000/31000", cash, qris, card, totalSales)
		}
	})
	sub("19 legacy settings row (live shape plus an unknown key) reads and pulls", func(t *testing.T) {
		defer setMethods(`[{"id":"tunai","label":"Tunai","isEnabled":true,"legacyField":"x"},{"id":"qris","label":"QRIS","isEnabled":true}]`)()
		settings, err := rd.AppSettings(ctx)
		if err != nil || len(settings.PaymentMethods) != 2 {
			t.Fatalf("AppSettings: %v %+v", err, settings.PaymentMethods)
		}
		bundle, err := h.Sync.Pull(ctx, read.Scope{OutletID: outlet}, outlet)
		if err != nil {
			t.Fatal(err)
		}
		b, _ := json.Marshal(bundle)
		if strings.Contains(string(b), "isCash") {
			t.Fatal("legacy row without isCash must not invent the flag")
		}
		// And the default rule still makes it cash for tender.
		if got := send("direct", "td-19", payload("tunai", 90000)); got.code != 422 {
			t.Fatalf("legacy tunai short status=%d", got.code)
		}
	})
	sub("20 HTTP 400 for a bad config; null paymentMethods stores []; isCash null round-trips", func(t *testing.T) {
		defer setMethods("[]")()
		put := authWrap(http.HandlerFunc(h.UpdateAppSettings))
		body := func(methods string) map[string]any {
			var m map[string]any
			_ = json.Unmarshal([]byte(`{"taxEnabled":false,"taxRate":0,"roundingEnabled":false,"roundingType":"none","autoOpenShift":false,"allowNegativeStock":true,"receipt":{},"paymentMethods":`+methods+`}`), &m)
			return m
		}
		for name, methods := range map[string]string{
			"duplicate": `[{"id":"a","label":"A","isEnabled":true},{"id":"A","label":"B","isEnabled":true}]`,
			"non-bool":  `[{"id":"a","label":"A","isEnabled":true,"isCash":"yes"}]`,
			"empty id":  `[{"id":"","label":"A","isEnabled":true}]`,
		} {
			if w := request(put, "PUT", "/settings/app", "", body(methods)); w.Code != 400 {
				t.Fatalf("%s: status=%d %s", name, w.Code, w.Body.String())
			}
		}
		if w := request(put, "PUT", "/settings/app", "", body("null")); w.Code != 200 {
			t.Fatalf("null paymentMethods: %d %s", w.Code, w.Body.String())
		}
		var stored string
		if err := pool.QueryRow(ctx, `SELECT payment_methods::text FROM app_settings`).Scan(&stored); err != nil || stored != "[]" {
			t.Fatalf("stored=%q err=%v", stored, err)
		}
		if w := request(put, "PUT", "/settings/app", "", body(`[{"id":"tunai","label":"T","isEnabled":true,"isCash":null}]`)); w.Code != 200 {
			t.Fatalf("isCash null write: %d %s", w.Code, w.Body.String())
		}
		settings, err := rd.AppSettings(ctx)
		if err != nil {
			t.Fatal(err)
		}
		b, _ := json.Marshal(settings)
		var m struct {
			PaymentMethods []map[string]any `json:"paymentMethods"`
		}
		if err := json.Unmarshal(b, &m); err != nil || len(m.PaymentMethods) != 1 {
			t.Fatalf("read: %v %s", err, b)
		}
		if v, ok := m.PaymentMethods[0]["isCash"]; !ok || v != nil {
			t.Fatalf("isCash null must round-trip as null, got %v (present=%v)", v, ok)
		}
		// Null means "default by id": tunai is still cash.
		if got := send("direct", "td-20", payload("tunai", 90000)); got.code != 422 {
			t.Fatalf("null-flag tunai short status=%d", got.code)
		}
	})
	// Last: mutates app settings.
	sub("8 batch: tax raised after capture flags cash_short, captured amount kept", func(t *testing.T) {
		exec(`UPDATE app_settings SET tax_enabled=true,tax_rate=10`)
		send("batch", "td-8", payload("cash", 100000))
		expectStored("tax", load("td-8"), 110000, 100000, 0, short)
	})
}
