package auth

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mandalika/pos-backend/internal/apperr"
	"github.com/mandalika/pos-backend/internal/coverage"
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
	// OutletIDs is the home outlet first, then any extra outlets; [] when none.
	OutletIDs []string `json:"outletIds"`
	// AllOutlets marks a manager who covers every outlet (then OutletIDs is empty).
	AllOutlets bool `json:"allOutlets"`
	// PermVersion is users.perm_version. Never serialized: it is a token claim, not API surface.
	PermVersion  int64 `json:"-"`
	passwordHash string
}

// Coverage is the set of outlets the user may act on.
func (u *User) Coverage() coverage.Coverage {
	return coverage.Of(u.Role, u.OutletID, u.OutletIDs, u.AllOutlets)
}

var ErrNotFound = errors.New("user not found")

// Open-shift refusals (409). "Open shift" is a server-side proxy: a shifts row with
// status 'open' for the user. The check is atomic with a shift opening: the callers hold
// FOR NO KEY UPDATE on the user row and service.OpenShiftTx takes FOR SHARE on it. The
// server cannot see a shift opened offline and not yet synced, nor items still queued on
// a tablet, so this narrows the stranded-queue risk without removing it.
var (
	ErrOpenShiftDelete = apperr.New(apperr.Conflict, "Pengguna ini masih punya shift yang buka. Tutup shift-nya dulu sebelum menghapus.")
	ErrOpenShiftMove   = apperr.New(apperr.Conflict, "Pengguna ini masih punya shift yang buka. Tutup shift-nya dulu sebelum memindah outlet.")
)

// ErrOutletNotFound refuses a coverage list that names an outlet that does not exist (400).
var ErrOutletNotFound = apperr.New(apperr.Rejected, "Outlet tidak ditemukan.")

