package write

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/mandalika/pos-backend/internal/apperr"
	"github.com/mandalika/pos-backend/internal/ledger"
)

// ── Custom roles (global reference data — bumps content version) ──

type CustomRole struct {
	Name        string   `json:"name"`
	Permissions []string `json:"permissions"`
}

func (r *Repo) CreateCustomRole(ctx context.Context, c CustomRole) (string, error) {
	var id string
	err := r.tx(ctx, "customRoles", func(t pgx.Tx) error {
		if e := t.QueryRow(ctx,
			`INSERT INTO custom_roles (name) VALUES ($1) RETURNING id`,
			c.Name).Scan(&id); e != nil {
			return e
		}
		return insertRolePerms(ctx, t, id, c.Permissions)
	})
	return id, err
}

func (r *Repo) UpdateCustomRole(ctx context.Context, id string, c CustomRole) error {
	return r.tx(ctx, "customRoles", func(t pgx.Tx) error {
		ct, e := t.Exec(ctx, `UPDATE custom_roles SET name=$1 WHERE id=$2`, c.Name, id)
		if e != nil {
			return e
		}
		if ct.RowsAffected() == 0 {
			return ErrNotFound
		}
		if _, e := t.Exec(ctx,
			`DELETE FROM custom_role_permissions WHERE role_id=$1`, id); e != nil {
			return e
		}
		return insertRolePerms(ctx, t, id, c.Permissions)
	})
}

func insertRolePerms(ctx context.Context, t pgx.Tx, roleID string, perms []string) error {
	for _, p := range perms {
		if _, e := t.Exec(ctx,
			`INSERT INTO custom_role_permissions (role_id, permission) VALUES ($1,$2)
			 ON CONFLICT DO NOTHING`, roleID, p); e != nil {
			return e
		}
	}
	return nil
}

func (r *Repo) DeleteCustomRole(ctx context.Context, id string) error {
	return r.delete(ctx, "customRoles", "custom_roles", id)
}

// ── Stock counts (outlet-scoped; not reference data) ──────────────
//
// A14: the server owns the baseline. Completion applies the counted difference to
// live stock (stock = stock + counted - baseline) instead of writing the absolute
// count, so sales made while a count runs are kept and a retried completion cannot
// restore an old number. Client frozenQty/difference/baseline/stock* are never read.

// ErrCountState: the requested action is not allowed in the count's current status.
var ErrCountState = apperr.New(apperr.Conflict, "status stock count tidak mengizinkan aksi ini")

// ErrCountDone: a replayed completion carries values other than the stored ones.
var ErrCountDone = apperr.New(apperr.Conflict, "stock count sudah selesai dengan nilai lain")

// ErrCountRunning: another count at the same location is still in progress.
var ErrCountRunning = apperr.New(apperr.Conflict, "stock count lain di lokasi ini masih berjalan")

type StockCountItem struct {
	ProductID   string `json:"productId"`
	ProductName string `json:"productName"`
	VariantSize string `json:"variantSize"`
	SKU         string `json:"sku"`
	// FrozenQty and Difference are accepted for wire compatibility and ignored.
	FrozenQty  int  `json:"frozenQty"`
	ActualQty  *int `json:"actualQty"`
	Difference *int `json:"difference"`
}

type StockCountCreate struct {
	Name        string           `json:"name"`
	PlannedDate string           `json:"plannedDate"`
	Notes       string           `json:"notes"`
	WarehouseID string           `json:"warehouseId"` // set → warehouse count; else outlet count (outletID from caller)
	Items       []StockCountItem `json:"items"`
}

type StockCountUpdate struct {
	Status string           `json:"status"`
	Notes  string           `json:"notes"`
	Items  []StockCountItem `json:"items"`
}

// countStep is the status change a PUT requests, after checking it against the
// count's current status.
type countStep int

const (
	stepNone countStep = iota
	stepStart
	stepCancel
)

