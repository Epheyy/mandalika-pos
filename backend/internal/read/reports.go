package read

import (
	"context"
	"fmt"
	"time"

	"github.com/oapi-codegen/nullable"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/mandalika/pos-backend/internal/api"
)

// ReportSummary aggregates the rows selected by the shared OrderFilter (the same
// filter Repo.Orders uses, so the summary and the list/CSV cover identical rows).
//
// A27: two row sets from one filter. Sale set sb = completed+partially_refunded+refunded rows
// bound on the SALE day; refund set rb = one row per order_refunds row bound on the REFUND day
// (r.refund_business_date, or r.refunded_at for the legacy instants). totalSales/byPayment/
// products stay still-sold amounts by sale day; gross = all of sb; refunds = all of rb;
// net = gross - refunds. NEVER totalSales - totalRefunds: a refunded sale is already missing from
// totalSales, so that would subtract it twice. C4a: a partially_refunded order is a sale that is
// still counted (totalOrders), but every sale-set order enters totalSales/byPayment/dailySales
// as net_total = total - sum of its refund rows, UNCLAMPED: total for a completed order, 0 for a
// legacy full refund, and the real remainder when a refund's amount of record differs from the
// computed share (D-39). products use refunded item quantities. grossSales is unchanged.
// Cancelled rows are
// never money; status=completed empties rb (a completed order has no refund row).
// sb/rb select only the columns the CTEs below use (full rows are ~800 bytes each).
// sum(dailySales[].netSales) == netSales depends on every refund row having a
// refund_business_date (the order_refunds trigger stamps it; rd skips NULL days, ragg does not).
func (r *Repo) ReportSummary(ctx context.Context, f OrderFilter) (api.ReportSummary, error) {
	sf, rf := f, f
	sf.DateBasis, rf.DateBasis = "sale", "refund"
	sf.summary, rf.summary = true, true
	saleWhere, args := appendOrderWhere(sf, []any{}, false)
	saleWhere += " AND o.status IN ('completed','partially_refunded','refunded')"
	refundWhere, args := appendOrderWhere(rf, args, true)
	sbSQL, lineSrc := summarySaleCTEs(f, saleWhere, &args)
	sql := fmt.Sprintf(`
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
  -- C6a: per (order, method) rows. The row filter moved from the order to the row: a fully
  -- refunded split order keeps its +QRIS / -cash rows although its order net is 0.
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
                     -- units already refunded on a part-refunded order; 0 for a completed one
                     CASE WHEN b.status='partially_refunded' THEN COALESCE(
                       (SELECT SUM(ri.quantity) FROM order_refund_items ri WHERE ri.order_item_id = it.id), 0)
                       ELSE 0 END AS rq
                FROM order_items it JOIN sb b ON b.id=it.order_id
                WHERE b.has_line AND b.status IN ('completed','partially_refunded')) x
        WHERE x.rq = 0 OR x.quantity > x.rq  -- a fully returned line of a part-refunded order is gone
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
  -- refundedOrders is distinct per day: summing dailySales[].refundedOrders can exceed the
  -- top-level refundedOrders when one order is refunded on two days.
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
FROM agg, ragg, pay, gpay, rpay, prod, daily`, sbSQL, refundWhere, lineSrc)
	v, err := oneJSON[api.ReportSummary](ctx, r.Pool, sql, args...)
	if err != nil {
		return v, err
	}
	// Echo the applied window and scope; null where a side is unbounded / cross-outlet.
	from, to := f.appliedWindow()
	v.From, v.To, v.OutletId = nullable.NewNullNullable[time.Time](), nullable.NewNullNullable[time.Time](), nullable.NewNullNullable[string]()
	v.DateFrom, v.DateTo = nullable.NewNullNullable[openapi_types.Date](), nullable.NewNullNullable[openapi_types.Date]()
	for _, b := range []struct {
		day string
		dst *nullable.Nullable[openapi_types.Date]
	}{{f.DateFrom, &v.DateFrom}, {f.DateTo, &v.DateTo}} {
		if b.day == "" {
			continue
		}
		d, err := time.Parse("2006-01-02", b.day)
		if err != nil {
			return v, err
		}
		*b.dst = nullable.NewNullableWithValue(openapi_types.Date{Time: d})
	}
	if from != nil {
		v.From = nullable.NewNullableWithValue(*from)
	}
	if to != nil {
		v.To = nullable.NewNullableWithValue(*to)
	}
	if !f.Scope.CrossAll {
		v.OutletId = nullable.NewNullableWithValue(f.Scope.OutletID)
	}
	return v, nil
}

