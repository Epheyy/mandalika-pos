package read

import (
	"context"

	"github.com/mandalika/pos-backend/internal/api"
)

// Ingredients lists ingredients with name/sku filter + pagination. categoryID ("" = every category) narrows the
// list to one category before paging, so a category filter covers every matching row, not just one page.
func (r *Repo) Ingredients(ctx context.Context, page, limit int, q, categoryID string) ([]api.Ingredient, int, error) {
	const sql = `
      SELECT jsonb_build_object(
        'id', i.id, 'name', i.name, 'unit', i.unit, 'sku', i.sku,
        'categoryId', i.category_id, 'categoryName', c.name,
        'defaultUnitCost', i.default_unit_cost,
        'notes', i.notes, 'isActive', i.is_active,
        'createdAt', to_char(i.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')
      ),
      count(*) OVER ()
      FROM ingredients i
      LEFT JOIN ingredient_categories c ON c.id = i.category_id
      WHERE ($3 = '' OR i.name ILIKE '%' || $3 || '%' OR i.sku ILIKE '%' || $3 || '%')
        AND ($4 = '' OR i.category_id = NULLIF($4, '')::uuid)
      ORDER BY i.is_active DESC, c.sort_order NULLS LAST, i.name ASC
      OFFSET $1 LIMIT $2`
	return listJSON[api.Ingredient](ctx, r.Pool, sql, off(page, limit), limit, q, categoryID)
}

// IngredientCategories lists all ingredient categories ordered by sort_order then name.
func (r *Repo) IngredientCategories(ctx context.Context) ([]api.IngredientCategory, error) {
	const sql = `
      SELECT jsonb_build_object(
        'id', id, 'name', name, 'sortOrder', sort_order,
        'createdAt', to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')
      )
      FROM ingredient_categories
      ORDER BY sort_order NULLS LAST, name ASC`
	rows, _, err := listJSON[api.IngredientCategory](ctx, r.Pool, sql)
	return rows, err
}

// IngredientUsage returns the distinct product variants whose CURRENT recipe version
// references this ingredient. Used to warn before an ingredient delete; historical
// versions are excluded because the FK is now SET NULL (history survives via snapshots).
func (r *Repo) IngredientUsage(ctx context.Context, ingredientID string) (api.IngredientUsageResponse, error) {
	// Non-nil so an unused ingredient serializes as [] (not null) — the client
	// reads `variants.length` directly.
	resp := api.IngredientUsageResponse{Variants: []api.IngredientUsageVariant{}}
	rows, err := r.Pool.Query(ctx, `
		SELECT DISTINCT p.name, v.size
		FROM recipe_ingredients ri
		JOIN recipes rec        ON rec.current_version_id = ri.version_id
		JOIN product_variants v ON v.id  = rec.variant_id
		JOIN products p         ON p.id  = v.product_id
		WHERE ri.ingredient_id = $1
		ORDER BY p.name, v.size`, ingredientID)
	if err != nil {
		return resp, err
	}
	defer rows.Close()
	for rows.Next() {
		var u api.IngredientUsageVariant
		if err := rows.Scan(&u.ProductName, &u.VariantSize); err != nil {
			return resp, err
		}
		resp.Variants = append(resp.Variants, u)
	}
	if err := rows.Err(); err != nil {
		return resp, err
	}
	return resp, nil
}

// IngredientLocationStock returns per-ingredient on-hand qty for a polymorphic location
// (outlet or warehouse). Returns active ingredients only; qty defaults to 0 when not stocked.
func (r *Repo) IngredientLocationStock(ctx context.Context, kind, id string) ([]api.IngredientStockRow, error) {
	var sql string
	if kind == "warehouse" {
		sql = `
      SELECT jsonb_build_object(
        'ingredientId', i.id, 'name', i.name, 'unit', i.unit,
        'defaultUnitCost', i.default_unit_cost,
        'qty', COALESCE(s.qty, 0)
      )
      FROM ingredients i
      LEFT JOIN ingredient_warehouse_stock s
             ON s.ingredient_id = i.id AND s.warehouse_id = $1
     WHERE i.is_active
     ORDER BY i.name ASC`
	} else {
		sql = `
      SELECT jsonb_build_object(
        'ingredientId', i.id, 'name', i.name, 'unit', i.unit,
        'defaultUnitCost', i.default_unit_cost,
        'qty', COALESCE(s.qty, 0)
      )
      FROM ingredients i
      LEFT JOIN ingredient_outlet_stock s
             ON s.ingredient_id = i.id AND s.outlet_id = $1
     WHERE i.is_active
     ORDER BY i.name ASC`
	}
	rows, _, err := listJSON[api.IngredientStockRow](ctx, r.Pool, sql, id)
	return rows, err
}
