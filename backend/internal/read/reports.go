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
// still counted (totalOrders), but it enters totalSales/byPayment/products NET of what was
// refunded on it (net_total, refunded item quantities), exactly as a fully refunded order leaves
// them, so totalSales + the refunds of those orders stays equal to gross. Cancelled rows are
// never money; status=completed empties rb (a completed order has no refund row).
// sb/rb select only the columns the CTEs below use (full rows are ~800 bytes each).
// sum(dailySales[].netSales) == netSales depends on every refund row having a
// refund_business_date (the order_refunds trigger stamps it; rd skips NULL days, ragg does not).
func (r *Repo) ReportSummary(ctx context.Context, f OrderFilter) (api.ReportSummary, error) {
	sf, rf := f, f
	sf.DateBasis, rf.DateBasis = "sale", "refund"
	saleWhere, args := appendOrderWhere(sf, []any{}, false)
	saleWhere += " AND o.status IN ('completed','partially_refunded','refunded')"
	refundWhere, args := appendOrderWhere(rf, args, true)
	sql := fmt.Sprintf(`
WITH sb AS (
  SELECT o.id, o.total, o.status, o.payment_method, o.business_date,
         CASE WHEN o.status='completed' THEN o.total
              WHEN o.status='partially_refunded' THEN GREATEST(o.total - COALESCE(
                (SELECT SUM(r.amount) FROM order_refunds r WHERE r.order_id = o.id), 0), 0)
              ELSE 0 END AS net_total
  FROM orders o %s
),
rb AS (
  SELECT r.order_id, r.amount, r.payment_method, r.refund_business_date
  FROM orders o JOIN order_refunds r ON r.order_id = o.id %s
),
agg AS (
  SELECT
    COALESCE(SUM(net_total) FILTER (WHERE status IN ('completed','partially_refunded')),0) AS total_sales,
    COUNT(*) FILTER (WHERE status IN ('completed','partially_refunded'))                   AS total_orders,
    COALESCE(SUM(total),0)                                                                 AS gross_sales,
    COUNT(*)                                                                               AS gross_orders
  FROM sb
),
ragg AS (
  SELECT COALESCE(SUM(amount),0) AS total_refunds, COUNT(DISTINCT order_id) AS refunded_orders FROM rb
),
pay AS (
  SELECT COALESCE(json_object_agg(payment_method, s),'{}'::json) AS by_pm
  FROM (SELECT payment_method, SUM(net_total) AS s FROM sb
        WHERE status IN ('completed','partially_refunded') GROUP BY payment_method) t
),
gpay AS (
  SELECT COALESCE(json_object_agg(payment_method, s),'{}'::json) AS by_pm
  FROM (SELECT payment_method, SUM(total) AS s FROM sb GROUP BY payment_method) t
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
               SUM(CASE WHEN x.quantity > 0 THEN x.subtotal * (x.quantity - x.rq) / x.quantity ELSE 0 END) AS rev
        FROM (SELECT it.product_id, it.product_name, it.quantity, it.subtotal,
                     -- units already refunded on a part-refunded order; 0 for a completed one
                     CASE WHEN b.status='partially_refunded' THEN COALESCE(
                       (SELECT SUM(ri.quantity) FROM order_refund_items ri WHERE ri.order_item_id = it.id), 0)
                       ELSE 0 END AS rq
                FROM order_items it JOIN sb b ON b.id=it.order_id
                WHERE b.status IN ('completed','partially_refunded')) x
        GROUP BY x.product_id HAVING SUM(x.quantity - x.rq) > 0 ORDER BY rev DESC LIMIT 10) p
),
sd AS (
  SELECT business_date AS d,
         SUM(net_total) FILTER (WHERE status IN ('completed','partially_refunded')) AS s,
         COUNT(*) FILTER (WHERE status IN ('completed','partially_refunded'))       AS n,
         SUM(total) AS g, COUNT(*) AS gn
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
FROM agg, ragg, pay, gpay, rpay, prod, daily`, saleWhere, refundWhere)
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
