package read

import (
	"context"
	"fmt"

	"github.com/mandalika/pos-backend/internal/api"
)

// Mirror service.RefundWarn*: read does not import service (it would invert the layering).
const (
	RefundFlagMismatch  = "amount_mismatch"
	RefundFlagOverTotal = "over_total"
)

// RefundReportFlags are the accepted Flag values (besides "").
var RefundReportFlags = map[string]bool{"any": true, RefundFlagMismatch: true, RefundFlagOverTotal: true}

// RefundReportFilters are the optional filters of the per-refund report ("" = no filter).
// DateFrom/DateTo are refund business days (order_refunds.refund_business_date); Flag is
// "any" (amount_mismatch or over_total), one of the two, or "".
type RefundReportFilters struct {
	DateFrom, DateTo, OutletID, Flag string
}

// refundReportObj is one refund row: the refund itself, its order and outlet, and the refunded
// lines with their names. cashierName is the sale's cashier, refundedByName who paid it out.
const refundReportObj = `json_build_object(
  'id',r.id,'orderId',r.order_id,'orderNumber',o.order_number,'outletId',r.outlet_id,'outletName',ou.name,
  'cashierName',o.cashier_name,'seq',r.seq,'scope',r.scope,'amount',r.amount,'computedAmount',r.computed_amount,
  'claimedAmount',r.claimed_amount,'amountWarning',r.amount_warning,'paymentMethod',r.payment_method,
  'reason',r.reason,'reasonCode',r.reason_code,'refundedByName',r.refunded_by_name,
  'refundedAt',r.refunded_at,'refundBusinessDate',r.refund_business_date,
  'items',COALESCE((SELECT json_agg(json_build_object(
     'orderItemId',ri.order_item_id,'lineNo',oi.line_no,'productName',oi.product_name,
     'variantSize',oi.variant_size,'quantity',ri.quantity,'amount',ri.amount)
     ORDER BY oi.line_no NULLS LAST, ri.order_item_id)
     FROM order_refund_items ri JOIN order_items oi ON oi.id=ri.order_item_id
     WHERE ri.refund_id=r.id),'[]'::json))`

func refundReportWhere(f RefundReportFilters) (string, []any) {
	where := `FROM order_refunds r JOIN orders o ON o.id=r.order_id JOIN outlets ou ON ou.id=r.outlet_id
	  WHERE ($1 = '' OR r.refund_business_date >= $1::text::date)
	    AND ($2 = '' OR r.refund_business_date <= $2::text::date)
	    AND ($3 = '' OR r.outlet_id::text = $3)
	    AND ($4 = '' OR ($4 = 'any' AND r.amount_warning IS NOT NULL) OR r.amount_warning = $4)`
	return where, []any{f.DateFrom, f.DateTo, f.OutletID, f.Flag}
}

// RefundReport returns one row per refund (newest first), a page of them, the total row count
// and a summary over the whole filtered set. OutletID must already be scope-clamped by the caller.
func (r *Repo) RefundReport(ctx context.Context, f RefundReportFilters, page, limit int) (api.RefundReportSummary, []api.RefundReportRow, int, error) {
	var sum api.RefundReportSummary
	where, args := refundReportWhere(f)
	if err := r.Pool.QueryRow(ctx,
		`SELECT count(*)::int, COALESCE(sum(r.amount),0)::float8,
		        count(*) FILTER (WHERE r.amount_warning IS NOT NULL)::int `+where, args...,
	).Scan(&sum.Count, &sum.TotalAmount, &sum.FlaggedCount); err != nil {
		return sum, nil, 0, fmt.Errorf("refund report summary: %w", err)
	}
	args = append(args, limit, off(page, limit))
	rows, total, err := listJSON[api.RefundReportRow](ctx, r.Pool,
		fmt.Sprintf(`SELECT %s, count(*) OVER() AS total %s
		  ORDER BY r.refunded_at DESC, r.id DESC LIMIT $%d OFFSET $%d`,
			refundReportObj, where, len(args)-1, len(args)), args...)
	return sum, rows, total, err
}
