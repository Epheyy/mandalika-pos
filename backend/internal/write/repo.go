// Package write holds the reference-data CRUD (Backoffice-only). Every mutation
// bumps the per-outlet content_version so POS raises its sync wall (plan §5a).
package write

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mandalika/pos-backend/internal/api"
)

var ErrNotFound = errors.New("not found")

type Repo struct{ Pool *pgxpool.Pool }

func New(p *pgxpool.Pool) *Repo { return &Repo{Pool: p} }

// BumpContentVersion increments every outlet's content_version and stamps a
// manifest entry for the changed resource (plan §5a). Reference data is global,
// so all outlets must resync. Run inside the caller's tx.
func bumpVersion(ctx context.Context, q pgx.Tx, resource string) error {
	_, err := q.Exec(ctx, `
		INSERT INTO content_versions (outlet_id, version, data_manifest, updated_at)
		SELECT id, 2,
		       jsonb_build_object($1::text, 1), now()
		  FROM outlets
		ON CONFLICT (outlet_id) DO UPDATE SET
		  version = content_versions.version + 1,
		  data_manifest = content_versions.data_manifest ||
		    jsonb_build_object($1::text,
		      COALESCE((content_versions.data_manifest->>$1)::int,0) + 1),
		  updated_at = now()`, resource)
	return err
}

// bumpVersionOutlets bumps the content version for only the given outlets — used
// for per-outlet writes (e.g. outlet-config) so a change at one outlet doesn't
// force every outlet to resync. Run inside the caller's tx.
func bumpVersionOutlets(ctx context.Context, q pgx.Tx, resource string, outletIDs []string) error {
	for _, oid := range outletIDs {
		if _, err := q.Exec(ctx, `
			INSERT INTO content_versions (outlet_id, version, data_manifest, updated_at)
			VALUES ($2, 2, jsonb_build_object($1::text,1), now())
			ON CONFLICT (outlet_id) DO UPDATE SET
			  version = content_versions.version + 1,
			  data_manifest = content_versions.data_manifest ||
			    jsonb_build_object($1::text, COALESCE((content_versions.data_manifest->>$1)::int,0)+1),
			  updated_at = now()`, resource, oid); err != nil {
			return err
		}
	}
	return nil
}

// tx runs fn in a transaction, bumping the content version for resource.
func (r *Repo) tx(ctx context.Context, resource string, fn func(pgx.Tx) error) error {
	t, err := r.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer t.Rollback(ctx)
	if err := fn(t); err != nil {
		return err
	}
	if err := bumpVersion(ctx, t, resource); err != nil {
		return fmt.Errorf("bump version: %w", err)
	}
	return t.Commit(ctx)
}

func jsonb(v any) ([]byte, error) {
	if v == nil {
		return []byte("null"), nil
	}
	return json.Marshal(v)
}

