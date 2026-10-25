package read

import (
	"context"
	"errors"
	"fmt"
	"math"
	"time"

	"github.com/jackc/pgx/v5"
)

// SeqWindow is the contiguous run of ledger rows a from/to range selects. The range is on TIME
// RECORDED (recorded_at, the transaction start), not on occurred_at: an offline sale rung days ago
// and synced today belongs to the day it reached the books, so a period that was already read
// never changes under the auditor. recorded_at can be slightly out of seq order (lock waits), so
// the window is defined by seq: from the first row recorded at or after From to the last row
// recorded before To. A seq interval of one SKU is always a continuous balance chain, so
// opening + in - out = closing holds for any window.
type SeqWindow struct {
	// Resolved is set by ResolveWindow; an unresolved window is treated as unbounded.
	Resolved bool
	// Empty means no row falls in the window (Lo and Hi are meaningless).
	Empty bool
	// Lo..Hi are the inclusive seq bounds (0 and MaxInt64 when that side is unbounded).
	Lo, Hi int64
	// Before bounds the "earlier" rows: seq < Before. For a non-empty window it is Lo; for an
	// empty one it is the point where the window would sit (MaxInt64: every row is earlier,
	// 0: none is).
	Before int64
}

// ResolveWindow computes f.Window from f.From/f.To over the filter's scope (the location, and
// the SKU when one is filtered). Without From and To the window is unbounded.
func (r *Repo) ResolveWindow(ctx context.Context, f *MovementFilter) error {
	f.Window = SeqWindow{Resolved: true, Lo: 0, Hi: math.MaxInt64, Before: 0}
	if f.From == nil && f.To == nil {
		return nil
	}
	scope, args := movementWhere(MovementFilter{LocationType: f.LocationType, LocationID: f.LocationID,
		ProductID: f.ProductID, VariantSize: f.VariantSize}, false)
	pick := func(cond, order string, arg time.Time) (*int64, error) {
		var seq int64
		err := r.Pool.QueryRow(ctx, fmt.Sprintf(`SELECT m.seq FROM stock_movements m WHERE %s AND m.recorded_at %s $%d
ORDER BY m.seq %s LIMIT 1`, scope, cond, len(args)+1, order), append(append([]any{}, args...), arg)...).Scan(&seq)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		if err != nil {
			return nil, fmt.Errorf("movement window: %w", err)
		}
		return &seq, nil
	}
	var lo, hi *int64
	var err error
	if f.From != nil {
		if lo, err = pick(">=", "ASC", *f.From); err != nil {
			return err
		}
		if lo == nil { // every row was recorded before From: the window sits after all of them
			f.Window.Empty, f.Window.Before = true, math.MaxInt64
			return nil
		}
		f.Window.Lo = *lo
	}
	if f.To != nil {
		if hi, err = pick("<", "DESC", *f.To); err != nil {
			return err
		}
		if hi == nil { // every row was recorded at or after To: nothing is earlier
			f.Window.Empty, f.Window.Before = true, 0
			return nil
		}
		f.Window.Hi = *hi
	}
	f.Window.Before = f.Window.Lo
	if f.Window.Lo > f.Window.Hi {
		f.Window.Empty = true
	}
	return nil
}

// windowSQL appends the window predicate on m.seq to where, numbering its args after args.
func windowSQL(w SeqWindow, where string, args []any) (string, []any) {
	if !w.Resolved {
		return where, args
	}
	if w.Empty {
		return where + " AND false", args
	}
	args = append(args, w.Lo, w.Hi)
	return where + fmt.Sprintf(" AND m.seq >= $%d AND m.seq <= $%d", len(args)-1, len(args)), args
}
