package handlers

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/mandalika/pos-backend/internal/api"
	"github.com/mandalika/pos-backend/internal/httpx"
	"github.com/mandalika/pos-backend/internal/write"
)

func (h *Handlers) Ingredients(w http.ResponseWriter, r *http.Request) {
	p, l := pageLimit(r)
	q := r.URL.Query().Get("q")
	categoryID, ok := uuidParam(w, r, "categoryId")
	if !ok {
		return
	}
	rows, total, err := h.Repo.Ingredients(r.Context(), p, l, q, categoryID)
	if err != nil {
		writeErr(w, r, 500, err)
		return
	}
	writeJSON(w, http.StatusOK, api.IngredientListResponse{Data: rows, Meta: *meta(total, p, l)})
}

func (h *Handlers) CreateIngredient(w http.ResponseWriter, r *http.Request) {
	in, ok := decodeWrite[write.Ingredient](w, r)
	if !ok {
		return
	}
	id, err := h.Write.CreateIngredient(r.Context(), in)
	h.created(w, r, id, err)
}

func (h *Handlers) UpdateIngredient(w http.ResponseWriter, r *http.Request) {
	in, ok := decodeWrite[write.Ingredient](w, r)
	if !ok {
		return
	}
	h.mutated(w, r, h.Write.UpdateIngredient(r.Context(), chi.URLParam(r, "id"), in))
}

func (h *Handlers) DeleteIngredient(w http.ResponseWriter, r *http.Request) {
	h.mutated(w, r, h.Write.DeleteIngredient(r.Context(), chi.URLParam(r, "id")))
}

func (h *Handlers) IngredientUsage(w http.ResponseWriter, r *http.Request) {
	resp, err := h.Repo.IngredientUsage(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, r, 500, err)
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

func (h *Handlers) CreateIngredientLocationGoodsReceipt(w http.ResponseWriter, r *http.Request) {
	kind, locID, ok := locTarget(r)
	if !ok {
		httpx.Err(w, http.StatusBadRequest, "kind ('outlet'/'warehouse') dan id wajib")
		return
	}
	type body struct {
		Supplier string                             `json:"supplier"`
		Note     string                             `json:"note"`
		Items    []write.IngredientGoodsReceiptItem `json:"items"`
	}
	b, ok := decodeWrite[body](w, r)
	if !ok {
		return
	}
	c, _ := h.caller(r)
	in := write.IngredientGoodsReceipt{
		LocKind:  kind,
		LocID:    locID,
		Supplier: b.Supplier,
		Note:     b.Note,
		Items:    b.Items,
	}
	id, err := h.Write.CreateIngredientGoodsReceipt(r.Context(), c.userID, in)
	h.created(w, r, id, err)
}

func (h *Handlers) AdjustIngredientLocationStock(w http.ResponseWriter, r *http.Request) {
	kind, locID, ok := locTarget(r)
	if !ok {
		httpx.Err(w, http.StatusBadRequest, "kind ('outlet'/'warehouse') dan id wajib")
		return
	}
	type body struct {
		IngredientID string  `json:"ingredientId"`
		NewQty       float64 `json:"newQty"`
		Reason       string  `json:"reason"`
	}
	b, ok := decodeWrite[body](w, r)
	if !ok {
		return
	}
	c, _ := h.caller(r)
	in := write.IngredientAdjust{
		LocKind:      kind,
		LocID:        locID,
		IngredientID: b.IngredientID,
		NewQty:       b.NewQty,
		Reason:       b.Reason,
	}
	h.mutated(w, r, h.Write.AdjustIngredientStock(r.Context(), c.userID, in))
}

func (h *Handlers) IngredientLocationStock(w http.ResponseWriter, r *http.Request) {
	kind, locID, ok := locTarget(r)
	if !ok {
		httpx.Err(w, http.StatusBadRequest, "kind ('outlet'/'warehouse') dan id wajib")
		return
	}
	rows, err := h.Repo.IngredientLocationStock(r.Context(), kind, locID)
	if err != nil {
		writeErr(w, r, 500, err)
		return
	}
	writeJSON(w, http.StatusOK, api.IngredientStockResponse{Data: rows})
}

func (h *Handlers) IngredientCategories(w http.ResponseWriter, r *http.Request) {
	rows, err := h.Repo.IngredientCategories(r.Context())
	if err != nil {
		writeErr(w, r, 500, err)
		return
	}
	writeJSON(w, http.StatusOK, api.IngredientCategoryListResponse{Data: rows})
}

func (h *Handlers) CreateIngredientCategory(w http.ResponseWriter, r *http.Request) {
	in, ok := decodeWrite[write.IngredientCategory](w, r)
	if !ok {
		return
	}
	id, err := h.Write.CreateIngredientCategory(r.Context(), in)
	h.created(w, r, id, err)
}

func (h *Handlers) UpdateIngredientCategory(w http.ResponseWriter, r *http.Request) {
	in, ok := decodeWrite[write.IngredientCategory](w, r)
	if !ok {
		return
	}
	h.mutated(w, r, h.Write.UpdateIngredientCategory(r.Context(), chi.URLParam(r, "id"), in))
}

func (h *Handlers) DeleteIngredientCategory(w http.ResponseWriter, r *http.Request) {
	h.mutated(w, r, h.Write.DeleteIngredientCategory(r.Context(), chi.URLParam(r, "id")))
}
