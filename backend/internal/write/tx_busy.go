package write

import (
	"errors"

	"github.com/jackc/pgx/v5/pgconn"
)

// ErrBusy marks a transaction that PostgreSQL aborted because of a lock
// conflict (deadlock, serialization failure or lock timeout). Nothing was
// applied; the caller may retry. Its text is safe to show to users.
var ErrBusy = errors.New("sedang diproses permintaan lain, silakan coba lagi")

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
