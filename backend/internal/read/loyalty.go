package read

import (
	"context"

	"github.com/mandalika/pos-backend/internal/api"
)

func (r *Repo) LoyaltyConditions(ctx context.Context) ([]api.LoyaltyCondition, int, error) {
	return listJSON[api.LoyaltyCondition](ctx, r.Pool,
		`SELECT json_build_object('id',id,'name',name,'type',type,'trigger',trigger,
		   'rewardType',reward_type,'rewardValue',reward_value,
		   'rewardProductIds',reward_product_ids,
		   'campaignStartDate',campaign_start_date,'campaignEndDate',campaign_end_date,
		   'activeDays',active_days,'applicableProductIds',applicable_product_ids,
		   'minimumSpend',minimum_spend,'isActive',is_active,'createdAt',created_at,
		   'appliedCount',(SELECT count(*) FROM loyalty_condition_applications a
		                     WHERE a.condition_id = loyalty_conditions.id))
		   FROM loyalty_conditions ORDER BY created_at DESC`)
}

func (r *Repo) LoyaltySettings(ctx context.Context) (api.LoyaltySettings, error) {
	return oneJSON[api.LoyaltySettings](ctx, r.Pool,
		`SELECT json_build_object('enabled',enabled,'tierEnabled',tier_enabled,
		   'pointsPerThousand',points_per_thousand,'redemptionRate',redemption_rate)
		   FROM loyalty_settings WHERE id=1`)
}
