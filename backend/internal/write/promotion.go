package write

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/mandalika/pos-backend/internal/promotionkeys"
)

type BXGYConfigInput struct {
	BuyQuantity      int      `json:"buyQuantity"`
	GetQuantity      int      `json:"getQuantity"`
	BuyProductIDs    []string `json:"buyProductIds"`
	GetProductIDs    []string `json:"getProductIds"`
	GetDiscountKind  string   `json:"getDiscountKind"`
	GetDiscountValue float64  `json:"getDiscountValue"`
	MaxApplications  int      `json:"maxApplications"`
}

type TierInput struct {
	MinSubtotal float64 `json:"minSubtotal"`
	Kind        string  `json:"kind"`
	Value       float64 `json:"value"`
}

type TieredConfigInput struct {
	Tiers []TierInput `json:"tiers"`
}

func validateTiered(c *TieredConfigInput) error {
	if c == nil || len(c.Tiers) == 0 {
		return fmt.Errorf("tieredConfig requires at least one tier")
	}
	seen := map[float64]bool{}
	for _, t := range c.Tiers {
		if t.MinSubtotal < 0 {
			return fmt.Errorf("tier minSubtotal must be >= 0")
		}
		if seen[t.MinSubtotal] {
			return fmt.Errorf("duplicate tier minSubtotal %v", t.MinSubtotal)
		}
		seen[t.MinSubtotal] = true
		switch t.Kind {
		case "percentage":
			if t.Value <= 0 || t.Value > 100 {
				return fmt.Errorf("tier percentage must be 0<v<=100")
			}
		case "fixed":
			if t.Value <= 0 {
				return fmt.Errorf("tier fixed value must be >0")
			}
		default:
			return fmt.Errorf("tier kind must be percentage|fixed")
		}
	}
	return nil
}

type BundleSlotInput struct {
	ProductKeys []string `json:"productKeys"`
	Quantity    int      `json:"quantity"`
}

type BundleConfigInput struct {
	Slots           []BundleSlotInput `json:"slots"`
	BundlePrice     float64           `json:"bundlePrice"`
	MaxApplications int               `json:"maxApplications"`
}

func validateBundle(c *BundleConfigInput) error {
	if c == nil || len(c.Slots) == 0 {
		return fmt.Errorf("bundleConfig requires at least one slot")
	}
	if c.BundlePrice <= 0 {
		return fmt.Errorf("bundle bundlePrice must be > 0")
	}
	if c.MaxApplications < 0 {
		return fmt.Errorf("bundle maxApplications must be >= 0")
	}
	seen := map[string]bool{}
	groups := make([][]string, 0, len(c.Slots))
	for _, s := range c.Slots {
		groups = append(groups, s.ProductKeys)
		if len(s.ProductKeys) == 0 {
			return fmt.Errorf("bundle slot requires at least one productKey")
		}
		if s.Quantity < 1 {
			return fmt.Errorf("bundle slot quantity must be >= 1")
		}
		for _, k := range s.ProductKeys {
			if seen[k] {
				return fmt.Errorf("bundle slots must not overlap on key %q", k)
			}
			seen[k] = true
		}
	}
	if promotionkeys.GroupsOverlap(groups) {
		return fmt.Errorf("bundle slots must not overlap in product/variant coverage")
	}
	return nil
}

func validateBXGY(c *BXGYConfigInput) error {
	if c == nil {
		return fmt.Errorf("bxgyConfig required for buy_x_get_y")
	}
	if c.BuyQuantity < 1 || c.GetQuantity < 1 || c.MaxApplications < 0 {
		return fmt.Errorf("invalid bxgy quantities")
	}
	switch c.GetDiscountKind {
	case "percentage":
		if c.GetDiscountValue <= 0 || c.GetDiscountValue > 100 {
			return fmt.Errorf("bxgy percentage must be 0<v<=100")
		}
	case "fixed":
		if c.GetDiscountValue <= 0 {
			return fmt.Errorf("bxgy fixed value must be >0")
		}
	default:
		return fmt.Errorf("bxgy getDiscountKind must be percentage|fixed")
	}
	for _, g := range c.GetProductIDs {
		for _, b := range c.BuyProductIDs {
			if promotionkeys.Overlap(g, b) {
				return fmt.Errorf("bxgy buy/get sets must not overlap")
			}
		}
	}
	return nil
}

