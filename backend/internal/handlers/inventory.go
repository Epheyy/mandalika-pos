package handlers

import (
	"net/http"

	"github.com/mandalika/pos-backend/internal/api"
	"github.com/mandalika/pos-backend/internal/httpx"
	"github.com/mandalika/pos-backend/internal/write"
)

// locTarget extracts and validates kind+id query params for polymorphic
// location endpoints (kind must be "outlet" or "warehouse", id must be set).
func locTarget(r *http.Request) (kind, id string, ok bool) {
	kind = r.URL.Query().Get("kind")
	id = r.URL.Query().Get("id")
	return kind, id, (kind == "warehouse" || kind == "outlet") && id != ""
}

func (h *Handlers) CreateLocationGoodsReceipt(w http.ResponseWriter, r *http.Request) {
	kind, id, ok := locTarget(r)
	if !ok {
		httpx.Err(w, http.StatusBadRequest, "kind ('outlet'/'warehouse') dan id wajib")
		return
	}
	g, ok := decodeWrite[write.GoodsReceipt](w, r)
	if !ok {
		return
	}
	c, _ := h.caller(r)
	h.mutated(w, r, h.Write.CreateLocationGoodsReceipt(r.Context(), kind, id, c.userID, g))
}

func (h *Handlers) AdjustLocationStock(w http.ResponseWriter, r *http.Request) {
	kind, id, ok := locTarget(r)
	if !ok {
		httpx.Err(w, http.StatusBadRequest, "kind ('outlet'/'warehouse') dan id wajib")
		return
	}
	a, ok := decodeWrite[write.WarehouseAdjust](w, r)
	if !ok {
		return
	}
	c, _ := h.caller(r)
	h.mutated(w, r, h.Write.AdjustLocationStock(r.Context(), kind, id, c.userID, a))
}

func (h *Handlers) SetOutletPar(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	if id == "" {
		httpx.Err(w, http.StatusBadRequest, "id outlet wajib")
		return
	}
	body, ok := decodeWrite[write.OutletPar](w, r)
	if !ok {
		return
	}
	h.mutated(w, r, h.Write.SetOutletPar(r.Context(), id, body.ProductID, body.VariantSize, body.ParLevel))
}

func (h *Handlers) InventoryOverview(w http.ResponseWriter, r *http.Request) {
	resp, err := h.Repo.InventoryOverview(r.Context())
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

func (h *Handlers) IngredientOverview(w http.ResponseWriter, r *http.Request) {
	resp, err := h.Repo.IngredientOverview(r.Context())
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

func (h *Handlers) MovementSummary(w http.ResponseWriter, r *http.Request) {
	kind := r.URL.Query().Get("kind")
	id := r.URL.Query().Get("id")
	from := r.URL.Query().Get("from")
	to := r.URL.Query().Get("to")
	if (kind != "outlet" && kind != "warehouse") || id == "" || from == "" || to == "" {
		httpx.Err(w, http.StatusBadRequest, "kind, id, from, to wajib")
		return
	}
	p, l := pageLimit(r)
	rows, total, err := h.Repo.MovementSummary(r.Context(), kind, id, from, to, p, l)
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, http.StatusOK, api.MovementSummaryResponse{Data: rows, Meta: *meta(total, p, l)})
}
