package write

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/mandalika/pos-backend/internal/apperr"
)

// Inventory controls S3: approval of manual stock adjustments and stock counts.
//
// Policy (owner answers 2 and 3, 2026-10-25): when app_settings.inventory_approval_required is
// on, every manual adjustment and every count with a difference waits for an approver. The
// approver is never the requester (admin included), is an admin or a receive_approver_roles
// user, re-enters their own receive PIN every time, and (for an outlet document) belongs to that
// outlet. A warehouse document accepts an admin or any approver-role user. An approved
// adjustment applies the requested DELTA, not the absolute quantity.
//
// This file owns no stock SQL: the stock writes stay in warehouse.go (ApplyAdjustmentDeltaTx)
// and stockcount.go (finishCount), the files the stock guards already classify.

const (
	docTypeStockCount = "stock_count"
	docTypeAdjustment = "adjustment_request"
)

var (
	// ErrApprovalRequired answers the direct adjust / complete endpoints while approval is on.
	ErrApprovalRequired = apperr.New(apperr.Conflict, "persetujuan diperlukan untuk perubahan stok ini")
	// ErrApprovalSelf: strict four-eyes, the approver took part in the document (see touchedBy).
	ErrApprovalSelf = apperr.New(apperr.Conflict, "penyetuju tidak boleh orang yang membuat, menghitung, atau mengajukan dokumen ini")
	// ErrApprovalNotPending: the document is not waiting for a decision (decided or cancelled).
	ErrApprovalNotPending = apperr.New(apperr.Conflict, "dokumen tidak sedang menunggu persetujuan")
	// ErrAdjustmentPending: one pending request per location and SKU.
	ErrAdjustmentPending = apperr.New(apperr.Conflict, "sudah ada permintaan penyesuaian yang menunggu persetujuan untuk SKU ini")
	// ErrApproverRevoked: the approver lost the right between the PIN check and the apply.
	ErrApproverRevoked = apperr.New(apperr.Forbidden, "persetujuan dicabut")
)

// reasonLabels are the reason codes of a stock change with their Indonesian label (the text a
// warehouse_stock_adjustments.reason carries).
var reasonLabels = map[string]string{
	"damaged": "Rusak", "expired": "Kedaluwarsa", "lost": "Hilang", "found": "Ditemukan",
	"data_entry": "Salah input", "tester_sample": "Tester/sampel", "count_variance": "Selisih opname",
	"other": "Lainnya",
}

const maxReasonTextLen = 500

// validateReason checks a reason code and its free text; "other" requires the text.
func validateReason(code, text string) error {
	if _, ok := reasonLabels[code]; !ok {
		return fmt.Errorf("kode alasan tidak valid")
	}
	text = strings.TrimSpace(text)
	if code == "other" && text == "" {
		return fmt.Errorf("alasan Lainnya wajib diisi teks")
	}
	if len(text) > maxReasonTextLen {
		return fmt.Errorf("teks alasan terlalu panjang")
	}
	return nil
}

// reasonSentence is the one-line reason stored on the adjustment row.
func reasonSentence(code, text string) string {
	text = strings.TrimSpace(text)
	if text == "" {
		return reasonLabels[code]
	}
	return reasonLabels[code] + ": " + text
}

// ApproverCovers is the scope rule: the user may approve a document of docOutlet ("" = a
// warehouse document). Admins always; otherwise the role must be an approver role, and an outlet
// document additionally needs the approver to belong to that outlet. ReceiveScope is not reused:
// it refuses warehouse destinations.
func ApproverCovers(role, approverOutlet, docOutlet string, approverRoles []string) bool {
	if !ApproverAllowed(role, approverRoles) {
		return false
	}
	if role == "admin" || docOutlet == "" {
		return true
	}
	return strings.EqualFold(approverOutlet, docOutlet)
}

// approvalRequiredOn reads the setting (no row = off).
func approvalRequiredOn(ctx context.Context, q interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}) (bool, error) {
	var on bool
	err := q.QueryRow(ctx, `SELECT inventory_approval_required FROM app_settings WHERE id=1`).Scan(&on)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return false, err
	}
	return on, nil
}