type Promotion struct {
	Name                   string             `json:"name"`
	Description            string             `json:"description"`
	Type                   string             `json:"type"`
	Value                  float64            `json:"value"`
	MinPurchase            *float64           `json:"minPurchase"`
	ApplicableProductIDs   []string           `json:"applicableProductIds"`
	ApplicableVariantKeys  []string           `json:"applicableVariantKeys"`
	ApplicableVariantSizes []string           `json:"applicableVariantSizes"`
	OutletIDs              []string           `json:"outletIds"`
	Combinable             *bool              `json:"combinable"`
	CombinableWith         []string           `json:"combinableWith"`
	CodeOnly               bool               `json:"codeOnly"`
	ActiveFromHour         string             `json:"activeFromHour"`
	ActiveToHour           string             `json:"activeToHour"`
	ActiveDays             []int              `json:"activeDays"`
	IsActive               bool               `json:"isActive"`
	StartDate              string             `json:"startDate"`
	EndDate                string             `json:"endDate"`
	BXGYConfig             *BXGYConfigInput   `json:"bxgyConfig"`
	TieredConfig           *TieredConfigInput `json:"tieredConfig"`
	BundleConfig           *BundleConfigInput `json:"bundleConfig"`
}

func (r *Repo) CreatePromotion(ctx context.Context, p Promotion) (string, error) {
	if err := validatePromotionBasics(p); err != nil {
		return "", err
	}
	if p.Type == "buy_x_get_y" {
		if err := validateBXGY(p.BXGYConfig); err != nil {
			return "", err
		}
	}
	if p.Type == "tiered" {
		if err := validateTiered(p.TieredConfig); err != nil {
			return "", err
		}
	}
	if p.Type == "bundle" {
		if err := validateBundle(p.BundleConfig); err != nil {
			return "", err
		}
	}
	var id string
	err := r.tx(ctx, "promotions", func(t pgx.Tx) error {
		apid, _ := jsonb(p.ApplicableProductIDs)
		avk, _ := jsonb(p.ApplicableVariantKeys)
		avs, _ := jsonb(p.ApplicableVariantSizes)
		oid, _ := jsonb(p.OutletIDs)
		cw, _ := jsonb(p.CombinableWith)
		ad, _ := jsonb(p.ActiveDays)
		var bxgy any
		if p.Type == "buy_x_get_y" && p.BXGYConfig != nil {
			b, _ := jsonb(p.BXGYConfig)
			bxgy = b
		}
		var tiered any
		if p.Type == "tiered" && p.TieredConfig != nil {
			b, _ := jsonb(p.TieredConfig)
			tiered = b
		}
		var bundle any
		if p.Type == "bundle" && p.BundleConfig != nil {
			b, _ := jsonb(p.BundleConfig)
			bundle = b
		}
		return t.QueryRow(ctx, `
			INSERT INTO promotions (name, description, type, value, min_purchase,
			  applicable_product_ids, applicable_variant_keys,
			  applicable_variant_sizes, outlet_ids, combinable, combinable_with,
			  active_from_hour, active_to_hour, active_days, is_active,
			  start_date, end_date, code_only, bxgy_config, tiered_config, bundle_config)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
			RETURNING id`,
			p.Name, nullStr(p.Description), p.Type, p.Value, p.MinPurchase,
			apid, avk, avs, oid, p.Combinable, cw,
			nullStr(p.ActiveFromHour), nullStr(p.ActiveToHour), ad, p.IsActive,
			nullDate(p.StartDate), nullDate(p.EndDate), p.CodeOnly, bxgy, tiered, bundle).Scan(&id)
	})
	return id, err
}

