package sync

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/mandalika/pos-backend/internal/apperr"
)

// Envelope is the capture-time identity the POS stamps on every outbox item (A04):
// who, at which outlet, on which device, in which shift the operation happened. It
// replaces the flush-time request headers as the source of attribution, but only
// after it has been verified against the authenticated caller (see attribute).
type Envelope struct {
	V          int       `json:"v"`
	OutletID   string    `json:"outletId"`
	UserID     string    `json:"userId"`
	DeviceID   string    `json:"deviceId"`
	CapturedAt time.Time `json:"capturedAt"`
	ShiftID    string    `json:"shiftId"`
	AppVersion string    `json:"appVersion"`
}

const envelopeVersion = 1

// Refusal texts shown on the tablet's review screen.
const (
	mismatchBadEnvelope = "Identitas transaksi tidak valid dan ditolak oleh server"
	mismatchOtherUser   = "Transaksi dibuat oleh akun lain dan tidak bisa dikirim dengan akun ini"
	mismatchOutlet      = "Akun ini tidak berwenang untuk outlet pada transaksi ini"
	mismatchShift       = "Shift pada transaksi ini milik outlet lain"
	mismatchLegacy      = "Versi aplikasi kasir terlalu lama: transaksi tanpa identitas tidak diterima lagi. Perbarui aplikasi lalu hubungi admin."
)

func mismatch(msg string) error { return apperr.New(apperr.ActorMismatch, msg) }

// shiftState is what the server knows about a shift id.
type shiftState int

const (
	shiftMissing shiftState = iota // no such shift (or not a uuid)
	shiftOpen
	shiftClosed
	shiftOtherOutlet
)

// attributionLookup is the database surface attribute needs; faked in unit tests.
type attributionLookup interface {
	OutletExists(ctx context.Context, outletID string) (bool, error)
	Shift(ctx context.Context, outletID, shiftID string) (shiftState, error)
	// Applied reports whether an item with this key and type was already applied at
	// scope (an outlet id), and the id/status a replay returns (M3).
	Applied(ctx context.Context, typ, key, scope string) (id, status string, ok bool, err error)
}

type poolLookup struct{ q pgxQuerier }

type pgxQuerier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

