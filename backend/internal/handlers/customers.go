package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/mandalika/pos-backend/internal/api"
	"github.com/mandalika/pos-backend/internal/custrules"
	"github.com/mandalika/pos-backend/internal/httpx"
	"github.com/mandalika/pos-backend/internal/read"
	"github.com/mandalika/pos-backend/internal/write"
)

// validCustomerInput applies the shared phone/email rules (custrules, twin of the backoffice
// form) and answers 400 with the Indonesian message when a field fails.
func validCustomerInput(w http.ResponseWriter, r *http.Request, c write.Customer) bool {
	if err := custrules.CheckPhone(c.Phone); err != nil {
		httpx.Err(w, http.StatusBadRequest, safeDomainText(r, http.StatusBadRequest, err))
		return false
	}
	if err := custrules.CheckEmail(c.Email); err != nil {
		httpx.Err(w, http.StatusBadRequest, safeDomainText(r, http.StatusBadRequest, err))
		return false
	}
	return true
}

// validCustomerUpdate is validCustomerInput for an edit, except that a phone or email left exactly
// as stored is not re-judged: rows from a CSV import or an older bundle may predate the rule, and a
// notes-only or birthday edit must still save.
func (h *Handlers) validCustomerUpdate(w http.ResponseWriter, r *http.Request, id string, c write.Customer) bool {
	if custrules.CheckPhone(c.Phone) == nil && custrules.CheckEmail(c.Email) == nil {
		return true
	}
	cur, err := h.Repo.Customer(r.Context(), id)
	if err != nil {
		return validCustomerInput(w, r, c) // cannot compare: apply the rule as is
	}
	if strings.TrimSpace(c.Phone) == strings.TrimSpace(cur.Phone) {
		c.Phone = "0812-0000-0000" // unchanged: exempt from the check below
	}
	if stored, err := cur.Email.Get(); err == nil && strings.TrimSpace(c.Email) == strings.TrimSpace(stored) {
		c.Email = ""
	}
	return validCustomerInput(w, r, c)
}

func (h *Handlers) CreateCustomer(w http.ResponseWriter, r *http.Request) {
	c, ok := decodeWrite[write.Customer](w, r)
	if !ok {
		return
	}
	if !validCustomerInput(w, r, c) {
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
	if !h.validCustomerUpdate(w, r, chi.URLParam(r, "id"), c) {
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
		writeErr(w, r, 500, err)
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
		writeErr(w, r, 500, err)
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
		writeErr(w, r, 500, err)
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
		writeErr(w, r, 500, err)
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
	id := chi.URLParam(r, "id")
	var bal int
	h.keyedMutated(w, r, keyedWrite{
		OpType:  "bo.points.adjust",
		Payload: map[string]any{"customerId": id, "points": in.Points, "reason": in.Reason},
		Unkeyed: func() (err error) {
			bal, err = h.Write.AdjustPoints(r.Context(), id, in.Points, in.Reason, c.userID, c.name)
			return err
		},
		Effect: func(ctx context.Context, tx pgx.Tx) (err error) {
			bal, err = h.Write.AdjustPointsTx(ctx, tx, id, in.Points, in.Reason, c.userID, c.name)
			return err
		},
		Outcome: func(context.Context, read.RowQuerier) (json.RawMessage, error) {
			return json.Marshal(api.AdjustPointsResponse{Data: struct {
				BalanceAfter int `json:"balanceAfter"`
			}{BalanceAfter: bal}})
		},
		OnErr: func(w http.ResponseWriter, err error) bool {
			switch {
			case errors.Is(err, write.ErrNotFound):
				httpx.Err(w, http.StatusNotFound, "pelanggan tidak ditemukan")
			case errors.Is(err, write.ErrZeroDelta) || errors.Is(err, write.ErrInsufficientPoints) || errors.Is(err, write.ErrReasonRequired):
				httpx.Err(w, http.StatusBadRequest, safeDomainText(r, http.StatusBadRequest, err))
			case errors.Is(err, write.ErrBusy) || isKeyConflict(err):
				return false // 409 via the shared mapping
			default:
				writeErr(w, r, http.StatusInternalServerError, err)
			}
			return true
		},
	})
}

func (h *Handlers) RewardGrants(w http.ResponseWriter, r *http.Request) {
	rows, err := h.Repo.RewardGrants(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, r, 500, err)
		return
	}
	writeJSON(w, http.StatusOK, api.RewardGrantListResponse{Data: rows})
}
