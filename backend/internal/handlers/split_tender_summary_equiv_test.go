package handlers

import (
	"encoding/json"
	"fmt"
	"reflect"

	"github.com/mandalika/pos-backend/internal/api"
	"github.com/mandalika/pos-backend/internal/read"
	"github.com/mandalika/pos-backend/internal/tenderlines"
)

// Subtest 13: the report summary was rebuilt to render the sale filter once (a MATERIALIZED base
// CTE) instead of three times. The pre-rebuild statement (read.ReportSummary at PR head f03265c5)
// is kept below as a test-only oracle; both must return the same JSON for every filter shape on
// split, refunded, cancelled, partially refunded and tenderless fixtures.

// oldSummaryTemplate is the f03265c5 ReportSummary statement: %[1]s = CTE list, %[2]s = refund
// where, %[3]s = by-method source.
const oldSummaryTemplate = `
WITH %[1]s,
rb AS (
  SELECT r.order_id, r.amount, r.payment_method, r.refund_business_date
  FROM orders o JOIN order_refunds r ON r.order_id = o.id %[2]s
),
agg AS (
  SELECT
    COALESCE(SUM(net_total),0)                                                             AS total_sales,
    COUNT(*) FILTER (WHERE has_line AND status IN ('completed','partially_refunded'))      AS total_orders,
    COALESCE(SUM(total),0)                                                                 AS gross_sales,
    COUNT(*) FILTER (WHERE has_line)                                                       AS gross_orders
  FROM sb
),
ragg AS (
  SELECT COALESCE(SUM(amount),0) AS total_refunds, COUNT(DISTINCT order_id) AS refunded_orders FROM rb
),
pay AS (
  SELECT COALESCE(json_object_agg(payment_method, s),'{}'::json) AS by_pm
  FROM (SELECT payment_method, SUM(net_total) AS s FROM %[3]s
        WHERE status IN ('completed','partially_refunded') OR net_total <> 0
        GROUP BY payment_method) t
),
gpay AS (
  SELECT COALESCE(json_object_agg(payment_method, s),'{}'::json) AS by_pm
  FROM (SELECT payment_method, SUM(total) AS s FROM %[3]s WHERE has_line GROUP BY payment_method) t
),
rpay AS (
  SELECT COALESCE(json_object_agg(payment_method, s),'{}'::json) AS by_pm
  FROM (SELECT payment_method, SUM(amount) AS s FROM rb GROUP BY payment_method) t
),
prod AS (
  SELECT COALESCE(json_agg(json_build_object(
           'productId',product_id,'productName',product_name,
           'quantity',qty,'revenue',rev) ORDER BY rev DESC),'[]'::json) AS top
  FROM (SELECT x.product_id, MIN(x.product_name) AS product_name,
               SUM(x.quantity - x.rq) AS qty,
               SUM(CASE WHEN x.rq = 0 THEN x.subtotal
                        ELSE x.subtotal * (x.quantity - x.rq) / x.quantity END) AS rev
        FROM (SELECT it.product_id, it.product_name, it.quantity, it.subtotal,
                     CASE WHEN b.status='partially_refunded' THEN COALESCE(
                       (SELECT SUM(ri.quantity) FROM order_refund_items ri WHERE ri.order_item_id = it.id), 0)
                       ELSE 0 END AS rq
                FROM order_items it JOIN sb b ON b.id=it.order_id
                WHERE b.has_line AND b.status IN ('completed','partially_refunded')) x
        WHERE x.rq = 0 OR x.quantity > x.rq
        GROUP BY x.product_id ORDER BY rev DESC LIMIT 10) p
),
sd AS (
  SELECT business_date AS d,
         SUM(net_total) AS s,
         COUNT(*) FILTER (WHERE has_line AND status IN ('completed','partially_refunded')) AS n,
         SUM(total) AS g, COUNT(*) FILTER (WHERE has_line) AS gn
  FROM sb GROUP BY business_date
),
rd AS (
  SELECT refund_business_date AS d, SUM(amount) AS r, COUNT(DISTINCT order_id) AS rn
  FROM rb WHERE refund_business_date IS NOT NULL GROUP BY refund_business_date
),
daily AS (
  SELECT COALESCE(json_agg(json_build_object(
           'date',to_char(d,'YYYY-MM-DD'),
           'sales',COALESCE(s,0),'orders',COALESCE(n,0),
           'grossSales',COALESCE(g,0),'grossOrders',COALESCE(gn,0),
           'refunds',COALESCE(r,0),'refundedOrders',COALESCE(rn,0),
           'netSales',COALESCE(g,0)-COALESCE(r,0)) ORDER BY d),'[]'::json) AS rows
  FROM (SELECT COALESCE(sd.d, rd.d) AS d, sd.s, sd.n, sd.g, sd.gn, rd.r, rd.rn
        FROM sd FULL OUTER JOIN rd ON sd.d = rd.d) x
)
SELECT json_build_object(
  'totalSales',agg.total_sales,'totalOrders',agg.total_orders,
  'grossSales',agg.gross_sales,'grossOrders',agg.gross_orders,
  'totalRefunds',ragg.total_refunds,'refundedOrders',ragg.refunded_orders,
  'netSales',agg.gross_sales-ragg.total_refunds,
  'avgOrderValue',CASE WHEN agg.total_orders>0
     THEN agg.total_sales/agg.total_orders ELSE 0 END,
  'byPaymentMethod',pay.by_pm,'grossByPaymentMethod',gpay.by_pm,
  'refundsByPaymentMethod',rpay.by_pm,
  'topProducts',prod.top,'dailySales',daily.rows)
FROM agg, ragg, pay, gpay, rpay, prod, daily`

