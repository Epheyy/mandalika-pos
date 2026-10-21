package read

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"github.com/oapi-codegen/nullable"

	"github.com/mandalika/pos-backend/internal/api"
)

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
