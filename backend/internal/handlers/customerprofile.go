package handlers

import (
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/mandalika/pos-backend/internal/api"
	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/httpx"
	"github.com/mandalika/pos-backend/internal/phone"
	"github.com/mandalika/pos-backend/internal/read"
	"github.com/mandalika/pos-backend/internal/service"
)

// isUUID: the canonical 36-character form only (uuid.Parse also takes urn: and braces, which Postgres rejects).
func isUUID(s string) bool { _, err := uuid.Parse(s); return err == nil && len(s) == 36 }

// Profile budget per terminal account (A30): enough for a shift of attach-and-look, far too small to guess phones.
const (
	profilePerMinute = 30
	profilePerDay    = 300
)

// profileAllowed counts one profile read against the caller's own minute and day windows (the lookup budget's
// shape and decision rule, separate keys). A request the minute window refuses does not touch the day counter.
func (h *Handlers) profileAllowed(r *http.Request, now time.Time) (retryAfter int, ok bool) {
	uid, _ := r.Context().Value(auth.CtxUserID).(string)
	m := h.Cache.IncrWindow(r.Context(), "rl:custprofile:m:"+uid+":"+strconv.FormatInt(now.Unix()/60, 10), time.Minute)
	if m > profilePerMinute {
		return 60 - now.UTC().Second(), false
	}
	d := h.Cache.IncrWindow(r.Context(), "rl:custprofile:d:"+uid+":"+now.UTC().Format("20060102"), 24*time.Hour)
	if d > profilePerDay {
		next := time.Date(now.Year(), now.Month(), now.Day()+1, 0, 0, 0, 0, time.UTC)
		return int(next.Sub(now.UTC()).Seconds()), false
	}
	return 0, true
}

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
	// A30: the phone gate is a guess-the-phone oracle for anyone holding an id, so a phone-only caller spends a
	// budget of its own (not the lookup budget: a busy outlet must not lose phone lookups to profile opens).
	if !withNotes {
		if retryAfter, ok := h.profileAllowed(r, time.Now()); !ok {
			w.Header().Set("Retry-After", strconv.Itoa(retryAfter))
			httpx.Err(w, http.StatusTooManyRequests, "terlalu banyak permintaan, coba lagi nanti")
			return
		}
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
