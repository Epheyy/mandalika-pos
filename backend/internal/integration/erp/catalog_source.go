package erp

import (
	"context"

	"github.com/jackc/pgx/v5"

	"github.com/mandalika/pos-backend/internal/integration/erp/erpapi"
)

// Product name and category of an ERP-grouped product follow the values its sizes last
// received from the ERP (product_variants.erp_name / erp_category, migration 0068), taken
// in owner order: active sizes first, then the smallest FG code (byte order). The name is
// the owner's; the category is the first stored one (a size with a blank category passes it
// on). A linked variant whose values were never stored (erp_name IS NULL: rows created
// before migration 0068 and not pulled since) stops the walk: the product keeps its current
// value until that row is stored, so an incremental pull before the first full pull cannot
// hand the product to a lower-ranked size. The order is deterministic, so siblings that
// disagree never flip the product between pulls, and because every size's values are
// stored, a discontinued, deleted or reconciled-away owner hands over to the next size in
// the same transaction.

// sourceName and sourceCategory are scalar subqueries over the product's ERP-linked variants
// in owner order; NULL means "keep the product's current value". productID is a column
// reference or a placeholder, never input.
func sourceName(productID string) string {
	return `(SELECT o.erp_name FROM product_variants o WHERE o.product_id=` + productID +
		` AND o.erp_slug IS NOT NULL ` + ownerOrder + ` LIMIT 1)`
}

func sourceCategory(productID string) string {
	return `(SELECT CASE WHEN o.erp_name IS NULL THEN NULL ELSE o.erp_category END FROM product_variants o` +
		` WHERE o.product_id=` + productID + ` AND o.erp_slug IS NOT NULL` +
		` AND (o.erp_category IS NOT NULL OR o.erp_name IS NULL) ` + ownerOrder + ` LIMIT 1)`
}

const ownerOrder = `ORDER BY o.is_active DESC, o.sku COLLATE "C"`

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
// only: it never counts as a change (the product write, if any, is syncProduct's).
func storeSource(ctx context.Context, q pgx.Tx, variantID, name string, category *string) error {
	_, err := q.Exec(ctx, `UPDATE product_variants SET erp_name=$2, erp_category=$3
		 WHERE id=$1 AND (erp_name IS DISTINCT FROM $2 OR erp_category IS DISTINCT FROM $3)`,
		variantID, name, category)
	return err
}

// syncProduct sets the product's name and category from its sizes' stored ERP values (a
// missing value keeps the current one) and CLEARS is_active once no variant is active (R2:
// products.is_active is admin-owned; the pull never sets it true). It reports whether the
// product changed and whether a category row was created.
func syncProduct(ctx context.Context, q pgx.Tx, productID string) (changed, categoryCreated bool, err error) {
	var name, category *string
	if err := q.QueryRow(ctx, `SELECT `+sourceName("$1::text::uuid")+`, `+sourceCategory("$1::text::uuid"),
		productID).Scan(&name, &category); err != nil {
		return false, false, err
	}
	catID, created, err := upsertCategory(ctx, q, category)
	if err != nil {
		return false, false, err
	}
	ct, err := q.Exec(ctx, `
		UPDATE products SET name = COALESCE($2, name),
		       category_id = COALESCE($3::text::uuid, category_id),
		       is_active = is_active AND EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id=products.id AND v.is_active)
		 WHERE id=$1
		   AND (name IS DISTINCT FROM COALESCE($2, name)
		     OR category_id IS DISTINCT FROM COALESCE($3::text::uuid, category_id)
		     OR (is_active AND NOT EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id=products.id AND v.is_active)))`,
		productID, name, catID)
	if err != nil {
		return false, false, err
	}
	return ct.RowsAffected() > 0, created, nil
}
