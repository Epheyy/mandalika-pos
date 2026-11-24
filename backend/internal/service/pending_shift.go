package service

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
)

// Shift-less attribution (migration 0098). A sale or cash movement captured while its tablet's
// shift_open was still in the outbox names that open by its idempotency key. The writer and the
// shift_open serialize on an advisory lock over (outlet, key), taken as the FIRST statement of
// each transaction (before any row lock, so it cannot join a cycle with the lock order in
// order.go): whichever commits first, the other sees it. Writer first: the open's backfill
// attaches the row. Open first: the writer reads the committed receipt.

// LockPendingShiftOpen takes the transaction-scoped advisory lock for (outlet, key).
func LockPendingShiftOpen(ctx context.Context, tx pgx.Tx, outletID, key string) error {
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('shift_open:'||$1::text||':'||$2::text, 0))`, outletID, key)
	return err
}

// ResolvePendingShiftOpen locks (outlet, key) and returns the shift that open produced, or ""
// while the open has not landed (the caller then stores the key with a NULL shift).
func ResolvePendingShiftOpen(ctx context.Context, tx pgx.Tx, outletID, key string) (string, error) {
	if err := LockPendingShiftOpen(ctx, tx, outletID, key); err != nil {
		return "", err
	}
	var shiftID *string
	err := tx.QueryRow(ctx, `SELECT outcome->>'orderId' FROM operation_receipts
		WHERE idempotency_key=$1 AND op_type='shift_open' AND scope=$2`, key, outletID).Scan(&shiftID)
	if errors.Is(err, pgx.ErrNoRows) || err == nil && (shiftID == nil || !isCanonicalUUID(*shiftID)) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return *shiftID, nil
}

// BackfillPendingShift attaches the sales, cash movements and their stock exceptions that were
// stored with this open's key (and no shift) to the shift the open just created. The key column
// is kept as audit evidence.
func BackfillPendingShift(ctx context.Context, tx pgx.Tx, outletID, key, shiftID string) error {
	for _, q := range []string{
		`UPDATE orders SET shift_id=$3 WHERE outlet_id=$1 AND pending_shift_open_key=$2 AND shift_id IS NULL`,
		`UPDATE cash_flows SET shift_id=$3 WHERE outlet_id=$1 AND pending_shift_open_key=$2 AND shift_id IS NULL`,
		`UPDATE sale_stock_exceptions x SET shift_id=$3 FROM orders o
		  WHERE x.order_id=o.id AND o.outlet_id=$1 AND o.pending_shift_open_key=$2 AND x.shift_id IS NULL`,
	} {
		if _, err := tx.Exec(ctx, q, outletID, key, shiftID); err != nil {
			return err
		}
	}
	return nil
}
