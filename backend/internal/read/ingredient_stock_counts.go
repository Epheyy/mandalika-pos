package read

import (
	"context"

	"github.com/mandalika/pos-backend/internal/api"
)

// ingStockCountLocationExpr builds the polymorphic location JSON object
// for an ingredient stock count row. Exactly one of outlet_id/warehouse_id is non-null.
const ingStockCountLocationExpr = `jsonb_build_object(
  'kind', CASE WHEN sc.outlet_id IS NOT NULL THEN 'outlet' ELSE 'warehouse' END,
  'id',   COALESCE(sc.outlet_id, sc.warehouse_id),
  'name', COALESCE(o.name, w.name))`

func (r *Repo) IngredientStockCounts(ctx context.Context, page, limit int) ([]api.IngredientStockCount, int, error) {
	sql := `
      SELECT jsonb_build_object(
        'id', sc.id, 'name', sc.name, 'status', sc.status,
        'location', ` + ingStockCountLocationExpr + `,
        'plannedDate', sc.planned_date, 'notes', sc.notes,
        'createdAt',   to_char(sc.created_at   AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'startedAt',   CASE WHEN sc.started_at   IS NULL THEN NULL ELSE to_char(sc.started_at   AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') END,
        'completedAt', CASE WHEN sc.completed_at IS NULL THEN NULL ELSE to_char(sc.completed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') END,
        'items', '[]'::jsonb
      ),
      count(*) OVER ()
      FROM ingredient_stock_counts sc
      LEFT JOIN outlets    o ON o.id = sc.outlet_id
      LEFT JOIN warehouses w ON w.id = sc.warehouse_id
      ORDER BY sc.created_at DESC, sc.id DESC
      OFFSET $1 LIMIT $2`
	return listJSON[api.IngredientStockCount](ctx, r.Pool, sql, off(page, limit), limit)
}

func (r *Repo) IngredientStockCount(ctx context.Context, id string) (api.IngredientStockCount, error) {
	sql := `
      SELECT jsonb_build_object(
        'id', sc.id, 'name', sc.name, 'status', sc.status,
        'location', ` + ingStockCountLocationExpr + `,
        'plannedDate', sc.planned_date, 'notes', sc.notes,
        'createdAt',   to_char(sc.created_at   AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'startedAt',   CASE WHEN sc.started_at   IS NULL THEN NULL ELSE to_char(sc.started_at   AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') END,
        'completedAt', CASE WHEN sc.completed_at IS NULL THEN NULL ELSE to_char(sc.completed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') END,
        'items', (
          SELECT COALESCE(jsonb_agg(jsonb_build_object(
            'id', i.id, 'ingredientId', i.ingredient_id,
            'ingredientName', i.ingredient_name, 'ingredientUnit', i.ingredient_unit,
            'counted', i.counted, 'difference', i.difference
          ) ORDER BY i.ingredient_name), '[]'::jsonb)
            FROM ingredient_stock_count_items i WHERE i.stock_count_id = sc.id
        )
      )
      FROM ingredient_stock_counts sc
      LEFT JOIN outlets    o ON o.id = sc.outlet_id
      LEFT JOIN warehouses w ON w.id = sc.warehouse_id
      WHERE sc.id = $1`
	return oneJSON[api.IngredientStockCount](ctx, r.Pool, sql, id)
}
