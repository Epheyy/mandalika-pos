package write

import (
	"context"

	"github.com/jackc/pgx/v5"

	"github.com/mandalika/pos-backend/internal/csvimport"
)

// planSkuMappingImport loads every variant (with its product's group key) and plans the
// mapping file against it. Barcode and size are never touched: the barcode defaults to
// the old SKU and printed labels must stay valid.
func planSkuMappingImport(ctx context.Context, q pgx.Tx, t *csvimport.Table) (*importPlan, error) {
	cat := csvimport.SkuMappingCatalog{GroupKeys: map[string]string{}, GroupKeyOwners: map[string]string{}}
	rows, err := q.Query(ctx, `
		SELECT v.id::text, v.product_id::text, v.sku, COALESCE(v.erp_slug,''), COALESCE(p.erp_group_key,'')
		  FROM product_variants v JOIN products p ON p.id = v.product_id`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var v csvimport.SkuMappingVariant
		var gk string
		if err = rows.Scan(&v.ID, &v.ProductID, &v.SKU, &v.ErpSlug, &gk); err != nil {
			rows.Close()
			return nil, err
		}
		cat.Variants = append(cat.Variants, v)
		cat.GroupKeys[v.ProductID] = gk
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return nil, err
	}
	// A key can be held by a product that has no variants, so read it from products.
	krows, err := q.Query(ctx, `SELECT id::text, erp_group_key FROM products WHERE erp_group_key IS NOT NULL`)
	if err != nil {
		return nil, err
	}
	for krows.Next() {
		var id, k string
		if err = krows.Scan(&id, &k); err != nil {
			krows.Close()
			return nil, err
		}
		cat.GroupKeyOwners[k] = id
	}
	krows.Close()
	if err = krows.Err(); err != nil {
		return nil, err
	}

	plan, err := csvimport.PlanSkuMapping(t, cat)
	if err != nil {
		return nil, err
	}
	return &importPlan{report: plan.Report, apply: func(ctx context.Context, tx pgx.Tx) error {
		return applySkuMappingPlan(ctx, tx, plan)
	}}, nil
}

func applySkuMappingPlan(ctx context.Context, tx pgx.Tx, plan *csvimport.SkuMappingPlan) error {
	if len(plan.Mappings) == 0 && len(plan.GroupKeys) == 0 {
		return nil // all skips: nothing written, no version bump
	}
	if n := len(plan.Mappings); n > 0 {
		ids, olds, codes, slugs := make([]string, n), make([]string, n), make([]string, n), make([]string, n)
		for i, m := range plan.Mappings {
			ids[i], olds[i], codes[i], slugs[i] = m.VariantID, m.OldSKU, m.FGCode, m.FGSlug
		}
		// Park every mapped variant on a unique temporary SKU first (compare-and-set on the
		// planned old SKU): idx_variant_product_sku is checked row by row, so a swap or chain
		// inside one product would otherwise trip it mid-statement.
		ct, err := tx.Exec(ctx, `
			UPDATE product_variants v SET sku = 'tmp:' || v.id::text
			  FROM unnest($1::uuid[], $2::text[]) AS t(id, old)
			 WHERE v.id = t.id AND v.sku = t.old`, ids, olds)
		if err != nil {
			return err
		}
		if int(ct.RowsAffected()) != n {
			return errImportStale // a variant vanished or its SKU changed between plan and apply
		}
		ct, err = tx.Exec(ctx, `
			UPDATE product_variants v SET sku = t.code, erp_slug = t.slug
			  FROM unnest($1::uuid[], $2::text[], $3::text[]) AS t(id, code, slug)
			 WHERE v.id = t.id`, ids, codes, slugs)
		if err != nil {
			return err
		}
		if int(ct.RowsAffected()) != n {
			return errImportStale
		}
	}
	if n := len(plan.GroupKeys); n > 0 {
		ids, keys := make([]string, 0, n), make([]string, 0, n)
		for id, k := range plan.GroupKeys {
			ids, keys = append(ids, id), append(keys, k)
		}
		ct, err := tx.Exec(ctx, `
			UPDATE products p SET erp_group_key = t.k
			  FROM unnest($1::uuid[], $2::text[]) AS t(id, k)
			 WHERE p.id = t.id`, ids, keys)
		if err != nil {
			return err
		}
		if int(ct.RowsAffected()) != n {
			return errImportStale
		}
	}
	return bumpVersion(ctx, tx, "products")
}
