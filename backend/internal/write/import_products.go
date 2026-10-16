package write

import (
	"context"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/mandalika/pos-backend/internal/csvimport"
)

// planProductImport loads the catalog once and plans the file against it.
func planProductImport(ctx context.Context, q pgx.Tx, t *csvimport.Table) (*importPlan, error) {
	cat, err := loadCatalog(ctx, q)
	if err != nil {
		return nil, err
	}
	plan, err := csvimport.PlanProducts(t, cat)
	if err != nil {
		return nil, err
	}
	return &importPlan{report: plan.Report, apply: func(ctx context.Context, tx pgx.Tx) error {
		return applyProductPlan(ctx, tx, plan)
	}}, nil
}

func loadCatalog(ctx context.Context, q pgx.Tx) (csvimport.Catalog, error) {
	var cat csvimport.Catalog
	rows, err := q.Query(ctx, `
		SELECT id::text, name, brand, COALESCE(category_id::text,''), COALESCE(description,''),
		       sellable, is_active, is_featured
		  FROM products`)
	if err != nil {
		return cat, err
	}
	for rows.Next() {
		var p csvimport.CatalogProduct
		if err = rows.Scan(&p.ID, &p.Name, &p.Brand, &p.CategoryID, &p.Description, &p.Sellable, &p.Active, &p.Featured); err != nil {
			rows.Close()
			return cat, err
		}
		cat.Products = append(cat.Products, p)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return cat, err
	}

	rows, err = q.Query(ctx, `SELECT id::text, product_id::text, size, sku, barcode, price::float8 FROM product_variants`)
	if err != nil {
		return cat, err
	}
	for rows.Next() {
		var v csvimport.CatalogVariant
		if err = rows.Scan(&v.ID, &v.ProductID, &v.Size, &v.SKU, &v.Barcode, &v.Price); err != nil {
			rows.Close()
			return cat, err
		}
		cat.Variants = append(cat.Variants, v)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return cat, err
	}

	rows, err = q.Query(ctx, `SELECT id::text, name FROM categories`)
	if err != nil {
		return cat, err
	}
	for rows.Next() {
		var c csvimport.CatalogCategory
		if err = rows.Scan(&c.ID, &c.Name); err != nil {
			rows.Close()
			return cat, err
		}
		cat.Categories = append(cat.Categories, c)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return cat, err
	}

	// Sizes that already have per-outlet or warehouse stock/price rows: a rename onto one
	// of them would collide on the (location, product, size) key.
	rows, err = q.Query(ctx, `
		SELECT DISTINCT product_id::text, variant_size FROM (
		  SELECT product_id, variant_size FROM outlet_variant_stock
		  UNION ALL SELECT product_id, variant_size FROM outlet_variant_price
		  UNION ALL SELECT product_id, variant_size FROM warehouse_variant_stock) s`)
	if err != nil {
		return cat, err
	}
	cat.StockSizes = map[string]map[string]bool{}
	for rows.Next() {
		var pid, size string
		if err = rows.Scan(&pid, &size); err != nil {
			rows.Close()
			return cat, err
		}
		if cat.StockSizes[pid] == nil {
			cat.StockSizes[pid] = map[string]bool{}
		}
		cat.StockSizes[pid][size] = true
	}
	rows.Close()
	return cat, rows.Err()
}

