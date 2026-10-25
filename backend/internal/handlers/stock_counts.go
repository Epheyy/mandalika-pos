package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/mandalika/pos-backend/internal/apperr"
	"github.com/mandalika/pos-backend/internal/httpx"
	"github.com/mandalika/pos-backend/internal/read"
	"github.com/mandalika/pos-backend/internal/write"
)

func (h *Handlers) CreateStockCount(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeWrite[write.StockCountCreate](w, r)
	if !ok {
		return
	}
	c, _ := h.caller(r)
	outletID := c.outletID
	if body.WarehouseID != "" {
		outletID = "" // warehouse count: location is the warehouse, not an outlet
	} else if outletID == "" {
		httpx.Err(w, http.StatusForbidden, "no active outlet")
		return
	}
	id, err := h.Write.CreateStockCount(r.Context(), outletID, c.userID, body)
	h.created(w, r, id, err)
}

func (h *Handlers) UpdateStockCount(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeWrite[write.StockCountUpdate](w, r)
	if !ok {
		return
	}
	c, _ := h.caller(r)
	// No outlet guard — the repo (lockCount) authorizes: outlet counts must match
	// the caller's outlet; warehouse counts are permission-gated by the route.
	err := h.Write.UpdateStockCount(r.Context(), chi.URLParam(r, "id"), c.outletID, body)
	if countConflict(w, r, err) {
		return
	}
	h.mutated(w, r, err)
}

// countConflict answers a stock count lifecycle refusal (apperr.Conflict) with 409
// and its Indonesian message; every other error is left to the caller's mapping.
func countConflict(w http.ResponseWriter, r *http.Request, err error) bool {
	if errors.Is(err, write.ErrApprovalRequired) {
		writeApprovalRequired(w, err) // the one 409 that carries data.code
		return true
	}
	if code, ok := apperr.CodeOf(err); ok && code == apperr.Conflict {
		httpx.Err(w, http.StatusConflict, safeDomainText(r, http.StatusConflict, err))
		return true
	}
	return false
}

func (h *Handlers) CompleteStockCount(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Items []write.StockCountItem `json:"items"`
	}
	// Empty body = finalize from the stored draft items; a malformed one is a 400
	// with nothing applied.
	if err := decodeOptionalBody(r, &body); err != nil {
		writeDecodeErr(w, err)
		return
	}
	c, _ := h.caller(r)
	// No outlet guard — repo authorizes (see UpdateStockCount). The outlet is the
	// authenticated caller's, never the body's.
	id := chi.URLParam(r, "id")
	h.keyedMutated(w, r, keyedWrite{
		OpType:  "bo.stock_count.complete",
		Payload: map[string]any{"countId": id, "outletId": c.outletID, "items": body.Items},
		Unkeyed: func() error {
			return h.Write.CompleteStockCountBy(r.Context(), id, c.outletID, callerUserID(r), body.Items)
		},
		Effect: func(ctx context.Context, tx pgx.Tx) error {
			return h.Write.CompleteStockCountTx(ctx, tx, id, c.outletID, callerUserID(r), body.Items)
		},
		Outcome: func(ctx context.Context, q read.RowQuerier) (json.RawMessage, error) {
			v, err := read.StockCountOn(ctx, q, scope(r), id)
			if err != nil {
				return nil, err
			}
			return json.Marshal(map[string]any{"data": v})
		},
		OnErr: func(w http.ResponseWriter, err error) bool { return countConflict(w, r, err) },
	})
}

// countOutcome builds the {"data": count} body of a count write.
func countOutcome(id string) func(context.Context, read.RowQuerier) (json.RawMessage, error) {
	return func(ctx context.Context, q read.RowQuerier) (json.RawMessage, error) {
		v, err := read.StockCountOn(ctx, q, read.Scope{CrossAll: true}, id)
		if err != nil {
			return nil, err
		}
		return json.Marshal(map[string]any{"data": v})
	}
}

// SubmitStockCount sends a finished count to an approver (status pending_approval). A count
// with no difference completes directly instead.
func (h *Handlers) SubmitStockCount(w http.ResponseWriter, r *http.Request) {
	if !requireIdempotencyKey(w, r) {
		return
	}
	body, ok := decodeWrite[write.CountSubmit](w, r)
	if !ok {
		return
	}
	if len(body.Lines) > maxSubmitLines {
		httpx.Err(w, http.StatusBadRequest, "invalid body")
		return
	}
	c, _ := h.caller(r)
	id, uid := chi.URLParam(r, "id"), callerUserID(r)
	h.keyedMutated(w, r, keyedWrite{
		OpType:  "bo.stock_count.submit",
		Payload: map[string]any{"countId": id, "outletId": c.outletID, "body": body},
		Unkeyed: func() error { return errKeyRequired },
		Effect: func(ctx context.Context, tx pgx.Tx) error {
			return h.Write.SubmitStockCountTx(ctx, tx, id, c.outletID, uid, body)
		},
		Outcome: countOutcome(id),
		OnErr: func(w http.ResponseWriter, err error) bool {
			return countConflict(w, r, err) || inventoryErr(r)(w, err)
		},
	})
}

// ApproveStockCount applies a submitted count's deltas after the approver's PIN.
func (h *Handlers) ApproveStockCount(w http.ResponseWriter, r *http.Request) {
	if !requireIdempotencyKey(w, r) {
		return
	}
	body, ok := decodeApprove(w, r)
	if !ok {
		return
	}
	id, uid, sc := chi.URLParam(r, "id"), callerUserID(r), scope(r)
	proof, err := h.Write.VerifyInventoryApprover(r.Context(), write.DocRef{Type: "stock_count", ID: id}, uid, body.Pin, sc.CrossAll, sc.OutletID)
	if err != nil {
		approveError(w, r, err)
		return
	}
	h.keyedMutated(w, r, keyedWrite{
		// pin is deliberately absent from the fingerprint (it is verified above).
		OpType:  "bo.stock_count.approve",
		Payload: map[string]any{"countId": id, "note": body.Note},
		Unkeyed: func() error { return errKeyRequired },
		Effect: func(ctx context.Context, tx pgx.Tx) error {
			return h.Write.ApproveStockCountTx(ctx, tx, id, proof, body.Note)
		},
		Outcome: countOutcome(id),
		OnErr:   inventoryErr(r),
	})
}

// RejectStockCount sends a submitted count back to in_progress for a recount.
func (h *Handlers) RejectStockCount(w http.ResponseWriter, r *http.Request) {
	if !requireIdempotencyKey(w, r) {
		return
	}
	note, ok := decodeRejectNote(w, r)
	if !ok {
		return
	}
	id, uid := chi.URLParam(r, "id"), callerUserID(r)
	if _, err := h.Repo.StockCount(r.Context(), scope(r), id); err != nil {
		writeErr(w, r, http.StatusInternalServerError, err)
		return
	}
	h.keyedMutated(w, r, keyedWrite{
		OpType:  "bo.stock_count.reject",
		Payload: map[string]any{"countId": id, "note": note},
		Unkeyed: func() error { return errKeyRequired },
		Effect: func(ctx context.Context, tx pgx.Tx) error {
			return h.Write.RejectStockCountTx(ctx, tx, id, uid, note)
		},
		Outcome: countOutcome(id),
		OnErr:   inventoryErr(r),
	})
}
