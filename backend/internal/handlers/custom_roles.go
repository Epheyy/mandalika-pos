package handlers

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/mandalika/pos-backend/internal/write"
)

func (h *Handlers) CreateCustomRole(w http.ResponseWriter, r *http.Request) {
	c, ok := decodeWrite[write.CustomRole](w, r)
	if !ok {
		return
	}
	id, err := h.Write.CreateCustomRole(r.Context(), c)
	h.created(w, r, id, err)
}

func (h *Handlers) UpdateCustomRole(w http.ResponseWriter, r *http.Request) {
	c, ok := decodeWrite[write.CustomRole](w, r)
	if !ok {
		return
	}
	h.mutated(w, r, h.Write.UpdateCustomRole(r.Context(), chi.URLParam(r, "id"), c))
}

func (h *Handlers) DeleteCustomRole(w http.ResponseWriter, r *http.Request) {
	h.mutated(w, r, h.Write.DeleteCustomRole(r.Context(), chi.URLParam(r, "id")))
}
