package write

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/mandalika/pos-backend/internal/apperr"
	"github.com/mandalika/pos-backend/internal/rules"
)

// A08: online step-up approval for transfer receive.
//
// Mint: the approver's PIN is verified on the server (lockout first, argon2 second)
// and a single-use grant is stored, bound to one receipt key, outlet, requesting user
// and count fingerprint. Consume: the grant is spent inside receiveTransfer's own
// transaction. Lock order everywhere: transfer row, then grant row. Mint never locks
// the transfer.

// ReceiveApprovalTTL bounds a grant, measured on the database clock.
const ReceiveApprovalTTL = 12 * time.Hour

// refusalMessage is the one body for unknown, ineligible, no-PIN and wrong-PIN approvers.
const refusalMessage = "PIN salah atau penyetuju tidak berwenang"

// ErrApprovalRefused is the uniform refusal of a mint.
var ErrApprovalRefused = apperr.New(apperr.Forbidden, refusalMessage)

// LockedError is returned when the approver or the requester is locked out.
type LockedError struct {
	RetryAfter time.Duration
	Hard       bool // only an admin action clears it
}

func (e *LockedError) Error() string {
	if e.Hard {
		return "Terkunci, hubungi admin"
	}
	return fmt.Sprintf("Terkunci, coba lagi dalam %d menit", int((e.RetryAfter+time.Minute-1)/time.Minute))
}

// ErrorCode keeps the error non-retryable for any generic classifier.
func (e *LockedError) ErrorCode() apperr.Code { return apperr.Forbidden }

// MintInput is one step-up request. PIN is verified and never stored or logged.
type MintInput struct {
	OutletID, RequesterID, DeviceID string
	TransferID, ReceiptKey          string
	ApproverID, PIN                 string
	Items                           []TransferReceiveItem
	Reason                          string
}

type MintResult struct {
	GrantID      string
	ExpiresAt    time.Time
	ApproverName string
}

// ApprovalBinding is what a redemption must match to spend a grant.
type ApprovalBinding struct {
	GrantID, OutletID, RequesterID, ReceiptKey, Fingerprint string
	DeviceID                                                string // advisory: a mismatch only warns
}

var uuidRe = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

func isUUID(s string) bool { return uuidRe.MatchString(s) }

var (
	dummyOnce sync.Once
	dummyHash string
)

// dummyPinHash gives unknown/ineligible approvers the same argon2 cost as a real one.
func dummyPinHash() string {
	dummyOnce.Do(func() {
		b := make([]byte, 16)
		_, _ = rand.Read(b)
		dummyHash, _ = rules.HashPassword(hex.EncodeToString(b))
	})
	return dummyHash
}

type lockRow struct {
	state rules.LockoutState
	have  bool // a row exists (the user exists)
}

func ensureLockout(ctx context.Context, tx pgx.Tx, kind, userID string) error {
	_, err := tx.Exec(ctx,
		`INSERT INTO receive_pin_lockouts(subject_kind, user_id) SELECT $1, id FROM users WHERE id=$2 ON CONFLICT DO NOTHING`,
		kind, userID)
	return err
}

func loadLockout(ctx context.Context, tx pgx.Tx, kind, userID string) (lockRow, error) {
	var l lockRow
	err := tx.QueryRow(ctx,
		`SELECT failures, lock_cycles, locked_until, hard_locked FROM receive_pin_lockouts
		  WHERE subject_kind=$1 AND user_id=$2 FOR UPDATE`, kind, userID).
		Scan(&l.state.Failures, &l.state.LockCycles, &l.state.LockedUntil, &l.state.HardLocked)
	if errors.Is(err, pgx.ErrNoRows) {
		return lockRow{}, nil
	}
	l.have = err == nil
	return l, err
}

func saveLockout(ctx context.Context, tx pgx.Tx, kind, userID string, s rules.LockoutState) error {
	_, err := tx.Exec(ctx,
		`UPDATE receive_pin_lockouts SET failures=$3, lock_cycles=$4, locked_until=$5, hard_locked=$6, updated_at=now()
		  WHERE subject_kind=$1 AND user_id=$2`, kind, userID, s.Failures, s.LockCycles, s.LockedUntil, s.HardLocked)
	return err
}

func insertAttempt(ctx context.Context, tx pgx.Tx, in MintInput, approverKnown bool, outcome string) error {
	var approver any
	if approverKnown {
		approver = in.ApproverID
	}
	_, err := tx.Exec(ctx,
		`INSERT INTO receive_pin_attempts(outlet_id, requester_id, approver_id, transfer_id, device_id, outcome)
		 VALUES($1,$2,$3,$4,$5,$6)`, in.OutletID, in.RequesterID, approver, in.TransferID, in.DeviceID, outcome)
	return err
}

