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
	if cfg.ConnConfig.Host != "127.0.0.1" || cfg.ConnConfig.Port != 56447 || cfg.ConnConfig.Database != "mandalika_td_synthetic" || cfg.ConnConfig.User != "td_test" {
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
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
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
		t.Helper()
		rdr := strings.NewReader("")
		if body != nil {
			raw, err := json.Marshal(body)
			if err != nil {
				t.Fatal(err)
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
		t.Helper()
		if route == "direct" {
			w := request(direct, "POST", "/orders", key, p)
			return result{code: w.Code}
		}
		w := request(batch, "POST", "/sync/batch", "", map[string]any{"items": []any{map[string]any{"type": "order", "idempotencyKey": key, "payload": p}}})
		var out struct {
			Data syncpkg.BatchResult `json:"data"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil || w.Code != 200 || len(out.Data.Results) != 1 {
			t.Fatalf("batch %d %s", w.Code, w.Body.String())
		}
		return result{code: w.Code, status: out.Data.Results[0].Status}
	}
	type row struct {
		total, paid, change float64
		warn                bool
		reason              *string
	}
	load := func(key string) row {
		t.Helper()
		var r row // via to_jsonb so the gate also runs (and fails behaviourally) before migration 0046
		if err := pool.QueryRow(ctx, `SELECT total,amount_paid,change,
			COALESCE((to_jsonb(o)->>'tender_warning')::boolean,false),to_jsonb(o)->>'tender_warning_reason'
			FROM orders o WHERE idempotency_key=$1`, key).Scan(&r.total, &r.paid, &r.change, &r.warn, &r.reason); err != nil {
			t.Fatalf("load %s: %v", key, err)
		}
		return r
	}
	orderCount := func() (n int) {
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM orders`).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return
	}
	stock := func() (n int) {
		if err := pool.QueryRow(ctx, `SELECT stock FROM outlet_variant_stock WHERE outlet_id=$1 AND product_id=$2`, outlet, product).Scan(&n); err != nil {
			t.Fatal(err)
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
		t.Helper()
		if r.total != total || r.paid != paid || r.change != change || r.warn != (reason != "") || reasonOf(r) != reason {
			t.Fatalf("%s: total=%v paid=%v change=%v warn=%v reason=%q; want total=%v paid=%v change=%v reason=%q",
				name, r.total, r.paid, r.change, r.warn, reasonOf(r), total, paid, change, reason)
		}
	}

	t.Run("1 direct cash shortfall is rejected 422 with zero writes", func(t *testing.T) {
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
	t.Run("2 batch cash shortfall is accepted and flagged cash_short", func(t *testing.T) {
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
	t.Run("3 batch qris amount mismatch is accepted, captured amount kept, flagged", func(t *testing.T) {
		if got := send("batch", "td-3", payload("qris", 95000)); got.status != "ok" {
			t.Fatalf("status=%q", got.status)
		}
		expectStored("batch qris 95000", load("td-3"), 100000, 95000, 0, mismatch)
	})
	t.Run("4 direct qris amount mismatch is accepted and flagged (online rejects cash_short only)", func(t *testing.T) {
		if got := send("direct", "td-4", payload("qris", 95000)); got.code != 201 {
			t.Fatalf("status=%d", got.code)
		}
		expectStored("direct qris 95000", load("td-4"), 100000, 95000, 0, mismatch)
	})
	for _, route := range []string{"direct", "batch"} {
		t.Run("5 cash overpay gives change, no flag/"+route, func(t *testing.T) {
			key := "td-5-" + route
			send(route, key, payload("cash", 150000))
			expectStored("cash 150000", load(key), 100000, 150000, 50000, "")
		})
		t.Run("6 qris exact has no flag/"+route, func(t *testing.T) {
			key := "td-6-" + route
			send(route, key, payload("qris", 100000))
			expectStored("qris 100000", load(key), 100000, 100000, 0, "")
		})
		t.Run("7 zero total passes cash 0 and qris 0/"+route, func(t *testing.T) {
			for _, method := range []string{"cash", "qris"} {
				p := payload(method, 0)
				line := p["items"].([]map[string]any)[0]
				line["price"], line["subtotal"], line["isReward"] = 0, 0, true
				key := "td-7-" + route + "-" + method
				send(route, key, p)
				expectStored(method+" zero total", load(key), 0, 0, 0, "")
			}
		})
		t.Run("11 Rp1 tolerance/"+route, func(t *testing.T) {
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
	t.Run("3b batch custom method with missing amountPaid stores 0 and flags", func(t *testing.T) {
		send("batch", "td-3b", payload("bca", nil))
		expectStored("bca missing", load("td-3b"), 100000, 0, 0, mismatch)
	})
	t.Run("9 batch replay of a flagged order is a duplicate, one row, flag unchanged", func(t *testing.T) {
		before := orderCount()
		got := send("batch", "td-2", payload("cash", 90000))
		if got.status != "duplicate" || orderCount() != before {
			t.Fatalf("status=%q orders %d->%d", got.status, before, orderCount())
		}
		expectStored("replay", load("td-2"), 100000, 90000, 0, short)
	})
	t.Run("10 read path exposes tenderWarning and reason", func(t *testing.T) {
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
	// Last: mutates app settings.
	t.Run("8 batch: tax raised after capture flags cash_short, captured amount kept", func(t *testing.T) {
		exec(`UPDATE app_settings SET tax_enabled=true,tax_rate=10`)
		send("batch", "td-8", payload("cash", 100000))
		expectStored("tax", load("td-8"), 110000, 100000, 0, short)
	})
}
