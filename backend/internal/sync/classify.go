package sync

import (
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/mandalika/pos-backend/internal/apperr"
	"github.com/mandalika/pos-backend/internal/write"
)

// Generic client-facing texts for failures whose raw error must not be shown.
const (
	internalMessage     = "Terjadi kesalahan server, akan dicoba lagi otomatis"
	dataRejectedMessage = "Data tidak valid dan ditolak oleh server"
)

// itemOutcome is the machine-readable result of a failed batch item.
type itemOutcome struct {
	Code      apperr.Code
	Retryable bool
	Message   string
	// Sanitized is true when Message replaced the raw error text; the caller
	// should log the raw error server-side.
	Sanitized bool
}

// classifyItemError decides whether a failed item is a business refusal
// (non-retryable, needs review) or a transient/unknown failure (retry later).
//
// Only errors explicitly marked with apperr (or PostgreSQL data/integrity errors)
// are non-retryable. Anything unclassified is "internal" and retryable: a server
// bug fixed by a deploy must retry, never go to review.
func classifyItemError(err error) itemOutcome {
	var coded apperr.Coded
	if errors.As(err, &coded) {
		code := coded.ErrorCode()
		return itemOutcome{
			Code:      code,
			Retryable: code == apperr.Busy || code == apperr.Internal,
			Message:   err.Error(),
		}
	}
	var pg *pgconn.PgError
	if errors.As(err, &pg) {
		return classifyPg(pg)
	}
	// Timeouts, cancellation, dropped connections (context errors, net errors,
	// pgconn.SafeToRetry/Timeout) and every unclassified error: internal, retry.
	return internalOutcome()
}

func classifyPg(pg *pgconn.PgError) itemOutcome {
	class := pg.Code
	if len(class) > 2 {
		class = class[:2]
	}
	switch {
	case pg.Code == "23503":
		// foreign_key_violation: in an offline outbox a missing parent row usually
		// means "parent not synced yet" (e.g. a customer), so retry, don't review.
		return internalOutcome()
	case class == "22" || class == "23": // data exception, integrity constraint
		return itemOutcome{Code: apperr.Rejected, Message: dataRejectedMessage, Sanitized: true}
	case class == "40" || pg.Code == "55P03": // deadlock/serialization, lock not available
		return itemOutcome{Code: apperr.Busy, Retryable: true, Message: write.ErrBusy.Error(), Sanitized: true}
	}
	// 08 connection, 53 resources, 57 operator intervention and anything else.
	return internalOutcome()
}

func internalOutcome() itemOutcome {
	return itemOutcome{Code: apperr.Internal, Retryable: true, Message: internalMessage, Sanitized: true}
}

// isMissing reports a lookup that found no row, including an id that is not a
// valid UUID (SQLSTATE 22P02), which the old code also reported as "not found".
func isMissing(err error) bool {
	var pg *pgconn.PgError
	return errors.Is(err, pgx.ErrNoRows) || (errors.As(err, &pg) && pg.Code == "22P02")
}
