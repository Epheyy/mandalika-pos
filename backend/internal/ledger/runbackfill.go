package ledger

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// ErrInvariantViolated is returned by RunBackfill when a write run would leave live
// stock and the ledger disagreeing; the transaction was rolled back.
var ErrInvariantViolated = errors.New("ledger: backfill would leave invariant violations")

// TxBeginner is satisfied by *pgxpool.Pool.
type TxBeginner interface {
	Begin(ctx context.Context) (pgx.Tx, error)
}

// RunBackfill is the whole command path in one transaction: Backfill, then the
// invariant check in the same transaction. A dry run always rolls back and returns the
// violations as they stand now. A write run commits only when the invariant holds (0
// violations); otherwise it rolls back and returns ErrInvariantViolated together with
// the violations so the caller can print them.
func RunBackfill(ctx context.Context, db TxBeginner, opts BackfillOptions) (BackfillReport, []Violation, error) {
	tx, err := db.Begin(ctx)
	if err != nil {
		return BackfillReport{}, nil, fmt.Errorf("ledger: backfill begin: %w", err)
	}
	// Rollback after a successful Commit is a harmless no-op.
	defer func() { _ = tx.Rollback(ctx) }()
	rep, err := Backfill(ctx, tx, opts)
	if err != nil {
		return rep, nil, err
	}
	viol, err := InvariantViolations(ctx, tx)
	if err != nil {
		return rep, nil, err
	}
	if opts.DryRun {
		return rep, viol, nil
	}
	if len(viol) > 0 {
		return rep, viol, ErrInvariantViolated
	}
	if err := tx.Commit(ctx); err != nil {
		return rep, viol, fmt.Errorf("ledger: backfill commit: %w", err)
	}
	return rep, viol, nil
}
