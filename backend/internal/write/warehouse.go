package write

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/mandalika/pos-backend/internal/ledger"
)

// OutletPar is the write-side input for setting a per-variant PAR (low-stock
// threshold) on an outlet. ParLevel nil clears the threshold.
type OutletPar struct {
	ProductID   string `json:"productId"`
	VariantSize string `json:"variantSize"`
	ParLevel    *int   `json:"parLevel"`
}

type Warehouse struct {
	Name     string `json:"name"`
	Code     string `json:"code"`
	Address  string `json:"address"`
	Phone    string `json:"phone"`
	LogoURL  string `json:"logoUrl"`
	IsActive bool   `json:"isActive"`
}

// noBumpTx runs fn in a tx WITHOUT bumping content_version (warehouses are not
// POS-synced, so no cashier resync is needed).
func (r *Repo) noBumpTx(ctx context.Context, fn func(pgx.Tx) error) error {
	t, err := r.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer t.Rollback(ctx)
	if err := fn(t); err != nil {
		return err
	}
	return t.Commit(ctx)
}

func (r *Repo) CreateWarehouse(ctx context.Context, w Warehouse) (string, error) {
	var id string
	err := r.noBumpTx(ctx, func(t pgx.Tx) error {
		return t.QueryRow(ctx,
			`INSERT INTO warehouses (name, code, address, phone, logo_url, is_active)
			 VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
			w.Name, nullStr(w.Code), nullStr(w.Address), nullStr(w.Phone), nullStr(w.LogoURL), w.IsActive).Scan(&id)
	})
	return id, err
}

func (r *Repo) UpdateWarehouse(ctx context.Context, id string, w Warehouse) error {
	return r.noBumpTx(ctx, func(t pgx.Tx) error {
		ct, e := t.Exec(ctx,
			`UPDATE warehouses SET name=$1, code=$2, address=$3, phone=$4, logo_url=$5, is_active=$6 WHERE id=$7`,
			w.Name, nullStr(w.Code), nullStr(w.Address), nullStr(w.Phone), nullStr(w.LogoURL), w.IsActive, id)
		if e == nil && ct.RowsAffected() == 0 {
			return ErrNotFound
		}
		return e
	})
}

// DeleteWarehouse (D13): refused while any of its stock rows is non-zero
// (WarehouseHasStockError), and then while a
// stock document names it (ErrWarehouseHasHistory: transfers keep a foreign key, receipts,
// adjustments and counts would cascade away; deactivate instead). The warehouse row
// is locked first (see lockWarehouseRow) so every stock row a concurrent receipt created is
// committed and visible; the zero rows are then deleted explicitly, with a RETURNING check,
// before the warehouse, so the FK CASCADE finds no non-zero row to remove.
func (r *Repo) DeleteWarehouse(ctx context.Context, id string) error {
	return retryBusy(ctx, func() error { return r.deleteWarehouse(ctx, id) })
}

func (r *Repo) deleteWarehouse(ctx context.Context, id string) error {
	return r.noBumpTx(ctx, func(t pgx.Tx) error {
		if e := lockWarehouseRow(ctx, t, id); e != nil {
			return e
		}
		if e := lockWarehouseStock(ctx, t, id); e != nil {
			return warehouseStockRefusal(e)
		}
		if e := guardedZeroWrite(ctx, t, "warehouse", `
			DELETE FROM warehouse_variant_stock WHERE warehouse_id=$1
			RETURNING warehouse_id::text, variant_size, stock`, id); e != nil {
			return warehouseStockRefusal(e)
		}
		// After the stock guard, so a stocked warehouse is still refused for its stock first.
		if e := guardWarehouseHistory(ctx, t, id); e != nil {
			return e
		}
		ct, e := t.Exec(ctx, `DELETE FROM warehouses WHERE id=$1`, id)
		if e == nil && ct.RowsAffected() == 0 {
			return ErrNotFound
		}
		var pg *pgconn.PgError
		if errors.As(e, &pg) && pg.Code == "23503" {
			// Backstop: a referencing table guardWarehouseHistory does not list. Logged so a
			// new foreign key shows up; the PgError is not wrapped (it would turn the 409
			// into the generic conflict text).
			slog.Warn("warehouse delete blocked by an unlisted foreign key", "constraint", pg.ConstraintName, "table", pg.TableName)
			return ErrWarehouseHasHistory
		}
		return e
	})
}

type GoodsReceiptItem struct {
	ProductID   string   `json:"productId"`
	VariantSize string   `json:"variantSize"`
	Qty         int      `json:"qty"`
	UnitCost    *float64 `json:"unitCost"`
}
type GoodsReceipt struct {
	Supplier string             `json:"supplier"`
	Note     string             `json:"note"`
	Items    []GoodsReceiptItem `json:"items"`
}

type WarehouseAdjust struct {
	ProductID   string `json:"productId"`
	VariantSize string `json:"variantSize"`
	NewQty      int    `json:"newQty"`
	Reason      string `json:"reason"`
}

// bumpOutletTx runs fn in a tx and, on success, bumps ONLY the given outlet's
// content_version under "products" so the POS re-syncs the new on-hand.
func (r *Repo) bumpOutletTx(ctx context.Context, outletID string, fn func(pgx.Tx) error) error {
	t, err := r.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer t.Rollback(ctx)
	if err := fn(t); err != nil {
		return err
	}
	if err := bumpVersionOutlets(ctx, t, "products", []string{outletID}); err != nil {
		return fmt.Errorf("bump version: %w", err)
	}
	return t.Commit(ctx)
}

// stockOutletTx is bumpOutletTx for writers that CHANGE the outlet's on-hand stock
// (goods receipt, adjust): after the content version it also advances the outlet's
// stock change counter, LAST (A15 Phase B). SetOutletPar keeps bumpOutletTx: a par
// level changes no stock and must not move the counter.
func (r *Repo) stockOutletTx(ctx context.Context, outletID string, fn func(pgx.Tx) error) error {
	t, err := r.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer t.Rollback(ctx)
	if err := stockOutletWork(ctx, t, outletID, fn); err != nil {
		return err
	}
	return t.Commit(ctx)
}

// stockOutletWork is stockOutletTx inside a caller-owned transaction: fn, the outlet's
// content version, then BumpStockSeq as the last statement. It neither begins nor commits.
func stockOutletWork(ctx context.Context, t pgx.Tx, outletID string, fn func(pgx.Tx) error) error {
	if err := fn(t); err != nil {
		return err
	}
	if err := bumpVersionOutlets(ctx, t, "products", []string{outletID}); err != nil {
		return fmt.Errorf("bump version: %w", err)
	}
	if _, err := BumpStockSeq(ctx, t, outletID); err != nil {
		return err
	}
	return nil
}

// locationWork runs work in its own transaction: warehouse writes bump nothing, outlet
// writes bump the content version and the stock counter.
func (r *Repo) locationWork(ctx context.Context, kind, locID string, work func(pgx.Tx) error) error {
	if kind == "warehouse" {
		return r.noBumpTx(ctx, work)
	}
	return r.stockOutletTx(ctx, locID, work)
}

// locationWorkTx is locationWork inside the caller's transaction.
func locationWorkTx(ctx context.Context, tx pgx.Tx, kind, locID string, work func(pgx.Tx) error) error {
	if kind == "warehouse" {
		return work(tx)
	}
	return stockOutletWork(ctx, tx, locID, work)
}

// locationIDs maps a location kind to the (warehouse_id, outlet_id) column values.
func locationIDs(kind, locID string) (whID, outID any) {
	if kind == "warehouse" {
		return locID, nil
	}
	return nil, locID
}

func ledgerLocation(kind string) ledger.LocationType {
	if kind == "warehouse" {
		return ledger.LocWarehouse
	}
	return ledger.LocOutlet
}

// CreateLocationGoodsReceipt records a goods-in for an outlet OR warehouse and
// INCREMENTS that location's stock per line. Outlet writes bump the outlet's
// content_version; warehouse writes do not.
func (r *Repo) CreateLocationGoodsReceipt(ctx context.Context, kind, locID, createdBy string, g GoodsReceipt) error {
	if err := validateGoodsReceipt(kind, g.Items); err != nil {
		return err
	}
	return r.locationWork(ctx, kind, locID, goodsReceiptWork(ctx, kind, locID, createdBy, g))
}

// CreateLocationGoodsReceiptTx is CreateLocationGoodsReceipt inside the caller's
// transaction (an idempotency receipt claim). It neither begins, commits nor retries.
func (r *Repo) CreateLocationGoodsReceiptTx(ctx context.Context, tx pgx.Tx, kind, locID, createdBy string, g GoodsReceipt) error {
	if err := validateGoodsReceipt(kind, g.Items); err != nil {
		return err
	}
	return locationWorkTx(ctx, tx, kind, locID, goodsReceiptWork(ctx, kind, locID, createdBy, g))
}

// goodsReceiptWork is the receipt body: header + items, the stock upsert, then the
// ledger rows (before the caller's bumps).
func goodsReceiptWork(ctx context.Context, kind, locID, createdBy string, g GoodsReceipt) func(pgx.Tx) error {
	whID, outID := locationIDs(kind, locID)
	return func(t pgx.Tx) error {
		var rid string
		if e := t.QueryRow(ctx,
			`INSERT INTO goods_receipts (warehouse_id, outlet_id, supplier, note, created_by)
			 VALUES ($1,$2,$3,$4,$5) RETURNING id`,
			whID, outID, nullStr(g.Supplier), nullStr(g.Note), nullUUID(createdBy)).Scan(&rid); e != nil {
			return e
		}
		for _, it := range g.Items {
			if _, e := t.Exec(ctx,
				`INSERT INTO goods_receipt_items (receipt_id, product_id, variant_size, qty, unit_cost)
				 VALUES ($1,$2,$3,$4,$5)`,
				rid, it.ProductID, it.VariantSize, it.Qty, it.UnitCost); e != nil {
				return e
			}
		}
		if e := upsertReceiptStock(ctx, t, kind, locID, g.Items); e != nil {
			return e
		}
		return recordReceiptMovements(ctx, t, kind, locID, createdBy, rid, g.Items)
	}
}

// upsertReceiptStock adds the receipt lines to stock in ONE statement whose rows are
// inserted/locked in (product_id, variant_size) order, the same order sales and refunds
// use (A42); duplicate lines add up. Outlet: touch ONLY stock, preserving available +
// par_level.
func upsertReceiptStock(ctx context.Context, t pgx.Tx, kind, locID string, items []GoodsReceiptItem) error {
	pids := make([]string, len(items))
	sizes := make([]string, len(items))
	qtys := make([]int32, len(items))
	for i, it := range items {
		pids[i], sizes[i], qtys[i] = it.ProductID, it.VariantSize, int32(it.Qty)
	}
	table, locCol := "outlet_variant_stock", "outlet_id"
	if kind == "warehouse" {
		table, locCol = "warehouse_variant_stock", "warehouse_id"
	}
	// table/locCol come from the two constants above, never from input.
	_, e := t.Exec(ctx,
		`INSERT INTO `+table+` (`+locCol+`, product_id, variant_size, stock)
		 SELECT $1::uuid, k.pid, k.size, k.qty
		   FROM (SELECT u.pid, u.size, SUM(u.qty)::int AS qty
		           FROM unnest($2::uuid[], $3::text[], $4::int[]) AS u(pid, size, qty)
		          GROUP BY u.pid, u.size) k
		  ORDER BY k.pid, k.size
		 ON CONFLICT (`+locCol+`, product_id, variant_size)
		   DO UPDATE SET stock = `+table+`.stock + EXCLUDED.stock`,
		locID, pids, sizes, qtys)
	return e
}

// recordReceiptMovements writes one `receipt` ledger row per DISTINCT (product, size),
// qty summed, in the same (product, size) order as the upsert. Runs after the upsert and
// before the outlet bumps, so BumpStockSeq stays the last statement.
func recordReceiptMovements(ctx context.Context, t pgx.Tx, kind, locID, createdBy, rid string, items []GoodsReceiptItem) error {
	type key struct{ pid, size string }
	sums := map[key]int{}
	var keys []key
	for _, it := range items {
		// Any spelling PostgreSQL accepts for a uuid lands on one canonical key.
		pid, err := uuid.Parse(it.ProductID)
		if err != nil {
			return fmt.Errorf("goods receipt: product id %q is not a uuid", it.ProductID)
		}
		k := key{pid.String(), it.VariantSize}
		if _, seen := sums[k]; !seen {
			keys = append(keys, k)
		}
		sums[k] += it.Qty
	}
	sort.Slice(keys, func(i, j int) bool {
		if keys[i].pid != keys[j].pid {
			return keys[i].pid < keys[j].pid
		}
		return keys[i].size < keys[j].size
	})
	doc := ledger.Document{
		Key: "receipt:" + rid, Kind: ledger.KindReceipt,
		LocationType: ledgerLocation(kind), LocationID: locID,
		RefType: "goods_receipt", RefID: rid, Actor: createdBy,
		OccurredAt: time.Now(), Lines: make([]ledger.Line, 0, len(keys)),
	}
	for _, k := range keys {
		doc.Lines = append(doc.Lines, ledger.Line{
			ProductID: k.pid, VariantSize: k.size, Qty: sums[k],
			RefLine: k.pid + ":" + k.size, DedupeKey: "receipt:" + rid + ":" + k.pid + ":" + k.size,
		})
	}
	_, err := ledger.RecordDeltas(ctx, t, doc)
	return err
}

// AdjustLocationStock SETS the absolute on-hand qty for an outlet OR warehouse +
// logs the correction. Outlet writes touch ONLY stock (preserve available +
// par_level) and bump the outlet's content_version.
func (r *Repo) AdjustLocationStock(ctx context.Context, kind, locID, createdBy string, a WarehouseAdjust) error {
	if err := validateLocationAdjust(kind, a.NewQty, a.Reason); err != nil {
		return err
	}
	return r.locationWork(ctx, kind, locID, adjustWork(ctx, kind, locID, createdBy, a))
}

// AdjustLocationStockTx is AdjustLocationStock inside the caller's transaction (an
// idempotency receipt claim). It neither begins, commits nor retries.
func (r *Repo) AdjustLocationStockTx(ctx context.Context, tx pgx.Tx, kind, locID, createdBy string, a WarehouseAdjust) error {
	if err := validateLocationAdjust(kind, a.NewQty, a.Reason); err != nil {
		return err
	}
	return locationWorkTx(ctx, tx, kind, locID, adjustWork(ctx, kind, locID, createdBy, a))
}

// adjustWork locks the row and reads the old qty, applies the absolute set, logs the
// correction and records the ledger movement (new - old; a no-op records nothing).
func adjustWork(ctx context.Context, kind, locID, createdBy string, a WarehouseAdjust) func(pgx.Tx) error {
	core := adjustWorkCore(ctx, kind, locID, createdBy, a, adjustMeta{})
	return func(t pgx.Tx) error {
		// The direct, absolute adjust is closed while approval is on (inventory_approval_required):
		// read inside this transaction, before any stock is touched.
		if e := requireNoApproval(ctx, t); e != nil {
			return e
		}
		return core(t)
	}
}

// adjustMeta turns the absolute adjust into the apply step of an approved request: delta
// replaces the absolute new qty (new = live + delta, which may be negative), and the request id and
// reason code ride on the adjustment row. result, when set, receives what was applied.
type adjustMeta struct {
	delta      *int
	requestID  string
	reasonCode string
	result     *adjustResult
}

type adjustResult struct {
	ID            string
	Before, After int
}

// ApplyAdjustmentDeltaTx applies an approved adjustment request's delta to live stock inside
// the caller's transaction (ledger kind adjust, same writer as the direct adjust). It neither
// begins, commits nor retries.
func ApplyAdjustmentDeltaTx(ctx context.Context, tx pgx.Tx, kind, locID, actor string, a WarehouseAdjust, delta int, requestID, reasonCode string) (adjustResult, error) {
	var res adjustResult
	m := adjustMeta{delta: &delta, requestID: requestID, reasonCode: reasonCode, result: &res}
	err := locationWorkTx(ctx, tx, kind, locID, adjustWorkCore(ctx, kind, locID, actor, a, m))
	return res, err
}

func adjustWorkCore(ctx context.Context, kind, locID, createdBy string, a WarehouseAdjust, m adjustMeta) func(pgx.Tx) error {
	whID, outID := locationIDs(kind, locID)
	return func(t pgx.Tx) error {
		old, e := lockAdjustStock(ctx, t, kind, locID, a)
		if e != nil {
			return e
		}
		if m.delta != nil {
			// the approved delta may take stock negative, as a count approval does (owner, 2026-10-25)
			a.NewQty = old + *m.delta
		}
		if e := setAdjustStock(ctx, t, kind, locID, a); e != nil {
			return e
		}
		var adjID string
		if e := t.QueryRow(ctx,
			`INSERT INTO warehouse_stock_adjustments (warehouse_id, outlet_id, product_id, variant_size, new_qty, reason, created_by, request_id, reason_code)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
			whID, outID, a.ProductID, a.VariantSize, a.NewQty, a.Reason, nullUUID(createdBy),
			nullUUID(m.requestID), nullStr(m.reasonCode)).Scan(&adjID); e != nil {
			return e
		}
		if m.result != nil {
			*m.result = adjustResult{ID: adjID, Before: old, After: a.NewQty}
		}
		_, e = ledger.Record(ctx, t, ledger.Document{
			Key: "adjust:" + adjID, Kind: ledger.KindAdjust,
			LocationType: ledgerLocation(kind), LocationID: locID,
			RefType: "stock_adjustment", RefID: adjID, Actor: createdBy, OccurredAt: time.Now(),
			Lines: []ledger.Line{{
				ProductID: a.ProductID, VariantSize: a.VariantSize, Qty: a.NewQty - old,
				QtyBefore: old, QtyAfter: a.NewQty, DedupeKey: "adjust:" + adjID,
			}},
		})
		return e
	}
}

// lockAdjustStock makes sure the stock row exists (a lazy zero row, no quantity change)
// and locks it, returning the old qty for the ledger's before/after.
func lockAdjustStock(ctx context.Context, t pgx.Tx, kind, locID string, a WarehouseAdjust) (int, error) {
	zeroRow, lockRow := "", ""
	if kind == "warehouse" {
		zeroRow = `INSERT INTO warehouse_variant_stock (warehouse_id, product_id, variant_size, stock)
			 VALUES ($1,$2,$3,0)
			 ON CONFLICT (warehouse_id, product_id, variant_size) DO NOTHING`
		lockRow = `SELECT stock FROM warehouse_variant_stock WHERE warehouse_id=$1 AND product_id=$2 AND variant_size=$3 FOR UPDATE`
	} else {
		zeroRow = `INSERT INTO outlet_variant_stock (outlet_id, product_id, variant_size, stock)
			 VALUES ($1,$2,$3,0)
			 ON CONFLICT (outlet_id, product_id, variant_size) DO NOTHING`
		lockRow = `SELECT stock FROM outlet_variant_stock WHERE outlet_id=$1 AND product_id=$2 AND variant_size=$3 FOR UPDATE`
	}
	if _, e := t.Exec(ctx, zeroRow, locID, a.ProductID, a.VariantSize); e != nil {
		return 0, e
	}
	var old int
	e := t.QueryRow(ctx, lockRow, locID, a.ProductID, a.VariantSize).Scan(&old)
	return old, e
}

// setAdjustStock writes the absolute qty. Outlet: touch ONLY stock, preserving
// available + par_level.
func setAdjustStock(ctx context.Context, t pgx.Tx, kind, locID string, a WarehouseAdjust) error {
	if kind == "warehouse" {
		_, e := t.Exec(ctx,
			`INSERT INTO warehouse_variant_stock (warehouse_id, product_id, variant_size, stock)
			 VALUES ($1,$2,$3,$4)
			 ON CONFLICT (warehouse_id, product_id, variant_size) DO UPDATE SET stock=EXCLUDED.stock`,
			locID, a.ProductID, a.VariantSize, a.NewQty)
		return e
	}
	_, e := t.Exec(ctx,
		`INSERT INTO outlet_variant_stock (outlet_id, product_id, variant_size, stock)
		 VALUES ($1,$2,$3,$4)
		 ON CONFLICT (outlet_id, product_id, variant_size) DO UPDATE SET stock=EXCLUDED.stock`,
		locID, a.ProductID, a.VariantSize, a.NewQty)
	return e
}

// SetOutletPar upserts ONLY par_level for one (outlet, product, variant),
// preserving stock + available. Bumps the outlet version (cheap; future-proofs
// any POS low-stock consumer). par == nil clears the threshold.
func (r *Repo) SetOutletPar(ctx context.Context, outletID, productID, variantSize string, par *int) error {
	return r.bumpOutletTx(ctx, outletID, func(t pgx.Tx) error {
		// First-insert path omits stock/available on purpose — their NOT NULL
		// DEFAULTs (stock 0, available true) seed a fresh row; the conflict path
		// touches only par_level, preserving any existing stock/available.
		_, e := t.Exec(ctx,
			`INSERT INTO outlet_variant_stock (outlet_id, product_id, variant_size, par_level)
			 VALUES ($1,$2,$3,$4)
			 ON CONFLICT (outlet_id, product_id, variant_size) DO UPDATE SET par_level=EXCLUDED.par_level`,
			outletID, productID, variantSize, par)
		return e
	})
}

// liveLocationStock reads the live on-hand qty of a variant at an outlet or warehouse (no row
// counts as 0) without locking it: what a requester sees when they ask for an adjustment.
func liveLocationStock(ctx context.Context, t pgx.Tx, kind, locID, productID, size string) (int, error) {
	q := `SELECT COALESCE((SELECT stock FROM outlet_variant_stock WHERE outlet_id=$1 AND product_id=$2 AND variant_size=$3),0)`
	if kind == "warehouse" {
		q = `SELECT COALESCE((SELECT stock FROM warehouse_variant_stock WHERE warehouse_id=$1 AND product_id=$2 AND variant_size=$3),0)`
	}
	var live int
	err := t.QueryRow(ctx, q, locID, productID, size).Scan(&live)
	return live, err
}
