package auth

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
)

// Postgres is the refresh-token authority. Every issue / rotation / logout /
// reset is one transaction with the lock order users -> refresh_tokens:
//   - login and rotation: users FOR SHARE (conflicts with reset's UPDATE users
//     and with logout's FOR NO KEY UPDATE, never with each other);
//   - logout: users FOR NO KEY UPDATE, then the family's rows;
//   - reset: UPDATE users, then the user's rows.
// A fixed order cannot deadlock.

var (
	// ErrCredentialsChanged: the password hash changed between authentication and
	// issuing (a concurrent admin reset won). Login answers 401.
	ErrCredentialsChanged = errors.New("credentials changed")
	// ErrRefreshRejected is the definitive "no" for a refresh token (401).
	ErrRefreshRejected = errors.New("refresh token rejected")
	// ErrAdoptionUnavailable: a legacy (rowless) token could not be judged because
	// Redis is unreachable. The caller answers 503 and keeps the session.
	ErrAdoptionUnavailable = errors.New("legacy session verdict unavailable")

	errNoSessionRow = errors.New("no session row")
)

// Session is one refresh token as stored: second-truncated iat/exp, identical to
// the values signed into the JWT.
type Session struct {
	JTI       string
	IssuedAt  time.Time
	ExpiresAt time.Time
}

// AdoptFunc decides whether a refresh token that has NO row at all may be
// adopted into Postgres (D4). It is never consulted when any row exists.
type AdoptFunc func(ctx context.Context, rc *RefreshClaims) (bool, error)

type RotateInput struct {
	Claims *RefreshClaims
	New    Session // successor to use when this call wins the claim
	Adopt  AdoptFunc
}

type RotateResult struct {
	User    *User
	Session Session // the refresh session to hand out (new, or the re-minted successor)
	Remint  bool    // true when an earlier successor was re-minted, nothing written
}

