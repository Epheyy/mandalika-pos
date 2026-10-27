package read

import (
	"context"

	"github.com/mandalika/pos-backend/internal/api"
)

// PromoRewardGrantRow is the read-side projection of promo_reward_grants.
// It mirrors the PromoRewardGrant OpenAPI schema (SP-Promo-3b).
type PromoRewardGrantRow struct {
	ID          string  `json:"id"`
	OrderID     string  `json:"orderId"`
	PromotionID string  `json:"promotionId"`
	ProductID   string  `json:"productId"`
	ProductName string  `json:"productName"`
	VariantSize string  `json:"variantSize"`
	FullPrice   float64 `json:"fullPrice"`
	RewardPrice float64 `json:"rewardPrice"`
	RewardValue float64 `json:"rewardValue"`
	CreatedAt   string  `json:"createdAt"`
}

// RewardGrantsByOrder returns all promo_reward_grants for a given order UUID.
// Used by tests and the reporting layer (SP-Promo-3b-reward).
func (r *Repo) RewardGrantsByOrder(ctx context.Context, orderID string) ([]PromoRewardGrantRow, int, error) {
	return listJSON[PromoRewardGrantRow](ctx, r.Pool,
		`SELECT json_build_object('id',id,'orderId',order_id,'promotionId',promotion_id,
		   'productId',product_id,'productName',product_name,'variantSize',variant_size,
		   'fullPrice',full_price,'rewardPrice',reward_price,'rewardValue',reward_value,
		   'createdAt',created_at) FROM promo_reward_grants WHERE order_id=$1`, orderID)
}

// GrantReportFilters holds the fixed $1..$5 filter params for the
// promo-reward-grant report. All fields are optional ("" = no filter).
// DateFrom/DateTo are business days (orders.business_date of the granting sale).
type GrantReportFilters struct {
	DateFrom, DateTo, OutletID, PromotionID, ProductID string
}