// applyProductPlan writes the plan merge-only, in the caller's transaction:
//   - it never deletes a product, variant or category;
//   - it never writes a stock column (product_variants.stock keeps its default 0 for a new
//     variant, and no outlet_variant_stock / warehouse stock row is created);
//   - an existing variant only has size, price and barcode updated, and a size rename
//     moves its per-outlet stock/price rows (and warehouse stock) to the new size key.
func applyProductPlan(ctx context.Context, tx pgx.Tx, plan *csvimport.ProductsPlan) error {
	if len(plan.Products) == 0 && len(plan.NewCategories) == 0 {
		return nil
	}
	catIDs, err := ensureCategories(ctx, tx, plan.NewCategories)
	if err != nil {
		return err
	}
	if len(plan.NewCategories) > 0 {
		if err = bumpVersion(ctx, tx, "categories"); err != nil {
			return err
		}
	}

	var (
		newIdx    []int
		updIdx    []int
		productID = make([]string, len(plan.Products))
	)
	for i, p := range plan.Products {
		if p.ExistingID == "" {
			newIdx = append(newIdx, i)
		} else {
			productID[i] = p.ExistingID
			updIdx = append(updIdx, i)
		}
	}
	if err = insertImportedProducts(ctx, tx, plan.Products, newIdx, catIDs, productID); err != nil {
		return err
	}
	if err = updateImportedProducts(ctx, tx, plan.Products, updIdx, catIDs); err != nil {
		return err
	}
	if err = writeImportedVariants(ctx, tx, plan.Products, productID); err != nil {
		return err
	}
	return bumpVersion(ctx, tx, "products")
}