// countStatusStep is the lifecycle table for PUT status changes. Repeating the
// action that already happened (double click) is a no-op; anything else out of
// order is ErrCountState; a status PUT cannot set is a plain input error.
func countStatusStep(current, requested string) (countStep, error) {
	switch requested {
	case "":
		return stepNone, nil
	case "in_progress":
		switch current {
		case "planned":
			return stepStart, nil
		case "in_progress":
			return stepNone, nil
		}
	case "cancelled":
		switch current {
		case "planned", "in_progress":
			return stepCancel, nil
		case "cancelled":
			return stepNone, nil
		}
	default:
		return stepNone, fmt.Errorf("status %q tidak dikenal", requested)
	}
	return stepNone, fmt.Errorf("%w (status: %s)", ErrCountState, current)
}

// itemsMode says how a PUT items payload is applied in a given status.
type itemsMode int

const (
	itemsReplace itemsMode = iota + 1 // planned: replace the line list (labels only)
	itemsPartial                      // in_progress: update actualQty of existing lines
)

func countItemsMode(status string) (itemsMode, error) {
	switch status {
	case "planned":
		return itemsReplace, nil
	case "in_progress":
		return itemsPartial, nil
	}
	return 0, fmt.Errorf("%w (status: %s)", ErrCountState, status)
}

// countDelta is the stock change a counted line applies: counted minus what the
// stock was when the line was counted (its baseline), or minus the frozen
// quantity for a line that has no per-line baseline.
func countDelta(actual int, baseline *int, frozen int) int {
	if baseline != nil {
		return actual - *baseline
	}
	return actual - frozen
}

// countLoc is the one location a count belongs to.
type countLoc struct{ outletID, warehouseID string }

func (l countLoc) isWarehouse() bool { return l.warehouseID != "" }

// stock returns the stock table, its location column and this count's location id.
func (l countLoc) stock() (table, col, id string) {
	if l.isWarehouse() {
		return "warehouse_variant_stock", "warehouse_id", l.warehouseID
	}
	return "outlet_variant_stock", "outlet_id", l.outletID
}

// liveStockSQL is a scalar subquery of the live stock of a variant; a missing row
// counts as 0. The arguments are SQL expressions or parameter placeholders.
func (l countLoc) liveStockSQL(locExpr, pidExpr, sizeExpr string) string {
	tbl, col, _ := l.stock()
	return fmt.Sprintf(`COALESCE((SELECT s.stock FROM %s s WHERE s.%s=%s::uuid AND s.product_id=%s AND s.variant_size=%s),0)`,
		tbl, col, locExpr, pidExpr, sizeExpr)
}

type countRow struct {
	status string
	loc    countLoc
}

// lockCount reads the count under a row lock (every state-changing path starts
// here, so concurrent edits and completions are serialized per count) and
// authorizes it: outlet counts must belong to the caller's outlet; warehouse
// counts are permission-gated (existence check only — no outlet binding).
func lockCount(ctx context.Context, t pgx.Tx, id, outletID string) (countRow, error) {
	var c countRow
	var oid, wid *string
	e := t.QueryRow(ctx,
		`SELECT status, outlet_id, warehouse_id FROM stock_counts WHERE id=$1 FOR UPDATE`, id).Scan(&c.status, &oid, &wid)
	if errors.Is(e, pgx.ErrNoRows) {
		return c, ErrNotFound
	}
	if e != nil {
		return c, e
	}
	switch {
	case wid != nil:
		c.loc.warehouseID = *wid
	case oid != nil && *oid == outletID:
		c.loc.outletID = *oid
	default:
		return c, ErrNotFound // outlet count: must match the caller's outlet
	}
	return c, nil
}

func validateCountItems(items []StockCountItem) error {
	seen := make(map[[2]string]bool, len(items))
	for _, i := range items {
		if i.ProductID == "" || i.VariantSize == "" {
			return fmt.Errorf("produk dan ukuran wajib diisi")
		}
		if i.ActualQty != nil && *i.ActualQty < 0 {
			return fmt.Errorf("jumlah hitung tidak boleh negatif")
		}
		k := [2]string{i.ProductID, i.VariantSize}
		if seen[k] {
			return fmt.Errorf("produk %s (%s) muncul lebih dari sekali", i.ProductName, i.VariantSize)
		}
		seen[k] = true
	}
	return nil
}

