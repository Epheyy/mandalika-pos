package write

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type TransferItemInput struct {
	ProductID   string `json:"productId"`
	VariantSize string `json:"variantSize"`
	Qty         int    `json:"qty"`
}

type TransferCreate struct {
	Source TransferLoc         `json:"source"`
	Dest   TransferLoc         `json:"dest"`
	Note   string              `json:"note"`
	Items  []TransferItemInput `json:"items"`
}

type TransferReceiveItem struct {
	ProductID   string `json:"productId"`
	VariantSize string `json:"variantSize"`
	ReceivedQty int    `json:"receivedQty"`
}

type TransferReceive struct {
	Items             []TransferReceiveItem `json:"items"`
	DiscrepancyReason string                `json:"discrepancyReason"`
}

type ReceiveMeta struct {
	ReceivedBy     string // approver/admin user id ("" allowed)
	ReceivedVia    string // "pos" | "backoffice"
	IdempotencyKey string // POS offline retry guard ("" for backoffice)
}

// loaded transfer row (locations are nil for the leg that is the other kind).
type transferRow struct {
	status                                           string
	srcOutlet, srcWarehouse, dstOutlet, dstWarehouse *string
}

type transferLine struct {
	pid, size string
	sent      int
}

func validateLocs(src, dst TransferLoc) error {
	if !validLocKind(src.Kind) || src.ID == "" {
		return fmt.Errorf("sumber tidak valid")
	}
	if !validLocKind(dst.Kind) || dst.ID == "" {
		return fmt.Errorf("tujuan tidak valid")
	}
	if sameLoc(src, dst) {
		return fmt.Errorf("sumber dan tujuan tidak boleh sama")
	}
	return nil
}

// locCols returns ("", id) for a warehouse and (id, "") for an outlet, ready for
// nullUUID() into the (outlet_id, warehouse_id) column pair.
func locCols(loc TransferLoc) (outletID, warehouseID string) {
	if loc.Kind == "outlet" {
		return loc.ID, ""
	}
	return "", loc.ID
}

func validateItems(items []TransferItemInput) error {
	if len(items) == 0 {
		return fmt.Errorf("minimal satu item")
	}
	for _, it := range items {
		if it.Qty <= 0 {
			return fmt.Errorf("qty harus lebih dari 0")
		}
	}
	return nil
}

func insertTransferItems(ctx context.Context, tx pgx.Tx, id string, items []TransferItemInput) error {
	for _, it := range items {
		if _, e := tx.Exec(ctx,
			`INSERT INTO transfer_items (transfer_id, product_id, variant_size, sent_qty)
			 VALUES ($1,$2,$3,$4)`, id, it.ProductID, it.VariantSize, it.Qty); e != nil {
			return e
		}
	}
	return nil
}

// loadTransfer reads the transfer row WITH a row lock. Every state-changing path
// must call it first: lock order is the transfer row, then stock rows.
func loadTransfer(ctx context.Context, q pgx.Tx, id string) (transferRow, error) {
	var t transferRow
	e := q.QueryRow(ctx,
		`SELECT status, source_outlet_id, source_warehouse_id, dest_outlet_id, dest_warehouse_id
		   FROM transfers WHERE id=$1 FOR UPDATE`, id).Scan(
		&t.status, &t.srcOutlet, &t.srcWarehouse, &t.dstOutlet, &t.dstWarehouse)
	if errors.Is(e, pgx.ErrNoRows) {
		return t, ErrNotFound
	}
	return t, e
}

