package write

import (
	"context"
	"errors"
	"github.com/mandalika/pos-backend/internal/apperr"
	"math/rand/v2"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

// ErrBusy marks a transaction that PostgreSQL aborted because of a lock
// conflict (deadlock, serialization failure or lock timeout). Nothing was
// applied; the caller may retry. Its text is safe to show to users.
var ErrBusy = apperr.New(apperr.Busy, "sedang diproses permintaan lain, silakan coba lagi")

// mapBusy converts retryable PostgreSQL concurrency errors into ErrBusy so raw
// database text never reaches a client. Other errors pass through unchanged.
func mapBusy(err error) error {
	var pg *pgconn.PgError
	if errors.As(err, &pg) {
		switch pg.Code {
		case "40P01", "40001", "55P03": // deadlock_detected, serialization_failure, lock_not_available
			return ErrBusy
		}
	}
	return err
}

const (
	busyAttempts   = 3 // first try plus two retries
	busyBackoffMin = 20 * time.Millisecond
	busyBackoffMax = 80 * time.Millisecond
)

// RetryBusy is retryBusy for callers outside this package (the direct sale and
// refund routes). fn must run one complete, fresh transaction per call.
func RetryBusy(ctx context.Context, fn func() error) error { return retryBusy(ctx, fn) }

// retryBusy runs fn (one complete, fresh transaction per call) and re-runs it
// when PostgreSQL aborted it on a lock conflict, with a short jittered backoff.
// After the last attempt the clean ErrBusy is returned. Other errors are never
// retried. Retrying matters for old POS builds that discard a failed receive.
func retryBusy(ctx context.Context, fn func() error) error {
	var err error
	for attempt := 0; attempt < busyAttempts; attempt++ {
		if attempt > 0 {
			wait := busyBackoffMin + time.Duration(rand.Int64N(int64(busyBackoffMax-busyBackoffMin)))
			select {
			case <-time.After(wait):
			case <-ctx.Done():
				return mapBusy(err)
			}
		}
		if err = mapBusy(fn()); !errors.Is(err, ErrBusy) {
			return err
		}
	}
	return err
}
