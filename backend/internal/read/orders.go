package read

import (
	"context"
	"fmt"

	"github.com/mandalika/pos-backend/internal/api"
)

const orderObj = `json_build_object('id',o.id,'orderNumber',o.order_number,
  'outletId',o.outlet_id,'cashierId',o.cashier_id,'cashierName',o.cashier_name,
  'salesmanId',o.salesman_id,'salesmanName',o.salesman_name,
  'customerId',o.customer_id,'customerName',o.customer_name,
  'subtotal',o.subtotal,'discountAmount',o.discount_amount,
  'discountType',o.discount_type,'discountValue',o.discount_value,
  'discountCode',o.discount_code,'discountLabel',o.discount_label,
  'discountBreakdown',o.discount_breakdown,
  'discountWarning',o.discount_warning,'discountWarningReason',o.discount_warning_reason,
  'stockWarning',o.stock_warning,
  'quotedTotal',CASE WHEN o.receipt_snapshot IS NOT NULL THEN o.quoted_total END,'quoteWarning',o.quote_warning,'quoteWarningReason',o.quote_warning_reason,
  'tenderWarning',o.tender_warning,'tenderWarningReason',o.tender_warning_reason,
  'surchargeType',o.surcharge_type,'surchargeValue',o.surcharge_value,
  'surchargeAmount',o.surcharge_amount,
  'taxAmount',o.tax_amount,'total',o.total,
  'paymentMethod',o.payment_method,'amountPaid',o.amount_paid,'change',o.change,
  'status',o.status,'notes',o.notes,'refundReason',o.refund_reason,
  'refundedAt',o.refunded_at,'refundBusinessDate',o.refund_business_date,'shiftId',o.shift_id,'createdAt',o.created_at,'businessDate',o.business_date,
  'refundShiftId',o.refund_shift_id,'refundedBy',o.refunded_by,'refundedByName',o.refunded_by_name,
  'pointsRedeemed',o.points_redeemed,
  'items',COALESCE((SELECT json_agg(json_build_object(
     'productId',it.product_id,'productName',it.product_name,
     'variantSize',it.variant_size,'price',it.price,'quantity',it.quantity,
     'subtotal',it.subtotal,'isBundle',it.is_bundle))
     FROM order_items it WHERE it.order_id=o.id),'[]'::json))`

func (r *Repo) Orders(ctx context.Context, f OrderFilter, page, limit int) ([]api.Order, int, error) {
	where, args := buildOrderWhere(f)
	args = append(args, limit, off(page, limit))
	order := "o.created_at DESC, o.id DESC"
	if f.refundBasis() {
		order = "o.refunded_at DESC NULLS LAST, o.id DESC"
	}
	sql := fmt.Sprintf(`SELECT %s, count(*) OVER() AS total FROM orders o %s
	  ORDER BY %s LIMIT $%d OFFSET $%d`,
		orderObj, where, order, len(args)-1, len(args))
	return listJSON[api.Order](ctx, r.Pool, sql, args...)
}

func (r *Repo) Order(ctx context.Context, sc Scope, id string) (api.Order, error) {
	args := []any{id}
	cond := ""
	if !sc.CrossAll {
		args = append(args, sc.OutletID)
		cond = " AND o.outlet_id=$2"
	}
	return oneJSON[api.Order](ctx, r.Pool,
		`SELECT `+orderObj+` FROM orders o WHERE o.id=$1`+cond, args...)
}
