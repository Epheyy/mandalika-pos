package auth

import (
	"context"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mandalika/pos-backend/internal/apperr"
	"github.com/mandalika/pos-backend/internal/rules"
)

type User struct {
	ID          string   `json:"id"`
	Email       string   `json:"email"`
	DisplayName string   `json:"displayName"`
	Role        string   `json:"role"`
	OutletID    string   `json:"outletId,omitempty"`
	PhotoURL    string   `json:"photoURL,omitempty"`
	Permissions []string `json:"permissions"`
	// PermVersion is users.perm_version. Never serialized: it is a token claim, not API surface.
	PermVersion  int64 `json:"-"`
	passwordHash string
}

var ErrNotFound = errors.New("user not found")

// Open-shift refusals (409). "Open shift" is a server-side proxy: a shifts row with
// status 'open' for the user. The server cannot see items still queued on a tablet,
// so this narrows the stranded-queue risk without removing it.
var (
	ErrOpenShiftDelete = apperr.New(apperr.Conflict, "Pengguna ini masih punya shift yang buka. Tutup shift-nya dulu sebelum menghapus.")
	ErrOpenShiftMove   = apperr.New(apperr.Conflict, "Pengguna ini masih punya shift yang buka. Tutup shift-nya dulu sebelum memindah outlet.")
)

