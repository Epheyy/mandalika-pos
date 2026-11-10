package handlers

import (
	"net/http"

	"github.com/go-chi/chi/v5"

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

func (h *Handlers) UpdateOutlet(w http.ResponseWriter, r *http.Request) {
	// A non-admin may only edit their own outlet (the id is a path param, so check it).
	if !outletInScope(r, chi.URLParam(r, "id")) {
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
