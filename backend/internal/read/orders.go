package read

import (
	"context"
	"fmt"

	"github.com/mandalika/pos-backend/internal/api"
)

const orderObjBase = `json_build_object('id',o.id,'orderNumber',o.order_number,
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
  'refundedAt',o.refunded_at,'refundBusinessDate',o.refund_business_date,'shiftId',o.shift_id,'createdAt',o.created_at,'clientCreatedAt',o.client_created_at,'businessDate',o.business_date,
  'refundShiftId',o.refund_shift_id,'refundedBy',o.refunded_by,'refundedByName',o.refunded_by_name,
  'pointsRedeemed',o.points_redeemed,'pointsRedemptionAmount',o.points_redemption_amount,
  -- C4a: sum of every refund row (SQL emits null when never refunded; Go omitempty then drops
  -- the key). Readers that
  -- used total for a refunded order read this instead, so a partial refund is not a full one.
  -- C6a: the payment lines (a tenderless order gets one synthetic line), so every order has >= 1.
  'tenders',(SELECT json_agg(json_build_object('seq',tl.seq,'method',tl.method,'amount',tl.amount,
     'tendered',tl.tendered,'change',tl.change,'reference',tl.reference,'synthetic',tl.synthetic)
     ORDER BY tl.seq) FROM (SELECT 1) one ` + tenderLinesLateral + `),
  'refundedAmount',(SELECT sum(r.amount) FROM order_refunds r WHERE r.order_id=o.id),
  'refunds',(SELECT json_agg(json_build_object(
     'id',r.id,'seq',r.seq,'scope',r.scope,'amount',r.amount,'computedAmount',r.computed_amount,'claimedAmount',r.claimed_amount,
     'amountWarning',r.amount_warning,'paymentMethod',r.payment_method,'payoutSource',r.payout_source,
     'reason',r.reason,'reasonCode',r.reason_code,'shiftId',r.shift_id,
     'refundedByName',r.refunded_by_name,'refundedAt',r.refunded_at,
     'refundBusinessDate',r.refund_business_date,
     'items',COALESCE((SELECT json_agg(json_build_object(
        'orderItemId',ri.order_item_id,'lineNo',oi.line_no,'quantity',ri.quantity,'amount',ri.amount)
        ORDER BY oi.line_no NULLS LAST, ri.order_item_id)
        FROM order_refund_items ri JOIN order_items oi ON oi.id=ri.order_item_id
        WHERE ri.refund_id=r.id),'[]'::json)) ORDER BY r.seq)
     FROM order_refunds r WHERE r.order_id=o.id),
  'items',COALESCE((SELECT json_agg((json_build_object(
     'id',it.id,'productId',it.product_id,'productName',it.product_name,
     'variantSize',it.variant_size,'price',it.price,'quantity',it.quantity,
     'subtotal',it.subtotal,'isBundle',it.is_bundle,
     'lineNo',it.line_no,'netAmount',it.net_amount,'refundGroup',it.refund_group,
     'refundedQty',COALESCE((SELECT sum(ri.quantity) FROM order_refund_items ri WHERE ri.order_item_id=it.id),0))::jsonb
     || CASE WHEN it.bundle_group IS NULL THEN '{}'::jsonb ELSE jsonb_strip_nulls(jsonb_build_object(
          'bundleGroup',it.bundle_group,'bundleRole',it.bundle_role,'bundleLine',it.bundle_line,
          'bundleSize',it.bundle_size,'bundleDiscount',it.bundle_discount,
          'bundlePromotionId',it.bundle_promotion_id)) END))
     FROM order_items it WHERE it.order_id=o.id),'[]'::json))`

// orderObj is the order JSON every order read returns. json_build_object takes at most 100 arguments
// (50 pairs) and orderObjBase is at the cap, so the void fields (migration 0092) are a second object
// merged in with jsonb ||. Absent (null, dropped by omitempty) when the order was never voided.
const orderObj = `((` + orderObjBase + `)::jsonb || jsonb_build_object(
  'void',(SELECT jsonb_build_object('id',v.id,'reasonCode',v.reason_code,'note',v.note,'voidedAt',v.voided_at,
     'voidedByName',v.voided_by_name,'source',v.source,'afterClose',v.after_close,'mode',v.mode,
     'replacementOrderId',COALESCE(v.replacement_order_id,f.replacement_order_id),
     'replacementOrderNumber',(SELECT ro.order_number FROM orders ro WHERE ro.id = COALESCE(v.replacement_order_id,f.replacement_order_id)),
     'followup',f.kind)
     FROM order_voids v LEFT JOIN order_void_followups f ON f.void_id = v.id WHERE v.order_id = o.id),
  'replacesOrderId',o.replaces_order_id,
  'replacesOrderNumber',(SELECT ro.order_number FROM orders ro WHERE ro.id = o.replaces_order_id),
  'deviceId',o.device_id))::json`

