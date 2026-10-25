package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/mandalika/pos-backend/internal/api"
	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/httpx"
	"github.com/mandalika/pos-backend/internal/read"
	"github.com/mandalika/pos-backend/internal/write"
)

// Permintaan Barang (PB). Outlet staff (request_stock) create, edit, submit and cancel the
// PBs of their own outlet; warehouse users (manage_inventory) approve, reject and fulfil
// them. The outlet of a write is the authenticated request context's (token outlet, or an
// admin's validated X-Outlet-Id), never a body or query field. Reads accept either
// permission and filter by it (read.RequisitionAccess), so a GET is permission-checked here
// rather than by a route group.

var validRequisitionStatuses = map[string]bool{
	"draft": true, "submitted": true, "approved": true, "rejected": true, "fulfilled": true, "cancelled": true,
}

// ctxOutlet is the active outlet of the authenticated request ("" when it resolves to none).
func ctxOutlet(r *http.Request) string {
	o, _ := r.Context().Value(auth.CtxOutletID).(string)
	return o
}

// requisitionAccess is the caller's read view, or false when they hold neither permission.
func requisitionAccess(r *http.Request, sc read.Scope) (read.RequisitionAccess, bool) {
	wh := auth.HasPermission(r.Context(), "manage_inventory")
	if !wh && !auth.HasPermission(r.Context(), "request_stock") {
		return read.RequisitionAccess{}, false
	}
	return read.RequisitionAccess{Warehouse: wh, Scope: sc}, true
}

// requireRequisitionKey answers 400 when the Idempotency-Key is missing or empty: a PB write
// is never unkeyed.
func requireRequisitionKey(w http.ResponseWriter, r *http.Request) bool {
	if strings.TrimSpace(r.Header.Get("Idempotency-Key")) == "" {
		httpx.Err(w, http.StatusBadRequest, "header Idempotency-Key wajib")
		return false
	}
	return true
}

// requisitionOutcome builds the stored response of a write: the PB as the writer sees it.
func requisitionOutcome(r *http.Request, id *string) func(ctx context.Context, q read.RowQuerier) (json.RawMessage, error) {
	return func(ctx context.Context, q read.RowQuerier) (json.RawMessage, error) {
		acc, _ := requisitionAccess(r, read.Scope{OutletID: ctxOutlet(r)})
		v, err := read.RequisitionOn(ctx, q, acc, *id)
		if err != nil {
			return nil, err
		}
		return json.Marshal(map[string]any{"data": v})
	}
}

