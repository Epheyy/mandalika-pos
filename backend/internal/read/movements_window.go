package read

import (
	"context"
	"errors"
	"fmt"
	"math"
	"time"

	"github.com/jackc/pgx/v5"
)

// windowSkew bounds how far transaction start time (recorded_at) may trail ledger order (seq)
// within one location. seq is taken when a row is inserted and recorded_at is the transaction
// start, so a transaction that waits on a stock row lock inserts (and takes its seq) later than a
// transaction that started after it. The boundary function below assumes that reordering never
// exceeds this bound; a lock wait longer than that is outside the service's design (the server
// request deadline is 25 s).
const windowSkew = 10 * time.Minute

// SeqWindow is the half-open run of ledger rows [Lo, Hi) of a location that a from/to range
// selects, in seq order. The range is on TIME RECORDED (recorded_at, the transaction start), not on
// occurred_at: an offline sale rung days ago and synced today belongs to the day it reached the
// books. recorded_at can be slightly out of seq order (lock waits), so the period is defined by
// ONE boundary function over the location, b(t) = the lowest seq recorded at or after t, and the
// window is [b(from), b(to)). Because the same b is used for both ends, consecutive periods
// partition the ledger: the end of one is exactly the start of the next, no row is counted twice
// and none is lost. A transaction that starts just before a boundary but commits after it lands in
// the earlier period (it takes its seq late, and seq decides), so a closed period never moves
// except for rows still in flight at its edge. The window is the same whether or not a SKU is
// filtered (the SKU filter applies inside it), so a SKU card equals its summary row. A seq
// interval of one SKU is always a continuous balance chain, so opening + in - out = closing
// holds for any window.
type SeqWindow struct {
	// Resolved is set by ResolveWindow; an unresolved window is treated as unbounded.
	Resolved bool
	// Empty means no row can fall in the window (Lo >= Hi).
	Empty bool
	// Lo is the first seq of the window (0: unbounded below) and Hi the first seq after it
	// (math.MaxInt64: unbounded above).
	Lo, Hi int64
	// Before bounds the earlier rows: seq < Before. It equals Lo.
	Before int64
}

// ResolveWindow computes f.Window from f.From/f.To over the filter's LOCATION. Without From and To
// the window is unbounded.
func (r *Repo) ResolveWindow(ctx context.Context, f *MovementFilter) error {
	f.Window = SeqWindow{Resolved: true, Lo: 0, Hi: math.MaxInt64}
	var err error
	if f.From != nil {
		if f.Window.Lo, err = r.boundary(ctx, f.LocationType, f.LocationID, *f.From); err != nil {
			return err
		}
	}
	if f.To != nil {
		if f.Window.Hi, err = r.boundary(ctx, f.LocationType, f.LocationID, *f.To); err != nil {
			return err
		}
	}
	f.Window.Before = f.Window.Lo
	f.Window.Empty = f.Window.Lo >= f.Window.Hi
	return nil
}

// The three boundary lookups (args $1 location type, $2 location id, $3 t, $4 t + windowSkew where
// used). Exported so the MV gate can EXPLAIN exactly what runs.
const (
	BoundarySliceSQL = `SELECT min(m.seq) FROM stock_movements m
WHERE m.location_type=$1 AND m.location_id=$2 AND m.recorded_at >= $3 AND m.recorded_at < $4`
	BoundaryNextSQL = `SELECT m.seq FROM stock_movements m
WHERE m.location_type=$1 AND m.location_id=$2 AND m.recorded_at >= $3
ORDER BY m.recorded_at, m.seq LIMIT 1`
	BoundaryEndSQL = `SELECT COALESCE((SELECT m.seq FROM stock_movements m
WHERE m.location_type=$1 AND m.location_id=$2 ORDER BY m.seq DESC LIMIT 1), 0) + 1`
)

// WindowSkew is the skew bound boundary lookups assume (see windowSkew).
const WindowSkew = windowSkew

// boundary is b(t): the lowest seq among the location's rows recorded at or after t, or one past
// the highest seq when there is none. Each step is a bounded lookup on
// stock_movements_loc_recorded (location, recorded_at, seq) or stock_movements_loc_seq:
//  1. the lowest seq among rows recorded in [t, t+windowSkew), which is the answer under the skew
//     assumption of windowSkew (rows recorded later cannot have a lower seq);
//  2. else the first row recorded after t+windowSkew, in (recorded_at, seq) order;
//  3. else one past the location's highest seq (an ordered probe of stock_movements_loc_seq).
func (r *Repo) boundary(ctx context.Context, locType, locID string, t time.Time) (int64, error) {
	var seq *int64
	err := r.Pool.QueryRow(ctx, BoundarySliceSQL, locType, locID, t, t.Add(windowSkew)).Scan(&seq)
	if err != nil {
		return 0, fmt.Errorf("window boundary: %w", err)
	}
	if seq != nil {
		return *seq, nil
	}
	var first int64
	err = r.Pool.QueryRow(ctx, BoundaryNextSQL, locType, locID, t.Add(windowSkew)).Scan(&first)
	if err == nil {
		return first, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return 0, fmt.Errorf("window boundary next row: %w", err)
	}
	var past int64
	if err = r.Pool.QueryRow(ctx, BoundaryEndSQL, locType, locID).Scan(&past); err != nil {
		return 0, fmt.Errorf("window boundary end: %w", err)
	}
	return past, nil
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
	return where + fmt.Sprintf(" AND m.seq >= $%d AND m.seq < $%d", len(args)-1, len(args)), args
}
