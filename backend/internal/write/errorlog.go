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
