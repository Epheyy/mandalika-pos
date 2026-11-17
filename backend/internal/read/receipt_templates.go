package read

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/mandalika/pos-backend/internal/api"
)

const receiptTemplateCols = `t.id::text, t.name, t.paper_width, t.blocks, t.is_default, t.version, t.updated_at,
	COALESCE((SELECT array_agg(o.id::text ORDER BY o.name, o.id)
	            FROM outlets o
	           WHERE o.receipt_template_id = t.id OR (t.is_default AND o.receipt_template_id IS NULL)), '{}')`

func scanReceiptTemplates(rows pgx.Rows) ([]api.ReceiptTemplate, error) {
	defer rows.Close()
	out := []api.ReceiptTemplate{}
	for rows.Next() {
		var (
			t       api.ReceiptTemplate
			width   int16
			raw     []byte
			id      string
			ids     []string
			updated time.Time
		)
		if err := rows.Scan(&id, &t.Name, &width, &raw, &t.IsDefault, &t.Version, &updated, &ids); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(raw, &t.Blocks); err != nil {
			return nil, err
		}
		var err error
		if t.Id, err = uuid.Parse(id); err != nil {
			return nil, err
		}
		t.OutletIds = make([]uuid.UUID, 0, len(ids))
		for _, o := range ids {
			ou, perr := uuid.Parse(o)
			if perr != nil {
				return nil, perr
			}
			t.OutletIds = append(t.OutletIds, ou)
		}
		t.PaperWidth = api.ReceiptTemplatePaperWidth(width)
		t.UpdatedAt = updated
		out = append(out, t)
	}
	return out, rows.Err()
}

// ReceiptTemplates lists every template with the outlets that print it; the default also lists the
// outlets that have no assignment. While Standar is still virtual (no default row) those outlets
// belong to no listed template.
func (r *Repo) ReceiptTemplates(ctx context.Context) ([]api.ReceiptTemplate, error) {
	rows, err := r.Pool.Query(ctx, `SELECT `+receiptTemplateCols+`
		FROM receipt_templates t ORDER BY t.is_default DESC, lower(t.name), t.id`)
	if err != nil {
		return nil, err
	}
	return scanReceiptTemplates(rows)
}

// ReceiptTemplate returns one template, or ErrNotFound.
func (r *Repo) ReceiptTemplate(ctx context.Context, id string) (api.ReceiptTemplate, error) {
	if _, err := uuid.Parse(id); err != nil {
		return api.ReceiptTemplate{}, ErrNotFound
	}
	rows, err := r.Pool.Query(ctx, `SELECT `+receiptTemplateCols+` FROM receipt_templates t WHERE t.id=$1`, id)
	if err != nil {
		return api.ReceiptTemplate{}, err
	}
	list, err := scanReceiptTemplates(rows)
	if err != nil {
		return api.ReceiptTemplate{}, err
	}
	if len(list) == 0 {
		return api.ReceiptTemplate{}, ErrNotFound
	}
	return list[0], nil
}

// ReceiptTemplateForOutlet is the template the sync pull ships to an outlet: its assigned template,
// else the default, else nil (the tablet then prints its built-in Standar). A row whose blocks are not
// a JSON array is skipped with a warning instead of failing every pull for the outlet; the tablet
// validates what it receives.
func ReceiptTemplateForOutlet(ctx context.Context, q RowQuerier, outletID string) (*api.SyncReceiptTemplate, error) {
	if _, err := uuid.Parse(outletID); err != nil {
		return nil, nil
	}
	var (
		t     api.SyncReceiptTemplate
		id    string
		width int16
		raw   []byte
	)
	err := q.QueryRow(ctx, `
		SELECT t.id::text, t.version, t.paper_width, t.blocks
		  FROM receipt_templates t
		 WHERE t.id = (SELECT receipt_template_id FROM outlets WHERE id = $1) OR t.is_default
		 ORDER BY t.is_default ASC
		 LIMIT 1`, outletID).Scan(&id, &t.Version, &width, &raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if t.Id, err = uuid.Parse(id); err != nil {
		return nil, err
	}
	if err := json.Unmarshal(raw, &t.Blocks); err != nil {
		slog.Warn("receipt template skipped: blocks are not a block list", "template_id", id, "err", err)
		return nil, nil
	}
	t.PaperWidth = api.SyncReceiptTemplatePaperWidth(width)
	return &t, nil
}
