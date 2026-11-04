package read

import (
	"context"
	"fmt"
	"strings"

	"github.com/mandalika/pos-backend/internal/api"
	"github.com/mandalika/pos-backend/internal/tenderlines"
)

// Trend granularities of DashboardAggregate.
const (
	DashboardTrendHour  = "hour"
	DashboardTrendDay   = "day"
	DashboardTrendMonth = "month"
)

// DashboardFilter selects what Ringkasan shows. Scope must come from scope(r). Days are
// business days (YYYY-MM-DD, inclusive). From may be empty (open start, period "Semua");
// PrevFrom/PrevTo are both set or both empty and end before From.
type DashboardFilter struct {
	Scope            Scope
	From, To         string
	PrevFrom, PrevTo string
	// Trend is one of the DashboardTrend* constants.
	Trend string
	// TzOffsetMin shifts the hour buckets to the viewer's local clock (minutes east of UTC).
	TzOffsetMin int
}

// DashboardAggregate computes in one statement (one snapshot) every number the backoffice
// Ringkasan screen used to derive in the browser from the full order list (see
// docs/plans/2026-11-04-ringkasan-dashboard-aggregate.md). It mirrors screens/dashboard/metrics.ts
// and reports/reportTotals.ts: sales by SALE business day, refunds by REFUND business day, never
// totalSales - totalRefunds.
//
// sb is one row per sale-set order (completed, partially refunded, refunded) over the UNION of the
// two disjoint windows, tagged 'cur' / 'prev'; rb is one row per refund row of a refunded or
// partially refunded order by refund day. Window figures, items, customers and the revenue read sb
// (never the per-method lines, so a split-tender order is not multiplied). The ranking keeps fully
// returned lines at 0 units and groups by (product, variant), exactly like the screen, unlike
// ReportSummary.prod. rk is the newest-first position of an order (created_at DESC, id DESC, the
// order the list endpoint returns), so ties break by first-seen order like the screen's stable sort.
func (r *Repo) DashboardAggregate(ctx context.Context, f DashboardFilter) (api.DashboardAggregate, error) {
	unionFrom := f.From
	if f.PrevFrom != "" {
		unionFrom = f.PrevFrom
	}
	sf := OrderFilter{Scope: f.Scope, DateFrom: unionFrom, DateTo: f.To, DateBasis: "sale"}
	rf := OrderFilter{Scope: f.Scope, DateFrom: unionFrom, DateTo: f.To, DateBasis: "refund"}
	saleWhere, args := appendOrderWhere(sf, []any{}, false)
	saleWhere += " AND o.status IN ('completed','partially_refunded','refunded')"
	refundWhere, args := appendOrderWhere(rf, args, true)
	refundWhere += " AND o.status IN ('refunded','partially_refunded')"
	if !f.Scope.CrossAll {
		// order_refunds carries the outlet too: lets idx_order_refunds_outlet_day serve the window.
		args = append(args, f.Scope.OutletID)
		refundWhere += fmt.Sprintf(" AND r.outlet_id=$%d", len(args))
	}
	arg := func(v any) int {
		args = append(args, v)
		return len(args)
	}
	dayArg := func(day string) string {
		if day == "" {
			return "NULL::date"
		}
		return fmt.Sprintf("$%d::text::date", arg(day))
	}
	windows := fmt.Sprintf("('cur', %s, %s)", dayArg(f.From), dayArg(f.To))
	if f.PrevFrom != "" {
		windows += fmt.Sprintf(", ('prev', %s, %s)", dayArg(f.PrevFrom), dayArg(f.PrevTo))
	}
	saleBucket, refundBucket := "to_char(b.business_date,'YYYY-MM-DD')", "to_char(x.d,'YYYY-MM-DD')"
	switch f.Trend {
	case DashboardTrendMonth:
		saleBucket, refundBucket = "to_char(b.business_date,'YYYY-MM')", "to_char(x.d,'YYYY-MM')"
	case DashboardTrendHour:
		n := arg(f.TzOffsetMin)
		// The viewer's local hour: UTC wall clock shifted by the viewer's offset.
		saleBucket = fmt.Sprintf("to_char((b.created_at AT TIME ZONE 'UTC') + make_interval(mins => $%d::int),'HH24')", n)
		refundBucket = fmt.Sprintf("to_char((x.refunded_at AT TIME ZONE 'UTC') + make_interval(mins => $%d::int),'HH24')", n)
	}
	const sold = "b.status IN ('completed','partially_refunded')"
	sql := fmt.Sprintf(`
WITH win(w, f, t) AS (VALUES %[1]s),
sb AS MATERIALIZED (
  SELECT o.id, o.total, o.status, o.payment_method, o.business_date, o.created_at, o.customer_id,
         o.cashier_id, o.cashier_name, o.discount_label, o.discount_amount, o.discount_breakdown,
         o.total - COALESCE(rs.refunded, 0) AS net_total, w.w AS win,
         row_number() OVER (ORDER BY o.created_at DESC, o.id DESC) AS rk
  FROM orders o
  JOIN win w ON o.business_date BETWEEN COALESCE(w.f,'-infinity'::date) AND COALESCE(w.t,'infinity'::date)
  LEFT JOIN (SELECT r.order_id, SUM(r.amount) AS refunded FROM order_refunds r
             WHERE r.order_id IN (SELECT o.id FROM orders o %[2]s) GROUP BY r.order_id) rs ON rs.order_id = o.id
  %[2]s
),
rb AS MATERIALIZED (
  SELECT r.order_id, r.amount, COALESCE(NULLIF(r.payment_method,''), o.payment_method) AS method,
         r.refund_business_date AS d, r.refunded_at, w.w AS win
  FROM orders o
  JOIN order_refunds r ON r.order_id = o.id
  JOIN win w ON r.refund_business_date BETWEEN COALESCE(w.f,'-infinity'::date) AND COALESCE(w.t,'infinity'::date)
  %[3]s
),
sagg AS (
  SELECT win, COALESCE(SUM(total),0) AS gross, COUNT(*) AS gross_n,
         COALESCE(SUM(net_total) FILTER (WHERE %[4]s),0) AS still,
         COUNT(*) FILTER (WHERE %[4]s) AS orders,
         COUNT(DISTINCT customer_id) FILTER (WHERE %[4]s) AS customers
  FROM sb b GROUP BY win
),
ragg AS (SELECT win, COALESCE(SUM(amount),0) AS refunds, COUNT(DISTINCT order_id) AS refunded_n FROM rb GROUP BY win),
itm AS (
  SELECT b.win, b.rk, it.product_id, it.variant_size, it.product_name,
         GREATEST(it.quantity - CASE WHEN b.status = 'partially_refunded'
           THEN COALESCE((SELECT SUM(ri.quantity) FROM order_refund_items ri WHERE ri.order_item_id = it.id), 0)
           ELSE 0 END, 0) AS sold
  FROM sb b JOIN order_items it ON it.order_id = b.id
  WHERE %[4]s
),
iagg AS (SELECT win, COALESCE(SUM(sold),0) AS items FROM itm GROUP BY win),
wjson AS (
  SELECT w.w, json_build_object(
    'gross', COALESCE(s.gross,0), 'grossCount', COALESCE(s.gross_n,0),
    'refunds', COALESCE(g.refunds,0), 'refundedCount', COALESCE(g.refunded_n,0),
    'net', COALESCE(s.gross,0) - COALESCE(g.refunds,0),
    'orders', COALESCE(s.orders,0), 'itemsSold', COALESCE(i.items,0),
    'customers', COALESCE(s.customers,0), 'stillSoldRevenue', COALESCE(s.still,0)) AS j
  FROM win w LEFT JOIN sagg s ON s.win = w.w LEFT JOIN ragg g ON g.win = w.w LEFT JOIN iagg i ON i.win = w.w
),
rk AS (
  SELECT product_id, variant_size, (array_agg(product_name ORDER BY rk))[1] AS product_name,
         SUM(sold) AS qty, MIN(rk) AS first_seen
  FROM itm WHERE win = 'cur' GROUP BY product_id, variant_size
),
rr AS (
  SELECT *, row_number() OVER (ORDER BY qty DESC, first_seen ASC, product_id, variant_size) AS rn_top,
         row_number() OVER (ORDER BY qty ASC, first_seen DESC, product_id DESC, variant_size DESC) AS rn_bottom,
         count(*) OVER () AS total
  FROM rk
),
csh AS (
  SELECT b.cashier_id, (array_agg(b.cashier_name ORDER BY b.rk))[1] AS name, COUNT(*) AS n,
         COALESCE(SUM(b.net_total),0) AS revenue, MIN(b.rk) AS first_seen
  FROM sb b WHERE b.win = 'cur' AND %[4]s GROUP BY b.cashier_id
  ORDER BY n DESC, first_seen ASC LIMIT 8
),
comp AS (
  SELECT c.label, c.amount
  FROM sb b
  CROSS JOIN LATERAL (
    SELECT e->>'label' AS label,
           CASE WHEN jsonb_typeof(e->'amount') = 'number' THEN (e->>'amount')::numeric ELSE 0 END AS amount
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(b.discount_breakdown) = 'array'
                                     THEN b.discount_breakdown ELSE '[]'::jsonb END) e
    UNION ALL
    SELECT b.discount_label, COALESCE(b.discount_amount, 0)
     -- SQL NULL, jsonb null, {} and [] all take the label path (a CASE: AND does not short-circuit, and NULL AND NULL drops the row)
     WHERE NOT CASE WHEN jsonb_typeof(b.discount_breakdown) = 'array' THEN jsonb_array_length(b.discount_breakdown) > 0 ELSE false END
  ) c
  WHERE b.win = 'cur' AND %[4]s
),
ptally AS (
  SELECT label, COUNT(*) AS cnt, COALESCE(SUM(amount),0) AS amount FROM comp
  WHERE label IS NOT NULL AND label <> '' AND label IN (SELECT name FROM promotions)
  GROUP BY label
),
gpay AS (
  SELECT COALESCE(json_object_agg(method, s), '{}'::json) AS m
  FROM (SELECT l.method, SUM(l.amount) AS s FROM (%[5]s) l GROUP BY l.method) t
),
rpay AS (
  SELECT COALESCE(json_object_agg(method, s), '{}'::json) AS m
  FROM (SELECT method, SUM(amount) AS s FROM rb WHERE win = 'cur' GROUP BY method) t
),
tsale AS (SELECT %[6]s AS bucket, SUM(b.total) AS sales, COUNT(*) AS n FROM sb b WHERE b.win = 'cur' GROUP BY 1),
tref AS (SELECT %[7]s AS bucket, SUM(x.amount) AS refunds FROM rb x WHERE x.win = 'cur' GROUP BY 1),
trend AS (
  SELECT COALESCE(json_agg(json_build_object('bucket', bucket, 'sales', COALESCE(sales,0), 'orders', COALESCE(n,0),
           'refunds', COALESCE(refunds,0)) ORDER BY bucket), '[]'::json) AS rows
  FROM (SELECT COALESCE(s.bucket, g.bucket) AS bucket, s.sales, s.n, g.refunds
        FROM tsale s FULL OUTER JOIN tref g ON g.bucket = s.bucket) u
)
SELECT json_build_object(
  'current', (SELECT j FROM wjson WHERE w = 'cur'),
  'previous', (SELECT j FROM wjson WHERE w = 'prev'),
  'trend', trend.rows,
  'grossByPaymentMethod', gpay.m, 'refundsByPaymentMethod', rpay.m,
  'topProducts', COALESCE((SELECT json_agg(json_build_object('productId', product_id, 'productName', product_name,
        'variantSize', variant_size, 'qty', qty) ORDER BY rn_top) FROM rr WHERE rn_top <= 10), '[]'::json),
  'bottomProducts', COALESCE((SELECT json_agg(json_build_object('productId', product_id, 'productName', product_name,
        'variantSize', variant_size, 'qty', qty) ORDER BY rn_bottom) FROM rr WHERE rn_bottom <= 10), '[]'::json),
  'distinctProducts', COALESCE((SELECT MAX(total) FROM rr), 0),
  'cashiers', COALESCE((SELECT json_agg(json_build_object('id', cashier_id, 'name', name, 'transactions', n,
        'revenue', revenue) ORDER BY n DESC, first_seen ASC) FROM csh), '[]'::json),
  'promoTally', COALESCE((SELECT json_agg(json_build_object('label', label, 'count', cnt, 'amount', amount)
        ORDER BY label) FROM ptally), '[]'::json))
FROM trend, gpay, rpay`,
		windows, saleWhere, refundWhere, sold,
		strings.TrimSpace(tenderlines.SetLines("(SELECT id, payment_method, total FROM sb WHERE win = 'cur')", nil)),
		saleBucket, refundBucket)
	return oneJSON[api.DashboardAggregate](ctx, r.Pool, sql, args...)
}
