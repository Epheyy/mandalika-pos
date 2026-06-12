package handlers

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/mandalika/pos-backend/internal/api"
	"github.com/mandalika/pos-backend/internal/httpx"
	"github.com/mandalika/pos-backend/internal/read"
	"github.com/mandalika/pos-backend/internal/write"
)

// DupCandidates lists dup-candidate records filtered by status.
// GET /customers/dup-candidates?status=pending&page=1&limit=50
func (h *Handlers) DupCandidates(w http.ResponseWriter, r *http.Request) {
	status := r.URL.Query().Get("status")
	switch status {
	case "", "pending":
		status = "pending"
	case "merged", "dismissed":
		// ok
	default:
		httpx.Err(w, http.StatusBadRequest, "status harus pending, merged, atau dismissed")
		return
	}
	p, l := pageLimit(r)
	rows, total, err := h.Repo.DupCandidates(r.Context(), status, p, l)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, api.DupCandidateListResponse{
		Data: rows,
		Meta: *meta(total, p, l),
	})
}

// DupCandidate returns a single dup-candidate by id.
// GET /customers/dup-candidates/{id}
func (h *Handlers) DupCandidate(w http.ResponseWriter, r *http.Request) {
	v, err := h.Repo.DupCandidate(r.Context(), chi.URLParam(r, "id"))
	if errors.Is(err, read.ErrNotFound) {
		httpx.Err(w, http.StatusNotFound, "not found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, api.DupCandidateResponse{Data: v})
}

// MergeDupCandidate executes the merge transaction for a pending dup-candidate.
// POST /customers/dup-candidates/{id}/merge
func (h *Handlers) MergeDupCandidate(w http.ResponseWriter, r *http.Request) {
	in, ok := decodeWrite[api.MergeCustomersInput](w, r)
	if !ok {
		return
	}
	c, err := h.caller(r)
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "caller error")
		return
	}

	// Unwrap FieldChoices: nullable.Nullable[map[string]MergeCustomersInputFieldChoices].
	// .Get() returns (value, error); err==nil means specified and non-null.
	choices := map[string]string{}
	if m, err := in.FieldChoices.Get(); err == nil {
		for k, v := range m {
			choices[k] = string(v)
		}
	}

	// in.KeeperId is openapi_types.UUID — convert to string via .String().
	keeperID := in.KeeperId.String()

	mergeErr := h.Write.MergeCustomers(
		r.Context(),
		chi.URLParam(r, "id"),
		keeperID,
		choices,
		c.userID,
		c.name,
	)
	if mergeErr != nil {
		switch {
		case errors.Is(mergeErr, write.ErrNotFound):
			httpx.Err(w, http.StatusNotFound, "not found")
		case errors.Is(mergeErr, write.ErrCandidateNotPending),
			errors.Is(mergeErr, write.ErrAlreadyMerged),
			errors.Is(mergeErr, write.ErrSelfMerge),
			errors.Is(mergeErr, write.ErrKeeperNotInPair):
			httpx.Err(w, http.StatusConflict, mergeErr.Error())
		default:
			httpx.Err(w, http.StatusInternalServerError, mergeErr.Error())
		}
		return
	}
	h.invalidate(r)
	writeJSON(w, http.StatusOK, api.OkResponse{Ok: true})
}

// DismissDupCandidate marks a pending dup-candidate as dismissed.
// POST /customers/dup-candidates/{id}/dismiss
func (h *Handlers) DismissDupCandidate(w http.ResponseWriter, r *http.Request) {
	err := h.Write.DismissDupCandidate(r.Context(), chi.URLParam(r, "id"))
	if errors.Is(err, write.ErrNotFound) {
		httpx.Err(w, http.StatusNotFound, "not found")
		return
	}
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, err.Error())
		return
	}
	h.invalidate(r)
	writeJSON(w, http.StatusOK, api.OkResponse{Ok: true})
}