// ── Products (+ variants child table) ─────────────────────

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
	err := r.tx(ctx, "products", func(t pgx.Tx) error {
		imgs, main := productImages(p)
		if e := t.QueryRow(ctx, `
			INSERT INTO products (name, brand, category_id, description, image_url,
			  images, sellable, is_featured, is_favourite, is_active)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
			p.Name, p.Brand, nullUUID(p.CategoryID), nullStr(p.Description),
			nullStr(main), imgs, p.Sellable, p.IsFeatured, p.IsFavourite, p.IsActive).
			Scan(&id); e != nil {
			return e
		}
		if e := insertVariants(ctx, t, id, p.Variants); e != nil {
			return e
		}
		return seedOutletStock(ctx, t, id, seedOutletID, p.Variants)
	})
	return id, barcodeConflict(err)
}

// seedOutletStock writes a new product's initial per-variant stock to one outlet:
// seedOutletID when set, else the primary outlet (most completed orders, tie-break
// oldest active). Variants with 0 are skipped; other outlets start empty.
func seedOutletStock(ctx context.Context, t pgx.Tx, productID, seedOutletID string, vs []Variant) error {
	outlet := seedOutletID
	if outlet == "" {
		if e := t.QueryRow(ctx, `
			SELECT o.id FROM outlets o
			LEFT JOIN (SELECT outlet_id, count(*) n FROM orders WHERE status='completed' GROUP BY outlet_id) oc
			  ON oc.outlet_id=o.id
			WHERE o.is_active
			ORDER BY COALESCE(oc.n,0) DESC, o.created_at ASC LIMIT 1`).Scan(&outlet); e != nil {
			if errors.Is(e, pgx.ErrNoRows) {
				return nil // no active outlet to seed
			}
			return e
		}
	}
	for _, v := range vs {
		if v.Stock == 0 {
			continue
		}
		if _, e := t.Exec(ctx, `
			INSERT INTO outlet_variant_stock (outlet_id, product_id, variant_size, stock)
			VALUES ($1,$2,$3,$4)
			ON CONFLICT (outlet_id, product_id, variant_size) DO UPDATE SET stock=EXCLUDED.stock`,
			outlet, productID, v.Size, v.Stock); e != nil {
			return e
		}
	}
	return nil
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

// SetProductOutletConfig applies the per-outlet stock/price/availability matrix
// for one product in a single tx, then bumps only the affected outlets' content
// version. A null price clears the override (falls back to base). Availability is
// per-variant (stored on outlet_variant_stock).
func (r *Repo) SetProductOutletConfig(ctx context.Context, productID string, items []api.OutletVariantConfig) error {
	t, err := r.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer t.Rollback(ctx)

	seen := map[string]bool{}
	var outletIDs []string
	for _, it := range items {
		oid := it.OutletId.String()
		if !seen[oid] {
			seen[oid] = true
			outletIDs = append(outletIDs, oid)
		}
		var par any
		if v, e := it.ParLevel.Get(); e == nil {
			par = v
		}
		if _, e := t.Exec(ctx, `
			INSERT INTO outlet_variant_stock (outlet_id, product_id, variant_size, stock, available, par_level)
			VALUES ($1,$2,$3,$4,$5,$6)
			ON CONFLICT (outlet_id, product_id, variant_size)
			  DO UPDATE SET stock=EXCLUDED.stock, available=EXCLUDED.available, par_level=EXCLUDED.par_level`,
			oid, productID, it.VariantSize, it.Stock, it.Available, par); e != nil {
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
	// so a renamed variant doesn't leave orphaned stock behind.
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

// ── Categories ────────────────────────────────────────────

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

// ── Customers ─────────────────────────────────────────────

type Customer struct {
	Name  string `json:"name"`
	Phone string `json:"phone"`
	Email string `json:"email"`
}

func (r *Repo) CreateCustomer(ctx context.Context, c Customer) (string, error) {
	var id string
	err := r.tx(ctx, "customers", func(t pgx.Tx) error {
		return t.QueryRow(ctx,
			`INSERT INTO customers (name, phone, email) VALUES ($1,$2,$3) RETURNING id`,
			c.Name, c.Phone, nullStr(c.Email)).Scan(&id)
	})
	return id, err
}

func (r *Repo) UpdateCustomer(ctx context.Context, id string, c Customer) error {
	return r.tx(ctx, "customers", func(t pgx.Tx) error {
		ct, e := t.Exec(ctx,
			`UPDATE customers SET name=$1, phone=$2, email=$3 WHERE id=$4`,
			c.Name, c.Phone, nullStr(c.Email), id)
		if e == nil && ct.RowsAffected() == 0 {
			return ErrNotFound
		}
		return e
	})
}

func (r *Repo) DeleteCustomer(ctx context.Context, id string) error {
	return r.delete(ctx, "customers", "customers", id)
}

// ── Promotions ────────────────────────────────────────────

type Promotion struct {
	Name                   string   `json:"name"`
	Description            string   `json:"description"`
	Type                   string   `json:"type"`
	Value                  float64  `json:"value"`
	MinPurchase            *float64 `json:"minPurchase"`
	ApplicableProductIDs   []string `json:"applicableProductIds"`
	ApplicableVariantKeys  []string `json:"applicableVariantKeys"`
	ApplicableVariantSizes []string `json:"applicableVariantSizes"`
	OutletIDs              []string `json:"outletIds"`
	Combinable             *bool    `json:"combinable"`
	CombinableWith         []string `json:"combinableWith"`
	ActiveFromHour         string   `json:"activeFromHour"`
	ActiveToHour           string   `json:"activeToHour"`
	ActiveDays             []int    `json:"activeDays"`
	IsActive               bool     `json:"isActive"`
	StartDate              string   `json:"startDate"`
	EndDate                string   `json:"endDate"`
}

func (r *Repo) CreatePromotion(ctx context.Context, p Promotion) (string, error) {
	var id string
	err := r.tx(ctx, "promotions", func(t pgx.Tx) error {
		apid, _ := jsonb(p.ApplicableProductIDs)
		avk, _ := jsonb(p.ApplicableVariantKeys)
		avs, _ := jsonb(p.ApplicableVariantSizes)
		oid, _ := jsonb(p.OutletIDs)
		cw, _ := jsonb(p.CombinableWith)
		ad, _ := jsonb(p.ActiveDays)
		return t.QueryRow(ctx, `
			INSERT INTO promotions (name, description, type, value, min_purchase,
			  applicable_product_ids, applicable_variant_keys,
			  applicable_variant_sizes, outlet_ids, combinable, combinable_with,
			  active_from_hour, active_to_hour, active_days, is_active,
			  start_date, end_date)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
			RETURNING id`,
			p.Name, nullStr(p.Description), p.Type, p.Value, p.MinPurchase,
			apid, avk, avs, oid, p.Combinable, cw,
			nullStr(p.ActiveFromHour), nullStr(p.ActiveToHour), ad, p.IsActive,
			nullDate(p.StartDate), nullDate(p.EndDate)).Scan(&id)
	})
	return id, err
}

func (r *Repo) UpdatePromotion(ctx context.Context, id string, p Promotion) error {
	return r.tx(ctx, "promotions", func(t pgx.Tx) error {
		apid, _ := jsonb(p.ApplicableProductIDs)
		avk, _ := jsonb(p.ApplicableVariantKeys)
		avs, _ := jsonb(p.ApplicableVariantSizes)
		oid, _ := jsonb(p.OutletIDs)
		cw, _ := jsonb(p.CombinableWith)
		ad, _ := jsonb(p.ActiveDays)
		ct, e := t.Exec(ctx, `
			UPDATE promotions SET name=$1, description=$2, type=$3, value=$4,
			  min_purchase=$5, applicable_product_ids=$6, applicable_variant_keys=$7,
			  applicable_variant_sizes=$8, outlet_ids=$9, combinable=$10,
			  combinable_with=$11, active_from_hour=$12, active_to_hour=$13,
			  active_days=$14, is_active=$15, start_date=$16, end_date=$17
			WHERE id=$18`,
			p.Name, nullStr(p.Description), p.Type, p.Value, p.MinPurchase,
			apid, avk, avs, oid, p.Combinable, cw,
			nullStr(p.ActiveFromHour), nullStr(p.ActiveToHour), ad, p.IsActive,
			nullDate(p.StartDate), nullDate(p.EndDate), id)
		if e == nil && ct.RowsAffected() == 0 {
			return ErrNotFound
		}
		return e
	})
}

func (r *Repo) DeletePromotion(ctx context.Context, id string) error {
	return r.delete(ctx, "promotions", "promotions", id)
}

// ── Discount codes ────────────────────────────────────────

type DiscountCode struct {
	Code        string   `json:"code"`
	PromotionID string   `json:"promotionId"`
	Type        string   `json:"type"`
	Value       float64  `json:"value"`
	MinPurchase *float64 `json:"minPurchase"`
	UsageLimit  *int     `json:"usageLimit"`
	IsActive    bool     `json:"isActive"`
	StartDate   string   `json:"startDate"`
	EndDate     string   `json:"endDate"`
}

func (r *Repo) CreateDiscountCode(ctx context.Context, d DiscountCode) (string, error) {
	var id string
	err := r.tx(ctx, "discountCodes", func(t pgx.Tx) error {
		return t.QueryRow(ctx, `
			INSERT INTO discount_codes (code, promotion_id, type, value,
			  min_purchase, usage_limit, is_active, start_date, end_date)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
			d.Code, nullUUID(d.PromotionID), d.Type, d.Value, d.MinPurchase,
			d.UsageLimit, d.IsActive, nullDate(d.StartDate), nullDate(d.EndDate)).
			Scan(&id)
	})
	return id, err
}

