package write

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/mandalika/pos-backend/internal/api"
	"github.com/mandalika/pos-backend/internal/receipttpl"
)

const (
	pgForeignKeyViolation = "23503"
	// testPrintName only satisfies the shared template validator; a draft has no stored name.
	testPrintName = "Cetak tes"
)

// SaveReceiptTestPrint stores an unsaved draft for one outlet's tablet to print once. A newer draft
// replaces the older one. It is validated like a template, never touches the content version and never
// reaches a sale. An unknown outlet is ErrNotFound.
func (r *Repo) SaveReceiptTestPrint(ctx context.Context, actor, outletID string, paperWidth int, blocks []api.ReceiptBlock) error {
	if _, err := uuid.Parse(outletID); err != nil {
		return ErrNotFound
	}
	if err := receipttpl.Validate(testPrintName, paperWidth, blocks); err != nil {
		return err
	}
	raw, err := json.Marshal(blocks)
	if err != nil {
		return err
	}
	_, err = r.Pool.Exec(ctx, `
		INSERT INTO receipt_test_prints (outlet_id, paper_width, blocks, created_by, created_at)
		VALUES ($1, $2, $3, $4, now())
		ON CONFLICT (outlet_id) DO UPDATE
		   SET paper_width = EXCLUDED.paper_width, blocks = EXCLUDED.blocks,
		       created_by = EXCLUDED.created_by, created_at = now()`,
		outletID, paperWidth, raw, nilIfEmpty(actor))
	var pg *pgconn.PgError
	if errors.As(err, &pg) && pg.Code == pgForeignKeyViolation {
		return ErrNotFound
	}
	return err
}
