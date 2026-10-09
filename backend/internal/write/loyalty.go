package write

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// ConditionApplicationRow is one loyalty_condition_applications insert. Empty
// ConditionID encodes NULL (condition deleted between eval and write is impossible
// inside one tx, but the column is nullable for later ON DELETE SET NULL).
type ConditionApplicationRow struct {
	OrderID, CustomerID, ConditionID   string
	ConditionName, Trigger, RewardType string
	RewardValue                        float64
	PointsContributed                  int
	RewardProductIDs                   []string
}

// InsertConditionApplication appends one audit row inside the given order tx.
func InsertConditionApplication(ctx context.Context, tx pgx.Tx, a ConditionApplicationRow) error {
	var rpids string
	if len(a.RewardProductIDs) > 0 {
		b, err := json.Marshal(a.RewardProductIDs)
		if err != nil {
			return fmt.Errorf("marshal reward product ids: %w", err)
		}
		rpids = string(b)
	}
	_, err := tx.Exec(ctx,
		`INSERT INTO loyalty_condition_applications
		   (order_id, customer_id, condition_id, condition_name, trigger, reward_type,
		    reward_value, points_contributed, reward_product_ids)
		 VALUES ($1,$2,NULLIF($3,'')::uuid,$4,$5,$6,$7,$8,NULLIF($9,'')::jsonb)`,
		a.OrderID, a.CustomerID, a.ConditionID, a.ConditionName, a.Trigger, a.RewardType,
		a.RewardValue, a.PointsContributed, rpids)
	if err != nil {
		return fmt.Errorf("insert condition application: %w", err)
	}
	return nil
}

// RewardGrantRow is one promo_reward_grants insert. Written inside the order tx
// for every BXGY (buy-X-get-Y) free item granted at checkout.
type RewardGrantRow struct {
	OrderID, PromotionID, ProductID, ProductName, VariantSize string
	FullPrice, RewardPrice, RewardValue                       float64
}

// InsertRewardGrant appends one promo reward grant row inside the given order tx.
func InsertRewardGrant(ctx context.Context, tx pgx.Tx, r RewardGrantRow) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO promo_reward_grants
		  (order_id, promotion_id, product_id, product_name, variant_size,
		   full_price, reward_price, reward_value)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
		r.OrderID, r.PromotionID, r.ProductID, r.ProductName, r.VariantSize,
		r.FullPrice, r.RewardPrice, r.RewardValue)
	if err != nil {
		return fmt.Errorf("insert reward grant: %w", err)
	}
	return nil
}

// LoyaltyCondition is the backoffice create/update input for a loyalty_conditions
// row (id/createdAt/appliedCount are server-owned and not part of the input).
// type + reward_type are enforced by DB CHECK constraints; trigger is free text
// (the engine simply ignores an unknown trigger).
type LoyaltyCondition struct {
	Name                 string   `json:"name"`
	Type                 string   `json:"type"`
	Trigger              string   `json:"trigger"`
	RewardType           string   `json:"rewardType"`
	RewardValue          float64  `json:"rewardValue"`
	RewardProductIDs     []string `json:"rewardProductIds"`
	CampaignStartDate    string   `json:"campaignStartDate"`
	CampaignEndDate      string   `json:"campaignEndDate"`
	ActiveDays           []int    `json:"activeDays"`
	ApplicableProductIDs []string `json:"applicableProductIds"`
	MinimumSpend         *float64 `json:"minimumSpend"`
	IsActive             bool     `json:"isActive"`
}

func (r *Repo) CreateLoyaltyCondition(ctx context.Context, c LoyaltyCondition) (string, error) {
	var id string
	err := r.tx(ctx, "loyaltyConditions", func(t pgx.Tx) error {
		rpid, _ := jsonb(c.RewardProductIDs)
		apid, _ := jsonb(c.ApplicableProductIDs)
		ad, _ := jsonb(c.ActiveDays)
		return t.QueryRow(ctx, `
			INSERT INTO loyalty_conditions (name, type, trigger, reward_type, reward_value,
			  reward_product_ids, campaign_start_date, campaign_end_date, active_days,
			  applicable_product_ids, minimum_spend, is_active)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
			c.Name, c.Type, c.Trigger, c.RewardType, c.RewardValue,
			rpid, nullDate(c.CampaignStartDate), nullDate(c.CampaignEndDate), ad,
			apid, c.MinimumSpend, c.IsActive).Scan(&id)
	})
	return id, err
}

func (r *Repo) UpdateLoyaltyCondition(ctx context.Context, id string, c LoyaltyCondition) error {
	return r.tx(ctx, "loyaltyConditions", func(t pgx.Tx) error {
		rpid, _ := jsonb(c.RewardProductIDs)
		apid, _ := jsonb(c.ApplicableProductIDs)
		ad, _ := jsonb(c.ActiveDays)
		ct, e := t.Exec(ctx, `
			UPDATE loyalty_conditions SET name=$1, type=$2, trigger=$3, reward_type=$4,
			  reward_value=$5, reward_product_ids=$6, campaign_start_date=$7,
			  campaign_end_date=$8, active_days=$9, applicable_product_ids=$10,
			  minimum_spend=$11, is_active=$12 WHERE id=$13`,
			c.Name, c.Type, c.Trigger, c.RewardType, c.RewardValue,
			rpid, nullDate(c.CampaignStartDate), nullDate(c.CampaignEndDate), ad,
			apid, c.MinimumSpend, c.IsActive, id)
		if e == nil && ct.RowsAffected() == 0 {
			return ErrNotFound
		}
		return e
	})
}

func (r *Repo) DeleteLoyaltyCondition(ctx context.Context, id string) error {
	return r.delete(ctx, "loyaltyConditions", "loyalty_conditions", id)
}
