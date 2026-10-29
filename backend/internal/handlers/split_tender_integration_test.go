package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http/httptest"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/config"
	"github.com/mandalika/pos-backend/internal/integration/erp"
	mw "github.com/mandalika/pos-backend/internal/middleware"
	"github.com/mandalika/pos-backend/internal/read"
	"github.com/mandalika/pos-backend/internal/service"
	syncpkg "github.com/mandalika/pos-backend/internal/sync"
	"github.com/mandalika/pos-backend/internal/write"
)

// Gate SP (isolated cluster, MANDALIKA_SP_TEST_DSN, port 56477): C6a split tender. Sales and
// refunds go through the real /sync/batch items (so the sale and refund paths of chunks B and C
// are exercised), tenderless fixtures are raw SQL (the synthetic-line path), and every money
// reader is asserted on exact figures. Subtests are numbered as in plan section 4 (C6a).

type spOutlet struct{ id, user, tok string }

type spEnv struct {
	t        *testing.T
	ctx      context.Context
	pool     *pgxpool.Pool
	svc      *service.OrderService
	router   chi.Router
	secret   []byte
	adminAll string
	device   string
	idN      int
	n        map[string]int
}

func TestSplitTenderPostgres(t *testing.T) {
	pool, ctx := gatePool(t, "SP", 56477)
	e := newSPEnv(t, ctx, pool)

	t.Run("6 read round trip", func(t *testing.T) { e.t = t; e.readRoundTrip() })
	t.Run("7 shift close", func(t *testing.T) { e.t = t; e.shiftClose() })
	t.Run("8 reports", func(t *testing.T) { e.t = t; e.reports() })
	t.Run("10 erp tenders", func(t *testing.T) { e.t = t; e.erpTenders() })
	// C6a later chunks append subtests 1-5, 9, 9b and 11 above this line, on the same spEnv.
}

func newSPEnv(t *testing.T, ctx context.Context, pool *pgxpool.Pool) *spEnv {
	rd, wr, svc := read.New(pool), write.New(pool), service.NewOrderService(pool)
	secret := []byte("SP-INTEGRATION-SYNTHETIC-KEY-0123456789")
	eng := syncpkg.New(pool, rd, svc, wr)
	eng.ContactKey = syncpkg.DeriveContactKey(secret)
	h := New(rd, nil, auth.NewStore(pool), wr, svc, eng, nil)
	authWrap := mw.RequireAuth(&config.Config{AccessSecret: secret})
	router := chi.NewRouter()
	router.With(authWrap).Post("/sync/batch", h.SyncBatch)
	router.With(authWrap).Get("/orders/{id}", h.Order)
	router.With(authWrap).Get("/orders", h.Orders)
	router.With(authWrap).Get("/reports/summary", h.ReportSummary)
	router.With(authWrap).Get("/settings/app", h.AppSettings)
	e := &spEnv{t: t, ctx: ctx, pool: pool, svc: svc, router: router, secret: secret,
		device: "00000000-0000-4000-8f77-0000000000d1", n: map[string]int{}}
	e.adminAll = e.issue(e.nextID("0c00"), "admin", "")
	return e
}

// ── plumbing ──

func (e *spEnv) nextID(group string) string {
	e.idN++
	return fmt.Sprintf("00000000-0000-4000-8f77-%s%08d", group, e.idN)
}

func (e *spEnv) seq(name string) int { e.n[name]++; return e.n[name] }

func (e *spEnv) issue(user, role, outlet string, perms ...string) string {
	tok, err := auth.IssueAccess(e.secret, time.Hour, user, role, outlet, perms)
	if err != nil {
		e.t.Fatal(err)
	}
	return tok
}

func (e *spEnv) exec(sql string, args ...any) {
	e.t.Helper()
	if _, err := e.pool.Exec(e.ctx, sql, args...); err != nil {
		e.t.Fatalf("%v: %s", err, sql)
	}
}

func (e *spEnv) num(sql string, args ...any) (n int64) {
	e.t.Helper()
	if err := e.pool.QueryRow(e.ctx, sql, args...).Scan(&n); err != nil {
		e.t.Fatalf("%v: %s", err, sql)
	}
	return
}