// runningCountConflict maps the one-running-count-per-location unique indexes.
func runningCountConflict(e error) error {
	var pg *pgconn.PgError
	if errors.As(e, &pg) && pg.Code == "23505" &&
		(pg.ConstraintName == "stock_counts_one_running_outlet" || pg.ConstraintName == "stock_counts_one_running_warehouse" ||
			pg.ConstraintName == "stock_counts_one_open_outlet" || pg.ConstraintName == "stock_counts_one_open_warehouse") {
		return ErrCountRunning
	}
	return e
}

// CreateStockCount records the line list. Frozen quantities are read from live
// stock here; the client's frozen/actual/difference are ignored. Outlet + creator
// come from the caller (server-resolved), never the body (plan §2a).
func (r *Repo) CreateStockCount(ctx context.Context, outletID, createdBy string, s StockCountCreate) (string, error) {
	// A count belongs to exactly one location. A warehouseId in the body makes it
	// a warehouse count (ignore any outlet scope); otherwise it's an outlet count
	// and the outlet comes from the caller's scope.
	if s.WarehouseID != "" {
		outletID = ""
	} else if outletID == "" {
		return "", fmt.Errorf("outlet atau gudang wajib")
	}
	if e := validateCountItems(s.Items); e != nil {
		return "", e
	}
	var id string
	t, err := r.Pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer t.Rollback(ctx)
	if e := t.QueryRow(ctx, `
		INSERT INTO stock_counts (name, status, outlet_id, warehouse_id, planned_date, notes, created_by)
		VALUES ($1,'planned',$2,$3,$4,$5,$6) RETURNING id`,
		s.Name, nullUUID(outletID), nullUUID(s.WarehouseID), nullDate(s.PlannedDate),
		nullStr(s.Notes), nullUUID(createdBy)).Scan(&id); e != nil {
		return "", e
	}
	if e := insertStockItems(ctx, t, id, countLoc{outletID: outletID, warehouseID: s.WarehouseID}, s.Items); e != nil {
		return "", e
	}
	return id, t.Commit(ctx)
}

// insertStockItems inserts labelled lines with frozen_qty read from live stock.
func insertStockItems(ctx context.Context, t pgx.Tx, scID string, loc countLoc, items []StockCountItem) error {
	_, _, lid := loc.stock()
	q := `INSERT INTO stock_count_items (stock_count_id, product_id, product_name, variant_size, sku, frozen_qty)
		VALUES ($1::uuid,$2::uuid,$3::text,$4::text,$5::text,` + loc.liveStockSQL("$6", "$2::uuid", "$4::text") + `)`
	for _, i := range items {
		if _, e := t.Exec(ctx, q, scID, i.ProductID, i.ProductName, i.VariantSize, i.SKU, lid); e != nil {
			return e
		}
	}
	return nil
}

// refreezeCount re-reads every line's frozen quantity from live stock (a planned
// count can sit for days before it starts).
func refreezeCount(ctx context.Context, t pgx.Tx, id string, loc countLoc) error {
	_, _, lid := loc.stock()
	_, e := t.Exec(ctx,
		`UPDATE stock_count_items i SET frozen_qty = `+loc.liveStockSQL("$2", "i.product_id", "i.variant_size")+`
		  WHERE i.stock_count_id=$1`, id, lid)
	return e
}