func (r *Repo) UpdateDiscountCode(ctx context.Context, id string, d DiscountCode) error {
	return r.tx(ctx, "discountCodes", func(t pgx.Tx) error {
		ct, e := t.Exec(ctx, `
			UPDATE discount_codes SET code=$1, promotion_id=$2, type=$3, value=$4,
			  min_purchase=$5, usage_limit=$6, is_active=$7, start_date=$8,
			  end_date=$9 WHERE id=$10`,
			d.Code, nullUUID(d.PromotionID), d.Type, d.Value, d.MinPurchase,
			d.UsageLimit, d.IsActive, nullDate(d.StartDate), nullDate(d.EndDate), id)
		if e == nil && ct.RowsAffected() == 0 {
			return ErrNotFound
		}
		return e
	})
}

func (r *Repo) DeleteDiscountCode(ctx context.Context, id string) error {
	return r.delete(ctx, "discountCodes", "discount_codes", id)
}

// ── Outlets ───────────────────────────────────────────────

type Outlet struct {
	Name     string `json:"name"`
	Code     string `json:"code"`
	Address  string `json:"address"`
	Phone    string `json:"phone"`
	IsActive bool   `json:"isActive"`
}

func (r *Repo) CreateOutlet(ctx context.Context, o Outlet) (string, error) {
	var id string
	err := r.tx(ctx, "outlets", func(t pgx.Tx) error {
		if e := t.QueryRow(ctx,
			`INSERT INTO outlets (name, code, address, phone, is_active)
			 VALUES ($1,$2,$3,$4,$5) RETURNING id`,
			o.Name, nullStr(o.Code), nullStr(o.Address), nullStr(o.Phone), o.IsActive).
			Scan(&id); e != nil {
			return e
		}
		// Seed a content_versions row so the new outlet has a baseline.
		_, e := t.Exec(ctx,
			`INSERT INTO content_versions (outlet_id) VALUES ($1)
			 ON CONFLICT DO NOTHING`, id)
		return e
	})
	return id, err
}

