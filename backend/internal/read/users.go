package read

import (
	"context"

	"github.com/mandalika/pos-backend/internal/api"
)

// ReceiveApprovingUsers returns the users who may approve a transfer receive at
// a given outlet: role ∈ receive_approver_roles OR role = 'admin', scoped to
// the outlet (or global for admins), and must have a PIN set. The hash itself is
// never returned (A08): the PIN is verified on the server only.
func (r *Repo) ReceiveApprovingUsers(ctx context.Context, outletID string) ([]api.ReceiveApprover, error) {
	sql := `SELECT json_build_object(
	    'userId', u.id, 'displayName', u.display_name),
	    count(*) OVER() AS total
	  FROM users u LEFT JOIN app_settings s ON s.id = 1
	  WHERE u.receive_pin_hash IS NOT NULL AND u.receive_pin_set_at IS NOT NULL
	    AND (u.role = ANY (COALESCE(s.receive_approver_roles, '{}')) OR u.role = 'admin')
	    AND (u.outlet_id = $1 OR u.role = 'admin')
	  ORDER BY u.display_name`
	rows, _, err := listJSON[api.ReceiveApprover](ctx, r.Pool, sql, outletID)
	return rows, err
}

func (r *Repo) CustomRoles(ctx context.Context) ([]api.CustomRole, int, error) {
	return listJSON[api.CustomRole](ctx, r.Pool,
		`SELECT json_build_object('id',cr.id,'name',cr.name,'createdAt',cr.created_at,
		   'permissions',COALESCE((SELECT json_agg(permission)
		     FROM custom_role_permissions WHERE role_id=cr.id),'[]'::json))
		   FROM custom_roles cr ORDER BY cr.name`)
}

const userObj = `json_build_object('id',u.id,'email',u.email,
  'displayName',u.display_name,'role',u.role,'outletId',u.outlet_id,
  'photoURL',u.photo_url,'createdAt',u.created_at,
  'permissions',COALESCE((SELECT json_agg(permission)
    FROM user_permissions WHERE user_id=u.id),'[]'::json))`

func (r *Repo) Users(ctx context.Context, page, limit int) ([]api.User, int, error) {
	return listJSON[api.User](ctx, r.Pool,
		`SELECT `+userObj+`, count(*) OVER() AS total
		   FROM users u ORDER BY u.created_at DESC LIMIT $1 OFFSET $2`,
		limit, off(page, limit))
}

func (r *Repo) User(ctx context.Context, id string) (api.User, error) {
	return oneJSON[api.User](ctx, r.Pool,
		`SELECT `+userObj+` FROM users u WHERE u.id=$1`, id)
}