// requireNoApproval refuses a direct stock write while approval is on.
func requireNoApproval(ctx context.Context, t pgx.Tx) error {
	on, err := approvalRequiredOn(ctx, t)
	if err != nil {
		return err
	}
	if on {
		return ErrApprovalRequired
	}
	return nil
}

// insertDocEvent appends one row to the inventory_doc_events history (insert-only).
func insertDocEvent(ctx context.Context, t pgx.Tx, docType, docID, action, actorID, note string, data map[string]any) error {
	if data == nil {
		data = map[string]any{}
	}
	raw, err := json.Marshal(data)
	if err != nil {
		return err
	}
	_, err = t.Exec(ctx,
		`INSERT INTO inventory_doc_events (doc_type, doc_id, action, actor_id, note, data)
		 VALUES ($1,$2,$3,$4,$5,$6)`,
		docType, docID, action, nullUUID(actorID), nullStr(strings.TrimSpace(note)), raw)
	return err
}

// ── approver step-up ──────────────────────────────────────────────

// DocRef names the document an approval is about.
type DocRef struct{ Type, ID string }

// ApprovalProof is what a passed PIN check hands to the keyed effect: who approved and which
// PIN generation was verified (re-setting the PIN revokes it, as in A08).
type ApprovalProof struct {
	ApproverID string
	PinSetAt   time.Time
}

// docLocation is the part of a document an approval needs before the PIN is checked.
type docLocation struct {
	outletID string // "" for a warehouse document
}

func readDocLocation(ctx context.Context, t pgx.Tx, ref DocRef) (docLocation, error) {
	var sql string
	switch ref.Type {
	case docTypeAdjustment:
		sql = `SELECT COALESCE(outlet_id::text,'') FROM stock_adjustment_requests WHERE id=$1`
	case docTypeStockCount:
		sql = `SELECT COALESCE(outlet_id::text,'') FROM stock_counts WHERE id=$1`
	default:
		return docLocation{}, ErrNotFound
	}
	var l docLocation
	err := t.QueryRow(ctx, sql, ref.ID).Scan(&l.outletID)
	if errors.Is(err, pgx.ErrNoRows) {
		return l, ErrNotFound
	}
	return l, err
}

