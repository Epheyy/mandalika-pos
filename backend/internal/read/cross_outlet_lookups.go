package read

import (
	"context"
	"fmt"
	"time"

	"github.com/mandalika/pos-backend/internal/api"
)

// CrossOutletLookupFilter narrows the head-office lookup log. Zero values mean "no filter".
type CrossOutletLookupFilter struct {
	UserID, OutletID string
	From, To         *time.Time // From inclusive, To exclusive
}

const crossOutletLookupObj = `json_build_object('id',l.id,'createdAt',l.created_at,'userId',l.user_id,
  'userName',COALESCE(NULLIF(l.user_name,''),NULLIF(u.display_name,''),''),'outletId',l.outlet_id,
  'outletName',COALESCE(ou.name,''),'deviceId',l.device_id,'queryKind',l.query_kind,
  'queryValue',l.query_value,'resultCount',l.result_count,'rateLimited',l.rate_limited)`

// CrossOutletLookups lists the A18 lookup log, newest first (admin).
func (r *Repo) CrossOutletLookups(ctx context.Context, f CrossOutletLookupFilter, page, limit int) ([]api.CrossOutletLookupLog, int, error) {
	args := []any{}
	cond := " WHERE true"
	add := func(clause string, val any) {
		args = append(args, val)
		cond += " AND " + fmt.Sprintf(clause, len(args))
	}
	if f.UserID != "" {
		add("l.user_id=$%d::uuid", f.UserID)
	}
	if f.OutletID != "" {
		add("l.outlet_id=$%d::uuid", f.OutletID)
	}
	if f.From != nil {
		add("l.created_at >= $%d", *f.From)
	}
	if f.To != nil {
		add("l.created_at < $%d", *f.To)
	}
	args = append(args, limit, off(page, limit))
	sql := fmt.Sprintf(`WITH t AS (SELECT count(*) AS n FROM cross_outlet_lookups l%[1]s),
	     pg AS (SELECT l.id, l.created_at FROM cross_outlet_lookups l%[1]s
	             ORDER BY l.created_at DESC, l.id DESC LIMIT $%[2]d OFFSET $%[3]d)
	SELECT CASE WHEN pg.id IS NULL THEN NULL ELSE %[4]s END, t.n
	  FROM t LEFT JOIN pg ON true
	  LEFT JOIN cross_outlet_lookups l ON l.id = pg.id
	  LEFT JOIN users u ON u.id = l.user_id
	  LEFT JOIN outlets ou ON ou.id = l.outlet_id
	 ORDER BY pg.created_at DESC, pg.id DESC`,
		cond, len(args)-1, len(args), crossOutletLookupObj)
	return pagedCountJSON[api.CrossOutletLookupLog](ctx, r.Pool, sql, args...)
}
