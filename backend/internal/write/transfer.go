package write

import (
	"context"
	"errors"
	"fmt"
	"github.com/mandalika/pos-backend/internal/apperr"
	"github.com/mandalika/pos-backend/internal/ledger"
	"time"

	"github.com/google/uuid"
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
	// Approval (A08) is the single-use online step-up grant a POS receive must spend.
	// nil for the backoffice receive. When set, received_by comes from the grant's
	// approver, never from ReceivedBy.
	Approval *ApprovalBinding
}

// loaded transfer row (locations are nil for the leg that is the other kind).
type transferRow struct {
	status, number                                   string
	srcOutlet, srcWarehouse, dstOutlet, dstWarehouse *string
}

type transferLine struct {
	id, pid, size string
	sent          int
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
	seen := make(map[string]struct{}, len(items))
	for _, it := range items {
		pid := it.ProductID
		if u, e := uuid.Parse(pid); e == nil {
			pid = u.String()
		}
		k := pid + "|" + it.VariantSize
		if _, dup := seen[k]; dup {
			return fmt.Errorf("produk dengan ukuran yang sama muncul lebih dari sekali; gabungkan jumlahnya dalam satu baris")
		}
		seen[k] = struct{}{}
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
		`SELECT status, transfer_no, source_outlet_id, source_warehouse_id, dest_outlet_id, dest_warehouse_id
		   FROM transfers WHERE id=$1 FOR UPDATE`, id).Scan(
		&t.status, &t.number, &t.srcOutlet, &t.srcWarehouse, &t.dstOutlet, &t.dstWarehouse)
	if errors.Is(e, pgx.ErrNoRows) {
		return t, ErrNotFound
	}
	return t, e
}

