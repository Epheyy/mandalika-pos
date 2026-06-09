package read

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/oapi-codegen/nullable"

	"github.com/mandalika/pos-backend/internal/api"
)

var ErrNotFound = errors.New("not found")

type Repo struct{ Pool *pgxpool.Pool }

func New(p *pgxpool.Pool) *Repo { return &Repo{Pool: p} }

// Scope is the resolved outlet boundary for outlet-scoped tables.
// CrossAll = admin requested every outlet; OutletID = the single active outlet.
type Scope struct {
	CrossAll bool
	OutletID string
	// SellableOnly excludes products flagged not-for-customers (POS pull only).
	SellableOnly bool
}

// listJSON runs a query whose first column is a per-row JSON object and whose
// optional second column is a window total; unmarshals each row into T.
func listJSON[T any](ctx context.Context, p *pgxpool.Pool, sql string, args ...any) ([]T, int, error) {
	rows, err := p.Query(ctx, sql, args...)
	if err != nil {
		return nil, 0, fmt.Errorf("query: %w", err)
	}
	defer rows.Close()
	out := []T{}
	total := 0
	for rows.Next() {
		var raw []byte
		if len(rows.FieldDescriptions()) > 1 {
			if err := rows.Scan(&raw, &total); err != nil {
				return nil, 0, fmt.Errorf("scan: %w", err)
			}
		} else if err := rows.Scan(&raw); err != nil {
			return nil, 0, fmt.Errorf("scan: %w", err)
		}
		var v T
		if err := json.Unmarshal(raw, &v); err != nil {
			return nil, 0, fmt.Errorf("unmarshal: %w", err)
		}
		out = append(out, v)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}
	if len(rows.FieldDescriptions()) <= 1 {
		total = len(out)
	}
	return out, total, nil
}

func oneJSON[T any](ctx context.Context, p *pgxpool.Pool, sql string, args ...any) (T, error) {
	var v T
	var raw []byte
	err := p.QueryRow(ctx, sql, args...).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return v, ErrNotFound
	}
	if err != nil {
		return v, fmt.Errorf("query: %w", err)
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		return v, fmt.Errorf("unmarshal: %w", err)
	}
	return v, nil
}

func off(page, limit int) int {
	if page < 1 {
		page = 1
	}
	return (page - 1) * limit
}

// ── Catalog ───────────────────────────────────────────────

// productObjScoped builds the product JSON with per-outlet stock/price resolved.
// When sc.OutletID != "" the variant stock/price resolve to that outlet (0 / base
// when no row) and unavailable products are excluded by the caller's WHERE; the
// outlet id is passed as $1. Otherwise (CrossAll/admin "all") stock is summed
// across outlets and the base variant price is used.
func productObjScoped(sc Scope) string {
	if sc.CrossAll || sc.OutletID == "" {
		return `json_build_object(
		  'id',p.id,'name',p.name,'brand',p.brand,'categoryId',p.category_id,
		  'description',p.description,'imageUrl',p.image_url,
	  'images',p.images,'sellable',p.sellable,
		  'isFeatured',p.is_featured,'isFavourite',p.is_favourite,'isActive',p.is_active,
		  'createdAt',p.created_at,
		  'variants',COALESCE((SELECT json_agg(json_build_object(
		     'id',v.id,'size',v.size,'price',v.price,
		     'stock',COALESCE((SELECT SUM(s.stock)::int FROM outlet_variant_stock s
		        WHERE s.product_id=v.product_id AND s.variant_size=v.size),0),
		     'sku',v.sku,'barcode',v.barcode) ORDER BY v.size)
		     FROM product_variants v WHERE v.product_id=p.id),'[]'::json))`
	}
	return `json_build_object(
	  'id',p.id,'name',p.name,'brand',p.brand,'categoryId',p.category_id,
	  'description',p.description,'imageUrl',p.image_url,
	  'images',p.images,'sellable',p.sellable,
	  'isFeatured',p.is_featured,'isFavourite',p.is_favourite,'isActive',p.is_active,
	  'createdAt',p.created_at,
	  'variants',COALESCE((SELECT json_agg(json_build_object(
	     'size',v.size,
	     'price',COALESCE((SELECT op.price FROM outlet_variant_price op
	        WHERE op.outlet_id=$1 AND op.product_id=v.product_id AND op.variant_size=v.size), v.price),
	     'stock',COALESCE((SELECT os.stock FROM outlet_variant_stock os
	        WHERE os.outlet_id=$1 AND os.product_id=v.product_id AND os.variant_size=v.size),0),
	     'parLevel',(SELECT op.par_level FROM outlet_variant_stock op
	        WHERE op.outlet_id=$1 AND op.product_id=v.product_id AND op.variant_size=v.size),
	     'sku',v.sku,'barcode',v.barcode) ORDER BY v.size)
	     FROM product_variants v WHERE v.product_id=p.id
	     AND COALESCE((SELECT oa.available FROM outlet_variant_stock oa
	        WHERE oa.outlet_id=$1 AND oa.product_id=v.product_id AND oa.variant_size=v.size), true)),'[]'::json))`
}

// availabilityWhere keeps a product only if it has at least one variant available
// at the scoped outlet ($argPos) — i.e. drops products whose every variant is
// turned off there.
func availabilityWhere(sc Scope, argPos int) string {
	if sc.CrossAll || sc.OutletID == "" {
		return ""
	}
	return fmt.Sprintf(` AND EXISTS (SELECT 1 FROM product_variants v2
	   WHERE v2.product_id=p.id
	     AND COALESCE((SELECT oa.available FROM outlet_variant_stock oa
	        WHERE oa.outlet_id=$%d AND oa.product_id=v2.product_id AND oa.variant_size=v2.size), true))`, argPos)
}

// sellableWhere hides not-for-customer products (POS pull only).
func sellableWhere(sc Scope) string {
	if sc.SellableOnly {
		return ` AND p.sellable`
	}
	return ""
}

func (r *Repo) Products(ctx context.Context, sc Scope, page, limit int) ([]api.Product, int, error) {
	obj := productObjScoped(sc)
	if sc.CrossAll || sc.OutletID == "" {
		return listJSON[api.Product](ctx, r.Pool,
			`SELECT `+obj+`, count(*) OVER() AS total
			   FROM products p WHERE true`+sellableWhere(sc)+`
			   ORDER BY p.created_at DESC LIMIT $1 OFFSET $2`,
			limit, off(page, limit))
	}
	return listJSON[api.Product](ctx, r.Pool,
		`SELECT `+obj+`, count(*) OVER() AS total
		   FROM products p WHERE true`+availabilityWhere(sc, 1)+sellableWhere(sc)+`
		   ORDER BY p.created_at DESC LIMIT $2 OFFSET $3`,
		sc.OutletID, limit, off(page, limit))
}

func (r *Repo) Product(ctx context.Context, sc Scope, id string) (api.Product, error) {
	obj := productObjScoped(sc)
	if sc.CrossAll || sc.OutletID == "" {
		return oneJSON[api.Product](ctx, r.Pool, `SELECT `+obj+` FROM products p WHERE p.id=$1`, id)
	}
	return oneJSON[api.Product](ctx, r.Pool,
		`SELECT `+obj+` FROM products p WHERE p.id=$2`, sc.OutletID, id)
}

// ProductOutletConfig returns the per-outlet stock/price/availability matrix for
// one product: a row per active outlet × variant. stock defaults 0, price is
// null when there's no override, available defaults true.
func (r *Repo) ProductOutletConfig(ctx context.Context, productID string) ([]api.OutletVariantConfig, error) {
	rows, _, err := listJSON[api.OutletVariantConfig](ctx, r.Pool, `
		SELECT json_build_object(
		  'outletId', o.id, 'outletName', o.name, 'variantSize', v.size,
		  'stock', COALESCE(s.stock, 0),
		  'price', op.price,
		  'parLevel', s.par_level,
		  'available', COALESCE(s.available, true))
		FROM outlets o
		CROSS JOIN product_variants v
		LEFT JOIN outlet_variant_stock s
		  ON s.outlet_id=o.id AND s.product_id=v.product_id AND s.variant_size=v.size
		LEFT JOIN outlet_variant_price op
		  ON op.outlet_id=o.id AND op.product_id=v.product_id AND op.variant_size=v.size
		WHERE v.product_id=$1 AND o.is_active
		ORDER BY o.name, v.size`, productID)
	return rows, err
}

func (r *Repo) Categories(ctx context.Context) ([]api.Category, int, error) {
	return listJSON[api.Category](ctx, r.Pool,
		`SELECT json_build_object('id',id,'name',name,'description',description,
		   'sortOrder',sort_order) FROM categories ORDER BY sort_order NULLS LAST, name`)
}

