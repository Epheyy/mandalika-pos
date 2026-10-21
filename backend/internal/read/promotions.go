package read

import (
	"context"

	"github.com/mandalika/pos-backend/internal/api"
)

func (r *Repo) Promotions(ctx context.Context) ([]api.Promotion, int, error) {
	return listJSON[api.Promotion](ctx, r.Pool,
		`SELECT json_build_object('id',id,'name',name,'description',description,
		   'type',type,'value',value,'minPurchase',min_purchase,
		   'applicableProductIds',applicable_product_ids,
		   'applicableVariantKeys',applicable_variant_keys,
		   'applicableVariantSizes',applicable_variant_sizes,
		   'outletIds',outlet_ids,'combinable',combinable,
		   'combinableWith',combinable_with,'activeFromHour',active_from_hour,
		   'activeToHour',active_to_hour,'activeDays',active_days,
		   'isActive',is_active,'startDate',start_date,'endDate',end_date,
		   'codeOnly',code_only,
		   'bxgyConfig',bxgy_config,
		   'tieredConfig',tiered_config,
		   'bundleConfig',bundle_config,
		   'createdAt',created_at) FROM promotions ORDER BY created_at DESC`)
}

// WithoutCustomerNames returns a copy of the codes with the holder's name removed
// (customerId is kept). Used for every consumer that lacks manage_promotions (A30).
func WithoutCustomerNames(in []api.DiscountCode) []api.DiscountCode {
	out := make([]api.DiscountCode, len(in))
	for i, c := range in {
		c.CustomerName = nil
		out[i] = c
	}
	return out
}

func (r *Repo) DiscountCodes(ctx context.Context) ([]api.DiscountCode, int, error) {
	return listJSON[api.DiscountCode](ctx, r.Pool,
		`SELECT json_build_object('id',id,'code',code,'promotionId',promotion_id,
		   'type',type,'value',value,'minPurchase',min_purchase,
		   'usageLimit',usage_limit,'perCustomerLimit',per_customer_limit,
		   'customerId',customer_id,'customerName',(SELECT name FROM customers WHERE id=discount_codes.customer_id),
		   'usageCount',usage_count,'isActive',is_active,
		   'startDate',start_date,'endDate',end_date,'combinable',combinable,
		   'createdAt',created_at)
		   FROM discount_codes ORDER BY created_at DESC`)
}

// DiscountCodesByIDs re-fetches specific discount codes by id — used after
// CreateDiscountCodeBatch to build the API response, since api.DiscountCode's
// nullable.Nullable wrappers are painful/error-prone to hand-assemble. Same
// json_build_object shape as DiscountCodes(); pgx maps []string → uuid[] with
// the explicit cast.
func (r *Repo) DiscountCodesByIDs(ctx context.Context, ids []string) ([]api.DiscountCode, int, error) {
	return listJSON[api.DiscountCode](ctx, r.Pool,
		`SELECT json_build_object('id',id,'code',code,'promotionId',promotion_id,
		   'type',type,'value',value,'minPurchase',min_purchase,
		   'usageLimit',usage_limit,'perCustomerLimit',per_customer_limit,
		   'customerId',customer_id,'customerName',(SELECT name FROM customers WHERE id=discount_codes.customer_id),
		   'usageCount',usage_count,'isActive',is_active,
		   'startDate',start_date,'endDate',end_date,'combinable',combinable,
		   'createdAt',created_at)
		   FROM discount_codes WHERE id = ANY($1::uuid[]) ORDER BY created_at DESC`, ids)
}
