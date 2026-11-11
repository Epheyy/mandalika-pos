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
	sql, args := errorLogsPageSQL(outletID, source, from, to, page, limit)
	return pagedCountJSON[api.ErrorLog](ctx, r.Pool, sql, args...)
}

// errorLogsPageSQL builds the id-first statement (see orderPageSQL): the payload and breadcrumbs
// JSON is only built for the page's rows, and the total comes from the same statement.
func errorLogsPageSQL(outletID, source, from, to string, page, limit int) (string, []any) {
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
	sql := fmt.Sprintf(`WITH t AS (SELECT count(*) AS n FROM error_logs e%[1]s),
	     pg AS (SELECT e.id, e.created_at FROM error_logs e%[1]s
	             ORDER BY e.created_at DESC, e.id DESC LIMIT $%[2]d OFFSET $%[3]d)
	SELECT CASE WHEN pg.id IS NULL THEN NULL ELSE %[4]s END, t.n
	  FROM t LEFT JOIN pg ON true LEFT JOIN error_logs e ON e.id = pg.id
	 ORDER BY pg.created_at DESC, pg.id DESC`,
		cond, len(args)-1, len(args), errorLogObj)
	return sql, args
}