// hasOpenShiftAt reports whether the user has an open shift at any of the outlets. Call it
// inside the transaction that holds the user row lock.
func hasOpenShiftAt(ctx context.Context, q querier, uid string, outletIDs []string) (bool, error) {
	if len(outletIDs) == 0 {
		return false, nil
	}
	var open bool
	err := q.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM shifts WHERE cashier_id=$1 AND status='open' AND outlet_id = ANY($2::uuid[]))`,
		uid, outletIDs).Scan(&open)
	return open, err
}

// openShiftOutlets lists the outlets where the user has an open shift.
func openShiftOutlets(ctx context.Context, q querier, uid string) ([]string, error) {
	rows, err := q.Query(ctx,
		`SELECT DISTINCT outlet_id::text FROM shifts WHERE cashier_id=$1 AND status='open'`, uid)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// outletsExist returns ErrOutletNotFound unless every id is an existing outlet.
func outletsExist(ctx context.Context, q querier, ids []string) error {
	ids = distinctFold(ids)
	if len(ids) == 0 {
		return nil
	}
	var n int
	if err := q.QueryRow(ctx,
		`SELECT count(*) FROM outlets WHERE id = ANY($1::uuid[])`, ids).Scan(&n); err != nil {
		return err
	}
	if n != len(ids) {
		return ErrOutletNotFound
	}
	return nil
}

// distinctFold dedupes ids case-insensitively, keeping order. Never nil.
func distinctFold(ids []string) []string {
	out := []string{}
	seen := map[string]struct{}{}
	for _, id := range ids {
		k := strings.ToLower(id)
		if _, ok := seen[k]; !ok {
			seen[k] = struct{}{}
			out = append(out, id)
		}
	}
	return out
}

func lowerAll(ids []string) []string {
	out := make([]string, len(ids))
	for i, id := range ids {
		out[i] = strings.ToLower(id)
	}
	return out
}

// sameCoverage reports whether two coverages grant the same outlets.
func sameCoverage(a, b coverage.Coverage) bool {
	return a.All == b.All && sameSet(lowerAll(a.OutletIDs), lowerAll(b.OutletIDs))
}

// replaceExtras rewrites the user's user_outlets rows inside the caller's transaction.
func replaceExtras(ctx context.Context, tx pgx.Tx, id string, extras []string) error {
	if _, err := tx.Exec(ctx, `DELETE FROM user_outlets WHERE user_id=$1`, id); err != nil {
		return err
	}
	for _, o := range extras {
		if _, err := tx.Exec(ctx,
			`INSERT INTO user_outlets (user_id, outlet_id) VALUES ($1,$2)`, id, o); err != nil {
			return err
		}
	}
	return nil
}

// checkCoverageDrop refuses a change that removes an outlet where the user has an open
// shift. Adding outlets, or keeping the ones with open shifts, is fine.
func checkCoverageDrop(ctx context.Context, tx pgx.Tx, id string, from, to coverage.Coverage) error {
	if to.All {
		return nil
	}
	var removed []string
	if from.All {
		open, err := openShiftOutlets(ctx, tx, id)
		if err != nil {
			return err
		}
		for _, o := range open {
			if !to.Covers(o) {
				removed = append(removed, o)
			}
		}
	} else {
		for _, o := range from.OutletIDs {
			if !to.Covers(o) {
				removed = append(removed, o)
			}
		}
	}
	open, err := hasOpenShiftAt(ctx, tx, id, removed)
	if err != nil {
		return err
	}
	if open {
		return ErrOpenShiftMove
	}
	return nil
}

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
	var extraOutlets []string
	var allOutlets bool
	dest := append([]any{&u.ID, &u.Email, &u.DisplayName, &u.Role, &outlet, &photo, &u.PermVersion, &allOutlets, &extraOutlets}, extra...)
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
	// The wire fields mirror the ENFORCED coverage, not raw rows: a cashier's leftover
	// user_outlets or flag, or a home-less manager's extras, never surface.
	cov := coverage.Of(u.Role, u.OutletID, extraOutlets, allOutlets)
	u.AllOutlets = cov.All && u.Role == "manager"
	u.OutletIDs = []string{}
	if !cov.All && cov.OutletIDs != nil {
		u.OutletIDs = cov.OutletIDs
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
		`SELECT u.id, u.email, u.display_name, u.role, u.outlet_id, u.photo_url, u.perm_version, `+coverage.SelectCols+`, u.password_hash
		   FROM users u WHERE u.email = $1`, email), &hash)
	if err != nil {
		return nil, err
	}
	u.passwordHash = hash
	return u, nil
}

func (s *Store) ByID(ctx context.Context, id string) (*User, error) {
	return scanUser(ctx, s.Pool, s.Pool.QueryRow(ctx,
		`SELECT u.id, u.email, u.display_name, u.role, u.outlet_id, u.photo_url, u.perm_version, `+coverage.SelectCols+`
		   FROM users u WHERE u.id = $1`, id))
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
// when non-nil, replaces the permission set. outletIDs is the full coverage (home
// first) and allOutlets the all-outlets flag; omitted, they keep the values the API
// shows today. The MERGED state must pass coverage.Validate before anything is
// written. Passwords are not changed here; admins use ResetPassword.
// ErrNotFound when the user does not exist.
func (s *Store) UpdateUser(ctx context.Context, id string, name, role, outletID, photo *string, perms *[]string, outletIDs *[]string, allOutlets *bool) error {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	var curRole string
	var curOutlet *string
	var curAll bool
	var curExtras []string
	err = tx.QueryRow(ctx,
		`SELECT u.role, u.outlet_id::text, `+coverage.SelectCols+` FROM users u WHERE u.id=$1 FOR NO KEY UPDATE OF u`, id,
	).Scan(&curRole, &curOutlet, &curAll, &curExtras)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	curHome := ""
	if curOutlet != nil {
		curHome = *curOutlet
	}
	// What the API shows today is the baseline for omitted fields (the enforced coverage,
	// not leftover rows), so a request that does not touch coverage keeps what the admin sees.
	curCov := coverage.Of(curRole, curHome, curExtras, curAll)
	shownAll := curCov.All && curRole == "manager"
	shownIDs := []string{}
	if !curCov.All {
		shownIDs = curCov.OutletIDs
	}

	newRole, newHome, newAll := curRole, curHome, shownAll
	if role != nil {
		newRole = *role
	}
	if outletID != nil {
		newHome = *outletID
	}
	if allOutlets != nil {
		newAll = *allOutlets
	}
	var newIDs []string
	if outletIDs != nil {
		newIDs = *outletIDs
	} else {
		// Keep the extras the admin sees and put the (possibly new) home first.
		kept := []string{}
		for _, o := range shownIDs {
			if !strings.EqualFold(o, curHome) {
				kept = append(kept, o)
			}
		}
		newIDs = kept
		if newHome != "" {
			newIDs = append([]string{newHome}, kept...)
		}
	}
	newIDs = distinctFold(newIDs)
	if err := coverage.Validate(newRole, newHome, newIDs, newAll); err != nil {
		return err
	}
	var named []string
	if outletIDs != nil {
		named = append(named, newIDs...)
	}
	if outletID != nil && newHome != "" {
		named = append(named, newHome)
	}
	if err := outletsExist(ctx, tx, named); err != nil {
		return err
	}
	newExtras := coverage.Extras(newRole, newHome, newIDs, newAll)
	newCov := coverage.Of(newRole, newHome, newExtras, newAll)

	rightsChanged := role != nil && *role != curRole
	if outletID != nil && !strings.EqualFold(newHome, curHome) {
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
	if !sameCoverage(curCov, newCov) {
		rightsChanged = true
		if err := checkCoverageDrop(ctx, tx, id, curCov, newCov); err != nil {
			return err
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
	// Home and the flag move in one statement: the merged state above already guarantees the
	// CHECK users_all_outlets_no_home holds, so it can never surface as a 500.
	var home any
	if newHome != "" {
		home = newHome
	}
	if _, err := tx.Exec(ctx, `UPDATE users SET outlet_id=$1, all_outlets=$2 WHERE id=$3`, home, newAll, id); err != nil {
		return err
	}
	if !sameSet(lowerAll(curExtras), lowerAll(newExtras)) {
		if err := replaceExtras(ctx, tx, id, newExtras); err != nil {
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
		pctx, cancel := publishCtx(ctx)
		defer cancel()
		s.Versions.Publish(pctx, id, newVersion)
	}
	return nil
}

// publishTimeout bounds a post-commit publish.
const publishTimeout = 2 * time.Second

// publishCtx detaches a post-commit publish from the request: an aborted admin request
// must not leave Redis stale for its whole TTL after the commit already happened.
func publishCtx(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.WithoutCancel(ctx), publishTimeout)
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
		pctx, cancel := publishCtx(ctx)
		defer cancel()
		s.Versions.PublishDeleted(pctx, id)
	}
	return nil
}

// CreateUser inserts a user with hashed password, permission rows and outlet coverage
// (outletIDs is the full list, home first; allOutlets the all-outlets flag).
func (s *Store) CreateUser(ctx context.Context, email, password, name, role, outletID string, perms []string, outletIDs []string, allOutlets bool) (string, error) {
	outletIDs = distinctFold(outletIDs)
	if err := coverage.Validate(role, outletID, outletIDs, allOutlets); err != nil {
		return "", err
	}
	hash, err := rules.HashPassword(password)
	if err != nil {
		return "", err
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)

	named := append([]string{}, outletIDs...)
	if outletID != "" {
		named = append(named, outletID)
	}
	if err := outletsExist(ctx, tx, named); err != nil {
		return "", err
	}
	var id string
	var outlet any
	if outletID != "" {
		outlet = outletID
	}
	err = tx.QueryRow(ctx,
		`INSERT INTO users (email, password_hash, display_name, role, outlet_id, all_outlets)
		 VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
		email, hash, name, role, outlet, allOutlets,
	).Scan(&id)
	if err != nil {
		return "", err
	}
	if err := replaceExtras(ctx, tx, id, coverage.Extras(role, outletID, outletIDs, allOutlets)); err != nil {
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
		pctx, cancel := publishCtx(ctx)
		defer cancel()
		s.Versions.Publish(pctx, id, newVersion)
	}
	return res, nil
}