func (e *spEnv) newOutlet() spOutlet {
	e.t.Helper()
	k := e.seq("outlet")
	o := spOutlet{id: e.nextID("0a00"), user: e.nextID("0b00")}
	e.exec(`INSERT INTO outlets(id,name,erp_slug,erp_code) VALUES($1,$2,$3,$4)`, o.id, fmt.Sprintf("SP outlet %d", k), fmt.Sprintf("sp-%d", k), fmt.Sprintf("SP%d", k))
	e.exec(`INSERT INTO users(id,email,password_hash,display_name,role,outlet_id) VALUES($1,$2,'x','SP cashier','cashier',$3)`, o.user, fmt.Sprintf("sp%d@example.invalid", k), o.id)
	o.tok = e.issue(o.user, "cashier", o.id, "create_order", "process_refund")
	return o
}

func (e *spEnv) newProduct(o spOutlet, price float64) string {
	e.t.Helper()
	k := e.seq("product")
	pid := e.nextID("0d00")
	e.exec(`INSERT INTO products(id,name) VALUES($1,$2)`, pid, fmt.Sprintf("SP product %d", k))
	e.exec(`INSERT INTO product_variants(product_id,size,price,stock,sku,erp_slug) VALUES($1,'std',$2,0,$3,$4)`,
		pid, price, fmt.Sprintf("SPSKU%d", k), fmt.Sprintf("sp-fg-%d", k))
	e.exec(`INSERT INTO outlet_variant_stock(outlet_id,product_id,variant_size,stock) VALUES($1,$2,'std',100000)`, o.id, pid)
	return pid
}

func (e *spEnv) call(method, path, token string, body any) (int, []byte) {
	e.t.Helper()
	var rdr *bytes.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			e.t.Fatal(err)
		}
		rdr = bytes.NewReader(raw)
	} else {
		rdr = bytes.NewReader(nil)
	}
	r := httptest.NewRequest(method, path, rdr)
	r.Header.Set("Authorization", "Bearer "+token)
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	e.router.ServeHTTP(w, r)
	return w.Code, w.Body.Bytes()
}

func (e *spEnv) send(o spOutlet, typ string, payload map[string]any, shift string) map[string]any {
	e.t.Helper()
	env := map[string]any{"v": 1, "outletId": o.id, "userId": o.user, "deviceId": e.device,
		"capturedAt": time.Now().UTC().Format(time.RFC3339Nano), "offlineMs": time.Hour.Milliseconds()}
	if shift != "" {
		env["shiftId"] = shift
	}
	item := map[string]any{"type": typ, "idempotencyKey": fmt.Sprintf("%s:%s%d", e.device, typ, e.seq("batch")), "payload": payload, "envelope": env}
	code, raw := e.call("POST", "/sync/batch", o.tok, map[string]any{"items": []any{item}})
	var out struct {
		Data struct {
			Results []map[string]any `json:"results"`
		} `json:"data"`
	}
	if code != 200 || json.Unmarshal(raw, &out) != nil || len(out.Data.Results) != 1 {
		e.t.Fatalf("batch %d %s", code, raw)
	}
	res := out.Data.Results[0]
	if res["status"] != "ok" {
		e.t.Fatalf("%s item: want ok, got %v", typ, res)
	}
	return res
}

// sale drives the real sale path. tenders nil = the legacy scalar payload.
func (e *spEnv) sale(o spOutlet, pid, method string, total, paid float64, tenders []map[string]any, shift string) string {
	e.t.Helper()
	p := map[string]any{"orderUuid": e.nextID("0e00"), "deviceId": e.device, "paymentMethod": method, "amountPaid": paid,
		"items": []map[string]any{{"productId": pid, "productName": "SP product", "variantSize": "std",
			"price": total, "quantity": 1, "subtotal": total}}}
	if tenders != nil {
		p["tenders"] = tenders
	}
	if shift != "" {
		p["shiftId"] = shift
	}
	id, _ := e.send(o, "order", p, "")["orderId"].(string)
	if id == "" {
		e.t.Fatal("sale returned no order id")
	}
	return id
}

