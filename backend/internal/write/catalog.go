package write

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/mandalika/pos-backend/internal/api"
	"github.com/mandalika/pos-backend/internal/apperr"
)

// txStock is tx for a writer that also changes outlet stock. fn returns the outlets
// whose stock it wrote (none = nothing to announce); after the content version bump the
// outlets' stock change counters advance, LAST (A15 Phase B).
func (r *Repo) txStock(ctx context.Context, resource string, fn func(pgx.Tx) ([]string, error)) error {
	t, err := r.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer t.Rollback(ctx)
	changed, err := fn(t)
	if err != nil {
		return err
	}
	if err := bumpVersion(ctx, t, resource); err != nil {
		return fmt.Errorf("bump version: %w", err)
	}
	if len(changed) > 0 {
		if _, err := BumpStockSeq(ctx, t, changed...); err != nil {
			return err
		}
	}
	return t.Commit(ctx)
}

type Variant struct {
	ID      string  `json:"id"` // permanent id; empty = new (modal sends it; CSV omits it)
	Size    string  `json:"size"`
	Price   float64 `json:"price"`
	Stock   int     `json:"stock"`
	SKU     string  `json:"sku"`
	Barcode string  `json:"barcode"` // scan key; empty ⇒ defaults to SKU
}

// variantBarcode resolves the scan key: explicit barcode, else the SKU.
func variantBarcode(v Variant) string {
	if v.Barcode != "" {
		return v.Barcode
	}
	return v.SKU
}

// validateVariants enforces SKU (required + unique per product) and rejects
// duplicate effective scan keys (barcode ⇒ SKU) within the product.
func validateVariants(vs []Variant) error {
	seen := map[string]bool{}
	seenBC := map[string]bool{}
	for _, v := range vs {
		if v.SKU == "" {
			return fmt.Errorf("setiap varian wajib punya SKU")
		}
		if seen[v.SKU] {
			return fmt.Errorf("SKU duplikat dalam produk: %s", v.SKU)
		}
		seen[v.SKU] = true
		bc := variantBarcode(v)
		if seenBC[bc] {
			return fmt.Errorf("barcode duplikat dalam produk: %s", bc)
		}
		seenBC[bc] = true
	}
	return nil
}

// SkuTakenError is a SKU that another product already uses (global SKU uniqueness, plan
// 4.2). It carries the 409 conflict code; handlers answer it with HTTP 409.
type SkuTakenError struct{ SKU string }

func (e *SkuTakenError) Error() string { return "SKU sudah dipakai produk lain: " + e.SKU }

func (e *SkuTakenError) ErrorCode() apperr.Code { return apperr.Conflict }

// IsSkuTaken reports whether err is a SkuTakenError.
func IsSkuTaken(err error) bool {
	var e *SkuTakenError
	return errors.As(err, &e)
}

// existingSKUs lists, per incoming variant, the stored SKU of the variant it updates
// ("" for a new variant), so checkSkusFree can tell new or changed SKUs from unchanged ones.
func existingSKUs(vs []Variant, matched []string, byID map[string]existingVariant) []string {
	out := make([]string, len(vs))
	for i := range vs {
		if vid := matched[i]; vid != "" {
			out[i] = byID[vid].sku
		}
	}
	return out
}

// checkSkusFree rejects a NEW or CHANGED SKU that a variant of another product already
// uses. Unchanged SKUs are skipped on purpose: legacy duplicates may exist until the
// one-time mapping runs, and they must still save. current is nil on create.
func checkSkusFree(ctx context.Context, t pgx.Tx, productID string, current []string, vs []Variant) error {
	for i, v := range vs {
		if current != nil && current[i] == v.SKU {
			continue
		}
		var taken bool
		if e := t.QueryRow(ctx,
			`SELECT EXISTS (SELECT 1 FROM product_variants WHERE sku=$1 AND product_id IS DISTINCT FROM NULLIF($2,'')::uuid)`,
			v.SKU, productID).Scan(&taken); e != nil {
			return e
		}
		if taken {
			return &SkuTakenError{SKU: v.SKU}
		}
	}
	return nil
}