// summarySaleCTEs renders the sale-side CTEs of ReportSummary (C6a). It returns the CTE list
// (sb = one row per order, sbl = one row per (order, method)) and the source the by-method
// maps read.
//
//   - sb is the per-order set that totals, products and the daily series read. Unfiltered, or
//     under the `split` filter value, it is exactly the pre-C6 per-order query (whole-order
//     money). Under a method filter (D-66) it is rebuilt from that method's rows: total = the
//     method's payment lines, net_total = those lines minus the refunds paid out in that method.
//     Every limited row nets (an order refunded in the method without ever using it enters with
//     gross 0); has_line keeps order counts, products and gross to orders that used the method.
//     topProducts reads sb's orders at full line revenue (sale lines are not allocated across
//     payments), so under a method filter it can exceed the limited totalSales; documented
//     trade-off of D-66.
//   - sbl unions the order's payment lines with its refund rows per (order, method), so a refund
//     paid out in a method the sale did not use still nets that method negative and the maps
//     keep adding up to the order. has_line marks methods that had a payment line (gross only).
//
// saleWhere is rendered ONCE, as a MATERIALIZED base CTE (sb unfiltered, so under a method
// filter) that sbl reads for both its payment lines and its refund rows, so the filter scan of
// orders is not repeated. sbl builds the payment lines set-based (a join on order_tenders plus
// an anti-join for the synthetic line of an order without stored lines) instead of through the
// per-order tenderlines.Lateral: same rows, but one hash join over the sale set instead of two
// index probes per order (the equivalence is gated by SP subtest 13). Keep it in step with the
// fragment's synthetic-line rule.
// A method filter appends its own argument for the CTE comparison.
func summarySaleCTEs(f OrderFilter, saleWhere string, args *[]any) (ctes, lineSrc string) {
	if !f.isMethodLimited() {
		sb := fmt.Sprintf(`sb AS MATERIALIZED (
  SELECT o.id, o.total, o.status, o.payment_method, o.business_date, true AS has_line,
         o.total - COALESCE((SELECT SUM(r.amount) FROM order_refunds r WHERE r.order_id = o.id), 0) AS net_total
  FROM orders o %s
)`, saleWhere)
		return sb + ",\n" + summaryLinesCTE("sb"), "sbl"
	}
	so := fmt.Sprintf(`so AS MATERIALIZED (
  SELECT o.id, o.total, o.status, o.payment_method, o.business_date
  FROM orders o %s
)`, saleWhere)
	*args = append(*args, f.PaymentMethod)
	n := len(*args)
	lineSrc = fmt.Sprintf("(SELECT * FROM sbl WHERE lower(btrim(payment_method)) = lower(btrim($%d))) lm", n)
	sb := fmt.Sprintf(`sb AS (
  SELECT id, status, business_date, SUM(total) AS total, SUM(net_total) AS net_total, bool_or(has_line) AS has_line
  FROM %s GROUP BY id, status, business_date
)`, lineSrc)
	return so + ",\n" + summaryLinesCTE("so") + ",\n" + sb, lineSrc
}

// summaryLinesCTE renders sbl over the materialized sale-set base CTE `base`.
func summaryLinesCTE(base string) string {
	return fmt.Sprintf(`sbl AS (
  SELECT x.id, x.status, x.business_date, x.method AS payment_method,
         SUM(x.gross) AS total, SUM(x.gross) - SUM(x.paid_out) AS net_total, bool_or(x.is_line) AS has_line
  FROM (
    SELECT o.id, o.status, o.business_date, t.method, t.amount AS gross, 0::numeric AS paid_out, true AS is_line
      FROM %[1]s o JOIN order_tenders t ON t.order_id = o.id
    UNION ALL
    SELECT o.id, o.status, o.business_date, o.payment_method, o.total, 0::numeric, true
      FROM %[1]s o WHERE NOT EXISTS (SELECT 1 FROM order_tenders t2 WHERE t2.order_id = o.id)
    UNION ALL
    SELECT o.id, o.status, o.business_date, r.payment_method, 0, r.amount, false
      FROM %[1]s o JOIN order_refunds r ON r.order_id = o.id
  ) x GROUP BY x.id, x.status, x.business_date, x.method
)`, base)
}