// transferLines returns lines sorted by (product_id, variant_size) so stock rows
// are always locked in one deterministic order (no deadlocks between transfers).
func transferLines(ctx context.Context, q pgx.Tx, id string) ([]transferLine, error) {
	rows, e := q.Query(ctx,
		`SELECT id, product_id, variant_size, sent_qty FROM transfer_items WHERE transfer_id=$1
		  ORDER BY product_id, variant_size, id`, id)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	var out []transferLine
	for rows.Next() {
		var l transferLine
		if e := rows.Scan(&l.id, &l.pid, &l.size, &l.sent); e != nil {
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
var errInsufficientStock = apperr.Wrap(apperr.Rejected, fmt.Errorf("stok tidak cukup untuk dikirim"))

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
	var id string
	err := r.noBumpTx(ctx, func(tx pgx.Tx) error {
		var e error
		id, e = createTransferTx(ctx, tx, createdBy, t)
		return e
	})
	return id, err
}

// createTransferTx inserts a draft transfer and its lines inside the caller's
// transaction (no stock movement, no version bump). Callers validate first.
// A requisition fulfil creates its draft through it so the PB link, the event and
// the transfer commit together.
func createTransferTx(ctx context.Context, tx pgx.Tx, createdBy string, t TransferCreate) (string, error) {
	so, sw := locCols(t.Source)
	do, dw := locCols(t.Dest)
	var id string
	if e := tx.QueryRow(ctx,
		`INSERT INTO transfers (status, source_outlet_id, source_warehouse_id,
		   dest_outlet_id, dest_warehouse_id, note, created_by)
		 VALUES ('draft',$1,$2,$3,$4,$5,$6) RETURNING id`,
		nullUUID(so), nullUUID(sw), nullUUID(do), nullUUID(dw),
		nullStr(t.Note), nullUUID(createdBy)).Scan(&id); e != nil {
		return "", e
	}
	return id, insertTransferItems(ctx, tx, id, t.Items)
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
	return retryBusy(ctx, func() error { return r.inTx(ctx, func(tx pgx.Tx) error { return r.sendTransfer(ctx, tx, id, "") }) })
}

// SendTransferTx is SendTransfer inside the caller's transaction (an idempotency
// receipt claim). It neither begins, commits nor retries. actor ("" allowed) is the
// acting user id recorded on the ledger rows.
func (r *Repo) SendTransferTx(ctx context.Context, tx pgx.Tx, id, actor string) error {
	return r.sendTransfer(ctx, tx, id, actor)
}

// inTx runs fn in one fresh transaction: commit on success, roll back otherwise.
func (r *Repo) inTx(ctx context.Context, fn func(tx pgx.Tx) error) error {
	tx, err := r.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if e := fn(tx); e != nil {
		return e
	}
	return tx.Commit(ctx)
}

func (r *Repo) sendTransfer(ctx context.Context, tx pgx.Tx, id, actor string) error {
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
	// Ledger rows BEFORE the outlet bumps (the bump stays the last statement).
	if e := recordTransferMovements(ctx, tx, ledger.KindTransferOut, id, t, lines, sjNo, actor, nil); e != nil {
		return e
	}
	if t.srcOutlet != nil {
		if e := bumpVersionOutlets(ctx, tx, "products", []string{*t.srcOutlet}); e != nil {
			return e
		}
		// A15 Phase B: the source outlet's stock just dropped. LAST, once (a warehouse
		// source has no outlet counter).
		if _, e := BumpStockSeq(ctx, tx, *t.srcOutlet); e != nil {
			return e
		}
	}
	return nil
}

// ReceiveTransfer credits the dest with the ACTUAL received qty per line, records
// each line's difference (received - sent), requires a discrepancy reason when
// any line differs, completes the transfer, and bumps the dest outlet leg if any.
// The payload is keyed by product+size, not line id: see receivedPerLine.
func (r *Repo) ReceiveTransfer(ctx context.Context, id string, rcv TransferReceive, meta ReceiveMeta) error {
	return retryBusy(ctx, func() error { return r.receiveTransfer(ctx, id, rcv, meta) })
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

	// A transfer that is already completed was received by someone. By THIS exact
	// receive key it is a duplicate → succeed as a no-op (so the POS outbox acks
	// instead of dead-lettering). By a different (or no) key it is a competing
	// receipt: first valid receive wins, this one needs review.
	if t.status == "completed" {
		var existing *string
		if e := tx.QueryRow(ctx,
			`SELECT received_idempotency_key FROM transfers WHERE id=$1`, id).Scan(&existing); e != nil {
			return e
		}
		if meta.IdempotencyKey != "" && existing != nil && *existing == meta.IdempotencyKey {
			return tx.Commit(ctx) // already applied by this receive
		}
		return errCompetingReceipt(t.status)
	}

	if _, e := transferTransition(t.status, "receive"); e != nil {
		return e
	}
	// A08: spend the approval grant (lock order: transfer row, then grant row). Any
	// later error rolls the whole transaction back, so the grant is not burnt.
	if meta.Approval != nil {
		approver, e := consumeApproval(ctx, tx, id, t, meta.Approval)
		if e != nil {
			return e
		}
		meta.ReceivedBy = approver
	}
	lines, e := transferLines(ctx, tx, id)
	if e != nil {
		return e
	}

	// Resolve one received qty per line; a line not supplied defaults to its
	// sent qty (received in full, no discrepancy).
	received, e := receivedPerLine(lines, rcv.Items)
	if e != nil {
		return e
	}
	anyDiff := false
	for i, l := range lines {
		if received[i] != l.sent {
			anyDiff = true
		}
	}
	if anyDiff && rcv.DiscrepancyReason == "" {
		return apperr.Wrap(apperr.Rejected, fmt.Errorf("alasan selisih wajib diisi"))
	}

	for i, l := range lines {
		got := received[i]
		if e := addStockDelta(ctx, tx, t.dstOutlet, t.dstWarehouse, l.pid, l.size, got); e != nil {
			return e
		}
		if _, e := tx.Exec(ctx,
			`UPDATE transfer_items SET received_qty=$1, difference=$2 WHERE id=$3`,
			got, transferDiff(l.sent, got), l.id); e != nil {
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

	// Ledger rows BEFORE the bump. The replay branch above returns before this, so a
	// replayed receive records nothing.
	if e := recordTransferMovements(ctx, tx, ledger.KindTransferIn, id, t, lines, ttNo, meta.ReceivedBy, received); e != nil {
		return e
	}

	// A15 Phase B: the destination outlet's stock just rose. LAST, once, after the TT
	// stamp so the counter row lock is held for the shortest time. The replay branch
	// above returns before this and so never bumps.
	if t.dstOutlet != nil {
		if _, e := BumpStockSeq(ctx, tx, *t.dstOutlet); e != nil {
			return e
		}
	}
	return tx.Commit(ctx)
}

// CancelTransfer voids a draft (no stock effect) or reverses an in_transit
// transfer (restore each line's sent qty to the source, bump source outlet leg).
func (r *Repo) CancelTransfer(ctx context.Context, id string) error {
	return retryBusy(ctx, func() error { return r.inTx(ctx, func(tx pgx.Tx) error { return r.cancelTransfer(ctx, tx, id, "") }) })
}

// CancelTransferTx is CancelTransfer inside the caller's transaction (an idempotency
// receipt claim). It neither begins, commits nor retries. actor as in SendTransferTx.
func (r *Repo) CancelTransferTx(ctx context.Context, tx pgx.Tx, id, actor string) error {
	return r.cancelTransfer(ctx, tx, id, actor)
}

func (r *Repo) cancelTransfer(ctx context.Context, tx pgx.Tx, id, actor string) error {
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
		// Ledger rows BEFORE the bump (a draft moved no stock, so it records nothing).
		if e := recordTransferMovements(ctx, tx, ledger.KindTransferCancel, id, t, lines, t.number, actor, nil); e != nil {
			return e
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
	// A15 Phase B: only an in-transit cancel put stock back (a draft moved none), and
	// only into an outlet source. LAST, once.
	if t.status == "in_transit" && t.srcOutlet != nil {
		if _, e := BumpStockSeq(ctx, tx, *t.srcOutlet); e != nil {
			return e
		}
	}
	return nil
}
