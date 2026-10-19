// Package apperr marks domain errors with a machine-readable outcome code so the
// /sync/batch layer can tell a business refusal from a transient or unknown
// failure without parsing message text. It is a leaf package (no internal imports).
package apperr

import "errors"

// Code is the wire value of ItemResult.code. Keep in sync with
// api/openapi.yaml SyncItemResult.code.
type Code string

const (
	Rejected         Code = "rejected"          // business rule refused the request
	Forbidden        Code = "forbidden"         // permission, approver, PIN or scope
	NotFound         Code = "not_found"         // referenced record does not exist
	Conflict         Code = "conflict"          // invalid state transition
	CompetingReceipt Code = "competing_receipt" // transfer already completed by a different receive
	KeyConflict      Code = "key_conflict"      // idempotency key reused for another operation
	Busy             Code = "busy"              // lock conflict; nothing applied, retry later
	Internal         Code = "internal"          // unclassified; treat as retryable
	ActorMismatch    Code = "actor_mismatch"    // capture-time envelope does not match the caller (A04)
	OfflineExpired   Code = "offline_expired"   // captured more than 12 h after the last online contact (A05)
)

// Coded is implemented by errors that carry an outcome code.
type Coded interface {
	error
	ErrorCode() Code
}

// Error is a domain error carrying a Code. Its text is the message verbatim.
type Error struct {
	code Code
	msg  string
	err  error
}

// New builds a coded error with a fixed message (usable as a sentinel).
func New(code Code, msg string) *Error { return &Error{code: code, msg: msg} }

// Wrap attaches code to err without changing err's text. Wrap(code, nil) is nil.
func Wrap(code Code, err error) error {
	if err == nil {
		return nil
	}
	return &Error{code: code, err: err}
}

func (e *Error) Error() string {
	if e.err != nil {
		return e.err.Error()
	}
	return e.msg
}

func (e *Error) Unwrap() error { return e.err }

// ErrorCode returns the outcome code.
func (e *Error) ErrorCode() Code { return e.code }

// CodeOf returns the first code found in err's chain.
func CodeOf(err error) (Code, bool) {
	var c Coded
	if errors.As(err, &c) {
		return c.ErrorCode(), true
	}
	return "", false
}