// ensureCategories returns lower(name) -> id for every category (existing and new) and
// creates the missing ones set-based.
func ensureCategories(ctx context.Context, tx pgx.Tx, newNames []string) (map[string]string, error) {
	if len(newNames) > 0 {
		if _, err := tx.Exec(ctx,
			`INSERT INTO categories (name) SELECT n FROM unnest($1::text[]) AS t(n)`, newNames); err != nil {
			return nil, err
		}
	}
	ids := map[string]string{}
	rows, err := tx.Query(ctx, `SELECT lower(name), id::text FROM categories ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var name, id string
		if err := rows.Scan(&name, &id); err != nil {
			return nil, err
		}
		if _, ok := ids[name]; !ok {
			ids[name] = id
		}
	}
	return ids, rows.Err()
}

func categoryArg(ids map[string]string, name string) *string {
	if name == "" {
		return nil
	}
	id, ok := ids[strings.ToLower(name)]
	if !ok {
		return nil
	}
	return &id
}

func insertImportedProducts(ctx context.Context, tx pgx.Tx, ps []csvimport.PlannedProduct, idx []int,
	catIDs map[string]string, productID []string) error {
	if len(idx) == 0 {
		return nil
	}
	n := len(idx)
	names, brands := make([]string, n), make([]string, n)
	cats, descs := make([]*string, n), make([]*string, n)
	sell, act, feat := make([]bool, n), make([]bool, n), make([]bool, n)
	for k, i := range idx {
		p := ps[i]
		names[k], brands[k] = p.Name, p.Brand
		cats[k], descs[k] = categoryArg(catIDs, p.CategoryName), p.Description
		sell[k], act[k], feat[k] = *p.Sellable, *p.Active, *p.Featured
	}
	rows, err := tx.Query(ctx, `
		INSERT INTO products (name, brand, category_id, description, sellable, is_active, is_featured)
		SELECT t.n, t.b, t.c::uuid, t.d, t.s, t.a, t.f
		  FROM unnest($1::text[],$2::text[],$3::text[],$4::text[],$5::bool[],$6::bool[],$7::bool[]) AS t(n,b,c,d,s,a,f)
		RETURNING id::text, lower(name), lower(brand)`,
		names, brands, cats, descs, sell, act, feat)
	if err != nil {
		return err
	}
	defer rows.Close()
	created := map[string]string{}
	for rows.Next() {
		var id, name, brand string
		if err := rows.Scan(&id, &name, &brand); err != nil {
			return err
		}
		created[name+"|"+brand] = id
	}
	if err := rows.Err(); err != nil {
		return err
	}
	rows.Close()
	for _, i := range idx {
		productID[i] = created[strings.ToLower(ps[i].Name)+"|"+strings.ToLower(ps[i].Brand)]
	}
	return nil
}

// updateImportedProducts applies product-level cells to existing products. A nil value
// keeps the stored one (blank optional cell = keep).
func updateImportedProducts(ctx context.Context, tx pgx.Tx, ps []csvimport.PlannedProduct, idx []int,
	catIDs map[string]string) error {
	if len(idx) == 0 {
		return nil
	}
	n := len(idx)
	ids := make([]string, n)
	cats, descs := make([]*string, n), make([]*string, n)
	sell, act, feat := make([]*bool, n), make([]*bool, n), make([]*bool, n)
	for k, i := range idx {
		p := ps[i]
		ids[k] = p.ExistingID
		cats[k], descs[k] = categoryArg(catIDs, p.CategoryName), p.Description
		sell[k], act[k], feat[k] = p.Sellable, p.Active, p.Featured
	}
	_, err := tx.Exec(ctx, `
		UPDATE products p SET
		       category_id = COALESCE(u.c::uuid, p.category_id),
		       description = COALESCE(u.d, p.description),
		       sellable    = COALESCE(u.s, p.sellable),
		       is_active   = COALESCE(u.a, p.is_active),
		       is_featured = COALESCE(u.f, p.is_featured)
		  FROM unnest($1::uuid[],$2::text[],$3::text[],$4::bool[],$5::bool[],$6::bool[]) AS u(id,c,d,s,a,f)
		 WHERE p.id = u.id`,
		ids, cats, descs, sell, act, feat)
	return err
}

// writeImportedVariants inserts new variants (never with stock), updates size, price and
// barcode of matched ones, and moves per-outlet stock/price (and warehouse stock) rows
// for renamed sizes.
func writeImportedVariants(ctx context.Context, tx pgx.Tx, ps []csvimport.PlannedProduct, productID []string) error {
	var (
		cPID, cSize, cSKU, cBar []string
		cPrice                  []float64
		uID, uSize, uBar        []string
		uPrice                  []float64
		rPID, rFrom, rTo        []string
	)
	for i, p := range ps {
		for _, v := range p.Variants {
			switch {
			case v.Create:
				cPID, cSize, cSKU, cBar = append(cPID, productID[i]), append(cSize, v.Size), append(cSKU, v.SKU), append(cBar, v.Barcode)
				cPrice = append(cPrice, v.Price)
			case v.Update:
				uID, uSize, uBar = append(uID, v.ExistingID), append(uSize, v.Size), append(uBar, v.Barcode)
				uPrice = append(uPrice, v.Price)
				if v.RenameFrom != "" {
					rPID, rFrom, rTo = append(rPID, productID[i]), append(rFrom, v.RenameFrom), append(rTo, v.Size)
				}
			}
		}
	}
	if len(cPID) > 0 {
		if _, err := tx.Exec(ctx, `
			INSERT INTO product_variants (product_id, size, price, sku, barcode)
			SELECT t.p::uuid, t.s, t.pr, t.k, t.b
			  FROM unnest($1::text[],$2::text[],$3::numeric[],$4::text[],$5::text[]) AS t(p,s,pr,k,b)`,
			cPID, cSize, cPrice, cSKU, cBar); err != nil {
			return err
		}
	}
	if len(uID) > 0 {
		if _, err := tx.Exec(ctx, `
			UPDATE product_variants v SET size = u.s, price = u.pr,
			       barcode = COALESCE(NULLIF(u.b,''), v.barcode)
			  FROM unnest($1::uuid[],$2::text[],$3::numeric[],$4::text[]) AS u(id,s,pr,b)
			 WHERE v.id = u.id`,
			uID, uSize, uPrice, uBar); err != nil {
			return err
		}
	}
	if len(rPID) > 0 {
		for _, table := range []string{"outlet_variant_stock", "outlet_variant_price", "warehouse_variant_stock"} {
			if _, err := tx.Exec(ctx, `
				UPDATE `+table+` s SET variant_size = r.to_size
				  FROM unnest($1::uuid[],$2::text[],$3::text[]) AS r(pid,from_size,to_size)
				 WHERE s.product_id = r.pid AND s.variant_size = r.from_size`,
				rPID, rFrom, rTo); err != nil {
				return err
			}
		}
	}
	return nil
}
