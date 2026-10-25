package write

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/mandalika/pos-backend/internal/apperr"
)

// Database side of the Permintaan Barang (PB) state machine (logic: requisition.go).
// Every method runs inside the caller's transaction (an idempotency receipt claim) and
// writes one inventory_doc_events row per state change. No method moves stock: a fulfil
// only creates a transfer DRAFT, which moves stock through the existing send/receive.
//
// Lock order: the PB row, then (fulfil only) the linked transfer row.

// WithTx runs fn in one fresh transaction (commit on success, roll back otherwise). The
// unkeyed fallback of a keyed handler uses it; the handlers require a key, so it is a
// safety net rather than a live path.
func (r *Repo) WithTx(ctx context.Context, fn func(tx pgx.Tx) error) error {
	return r.inTx(ctx, fn)
}

type reqRow struct {
	status, number, outletID string
	warehouseID, transferID  *string
}

// lockRequisition reads the PB row WITH a row lock (ErrNotFound when missing).
func lockRequisition(ctx context.Context, tx pgx.Tx, id string) (reqRow, error) {
	var q reqRow
	e := tx.QueryRow(ctx,
		`SELECT status, number, outlet_id, warehouse_id, transfer_id
		   FROM stock_requisitions WHERE id=$1 FOR UPDATE`, id).Scan(
		&q.status, &q.number, &q.outletID, &q.warehouseID, &q.transferID)
	if errors.Is(e, pgx.ErrNoRows) {
		return q, ErrNotFound
	}
	return q, e
}

// lockOwnRequisition is lockRequisition for the outlet side: another outlet's PB is a 404.
func lockOwnRequisition(ctx context.Context, tx pgx.Tx, id, outletID string) (reqRow, error) {
	q, e := lockRequisition(ctx, tx, id)
	if e != nil {
		return q, e
	}
	if outletID == "" || !sameUUID(q.outletID, outletID) {
		return q, ErrNotFound
	}
	return q, nil
}

// lockVisibleRequisition is lockRequisition for the warehouse side: a draft is private to
// its outlet, so another outlet's draft is a 404 (not a state refusal that would leak it).
func lockVisibleRequisition(ctx context.Context, tx pgx.Tx, id, viewerOutlet string) (reqRow, error) {
	q, e := lockRequisition(ctx, tx, id)
	if e != nil {
		return q, e
	}
	if q.status == "draft" && (viewerOutlet == "" || !sameUUID(q.outletID, viewerOutlet)) {
		return q, ErrNotFound
	}
	return q, nil
}

func sameUUID(a, b string) bool { return strings.EqualFold(a, b) }