// saveCountLines stores actualQty on existing lines only (no adds or removals).
// captureBaseline is true for per-line saves: a changed value records the live
// stock at that moment as the line's baseline and stamps counted_at. A line whose
// value is unchanged keeps its baseline; a cleared line drops all three. Lines
// first set at completion get no baseline and fall back to frozen_qty.
func saveCountLines(ctx context.Context, t pgx.Tx, id string, loc countLoc, items []StockCountItem, captureBaseline bool) error {
	_, _, lid := loc.stock()
	q := `UPDATE stock_count_items SET
		baseline_qty = CASE WHEN $4::int IS NULL THEN NULL
		                    WHEN actual_qty IS NOT DISTINCT FROM $4::int THEN baseline_qty
		                    WHEN $5::boolean THEN ` + loc.liveStockSQL("$6", "$2::uuid", "$3::text") + `
		                    ELSE NULL END,
		counted_at = CASE WHEN $4::int IS NULL THEN NULL
		                  WHEN actual_qty IS NOT DISTINCT FROM $4::int THEN counted_at
		                  ELSE now() END,
		actual_qty = $4::int
		WHERE stock_count_id=$1::uuid AND product_id=$2::uuid AND variant_size=$3::text`
	for _, i := range items {
		ct, e := t.Exec(ctx, q, id, i.ProductID, i.VariantSize, i.ActualQty, captureBaseline, lid)
		if e != nil {
			return e
		}
		if ct.RowsAffected() == 0 {
			return fmt.Errorf("produk %s (%s) tidak ada di stock count ini", i.ProductName, i.VariantSize)
		}
	}
	return nil
}

// UpdateStockCount handles start, cancel, notes and line edits, all against the
// lifecycle table above and under the count's row lock.
func (r *Repo) UpdateStockCount(ctx context.Context, id, outletID string, u StockCountUpdate) error {
	return r.UpdateStockCountBy(ctx, id, outletID, "", u)
}

// UpdateStockCountBy is UpdateStockCount recording actor ("" allowed) as the saver of counted lines.
func (r *Repo) UpdateStockCountBy(ctx context.Context, id, outletID, actor string, u StockCountUpdate) error {
	return retryBusy(ctx, func() error { return r.updateStockCount(ctx, id, outletID, actor, u) })
}

func (r *Repo) updateStockCount(ctx context.Context, id, outletID, actor string, u StockCountUpdate) error {
	if e := validateCountItems(u.Items); e != nil {
		return e
	}
	t, err := r.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer t.Rollback(ctx)
	c, e := lockCount(ctx, t, id, outletID)
	if e != nil {
		return e
	}
	step, e := countStatusStep(c.status, u.Status)
	if e != nil {
		return e
	}
	status := c.status
	switch step {
	case stepStart:
		if _, e := t.Exec(ctx,
			`UPDATE stock_counts SET status='in_progress', started_at=now() WHERE id=$1`, id); e != nil {
			return runningCountConflict(e)
		}
		if e := refreezeCount(ctx, t, id, c.loc); e != nil {
			return e
		}
		status = "in_progress"
	case stepCancel:
		if _, e := t.Exec(ctx,
			`UPDATE stock_counts SET status='cancelled' WHERE id=$1`, id); e != nil {
			return e
		}
		status = "cancelled"
	}
	if u.Items != nil {
		mode, e := countItemsMode(status)
		if e != nil {
			return e
		}
		if mode == itemsReplace {
			if _, e := t.Exec(ctx,
				`DELETE FROM stock_count_items WHERE stock_count_id=$1`, id); e != nil {
				return e
			}
			if e := insertStockItems(ctx, t, id, c.loc, u.Items); e != nil {
				return e
			}
		} else {
			if e := saveCountLines(ctx, t, id, c.loc, u.Items, true); e != nil {
				return e
			}
			// The lines store no actor: record who saved counted lines, for the strict four-eyes check.
			if actor != "" {
				if e := insertDocEvent(ctx, t, docTypeStockCount, id, "updated", actor, "", map[string]any{"lines": len(u.Items)}); e != nil {
					return e
				}
			}
		}
	}
	if u.Notes != "" {
		if status != "planned" && status != "in_progress" {
			return fmt.Errorf("%w (status: %s)", ErrCountState, status)
		}
		if _, e := t.Exec(ctx,
			`UPDATE stock_counts SET notes=$1 WHERE id=$2`, u.Notes, id); e != nil {
			return e
		}
	}
	return t.Commit(ctx)
}

