package handlers

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/mandalika/pos-backend/internal/api"
	"github.com/mandalika/pos-backend/internal/httpx"
	"github.com/mandalika/pos-backend/internal/write"
)

func (h *Handlers) IngredientTransfers(w http.ResponseWriter, r *http.Request) {
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
	rows, total, err := h.Repo.IngredientTransfers(r.Context(), p, l, status, from, to, locKind, locID)
	if err != nil {
		writeErr(w, r, 500, err)
		return
	}
	writeJSON(w, http.StatusOK, api.IngredientTransferListResponse{Data: rows, Meta: *meta(total, p, l)})
}

func (h *Handlers) IngredientTransfer(w http.ResponseWriter, r *http.Request) {
	t, err := h.Repo.IngredientTransfer(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, r, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusOK, api.IngredientTransferResponse{Data: t})
}

func (h *Handlers) CreateIngredientTransfer(w http.ResponseWriter, r *http.Request) {
	// Body: {source:{kind,id}, dest:{kind,id}, note, items:[{ingredientId,qty}]}
	// write.IngredientTransferCreate has Source/Dest as TransferLoc{Kind,ID} — matches JSON exactly.
	in, ok := decodeWrite[write.IngredientTransferCreate](w, r)
	if !ok {
		return
	}
	c, _ := h.caller(r)
	id, err := h.Write.CreateIngredientTransfer(r.Context(), c.userID, in)
	h.created(w, r, id, err)
}

func (h *Handlers) SendIngredientTransfer(w http.ResponseWriter, r *http.Request) {
	c, _ := h.caller(r)
	h.mutated(w, r, h.Write.SendIngredientTransfer(r.Context(), c.userID, chi.URLParam(r, "id")))
}

func (h *Handlers) ReceiveIngredientTransfer(w http.ResponseWriter, r *http.Request) {
	in, ok := decodeWrite[write.IngredientTransferReceive](w, r)
	if !ok {
		return
	}
	c, _ := h.caller(r)
	h.mutated(w, r, h.Write.ReceiveIngredientTransfer(r.Context(), c.userID, chi.URLParam(r, "id"), in))
}

type ingredientTransferCancelBody struct {
	Reason string `json:"reason"`
}

func (h *Handlers) CancelIngredientTransfer(w http.ResponseWriter, r *http.Request) {
	in, ok := decodeWrite[ingredientTransferCancelBody](w, r)
	if !ok {
		return
	}
	c, _ := h.caller(r)
	h.mutated(w, r, h.Write.CancelIngredientTransfer(r.Context(), c.userID, chi.URLParam(r, "id"), in.Reason))
}
