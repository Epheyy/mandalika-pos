package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/config"
	"github.com/mandalika/pos-backend/internal/db"
	mw "github.com/mandalika/pos-backend/internal/middleware"
)

// refundDaily / refundSummary decode the A27 fields of /reports/summary.
type refundDaily struct {
	Date           string  `json:"date"`
	Sales          float64 `json:"sales"`
	Orders         int     `json:"orders"`
	GrossSales     float64 `json:"grossSales"`
	GrossOrders    int     `json:"grossOrders"`
	Refunds        float64 `json:"refunds"`
	RefundedOrders int     `json:"refundedOrders"`
	NetSales       float64 `json:"netSales"`
}

type refundSummary struct {
	TotalSales     float64            `json:"totalSales"`
	TotalOrders    int                `json:"totalOrders"`
	GrossSales     float64            `json:"grossSales"`
	GrossOrders    int                `json:"grossOrders"`
	TotalRefunds   float64            `json:"totalRefunds"`
	RefundedOrders int                `json:"refundedOrders"`
	NetSales       float64            `json:"netSales"`
	ByPay          map[string]float64 `json:"byPaymentMethod"`
	GrossBy        map[string]float64 `json:"grossByPaymentMethod"`
	RefundsBy      map[string]float64 `json:"refundsByPaymentMethod"`
	DailySales     []refundDaily      `json:"dailySales"`
}