// CompleteStockCount applies the counted difference of every counted line to live
// stock in one tx and (for outlet counts) bumps the products content version so
// POS resyncs (plan §5a). A payload only updates actualQty on existing lines (a
// line first set here has no baseline and falls back to frozen_qty); it can never
// add products. Completing an already completed count writes nothing.
func (r *Repo) CompleteStockCount(ctx context.Context, id, outletID string, items []StockCountItem) error {
	return r.CompleteStockCountBy(ctx, id, outletID, "", items)
}

// CompleteStockCountBy is CompleteStockCount recording actor ("" allowed) on the ledger rows.
func (r *Repo) CompleteStockCountBy(ctx context.Context, id, outletID, actor string, items []StockCountItem) error {
	return retryBusy(ctx, func() error {
		return r.inTx(ctx, func(t pgx.Tx) error { return r.completeStockCount(ctx, t, id, outletID, actor, items) })
	})
}

// CompleteStockCountTx is CompleteStockCountBy inside the caller's transaction (an
// idempotency receipt claim). It neither begins, commits nor retries.
func (r *Repo) CompleteStockCountTx(ctx context.Context, tx pgx.Tx, id, outletID, actor string, items []StockCountItem) error {
	return r.completeStockCount(ctx, tx, id, outletID, actor, items)
}

func (r *Repo) completeStockCount(ctx context.Context, t pgx.Tx, id, outletID, actor string, items []StockCountItem) error {
	if e := validateCountItems(items); e != nil {
		return e
	}
	c, e := lockCount(ctx, t, id, outletID)
	if e != nil {
		return e
	}
	if c.status == "completed" {
		// Replay: the first completion already applied; zero writes. A payload that
		// disagrees with what was stored is refused rather than silently dropped.
		return checkReplayItems(ctx, t, id, items)
	}
	if c.status != "in_progress" {
		return fmt.Errorf("%w (status: %s)", ErrCountState, c.status)
	}
	if items != nil {
		if e := saveCountLines(ctx, t, id, c.loc, items, false); e != nil {
			return e
		}
	}
	// Approval flag on: only a count with no difference completes directly; one with a
	// difference must go through submit and approve (the lines saved above roll back with
	// the refusal, the caller's transaction ends in error).
	if e := requireApprovalForVariance(ctx, t, id); e != nil {
		return e
	}
	return finishCount(ctx, t, id, c, actor, "")
}

// finishCount applies the count's deltas, marks it completed (recording approvedBy when an
// approver signed it off) and, for an outlet count, bumps the content version and the stock
// counter. Shared by the direct completion and by an approved submission. The stock counter
// bump stays the LAST statement; a replayed completion returns before here.
func finishCount(ctx context.Context, t pgx.Tx, id string, c countRow, actor, approvedBy string) error {
	if e := applyCountDeltas(ctx, t, id, c.loc, actor); e != nil {
		return e
	}
	if _, e := t.Exec(ctx,
		`UPDATE stock_counts SET status='completed', completed_at=now(),
		        approved_by=$2, approved_at=CASE WHEN $2::uuid IS NULL THEN NULL ELSE now() END
		  WHERE id=$1`, id, nullUUID(approvedBy)); e != nil {
		return e
	}
	if !c.loc.isWarehouse() { // warehouse: no POS resync needed
		if e := bumpVersion(ctx, t, "products"); e != nil {
			return fmt.Errorf("bump version: %w", e)
		}
		// A15 Phase B: the count rewrote this outlet's stock. Only the count's own
		// outlet moves its counter (the content bump above touches every outlet, which
		// is wasteful but changes no stock elsewhere). LAST, once; replays and
		// warehouse counts return before here.
		if _, e := BumpStockSeq(ctx, t, c.loc.outletID); e != nil {
			return e
		}
	}
	return nil
}

