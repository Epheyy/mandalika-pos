package handlers

import (
	"errors"
	"net/http"

	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/httpx"
	"github.com/mandalika/pos-backend/internal/write"
)

// caller resolves the authenticated identity. Outlet/user never come from the
// request body (plan §2a, §5).
type callerID struct {
	outletID, userID, name string
	// role and homeOutletID are read from the users row, never from the request (A04).
	role, homeOutletID string
}

func (h *Handlers) caller(r *http.Request) (callerID, error) {
	uid, _ := r.Context().Value(auth.CtxUserID).(string)
	outlet, _ := r.Context().Value(auth.CtxOutletID).(string)
	c := callerID{outletID: outlet, userID: uid}
	if u, err := h.Store.ByID(r.Context(), uid); err == nil {
		c.name = u.DisplayName
		c.role, c.homeOutletID = u.Role, u.OutletID
		if c.outletID == "" {
			c.outletID = u.OutletID
		}
	}
	return c, nil
}

func decodeWrite[T any](w http.ResponseWriter, r *http.Request) (T, bool) {
	var v T
	if err := httpx.DecodeLoose(r, &v); err != nil {
		httpx.Err(w, http.StatusBadRequest, "invalid body")
		return v, false
	}
	return v, true
}

func (h *Handlers) created(w http.ResponseWriter, r *http.Request, id string, err error) {
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	h.invalidate(r)
	writeJSON(w, http.StatusCreated, map[string]any{"data": map[string]string{"id": id}})
}

func (h *Handlers) mutated(w http.ResponseWriter, r *http.Request, err error) {
	if errors.Is(err, write.ErrNotFound) {
		httpx.Err(w, http.StatusNotFound, "not found")
		return
	}
	if errors.Is(err, write.ErrBusy) {
		// Lock conflict/deadlock: nothing was applied, safe to retry. Clean message only.
		httpx.Err(w, http.StatusConflict, err.Error())
		return
	}
	if isKeyConflict(err) {
		httpx.Err(w, http.StatusConflict, err.Error()) // key already used for another operation
		return
	}
	if write.IsStockGuardRefusal(err) {
		// A D13 refusal (stocked variant, or a rename onto leftover rows): 409 with its message.
		httpx.Err(w, http.StatusConflict, err.Error())
		return
	}
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	h.invalidate(r)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