// refund drives the real sync refund item (full refund); payout "" = absent.
func (e *spEnv) refund(o spOutlet, order, payout, shift string) {
	e.t.Helper()
	p := map[string]any{"orderId": order, "reason": "rusak", "deviceId": e.device, "orderUuid": e.nextID("1000")}
	if payout != "" {
		p["payoutMethod"] = payout
	}
	e.send(o, "refund", p, shift)
}

// rawOrder inserts a tenderless order (no order_tenders row): the synthetic-line path.
func (e *spEnv) rawOrder(o spOutlet, method, status string, total int, shift string) string {
	e.t.Helper()
	k := e.seq("raw")
	id := e.nextID("0f00")
	e.exec(`INSERT INTO orders(id,order_number,order_uuid,idempotency_key,outlet_id,cashier_id,cashier_name,subtotal,total,amount_paid,payment_method,status,shift_id)
		VALUES($1,$2,gen_random_uuid(),$3,$4,$5,'SP cashier',$6,$6,$6,$7,$8,NULLIF($9::text,'')::uuid)`,
		id, fmt.Sprintf("SPR-%d", k), fmt.Sprintf("sp-raw-%d", k), o.id, o.user, total, method, status, shift)
	return id
}

func (e *spEnv) newShift(o spOutlet) string {
	e.t.Helper()
	id := e.nextID("1100")
	e.exec(`INSERT INTO shifts(id,outlet_id,cashier_id,cashier_name,status,opened_at,starting_cash) VALUES($1,$2,$3,'SP shift','open',now(),0)`, id, o.id, o.user)
	return id
}

func (e *spEnv) getData(path string) map[string]any {
	e.t.Helper()
	code, raw := e.call("GET", path, e.adminAll, nil)
	var out struct {
		Data map[string]any `json:"data"`
	}
	if code != 200 || json.Unmarshal(raw, &out) != nil || out.Data == nil {
		e.t.Fatalf("GET %s: %d %s", path, code, raw)
	}
	return out.Data
}

func (e *spEnv) listIDs(outlet, query string) []string {
	e.t.Helper()
	code, raw := e.call("GET", "/orders?outletId="+outlet+"&limit=200"+query, e.adminAll, nil)
	var out struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if code != 200 || json.Unmarshal(raw, &out) != nil {
		e.t.Fatalf("orders list %d %s", code, raw)
	}
	ids := []string{}
	for _, d := range out.Data {
		ids = append(ids, d.ID)
	}
	sort.Strings(ids)
	return ids
}

func sameSet(got []string, want ...string) bool {
	w := append([]string{}, want...)
	sort.Strings(w)
	return strings.Join(got, ",") == strings.Join(w, ",")
}

type spSummary struct {
	TotalSales, GrossSales, TotalRefunds, NetSales float64
	TotalOrders, GrossOrders, RefundedOrders       int
	ByPay                                          map[string]float64           `json:"byPaymentMethod"`
	GrossBy                                        map[string]float64           `json:"grossByPaymentMethod"`
	RefundsBy                                      map[string]float64           `json:"refundsByPaymentMethod"`
	Daily                                          []struct{ NetSales float64 } `json:"dailySales"`
}

func (e *spEnv) summary(outlet, query string) spSummary {
	e.t.Helper()
	code, raw := e.call("GET", "/reports/summary?outletId="+outlet+query, e.adminAll, nil)
	var out struct{ Data spSummary }
	if code != 200 || json.Unmarshal(raw, &out) != nil {
		e.t.Fatalf("summary %d %s", code, raw)
	}
	return out.Data
}

func near(a, b float64) bool { return math.Abs(a-b) < 0.5 }

func mapNear(got, want map[string]float64) bool {
	if len(got) != len(want) {
		return false
	}
	for k, v := range want {
		g, ok := got[k]
		if !ok || !near(g, v) {
			return false
		}
	}
	return true
}

