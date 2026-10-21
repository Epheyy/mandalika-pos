package write

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/mandalika/pos-backend/internal/api"
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
	var id string
	err := r.txStock(ctx, "products", func(t pgx.Tx) ([]string, error) {
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
// oldest active). Variants with 0 are skipped; other outlets start empty. It returns
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
// matched variant is updated in place; if its size changed, its per-outlet
// stock/price rows are moved old→new size in the same tx (so stock follows a
// rename via any caller). Unmatched incoming = new variant; existing variants not
// in the payload = removed (with their per-outlet rows).
func (r *Repo) UpdateProduct(ctx context.Context, id string, p Product) error {
	if e := validateVariants(p.Variants); e != nil {
		return e
	}
	return barcodeConflict(r.tx(ctx, "products", func(t pgx.Tx) error {
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

		rows, e := t.Query(ctx, `SELECT id, size, sku FROM product_variants WHERE product_id=$1`, id)
		if e != nil {
			return e
		}
		type ex struct{ size, sku string }
		byID := map[string]ex{}
		bySKU := map[string]string{}
		for rows.Next() {
			var vid, sz, sku string
			if e := rows.Scan(&vid, &sz, &sku); e != nil {
				rows.Close()
				return e
			}
			byID[vid] = ex{sz, sku}
			if sku != "" {
				bySKU[sku] = vid
			}
		}
		rows.Close()

		kept := map[string]bool{}
		for _, v := range p.Variants {
			vid := v.ID
			if vid == "" {
				vid = bySKU[v.SKU] // CSV path: correlate by SKU
			}
			if cur, ok := byID[vid]; ok {
				if _, e := t.Exec(ctx,
					`UPDATE product_variants SET size=$1, price=$2, stock=$3, sku=$4, barcode=$5 WHERE id=$6`,
					v.Size, v.Price, v.Stock, v.SKU, variantBarcode(v), vid); e != nil {
					return e
				}
				if cur.size != v.Size {
					if _, e := t.Exec(ctx,
						`UPDATE outlet_variant_stock SET variant_size=$1 WHERE product_id=$2 AND variant_size=$3`,
						v.Size, id, cur.size); e != nil {
						return e
					}
					if _, e := t.Exec(ctx,
						`UPDATE outlet_variant_price SET variant_size=$1 WHERE product_id=$2 AND variant_size=$3`,
						v.Size, id, cur.size); e != nil {
						return e
					}
				}
				kept[vid] = true
				continue
			}
			if _, e := t.Exec(ctx,
				`INSERT INTO product_variants (product_id, size, price, stock, sku, barcode) VALUES ($1,$2,$3,$4,$5,$6)`,
				id, v.Size, v.Price, v.Stock, v.SKU, variantBarcode(v)); e != nil {
				return e
			}
		}
		for vid, cur := range byID {
			if kept[vid] {
				continue
			}
			if _, e := t.Exec(ctx, `DELETE FROM product_variants WHERE id=$1`, vid); e != nil {
				return e
			}
			if _, e := t.Exec(ctx, `DELETE FROM outlet_variant_stock WHERE product_id=$1 AND variant_size=$2`, id, cur.size); e != nil {
				return e
			}
			if _, e := t.Exec(ctx, `DELETE FROM outlet_variant_price WHERE product_id=$1 AND variant_size=$2`, id, cur.size); e != nil {
				return e
			}
		}
		return nil
	}))
}

func insertVariants(ctx context.Context, t pgx.Tx, productID string, vs []Variant) error {
	for _, v := range vs {
		if _, e := t.Exec(ctx, `
			INSERT INTO product_variants (product_id, size, price, stock, sku, barcode)
			VALUES ($1,$2,$3,$4,$5,$6)`,
			productID, v.Size, v.Price, v.Stock, v.SKU, variantBarcode(v)); e != nil {
			return e
		}
	}
	return nil
}

func (r *Repo) DeleteProduct(ctx context.Context, id string) error {
	return r.delete(ctx, "products", "products", id)
}

// SetProductOutletConfig applies the per-outlet price/availability matrix for one
// product in a single tx, then bumps only the affected outlets' content version.
// A null price clears the override (falls back to base). Stock + par_level are
// owned by the Inventori module and are never touched here.
func (r *Repo) SetProductOutletConfig(ctx context.Context, productID string, items []api.OutletConfigItemInput) error {
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
	// Clean up rows for variant sizes that no longer exist (renamed or removed),
	// so a renamed variant doesn't leave orphaned stock + price rows behind.
	sizes := make([]string, 0, len(items))
	seenSize := map[string]bool{}
	for _, it := range items {
		if !seenSize[it.VariantSize] {
			seenSize[it.VariantSize] = true
			sizes = append(sizes, it.VariantSize)
		}
	}
	if _, e := t.Exec(ctx,
		`DELETE FROM outlet_variant_stock WHERE product_id=$1 AND variant_size <> ALL($2::text[])`,
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
