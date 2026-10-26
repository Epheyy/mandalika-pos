package read

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/oapi-codegen/nullable"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/mandalika/pos-backend/internal/api"
)

// ErrGoodsReceiptNotFound is returned by GoodsReceiptDetail for an unknown receipt id.
var ErrGoodsReceiptNotFound = errors.New("goods receipt not found")

// GoodsReceiptDetail reads one goods receipt with its lines (the kartu stok opens it from a
// receipt row). The caller checks the location scope with the returned LocationType/LocationId.
func (r *Repo) GoodsReceiptDetail(ctx context.Context, id string) (api.GoodsReceiptDetail, error) {
	var (
		d                         api.GoodsReceiptDetail
		whID, outID               *openapi_types.UUID
		whName, outName           *string
		supplier, note, createdBy *string
		source                    string
	)
	err := r.Pool.QueryRow(ctx, `
SELECT gr.id, gr.warehouse_id, gr.outlet_id, w.name, o.name, gr.supplier, gr.note, gr.source, gr.created_at, u.display_name
FROM goods_receipts gr
LEFT JOIN warehouses w ON w.id = gr.warehouse_id
LEFT JOIN outlets o ON o.id = gr.outlet_id
LEFT JOIN users u ON u.id = gr.created_by
WHERE gr.id = $1`, id).Scan(&d.Id, &whID, &outID, &whName, &outName, &supplier, &note, &source, &d.CreatedAt, &createdBy)
	if errors.Is(err, pgx.ErrNoRows) {
		return d, ErrGoodsReceiptNotFound
	}
	if err != nil {
		return d, fmt.Errorf("goods receipt: %w", err)
	}
	if whID != nil {
		d.LocationType, d.LocationId, d.LocationName = api.InventoryLocationTypeWarehouse, *whID, whName
	} else if outID != nil {
		d.LocationType, d.LocationId, d.LocationName = api.InventoryLocationTypeOutlet, *outID, outName
	}
	d.Supplier, d.Note, d.CreatedByName = supplier, note, createdBy
	d.Source = api.GoodsReceiptDetailSource(source)
	rows, err := r.Pool.Query(ctx, `
SELECT i.product_id, COALESCE(p.name, ''), i.variant_size, NULLIF(v.sku, ''), i.qty, i.unit_cost::float8
FROM goods_receipt_items i
LEFT JOIN products p ON p.id = i.product_id
LEFT JOIN LATERAL (SELECT sku FROM product_variants pv WHERE pv.product_id = i.product_id AND pv.size = i.variant_size LIMIT 1) v ON true
WHERE i.receipt_id = $1 ORDER BY p.name, i.variant_size`, id)
	if err != nil {
		return d, fmt.Errorf("goods receipt items: %w", err)
	}
	defer rows.Close()
	d.Items = []api.GoodsReceiptDetailItem{}
	for rows.Next() {
		var (
			it       api.GoodsReceiptDetailItem
			unitCost *float64
		)
		if err := rows.Scan(&it.ProductId, &it.ProductName, &it.VariantSize, &it.Sku, &it.Qty, &unitCost); err != nil {
			return d, fmt.Errorf("goods receipt item scan: %w", err)
		}
		// the generated nullable type has no Scanner: set it from the scanned pointer
		if unitCost != nil {
			it.UnitCost = nullable.NewNullableWithValue(*unitCost)
		} else {
			it.UnitCost.SetNull()
		}
		d.Items = append(d.Items, it)
	}
	return d, rows.Err()
}
