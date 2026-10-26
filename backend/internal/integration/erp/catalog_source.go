package erp

import (
	"context"

	"github.com/jackc/pgx/v5"

	"github.com/mandalika/pos-backend/internal/integration/erp/erpapi"
)

// What each ERP size last said about its product is stored on its own variant
// (product_variants.erp_name / erp_category, migration 0068). Mapping v3 (sandbox pull report
// 2026-10-26 §6.4, owner decision 2026-10-26) never copies it onto the product: once a
// product exists its name, category, brand, sellable flag and images belong to the POS, and
// the ERP category is a product line, not a POS category. The stored values show the drift
// (for example KEM-CAN "CANVAS BAG MANDALIKA" against the POS name "CANVAS BAG").

// fgSourceName is the name stored for an FG: the product name rule for a sellable FG, the
// full ERP name (spaces collapsed) for an "others" item.
func fgSourceName(fg erpapi.IntegrationFG) string {
	if fg.IsOthers {
		return collapseSpaces(fg.Name)
	}
	return ProductNameFromFG(fg.Name)
}

// fgCategory is the category text stored for an FG: spaces collapsed, nil when blank.
func fgCategory(fg erpapi.IntegrationFG) *string {
	if fg.Category == nil {
		return nil
	}
	if c := collapseSpaces(*fg.Category); c != "" {
		return &c
	}
	return nil
}

// storeSource records what the FG says about its product on its own variant. Bookkeeping
// only: it never counts as a change.
func storeSource(ctx context.Context, q pgx.Tx, variantID, name string, category *string) error {
	_, err := q.Exec(ctx, `UPDATE product_variants SET erp_name=$2, erp_category=$3
		 WHERE id=$1 AND (erp_name IS DISTINCT FROM $2 OR erp_category IS DISTINCT FROM $3)`,
		variantID, name, category)
	return err
}

// syncProduct CLEARS products.is_active once no variant is active (R2: products.is_active is
// admin-owned; the pull never sets it true). It is the only write the pull makes to an
// existing product. It reports whether the product changed.
func syncProduct(ctx context.Context, q pgx.Tx, productID string) (bool, error) {
	ct, err := q.Exec(ctx, `
		UPDATE products SET is_active = false
		 WHERE id=$1 AND is_active
		   AND NOT EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id=products.id AND v.is_active)`,
		productID)
	if err != nil {
		return false, err
	}
	return ct.RowsAffected() > 0, nil
}
