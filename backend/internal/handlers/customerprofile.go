package handlers

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/mandalika/pos-backend/internal/api"
	"github.com/mandalika/pos-backend/internal/httpx"
	"github.com/mandalika/pos-backend/internal/read"
	"github.com/mandalika/pos-backend/internal/service"
)

// CustomerProfile serves the POS profile sheet (D-25). Any authenticated role: the cashier
// reaches a customer by phone and then asks for the profile by id. Order-derived data is
// limited to scope(r) (the outlet-scope IDOR lesson: never a raw outletId); notes are CRM
// data and follow customerScope. A merged-away id answers with the keeper.
func (h *Handlers) CustomerProfile(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if _, err := uuid.Parse(id); err != nil {
		httpx.Err(w, http.StatusNotFound, "pelanggan tidak ditemukan")
		return
	}
	withNotes := customerScope(r) == CustomerAll
	data, err := h.Repo.CustomerProfile(r.Context(), id, scope(r), withNotes)
	if errors.Is(err, read.ErrNotFound) {
		httpx.Err(w, http.StatusNotFound, "pelanggan tidak ditemukan")
		return
	}
	if err != nil {
		writeErr(w, r, http.StatusInternalServerError, err)
		return
	}
	p := data.Profile
	p.Customer.Tier = api.CustomerProfileHeaderTier(service.CustomerTier(data.TotalSpend))
	c, _ := h.caller(r)
	rewards, err := h.OrderSvc.PreviewRewards(r.Context(), p.Customer.Id.String(), nil, 0, nil, c.outletID)
	if err != nil {
		writeErr(w, r, http.StatusInternalServerError, err)
		return
	}
	p.RewardsAvailable = len(rewards)
	w.Header().Set("Cache-Control", "no-store")
	// writeJSON: CustomerProfileResponse already carries the {data:...} envelope.
	writeJSON(w, http.StatusOK, api.CustomerProfileResponse{Data: p})
}
