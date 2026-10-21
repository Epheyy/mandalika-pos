package read

import (
	"context"

	"github.com/mandalika/pos-backend/internal/api"
)

func (r *Repo) Outlets(ctx context.Context) ([]api.Outlet, int, error) {
	return listJSON[api.Outlet](ctx, r.Pool,
		`SELECT json_build_object('id',id,'name',name,'code',code,'address',address,
		   'phone',phone,'logoUrl',logo_url,'isActive',is_active,'timezone',timezone,'createdAt',created_at)
		   FROM outlets ORDER BY name`)
}