// transferLines returns lines sorted by (product_id, variant_size) so stock rows
// are always locked in one deterministic order (no deadlocks between transfers).
func transferLines(ctx context.Context, q pgx.Tx, id string) ([]transferLine, error) {
	rows, e := q.Query(ctx,
		`SELECT product_id, variant_size, sent_qty FROM transfer_items WHERE transfer_id=$1
		  ORDER BY product_id, variant_size`, id)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	var out []transferLine
	for rows.Next() {
		var l transferLine
		if e := rows.Scan(&l.pid, &l.size, &l.sent); e != nil {
			return nil, e
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

// addStockDelta applies a signed delta to the right stock table for one leg.
// Exactly one of outletID/warehouseID is non-nil. The column list mirrors
// stockcount.go so par_level/available keep their defaults.
func addStockDelta(ctx context.Context, q pgx.Tx, outletID, warehouseID *string, productID, size string, delta int) error {
	if outletID != nil {
		_, e := q.Exec(ctx,
			`INSERT INTO outlet_variant_stock (outlet_id, product_id, variant_size, stock)
			 VALUES ($1,$2,$3,$4)
			 ON CONFLICT (outlet_id, product_id, variant_size)
			   DO UPDATE SET stock = outlet_variant_stock.stock + EXCLUDED.stock`,
			*outletID, productID, size, delta)
		return e
	}
	_, e := q.Exec(ctx,
		`INSERT INTO warehouse_variant_stock (warehouse_id, product_id, variant_size, stock)
		 VALUES ($1,$2,$3,$4)
		 ON CONFLICT (warehouse_id, product_id, variant_size)
		   DO UPDATE SET stock = warehouse_variant_stock.stock + EXCLUDED.stock`,
		*warehouseID, productID, size, delta)
	return e
}

// errInsufficientStock is the domain error when a send would overdraw the source.
var errInsufficientStock = fmt.Errorf("stok tidak cukup untuk dikirim")

// deductStockGuarded atomically subtracts qty from the source leg only if enough
// is on hand (a missing stock row counts as 0). Check and write are one statement,
// so concurrent sends from the same source cannot both pass the guard.
func deductStockGuarded(ctx context.Context, q pgx.Tx, outletID, warehouseID *string, productID, size string, qty int) error {
	var ct pgconn.CommandTag
	var e error
	if outletID != nil {
		ct, e = q.Exec(ctx,
			`UPDATE outlet_variant_stock SET stock = stock - $4
			  WHERE outlet_id=$1 AND product_id=$2 AND variant_size=$3 AND stock >= $4`,
			*outletID, productID, size, qty)
	} else {
		ct, e = q.Exec(ctx,
			`UPDATE warehouse_variant_stock SET stock = stock - $4
			  WHERE warehouse_id=$1 AND product_id=$2 AND variant_size=$3 AND stock >= $4`,
			*warehouseID, productID, size, qty)
	}
	if e != nil {
		return e
	}
	if ct.RowsAffected() != 1 {
		return errInsufficientStock
	}
	return nil
}

// guardedStatusUpdate runs a status UPDATE whose WHERE ends in `id=$1 AND status=$2`
// and requires exactly one row. The row lock already serializes callers; this makes
// a lost race fail closed with the same error as any invalid transition.
func guardedStatusUpdate(ctx context.Context, q pgx.Tx, from, sql, id string, extra ...any) error {
	ct, e := q.Exec(ctx, sql, append([]any{id, from}, extra...)...)
	if e != nil {
		return e
	}
	if ct.RowsAffected() != 1 {
		return errTransitionDenied(from)
	}
	return nil
}

// CreateTransfer records a draft (no stock movement, no version bump).
func (r *Repo) CreateTransfer(ctx context.Context, createdBy string, t TransferCreate) (string, error) {
	if e := validateLocs(t.Source, t.Dest); e != nil {
		return "", e
	}
	if e := validateItems(t.Items); e != nil {
		return "", e
	}
	so, sw := locCols(t.Source)
	do, dw := locCols(t.Dest)
	var id string
	err := r.noBumpTx(ctx, func(tx pgx.Tx) error {
		if e := tx.QueryRow(ctx,
			`INSERT INTO transfers (status, source_outlet_id, source_warehouse_id,
			   dest_outlet_id, dest_warehouse_id, note, created_by)
			 VALUES ('draft',$1,$2,$3,$4,$5,$6) RETURNING id`,
			nullUUID(so), nullUUID(sw), nullUUID(do), nullUUID(dw),
			nullStr(t.Note), nullUUID(createdBy)).Scan(&id); e != nil {
			return e
		}
		return insertTransferItems(ctx, tx, id, t.Items)
	})
	return id, err
}

// UpdateTransferDraft replaces a draft's note + items. Source/dest are fixed at
// create and ignored here. Only drafts are editable.
func (r *Repo) UpdateTransferDraft(ctx context.Context, id string, t TransferCreate) error {
	if e := validateItems(t.Items); e != nil {
		return e
	}
	return mapBusy(r.noBumpTx(ctx, func(tx pgx.Tx) error {
		var status string
		e := tx.QueryRow(ctx, `SELECT status FROM transfers WHERE id=$1 FOR UPDATE`, id).Scan(&status)
		if errors.Is(e, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if e != nil {
			return e
		}
		if status != "draft" {
			return fmt.Errorf("hanya draft yang bisa diubah")
		}
		if _, e := tx.Exec(ctx, `UPDATE transfers SET note=$1 WHERE id=$2`, nullStr(t.Note), id); e != nil {
			return e
		}
		if _, e := tx.Exec(ctx, `DELETE FROM transfer_items WHERE transfer_id=$1`, id); e != nil {
			return e
		}
		return insertTransferItems(ctx, tx, id, t.Items)
	}))
}

// SendTransfer deducts each line from the source (guarding against oversend),
// marks the transfer in_transit, and bumps the source outlet leg if any.
func (r *Repo) SendTransfer(ctx context.Context, id string) error {
	return mapBusy(r.sendTransfer(ctx, id))
}

func (r *Repo) sendTransfer(ctx context.Context, id string) error {
	tx, err := r.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	t, e := loadTransfer(ctx, tx, id)
	if e != nil {
		return e
	}
	if _, e := transferTransition(t.status, "send"); e != nil {
		return e
	}
	lines, e := transferLines(ctx, tx, id)
	if e != nil {
		return e
	}
	// Atomic guarded decrement per line (lines are sorted, see transferLines).
	for _, l := range lines {
		if e := deductStockGuarded(ctx, tx, t.srcOutlet, t.srcWarehouse, l.pid, l.size, l.sent); e != nil {
			return e
		}
	}
	if e := guardedStatusUpdate(ctx, tx, t.status,
		`UPDATE transfers SET status='in_transit', sent_at=now() WHERE id=$1 AND status=$2`, id); e != nil {
		return e
	}
	// SP4: stamp the surat jalan number now that the transfer is in_transit
	// (integration verified at A10 — no DB-coupled unit test exists in this package).
	sjNo, e := nextDocNo(ctx, tx, "SJ", time.Now().Year())
	if e != nil {
		return e
	}
	if _, e := tx.Exec(ctx,
		`UPDATE transfers SET surat_jalan_no=$1 WHERE id=$2`, sjNo, id); e != nil {
		return e
	}
	if t.srcOutlet != nil {
		if e := bumpVersionOutlets(ctx, tx, "products", []string{*t.srcOutlet}); e != nil {
			return e
		}
	}
	return tx.Commit(ctx)
}

// ReceiveTransfer credits the dest with the ACTUAL received qty per line, records
// each line's difference (received - sent), requires a discrepancy reason when
// any line differs, completes the transfer, and bumps the dest outlet leg if any.
func (r *Repo) ReceiveTransfer(ctx context.Context, id string, rcv TransferReceive, meta ReceiveMeta) error {
	return mapBusy(r.receiveTransfer(ctx, id, rcv, meta))
}

func (r *Repo) receiveTransfer(ctx context.Context, id string, rcv TransferReceive, meta ReceiveMeta) error {
	tx, err := r.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	t, e := loadTransfer(ctx, tx, id)
	if e != nil {
		return e
	}

	// Idempotent retry: a transfer already completed by THIS exact receive key is a
	// duplicate → succeed as a no-op (so the POS outbox acks instead of dead-lettering).
	if meta.IdempotencyKey != "" {
		var existing *string
		if e := tx.QueryRow(ctx,
			`SELECT received_idempotency_key FROM transfers WHERE id=$1`, id).Scan(&existing); e != nil {
			return e
		}
		if t.status == "completed" && existing != nil && *existing == meta.IdempotencyKey {
			return tx.Commit(ctx) // already applied by this receive
		}
	}

	if _, e := transferTransition(t.status, "receive"); e != nil {
		return e
	}
	lines, e := transferLines(ctx, tx, id)
	if e != nil {
		return e
	}

	// Index supplied received quantities; a line not supplied defaults to its
	// sent qty (received in full, no discrepancy).
	recv := map[string]int{}
	for _, it := range rcv.Items {
		if it.ReceivedQty < 0 {
			return fmt.Errorf("jumlah terima tidak boleh negatif")
		}
		recv[it.ProductID+"|"+it.VariantSize] = it.ReceivedQty
	}
	type resolved struct {
		l   transferLine
		got int
	}
	res := make([]resolved, 0, len(lines))
	anyDiff := false
	for _, l := range lines {
		got, ok := recv[l.pid+"|"+l.size]
		if !ok {
			got = l.sent
		}
		if got != l.sent {
			anyDiff = true
		}
		res = append(res, resolved{l, got})
	}
	if anyDiff && rcv.DiscrepancyReason == "" {
		return fmt.Errorf("alasan selisih wajib diisi")
	}

	for _, rr := range res {
		if e := addStockDelta(ctx, tx, t.dstOutlet, t.dstWarehouse, rr.l.pid, rr.l.size, rr.got); e != nil {
			return e
		}
		if _, e := tx.Exec(ctx,
			`UPDATE transfer_items SET received_qty=$1, difference=$2
			   WHERE transfer_id=$3 AND product_id=$4 AND variant_size=$5`,
			rr.got, transferDiff(rr.l.sent, rr.got), id, rr.l.pid, rr.l.size); e != nil {
			return e
		}
	}
	if e := guardedStatusUpdate(ctx, tx, t.status,
		`UPDATE transfers SET status='completed', received_at=now(), discrepancy_reason=$3,
		   received_by=$4, received_via=$5, received_idempotency_key=$6 WHERE id=$1 AND status=$2`,
		id, nullStr(rcv.DiscrepancyReason), nullUUID(meta.ReceivedBy),
		nullStr(meta.ReceivedVia), nullStr(meta.IdempotencyKey)); e != nil {
		return e
	}
	if t.dstOutlet != nil {
		if e := bumpVersionOutlets(ctx, tx, "products", []string{*t.dstOutlet}); e != nil {
			return e
		}
	}

	// SP4: stamp the tanda terima number now that the transfer is completed.
	// The idempotent-replay early-return above bypasses this block, so a replay
	// never reassigns TT. (integration verified at A10 — no DB-coupled unit
	// test exists in this package.)
	ttNo, e := nextDocNo(ctx, tx, "TT", time.Now().Year())
	if e != nil {
		return e
	}
	if _, e := tx.Exec(ctx,
		`UPDATE transfers SET tanda_terima_no=$1 WHERE id=$2`, ttNo, id); e != nil {
		return e
	}

	return tx.Commit(ctx)
}

// CancelTransfer voids a draft (no stock effect) or reverses an in_transit
// transfer (restore each line's sent qty to the source, bump source outlet leg).
func (r *Repo) CancelTransfer(ctx context.Context, id string) error {
	return mapBusy(r.cancelTransfer(ctx, id))
}

func (r *Repo) cancelTransfer(ctx context.Context, id string) error {
	tx, err := r.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	t, e := loadTransfer(ctx, tx, id)
	if e != nil {
		return e
	}
	if _, e := transferTransition(t.status, "cancel"); e != nil {
		return e
	}
	if t.status == "in_transit" {
		lines, e := transferLines(ctx, tx, id)
		if e != nil {
			return e
		}
		for _, l := range lines {
			if e := addStockDelta(ctx, tx, t.srcOutlet, t.srcWarehouse, l.pid, l.size, l.sent); e != nil {
				return e
			}
		}
		if t.srcOutlet != nil {
			if e := bumpVersionOutlets(ctx, tx, "products", []string{*t.srcOutlet}); e != nil {
				return e
			}
		}
	}
	if e := guardedStatusUpdate(ctx, tx, t.status,
		`UPDATE transfers SET status='cancelled', cancelled_at=now() WHERE id=$1 AND status=$2`, id); e != nil {
		return e
	}
	return tx.Commit(ctx)
}
