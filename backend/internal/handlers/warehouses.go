package handlers

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/mandalika/pos-backend/internal/write"
)

func (h *Handlers) Warehouses(w http.ResponseWriter, r *http.Request) {
	rows, err := h.Repo.Warehouses(r.Context())
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": rows})
}

func (h *Handlers) CreateWarehouse(w http.ResponseWriter, r *http.Request) {
	wh, ok := decodeWrite[write.Warehouse](w, r)
	if !ok {
		return
	}
	id, err := h.Write.CreateWarehouse(r.Context(), wh)
	h.created(w, r, id, err)
}

func (h *Handlers) UpdateWarehouse(w http.ResponseWriter, r *http.Request) {
	wh, ok := decodeWrite[write.Warehouse](w, r)
	if !ok {
		return
	}
	h.mutated(w, r, h.Write.UpdateWarehouse(r.Context(), chi.URLParam(r, "id"), wh))
}

func (h *Handlers) DeleteWarehouse(w http.ResponseWriter, r *http.Request) {
	h.mutated(w, r, h.Write.DeleteWarehouse(r.Context(), chi.URLParam(r, "id")))
}

func (h *Handlers) WarehouseStock(w http.ResponseWriter, r *http.Request) {
	rows, err := h.Repo.WarehouseStock(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": rows})
}
