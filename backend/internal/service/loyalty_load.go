package service

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// rowQueryRower is satisfied by both *pgxpool.Pool and pgx.Tx, so loadLoyalty
// can run on the pool (preview) or inside the order tx (commit).
type rowQueryRower interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

func loadLoyalty(ctx context.Context, q rowQueryRower) (bool, float64, float64, error) {
	var en bool
	var ppk, rate float64
	err := q.QueryRow(ctx,
		`SELECT enabled, points_per_thousand, redemption_rate
		   FROM loyalty_settings WHERE id=1`).
		Scan(&en, &ppk, &rate)
	return en, ppk, rate, err
}

// rowQuerier is satisfied by both *pgxpool.Pool and pgx.Tx, so loadActiveConditions
// can run inside the order tx (commit) or directly on the pool (preview).
type rowQuerier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

// loadActiveConditions reads the active loyalty_conditions inside the order tx into
// the pure engine struct. Ordered (created_at, id) so multiply-tie attribution is
// deterministic. jsonb arrays scan directly into Go slices (pgx v5), as in resolvePromo.
func loadActiveConditions(ctx context.Context, q rowQuerier) ([]LoyaltyCondition, error) {
	rows, err := q.Query(ctx, `
		SELECT id, name, type, trigger, reward_type, reward_value,
		       COALESCE(reward_product_ids,'[]'::jsonb),
		       campaign_start_date, campaign_end_date,
		       COALESCE(active_days,'[]'::jsonb),
		       COALESCE(applicable_product_ids,'[]'::jsonb),
		       minimum_spend, is_active
		  FROM loyalty_conditions
		 WHERE is_active = true
		 ORDER BY created_at, id`)
	if err != nil {
		return nil, fmt.Errorf("load loyalty conditions: %w", err)
	}
	defer rows.Close()
	var out []LoyaltyCondition
	for rows.Next() {
		var c LoyaltyCondition
		if err := rows.Scan(&c.ID, &c.Name, &c.Type, &c.Trigger, &c.RewardType, &c.RewardValue,
			&c.RewardProductIDs, &c.CampaignStartDate, &c.CampaignEndDate,
			&c.ActiveDays, &c.ApplicableProductIDs, &c.MinimumSpend, &c.IsActive); err != nil {
			return nil, fmt.Errorf("scan loyalty condition: %w", err)
		}
		out = append(out, c)
	}
	return out, rows.Err()
}
