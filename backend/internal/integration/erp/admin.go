package erp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Admin errors.
var (
	ErrNotFound      = errors.New("erp: outbox row not found")
	ErrNotRetryable  = errors.New("erp: outbox row is pending or sending, nothing to retry")
	ErrInvalidFilter = errors.New("erp: invalid outbox filter")
)

const maxListLimit = 200

// OutboxStatuses and OutboxKinds are the values the list filters accept.
var (
	OutboxStatuses = []string{statusPending, statusHeld, "sending", statusDelivered, statusReplayed, statusDead}
	OutboxKinds    = []string{"sale", "refund", "transfer_out", "transfer_in", "transfer_cancel",
		"receipt", "adjust", "count", "opening", "write_off"}
)

// OutboxItem is one erp_outbox row without its bodies.
type OutboxItem struct {
	ID, DocumentID, Kind, LocationType, LocationID string
	RefType, RefID, RefNumber, Status              string
	Part, PartCount, Attempts                      int
	NextAttemptAt                                  time.Time
	LastHTTPStatus                                 *int
	LastError, HoldReason                          *string
	CreatedAt, UpdatedAt                           time.Time
	DeliveredAt                                    *time.Time
}

// OutboxDetail adds the frozen payload and the ERP answer.
type OutboxDetail struct {
	OutboxItem
	Payload       json.RawMessage
	PayloadSHA256 *string
	ERPResponse   json.RawMessage
}

const itemColumns = `o.id::text, o.document_id::text, o.kind, o.location_type, o.location_id::text,
  o.ref_type, o.ref_id::text, COALESCE(o.ref_number,''), o.status, o.part, o.part_count, o.attempts,
  o.next_attempt_at, o.last_http_status, o.last_error, o.hold_reason, o.created_at, o.updated_at, o.delivered_at`

const (
	countsSQL = `SELECT status, count(*) FROM erp_outbox GROUP BY status`
	listSQL   = `SELECT ` + itemColumns + `, count(*) OVER () FROM erp_outbox o
 WHERE ($1 = '' OR o.status = $1) AND ($2 = '' OR o.kind = $2)
 ORDER BY o.created_at DESC, o.id LIMIT $3 OFFSET $4`
	getSQL = `SELECT ` + itemColumns + `, o.payload, o.payload_sha256, o.erp_response
 FROM erp_outbox o WHERE o.id = $1`

	// The frozen payload is cleared only after 400/422 (the ERP wrote nothing, and a fixed
	// mapping must rebuild the body). After 409, 5xx, timeouts or a delivery the ERP may
	// hold that body, and a different one would be answered with 409.
	retrySQL = `
UPDATE erp_outbox o SET status='pending', attempts=0, next_attempt_at=now(),
  lease_token=NULL, lease_until=NULL, hold_reason=NULL, updated_at=now(),
  payload = CASE WHEN o.last_http_status IN (400, 422) THEN NULL ELSE o.payload END,
  payload_sha256 = CASE WHEN o.last_http_status IN (400, 422) THEN NULL ELSE o.payload_sha256 END
WHERE o.id = $1 AND o.status IN ('dead','held','delivered','replayed')
RETURNING ` + itemColumns
	existsSQL = `SELECT EXISTS (SELECT 1 FROM erp_outbox WHERE id = $1)`
)