func (e *spEnv) wantSummary(label string, got spSummary, want spSummary) {
	e.t.Helper()
	ok := near(got.TotalSales, want.TotalSales) && near(got.GrossSales, want.GrossSales) &&
		near(got.TotalRefunds, want.TotalRefunds) && near(got.NetSales, want.NetSales) &&
		got.TotalOrders == want.TotalOrders && got.GrossOrders == want.GrossOrders && got.RefundedOrders == want.RefundedOrders &&
		mapNear(got.ByPay, want.ByPay) && mapNear(got.GrossBy, want.GrossBy) && mapNear(got.RefundsBy, want.RefundsBy)
	if !ok {
		e.t.Fatalf("%s: got %+v want %+v", label, got, want)
	}
	var daily float64
	for _, d := range got.Daily {
		daily += d.NetSales
	}
	if !near(daily, got.NetSales) {
		e.t.Fatalf("%s: sum of daily netSales %v != netSales %v", label, daily, got.NetSales)
	}
}

// ── subtest 6: read round trip ──

func (e *spEnv) readRoundTrip() {
	o := e.newOutlet()
	pid := e.newProduct(o, 100000)
	split := func() string {
		return e.sale(o, pid, "split", 100000, 110000, []map[string]any{
			{"method": "qris", "amount": 60000, "reference": "R1"}, {"method": "cash", "amount": 50000}}, "")
	}
	a := split()
	d := e.getData("/orders/" + a)
	tn, _ := d["tenders"].([]any)
	if d["paymentMethod"] != "split" || len(tn) != 2 {
		e.t.Fatalf("split order: %v", d)
	}
	l1, l2 := tn[0].(map[string]any), tn[1].(map[string]any)
	if l1["method"] != "qris" || l1["seq"].(float64) != 1 || l1["synthetic"] != false || l1["reference"] != "R1" ||
		!near(l1["amount"].(float64), 60000) {
		e.t.Fatalf("line 1: %v", l1)
	}
	if l2["method"] != "cash" || !near(l2["amount"].(float64), 40000) || !near(l2["tendered"].(float64), 50000) ||
		!near(l2["change"].(float64), 10000) {
		e.t.Fatalf("line 2: %v", l2)
	}

	raw := e.rawOrder(o, "qris", "completed", 30000, "")
	rt, _ := e.getData("/orders/" + raw)["tenders"].([]any)
	if len(rt) != 1 {
		e.t.Fatalf("tenderless order must read one synthetic line, got %v", rt)
	}
	if s := rt[0].(map[string]any); s["synthetic"] != true || s["method"] != "qris" || !near(s["amount"].(float64), 30000) || s["seq"].(float64) != 1 {
		e.t.Fatalf("synthetic line: %v", s)
	}

	e.refund(o, a, "cash", "")
	rf := e.getData("/orders/" + a)["refunds"].([]any)[0].(map[string]any)
	if rf["paymentMethod"] != "cash" || rf["payoutSource"] != "chosen" {
		e.t.Fatalf("chosen payout: %v", rf)
	}
	b := split()
	e.refund(o, b, "", "")
	rf = e.getData("/orders/" + b)["refunds"].([]any)[0].(map[string]any)
	if rf["paymentMethod"] != "cash" || rf["payoutSource"] != "default" {
		e.t.Fatalf("default payout: %v", rf)
	}
	// the list reads the same SELECT: both orders carry tenders there too.
	code, listRaw := e.call("GET", "/orders?outletId="+o.id+"&limit=50", e.adminAll, nil)
	if code != 200 || !strings.Contains(string(listRaw), `"tenders"`) || !strings.Contains(string(listRaw), `"payoutSource"`) {
		e.t.Fatalf("list lacks tenders/payoutSource: %d", code)
	}

	// settings round trip (gap class): the new column is read back, default off.
	if v, _ := e.getData("/settings/app")["splitTenderEnabled"].(bool); v {
		e.t.Fatal("splitTenderEnabled must default to false")
	}
	e.exec(`UPDATE app_settings SET split_tender_enabled=true WHERE id=1`)
	defer e.exec(`UPDATE app_settings SET split_tender_enabled=false WHERE id=1`)
	if v, _ := e.getData("/settings/app")["splitTenderEnabled"].(bool); !v {
		e.t.Fatal("splitTenderEnabled=true must read back")
	}
}

// ── subtest 7: shift close ──

