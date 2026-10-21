package handlers

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/mandalika/pos-backend/internal/api"
	"github.com/mandalika/pos-backend/internal/write"
)

func (h *Handlers) CreatePromotion(w http.ResponseWriter, r *http.Request) {
	p, ok := decodeWrite[write.Promotion](w, r)
	if !ok {
		return
	}
	id, err := h.Write.CreatePromotion(r.Context(), p)
	h.created(w, r, id, err)
}

func (h *Handlers) UpdatePromotion(w http.ResponseWriter, r *http.Request) {
	p, ok := decodeWrite[write.Promotion](w, r)
	if !ok {
		return
	}
	h.mutated(w, r, h.Write.UpdatePromotion(r.Context(), chi.URLParam(r, "id"), p))
}

func (h *Handlers) DeletePromotion(w http.ResponseWriter, r *http.Request) {
	h.mutated(w, r, h.Write.DeletePromotion(r.Context(), chi.URLParam(r, "id")))
}

func (h *Handlers) CreateDiscountCode(w http.ResponseWriter, r *http.Request) {
	d, ok := decodeWrite[write.DiscountCode](w, r)
	if !ok {
		return
	}
	id, err := h.Write.CreateDiscountCode(r.Context(), d)
	h.created(w, r, id, err)
}

func (h *Handlers) UpdateDiscountCode(w http.ResponseWriter, r *http.Request) {
	d, ok := decodeWrite[write.DiscountCode](w, r)
	if !ok {
		return
	}
	h.mutated(w, r, h.Write.UpdateDiscountCode(r.Context(), chi.URLParam(r, "id"), d))
}

func (h *Handlers) DeleteDiscountCode(w http.ResponseWriter, r *http.Request) {
	h.mutated(w, r, h.Write.DeleteDiscountCode(r.Context(), chi.URLParam(r, "id")))
}

// CreateDiscountCodeBatch generates a batch of unique discount codes sharing
// one set of settings (write.CreateDiscountCodeBatch), then re-fetches the
// created rows via the read repo (DiscountCodesByIDs) rather than hand-assembling
// api.DiscountCode — its nullable.Nullable wrappers are painful/error-prone to
// build by hand and the read repo already serializes them correctly.
func (h *Handlers) CreateDiscountCodeBatch(w http.ResponseWriter, r *http.Request) {
	b, ok := decodeWrite[write.DiscountCodeBatch](w, r)
	if !ok {
		return
	}
	created, err := h.Write.CreateDiscountCodeBatch(r.Context(), b)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err) // validation/generation error → 400 + message
		return
	}
	ids := make([]string, len(created))
	for i, c := range created {
		ids[i] = c.ID
	}
	rows, _, err := h.Repo.DiscountCodesByIDs(r.Context(), ids)
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	h.invalidate(r)
	writeJSON(w, http.StatusOK, api.DiscountCodeListResponse{Data: rows})
}