// oldSummaryCTEs is the f03265c5 summarySaleCTEs: saleWhere rendered three times.
func oldSummaryCTEs(limited bool, saleWhere string, methodArg int) (ctes, lineSrc string) {
	sbl := fmt.Sprintf(`sbl AS (
  SELECT x.id, x.status, x.business_date, x.method AS payment_method,
         SUM(x.gross) AS total, SUM(x.gross) - SUM(x.paid_out) AS net_total, bool_or(x.is_line) AS has_line
  FROM (
    SELECT o.id, o.status, o.business_date, tl.method, tl.amount AS gross, 0::numeric AS paid_out, true AS is_line
      FROM orders o %s %s
    UNION ALL
    SELECT o.id, o.status, o.business_date, r.payment_method, 0, r.amount, false
      FROM orders o JOIN order_refunds r ON r.order_id = o.id %s
  ) x GROUP BY x.id, x.status, x.business_date, x.method
)`, tenderlines.Lateral, saleWhere, saleWhere)
	if !limited {
		sb := fmt.Sprintf(`sb AS (
  SELECT o.id, o.total, o.status, o.payment_method, o.business_date, true AS has_line,
         o.total - COALESCE((SELECT SUM(r.amount) FROM order_refunds r WHERE r.order_id = o.id), 0) AS net_total
  FROM orders o %s
)`, saleWhere)
		return sb + ",\n" + sbl, "sbl"
	}
	lineSrc = fmt.Sprintf("(SELECT * FROM sbl WHERE lower(btrim(payment_method)) = lower(btrim($%d))) lm", methodArg)
	sb := fmt.Sprintf(`sb AS (
  SELECT id, status, business_date, SUM(total) AS total, SUM(net_total) AS net_total, bool_or(has_line) AS has_line
  FROM %s GROUP BY id, status, business_date
)`, lineSrc)
	return sbl + ",\n" + sb, lineSrc
}

type spEqCase struct{ method, from, to string }

