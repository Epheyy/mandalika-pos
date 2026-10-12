package handlers

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/mandalika/pos-backend/internal/write"
)

// Limits for POST /sync/review-items and the resolve note (spec §4.3/§4.4).
const (
	maxReviewReports      = 200
	maxReviewKeyLen       = 200
	maxReviewCodeLen      = 40
	maxReviewTextRunes    = 1000
	maxReviewPayloadBytes = 64 << 10
	maxResolveNoteRunes   = 500
)

var reviewOpTypes = map[string]bool{
	"order": true, "refund": true, "shift_open": true, "shift_close": true,
	"cash_flow": true, "customer_create": true, "transfer_receive": true,
}

var (
	errReviewBatchSize = errors.New("items must hold 1-200 review items")
	errResolveNote     = errors.New("catatan wajib diisi (1-500 karakter)")
)

// reviewReportIn is one item of a tablet check-in, as sent.
type reviewReportIn struct {
	IdempotencyKey   string          `json:"idempotencyKey"`
	Type             string          `json:"type"`
	ReviewCode       string          `json:"reviewCode"`
	ReviewReason     string          `json:"reviewReason"`
	LastError        string          `json:"lastError"`
	OwnerUserID      string          `json:"ownerUserId"`
	CapturedOutletID string          `json:"capturedOutletId"`
	ClientCreatedAt  string          `json:"clientCreatedAt"`
	Payload          json.RawMessage `json:"payload"`
}

// normalizeReviewReports validates a check-in. A wrong batch size rejects the
// request; an invalid single item is skipped (the reply only lists resolved
// keys, so a skipped item is simply reported again next time).
func normalizeReviewReports(in []reviewReportIn) ([]write.SyncReviewReport, error) {
	if len(in) == 0 || len(in) > maxReviewReports {
		return nil, errReviewBatchSize
	}
	out := make([]write.SyncReviewReport, 0, len(in))
	seen := make(map[string]bool, len(in))
	for _, it := range in {
		key := strings.TrimSpace(it.IdempotencyKey)
		if key == "" || len(key) > maxReviewKeyLen || seen[key] || !reviewOpTypes[it.Type] {
			continue
		}
		at, err := time.Parse(time.RFC3339Nano, it.ClientCreatedAt)
		if err != nil {
			continue
		}
		seen[key] = true
		out = append(out, write.SyncReviewReport{
			Key:              key,
			OpType:           it.Type,
			ReviewCode:       clipText(strings.TrimSpace(it.ReviewCode), maxReviewCodeLen),
			ReviewReason:     clipText(it.ReviewReason, maxReviewTextRunes),
			LastError:        clipText(it.LastError, maxReviewTextRunes),
			OwnerUserID:      uuidOrEmpty(it.OwnerUserID),
			CapturedOutletID: uuidOrEmpty(it.CapturedOutletID),
			Payload:          sanitizeReviewPayload(it.Payload),
			ClientCreatedAt:  at,
		})
	}
	return out, nil
}

// clipText removes NUL (PostgreSQL rejects it in text) and caps the rune count.
func clipText(s string, max int) string {
	s = strings.ReplaceAll(s, "\x00", "")
	if utf8.RuneCountInString(s) <= max {
		return s
	}
	return string([]rune(s)[:max])
}

func uuidOrEmpty(s string) string {
	if _, err := uuid.Parse(s); err != nil {
		return ""
	}
	return s
}

var invalidPayload = []byte(`{"_invalid":true}`)

// sanitizeReviewPayload returns a JSON object safe for jsonb: size-capped,
// top-level pin removed (backstop; the tablet already strips it), NUL removed.
func sanitizeReviewPayload(raw json.RawMessage) []byte {
	if len(raw) > maxReviewPayloadBytes {
		b, _ := json.Marshal(map[string]any{"_truncated": true, "bytes": len(raw)})
		return b
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil || m == nil {
		return invalidPayload
	}
	delete(m, "pin")
	b, err := json.Marshal(m)
	if err != nil {
		return invalidPayload
	}
	b = bytes.ReplaceAll(b, []byte(`\u0000`), nil)
	if !json.Valid(b) {
		return invalidPayload
	}
	return b
}

func normalizeResolveNote(s string) (string, error) {
	n := strings.TrimSpace(s)
	if n == "" || utf8.RuneCountInString(n) > maxResolveNoteRunes {
		return "", errResolveNote
	}
	return n, nil
}