func (h *Handlers) Requisitions(w http.ResponseWriter, r *http.Request) {
	acc, ok := requisitionAccess(r, scope(r))
	if !ok {
		httpx.Err(w, http.StatusForbidden, "missing permission: request_stock")
		return
	}
	q := r.URL.Query()
	status := q.Get("status")
	if status != "" && !validRequisitionStatuses[status] {
		httpx.Err(w, http.StatusBadRequest, "status tidak valid")
		return
	}
	p, l := pageLimit(r)
	rows, total, err := h.Repo.Requisitions(r.Context(), acc, status, q.Get("outletId"), p, l)
	if err != nil {
		writeErr(w, r, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, api.StockRequisitionListResponse{Data: rows, Meta: meta(total, p, l)})
}

func (h *Handlers) Requisition(w http.ResponseWriter, r *http.Request) {
	acc, ok := requisitionAccess(r, scope(r))
	if !ok {
		httpx.Err(w, http.StatusForbidden, "missing permission: request_stock")
		return
	}
	v, err := h.Repo.Requisition(r.Context(), acc, chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, r, 0, err) // read.ErrNotFound (incl. another outlet's PB) -> 404
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": v})
}

// requisitionWrite runs one keyed PB write. do is the effect inside the receipt transaction.
func (h *Handlers) requisitionWrite(w http.ResponseWriter, r *http.Request, opType string, payload any,
	status int, id *string, do func(ctx context.Context, tx pgx.Tx) error) {
	h.keyedMutated(w, r, keyedWrite{
		OpType: opType, Payload: payload, Status: status,
		Unkeyed: func() error { return h.Write.WithTx(r.Context(), func(tx pgx.Tx) error { return do(r.Context(), tx) }) },
		Effect:  do,
		Outcome: requisitionOutcome(r, id),
		OnErr:   func(w http.ResponseWriter, err error) bool { return countConflict(w, r, err) },
	})
}

// outletWrite checks the key and the active outlet shared by the outlet-side writes.
func outletWrite(w http.ResponseWriter, r *http.Request) (outlet string, ok bool) {
	if !requireRequisitionKey(w, r) {
		return "", false
	}
	if outlet = ctxOutlet(r); outlet == "" {
		httpx.Err(w, http.StatusBadRequest, "tidak ada outlet aktif")
		return "", false
	}
	return outlet, true
}

func (h *Handlers) CreateRequisition(w http.ResponseWriter, r *http.Request) {
	outlet, ok := outletWrite(w, r)
	if !ok {
		return
	}
	body, ok := decodeWrite[write.RequisitionInput](w, r)
	if !ok {
		return
	}
	uid, id := callerUserID(r), ""
	h.requisitionWrite(w, r, "bo.requisition.create", map[string]any{"outletId": outlet, "body": body},
		http.StatusCreated, &id, func(ctx context.Context, tx pgx.Tx) (e error) {
			id, e = h.Write.CreateRequisitionTx(ctx, tx, outlet, uid, body)
			return e
		})
}

func (h *Handlers) UpdateRequisition(w http.ResponseWriter, r *http.Request) {
	outlet, ok := outletWrite(w, r)
	if !ok {
		return
	}
	body, ok := decodeWrite[write.RequisitionInput](w, r)
	if !ok {
		return
	}
	id, uid := chi.URLParam(r, "id"), callerUserID(r)
	h.requisitionWrite(w, r, "bo.requisition.update", map[string]any{"id": id, "outletId": outlet, "body": body},
		http.StatusOK, &id, func(ctx context.Context, tx pgx.Tx) error {
			return h.Write.UpdateRequisitionTx(ctx, tx, id, outlet, uid, body)
		})
}

func (h *Handlers) SubmitRequisition(w http.ResponseWriter, r *http.Request) {
	outlet, ok := outletWrite(w, r)
	if !ok {
		return
	}
	id, uid := chi.URLParam(r, "id"), callerUserID(r)
	h.requisitionWrite(w, r, "bo.requisition.submit", map[string]any{"id": id, "outletId": outlet},
		http.StatusOK, &id, func(ctx context.Context, tx pgx.Tx) error {
			return h.Write.SubmitRequisitionTx(ctx, tx, id, outlet, uid)
		})
}

func (h *Handlers) CancelRequisition(w http.ResponseWriter, r *http.Request) {
	outlet, ok := outletWrite(w, r)
	if !ok {
		return
	}
	id, uid := chi.URLParam(r, "id"), callerUserID(r)
	h.requisitionWrite(w, r, "bo.requisition.cancel", map[string]any{"id": id, "outletId": outlet},
		http.StatusOK, &id, func(ctx context.Context, tx pgx.Tx) error {
			return h.Write.CancelRequisitionTx(ctx, tx, id, outlet, uid)
		})
}

func (h *Handlers) ApproveRequisition(w http.ResponseWriter, r *http.Request) {
	if !requireRequisitionKey(w, r) {
		return
	}
	body, ok := decodeWrite[write.RequisitionApproval](w, r)
	if !ok {
		return
	}
	id, uid, viewer := chi.URLParam(r, "id"), callerUserID(r), ctxOutlet(r)
	h.requisitionWrite(w, r, "bo.requisition.approve", map[string]any{"id": id, "body": body},
		http.StatusOK, &id, func(ctx context.Context, tx pgx.Tx) error {
			return h.Write.ApproveRequisitionTx(ctx, tx, id, viewer, uid, body)
		})
}

func (h *Handlers) RejectRequisition(w http.ResponseWriter, r *http.Request) {
	if !requireRequisitionKey(w, r) {
		return
	}
	body, ok := decodeWrite[api.InventoryRejectInput](w, r)
	if !ok {
		return
	}
	id, uid, viewer := chi.URLParam(r, "id"), callerUserID(r), ctxOutlet(r)
	h.requisitionWrite(w, r, "bo.requisition.reject", map[string]any{"id": id, "body": body},
		http.StatusOK, &id, func(ctx context.Context, tx pgx.Tx) error {
			return h.Write.RejectRequisitionTx(ctx, tx, id, viewer, uid, body.Note)
		})
}

func (h *Handlers) FulfilRequisition(w http.ResponseWriter, r *http.Request) {
	if !requireRequisitionKey(w, r) {
		return
	}
	id, uid, viewer := chi.URLParam(r, "id"), callerUserID(r), ctxOutlet(r)
	var tid, tno string
	do := func(ctx context.Context, tx pgx.Tx) (e error) {
		tid, tno, e = h.Write.FulfilRequisitionTx(ctx, tx, id, viewer, uid)
		return e
	}
	h.keyedMutated(w, r, keyedWrite{
		OpType: "bo.requisition.fulfil", Payload: map[string]any{"id": id}, Status: http.StatusCreated,
		Unkeyed: func() error { return h.Write.WithTx(r.Context(), func(tx pgx.Tx) error { return do(r.Context(), tx) }) },
		Effect:  do,
		Outcome: func(context.Context, read.RowQuerier) (json.RawMessage, error) {
			return json.Marshal(map[string]any{"data": map[string]string{"transferId": tid, "transferNo": tno}})
		},
		OnErr: func(w http.ResponseWriter, err error) bool { return countConflict(w, r, err) },
	})
}