func requisitionLines(ctx context.Context, tx pgx.Tx, id string) ([]reqLine, error) {
	rows, e := tx.Query(ctx,
		`SELECT id, product_id, variant_size, requested_qty, approved_qty
		   FROM stock_requisition_items WHERE requisition_id=$1
		  ORDER BY product_id, variant_size, id`, id)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	var out []reqLine
	for rows.Next() {
		var l reqLine
		if e := rows.Scan(&l.id, &l.pid, &l.size, &l.requested, &l.approved); e != nil {
			return nil, e
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

func insertRequisitionItems(ctx context.Context, tx pgx.Tx, id string, items []RequisitionItemInput) error {
	for _, it := range items {
		if _, e := tx.Exec(ctx,
			`INSERT INTO stock_requisition_items (requisition_id, product_id, variant_size, requested_qty, note)
			 VALUES ($1,$2,$3,$4,$5)`,
			id, it.ProductID, it.VariantSize, it.RequestedQty, nullStr(it.Note)); e != nil {
			return e
		}
	}
	return nil
}

// insertRequisitionEvent appends one history row (the table is INSERT-only).
func insertRequisitionEvent(ctx context.Context, tx pgx.Tx, id, action, actor, note string, data map[string]any) error {
	if data == nil {
		data = map[string]any{}
	}
	raw, e := json.Marshal(data)
	if e != nil {
		return e
	}
	_, e = tx.Exec(ctx,
		`INSERT INTO inventory_doc_events (doc_type, doc_id, action, actor_id, note, data)
		 VALUES ('requisition', $1, $2, $3, $4, $5::jsonb)`,
		id, action, nullUUID(actor), nullStr(note), string(raw))
	return e
}

// CreateRequisitionTx records a draft for outletID (the authenticated scope's outlet).
func (r *Repo) CreateRequisitionTx(ctx context.Context, tx pgx.Tx, outletID, actor string, in RequisitionInput) (string, error) {
	if e := validateRequisitionInput(in); e != nil {
		return "", e
	}
	no, e := nextDocNo(ctx, tx, "PB", time.Now().Year())
	if e != nil {
		return "", e
	}
	var id string
	if e := tx.QueryRow(ctx,
		`INSERT INTO stock_requisitions (number, outlet_id, needed_by, note, requested_by)
		 VALUES ($1,$2,$3,$4,$5) RETURNING id`,
		no, outletID, nullStr(in.NeededBy), nullStr(in.Note), actor).Scan(&id); e != nil {
		return "", e
	}
	if e := insertRequisitionItems(ctx, tx, id, in.Items); e != nil {
		return "", e
	}
	return id, insertRequisitionEvent(ctx, tx, id, "created", actor, "", map[string]any{"number": no})
}

// UpdateRequisitionTx replaces a draft's note, date and lines (drafts only).
func (r *Repo) UpdateRequisitionTx(ctx context.Context, tx pgx.Tx, id, outletID, actor string, in RequisitionInput) error {
	if e := validateRequisitionInput(in); e != nil {
		return e
	}
	q, e := lockOwnRequisition(ctx, tx, id, outletID)
	if e != nil {
		return e
	}
	if q.status != "draft" {
		return errRequisitionDenied(q.status)
	}
	if _, e := tx.Exec(ctx,
		`UPDATE stock_requisitions SET note=$2, needed_by=$3, updated_at=now() WHERE id=$1`,
		id, nullStr(in.Note), nullStr(in.NeededBy)); e != nil {
		return e
	}
	if _, e := tx.Exec(ctx, `DELETE FROM stock_requisition_items WHERE requisition_id=$1`, id); e != nil {
		return e
	}
	if e := insertRequisitionItems(ctx, tx, id, in.Items); e != nil {
		return e
	}
	return insertRequisitionEvent(ctx, tx, id, "updated", actor, "", nil)
}

// SubmitRequisitionTx sends a draft to the warehouse.
func (r *Repo) SubmitRequisitionTx(ctx context.Context, tx pgx.Tx, id, outletID, actor string) error {
	q, e := lockOwnRequisition(ctx, tx, id, outletID)
	if e != nil {
		return e
	}
	to, e := requisitionTransition(q.status, "submit")
	if e != nil {
		return e
	}
	if _, e := tx.Exec(ctx,
		`UPDATE stock_requisitions SET status=$2, submitted_at=now(), updated_at=now() WHERE id=$1`, id, to); e != nil {
		return e
	}
	return insertRequisitionEvent(ctx, tx, id, "submitted", actor, "", nil)
}

// CancelRequisitionTx withdraws a draft or submitted PB (outlet side).
func (r *Repo) CancelRequisitionTx(ctx context.Context, tx pgx.Tx, id, outletID, actor string) error {
	q, e := lockOwnRequisition(ctx, tx, id, outletID)
	if e != nil {
		return e
	}
	to, e := requisitionTransition(q.status, "cancel")
	if e != nil {
		return e
	}
	if _, e := tx.Exec(ctx,
		`UPDATE stock_requisitions SET status=$2, cancelled_at=now(), updated_at=now() WHERE id=$1`, id, to); e != nil {
		return e
	}
	return insertRequisitionEvent(ctx, tx, id, "cancelled", actor, "", nil)
}

// ApproveRequisitionTx records the warehouse's per-line approved qty and source gudang.
func (r *Repo) ApproveRequisitionTx(ctx context.Context, tx pgx.Tx, id, viewerOutlet, actor string, ap RequisitionApproval) error {
	q, e := lockVisibleRequisition(ctx, tx, id, viewerOutlet)
	if e != nil {
		return e
	}
	to, e := requisitionTransition(q.status, "approve")
	if e != nil {
		return e
	}
	lines, e := requisitionLines(ctx, tx, id)
	if e != nil {
		return e
	}
	qty, e := resolveApproval(lines, ap.Items)
	if e != nil {
		return e
	}
	var active bool
	e = tx.QueryRow(ctx, `SELECT is_active FROM warehouses WHERE id=$1`, ap.WarehouseID).Scan(&active)
	if errors.Is(e, pgx.ErrNoRows) || (e == nil && !active) {
		return errRequisitionRejected("gudang sumber tidak ditemukan atau tidak aktif")
	}
	if e != nil {
		return e
	}
	total := 0
	for _, l := range lines {
		total += qty[l.id]
		if _, e := tx.Exec(ctx, `UPDATE stock_requisition_items SET approved_qty=$2 WHERE id=$1`, l.id, qty[l.id]); e != nil {
			return e
		}
	}
	if _, e := tx.Exec(ctx,
		`UPDATE stock_requisitions SET status=$2, warehouse_id=$3, decided_by=$4, decided_at=now(),
		   decision_note=$5, updated_at=now() WHERE id=$1`,
		id, to, ap.WarehouseID, nullUUID(actor), nullStr(ap.Note)); e != nil {
		return e
	}
	return insertRequisitionEvent(ctx, tx, id, "approved", actor, ap.Note,
		map[string]any{"warehouseId": ap.WarehouseID, "approvedQty": total})
}

// RejectRequisitionTx declines a submitted PB; the note is required.
func (r *Repo) RejectRequisitionTx(ctx context.Context, tx pgx.Tx, id, viewerOutlet, actor, note string) error {
	q, e := lockVisibleRequisition(ctx, tx, id, viewerOutlet)
	if e != nil {
		return e
	}
	to, e := requisitionTransition(q.status, "reject")
	if e != nil {
		return e
	}
	if strings.TrimSpace(note) == "" {
		return errRequisitionRejected("catatan penolakan wajib diisi")
	}
	if _, e := tx.Exec(ctx,
		`UPDATE stock_requisitions SET status=$2, decided_by=$3, decided_at=now(), decision_note=$4,
		   updated_at=now() WHERE id=$1`, id, to, nullUUID(actor), note); e != nil {
		return e
	}
	return insertRequisitionEvent(ctx, tx, id, "rejected", actor, note, nil)
}

// FulfilRequisitionTx creates the gudang -> toko transfer DRAFT with the approved quantities
// and links it, in the caller's transaction. A fulfilled PB may be fulfilled again only when
// its linked transfer was cancelled. Returns the new transfer's id and number.
func (r *Repo) FulfilRequisitionTx(ctx context.Context, tx pgx.Tx, id, viewerOutlet, actor string) (string, string, error) {
	q, e := lockVisibleRequisition(ctx, tx, id, viewerOutlet)
	if e != nil {
		return "", "", e
	}
	if _, e := requisitionTransition(q.status, "fulfil"); e != nil {
		return "", "", e
	}
	action, prevTransfer := "fulfilled", ""
	if q.status == "fulfilled" {
		// Lock order: PB row (above), then the linked transfer row.
		var tst string
		if q.transferID == nil {
			return "", "", errRequisitionDenied(q.status)
		}
		if e := tx.QueryRow(ctx, `SELECT status FROM transfers WHERE id=$1 FOR UPDATE`, *q.transferID).Scan(&tst); e != nil {
			return "", "", e
		}
		if !canRefulfil(tst) {
			return "", "", errRequisitionDenied(q.status)
		}
		action, prevTransfer = "refulfilled", *q.transferID
	}
	lines, e := requisitionLines(ctx, tx, id)
	if e != nil {
		return "", "", e
	}
	items := approvedTransferItems(lines)
	if len(items) == 0 {
		return "", "", apperr.Wrap(apperr.Conflict, errors.New("tidak ada qty disetujui untuk ditransfer")) // 409: nothing left
	}
	if q.warehouseID == nil {
		return "", "", errRequisitionDenied(q.status)
	}
	tid, e := createTransferTx(ctx, tx, actor, TransferCreate{
		Source: TransferLoc{Kind: "warehouse", ID: *q.warehouseID},
		Dest:   TransferLoc{Kind: "outlet", ID: q.outletID},
		Note:   "Permintaan Barang " + q.number,
		Items:  items,
	})
	if e != nil {
		return "", "", e
	}
	var tno string
	if e := tx.QueryRow(ctx, `SELECT transfer_no FROM transfers WHERE id=$1`, tid).Scan(&tno); e != nil {
		return "", "", e
	}
	if _, e := tx.Exec(ctx,
		`UPDATE stock_requisitions SET status='fulfilled', transfer_id=$2, fulfilled_by=$3,
		   fulfilled_at=now(), updated_at=now() WHERE id=$1`, id, tid, nullUUID(actor)); e != nil {
		return "", "", e
	}
	data := map[string]any{"transferId": tid, "transferNo": tno}
	if prevTransfer != "" {
		data["previousTransferId"] = prevTransfer
	}
	return tid, tno, insertRequisitionEvent(ctx, tx, id, action, actor, "", data)
}
