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
	OrderID, CustomerID, ConditionID string
	ConditionName, Trigger, RewardType string
	RewardValue       float64
	PointsContributed int
	RewardProductIDs  []string
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
