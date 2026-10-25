package read

import (
	"context"
	"fmt"

	"github.com/mandalika/pos-backend/internal/api"
)

// Inventory controls S3: reads of adjustment requests and the approval queue. Outlet documents
// are outlet-scoped; warehouse documents carry no outlet binding (permission-gated by the route),
// like warehouse stock counts.

// docScopeSQL restricts a document alias to what the scope may see. Args: crossAll, outletId.
func docScopeSQL(alias string, crossAllArg, outletArg int) string {
	return fmt.Sprintf(`($%d::boolean OR %s.warehouse_id IS NOT NULL OR %s.outlet_id = NULLIF($%d,'')::uuid)`,
		crossAllArg, alias, alias, outletArg)
}

const adjustmentRequestObj = `json_build_object('id',r.id,'number',r.number,'status',r.status,
  'locationType',CASE WHEN r.warehouse_id IS NOT NULL THEN 'warehouse' ELSE 'outlet' END,
  'locationId',COALESCE(r.warehouse_id,r.outlet_id),
  'locationName',COALESCE(w.name,o.name),
  'productId',r.product_id,
  'productName',(SELECT p.name FROM products p WHERE p.id=r.product_id),
  'variantSize',r.variant_size,
  'sku',(SELECT v.sku FROM product_variants v WHERE v.product_id=r.product_id AND v.size=r.variant_size LIMIT 1),
  'qtyAtRequest',r.qty_at_request,'requestedNewQty',r.requested_new_qty,
  'liveQty',` + adjustmentLiveQtySQL + `,
  'reasonCode',r.reason_code,'reasonText',r.reason_text,
  'requestedBy',r.requested_by,'requestedByName',ru.display_name,'requestedAt',r.requested_at,
  'approvedBy',r.approved_by,'approvedByName',au.display_name,'approvedAt',r.approved_at,
  'decisionNote',r.decision_note,'appliedAdjustmentId',r.applied_adjustment_id,
  'events',COALESCE((SELECT json_agg(json_build_object('id',e.id,'action',e.action,'actorId',e.actor_id,
       'actorName',eu.display_name,'at',e.at,'note',e.note,'data',e.data) ORDER BY e.id)
     FROM inventory_doc_events e LEFT JOIN users eu ON eu.id=e.actor_id
     WHERE e.doc_type='adjustment_request' AND e.doc_id=r.id),'[]'::json))`

const adjustmentRequestFrom = `FROM stock_adjustment_requests r
  LEFT JOIN outlets o ON o.id=r.outlet_id LEFT JOIN warehouses w ON w.id=r.warehouse_id
  LEFT JOIN users ru ON ru.id=r.requested_by LEFT JOIN users au ON au.id=r.approved_by`

// AdjustmentRequestFilter narrows the list; empty fields match everything.
type AdjustmentRequestFilter struct {
	Status       string
	LocationType string
	LocationID   string
}

func (r *Repo) AdjustmentRequests(ctx context.Context, s Scope, f AdjustmentRequestFilter, page, limit int) ([]api.AdjustmentRequest, int, error) {
	sql := fmt.Sprintf(`SELECT %s, count(*) OVER() %s
	  WHERE %s AND ($3='' OR r.status=$3)
	    AND ($4='' OR (CASE WHEN r.warehouse_id IS NOT NULL THEN 'warehouse' ELSE 'outlet' END)=$4)
	    AND ($5='' OR COALESCE(r.warehouse_id,r.outlet_id)::text=$5)
	  ORDER BY r.requested_at DESC, r.id LIMIT $6 OFFSET $7`,
		adjustmentRequestObj, adjustmentRequestFrom, docScopeSQL("r", 1, 2))
	return listJSON[api.AdjustmentRequest](ctx, r.Pool, sql,
		s.CrossAll, s.OutletID, f.Status, f.LocationType, f.LocationID, limit, off(page, limit))
}

// AdjustmentRequestOn reads one request (with its history) through q: the pool, or a transaction
// that has just written it (a keyed write answers from inside its receipt claim).
func AdjustmentRequestOn(ctx context.Context, q RowQuerier, s Scope, id string) (api.AdjustmentRequest, error) {
	sql := fmt.Sprintf(`SELECT %s %s WHERE r.id::text=$3 AND %s`,
		adjustmentRequestObj, adjustmentRequestFrom, docScopeSQL("r", 1, 2))
	return oneJSON[api.AdjustmentRequest](ctx, q, sql, s.CrossAll, s.OutletID, id)
}

