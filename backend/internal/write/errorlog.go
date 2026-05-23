package write

import (
	"context"
	"time"
)

// ErrorLog is one captured error (POS sync/runtime/print or backend panic).
type ErrorLog struct {
	OutletID        string
	OutletName      string
	DeviceID        string
	UserID          string
	UserName        string
	Source          string
	Kind            string
	Action          string
	Message         string
	Payload         []byte // raw JSON
	Breadcrumbs     []byte // raw JSON array
	AppVersion      string
	ClientCreatedAt *time.Time
}

// InsertErrorLogs records errors. Best-effort, no content-version bump (not
// reference data). Rows missing source/message are skipped.
func (r *Repo) InsertErrorLogs(ctx context.Context, logs []ErrorLog) error {
	for _, l := range logs {
		if l.Source == "" || l.Message == "" {
			continue
		}
		if _, err := r.Pool.Exec(ctx, `
			INSERT INTO error_logs (outlet_id, outlet_name, device_id, user_id,
			  user_name, source, kind, action, message, payload, breadcrumbs,
			  app_version, client_created_at)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13)`,
			elNullUUID(l.OutletID), elNullStr(l.OutletName), elNullStr(l.DeviceID),
			elNullStr(l.UserID), elNullStr(l.UserName), l.Source, elNullStr(l.Kind),
			elNullStr(l.Action), l.Message, elNullBytes(l.Payload), elNullBytes(l.Breadcrumbs),
			elNullStr(l.AppVersion), l.ClientCreatedAt,
		); err != nil {
			return err
		}
	}
	return nil
}

func elNullStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func elNullUUID(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func elNullBytes(b []byte) any {
	if len(b) == 0 {
		return nil
	}
	return b
}
