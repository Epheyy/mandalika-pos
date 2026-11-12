package read

import (
	"context"

	"github.com/mandalika/pos-backend/internal/api"
	"github.com/mandalika/pos-backend/internal/bundles"
)

// BundleReportFilters bounds BundleReport: business days (orders.business_date, inclusive) and an
// outlet that is already scope-clamped by the handler ("" = all outlets).
type BundleReportFilters struct{ DateFrom, DateTo, OutletID string }

// bundleReportSQL counts one bundle per `large` piece (bundle_role='large'), grouped by the large
// piece's product (the fragrance), the line and the size stamped on the sale. Revenue and
// discount sum the three pieces that share (order_id, bundle_group). A bundle is whole-refund
// only (refund group set:<n>), so a bundle whose large piece has refund rows is excluded.
// The status list is the only place to extend when sales can be voided.
const bundleReportSQL = `
WITH sets AS (
  SELECT l.order_id, l.bundle_group, l.product_id, l.product_name,
         COALESCE(l.bundle_line,'') AS line, COALESCE(l.bundle_size,'') AS size
  FROM orders o
  JOIN order_items l ON l.order_id = o.id AND l.bundle_role = 'large'
  WHERE o.status IN ('completed','partially_refunded')
    AND ($3 = '' OR o.outlet_id::text = $3)
    AND ($1 = '' OR o.business_date >= $1::date)
    AND ($2 = '' OR o.business_date <= $2::date)
    AND NOT EXISTS (SELECT 1 FROM order_refund_items ri WHERE ri.order_item_id = l.id)
),
priced AS (
  SELECT s.product_id, s.product_name, s.line, s.size,
         SUM(i.subtotal) AS revenue, SUM(COALESCE(i.bundle_discount,0)) AS discount
  FROM sets s
  JOIN order_items i ON i.order_id = s.order_id AND i.bundle_group = s.bundle_group
  GROUP BY s.order_id, s.bundle_group, s.product_id, s.product_name, s.line, s.size
)
SELECT COALESCE(json_agg(json_build_object(
         'productId', product_id, 'productName', product_name, 'line', line, 'size', size,
         'bundles', bundles, 'revenue', revenue, 'discount', discount)
       ORDER BY bundles DESC, revenue DESC, product_name, line, size), '[]'::json)
FROM (SELECT product_id, MIN(product_name) AS product_name, line, size,
             COUNT(*) AS bundles, SUM(revenue) AS revenue, SUM(discount) AS discount
      FROM priced GROUP BY product_id, line, size) g`

// BundleReport returns bundles sold per fragrance, line and size. Money columns are exact sums of
// order_items.subtotal / bundle_discount, so item sales and bundle revenue agree.
func (r *Repo) BundleReport(ctx context.Context, f BundleReportFilters) (api.BundleReport, error) {
	var rows []api.BundleReportRow
	if err := r.Pool.QueryRow(ctx, bundleReportSQL, f.DateFrom, f.DateTo, f.OutletID).Scan(&rows); err != nil {
		return api.BundleReport{}, err
	}
	out := api.BundleReport{Data: rows}
	for i := range out.Data {
		out.Data[i].LineLabel, _ = bundles.LineInfo(out.Data[i].Line)
		out.Totals.Bundles += out.Data[i].Bundles
		out.Totals.Revenue += out.Data[i].Revenue
		out.Totals.Discount += out.Data[i].Discount
	}
	return out, nil
}
