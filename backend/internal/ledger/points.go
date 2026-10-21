package ledger

import (
	"context"
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
