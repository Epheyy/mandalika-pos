package handlers

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/mandalika/pos-backend/internal/httpx"
	"github.com/mandalika/pos-backend/internal/read"
)

// GetGoodsReceipt is the read-only view of one goods receipt, opened from the kartu stok. The
// location of the receipt must be inside the caller's scope (as for the kartu stok itself); a
// receipt outside it answers 403, an unknown id 404.
func (h *Handlers) GetGoodsReceipt(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if _, err := uuid.Parse(id); err != nil {
		httpx.Err(w, http.StatusBadRequest, "id tidak valid")
		return
	}
	d, err := h.Repo.GoodsReceiptDetail(r.Context(), id)
	if errors.Is(err, read.ErrGoodsReceiptNotFound) {
		httpx.Err(w, http.StatusNotFound, "penerimaan barang tidak ditemukan")
		return
	}
	if err != nil {
		writeErr(w, r, http.StatusInternalServerError, err)
		return
	}
	if !movementLocationAllowed(r, string(d.LocationType), d.LocationId.String()) {
		httpx.Err(w, http.StatusForbidden, "lokasi di luar cakupan akun")
		return
	}
	writeJSON(w, http.StatusOK, d)
}
