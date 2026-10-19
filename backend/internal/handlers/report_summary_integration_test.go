package handlers

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/config"
	"github.com/mandalika/pos-backend/internal/db"
	mw "github.com/mandalika/pos-backend/internal/middleware"
	"github.com/mandalika/pos-backend/internal/read"
)

// Opt-in fresh synthetic cluster only: exact target, directory and empty schema.
// No application secret loading, live fallback or historical fixture cleanup.
func TestReportSummaryPostgres(t *testing.T) {
	dsn := os.Getenv("MANDALIKA_A27_TEST_DSN")
	if dsn == "" {
		t.Skip("isolated A27 pagination PostgreSQL fixture not configured")
	}
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ConnConfig.Host != "127.0.0.1" || cfg.ConnConfig.Port != 56444 || cfg.ConnConfig.Database != "mandalika_a27_synthetic" || cfg.ConnConfig.User != "a27_test" {
		t.Fatal("refusing non-fixture target")
	}
	// Pin only the synthetic session for reproducible daily buckets; production timezone is unchanged.
	cfg.ConnConfig.RuntimeParams["timezone"] = "UTC"
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	var dir string
	if err = pool.QueryRow(ctx, "SHOW data_directory").Scan(&dir); err != nil {
		t.Fatal(err)
	}
	expected := os.Getenv("MANDALIKA_A27_TEST_DATA_DIR")
	if expected == "" || filepath.Clean(dir) != filepath.Clean(expected) {
		t.Fatal("fixture directory mismatch")
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
	const outletA = "00000000-0000-4000-8700-000000000001"
	const outletB = "00000000-0000-4000-8700-000000000002"
	const cashier = "00000000-0000-4000-8700-000000000003"
	const product = "00000000-0000-4000-8700-000000000004"
	exec(`INSERT INTO outlets(id,name) VALUES($1,'A27 synthetic A'),($2,'A27 synthetic B')`, outletA, outletB)
	h := New(read.New(pool), nil, nil, nil, nil, nil, nil)
	secret := []byte("A27-SYNTHETIC-TEST-KEY")
	handler := mw.RequireAuth(&config.Config{AccessSecret: secret})(mw.RequirePermission("view_reports")(http.HandlerFunc(h.ReportSummary)))
	type sale struct {
		status                            string
		amount                            int
		method, outlet, created, refunded string
	}
	completed := sale{"completed", 100, "cash", outletA, "2026-01-02T12:00:00Z", ""}
	refunded := sale{"refunded", 30, "cash", outletA, "2026-01-02T13:00:00Z", "2026-01-10T12:00:00Z"}
	cancelled := sale{"cancelled", 900, "cash", outletA, "2026-01-02T14:00:00Z", ""}
	card := sale{"completed", 60, "card", outletA, "2026-01-02T15:00:00Z", ""}
	other := sale{"completed", 200, "qris", outletB, "2026-01-02T16:00:00Z", ""}
	type scenario struct {
		name                          string
		rows                          []sale
		role, outlet, query, from, to string
		sales, refunds, orders        int
		payments                      map[string]float64
	}
	cases := []scenario{
		{name: "empty", payments: map[string]float64{}},
		{name: "completed-only", rows: []sale{completed}, sales: 100, orders: 1, payments: map[string]float64{"cash": 100}},
		{name: "refunded-only", rows: []sale{refunded}, refunds: 30, payments: map[string]float64{}},
		{name: "completed100-refunded30", rows: []sale{completed, refunded}, sales: 100, refunds: 30, orders: 1, payments: map[string]float64{"cash": 100}},
		{name: "cancelled-only", rows: []sale{cancelled}, payments: map[string]float64{}},
		{name: "payments-products-daily", rows: []sale{completed, card, refunded, cancelled}, sales: 160, refunds: 30, orders: 2, payments: map[string]float64{"cash": 100, "card": 60}},
		{name: "outlet-A", rows: []sale{completed, refunded, other}, sales: 100, refunds: 30, orders: 1, payments: map[string]float64{"cash": 100}},
		{name: "cashier-cannot-cross-all", rows: []sale{completed, other}, query: "&outletId=all", sales: 100, orders: 1, payments: map[string]float64{"cash": 100}},
		{name: "admin-outlet-B", rows: []sale{completed, other}, role: "admin", query: "&outletId=" + outletB, sales: 200, orders: 1, payments: map[string]float64{"qris": 200}},
		{name: "admin-cross-all", rows: []sale{completed, refunded, other}, role: "admin", query: "&outletId=all", sales: 300, refunds: 30, orders: 2, payments: map[string]float64{"cash": 100, "qris": 200}},
		{name: "admin-default-bound-outlet", rows: []sale{completed, other}, role: "admin", sales: 100, orders: 1, payments: map[string]float64{"cash": 100}},
		{name: "admin-unbound-cross-all", rows: []sale{completed, other}, role: "admin", outlet: "none", sales: 300, orders: 2, payments: map[string]float64{"cash": 100, "qris": 200}},
		{name: "created-at-half-open-boundaries", rows: []sale{{"completed", 10, "cash", outletA, "2026-01-02T00:00:00Z", ""}, {"completed", 20, "cash", outletA, "2026-01-02T23:59:59.999999Z", ""}, {"completed", 40, "cash", outletA, "2026-01-03T00:00:00Z", ""}, {"completed", 80, "cash", outletA, "2026-01-01T23:59:59.999999Z", ""}}, sales: 30, orders: 2, payments: map[string]float64{"cash": 30}},
		{name: "late-refund-purchase-period", rows: []sale{refunded}, refunds: 30, payments: map[string]float64{}},
		{name: "late-refund-settlement-period-not-posted", rows: []sale{refunded}, from: "2026-01-10T00:00:00Z", to: "2026-01-11T00:00:00Z", payments: map[string]float64{}},
	}
	snapshot := func(t *testing.T) string {
		t.Helper()
		var s string
		if err := pool.QueryRow(ctx, `SELECT jsonb_build_object('orders',(SELECT coalesce(jsonb_agg(to_jsonb(o) ORDER BY id),'[]'::jsonb) FROM orders o),'items',(SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY id),'[]'::jsonb) FROM order_items i))::text`).Scan(&s); err != nil {
			t.Fatal(err)
		}
		return s
	}
	evidence := []map[string]any{}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			// Fixture reset only, before the read/no-mutation boundary. No business command runs.
			exec(`DELETE FROM order_items`)
			exec(`DELETE FROM orders`)
			for i, o := range c.rows {
				id := fmt.Sprintf("00000000-0000-4000-8701-%012d", i+1)
				exec(`INSERT INTO orders(id,order_uuid,order_number,idempotency_key,outlet_id,cashier_id,cashier_name,subtotal,total,payment_method,status,created_at,refunded_at) VALUES($1,$1,$2,$2,$3,$4,'A27',$5,$5,$6,$7,$8,NULLIF($9,'')::timestamptz)`, id, fmt.Sprintf("A27-%d", i), o.outlet, cashier, o.amount, o.method, o.status, o.created, o.refunded)
				exec(`INSERT INTO order_items(order_id,product_id,product_name,variant_size,price,quantity,subtotal) VALUES($1,$2,'A27 product','M',$3,1,$3)`, id, product, o.amount)
			}
			before := snapshot(t)
			role, outlet := c.role, c.outlet
			if role == "" {
				role = "cashier"
			}
			if outlet == "" {
				outlet = outletA
			}
			if outlet == "none" {
				outlet = ""
			}
			from, to := c.from, c.to
			if from == "" {
				from = "2026-01-02T00:00:00Z"
			}
			if to == "" {
				to = "2026-01-03T00:00:00Z"
			}
			token, err := auth.IssueAccess(secret, time.Hour, cashier, role, outlet, []string{"view_reports"})
			if err != nil {
				t.Fatal(err)
			}
			path := "/api/v1/reports/summary?from=" + from + "&to=" + to + c.query
			req := httptest.NewRequest(http.MethodGet, path, nil)
			req.Header.Set("Authorization", "Bearer "+token)
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, req)
			if w.Code != 200 {
				t.Fatalf("HTTP%d: %s", w.Code, w.Body.String())
			}
			var response struct {
				Data map[string]any `json:"data"`
			}
			if err = json.Unmarshal(w.Body.Bytes(), &response); err != nil {
				t.Fatal(err)
			}
			data := response.Data
			keys := []string{}
			for k := range data {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			wantKeys := []string{"avgOrderValue", "byPaymentMethod", "dailySales", "dateFrom", "dateTo", "from", "netSales", "outletId", "refundedOrders", "to", "topProducts", "totalOrders", "totalRefunds", "totalSales"}
			if !reflect.DeepEqual(keys, wantKeys) {
				t.Errorf("API shape changed: %v", keys)
			}
			avg := 0.0
			if c.orders > 0 {
				avg = float64(c.sales) / float64(c.orders)
			}
			for k, want := range map[string]float64{"totalSales": float64(c.sales), "totalRefunds": float64(c.refunds), "totalOrders": float64(c.orders), "netSales": float64(c.sales), "avgOrderValue": avg} {
				if data[k] != want {
					t.Errorf("%s=%v want %v", k, data[k], want)
				}
			}
			for key, want := range map[string]string{"from": from, "to": to} {
				gotTime, err := time.Parse(time.RFC3339, data[key].(string))
				wantTime, _ := time.Parse(time.RFC3339, want)
				if err != nil || !gotTime.Equal(wantTime) {
					t.Errorf("window instant changed: %s=%v", key, data[key])
				}
			}
			pay := data["byPaymentMethod"].(map[string]any)
			if len(pay) != len(c.payments) {
				t.Errorf("payment entries: %v", pay)
			}
			for k, v := range c.payments {
				if pay[k] != v {
					t.Errorf("payment %s=%v want%v", k, pay[k], v)
				}
			}
			products := data["topProducts"].([]any)
			daily := data["dailySales"].([]any)
			if c.orders == 0 {
				if len(products) != 0 || len(daily) != 0 {
					t.Errorf("non-completed product/daily rows: %v %v", products, daily)
				}
			} else {
				if len(products) != 1 || len(daily) != 1 {
					t.Fatalf("unexpected aggregate rows: %v %v", products, daily)
				}
				p := products[0].(map[string]any)
				d := daily[0].(map[string]any)
				if p["productId"] != product || p["quantity"] != float64(c.orders) || p["revenue"] != float64(c.sales) {
					t.Errorf("product aggregate %v", p)
				}
				if d["date"] != "2026-01-02" || d["orders"] != float64(c.orders) || d["sales"] != float64(c.sales) {
					t.Errorf("daily aggregate %v", d)
				}
			}
			after := snapshot(t)
			if before != after {
				t.Error("report mutated orders/items")
			}
			evidence = append(evidence, map[string]any{"scenario": c.name, "request": path, "role": role, "tokenOutlet": outlet, "httpStatus": w.Code, "response": json.RawMessage(w.Body.Bytes()), "expectedNetSales": c.sales, "snapshotBefore": json.RawMessage(before), "snapshotAfter": json.RawMessage(after), "beforeSHA256": fmt.Sprintf("%x", sha256.Sum256([]byte(before))), "afterSHA256": fmt.Sprintf("%x", sha256.Sum256([]byte(after))), "unchanged": before == after})
			t.Logf("sales=%v refunds=%v net=%v expectedNet=%d; orders/items unchanged=%v", data["totalSales"], data["totalRefunds"], data["netSales"], c.sales, before == after)
		})
	}
	t.Run("permission-boundary", func(t *testing.T) {
		before := snapshot(t)
		for _, authorized := range []bool{false, true} {
			req := httptest.NewRequest(http.MethodGet, "/api/v1/reports/summary", nil)
			want := 401
			if authorized {
				token, err := auth.IssueAccess(secret, time.Hour, cashier, "cashier", outletA, []string{})
				if err != nil {
					t.Fatal(err)
				}
				req.Header.Set("Authorization", "Bearer "+token)
				want = 403
			}
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, req)
			if w.Code != want {
				t.Errorf("permission status=%d want%d", w.Code, want)
			}
		}
		if before != snapshot(t) {
			t.Error("denied read mutated rows")
		}
	})
	t.Run("a26-filters-and-parity", func(t *testing.T) {
		exec(`DELETE FROM order_items`)
		exec(`DELETE FROM orders`)
		type ord struct {
			status, method, outlet, created string
			total                           string
		}
		// Totals are non-round and their sum exceeds 2^24 (float32 would round it).
		rows := []ord{
			{"completed", " QRIS", outletA, "2026-03-02T05:00:00Z", "16777217.37"},
			{"completed", "qris", outletA, "2026-03-02T06:00:00Z", "16777219.11"},
			{"completed", "cash", outletA, "2026-03-02T07:00:00Z", "12345.67"},
			{"refunded", "cash", outletA, "2026-03-02T08:00:00Z", "5000.50"},
			{"cancelled", "cash", outletA, "2026-03-02T09:00:00Z", "900.00"},
			{"completed", "cash", outletA, "2026-03-01T16:59:00Z", "111.00"}, // WIB 23:59 on 1 Mar
			{"completed", "cash", outletA, "2026-03-02T17:01:00Z", "222.00"}, // WIB 00:01 on 3 Mar
			{"completed", "qris", outletB, "2026-03-02T05:00:00Z", "777.00"},
		}
		for i, o := range rows {
			id := fmt.Sprintf("00000000-0000-4000-8702-%012d", i+1)
			exec(`INSERT INTO orders(id,order_uuid,order_number,idempotency_key,outlet_id,cashier_id,cashier_name,subtotal,total,payment_method,status,created_at) VALUES($1,$1,$2,$2,$3,$4,'Kasir Ani',$5::numeric,$5::numeric,$6,$7,$8)`,
				id, fmt.Sprintf("A26-%d", i), o.outlet, cashier, o.total, o.method, o.status, o.created)
			exec(`INSERT INTO order_items(order_id,product_id,product_name,variant_size,price,quantity,subtotal) VALUES($1,$2,'A26 product','M',$3::numeric,1,$3::numeric)`, id, product, o.total)
		}
		mux := http.NewServeMux()
		mux.HandleFunc("/api/v1/reports/summary", h.ReportSummary)
		mux.HandleFunc("/api/v1/orders", h.Orders)
		both := mw.RequireAuth(&config.Config{AccessSecret: secret})(mux)
		get := func(t *testing.T, role, outlet, path string) (int, []byte) {
			t.Helper()
			token, err := auth.IssueAccess(secret, time.Hour, cashier, role, outlet, []string{"view_reports"})
			if err != nil {
				t.Fatal(err)
			}
			req := httptest.NewRequest(http.MethodGet, path, nil)
			req.Header.Set("Authorization", "Bearer "+token)
			w := httptest.NewRecorder()
			both.ServeHTTP(w, req)
			return w.Code, w.Body.Bytes()
		}
		type summary struct {
			TotalSales      float64            `json:"totalSales"`
			TotalOrders     int                `json:"totalOrders"`
			TotalRefunds    float64            `json:"totalRefunds"`
			RefundedOrders  int                `json:"refundedOrders"`
			ByPaymentMethod map[string]float64 `json:"byPaymentMethod"`
		}
		sum := func(t *testing.T, role, outlet, query string) summary {
			t.Helper()
			code, body := get(t, role, outlet, "/api/v1/reports/summary?"+query)
			if code != 200 {
				t.Fatalf("summary %s: %d %s", query, code, body)
			}
			var r struct{ Data summary }
			if err := json.Unmarshal(body, &r); err != nil {
				t.Fatal(err)
			}
			return r.Data
		}
		// Sum every /orders page for the same filter; summary must equal it.
		listSum := func(t *testing.T, role, outlet, query string) (float64, int) {
			t.Helper()
			total, count := 0.0, 0
			for page := 1; ; page++ {
				code, body := get(t, role, outlet, fmt.Sprintf("/api/v1/orders?%s&page=%d&limit=2", query, page))
				if code != 200 {
					t.Fatalf("orders %s: %d %s", query, code, body)
				}
				var r struct {
					Data []struct {
						Total  float64 `json:"total"`
						Status string  `json:"status"`
					} `json:"data"`
					Meta struct{ Total int }
				}
				if err := json.Unmarshal(body, &r); err != nil {
					t.Fatal(err)
				}
				for _, o := range r.Data {
					if o.Status == "completed" {
						total += o.Total
					}
					count++
				}
				if count >= r.Meta.Total || len(r.Data) == 0 {
					return total, r.Meta.Total
				}
			}
		}
		// Decimal sums parsed to float64 may differ from float addition by an ulp;
		// float32 (the bug) was off by whole rupiah at this magnitude.
		approx := func(a, b float64) bool { return math.Abs(a-b) < 1e-4 }
		const day = "dateFrom=2026-03-02&dateTo=2026-03-02&outletId=" + outletA
		t.Run("money-above-2^24-is-exact", func(t *testing.T) {
			s := sum(t, "admin", "", day+"&paymentMethod=qris")
			want := 16777217.37 + 16777219.11
			if !approx(s.TotalSales, want) || s.TotalOrders != 2 {
				t.Errorf("totalSales=%v orders=%d want %v/2", s.TotalSales, s.TotalOrders, want)
			}
		})
		t.Run("wib-midnight-boundary", func(t *testing.T) {
			s := sum(t, "admin", "", "dateFrom=2026-03-02&dateTo=2026-03-02&outletId="+outletA+"&paymentMethod=cash&status=completed")
			// 16:59Z (WIB 1 Mar) and 17:01Z (WIB 3 Mar) are outside 2 Mar WIB; only 12345.67.
			if !approx(s.TotalSales, 12345.67) || s.TotalOrders != 1 {
				t.Errorf("totalSales=%v orders=%d", s.TotalSales, s.TotalOrders)
			}
		})
		t.Run("payment-filter-normalised-grouping-raw", func(t *testing.T) {
			s := sum(t, "admin", "", day+"&paymentMethod=QRIS")
			if len(s.ByPaymentMethod) != 2 || s.ByPaymentMethod[" QRIS"] != 16777217.37 || s.ByPaymentMethod["qris"] != 16777219.11 {
				t.Errorf("byPaymentMethod=%v", s.ByPaymentMethod)
			}
		})
		t.Run("status-and-refunded-count", func(t *testing.T) {
			s := sum(t, "admin", "", day)
			if s.RefundedOrders != 1 || s.TotalRefunds != 5000.5 {
				t.Errorf("refunded=%d refunds=%v", s.RefundedOrders, s.TotalRefunds)
			}
			c := sum(t, "admin", "", day+"&status=cancelled")
			if c.TotalSales != 0 || c.TotalOrders != 0 || c.RefundedOrders != 0 {
				t.Errorf("cancelled must not appear in money: %+v", c)
			}
		})
		t.Run("q-matches-cashier-name", func(t *testing.T) {
			if s := sum(t, "admin", "", day+"&q=kasir%20ani&status=completed"); s.TotalOrders != 3 {
				t.Errorf("orders=%d", s.TotalOrders)
			}
			if s := sum(t, "admin", "", day+"&q=nobody-xyz"); s.TotalOrders != 0 {
				t.Errorf("orders=%d", s.TotalOrders)
			}
		})
		t.Run("unbounded-range", func(t *testing.T) {
			s := sum(t, "admin", "", "outletId="+outletA+"&status=completed")
			want := 16777217.37 + 16777219.11 + 12345.67 + 111 + 222
			if !approx(s.TotalSales, want) || s.TotalOrders != 5 {
				t.Errorf("totalSales=%v orders=%d want %v/5", s.TotalSales, s.TotalOrders, want)
			}
		})
		t.Run("non-admin-cannot-widen-outlet", func(t *testing.T) {
			s := sum(t, "cashier", outletA, "outletId="+outletB+"&status=completed&dateFrom=2026-03-02&dateTo=2026-03-02")
			if s.TotalSales == 777 || s.TotalOrders != 3 {
				t.Errorf("cashier saw other outlet: %+v", s)
			}
		})
		t.Run("invalid-date-is-400", func(t *testing.T) {
			if code, _ := get(t, "admin", "", "/api/v1/reports/summary?dateFrom=2026-13-45"); code != 400 {
				t.Errorf("status=%d", code)
			}
		})
		t.Run("summary-equals-sum-of-all-order-pages", func(t *testing.T) {
			for _, q := range []string{
				day,
				"outletId=" + outletA,
				"outletId=all",
				day + "&paymentMethod=qris",
				"outletId=" + outletA + "&dateFrom=2026-03-01",
			} {
				s := sum(t, "admin", "", q+"&status=completed")
				got, n := listSum(t, "admin", "", q+"&status=completed")
				if !approx(s.TotalSales, got) || s.TotalOrders != n {
					t.Errorf("%s: summary %v/%d != pages %v/%d", q, s.TotalSales, s.TotalOrders, got, n)
				}
			}
		})
		t.Run("order-total-above-2^24-round-trips-exactly", func(t *testing.T) {
			exec(`DELETE FROM order_items`)
			exec(`DELETE FROM orders`)
			id := "00000000-0000-4000-8703-000000000001"
			exec(`INSERT INTO orders(id,order_uuid,order_number,idempotency_key,outlet_id,cashier_id,cashier_name,subtotal,total,payment_method,status,created_at) VALUES($1,$1,'A26-BIG','A26-BIG',$2,$3,'Kasir Ani',20000001,20000001,'cash','completed','2026-03-02T05:00:00Z')`, id, outletA, cashier)
			code, body := get(t, "admin", "", "/api/v1/orders?outletId="+outletA)
			if code != 200 {
				t.Fatalf("%d %s", code, body)
			}
			var r struct {
				Data []struct{ Total, Subtotal float64 }
			}
			if err := json.Unmarshal(body, &r); err != nil || len(r.Data) != 1 || r.Data[0].Total != 20000001 || r.Data[0].Subtotal != 20000001 {
				t.Fatalf("Rp 20,000,001 did not round-trip: %v %s", err, body)
			}
		})
	})
	if path := os.Getenv("MANDALIKA_A27_TEST_OUTPUT"); path != "" {
		raw, err := json.MarshalIndent(evidence, "", "  ")
		if err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(path, append(raw, '\n'), 0600); err != nil {
			t.Fatal(err)
		}
	}
}
