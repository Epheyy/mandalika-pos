package handlers

import (
	"context"
	"errors"
	"net/http"

	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/httpx"
	syncpkg "github.com/mandalika/pos-backend/internal/sync"
)

func (h *Handlers) SyncVersion(w http.ResponseWriter, r *http.Request) {
	c, _ := h.caller(r)
	// Outlet-less accounts (admin before a terminal outlet is chosen) get the same
	// 403 as /sync/pull, not a 500 from an empty-uuid lookup. Clients read a 4xx as
	// "reachable, account problem" (A04).
	if c.outletID == "" {
		httpx.Err(w, http.StatusForbidden, "no active outlet")
		return
	}
	v, err := h.Sync.Version(r.Context(), c.outletID)
	if err != nil {
		syncFail(w, r, err)
		return
	}
	// A05: a 2xx here is the tablet's "last successful online contact"; sign it for the
	// device so the offline cap does not trust the tablet's own clock.
	v.Contact = h.Sync.ContactFor(r.URL.Query().Get("deviceId"))
	writeJSON(w, http.StatusOK, map[string]any{"data": v})
}

func (h *Handlers) SyncPull(w http.ResponseWriter, r *http.Request) {
	c, _ := h.caller(r)
	if c.outletID == "" {
		httpx.Err(w, http.StatusForbidden, "no active outlet")
		return
	}
	b, err := h.Sync.Pull(r.Context(), scope(r), c.outletID)
	if err != nil {
		syncFail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": b})
}

func (h *Handlers) SyncBatch(w http.ResponseWriter, r *http.Request) {
	h.syncBatch(w, r, h.caller, h.Sync.ProcessBatch)
}

// Keep the trusted HTTP mapping testable without a database identity lookup.
func (h *Handlers) syncBatch(w http.ResponseWriter, r *http.Request,
	resolveCaller func(*http.Request) (callerID, error),
	process func(context.Context, syncpkg.Caller, []syncpkg.BatchItem) (syncpkg.BatchResult, error),
) {
	items, err := decodeBatchEnvelope(http.MaxBytesReader(w, r.Body, syncBatchBodyLimit))
	if errors.Is(err, errBatchTooLarge) {
		httpx.Err(w, http.StatusRequestEntityTooLarge, "batch too large")
		return
	}
	if err != nil {
		httpx.Err(w, http.StatusBadRequest, "invalid body")
		return
	}
	c, _ := resolveCaller(r)
	if c.outletID == "" {
		httpx.Err(w, http.StatusForbidden, "no active outlet")
		return
	}
	res, err := process(r.Context(), syncpkg.Caller{
		OutletID: c.outletID, UserID: c.userID, DisplayName: c.name,
		Role: c.role, HomeOutletID: c.homeOutletID,
		CanRefund:       auth.HasPermission(r.Context(), "process_refund"),
		CanVoidOwnShift: auth.HasPermission(r.Context(), "void_own_shift"),
		CanVoidAny:      auth.HasPermission(r.Context(), "void_any"),
	}, items)
	if err != nil {
		syncFail(w, r, err)
		return
	}
	h.invalidate(r)
	writeJSON(w, http.StatusOK, map[string]any{"data": res})
}
