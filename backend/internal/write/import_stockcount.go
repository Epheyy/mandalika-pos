package write

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/mandalika/pos-backend/internal/csvimport"
	"github.com/mandalika/pos-backend/internal/ledger"
)

// planStockCountImport loads the count's lines, the catalog variants and the lines whose stock
// moved since the count started, then plans the scanner file against them. The count must be
// in_progress. On commit the count row is locked first (like every other save of its lines),
// so what is planned is what is applied; the read-only preview reads without the lock.
func planStockCountImport(ctx context.Context, q pgx.Tx, req ImportRequest, t *csvimport.Table, commit bool) (*importPlan, error) {
	lock := ""
	if commit {
		lock = "FOR UPDATE"
	}
	c, err := readCountRow(ctx, q, req.TargetID, req.OutletID, lock)
	if err != nil {
		return nil, err
	}
	if c.status != "in_progress" {
		return nil, fmt.Errorf("%w (status: %s)", ErrCountState, c.status)
	}
	cat, err := loadCountCatalog(ctx, q, req.TargetID, c.loc)
	if err != nil {
		return nil, err
	}
	plan := csvimport.PlanStockCount(t, cat)
	rep := plan.Report
	return &importPlan{count: &rep, apply: func(ctx context.Context, tx pgx.Tx) error {
		return applyStockCountSaves(ctx, tx, req, c.loc, plan.Saves)
	}}, nil
}

func loadCountCatalog(ctx context.Context, q pgx.Tx, countID string, loc countLoc) (csvimport.StockCountCatalog, error) {
	var cat csvimport.StockCountCatalog
	_, _, lid := loc.stock()
	locType := ledger.LocOutlet
	if loc.isWarehouse() {
		locType = ledger.LocWarehouse
	}
	// Scans the location's movements since the count started (S1 adds a (location, recorded_at, seq)
	// index that serves this after the merge; none here).
	moved := map[[2]string]bool{}
	rows, err := q.Query(ctx, `
		SELECT DISTINCT m.product_id::text, m.variant_size
		  FROM stock_movements m, stock_counts sc
		 WHERE sc.id=$1 AND m.location_type=$2 AND m.location_id=$3::uuid
		   AND sc.started_at IS NOT NULL AND m.recorded_at > sc.started_at`, countID, string(locType), lid)
	if err != nil {
		return cat, err
	}
	for rows.Next() {
		var k [2]string
		if err = rows.Scan(&k[0], &k[1]); err != nil {
			rows.Close()
			return cat, err
		}
		moved[k] = true
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return cat, err
	}

	rows, err = q.Query(ctx, `
		SELECT product_id::text, variant_size, product_name, sku, frozen_qty, actual_qty, baseline_qty IS NOT NULL
		  FROM stock_count_items WHERE stock_count_id=$1 ORDER BY product_name, variant_size`, countID)
	if err != nil {
		return cat, err
	}
	for rows.Next() {
		var l csvimport.StockCountLine
		if err = rows.Scan(&l.ProductID, &l.VariantSize, &l.ProductName, &l.SKU, &l.Frozen, &l.Actual, &l.HasBaseline); err != nil {
			rows.Close()
			return cat, err
		}
		l.Moved = moved[[2]string{l.ProductID, l.VariantSize}]
		cat.Lines = append(cat.Lines, l)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return cat, err
	}

	rows, err = q.Query(ctx, `SELECT product_id::text, size, sku, barcode FROM product_variants`)
	if err != nil {
		return cat, err
	}
	defer rows.Close()
	for rows.Next() {
		var v csvimport.StockCountVariant
		if err = rows.Scan(&v.ProductID, &v.Size, &v.SKU, &v.Barcode); err != nil {
			return cat, err
		}
		cat.Variants = append(cat.Variants, v)
	}
	return cat, rows.Err()
}

// applyStockCountSaves stores the counted quantities only: no stock change, no per-line
// baseline kept: a CSV save that changes a line's value clears that line's manual baseline, so the
// delta stays against the count-start snapshot (the preview flags such lines, baseline_replaced). The upload is a line save, so
// saveCountLinesAs writes the importer's 'imported' event (data: importRunId, lines), so the history tells scanner
// imports from manual saves; touchedBy counts it, so the strict four-eyes rule still keeps them from approving.
func applyStockCountSaves(ctx context.Context, tx pgx.Tx, req ImportRequest, loc countLoc, saves []csvimport.StockCountSave) error {
	if len(saves) == 0 {
		return nil
	}
	items := make([]StockCountItem, len(saves))
	for i, s := range saves {
		qty := s.Qty
		items[i] = StockCountItem{ProductID: s.ProductID, VariantSize: s.VariantSize, ActualQty: &qty}
	}
	return saveCountLinesAs(ctx, tx, req.TargetID, loc, items, false, req.UserID, "imported", map[string]any{"importRunId": req.RunID})
}