func (r *Repo) UpdateOutlet(ctx context.Context, id string, o Outlet) error {
	return r.tx(ctx, "outlets", func(t pgx.Tx) error {
		ct, e := t.Exec(ctx,
			`UPDATE outlets SET name=$1, code=$2, address=$3, phone=$4, is_active=$5 WHERE id=$6`,
			o.Name, nullStr(o.Code), nullStr(o.Address), nullStr(o.Phone), o.IsActive, id)
		if e == nil && ct.RowsAffected() == 0 {
			return ErrNotFound
		}
		return e
	})
}

// ── Settings (singletons) ─────────────────────────────────

func (r *Repo) UpdateAppSettings(ctx context.Context, raw json.RawMessage) error {
	var s struct {
		TaxEnabled           bool                  `json:"taxEnabled"`
		TaxRate              float64               `json:"taxRate"`
		RoundingEnabled      bool                  `json:"roundingEnabled"`
		RoundingType         string                `json:"roundingType"`
		RoundingAmount       *float64              `json:"roundingAmount"`
		RoundingDirection    *string               `json:"roundingDirection"`
		RoundingApplyToTax   *bool                 `json:"roundingApplyToTax"`
		AutoOpenShift        bool                  `json:"autoOpenShift"`
		PaymentMethods       json.RawMessage       `json:"paymentMethods"`
		Receipt              json.RawMessage       `json:"receipt"`
		ReceiveApproverRoles []string              `json:"receiveApproverRoles"`
		Documents            *api.DocumentSettings `json:"documents"`
	}
	if err := json.Unmarshal(raw, &s); err != nil {
		return err
	}
	if len(s.PaymentMethods) == 0 {
		s.PaymentMethods = json.RawMessage("[]")
	}
	if len(s.Receipt) == 0 {
		s.Receipt = json.RawMessage("{}")
	}
	if s.ReceiveApproverRoles == nil {
		s.ReceiveApproverRoles = []string{}
	}

	return r.tx(ctx, "appSettings", func(t pgx.Tx) error {
		_, e := t.Exec(ctx, `
			UPDATE app_settings SET tax_enabled=$1, tax_rate=$2,
			  rounding_enabled=$3, rounding_type=$4, rounding_amount=$5,
			  rounding_direction=$6, rounding_apply_to_tax=$7, auto_open_shift=$8,
			  payment_methods=$9, receipt=$10, receive_approver_roles=$11 WHERE id=1`,
			s.TaxEnabled, s.TaxRate, s.RoundingEnabled, s.RoundingType,
			s.RoundingAmount, s.RoundingDirection, s.RoundingApplyToTax,
			s.AutoOpenShift, []byte(s.PaymentMethods), []byte(s.Receipt),
			s.ReceiveApproverRoles)
		if e != nil {
			return e
		}
		// Only write documents columns when the block is present in the request.
		// Absent documents block → leave existing DB values untouched.
		// Present but null/unspecified individual fields → set to SQL NULL (clear).
		if d := s.Documents; d != nil {
			var docLogoURL, docBrandName, docAddressLines, docPhone, docNPWP *string
			if v, err := d.LogoUrl.Get(); err == nil {
				docLogoURL = &v
			}
			if v, err := d.BrandName.Get(); err == nil {
				docBrandName = &v
			}
			if v, err := d.AddressLines.Get(); err == nil {
				docAddressLines = &v
			}
			if v, err := d.Phone.Get(); err == nil {
				docPhone = &v
			}
			if v, err := d.Npwp.Get(); err == nil {
				docNPWP = &v
			}
			if _, e := t.Exec(ctx, `
				UPDATE app_settings SET
				  documents_logo_url=$1, documents_brand_name=$2,
				  documents_address_lines=$3, documents_phone=$4,
				  documents_npwp=$5 WHERE id=1`,
				docLogoURL, docBrandName, docAddressLines, docPhone, docNPWP); e != nil {
				return fmt.Errorf("update documents: %w", e)
			}
		}
		return e
	})
}

