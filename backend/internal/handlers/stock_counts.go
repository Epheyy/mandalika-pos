package handlers

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/mandalika/pos-backend/internal/apperr"
	"github.com/mandalika/pos-backend/internal/httpx"
	"github.com/mandalika/pos-backend/internal/write"
)

func (h *Handlers) CreateStockCount(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeWrite[write.StockCountCreate](w, r)
	if !ok {
		return
	}
	c, _ := h.caller(r)
	outletID := c.outletID
	if body.WarehouseID != "" {
		outletID = "" // warehouse count: location is the warehouse, not an outlet
	} else if outletID == "" {
		httpx.Err(w, http.StatusForbidden, "no active outlet")
		return
	}
	id, err := h.Write.CreateStockCount(r.Context(), outletID, c.userID, body)
	h.created(w, r, id, err)
}

func (h *Handlers) UpdateStockCount(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeWrite[write.StockCountUpdate](w, r)
	if !ok {
		return
	}
	c, _ := h.caller(r)
	// No outlet guard — the repo (lockCount) authorizes: outlet counts must match
	// the caller's outlet; warehouse counts are permission-gated by the route.
	err := h.Write.UpdateStockCount(r.Context(), chi.URLParam(r, "id"), c.outletID, body)
	if countConflict(w, err) {
		return
	}
	h.mutated(w, r, err)
}

// countConflict answers a stock count lifecycle refusal (apperr.Conflict) with 409
// and its Indonesian message; every other error is left to the caller's mapping.
func countConflict(w http.ResponseWriter, err error) bool {
	if code, ok := apperr.CodeOf(err); ok && code == apperr.Conflict {
		httpx.Err(w, http.StatusConflict, err.Error())
		return true
	}
	return false
}

func (h *Handlers) CompleteStockCount(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Items []write.StockCountItem `json:"items"`
	}
	// Empty body = finalize from the stored draft items; a malformed one is a 400
	// with nothing applied.
	if err := decodeOptionalBody(r, &body); err != nil {
		httpx.Err(w, http.StatusBadRequest, "invalid body")
		return
	}
	c, _ := h.caller(r)
	// No outlet guard — repo authorizes (see UpdateStockCount).
	id := chi.URLParam(r, "id")
	if err := h.Write.CompleteStockCount(r.Context(), id, c.outletID, body.Items); err != nil {
		if errors.Is(err, write.ErrNotFound) {
			httpx.Err(w, http.StatusNotFound, "not found")
			return
		}
		if errors.Is(err, write.ErrBusy) {
			httpx.Err(w, http.StatusConflict, err.Error()) // nothing applied, safe to retry
			return
		}
		if countConflict(w, err) {
			return
		}
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	h.invalidate(r)
	v, err := h.Repo.StockCount(r.Context(), scope(r), id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": v})
}