type Product struct {
	Name        string    `json:"name"`
	Brand       string    `json:"brand"`
	CategoryID  string    `json:"categoryId"`
	Description string    `json:"description"`
	ImageURL    string    `json:"imageUrl"`
	Images      []string  `json:"images"`
	Sellable    bool      `json:"sellable"`
	Variants    []Variant `json:"variants"`
	IsFeatured  bool      `json:"isFeatured"`
	IsFavourite bool      `json:"isFavourite"`
	IsActive    bool      `json:"isActive"`
}

// productImages resolves the images array + main image (images[0], back-compat
// with the legacy single image_url column).
func productImages(p Product) ([]byte, string) {
	imgs := p.Images
	if len(imgs) == 0 && p.ImageURL != "" {
		imgs = []string{p.ImageURL}
	}
	main := ""
	if len(imgs) > 0 {
		main = imgs[0]
	}
	b, _ := json.Marshal(imgs)
	return b, main
}

func (r *Repo) CreateProduct(ctx context.Context, seedOutletID string, p Product) (string, error) {
	if e := validateVariants(p.Variants); e != nil {
		return "", e
	}
	// D12: opening stock is never typed into a create; it enters through a goods receipt,
	// which records the movement. Refused before any write.
	for _, v := range p.Variants {
		if v.Stock != 0 {
			return "", fmt.Errorf("stok awal tidak bisa diisi saat membuat produk; catat lewat Penerimaan Barang (varian %s)", v.SKU)
		}
	}
	var id string
	err := r.txStock(ctx, "products", func(t pgx.Tx) ([]string, error) {
		if e := checkSkusFree(ctx, t, "", nil, p.Variants); e != nil {
			return nil, e
		}
		imgs, main := productImages(p)
		if e := t.QueryRow(ctx, `
			INSERT INTO products (name, brand, category_id, description, image_url,
			  images, sellable, is_featured, is_favourite, is_active)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
			p.Name, p.Brand, nullUUID(p.CategoryID), nullStr(p.Description),
			nullStr(main), imgs, p.Sellable, p.IsFeatured, p.IsFavourite, p.IsActive).
			Scan(&id); e != nil {
			return nil, e
		}
		if e := insertVariants(ctx, t, id, p.Variants); e != nil {
			return nil, e
		}
		seeded, e := seedOutletStock(ctx, t, id, seedOutletID, p.Variants)
		if e != nil || seeded == "" {
			return nil, e
		}
		return []string{seeded}, nil
	})
	return id, barcodeConflict(err)
}

// seedOutletStock writes a new product's initial per-variant stock to one outlet:
// seedOutletID when set, else the primary outlet (most completed orders, tie-break
// oldest active). Variants with 0 are skipped; other outlets start empty. Since D12
// CreateProduct refuses a non-zero stock, so in practice no row is written. It returns
// the outlet it wrote stock rows to, or "" when no row was written (no active outlet,
// or every variant is 0), so the caller announces a change only when one happened.
func seedOutletStock(ctx context.Context, t pgx.Tx, productID, seedOutletID string, vs []Variant) (string, error) {
	outlet := seedOutletID
	if outlet == "" {
		if e := t.QueryRow(ctx, `
			SELECT o.id FROM outlets o
			LEFT JOIN (SELECT outlet_id, count(*) n FROM orders WHERE status='completed' GROUP BY outlet_id) oc
			  ON oc.outlet_id=o.id
			WHERE o.is_active
			ORDER BY COALESCE(oc.n,0) DESC, o.created_at ASC LIMIT 1`).Scan(&outlet); e != nil {
			if errors.Is(e, pgx.ErrNoRows) {
				return "", nil // no active outlet to seed
			}
			return "", e
		}
	}
	wrote := false
	for _, v := range vs {
		if v.Stock == 0 {
			continue
		}
		if _, e := t.Exec(ctx, `
			INSERT INTO outlet_variant_stock (outlet_id, product_id, variant_size, stock)
			VALUES ($1,$2,$3,$4)
			ON CONFLICT (outlet_id, product_id, variant_size) DO UPDATE SET stock=EXCLUDED.stock`,
			outlet, productID, v.Size, v.Stock); e != nil {
			return "", e
		}
		wrote = true
	}
	if !wrote {
		return "", nil
	}
	return outlet, nil
}

// UpdateProduct preserves variant identity instead of delete+reinsert: each
// incoming variant is matched to an existing one by id (modal) or SKU (CSV). A
// matched variant is updated in place; if its size changed, its per-outlet and
// warehouse stock/price rows are moved old→new size in the same tx. Unmatched
// incoming = new variant; existing variants not in the payload = removed (with their
// per-outlet and warehouse rows). D13: a rename or removal never moves or destroys
// stock: it is refused (VariantHasStockError, 409) while any row of the old size is
// non-zero.
func (r *Repo) UpdateProduct(ctx context.Context, id string, p Product) error {
	if e := validateVariants(p.Variants); e != nil {
		return e
	}
	return retryBusy(ctx, func() error { return r.updateProduct(ctx, id, p) })
}

// updateProduct is one UpdateProduct attempt (one fresh tx). Its only product-row lock is
// the FOR NO KEY UPDATE of the ERP guard, which the UPDATE right after takes anyway; it
// does not lock the parent against stock writers: a stock row a concurrent receipt adds
// for a removed or renamed size after the guard is only left behind under the old size
// (nothing is destroyed or moved), and a FOR UPDATE would stall every sale of the product
// for the length of an edit. The incoming variants are copied because the ERP guard
// replaces ERP-owned text on linked variants with the stored values.
func (r *Repo) updateProduct(ctx context.Context, id string, p Product) error {
	p.Variants = append([]Variant(nil), p.Variants...)
	return barcodeConflict(r.tx(ctx, "products", func(t pgx.Tx) error {
		if e := guardLinkedProduct(ctx, t, id, &p); e != nil {
			return e
		}
		if e := updateProductRow(ctx, t, id, p); e != nil {
			return e
		}
		byID, bySKU, e := loadExistingVariants(ctx, t, id)
		if e != nil {
			return e
		}
		matched := matchVariants(p.Variants, byID, bySKU)
		if e := guardLinkedVariants(ctx, t, id, p.Variants, matched, byID); e != nil {
			return e
		}
		if e := checkSkusFree(ctx, t, id, existingSKUs(p.Variants, matched, byID), p.Variants); e != nil {
			return e
		}
		if e := lockVariantStock(ctx, t, id, sizesAtRisk(p.Variants, matched, byID)); e != nil {
			return e
		}
		for i, v := range p.Variants {
			vid := matched[i]
			if vid == "" {
				if _, e := t.Exec(ctx,
					`INSERT INTO product_variants (product_id, size, price, sku, barcode) VALUES ($1,$2,$3,$4,$5)`,
					id, v.Size, v.Price, v.SKU, variantBarcode(v)); e != nil {
					return e
				}
				continue
			}
			if _, e := t.Exec(ctx,
				`UPDATE product_variants SET size=$1, price=$2, sku=$3, barcode=$4 WHERE id=$5`,
				v.Size, v.Price, v.SKU, variantBarcode(v), vid); e != nil {
				return e
			}
			if cur := byID[vid]; cur.size != v.Size {
				if e := ensureSizeFree(ctx, t, id, v.Size); e != nil {
					return e
				}
				if e := moveVariantKeys(ctx, t, id, cur.size, v.Size); e != nil {
					return e
				}
			}
		}
		return dropRemovedVariants(ctx, t, id, matched, byID)
	}))
}

func updateProductRow(ctx context.Context, t pgx.Tx, id string, p Product) error {
	imgs, main := productImages(p)
	ct, e := t.Exec(ctx, `
		UPDATE products SET name=$1, brand=$2, category_id=$3, description=$4,
		  image_url=$5, images=$6, sellable=$7,
		  is_featured=$8, is_favourite=$9, is_active=$10
		WHERE id=$11`,
		p.Name, p.Brand, nullUUID(p.CategoryID), nullStr(p.Description),
		nullStr(main), imgs, p.Sellable, p.IsFeatured, p.IsFavourite, p.IsActive, id)
	if e != nil {
		return e
	}
	if ct.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

type existingVariant struct{ size, sku string }

func loadExistingVariants(ctx context.Context, t pgx.Tx, id string) (map[string]existingVariant, map[string]string, error) {
	rows, e := t.Query(ctx, `SELECT id, size, sku FROM product_variants WHERE product_id=$1`, id)
	if e != nil {
		return nil, nil, e
	}
	defer rows.Close()
	byID := map[string]existingVariant{}
	bySKU := map[string]string{}
	for rows.Next() {
		var vid, sz, sku string
		if e := rows.Scan(&vid, &sz, &sku); e != nil {
			return nil, nil, e
		}
		byID[vid] = existingVariant{sz, sku}
		if sku != "" {
			bySKU[sku] = vid
		}
	}
	return byID, bySKU, rows.Err()
}

// matchVariants maps each incoming variant (by index) to the existing variant id it
// updates, by id (modal) or SKU (CSV); "" = a new variant.
func matchVariants(vs []Variant, byID map[string]existingVariant, bySKU map[string]string) []string {
	out := make([]string, len(vs))
	for i, v := range vs {
		vid := v.ID
		if vid == "" {
			vid = bySKU[v.SKU]
		}
		if _, ok := byID[vid]; ok {
			out[i] = vid
		}
	}
	return out
}

// sizesAtRisk lists the OLD sizes whose stock keys a rename would move or a removal
// would delete.
func sizesAtRisk(vs []Variant, matched []string, byID map[string]existingVariant) []string {
	kept := map[string]bool{}
	var sizes []string
	for i, v := range vs {
		if vid := matched[i]; vid != "" {
			kept[vid] = true
			if old := byID[vid].size; old != v.Size {
				sizes = append(sizes, old)
			}
		}
	}
	for vid, cur := range byID {
		if !kept[vid] {
			sizes = append(sizes, cur.size)
		}
	}
	return sizes
}

// moveVariantKeys re-keys a renamed variant's outlet stock, outlet price and warehouse
// stock rows. The pre-lock proved them zero; the RETURNING check keeps that true if a
// writer created a non-zero row since (D13).
func moveVariantKeys(ctx context.Context, t pgx.Tx, productID, from, to string) error {
	// D13 guarded zero-stock move (RETURNING check), not a quantity change.
	if e := guardedZeroWrite(ctx, t, "outlet", `
		UPDATE outlet_variant_stock SET variant_size=$1 WHERE product_id=$2 AND variant_size=$3
		RETURNING outlet_id::text, $3::text, stock`, to, productID, from); e != nil {
		return e
	}
	if _, e := t.Exec(ctx,
		`UPDATE outlet_variant_price SET variant_size=$1 WHERE product_id=$2 AND variant_size=$3`,
		to, productID, from); e != nil {
		return e
	}
	return guardedZeroWrite(ctx, t, "warehouse", `
		UPDATE warehouse_variant_stock SET variant_size=$1 WHERE product_id=$2 AND variant_size=$3
		RETURNING warehouse_id::text, $3::text, stock`, to, productID, from)
}

// dropRemovedVariants deletes the variants missing from the payload together with
// their outlet and warehouse stock rows and outlet price rows.
func dropRemovedVariants(ctx context.Context, t pgx.Tx, id string, matched []string, byID map[string]existingVariant) error {
	kept := map[string]bool{}
	for _, vid := range matched {
		if vid != "" {
			kept[vid] = true
		}
	}
	for vid, cur := range byID {
		if kept[vid] {
			continue
		}
		if _, e := t.Exec(ctx, `DELETE FROM product_variants WHERE id=$1`, vid); e != nil {
			return e
		}
		// D13 guarded zero-stock delete (RETURNING check), not a quantity change.
		if e := guardedZeroWrite(ctx, t, "outlet", `
			DELETE FROM outlet_variant_stock WHERE product_id=$1 AND variant_size=$2
			RETURNING outlet_id::text, variant_size, stock`, id, cur.size); e != nil {
			return e
		}
		if _, e := t.Exec(ctx, `DELETE FROM outlet_variant_price WHERE product_id=$1 AND variant_size=$2`, id, cur.size); e != nil {
			return e
		}
		if e := guardedZeroWrite(ctx, t, "warehouse", `
			DELETE FROM warehouse_variant_stock WHERE product_id=$1 AND variant_size=$2
			RETURNING warehouse_id::text, variant_size, stock`, id, cur.size); e != nil {
			return e
		}
	}
	return nil
}

func insertVariants(ctx context.Context, t pgx.Tx, productID string, vs []Variant) error {
	for _, v := range vs {
		if _, e := t.Exec(ctx, `
			INSERT INTO product_variants (product_id, size, price, sku, barcode)
			VALUES ($1,$2,$3,$4,$5)`,
			productID, v.Size, v.Price, v.SKU, variantBarcode(v)); e != nil {
			return e
		}
	}
	return nil
}

// DeleteProduct (D13): refused while any outlet or warehouse stock row of the product is
// non-zero (ProductHasStockError), and then while any receipt, adjustment or transfer line names it
// (ErrProductHasHistory: those keep a foreign key to products; deactivate instead). The
// product row is locked first (see lockProductRow) so every stock row a concurrent
// writer created is committed and visible; the zero rows are then deleted
// explicitly, with a RETURNING check, BEFORE the product delete, so the FK CASCADE finds
// no non-zero row to remove.
func (r *Repo) DeleteProduct(ctx context.Context, id string) error {
	return retryBusy(ctx, func() error { return r.deleteProduct(ctx, id) })
}

func (r *Repo) deleteProduct(ctx context.Context, id string) error {
	return r.tx(ctx, "products", func(t pgx.Tx) error {
		if e := lockProductRow(ctx, t, id); e != nil {
			return e
		}
		if e := guardLinkedProductDelete(ctx, t, id); e != nil {
			return e
		}
		if e := lockProductStock(ctx, t, id); e != nil {
			return productStockRefusal(e)
		}
		// D13 guarded zero-stock delete (RETURNING check), not a quantity change.
		if e := guardedZeroWrite(ctx, t, "outlet", `
			DELETE FROM outlet_variant_stock WHERE product_id=$1
			RETURNING outlet_id::text, variant_size, stock`, id); e != nil {
			return productStockRefusal(e)
		}
		if e := guardedZeroWrite(ctx, t, "warehouse", `
			DELETE FROM warehouse_variant_stock WHERE product_id=$1
			RETURNING warehouse_id::text, variant_size, stock`, id); e != nil {
			return productStockRefusal(e)
		}
		// After the stock guard, so a stocked product is still refused for its stock first.
		if e := guardProductHistory(ctx, t, id); e != nil {
			return e
		}
		ct, e := t.Exec(ctx, `DELETE FROM products WHERE id=$1`, id)
		if e == nil && ct.RowsAffected() == 0 {
			return ErrNotFound
		}
		var pg *pgconn.PgError
		if errors.As(e, &pg) && pg.Code == "23503" {
			// Backstop: a referencing table guardProductHistory does not list. Logged so a
			// new foreign key shows up; the PgError is not wrapped (it would turn the 409
			// into the generic conflict text).
			slog.Warn("product delete blocked by an unlisted foreign key", "constraint", pg.ConstraintName, "table", pg.TableName)
			return ErrProductHasHistory
		}
		return e
	})
}

// SetProductOutletConfig applies the per-outlet price/availability matrix for one
// product in a single tx, then bumps only the affected outlets' content version.
// A null price clears the override (falls back to base). Stock + par_level are
// owned by the Inventori module and are never touched here.
func (r *Repo) SetProductOutletConfig(ctx context.Context, productID string, items []api.OutletConfigItemInput) error {
	return retryBusy(ctx, func() error { return r.setProductOutletConfig(ctx, productID, items) })
}

func (r *Repo) setProductOutletConfig(ctx context.Context, productID string, items []api.OutletConfigItemInput) error {
	t, err := r.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer t.Rollback(ctx)

	// Upsert in (outlet, size) order so concurrent writers (and the CSV import's rename)
	// take the per-outlet rows in one consistent order.
	items = append([]api.OutletConfigItemInput(nil), items...)
	sort.SliceStable(items, func(i, j int) bool {
		if a, b := items[i].OutletId.String(), items[j].OutletId.String(); a != b {
			return a < b
		}
		return items[i].VariantSize < items[j].VariantSize
	})

	seen := map[string]bool{}
	var outletIDs []string
	for _, it := range items {
		oid := it.OutletId.String()
		if !seen[oid] {
			seen[oid] = true
			outletIDs = append(outletIDs, oid)
		}
		// availability only — stock + par_level are owned by Inventori now.
		if _, e := t.Exec(ctx, `
			INSERT INTO outlet_variant_stock (outlet_id, product_id, variant_size, available)
			VALUES ($1,$2,$3,$4)
			ON CONFLICT (outlet_id, product_id, variant_size)
			  DO UPDATE SET available=EXCLUDED.available`,
			oid, productID, it.VariantSize, it.Available); e != nil {
			return e
		}
		if v, e := it.Price.Get(); e == nil {
			if _, e := t.Exec(ctx, `
				INSERT INTO outlet_variant_price (outlet_id, product_id, variant_size, price)
				VALUES ($1,$2,$3,$4)
				ON CONFLICT (outlet_id, product_id, variant_size) DO UPDATE SET price=EXCLUDED.price`,
				oid, productID, it.VariantSize, v); e != nil {
				return e
			}
		} else if _, e := t.Exec(ctx, `
			DELETE FROM outlet_variant_price
			WHERE outlet_id=$1 AND product_id=$2 AND variant_size=$3`,
			oid, productID, it.VariantSize); e != nil {
			return e
		}
	}
	// Clean up rows for sizes that are not in the payload. A stock row goes only when the
	// size has no variant any more AND the row is empty (D13): a partial payload must not
	// delete the live stock row of a variant that merely was not listed.
	sizes := make([]string, 0, len(items))
	seenSize := map[string]bool{}
	for _, it := range items {
		if !seenSize[it.VariantSize] {
			seenSize[it.VariantSize] = true
			sizes = append(sizes, it.VariantSize)
		}
	}
	if _, e := t.Exec(ctx,
		`DELETE FROM outlet_variant_stock s WHERE s.product_id=$1 AND s.variant_size <> ALL($2::text[])
		   AND s.stock = 0
		   AND NOT EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = s.product_id AND v.size = s.variant_size)`,
		productID, sizes); e != nil {
		return e
	}
	if _, e := t.Exec(ctx,
		`DELETE FROM outlet_variant_price WHERE product_id=$1 AND variant_size <> ALL($2::text[])`,
		productID, sizes); e != nil {
		return e
	}
	if e := bumpVersionOutlets(ctx, t, "products", outletIDs); e != nil {
		return fmt.Errorf("bump version: %w", e)
	}
	return t.Commit(ctx)
}

type Category struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	SortOrder   *int   `json:"sortOrder"`
}

func (r *Repo) CreateCategory(ctx context.Context, c Category) (string, error) {
	var id string
	err := r.tx(ctx, "categories", func(t pgx.Tx) error {
		return t.QueryRow(ctx,
			`INSERT INTO categories (name, description, sort_order)
			 VALUES ($1,$2,$3) RETURNING id`,
			c.Name, nullStr(c.Description), c.SortOrder).Scan(&id)
	})
	return id, err
}

func (r *Repo) UpdateCategory(ctx context.Context, id string, c Category) error {
	return r.tx(ctx, "categories", func(t pgx.Tx) error {
		ct, e := t.Exec(ctx,
			`UPDATE categories SET name=$1, description=$2, sort_order=$3 WHERE id=$4`,
			c.Name, nullStr(c.Description), c.SortOrder, id)
		if e == nil && ct.RowsAffected() == 0 {
			return ErrNotFound
		}
		return e
	})
}

func (r *Repo) DeleteCategory(ctx context.Context, id string) error {
	return r.delete(ctx, "categories", "categories", id)
}

// barcodeConflict maps the catalog-wide barcode unique-violation to a friendly,
// non-leaky message naming the offending code (best-effort parse of pg Detail).
func barcodeConflict(err error) error {
	var pg *pgconn.PgError
	if errors.As(err, &pg) && pg.Code == "23505" && pg.ConstraintName == "idx_variant_barcode" {
		code := ""
		if i := strings.Index(pg.Detail, "=("); i >= 0 {
			if j := strings.Index(pg.Detail[i+2:], ")"); j >= 0 {
				code = pg.Detail[i+2 : i+2+j]
			}
		}
		if code != "" {
			return fmt.Errorf("barcode sudah dipakai varian lain: %s", code)
		}
		return fmt.Errorf("barcode sudah dipakai varian lain")
	}
	return err
}
