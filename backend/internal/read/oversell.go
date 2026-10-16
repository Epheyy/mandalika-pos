package read

import (
	"context"

	"github.com/mandalika/pos-backend/internal/api"
)

// OversellFilters bounds the A44 oversell report. Every field is optional
// ("" = no filter). DateFrom/DateTo are WIB (Asia/Jakarta) calendar days applied
// to sold_at (the business time, not the sync time). OutletID must come from the
// caller's scope, never from a raw query parameter.
type OversellFilters struct {
	DateFrom, DateTo, OutletID, ProductID, VariantSize, CashierID, Kind, Status string
}

// oversellWhere is the shared filter clause; the order join is needed for the
// refunded/cancelled split. Parameters $1..$8 are fixed in this order.
const oversellFrom = `FROM sale_stock_exceptions x
		JOIN orders o ON o.id = x.order_id`

const oversellFilter = `
		WHERE ($1 = '' OR x.sold_at >= ($1::date)::timestamp AT TIME ZONE 'Asia/Jakarta')
		  AND ($2 = '' OR x.sold_at <  (($2::date + 1)::timestamp AT TIME ZONE 'Asia/Jakarta'))
		  AND ($3 = '' OR x.outlet_id::text = $3)
		  AND ($4 = '' OR x.product_id::text = $4)
		  AND ($5 = '' OR x.variant_size = $5)
		  AND ($6 = '' OR x.cashier_id::text = $6)
		  AND ($7 = '' OR x.kind = $7)
		  AND ($8 = '' OR ($8 = 'open' AND x.acknowledged_at IS NULL)
		               OR ($8 = 'acknowledged' AND x.acknowledged_at IS NOT NULL))`

const oversellWhere = oversellFrom + oversellFilter

// SaleStockExceptionReport returns the summary over the full filtered set and one
// page of records (newest sale first). It returns (summary, page, total rows, error).
func (r *Repo) SaleStockExceptionReport(ctx context.Context, f OversellFilters, page, limit int) (api.OversellSummary, []api.OversellRecord, int, error) {
	var sum api.OversellSummary
	args := []any{f.DateFrom, f.DateTo, f.OutletID, f.ProductID, f.VariantSize, f.CashierID, f.Kind, f.Status}

	if err := r.Pool.QueryRow(ctx,
		`SELECT COUNT(*), COUNT(DISTINCT x.order_id),
		        COALESCE(SUM(x.shortfall),0),
		        COALESCE(SUM(x.shortfall) FILTER (WHERE o.status = 'completed'),0),
		        COALESCE(SUM(x.shortfall) FILTER (WHERE o.status <> 'completed'),0),
		        COUNT(*) FILTER (WHERE x.acknowledged_at IS NULL) `+oversellWhere, args...,
	).Scan(&sum.Lines, &sum.Orders, &sum.TotalShortfall, &sum.ActiveShortfall, &sum.ReversedShortfall, &sum.OpenCount); err != nil {
		return sum, nil, 0, err
	}

	byProduct, _, err := listJSON[api.OversellBreakdown](ctx, r.Pool,
		`SELECT json_build_object('key', x.product_id::text, 'name', MAX(x.product_name),
		   'variantSize', x.variant_size, 'lines', COUNT(*), 'shortfall', SUM(x.shortfall)) `+oversellWhere+
			` GROUP BY x.product_id, x.variant_size ORDER BY SUM(x.shortfall) DESC, x.product_id, x.variant_size LIMIT 50`, args...)
	if err != nil {
		return sum, nil, 0, err
	}
	sum.ByProduct = byProduct

	byCashier, _, err := listJSON[api.OversellBreakdown](ctx, r.Pool,
		`SELECT json_build_object('key', x.cashier_id::text, 'name', MAX(x.cashier_name),
		   'lines', COUNT(*), 'shortfall', SUM(x.shortfall)) `+oversellWhere+
			` GROUP BY x.cashier_id ORDER BY SUM(x.shortfall) DESC, x.cashier_id LIMIT 50`, args...)
	if err != nil {
		return sum, nil, 0, err
	}
	sum.ByCashier = byCashier

	// $9=limit, $10=offset. The page re-joins outlets/variants/stock for display only.
	rows, _, err := listJSON[api.OversellRecord](ctx, r.Pool,
		`SELECT json_build_object(
		   'id', x.id, 'orderId', x.order_id, 'orderNumber', x.order_number, 'orderStatus', o.status,
		   'outletId', x.outlet_id, 'outletName', ol.name,
		   'productId', x.product_id, 'productName', x.product_name, 'variantSize', x.variant_size,
		   'sku', pv.sku, 'kind', x.kind, 'quantity', x.quantity,
		   'stockBefore', x.stock_before, 'stockAfter', x.stock_after, 'shortfall', x.shortfall,
		   'currentStock', s.stock, 'channel', x.channel,
		   'cashierId', x.cashier_id, 'cashierName', x.cashier_name,
		   'shiftId', x.shift_id, 'deviceId', x.device_id,
		   'soldAt', x.sold_at, 'recordedAt', x.recorded_at,
		   'acknowledgedAt', x.acknowledged_at, 'acknowledgedByName', x.acknowledged_by_name,
		   'acknowledgeNote', x.acknowledge_note)
		 `+oversellFrom+`
		 JOIN outlets ol ON ol.id = x.outlet_id
		 LEFT JOIN LATERAL (SELECT v.sku FROM product_variants v WHERE v.product_id = x.product_id AND v.size = x.variant_size LIMIT 1) pv ON true
		 LEFT JOIN outlet_variant_stock s ON s.outlet_id = x.outlet_id AND s.product_id = x.product_id AND s.variant_size = x.variant_size`+oversellFilter+`
		 ORDER BY x.sold_at DESC, x.id LIMIT $9 OFFSET $10`,
		append(args, limit, off(page, limit))...)
	if err != nil {
		return sum, nil, 0, err
	}
	return sum, rows, sum.Lines, nil
}

// OversellOpenCount is the badge number: unchecked exception lines in scope
// (outletID "" = all outlets). Served by the partial index idx_sse_open.
func (r *Repo) OversellOpenCount(ctx context.Context, outletID string) (int, error) {
	var n int
	err := r.Pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM sale_stock_exceptions
		  WHERE acknowledged_at IS NULL AND ($1 = '' OR outlet_id::text = $1)`, outletID).Scan(&n)
	return n, err
}
