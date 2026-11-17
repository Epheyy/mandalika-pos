package read

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/mandalika/pos-backend/internal/api"
)

// ReceiptTestPrintTTLMinutes is how long a draft sent from the Backoffice stays fetchable.
const ReceiptTestPrintTTLMinutes = 60

// ReceiptTestPrint returns the draft sent to this outlet in the last 60 minutes, or ErrNotFound. The
// answer has no stored id or version: it is a one-off draft, never a saved template.
func (r *Repo) ReceiptTestPrint(ctx context.Context, outletID string) (api.SyncReceiptTemplate, error) {
	var out api.SyncReceiptTemplate
	if _, err := uuid.Parse(outletID); err != nil {
		return out, ErrNotFound
	}
	var (
		width int16
		raw   []byte
	)
	err := r.Pool.QueryRow(ctx, `
		SELECT paper_width, blocks
		  FROM receipt_test_prints
		 WHERE outlet_id = $1 AND created_at > now() - make_interval(mins => $2)`,
		outletID, ReceiptTestPrintTTLMinutes).Scan(&width, &raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, ErrNotFound
	}
	if err != nil {
		return out, err
	}
	if err := json.Unmarshal(raw, &out.Blocks); err != nil {
		return out, ErrNotFound
	}
	out.Id = uuid.Nil
	out.PaperWidth = api.SyncReceiptTemplatePaperWidth(width)
	return out, nil
}
