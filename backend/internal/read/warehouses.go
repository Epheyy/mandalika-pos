package read

import (
	"context"

	"github.com/mandalika/pos-backend/internal/api"
)

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
