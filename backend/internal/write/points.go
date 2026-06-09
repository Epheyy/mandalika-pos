package write

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// PointTxRow is one ledger entry to insert. Empty OrderID/ByID/ByName → NULL.
type PointTxRow struct {
	CustomerID   string
	Type         string // earn | redeem | adjust | refund
	Points       int    // signed
	BalanceAfter int
	Reason       string
	OrderID      string
	ByID         string
	ByName       string
}

// InsertPointTx appends one ledger row using the given tx. Exported so the order
// service (CreateOrder / Refund) can record earn/redeem/refund entries inside the
// order transaction. The ::uuid casts let empty strings encode as NULL safely.
func InsertPointTx(ctx context.Context, tx pgx.Tx, e PointTxRow) error {
	switch e.Type {
	case "earn", "redeem", "adjust", "refund":
	default:
		return fmt.Errorf("invalid point tx type: %q", e.Type)
	}
	_, err := tx.Exec(ctx,
		`INSERT INTO point_transactions
		   (customer_id, type, points, balance_after, reason, order_id, created_by, created_by_name)
		 VALUES ($1,$2,$3,$4,NULLIF($5,''),NULLIF($6,'')::uuid,NULLIF($7,'')::uuid,NULLIF($8,''))`,
		e.CustomerID, e.Type, e.Points, e.BalanceAfter,
		e.Reason, e.OrderID, e.ByID, e.ByName)
	if err != nil {
		return fmt.Errorf("insert point tx: %w", err)
	}
	return nil
}

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
