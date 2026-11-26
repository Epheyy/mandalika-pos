package read

import (
	"context"
	"strings"

	"github.com/mandalika/pos-backend/internal/api"
)

// crossOutletMaxRows caps a lookup (exact number or phone, newest first). No date window: the
// owner set no return deadline.
const crossOutletMaxRows = 20

// crossOutletObj is one lookup row: the order as every order read returns it, minus the fields a
// stranger at another outlet must not read (A30): the customer id and name, the device id, the free-text
// notes, the salesman id and name and the refunder's user id. cashierName stays (the
// refund dialog shows it). The phone is never part of orderObj.
const crossOutletObj = `jsonb_build_object('outletName',ou.name,
  'order',(` + orderObj + `)::jsonb - 'customerId' - 'customerName' - 'deviceId'
    - 'notes' - 'salesmanId' - 'salesmanName' - 'refundedBy')`

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