// oldSummaryStatement renders the old statement for one outlet and filter, with the where
// clauses written out by hand (the sale set binds the sale day, the refund set the refund day).
func oldSummaryStatement(outlet string, c spEqCase) (string, []any) {
	args := []any{}
	add := func(v any) int { args = append(args, v); return len(args) }
	isSplit := c.method == "split"
	limited := c.method != "" && !isSplit

	sale := fmt.Sprintf("WHERE 1=1 AND o.outlet_id=$%d", add(outlet))
	if c.from != "" {
		sale += fmt.Sprintf(" AND o.business_date >= $%d::text::date", add(c.from))
	}
	if c.to != "" {
		sale += fmt.Sprintf(" AND o.business_date <= $%d::text::date", add(c.to))
	}
	if c.method != "" {
		n := add(c.method)
		if isSplit {
			sale += fmt.Sprintf(" AND lower(btrim(o.payment_method)) = lower(btrim($%d))", n)
		} else {
			sale += fmt.Sprintf(` AND ((EXISTS (SELECT 1 FROM order_tenders pt WHERE pt.order_id = o.id AND lower(btrim(pt.method)) = lower(btrim($%[1]d)))
	    OR (NOT EXISTS (SELECT 1 FROM order_tenders pt2 WHERE pt2.order_id = o.id)
	        AND lower(btrim(o.payment_method)) = lower(btrim($%[1]d))))
	    OR EXISTS (SELECT 1 FROM order_refunds rp WHERE rp.order_id = o.id AND lower(btrim(rp.payment_method)) = lower(btrim($%[1]d))))`, n)
		}
	}
	sale += " AND o.status IN ('completed','partially_refunded','refunded')"

	refund := fmt.Sprintf("WHERE 1=1 AND o.outlet_id=$%d", add(outlet))
	if c.from != "" {
		refund += fmt.Sprintf(" AND r.refund_business_date >= $%d::text::date", add(c.from))
	}
	if c.to != "" {
		refund += fmt.Sprintf(" AND r.refund_business_date <= $%d::text::date", add(c.to))
	}
	if c.method != "" {
		col := "r.payment_method"
		if isSplit {
			col = "o.payment_method"
		}
		refund += fmt.Sprintf(" AND lower(btrim(%s)) = lower(btrim($%d))", col, add(c.method))
	}
	methodArg := 0
	if limited {
		methodArg = add(c.method)
	}
	ctes, lineSrc := oldSummaryCTEs(limited, sale, methodArg)
	return fmt.Sprintf(oldSummaryTemplate, ctes, refund, lineSrc), args
}

// summaryJSONMap normalizes a summary to a generic map without the echo fields only the new
// code path sets, so the old statement's decoded output and ReportSummary's compare equal.
func (e *spEnv) summaryJSONMap(v api.ReportSummary) map[string]any {
	e.t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		e.t.Fatal(err)
	}
	m := map[string]any{}
	if err := json.Unmarshal(raw, &m); err != nil {
		e.t.Fatal(err)
	}
	for _, k := range []string{"from", "to", "outletId", "dateFrom", "dateTo"} {
		delete(m, k)
	}
	return m
}