// touchedBy reports whether the user took part in the document: created it, saved counted lines
// on it, or submitted it (the document's own columns, plus every 'created', 'submitted' and
// 'updated' event, so a submission that was rejected and resubmitted by someone else still
// counts). Strict four-eyes: such a user can never approve it. A line save is recorded as an
// 'updated' event because the count lines themselves store no actor.
func touchedBy(ctx context.Context, t pgx.Tx, ref DocRef, userID string) (bool, error) {
	var touched bool
	err := t.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM stock_counts WHERE id=$1 AND (created_by=$2::uuid OR submitted_by=$2::uuid))
		    OR EXISTS (SELECT 1 FROM stock_adjustment_requests WHERE id=$1 AND requested_by=$2::uuid)
		    OR EXISTS (SELECT 1 FROM inventory_doc_events
		                WHERE doc_type=$3 AND doc_id=$1 AND actor_id=$2::uuid
		                  AND action IN ('created','submitted','updated'))`,
		ref.ID, userID, ref.Type).Scan(&touched)
	return touched, err
}

// insertDocAttempt audits one approval attempt (no PIN). transfer_id stays NULL.
func insertDocAttempt(ctx context.Context, t pgx.Tx, ref DocRef, docOutlet, userID string, approverKnown bool, outcome string) error {
	var approver any
	if approverKnown {
		approver = userID
	}
	_, err := t.Exec(ctx,
		`INSERT INTO receive_pin_attempts(outlet_id, requester_id, approver_id, doc_type, doc_id, outcome)
		 VALUES($1,$2,$3,$4,$5,$6)`, nullUUID(docOutlet), userID, approver, ref.Type, ref.ID, outcome)
	return err
}

// VerifyInventoryApprover checks the logged-in approver's receive PIN for one document, under
// the same server-side lockout as the transfer receive. It runs and COMMITS in its own
// transaction BEFORE the keyed effect, so a wrong PIN (and the counters it moves) survives a
// refused or replayed claim. Only facts that never change are checked here: the document exists
// and is visible to the caller (404), and the approver is not the one who submitted it (409).
// Whether it still waits for a decision is the effect's call, so a replayed key still answers
// from its stored outcome. Refusals: ErrNotFound, ErrApprovalSelf, ErrApprovalRefused (uniform
// for unknown, ineligible, out-of-scope, no-PIN and wrong-PIN), *LockedError, ErrBusy.
//
// crossAll / visibleOutlet are the caller's read scope: an outlet document of another outlet is
// not found.
func (r *Repo) VerifyInventoryApprover(ctx context.Context, ref DocRef, approverID, pin string, crossAll bool, visibleOutlet string) (ApprovalProof, error) {
	p, err := r.verifyInventoryApprover(ctx, ref, approverID, pin, crossAll, visibleOutlet)
	return p, mapBusy(err)
}

func (r *Repo) verifyInventoryApprover(ctx context.Context, ref DocRef, approverID, pin string, crossAll bool, visibleOutlet string) (ApprovalProof, error) {
	var zero ApprovalProof
	if !isUUID(ref.ID) {
		return zero, ErrNotFound
	}
	if !isUUID(approverID) {
		return zero, apperr.New(apperr.Forbidden, "tidak berwenang")
	}
	tx, err := r.Pool.Begin(ctx)
	if err != nil {
		return zero, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SET LOCAL lock_timeout = '`+mintLockTimeout+`'`); err != nil {
		return zero, err
	}
	loc, err := readDocLocation(ctx, tx, ref)
	if err != nil {
		return zero, err
	}
	if !crossAll && loc.outletID != "" && !strings.EqualFold(loc.outletID, visibleOutlet) {
		return zero, ErrNotFound
	}
	if took, err := touchedBy(ctx, tx, ref, approverID); err != nil {
		return zero, err
	} else if took {
		return zero, ErrApprovalSelf
	}

	var (
		exists           bool
		role, apprOutlet string
		hash             *string
		setAt            *time.Time
	)
	err = tx.QueryRow(ctx,
		`SELECT role, COALESCE(outlet_id::text,''), receive_pin_hash, receive_pin_set_at FROM users WHERE id=$1`,
		approverID).Scan(&role, &apprOutlet, &hash, &setAt)
	switch {
	case err == nil:
		exists = true
	case !errors.Is(err, pgx.ErrNoRows):
		return zero, err
	}
	roles, err := approverRoles(ctx, tx)
	if err != nil {
		return zero, err
	}
	authorized := exists && ApproverCovers(role, apprOutlet, loc.outletID, roles)
	chk, err := checkApproverPIN(ctx, tx, pinSubject{
		approverID: approverID, requesterID: approverID,
		exists: exists, authorized: authorized, hash: hash, setAt: setAt, pin: pin,
		attempt: func(known bool, outcome string) error {
			return insertDocAttempt(ctx, tx, ref, loc.outletID, approverID, known, outcome)
		},
	})
	if err != nil {
		return zero, err
	}
	if err := chk.succeed(ctx, tx); err != nil {
		return zero, err
	}
	if err := tx.Commit(ctx); err != nil {
		return zero, err
	}
	return ApprovalProof{ApproverID: approverID, PinSetAt: *setAt}, nil
}

// recheckApprover runs inside the keyed effect: the approver must still be allowed to approve
// this location and must still hold the PIN generation that was verified.
func recheckApprover(ctx context.Context, t pgx.Tx, p ApprovalProof, docOutlet string) error {
	var role, outlet string
	var pinOK bool
	err := t.QueryRow(ctx,
		`SELECT role, COALESCE(outlet_id::text,''), COALESCE(receive_pin_hash IS NOT NULL AND receive_pin_set_at = $2, false)
		   FROM users WHERE id=$1`, p.ApproverID, p.PinSetAt).Scan(&role, &outlet, &pinOK)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrApproverRevoked
	}
	if err != nil {
		return err
	}
	roles, err := approverRoles(ctx, t)
	if err != nil {
		return err
	}
	if !pinOK || !ApproverCovers(role, outlet, docOutlet, roles) {
		return ErrApproverRevoked
	}
	return nil
}