type spShiftRow struct{ total, orders, refunds, cash, card, transfer, qris float64 }

func (e *spEnv) readShift(id string) (r spShiftRow) {
	e.t.Helper()
	if err := e.pool.QueryRow(e.ctx, `SELECT total_sales::float8, total_orders::float8, total_refunds::float8, cash_sales::float8,
		card_sales::float8, transfer_sales::float8, qris_sales::float8 FROM shifts WHERE id=$1`, id).
		Scan(&r.total, &r.orders, &r.refunds, &r.cash, &r.card, &r.transfer, &r.qris); err != nil {
		e.t.Fatal(err)
	}
	return
}

// oldShiftSQL is the pre-C6 per-order aggregate (service/shift.go before C6a), kept verbatim as
// the byte-identity oracle. $1 = shift, $2 = cash method ids.
const oldShiftSQL = `
SELECT COALESCE(a.total_sales,0)::float8, COALESCE(a.total_orders,0)::float8, COALESCE(a.total_refunds,0)::float8,
       COALESCE(a.cash_sales,0)::float8, COALESCE(a.card_sales,0)::float8, COALESCE(a.transfer_sales,0)::float8, COALESCE(a.qris_sales,0)::float8
FROM (
  SELECT
    sum(net_sale)                        AS total_sales,
    count(*)      FILTER (WHERE is_sale) AS total_orders,
    sum(refunded)                        AS total_refunds,
    sum(net_sale) FILTER (WHERE payment_method = ANY($2::text[])) AS cash_sales,
    sum(net_sale) FILTER (WHERE payment_method='card' AND NOT (payment_method = ANY($2::text[])))     AS card_sales,
    sum(net_sale) FILTER (WHERE payment_method='transfer' AND NOT (payment_method = ANY($2::text[]))) AS transfer_sales,
    sum(net_sale) FILTER (WHERE payment_method='qris' AND NOT (payment_method = ANY($2::text[])))     AS qris_sales
  FROM (
    SELECT o.payment_method,
           o.status IN ('completed','partially_refunded') AS is_sale,
           x.refunded,
           CASE WHEN o.status IN ('completed','partially_refunded','refunded')
                THEN o.total - x.refunded END AS net_sale
      FROM orders o
      CROSS JOIN LATERAL (SELECT COALESCE(sum(r.amount),0) AS refunded
                            FROM order_refunds r WHERE r.order_id = o.id) x
     WHERE o.shift_id=$1
  ) ord
) a`

