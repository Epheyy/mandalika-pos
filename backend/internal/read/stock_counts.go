package read

import (
	"context"
	"fmt"

	"github.com/mandalika/pos-backend/internal/api"
)

const stockCountObj = `json_build_object('id',sc.id,'name',sc.name,
  'status',sc.status,'outletId',sc.outlet_id,'warehouseId',sc.warehouse_id,'plannedDate',sc.planned_date,
  'startedAt',sc.started_at,'completedAt',sc.completed_at,'notes',sc.notes,
  'createdBy',sc.created_by,'createdAt',sc.created_at,
  'items',COALESCE((SELECT json_agg(json_build_object(
     'productId',i.product_id,'productName',i.product_name,
     'variantSize',i.variant_size,'sku',i.sku,'frozenQty',i.frozen_qty,
     'actualQty',i.actual_qty,'difference',i.difference,
     'baselineQty',i.baseline_qty,'countedAt',i.counted_at,
     'stockBefore',i.stock_before,'stockAfter',i.stock_after))
     FROM stock_count_items i WHERE i.stock_count_id=sc.id),'[]'::json))`

func (r *Repo) StockCounts(ctx context.Context, s Scope, page, limit int) ([]api.StockCount, int, error) {
	where := ""
	args := []any{}
	if !s.CrossAll {
		args = append(args, s.OutletID)
		where = "WHERE sc.outlet_id=$1"
	}
	args = append(args, limit, off(page, limit))
	sql := fmt.Sprintf(`SELECT %s, count(*) OVER() AS total FROM stock_counts sc %s
	  ORDER BY sc.created_at DESC LIMIT $%d OFFSET $%d`,
		stockCountObj, where, len(args)-1, len(args))
	return listJSON[api.StockCount](ctx, r.Pool, sql, args...)
}

func (r *Repo) StockCount(ctx context.Context, s Scope, id string) (api.StockCount, error) {
	return StockCountOn(ctx, r.Pool, s, id)
}

// StockCountOn reads one stock count through q: the pool, or a transaction that has
// just written it (a keyed completion answers from inside its receipt claim).
func StockCountOn(ctx context.Context, q RowQuerier, s Scope, id string) (api.StockCount, error) {
	args := []any{id}
	cond := ""
	if !s.CrossAll {
		args = append(args, s.OutletID)
		// Outlet-scoped readers see their outlet's counts plus any warehouse count
		// (warehouse counts have no outlet binding; they're permission-gated).
		cond = " AND (sc.outlet_id=$2 OR sc.warehouse_id IS NOT NULL)"
	}
	return oneJSON[api.StockCount](ctx, q,
		`SELECT `+stockCountObj+` FROM stock_counts sc WHERE sc.id=$1`+cond, args...)
}
