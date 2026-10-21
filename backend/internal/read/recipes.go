package read

import (
	"context"
	"fmt"

	"github.com/mandalika/pos-backend/internal/api"
)

// recipeLinesSQL is the shared jsonb_agg subquery for a version's ingredient
// lines, hydrated with current name/cost/unit + total on-hand across warehouses.
const recipeLinesSQL = `
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'ingredientId', ri.ingredient_id,
    'nameAtSave',   ri.name_at_save,
    'name',         COALESCE(ing.name, ri.name_at_save),
    'qty',          ri.qty,
    'unitAtSave',   ri.unit_at_save,
    'costAtSave',   ri.cost_at_save,
    'defaultUnitCost', ing.default_unit_cost,
    'isActive',     COALESCE(ing.is_active, false),
    'onHandTotal',  COALESCE((SELECT SUM(qty) FROM ingredient_warehouse_stock WHERE ingredient_id = ri.ingredient_id), 0)
  ) ORDER BY ri.sort_order, ri.name_at_save), '[]'::jsonb)
    FROM recipe_ingredients ri
    LEFT JOIN ingredients ing ON ing.id = ri.ingredient_id
   WHERE ri.version_id = %s`

// VariantRecipe returns the current version of a variant's recipe. Returns
// read.ErrNotFound when the variant has no recipe yet.
func (r *Repo) VariantRecipe(ctx context.Context, variantID string) (api.Recipe, error) {
	sql := `
      WITH rec AS (
        SELECT id, current_version_id FROM recipes WHERE variant_id = $1
      ),
      cv AS (
        SELECT v.* FROM recipe_versions v JOIN rec ON rec.current_version_id = v.id
      )
      SELECT jsonb_build_object(
        'variantId', $1::uuid,
        'recipeId', (SELECT id FROM rec),
        'currentVersionId', (SELECT current_version_id FROM rec),
        'versionId', (SELECT id FROM cv),
        'versionNo', COALESCE((SELECT version_no FROM cv), 0),
        'notes', (SELECT notes FROM cv),
        'totalCostCached', (SELECT total_cost_cached FROM cv),
        'versionCount', (SELECT COUNT(*) FROM recipe_versions WHERE recipe_id = (SELECT id FROM rec)),
        'items', (` + fmt.Sprintf(recipeLinesSQL, "(SELECT id FROM cv)") + `)
      )
      FROM rec`
	return oneJSON[api.Recipe](ctx, r.Pool, sql, variantID)
}

// RecipeVariantIDs returns the ids of variants under a product that have a recipe.
// A variant is included only if its current version has at least one ingredient;
// an empty current version (e.g. freshly reset) does NOT light up the gold flask.
func (r *Repo) RecipeVariantIDs(ctx context.Context, productID string) ([]string, error) {
	rows, err := r.Pool.Query(ctx,
		`SELECT r.variant_id::text
		   FROM recipes r
		   JOIN product_variants v ON v.id = r.variant_id
		  WHERE v.product_id = $1
		    AND r.current_version_id IS NOT NULL
		    AND EXISTS (SELECT 1 FROM recipe_ingredients ri
		                 WHERE ri.version_id = r.current_version_id)`, productID)
	if err != nil {
		return nil, fmt.Errorf("recipe variant ids: %w", err)
	}
	defer rows.Close()
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("scan recipe variant id: %w", err)
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// RecipeVersions lists version summaries (newest first) for a variant's recipe.
// Returns an empty slice when there is no recipe.
func (r *Repo) RecipeVersions(ctx context.Context, variantID string) ([]api.RecipeVersionSummary, error) {
	const sql = `
      SELECT jsonb_build_object(
        'id', v.id, 'versionNo', v.version_no, 'notes', v.notes,
        'totalCostCached', v.total_cost_cached,
        'createdAt', to_char(v.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'createdByName', u.display_name
      )
      FROM recipe_versions v
      JOIN recipes rc ON rc.id = v.recipe_id AND rc.variant_id = $1
      LEFT JOIN users u ON u.id = v.created_by
      ORDER BY v.version_no DESC`
	rows, _, err := listJSON[api.RecipeVersionSummary](ctx, r.Pool, sql, variantID)
	return rows, err
}

// RecipeVersion returns one historical version (read-only) of a variant's recipe.
func (r *Repo) RecipeVersion(ctx context.Context, variantID, versionID string) (api.Recipe, error) {
	sql := `
      WITH cv AS (
        SELECT v.* FROM recipe_versions v
        JOIN recipes rc ON rc.id = v.recipe_id AND rc.variant_id = $1
       WHERE v.id = $2
      )
      SELECT jsonb_build_object(
        'variantId', $1::uuid,
        'recipeId', (SELECT recipe_id FROM cv),
        'currentVersionId', (SELECT current_version_id FROM recipes WHERE variant_id = $1),
        'versionId', (SELECT id FROM cv),
        'versionNo', (SELECT version_no FROM cv),
        'notes', (SELECT notes FROM cv),
        'totalCostCached', (SELECT total_cost_cached FROM cv),
        'versionCount', (SELECT COUNT(*) FROM recipe_versions WHERE recipe_id = (SELECT recipe_id FROM cv)),
        'items', (` + fmt.Sprintf(recipeLinesSQL, "(SELECT id FROM cv)") + `)
      )
      FROM cv`
	return oneJSON[api.Recipe](ctx, r.Pool, sql, variantID, versionID)
}
