package handlers

import (
	"errors"
	"net/http"

	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/coverage"
	"github.com/mandalika/pos-backend/internal/httpx"
	"github.com/mandalika/pos-backend/internal/write"
)

// caller resolves the authenticated identity. Outlet/user never come from the
// request body (plan §2a, §5).
type callerID struct {
	outletID, userID, name string
	// role and homeOutletID are read from the users row, never from the request (A04).
	role, homeOutletID string
	coverage           coverage.Coverage
}

func (h *Handlers) caller(r *http.Request) (callerID, error) {
	uid, _ := r.Context().Value(auth.CtxUserID).(string)
	outlet, _ := r.Context().Value(auth.CtxOutletID).(string)
	c := callerID{outletID: outlet, userID: uid}
	if u, err := h.Store.ByID(r.Context(), uid); err == nil {
		c.name = u.DisplayName
		c.role, c.homeOutletID, c.coverage = u.Role, u.OutletID, u.Coverage()
		if c.outletID == "" {
			c.outletID = u.OutletID
		}
	}
	return c, nil
}

func decodeWrite[T any](w http.ResponseWriter, r *http.Request) (T, bool) {
	var v T
	if err := httpx.DecodeLoose(r, &v); err != nil {
		writeDecodeErr(w, err)
		return v, false
	}
	return v, true
}

// writeDecodeErr answers a failed body decode: a *http.MaxBytesError (the global
// or a per-route cap tripped, incl. chunked bodies) is 413 with a fixed message;
// anything else keeps the 400 "invalid body".
func writeDecodeErr(w http.ResponseWriter, err error) {
	if isBodyTooLarge(err) {
		httpx.Err(w, http.StatusRequestEntityTooLarge, "request body too large")
		return
	}
	httpx.Err(w, http.StatusBadRequest, "invalid body")
}

func (h *Handlers) created(w http.ResponseWriter, r *http.Request, id string, err error) {
	if write.IsSkuTaken(err) || write.IsBundleConflict(err) {
		httpx.Err(w, http.StatusConflict, safeDomainText(r, http.StatusConflict, err))
		return
	}
	if err != nil {
		writeErr(w, r, http.StatusBadRequest, err)
		return
	}
	h.invalidate(r)
	writeJSON(w, http.StatusCreated, map[string]any{"data": map[string]string{"id": id}})
}

// mutated answers a write: the mapped failure, or cache invalidation and {ok:true}.
func (h *Handlers) mutated(w http.ResponseWriter, r *http.Request, err error) {
	if h.mutationFailed(w, r, err) {
		return
	}
	h.invalidate(r)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// mutationFailed writes the error response for a failed write and reports whether err was set.
func (h *Handlers) mutationFailed(w http.ResponseWriter, r *http.Request, err error) bool {
	if errors.Is(err, write.ErrNotFound) {
		httpx.Err(w, http.StatusNotFound, "not found")
		return true
	}
	if errors.Is(err, write.ErrBusy) {
		// Lock conflict/deadlock: nothing was applied, safe to retry. Clean message only.
		httpx.Err(w, http.StatusConflict, safeDomainText(r, http.StatusConflict, err))
		return true
	}
	if isKeyConflict(err) {
		httpx.Err(w, http.StatusConflict, safeDomainText(r, http.StatusConflict, err)) // key already used for another operation
		return true
	}
	if write.IsSkuTaken(err) || write.IsBundleConflict(err) {
		httpx.Err(w, http.StatusConflict, safeDomainText(r, http.StatusConflict, err))
		return true
	}
	if write.IsErpOwned(err) {
		// An ERP-owned field of an ERP-linked row (plan 4.5): the ERP owns it.
		httpx.Err(w, http.StatusConflict, safeDomainText(r, http.StatusConflict, err))
		return true
	}
	if write.IsProductHasHistory(err) || write.IsWarehouseHasHistory(err) {
		// A zeroed product or warehouse that stock documents name: 409 naming that and deactivate.
		httpx.Err(w, http.StatusConflict, safeDomainText(r, http.StatusConflict, err))
		return true
	}
	if write.IsStockGuardRefusal(err) {
		// A D13 refusal (stocked variant, or a rename onto leftover rows): 409 with its message.
		httpx.Err(w, http.StatusConflict, safeDomainText(r, http.StatusConflict, err))
		return true
	}
	if err != nil {
		writeErr(w, r, http.StatusBadRequest, err)
		return true
	}
	return false
}
