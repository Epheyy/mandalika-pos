package write

import (
	"context"
	"encoding/json"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/mandalika/pos-backend/internal/redact"
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

// Caps applied to every stored error log. Redaction and these limits live here
// (not in the HTTP handler) so the panic recoverer, and POS bundles that have
// not yet shipped on-device redaction, are covered too (A37).
const (
	maxELMessageRunes = 2000
	maxELActionRunes  = 500
	maxELShortRunes   = 200
	maxELJSONBytes    = 128 << 10
)

var elInvalidJSON = []byte(`{"_invalid":true}`)

func elClip(s string, max int) string {
	s = strings.ReplaceAll(s, "\x00", "")
	if utf8.RuneCountInString(s) <= max {
		return s
	}
	return string([]rune(s)[:max])
}

func elRedactJSON(raw []byte) []byte {
	if len(raw) == 0 {
		return nil
	}
	if len(raw) > maxELJSONBytes {
		b, _ := json.Marshal(map[string]any{"_truncated": true, "bytes": len(raw)})
		return b
	}
	out, err := redact.JSON(raw, redact.Logs)
	if err != nil {
		return elInvalidJSON
	}
	return out
}

// redactErrorLog returns a scrubbed copy of l (the input is not modified).
// It never panics: if redaction itself fails, the free-text and JSON fields
// are dropped rather than stored raw.
func redactErrorLog(l ErrorLog) (out ErrorLog) {
	defer func() {
		if rec := recover(); rec != nil {
			out = l
			out.Message, out.Action = "[redaction failed]", ""
			out.Payload, out.Breadcrumbs = nil, nil
			out.OutletName, out.DeviceID, out.UserName, out.Kind, out.AppVersion = "", "", "", "", ""
		}
	}()
	out = l
	out.Message = elClip(redact.String(l.Message, redact.Logs), maxELMessageRunes)
	out.Action = elClip(redact.String(l.Action, redact.Logs), maxELActionRunes)
	out.Kind = elClip(redact.String(l.Kind, redact.Logs), maxELShortRunes)
	out.OutletName = elClip(l.OutletName, maxELShortRunes)
	out.DeviceID = elClip(l.DeviceID, maxELShortRunes)
	out.UserName = elClip(l.UserName, maxELShortRunes)
	out.Source = elClip(l.Source, 32)
	out.AppVersion = elClip(l.AppVersion, maxELShortRunes)
	out.Payload = elRedactJSON(l.Payload)
	out.Breadcrumbs = elRedactJSON(l.Breadcrumbs)
	return out
}

// InsertErrorLogs records errors in one transaction (a failing row leaves no
// partial batch). Every row is redacted first. Best-effort, no content-version
// bump (not reference data). Rows missing source/message are skipped.
func (r *Repo) InsertErrorLogs(ctx context.Context, logs []ErrorLog) error {
	rows := make([]ErrorLog, 0, len(logs))
	for _, l := range logs {
		if l.Source == "" || l.Message == "" {
			continue
		}
		rows = append(rows, redactErrorLog(l))
	}
	if len(rows) == 0 {
		return nil
	}
	tx, err := r.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	for _, l := range rows {
		if _, err := tx.Exec(ctx, `
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
	return tx.Commit(ctx)
}

// ErrorLogRetentionDays is how long error_logs rows live (HANDOFF decision 2026-10-17).
// read.ErrorLogRetentionDays must match (a handlers test pins this).
const ErrorLogRetentionDays = 60

// ErrorLogSweepLockKey serializes retention sweeps across instances (advisory lock).
const ErrorLogSweepLockKey int64 = 0x656c4c4f47535745 // "elLOGSWE"

// SweepErrorLogs deletes error_logs rows older than the retention window, in
// short batches. Each batch is its own transaction holding a transaction-level
// advisory lock; if another instance holds it the sweep is skipped (not an
// error). It stops after maxBatches batches or the first short batch.
func (r *Repo) SweepErrorLogs(ctx context.Context, batch, maxBatches int) (deleted int64, skipped bool, err error) {
	for i := 0; i < maxBatches; i++ {
		n, got, err := r.sweepErrorLogBatch(ctx, batch)
		if err != nil {
			return deleted, false, err
		}
		if !got {
			return deleted, true, nil
		}
		deleted += n
		if n < int64(batch) {
			break
		}
	}
	return deleted, false, nil
}

func (r *Repo) sweepErrorLogBatch(ctx context.Context, batch int) (n int64, locked bool, err error) {
	tx, err := r.Pool.Begin(ctx)
	if err != nil {
		return 0, false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := tx.QueryRow(ctx, `SELECT pg_try_advisory_xact_lock($1)`, ErrorLogSweepLockKey).Scan(&locked); err != nil {
		return 0, false, err
	}
	if !locked {
		return 0, false, nil
	}
	ct, err := tx.Exec(ctx, `
		DELETE FROM error_logs WHERE id IN (
		  SELECT id FROM error_logs
		  WHERE created_at < now() - make_interval(days => $1)
		  ORDER BY created_at LIMIT $2)`, ErrorLogRetentionDays, batch)
	if err != nil {
		return 0, true, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, true, err
	}
	return ct.RowsAffected(), true, nil
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
