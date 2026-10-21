package ledger

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
