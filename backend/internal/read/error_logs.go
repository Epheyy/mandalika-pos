package read

import (
	"context"
	"fmt"

	"github.com/mandalika/pos-backend/internal/api"
)

const errorLogObj = `json_build_object('id',e.id,'outletId',e.outlet_id,
  'outletName',e.outlet_name,'deviceId',e.device_id,'userId',e.user_id,
  'userName',e.user_name,'source',e.source,'kind',e.kind,'action',e.action,
  'message',e.message,'payload',e.payload,'breadcrumbs',e.breadcrumbs,
  'appVersion',e.app_version,'clientCreatedAt',e.client_created_at,
  'createdAt',e.created_at)`

// ErrorLogRetentionDays bounds what ErrorLogs returns, so the retention policy
// holds even if the sweep lags. Must equal write.ErrorLogRetentionDays.
const ErrorLogRetentionDays = 60

// ErrorLogs lists captured errors (admin; cross-outlet), newest first, within the retention window.
func (r *Repo) ErrorLogs(ctx context.Context, outletID, source, from, to string, page, limit int) ([]api.ErrorLog, int, error) {
	args := []any{}
	cond := fmt.Sprintf(" WHERE e.created_at >= now() - interval '%d days'", ErrorLogRetentionDays)
	add := func(clause string, val any) {
		args = append(args, val)
		cond += " AND " + fmt.Sprintf(clause, len(args))
	}
	if outletID != "" {
		add("e.outlet_id=$%d", outletID)
	}
	if source != "" {
		add("e.source=$%d", source)
	}
	if from != "" {
		add("e.created_at >= $%d", from)
	}
	if to != "" {
		add("e.created_at <= $%d", to)
	}
	args = append(args, limit, off(page, limit))
	sql := fmt.Sprintf(`SELECT %s, count(*) OVER() AS total FROM error_logs e%s
	  ORDER BY e.created_at DESC, e.id DESC LIMIT $%d OFFSET $%d`,
		errorLogObj, cond, len(args)-1, len(args))
	return listJSON[api.ErrorLog](ctx, r.Pool, sql, args...)
}