func (r *Repo) UpdateLoyaltySettings(ctx context.Context, raw json.RawMessage) error {
	var s struct {
		Enabled        bool    `json:"enabled"`
		TierEnabled    bool    `json:"tierEnabled"`
		PointsPerK     float64 `json:"pointsPerThousand"`
		RedemptionRate float64 `json:"redemptionRate"`
	}
	if err := json.Unmarshal(raw, &s); err != nil {
		return err
	}
	return r.tx(ctx, "loyaltySettings", func(t pgx.Tx) error {
		_, e := t.Exec(ctx, `
			UPDATE loyalty_settings SET enabled=$1, tier_enabled=$2,
			  points_per_thousand=$3, redemption_rate=$4 WHERE id=1`,
			s.Enabled, s.TierEnabled, s.PointsPerK, s.RedemptionRate)
		return e
	})
}

// ── shared helpers ────────────────────────────────────────

func (r *Repo) delete(ctx context.Context, resource, table, id string) error {
	return r.tx(ctx, resource, func(t pgx.Tx) error {
		ct, e := t.Exec(ctx, `DELETE FROM `+table+` WHERE id=$1`, id)
		if e == nil && ct.RowsAffected() == 0 {
			return ErrNotFound
		}
		return e
	})
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

func nullStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func nullUUID(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func nullDate(s string) any {
	if s == "" {
		return nil
	}
	return s
}