// equivFixture seeds one outlet with split, single, tenderless, cancelled, refunded and
// partially refunded orders spread over several business days. Every order has its own product
// (distinct revenue) so topProducts has no ties.
func (e *spEnv) equivFixture() spOutlet {
	o := e.newOutlet()
	prod := func() string { return e.newProduct(o, 10000) }
	split := func(total float64, a, b map[string]any) string {
		return e.sale(o, prod(), "split", total, total, []map[string]any{a, b}, "")
	}
	day := func(id string, ago int) {
		e.exec(`UPDATE orders SET business_date = current_date - $2::int WHERE id=$1`, id, ago)
	}
	refDay := func(id string, ago int) {
		e.exec(`UPDATE order_refunds SET refund_business_date = current_date - $2::int WHERE order_id=$1`, id, ago)
	}
	a := split(100000, map[string]any{"method": "qris", "amount": 60000}, map[string]any{"method": "cash", "amount": 40000})
	e.refund(o, a, "cash", "")
	day(a, 3)
	refDay(a, 2)
	b := split(50000, map[string]any{"method": "qris", "amount": 30000}, map[string]any{"method": "card", "amount": 20000})
	e.refund(o, b, "cash", "") // paid out in a method the sale never used
	day(b, 1)
	c := e.sale(o, prod(), "qris", 30000, 30000, nil, "")
	day(c, 1)
	d := e.sale(o, prod(), "cash", 20000, 20000, nil, "")
	day(d, 0)
	f := split(80000, map[string]any{"method": "qris", "amount": 50000}, map[string]any{"method": "cash", "amount": 30000})
	day(f, 2)
	h := e.sale(o, prod(), "cash", 25000, 25000, nil, "")
	e.refund(o, h, "qris", "") // single-method sale refunded in another method
	day(h, 1)
	e.partialCashSale(o, prod(), "")
	// a split sale of two units with one unit refunded (partially_refunded, refund in cash).
	p := e.salePayload(prod(), "split", 70000, 70000, 2, []map[string]any{
		{"method": "card", "amount": 30000}, {"method": "cash", "amount": 40000}})
	g := e.batchSale(o, p)
	rp := map[string]any{"orderId": g, "reason": "rusak", "deviceId": e.device, "orderUuid": e.nextID("1000"),
		"payoutMethod": "cash", "items": []map[string]any{{"lineNo": 0, "quantity": 1}}}
	e.send(o, "refund", rp, "")
	day(g, 2)
	day(e.rawOrder(o, "qris", "completed", 10000, ""), 1)
	e.rawOrder(o, "card", "cancelled", 9000, "")
	day(e.rawOrder(o, "cash", "refunded", 15000, ""), 3)
	return o
}

func (e *spEnv) summaryEquivalence() {
	o := e.equivFixture()
	day := func(ago int) string {
		var s string
		if err := e.pool.QueryRow(e.ctx, `SELECT to_char(current_date - $1::int,'YYYY-MM-DD')`, ago).Scan(&s); err != nil {
			e.t.Fatal(err)
		}
		return s
	}
	repo := read.New(e.pool)
	for _, w := range [][2]string{{"", ""}, {day(2), day(1)}, {day(1), ""}} {
		for _, m := range []string{"", "qris", "cash", "card", "CARD ", "split", "transfer"} {
			c := spEqCase{method: m, from: w[0], to: w[1]}
			label := fmt.Sprintf("method=%q window=%v", m, w)
			sql, args := oldSummaryStatement(o.id, c)
			var old api.ReportSummary
			var raw []byte
			if err := e.pool.QueryRow(e.ctx, sql, args...).Scan(&raw); err != nil {
				e.t.Fatalf("%s: old statement: %v", label, err)
			}
			if err := json.Unmarshal(raw, &old); err != nil {
				e.t.Fatalf("%s: old json: %v", label, err)
			}
			got, err := repo.ReportSummary(e.ctx, read.OrderFilter{Scope: read.Scope{OutletID: o.id},
				DateFrom: c.from, DateTo: c.to, PaymentMethod: c.method})
			if err != nil {
				e.t.Fatalf("%s: new summary: %v", label, err)
			}
			if gm, om := e.summaryJSONMap(got), e.summaryJSONMap(old); !reflect.DeepEqual(gm, om) {
				e.t.Fatalf("%s: new summary differs from the f03265c5 statement\n new %v\n old %v", label, gm, om)
			}
		}
	}
	// guard: the unfiltered, whole-range comparison is not trivially empty.
	all := e.summary(o.id, "")
	if all.GrossOrders < 8 || len(all.RefundsBy) < 1 || len(all.Daily) < 3 {
		e.t.Fatalf("equivalence fixture too weak: %+v", all)
	}
}
