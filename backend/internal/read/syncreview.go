package read

import (
	"context"
	"encoding/json"
	"time"
)

// SyncReviewFilter selects head-office review items. Status is "open" or "resolved";
// ReviewCode "none" matches items parked without a code.
type SyncReviewFilter struct {
	Status, OutletID, ReviewCode string
	Page, Limit                  int
}

type SyncReviewItem struct {
	Key                string          `json:"idempotencyKey"`
	OutletID           string          `json:"outletId"`
	OutletName         string          `json:"outletName"`
	CapturedOutletID   *string         `json:"capturedOutletId"`
	CapturedOutletName *string         `json:"capturedOutletName"`
	Type               string          `json:"type"`
	ReviewCode         *string         `json:"reviewCode"`
	ReviewReason       *string         `json:"reviewReason"`
	LastError          *string         `json:"lastError"`
	OwnerUserID        *string         `json:"ownerUserId"`
	OwnerName          *string         `json:"ownerName"`
	Payload            json.RawMessage `json:"payload"`
	ClientCreatedAt    time.Time       `json:"clientCreatedAt"`
	FirstReportedAt    time.Time       `json:"firstReportedAt"`
	LastReportedAt     time.Time       `json:"lastReportedAt"`
	ReportedByName     string          `json:"reportedByName"`
	ResolvedAt         *time.Time      `json:"resolvedAt"`
	ResolvedByName     *string         `json:"resolvedByName"`
	ResolutionNote     *string         `json:"resolutionNote"`
	AppliedOnServer    bool            `json:"appliedOnServer"`
}

// SyncReviewItems lists review items across all outlets. Open items oldest first,
// resolved items most recently resolved first.
func (r *Repo) SyncReviewItems(ctx context.Context, f SyncReviewFilter) ([]SyncReviewItem, int, error) {
	rows, err := r.Pool.Query(ctx, `
		SELECT s.idempotency_key, s.outlet_id::text, COALESCE(o.name, ''),
		  s.captured_outlet_id::text, co.name, s.op_type, s.review_code, s.review_reason,
		  s.last_error, s.owner_user_id::text, ou.display_name, s.payload,
		  s.client_created_at, s.first_reported_at, s.last_reported_at,
		  COALESCE(rb.display_name, ''), s.resolved_at, rv.display_name, s.resolution_note,
		  -- Same probe as sync/attribute.go Applied: orders dedupe via processed_keys,
		  -- transfer receives via transfers.received_idempotency_key, the A11 keyed
		  -- types via operation_receipts. Missing one would hide "Sudah masuk ke server"
		  -- and invite a manual re-entry (double sale / double stock move).
		  (EXISTS (SELECT 1 FROM operation_receipts rc WHERE rc.idempotency_key = s.idempotency_key)
		   OR EXISTS (SELECT 1 FROM processed_keys pk WHERE pk.idempotency_key = s.idempotency_key)
		   OR EXISTS (SELECT 1 FROM transfers tr WHERE tr.received_idempotency_key = s.idempotency_key)),
		  count(*) OVER()
		FROM sync_review_items s
		LEFT JOIN outlets o ON o.id = s.outlet_id
		LEFT JOIN outlets co ON co.id = s.captured_outlet_id
		LEFT JOIN users ou ON ou.id = s.owner_user_id
		LEFT JOIN users rb ON rb.id = s.reported_by
		LEFT JOIN users rv ON rv.id = s.resolved_by
		WHERE (CASE WHEN $1::text = 'resolved' THEN s.resolved_at IS NOT NULL ELSE s.resolved_at IS NULL END)
		  AND ($2::text = '' OR s.outlet_id::text = $2::text)
		  AND ($3::text = '' OR COALESCE(s.review_code, 'none') = $3::text)
		ORDER BY CASE WHEN $1::text = 'resolved' THEN s.resolved_at END DESC NULLS LAST,
		  s.client_created_at ASC, s.idempotency_key
		OFFSET $4 LIMIT $5`,
		f.Status, f.OutletID, f.ReviewCode, off(f.Page, f.Limit), f.Limit)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	items, total := []SyncReviewItem{}, 0
	for rows.Next() {
		var it SyncReviewItem
		var payload []byte
		if err := rows.Scan(&it.Key, &it.OutletID, &it.OutletName, &it.CapturedOutletID,
			&it.CapturedOutletName, &it.Type, &it.ReviewCode, &it.ReviewReason, &it.LastError,
			&it.OwnerUserID, &it.OwnerName, &payload, &it.ClientCreatedAt, &it.FirstReportedAt,
			&it.LastReportedAt, &it.ReportedByName, &it.ResolvedAt, &it.ResolvedByName,
			&it.ResolutionNote, &it.AppliedOnServer, &total); err != nil {
			return nil, 0, err
		}
		it.Payload = json.RawMessage(payload)
		items = append(items, it)
	}
	return items, total, rows.Err()
}

// SyncReviewOpenCount is the unfiltered number of open items (sidebar badge).
func (r *Repo) SyncReviewOpenCount(ctx context.Context) (int, error) {
	var n int
	err := r.Pool.QueryRow(ctx, `SELECT count(*) FROM sync_review_items WHERE resolved_at IS NULL`).Scan(&n)
	return n, err
}
