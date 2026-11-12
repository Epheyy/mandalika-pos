package read

import (
	"context"

	"github.com/mandalika/pos-backend/internal/api"
)

// promotionObj and discountCodeObj are the row shapes of the promotion and discount-code lists, shared
// by the full lists the tablet and the pickers read and by the paged backoffice lists.
const promotionObj = `json_build_object('id',id,'name',name,'description',description,
		   'type',type,'value',value,'minPurchase',min_purchase,
		   'applicableProductIds',applicable_product_ids,
		   'applicableVariantKeys',applicable_variant_keys,
		   'applicableVariantSizes',applicable_variant_sizes,
		   'outletIds',outlet_ids,'combinable',combinable,
		   'combinableWith',combinable_with,'activeFromHour',active_from_hour,
		   'activeToHour',active_to_hour,'activeDays',active_days,
		   'isActive',is_active,'startDate',start_date,'endDate',end_date,
		   'codeOnly',code_only,
		   'autoApply',auto_apply,
		   'bxgyConfig',bxgy_config,
		   'tieredConfig',tiered_config,
		   'bundleConfig',bundle_config,
		   'bundleDiscountConfig',bundle_discount_config,
		   'createdAt',created_at)`

const discountCodeObj = `json_build_object('id',id,'code',code,'promotionId',promotion_id,
		   'type',type,'value',value,'minPurchase',min_purchase,
		   'usageLimit',usage_limit,'perCustomerLimit',per_customer_limit,
		   'customerId',customer_id,'customerName',(SELECT name FROM customers WHERE id=discount_codes.customer_id),
		   'usageCount',usage_count,'isActive',is_active,
		   'startDate',start_date,'endDate',end_date,'combinable',combinable,
		   'createdAt',created_at)`

func (r *Repo) Promotions(ctx context.Context) ([]api.Promotion, int, error) {
	return listJSON[api.Promotion](ctx, r.Pool,
		`SELECT `+promotionObj+` FROM promotions ORDER BY created_at DESC`)
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
		`SELECT `+discountCodeObj+`
		   FROM discount_codes ORDER BY created_at DESC`)
}

// DiscountCodesByIDs re-fetches specific discount codes by id — used after
// CreateDiscountCodeBatch to build the API response, since api.DiscountCode's
// nullable.Nullable wrappers are painful/error-prone to hand-assemble. Same
// json_build_object shape as DiscountCodes(); pgx maps []string → uuid[] with
// the explicit cast.
func (r *Repo) DiscountCodesByIDs(ctx context.Context, ids []string) ([]api.DiscountCode, int, error) {
	rows, err := DiscountCodesByIDsOn(ctx, r.Pool, ids)
	return rows, len(rows), err
}

// DiscountCodesByIDsOn is DiscountCodesByIDs through q: the pool, or the transaction that
// just created the codes (a keyed batch answers from inside its receipt claim).
func DiscountCodesByIDsOn(ctx context.Context, q RowQuerier, ids []string) ([]api.DiscountCode, error) {
	return oneJSON[[]api.DiscountCode](ctx, q,
		`SELECT COALESCE(json_agg(`+discountCodeObj+` ORDER BY created_at DESC), '[]'::json)
		   FROM discount_codes WHERE id = ANY($1::uuid[])`, ids)
}
