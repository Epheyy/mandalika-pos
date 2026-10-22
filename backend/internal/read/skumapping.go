package read

import "context"

// SkuMappingRow is one line of the ERP SKU mapping export (plan 4.2): one per variant.
// FGCode/FGSlug are prefilled only when the variant is already linked (erp_slug set).
type SkuMappingRow struct {
	VariantID, Product, Size, SKU, Barcode string
	HasStock                               bool
	FGCode, FGSlug, ERPGroupKey            string
}

// SkuMappingExport lists every variant, ordered by product name then size. has_stock is
// true when any outlet or warehouse stock row of the (product, size) is non-zero.
func (r *Repo) SkuMappingExport(ctx context.Context) ([]SkuMappingRow, error) {
	rows, err := r.Pool.Query(ctx, `
		SELECT v.id::text, p.name, v.size, v.sku, v.barcode,
		       (EXISTS (SELECT 1 FROM outlet_variant_stock s
		                 WHERE s.product_id=v.product_id AND s.variant_size=v.size AND s.stock <> 0)
		     OR EXISTS (SELECT 1 FROM warehouse_variant_stock w
		                 WHERE w.product_id=v.product_id AND w.variant_size=v.size AND w.stock <> 0)),
		       CASE WHEN v.erp_slug IS NOT NULL THEN v.sku ELSE '' END,
		       COALESCE(v.erp_slug,''), COALESCE(p.erp_group_key,'')
		  FROM product_variants v JOIN products p ON p.id = v.product_id
		 ORDER BY p.name, v.size, v.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SkuMappingRow
	for rows.Next() {
		var m SkuMappingRow
		if err = rows.Scan(&m.VariantID, &m.Product, &m.Size, &m.SKU, &m.Barcode, &m.HasStock,
			&m.FGCode, &m.FGSlug, &m.ERPGroupKey); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}
