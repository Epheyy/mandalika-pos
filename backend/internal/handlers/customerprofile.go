package handlers

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/mandalika/pos-backend/internal/api"
	"github.com/mandalika/pos-backend/internal/httpx"
	"github.com/mandalika/pos-backend/internal/phone"
	"github.com/mandalika/pos-backend/internal/read"
	"github.com/mandalika/pos-backend/internal/service"
)

// isUUID: the canonical 36-character form only (uuid.Parse also takes urn: and braces, which Postgres rejects).
func isUUID(s string) bool { _, err := uuid.Parse(s); return err == nil && len(s) == 36 }

// CustomerProfile serves the POS profile sheet (D-25). Any authenticated role: the cashier
// reaches a customer by phone and then asks for the profile by id. Order-derived data is
// limited to scope(r) (the outlet-scope IDOR lesson: never a raw outletId); notes are CRM
// data and follow customerScope. A merged-away id answers with the keeper.
func (h *Handlers) CustomerProfile(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if !isUUID(id) {
		httpx.Err(w, http.StatusNotFound, "pelanggan tidak ditemukan")
		return
	}
	withNotes := customerScope(r) == CustomerAll
	sc := scope(r)
	if sc.OutletID != "" && !isUUID(sc.OutletID) {
		httpx.Err(w, http.StatusBadRequest, "outletId tidak valid")
		return
	}
	data, err := h.Repo.CustomerProfile(r.Context(), id, sc, withNotes, phone.Normalize(r.URL.Query().Get("phone")))
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
	// The count is advisory: a failed preview must not hide the profile.
	if err == nil {
		p.RewardsAvailable = len(rewards)
	}
	w.Header().Set("Cache-Control", "no-store")
	// writeJSON: CustomerProfileResponse already carries the {data:...} envelope.
	writeJSON(w, http.StatusOK, api.CustomerProfileResponse{Data: p})
}
