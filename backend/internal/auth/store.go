package auth

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type User struct {
	ID           string   `json:"id"`
	Email        string   `json:"email"`
	DisplayName  string   `json:"displayName"`
	Role         string   `json:"role"`
	OutletID     string   `json:"outletId,omitempty"`
	PhotoURL     string   `json:"photoURL,omitempty"`
	Permissions  []string `json:"permissions"`
	passwordHash string
}

var ErrNotFound = errors.New("user not found")

type Store struct{ Pool *pgxpool.Pool }

func NewStore(p *pgxpool.Pool) *Store { return &Store{Pool: p} }

func (s *Store) byEmailRow(ctx context.Context, email string) (*User, error) {
	u := &User{}
	var outlet, photo *string
	err := s.Pool.QueryRow(ctx,
		`SELECT id, email, display_name, role, outlet_id, photo_url, password_hash
		   FROM users WHERE email = $1`, email,
	).Scan(&u.ID, &u.Email, &u.DisplayName, &u.Role, &outlet, &photo, &u.passwordHash)
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
	u.Permissions = s.permissions(ctx, u.ID)
	return u, nil
}

func (s *Store) ByID(ctx context.Context, id string) (*User, error) {
	u := &User{}
	var outlet, photo *string
	err := s.Pool.QueryRow(ctx,
		`SELECT id, email, display_name, role, outlet_id, photo_url
		   FROM users WHERE id = $1`, id,
	).Scan(&u.ID, &u.Email, &u.DisplayName, &u.Role, &outlet, &photo)
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
	u.Permissions = s.permissions(ctx, u.ID)
	return u, nil
}

func (s *Store) permissions(ctx context.Context, uid string) []string {
	rows, err := s.Pool.Query(ctx,
		`SELECT permission FROM user_permissions WHERE user_id = $1`, uid)
	if err != nil {
		return []string{}
	}
	defer rows.Close()
	perms := []string{}
	for rows.Next() {
		var p string
		if rows.Scan(&p) == nil {
			perms = append(perms, p)
		}
	}
	return perms
}

func (s *Store) Authenticate(ctx context.Context, email, password string) (*User, error) {
	u, err := s.byEmailRow(ctx, email)
	if err != nil {
		return nil, err
	}
	ok, err := VerifyPassword(password, u.passwordHash)
	if err != nil || !ok {
		return nil, ErrNotFound
	}
	return u, nil
}

// UpdateUser patches mutable fields; only non-nil args are applied. perms,
// when non-nil, replaces the permission set. password, when non-empty, rehashes.
func (s *Store) UpdateUser(ctx context.Context, id string, name, role, outletID, photo, password *string, perms *[]string) error {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

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
	if password != nil && *password != "" {
		hash, err := HashPassword(*password)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE users SET password_hash=$1 WHERE id=$2`, hash, id); err != nil {
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
	return tx.Commit(ctx)
}

// SetReceivePin hashes and stores a user's receive-approval PIN (argon2id, same
// format as the password). Empty pin clears it.
func (s *Store) SetReceivePin(ctx context.Context, userID, pin string) error {
	if pin == "" {
		return s.ClearReceivePin(ctx, userID)
	}
	hash, err := HashPassword(pin)
	if err != nil {
		return err
	}
	_, err = s.Pool.Exec(ctx,
		`UPDATE users SET receive_pin_hash=$1, receive_pin_set_at=now() WHERE id=$2`,
		hash, userID)
	return err
}

func (s *Store) ClearReceivePin(ctx context.Context, userID string) error {
	_, err := s.Pool.Exec(ctx,
		`UPDATE users SET receive_pin_hash=NULL, receive_pin_set_at=NULL WHERE id=$1`, userID)
	return err
}

// DeleteUser removes a user (cascades permissions/outlets/refresh tokens).
func (s *Store) DeleteUser(ctx context.Context, id string) error {
	ct, err := s.Pool.Exec(ctx, `DELETE FROM users WHERE id=$1`, id)
	if err != nil {
		return err
	}
	if ct.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// CreateUser inserts a user with hashed password and permission rows.
func (s *Store) CreateUser(ctx context.Context, email, password, name, role, outletID string, perms []string) (string, error) {
	hash, err := HashPassword(password)
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
}

// ResetPassword sets a new password hash for the user and revokes every
// refresh_tokens row in one transaction. ErrNotFound when the user is gone.
func (s *Store) ResetPassword(ctx context.Context, id, hash string) (ResetResult, error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return ResetResult{}, err
	}
	defer tx.Rollback(ctx)

	var res ResetResult
	err = tx.QueryRow(ctx,
		`UPDATE users SET password_hash=$1 WHERE id=$2 RETURNING email, role`, hash, id,
	).Scan(&res.Email, &res.Role)
	if errors.Is(err, pgx.ErrNoRows) {
		return ResetResult{}, ErrNotFound
	}
	if err != nil {
		return ResetResult{}, err
	}
	if _, err := tx.Exec(ctx,
		`UPDATE refresh_tokens SET revoked=true WHERE user_id=$1 AND revoked=false`, id); err != nil {
		return ResetResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ResetResult{}, err
	}
	return res, nil
}

// ActiveRefreshJTIs lists the user's unrevoked, unexpired refresh jtis so the
// matching Redis keys can be deleted.
func (s *Store) ActiveRefreshJTIs(ctx context.Context, userID string) ([]string, error) {
	rows, err := s.Pool.Query(ctx,
		`SELECT jti FROM refresh_tokens WHERE user_id=$1 AND revoked=false AND expires_at>now()`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var j string
		if err := rows.Scan(&j); err != nil {
			return nil, err
		}
		out = append(out, j)
	}
	return out, rows.Err()
}