// refundOrderKey is the refund-basis sort key: the latest refund row (C4a), because a part
// refund leaves orders.refunded_at NULL. Computed once per candidate row in the id-first CTE.
const refundOrderKey = `(SELECT max(r.refunded_at) FROM order_refunds r WHERE r.order_id=o.id)`

// orderPageSQL builds the id-first list statement: one statement, so the total and the page
// share a snapshot (A26), and the heavy orderObj sub-selects only run for the page's rows.
// t LEFT JOIN pg keeps the total on an empty page (one row with a NULL object). extraCols is
// appended to the select list (keyset columns).
//
// countWhere filters the count. cursorPred ("" for none) is the keyset position predicate over
// the unqualified (created_at, id) columns; it narrows only the page, never the count, in both
// forms. materialize evaluates a filter that cannot use an index once, in a CTE that feeds both
// the count and the page.
func orderPageSQL(f OrderFilter, countWhere, cursorPred, limitOffset, extraCols string, materialize bool) string {
	if materialize {
		return orderPageSQLFromSet(f, "SELECT "+orderSetCols(f)+" FROM orders o "+countWhere, cursorPred, limitOffset, extraCols)
	}
	pageWhere := countWhere
	if cursorPred != "" {
		pageWhere += " AND " + cursorPred
	}
	cols, orderBy, outerOrder := "o.id, o.created_at", "o.created_at DESC, o.id DESC", "pg.created_at DESC, pg.id DESC"
	if f.refundBasis() {
		cols += ", " + refundOrderKey + " AS k"
		orderBy = "k DESC NULLS LAST, o.id DESC"
		outerOrder = "pg.k DESC NULLS LAST, pg.id DESC"
	}
	ctes := fmt.Sprintf(`t AS (SELECT count(*) AS n FROM orders o %s),
	     pg AS (SELECT %s FROM orders o %s ORDER BY %s LIMIT %s)`,
		countWhere, cols, pageWhere, orderBy, limitOffset)
	return orderPageOuter(ctes, extraCols, outerOrder)
}

// orderPageSQLFromSet is the MATERIALIZED form over an arbitrary filtered set (setBody selects
// orderSetCols): the set is evaluated once and feeds both the count and the page.
func orderPageSQLFromSet(f OrderFilter, setBody, cursorPred, limitOffset, extraCols string) string {
	matWhere := ""
	if cursorPred != "" {
		matWhere = "WHERE " + cursorPred
	}
	matCols, matOrder, outerOrder := "id, created_at", "created_at DESC, id DESC", "pg.created_at DESC, pg.id DESC"
	if f.refundBasis() {
		matCols += ", k"
		matOrder = "k DESC NULLS LAST, id DESC"
		outerOrder = "pg.k DESC NULLS LAST, pg.id DESC"
	}
	ctes := fmt.Sprintf(`f AS MATERIALIZED (%s),
	     t AS (SELECT count(*) AS n FROM f),
	     pg AS (SELECT %s FROM f %s ORDER BY %s LIMIT %s)`,
		setBody, matCols, matWhere, matOrder, limitOffset)
	return orderPageOuter(ctes, extraCols, outerOrder)
}

func orderPageOuter(ctes, extraCols, outerOrder string) string {
	return fmt.Sprintf(`WITH %s
	SELECT CASE WHEN pg.id IS NULL THEN NULL ELSE %s END, t.n%s
	  FROM t LEFT JOIN pg ON true LEFT JOIN orders o ON o.id = pg.id
	 ORDER BY %s`, ctes, orderObj, extraCols, outerOrder)
}

func (r *Repo) Orders(ctx context.Context, f OrderFilter, page, limit int) ([]api.Order, int, error) {
	if useSearchIndex(f) {
		body, args := orderSearchSet(f, orderSetCols(f), "", nil)
		args = append(args, limit, off(page, limit))
		sql := orderPageSQLFromSet(f, body, "", fmt.Sprintf("$%d OFFSET $%d", len(args)-1, len(args)), "")
		return pagedSearchJSON[api.Order](ctx, r.Pool, sql, args...)
	}
	where, args := buildOrderWhere(f)
	args = append(args, limit, off(page, limit))
	// A q or payment-method filter has no index to walk: evaluate it once, not twice.
	materialize := f.Q != "" || f.PaymentMethod != ""
	sql := orderPageSQL(f, where, "", fmt.Sprintf("$%d OFFSET $%d", len(args)-1, len(args)), "", materialize)
	return pagedCountJSON[api.Order](ctx, r.Pool, sql, args...)
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
