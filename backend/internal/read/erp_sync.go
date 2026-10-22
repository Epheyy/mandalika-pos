package read

import (
	"context"
	"time"
)

// ErpSyncRun is one erp_sync_runs row (a catalog pull of one resource).
type ErpSyncRun struct {
	ID         string     `json:"id"`
	Resource   string     `json:"resource"`
	Mode       string     `json:"mode"`
	StartedAt  time.Time  `json:"startedAt"`
	FinishedAt *time.Time `json:"finishedAt"`
	Pages      *int       `json:"pages"`
	Upserted   *int       `json:"upserted"`
	Tombstoned *int       `json:"tombstoned"`
	Status     string     `json:"status"`
	Error      *string    `json:"error"`
}

// ErpWatermark is one integration_watermarks row (per pulled resource).
type ErpWatermark struct {
	Resource       string     `json:"resource"`
	Watermark      *time.Time `json:"watermark"`
	LastFullSyncAt *time.Time `json:"lastFullSyncAt"`
	LastRunAt      *time.Time `json:"lastRunAt"`
	LastStatus     *string    `json:"lastStatus"`
	LastError      *string    `json:"lastError"`
}

// ErpSyncRuns returns the newest catalog-pull runs (limit already clamped by the
// caller) and every watermark row, for the ops view.
func (r *Repo) ErpSyncRuns(ctx context.Context, limit int) ([]ErpSyncRun, []ErpWatermark, error) {
	rows, err := r.Pool.Query(ctx,
		`SELECT id::text, resource, mode, started_at, finished_at, pages, upserted, tombstoned, status, error
		   FROM erp_sync_runs ORDER BY started_at DESC, id LIMIT $1`, limit)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	runs := []ErpSyncRun{}
	for rows.Next() {
		var x ErpSyncRun
		if err := rows.Scan(&x.ID, &x.Resource, &x.Mode, &x.StartedAt, &x.FinishedAt, &x.Pages,
			&x.Upserted, &x.Tombstoned, &x.Status, &x.Error); err != nil {
			return nil, nil, err
		}
		runs = append(runs, x)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}

	wrows, err := r.Pool.Query(ctx,
		`SELECT resource, watermark, last_full_sync_at, last_run_at, last_status, last_error
		   FROM integration_watermarks ORDER BY resource`)
	if err != nil {
		return nil, nil, err
	}
	defer wrows.Close()
	marks := []ErpWatermark{}
	for wrows.Next() {
		var x ErpWatermark
		if err := wrows.Scan(&x.Resource, &x.Watermark, &x.LastFullSyncAt, &x.LastRunAt, &x.LastStatus, &x.LastError); err != nil {
			return nil, nil, err
		}
		marks = append(marks, x)
	}
	return runs, marks, wrows.Err()
}
