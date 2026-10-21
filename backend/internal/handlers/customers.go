package handlers

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/mandalika/pos-backend/internal/api"
	"github.com/mandalika/pos-backend/internal/httpx"
	"github.com/mandalika/pos-backend/internal/write"
)

func (h *Handlers) CreateCustomer(w http.ResponseWriter, r *http.Request) {
	c, ok := decodeWrite[write.Customer](w, r)
	if !ok {
		return
	}
	id, err := h.Write.CreateCustomer(r.Context(), c)
	h.created(w, r, id, err)
}

func (h *Handlers) UpdateCustomer(w http.ResponseWriter, r *http.Request) {
	c, ok := decodeWrite[write.Customer](w, r)
	if !ok {
		return
	}
	h.mutated(w, r, h.Write.UpdateCustomer(r.Context(), chi.URLParam(r, "id"), c))
}

func (h *Handlers) DeleteCustomer(w http.ResponseWriter, r *http.Request) {
	h.mutated(w, r, h.Write.DeleteCustomer(r.Context(), chi.URLParam(r, "id")))
}

func (h *Handlers) Tags(w http.ResponseWriter, r *http.Request) {
	rows, err := h.Repo.Tags(r.Context())
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, http.StatusOK, api.TagListResponse{Data: rows})
}

func (h *Handlers) CreateTag(w http.ResponseWriter, r *http.Request) {
	in, ok := decodeWrite[write.Tag](w, r)
	if !ok {
		return
	}
	id, err := h.Write.CreateTag(r.Context(), in)
	h.created(w, r, id, err)
}

func (h *Handlers) UpdateTag(w http.ResponseWriter, r *http.Request) {
	in, ok := decodeWrite[write.Tag](w, r)
	if !ok {
		return
	}
	h.mutated(w, r, h.Write.UpdateTag(r.Context(), chi.URLParam(r, "id"), in))
}

func (h *Handlers) DeleteTag(w http.ResponseWriter, r *http.Request) {
	h.mutated(w, r, h.Write.DeleteTag(r.Context(), chi.URLParam(r, "id")))
}

func (h *Handlers) SetCustomerTags(w http.ResponseWriter, r *http.Request) {
	in, ok := decodeWrite[api.SetCustomerTagsInput](w, r)
	if !ok {
		return
	}
	h.mutated(w, r, h.Write.SetCustomerTags(r.Context(), chi.URLParam(r, "id"), in.TagIds))
}

func (h *Handlers) Segments(w http.ResponseWriter, r *http.Request) {
	rows, err := h.Repo.Segments(r.Context())
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, http.StatusOK, api.SegmentListResponse{Data: rows})
}

func (h *Handlers) CreateSegment(w http.ResponseWriter, r *http.Request) {
	in, ok := decodeWrite[write.Segment](w, r)
	if !ok {
		return
	}
	id, err := h.Write.CreateSegment(r.Context(), in)
	h.created(w, r, id, err)
}

func (h *Handlers) UpdateSegment(w http.ResponseWriter, r *http.Request) {
	in, ok := decodeWrite[write.Segment](w, r)
	if !ok {
		return
	}
	h.mutated(w, r, h.Write.UpdateSegment(r.Context(), chi.URLParam(r, "id"), in))
}

func (h *Handlers) DeleteSegment(w http.ResponseWriter, r *http.Request) {
	h.mutated(w, r, h.Write.DeleteSegment(r.Context(), chi.URLParam(r, "id")))
}

func (h *Handlers) ReorderSegments(w http.ResponseWriter, r *http.Request) {
	in, ok := decodeWrite[api.ReorderSegmentsInput](w, r)
	if !ok {
		return
	}
	h.mutated(w, r, h.Write.ReorderSegments(r.Context(), in.OrderedIds))
}

func (h *Handlers) Interactions(w http.ResponseWriter, r *http.Request) {
	p, l := pageLimit(r)
	rows, total, err := h.Repo.Interactions(r.Context(), chi.URLParam(r, "id"), p, l)
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, http.StatusOK, api.InteractionListResponse{Data: rows, Meta: *meta(total, p, l)})
}

func (h *Handlers) CreateInteraction(w http.ResponseWriter, r *http.Request) {
	in, ok := decodeWrite[write.Interaction](w, r)
	if !ok {
		return
	}
	c, _ := h.caller(r)
	id, err := h.Write.CreateInteraction(r.Context(), chi.URLParam(r, "id"), in, c.userID, c.name)
	if errors.Is(err, write.ErrNotFound) {
		httpx.Err(w, http.StatusNotFound, "pelanggan tidak ditemukan")
		return
	}
	h.created(w, r, id, err)
}

func (h *Handlers) DeleteInteraction(w http.ResponseWriter, r *http.Request) {
	h.mutated(w, r, h.Write.DeleteInteraction(r.Context(), chi.URLParam(r, "id"), chi.URLParam(r, "iid")))
}

func (h *Handlers) PointTransactions(w http.ResponseWriter, r *http.Request) {
	p, l := pageLimit(r)
	rows, total, err := h.Repo.PointTransactions(r.Context(), chi.URLParam(r, "id"), p, l)
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, http.StatusOK, api.PointTransactionListResponse{Data: rows, Meta: *meta(total, p, l)})
}

func (h *Handlers) AdjustPoints(w http.ResponseWriter, r *http.Request) {
	in, ok := decodeWrite[api.AdjustPointsInput](w, r)
	if !ok {
		return
	}
	c, _ := h.caller(r)
	bal, err := h.Write.AdjustPoints(r.Context(), chi.URLParam(r, "id"), in.Points, in.Reason, c.userID, c.name)
	if errors.Is(err, write.ErrNotFound) {
		httpx.Err(w, http.StatusNotFound, "pelanggan tidak ditemukan")
		return
	}
	if errors.Is(err, write.ErrZeroDelta) || errors.Is(err, write.ErrInsufficientPoints) || errors.Is(err, write.ErrReasonRequired) {
		httpx.Err(w, http.StatusBadRequest, err.Error())
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	h.invalidate(r)
	writeJSON(w, http.StatusOK, api.AdjustPointsResponse{Data: struct {
		BalanceAfter int `json:"balanceAfter"`
	}{BalanceAfter: bal}})
}

func (h *Handlers) RewardGrants(w http.ResponseWriter, r *http.Request) {
	rows, err := h.Repo.RewardGrants(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, http.StatusOK, api.RewardGrantListResponse{Data: rows})
}