// PromoRewardGrantReport returns a grouped, paginated view of promo reward
// grants for COMPLETED orders only, plus a summary (totals + by-promotion and
// by-product breakdowns aggregated over the full filtered set). It returns
// (summary, page of groups, total group count, error).
//
// Day bounds are business days: the granting sale's orders.business_date, so a giveaway
// lands on the same day as its sale in every report (A28).
func (r *Repo) PromoRewardGrantReport(ctx context.Context, f GrantReportFilters, page, limit int) (api.PromoGrantSummary, []api.PromoRewardGrantGroup, int, error) {
	var sum api.PromoGrantSummary
	where := `FROM promo_reward_grants g
		JOIN orders o     ON o.id = g.order_id AND o.status IN ('completed','partially_refunded')
		JOIN promotions p ON p.id = g.promotion_id
		WHERE ($1 = '' OR o.business_date >= $1::date)
		  AND ($2 = '' OR o.business_date <= $2::date)
		  AND ($3 = '' OR o.outlet_id::text = $3)
		  AND ($4 = '' OR g.promotion_id::text = $4)
		  AND ($5 = '' OR g.product_id::text = $5)`
	args := []any{f.DateFrom, f.DateTo, f.OutletID, f.PromotionID, f.ProductID}

	// Summary scalars (over the full filtered set). Fields are pointers, so
	// scan into locals then take addresses. reward_value is numeric → scan into
	// float64 (the field is format: double too, so no narrowing).
	var tv float64
	var ti, to int
	if err := r.Pool.QueryRow(ctx,
		`SELECT COALESCE(SUM(g.reward_value),0), COUNT(*), COUNT(DISTINCT g.order_id) `+where, args...,
	).Scan(&tv, &ti, &to); err != nil {
		return sum, nil, 0, err
	}
	sum.TotalValue = &tv
	sum.TotalItems = &ti
	sum.TotalOrders = &to

	// Breakdown by promotion.
	byPromo, _, err := listJSON[api.PromoGrantBreakdown](ctx, r.Pool,
		`SELECT json_build_object('promotionId',g.promotion_id,'promotionName',p.name,
		   'value',SUM(g.reward_value),'items',COUNT(*)) `+where+
			` GROUP BY g.promotion_id, p.name ORDER BY SUM(g.reward_value) DESC`, args...)
	if err != nil {
		return sum, nil, 0, err
	}
	sum.ByPromotion = &byPromo

	// Breakdown by product.
	byProduct, _, err := listJSON[api.PromoGrantBreakdown](ctx, r.Pool,
		`SELECT json_build_object('productId',g.product_id,'productName',g.product_name,
		   'variantSize',g.variant_size,'value',SUM(g.reward_value),'items',COUNT(*)) `+where+
			` GROUP BY g.product_id, g.product_name, g.variant_size ORDER BY SUM(g.reward_value) DESC`, args...)
	if err != nil {
		return sum, nil, 0, err
	}
	sum.ByProduct = &byProduct

	// Total group count (grouped subquery mirrors the page's GROUP BY).
	var total int
	if err := r.Pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM (SELECT 1 `+where+
			` GROUP BY g.order_id, g.promotion_id, g.product_id, g.variant_size) t`, args...,
	).Scan(&total); err != nil {
		return sum, nil, 0, err
	}

	// Grouped page. $6=limit, $7=offset.
	rows, _, err := listJSON[api.PromoRewardGrantGroup](ctx, r.Pool,
		`SELECT json_build_object('orderId',g.order_id,'orderNumber',o.order_number,
		   'promotionId',g.promotion_id,'promotionName',p.name,
		   'productId',g.product_id,'productName',g.product_name,'variantSize',g.variant_size,
		   'quantity',COUNT(*),'fullPrice',MAX(g.full_price),
		   'valueGivenAway',SUM(g.reward_value),'createdAt',o.created_at) `+where+
			` GROUP BY g.order_id, o.order_number, g.promotion_id, p.name, g.product_id, g.product_name, g.variant_size, o.created_at
			  ORDER BY o.created_at DESC LIMIT $6 OFFSET $7`,
		append(args, limit, off(page, limit))...)
	if err != nil {
		return sum, nil, 0, err
	}
	return sum, rows, total, nil
}

// CodeReportFilters bounds the DiscountCodeReport query.
type CodeReportFilters struct{ DateFrom, DateTo, OutletID string }

// DiscountCodeReport attributes discount VALUE per code from the unnested
// orders.discount_breakdown components whose label matches a real
// discount_codes.code — NOT orders.discount_amount. Completed orders only.
// Day bounds are business days (orders.business_date). Status is derived in SQL.
func (r *Repo) DiscountCodeReport(ctx context.Context, f CodeReportFilters, page, limit int) (api.DiscountCodeReportSummary, []api.DiscountCodeReportRow, int, error) {
	var sum api.DiscountCodeReportSummary
	where := `FROM orders o
		CROSS JOIN LATERAL jsonb_array_elements(COALESCE(o.discount_breakdown, '[]'::jsonb)) b
		JOIN discount_codes dc ON dc.code = (b->>'label')
		LEFT JOIN promotions p ON p.id = dc.promotion_id
		WHERE o.status IN ('completed','partially_refunded')
		  AND ($3 = '' OR o.outlet_id::text = $3)
		  AND ($1 = '' OR o.business_date >= $1::date)
		  AND ($2 = '' OR o.business_date <= $2::date)`
	args := []any{f.DateFrom, f.DateTo, f.OutletID}

	// Summary over the full filtered set. Fields are pointers, so scan into
	// locals then take addresses. Value is numeric → scan into float64
	// (the field is format: double too, so no narrowing).
	var tr, dc int
	var tv float64
	if err := r.Pool.QueryRow(ctx,
		`SELECT COUNT(DISTINCT o.id), COALESCE(SUM((b->>'amount')::numeric),0), COUNT(DISTINCT b->>'label') `+where, args...,
	).Scan(&tr, &tv, &dc); err != nil {
		return sum, nil, 0, err
	}
	trv, dcv := tr, dc
	sum.TotalRedemptions = &trv
	sum.TotalValue = &tv
	sum.DistinctCodes = &dcv

	// Total group count (grouped subquery mirrors the page's GROUP BY).
	var total int
	if err := r.Pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM (SELECT 1 `+where+` GROUP BY dc.id, b->>'label') t`, args...,
	).Scan(&total); err != nil {
		return sum, nil, 0, err
	}

	// Per-code page. $4=limit, $5=offset.
	rows, _, err := listJSON[api.DiscountCodeReportRow](ctx, r.Pool,
		`SELECT json_build_object(
		   'code', b->>'label',
		   'promotionName', p.name,
		   'redemptions', COUNT(DISTINCT o.id),
		   'valueGiven', SUM((b->>'amount')::numeric),
		   'usageLimit', dc.usage_limit,
		   'usageCount', dc.usage_count,
		   'remaining', CASE WHEN dc.usage_limit IS NULL THEN NULL ELSE dc.usage_limit - dc.usage_count END,
		   'status', CASE
		     WHEN NOT dc.is_active THEN 'nonaktif'
		     WHEN dc.end_date IS NOT NULL AND dc.end_date < (now() AT TIME ZONE 'Asia/Jakarta')::date THEN 'kedaluwarsa'
		     WHEN dc.usage_limit IS NOT NULL AND dc.usage_count >= dc.usage_limit THEN 'kuota habis'
		     ELSE 'aktif' END) `+where+`
		 GROUP BY dc.id, b->>'label', p.name, dc.usage_limit, dc.usage_count, dc.is_active, dc.end_date
		 ORDER BY SUM((b->>'amount')::numeric) DESC, dc.id LIMIT $4 OFFSET $5`,
		append(args, limit, off(page, limit))...)
	if err != nil {
		return sum, nil, 0, err
	}
	return sum, rows, total, nil
}
