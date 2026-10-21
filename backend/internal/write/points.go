package write

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// AdjustPoints applies a signed manual adjustment with a required reason, writes an
// `adjust` ledger entry, and updates the cached balance — all in one tx. Rejects a
// subtraction larger than the balance (floor at 0).
func (r *Repo) AdjustPoints(ctx context.Context, customerID string, delta int, reason, byID, byName string) (int, error) {
	if reason == "" {
		return 0, ErrReasonRequired
	}
	t, err := r.Pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer t.Rollback(ctx)

	var bal int
	if e := t.QueryRow(ctx, `SELECT points FROM customers WHERE id=$1 FOR UPDATE`, customerID).Scan(&bal); e != nil {
		if errors.Is(e, pgx.ErrNoRows) {
			return 0, ErrNotFound
		}
		return 0, fmt.Errorf("load points: %w", e)
	}
	nb, e := adjustedBalance(bal, delta)
	if e != nil {
		return 0, e
	}
	if e := InsertPointTx(ctx, t, PointTxRow{
		CustomerID: customerID, Type: "adjust", Points: delta, BalanceAfter: nb,
		Reason: reason, ByID: byID, ByName: byName,
	}); e != nil {
		return 0, e
	}
	if _, e := t.Exec(ctx, `UPDATE customers SET points=$2 WHERE id=$1`, customerID, nb); e != nil {
		return 0, fmt.Errorf("update points: %w", e)
	}
	if e := t.Commit(ctx); e != nil {
		return 0, e
	}
	return nb, nil
}