// requireApprover is the PIN-less eligibility check of a rejection: admin or approver role,
// within the document's outlet scope.
func requireApprover(ctx context.Context, t pgx.Tx, userID, docOutlet string) error {
	var role, outlet string
	err := t.QueryRow(ctx, `SELECT role, COALESCE(outlet_id::text,'') FROM users WHERE id=$1`, userID).Scan(&role, &outlet)
	if errors.Is(err, pgx.ErrNoRows) {
		return apperr.New(apperr.Forbidden, "tidak berwenang")
	}
	if err != nil {
		return err
	}
	roles, err := approverRoles(ctx, t)
	if err != nil {
		return err
	}
	if !ApproverCovers(role, outlet, docOutlet, roles) {
		return apperr.New(apperr.Forbidden, "tidak berwenang")
	}
	return nil
}

// ── adjustment requests ───────────────────────────────────────────

// AdjustmentRequestInput is a requested change of one SKU's quantity at one location.
type AdjustmentRequestInput struct {
	LocationType string `json:"locationType"`
	LocationID   string `json:"locationId"`
	ProductID    string `json:"productId"`
	VariantSize  string `json:"variantSize"`
	NewQty       int    `json:"newQty"`
	ReasonCode   string `json:"reasonCode"`
	ReasonText   string `json:"reasonText"`
}

func validateAdjustmentRequest(in AdjustmentRequestInput) error {
	if !validLocKind(in.LocationType) || !isUUID(in.LocationID) {
		return fmt.Errorf("lokasi tidak valid")
	}
	if !isUUID(in.ProductID) || strings.TrimSpace(in.VariantSize) == "" {
		return fmt.Errorf("produk dan ukuran wajib diisi")
	}
	if in.NewQty < 0 {
		return fmt.Errorf("stok tidak boleh negatif")
	}
	return validateReason(in.ReasonCode, in.ReasonText)
}

// requestLocationSQL are the existence checks of the two location kinds.
var requestLocationSQL = map[string]string{
	"outlet":    `SELECT EXISTS(SELECT 1 FROM outlets WHERE id=$1)`,
	"warehouse": `SELECT EXISTS(SELECT 1 FROM warehouses WHERE id=$1)`,
}

