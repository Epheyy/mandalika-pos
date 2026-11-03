package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/mandalika/pos-backend/internal/api"
	"github.com/mandalika/pos-backend/internal/apperr"
	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/httpx"
	"github.com/mandalika/pos-backend/internal/read"
	"github.com/mandalika/pos-backend/internal/write"
)

// Inventory controls S3: adjustment requests, the approval queue and the shared helpers of the
// count approval handlers (stock_counts.go).

const (
	msgIdempotencyKeyRequired = "Idempotency-Key wajib"
	msgApprovalRequired       = "persetujuan diperlukan untuk perubahan stok ini"
	// approvalRequiredCode is the machine code of the InventoryConflictError 409 that closes the
	// direct adjust / complete endpoints while approval is on. No other 409 sends data.code.
	approvalRequiredCode = "approval_required"
	maxApprovalNoteLen   = 500
	maxSubmitLines       = 5000
)

var errKeyRequired = errors.New(msgIdempotencyKeyRequired)

// requireIdempotencyKey answers 400 when the Idempotency-Key header is missing or blank. Every
// new inventory write requires it, and it is checked BEFORE a PIN is verified, so a keyless call
// can never burn a PIN attempt.
func requireIdempotencyKey(w http.ResponseWriter, r *http.Request) bool {
	if strings.TrimSpace(r.Header.Get("Idempotency-Key")) == "" {
		httpx.Err(w, http.StatusBadRequest, msgIdempotencyKeyRequired)
		return false
	}
	return true
}

// writeApprovalRequired answers the 409 of a direct write while approval is on.
func writeApprovalRequired(w http.ResponseWriter, _ error) {
	writeJSON(w, http.StatusConflict, map[string]any{
		"error": msgApprovalRequired,
		"data":  map[string]string{"code": approvalRequiredCode},
	})
}

// inventoryErr answers the typed refusals of the inventory writes: approval_required (the only
// 409 with data.code), other conflicts and forbidden as {error}. Anything else is left to the
// shared mapping.
func inventoryErr(r *http.Request) func(http.ResponseWriter, error) bool {
	return func(w http.ResponseWriter, err error) bool {
		if errors.Is(err, write.ErrApprovalRequired) {
			writeApprovalRequired(w, err)
			return true
		}
		code, ok := apperr.CodeOf(err)
		if !ok {
			return false
		}
		switch code {
		case apperr.Conflict:
			httpx.Err(w, http.StatusConflict, safeDomainText(r, http.StatusConflict, err))
			return true
		case apperr.Forbidden:
			httpx.Err(w, http.StatusForbidden, safeDomainText(r, http.StatusForbidden, err))
			return true
		}
		return false
	}
}

// approveError answers a failed PIN step of an approval: a missing or invisible document is 404,
// everything else (locked 429, uniform 403, 409, 503) is the transfer-receive mapping.
func approveError(w http.ResponseWriter, r *http.Request, err error) {
	if errors.Is(err, write.ErrNotFound) {
		httpx.Err(w, http.StatusNotFound, "not found")
		return
	}
	mintError(w, r, err)
}

// locationInScope is the explicit location check of a request body: admins reach every
// location, other users only their own outlet; a warehouse is permission-gated by the route.
func locationInScope(r *http.Request, locationType, locationID string) bool {
	if role, _ := r.Context().Value(auth.CtxRole).(string); role == "admin" {
		return true
	}
	if locationType == "warehouse" {
		return true
	}
	own := scope(r).OutletID
	return own != "" && strings.EqualFold(own, locationID)
}

// adjustmentOutcome builds the {"data": request} body of an adjustment request write.
func adjustmentOutcome(id string) func(context.Context, read.RowQuerier) (json.RawMessage, error) {
	return func(ctx context.Context, q read.RowQuerier) (json.RawMessage, error) {
		v, err := read.AdjustmentRequestOn(ctx, q, read.Scope{CrossAll: true}, id)
		if err != nil {
			return nil, err
		}
		return json.Marshal(api.AdjustmentRequestResponse{Data: v})
	}
}

// visibleAdjustment 404s a request the caller's scope cannot see, before any write.
func (h *Handlers) visibleAdjustment(w http.ResponseWriter, r *http.Request, id string) bool {
	if _, err := h.Repo.AdjustmentRequest(r.Context(), scope(r), id); err != nil {
		writeErr(w, r, http.StatusInternalServerError, err)
		return false
	}
	return true
}

