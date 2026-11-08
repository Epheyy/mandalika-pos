package handlers

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mandalika/pos-backend/internal/api"
	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/config"
	"github.com/mandalika/pos-backend/internal/db"
	"github.com/mandalika/pos-backend/internal/integration/erp"
	mw "github.com/mandalika/pos-backend/internal/middleware"
	"github.com/mandalika/pos-backend/internal/read"
	"github.com/mandalika/pos-backend/internal/service"
	syncpkg "github.com/mandalika/pos-backend/internal/sync"
	"github.com/mandalika/pos-backend/internal/write"
)

// rlOutlet is one isolated outlet (own cashier, own token) so money readers can be asserted
// against exact figures without other subtests' orders leaking in.
type rlOutlet struct{ id, user, tok string }

type rlRefundRow struct {
	id, scope, warn, key             string
	seq                              int
	amount, computed, clawed, restor int64
	claimed                          int64 // -1 = no claim stored
}

type rlLine struct {
	id, group string
	no, qty   int
	net       int64
}

// rlCum is the independent re-derivation of the plan's cum(n) rule (2.4).
func rlCum(net int64, qty, n int) int64 {
	if n == qty {
		return net
	}
	return net * int64(n) / int64(qty)
}

// TestRefundLinesPostgres is gate RL (isolated cluster, MANDALIKA_RL_TEST_DSN, port 26476):
// C4a per-line / partial refunds end to end. Sales go through the real /sync/batch "order" item
// (so line_no/net_amount/refund_group are really written), refunds through the real "refund"
// item and the direct route, and every effect is asserted on the rows AND on the HTTP readers.
func TestRefundLinesPostgres(t *testing.T) {
	pool, ctx := gatePool(t, "RL", 26476)
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
			cur.Fatalf("%v: %s", err, sql)
		}
	}
	num := func(sql string, args ...any) (n int64) {
		cur.Helper()
		if err := pool.QueryRow(ctx, sql, args...).Scan(&n); err != nil {
			cur.Fatalf("%v: %s", err, sql)
		}
		return
	}
	str := func(sql string, args ...any) (s string) {
		cur.Helper()
		var p *string
		if err := pool.QueryRow(ctx, sql, args...).Scan(&p); err != nil {
			cur.Fatalf("%v: %s", err, sql)
		}
		if p != nil {
			s = *p
		}
		return
	}

	rd, wr, svc := read.New(pool), write.New(pool), service.NewOrderService(pool)
	secret := []byte("RL-INTEGRATION-SYNTHETIC-KEY-0123456789")
	eng := syncpkg.New(pool, rd, svc, wr)
	eng.ContactKey = syncpkg.DeriveContactKey(secret)
	h := New(rd, nil, auth.NewStore(pool), wr, svc, eng, nil)
	authWrap := mw.RequireAuth(&config.Config{AccessSecret: secret})
	router := chi.NewRouter()
	router.With(authWrap).Post("/sync/batch", h.SyncBatch)
	router.With(authWrap, mw.RequirePermission("process_refund")).Post("/orders/{id}/refund", h.RefundOrder)
	router.With(authWrap).Get("/orders/{id}", h.Order)
	router.With(authWrap).Get("/orders", h.Orders)
	router.With(authWrap).Get("/shifts/{id}", h.Shift)
	router.With(authWrap).Get("/shifts/current", h.CurrentShift)
	router.With(authWrap).Get("/reports/summary", h.ReportSummary)
	router.With(authWrap).Get("/refund-report", h.RefundReport)

	issue := func(user, role, outlet string, perms ...string) string {
		tok, err := auth.IssueAccess(secret, time.Hour, user, role, outlet, perms)
		if err != nil {
			t.Fatal(err)
		}
		return tok
	}
	const device = "00000000-0000-4000-8f76-0000000000d1"
	var idN int
	nextID := func(group string) string {
		idN++
		return fmt.Sprintf("00000000-0000-4000-8f76-%s%08d", group, idN)
	}
	outletN := 0
	newOutlet := func() rlOutlet {
		cur.Helper()
		outletN++
		o := rlOutlet{id: nextID("0a00"), user: nextID("0b00")}
		exec(`INSERT INTO outlets(id,name,erp_slug,erp_code) VALUES($1,$2,$3,$4)`, o.id, fmt.Sprintf("RL outlet %d", outletN), fmt.Sprintf("rl-%d", outletN), fmt.Sprintf("RL%d", outletN))
		exec(`INSERT INTO users(id,email,password_hash,display_name,role,outlet_id) VALUES($1,$2,'x','RL cashier','cashier',$3)`, o.user, fmt.Sprintf("rl%d@example.invalid", outletN), o.id)
		o.tok = issue(o.user, "cashier", o.id, "create_order", "process_refund")
		return o
	}
	adminAll := issue(nextID("0c00"), "admin", "")
	productN := 0
	newProduct := func(o rlOutlet, price float64) string {
		cur.Helper()
		productN++
		pid := nextID("0d00")
		exec(`INSERT INTO products(id,name) VALUES($1,$2)`, pid, fmt.Sprintf("RL product %d", productN))
		exec(`INSERT INTO product_variants(product_id,size,price,stock,sku,erp_slug) VALUES($1,'std',$2,0,$3,$4)`,
			pid, price, fmt.Sprintf("RLSKU%d", productN), fmt.Sprintf("rl-fg-%d", productN))
		exec(`INSERT INTO outlet_variant_stock(outlet_id,product_id,variant_size,stock) VALUES($1,$2,'std',1000)`, o.id, pid)
		return pid
	}
	stock := func(o rlOutlet, pid string) int {
		return int(num(`SELECT stock FROM outlet_variant_stock WHERE outlet_id=$1 AND product_id=$2 AND variant_size='std'`, o.id, pid))
	}
	line := func(pid string, qty int, price float64) map[string]any {
		return map[string]any{"productId": pid, "productName": "RL product", "variantSize": "std",
			"price": price, "quantity": qty, "subtotal": price * float64(qty)}
	}

	// ── transport ──
	call := func(method, path, token string, body any) (int, []byte) {
		cur.Helper()
		var rdr *bytes.Reader
		if body != nil {
			raw, err := json.Marshal(body)
			if err != nil {
				cur.Fatal(err)
			}
			rdr = bytes.NewReader(raw)
		} else {
			rdr = bytes.NewReader(nil)
		}
		r := httptest.NewRequest(method, path, rdr)
		r.Header.Set("Authorization", "Bearer "+token)
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		return w.Code, w.Body.Bytes()
	}
	env := func(o rlOutlet, shift string) map[string]any {
		e := map[string]any{"v": 1, "outletId": o.id, "userId": o.user, "deviceId": device,
			"capturedAt": time.Now().UTC().Format(time.RFC3339Nano), "offlineMs": time.Hour.Milliseconds()}
		if shift != "" {
			e["shiftId"] = shift
		}
		return e
	}
	batchN := 0
	send := func(o rlOutlet, typ, key string, payload map[string]any, shift string) map[string]any {
		cur.Helper()
		batchN++
		item := map[string]any{"type": typ, "idempotencyKey": device + ":" + key, "payload": payload, "envelope": env(o, shift)}
		code, raw := call("POST", "/sync/batch", o.tok, map[string]any{"items": []any{item}})
		var out struct {
			Data struct {
				Results []map[string]any `json:"results"`
			} `json:"data"`
		}
		if code != 200 || json.Unmarshal(raw, &out) != nil || len(out.Data.Results) != 1 {
			cur.Fatalf("batch %d %s", code, raw)
		}
		return out.Data.Results[0]
	}
	wantOK := func(name string, r map[string]any) {
		cur.Helper()
		if r["status"] != "ok" {
			cur.Fatalf("%s: want ok, got %v", name, r)
		}
	}
	wantRefusal := func(name string, r map[string]any, code string, contains ...string) {
		cur.Helper()
		if r["status"] != "error" || r["code"] != code || r["retryable"] != false {
			cur.Fatalf("%s: want non-retryable %s, got %v", name, code, r)
		}
		msg, _ := r["error"].(string)
		for _, c := range contains {
			if !strings.Contains(msg, c) {
				cur.Fatalf("%s: error %q lacks %q", name, msg, c)
			}
		}
	}

	// ── sales (real CreateOrder via sync) ──
	type saleOpt struct {
		items    []map[string]any
		customer string
		shift    string
		method   string
		extra    map[string]any
	}
	saleN := 0
	sell := func(o rlOutlet, s saleOpt) string {
		cur.Helper()
		saleN++
		method := s.method
		if method == "" {
			method = "cash"
		}
		p := map[string]any{"orderUuid": nextID("0e00"), "deviceId": device, "paymentMethod": method,
			"amountPaid": 100000000, "items": s.items}
		if s.customer != "" {
			p["customerId"] = s.customer
		}
		if s.shift != "" {
			p["shiftId"] = s.shift
		}
		for k, v := range s.extra {
			p[k] = v
		}
		res := send(o, "order", fmt.Sprintf("sale%d", saleN), p, "")
		wantOK("sale", res)
		id, _ := res["orderId"].(string)
		if id == "" {
			cur.Fatalf("sale returned no order id: %v", res)
		}
		return id
	}
	// legacyOrder inserts a pre-C4a style order directly: NULL line_no / net_amount.
	legacyN := 0
	legacyOrder := func(o rlOutlet, status string, pid string, total int, shift string) string {
		cur.Helper()
		legacyN++
		id := nextID("0f00")
		exec(`INSERT INTO orders(id,order_number,order_uuid,idempotency_key,outlet_id,cashier_id,cashier_name,subtotal,total,payment_method,status,shift_id)
			VALUES($1,$2,gen_random_uuid(),$3,$4,$5,'RL cashier',$6,$6,'cash',$7,NULLIF($8::text,'')::uuid)`,
			id, fmt.Sprintf("RLL-%d", legacyN), fmt.Sprintf("rl-legacy-%d", legacyN), o.id, o.user, total, status, shift)
		exec(`INSERT INTO order_items(order_id,product_id,product_name,variant_size,price,quantity,subtotal) VALUES($1,$2,'RL product','std',$3,2,$4)`,
			id, pid, total/2, total)
		return id
	}

	// ── refunds ──
	rp := func(order string, pairs ...[2]int) map[string]any {
		p := map[string]any{"orderId": order, "reason": "rusak", "deviceId": device, "orderUuid": nextID("1000")}
		if len(pairs) > 0 {
			items := []any{}
			for _, pr := range pairs {
				items = append(items, map[string]any{"lineNo": pr[0], "quantity": pr[1]})
			}
			p["items"] = items
		}
		return p
	}
	refundN := 0
	rf := func(o rlOutlet, p map[string]any, shift string) map[string]any {
		cur.Helper()
		refundN++
		return send(o, "refund", fmt.Sprintf("refund%d", refundN), p, shift)
	}
	direct := func(o rlOutlet, order string) (int, string) {
		cur.Helper()
		code, raw := call("POST", "/orders/"+order+"/refund", o.tok, map[string]any{"reason": "rusak"})
		return code, string(raw)
	}

	// ── readers ──
	refunds := func(order string) (out []rlRefundRow) {
		cur.Helper()
		rows, err := pool.Query(ctx, `SELECT id::text, seq, scope, COALESCE(amount_warning,''), ledger_document_key,
			round(amount)::bigint, round(computed_amount)::bigint, points_clawed, points_restored,
			COALESCE(round(claimed_amount)::bigint,-1)
			FROM order_refunds WHERE order_id=$1 ORDER BY seq`, order)
		if err != nil {
			cur.Fatal(err)
		}
		defer rows.Close()
		for rows.Next() {
			var r rlRefundRow
			if err := rows.Scan(&r.id, &r.seq, &r.scope, &r.warn, &r.key, &r.amount, &r.computed, &r.clawed, &r.restor, &r.claimed); err != nil {
				cur.Fatal(err)
			}
			out = append(out, r)
		}
		return
	}
	lines := func(order string) (out []rlLine) {
		cur.Helper()
		rows, err := pool.Query(ctx, `SELECT id::text, COALESCE(line_no,-1), quantity, COALESCE(round(net_amount)::bigint,-1), COALESCE(refund_group,'')
			FROM order_items WHERE order_id=$1 ORDER BY line_no NULLS LAST, id`, order)
		if err != nil {
			cur.Fatal(err)
		}
		defer rows.Close()
		for rows.Next() {
			var l rlLine
			if err := rows.Scan(&l.id, &l.no, &l.qty, &l.net, &l.group); err != nil {
				cur.Fatal(err)
			}
			out = append(out, l)
		}
		return
	}
	total := func(order string) int64 {
		cur.Helper()
		return num(`SELECT round(total)::bigint FROM orders WHERE id=$1`, order)
	}
	status := func(order string) string { cur.Helper(); return str(`SELECT status FROM orders WHERE id=$1`, order) }
	type cust struct{ points, spent, visits int64 }
	custRow := func(id string) (c cust) {
		cur.Helper()
		if err := pool.QueryRow(ctx, `SELECT points, round(total_spent)::bigint, visit_count FROM customers WHERE id=$1`, id).Scan(&c.points, &c.spent, &c.visits); err != nil {
			cur.Fatal(err)
		}
		return
	}
	// expectedAmount re-derives a partial refund's computed amount from the stored nets.
	expectedAmount := func(ls []rlLine, prior map[int]int, picks map[int]int) (sum int64) {
		for _, l := range ls {
			if k := picks[l.no]; k > 0 {
				sum += rlCum(l.net, l.qty, prior[l.no]+k) - rlCum(l.net, l.qty, prior[l.no])
			}
		}
		return
	}
	getData := func(token, path string) map[string]any {
		cur.Helper()
		code, raw := call("GET", path, token, nil)
		var out struct {
			Data map[string]any `json:"data"`
		}
		if code != 200 || json.Unmarshal(raw, &out) != nil || out.Data == nil {
			cur.Fatalf("GET %s: %d %s", path, code, raw)
		}
		return out.Data
	}
	// world is everything a refused / replayed refund must not touch.
	snap := func() string {
		cur.Helper()
		return str(`SELECT concat_ws('/',
			(SELECT count(*) FROM order_refunds), (SELECT count(*) FROM order_refund_items),
			(SELECT COALESCE(sum(quantity),0) FROM order_refund_items),
			(SELECT md5(COALESCE(string_agg(id::text||status, ',' ORDER BY id),'')) FROM orders),
			(SELECT COALESCE(sum(stock),0) FROM outlet_variant_stock),
			(SELECT COALESCE(sum(points),0) FROM customers), (SELECT COALESCE(sum(round(total_spent)),0) FROM customers),
			(SELECT COALESCE(sum(usage_count),0) FROM discount_codes),
			(SELECT count(*) FROM stock_movements), (SELECT count(*) FROM erp_outbox),
			(SELECT count(*) FROM point_transactions), (SELECT count(*) FROM operation_receipts))`)
	}
	snapNoReceipt := func() string {
		cur.Helper()
		return str(`SELECT concat_ws('/',
			(SELECT count(*) FROM order_refunds), (SELECT count(*) FROM order_refund_items),
			(SELECT md5(COALESCE(string_agg(id::text||status, ',' ORDER BY id),'')) FROM orders),
			(SELECT COALESCE(sum(stock),0) FROM outlet_variant_stock),
			(SELECT COALESCE(sum(points),0) FROM customers), (SELECT COALESCE(sum(round(total_spent)),0) FROM customers),
			(SELECT COALESCE(sum(usage_count),0) FROM discount_codes),
			(SELECT count(*) FROM stock_movements), (SELECT count(*) FROM erp_outbox))`)
	}

	// shifts
	shiftN := 0
	newShift := func(o rlOutlet, openedAt time.Time) string {
		cur.Helper()
		shiftN++
		id := nextID("1100")
		exec(`INSERT INTO shifts(id,outlet_id,cashier_id,cashier_name,status,opened_at,starting_cash) VALUES($1,$2,$3,'RL shift','open',$4,0)`, id, o.id, o.user, openedAt)
		return id
	}
	closeShift := func(o rlOutlet, id string) {
		cur.Helper()
		if err := svc.CloseShift(ctx, o.id, id, 0, nil); err != nil {
			cur.Fatal(err)
		}
	}
	type shiftRow struct {
		cashSales, totalSales, totalRefunds, cashRefundsPaid, totalOrders int64
		byMethod                                                          string
	}
	readShift := func(id string) (r shiftRow) {
		cur.Helper()
		if err := pool.QueryRow(ctx, `SELECT round(cash_sales)::bigint, round(total_sales)::bigint, round(total_refunds)::bigint,
			round(cash_refunds_paid)::bigint, total_orders, COALESCE(refunds_paid_by_method::text,'null') FROM shifts WHERE id=$1`, id).
			Scan(&r.cashSales, &r.totalSales, &r.totalRefunds, &r.cashRefundsPaid, &r.totalOrders, &r.byMethod); err != nil {
			cur.Fatal(err)
		}
		return
	}
	jsonEq := func(got, want string) bool {
		var a, b any
		return json.Unmarshal([]byte(got), &a) == nil && json.Unmarshal([]byte(want), &b) == nil && fmt.Sprint(a) == fmt.Sprint(b)
	}
	type summary struct {
		TotalSales, GrossSales, TotalRefunds, NetSales float64
		TotalOrders, RefundedOrders                    int
		ByPay                                          map[string]float64 `json:"byPaymentMethod"`
		RefundsBy                                      map[string]float64 `json:"refundsByPaymentMethod"`
		Daily                                          []struct {
			Date                                 string
			Sales, GrossSales, Refunds, NetSales float64
			Orders, GrossOrders, RefundedOrders  int
		} `json:"dailySales"`
	}
	summaryOf := func(outlet, q string) (s summary) {
		cur.Helper()
		code, raw := call("GET", "/reports/summary?outletId="+outlet+q, adminAll, nil)
		var out struct{ Data summary }
		if code != 200 || json.Unmarshal(raw, &out) != nil {
			cur.Fatalf("summary %d %s", code, raw)
		}
		return out.Data
	}
	enableTaxLoyalty := func() func() {
		exec(`UPDATE app_settings SET tax_enabled=true, tax_rate=11, rounding_enabled=true, rounding_type='nearest_1000' WHERE id=1`)
		exec(`UPDATE loyalty_settings SET enabled=true, points_per_thousand=1, redemption_rate=100 WHERE id=1`)
		return func() {
			exec(`UPDATE app_settings SET tax_enabled=false, tax_rate=0, rounding_enabled=false, rounding_type='none' WHERE id=1`)
			exec(`UPDATE loyalty_settings SET enabled=false, points_per_thousand=0, redemption_rate=0 WHERE id=1`)
		}
	}
	newCustomer := func(points int) string {
		cur.Helper()
		id := nextID("1200")
		exec(`INSERT INTO customers(id,name,phone,points) VALUES($1,'RL customer',$2,$3)`, id, fmt.Sprintf("rl-%d", idN), points)
		return id
	}

	amountCheck := func(r rlRefundRow, want int64) string {
		if r.amount != want || r.computed != want || r.warn != "" {
			return fmt.Sprintf("refund row %+v want amount=computed=%d and no warning", r, want)
		}
		return ""
	}

	// ─────────────────────────────────────────────────────────────────────────────
	sub("1 two partial refunds then a final one: sums, statuses, stock, points, code usage, aggregates", func(t *testing.T) {
		defer enableTaxLoyalty()()
		o := newOutlet()
		pA, pB, pC, pD := newProduct(o, 100000), newProduct(o, 55000), newProduct(o, 30000), newProduct(o, 20000)
		cu := newCustomer(200)
		const code = "RLCODE1"
		exec(`INSERT INTO discount_codes(code,type,value,per_customer_limit,usage_limit) VALUES($1,'fixed',1000,1,100)`, code)
		oid := sell(o, saleOpt{customer: cu,
			items: []map[string]any{line(pA, 2, 100000), line(pB, 3, 55000), line(pC, 1, 30000)},
			extra: map[string]any{"discountType": "percentage", "discountValue": 10, "discountCodes": []string{code}, "pointsRedeemed": 50}})
		tot := total(oid)
		earned := num(`SELECT points_earned FROM orders WHERE id=$1`, oid)
		redeemed := num(`SELECT points_redeemed FROM orders WHERE id=$1`, oid)
		ls := lines(oid)
		var sumNet int64
		for i, l := range ls {
			sumNet += l.net
			if l.no != i || l.net <= 0 {
				t.Fatalf("sale line %d: line_no=%d net=%d", i, l.no, l.net)
			}
		}
		if sumNet != tot || tot <= 0 || earned <= 0 || redeemed != 50 {
			t.Fatalf("sale: total=%d sum(net)=%d earned=%d redeemed=%d", tot, sumNet, earned, redeemed)
		}
		if status(oid) != "completed" || num(`SELECT discount_amount::bigint FROM orders WHERE id=$1`, oid) <= 0 {
			t.Fatal("sale should be completed with a discount")
		}
		stA0, stB0, stC0 := stock(o, pA), stock(o, pB), stock(o, pC)
		c0 := custRow(cu)
		usage0 := num(`SELECT usage_count FROM discount_codes WHERE code=$1`, code)
		if c0.visits != 1 || c0.spent <= 0 {
			t.Fatalf("sale aggregates: %+v", c0)
		}

		prior := map[int]int{}
		var sumClawed, sumRestored, sumAmount int64
		step := func(name string, picks map[int]int, pairs ...[2]int) rlRefundRow {
			cur.Helper()
			before := custRow(cu)
			res := rf(o, rp(oid, pairs...), "")
			wantOK(name, res)
			rs := refunds(oid)
			r := rs[len(rs)-1]
			for ln, k := range picks {
				prior[ln] += k
			}
			sumClawed += r.clawed
			sumRestored += r.restor
			sumAmount += r.amount
			after := custRow(cu)
			if after.points != before.points-r.clawed+r.restor || after.spent != before.spent-r.amount || after.visits != c0.visits {
				cur.Fatalf("%s: customer before=%+v after=%+v refund=%+v", name, before, after, r)
			}
			if got := num(`SELECT usage_count FROM discount_codes WHERE code=$1`, code); name != "R3" && got != usage0 {
				cur.Fatalf("%s: usage_count %d want %d (restored only by the completing refund, D-38)", name, got, usage0)
			}
			return r
		}
		// R1: line0 x1, line1 x1
		pick1 := map[int]int{0: 1, 1: 1}
		want1 := expectedAmount(ls, map[int]int{}, pick1)
		r1 := step("R1", pick1, [2]int{0, 1}, [2]int{1, 1})
		if res := amountCheck(r1, want1); res != "" {
			t.Fatal(res)
		}
		if r1.scope != "partial" || r1.seq != 1 || status(oid) != "partially_refunded" {
			t.Fatalf("R1: %+v status=%s", r1, status(oid))
		}
		if str(`SELECT refund_reason FROM orders WHERE id=$1`, oid) != "" || num(`SELECT count(*) FROM orders WHERE id=$1 AND refunded_at IS NULL AND refund_shift_id IS NULL AND refunded_by IS NULL`, oid) != 1 {
			t.Fatal("R1: orders.refund_* must stay empty until the completing refund")
		}
		if r1.clawed != earned*r1.computed/tot || r1.restor != redeemed*r1.computed/tot {
			t.Fatalf("R1 points: clawed=%d restored=%d, earned=%d redeemed=%d computed=%d total=%d", r1.clawed, r1.restor, earned, redeemed, r1.computed, tot)
		}
		if stock(o, pA) != stA0+1 || stock(o, pB) != stB0+1 || stock(o, pC) != stC0 {
			t.Fatal("R1 restock must equal the refunded units only")
		}
		od := getData(adminAll, "/orders/"+oid)
		if od["status"] != "partially_refunded" || od["refundedAmount"] != float64(r1.amount) {
			t.Fatalf("order read after R1: status=%v refundedAmount=%v want %d", od["status"], od["refundedAmount"], r1.amount)
		}
		if rfs, _ := od["refunds"].([]any); len(rfs) != 1 {
			t.Fatalf("order read refunds: %v", od["refunds"])
		}
		if its, _ := od["items"].([]any); len(its) != 3 || its[0].(map[string]any)["refundedQty"] != float64(1) || its[2].(map[string]any)["refundedQty"] != float64(0) {
			t.Fatalf("order read items: %v", od["items"])
		}

		// R2: line1 x1, line2 x1
		pick2 := map[int]int{1: 1, 2: 1}
		want2 := expectedAmount(ls, map[int]int{0: 1, 1: 1}, pick2)
		r2 := step("R2", pick2, [2]int{1, 1}, [2]int{2, 1})
		if res := amountCheck(r2, want2); res != "" {
			t.Fatal(res)
		}
		cum2 := r1.computed + r2.computed
		if r2.seq != 2 || status(oid) != "partially_refunded" || r1.clawed+r2.clawed != earned*cum2/tot || r1.restor+r2.restor != redeemed*cum2/tot {
			t.Fatalf("R2: %+v status=%s", r2, status(oid))
		}
		if stock(o, pA) != stA0+1 || stock(o, pB) != stB0+2 || stock(o, pC) != stC0+1 {
			t.Fatal("R2 restock must equal the refunded units only")
		}
		// D-38: the partly refunded order still holds the per-customer cap slot. The sync path is
		// offline-lenient, so the cap shows as a discount warning on the new sale.
		probe := sell(o, saleOpt{customer: cu, items: []map[string]any{line(pD, 1, 20000)},
			extra: map[string]any{"discountCodes": []string{code}}})
		if num(`SELECT count(*) FROM orders WHERE id=$1 AND discount_warning`, probe) != 1 {
			t.Fatalf("a part-refunded order must still count for the per-customer cap: %s", str(`SELECT COALESCE(discount_warning_reason,'') FROM orders WHERE id=$1`, probe))
		}
		c0 = custRow(cu) // the probe sale added a visit
		usageBefore3 := num(`SELECT usage_count FROM discount_codes WHERE code=$1`, code)
		usage0 = usageBefore3 // R3 is the only step that may change it

		// R3: completes the order
		before3 := custRow(cu)
		pick3 := map[int]int{0: 1, 1: 1}
		r3 := step("R3", pick3, [2]int{0, 1}, [2]int{1, 1})
		_ = before3
		if r3.scope != "partial" || r3.seq != 3 || status(oid) != "refunded" {
			t.Fatalf("R3 must complete the order: %+v status=%s", r3, status(oid))
		}
		if sumAmount != tot || r3.amount != tot-r1.computed-r2.computed {
			t.Fatalf("sum of refunds %d must equal total %d exactly (R3=%d)", sumAmount, tot, r3.amount)
		}
		if sumClawed != earned || sumRestored != redeemed {
			t.Fatalf("D-37: clawed=%d earned=%d restored=%d redeemed=%d", sumClawed, earned, sumRestored, redeemed)
		}
		if stock(o, pA) != stA0+2 || stock(o, pB) != stB0+3 || stock(o, pC) != stC0+1 {
			t.Fatal("after the final refund every sold unit is back")
		}
		if num(`SELECT count(*) FROM orders WHERE id=$1 AND refund_reason='rusak' AND refunded_at IS NOT NULL AND refunded_by=$2::uuid`, oid, o.user) != 1 {
			t.Fatal("the completing refund must write orders.refund_*")
		}
		if got := num(`SELECT usage_count FROM discount_codes WHERE code=$1`, code); got != usageBefore3-1 {
			t.Fatalf("D-38: usage restored on the completing refund only: %d want %d", got, usageBefore3-1)
		}
		if got := num(`SELECT count(*) FROM orders WHERE customer_id=$1 AND status IN ('completed','partially_refunded') AND jsonb_exists(applied_discount_codes,$2)`, cu, code); got != 1 {
			t.Fatalf("after the final refund only the probe sale holds the cap slot, got %d", got)
		}
		od = getData(adminAll, "/orders/"+oid)
		if od["status"] != "refunded" || od["refundedAmount"] != float64(tot) {
			t.Fatalf("order read after R3: %v %v", od["status"], od["refundedAmount"])
		}
	})

	// ─────────────────────────────────────────────────────────────────────────────
	sub("2 concurrent partial refunds of the same line from two keys: exactly one passes the quantity guard", func(t *testing.T) {
		o := newOutlet()
		pA, pB := newProduct(o, 50000), newProduct(o, 30000)
		oid := sell(o, saleOpt{items: []map[string]any{line(pA, 2, 50000), line(pB, 1, 30000)}})
		stA := stock(o, pA)
		start := make(chan struct{})
		var wg sync.WaitGroup
		results := make([]map[string]any, 2)
		// Everything that touches shared test state (nextID, env) is built BEFORE the goroutines
		// start, so they only send: no data race, and two distinct client refund uuids.
		bodies := make([][]byte, 2)
		for i := range bodies {
			item := map[string]any{"type": "refund", "idempotencyKey": fmt.Sprintf("%s:conc-%d", device, i), "payload": rp(oid, [2]int{0, 2}), "envelope": env(o, "")}
			raw, err := json.Marshal(map[string]any{"items": []any{item}})
			if err != nil {
				t.Fatal(err)
			}
			bodies[i] = raw
		}
		for i := range results {
			wg.Add(1)
			go func() {
				defer wg.Done()
				<-start
				raw := bodies[i]
				r := httptest.NewRequest("POST", "/sync/batch", bytes.NewReader(raw))
				r.Header.Set("Authorization", "Bearer "+o.tok)
				w := httptest.NewRecorder()
				router.ServeHTTP(w, r)
				var out struct {
					Data struct {
						Results []map[string]any `json:"results"`
					} `json:"data"`
				}
				if w.Code == 200 && json.Unmarshal(w.Body.Bytes(), &out) == nil && len(out.Data.Results) == 1 {
					results[i] = out.Data.Results[0]
				}
			}()
		}
		close(start)
		wg.Wait()
		okN, lost := 0, 0
		for _, r := range results {
			switch {
			case r == nil:
				t.Fatal("a concurrent refund got no result")
			case r["status"] == "ok":
				okN++
			case r["code"] == "conflict" && r["retryable"] == false && strings.Contains(fmt.Sprint(r["error"]), "melebihi") && strings.Contains(fmt.Sprint(r["error"]), "jangan bayar ulang"):
				lost++
			default:
				t.Fatalf("unexpected concurrent result: %v", r)
			}
		}
		if okN != 1 || lost != 1 {
			t.Fatalf("exactly one refund may pass: ok=%d lost=%d (%v)", okN, lost, results)
		}
		if stock(o, pA) != stA+2 || len(refunds(oid)) != 1 || status(oid) != "partially_refunded" {
			t.Fatalf("stock must be restocked once: %d want %d, refunds=%d status=%s", stock(o, pA), stA+2, len(refunds(oid)), status(oid))
		}
	})

	// ─────────────────────────────────────────────────────────────────────────────
	sub("3 legacy payload, legacy orders, direct route", func(t *testing.T) {
		o := newOutlet()
		pA, pB := newProduct(o, 50000), newProduct(o, 30000)
		// legacy payload on a partially_refunded order: conflict, warning, nothing changes
		oid := sell(o, saleOpt{items: []map[string]any{line(pA, 2, 50000), line(pB, 1, 30000)}})
		wantOK("partial", rf(o, rp(oid, [2]int{0, 1}), ""))
		before := snap()
		wantRefusal("legacy on part-refunded", rf(o, rp(oid), ""), "conflict", "Perbarui aplikasi", "jangan bayar ulang")
		if snap() != before {
			t.Fatal("a refused legacy refund had effects")
		}
		// the direct route (legacy shape) on a part-refunded order is a 409 with no effects
		if code, body := direct(o, oid); code != 409 || !strings.Contains(body, "jangan bayar ulang") || snap() != before {
			t.Fatalf("direct on partially_refunded: %d %s", code, body)
		}
		// direct route on a completed real sale works
		d := sell(o, saleOpt{items: []map[string]any{line(pA, 1, 50000)}})
		sA := stock(o, pA)
		if code, body := direct(o, d); code != 201 {
			t.Fatalf("direct on completed: %d %s", code, body)
		}
		rs := refunds(d)
		if status(d) != "refunded" || len(rs) != 1 || rs[0].scope != "full" || rs[0].amount != total(d) || stock(o, pA) != sA+1 {
			t.Fatalf("direct whole refund: status=%s rows=%+v", status(d), rs)
		}
		// pre-C4a order (NULL line_no/net_amount): legacy payload still refunds the whole order
		lo := legacyOrder(o, "completed", pA, 80000, "")
		lsA := stock(o, pA)
		wantOK("legacy order, legacy payload", rf(o, rp(lo), ""))
		lrs := refunds(lo)
		if status(lo) != "refunded" || len(lrs) != 1 || lrs[0].scope != "full" || lrs[0].amount != 80000 || stock(o, pA) != lsA+2 {
			t.Fatalf("legacy whole refund: status=%s rows=%+v stock=%d want %d", status(lo), lrs, stock(o, pA), lsA+2)
		}
		// items payload on an order with NULL line_no: Rejected, whole order only
		lo2 := legacyOrder(o, "completed", pA, 80000, "")
		before = snap()
		wantRefusal("items on legacy order", rf(o, rp(lo2, [2]int{0, 1}), ""), "rejected", "Transaksi lama hanya bisa direfund seluruhnya", "jangan bayar ulang")
		if snap() != before || status(lo2) != "completed" {
			t.Fatal("a refused items refund on a legacy order had effects")
		}
	})

	// ─────────────────────────────────────────────────────────────────────────────
	sub("4 replay, key conflict, client uuid defence, malformed items", func(t *testing.T) {
		o := newOutlet()
		pA, pB := newProduct(o, 50000), newProduct(o, 30000)
		oid := sell(o, saleOpt{items: []map[string]any{line(pA, 2, 50000), line(pB, 1, 30000)}})
		other := sell(o, saleOpt{items: []map[string]any{line(pB, 1, 30000)}})

		first := rp(oid, [2]int{0, 1})
		refundN++
		key := fmt.Sprintf("replay%d", refundN)
		r1 := send(o, "refund", key, first, "")
		wantOK("first", r1)
		if r1["refundState"] != "partial" {
			t.Fatalf("partial refund ack: %v", r1)
		}
		after := snap()
		again := send(o, "refund", key, first, "")
		wantOK("replay", again)
		if again["refundState"] != "partial" || again["orderId"] != r1["orderId"] || snap() != after {
			t.Fatalf("same-key replay: %v (world changed=%v)", again, snap() != after)
		}
		// altered body under the same key
		altered := rp(oid, [2]int{0, 2})
		altered["orderUuid"] = first["orderUuid"]
		wantRefusal("altered body", send(o, "refund", key, altered, ""), "key_conflict")
		if snap() != after {
			t.Fatal("key_conflict had effects")
		}
		// (device_id, client_refund_uuid) defence: another key, same uuid => no-op success
		dupe := rp(oid, [2]int{0, 1})
		dupe["orderUuid"] = first["orderUuid"]
		beforeDupe := snapNoReceipt()
		d := rf(o, dupe, "")
		wantOK("same pair again", d)
		if d["refundState"] != "partial" || snapNoReceipt() != beforeDupe || len(refunds(oid)) != 1 {
			t.Fatalf("same (device, uuid) must be a no-op success: %v rows=%d", d, len(refunds(oid)))
		}
		// the same pair naming a DIFFERENT order is a mismatch, never a replay
		mism := rp(other, [2]int{0, 1})
		mism["orderUuid"] = first["orderUuid"]
		bm := snap()
		wantRefusal("pair on another order", rf(o, mism, ""), "rejected", "jangan bayar ulang")
		if snap() != bm {
			t.Fatal("mismatch had effects")
		}
		// a replayed completing refund keeps refundState full
		fin := rp(oid, [2]int{0, 1}, [2]int{1, 1})
		refundN++
		fkey := fmt.Sprintf("final%d", refundN)
		fr := send(o, "refund", fkey, fin, "")
		wantOK("final", fr)
		if fr["refundState"] != "full" || status(oid) != "refunded" {
			t.Fatalf("completing refund: %v status=%s", fr, status(oid))
		}
		fa := snap()
		fr2 := send(o, "refund", fkey, fin, "")
		if fr2["status"] != "ok" || fr2["refundState"] != "full" || snap() != fa {
			t.Fatalf("replay of the completing refund: %v", fr2)
		}

		// malformed items: nothing changes, every refusal carries the warning
		o2 := sell(o, saleOpt{items: []map[string]any{line(pA, 2, 50000), line(pB, 1, 30000)}})
		bad := func(name, code, contains string, items any) {
			cur.Helper()
			p := rp(o2)
			p["items"] = items
			b := snap()
			wantRefusal(name, rf(o, p, ""), code, contains, "jangan bayar ulang")
			if snap() != b {
				cur.Fatalf("%s had effects", name)
			}
		}
		bad("missing lineNo", "rejected", "tidak dikenal", []any{map[string]any{"quantity": 1}})
		bad("missing quantity", "rejected", "tidak dikenal", []any{map[string]any{"lineNo": 0}})
		bad("quantity 0", "rejected", "tidak dikenal", []any{map[string]any{"lineNo": 0, "quantity": 0}})
		bad("negative quantity", "rejected", "tidak dikenal", []any{map[string]any{"lineNo": 0, "quantity": -1}})
		bad("duplicate lineNo", "rejected", "tidak dikenal", []any{map[string]any{"lineNo": 0, "quantity": 1}, map[string]any{"lineNo": 0, "quantity": 1}})
		bad("unknown lineNo", "rejected", "tidak dikenal", []any{map[string]any{"lineNo": 9, "quantity": 1}})
		bad("empty items", "rejected", "tidak dikenal", []any{})
		bad("quantity above remaining", "conflict", "melebihi", []any{map[string]any{"lineNo": 0, "quantity": 3}})
		p := rp(o2, [2]int{0, 1})
		p["reasonCode"] = "Rusak!"
		b := snap()
		wantRefusal("bad reasonCode", rf(o, p, ""), "rejected", "jangan bayar ulang")
		if snap() != b {
			t.Fatal("bad reasonCode had effects")
		}
		// after refunding 1 of 2 units, asking for 2 more is over the remainder
		wantOK("take one", rf(o, rp(o2, [2]int{0, 1}), ""))
		b = snap()
		wantRefusal("over the remainder", rf(o, rp(o2, [2]int{0, 2}), ""), "conflict", "melebihi")
		if snap() != b {
			t.Fatal("over-remainder had effects")
		}
	})

	// ─────────────────────────────────────────────────────────────────────────────
	sub("5 groups: bundle/BXGY all-or-nothing, loyalty reward alone, giveaway bag never refunded", func(t *testing.T) {
		o := newOutlet()
		pBuy, pGet, pPlain := newProduct(o, 100000), newProduct(o, 110000), newProduct(o, 40000)
		promo := nextID("1300")
		exec(`INSERT INTO promotions(id,name,type,value,bxgy_config) VALUES($1,'RL BXGY','buy_x_get_y',0,$2::jsonb)`, promo,
			fmt.Sprintf(`{"buyQuantity":1,"getQuantity":1,"buyProductIds":["%s"],"getProductIds":["%s"],"getDiscountKind":"percentage","getDiscountValue":50}`, pBuy, pGet))
		reward := line(pGet, 1, 55000)
		reward["isReward"] = true
		reward["rewardPromotionId"] = promo
		oid := sell(o, saleOpt{items: []map[string]any{line(pBuy, 1, 100000), reward, line(pPlain, 1, 40000)},
			extra: map[string]any{"promotionId": promo}})
		ls := lines(oid)
		if len(ls) != 3 || ls[0].group == "" || ls[0].group != ls[1].group || ls[2].group != "" || !strings.HasPrefix(ls[0].group, "bxgy:"+promo) {
			t.Fatalf("groups written at sale time: %+v", ls)
		}
		b := snap()
		wantRefusal("only the paid buy line", rf(o, rp(oid, [2]int{0, 1}), ""), "rejected", "bersamaan", "jangan bayar ulang")
		wantRefusal("only the reward line", rf(o, rp(oid, [2]int{1, 1}), ""), "rejected", "bersamaan")
		if snap() != b {
			t.Fatal("a split group refund had effects")
		}
		sPlain, sBuy, sGet := stock(o, pPlain), stock(o, pBuy), stock(o, pGet)
		wantOK("the ungrouped line alone", rf(o, rp(oid, [2]int{2, 1}), ""))
		wantRefusal("buy line alone after another refund", rf(o, rp(oid, [2]int{0, 1}), ""), "rejected", "bersamaan")
		wantOK("the whole group together", rf(o, rp(oid, [2]int{0, 1}, [2]int{1, 1}), ""))
		rs := refunds(oid)
		var sum int64
		for _, r := range rs {
			sum += r.amount
		}
		if len(rs) != 2 || sum != total(oid) || status(oid) != "refunded" ||
			stock(o, pPlain) != sPlain+1 || stock(o, pBuy) != sBuy+1 || stock(o, pGet) != sGet+1 {
			t.Fatalf("group refund: rows=%+v sum=%d total=%d status=%s", rs, sum, total(oid), status(oid))
		}

		// D-35: a loyalty reward line (Rp0) is refundable on its own, ungrouped.
		defer exec(`DELETE FROM loyalty_conditions`)
		defer exec(`UPDATE loyalty_settings SET enabled=false, points_per_thousand=0 WHERE id=1`)
		exec(`UPDATE loyalty_settings SET enabled=true, points_per_thousand=1 WHERE id=1`)
		pGift := newProduct(o, 25000)
		cond := nextID("1400")
		exec(`INSERT INTO loyalty_conditions(id,name,type,trigger,reward_type,reward_product_ids,minimum_spend)
			VALUES($1,'RL gift','always_on','spending_threshold','product_reward',$2::jsonb,1)`, cond, `["`+pGift+`"]`)
		cu := newCustomer(0)
		gift := line(pGift, 1, 0)
		gift["isReward"] = true
		gift["rewardConditionId"] = cond
		lo := sell(o, saleOpt{customer: cu, items: []map[string]any{line(pPlain, 1, 40000), gift}})
		lls := lines(lo)
		if len(lls) != 2 || lls[1].group != "" || lls[1].net != 0 || num(`SELECT count(*) FROM loyalty_condition_applications WHERE order_id=$1`, lo) != 1 {
			t.Fatalf("loyalty reward sale: lines=%+v", lls)
		}
		sGift := stock(o, pGift)
		wantOK("reward line alone", rf(o, rp(lo, [2]int{1, 1}), ""))
		lrs := refunds(lo)
		if len(lrs) != 1 || lrs[0].amount != 0 || status(lo) != "partially_refunded" || stock(o, pGift) != sGift+1 {
			t.Fatalf("reward line alone: rows=%+v status=%s", lrs, status(lo))
		}
		wantOK("then the paid line", rf(o, rp(lo, [2]int{0, 1}), ""))
		if status(lo) != "refunded" {
			t.Fatal("the paid line completes the order")
		}

		// D-41: the C3 giveaway bag is not an order line: never refunded, never restocked.
		pBag := newProduct(o, 10000)
		exec(`INSERT INTO outlet_giveaways(outlet_id,product_id,variant_size) VALUES($1,$2,'std')`, o.id, pBag)
		defer exec(`DELETE FROM outlet_giveaways WHERE outlet_id=$1`, o.id)
		bagStart := stock(o, pBag)
		go1 := sell(o, saleOpt{items: []map[string]any{line(pPlain, 1, 40000)}})
		if stock(o, pBag) != bagStart-1 || num(`SELECT count(*) FROM stock_movements WHERE dedupe_key=$1`, "giveaway:"+go1) != 1 {
			t.Fatal("the sale must have given away one bag")
		}
		wantOK("refund the whole sale", rf(o, rp(go1, [2]int{0, 1}), ""))
		if stock(o, pBag) != bagStart-1 || num(`SELECT count(*) FROM stock_movements WHERE kind='refund' AND product_id=$1`, pBag) != 0 ||
			num(`SELECT count(*) FROM order_items WHERE order_id=$1 AND product_id=$2`, go1, pBag) != 0 {
			t.Fatal("the giveaway bag must never be refunded or restocked (D-41)")
		}
	})

	// ─────────────────────────────────────────────────────────────────────────────
	sub("6 ledger keys, one erp_outbox row per refund, ERP tender and lines from the refund row", func(t *testing.T) {
		o := newOutlet()
		pA, pB := newProduct(o, 50000), newProduct(o, 30000)
		oid := sell(o, saleOpt{items: []map[string]any{line(pA, 2, 50000), line(pB, 1, 30000)}})
		ls := lines(oid)
		wantOK("R1", rf(o, rp(oid, [2]int{0, 1}), ""))
		wantOK("R2", rf(o, rp(oid, [2]int{0, 1}, [2]int{1, 1}), ""))
		rs := refunds(oid)
		if len(rs) != 2 || rs[0].amount != 50000 || rs[1].amount != 80000 || rs[0].amount+rs[1].amount != total(oid) {
			t.Fatalf("refund rows: %+v total=%d", rs, total(oid))
		}
		// distinct documents keyed refund:<refundId>, never the legacy refund:<orderId>
		for _, r := range rs {
			if r.key != "refund:"+r.id || r.key == "refund:"+oid {
				t.Fatalf("ledger_document_key %q for refund %s", r.key, r.id)
			}
			if num(`SELECT count(*) FROM erp_outbox WHERE doc_key=$1 AND kind='refund' AND ref_id=$2`, r.key, oid) != 1 {
				t.Fatalf("exactly one erp_outbox row for %s", r.key)
			}
		}
		if num(`SELECT count(*) FROM erp_outbox WHERE kind='refund' AND ref_id=$1`, oid) != 2 ||
			num(`SELECT count(DISTINCT document_id) FROM stock_movements WHERE kind='refund' AND ref_id=$1`, oid) != 2 {
			t.Fatal("one outbox row and one ledger document per refund")
		}
		// line dedupe keys refund:<refundId>:<orderItemId>; qty = refunded qty only
		want := map[string]int{
			"refund:" + rs[0].id + ":" + ls[0].id: 1,
			"refund:" + rs[1].id + ":" + ls[0].id: 1,
			"refund:" + rs[1].id + ":" + ls[1].id: 1,
		}
		rows, err := pool.Query(ctx, `SELECT dedupe_key, qty FROM stock_movements WHERE kind='refund' AND ref_id=$1`, oid)
		if err != nil {
			t.Fatal(err)
		}
		got := map[string]int{}
		for rows.Next() {
			var k string
			var q int
			if err := rows.Scan(&k, &q); err != nil {
				t.Fatal(err)
			}
			got[k] = q
		}
		rows.Close()
		if fmt.Sprint(got) != fmt.Sprint(want) {
			t.Fatalf("refund ledger lines %v want %v", got, want)
		}
		// the ERP wire document, built exactly as the relay does
		build := func(docKey string) erp.StockDocument {
			cur.Helper()
			var hd erp.OutboxHeader
			if err := pool.QueryRow(ctx, `SELECT id::text, document_id::text, kind, location_type, location_id::text, ref_type, ref_id::text,
			    coalesce(ref_number,''), part, part_count, created_at FROM erp_outbox WHERE doc_key=$1`, docKey).
				Scan(&hd.ID, &hd.DocumentID, &hd.Kind, &hd.LocationType, &hd.LocationID, &hd.RefType, &hd.RefID, &hd.RefNumber, &hd.Part, &hd.PartCount, &hd.CreatedAt); err != nil {
				cur.Fatalf("outbox row %s: %v", docKey, err)
			}
			in, err := erp.LoadBuildInput(ctx, pool, hd, "mandalika")
			if err != nil {
				cur.Fatal(err)
			}
			doc, hold, err := erp.BuildDocument(in)
			if err != nil || hold != "" {
				cur.Fatalf("BuildDocument %s: hold=%q err=%v", docKey, hold, err)
			}
			return doc
		}
		for i, r := range rs {
			doc := build(r.key)
			wantTender := -r.amount
			if len(doc.Tenders) != 1 || doc.Tenders[0].Amount != wantTender || doc.Tenders[0].Method != "cash" || doc.Tenders[0].Amount == -total(oid) {
				t.Fatalf("refund %d tender %+v, want -%d (not -order.Total %d)", i+1, doc.Tenders, r.amount, total(oid))
			}
			if len(doc.Lines) != []int{1, 2}[i] {
				t.Fatalf("refund %d lines %d", i+1, len(doc.Lines))
			}
			for _, l := range doc.Lines {
				if l.Qty != 1 || l.RefundOfMovementID == "" || l.UnitPrice == nil {
					t.Fatalf("refund %d line %+v: qty = refunded qty, linked to the sale movement, gross unit price", i+1, l)
				}
				if num(`SELECT count(*) FROM stock_movements WHERE id=$1::uuid AND kind='sale'`, l.RefundOfMovementID) != 1 {
					t.Fatalf("refund_of %s is not a sale movement", l.RefundOfMovementID)
				}
			}
		}
		// a legacy whole refund written directly (fixture/old revision) keeps the legacy key shape
		lo := legacyOrder(o, "completed", pA, 80000, "")
		exec(`UPDATE orders SET status='refunded', refund_reason='old', refunded_at=now() WHERE id=$1`, lo)
		lr := refunds(lo)
		if len(lr) != 1 || lr[0].key != "refund:"+lo || lr[0].scope != "legacy_full" {
			t.Fatalf("legacy row: %+v", lr)
		}
	})

	// ─────────────────────────────────────────────────────────────────────────────
	sub("7 the amount is a captured fact (D-39, capped by D-49) and shift/report totals agree (F1 fixture)", func(t *testing.T) {
		o := newOutlet()
		pA, pB := newProduct(o, 30000), newProduct(o, 70000)
		s := newShift(o, time.Now())
		oid := sell(o, saleOpt{shift: s, items: []map[string]any{line(pA, 1, 30000), line(pB, 1, 70000)}})
		if total(oid) != 100000 {
			t.Fatalf("fixture total %d", total(oid))
		}
		claim := func(p map[string]any, amount int) map[string]any { p["refundAmount"] = amount; return p }
		wantOK("R1 claimed 25000", rf(o, claim(rp(oid, [2]int{0, 1}), 25000), s))
		wantOK("R2 pays 70000", rf(o, claim(rp(oid, [2]int{1, 1}), 70000), s))
		rs := refunds(oid)
		if len(rs) != 2 || rs[0].amount != 25000 || rs[0].computed != 30000 || rs[0].warn != "amount_mismatch" ||
			rs[1].amount != 70000 || rs[1].computed != 70000 || rs[1].warn != "" || status(oid) != "refunded" {
			t.Fatalf("captured amounts: %+v status=%s", rs, status(oid))
		}
		od := getData(adminAll, "/orders/"+oid)
		if od["refundedAmount"] != float64(95000) {
			t.Fatalf("order read refundedAmount=%v want 95000", od["refundedAmount"])
		}
		// Reasoned expectation: net sale = total - sum(refunds) = 100000 - 95000 = 5000 stays in sales
		// (UNCLAMPED); total_refunds is the gross 95000; both refunds were paid by the SALE's own
		// shift, so nothing is an other-shift cash refund.
		closeShift(o, s)
		sr := readShift(s)
		if sr.totalSales != 5000 || sr.cashSales != 5000 || sr.totalRefunds != 95000 || sr.cashRefundsPaid != 0 || sr.totalOrders != 0 || !jsonEq(sr.byMethod, `{}`) {
			t.Fatalf("shift close: %+v", sr)
		}
		sm := summaryOf(o.id, "")
		if sm.TotalSales != 5000 || sm.GrossSales != 100000 || sm.TotalRefunds != 95000 || sm.NetSales != 5000 || sm.RefundedOrders != 1 ||
			sm.TotalSales+sm.TotalRefunds != sm.GrossSales || sm.ByPay["cash"] != 5000 || sm.RefundsBy["cash"] != 95000 {
			t.Fatalf("report summary: %+v", sm)
		}
		if len(sm.Daily) != 1 || sm.Daily[0].NetSales != 5000 || sm.Daily[0].GrossSales != 100000 || sm.Daily[0].Refunds != 95000 {
			t.Fatalf("daily rows: %+v", sm.Daily)
		}
		// within Rp1 is no mismatch
		o4 := sell(o, saleOpt{items: []map[string]any{line(pA, 1, 30000), line(pB, 1, 70000)}})
		wantOK("within tolerance", rf(o, claim(rp(o4, [2]int{0, 1}), 30001), ""))
		if r := refunds(o4)[0]; r.amount != 30001 || r.warn != "" {
			t.Fatalf("Rp1 slack: %+v", r)
		}
		// completing refund claims more than is left: still commits, flagged over_total, capped (D-49)
		o2 := sell(o, saleOpt{items: []map[string]any{line(pA, 1, 30000), line(pB, 1, 70000)}})
		wantOK("o2 R1", rf(o, claim(rp(o2, [2]int{0, 1}), 30000), ""))
		wantOK("o2 R2 over total", rf(o, claim(rp(o2, [2]int{1, 1}), 80000), ""))
		r2 := refunds(o2)
		// D-49: the claim (80000) is kept, the amount of record is capped at what was left (70000)
		if len(r2) != 2 || r2[0].warn != "" || r2[1].warn != "over_total" || r2[1].amount != 70000 || r2[1].claimed != 80000 || status(o2) != "refunded" {
			t.Fatalf("over_total on the completing refund: %+v status=%s", r2, status(o2))
		}
		// a first partial whose claim alone exceeds the total
		o3 := sell(o, saleOpt{items: []map[string]any{line(pA, 1, 30000), line(pB, 1, 70000)}})
		wantOK("o3 huge claim", rf(o, claim(rp(o3, [2]int{0, 1}), 200000), ""))
		if r := refunds(o3)[0]; r.warn != "over_total" || r.amount != 100000 || r.claimed != 200000 || status(o3) != "partially_refunded" {
			t.Fatalf("over_total on a partial: %+v status=%s", r, status(o3))
		}
		// D-49: ... and the next refund of that order has nothing left to record
		wantOK("o3 R2 after a capped claim", rf(o, rp(o3, [2]int{1, 1}), ""))
		if r := refunds(o3); len(r) != 2 || r[1].amount != 0 || r[1].warn != "over_total" || status(o3) != "refunded" {
			t.Fatalf("nothing left after a capped claim: %+v status=%s", r, status(o3))
		}
	})

	// ─────────────────────────────────────────────────────────────────────────────
	sub("7d D-49 cap: two refunds whose claims would exceed the total; shift, report and ERP use the capped amount", func(t *testing.T) {
		o := newOutlet()
		pA, pB := newProduct(o, 30000), newProduct(o, 70000)
		s := newShift(o, time.Now())
		oid := sell(o, saleOpt{shift: s, items: []map[string]any{line(pA, 1, 30000), line(pB, 1, 70000)}})
		claim := func(p map[string]any, amount int) map[string]any { p["refundAmount"] = amount; return p }
		// a claim within what is left stays the fact (60000 is paid out although the line is worth 30000)
		wantOK("R1 claims 60000", rf(o, claim(rp(oid, [2]int{0, 1}), 60000), s))
		// the second claim (70000) would take the sum to 130000: the record stops at the 40000 left
		wantOK("R2 claims 70000", rf(o, claim(rp(oid, [2]int{1, 1}), 70000), s))
		rs := refunds(oid)
		if len(rs) != 2 ||
			rs[0].amount != 60000 || rs[0].claimed != 60000 || rs[0].computed != 30000 || rs[0].warn != "amount_mismatch" ||
			rs[1].amount != 40000 || rs[1].claimed != 70000 || rs[1].computed != 70000 || rs[1].warn != "over_total" || status(oid) != "refunded" {
			t.Fatalf("capped refund rows: %+v status=%s", rs, status(oid))
		}
		od := getData(adminAll, "/orders/"+oid)
		if od["refundedAmount"] != float64(100000) {
			t.Fatalf("order read refundedAmount=%v want 100000", od["refundedAmount"])
		}
		rd2, _ := od["refunds"].([]any)
		if len(rd2) != 2 || rd2[1].(map[string]any)["claimedAmount"] != float64(70000) || rd2[1].(map[string]any)["amount"] != float64(40000) {
			t.Fatalf("order read refunds[]: %v", od["refunds"])
		}
		closeShift(o, s)
		sr := readShift(s)
		if sr.totalSales != 0 || sr.totalRefunds != 100000 || sr.cashRefundsPaid != 0 {
			t.Fatalf("shift close uses the capped amounts: %+v", sr)
		}
		sm := summaryOf(o.id, "")
		if sm.GrossSales != 100000 || sm.TotalRefunds != 100000 || sm.NetSales != 0 || sm.RefundsBy["cash"] != 100000 {
			t.Fatalf("report summary uses the capped amounts: %+v", sm)
		}
		var hd erp.OutboxHeader
		if err := pool.QueryRow(ctx, `SELECT id::text, document_id::text, kind, location_type, location_id::text, ref_type, ref_id::text,
		    coalesce(ref_number,''), part, part_count, created_at FROM erp_outbox WHERE doc_key=$1`, rs[1].key).
			Scan(&hd.ID, &hd.DocumentID, &hd.Kind, &hd.LocationType, &hd.LocationID, &hd.RefType, &hd.RefID, &hd.RefNumber, &hd.Part, &hd.PartCount, &hd.CreatedAt); err != nil {
			t.Fatalf("outbox row: %v", err)
		}
		in, err := erp.LoadBuildInput(ctx, pool, hd, "mandalika")
		if err != nil {
			t.Fatal(err)
		}
		doc, hold, err := erp.BuildDocument(in)
		if err != nil || hold != "" || len(doc.Tenders) != 1 || doc.Tenders[0].Amount != -40000 {
			t.Fatalf("ERP tender must be the capped amount, not held: hold=%q err=%v tenders=%+v", hold, err, doc.Tenders)
		}
	})

	// ─────────────────────────────────────────────────────────────────────────────
	sub("7b total_spent drops by the COMPUTED share, never by a wild claimed amount (D-42)", func(t *testing.T) {
		o := newOutlet()
		pA, pB, pC := newProduct(o, 100000), newProduct(o, 150000), newProduct(o, 300000)
		cu := newCustomer(0)
		other := sell(o, saleOpt{customer: cu, items: []map[string]any{line(pC, 1, 300000)}})
		oid := sell(o, saleOpt{customer: cu, items: []map[string]any{line(pA, 1, 100000), line(pB, 1, 150000)}})
		if total(oid) != 250000 || total(other) != 300000 || custRow(cu).spent != 550000 {
			t.Fatalf("fixture: %d %d %+v", total(oid), total(other), custRow(cu))
		}
		p := rp(oid, [2]int{0, 1})
		p["refundAmount"] = 25000000
		wantOK("wild claim", rf(o, p, ""))
		r1 := refunds(oid)[0]
		if r1.amount != 250000 || r1.claimed != 25000000 || r1.computed != 100000 || r1.warn != "over_total" {
			t.Fatalf("amount of record is capped at the order total, the claim kept, flagged (D-49): %+v", r1)
		}
		if got := custRow(cu).spent; got != 550000-r1.computed || got < total(other) {
			t.Fatalf("total_spent %d must drop by computed %d only (=450000), never below the other order's %d", got, r1.computed, total(other))
		}
		wantOK("completing refund", rf(o, rp(oid, [2]int{1, 1}), ""))
		if got := custRow(cu).spent; got != total(other) || status(oid) != "refunded" {
			t.Fatalf("after the final refund total_spent=%d want exactly the other order's %d", got, total(other))
		}
	})

	// ─────────────────────────────────────────────────────────────────────────────
	sub("7c a fully refunded cash order whose refunds paid no/other shift still shows its residual in the cash bucket", func(t *testing.T) {
		// service/shift.go: net_sale = total - sum(order_refunds.amount) = 100000 - 95000 = 5000 for a
		// refunded order; cash_sales = sum(net_sale) FILTER (payment_method = ANY(cash ids)); the cash
		// ids now include the methods of 'refunded' orders, so the 5000 lands in cash_sales even when no
		// refund row names this shift. total_sales = 5000, total_refunds = 95000, total_orders = 0, and
		// the shift paid no other-shift refund (by_method {}, cash_refunds_paid 0).
		run := func(name string, paidByOtherShift bool) {
			o := newOutlet()
			pA, pB := newProduct(o, 30000), newProduct(o, 70000)
			s := newShift(o, time.Now())
			paying := ""
			if paidByOtherShift {
				paying = nextID("1100")
				exec(`INSERT INTO shifts(id,outlet_id,cashier_id,cashier_name,status,opened_at,closed_at,starting_cash) VALUES($1,$2,$3,'RL other','closed',$4,$4,0)`, paying, o.id, o.user, time.Now().Add(-time.Hour))
			}
			oid := sell(o, saleOpt{shift: s, items: []map[string]any{line(pA, 1, 30000), line(pB, 1, 70000)}})
			c1 := rp(oid, [2]int{0, 1})
			c1["refundAmount"] = 25000
			c2 := rp(oid, [2]int{1, 1})
			c2["refundAmount"] = 70000
			wantOK(name+" R1", rf(o, c1, paying))
			wantOK(name+" R2", rf(o, c2, paying))
			if status(oid) != "refunded" || num(`SELECT count(*) FROM order_refunds WHERE order_id=$1 AND shift_id IS NOT DISTINCT FROM NULLIF($2::text,'')::uuid`, oid, paying) != 2 {
				t.Fatalf("%s: status=%s", name, status(oid))
			}
			closeShift(o, s)
			sr := readShift(s)
			if sr.totalSales != 5000 || sr.cashSales != 5000 || sr.totalRefunds != 95000 || sr.totalOrders != 0 || sr.cashRefundsPaid != 0 || !jsonEq(sr.byMethod, `{}`) {
				t.Fatalf("%s: shift close %+v", name, sr)
			}
			if sm := summaryOf(o.id, ""); sm.TotalSales != float64(sr.totalSales) || sm.TotalRefunds != float64(sr.totalRefunds) || sm.GrossSales != 100000 || sm.ByPay["cash"] != 5000 {
				t.Fatalf("%s: report %+v disagrees with the shift", name, sm)
			}
		}
		run("no refund shift", false)
		run("paid by another shift", true)
	})

	// ─────────────────────────────────────────────────────────────────────────────
	sub("8 cross-shift partial refunds and refund-business-day reports", func(t *testing.T) {
		o := newOutlet()
		pA, pB := newProduct(o, 60000), newProduct(o, 40000)
		now := time.Now().UTC()
		sA := newShift(o, now)
		oid := sell(o, saleOpt{shift: sA, items: []map[string]any{line(pA, 1, 60000), line(pB, 1, 40000)}})
		closeShift(o, sA)
		snapA := readShift(sA)
		if snapA.cashSales != 100000 || snapA.totalSales != 100000 || snapA.totalOrders != 1 {
			t.Fatalf("A snapshot: %+v", snapA)
		}
		sB := newShift(o, now.Add(24*time.Hour))
		wantOK("partial refund in shift B", rf(o, rp(oid, [2]int{0, 1}), sB))
		if readShift(sA) != snapA {
			t.Fatalf("A's closed snapshot changed: %+v -> %+v", snapA, readShift(sA))
		}
		live := getData(o.tok, "/shifts/"+sB)
		by, _ := live["refundsPaidByMethod"].(map[string]any)
		if len(by) != 1 || by["cash"] != float64(60000) || live["cashRefundsPaid"] != float64(60000) {
			t.Fatalf("B live read: refundsPaidByMethod=%v cashRefundsPaid=%v", live["refundsPaidByMethod"], live["cashRefundsPaid"])
		}
		closeShift(o, sB)
		if sr := readShift(sB); sr.cashRefundsPaid != 60000 || !jsonEq(sr.byMethod, `{"cash":60000}`) || sr.totalRefunds != 0 || sr.totalSales != 0 {
			t.Fatalf("B close: %+v", sr)
		}
		sD := newShift(o, now.Add(48*time.Hour))
		wantOK("completing refund in shift D", rf(o, rp(oid, [2]int{1, 1}), sD))
		closeShift(o, sD)
		if sr := readShift(sD); sr.cashRefundsPaid != 40000 || !jsonEq(sr.byMethod, `{"cash":40000}`) {
			t.Fatalf("D close: %+v", sr)
		}
		if readShift(sA) != snapA {
			t.Fatal("A's closed snapshot changed after the completing refund")
		}
		day := func(shift string) string { return str(`SELECT business_date::text FROM shifts WHERE id=$1`, shift) }
		dA, dB, dD := day(sA), day(sB), day(sD)
		if dA == dB || dB == dD {
			t.Fatalf("fixture days must differ: %s %s %s", dA, dB, dD)
		}
		q := func(from, to string) string { return "&dateFrom=" + from + "&dateTo=" + to }
		a := summaryOf(o.id, q(dA, dA))
		if a.GrossSales != 100000 || a.TotalRefunds != 0 || a.NetSales != 100000 || a.TotalSales != 0 {
			t.Fatalf("sale day: %+v", a)
		}
		b := summaryOf(o.id, q(dB, dB))
		if b.GrossSales != 0 || b.TotalRefunds != 60000 || b.RefundedOrders != 1 || b.NetSales != -60000 || b.RefundsBy["cash"] != 60000 {
			t.Fatalf("first refund day: %+v", b)
		}
		d := summaryOf(o.id, q(dD, dD))
		if d.TotalRefunds != 40000 || d.RefundedOrders != 1 || d.NetSales != -40000 {
			t.Fatalf("second refund day: %+v", d)
		}
		all := summaryOf(o.id, q(dA, dD))
		if all.GrossSales != 100000 || all.TotalRefunds != 100000 || all.RefundedOrders != 1 || all.NetSales != 0 || len(all.Daily) != 3 {
			t.Fatalf("whole window: %+v", all)
		}
		for _, row := range all.Daily {
			if row.NetSales != row.GrossSales-row.Refunds {
				t.Fatalf("daily row %+v", row)
			}
		}
		listTotal := func(query string) int {
			cur.Helper()
			code, raw := call("GET", "/orders?outletId="+o.id+query, adminAll, nil)
			var out struct {
				Data []map[string]any `json:"data"`
				Meta struct {
					Total int `json:"total"`
				} `json:"meta"`
			}
			if code != 200 || json.Unmarshal(raw, &out) != nil || len(out.Data) != out.Meta.Total {
				cur.Fatalf("orders list %d %s", code, raw)
			}
			return out.Meta.Total
		}
		if n := listTotal("&dateBasis=refund" + q(dB, dD)); n != 1 {
			t.Fatalf("an order refunded twice appears once in the refund-basis list, got %d", n)
		}
		if listTotal("&dateBasis=refund"+q(dB, dB)) != 1 || listTotal("&dateBasis=refund"+q(dA, dA)) != 0 {
			t.Fatal("refund-basis list must follow the refund business day")
		}

		// (ii) total_refunds attributes to the SALE's shift, whichever shift paid. Only one shift can be
		// open per outlet, so the paying shift B2 is a drawer that is already closed (late refund).
		o2 := newOutlet()
		qA, qB := newProduct(o2, 60000), newProduct(o2, 40000)
		a2 := newShift(o2, now)
		b2 := nextID("1100")
		exec(`INSERT INTO shifts(id,outlet_id,cashier_id,cashier_name,status,opened_at,closed_at,starting_cash) VALUES($1,$2,$3,'RL B2','closed',$4,$4,0)`, b2, o2.id, o2.user, now.Add(-time.Hour))
		oid2 := sell(o2, saleOpt{shift: a2, items: []map[string]any{line(qA, 1, 60000), line(qB, 1, 40000)}})
		wantOK("partial refund paid by B2", rf(o2, rp(oid2, [2]int{0, 1}), b2))
		liveA := getData(o2.tok, "/shifts/"+a2)
		if by, _ := liveA["refundsPaidByMethod"].(map[string]any); len(by) != 0 {
			t.Fatalf("a refund of the shift's own sale is not an other-shift cash refund: %v", liveA["refundsPaidByMethod"])
		}
		closeShift(o2, a2)
		ra := readShift(a2)
		if ra.totalRefunds != 60000 || ra.totalSales != 40000 || ra.cashSales != 40000 || ra.totalOrders != 1 || ra.cashRefundsPaid != 0 {
			t.Fatalf("A2 close (total_refunds follows the sale shift, a partially refunded order is still a sale): %+v", ra)
		}
	})

	// ─────────────────────────────────────────────────────────────────────────────
	sub("9 catch-up trigger, backfill and the refund row written before the status flip", func(t *testing.T) {
		o := newOutlet()
		pA, pB := newProduct(o, 60000), newProduct(o, 40000)
		s := newShift(o, time.Now())
		oid := sell(o, saleOpt{shift: s, items: []map[string]any{line(pA, 1, 60000), line(pB, 1, 40000)}})
		// (a) a direct UPDATE (fixtures, fsmigrate, an old revision) gets exactly one legacy_full row
		exec(`UPDATE orders SET status='refunded', refund_reason='fixture', refunded_at=now(), refund_shift_id=$2 WHERE id=$1`, oid, s)
		exec(`UPDATE orders SET status='refunded' WHERE id=$1`, oid) // touching it again must not add a row
		rs := refunds(oid)
		if len(rs) != 1 || rs[0].scope != "legacy_full" || rs[0].seq != 1 || rs[0].amount != 100000 || rs[0].computed != 100000 || rs[0].key != "refund:"+oid {
			t.Fatalf("trigger row: %+v", rs)
		}
		if num(`SELECT count(*) FROM order_refund_items WHERE refund_id=$1::uuid AND quantity=1 AND NOT restocked`, rs[0].id) != 2 ||
			num(`SELECT count(*) FROM order_refunds WHERE id=$1::uuid AND refund_business_date IS NOT NULL AND payment_method='cash' AND shift_id=$2`, rs[0].id, s) != 1 {
			t.Fatal("legacy_full row must carry its items (restocked = has a ledger movement) and the order's shift/business date")
		}
		closeShift(o, s)
		if sr := readShift(s); sr.totalSales != 0 || sr.totalRefunds != 100000 || sr.cashRefundsPaid != 0 || sr.totalOrders != 0 || sr.cashSales != 0 {
			t.Fatalf("legacy expectation for the shift: %+v", sr)
		}
		if sm := summaryOf(o.id, ""); sm.GrossSales != 100000 || sm.TotalRefunds != 100000 || sm.NetSales != 0 || sm.TotalSales != 0 || sm.RefundedOrders != 1 {
			t.Fatalf("legacy expectation for the report: %+v", sm)
		}
		// an order INSERTed already refunded also gets its single row (its items arrive after the
		// order row, so the row has none: the trigger cannot see them yet)
		ins := nextID("1500")
		exec(`INSERT INTO orders(id,order_number,order_uuid,idempotency_key,outlet_id,cashier_id,cashier_name,subtotal,total,payment_method,status,refund_reason,refunded_at)
			VALUES($1,'RL-INS',gen_random_uuid(),'rl-ins',$2,$3,'RL',500,500,'cash','refunded','fixture',now())`, ins, o.id, o.user)
		if r := refunds(ins); len(r) != 1 || r[0].scope != "legacy_full" || r[0].amount != 500 || r[0].key != "refund:"+ins {
			t.Fatalf("insert-as-refunded row: %+v", r)
		}
		// (b) RefundLinesTx writes its own row first: no trigger row, no UNIQUE(order_id, seq) clash
		w := sell(o, saleOpt{items: []map[string]any{line(pA, 1, 60000)}})
		wantOK("whole legacy payload", rf(o, rp(w), ""))
		exec(`UPDATE orders SET status='refunded' WHERE id=$1`, w)
		if r := refunds(w); len(r) != 1 || r[0].scope != "full" || r[0].seq != 1 {
			t.Fatalf("new-code refund must not get a trigger row: %+v", r)
		}
		p := sell(o, saleOpt{items: []map[string]any{line(pA, 2, 60000), line(pB, 1, 40000)}})
		wantOK("partial", rf(o, rp(p, [2]int{0, 1}), ""))
		wantOK("completing", rf(o, rp(p, [2]int{0, 1}, [2]int{1, 1}), ""))
		if r := refunds(p); len(r) != 2 || r[0].seq != 1 || r[1].seq != 2 || r[0].scope == "legacy_full" || r[1].scope == "legacy_full" {
			t.Fatalf("refund rows of a two-step order: %+v", r)
		}
		if num(`SELECT count(*) FROM order_refunds WHERE scope='legacy_full' AND ledger_document_key <> 'refund:'||order_id`) != 0 {
			t.Fatal("every legacy_full row keeps the legacy refund:<orderId> key")
		}

		// (c) the 0077 backfill itself: rows written at schema 0076, then migrated.
		var adminCfg = pool.Config().Copy()
		adminCfg.ConnConfig.Database = "postgres"
		admin, err := pgxpool.NewWithConfig(ctx, adminCfg)
		if err != nil {
			t.Fatal(err)
		}
		defer admin.Close()
		if _, err := admin.Exec(ctx, `CREATE DATABASE mandalika_rl_stage`); err != nil {
			t.Fatalf("create the two-stage database: %v", err)
		}
		defer func() { _, _ = admin.Exec(ctx, `DROP DATABASE IF EXISTS mandalika_rl_stage WITH (FORCE)`) }()
		stageCfg := pool.Config().Copy()
		stageCfg.ConnConfig.Database = "mandalika_rl_stage"
		stage, err := pgxpool.NewWithConfig(ctx, stageCfg)
		if err != nil {
			t.Fatal(err)
		}
		defer stage.Close()
		sx := func(sql string, args ...any) {
			cur.Helper()
			if _, err := stage.Exec(ctx, sql, args...); err != nil {
				cur.Fatalf("%v: %s", err, sql)
			}
		}
		const m77 = "0077_order_refunds.sql"
		ents, err := os.ReadDir("../db/migrations")
		if err != nil {
			t.Fatal(err)
		}
		var held []string // every migration that sorts >= 0077: a future 0078 must not run onto a 0076 schema
		for _, e := range ents {
			if strings.HasSuffix(e.Name(), ".sql") && e.Name() >= m77 {
				held = append(held, e.Name())
			}
		}
		sx(`CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`)
		for _, n := range held {
			sx(`INSERT INTO schema_migrations(name) VALUES($1)`, n) // stop at schema 0076
		}
		if err := (&db.DB{Pool: stage}).Migrate(ctx); err != nil {
			t.Fatal(err)
		}
		if n := func() (n int) {
			_ = stage.QueryRow(ctx, `SELECT count(*) FROM information_schema.tables WHERE table_name='order_refunds'`).Scan(&n)
			return
		}(); n != 0 {
			t.Fatal("stage database must be at schema 0076")
		}
		so, su, sp, ss := nextID("1600"), nextID("1601"), nextID("1602"), nextID("1603")
		sx(`INSERT INTO outlets(id,name) VALUES($1,'RL stage')`, so)
		sx(`INSERT INTO users(id,email,password_hash,display_name,role,outlet_id) VALUES($1,'stage@example.invalid','x','RL','cashier',$2)`, su, so)
		sx(`INSERT INTO products(id,name) VALUES($1,'RL stage product')`, sp)
		sx(`INSERT INTO shifts(id,outlet_id,cashier_id,cashier_name,status,opened_at,starting_cash) VALUES($1,$2,$3,'RL','open',now(),0)`, ss, so, su)
		// A second outlet + open shift B: a LEGACY cross-shift refund (sale in shift A, refund paid by
		// shift B). One open shift per outlet, so B lives at another outlet; the readers join on ids only.
		so2, ss2 := nextID("1610"), nextID("1611")
		sx(`INSERT INTO outlets(id,name) VALUES($1,'RL stage 2')`, so2)
		sx(`INSERT INTO shifts(id,outlet_id,cashier_id,cashier_name,status,opened_at,starting_cash) VALUES($1,$2,$3,'RL','open',now(),0)`, ss2, so2, su)
		var restockedItem string
		for i, f := range []struct {
			status, refundShift string
			total               int
		}{{"completed", "", 1000}, {"refunded", ss, 2000}, {"refunded", ss, 3000}, {"cancelled", "", 4000}, {"refunded", ss2, 7000}} {
			id := nextID("1604")
			sx(`INSERT INTO orders(id,order_number,order_uuid,idempotency_key,outlet_id,cashier_id,cashier_name,subtotal,total,payment_method,status,shift_id,refund_reason,refunded_at,refund_shift_id)
				VALUES($1,$2,gen_random_uuid(),$3,$4,$5,'RL',$6,$6,'cash',$7,$8,NULLIF($9,''),CASE WHEN $7='refunded' THEN now() END,NULLIF($10::text,'')::uuid)`,
				id, fmt.Sprintf("RLS-%d", i), fmt.Sprintf("rls-%d", i), so, su, f.total, f.status, ss,
				map[bool]string{true: "old", false: ""}[f.status == "refunded"], f.refundShift)
			item := nextID("1605")
			sx(`INSERT INTO order_items(id,order_id,product_id,product_name,variant_size,price,quantity,subtotal) VALUES($1,$2,$3,'p','M',500,2,$4)`, item, id, sp, f.total)
			if i == 1 {
				restockedItem = item
			}
		}
		// the first refunded order's line was restocked by a refund stock movement (ledger era)
		sx(`INSERT INTO stock_movements(document_id,dedupe_key,kind,location_type,location_id,product_id,variant_size,qty,qty_before,qty_after,ref_type,occurred_at)
			VALUES(gen_random_uuid(),$1,'refund','outlet',$2,$3,'M',2,0,2,'order',now())`, "refund:"+restockedItem, so, sp)
		// legacy expectations at 0076: refunded orders are 2000 + 3000 + 7000 = 12000, the completed one 1000 stays sold
		for _, n := range held {
			sx(`DELETE FROM schema_migrations WHERE name=$1`, n)
		}
		if err := (&db.DB{Pool: stage}).Migrate(ctx); err != nil {
			t.Fatalf("applying 0077 over existing refunded orders: %v", err)
		}
		cnt := func(sql string) (n int64) {
			cur.Helper()
			if err := stage.QueryRow(ctx, sql).Scan(&n); err != nil {
				cur.Fatalf("%v: %s", err, sql)
			}
			return
		}
		if cnt(`SELECT count(*) FROM order_refunds`) != 3 || cnt(`SELECT count(*) FROM order_refunds WHERE scope='legacy_full' AND seq=1 AND amount=computed_amount AND ledger_document_key='refund:'||order_id AND shift_id IS NOT NULL`) != 3 ||
			cnt(`SELECT round(sum(amount))::bigint FROM order_refunds`) != 12000 || cnt(`SELECT count(*) FROM order_refund_items`) != 3 ||
			cnt(`SELECT count(*) FROM order_refund_items WHERE restocked`) != 1 ||
			cnt(`SELECT count(*) FROM order_refund_items WHERE restocked AND order_item_id='`+restockedItem+`'::uuid`) != 1 ||
			cnt(`SELECT count(*) FROM order_refunds r JOIN orders o ON o.id=r.order_id WHERE o.status<>'refunded'`) != 0 {
			t.Fatal("backfill: exactly one legacy_full row (+ items) per refunded order")
		}
		stageSvc := service.NewOrderService(stage)
		if err := stageSvc.CloseShift(ctx, so, ss, 0, nil); err != nil {
			t.Fatal(err)
		}
		if err := stageSvc.CloseShift(ctx, so2, ss2, 0, nil); err != nil {
			t.Fatal(err)
		}
		var ts, tr, cs, tor int64
		if err := stage.QueryRow(ctx, `SELECT round(total_sales)::bigint, round(total_refunds)::bigint, round(cash_sales)::bigint, total_orders FROM shifts WHERE id=$1`, ss).Scan(&ts, &tr, &cs, &tor); err != nil {
			t.Fatal(err)
		}
		// Shift A (sales shift of all five orders): the completed 1000 stays sold; every refunded
		// order is net 0 in sales and its full total (2000+3000+7000) is in total_refunds, whichever
		// shift paid it (refunded orders attribute to the sale's shift).
		if ts != 1000 || tr != 12000 || cs != 1000 || tor != 1 {
			t.Fatalf("post-backfill shift A close: sales=%d refunds=%d cash=%d orders=%d (legacy expectation 1000/12000/1000/1)", ts, tr, cs, tor)
		}
		// Shift B paid the 7000 refund of A's sale: legacy = a cash refund paid by another shift.
		var bPaid, bRefunds, bSales int64
		var bBy string
		if err := stage.QueryRow(ctx, `SELECT round(cash_refunds_paid)::bigint, round(total_refunds)::bigint, round(total_sales)::bigint, refunds_paid_by_method::text FROM shifts WHERE id=$1`, ss2).Scan(&bPaid, &bRefunds, &bSales, &bBy); err != nil {
			t.Fatal(err)
		}
		if bPaid != 7000 || bRefunds != 0 || bSales != 0 || !jsonEq(bBy, `{"cash":7000}`) {
			t.Fatalf("post-backfill shift B close: cash_refunds_paid=%d total_refunds=%d sales=%d by=%s (legacy expectation 7000/0/0/{cash:7000})", bPaid, bRefunds, bSales, bBy)
		}
		sm, err := read.New(stage).ReportSummary(ctx, read.OrderFilter{Scope: read.Scope{CrossAll: true}})
		if err != nil {
			t.Fatal(err)
		}
		if sm.GrossSales != 13000 || sm.TotalRefunds != 12000 || sm.TotalSales != 1000 || sm.NetSales != 1000 || sm.RefundedOrders != 3 {
			t.Fatalf("post-backfill report: %+v", sm)
		}
	})

	// ─────────────────────────────────────────────────────────────────────────────
	sub("10 zero-total order (100% points): proportional points never go negative", func(t *testing.T) {
		defer exec(`UPDATE loyalty_settings SET enabled=false, points_per_thousand=0, redemption_rate=0 WHERE id=1`)
		exec(`UPDATE loyalty_settings SET enabled=true, points_per_thousand=1, redemption_rate=100 WHERE id=1`)
		o := newOutlet()
		pA, pB := newProduct(o, 30000), newProduct(o, 20000)
		cu := newCustomer(1000)
		oid := sell(o, saleOpt{customer: cu, items: []map[string]any{line(pA, 1, 30000), line(pB, 1, 20000)}, extra: map[string]any{"pointsRedeemed": 600}})
		earned := num(`SELECT points_earned FROM orders WHERE id=$1`, oid)
		redeemed := num(`SELECT points_redeemed FROM orders WHERE id=$1`, oid)
		if total(oid) != 0 || redeemed != 500 || earned <= 0 {
			t.Fatalf("fixture: total=%d redeemed=%d earned=%d", total(oid), redeemed, earned)
		}
		// the read API exposes the redeemed points and their frozen Rupiah value (500 x Rp100, clamped to the total)
		got, err := rd.Order(ctx, read.Scope{CrossAll: true}, oid)
		if err != nil {
			t.Fatal(err)
		}
		if got.PointsRedeemed == nil || *got.PointsRedeemed != 500 || got.PointsRedemptionAmount.IsNull() || !got.PointsRedemptionAmount.IsSpecified() || got.PointsRedemptionAmount.MustGet() != 50000 {
			t.Fatalf("order read: pointsRedeemed=%v amount=%+v, want 500 / 50000", got.PointsRedeemed, got.PointsRedemptionAmount)
		}
		plain := sell(o, saleOpt{items: []map[string]any{line(pA, 1, 30000)}})
		gotPlain, err := rd.Order(ctx, read.Scope{CrossAll: true}, plain)
		if err != nil {
			t.Fatal(err)
		}
		if gotPlain.PointsRedemptionAmount.IsSpecified() && !gotPlain.PointsRedemptionAmount.IsNull() {
			t.Fatalf("an order without redemption must carry no amount, got %+v", gotPlain.PointsRedemptionAmount)
		}
		before := custRow(cu)
		wantOK("partial refund", rf(o, rp(oid, [2]int{0, 1}), ""))
		r1 := refunds(oid)[0]
		after := custRow(cu)
		if r1.amount != 0 || r1.clawed != 0 || r1.restor != 0 || after.points != before.points || status(oid) != "partially_refunded" {
			t.Fatalf("a partial refund of a Rp0 order restores/claws nothing: %+v points %d -> %d", r1, before.points, after.points)
		}
		// the customer has spent the earned points meanwhile: the claw is forgiven, never negative
		exec(`UPDATE customers SET points=0 WHERE id=$1`, cu)
		wantOK("final refund", rf(o, rp(oid, [2]int{1, 1}), ""))
		rs := refunds(oid)
		fin := custRow(cu)
		if len(rs) != 2 || rs[1].clawed != 0 || rs[0].restor+rs[1].restor != redeemed || fin.points != redeemed || status(oid) != "refunded" {
			t.Fatalf("final refund of a Rp0 order: %+v points=%d", rs, fin.points)
		}
		if num(`SELECT count(*) FROM customers WHERE points < 0`) != 0 {
			t.Fatal("a refund must never leave points negative")
		}
		// with enough balance the whole earned amount is clawed by the completing refund
		cu2 := newCustomer(1000)
		o2 := sell(o, saleOpt{customer: cu2, items: []map[string]any{line(pA, 1, 30000), line(pB, 1, 20000)}, extra: map[string]any{"pointsRedeemed": 600}})
		wantOK("o2 partial", rf(o, rp(o2, [2]int{0, 1}), ""))
		wantOK("o2 final", rf(o, rp(o2, [2]int{1, 1}), ""))
		r2 := refunds(o2)
		if r2[0].clawed+r2[1].clawed != earned || r2[0].restor+r2[1].restor != redeemed || custRow(cu2).points != 1000 {
			t.Fatalf("o2: %+v points=%d", r2, custRow(cu2).points)
		}
	})

	// ─────────────────────────────────────────────────────────────────────────────
	sub("12 refund report: one row per refund with lines, flag filter, outlet scope, 400s", func(t *testing.T) {
		o, other := newOutlet(), newOutlet()
		pA, pB := newProduct(o, 30000), newProduct(o, 70000)
		pC := newProduct(other, 50000)
		oid := sell(o, saleOpt{items: []map[string]any{line(pA, 1, 30000), line(pB, 1, 70000)}})
		claim := func(p map[string]any, amount int) map[string]any { p["refundAmount"] = amount; return p }
		wantOK("R1", rf(o, rp(oid, [2]int{0, 1}), ""))
		wantOK("R2 over claim", rf(o, claim(rp(oid, [2]int{1, 1}), 90000), ""))
		oid2 := sell(other, saleOpt{items: []map[string]any{line(pC, 1, 50000)}})
		wantOK("other outlet refund", rf(other, rp(oid2, [2]int{0, 1}), ""))

		report := func(token, q string) (sum map[string]any, rows []map[string]any, total float64) {
			cur.Helper()
			code, raw := call("GET", "/refund-report"+q, token, nil)
			var out struct {
				Summary map[string]any          `json:"summary"`
				Data    []map[string]any        `json:"data"`
				Meta    struct{ Total float64 } `json:"meta"`
			}
			if code != 200 || json.Unmarshal(raw, &out) != nil {
				cur.Fatalf("GET /refund-report%s: %d %s", q, code, raw)
			}
			return out.Summary, out.Data, out.Meta.Total
		}
		sum, rows, total := report(adminAll, "?outletId="+o.id)
		if total != 2 || len(rows) != 2 || sum["count"] != float64(2) || sum["totalAmount"] != float64(100000) || sum["flaggedCount"] != float64(1) {
			t.Fatalf("outlet report: total=%v rows=%d sum=%v", total, len(rows), sum)
		}
		// newest first: R2 (capped 70000 of a 90000 claim, 1 line) then R1
		r2, r1 := rows[0], rows[1]
		items2, _ := r2["items"].([]any)
		if r2["seq"] != float64(2) || r2["amount"] != float64(70000) || r2["claimedAmount"] != float64(90000) || r2["amountWarning"] != "over_total" ||
			r2["orderId"] != oid || r2["outletName"] == "" || r2["cashierName"] == "" || len(items2) != 1 ||
			items2[0].(map[string]any)["quantity"] != float64(1) || r1["seq"] != float64(1) {
			t.Fatalf("report rows: %v", rows)
		}
		if _, f, ft := report(adminAll, "?outletId="+o.id+"&flag=over_total"); ft != 1 || len(f) != 1 || f[0]["seq"] != float64(2) {
			t.Fatalf("flag filter over_total: %d rows", len(f))
		}
		if _, f, _ := report(adminAll, "?outletId="+o.id+"&flag=amount_mismatch"); len(f) != 0 {
			t.Fatalf("flag filter amount_mismatch: %d rows", len(f))
		}
		if _, p1, pt := report(adminAll, "?outletId="+o.id+"&limit=1&page=2"); pt != 2 || len(p1) != 1 || p1[0]["seq"] != float64(1) {
			t.Fatalf("paging: total=%v rows=%v", pt, p1)
		}
		if _, _, dt := report(adminAll, "?outletId="+o.id+"&dateFrom=2001-01-01&dateTo=2001-01-02"); dt != 0 {
			t.Fatalf("date filter should exclude: %v", dt)
		}
		// a cashier of the other outlet only ever sees their own outlet, even asking for another
		_, mine, mt := report(other.tok, "?outletId="+o.id)
		if mt != 1 || len(mine) != 1 || mine[0]["outletId"] != other.id {
			t.Fatalf("scope clamp leaked: total=%v rows=%v", mt, mine)
		}
		for _, q := range []string{"?flag=bogus", "?dateFrom=nope"} {
			if code, _ := call("GET", "/refund-report"+q, adminAll, nil); code != 400 {
				t.Fatalf("%s should be 400, got %d", q, code)
			}
		}
	})

	// ─────────────────────────────────────────────────────────────────────────────
	sub("13 direct route per-line (admin refund, C4c): items shape, no claim, server rules unchanged", func(t *testing.T) {
		o := newOutlet()
		pA, pB := newProduct(o, 30000), newProduct(o, 70000)
		oid := sell(o, saleOpt{items: []map[string]any{line(pA, 1, 30000), line(pB, 1, 70000)}})
		post := func(body map[string]any) (int, string) {
			cur.Helper()
			code, raw := call("POST", "/orders/"+oid+"/refund", o.tok, body)
			return code, string(raw)
		}
		if code, b := post(map[string]any{"reason": "rusak", "items": []map[string]int{}}); code != 400 {
			t.Fatalf("empty items must be refused, got %d %s", code, b)
		}
		if code, b := post(map[string]any{"reason": "rusak", "items": []map[string]int{{"lineNo": 0, "quantity": 2}}}); code != 409 || !strings.Contains(b, "jangan bayar ulang") {
			t.Fatalf("over quantity: %d %s", code, b)
		}
		if code, b := post(map[string]any{"reason": "rusak", "reasonCode": "Bad Code", "items": []map[string]int{{"lineNo": 0, "quantity": 1}}}); code != 400 {
			t.Fatalf("bad reason code: %d %s", code, b)
		}
		if code, b := post(map[string]any{"reason": "rusak", "reasonCode": "rusak", "items": []map[string]int{{"lineNo": 0, "quantity": 1}}}); code != 201 {
			t.Fatalf("per-line direct refund: %d %s", code, b)
		}
		rs := refunds(oid)
		if len(rs) != 1 || rs[0].scope != "partial" || rs[0].amount != 30000 || rs[0].claimed != -1 || status(oid) != "partially_refunded" {
			t.Fatalf("direct partial row: %+v status=%s", rs, status(oid))
		}
		// a retry with the same client uuid is a replay, never a second payout
		key := "0e0e0e0e-1111-4222-8333-" + fmt.Sprintf("%012d", time.Now().UnixNano()%1_000_000_000_000)
		keyed := map[string]any{"reason": "rusak", "clientRefundUuid": key, "items": []map[string]int{{"lineNo": 1, "quantity": 1}}}
		if code, b := post(keyed); code != 201 {
			t.Fatalf("keyed direct refund: %d %s", code, b)
		}
		if code, b := post(keyed); code != 201 || len(refunds(oid)) != 2 {
			t.Fatalf("keyed replay must not add a refund: %d %s rows=%d", code, b, len(refunds(oid)))
		}
		if code, _ := post(map[string]any{"reason": "rusak", "clientRefundUuid": "nope", "items": []map[string]int{{"lineNo": 1, "quantity": 1}}}); code != 400 {
			t.Fatalf("bad clientRefundUuid must be 400, got %d", code)
		}
		if code, _ := post(map[string]any{"reason": "rusak", "items": []map[string]int{{"lineNo": 1, "quantity": 1}}}); code != 409 {
			t.Fatalf("an unkeyed repeat must conflict, got %d", code)
		}
		if status(oid) != "refunded" || len(refunds(oid)) != 2 {
			t.Fatalf("final status %s", status(oid))
		}
	})

	// ─────────────────────────────────────────────────────────────────────────────
	sub("14 Kartu Stok: refund movements carry Refund ke-N and the refund reason (new keys and the legacy refund:<orderId> key)", func(t *testing.T) {
		o := newOutlet()
		pA, pB := newProduct(o, 30000), newProduct(o, 70000)
		oid := sell(o, saleOpt{items: []map[string]any{line(pA, 1, 30000), line(pB, 1, 70000)}})
		wantOK("R1", rf(o, rp(oid, [2]int{0, 1}), ""))
		wantOK("R2", rf(o, rp(oid, [2]int{1, 1}), ""))
		seqOf := func(pid string) (seq int, reason string, n int) {
			cur.Helper()
			f := read.MovementFilter{LocationType: "outlet", LocationID: o.id, ProductID: pid, VariantSize: "std", Kinds: []string{"refund"}}
			if err := rd.ForEachMovement(ctx, f, 0, 50, func(m api.StockMovementRow) error {
				n++
				if m.RefundSeq != nil {
					seq = *m.RefundSeq
				}
				if m.ReasonText != nil {
					reason = *m.ReasonText
				}
				return nil
			}); err != nil {
				cur.Fatal(err)
			}
			return
		}
		if sq, rs, n := seqOf(pA); n != 1 || sq != 1 || rs == "" {
			t.Fatalf("line A refund movement: seq=%d reason=%q n=%d", sq, rs, n)
		}
		if sq, rs, n := seqOf(pB); n != 1 || sq != 2 || rs == "" {
			t.Fatalf("line B refund movement: seq=%d reason=%q n=%d", sq, rs, n)
		}
		// legacy key shape: refund row key refund:<orderId>, movement dedupe key refund:<itemId>
		lp := newProduct(o, 40000)
		lo := legacyOrder(o, "completed", lp, 40000, "")
		exec(`UPDATE orders SET status='refunded', refund_reason='lama', refunded_at=now() WHERE id=$1`, lo)
		li := str(`SELECT id::text FROM order_items WHERE order_id=$1`, lo)
		exec(`INSERT INTO stock_movements(kind, location_type, location_id, product_id, variant_size, qty, qty_before, qty_after, ref_type, ref_id, dedupe_key, document_id, occurred_at)
			SELECT 'refund','outlet',$1::uuid,$2::uuid,'std',1,0,1,'order',$3::uuid,'refund:'||$4,gen_random_uuid(),now()`, o.id, lp, lo, li)
		if sq, _, n := seqOf(lp); n != 1 || sq != 1 {
			t.Fatalf("legacy refund movement: seq=%d n=%d", sq, n)
		}
	})

	// ─────────────────────────────────────────────────────────────────────────────
	sub("11 invariant (D-49): sum(order_refunds.amount) <= orders.total + 1, always", func(t *testing.T) {
		rows, err := pool.Query(ctx, `SELECT o.id::text FROM orders o JOIN order_refunds r ON r.order_id=o.id
			GROUP BY o.id, o.total
			HAVING sum(r.amount) > o.total + 1`)
		if err != nil {
			t.Fatal(err)
		}
		var bad []string
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				t.Fatal(err)
			}
			bad = append(bad, id)
		}
		rows.Close()
		if len(bad) != 0 {
			t.Fatalf("orders whose refund amounts of record sum past their total: %v", bad)
		}
		if num(`SELECT count(*) FROM order_refunds WHERE amount_warning='over_total'`) < 2 {
			t.Fatal("subtest 7 must have produced flagged rows, or the invariant is vacuous")
		}
		// every refunded order's computed amounts add up to its total exactly
		if n := num(`SELECT count(*) FROM orders o WHERE o.status='refunded' AND
			(SELECT COALESCE(sum(round(computed_amount)),0) FROM order_refunds r WHERE r.order_id=o.id) <> round(o.total)`); n != 0 {
			t.Fatalf("%d refunded orders whose computed amounts do not sum to the total", n)
		}
		if num(`SELECT count(*) FROM orders o WHERE o.status='partially_refunded' AND NOT EXISTS (SELECT 1 FROM order_refunds r WHERE r.order_id=o.id)`) != 0 {
			t.Fatal("a partially_refunded order without a refund row")
		}
	})
}