func (e *spEnv) shiftClose() {
	// (a) byte identity on one-line fixtures: real single-method sales (one stored line), raw
	// tenderless orders (synthetic line), a cancelled and a legacy-refunded order, and a real
	// refund. The old SQL and the new CloseShift must agree on every column.
	o := e.newOutlet()
	pid := e.newProduct(o, 10000)
	sh := e.newShift(o)
	e.sale(o, pid, "cash", 50000, 60000, nil, sh)
	q := e.sale(o, pid, "qris", 30000, 30000, nil, sh)
	e.sale(o, pid, "qris", 15000, 15000, nil, sh)
	e.sale(o, pid, "card", 20000, 20000, nil, sh)
	e.sale(o, pid, "transfer", 40000, 40000, nil, sh)
	e.rawOrder(o, "cash", "completed", 10000, sh)
	e.rawOrder(o, "qris", "cancelled", 5000, sh)
	e.rawOrder(o, "card", "refunded", 7000, sh)
	e.refund(o, q, "", sh)
	var want spShiftRow
	if err := e.pool.QueryRow(e.ctx, oldShiftSQL, sh, []string{"cash"}).
		Scan(&want.total, &want.orders, &want.refunds, &want.cash, &want.card, &want.transfer, &want.qris); err != nil {
		e.t.Fatal(err)
	}
	if err := e.svc.CloseShift(e.ctx, o.id, sh, 0, nil); err != nil {
		e.t.Fatal(err)
	}
	if got := e.readShift(sh); got != want {
		e.t.Fatalf("pre-C6 byte identity: new %+v old %+v", got, want)
	}
	if want.cash == 0 || want.qris == 0 || want.orders == 0 {
		e.t.Fatalf("fixture too weak to prove identity: %+v", want)
	}

	// (b) split sales: a cash-payout refund of a split sale, a completed split sale, a single
	// cash sale and a CANCELLED split sale (counted nowhere).
	o2 := e.newOutlet()
	p2 := e.newProduct(o2, 10000)
	s2 := e.newShift(o2)
	s1 := e.sale(o2, p2, "split", 100000, 100000, []map[string]any{
		{"method": "qris", "amount": 60000}, {"method": "cash", "amount": 40000}}, s2)
	e.sale(o2, p2, "split", 50000, 50000, []map[string]any{
		{"method": "card", "amount": 20000}, {"method": "cash", "amount": 30000}}, s2)
	e.sale(o2, p2, "cash", 25000, 25000, nil, s2)
	s4 := e.sale(o2, p2, "split", 15000, 15000, []map[string]any{
		{"method": "qris", "amount": 10000}, {"method": "cash", "amount": 5000}}, s2)
	e.exec(`UPDATE orders SET status='cancelled' WHERE id=$1`, s4)
	e.refund(o2, s1, "cash", s2)
	if err := e.svc.CloseShift(e.ctx, o2.id, s2, 0, nil); err != nil {
		e.t.Fatal(err)
	}
	// S1 net 0 (refunded, qris +60k, cash 40k-100k), S2 50k, S3 25k, S4 nowhere.
	wantSplit := spShiftRow{total: 75000, orders: 2, refunds: 100000, cash: -5000, card: 20000, transfer: 0, qris: 60000}
	if got := e.readShift(s2); got != wantSplit {
		e.t.Fatalf("split shift: got %+v want %+v", got, wantSplit)
	}
	if b := wantSplit; !near(b.cash+b.card+b.transfer+b.qris, b.total) {
		e.t.Fatal("buckets must add up to total_sales")
	}
}

// ── subtest 8: reports ──

// oldSummary is the pre-C6 order-level summary (per-order payment_method, order-level method
// filter), the oracle for one-line fixtures. method "" = unfiltered.
func (e *spEnv) oldSummary(outlet, method string) spSummary {
	e.t.Helper()
	var s spSummary
	const sb = `(SELECT o.id, o.total, o.status, o.payment_method,
	    o.total - COALESCE((SELECT SUM(r.amount) FROM order_refunds r WHERE r.order_id=o.id),0) AS net_total
	  FROM orders o WHERE o.outlet_id=$1 AND o.status IN ('completed','partially_refunded','refunded')
	    AND ($2='' OR lower(btrim(o.payment_method)) = lower(btrim($2)))) sb`
	if err := e.pool.QueryRow(e.ctx, `SELECT COALESCE(SUM(net_total),0)::float8,
	    COUNT(*) FILTER (WHERE status IN ('completed','partially_refunded')), COALESCE(SUM(total),0)::float8, COUNT(*) FROM `+sb,
		outlet, method).Scan(&s.TotalSales, &s.TotalOrders, &s.GrossSales, &s.GrossOrders); err != nil {
		e.t.Fatal(err)
	}
	if err := e.pool.QueryRow(e.ctx, `SELECT COALESCE(SUM(r.amount),0)::float8, COUNT(DISTINCT r.order_id)
	  FROM orders o JOIN order_refunds r ON r.order_id=o.id WHERE o.outlet_id=$1
	    AND ($2='' OR lower(btrim(o.payment_method)) = lower(btrim($2)))`, outlet, method).Scan(&s.TotalRefunds, &s.RefundedOrders); err != nil {
		e.t.Fatal(err)
	}
	s.NetSales = s.GrossSales - s.TotalRefunds
	collect := func(sql string) map[string]float64 {
		rows, err := e.pool.Query(e.ctx, sql, outlet, method)
		if err != nil {
			e.t.Fatal(err)
		}
		defer rows.Close()
		m := map[string]float64{}
		for rows.Next() {
			var k string
			var v float64
			if err := rows.Scan(&k, &v); err != nil {
				e.t.Fatal(err)
			}
			m[k] = v
		}
		return m
	}
	s.ByPay = collect(`SELECT payment_method, SUM(net_total)::float8 FROM ` + sb + `
	  WHERE status IN ('completed','partially_refunded') OR net_total <> 0 GROUP BY payment_method`)
	s.GrossBy = collect(`SELECT payment_method, SUM(total)::float8 FROM ` + sb + ` GROUP BY payment_method`)
	s.RefundsBy = collect(`SELECT r.payment_method, SUM(r.amount)::float8 FROM orders o JOIN order_refunds r ON r.order_id=o.id
	  WHERE o.outlet_id=$1 AND ($2='' OR lower(btrim(o.payment_method)) = lower(btrim($2))) GROUP BY r.payment_method`)
	return s
}

