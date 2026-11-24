package read

import (
	"context"

	"github.com/mandalika/pos-backend/internal/api"
)

// ReceiveApprovingUsers returns the users who may approve a transfer receive at
// a given outlet: role ∈ receive_approver_roles OR role = 'admin', scoped to
// the outlet's coverage (admin, all-outlets manager, home or an extra outlet of a manager with a home; mirrors coverage.Of), and must have a PIN set. The hash itself is
// never returned (A08): the PIN is verified on the server only.
func (r *Repo) ReceiveApprovingUsers(ctx context.Context, outletID string) ([]api.ReceiveApprover, error) {
	sql := `SELECT json_build_object(
	    'userId', u.id, 'displayName', u.display_name),
	    count(*) OVER() AS total
	  FROM users u LEFT JOIN app_settings s ON s.id = 1
	  WHERE u.receive_pin_hash IS NOT NULL AND u.receive_pin_set_at IS NOT NULL
	    AND (u.role = ANY (COALESCE(s.receive_approver_roles, '{}')) OR u.role = 'admin')
	    AND (u.role = 'admin' OR u.outlet_id = $1
         OR (u.role = 'manager' AND u.all_outlets)
         OR (u.role = 'manager' AND u.outlet_id IS NOT NULL AND EXISTS (
               SELECT 1 FROM user_outlets uo WHERE uo.user_id = u.id AND uo.outlet_id = $1)))
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

// userObj mirrors coverage.Of (the rule behind auth.User): outletIds is the ENFORCED
// coverage, home first, and allOutlets is true only for an all-outlets manager. Admin, an
// all-outlets manager and a manager without a home show []; a cashier shows [home] whatever
// user_outlets holds. Keep it in step with coverage.Of; the OCV gate compares the two.
const userObj = `json_build_object('id',u.id,'email',u.email,
  'displayName',u.display_name,'role',u.role,'outletId',u.outlet_id,
  'allOutlets',(u.role='manager' AND u.all_outlets),
  'outletIds',CASE
    WHEN u.role='admin' OR u.outlet_id IS NULL OR (u.role='manager' AND u.all_outlets) THEN '[]'::jsonb
    WHEN u.role='manager' THEN to_jsonb(ARRAY[u.outlet_id]) || COALESCE((SELECT jsonb_agg(uo.outlet_id ORDER BY uo.outlet_id)
      FROM user_outlets uo WHERE uo.user_id=u.id AND uo.outlet_id<>u.outlet_id),'[]'::jsonb)
    WHEN u.role='cashier' THEN to_jsonb(ARRAY[u.outlet_id])
    ELSE '[]'::jsonb END,
  'photoURL',u.photo_url,'createdAt',u.created_at,
  'permissions',COALESCE((SELECT json_agg(permission)
    FROM user_permissions WHERE user_id=u.id),'[]'::json))`

func (r *Repo) Users(ctx context.Context, page, limit int) ([]api.User, int, error) {
	return listJSON[api.User](ctx, r.Pool,
		`SELECT `+userObj+`, count(*) OVER() AS total
		   FROM users u ORDER BY u.created_at DESC, u.id DESC LIMIT $1 OFFSET $2`,
		limit, off(page, limit))
}

func (r *Repo) User(ctx context.Context, id string) (api.User, error) {
	return oneJSON[api.User](ctx, r.Pool,
		`SELECT `+userObj+` FROM users u WHERE u.id=$1`, id)
}