// CreateAdjustmentRequestTx records a pending request inside the caller's transaction (an
// idempotency receipt claim). qty_at_request is the live quantity read here, never the body's.
// A second pending request for the same location and SKU is ErrAdjustmentPending.
func (r *Repo) CreateAdjustmentRequestTx(ctx context.Context, t pgx.Tx, requesterID string, in AdjustmentRequestInput) (string, error) {
	if err := validateAdjustmentRequest(in); err != nil {
		return "", err
	}
	if !isUUID(requesterID) {
		return "", apperr.New(apperr.Forbidden, "tidak berwenang")
	}
	var exists bool
	if err := t.QueryRow(ctx, requestLocationSQL[in.LocationType], in.LocationID).Scan(&exists); err != nil {
		return "", err
	}
	if !exists {
		return "", ErrNotFound
	}
	if err := t.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM product_variants WHERE product_id=$1 AND size=$2)`,
		in.ProductID, in.VariantSize).Scan(&exists); err != nil {
		return "", err
	}
	if !exists {
		return "", ErrNotFound
	}
	live, err := liveLocationStock(ctx, t, in.LocationType, in.LocationID, in.ProductID, in.VariantSize)
	if err != nil {
		return "", err
	}
	if live == in.NewQty {
		return "", fmt.Errorf("jumlah baru sama dengan stok saat ini")
	}
	number, err := nextDocNo(ctx, t, "ADJ", time.Now().Year())
	if err != nil {
		return "", err
	}
	whID, outID := locationIDs(in.LocationType, in.LocationID)
	var id string
	err = t.QueryRow(ctx,
		`INSERT INTO stock_adjustment_requests
		   (number, outlet_id, warehouse_id, product_id, variant_size, qty_at_request, requested_new_qty,
		    reason_code, reason_text, requested_by)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id::text`,
		number, outID, whID, in.ProductID, in.VariantSize, live, in.NewQty,
		in.ReasonCode, nullStr(strings.TrimSpace(in.ReasonText)), requesterID).Scan(&id)
	var pg *pgconn.PgError
	if errors.As(err, &pg) && pg.Code == "23505" && pg.ConstraintName == "stock_adjustment_requests_one_pending" {
		return "", ErrAdjustmentPending
	}
	if err != nil {
		return "", err
	}
	if err := insertDocEvent(ctx, t, docTypeAdjustment, id, "submitted", requesterID, in.ReasonText,
		map[string]any{"number": number, "fromQty": live, "toQty": in.NewQty, "reasonCode": in.ReasonCode}); err != nil {
		return "", err
	}
	return id, nil
}

type adjRequest struct {
	status, outletID, warehouseID, productID, variantSize string
	reasonCode, reasonText, requestedBy                   string
	qtyAtRequest, newQty                                  int
}

func (a adjRequest) location() (kind, id string) {
	if a.warehouseID != "" {
		return "warehouse", a.warehouseID
	}
	return "outlet", a.outletID
}

// lockAdjustmentRequest reads one request under a row lock.
func lockAdjustmentRequest(ctx context.Context, t pgx.Tx, id string) (adjRequest, error) {
	var a adjRequest
	if !isUUID(id) {
		return a, ErrNotFound
	}
	err := t.QueryRow(ctx,
		`SELECT status, COALESCE(outlet_id::text,''), COALESCE(warehouse_id::text,''), product_id::text, variant_size,
		        reason_code, COALESCE(reason_text,''), requested_by::text, qty_at_request, requested_new_qty
		   FROM stock_adjustment_requests WHERE id=$1 FOR UPDATE`, id).
		Scan(&a.status, &a.outletID, &a.warehouseID, &a.productID, &a.variantSize,
			&a.reasonCode, &a.reasonText, &a.requestedBy, &a.qtyAtRequest, &a.newQty)
	if errors.Is(err, pgx.ErrNoRows) {
		return a, ErrNotFound
	}
	return a, err
}

// AdjustmentApplied is what an approval applied.
type AdjustmentApplied struct {
	AdjustmentID  string
	LiveQtyBefore int
	Delta         int
}

// ApproveAdjustmentRequestTx applies the requested DELTA (requested_new_qty - qty_at_request) to
// live stock, ledger kind adjust, inside the caller's transaction. The proof comes from
// VerifyInventoryApprover; the approver is re-checked here, and is never the requester.
func (r *Repo) ApproveAdjustmentRequestTx(ctx context.Context, t pgx.Tx, id string, p ApprovalProof, note string) (AdjustmentApplied, error) {
	var zero AdjustmentApplied
	req, err := lockAdjustmentRequest(ctx, t, id)
	if err != nil {
		return zero, err
	}
	if req.status != "pending_approval" {
		return zero, ErrApprovalNotPending
	}
	if took, err := touchedBy(ctx, t, DocRef{Type: docTypeAdjustment, ID: id}, p.ApproverID); err != nil {
		return zero, err
	} else if took {
		return zero, ErrApprovalSelf
	}
	if err := recheckApprover(ctx, t, p, req.outletID); err != nil {
		return zero, err
	}
	delta := req.newQty - req.qtyAtRequest
	kind, locID := req.location()
	if err := insertDocEvent(ctx, t, docTypeAdjustment, id, "approved", p.ApproverID, note, nil); err != nil {
		return zero, err
	}
	res, err := ApplyAdjustmentDeltaTx(ctx, t, kind, locID, req.requestedBy,
		WarehouseAdjust{ProductID: req.productID, VariantSize: req.variantSize, Reason: reasonSentence(req.reasonCode, req.reasonText)},
		delta, id, req.reasonCode)
	if err != nil {
		return zero, err
	}
	// The stock counter bump inside the apply is not the last statement of this transaction;
	// what follows touches only this request and the history, never stock, version or seq rows.
	if _, err := t.Exec(ctx,
		`UPDATE stock_adjustment_requests SET status='approved', approved_by=$2, approved_at=now(),
		        decision_note=$3, applied_adjustment_id=$4 WHERE id=$1`,
		id, p.ApproverID, nullStr(strings.TrimSpace(note)), res.ID); err != nil {
		return zero, err
	}
	if err := insertDocEvent(ctx, t, docTypeAdjustment, id, "applied", p.ApproverID, "",
		map[string]any{"adjustmentId": res.ID, "fromQty": res.Before, "toQty": res.After, "delta": delta,
			"qtyAtRequest": req.qtyAtRequest, "requestedNewQty": req.newQty}); err != nil {
		return zero, err
	}
	return AdjustmentApplied{AdjustmentID: res.ID, LiveQtyBefore: res.Before, Delta: delta}, nil
}

// RejectAdjustmentRequestTx declines a pending request. The decider must be an approver for the
// location; the requester withdraws with CancelAdjustmentRequestTx instead.
func (r *Repo) RejectAdjustmentRequestTx(ctx context.Context, t pgx.Tx, id, userID, note string) error {
	req, err := lockAdjustmentRequest(ctx, t, id)
	if err != nil {
		return err
	}
	// Eligibility first, so a user who may not decide cannot probe the document's state.
	if err := requireApprover(ctx, t, userID, req.outletID); err != nil {
		return err
	}
	if req.status != "pending_approval" {
		return ErrApprovalNotPending
	}
	if strings.EqualFold(req.requestedBy, userID) {
		return apperr.New(apperr.Conflict, "pengaju tidak dapat menolak permintaannya sendiri; gunakan batalkan")
	}
	if _, err := t.Exec(ctx,
		`UPDATE stock_adjustment_requests SET status='rejected', approved_by=NULL, approved_at=NULL, decision_note=$2 WHERE id=$1`,
		id, strings.TrimSpace(note)); err != nil {
		return err
	}
	return insertDocEvent(ctx, t, docTypeAdjustment, id, "rejected", userID, note, nil)
}

// CancelAdjustmentRequestTx withdraws a pending request; only the requester may.
func (r *Repo) CancelAdjustmentRequestTx(ctx context.Context, t pgx.Tx, id, userID, note string) error {
	req, err := lockAdjustmentRequest(ctx, t, id)
	if err != nil {
		return err
	}
	if !strings.EqualFold(req.requestedBy, userID) {
		return apperr.New(apperr.Forbidden, "hanya pengaju yang dapat membatalkan permintaan")
	}
	if req.status != "pending_approval" {
		return ErrApprovalNotPending
	}
	if _, err := t.Exec(ctx,
		`UPDATE stock_adjustment_requests SET status='cancelled', decision_note=$2 WHERE id=$1`,
		id, nullStr(strings.TrimSpace(note))); err != nil {
		return err
	}
	return insertDocEvent(ctx, t, docTypeAdjustment, id, "cancelled", userID, note, nil)
}

// InventorySettingDocID is the fixed doc_id of the inventory_doc_events rows that log a change of
// app_settings.inventory_approval_required (doc_type 'app_setting'). The setting is a singleton, so
// one constant id keeps its whole history on one timeline. Never change it.
const InventorySettingDocID = "00000000-0000-4000-8000-000000000072"

// setApprovalSwitch writes the approval switch and, when its value really changes, appends an
// 'updated' history row with the actor and from/to. The old value is read under the row lock, so
// two racing saves log a consistent chain.
func setApprovalSwitch(ctx context.Context, t pgx.Tx, actor string, to bool) error {
	var from bool
	if err := t.QueryRow(ctx, `SELECT inventory_approval_required FROM app_settings WHERE id=1 FOR UPDATE`).Scan(&from); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil // no settings row: nothing to switch
		}
		return err
	}
	if from == to {
		return nil
	}
	if _, err := t.Exec(ctx, `UPDATE app_settings SET inventory_approval_required=$1 WHERE id=1`, to); err != nil {
		return err
	}
	return insertDocEvent(ctx, t, "app_setting", InventorySettingDocID, "updated", actor, "",
		map[string]any{"setting": "inventoryApprovalRequired", "from": from, "to": to})
}
