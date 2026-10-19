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
// filter Repo.Orders uses, so the summary and the list/CSV cover identical rows) by
// created_at and CURRENT status. Refunded rows are already excluded from total_sales,
// so netSales equals totalSales; this is not settlement-time refund accounting (A27).
// Cancelled rows never count as money. Money/aggregation is server-authoritative.
func (r *Repo) ReportSummary(ctx context.Context, f OrderFilter) (api.ReportSummary, error) {
	where, args := buildOrderWhere(f)
	sql := fmt.Sprintf(`
WITH base AS (
  SELECT o.* FROM orders o %s
),
agg AS (
  SELECT
    COALESCE(SUM(total) FILTER (WHERE status='completed'),0)              AS total_sales,
    COUNT(*) FILTER (WHERE status='completed')                            AS total_orders,
    COALESCE(SUM(total) FILTER (WHERE status='refunded'),0)               AS total_refunds,
    COUNT(*) FILTER (WHERE status='refunded')                             AS refunded_orders
  FROM base
),
pay AS (
  SELECT COALESCE(json_object_agg(payment_method, s),'{}'::json) AS by_pm
  FROM (SELECT payment_method, SUM(total) AS s FROM base
        WHERE status='completed' GROUP BY payment_method) t
),
prod AS (
  SELECT COALESCE(json_agg(json_build_object(
           'productId',product_id,'productName',product_name,
           'quantity',qty,'revenue',rev) ORDER BY rev DESC),'[]'::json) AS top
  FROM (SELECT it.product_id, MIN(it.product_name) AS product_name,
               SUM(it.quantity) AS qty, SUM(it.subtotal) AS rev
        FROM order_items it JOIN base b ON b.id=it.order_id
        WHERE b.status='completed'
        GROUP BY it.product_id ORDER BY rev DESC LIMIT 10) p
),
daily AS (
  SELECT COALESCE(json_agg(json_build_object(
           'date',d,'sales',s,'orders',n) ORDER BY d),'[]'::json) AS rows
  FROM (SELECT to_char(business_date,'YYYY-MM-DD') AS d,
               SUM(total) AS s, COUNT(*) AS n
        FROM base WHERE status='completed'
        GROUP BY 1 ORDER BY 1) g
)
SELECT json_build_object(
  'totalSales',agg.total_sales,'totalOrders',agg.total_orders,
  'totalRefunds',agg.total_refunds,'refundedOrders',agg.refunded_orders,
  'netSales',agg.total_sales,
  'avgOrderValue',CASE WHEN agg.total_orders>0
     THEN agg.total_sales/agg.total_orders ELSE 0 END,
  'byPaymentMethod',pay.by_pm,'topProducts',prod.top,'dailySales',daily.rows)
FROM agg, pay, prod, daily`, where)
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