func (r *Repo) AdjustmentRequest(ctx context.Context, s Scope, id string) (api.AdjustmentRequest, error) {
	return AdjustmentRequestOn(ctx, r.Pool, s, id)
}

// approvalQueueSQL unions the pending adjustment requests and the submitted counts. $1/$2 are the
// scope, $3 and $4 say whether the caller may see adjustments and counts.
const approvalQueueSQL = `WITH q AS (
  SELECT 'adjustment'::text AS type, r.id, r.number AS number,
         CASE WHEN r.warehouse_id IS NOT NULL THEN 'warehouse' ELSE 'outlet' END AS loc_type,
         COALESCE(r.warehouse_id,r.outlet_id) AS loc_id, COALESCE(w.name,o.name) AS loc_name,
         r.requested_by AS by_id, u.display_name AS by_name, r.requested_at AS at,
         1 AS lines, (r.requested_new_qty - r.qty_at_request) AS net
    FROM stock_adjustment_requests r
    LEFT JOIN outlets o ON o.id=r.outlet_id LEFT JOIN warehouses w ON w.id=r.warehouse_id
    LEFT JOIN users u ON u.id=r.requested_by
   WHERE r.status='pending_approval' AND $3::boolean
     AND ($1::boolean OR r.warehouse_id IS NOT NULL OR r.outlet_id = NULLIF($2,'')::uuid)
  UNION ALL
  SELECT 'count'::text, sc.id, sc.name,
         CASE WHEN sc.warehouse_id IS NOT NULL THEN 'warehouse' ELSE 'outlet' END,
         COALESCE(sc.warehouse_id,sc.outlet_id), COALESCE(w.name,o.name),
         sc.submitted_by, u.display_name, COALESCE(sc.submitted_at, sc.created_at),
         (SELECT count(*) FROM stock_count_items i WHERE i.stock_count_id=sc.id AND i.actual_qty IS NOT NULL
             AND i.actual_qty <> COALESCE(i.baseline_qty,i.frozen_qty))::int,
         COALESCE((SELECT sum(i.actual_qty - COALESCE(i.baseline_qty,i.frozen_qty)) FROM stock_count_items i
             WHERE i.stock_count_id=sc.id AND i.actual_qty IS NOT NULL),0)::int
    FROM stock_counts sc
    LEFT JOIN outlets o ON o.id=sc.outlet_id LEFT JOIN warehouses w ON w.id=sc.warehouse_id
    LEFT JOIN users u ON u.id=sc.submitted_by
   WHERE sc.status='pending_approval' AND $4::boolean
     AND ($1::boolean OR sc.warehouse_id IS NOT NULL OR sc.outlet_id = NULLIF($2,'')::uuid)
)`

// ApprovalQueue returns one page of the pending approvals (oldest first) and the number of
// pending items the caller may see, for the nav badge. seeAdjustments / seeCounts are the
// caller's permissions (manage_inventory / manage_stock_count): a user holding only one of them
// sees only that kind.
func (r *Repo) ApprovalQueue(ctx context.Context, s Scope, seeAdjustments, seeCounts bool, page, limit int) ([]api.ApprovalQueueItem, int, error) {
	sql := approvalQueueSQL + `
SELECT json_build_object('type',type,'id',id,'number',number,'locationType',loc_type,'locationId',loc_id,
  'locationName',loc_name,'requestedBy',by_id,'requestedByName',by_name,'at',at,'lines',lines,'netDelta',net)
  FROM q ORDER BY at, id LIMIT $5 OFFSET $6`
	items, _, err := listJSON[api.ApprovalQueueItem](ctx, r.Pool, sql,
		s.CrossAll, s.OutletID, seeAdjustments, seeCounts, limit, off(page, limit))
	if err != nil {
		return nil, 0, err
	}
	var total int
	err = r.Pool.QueryRow(ctx, approvalQueueSQL+` SELECT count(*) FROM q`,
		s.CrossAll, s.OutletID, seeAdjustments, seeCounts).Scan(&total)
	if err != nil {
		return nil, 0, fmt.Errorf("query: %w", err)
	}
	return items, total, nil
}