// checkReplayItems accepts a replayed completion only if every payload line is on
// the count with the same stored actual_qty (an empty or absent payload is fine).
func checkReplayItems(ctx context.Context, t pgx.Tx, id string, items []StockCountItem) error {
	if len(items) == 0 {
		return nil
	}
	rows, e := t.Query(ctx,
		`SELECT product_id, variant_size, actual_qty FROM stock_count_items WHERE stock_count_id=$1`, id)
	if e != nil {
		return e
	}
	stored := map[[2]string]*int{}
	for rows.Next() {
		var pid, size string
		var actual *int
		if e := rows.Scan(&pid, &size, &actual); e != nil {
			rows.Close()
			return e
		}
		stored[[2]string{pid, size}] = actual
	}
	rows.Close()
	if e := rows.Err(); e != nil {
		return e
	}
	for _, i := range items {
		have, ok := stored[[2]string{i.ProductID, i.VariantSize}]
		if !ok || (have == nil) != (i.ActualQty == nil) || (have != nil && *have != *i.ActualQty) {
			return ErrCountDone
		}
	}
	return nil
}

// Known limit (needs the A17 stock movement ledger): an offline sale made before an
// item was counted but synced after its baseline was captured is subtracted twice,
// and the baseline read is not locked, so a sale landing in the millisecond between
// that read and the count's own write can do the same.
//
// applyCountDeltas adds each counted line's delta to live stock, records the stock
// seen before/after on the line, and writes the ledger rows (kind count, one per
// non-zero delta, before/after from the RETURNING stock) in the same tx. Lines are visited in (product_id, variant_size) order,
// the same order transfers lock stock rows in. A negative result is kept.
func applyCountDeltas(ctx context.Context, t pgx.Tx, id string, loc countLoc, actor string) error {
	type line struct {
		id, pid, size  string
		frozen, actual int
		baseline       *int
	}
	rows, e := t.Query(ctx, `
		SELECT id, product_id, variant_size, frozen_qty, actual_qty, baseline_qty
		  FROM stock_count_items WHERE stock_count_id=$1 AND actual_qty IS NOT NULL
		 ORDER BY product_id, variant_size`, id)
	if e != nil {
		return e
	}
	var lines []line
	for rows.Next() {
		var l line
		if e := rows.Scan(&l.id, &l.pid, &l.size, &l.frozen, &l.actual, &l.baseline); e != nil {
			rows.Close()
			return e
		}
		lines = append(lines, l)
	}
	rows.Close()
	if e := rows.Err(); e != nil {
		return e
	}
	tbl, col, lid := loc.stock()
	apply := fmt.Sprintf(`INSERT INTO %s (%s, product_id, variant_size, stock) VALUES ($1,$2,$3,$4)
		ON CONFLICT (%s, product_id, variant_size) DO UPDATE SET stock = %s.stock + $4
		RETURNING stock`, tbl, col, col, tbl)
	doc := countLedgerDoc(id, loc, actor, len(lines))
	for _, l := range lines {
		delta := countDelta(l.actual, l.baseline, l.frozen)
		var after int
		if e := t.QueryRow(ctx, apply, lid, l.pid, l.size, delta).Scan(&after); e != nil {
			return e
		}
		if _, e := t.Exec(ctx,
			`UPDATE stock_count_items SET difference=$4, stock_before=$5, stock_after=$6
			  WHERE stock_count_id=$1 AND product_id=$2 AND variant_size=$3`,
			id, l.pid, l.size, delta, after-delta, after); e != nil {
			return e
		}
		doc.Lines = append(doc.Lines, ledger.Line{
			ProductID: l.pid, VariantSize: l.size, Qty: delta, QtyBefore: after - delta, QtyAfter: after,
			RefLine: l.id, DedupeKey: doc.Key + ":" + l.pid + ":" + l.size,
		})
	}
	_, e = ledger.Record(ctx, t, doc)
	return e
}

// countLedgerDoc is the ledger document of one count's completion at its location
// (stock_counts has no printed number, so ref_number stays empty).
func countLedgerDoc(id string, loc countLoc, actor string, n int) ledger.Document {
	_, _, lid := loc.stock()
	lt := ledger.LocOutlet
	if loc.isWarehouse() {
		lt = ledger.LocWarehouse
	}
	return ledger.Document{
		Key: "count:" + id, Kind: ledger.KindCount, LocationType: lt, LocationID: lid,
		RefType: "stock_count", RefID: id, Actor: actor, OccurredAt: time.Now(),
		Lines: make([]ledger.Line, 0, n),
	}
}