func (p poolLookup) OutletExists(ctx context.Context, outletID string) (bool, error) {
	if _, err := uuid.Parse(outletID); err != nil {
		return false, nil // not a uuid cannot be an existing outlet (never reaches SQL: 22P02)
	}
	var one int
	err := p.q.QueryRow(ctx, `SELECT 1 FROM outlets WHERE id=$1 AND is_active`, outletID).Scan(&one)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

func (p poolLookup) Shift(ctx context.Context, outletID, shiftID string) (shiftState, error) {
	if _, err := uuid.Parse(shiftID); err != nil {
		return shiftMissing, nil
	}
	var owner, status string
	err := p.q.QueryRow(ctx, `SELECT outlet_id::text, status FROM shifts WHERE id=$1`, shiftID).Scan(&owner, &status)
	if errors.Is(err, pgx.ErrNoRows) {
		return shiftMissing, nil
	}
	if err != nil {
		return shiftMissing, err
	}
	switch {
	case !strings.EqualFold(owner, outletID):
		return shiftOtherOutlet, nil
	case status == "closed":
		return shiftClosed, nil
	}
	return shiftOpen, nil
}

// Applied implements the already-applied probe: orders via processed_keys, transfer
// receives via the stored receive key, every other keyed op via its receipt. The scope
// (outlet) must match what was recorded, like the receipt replay rule.
func (p poolLookup) Applied(ctx context.Context, typ, key, scope string) (string, string, bool, error) {
	var id string
	var err error
	status := "ok"
	switch typ {
	case "order":
		status = "duplicate"
		err = p.q.QueryRow(ctx, `SELECT p.order_id::text FROM processed_keys p JOIN orders o ON o.id=p.order_id
			WHERE p.idempotency_key=$1 AND o.outlet_id::text=$2`, key, scope).Scan(&id)
	case "transfer_receive":
		err = p.q.QueryRow(ctx, `SELECT id::text FROM transfers WHERE received_idempotency_key=$1 AND dest_outlet_id::text=$2`, key, scope).Scan(&id)
	case "refund", "shift_open", "shift_close", "cash_flow", "customer_create":
		var outcome []byte
		err = p.q.QueryRow(ctx, `SELECT outcome FROM operation_receipts WHERE idempotency_key=$1 AND op_type=$2 AND scope=$3`, key, typ, scope).Scan(&outcome)
		if err == nil {
			var o receiptOutcome
			if json.Unmarshal(outcome, &o) != nil || o.OrderID == "" && typ != "customer_create" {
				return "", "", false, nil // receipt not completed: not applied
			}
			id = o.OrderID
		}
	default:
		return "", "", false, nil
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", false, nil
	}
	if err != nil {
		return "", "", false, err
	}
	return id, status, true, nil
}

// alreadyApplied is consulted only when attribution is refused: an item that landed
// before (e.g. the cashier was reassigned after a lost response) must replay as the
// first attempt's result, not go to review, and never apply twice (M3).
func (e *Engine) alreadyApplied(ctx context.Context, c Caller, it BatchItem) (id, status string, ok bool, err error) {
	scope := c.OutletID
	var env Envelope
	if len(it.Envelope) > 0 && json.Unmarshal(it.Envelope, &env) == nil && env.OutletID != "" {
		scope = env.OutletID
	}
	return e.lookup().Applied(ctx, it.Type, it.IdempotencyKey, scope)
}

func (e *Engine) lookup() attributionLookup {
	if e.Lookup != nil {
		return e.Lookup
	}
	return poolLookup{q: e.Pool}
}

func (e *Engine) now() time.Time {
	if e.Now != nil {
		return e.Now()
	}
	return time.Now()
}

// attribute decides which identity a batch item is processed as. The returned
// caller replaces the flush-time one everywhere except the version read (which
// stays on the request's outlet header). Rules (A04):
//
//   - No envelope (legacy client): the request caller, with a warning, until
//     LegacyEnvelopeUntil; after that actor_mismatch. Unset cutoff = accept.
//   - v must be 1, userId the authenticated user, deviceId the idempotency-key
//     prefix ("<deviceId>:<uuid>").
//   - outlet: an admin may be attributed to any existing outlet; everyone else
//     only to their stored users.outlet_id (never a header, never the token).
//   - shift: one that belongs to another outlet is refused; a closed one is
//     accepted (the late sale keeps it); an unknown one is accepted with a warning.
//
// Mismatches are non-retryable (review); database failures are returned as-is and
// classify as retryable internal errors, so a blip never parks an item.
func (e *Engine) attribute(ctx context.Context, c Caller, it BatchItem) (Caller, error) {
	if len(it.Envelope) == 0 {
		return c, e.legacyItem(c, it)
	}
	var env Envelope
	if json.Unmarshal(it.Envelope, &env) != nil || env.V != envelopeVersion ||
		env.OutletID == "" || env.UserID == "" || env.DeviceID == "" {
		return c, mismatch(mismatchBadEnvelope)
	}
	if env.UserID != c.UserID {
		return c, mismatch(mismatchOtherUser)
	}
	if !strings.HasPrefix(it.IdempotencyKey, env.DeviceID+":") {
		return c, mismatch(mismatchBadEnvelope)
	}
	if c.Role == "" {
		// The users row could not be read (blip or deleted): fail closed but retryable.
		return c, apperr.New(apperr.Internal, "identitas pengguna belum dapat diverifikasi")
	}
	lk := e.lookup()
	if c.Role == "admin" {
		ok, err := lk.OutletExists(ctx, env.OutletID)
		if err != nil {
			return c, err
		}
		if !ok {
			return c, mismatch(mismatchOutlet)
		}
	} else if c.HomeOutletID == "" || !strings.EqualFold(env.OutletID, c.HomeOutletID) {
		return c, mismatch(mismatchOutlet)
	}
	if env.ShiftID != "" {
		st, err := lk.Shift(ctx, env.OutletID, env.ShiftID)
		if err != nil {
			return c, err
		}
		switch st {
		case shiftOtherOutlet:
			return c, mismatch(mismatchShift)
		case shiftClosed:
			slog.Info("sync item for a closed shift (late sale keeps its shift)", "type", it.Type,
				"idempotencyKey", it.IdempotencyKey, "shiftId", env.ShiftID, "outletId", env.OutletID)
		case shiftMissing:
			slog.Warn("sync item references an unknown shift", "type", it.Type,
				"idempotencyKey", it.IdempotencyKey, "shiftId", env.ShiftID, "outletId", env.OutletID)
		}
	}
	out := c
	out.OutletID = env.OutletID
	return out, nil
}

// legacyItem applies the no-envelope policy. It never touches the database.
func (e *Engine) legacyItem(c Caller, it BatchItem) error {
	if !e.LegacyEnvelopeUntil.IsZero() && !e.now().Before(e.LegacyEnvelopeUntil) {
		return mismatch(mismatchLegacy)
	}
	slog.Warn("sync item without capture envelope (legacy client)", "type", it.Type,
		"idempotencyKey", it.IdempotencyKey, "outletId", c.OutletID, "userId", c.UserID)
	return nil
}

// payloadShift reconciles a shift id carried in an order or cash_flow payload with
// the attributed outlet. It runs only for enveloped items (legacy behaviour is
// untouched). A shift of another outlet is refused; an unknown one is dropped to
// NULL, because the FK violation it would otherwise raise is classified retryable
// and would never succeed.
func (e *Engine) payloadShift(ctx context.Context, c Caller, it BatchItem, shiftID string) (string, error) {
	if shiftID == "" || len(it.Envelope) == 0 {
		return shiftID, nil
	}
	st, err := e.lookup().Shift(ctx, c.OutletID, shiftID)
	if err != nil {
		return "", err
	}
	switch st {
	case shiftOtherOutlet:
		return "", mismatch(mismatchShift)
	case shiftMissing:
		slog.Warn("sync item payload references an unknown shift; stored without one", "type", it.Type,
			"idempotencyKey", it.IdempotencyKey, "shiftId", shiftID, "outletId", c.OutletID)
		return "", nil
	}
	return shiftID, nil
}
