// Package write holds the reference-data CRUD (Backoffice-only). Every mutation
// bumps the per-outlet content_version so POS raises its sync wall (plan §5a).
package write

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
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
	Size  string  `json:"size"`
	Price float64 `json:"price"`
	Stock int     `json:"stock"`
	SKU   string  `json:"sku"`
}

type Product struct {
	Name        string    `json:"name"`
	Brand       string    `json:"brand"`
	CategoryID  string    `json:"categoryId"`
	Description string    `json:"description"`
	ImageURL    string    `json:"imageUrl"`
	Variants    []Variant `json:"variants"`
	IsFeatured  bool      `json:"isFeatured"`
	IsFavourite bool      `json:"isFavourite"`
	IsActive    bool      `json:"isActive"`
}

func (r *Repo) CreateProduct(ctx context.Context, p Product) (string, error) {
	var id string
	err := r.tx(ctx, "products", func(t pgx.Tx) error {
		if e := t.QueryRow(ctx, `
			INSERT INTO products (name, brand, category_id, description, image_url,
			  is_featured, is_favourite, is_active)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
			p.Name, p.Brand, nullUUID(p.CategoryID), nullStr(p.Description),
			nullStr(p.ImageURL), p.IsFeatured, p.IsFavourite, p.IsActive).
			Scan(&id); e != nil {
			return e
		}
		return insertVariants(ctx, t, id, p.Variants)
	})
	return id, err
}

func (r *Repo) UpdateProduct(ctx context.Context, id string, p Product) error {
	return r.tx(ctx, "products", func(t pgx.Tx) error {
		ct, e := t.Exec(ctx, `
			UPDATE products SET name=$1, brand=$2, category_id=$3, description=$4,
			  image_url=$5, is_featured=$6, is_favourite=$7, is_active=$8
			WHERE id=$9`,
			p.Name, p.Brand, nullUUID(p.CategoryID), nullStr(p.Description),
			nullStr(p.ImageURL), p.IsFeatured, p.IsFavourite, p.IsActive, id)
		if e != nil {
			return e
		}
		if ct.RowsAffected() == 0 {
			return ErrNotFound
		}
		if _, e := t.Exec(ctx, `DELETE FROM product_variants WHERE product_id=$1`, id); e != nil {
			return e
		}
		return insertVariants(ctx, t, id, p.Variants)
	})
}

func insertVariants(ctx context.Context, t pgx.Tx, productID string, vs []Variant) error {
	for _, v := range vs {
		if _, e := t.Exec(ctx, `
			INSERT INTO product_variants (product_id, size, price, stock, sku)
			VALUES ($1,$2,$3,$4,$5)`,
			productID, v.Size, v.Price, v.Stock, v.SKU); e != nil {
			return e
		}
	}
	return nil
}

func (r *Repo) DeleteProduct(ctx context.Context, id string) error {
	return r.delete(ctx, "products", "products", id)
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
		TaxEnabled         bool            `json:"taxEnabled"`
		TaxRate            float64         `json:"taxRate"`
		RoundingEnabled    bool            `json:"roundingEnabled"`
		RoundingType       string          `json:"roundingType"`
		RoundingAmount     *float64        `json:"roundingAmount"`
		RoundingDirection  *string         `json:"roundingDirection"`
		RoundingApplyToTax *bool           `json:"roundingApplyToTax"`
		AutoOpenShift      bool            `json:"autoOpenShift"`
		PaymentMethods     json.RawMessage `json:"paymentMethods"`
		Receipt            json.RawMessage `json:"receipt"`
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
	return r.tx(ctx, "appSettings", func(t pgx.Tx) error {
		_, e := t.Exec(ctx, `
			UPDATE app_settings SET tax_enabled=$1, tax_rate=$2,
			  rounding_enabled=$3, rounding_type=$4, rounding_amount=$5,
			  rounding_direction=$6, rounding_apply_to_tax=$7, auto_open_shift=$8,
			  payment_methods=$9, receipt=$10 WHERE id=1`,
			s.TaxEnabled, s.TaxRate, s.RoundingEnabled, s.RoundingType,
			s.RoundingAmount, s.RoundingDirection, s.RoundingApplyToTax,
			s.AutoOpenShift, []byte(s.PaymentMethods), []byte(s.Receipt))
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