// hasOpenShift reports whether the user has an open shift. Call it inside the
// transaction that holds the user row lock.
func hasOpenShift(ctx context.Context, q querier, uid string) (bool, error) {
	var open bool
	err := q.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM shifts WHERE cashier_id=$1 AND status='open')`, uid).Scan(&open)
	return open, err
}

// RightsPublisher is told, after commit, that a user's rights version moved (or that
// the user is gone) so every instance can refuse older access tokens within seconds.
type RightsPublisher interface {
	Publish(ctx context.Context, uid string, v int64)
	PublishDeleted(ctx context.Context, uid string)
}

type Store struct {
	Pool *pgxpool.Pool
	// Versions, when set, receives rights-version changes after commit. Nil means none.
	Versions RightsPublisher
}

func NewStore(p *pgxpool.Pool) *Store { return &Store{Pool: p} }

// querier is the read surface shared by the pool and a transaction.
type querier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

func scanUser(ctx context.Context, q querier, row pgx.Row, extra ...any) (*User, error) {
	u := &User{}
	var outlet, photo *string
	dest := append([]any{&u.ID, &u.Email, &u.DisplayName, &u.Role, &outlet, &photo, &u.PermVersion}, extra...)
	err := row.Scan(dest...)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if outlet != nil {
		u.OutletID = *outlet
	}
	if photo != nil {
		u.PhotoURL = *photo
	}
	perms, err := permissionsOf(ctx, q, u.ID)
	if err != nil {
		return nil, err
	}
	u.Permissions = perms
	return u, nil
}

func (s *Store) byEmailRow(ctx context.Context, email string) (*User, error) {
	var hash string
	u, err := scanUser(ctx, s.Pool, s.Pool.QueryRow(ctx,
		`SELECT id, email, display_name, role, outlet_id, photo_url, perm_version, password_hash
		   FROM users WHERE email = $1`, email), &hash)
	if err != nil {
		return nil, err
	}
	u.passwordHash = hash
	return u, nil
}

func (s *Store) ByID(ctx context.Context, id string) (*User, error) {
	return scanUser(ctx, s.Pool, s.Pool.QueryRow(ctx,
		`SELECT id, email, display_name, role, outlet_id, photo_url, perm_version
		   FROM users WHERE id = $1`, id))
}

// permissionsOf returns the user's permissions. A query error is returned, never
// swallowed: a DB blip must not mint an access token with no permissions.
func permissionsOf(ctx context.Context, q querier, uid string) ([]string, error) {
	rows, err := q.Query(ctx, `SELECT permission FROM user_permissions WHERE user_id = $1`, uid)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	perms := []string{}
	for rows.Next() {
		var p string
		if err := rows.Scan(&p); err != nil {
			return nil, err
		}
		perms = append(perms, p)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return perms, nil
}

// Authenticate verifies the credentials. It also returns the password hash it
// verified against so IssueSession can detect a concurrent admin reset.
func (s *Store) Authenticate(ctx context.Context, email, password string) (*User, string, error) {
	u, err := s.byEmailRow(ctx, email)
	if err != nil {
		return nil, "", err
	}
	ok, err := rules.VerifyPassword(password, u.passwordHash)
	if err != nil || !ok {
		return nil, "", ErrNotFound
	}
	return u, u.passwordHash, nil
}

// UpdateUser patches mutable fields; only non-nil args are applied. perms,
// when non-nil, replaces the permission set. Passwords are not changed here;
// admins use ResetPassword. ErrNotFound when the user does not exist.
func (s *Store) UpdateUser(ctx context.Context, id string, name, role, outletID, photo *string, perms *[]string) error {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	var curRole string
	var curOutlet *string
	err = tx.QueryRow(ctx,
		`SELECT role, outlet_id FROM users WHERE id=$1 FOR NO KEY UPDATE`, id).Scan(&curRole, &curOutlet)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	rightsChanged := role != nil && *role != curRole
	if outletID != nil {
		cur := ""
		if curOutlet != nil {
			cur = *curOutlet
		}
		if !strings.EqualFold(*outletID, cur) {
			rightsChanged = true
			// The whole request is refused: no partial update.
			open, err := hasOpenShift(ctx, tx, id)
			if err != nil {
				return err
			}
			if open {
				return ErrOpenShiftMove
			}
		}
	}
	if perms != nil && !rightsChanged {
		have, err := permissionsOf(ctx, tx, id)
		if err != nil {
			return err
		}
		rightsChanged = !sameSet(have, *perms)
	}
	if name != nil {
		if _, err := tx.Exec(ctx, `UPDATE users SET display_name=$1 WHERE id=$2`, *name, id); err != nil {
			return err
		}
	}
	if role != nil {
		if _, err := tx.Exec(ctx, `UPDATE users SET role=$1 WHERE id=$2`, *role, id); err != nil {
			return err
		}
	}
	if outletID != nil {
		var o any
		if *outletID != "" {
			o = *outletID
		}
		if _, err := tx.Exec(ctx, `UPDATE users SET outlet_id=$1 WHERE id=$2`, o, id); err != nil {
			return err
		}
	}
	if photo != nil {
		if _, err := tx.Exec(ctx, `UPDATE users SET photo_url=$1 WHERE id=$2`, *photo, id); err != nil {
			return err
		}
	}
	if perms != nil {
		if _, err := tx.Exec(ctx, `DELETE FROM user_permissions WHERE user_id=$1`, id); err != nil {
			return err
		}
		for _, p := range *perms {
			if _, err := tx.Exec(ctx,
				`INSERT INTO user_permissions (user_id, permission) VALUES ($1,$2)`, id, p); err != nil {
				return err
			}
		}
	}
	var newVersion int64
	if rightsChanged {
		if newVersion, err = bumpPermVersion(ctx, tx, id); err != nil {
			return err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	if rightsChanged && s.Versions != nil {
		s.Versions.Publish(ctx, id, newVersion)
	}
	return nil
}

// bumpPermVersion raises the user's rights version inside the caller's transaction.
func bumpPermVersion(ctx context.Context, tx pgx.Tx, id string) (int64, error) {
	var v int64
	err := tx.QueryRow(ctx,
		`UPDATE users SET perm_version=perm_version+1 WHERE id=$1 RETURNING perm_version`, id).Scan(&v)
	return v, err
}

// sameSet reports whether a and b hold the same strings, ignoring order and duplicates.
func sameSet(a, b []string) bool {
	ma := make(map[string]struct{}, len(a))
	for _, x := range a {
		ma[x] = struct{}{}
	}
	mb := make(map[string]struct{}, len(b))
	for _, x := range b {
		mb[x] = struct{}{}
	}
	if len(ma) != len(mb) {
		return false
	}
	for x := range ma {
		if _, ok := mb[x]; !ok {
			return false
		}
	}
	return true
}

// SetReceivePin hashes and stores a user's receive-approval PIN (argon2id, same
// format as the password). Empty pin clears it. Either way (A08) the user's PIN
// lockouts are cleared in the same transaction, and outstanding approval grants are
// revoked implicitly because receive_pin_set_at changes.
func (s *Store) SetReceivePin(ctx context.Context, userID, pin string) error {
	if pin == "" {
		return s.ClearReceivePin(ctx, userID)
	}
	hash, err := rules.HashPassword(pin)
	if err != nil {
		return err
	}
	return s.updatePinClearingLockouts(ctx, userID,
		`UPDATE users SET receive_pin_hash=$1, receive_pin_set_at=now() WHERE id=$2`, hash, userID)
}

func (s *Store) ClearReceivePin(ctx context.Context, userID string) error {
	return s.updatePinClearingLockouts(ctx, userID,
		`UPDATE users SET receive_pin_hash=NULL, receive_pin_set_at=NULL WHERE id=$1`, userID)
}

func (s *Store) updatePinClearingLockouts(ctx context.Context, userID, sql string, args ...any) error {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, sql, args...); err != nil {
		return err
	}
	if err := clearReceiveLockouts(ctx, tx, userID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func clearReceiveLockouts(ctx context.Context, tx pgx.Tx, userID string) error {
	if _, err := tx.Exec(ctx, `DELETE FROM receive_pin_lockouts WHERE user_id=$1`, userID); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `INSERT INTO receive_pin_attempts(approver_id, outcome) VALUES($1,'reset')`, userID)
	return err
}

// ClearReceiveLockouts clears both the approver and requester receive-PIN lockouts of
// a user without touching the PIN (admin unlock). ErrNotFound when the user is gone.
func (s *Store) ClearReceiveLockouts(ctx context.Context, userID string) error {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var one int
	if err := tx.QueryRow(ctx, `SELECT 1 FROM users WHERE id=$1`, userID).Scan(&one); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		return err
	}
	if err := clearReceiveLockouts(ctx, tx, userID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// DeleteUser removes a user (cascades permissions/outlets/refresh tokens).
func (s *Store) DeleteUser(ctx context.Context, id string) error {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var one int
	err = tx.QueryRow(ctx, `SELECT 1 FROM users WHERE id=$1 FOR UPDATE`, id).Scan(&one)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	open, err := hasOpenShift(ctx, tx, id)
	if err != nil {
		return err
	}
	if open {
		return ErrOpenShiftDelete
	}
	if _, err := tx.Exec(ctx, `DELETE FROM users WHERE id=$1`, id); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	if s.Versions != nil {
		s.Versions.PublishDeleted(ctx, id)
	}
	return nil
}

// CreateUser inserts a user with hashed password and permission rows.
func (s *Store) CreateUser(ctx context.Context, email, password, name, role, outletID string, perms []string) (string, error) {
	hash, err := rules.HashPassword(password)
	if err != nil {
		return "", err
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)

	var id string
	var outlet any
	if outletID != "" {
		outlet = outletID
	}
	err = tx.QueryRow(ctx,
		`INSERT INTO users (email, password_hash, display_name, role, outlet_id)
		 VALUES ($1,$2,$3,$4,$5) RETURNING id`,
		email, hash, name, role, outlet,
	).Scan(&id)
	if err != nil {
		return "", err
	}
	for _, p := range perms {
		if _, err := tx.Exec(ctx,
			`INSERT INTO user_permissions (user_id, permission) VALUES ($1,$2)`,
			id, p); err != nil {
			return "", err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return id, nil
}

// ResetResult is what an admin password reset reports about the target user.
type ResetResult struct {
	Email string
	Role  string
	// JTIs are the user's unexpired refresh jtis (including already-revoked
	// ones from the last hour, so a retry after a failed Redis cleanup still
	// finds them; the marker covers older rotated rows).
	JTIs []string
}

// ResetPassword sets a new password hash for the user and revokes every
// refresh_tokens row in one transaction (users row first: the same lock order
// as login/rotation, which hold users FOR SHARE before touching token rows). ErrNotFound when the user is gone.
func (s *Store) ResetPassword(ctx context.Context, id, hash string) (ResetResult, error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return ResetResult{}, err
	}
	defer tx.Rollback(ctx)

	var res ResetResult
	var newVersion int64
	err = tx.QueryRow(ctx,
		`UPDATE users SET password_hash=$1, refresh_revoked_before=now(), perm_version=perm_version+1
		  WHERE id=$2 RETURNING email, role, perm_version`, hash, id,
	).Scan(&res.Email, &res.Role, &newVersion)
	if errors.Is(err, pgx.ErrNoRows) {
		return ResetResult{}, ErrNotFound
	}
	if err != nil {
		return ResetResult{}, err
	}
	// COALESCE keeps the revoke reason/time of rows already rotated or logged out.
	rows, err := tx.Query(ctx,
		`UPDATE refresh_tokens SET revoked=true,
		        revoked_at=COALESCE(revoked_at, now()), revoke_reason=COALESCE(revoke_reason, 'reset')
		  WHERE user_id=$1 AND expires_at>now()
		    AND (NOT revoked OR created_at > now() - interval '1 hour') RETURNING jti`, id)
	if err != nil {
		return ResetResult{}, err
	}
	for rows.Next() {
		var j string
		if err := rows.Scan(&j); err != nil {
			rows.Close()
			return ResetResult{}, err
		}
		res.JTIs = append(res.JTIs, j)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return ResetResult{}, err
	}
	// Rows already expired stay as they are; they cannot be exchanged anyway.
	if _, err := tx.Exec(ctx,
		`UPDATE refresh_tokens SET revoked=true, revoked_at=COALESCE(revoked_at, now()),
		        revoke_reason=COALESCE(revoke_reason, 'reset')
		  WHERE user_id=$1 AND NOT revoked`, id); err != nil {
		return ResetResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ResetResult{}, err
	}
	if s.Versions != nil {
		s.Versions.Publish(ctx, id, newVersion)
	}
	return res, nil
}
