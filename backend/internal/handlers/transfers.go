package handlers

import (
	"context"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/mandalika/pos-backend/internal/api"
	"github.com/mandalika/pos-backend/internal/httpx"
	"github.com/mandalika/pos-backend/internal/write"
)

func (h *Handlers) Transfers(w http.ResponseWriter, r *http.Request) {
	p, l := pageLimit(r)
	q := r.URL.Query()
	status := q.Get("status")
	from := q.Get("from")
	to := q.Get("to")
	locKind := q.Get("locKind")
	locID := q.Get("locID")
	if locKind != "" && locKind != "outlet" && locKind != "warehouse" {
		httpx.Err(w, http.StatusBadRequest, "locKind harus outlet atau warehouse")
		return
	}
	rows, total, err := h.Repo.Transfers(r.Context(), status, from, to, locKind, locID, p, l)
	if err != nil {
		writeErr(w, r, 500, err)
		return
	}
	writeJSON(w, http.StatusOK, api.TransferListResponse{Data: rows, Meta: *meta(total, p, l)})
}

func (h *Handlers) Transfer(w http.ResponseWriter, r *http.Request) {
	v, err := h.Repo.Transfer(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, r, 0, err) // writeErr maps read.ErrNotFound → 404
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": v})
}

func (h *Handlers) TransferLocationStock(w http.ResponseWriter, r *http.Request) {
	kind := r.URL.Query().Get("kind")
	id := r.URL.Query().Get("id")
	if kind != "warehouse" && kind != "outlet" {
		httpx.Err(w, http.StatusBadRequest, "kind harus 'warehouse' atau 'outlet'")
		return
	}
	if id == "" {
		httpx.Err(w, http.StatusBadRequest, "id wajib")
		return
	}
	rows, err := h.Repo.LocationStock(r.Context(), kind, id)
	if err != nil {
		writeErr(w, r, 500, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": rows})
}

func (h *Handlers) CreateTransfer(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeWrite[write.TransferCreate](w, r)
	if !ok {
		return
	}
	c, _ := h.caller(r)
	id, err := h.Write.CreateTransfer(r.Context(), c.userID, body)
	h.created(w, r, id, err)
}

func (h *Handlers) UpdateTransfer(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeWrite[write.TransferCreate](w, r)
	if !ok {
		return
	}
	h.mutated(w, r, h.Write.UpdateTransferDraft(r.Context(), chi.URLParam(r, "id"), body))
}

func (h *Handlers) SendTransfer(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	h.keyedMutated(w, r, keyedWrite{
		OpType: "bo.transfer.send", Payload: map[string]string{"transferId": id},
		Unkeyed: func() error { return h.Write.SendTransfer(r.Context(), id) },
		Effect: func(ctx context.Context, tx pgx.Tx) error {
			return h.Write.SendTransferTx(ctx, tx, id, callerUserID(r))
		},
	})
}

func (h *Handlers) ReceiveTransfer(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeWrite[write.TransferReceive](w, r)
	if !ok {
		return
	}
	c, _ := h.caller(r)
	h.mutated(w, r, h.Write.ReceiveTransfer(r.Context(), chi.URLParam(r, "id"), body, write.ReceiveMeta{
		ReceivedBy: c.userID, ReceivedVia: "backoffice",
	}))
}

func (h *Handlers) CancelTransfer(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	h.keyedMutated(w, r, keyedWrite{
		OpType: "bo.transfer.cancel", Payload: map[string]string{"transferId": id},
		Unkeyed: func() error { return h.Write.CancelTransfer(r.Context(), id) },
		Effect: func(ctx context.Context, tx pgx.Tx) error {
			return h.Write.CancelTransferTx(ctx, tx, id, callerUserID(r))
		},
	})
}

func (h *Handlers) GetInboundTransfers(w http.ResponseWriter, r *http.Request) {
	c, _ := h.caller(r)
	if c.outletID == "" {
		writeJSON(w, http.StatusOK, map[string]any{"data": []any{}})
		return
	}
	rows, err := h.Repo.TransfersForOutlet(r.Context(), c.outletID, "in_transit")
	if err != nil {
		writeErr(w, r, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": rows})
}

func (h *Handlers) GetOutletTransfers(w http.ResponseWriter, r *http.Request) {
	c, _ := h.caller(r)
	status := r.URL.Query().Get("status")
	if status != "completed" && status != "cancelled" {
		httpx.Err(w, http.StatusBadRequest, "status harus completed atau cancelled")
		return
	}
	if c.outletID == "" {
		writeJSON(w, http.StatusOK, map[string]any{"data": []any{}})
		return
	}
	rows, err := h.Repo.OutletTransferHistory(r.Context(), c.outletID, status)
	if err != nil {
		writeErr(w, r, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": rows})
}