func (e *spEnv) reports() {
	// pre-C6 one-line fixtures: the new summary equals the old SQL, unfiltered and per method.
	o := e.newOutlet()
	pid := e.newProduct(o, 10000)
	e.sale(o, pid, "cash", 50000, 50000, nil, "")
	q := e.sale(o, pid, "qris", 30000, 30000, nil, "")
	e.sale(o, pid, "card", 20000, 20000, nil, "")
	e.sale(o, pid, "transfer", 40000, 40000, nil, "")
	e.rawOrder(o, "qris", "completed", 10000, "")
	e.rawOrder(o, "cash", "refunded", 15000, "")
	e.rawOrder(o, "card", "cancelled", 9000, "")
	e.refund(o, q, "", "")
	for _, m := range []string{"", "qris", "cash", "CARD "} {
		q := ""
		if m != "" {
			q = "&paymentMethod=" + strings.ReplaceAll(m, " ", "%20")
		}
		e.wantSummary("byte identity method="+m, e.summary(o.id, q), e.oldSummary(o.id, m))
	}

	// split fixtures.
	r := e.newOutlet()
	rp := e.newProduct(r, 10000)
	p1 := e.sale(r, rp, "split", 100000, 100000, []map[string]any{
		{"method": "qris", "amount": 60000}, {"method": "cash", "amount": 40000}}, "")
	p2 := e.sale(r, rp, "qris", 30000, 30000, nil, "")
	p3 := e.sale(r, rp, "cash", 20000, 20000, nil, "")
	p4 := e.sale(r, rp, "split", 50000, 50000, []map[string]any{
		{"method": "card", "amount": 20000}, {"method": "qris", "amount": 30000}}, "")
	t1 := e.rawOrder(r, "qris", "completed", 10000, "")
	e.refund(r, p1, "cash", "")

	// unfiltered: a fully refunded split order keeps its per-method rows (+qris, -cash).
	e.wantSummary("unfiltered", e.summary(r.id, ""), spSummary{
		TotalSales: 110000, GrossSales: 210000, TotalRefunds: 100000, NetSales: 110000,
		TotalOrders: 4, GrossOrders: 5, RefundedOrders: 1,
		ByPay:     map[string]float64{"qris": 130000, "cash": -40000, "card": 20000},
		GrossBy:   map[string]float64{"qris": 130000, "cash": 60000, "card": 20000},
		RefundsBy: map[string]float64{"cash": 100000}})
	un := e.summary(r.id, "")
	var by float64
	for _, v := range un.ByPay {
		by += v
	}
	if !near(by, un.TotalSales) {
		e.t.Fatalf("by-method map %v must sum to totalSales %v", un.ByPay, un.TotalSales)
	}

	// list rule: orders CONTAINING the method, split orders and synthetic lines included.
	if got := e.listIDs(r.id, "&paymentMethod=QRIS"); !sameSet(got, p1, p2, p4, t1) {
		e.t.Fatalf("qris list: %v", got)
	}
	if got := e.listIDs(r.id, "&paymentMethod=cash"); !sameSet(got, p1, p3) {
		e.t.Fatalf("cash list: %v", got)
	}
	if got := e.listIDs(r.id, "&paymentMethod=split"); !sameSet(got, p1, p4) {
		e.t.Fatalf("split list: %v", got)
	}

	// summary rule (D-66): money limited to the method.
	e.wantSummary("qris filter", e.summary(r.id, "&paymentMethod=qris"), spSummary{
		TotalSales: 130000, GrossSales: 130000, TotalRefunds: 0, NetSales: 130000,
		TotalOrders: 3, GrossOrders: 4, RefundedOrders: 0,
		ByPay: map[string]float64{"qris": 130000}, GrossBy: map[string]float64{"qris": 130000}, RefundsBy: map[string]float64{}})
	e.wantSummary("cash filter", e.summary(r.id, "&paymentMethod=cash"), spSummary{
		TotalSales: -40000, GrossSales: 60000, TotalRefunds: 100000, NetSales: -40000,
		TotalOrders: 1, GrossOrders: 2, RefundedOrders: 1,
		ByPay: map[string]float64{"cash": -40000}, GrossBy: map[string]float64{"cash": 60000}, RefundsBy: map[string]float64{"cash": 100000}})
	// `split` = whole-order money of split orders.
	e.wantSummary("split filter", e.summary(r.id, "&paymentMethod=split"), spSummary{
		TotalSales: 50000, GrossSales: 150000, TotalRefunds: 100000, NetSales: 50000,
		TotalOrders: 1, GrossOrders: 2, RefundedOrders: 1,
		ByPay:     map[string]float64{"qris": 90000, "cash": -60000, "card": 20000},
		GrossBy:   map[string]float64{"qris": 90000, "cash": 40000, "card": 20000},
		RefundsBy: map[string]float64{"cash": 100000}})
}

