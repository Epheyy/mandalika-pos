package handlers

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/mandalika/pos-backend/internal/api"
	"github.com/mandalika/pos-backend/internal/write"
)

func (h *Handlers) IngredientStockCounts(w http.ResponseWriter, r *http.Request) {
	p, l := pageLimit(r)
	rows, total, err := h.Repo.IngredientStockCounts(r.Context(), p, l)
	if err != nil {
		writeErr(w, r, 500, err)
		return
	}
	writeJSON(w, http.StatusOK, api.IngredientStockCountListResponse{Data: rows, Meta: *meta(total, p, l)})
}

func (h *Handlers) IngredientStockCount(w http.ResponseWriter, r *http.Request) {
	sc, err := h.Repo.IngredientStockCount(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, r, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusOK, api.IngredientStockCountResponse{Data: sc})
}

func (h *Handlers) CreateIngredientStockCount(w http.ResponseWriter, r *http.Request) {
	// Body: {name, location:{kind,id}, plannedDate?, notes?}
	type ingredientStockCountInput struct {
		Name        string            `json:"name"`
		Location    write.TransferLoc `json:"location"`
		PlannedDate string            `json:"plannedDate"`
		Notes       string            `json:"notes"`
	}
	b, ok := decodeWrite[ingredientStockCountInput](w, r)
	if !ok {
		return
	}
	c, _ := h.caller(r)
	in := write.IngredientStockCount{
		Name:        b.Name,
		LocKind:     b.Location.Kind,
		LocID:       b.Location.ID,
		PlannedDate: b.PlannedDate,
		Notes:       b.Notes,
	}
	id, err := h.Write.CreateIngredientStockCount(r.Context(), c.userID, in)
	h.created(w, r, id, err)
}

func (h *Handlers) StartIngredientStockCount(w http.ResponseWriter, r *http.Request) {
	h.mutated(w, r, h.Write.StartIngredientStockCount(r.Context(), chi.URLParam(r, "id")))
}

type ingredientStockCountSaveBody struct {
	Items []write.IngredientStockCountSaveItem `json:"items"`
}

func (h *Handlers) SaveIngredientStockCount(w http.ResponseWriter, r *http.Request) {
	in, ok := decodeWrite[ingredientStockCountSaveBody](w, r)
	if !ok {
		return
	}
	h.mutated(w, r, h.Write.SaveIngredientStockCount(r.Context(), chi.URLParam(r, "id"), in.Items))
}

func (h *Handlers) CompleteIngredientStockCount(w http.ResponseWriter, r *http.Request) {
	h.mutated(w, r, h.Write.CompleteIngredientStockCount(r.Context(), chi.URLParam(r, "id")))
}

func (h *Handlers) CancelIngredientStockCount(w http.ResponseWriter, r *http.Request) {
	h.mutated(w, r, h.Write.CancelIngredientStockCount(r.Context(), chi.URLParam(r, "id")))
}
