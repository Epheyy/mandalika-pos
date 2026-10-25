package read

import (
	"context"
	"fmt"

	"github.com/mandalika/pos-backend/internal/api"
)

// Permintaan Barang (PB) reads. Who sees what:
//   - outlet staff (request_stock only): their own outlet's PBs, every status;
//   - warehouse users (manage_inventory, admin): every submitted-or-later PB, plus the drafts
//     of their own active outlet. Another outlet's draft stays hidden (a 404 on the detail).

// RequisitionAccess is the caller's view of the PB list. Scope comes from the request context
// (token outlet, or the validated X-Outlet-Id of an admin), never from a body or raw header.
type RequisitionAccess struct {
	Warehouse bool
	Scope     Scope
}

const requisitionBase = `json_build_object(
  'id', r.id, 'number', r.number, 'status', r.status,
  'outletId', r.outlet_id, 'outletName', o.name,
  'warehouseId', r.warehouse_id, 'warehouseName', w.name,
  'neededBy', r.needed_by, 'note', r.note,
  'requestedBy', r.requested_by, 'requestedByName', ru.display_name,
  'submittedAt', r.submitted_at,
  'decidedBy', r.decided_by, 'decidedByName', du.display_name,
  'decidedAt', r.decided_at, 'decisionNote', r.decision_note,
  'fulfilledBy', r.fulfilled_by, 'fulfilledAt', r.fulfilled_at,
  'cancelledAt', r.cancelled_at,
  'transfer', CASE WHEN t.id IS NULL THEN NULL ELSE
     json_build_object('id', t.id, 'transferNo', t.transfer_no, 'status', t.status) END,
  'createdAt', r.created_at, 'updatedAt', r.updated_at`

const requisitionDetailExtra = `,
  'items', COALESCE((SELECT json_agg(json_build_object(
     'id', i.id, 'productId', i.product_id, 'productName', p.name,
     'variantSize', i.variant_size, 'sku', v.sku,
     'requestedQty', i.requested_qty, 'approvedQty', i.approved_qty, 'note', i.note)
     ORDER BY p.name, i.variant_size)
     FROM stock_requisition_items i
     JOIN products p ON p.id = i.product_id
     LEFT JOIN product_variants v ON v.product_id = i.product_id AND v.size = i.variant_size
     WHERE i.requisition_id = r.id), '[]'::json),
  'events', COALESCE((SELECT json_agg(json_build_object(
     'id', e.id, 'action', e.action, 'actorId', e.actor_id, 'actorName', eu.display_name,
     'note', e.note, 'data', e.data, 'at', e.at) ORDER BY e.id)
     FROM inventory_doc_events e
     LEFT JOIN users eu ON eu.id = e.actor_id
     WHERE e.doc_type = 'requisition' AND e.doc_id = r.id), '[]'::json)`

const requisitionFrom = `FROM stock_requisitions r
  JOIN outlets o ON o.id = r.outlet_id
  LEFT JOIN warehouses w ON w.id = r.warehouse_id
  LEFT JOIN users ru ON ru.id = r.requested_by
  LEFT JOIN users du ON du.id = r.decided_by
  LEFT JOIN transfers t ON t.id = r.transfer_id`

// visibleWhere is the row filter for the access mode; own is the $n of the active outlet id.
func (a RequisitionAccess) visibleWhere(args []any) (string, []any) {
	args = append(args, a.Scope.OutletID)
	own := fmt.Sprintf("r.outlet_id = NULLIF($%d,'')::uuid", len(args))
	if a.Warehouse {
		return "(r.submitted_at IS NOT NULL OR " + own + ")", args
	}
	return own, args
}

// Requisitions lists the PBs the caller may see, newest first. outletID (optional) narrows a
// warehouse view to one outlet; an outlet user is already pinned to their own.
func (r *Repo) Requisitions(ctx context.Context, a RequisitionAccess, status, outletID string, page, limit int) ([]api.StockRequisition, int, error) {
	vis, args := a.visibleWhere(nil)
	where := "WHERE " + vis
	if status != "" {
		args = append(args, status)
		where += fmt.Sprintf(" AND r.status=$%d", len(args))
	}
	if outletID != "" {
		args = append(args, outletID)
		where += fmt.Sprintf(" AND r.outlet_id=$%d", len(args))
	}
	args = append(args, limit, off(page, limit))
	sql := fmt.Sprintf(`SELECT %s), count(*) OVER() AS total %s %s
	  ORDER BY r.created_at DESC, r.id LIMIT $%d OFFSET $%d`,
		requisitionBase, requisitionFrom, where, len(args)-1, len(args))
	return listJSON[api.StockRequisition](ctx, r.Pool, sql, args...)
}

// Requisition returns one visible PB with its lines and events (ErrNotFound otherwise).
func (r *Repo) Requisition(ctx context.Context, a RequisitionAccess, id string) (api.StockRequisition, error) {
	return RequisitionOn(ctx, r.Pool, a, id)
}

// RequisitionOn is Requisition on any querier, so a keyed write can build its stored
// response inside its own transaction.
func RequisitionOn(ctx context.Context, q RowQuerier, a RequisitionAccess, id string) (api.StockRequisition, error) {
	vis, args := a.visibleWhere([]any{id})
	return oneJSON[api.StockRequisition](ctx, q,
		`SELECT `+requisitionBase+requisitionDetailExtra+`) `+requisitionFrom+` WHERE r.id=$1 AND `+vis, args...)
}