func approverRoles(ctx context.Context, q interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}) ([]string, error) {
	var roles []string
	err := q.QueryRow(ctx, `SELECT receive_approver_roles FROM app_settings WHERE id=1`).Scan(&roles)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	return roles, nil // no row means no extra roles (admins still pass)
}

// pinSubject is one approver PIN check. authorized says the approver may approve at this
// document's location (role and scope), so only then does the approver's own lockout counter
// exist and move; hash and setAt are the approver's stored PIN (nil when none). attempt writes
// the audit row (never the PIN) for the caller's kind of document.
type pinSubject struct {
	approverID, requesterID string
	exists, authorized      bool
	hash                    *string
	setAt                   *time.Time
	pin                     string
	attempt                 func(approverKnown bool, outcome string) error
}

// pinCheck carries a passed check to its success bookkeeping.
type pinCheck struct {
	s                 pinSubject
	now               time.Time
	apprLock, reqLock lockRow
}

// checkApproverPIN is the lockout + argon2 core shared by the transfer-receive mint and the
// inventory approvals. Lock order is fixed (approver row, then requester row). A locked
// subject is never verified, correct PIN or not. On a lockout or a refused PIN it COMMITS the
// counters and the audit row on tx itself and returns *LockedError / ErrApprovalRefused:
// returning the refusal into the caller's deferred rollback would make the lockout never fire.
// On success nothing is written yet; the caller does its own work and then calls succeed.
func checkApproverPIN(ctx context.Context, tx pgx.Tx, s pinSubject) (*pinCheck, error) {
	// Lockout rows exist only for real users (FK). Lock order: approver, then requester.
	if s.authorized {
		if err := ensureLockout(ctx, tx, "approver", s.approverID); err != nil {
			return nil, err
		}
	}
	if err := ensureLockout(ctx, tx, "requester", s.requesterID); err != nil {
		return nil, err
	}
	var apprLock, reqLock lockRow
	var err error
	if s.authorized {
		if apprLock, err = loadLockout(ctx, tx, "approver", s.approverID); err != nil {
			return nil, err
		}
	}
	if reqLock, err = loadLockout(ctx, tx, "requester", s.requesterID); err != nil {
		return nil, err
	}
	var now time.Time
	if err := tx.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&now); err != nil {
		return nil, err
	}
	if locked := (apprLock.have && rules.IsLocked(apprLock.state, now)) || (reqLock.have && rules.IsLocked(reqLock.state, now)); locked {
		le := &LockedError{
			Hard: (apprLock.have && apprLock.state.HardLocked) || (reqLock.have && reqLock.state.HardLocked),
		}
		le.RetryAfter = max(rules.RetryAfter(apprLock.state, now), rules.RetryAfter(reqLock.state, now))
		// Checked BEFORE argon2: a locked subject is never verified, correct PIN or not.
		if err := s.attempt(s.exists, "locked"); err != nil {
			return nil, err
		}
		if err := tx.Commit(ctx); err != nil {
			return nil, err
		}
		return nil, le
	}

	eligible := s.authorized && s.hash != nil && *s.hash != "" && s.setAt != nil
	toCheck := dummyPinHash()
	if eligible {
		toCheck = *s.hash
	}
	pinOK, _ := rules.VerifyPassword(s.pin, toCheck)

	if !(eligible && pinOK) {
		outcome := "wrong_pin"
		if !eligible {
			outcome = "ineligible"
		}
		if apprLock.have {
			if err := saveLockout(ctx, tx, "approver", s.approverID, rules.NextLockout(apprLock.state, now, rules.LockoutFail, rules.ApproverLockout)); err != nil {
				return nil, err
			}
		}
		if reqLock.have {
			if err := saveLockout(ctx, tx, "requester", s.requesterID, rules.NextLockout(reqLock.state, now, rules.LockoutFail, rules.RequesterLockout)); err != nil {
				return nil, err
			}
		}
		if err := s.attempt(s.exists, outcome); err != nil {
			return nil, err
		}
		// Commit the counters: returning the refusal into the deferred rollback would
		// make the lockout never fire.
		if err := tx.Commit(ctx); err != nil {
			return nil, err
		}
		return nil, ErrApprovalRefused
	}
	return &pinCheck{s: s, now: now, apprLock: apprLock, reqLock: reqLock}, nil
}

// succeed resets both counters and writes the "granted" audit row.
func (c *pinCheck) succeed(ctx context.Context, tx pgx.Tx) error {
	if c.apprLock.have {
		if err := saveLockout(ctx, tx, "approver", c.s.approverID, rules.NextLockout(c.apprLock.state, c.now, rules.LockoutSuccess, rules.ApproverLockout)); err != nil {
			return err
		}
	}
	if c.reqLock.have {
		if err := saveLockout(ctx, tx, "requester", c.s.requesterID, rules.NextLockout(c.reqLock.state, c.now, rules.LockoutSuccess, rules.RequesterLockout)); err != nil {
			return err
		}
	}
	return c.s.attempt(true, "granted")
}