func (r *Repo) Bundles(ctx context.Context) ([]api.Bundle, int, error) {
	return listJSON[api.Bundle](ctx, r.Pool,
		`SELECT json_build_object('id',b.id,'name',b.name,'description',b.description,
		   'price',b.price,'imageUrl',b.image_url,'isActive',b.is_active,
		   'createdAt',b.created_at,
		   'items',COALESCE((SELECT json_agg(json_build_object(
		     'productId',i.product_id,'productName',i.product_name,
		     'variantSize',i.variant_size,'quantity',i.quantity,'price',i.price))
		     FROM bundle_items i WHERE i.bundle_id=b.id),'[]'::json))
		   FROM bundles b ORDER BY b.created_at DESC`)
}

func (r *Repo) Outlets(ctx context.Context) ([]api.Outlet, int, error) {
	return listJSON[api.Outlet](ctx, r.Pool,
		`SELECT json_build_object('id',id,'name',name,'code',code,'address',address,
		   'phone',phone,'logoUrl',logo_url,'isActive',is_active,'createdAt',created_at)
		   FROM outlets ORDER BY name`)
}

// ── Warehouses (not POS-synced) ───────────────────────────

func (r *Repo) Warehouses(ctx context.Context) ([]api.Warehouse, error) {
	rows, _, err := listJSON[api.Warehouse](ctx, r.Pool, `
		SELECT json_build_object(
		  'id', w.id, 'name', w.name, 'code', w.code, 'address', w.address,
		  'phone', w.phone, 'logoUrl', w.logo_url, 'isActive', w.is_active, 'createdAt', w.created_at)
		FROM warehouses w ORDER BY w.name`)
	return rows, err
}

// WarehouseStock lists every product variant with the warehouse's on-hand qty
// (0 when no row), so the UI can show/seed all variants.
func (r *Repo) WarehouseStock(ctx context.Context, warehouseID string) ([]api.WarehouseStockRow, error) {
	rows, _, err := listJSON[api.WarehouseStockRow](ctx, r.Pool, `
		SELECT json_build_object(
		  'productId', v.product_id, 'productName', p.name, 'variantSize', v.size,
		  'sku', v.sku,
		  'stock', COALESCE((SELECT s.stock FROM warehouse_variant_stock s
		     WHERE s.warehouse_id=$1 AND s.product_id=v.product_id AND s.variant_size=v.size),0))
		FROM product_variants v JOIN products p ON p.id=v.product_id
		ORDER BY p.name, v.size`, warehouseID)
	return rows, err
}

