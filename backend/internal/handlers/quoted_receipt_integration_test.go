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

// A10 quoted receipt total. Opt-in only, same isolation contract as the other
// gates. The POS sends the total it showed/printed (quotedTotal) plus a small
// receiptSnapshot; the server keeps both unchanged, never rejects on a
// difference (both routes) and only flags it: quote_mismatch (> Rp1) or
// quote_invalid (unusable quote stored NULL). An absent quote is NULL, no flag.
func TestQuotedReceiptPostgres(t *testing.T) {
	dsn := os.Getenv("MANDALIKA_QT_TEST_DSN")
	if dsn == "" {
		t.Skip("isolated PostgreSQL fixture not configured")
	}
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ConnConfig.Host != "127.0.0.1" || cfg.ConnConfig.Port != 56461 || cfg.ConnConfig.Database != "mandalika_qt_synthetic" || cfg.ConnConfig.User != "qt_test" {
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
	expected := os.Getenv("MANDALIKA_QT_TEST_DATA_DIR")
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
	secret := []byte("QT-INTEGRATION-SYNTHETIC-KEY")
	token, err := auth.IssueAccess(secret, time.Hour, user, "cashier", outlet, []string{"create_order", "process_refund"})
	if err != nil {
		t.Fatal(err)
	}
	authWrap := mw.RequireAuth(&config.Config{AccessSecret: secret})
	direct := authWrap(mw.RequirePermission("create_order")(http.HandlerFunc(h.CreateOrder)))
	batch := authWrap(http.HandlerFunc(h.SyncBatch))
	router := chi.NewRouter()
	router.With(authWrap, mw.RequirePermission("process_refund")).Post("/orders/{id}/refund", h.RefundOrder)
	router.With(authWrap).Get("/orders/{id}", h.Order)
	if _, err = h.Sync.Version(ctx, outlet); err != nil {
		t.Fatal(err)
	}

	do := func(handler http.Handler, method, path, key string, body any) *httptest.ResponseRecorder {
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
	// payload is a one-line 100000 cash sale; extra carries the quote fields.
	payload := func(extra map[string]any) map[string]any {
		seq++
		p := map[string]any{
			"orderUuid": fmt.Sprintf("00000000-0000-4000-8003-%012d", seq), "paymentMethod": "cash", "amountPaid": 150000,
			"items": []map[string]any{{"productId": product, "productName": "Synthetic product", "variantSize": "110ml", "price": 100000, "quantity": 1, "subtotal": 100000}},
		}
		for k, v := range extra {
			p[k] = v
		}
		return p
	}
	snapshot := func(total float64) map[string]any {
		return map[string]any{"v": 1, "refVersion": "7", "subtotal": total, "total": total, "amountPaid": 150000,
			"lines": []map[string]any{{"productId": product, "variantSize": "110ml", "name": "Synthetic product", "qty": 1, "unitPrice": total, "amount": total}}}
	}
	// send returns the HTTP code and (batch only) the item status.
	send := func(route, key string, p map[string]any) (int, string) {
		cur.Helper()
		if route == "direct" {
			w := do(direct, "POST", "/orders", key, p)
			return w.Code, ""
		}
		w := do(batch, "POST", "/sync/batch", "", map[string]any{"items": []any{map[string]any{"type": "order", "idempotencyKey": key, "payload": p}}})
		var out struct {
			Data syncpkg.BatchResult `json:"data"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil || w.Code != 200 || len(out.Data.Results) != 1 {
			cur.Fatalf("batch %d %s", w.Code, w.Body.String())
		}
		return w.Code, out.Data.Results[0].Status
	}
	accepted := func(route string, code int, st string) bool {
		return (route == "direct" && code == 201) || (route == "batch" && st == "ok")
	}
	type row struct {
		total, paid float64
		quoted      *float64
		snap        *string
		warn        bool
		reason      *string
	}
	load := func(key string) row {
		cur.Helper()
		var r row
		if err := pool.QueryRow(ctx, `SELECT total,amount_paid,quoted_total,receipt_snapshot::text,quote_warning,quote_warning_reason
			FROM orders WHERE idempotency_key=$1`, key).Scan(&r.total, &r.paid, &r.quoted, &r.snap, &r.warn, &r.reason); err != nil {
			cur.Fatalf("load %s: %v", key, err)
		}
		return r
	}
	reasonOf := func(r row) string {
		if r.reason == nil {
			return ""
		}
		return *r.reason
	}
	want := func(name string, r row, total float64, quoted *float64, hasSnap bool, reason string) {
		cur.Helper()
		if r.total != total || (r.quoted == nil) != (quoted == nil) || (quoted != nil && *r.quoted != *quoted) ||
			(r.snap != nil) != hasSnap || r.warn != (reason != "") || reasonOf(r) != reason {
			q := "NULL"
			if r.quoted != nil {
				q = fmt.Sprint(*r.quoted)
			}
			cur.Fatalf("%s: total=%v quoted=%s snap=%v warn=%v reason=%q", name, r.total, q, r.snap != nil, r.warn, reasonOf(r))
		}
	}
	f := func(v float64) *float64 { return &v }
	orderCount := func() (n int) {
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM orders`).Scan(&n); err != nil {
			cur.Fatal(err)
		}
		return
	}
	// The server prices from the captured line price plus CURRENT settings, so a tax
	// change after the cashier quoted is the realistic drift: 100000 quoted, 110000 due.
	setTaxDrift := func(price int) {
		exec(`UPDATE app_settings SET tax_enabled=$1,tax_rate=10`, price > 100000)
	}

	for _, route := range []string{"batch", "direct"} {
		route := route
		sub(route+": legacy payload without a quote is NULL and unflagged", func(t *testing.T) {
			key := "legacy-" + route
			if code, st := send(route, key, payload(nil)); !accepted(route, code, st) {
				t.Fatalf("code=%d status=%s", code, st)
			}
			want("legacy", load(key), 100000, nil, false, "")
		})
		sub(route+": matching quote is stored, no flag", func(t *testing.T) {
			key := "match-" + route
			send(route, key, payload(map[string]any{"quotedTotal": 100000, "receiptSnapshot": snapshot(100000)}))
			r := load(key)
			want("match", r, 100000, f(100000), true, "")
			if !strings.Contains(*r.snap, `"refVersion"`) {
				t.Fatalf("snapshot not stored as sent: %s", *r.snap)
			}
		})
		sub(route+": one rupiah of drift is tolerated", func(t *testing.T) {
			key := "tol-" + route
			send(route, key, payload(map[string]any{"quotedTotal": 100001, "receiptSnapshot": snapshot(100001)}))
			want("tolerance", load(key), 100000, f(100001), true, "")
		})
		sub(route+": invalid quote is accepted, stored NULL and flagged", func(t *testing.T) {
			for i, bad := range []map[string]any{
				{"quotedTotal": -5, "receiptSnapshot": snapshot(100000)},
				{"quotedTotal": 1e13},
				{"quotedTotal": 100000, "receiptSnapshot": []int{1}},
			} {
				key := fmt.Sprintf("invalid-%s-%d", route, i)
				if code, st := send(route, key, payload(bad)); !accepted(route, code, st) {
					t.Fatalf("%d: code=%d status=%s", i, code, st)
				}
				want(fmt.Sprint("invalid", i), load(key), 100000, nil, false, "quote_invalid")
			}
		})
	}

	sub("tax drift: mismatch is flagged on both routes, never rejected", func(t *testing.T) {
		setTaxDrift(110000)
		defer setTaxDrift(100000)
		before := orderCount()
		for _, route := range []string{"batch", "direct"} {
			key := "drift-" + route
			code, st := send(route, key, payload(map[string]any{"quotedTotal": 100000, "receiptSnapshot": snapshot(100000)}))
			if !accepted(route, code, st) {
				t.Fatalf("%s must accept: code=%d status=%s", route, code, st)
			}
			r := load(key)
			want("drift "+route, r, 110000, f(100000), true, "quote_mismatch")
			if r.paid != 150000 {
				t.Fatalf("amount_paid must stay the captured tender, got %v", r.paid)
			}
		}
		if orderCount() != before+2 {
			t.Fatal("both mismatching sales must be stored")
		}
	})

	sub("same-key replay is not re-judged and adds no second flag", func(t *testing.T) {
		setTaxDrift(110000)
		key := "replay-batch"
		send("batch", key, payload(map[string]any{"quotedTotal": 100000, "receiptSnapshot": snapshot(100000)}))
		first := load(key)
		setTaxDrift(100000)
		n := orderCount()
		replay := payload(map[string]any{"quotedTotal": -1})
		if _, st := send("batch", key, replay); st != "duplicate" {
			t.Fatalf("replay status %q", st)
		}
		again := load(key)
		if orderCount() != n || again.reason == nil || *again.reason != "quote_mismatch" || *again.quoted != *first.quoted || *again.snap != *first.snap {
			t.Fatalf("replay changed the stored quote: %+v vs %+v", first, again)
		}
	})

	sub("receipt_snapshot is unchanged by a refund", func(t *testing.T) {
		key := "refund-keep"
		send("batch", key, payload(map[string]any{"quotedTotal": 100000, "receiptSnapshot": snapshot(100000)}))
		before := load(key)
		var id string
		if err := pool.QueryRow(ctx, `SELECT id FROM orders WHERE idempotency_key=$1`, key).Scan(&id); err != nil {
			t.Fatal(err)
		}
		w := do(router, "POST", "/orders/"+id+"/refund", "", map[string]string{"reason": "rusak"})
		if w.Code != 201 {
			t.Fatalf("refund %d %s", w.Code, w.Body.String())
		}
		after := load(key)
		if after.snap == nil || *after.snap != *before.snap || *after.quoted != *before.quoted || after.warn != before.warn {
			t.Fatalf("refund touched the quote: %+v vs %+v", before, after)
		}
	})

	sub("read API exposes quote fields but not the snapshot", func(t *testing.T) {
		key := "read-drift"
		setTaxDrift(110000)
		defer setTaxDrift(100000)
		send("batch", key, payload(map[string]any{"quotedTotal": 100000, "receiptSnapshot": snapshot(100000)}))
		var id string
		if err := pool.QueryRow(ctx, `SELECT id FROM orders WHERE idempotency_key=$1`, key).Scan(&id); err != nil {
			t.Fatal(err)
		}
		w := do(router, "GET", "/orders/"+id, "", nil)
		var out struct {
			Data map[string]any `json:"data"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil || w.Code != 200 {
			t.Fatalf("%d %s", w.Code, w.Body.String())
		}
		if out.Data["quotedTotal"] != float64(100000) || out.Data["quoteWarning"] != true || out.Data["quoteWarningReason"] != "quote_mismatch" {
			t.Fatalf("quote fields: %v", out.Data)
		}
		if _, leaked := out.Data["receiptSnapshot"]; leaked {
			t.Fatal("snapshot must stay out of the order JSON")
		}
	})
}