func (r *Repo) UpdatePromotion(ctx context.Context, id string, p Promotion) error {
	if err := validatePromotionBasics(p); err != nil {
		return err
	}
	if p.Type == "buy_x_get_y" {
		if err := validateBXGY(p.BXGYConfig); err != nil {
			return err
		}
	}
	if p.Type == "tiered" {
		if err := validateTiered(p.TieredConfig); err != nil {
			return err
		}
	}
	if p.Type == "bundle" {
		if err := validateBundle(p.BundleConfig); err != nil {
			return err
		}
	}
	return r.tx(ctx, "promotions", func(t pgx.Tx) error {
		apid, _ := jsonb(p.ApplicableProductIDs)
		avk, _ := jsonb(p.ApplicableVariantKeys)
		avs, _ := jsonb(p.ApplicableVariantSizes)
		oid, _ := jsonb(p.OutletIDs)
		cw, _ := jsonb(p.CombinableWith)
		ad, _ := jsonb(p.ActiveDays)
		var bxgy any
		if p.Type == "buy_x_get_y" && p.BXGYConfig != nil {
			b, _ := jsonb(p.BXGYConfig)
			bxgy = b
		}
		var tiered any
		if p.Type == "tiered" && p.TieredConfig != nil {
			b, _ := jsonb(p.TieredConfig)
			tiered = b
		}
		var bundle any
		if p.Type == "bundle" && p.BundleConfig != nil {
			b, _ := jsonb(p.BundleConfig)
			bundle = b
		}
		ct, e := t.Exec(ctx, `
			UPDATE promotions SET name=$1, description=$2, type=$3, value=$4,
			  min_purchase=$5, applicable_product_ids=$6, applicable_variant_keys=$7,
			  applicable_variant_sizes=$8, outlet_ids=$9, combinable=$10,
			  combinable_with=$11, active_from_hour=$12, active_to_hour=$13,
			  active_days=$14, is_active=$15, start_date=$16, end_date=$17, code_only=$18,
			  bxgy_config=$19, tiered_config=$20, bundle_config=$21
			WHERE id=$22`,
			p.Name, nullStr(p.Description), p.Type, p.Value, p.MinPurchase,
			apid, avk, avs, oid, p.Combinable, cw,
			nullStr(p.ActiveFromHour), nullStr(p.ActiveToHour), ad, p.IsActive,
			nullDate(p.StartDate), nullDate(p.EndDate), p.CodeOnly, bxgy, tiered, bundle, id)
		if e == nil && ct.RowsAffected() == 0 {
			return ErrNotFound
		}
		return e
	})
}

func (r *Repo) DeletePromotion(ctx context.Context, id string) error {
	return r.delete(ctx, "promotions", "promotions", id)
}

// validateDiscountValue guards the top-level `value` of a plain percentage/fixed promotion or code: it must be
// > 0 and a percentage must be <= 100. Other types (bogo, bxgy, tiered, bundle) carry their numbers in a config
// blob and ignore the top-level value, so it is not checked for them. Validated in the write path only: no DB
// CHECK, since older test rows may hold 0.
func validateDiscountValue(typ string, value float64) error {
	switch typ {
	case "percentage":
		if value <= 0 || value > 100 {
			return fmt.Errorf("percentage value must be > 0 and <= 100")
		}
	case "fixed":
		if value <= 0 {
			return fmt.Errorf("fixed value must be greater than 0")
		}
	}
	return nil
}

// validateDateOrder rejects an end date before the start date (YYYY-MM-DD strings compare correctly as text).
func validateDateOrder(start, end string) error {
	if start != "" && end != "" && end < start {
		return fmt.Errorf("endDate must not be before startDate")
	}
	return nil
}

// An inactive row may be saved as it is (switching an old invalid promotion off from the list resends the whole
// row), so the value/date rules apply to active ones only; the form itself always checks.
func validatePromotionBasics(p Promotion) error {
	if !p.IsActive {
		return nil
	}
	if err := validateDiscountValue(p.Type, p.Value); err != nil {
		return err
	}
	return validateDateOrder(p.StartDate, p.EndDate)
}