func (h *Handlers) CreateAdjustmentRequest(w http.ResponseWriter, r *http.Request) {
	if !requireIdempotencyKey(w, r) {
		return
	}
	in, ok := decodeWrite[write.AdjustmentRequestInput](w, r)
	if !ok {
		return
	}
	if !locationInScope(r, in.LocationType, in.LocationID) {
		httpx.Err(w, http.StatusForbidden, "lokasi di luar jangkauan")
		return
	}
	uid := callerUserID(r)
	var id string
	h.keyedMutated(w, r, keyedWrite{
		OpType: "bo.inventory.adjustment_request.create", Payload: map[string]any{"body": in}, Status: http.StatusCreated,
		Unkeyed: func() error { return errKeyRequired },
		Effect: func(ctx context.Context, tx pgx.Tx) (err error) {
			id, err = h.Write.CreateAdjustmentRequestTx(ctx, tx, uid, in)
			return err
		},
		Outcome: func(ctx context.Context, q read.RowQuerier) (json.RawMessage, error) {
			return adjustmentOutcome(id)(ctx, q)
		},
		OnErr: inventoryErr(r),
	})
}

func (h *Handlers) ListAdjustmentRequests(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	status := q.Get("status")
	switch status {
	case "", "pending_approval", "approved", "rejected", "cancelled":
	default:
		httpx.Err(w, http.StatusBadRequest, "status tidak valid")
		return
	}
	if lt := q.Get("locationType"); lt != "" && lt != "outlet" && lt != "warehouse" {
		httpx.Err(w, http.StatusBadRequest, "locationType tidak valid")
		return
	}
	p, l := pageLimit(r)
	rows, total, err := h.Repo.AdjustmentRequests(r.Context(), scope(r), read.AdjustmentRequestFilter{
		Status: status, LocationType: q.Get("locationType"), LocationID: q.Get("locationId"),
	}, p, l)
	if err != nil {
		writeErr(w, r, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, api.AdjustmentRequestListResponse{Data: rows, Meta: meta(total, p, l)})
}

func (h *Handlers) GetAdjustmentRequest(w http.ResponseWriter, r *http.Request) {
	v, err := h.Repo.AdjustmentRequest(r.Context(), scope(r), chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, r, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, api.AdjustmentRequestResponse{Data: v})
}

// approveBody is the step-up body of an approval. The PIN is verified and never stored, logged,
// echoed or fingerprinted.
type approveBody struct {
	Pin  string `json:"pin"`
	Note string `json:"note"`
}

// decodeApprove reads and validates an approve body. A malformed PIN is a 400 that is not
// counted as an attempt (as in A08).
func decodeApprove(w http.ResponseWriter, r *http.Request) (approveBody, bool) {
	b, ok := decodeWrite[approveBody](w, r)
	if !ok {
		return b, false
	}
	if !validReceivePin(b.Pin) || len(b.Note) > maxApprovalNoteLen {
		httpx.Err(w, http.StatusBadRequest, "invalid body")
		return b, false
	}
	return b, true
}

func (h *Handlers) ApproveAdjustmentRequest(w http.ResponseWriter, r *http.Request) {
	if !requireIdempotencyKey(w, r) {
		return
	}
	body, ok := decodeApprove(w, r)
	if !ok {
		return
	}
	id, uid, sc := chi.URLParam(r, "id"), callerUserID(r), scope(r)
	// The PIN and its lockout counters commit in their own transaction BEFORE the keyed claim,
	// so a refused or replayed claim never rolls a wrong-PIN attempt back.
	proof, err := h.Write.VerifyInventoryApprover(r.Context(), write.DocRef{Type: "adjustment_request", ID: id}, uid, body.Pin, sc.CrossAll, sc.OutletID)
	if err != nil {
		approveError(w, r, err)
		return
	}
	var applied write.AdjustmentApplied
	h.keyedMutated(w, r, keyedWrite{
		// pin is deliberately absent: the same key replays whatever PIN is sent (it is verified above).
		OpType: "bo.inventory.adjustment_request.approve", Payload: map[string]any{"id": id, "note": body.Note},
		Unkeyed: func() error { return errKeyRequired },
		Effect: func(ctx context.Context, tx pgx.Tx) (err error) {
			applied, err = h.Write.ApproveAdjustmentRequestTx(ctx, tx, id, proof, body.Note)
			return err
		},
		Outcome: func(ctx context.Context, q read.RowQuerier) (json.RawMessage, error) {
			v, err := read.AdjustmentRequestOn(ctx, q, read.Scope{CrossAll: true}, id)
			if err != nil {
				return nil, err
			}
			adj, _ := parseUUID(applied.AdjustmentID)
			return json.Marshal(api.AdjustmentRequestApproveResponse{Data: api.AdjustmentRequestApproveResult{
				Request: v, AppliedAdjustmentId: adj, LiveQtyBefore: applied.LiveQtyBefore, Delta: applied.Delta,
			}})
		},
		OnErr: inventoryErr(r),
	})
}

// decodeRejectNote reads the required note of a rejection.
func decodeRejectNote(w http.ResponseWriter, r *http.Request) (string, bool) {
	b, ok := decodeWrite[struct {
		Note string `json:"note"`
	}](w, r)
	note := strings.TrimSpace(b.Note)
	if !ok || note == "" || len(note) > maxApprovalNoteLen {
		if ok {
			httpx.Err(w, http.StatusBadRequest, "catatan penolakan wajib diisi")
		}
		return "", false
	}
	return note, true
}

func (h *Handlers) RejectAdjustmentRequest(w http.ResponseWriter, r *http.Request) {
	if !requireIdempotencyKey(w, r) {
		return
	}
	note, ok := decodeRejectNote(w, r)
	if !ok {
		return
	}
	id, uid := chi.URLParam(r, "id"), callerUserID(r)
	if !h.visibleAdjustment(w, r, id) {
		return
	}
	h.keyedMutated(w, r, keyedWrite{
		OpType: "bo.inventory.adjustment_request.reject", Payload: map[string]any{"id": id, "note": note},
		Unkeyed: func() error { return errKeyRequired },
		Effect: func(ctx context.Context, tx pgx.Tx) error {
			return h.Write.RejectAdjustmentRequestTx(ctx, tx, id, uid, note)
		},
		Outcome: adjustmentOutcome(id),
		OnErr:   inventoryErr(r),
	})
}

func (h *Handlers) CancelAdjustmentRequest(w http.ResponseWriter, r *http.Request) {
	if !requireIdempotencyKey(w, r) {
		return
	}
	var body struct {
		Note string `json:"note"`
	}
	if err := decodeOptionalBody(r, &body); err != nil {
		writeDecodeErr(w, err)
		return
	}
	if len(body.Note) > maxApprovalNoteLen {
		httpx.Err(w, http.StatusBadRequest, "invalid body")
		return
	}
	id, uid := chi.URLParam(r, "id"), callerUserID(r)
	if !h.visibleAdjustment(w, r, id) {
		return
	}
	h.keyedMutated(w, r, keyedWrite{
		OpType: "bo.inventory.adjustment_request.cancel", Payload: map[string]any{"id": id, "note": body.Note},
		Unkeyed: func() error { return errKeyRequired },
		Effect: func(ctx context.Context, tx pgx.Tx) error {
			return h.Write.CancelAdjustmentRequestTx(ctx, tx, id, uid, body.Note)
		},
		Outcome: adjustmentOutcome(id),
		OnErr:   inventoryErr(r),
	})
}

// ListInventoryApprovals is the Persetujuan Stok queue: pending adjustment requests and
// submitted counts in one paged list. Each kind is shown only to a caller holding its
// permission (manage_inventory / manage_stock_count), so a count-only user never sees an
// adjustment request. pendingCount is the pending total the caller may see, whatever kind narrows the
// list to, for the nav badge. outletId narrows the list; for an admin it also switches the scope
// (scope()), so it narrows pendingCount too.
func (h *Handlers) ListInventoryApprovals(w http.ResponseWriter, r *http.Request) {
	if s := r.URL.Query().Get("status"); s != "" && s != "pending" {
		httpx.Err(w, http.StatusBadRequest, "status tidak valid")
		return
	}
	seeAdj := auth.HasPermission(r.Context(), "manage_inventory")
	seeCnt := auth.HasPermission(r.Context(), "manage_stock_count")
	if !seeAdj && !seeCnt {
		httpx.Err(w, http.StatusForbidden, "missing permission: manage_inventory or manage_stock_count")
		return
	}
	f, ok := approvalFilter(w, r)
	if !ok {
		return
	}
	p, l := pageLimit(r)
	items, total, pending, err := h.Repo.ApprovalQueueFiltered(r.Context(), scope(r), seeAdj, seeCnt, f, p, l)
	if err != nil {
		writeErr(w, r, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, api.ApprovalQueueResponse{Data: items, PendingCount: pending, Meta: meta(total, p, l)})
}