// Ingredients lists ingredients with name/sku filter + pagination.
func (r *Repo) Ingredients(ctx context.Context, page, limit int, q string) ([]api.Ingredient, int, error) {
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
      ORDER BY i.is_active DESC, c.sort_order NULLS LAST, i.name ASC
      OFFSET $1 LIMIT $2`
	return listJSON[api.Ingredient](ctx, r.Pool, sql, off(page, limit), limit, q)
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

// ingTransferItemsSubq is the shared ingredient transfer items subquery.
const ingTransferItemsSubq = `(
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', i.id, 'ingredientId', i.ingredient_id,
    'ingredientName', ing.name, 'ingredientUnit', ing.unit,
    'sentQty', i.sent_qty, 'receivedQty', i.received_qty, 'difference', i.difference
  ) ORDER BY ing.name), '[]'::jsonb)
    FROM ingredient_transfer_items i JOIN ingredients ing ON ing.id = i.ingredient_id
   WHERE i.transfer_id = t.id
)`

// ingTransferObj builds the polymorphic JSON shape for an ingredient transfer.
// Joins both outlets and warehouses for each leg so names are resolved regardless
// of location kind (mirrors transferObj / transferFrom in the product transfer reads).
const ingTransferObj = `jsonb_build_object(
  'id', t.id, 'transferNo', t.transfer_no, 'status', t.status,
  'source', jsonb_build_object(
    'kind', CASE WHEN t.source_outlet_id IS NOT NULL THEN 'outlet' ELSE 'warehouse' END,
    'id',   COALESCE(t.source_outlet_id, t.source_warehouse_id),
    'name', COALESCE(so.name, sw.name)),
  'dest', jsonb_build_object(
    'kind', CASE WHEN t.dest_outlet_id IS NOT NULL THEN 'outlet' ELSE 'warehouse' END,
    'id',   COALESCE(t.dest_outlet_id, t.dest_warehouse_id),
    'name', COALESCE(do2.name, dw.name)),
  'suratJalanNo', t.surat_jalan_no, 'tandaTerimaNo', t.tanda_terima_no,
  'note', t.note, 'discrepancyReason', t.discrepancy_reason,
  'createdAt',   to_char(t.created_at   AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  'sentAt',      CASE WHEN t.sent_at      IS NULL THEN NULL ELSE to_char(t.sent_at      AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') END,
  'receivedAt',  CASE WHEN t.received_at  IS NULL THEN NULL ELSE to_char(t.received_at  AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') END,
  'cancelledAt', CASE WHEN t.cancelled_at IS NULL THEN NULL ELSE to_char(t.cancelled_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') END,
  'cancelReason', t.cancel_reason,
  'items', ` + ingTransferItemsSubq + `)`

// ingTransferFrom resolves all four nullable location legs.
// do2/dw alias avoids the reserved word "do".
const ingTransferFrom = `FROM ingredient_transfers t
  LEFT JOIN outlets    so  ON so.id  = t.source_outlet_id
  LEFT JOIN warehouses sw  ON sw.id  = t.source_warehouse_id
  LEFT JOIN outlets    do2 ON do2.id = t.dest_outlet_id
  LEFT JOIN warehouses dw  ON dw.id  = t.dest_warehouse_id`

// IngredientTransfers lists ingredient transfers newest-first with optional filters:
// status, date range, and location (any side — source OR dest).
func (r *Repo) IngredientTransfers(ctx context.Context, page, limit int, status, from, to, locKind, locID string) ([]api.IngredientTransfer, int, error) {
	where := "WHERE 1=1"
	args := []any{}
	if status != "" {
		args = append(args, status)
		where += fmt.Sprintf(" AND t.status=$%d", len(args))
	}
	if from != "" {
		args = append(args, from)
		where += fmt.Sprintf(" AND t.created_at >= $%d", len(args))
	}
	if to != "" {
		args = append(args, to)
		where += fmt.Sprintf(" AND t.created_at < $%d", len(args))
	}
	if locKind != "" && locID != "" {
		args = append(args, locID)
		if locKind == "warehouse" {
			where += fmt.Sprintf(" AND (t.source_warehouse_id=$%d OR t.dest_warehouse_id=$%d)", len(args), len(args))
		} else {
			where += fmt.Sprintf(" AND (t.source_outlet_id=$%d OR t.dest_outlet_id=$%d)", len(args), len(args))
		}
	}
	args = append(args, limit, off(page, limit))
	sql := fmt.Sprintf(`SELECT %s, count(*) OVER() AS total %s %s
	  ORDER BY t.created_at DESC LIMIT $%d OFFSET $%d`,
		ingTransferObj, ingTransferFrom, where, len(args)-1, len(args))
	return listJSON[api.IngredientTransfer](ctx, r.Pool, sql, args...)
}

// IngredientTransfer returns a single ingredient transfer with sender/receiver
// letterheads resolved from location address/phone/logo_url with
// app_settings.documents_* fallback. Supports any location kind (outlet or warehouse).
func (r *Repo) IngredientTransfer(ctx context.Context, id string) (api.IngredientTransfer, error) {
	const sql = `
      WITH s AS (SELECT * FROM app_settings LIMIT 1),
           t AS (SELECT it.* FROM ingredient_transfers it WHERE it.id = $1)
      SELECT jsonb_build_object(
        'id', t.id, 'transferNo', t.transfer_no, 'status', t.status,
        'source', jsonb_build_object(
          'kind', CASE WHEN t.source_outlet_id IS NOT NULL THEN 'outlet' ELSE 'warehouse' END,
          'id',   COALESCE(t.source_outlet_id, t.source_warehouse_id),
          'name', COALESCE(so.name, sw.name)),
        'dest', jsonb_build_object(
          'kind', CASE WHEN t.dest_outlet_id IS NOT NULL THEN 'outlet' ELSE 'warehouse' END,
          'id',   COALESCE(t.dest_outlet_id, t.dest_warehouse_id),
          'name', COALESCE(do2.name, dw.name)),
        'suratJalanNo', t.surat_jalan_no, 'tandaTerimaNo', t.tanda_terima_no,
        'note', t.note, 'discrepancyReason', t.discrepancy_reason,
        'createdAt',   to_char(t.created_at   AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'sentAt',      CASE WHEN t.sent_at      IS NULL THEN NULL ELSE to_char(t.sent_at      AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') END,
        'receivedAt',  CASE WHEN t.received_at  IS NULL THEN NULL ELSE to_char(t.received_at  AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') END,
        'cancelledAt', CASE WHEN t.cancelled_at IS NULL THEN NULL ELSE to_char(t.cancelled_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') END,
        'cancelReason', t.cancel_reason,
        'senderLetterhead', jsonb_build_object(
          'locationName', COALESCE(so.name, sw.name),
          'brandName',    s.documents_brand_name,
          'logoUrl',      COALESCE(so.logo_url, sw.logo_url, s.documents_logo_url),
          'addressLines', string_to_array(
                            COALESCE(NULLIF(COALESCE(so.address, sw.address), ''),
                                     s.documents_address_lines, ''), E'\n'),
          'phone',        COALESCE(so.phone, sw.phone, s.documents_phone),
          'npwp',         s.documents_npwp),
        'receiverLetterhead', jsonb_build_object(
          'locationName', COALESCE(do2.name, dw.name),
          'brandName',    s.documents_brand_name,
          'logoUrl',      COALESCE(do2.logo_url, dw.logo_url, s.documents_logo_url),
          'addressLines', string_to_array(
                            COALESCE(NULLIF(COALESCE(do2.address, dw.address), ''),
                                     s.documents_address_lines, ''), E'\n'),
          'phone',        COALESCE(do2.phone, dw.phone, s.documents_phone),
          'npwp',         s.documents_npwp),
        'items', ` + ingTransferItemsSubq + `
      )
      FROM t
      LEFT JOIN outlets    so  ON so.id  = t.source_outlet_id
      LEFT JOIN warehouses sw  ON sw.id  = t.source_warehouse_id
      LEFT JOIN outlets    do2 ON do2.id = t.dest_outlet_id
      LEFT JOIN warehouses dw  ON dw.id  = t.dest_warehouse_id
      LEFT JOIN s ON true`
	return oneJSON[api.IngredientTransfer](ctx, r.Pool, sql, id)
}

// ── Ingredient stock-counts ────────────────────────────────

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
      ORDER BY sc.created_at DESC
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

// ── Customers ─────────────────────────────────────────────

// segmentMatch: the RFM rule predicate. Correlates via BARE columns (last_visit,
// visit_count, total_spent) NOT customers.<col> — because customerObj is also used
// by RecentCustomersForOutlet which aliases `customers c`. Bare cols resolve to the
// outer customers row whatever its alias.
const segmentMatch = `s.is_active
  AND (s.r_min IS NULL OR (last_visit IS NOT NULL AND (now()::date - last_visit::date) >= s.r_min))
  AND (s.r_max IS NULL OR (last_visit IS NOT NULL AND (now()::date - last_visit::date) <= s.r_max))
  AND (s.f_min IS NULL OR visit_count >= s.f_min)
  AND (s.f_max IS NULL OR visit_count <= s.f_max)
  AND (s.m_min IS NULL OR total_spent >= s.m_min)
  AND (s.m_max IS NULL OR total_spent <= s.m_max)`

// segmentSel: the computed segment object (or NULL when no rule matches).
const segmentSel = `(SELECT json_build_object('id',s.id,'name',s.name,'color',s.color)
  FROM customer_segments s WHERE ` + segmentMatch + ` ORDER BY s.sort_order, s.created_at LIMIT 1)`

// segmentIdSel: just the matched segment id (for the list filter).
const segmentIdSel = `(SELECT s.id FROM customer_segments s WHERE ` + segmentMatch + ` ORDER BY s.sort_order, s.created_at LIMIT 1)`

const customerObj = `json_build_object('id',id,'name',name,'phone',phone,
  'email',email,'points',points,'totalSpent',total_spent,'visitCount',visit_count,
  'lastVisit',last_visit,'birthday',birthday,'anniversary',anniversary,
  'notes',notes,'createdAt',created_at,
  'segment', ` + segmentSel + `)`

// customerObjWithTags = customerObj + the customer's tags. Used ONLY by the
// backoffice list + detail reads; the shared customerObj stays tag-free so the
// POS sync / lookup / by-phone payloads don't carry tags.
//
// customerObjWithTags must be used ONLY in queries whose outer FROM is
// "FROM customers" (unaliased): the tags sub-select correlates via the bare
// `customers.id`. Aliasing the outer table (e.g. `FROM customers c`) would
// silently return empty tags.
const customerObjWithTags = `json_build_object('id',id,'name',name,'phone',phone,
  'email',email,'points',points,'totalSpent',total_spent,'visitCount',visit_count,
  'lastVisit',last_visit,'birthday',birthday,'anniversary',anniversary,
  'notes',notes,'createdAt',created_at,
  'segment', ` + segmentSel + `,
  'tags', COALESCE((SELECT json_agg(json_build_object('id',t.id,'name',t.name,'color',t.color) ORDER BY t.name)
                    FROM customer_tags ct JOIN tags t ON t.id = ct.tag_id
                    WHERE ct.customer_id = customers.id), '[]'::json))`

func (r *Repo) Customers(ctx context.Context, page, limit int, q, sort, tagId, segmentId string) ([]api.Customer, int, error) {
	// `order` is a fixed internal string (never user input) — safe to concatenate.
	order := `ORDER BY total_spent DESC, created_at DESC`
	if sort == "terbaru" {
		order = `ORDER BY created_at DESC`
	}
	args := []any{off(page, limit), limit, q} // $1 offset, $2 limit, $3 q
	tagFilter := ""
	if tagId != "" {
		args = append(args, tagId)
		tagFilter = fmt.Sprintf(` AND EXISTS (SELECT 1 FROM customer_tags ct
			WHERE ct.customer_id = customers.id AND ct.tag_id = $%d::uuid)`, len(args))
	}
	segFilter := ""
	if segmentId != "" {
		args = append(args, segmentId)
		segFilter = fmt.Sprintf(` AND `+segmentIdSel+` = $%d::uuid`, len(args))
	}
	sql := `SELECT ` + customerObjWithTags + `, count(*) OVER() AS total
		   FROM customers
		  WHERE ($3 = '' OR name ILIKE '%' || $3 || '%' OR phone ILIKE '%' || $3 || '%' OR email ILIKE '%' || $3 || '%')` +
		tagFilter + segFilter + `
		  ` + order + `
		  OFFSET $1 LIMIT $2`
	return listJSON[api.Customer](ctx, r.Pool, sql, args...)
}

// CustomerByPhone returns 0+ customers with this exact (trimmed) phone — backs
// the backoffice soft dup-check via idx_customers_phone.
func (r *Repo) CustomerByPhone(ctx context.Context, phone string) ([]api.Customer, error) {
	rows, _, err := listJSON[api.Customer](ctx, r.Pool,
		`SELECT `+customerObj+`, count(*) OVER() AS total FROM customers WHERE phone = $1`, phone)
	return rows, err
}

// CustomerLookup is the on-demand cashier search (SP-CRM-3 seam): capped,
// exact-phone matches ranked first.
func (r *Repo) CustomerLookup(ctx context.Context, q string, limit int) ([]api.Customer, error) {
	if limit < 1 || limit > 20 {
		limit = 20
	}
	rows, _, err := listJSON[api.Customer](ctx, r.Pool,
		`SELECT `+customerObj+`, count(*) OVER() AS total FROM customers
		  WHERE name ILIKE '%' || $1 || '%' OR phone ILIKE '%' || $1 || '%'
		  ORDER BY (phone = $1) DESC, name
		  LIMIT $2`, q, limit)
	return rows, err
}

// RecentCustomersForOutlet returns the bounded set of customers who transacted
// at outletID within the last `days`, most-recent-first, capped at `limit`. This
// replaces the global bulk customer sync (SP-CRM-3 Phase 2). Reuses customerObj.
// (`limit`, not `cap`, to avoid shadowing the Go builtin.)
func (r *Repo) RecentCustomersForOutlet(ctx context.Context, outletID string, days, limit int) ([]api.Customer, error) {
	if days < 1 {
		days = 90
	}
	if limit < 1 || limit > 5000 {
		limit = 1000
	}
	rows, _, err := listJSON[api.Customer](ctx, r.Pool,
		`SELECT `+customerObj+`, count(*) OVER() AS total
		   FROM customers c
		   JOIN (
		     SELECT customer_id, max(created_at) AS last_seen
		       FROM orders
		      WHERE outlet_id = $1 AND customer_id IS NOT NULL
		        AND created_at >= now() - make_interval(days => $2)
		   GROUP BY customer_id
		   ORDER BY last_seen DESC
		      LIMIT $3
		   ) recent ON recent.customer_id = c.id
		  ORDER BY recent.last_seen DESC`,
		outletID, days, limit)
	return rows, err
}

func (r *Repo) Customer(ctx context.Context, id string) (api.Customer, error) {
	return oneJSON[api.Customer](ctx, r.Pool,
		`SELECT `+customerObjWithTags+` FROM customers WHERE id=$1`, id)
}

// Interactions returns a customer's interaction log, newest-first, paginated.
func (r *Repo) Interactions(ctx context.Context, customerID string, page, limit int) ([]api.Interaction, int, error) {
	const sql = `SELECT json_build_object(
		  'id', id, 'type', type, 'interactionDate', interaction_date,
		  'note', note, 'createdBy', created_by, 'createdByName', created_by_name,
		  'createdAt', created_at), count(*) OVER() AS total
		FROM customer_interactions
		WHERE customer_id = $1
		ORDER BY interaction_date DESC, created_at DESC
		OFFSET $2 LIMIT $3`
	return listJSON[api.Interaction](ctx, r.Pool, sql, customerID, off(page, limit), limit)
}

// Tags lists all customer tags ordered by sort_order then name.
func (r *Repo) Tags(ctx context.Context) ([]api.Tag, error) {
	const sql = `SELECT json_build_object('id',id,'name',name,'color',color,
		'sortOrder',sort_order,'createdAt',created_at)
		FROM tags ORDER BY sort_order NULLS LAST, name ASC`
	rows, _, err := listJSON[api.Tag](ctx, r.Pool, sql)
	return rows, err
}

// Segments lists all segment rules ordered by priority.
func (r *Repo) Segments(ctx context.Context) ([]api.Segment, error) {
	const sql = `SELECT json_build_object('id',id,'name',name,'color',color,
		'sortOrder',sort_order,'rMin',r_min,'rMax',r_max,'fMin',f_min,'fMax',f_max,
		'mMin',m_min,'mMax',m_max,'isActive',is_active,'createdAt',created_at)
		FROM customer_segments ORDER BY sort_order`
	rows, _, err := listJSON[api.Segment](ctx, r.Pool, sql)
	return rows, err
}

// ── Promotions / loyalty ──────────────────────────────────

func (r *Repo) Promotions(ctx context.Context) ([]api.Promotion, int, error) {
	return listJSON[api.Promotion](ctx, r.Pool,
		`SELECT json_build_object('id',id,'name',name,'description',description,
		   'type',type,'value',value,'minPurchase',min_purchase,
		   'applicableProductIds',applicable_product_ids,
		   'applicableVariantKeys',applicable_variant_keys,
		   'applicableVariantSizes',applicable_variant_sizes,
		   'outletIds',outlet_ids,'combinable',combinable,
		   'combinableWith',combinable_with,'activeFromHour',active_from_hour,
		   'activeToHour',active_to_hour,'activeDays',active_days,
		   'isActive',is_active,'startDate',start_date,'endDate',end_date,
		   'createdAt',created_at) FROM promotions ORDER BY created_at DESC`)
}

func (r *Repo) DiscountCodes(ctx context.Context) ([]api.DiscountCode, int, error) {
	return listJSON[api.DiscountCode](ctx, r.Pool,
		`SELECT json_build_object('id',id,'code',code,'promotionId',promotion_id,
		   'type',type,'value',value,'minPurchase',min_purchase,
		   'usageLimit',usage_limit,'usageCount',usage_count,'isActive',is_active,
		   'startDate',start_date,'endDate',end_date,'createdAt',created_at)
		   FROM discount_codes ORDER BY created_at DESC`)
}

func (r *Repo) LoyaltyConditions(ctx context.Context) ([]api.LoyaltyCondition, int, error) {
	return listJSON[api.LoyaltyCondition](ctx, r.Pool,
		`SELECT json_build_object('id',id,'name',name,'type',type,'trigger',trigger,
		   'rewardType',reward_type,'rewardValue',reward_value,
		   'rewardProductIds',reward_product_ids,
		   'campaignStartDate',campaign_start_date,'campaignEndDate',campaign_end_date,
		   'activeDays',active_days,'applicableProductIds',applicable_product_ids,
		   'minimumSpend',minimum_spend,'isActive',is_active,'createdAt',created_at)
		   FROM loyalty_conditions ORDER BY created_at DESC`)
}

func (r *Repo) LoyaltySettings(ctx context.Context) (api.LoyaltySettings, error) {
	return oneJSON[api.LoyaltySettings](ctx, r.Pool,
		`SELECT json_build_object('enabled',enabled,'tierEnabled',tier_enabled,
		   'pointsPerThousand',points_per_thousand,'redemptionRate',redemption_rate)
		   FROM loyalty_settings WHERE id=1`)
}

func (r *Repo) AppSettings(ctx context.Context) (api.AppSettings, error) {
	return oneJSON[api.AppSettings](ctx, r.Pool,
		`SELECT json_build_object('taxEnabled',tax_enabled,'taxRate',tax_rate,
		   'roundingEnabled',rounding_enabled,'roundingType',rounding_type,
		   'roundingAmount',rounding_amount,'roundingDirection',rounding_direction,
		   'roundingApplyToTax',rounding_apply_to_tax,'autoOpenShift',auto_open_shift,
		   'paymentMethods',payment_methods,'receipt',receipt,
		   'receiveApproverRoles',receive_approver_roles,
		   'recipesEnabled',recipes_enabled,
		   'documents',json_build_object(
		     'logoUrl',documents_logo_url,
		     'brandName',documents_brand_name,
		     'addressLines',documents_address_lines,
		     'phone',documents_phone,
		     'npwp',documents_npwp))
		   FROM app_settings WHERE id=1`)
}

// ReceiveApprovingUsers returns the users who may approve a transfer receive at
// a given outlet: role ∈ receive_approver_roles OR role = 'admin', scoped to
// the outlet (or global for admins), and must have a PIN hash set.
func (r *Repo) ReceiveApprovingUsers(ctx context.Context, outletID string) ([]api.ReceiveApprover, error) {
	sql := `SELECT json_build_object(
	    'userId', u.id, 'displayName', u.display_name, 'receivePinHash', u.receive_pin_hash),
	    count(*) OVER() AS total
	  FROM users u, app_settings s
	  WHERE s.id = 1 AND u.receive_pin_hash IS NOT NULL
	    AND (u.role = ANY (s.receive_approver_roles) OR u.role = 'admin')
	    AND (u.outlet_id = $1 OR u.role = 'admin')
	  ORDER BY u.display_name`
	rows, _, err := listJSON[api.ReceiveApprover](ctx, r.Pool, sql, outletID)
	return rows, err
}

func (r *Repo) CustomRoles(ctx context.Context) ([]api.CustomRole, int, error) {
	return listJSON[api.CustomRole](ctx, r.Pool,
		`SELECT json_build_object('id',cr.id,'name',cr.name,'createdAt',cr.created_at,
		   'permissions',COALESCE((SELECT json_agg(permission)
		     FROM custom_role_permissions WHERE role_id=cr.id),'[]'::json))
		   FROM custom_roles cr ORDER BY cr.name`)
}

// ── Users ─────────────────────────────────────────────────

const userObj = `json_build_object('id',u.id,'email',u.email,
  'displayName',u.display_name,'role',u.role,'outletId',u.outlet_id,
  'photoURL',u.photo_url,'createdAt',u.created_at,
  'permissions',COALESCE((SELECT json_agg(permission)
    FROM user_permissions WHERE user_id=u.id),'[]'::json))`

func (r *Repo) Users(ctx context.Context, page, limit int) ([]api.User, int, error) {
	return listJSON[api.User](ctx, r.Pool,
		`SELECT `+userObj+`, count(*) OVER() AS total
		   FROM users u ORDER BY u.created_at DESC LIMIT $1 OFFSET $2`,
		limit, off(page, limit))
}

func (r *Repo) User(ctx context.Context, id string) (api.User, error) {
	return oneJSON[api.User](ctx, r.Pool,
		`SELECT `+userObj+` FROM users u WHERE u.id=$1`, id)
}

// ── Sales (outlet-scoped) ─────────────────────────────────

const orderObj = `json_build_object('id',o.id,'orderNumber',o.order_number,
  'outletId',o.outlet_id,'cashierId',o.cashier_id,'cashierName',o.cashier_name,
  'salesmanId',o.salesman_id,'salesmanName',o.salesman_name,
  'customerId',o.customer_id,'customerName',o.customer_name,
  'subtotal',o.subtotal,'discountAmount',o.discount_amount,
  'discountType',o.discount_type,'discountValue',o.discount_value,
  'discountCode',o.discount_code,'discountLabel',o.discount_label,
  'discountBreakdown',o.discount_breakdown,
  'surchargeType',o.surcharge_type,'surchargeValue',o.surcharge_value,
  'surchargeAmount',o.surcharge_amount,
  'taxAmount',o.tax_amount,'total',o.total,
  'paymentMethod',o.payment_method,'amountPaid',o.amount_paid,'change',o.change,
  'status',o.status,'notes',o.notes,'refundReason',o.refund_reason,
  'refundedAt',o.refunded_at,'shiftId',o.shift_id,'createdAt',o.created_at,
  'pointsRedeemed',o.points_redeemed,
  'items',COALESCE((SELECT json_agg(json_build_object(
     'productId',it.product_id,'productName',it.product_name,
     'variantSize',it.variant_size,'price',it.price,'quantity',it.quantity,
     'subtotal',it.subtotal,'isBundle',it.is_bundle))
     FROM order_items it WHERE it.order_id=o.id),'[]'::json))`

func (r *Repo) Orders(ctx context.Context, sc Scope, shiftID, customerID, from, to, q string, page, limit int) ([]api.Order, int, error) {
	where := "WHERE 1=1"
	args := []any{}
	if !sc.CrossAll {
		args = append(args, sc.OutletID)
		where += fmt.Sprintf(" AND o.outlet_id=$%d", len(args))
	}
	if shiftID != "" {
		args = append(args, shiftID)
		where += fmt.Sprintf(" AND o.shift_id=$%d", len(args))
	}
	if customerID != "" {
		args = append(args, customerID)
		where += fmt.Sprintf(" AND o.customer_id=$%d", len(args))
	}
	if from != "" {
		args = append(args, from)
		where += fmt.Sprintf(" AND o.created_at >= $%d", len(args))
	}
	if to != "" {
		args = append(args, to)
		where += fmt.Sprintf(" AND o.created_at < ($%d::date + interval '1 day')", len(args))
	}
	if q != "" {
		args = append(args, "%"+q+"%")
		// Match order number, the order's stored customer name, or the
		// linked customer's phone/name.
		where += fmt.Sprintf(` AND (o.order_number ILIKE $%d OR o.customer_name ILIKE $%d
		  OR EXISTS (SELECT 1 FROM customers c WHERE c.id = o.customer_id
		    AND (c.phone ILIKE $%d OR c.name ILIKE $%d)))`,
			len(args), len(args), len(args), len(args))
	}
	args = append(args, limit, off(page, limit))
	sql := fmt.Sprintf(`SELECT %s, count(*) OVER() AS total FROM orders o %s
	  ORDER BY o.created_at DESC LIMIT $%d OFFSET $%d`,
		orderObj, where, len(args)-1, len(args))
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

const shiftObj = `json_build_object('id',s.id,'outletId',s.outlet_id,
  'outletName',s.outlet_name,'cashierId',s.cashier_id,'cashierName',s.cashier_name,
  'status',s.status,'openedAt',s.opened_at,'closedAt',s.closed_at,
  'startingCash',s.starting_cash,'closingCash',s.closing_cash,
  'totalSales',s.total_sales,'totalOrders',s.total_orders,
  'totalRefunds',s.total_refunds,'cashSales',s.cash_sales,'cardSales',s.card_sales,
  'transferSales',s.transfer_sales,'qrisSales',s.qris_sales,
  'countedByMethod',s.counted_by_method)`

func (r *Repo) Shifts(ctx context.Context, sc Scope, page, limit int) ([]api.Shift, int, error) {
	where := ""
	args := []any{}
	if !sc.CrossAll {
		args = append(args, sc.OutletID)
		where = "WHERE s.outlet_id=$1"
	}
	args = append(args, limit, off(page, limit))
	sql := fmt.Sprintf(`SELECT %s, count(*) OVER() AS total FROM shifts s %s
	  ORDER BY s.opened_at DESC LIMIT $%d OFFSET $%d`,
		shiftObj, where, len(args)-1, len(args))
	return listJSON[api.Shift](ctx, r.Pool, sql, args...)
}

func (r *Repo) Shift(ctx context.Context, sc Scope, id string) (api.Shift, error) {
	args := []any{id}
	cond := ""
	if !sc.CrossAll {
		args = append(args, sc.OutletID)
		cond = " AND s.outlet_id=$2"
	}
	return oneJSON[api.Shift](ctx, r.Pool,
		`SELECT `+shiftObj+` FROM shifts s WHERE s.id=$1`+cond, args...)
}

// CurrentShift returns the open shift for the active outlet, or ErrNotFound.
func (r *Repo) CurrentShift(ctx context.Context, sc Scope) (api.Shift, error) {
	args := []any{}
	cond := ""
	if !sc.CrossAll {
		args = append(args, sc.OutletID)
		cond = " AND s.outlet_id=$1"
	}
	return oneJSON[api.Shift](ctx, r.Pool,
		`SELECT `+shiftObj+` FROM shifts s WHERE s.status='open'`+cond+
			` ORDER BY s.opened_at DESC LIMIT 1`, args...)
}

const errorLogObj = `json_build_object('id',e.id,'outletId',e.outlet_id,
  'outletName',e.outlet_name,'deviceId',e.device_id,'userId',e.user_id,
  'userName',e.user_name,'source',e.source,'kind',e.kind,'action',e.action,
  'message',e.message,'payload',e.payload,'breadcrumbs',e.breadcrumbs,
  'appVersion',e.app_version,'clientCreatedAt',e.client_created_at,
  'createdAt',e.created_at)`

// ErrorLogs lists captured errors (admin; cross-outlet), newest first.
func (r *Repo) ErrorLogs(ctx context.Context, outletID, source, from, to string, page, limit int) ([]api.ErrorLog, int, error) {
	args := []any{}
	cond := ""
	add := func(clause string, val any) {
		args = append(args, val)
		if cond == "" {
			cond = " WHERE "
		} else {
			cond += " AND "
		}
		cond += fmt.Sprintf(clause, len(args))
	}
	if outletID != "" {
		add("e.outlet_id=$%d", outletID)
	}
	if source != "" {
		add("e.source=$%d", source)
	}
	if from != "" {
		add("e.created_at >= $%d", from)
	}
	if to != "" {
		add("e.created_at <= $%d", to)
	}
	args = append(args, limit, off(page, limit))
	sql := fmt.Sprintf(`SELECT %s, count(*) OVER() AS total FROM error_logs e%s
	  ORDER BY e.created_at DESC LIMIT $%d OFFSET $%d`,
		errorLogObj, cond, len(args)-1, len(args))
	return listJSON[api.ErrorLog](ctx, r.Pool, sql, args...)
}

const stockCountObj = `json_build_object('id',sc.id,'name',sc.name,
  'status',sc.status,'outletId',sc.outlet_id,'warehouseId',sc.warehouse_id,'plannedDate',sc.planned_date,
  'startedAt',sc.started_at,'completedAt',sc.completed_at,'notes',sc.notes,
  'createdBy',sc.created_by,'createdAt',sc.created_at,
  'items',COALESCE((SELECT json_agg(json_build_object(
     'productId',i.product_id,'productName',i.product_name,
     'variantSize',i.variant_size,'sku',i.sku,'frozenQty',i.frozen_qty,
     'actualQty',i.actual_qty,'difference',i.difference))
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
	args := []any{id}
	cond := ""
	if !s.CrossAll {
		args = append(args, s.OutletID)
		// Outlet-scoped readers see their outlet's counts plus any warehouse count
		// (warehouse counts have no outlet binding; they're permission-gated).
		cond = " AND (sc.outlet_id=$2 OR sc.warehouse_id IS NOT NULL)"
	}
	return oneJSON[api.StockCount](ctx, r.Pool,
		`SELECT `+stockCountObj+` FROM stock_counts sc WHERE sc.id=$1`+cond, args...)
}

const transferObj = `json_build_object(
  'id', t.id, 'transferNo', t.transfer_no, 'status', t.status,
  'suratJalanNo', t.surat_jalan_no, 'tandaTerimaNo', t.tanda_terima_no,
  'source', json_build_object(
    'kind', CASE WHEN t.source_outlet_id IS NOT NULL THEN 'outlet' ELSE 'warehouse' END,
    'id',   COALESCE(t.source_outlet_id, t.source_warehouse_id),
    'name', COALESCE(so.name, sw.name)),
  'dest', json_build_object(
    'kind', CASE WHEN t.dest_outlet_id IS NOT NULL THEN 'outlet' ELSE 'warehouse' END,
    'id',   COALESCE(t.dest_outlet_id, t.dest_warehouse_id),
    'name', COALESCE(do2.name, dw.name)),
  'senderLetterhead', json_build_object(
    'locationName', COALESCE(so.name, sw.name),
    'brandName',    s.documents_brand_name,
    'logoUrl',      COALESCE(so.logo_url, sw.logo_url, s.documents_logo_url),
    'addressLines', string_to_array(
                      COALESCE(NULLIF(COALESCE(so.address, sw.address), ''),
                               s.documents_address_lines, ''), E'\n'),
    'phone',        COALESCE(so.phone, sw.phone, s.documents_phone),
    'npwp',         s.documents_npwp),
  'receiverLetterhead', json_build_object(
    'locationName', COALESCE(do2.name, dw.name),
    'brandName',    s.documents_brand_name,
    'logoUrl',      COALESCE(do2.logo_url, dw.logo_url, s.documents_logo_url),
    'addressLines', string_to_array(
                      COALESCE(NULLIF(COALESCE(do2.address, dw.address), ''),
                               s.documents_address_lines, ''), E'\n'),
    'phone',        COALESCE(do2.phone, dw.phone, s.documents_phone),
    'npwp',         s.documents_npwp),
  'note', t.note, 'discrepancyReason', t.discrepancy_reason,
  'createdAt', t.created_at, 'sentAt', t.sent_at,
  'receivedAt', t.received_at, 'cancelledAt', t.cancelled_at,
  'items', COALESCE((SELECT json_agg(json_build_object(
     'productId', ti.product_id, 'productName', p.name,
     'variantSize', ti.variant_size, 'sku', v.sku,
     'sentQty', ti.sent_qty, 'receivedQty', ti.received_qty,
     'difference', ti.difference) ORDER BY p.name, ti.variant_size)
     FROM transfer_items ti
     JOIN products p ON p.id = ti.product_id
     LEFT JOIN product_variants v ON v.product_id = ti.product_id AND v.size = ti.variant_size
     WHERE ti.transfer_id = t.id), '[]'::json))`

// transferFrom resolves both polymorphic endpoints' names. `do2`/`dw` aliases
// avoid the reserved word `do`. The single-row app_settings table is joined
// unconditionally (ON true) to supply brand-level letterhead defaults.
const transferFrom = `FROM transfers t
  LEFT JOIN outlets    so  ON so.id  = t.source_outlet_id
  LEFT JOIN warehouses sw  ON sw.id  = t.source_warehouse_id
  LEFT JOIN outlets    do2 ON do2.id = t.dest_outlet_id
  LEFT JOIN warehouses dw  ON dw.id  = t.dest_warehouse_id
  LEFT JOIN app_settings s ON true`

// Transfers lists transfers newest-first with optional filters: status, date range,
// and location (any side — source OR dest).
func (r *Repo) Transfers(ctx context.Context, status, from, to, locKind, locID string, page, limit int) ([]api.Transfer, int, error) {
	where := "WHERE 1=1"
	args := []any{}
	if status != "" {
		args = append(args, status)
		where += fmt.Sprintf(" AND t.status=$%d", len(args))
	}
	if from != "" {
		args = append(args, from)
		where += fmt.Sprintf(" AND t.created_at >= $%d", len(args))
	}
	if to != "" {
		args = append(args, to)
		where += fmt.Sprintf(" AND t.created_at < $%d", len(args))
	}
	if locKind != "" && locID != "" {
		args = append(args, locID)
		if locKind == "warehouse" {
			where += fmt.Sprintf(" AND (t.source_warehouse_id=$%d OR t.dest_warehouse_id=$%d)", len(args), len(args))
		} else {
			where += fmt.Sprintf(" AND (t.source_outlet_id=$%d OR t.dest_outlet_id=$%d)", len(args), len(args))
		}
	}
	args = append(args, limit, off(page, limit))
	sql := fmt.Sprintf(`SELECT %s, count(*) OVER() AS total %s %s
	  ORDER BY t.created_at DESC LIMIT $%d OFFSET $%d`,
		transferObj, transferFrom, where, len(args)-1, len(args))
	return listJSON[api.Transfer](ctx, r.Pool, sql, args...)
}

// Transfer returns one transfer with its items.
func (r *Repo) Transfer(ctx context.Context, id string) (api.Transfer, error) {
	return oneJSON[api.Transfer](ctx, r.Pool,
		`SELECT `+transferObj+` `+transferFrom+` WHERE t.id=$1`, id)
}

// TransfersForOutlet returns transfers of a given status destined to this outlet.
// Used by the POS pull bundle (status="in_transit") so the destination outlet can
// receive on-device.
func (r *Repo) TransfersForOutlet(ctx context.Context, outletID, status string) ([]api.Transfer, error) {
	sql := `SELECT ` + transferObj + `, count(*) OVER() AS total ` + transferFrom +
		` WHERE t.dest_outlet_id=$1 AND t.status=$2 ORDER BY t.created_at DESC`
	rows, _, err := listJSON[api.Transfer](ctx, r.Pool, sql, outletID, status)
	return rows, err
}

// OutletTransferHistory returns transfers (incoming OR outgoing) for an outlet
// at a given status, newest first. Used by the cashier-scoped history view.
func (r *Repo) OutletTransferHistory(ctx context.Context, outletID, status string) ([]api.Transfer, error) {
	sql := `SELECT ` + transferObj + `, count(*) OVER() AS total ` + transferFrom +
		` WHERE (t.source_outlet_id=$1 OR t.dest_outlet_id=$1) AND t.status=$2 ORDER BY t.created_at DESC`
	rows, _, err := listJSON[api.Transfer](ctx, r.Pool, sql, outletID, status)
	return rows, err
}

// LocationStock returns on-hand rows for a polymorphic location, so the
// create-transfer UI can show the source's live stock. Warehouse reuses the
// existing matrix; outlet reads outlet_variant_stock.
func (r *Repo) LocationStock(ctx context.Context, kind, id string) ([]api.WarehouseStockRow, error) {
	if kind == "warehouse" {
		return r.WarehouseStock(ctx, id)
	}
	rows, _, err := listJSON[api.WarehouseStockRow](ctx, r.Pool, `
		SELECT json_build_object(
		  'productId', v.product_id, 'productName', p.name, 'variantSize', v.size,
		  'sku', v.sku,
		  'stock', COALESCE((SELECT s.stock FROM outlet_variant_stock s
		     WHERE s.outlet_id=$1 AND s.product_id=v.product_id AND s.variant_size=v.size),0),
		  'parLevel', (SELECT s.par_level FROM outlet_variant_stock s
		     WHERE s.outlet_id=$1 AND s.product_id=v.product_id AND s.variant_size=v.size))
		FROM product_variants v JOIN products p ON p.id=v.product_id
		ORDER BY p.name, v.size`, id)
	return rows, err
}

func (r *Repo) CashFlows(ctx context.Context, s Scope, shiftID string, page, limit int) ([]api.CashFlow, int, error) {
	where := "WHERE 1=1"
	args := []any{}
	if !s.CrossAll {
		args = append(args, s.OutletID)
		where += fmt.Sprintf(" AND cf.outlet_id=$%d", len(args))
	}
	if shiftID != "" {
		args = append(args, shiftID)
		where += fmt.Sprintf(" AND cf.shift_id=$%d", len(args))
	}
	args = append(args, limit, off(page, limit))
	sql := fmt.Sprintf(`SELECT json_build_object('id',cf.id,'outletId',cf.outlet_id,
	  'shiftId',cf.shift_id,'type',cf.type,'amount',cf.amount,
	  'description',cf.description,'cashierId',cf.cashier_id,
	  'cashierName',cf.cashier_name,'createdAt',cf.created_at),
	  count(*) OVER() AS total FROM cash_flows cf %s
	  ORDER BY cf.created_at DESC LIMIT $%d OFFSET $%d`,
		where, len(args)-1, len(args))
	return listJSON[api.CashFlow](ctx, r.Pool, sql, args...)
}

// ── Sync helpers (transfer receive auth) ─────────────────

// ApproverAuth holds the minimal fields needed to validate a POS receive approver.
type ApproverAuth struct {
	Role           string
	ReceivePinHash string
	OutletID       string // "" when the user has no outlet (e.g. admins)
}

// UserAuth fetches the role, receive PIN hash, and outlet id for the given user id.
// Returns pgx.ErrNoRows (wrapped) when the user does not exist.
func (r *Repo) UserAuth(ctx context.Context, id string) (ApproverAuth, error) {
	var a ApproverAuth
	var hash *string
	var outlet *string
	e := r.Pool.QueryRow(ctx,
		`SELECT role, receive_pin_hash, outlet_id FROM users WHERE id=$1`, id).Scan(&a.Role, &hash, &outlet)
	if hash != nil {
		a.ReceivePinHash = *hash
	}
	if outlet != nil {
		a.OutletID = *outlet
	}
	return a, e
}

// TransferDestOutlet returns the destination outlet id of a transfer, or "" if
// the transfer's destination is a warehouse (not an outlet). Errors if not found.
func (r *Repo) TransferDestOutlet(ctx context.Context, id string) (string, error) {
	var dest *string
	e := r.Pool.QueryRow(ctx, `SELECT dest_outlet_id FROM transfers WHERE id=$1`, id).Scan(&dest)
	if e != nil {
		return "", e
	}
	if dest == nil {
		return "", nil
	}
	return *dest, nil
}

// ReceiveApproverRoles returns the list of roles allowed to approve a POS
// transfer receive (stored in app_settings.receive_approver_roles).
func (r *Repo) ReceiveApproverRoles(ctx context.Context) ([]string, error) {
	var roles []string
	e := r.Pool.QueryRow(ctx,
		`SELECT receive_approver_roles FROM app_settings WHERE id=1`).Scan(&roles)
	return roles, e
}

// RecipesEnabled returns true when the Recipe/Formula module is turned on
// for this deployment. Reads the singleton app_settings row.
// A missing row (fresh DB) is treated as disabled — returns false, nil.
func (r *Repo) RecipesEnabled(ctx context.Context) (bool, error) {
	var enabled bool
	err := r.Pool.QueryRow(ctx,
		`SELECT COALESCE(recipes_enabled, false) FROM app_settings LIMIT 1`,
	).Scan(&enabled)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("read recipes_enabled: %w", err)
	}
	return enabled, nil
}

// InventoryOverview returns the read-only product-stock matrix: every active
// location (outlets then warehouses) × every active product variant, with a
// per-row total and a per-outlet-cell belowPar flag for low-stock highlighting.
func (r *Repo) InventoryOverview(ctx context.Context) (api.InventoryOverviewResponse, error) {
	var resp api.InventoryOverviewResponse

	// 1) Locations (outlets first, then warehouses), active only.
	lrows, err := r.Pool.Query(ctx, `
		SELECT id::text, 'outlet' AS kind, name FROM outlets WHERE is_active
		UNION ALL
		SELECT id::text, 'warehouse' AS kind, name FROM warehouses WHERE is_active
		ORDER BY kind ASC, name`) // 'outlet' < 'warehouse' lexically, so ASC puts outlets first
	if err != nil {
		return resp, err
	}
	defer lrows.Close()
	for lrows.Next() {
		var idStr string
		var kindStr string
		var name string
		if err := lrows.Scan(&idStr, &kindStr, &name); err != nil {
			return resp, err
		}
		locID, err := uuid.Parse(idStr)
		if err != nil {
			return resp, fmt.Errorf("parse location id %q: %w", idStr, err)
		}
		resp.Locations = append(resp.Locations, api.InventoryOverviewLocation{
			Id:   locID,
			Kind: api.InventoryOverviewLocationKind(kindStr),
			Name: name,
		})
	}
	if err := lrows.Err(); err != nil {
		return resp, err
	}

	// 2) Per-(variant, location) stock + outlet par_level, assembled in memory.
	type cellKey struct{ pid, size, loc string }
	stockByCell := map[cellKey]int{}
	parByCell := map[cellKey]*int{}

	orows, err := r.Pool.Query(ctx,
		`SELECT product_id::text, variant_size, outlet_id::text, stock, par_level FROM outlet_variant_stock`)
	if err != nil {
		return resp, err
	}
	for orows.Next() {
		var pid, size, loc string
		var stock int
		var par *int
		if err := orows.Scan(&pid, &size, &loc, &stock, &par); err != nil {
			orows.Close()
			return resp, err
		}
		k := cellKey{pid, size, loc}
		stockByCell[k] = stock
		parByCell[k] = par
	}
	orows.Close()
	if err := orows.Err(); err != nil {
		return resp, err
	}

	wrows, err := r.Pool.Query(ctx,
		`SELECT product_id::text, variant_size, warehouse_id::text, stock FROM warehouse_variant_stock`)
	if err != nil {
		return resp, err
	}
	for wrows.Next() {
		var pid, size, loc string
		var stock int
		if err := wrows.Scan(&pid, &size, &loc, &stock); err != nil {
			wrows.Close()
			return resp, err
		}
		stockByCell[cellKey{pid, size, loc}] = stock
	}
	wrows.Close()
	if err := wrows.Err(); err != nil {
		return resp, err
	}

	// 3) Rows = active product variants (full catalog).
	vrows, err := r.Pool.Query(ctx, `
		SELECT v.product_id::text, p.name, v.size, v.sku
		FROM product_variants v JOIN products p ON p.id=v.product_id
		WHERE p.is_active
		ORDER BY p.name, v.size`)
	if err != nil {
		return resp, err
	}
	defer vrows.Close()
	for vrows.Next() {
		var pid, name, size string
		var sku *string
		if err := vrows.Scan(&pid, &name, &size, &sku); err != nil {
			return resp, err
		}
		prodID, err := uuid.Parse(pid)
		if err != nil {
			return resp, fmt.Errorf("parse product id %q: %w", pid, err)
		}
		row := api.InventoryOverviewRow{
			ProductId:   prodID,
			ProductName: name,
			VariantSize: size,
			Sku:         sku,
		}
		total := 0
		for _, l := range resp.Locations {
			locStr := l.Id.String()
			k := cellKey{pid, size, locStr}
			stock := stockByCell[k]
			total += stock
			cell := api.InventoryOverviewCell{LocationId: l.Id, Stock: stock}
			if l.Kind == api.InventoryOverviewLocationKindOutlet {
				if par := parByCell[k]; par != nil && stock <= *par {
					cell.BelowPar = nullable.NewNullableWithValue(true)
				}
			}
			row.Cells = append(row.Cells, cell)
		}
		row.Total = total
		resp.Rows = append(resp.Rows, row)
	}
	if err := vrows.Err(); err != nil {
		return resp, err
	}
	return resp, nil
}

// IngredientOverview returns the read-only ingredient-stock matrix: every
// active location (outlets then warehouses) × every active ingredient, with a
// per-row total (float). No PAR threshold or belowPar flag.
func (r *Repo) IngredientOverview(ctx context.Context) (api.IngredientOverviewResponse, error) {
	var resp api.IngredientOverviewResponse

	// 1) Locations (outlets first, then warehouses), active only.
	lrows, err := r.Pool.Query(ctx, `
		SELECT id::text, 'outlet' AS kind, name FROM outlets WHERE is_active
		UNION ALL
		SELECT id::text, 'warehouse' AS kind, name FROM warehouses WHERE is_active
		ORDER BY kind ASC, name`) // 'outlet' < 'warehouse' lexically
	if err != nil {
		return resp, err
	}
	defer lrows.Close()
	for lrows.Next() {
		var idStr, kindStr, name string
		if err := lrows.Scan(&idStr, &kindStr, &name); err != nil {
			return resp, err
		}
		locID, err := uuid.Parse(idStr)
		if err != nil {
			return resp, fmt.Errorf("parse location id %q: %w", idStr, err)
		}
		resp.Locations = append(resp.Locations, api.InventoryOverviewLocation{
			Id:   locID,
			Kind: api.InventoryOverviewLocationKind(kindStr),
			Name: name,
		})
	}
	if err := lrows.Err(); err != nil {
		return resp, err
	}

	// 2) Per-(ingredient, location) qty assembled in memory.
	type cellKey struct{ ing, loc string }
	qtyByCell := map[cellKey]float64{}

	orows, err := r.Pool.Query(ctx,
		`SELECT ingredient_id::text, outlet_id::text, qty FROM ingredient_outlet_stock`)
	if err != nil {
		return resp, err
	}
	for orows.Next() {
		var ing, loc string
		var qty float64
		if err := orows.Scan(&ing, &loc, &qty); err != nil {
			orows.Close()
			return resp, err
		}
		qtyByCell[cellKey{ing, loc}] = qty
	}
	orows.Close()
	if err := orows.Err(); err != nil {
		return resp, err
	}

	wrows, err := r.Pool.Query(ctx,
		`SELECT ingredient_id::text, warehouse_id::text, qty FROM ingredient_warehouse_stock`)
	if err != nil {
		return resp, err
	}
	for wrows.Next() {
		var ing, loc string
		var qty float64
		if err := wrows.Scan(&ing, &loc, &qty); err != nil {
			wrows.Close()
			return resp, err
		}
		qtyByCell[cellKey{ing, loc}] = qty
	}
	wrows.Close()
	if err := wrows.Err(); err != nil {
		return resp, err
	}

	// 3) Rows = active ingredients.
	irows, err := r.Pool.Query(ctx, `
		SELECT i.id::text, i.name, i.sku, i.unit
		FROM ingredients i
		WHERE i.is_active
		ORDER BY i.name ASC`)
	if err != nil {
		return resp, err
	}
	defer irows.Close()
	for irows.Next() {
		var id, name, unit string
		var sku *string
		if err := irows.Scan(&id, &name, &sku, &unit); err != nil {
			return resp, err
		}
		ingID, err := uuid.Parse(id)
		if err != nil {
			return resp, fmt.Errorf("parse ingredient id %q: %w", id, err)
		}
		row := api.IngredientOverviewRow{
			IngredientId:   ingID,
			IngredientName: name,
			Sku:            sku,
			Unit:           unit,
		}
		var total float64
		for _, l := range resp.Locations {
			locStr := l.Id.String()
			qty := qtyByCell[cellKey{id, locStr}]
			total += qty
			row.Cells = append(row.Cells, api.IngredientOverviewCell{
				LocationId: l.Id,
				Qty:        float32(qty),
			})
		}
		row.Total = float32(total)
		resp.Rows = append(resp.Rows, row)
	}
	if err := irows.Err(); err != nil {
		return resp, err
	}
	return resp, nil
}

// MovementSummary returns a per-variant stock-movement summary for a single
// location (outlet or warehouse) over a half-open date range [from, to).
// For warehouses, sold/refunded are always 0 (warehouses don't sell).
func (r *Repo) MovementSummary(ctx context.Context, kind, id, from, to string, page, limit int) ([]api.MovementSummaryRow, int, error) {
	var sql string
	if kind == "outlet" {
		sql = `
WITH variant_base AS (
  SELECT v.product_id, v.size, p.name AS product_name, COALESCE(v.sku,'') AS sku
  FROM product_variants v JOIN products p ON p.id = v.product_id
  WHERE p.is_active
),
cur AS (
  SELECT product_id, variant_size, stock FROM outlet_variant_stock WHERE outlet_id = $1
),
gin AS (
  SELECT gri.product_id, gri.variant_size, SUM(gri.qty) AS qty
  FROM goods_receipt_items gri
  JOIN goods_receipts gr ON gr.id = gri.receipt_id
  WHERE gr.outlet_id = $1 AND gr.created_at >= $2 AND gr.created_at < $3
  GROUP BY 1,2
),
sold AS (
  SELECT oi.product_id, oi.variant_size, SUM(oi.quantity) AS qty
  FROM order_items oi
  JOIN orders o ON o.id = oi.order_id
  WHERE o.outlet_id = $1 AND o.status = 'completed' AND oi.is_bundle = false
    AND o.created_at >= $2 AND o.created_at < $3
  GROUP BY 1,2
),
refunded AS (
  SELECT oi.product_id, oi.variant_size, SUM(oi.quantity) AS qty
  FROM order_items oi
  JOIN orders o ON o.id = oi.order_id
  WHERE o.outlet_id = $1 AND o.status IN ('refunded','cancelled') AND oi.is_bundle = false
    AND COALESCE(o.refunded_at, o.created_at) >= $2
    AND COALESCE(o.refunded_at, o.created_at) < $3
  GROUP BY 1,2
),
tin AS (
  SELECT ti.product_id, ti.variant_size, SUM(ti.received_qty) AS qty
  FROM transfer_items ti
  JOIN transfers t ON t.id = ti.transfer_id
  WHERE t.dest_outlet_id = $1 AND t.status = 'completed'
    AND t.received_at >= $2 AND t.received_at < $3
  GROUP BY 1,2
),
tout AS (
  SELECT ti.product_id, ti.variant_size, SUM(ti.sent_qty) AS qty
  FROM transfer_items ti
  JOIN transfers t ON t.id = ti.transfer_id
  WHERE t.source_outlet_id = $1 AND t.status = 'completed'
    AND t.sent_at >= $2 AND t.sent_at < $3
  GROUP BY 1,2
),
adj AS (
  SELECT wsa.product_id, wsa.variant_size, COUNT(*) AS cnt
  FROM warehouse_stock_adjustments wsa
  WHERE wsa.outlet_id = $1
    AND wsa.created_at >= $2 AND wsa.created_at < $3
  GROUP BY 1,2
),
opn AS (
  SELECT sci.product_id, sci.variant_size, SUM(COALESCE(sci.difference, 0)) AS diff
  FROM stock_count_items sci
  JOIN stock_counts sc ON sc.id = sci.stock_count_id
  WHERE sc.outlet_id = $1 AND sc.status = 'completed'
    AND sc.completed_at >= $2 AND sc.completed_at < $3
  GROUP BY 1,2
)
SELECT json_build_object(
  'productId', vb.product_id, 'productName', vb.product_name, 'variantSize', vb.size, 'sku', vb.sku,
  'currentStock', COALESCE(cur.stock, 0),
  'goodsIn', COALESCE(gin.qty, 0),
  'sold', COALESCE(sold.qty, 0),
  'refunded', COALESCE(refunded.qty, 0),
  'transferIn', COALESCE(tin.qty, 0),
  'transferOut', COALESCE(tout.qty, 0),
  'adjustmentCount', COALESCE(adj.cnt, 0),
  'opnameDiff', COALESCE(opn.diff, 0)
), COUNT(*) OVER ()
FROM variant_base vb
LEFT JOIN cur      ON cur.product_id = vb.product_id      AND cur.variant_size = vb.size
LEFT JOIN gin      ON gin.product_id = vb.product_id      AND gin.variant_size = vb.size
LEFT JOIN sold     ON sold.product_id = vb.product_id     AND sold.variant_size = vb.size
LEFT JOIN refunded ON refunded.product_id = vb.product_id AND refunded.variant_size = vb.size
LEFT JOIN tin      ON tin.product_id = vb.product_id      AND tin.variant_size = vb.size
LEFT JOIN tout     ON tout.product_id = vb.product_id     AND tout.variant_size = vb.size
LEFT JOIN adj      ON adj.product_id = vb.product_id      AND adj.variant_size = vb.size
LEFT JOIN opn      ON opn.product_id = vb.product_id      AND opn.variant_size = vb.size
ORDER BY vb.product_name, vb.size
LIMIT $5 OFFSET $4`
	} else {
		// warehouse: no sold/refunded CTEs; set those fields to 0 in output
		sql = `
WITH variant_base AS (
  SELECT v.product_id, v.size, p.name AS product_name, COALESCE(v.sku,'') AS sku
  FROM product_variants v JOIN products p ON p.id = v.product_id
  WHERE p.is_active
),
cur AS (
  SELECT product_id, variant_size, stock FROM warehouse_variant_stock WHERE warehouse_id = $1
),
gin AS (
  SELECT gri.product_id, gri.variant_size, SUM(gri.qty) AS qty
  FROM goods_receipt_items gri
  JOIN goods_receipts gr ON gr.id = gri.receipt_id
  WHERE gr.warehouse_id = $1 AND gr.created_at >= $2 AND gr.created_at < $3
  GROUP BY 1,2
),
tin AS (
  SELECT ti.product_id, ti.variant_size, SUM(ti.received_qty) AS qty
  FROM transfer_items ti
  JOIN transfers t ON t.id = ti.transfer_id
  WHERE t.dest_warehouse_id = $1 AND t.status = 'completed'
    AND t.received_at >= $2 AND t.received_at < $3
  GROUP BY 1,2
),
tout AS (
  SELECT ti.product_id, ti.variant_size, SUM(ti.sent_qty) AS qty
  FROM transfer_items ti
  JOIN transfers t ON t.id = ti.transfer_id
  WHERE t.source_warehouse_id = $1 AND t.status = 'completed'
    AND t.sent_at >= $2 AND t.sent_at < $3
  GROUP BY 1,2
),
adj AS (
  SELECT wsa.product_id, wsa.variant_size, COUNT(*) AS cnt
  FROM warehouse_stock_adjustments wsa
  WHERE wsa.warehouse_id = $1
    AND wsa.created_at >= $2 AND wsa.created_at < $3
  GROUP BY 1,2
),
opn AS (
  SELECT sci.product_id, sci.variant_size, SUM(COALESCE(sci.difference, 0)) AS diff
  FROM stock_count_items sci
  JOIN stock_counts sc ON sc.id = sci.stock_count_id
  WHERE sc.warehouse_id = $1 AND sc.status = 'completed'
    AND sc.completed_at >= $2 AND sc.completed_at < $3
  GROUP BY 1,2
)
SELECT json_build_object(
  'productId', vb.product_id, 'productName', vb.product_name, 'variantSize', vb.size, 'sku', vb.sku,
  'currentStock', COALESCE(cur.stock, 0),
  'goodsIn', COALESCE(gin.qty, 0),
  'sold', 0,
  'refunded', 0,
  'transferIn', COALESCE(tin.qty, 0),
  'transferOut', COALESCE(tout.qty, 0),
  'adjustmentCount', COALESCE(adj.cnt, 0),
  'opnameDiff', COALESCE(opn.diff, 0)
), COUNT(*) OVER ()
FROM variant_base vb
LEFT JOIN cur  ON cur.product_id = vb.product_id  AND cur.variant_size = vb.size
LEFT JOIN gin  ON gin.product_id = vb.product_id  AND gin.variant_size = vb.size
LEFT JOIN tin  ON tin.product_id = vb.product_id  AND tin.variant_size = vb.size
LEFT JOIN tout ON tout.product_id = vb.product_id AND tout.variant_size = vb.size
LEFT JOIN adj  ON adj.product_id = vb.product_id  AND adj.variant_size = vb.size
LEFT JOIN opn  ON opn.product_id = vb.product_id  AND opn.variant_size = vb.size
ORDER BY vb.product_name, vb.size
LIMIT $5 OFFSET $4`
	}
	return listJSON[api.MovementSummaryRow](ctx, r.Pool, sql, id, from, to, off(page, limit), limit)
}