// IssueSession persists a login session. The caller signs tokens only after it
// returns nil, so a token is never handed out without a durable row.
func (s *Store) IssueSession(ctx context.Context, u *User, verifiedHash string, sess Session) error {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	var hash string
	err = tx.QueryRow(ctx, `SELECT password_hash FROM users WHERE id=$1 FOR SHARE`, u.ID).Scan(&hash)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if hash != verifiedHash {
		return ErrCredentialsChanged
	}
	if _, err := tx.Exec(ctx,
		`DELETE FROM refresh_tokens WHERE user_id=$1 AND expires_at < now() - interval '1 day'`, u.ID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO refresh_tokens (jti, user_id, family_id, created_at, expires_at) VALUES ($1,$2,$1,$3,$4)`,
		sess.JTI, u.ID, sess.IssuedAt, sess.ExpiresAt); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// RotateSession exchanges a refresh token for its successor atomically.
// Errors: ErrRefreshRejected (401), ErrNotFound (user gone, 401),
// ErrAdoptionUnavailable and any other error (503).
func (s *Store) RotateSession(ctx context.Context, in RotateInput) (*RotateResult, error) {
	res, err := s.rotateTx(ctx, in, false)
	if !errors.Is(err, errNoSessionRow) {
		return res, err
	}
	// No row at all for this jti: a legacy token whose only record is in Redis.
	// The Redis reads happen outside any transaction.
	if in.Adopt == nil {
		return nil, ErrRefreshRejected
	}
	ok, err := in.Adopt(ctx, in.Claims)
	if err != nil {
		return nil, err
	}
	if !ok {
		// A concurrent adoption of the same token may have committed (and its
		// Redis mirror deleted the legacy key) between our first look and the
		// Redis read: look at Postgres again before concluding "no".
		res, err = s.rotateTx(ctx, in, false)
		if errors.Is(err, errNoSessionRow) {
			return nil, ErrRefreshRejected
		}
		return res, err
	}
	res, err = s.rotateTx(ctx, in, true)
	if errors.Is(err, errNoSessionRow) {
		return nil, ErrRefreshRejected
	}
	return res, err
}

func (s *Store) rotateTx(ctx context.Context, in RotateInput, adopt bool) (*RotateResult, error) {
	rc := in.Claims
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	var revokedBefore *time.Time
	u, err := scanUser(ctx, tx, tx.QueryRow(ctx,
		`SELECT id, email, display_name, role, outlet_id, photo_url, refresh_revoked_before
		   FROM users WHERE id=$1 FOR SHARE`, rc.UserID), &revokedBefore)
	if err != nil {
		return nil, err // ErrNotFound -> 401, anything else -> 503
	}

	if adopt {
		// Legacy tokens only ever predate this deploy; a reset recorded in
		// Postgres at or after their iat kills them (fail closed).
		if rc.IssuedAt == nil || (revokedBefore != nil && rc.IssuedAt.Unix() <= revokedBefore.Unix()) {
			return nil, ErrRefreshRejected
		}
		var exp time.Time
		if rc.ExpiresAt != nil {
			exp = rc.ExpiresAt.Time
		}
		// Bare ON CONFLICT DO NOTHING (every unique index arbitrates): a concurrent
		// adoption of the same token also collides on refresh_tokens_live_head_uidx,
		// and naming only (jti) would surface that as a 23505 instead of a no-op.
		// The normal claim / re-mint logic below then decides from the committed state.
		if _, err := tx.Exec(ctx,
			`INSERT INTO refresh_tokens (jti, user_id, family_id, created_at, expires_at)
			 VALUES ($1,$2,$1,$3,$4) ON CONFLICT DO NOTHING`,
			rc.ID, rc.UserID, rc.IssuedAt.Time, exp); err != nil {
			return nil, err
		}
	}

	var family string
	var createdAt time.Time
	err = tx.QueryRow(ctx,
		`UPDATE refresh_tokens
		    SET revoked=true, revoked_at=now(), revoke_reason='rotated', replaced_by=$3
		  WHERE jti=$1 AND user_id=$2 AND NOT revoked AND expires_at>now()
		  RETURNING COALESCE(family_id, jti), created_at`,
		rc.ID, rc.UserID, in.New.JTI).Scan(&family, &createdAt)
	if err == nil {
		if _, err := tx.Exec(ctx,
			`INSERT INTO refresh_tokens (jti, user_id, family_id, created_at, expires_at) VALUES ($1,$2,$3,$4,$5)`,
			in.New.JTI, rc.UserID, family, in.New.IssuedAt, in.New.ExpiresAt); err != nil {
			return nil, err // rolls the claim back too: X is never revoked without a successor
		}
		if err := tx.Commit(ctx); err != nil {
			return nil, err
		}
		return &RotateResult{User: u, Session: in.New}, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}

	// Zero rows claimed: decide from the row itself (looked up by jti ALONE, so a
	// revoked, expired or foreign row can never look absent and be adopted).
	var owner string
	var revoked bool
	var replacedBy *string
	var revokedAgeSec *float64
	err = tx.QueryRow(ctx,
		`SELECT user_id, revoked, replaced_by,
		        CASE WHEN revoked_at IS NULL THEN NULL ELSE extract(epoch FROM now() - revoked_at)::float8 END
		   FROM refresh_tokens WHERE jti=$1`, rc.ID,
	).Scan(&owner, &revoked, &replacedBy, &revokedAgeSec)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errNoSessionRow
	}
	if err != nil {
		return nil, err
	}
	if owner != rc.UserID || !revoked {
		return nil, ErrRefreshRejected // foreign row, or live but expired
	}
	if replacedBy != nil {
		var succ Session
		err = tx.QueryRow(ctx,
			`SELECT jti, created_at, expires_at FROM refresh_tokens
			  WHERE jti=$1 AND user_id=$2 AND NOT revoked AND expires_at>now()`,
			*replacedBy, rc.UserID).Scan(&succ.JTI, &succ.IssuedAt, &succ.ExpiresAt)
		if err == nil {
			// Immediate predecessor replay (lost response, lost write, or the
			// loser of a concurrent refresh): hand out the SAME successor. The
			// age since the predecessor was revoked shows how stale replays are
			// (no token values are logged).
			age := "unknown"
			if revokedAgeSec != nil {
				age = (time.Duration(*revokedAgeSec * float64(time.Second))).Round(time.Millisecond).String()
			}
			slog.Info("refresh_remint", "user", rc.UserID, "age", age)
			return &RotateResult{User: u, Session: succ, Remint: true}, nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return nil, err
		}
	}
	// Deep reuse, logout, reset or an old-revision revoke: refuse this request
	// only. The family is deliberately NOT revoked (see plan risk 2).
	slog.Warn("refresh_reuse_detected", "user", rc.UserID, "jti", rc.ID)
	return nil, ErrRefreshRejected
}

// RevokeInput describes a logout. Legacy is the same Redis verdict used for
// adoption: it decides whether a token with NO row at all is a genuine legacy
// session that must be tombstoned.
type RevokeInput struct {
	Claims *RefreshClaims
	Legacy AdoptFunc
}

// RevokeFamily ends the whole session of the presented token. Owner decision
// 2026-10-16: ANY token of the family (its row exists and belongs to the token's
// user, revoked or not, expired-but-unswept or not) revokes every live row of
// that family. It returns the jtis it revoked.
//
// A token with no row: when the Redis verdict says it is a genuine legacy
// session, a revoked tombstone row is inserted, so a concurrent or later
// adoption of that jti can never produce a live successor. Otherwise nothing is
// written. The users row is locked FOR NO KEY UPDATE first (serializes with
// rotation's FOR SHARE, keeping the users -> refresh_tokens lock order).
func (s *Store) RevokeFamily(ctx context.Context, in RevokeInput) ([]string, error) {
	revoked, found, err := s.revokeTx(ctx, in.Claims, false)
	if err != nil || found {
		return revoked, err
	}
	if in.Legacy == nil {
		return nil, nil
	}
	// Redis is read outside any transaction.
	ok, err := in.Legacy(ctx, in.Claims)
	if err != nil {
		return nil, err
	}
	if ok {
		revoked, _, err = s.revokeTx(ctx, in.Claims, true)
		return revoked, err
	}
	// A concurrent adoption may have committed (and its mirror deleted the legacy
	// key) between our first look and the Redis read: look at Postgres again.
	revoked, _, err = s.revokeTx(ctx, in.Claims, false)
	return revoked, err
}

// revokeTx revokes the family of rc's row. found reports whether the row exists
// (and is the user's); with tombstone set, a missing row is first inserted as a
// revoked tombstone.
func (s *Store) revokeTx(ctx context.Context, rc *RefreshClaims, tombstone bool) (revoked []string, found bool, err error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return nil, false, err
	}
	defer tx.Rollback(ctx)

	var one int
	err = tx.QueryRow(ctx, `SELECT 1 FROM users WHERE id=$1 FOR NO KEY UPDATE`, rc.UserID).Scan(&one)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, true, nil // user gone: nothing to revoke, nothing to retry
	}
	if err != nil {
		return nil, false, err
	}
	if tombstone && rc.IssuedAt != nil && rc.ExpiresAt != nil {
		// Bare ON CONFLICT DO NOTHING: a concurrent adoption that committed first
		// simply wins the insert and the family revoke below ends its successor.
		if _, err := tx.Exec(ctx,
			`INSERT INTO refresh_tokens (jti, user_id, family_id, created_at, expires_at, revoked, revoked_at, revoke_reason)
			 VALUES ($1,$2,$1,$3,$4,true,now(),'logout') ON CONFLICT DO NOTHING`,
			rc.ID, rc.UserID, rc.IssuedAt.Time, rc.ExpiresAt.Time); err != nil {
			return nil, false, err
		}
	}
	var family string
	err = tx.QueryRow(ctx,
		`SELECT COALESCE(family_id, jti) FROM refresh_tokens WHERE jti=$1 AND user_id=$2`, rc.ID, rc.UserID).Scan(&family)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, false, nil // no row (or another user's row): nothing to revoke
	}
	if err != nil {
		return nil, false, err
	}
	rows, err := tx.Query(ctx,
		`UPDATE refresh_tokens SET revoked=true, revoked_at=now(), revoke_reason='logout'
		  WHERE user_id=$1 AND COALESCE(family_id, jti)=$2 AND NOT revoked RETURNING jti`, rc.UserID, family)
	if err != nil {
		return nil, false, err
	}
	for rows.Next() {
		var j string
		if err := rows.Scan(&j); err != nil {
			rows.Close()
			return nil, false, err
		}
		revoked = append(revoked, j)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, false, err
	}
	return revoked, true, nil
}

// SweepExpiredRefresh deletes at most limit rows that expired more than a day
// ago. Revoked-but-unexpired rows are kept: replay decisions need them.
func (s *Store) SweepExpiredRefresh(ctx context.Context, limit int) (int64, error) {
	ct, err := s.Pool.Exec(ctx,
		`DELETE FROM refresh_tokens WHERE jti IN (
		   SELECT jti FROM refresh_tokens WHERE expires_at < now() - interval '1 day' LIMIT $1)`, limit)
	if err != nil {
		return 0, fmt.Errorf("sweep refresh tokens: %w", err)
	}
	return ct.RowsAffected(), nil
}