// Counts returns the number of rows per status; every status is present.
func Counts(ctx context.Context, q Querier) (map[string]int, error) {
	counts := make(map[string]int, len(OutboxStatuses))
	for _, s := range OutboxStatuses {
		counts[s] = 0
	}
	rows, err := q.Query(ctx, countsSQL)
	if err != nil {
		return nil, fmt.Errorf("erp admin: counts: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var status string
		var n int
		if err := rows.Scan(&status, &n); err != nil {
			return nil, fmt.Errorf("erp admin: scan counts: %w", err)
		}
		counts[status] = n
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("erp admin: read counts: %w", err)
	}
	return counts, nil
}

// List returns the newest rows first plus the total matching rows. An empty status or
// kind means all.
func List(ctx context.Context, q Querier, status, kind string, limit, offset int) ([]OutboxItem, int, error) {
	if (status != "" && !contains(OutboxStatuses, status)) || (kind != "" && !contains(OutboxKinds, kind)) {
		return nil, 0, ErrInvalidFilter
	}
	limit = min(max(limit, 1), maxListLimit)
	offset = max(offset, 0)
	rows, err := q.Query(ctx, listSQL, status, kind, limit, offset)
	if err != nil {
		return nil, 0, fmt.Errorf("erp admin: list: %w", err)
	}
	defer rows.Close()
	items := []OutboxItem{}
	total := 0
	for rows.Next() {
		var it OutboxItem
		if err := rows.Scan(append(itemDests(&it), &total)...); err != nil {
			return nil, 0, fmt.Errorf("erp admin: scan list: %w", err)
		}
		items = append(items, it)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, fmt.Errorf("erp admin: read list: %w", err)
	}
	if len(items) == 0 && offset > 0 {
		// Past the last page: window count is gone with the rows, so ask for it.
		if err := q.QueryRow(ctx, `SELECT count(*) FROM erp_outbox o WHERE ($1 = '' OR o.status = $1) AND ($2 = '' OR o.kind = $2)`,
			status, kind).Scan(&total); err != nil {
			return nil, 0, fmt.Errorf("erp admin: count list: %w", err)
		}
	}
	return items, total, nil
}

// Get returns one row with its payload and the ERP response.
func Get(ctx context.Context, q Querier, id string) (OutboxDetail, error) {
	if _, err := uuid.Parse(id); err != nil {
		return OutboxDetail{}, ErrNotFound
	}
	var d OutboxDetail
	err := q.QueryRow(ctx, getSQL, id).Scan(append(itemDests(&d.OutboxItem), &d.Payload, &d.PayloadSHA256, &d.ERPResponse)...)
	if errors.Is(err, pgx.ErrNoRows) {
		return OutboxDetail{}, ErrNotFound
	}
	if err != nil {
		return OutboxDetail{}, fmt.Errorf("erp admin: get: %w", err)
	}
	return d, nil
}

// Retry requeues a dead, held, delivered or replayed row (a resend of a delivered one
// is answered "replayed" by the ERP). Pending and sending rows are not retryable.
func Retry(ctx context.Context, pool *pgxpool.Pool, id string) (OutboxItem, error) {
	if _, err := uuid.Parse(id); err != nil {
		return OutboxItem{}, ErrNotFound
	}
	var it OutboxItem
	err := pool.QueryRow(ctx, retrySQL, id).Scan(itemDests(&it)...)
	if err == nil {
		return it, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return OutboxItem{}, fmt.Errorf("erp admin: retry: %w", err)
	}
	var exists bool
	if err := pool.QueryRow(ctx, existsSQL, id).Scan(&exists); err != nil {
		return OutboxItem{}, fmt.Errorf("erp admin: retry lookup: %w", err)
	}
	if !exists {
		return OutboxItem{}, ErrNotFound
	}
	return OutboxItem{}, ErrNotRetryable
}

// itemDests lists the scan targets in itemColumns order.
func itemDests(it *OutboxItem) []any {
	return []any{&it.ID, &it.DocumentID, &it.Kind, &it.LocationType, &it.LocationID,
		&it.RefType, &it.RefID, &it.RefNumber, &it.Status, &it.Part, &it.PartCount, &it.Attempts,
		&it.NextAttemptAt, &it.LastHTTPStatus, &it.LastError, &it.HoldReason, &it.CreatedAt, &it.UpdatedAt, &it.DeliveredAt}
}

func contains(set []string, v string) bool {
	for _, s := range set {
		if s == v {
			return true
		}
	}
	return false
}
