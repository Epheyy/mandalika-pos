package read

import (
	"context"
	"strings"

	"github.com/mandalika/pos-backend/internal/api"
)

// crossOutletMaxRows caps a lookup (exact number or phone, newest first). No date window: the
// owner set no return deadline.
const crossOutletMaxRows = 20

// xoPick builds jsonb_build_object over the named keys of the jsonb value src (a column or alias).
func xoPick(src string, keys ...string) string {
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		parts = append(parts, "'"+k+"',"+src+"->'"+k+"'")
	}
	return "jsonb_build_object(" + strings.Join(parts, ",") + ")"
}

// xoArray rebuilds the array at key of x (the full order object) element by element from an
// allowlist; extra is merged into each element (neutral values for required-but-sensitive keys).
func xoArray(key, extra string, keys ...string) string {
	elem := xoPick("e.v", keys...)
	if extra != "" {
		elem = "(" + elem + " || " + extra + ")"
	}
	return `COALESCE((SELECT jsonb_agg(` + elem + ` ORDER BY e.n)
	    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(x->'` + key + `')='array' THEN x->'` + key + `' ELSE '[]'::jsonb END) WITH ORDINALITY e(v,n)),'[]'::jsonb)`
}

// crossOutletObj is one lookup row. A30: a cashier at another outlet may see only the outlet name, the
// date, the items, the amounts, the payment methods and what was already refunded. So the order is an
// ALLOWLIST projection of orderObj (a denylist leaks every field added later): only the keys the POS
// refund flow reads are copied. The api.Order fields that are required but sensitive come back as ""
// (cashierId, cashierName, refunds[].reason); everything else (customer, salesman, device, notes,
// cashier, refund reasons and refunders, payment references, shift ids) is simply absent.
var crossOutletObj = `jsonb_build_object('outletName',ou.name,
  'order',(SELECT ` + xoPick("x", "id", "orderNumber", "outletId", "businessDate", "createdAt", "clientCreatedAt",
	"subtotal", "discountAmount", "taxAmount", "total", "paymentMethod", "amountPaid", "change", "status",
	"refundedAmount", "refundedAt", "refundBusinessDate") + `
    || jsonb_build_object('cashierId','','cashierName','',
      'items',` + xoArray("items", "", "id", "productId", "productName", "variantSize", "price", "quantity",
	"subtotal", "isBundle", "lineNo", "netAmount", "refundGroup", "refundedQty") + `,
      'tenders',` + xoArray("tenders", "", "seq", "method", "amount", "tendered", "change", "synthetic") + `,
      'refunds',` + xoArray("refunds", "jsonb_build_object('reason','')", "id", "seq", "scope", "amount",
	"computedAmount", "paymentMethod", "outletId", "refundedAt", "refundBusinessDate", "items") + `)
    FROM (SELECT (` + orderObj + `)::jsonb AS x) s))`

const crossOutletFrom = ` FROM orders o JOIN outlets ou ON ou.id = o.outlet_id
 WHERE o.outlet_id <> $1::uuid AND o.status IN ('completed','partially_refunded','refunded')`

// CrossOutletByNumber returns the sale with this exact order number when it was made at an outlet
// other than activeOutletID. The stored number is matched as typed or upper-cased (the index on the
// unique order_number serves both arms).
func (r *Repo) CrossOutletByNumber(ctx context.Context, activeOutletID, orderNumber string) ([]api.CrossOutletOrder, error) {
	orderNumber = strings.TrimSpace(orderNumber)
	if orderNumber == "" {
		return []api.CrossOutletOrder{}, nil
	}
	rows, _, err := listJSON[api.CrossOutletOrder](ctx, r.Pool,
		`SELECT `+crossOutletObj+crossOutletFrom+`
		   AND (o.order_number = $2 OR o.order_number = upper($2))
		 ORDER BY o.created_at DESC, o.id DESC LIMIT $3`,
		activeOutletID, orderNumber, crossOutletMaxRows)
	return rows, err
}

// CrossOutletByPhone returns the sales of the live customers whose normalized phone equals phoneNorm
// exactly (never a partial match, A30), made at an outlet other than activeOutletID.
func (r *Repo) CrossOutletByPhone(ctx context.Context, activeOutletID, phoneNorm string) ([]api.CrossOutletOrder, error) {
	if phoneNorm == "" {
		return []api.CrossOutletOrder{}, nil
	}
	rows, _, err := listJSON[api.CrossOutletOrder](ctx, r.Pool,
		`SELECT `+crossOutletObj+crossOutletFrom+`
		   AND o.customer_id IN (SELECT c.id FROM customers c WHERE c.phone_norm = $2 AND c.merged_into IS NULL)
		 ORDER BY o.created_at DESC, o.id DESC LIMIT $3`,
		activeOutletID, phoneNorm, crossOutletMaxRows)
	return rows, err
}

// CrossOutletOrderByID reads one order at ANY outlet through the same stripped projection as the
// lookup (the read-back after a cross-outlet refund: the order lives at the sale outlet).
func (r *Repo) CrossOutletOrderByID(ctx context.Context, orderID string) (api.CrossOutletOrder, error) {
	return oneJSON[api.CrossOutletOrder](ctx, r.Pool,
		`SELECT `+crossOutletObj+` FROM orders o JOIN outlets ou ON ou.id = o.outlet_id WHERE o.id = $1::uuid`, orderID)
}
