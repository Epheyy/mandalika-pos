package write

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// SyncReviewReport is one parked tablet item from POST /sync/review-items,
// already validated and redacted by the handler.
type SyncReviewReport struct {
	Key              string
	OpType           string
	ReviewCode       string
	ReviewReason     string
	LastError        string
	OwnerUserID      string // "" = unknown
	CapturedOutletID string // "" = unknown
	Payload          []byte // JSON object
	ClientCreatedAt  time.Time
}

// SyncReviewResolution is head office's decision on one item.
type SyncReviewResolution struct {
	Key            string    `json:"idempotencyKey"`
	ResolvedAt     time.Time `json:"resolvedAt"`
	ResolvedByName string    `json:"resolvedByName"`
	Note           string    `json:"note"`
}

const resolutionSelect = `
	SELECT s.idempotency_key, s.resolved_at, COALESCE(u.display_name, ''), s.resolution_note
	FROM sync_review_items s LEFT JOIN users u ON u.id = s.resolved_by`

// UpsertSyncReviewReports stores a check-in for outletID and returns the keys of
// this request that head office already resolved. A key stored under another
// outlet is left untouched and never returned. Re-reporting never reopens.
func (r *Repo) UpsertSyncReviewReports(ctx context.Context, outletID, reporterID string, items []SyncReviewReport) ([]SyncReviewResolution, error) {
	tx, err := r.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	keys := make([]string, 0, len(items))
	for _, it := range items {
		if _, err := tx.Exec(ctx, `
			INSERT INTO sync_review_items (idempotency_key, outlet_id, captured_outlet_id, op_type,
			  review_code, review_reason, last_error, owner_user_id, payload, client_created_at, reported_by)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)
			ON CONFLICT (idempotency_key) DO UPDATE SET
			  last_reported_at = now(),
			  review_code = EXCLUDED.review_code,
			  review_reason = EXCLUDED.review_reason,
			  last_error = EXCLUDED.last_error
			WHERE sync_review_items.outlet_id = EXCLUDED.outlet_id`,
			it.Key, outletID, elNullUUID(it.CapturedOutletID), it.OpType,
			elNullStr(it.ReviewCode), elNullStr(it.ReviewReason), elNullStr(it.LastError),
			elNullUUID(it.OwnerUserID), string(it.Payload), it.ClientCreatedAt, reporterID,
		); err != nil {
			return nil, err
		}
		keys = append(keys, it.Key)
	}
	rows, err := tx.Query(ctx, resolutionSelect+`
		WHERE s.idempotency_key = ANY($1) AND s.outlet_id = $2 AND s.resolved_at IS NOT NULL
		ORDER BY s.idempotency_key`, keys, outletID)
	if err != nil {
		return nil, err
	}
	out := []SyncReviewResolution{}
	for rows.Next() {
		var x SyncReviewResolution
		if err := rows.Scan(&x.Key, &x.ResolvedAt, &x.ResolvedByName, &x.Note); err != nil {
			rows.Close()
			return nil, err
		}
		out = append(out, x)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// ResolveSyncReviewItem marks one item handled. Resolving twice keeps and
// returns the first resolution. Unknown key → ErrNotFound.
func (r *Repo) ResolveSyncReviewItem(ctx context.Context, key, userID, note string) (SyncReviewResolution, error) {
	if _, err := r.Pool.Exec(ctx, `
		UPDATE sync_review_items SET resolved_at = now(), resolved_by = $2, resolution_note = $3
		WHERE idempotency_key = $1 AND resolved_at IS NULL`, key, userID, note); err != nil {
		return SyncReviewResolution{}, err
	}
	var x SyncReviewResolution
	err := r.Pool.QueryRow(ctx, resolutionSelect+`
		WHERE s.idempotency_key = $1 AND s.resolved_at IS NOT NULL`, key).
		Scan(&x.Key, &x.ResolvedAt, &x.ResolvedByName, &x.Note)
	if errors.Is(err, pgx.ErrNoRows) {
		return SyncReviewResolution{}, ErrNotFound
	}
	return x, err
}