// runRefundDateBasis is the A27 policy gate: sales are recognised on the sale business day,
// refunds on the REFUND business day, and net = gross - refunds (never totalSales - totalRefunds).
func runRefundDateBasis(t *testing.T, ctx context.Context, pool *pgxpool.Pool, h *Handlers, secret []byte, exec func(string, ...any)) {
	const outA = "00000000-0000-4000-8800-000000000001"
	const outW = "00000000-0000-4000-8800-000000000002"
	const outM = "00000000-0000-4000-8800-000000000003"
	const cashier = "00000000-0000-4000-8800-000000000009"
	const product = "00000000-0000-4000-8800-00000000000a"
	exec(`INSERT INTO outlets(id,name,timezone) VALUES($1,'A27 RD A','Asia/Jakarta'),($2,'A27 RD W','Asia/Jakarta'),($3,'A27 RD M','Asia/Makassar')`, outA, outW, outM)

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/reports/summary", h.ReportSummary)
	mux.HandleFunc("/api/v1/orders", h.Orders)
	srv := mw.RequireAuth(&config.Config{AccessSecret: secret})(mux)
	get := func(t *testing.T, role, outlet, path string) (int, []byte) {
		t.Helper()
		token, err := auth.IssueAccess(secret, time.Hour, cashier, role, outlet, []string{"view_reports"})
		if err != nil {
			t.Fatal(err)
		}
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		srv.ServeHTTP(w, req)
		return w.Code, w.Body.Bytes()
	}
	sum := func(t *testing.T, role, outlet, query string) refundSummary {
		t.Helper()
		code, body := get(t, role, outlet, "/api/v1/reports/summary?"+query)
		if code != 200 {
			t.Fatalf("summary %s: %d %s", query, code, body)
		}
		var r struct{ Data refundSummary }
		if err := json.Unmarshal(body, &r); err != nil {
			t.Fatal(err)
		}
		return r.Data
	}
	reset := func() {
		exec(`DELETE FROM order_items`)
		exec(`DELETE FROM orders`)
		exec(`DELETE FROM shifts`)
	}
	seq := 0
	sale := func(outlet, total, method, created string) string {
		seq++
		id := fmt.Sprintf("00000000-0000-4000-8801-%012d", seq)
		exec(`INSERT INTO orders(id,order_uuid,order_number,idempotency_key,outlet_id,cashier_id,cashier_name,subtotal,total,payment_method,status,created_at) VALUES($1,$1,$2,$2,$3,$4,'RD',$5::numeric,$5::numeric,$6,'completed',$7)`, id, fmt.Sprintf("RD-%d", seq), outlet, cashier, total, method, created)
		exec(`INSERT INTO order_items(order_id,product_id,product_name,variant_size,price,quantity,subtotal) VALUES($1,$2,'RD product','M',$3::numeric,1,$3::numeric)`, id, product, total)
		return id
	}
	// refund flips completed -> refunded; the UPDATE trigger stamps refund_business_date.
	refund := func(id, at string, shift any) {
		exec(`UPDATE orders SET status='refunded', refunded_at=$2, refund_shift_id=$3::uuid WHERE id=$1`, id, at, shift)
	}
	shift := func(id, outlet, opened string) {
		exec(`INSERT INTO shifts(id,outlet_id,cashier_id,cashier_name,status,opened_at,starting_cash) VALUES($1,$2,$3,'RD','open',$4,0)`, id, outlet, cashier, opened)
	}
	eqMap := func(t *testing.T, what string, got, want map[string]float64) {
		t.Helper()
		if got == nil {
			got = map[string]float64{}
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("%s=%v want %v", what, got, want)
		}
	}
	type want struct {
		gross, totalSales, refunds, net float64
		grossOrders, refundedOrders     int
		daily                           []refundDaily
		grossBy, refundsBy              map[string]float64
	}
	check := func(t *testing.T, label string, s refundSummary, w want) {
		t.Helper()
		if s.GrossSales != w.gross || s.TotalSales != w.totalSales || s.TotalRefunds != w.refunds || s.NetSales != w.net || s.GrossOrders != w.grossOrders || s.RefundedOrders != w.refundedOrders {
			t.Errorf("%s: gross=%v/%d sales=%v refunds=%v/%d net=%v; want %+v", label, s.GrossSales, s.GrossOrders, s.TotalSales, s.TotalRefunds, s.RefundedOrders, s.NetSales, w)
		}
		if len(s.DailySales) != len(w.daily) {
			t.Fatalf("%s: daily rows %+v want %+v", label, s.DailySales, w.daily)
		}
		for i := range w.daily {
			if s.DailySales[i] != w.daily[i] {
				t.Errorf("%s: daily[%d]=%+v want %+v", label, i, s.DailySales[i], w.daily[i])
			}
		}
		eqMap(t, label+" grossBy", s.GrossBy, w.grossBy)
		eqMap(t, label+" refundsBy", s.RefundsBy, w.refundsBy)
	}

	t.Run("a27-d1-d2-d3-refund-on-refund-day", func(t *testing.T) {
		reset()
		const shiftD3 = "00000000-0000-4000-8802-000000000001"
		x := sale(outA, "100", "cash", "2026-02-01T05:00:00Z") // D1 = 2026-02-01 (12:00 WIB)
		shift(shiftD3, outA, "2026-02-03T03:00:00Z")           // opened D3 10:00 WIB
		refund(x, "2026-02-03T04:00:00Z", shiftD3)             // POS refund from the D3 shift
		q := func(from, to string) string { return "outletId=" + outA + "&dateFrom=" + from + "&dateTo=" + to }
		none := map[string]float64{}
		check(t, "D1", sum(t, "admin", "", q("2026-02-01", "2026-02-01")), want{gross: 100, grossOrders: 1, net: 100,
			daily:   []refundDaily{{"2026-02-01", 0, 0, 100, 1, 0, 0, 100}},
			grossBy: map[string]float64{"cash": 100}, refundsBy: none})
		check(t, "D2", sum(t, "admin", "", q("2026-02-02", "2026-02-02")), want{grossBy: none, refundsBy: none})
		check(t, "D3", sum(t, "admin", "", q("2026-02-03", "2026-02-03")), want{refunds: 100, refundedOrders: 1, net: -100,
			daily:   []refundDaily{{"2026-02-03", 0, 0, 0, 0, 100, 1, -100}},
			grossBy: none, refundsBy: map[string]float64{"cash": 100}})
		check(t, "D1-D3", sum(t, "admin", "", q("2026-02-01", "2026-02-03")), want{gross: 100, grossOrders: 1, refunds: 100, refundedOrders: 1, net: 0,
			daily:   []refundDaily{{"2026-02-01", 0, 0, 100, 1, 0, 0, 100}, {"2026-02-03", 0, 0, 0, 0, 100, 1, -100}},
			grossBy: map[string]float64{"cash": 100}, refundsBy: map[string]float64{"cash": 100}})

		// Shift close figures are a separate drawer model: reading every basis must not touch shifts.
		var before, after string
		snap := `SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY id),'[]'::jsonb)::text FROM shifts s`
		if err := pool.QueryRow(ctx, snap).Scan(&before); err != nil {
			t.Fatal(err)
		}
		sum(t, "admin", "", q("2026-02-01", "2026-02-03"))
		get(t, "admin", "", "/api/v1/orders?dateBasis=refund&outletId="+outA)
		if err := pool.QueryRow(ctx, snap).Scan(&after); err != nil || before != after {
			t.Errorf("shifts changed by report reads: %v", err)
		}
	})

	t.Run("a27-refund-day-uses-outlet-clock-and-shift-opening-day", func(t *testing.T) {
		reset()
		const shiftLate = "00000000-0000-4000-8802-000000000002"
		y := sale(outA, "40", "cash", "2026-02-10T05:00:00Z")
		z := sale(outA, "25", "qris", "2026-02-10T06:00:00Z")
		refund(y, "2026-02-12T16:50:00Z", nil) // no shift: 23:50 WIB on 02-12
		shift(shiftLate, outA, "2026-02-12T15:00:00Z")
		refund(z, "2026-02-12T17:30:00Z", shiftLate) // 00:30 WIB on 02-13, but the shift opened 22:00 on 02-12
		s := sum(t, "admin", "", "outletId="+outA+"&dateFrom=2026-02-12&dateTo=2026-02-12")
		if s.TotalRefunds != 65 || s.RefundedOrders != 2 {
			t.Errorf("02-12 refunds=%v/%d want 65/2", s.TotalRefunds, s.RefundedOrders)
		}
		eqMap(t, "02-12 refundsBy", s.RefundsBy, map[string]float64{"cash": 40, "qris": 25})
		if n := sum(t, "admin", "", "outletId="+outA+"&dateFrom=2026-02-13&dateTo=2026-02-13"); n.TotalRefunds != 0 || n.NetSales != 0 {
			t.Errorf("02-13 must stay empty: %+v", n)
		}
	})

	t.Run("a27-multi-outlet-timezones", func(t *testing.T) {
		reset()
		w := sale(outW, "70", "cash", "2026-10-19T15:30:00Z") // 22:30 WIB, 10-19
		m := sale(outM, "30", "cash", "2026-10-19T15:30:00Z") // 23:30 WITA, 10-19
		refund(w, "2026-10-19T16:10:00Z", nil)                // 23:10 WIB -> 10-19
		refund(m, "2026-10-19T16:10:00Z", nil)                // 00:10 WITA -> 10-20
		day := func(d string) string { return "outletId=all&dateFrom=" + d + "&dateTo=" + d }
		a := sum(t, "admin", "", day("2026-10-19"))
		if a.GrossSales != 100 || a.TotalRefunds != 70 || a.NetSales != 30 {
			t.Errorf("10-19: gross=%v refunds=%v net=%v want 100/70/30", a.GrossSales, a.TotalRefunds, a.NetSales)
		}
		b := sum(t, "admin", "", day("2026-10-20"))
		if b.GrossSales != 0 || b.TotalRefunds != 30 || b.NetSales != -30 {
			t.Errorf("10-20: gross=%v refunds=%v net=%v want 0/30/-30", b.GrossSales, b.TotalRefunds, b.NetSales)
		}
		// A non-admin cannot widen the outlet through the query parameter.
		c := sum(t, "cashier", outW, "outletId="+outM+"&dateFrom=2026-10-19&dateTo=2026-10-19")
		if c.GrossSales != 70 || c.TotalRefunds != 70 || c.NetSales != 0 {
			t.Errorf("cashier scope leak: %+v", c)
		}
	})

	t.Run("a27-legacy-instant-refund-side-is-bounded", func(t *testing.T) {
		reset()
		id := sale(outA, "30", "cash", "2026-04-01T05:00:00Z")
		refund(id, "2026-04-05T00:00:00Z", nil)
		in := sum(t, "admin", "", "outletId="+outA+"&from=2026-04-05T00:00:00Z&to=2026-04-06T00:00:00Z")
		if in.TotalRefunds != 30 || in.RefundedOrders != 1 {
			t.Errorf("refunded_at == from must be inside: %+v", in)
		}
		out := sum(t, "admin", "", "outletId="+outA+"&from=2026-04-04T00:00:00Z&to=2026-04-05T00:00:00Z")
		if out.TotalRefunds != 0 || out.RefundedOrders != 0 || out.NetSales != 0 || len(out.DailySales) != 0 {
			t.Errorf("refunded_at == to must be outside: %+v", out)
		}
	})

	// Shared fixture for status interplay, invariants and list parity.
	reset()
	sale(outA, "100", "cash", "2026-03-10T05:00:00Z")
	r := sale(outA, "50", "card", "2026-03-10T06:00:00Z")
	r2 := sale(outA, "20", "cash", "2026-03-05T05:00:00Z")
	cx := sale(outA, "900", "cash", "2026-03-10T07:00:00Z")
	refund(r, "2026-03-12T05:00:00Z", nil)
	refund(r2, "2026-03-10T08:00:00Z", nil)
	exec(`UPDATE orders SET status='cancelled' WHERE id=$1`, cx)
	const day = "outletId=" + outA + "&dateFrom=2026-03-10&dateTo=2026-03-10"

	t.Run("a27-status-interplay", func(t *testing.T) {
		all := sum(t, "admin", "", day)
		if all.GrossSales != 150 || all.GrossOrders != 2 || all.TotalSales != 100 || all.TotalRefunds != 20 || all.RefundedOrders != 1 || all.NetSales != 130 {
			t.Errorf("no status: %+v", all)
		}
		comp := sum(t, "admin", "", day+"&status=completed")
		if comp.GrossSales != 100 || comp.TotalRefunds != 0 || comp.RefundedOrders != 0 || comp.NetSales != 100 {
			t.Errorf("completed: refund side must be empty: %+v", comp)
		}
		ref := sum(t, "admin", "", day+"&status=refunded")
		if ref.GrossSales != 50 || ref.GrossOrders != 1 || ref.TotalSales != 0 || ref.TotalRefunds != 20 || ref.NetSales != 30 {
			t.Errorf("refunded: %+v", ref)
		}
		can := sum(t, "admin", "", day+"&status=cancelled")
		if can.GrossSales != 0 || can.TotalRefunds != 0 || can.NetSales != 0 || can.TotalSales != 0 || len(can.DailySales) != 0 {
			t.Errorf("cancelled is never money: %+v", can)
		}
	})

	t.Run("a27-invariants", func(t *testing.T) {
		unb := sum(t, "admin", "", "outletId="+outA)
		if unb.NetSales != unb.TotalSales || unb.NetSales != 100 {
			t.Errorf("unbounded: net=%v totalSales=%v want both 100", unb.NetSales, unb.TotalSales)
		}
		for _, s := range []refundSummary{unb, sum(t, "admin", "", "outletId="+outA+"&dateFrom=2026-03-01&dateTo=2026-03-31"), sum(t, "admin", "", day)} {
			dn, gp, rp := 0.0, 0.0, 0.0
			for _, d := range s.DailySales {
				dn += d.NetSales
			}
			for _, v := range s.GrossBy {
				gp += v
			}
			for _, v := range s.RefundsBy {
				rp += v
			}
			if dn != s.NetSales || gp != s.GrossSales || rp != s.TotalRefunds || s.NetSales != s.GrossSales-s.TotalRefunds {
				t.Errorf("invariant broken: dailyNet=%v grossMap=%v refundMap=%v %+v", dn, gp, rp, s)
			}
		}
	})

	t.Run("a27-list-parity-and-date-basis", func(t *testing.T) {
		type row struct {
			ID                 string  `json:"id"`
			Total              float64 `json:"total"`
			Status             string  `json:"status"`
			RefundBusinessDate *string `json:"refundBusinessDate"`
		}
		page := func(t *testing.T, query string) ([]row, int) {
			t.Helper()
			var rows []row
			for p := 1; ; p++ {
				code, body := get(t, "admin", "", fmt.Sprintf("/api/v1/orders?%s&page=%d&limit=2", query, p))
				if code != 200 {
					t.Fatalf("orders %s: %d %s", query, code, body)
				}
				var resp struct {
					Data []row
					Meta struct{ Total int }
				}
				if err := json.Unmarshal(body, &resp); err != nil {
					t.Fatal(err)
				}
				rows = append(rows, resp.Data...)
				if len(resp.Data) == 0 || len(rows) >= resp.Meta.Total {
					return rows, resp.Meta.Total
				}
			}
		}
		const month = "outletId=" + outA + "&dateFrom=2026-03-01&dateTo=2026-03-31"
		for _, q := range []string{month, day, "outletId=" + outA} {
			s := sum(t, "admin", "", q)
			rows, _ := page(t, q)
			gross := 0.0
			for _, o := range rows {
				if o.Status == "completed" || o.Status == "refunded" {
					gross += o.Total
				}
			}
			if s.GrossSales != gross {
				t.Errorf("%s: grossSales=%v != sale-basis list sum %v", q, s.GrossSales, gross)
			}
			refRows, n := page(t, q+"&dateBasis=refund")
			refunds := 0.0
			for _, o := range refRows {
				if o.Status != "refunded" || o.RefundBusinessDate == nil {
					t.Errorf("%s dateBasis=refund returned %+v", q, o)
				}
				refunds += o.Total
			}
			if s.TotalRefunds != refunds || s.RefundedOrders != n {
				t.Errorf("%s: totalRefunds=%v/%d != refund-basis list %v/%d", q, s.TotalRefunds, s.RefundedOrders, refunds, n)
			}
		}
		// Refund basis is bound to the refund day and ordered by refundedAt, newest first.
		rows, _ := page(t, "outletId="+outA+"&dateBasis=refund")
		if len(rows) != 2 || rows[0].ID != r || rows[1].ID != r2 {
			t.Fatalf("refund order: %+v want [%s %s]", rows, r, r2)
		}
		if rows[1].RefundBusinessDate == nil || *rows[1].RefundBusinessDate != "2026-03-10" {
			t.Errorf("refundBusinessDate=%v want 2026-03-10", rows[1].RefundBusinessDate)
		}
		only, _ := page(t, day+"&dateBasis=refund")
		if len(only) != 1 || only[0].ID != r2 {
			t.Errorf("refund-day 03-10 rows: %+v want only %s", only, r2)
		}
		if code, _ := get(t, "admin", "", "/api/v1/orders?dateBasis=bogus"); code != 400 {
			t.Errorf("dateBasis=bogus status=%d want 400", code)
		}
		// Legacy POS from/to stays created_at based (all statuses), unaffected by the refund basis.
		legacy, n := page(t, "outletId="+outA+"&from=2026-03-10&to=2026-03-10")
		if n != 3 || len(legacy) != 3 {
			t.Errorf("legacy POS from/to rows=%d total=%d want 3", len(legacy), n)
		}
	})

	t.Run("a27-migration-0060", func(t *testing.T) {
		const name = "0060_refund_business_date_index.sql"
		var applied int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM schema_migrations WHERE name=$1`, name).Scan(&applied); err != nil || applied != 1 {
			t.Fatalf("%s not applied: %d %v", name, applied, err)
		}
		if err := (&db.DB{Pool: pool}).Migrate(ctx); err != nil {
			t.Fatalf("second Migrate: %v", err)
		}
		for _, ix := range []string{"idx_orders_outlet_refund_bd", "idx_orders_refund_bd"} {
			var n int
			if err := pool.QueryRow(ctx, `SELECT count(*) FROM pg_indexes WHERE tablename='orders' AND indexname=$1`, ix).Scan(&n); err != nil || n != 1 {
				t.Errorf("index %s missing", ix)
			}
		}
		// Backfill: a legacy refunded row with no refunded_at and no refund date (the 0059 gap). It was captured
		// at 00:30 WIB on 05-02 inside a shift opened 22:00 on 05-01, so business_date != the WIB day of created_at.
		raw, err := os.ReadFile("../db/migrations/" + name)
		if err != nil {
			t.Fatal(err)
		}
		reset()
		exec(`ALTER TABLE orders DISABLE TRIGGER trg_orders_business_date`)
		const legacyID = "00000000-0000-4000-8803-000000000001"
		exec(`INSERT INTO orders(id,order_uuid,order_number,idempotency_key,outlet_id,cashier_id,cashier_name,subtotal,total,payment_method,status,created_at,business_date,refunded_at,refund_business_date) VALUES($1,$1,'RD-LEGACY','RD-LEGACY',$2,$3,'RD',10,10,'cash','refunded','2026-05-01T17:30:00Z','2026-05-01',NULL,NULL)`, legacyID, outA, cashier)
		exec(`ALTER TABLE orders ENABLE TRIGGER trg_orders_business_date`)
		for i := 0; i < 2; i++ { // twice: the body must be idempotent
			if _, err := pool.Exec(ctx, string(raw)); err != nil {
				t.Fatalf("0060 body run %d: %v", i+1, err)
			}
		}
		var got *string
		if err := pool.QueryRow(ctx, `SELECT to_char(refund_business_date,'YYYY-MM-DD') FROM orders WHERE id=$1`, legacyID).Scan(&got); err != nil || got == nil || *got != "2026-05-01" {
			t.Errorf("backfill refund_business_date=%v err=%v want the row business_date 2026-05-01 (not the 05-02 WIB day of created_at)", got, err)
		}
		if strings.Contains(string(raw), "DROP ") {
			t.Error("0060 must stay additive")
		}
	})
}
