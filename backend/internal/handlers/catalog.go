package handlers

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/mandalika/pos-backend/internal/api"
	"github.com/mandalika/pos-backend/internal/write"
)

func (h *Handlers) CreateProduct(w http.ResponseWriter, r *http.Request) {
	p, ok := decodeWrite[write.Product](w, r)
	if !ok {
		return
	}
	id, err := h.Write.CreateProduct(r.Context(), scope(r).OutletID, p)
	h.created(w, r, id, err)
}

func (h *Handlers) UpdateProduct(w http.ResponseWriter, r *http.Request) {
	p, ok := decodeWrite[write.Product](w, r)
	if !ok {
		return
	}
	h.mutated(w, r, h.Write.UpdateProduct(r.Context(), chi.URLParam(r, "id"), p))
}

func (h *Handlers) DeleteProduct(w http.ResponseWriter, r *http.Request) {
	h.mutated(w, r, h.Write.DeleteProduct(r.Context(), chi.URLParam(r, "id")))
}

func (h *Handlers) GetProductOutletConfig(w http.ResponseWriter, r *http.Request) {
	rows, err := h.Repo.ProductOutletConfig(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, r, 500, err)
		return
	}
	writeJSON(w, http.StatusOK, api.OutletConfigResponse{Data: rows})
}

func (h *Handlers) PutProductOutletConfig(w http.ResponseWriter, r *http.Request) {
	in, ok := decodeWrite[api.OutletConfigInput](w, r)
	if !ok {
		return
	}
	h.mutated(w, r, h.Write.SetProductOutletConfig(r.Context(), chi.URLParam(r, "id"), in.Items))
}

func (h *Handlers) CreateCategory(w http.ResponseWriter, r *http.Request) {
	c, ok := decodeWrite[write.Category](w, r)
	if !ok {
		return
	}
	id, err := h.Write.CreateCategory(r.Context(), c)
	h.created(w, r, id, err)
}

func (h *Handlers) UpdateCategory(w http.ResponseWriter, r *http.Request) {
	c, ok := decodeWrite[write.Category](w, r)
	if !ok {
		return
	}
	h.mutated(w, r, h.Write.UpdateCategory(r.Context(), chi.URLParam(r, "id"), c))
}

func (h *Handlers) DeleteCategory(w http.ResponseWriter, r *http.Request) {
	h.mutated(w, r, h.Write.DeleteCategory(r.Context(), chi.URLParam(r, "id")))
}