// MintReceiveApproval verifies the approver's PIN under the server-side lockout and
// stores a single-use grant. Refusals: ErrApprovalRefused (uniform), *LockedError,
// ErrNotFound, apperr.Forbidden (transfer not for this outlet), apperr.Conflict.
//
// Not wrapped in retryBusy: a mint waits for the lockout row locks at most
// mintLockTimeout (a connection is held meanwhile), then fails fast as ErrBusy so a burst
// from one requester cannot pin the pool. Lock order is fixed (approver row, then requester
// row), so there is no deadlock to retry.
func (r *Repo) MintReceiveApproval(ctx context.Context, in MintInput) (MintResult, error) {
	res, err := r.mintReceiveApproval(ctx, in)
	return res, mapBusy(err)
}

// mintLockTimeout bounds every lock wait inside a mint (lockout rows, grant row).
const mintLockTimeout = "2s"

func (r *Repo) mintReceiveApproval(ctx context.Context, in MintInput) (MintResult, error) {
	var zero MintResult
	if !isUUID(in.TransferID) {
		return zero, ErrNotFound
	}
	if !isUUID(in.OutletID) || !isUUID(in.RequesterID) {
		return zero, apperr.New(apperr.Forbidden, "tidak berwenang")
	}
	tx, err := r.Pool.Begin(ctx)
	if err != nil {
		return zero, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SET LOCAL lock_timeout = '`+mintLockTimeout+`'`); err != nil {
		return zero, err
	}

	// Read the transfer WITHOUT a row lock; redemption re-checks its state anyway.
	var status string
	var dst *string
	if err := tx.QueryRow(ctx, `SELECT status, dest_outlet_id::text FROM transfers WHERE id=$1`, in.TransferID).Scan(&status, &dst); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return zero, ErrNotFound
		}
		return zero, err
	}
	dest := ""
	if dst != nil {
		dest = *dst
	}
	if dest == "" || !strings.EqualFold(dest, in.OutletID) {
		return zero, apperr.New(apperr.Forbidden, "transfer bukan untuk outlet ini")
	}
	if _, err := transferTransition(status, "receive"); err != nil {
		return zero, err
	}

	var (
		exists           bool
		role, apprOutlet string
		hash             *string
		setAt            *time.Time
		apprName         string
	)
	if isUUID(in.ApproverID) {
		err := tx.QueryRow(ctx,
			`SELECT role, COALESCE(outlet_id::text,''), receive_pin_hash, receive_pin_set_at, display_name FROM users WHERE id=$1`,
			in.ApproverID).Scan(&role, &apprOutlet, &hash, &setAt, &apprName)
		switch {
		case err == nil:
			exists = true
		case !errors.Is(err, pgx.ErrNoRows):
			return zero, err
		}
	}
	roles, err := approverRoles(ctx, tx)
	if err != nil {
		return zero, err
	}

	// The approver counter only exists for, and only moves for, an approver who may approve
	// at THIS outlet. An unknown or ineligible approver counts against the requester alone,
	// so a cashier elsewhere cannot lock another outlet's approver, and an approver's lock
	// state never shows to someone who could not use that approver anyway.
	authorized := exists && ApproverAllowed(role, roles) && ReceiveScope(in.OutletID, dest, role, apprOutlet) == ""
	chk, err := checkApproverPIN(ctx, tx, pinSubject{
		approverID: in.ApproverID, requesterID: in.RequesterID,
		exists: exists, authorized: authorized, hash: hash, setAt: setAt, pin: in.PIN,
		attempt: func(approverKnown bool, outcome string) error {
			return insertAttempt(ctx, tx, in, approverKnown, outcome)
		},
	})
	if err != nil {
		return zero, err
	}

	var out MintResult
	err = tx.QueryRow(ctx,
		`INSERT INTO transfer_receive_approvals
		   (outlet_id, transfer_id, receipt_key, fingerprint, requested_by, device_id, approver_id, pin_set_at, expires_at)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now() + make_interval(secs => $9))
		 ON CONFLICT (outlet_id, receipt_key) DO UPDATE SET
		   transfer_id=EXCLUDED.transfer_id, fingerprint=EXCLUDED.fingerprint, requested_by=EXCLUDED.requested_by,
		   device_id=EXCLUDED.device_id, approver_id=EXCLUDED.approver_id, pin_set_at=EXCLUDED.pin_set_at,
		   issued_at=now(), expires_at=EXCLUDED.expires_at
		   WHERE transfer_receive_approvals.consumed_at IS NULL
		     AND transfer_receive_approvals.requested_by = EXCLUDED.requested_by
		 RETURNING id::text, expires_at`,
		in.OutletID, in.TransferID, in.ReceiptKey, ReceiveFingerprint(in.TransferID, in.Items, in.Reason),
		in.RequesterID, in.DeviceID, in.ApproverID, *setAt, ReceiveApprovalTTL.Seconds()).Scan(&out.GrantID, &out.ExpiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		// The key's grant was already spent, or belongs to another user: a re-mint must
		// never clear consumed_at nor rebind someone else's grant.
		return zero, apperr.New(apperr.Conflict, "kunci penerimaan sudah dipakai")
	}
	if err != nil {
		return zero, err
	}
	out.ApproverName = apprName
	if err := chk.succeed(ctx, tx); err != nil {
		return zero, err
	}
	return out, tx.Commit(ctx)
}

// consumeApproval spends the grant inside the receive transaction (transfer row already
// locked) and re-checks the approver. It returns the approver id, which becomes
// received_by. Every refusal is apperr.Forbidden: non-retryable, goes to review.
func consumeApproval(ctx context.Context, tx pgx.Tx, transferID string, t transferRow, a *ApprovalBinding) (string, error) {
	forbid := func(msg string) (string, error) { return "", apperr.New(apperr.Forbidden, msg) }
	if !isUUID(a.GrantID) || !isUUID(a.OutletID) || !isUUID(a.RequesterID) || !isUUID(transferID) {
		return forbid("Persetujuan tidak ditemukan")
	}
	var approver, deviceID string
	var pinSetAt time.Time
	err := tx.QueryRow(ctx,
		`UPDATE transfer_receive_approvals SET consumed_at=now(), consumed_key=$4
		  WHERE id=$1 AND outlet_id=$2 AND requested_by=$3 AND receipt_key=$4 AND transfer_id=$5
		    AND fingerprint=$6 AND consumed_at IS NULL AND expires_at > now()
		  RETURNING approver_id::text, pin_set_at, device_id`,
		a.GrantID, a.OutletID, a.RequesterID, a.ReceiptKey, transferID, a.Fingerprint).Scan(&approver, &pinSetAt, &deviceID)
	if errors.Is(err, pgx.ErrNoRows) {
		return diagnoseGrant(ctx, tx, transferID, a)
	}
	if err != nil {
		return "", err
	}
	if deviceID != "" && a.DeviceID != "" && deviceID != a.DeviceID {
		slog.Warn("receive approval redeemed from another device", "grantId", a.GrantID, "mintDevice", deviceID, "redeemDevice", a.DeviceID)
	}

	var role, outlet string
	var pinOK bool
	err = tx.QueryRow(ctx,
		`SELECT role, COALESCE(outlet_id::text,''), COALESCE(receive_pin_hash IS NOT NULL AND receive_pin_set_at = $2, false)
		   FROM users WHERE id=$1`, approver, pinSetAt).Scan(&role, &outlet, &pinOK)
	if errors.Is(err, pgx.ErrNoRows) {
		return forbid("Persetujuan dicabut")
	}
	if err != nil {
		return "", err
	}
	roles, err := approverRoles(ctx, tx)
	if err != nil {
		return "", err
	}
	dest := ""
	if t.dstOutlet != nil {
		dest = *t.dstOutlet
	}
	if !pinOK || !ApproverAllowed(role, roles) || ReceiveScope(a.OutletID, dest, role, outlet) != "" {
		return forbid("Persetujuan dicabut")
	}
	return approver, nil
}

// diagnoseGrant picks the refusal text after the guarded UPDATE matched nothing.
// The failed UPDATE did not error, so the transaction is still usable.
func diagnoseGrant(ctx context.Context, tx pgx.Tx, transferID string, a *ApprovalBinding) (string, error) {
	var outlet, requester, key, transfer, fp string
	var consumedAt *time.Time
	var expired bool
	err := tx.QueryRow(ctx,
		`SELECT outlet_id::text, requested_by::text, receipt_key, transfer_id::text, fingerprint, consumed_at, expires_at <= now()
		   FROM transfer_receive_approvals WHERE id=$1`, a.GrantID).Scan(&outlet, &requester, &key, &transfer, &fp, &consumedAt, &expired)
	msg := "Persetujuan tidak ditemukan"
	switch {
	case errors.Is(err, pgx.ErrNoRows):
	case err != nil:
		return "", err
	case !strings.EqualFold(outlet, a.OutletID) || !strings.EqualFold(requester, a.RequesterID) || key != a.ReceiptKey ||
		!strings.EqualFold(transfer, transferID) || fp != a.Fingerprint:
		msg = "Persetujuan tidak cocok dengan penerimaan ini"
	case consumedAt != nil:
		msg = "Persetujuan sudah dipakai"
	case expired:
		msg = "Persetujuan kedaluwarsa"
	}
	return "", apperr.New(apperr.Forbidden, msg)
}