// ── subtest 10: ERP tenders ──

// erpDocument builds the wire document of the order's outbox row of a kind exactly as the relay does.
func (e *spEnv) erpDocument(order, kind string) erp.StockDocument {
	e.t.Helper()
	var hd erp.OutboxHeader
	err := e.pool.QueryRow(e.ctx, `SELECT id::text, document_id::text, kind, location_type, location_id::text, ref_type, ref_id::text,
	    coalesce(ref_number,''), part, part_count, created_at FROM erp_outbox WHERE ref_id=$1 AND kind=$2 AND part<=1`, order, kind).
		Scan(&hd.ID, &hd.DocumentID, &hd.Kind, &hd.LocationType, &hd.LocationID, &hd.RefType, &hd.RefID, &hd.RefNumber, &hd.Part, &hd.PartCount, &hd.CreatedAt)
	if err != nil {
		e.t.Fatalf("outbox %s row of %s: %v", kind, order, err)
	}
	in, err := erp.LoadBuildInput(e.ctx, e.pool, hd, "mandalika")
	if err != nil {
		e.t.Fatal(err)
	}
	doc, hold, err := erp.BuildDocument(in)
	if err != nil || hold != "" {
		e.t.Fatalf("BuildDocument %s: hold=%q err=%v", kind, hold, err)
	}
	return doc
}

func (e *spEnv) erpTenders() {
	o := e.newOutlet()
	pid := e.newProduct(o, 100000)
	order := e.sale(o, pid, "split", 100000, 110000, []map[string]any{
		{"method": "qris", "amount": 60000, "reference": "R1"}, {"method": "tunai", "amount": 50000}}, "")

	// live `tunai` goes out as cash; the lines sum to the order total (change is not a tender).
	doc := e.erpDocument(order, "sale")
	want := []erp.Tender{{Method: "qris", Amount: 60000}, {Method: "cash", Amount: 40000}}
	if len(doc.Tenders) != 2 || doc.Tenders[0] != want[0] || doc.Tenders[1] != want[1] {
		e.t.Fatalf("sale tenders = %+v, want %+v", doc.Tenders, want)
	}
	var sum int64
	for _, tn := range doc.Tenders {
		sum += tn.Amount
	}
	if sum != 100000 {
		e.t.Fatalf("tender sum = %d, want the order total 100000", sum)
	}

	// the refund document's tender is the payout method, negated.
	e.refund(o, order, "qris", "")
	rd := e.erpDocument(order, "refund")
	if len(rd.Tenders) != 1 || rd.Tenders[0] != (erp.Tender{Method: "qris", Amount: -100000}) {
		e.t.Fatalf("refund tenders = %+v, want qris -100000", rd.Tenders)
	}

}
