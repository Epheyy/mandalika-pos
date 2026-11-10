package handlers

import (
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/httpx"
	"github.com/mandalika/pos-backend/internal/write"
)

func (h *Handlers) CreateOutlet(w http.ResponseWriter, r *http.Request) {
	o, ok := decodeWrite[write.Outlet](w, r)
	if !ok {
		return
	}
	if !validOutletTimezone(w, o.Timezone) {
		return
	}
	id, err := h.Write.CreateOutlet(r.Context(), o)
	h.created(w, r, id, err)
}

// canEditOutletID: admin always (role read straight from the token, not scope(), which
// narrows an outlet-assigned admin or an X-Outlet-Id header to one outlet); anyone else
// only their own token outlet.
func canEditOutletID(r *http.Request, id string) bool {
	if role, _ := r.Context().Value(auth.CtxRole).(string); role == "admin" {
		return true
	}
	own, _ := r.Context().Value(auth.CtxOutletID).(string)
	return own != "" && strings.EqualFold(own, id)
}

func (h *Handlers) UpdateOutlet(w http.ResponseWriter, r *http.Request) {
	// A non-admin may only edit their own outlet (the id is a path param, so check it).
	if !canEditOutletID(r, chi.URLParam(r, "id")) {
		httpx.Err(w, http.StatusForbidden, "outlet not permitted")
		return
	}
	o, ok := decodeWrite[write.Outlet](w, r)
	if !ok {
		return
	}
	if !validOutletTimezone(w, o.Timezone) {
		return
	}
	h.mutated(w, r, h.Write.UpdateOutlet(r.Context(), chi.URLParam(r, "id"), o))
}
