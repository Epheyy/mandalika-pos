package write

import (
	"context"
	"fmt"
)

// AcknowledgeSaleStockExceptions marks oversell lines "sudah dicek" (Q1). Lines
// already checked, or outside outletID's scope (outletID "" = all), are skipped, so
// a repeat is a no-op. Returns how many lines were newly acknowledged.
func (r *Repo) AcknowledgeSaleStockExceptions(ctx context.Context, ids []string, outletID, userID, note string) (int, error) {
	tag, err := r.Pool.Exec(ctx, `
		UPDATE sale_stock_exceptions
		   SET acknowledged_at = now(), acknowledged_by = $2::uuid,
		       acknowledged_by_name = (SELECT display_name FROM users WHERE id = $2::uuid),
		       acknowledge_note = NULLIF($3, '')
		 WHERE id = ANY($1::uuid[]) AND acknowledged_at IS NULL
		   AND ($4 = '' OR outlet_id::text = $4)`,
		ids, userID, note, outletID)
	if err != nil {
		return 0, fmt.Errorf("acknowledge sale stock exceptions: %w", err)
	}
	return int(tag.RowsAffected()), nil
}
