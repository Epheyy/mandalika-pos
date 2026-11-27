package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/mandalika/pos-backend/internal/api"
	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/coverage"
	"github.com/mandalika/pos-backend/internal/httpx"
	"github.com/mandalika/pos-backend/internal/read"
	"github.com/mandalika/pos-backend/internal/write"
)

// salesStaffCaller is the authenticated caller as the Tim Sales rules see it.
func salesStaffCaller(r *http.Request) coverage.Caller {
	role, _ := r.Context().Value(auth.CtxRole).(string)
	return coverage.Caller{UserID: callerUserID(r), Admin: role == "admin", Cov: auth.CoverageFrom(r.Context())}
}

// salesStaffErrStatus maps a Tim Sales domain error to its HTTP status (0 = not a domain error).
func salesStaffErrStatus(err error) int {
	switch {
	case errors.Is(err, write.ErrSalesStaffInvalid):
		return http.StatusBadRequest
	case errors.Is(err, write.ErrSalesStaffForbidden):
		return http.StatusForbidden
	case errors.Is(err, write.ErrSalesStaffNotFound), errors.Is(err, read.ErrNotFound):
		return http.StatusNotFound
	case errors.Is(err, write.ErrSalesStaffDuplicateName), errors.Is(err, write.ErrSalesStaffUserTaken):
		return http.StatusConflict
	}
	return 0
}

// salesStaffOnErr answers Tim Sales domain errors for keyedMutated.
func salesStaffOnErr(r *http.Request) func(http.ResponseWriter, error) bool {
	return func(w http.ResponseWriter, err error) bool {
		st := salesStaffErrStatus(err)
		if st == 0 {
			return false
		}
		httpx.Err(w, st, safeDomainText(r, st, err))
		return true
	}
}

// salesStaffInput converts the request body; userId absent and null both mean unlinked.
func salesStaffInput(body api.SalesStaffInput) write.SalesStaffInput {
	in := write.SalesStaffInput{Name: body.Name, Active: body.Active, OutletIDs: make([]string, 0, len(body.OutletIds))}
	for _, o := range body.OutletIds {
		in.OutletIDs = append(in.OutletIDs, o.String())
	}
	if body.UserId.IsSpecified() && !body.UserId.IsNull() {
		if u, err := body.UserId.Get(); err == nil {
			s := u.String()
			in.UserID = &s
		}
	}
	return in
}

// ListSalesStaff answers the Tim Sales list as the caller may see it.
func (h *Handlers) ListSalesStaff(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	f := read.SalesStaffFilter{Q: strings.TrimSpace(q.Get("q"))}
	if o := q.Get("outletId"); o != "" {
		if _, err := uuid.Parse(o); err != nil {
			httpx.Err(w, http.StatusBadRequest, "outletId tidak valid")
			return
		}
		f.OutletID = o
	}
	switch q.Get("active") {
	case "":
	case "true":
		t := true
		f.Active = &t
	case "false":
		t := false
		f.Active = &t
	default:
		httpx.Err(w, http.StatusBadRequest, "active harus true atau false")
		return
	}
	list, err := h.Repo.SalesStaffList(r.Context(), salesStaffCaller(r), f)
	if err != nil {
		writeErr(w, r, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": list})
}

// ListSalesStaffLinkableUsers answers the unlinked users the caller may attach to a person.
func (h *Handlers) ListSalesStaffLinkableUsers(w http.ResponseWriter, r *http.Request) {
	users, err := h.Repo.LinkableUsers(r.Context(), salesStaffCaller(r))
	if err != nil {
		writeErr(w, r, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": users})
}

// CreateSalesStaff adds a person. Idempotency-Key is required (400 without it).
func (h *Handlers) CreateSalesStaff(w http.ResponseWriter, r *http.Request) {
	if strings.TrimSpace(r.Header.Get("Idempotency-Key")) == "" {
		httpx.Err(w, http.StatusBadRequest, "header Idempotency-Key wajib")
		return
	}
	var body api.SalesStaffInput
	if err := httpx.DecodeLoose(r, &body); err != nil {
		writeDecodeErr(w, err)
		return
	}
	in := salesStaffInput(body)
	caller := salesStaffCaller(r)
	var id string
	h.keyedMutated(w, r, keyedWrite{
		OpType:  "bo.sales_staff.create",
		Payload: in,
		Status:  http.StatusCreated,
		Unkeyed: func() error { return errors.New("idempotency key required") }, // unreachable: checked above
		Effect: func(ctx context.Context, tx pgx.Tx) (err error) {
			id, err = h.Write.CreateSalesStaffTx(ctx, tx, caller, in)
			return err
		},
		Outcome: func(ctx context.Context, q read.RowQuerier) (json.RawMessage, error) {
			return h.salesStaffOutcome(ctx, q, caller, id)
		},
		OnErr: salesStaffOnErr(r),
	})
}

// UpdateSalesStaff edits a person. Idempotency-Key is optional.
func (h *Handlers) UpdateSalesStaff(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if _, err := uuid.Parse(id); err != nil {
		httpx.Err(w, http.StatusBadRequest, "id tidak valid")
		return
	}
	var body api.SalesStaffInput
	if err := httpx.DecodeLoose(r, &body); err != nil {
		writeDecodeErr(w, err)
		return
	}
	in := salesStaffInput(body)
	caller := salesStaffCaller(r)
	h.keyedMutated(w, r, keyedWrite{
		OpType:  "bo.sales_staff.update",
		Payload: map[string]any{"id": id, "in": in},
		Unkeyed: func() error {
			return h.Write.WithTx(r.Context(), func(tx pgx.Tx) error {
				return h.Write.UpdateSalesStaffTx(r.Context(), tx, caller, id, in)
			})
		},
		Effect: func(ctx context.Context, tx pgx.Tx) error {
			return h.Write.UpdateSalesStaffTx(ctx, tx, caller, id, in)
		},
		Outcome: func(ctx context.Context, q read.RowQuerier) (json.RawMessage, error) {
			return h.salesStaffOutcome(ctx, q, caller, id)
		},
		OnErr: salesStaffOnErr(r),
	})
}

// salesStaffOutcome is the write response: the person as the caller sees them after the
// write (a reduced shape when the write took the last covered outlet away).
func (h *Handlers) salesStaffOutcome(ctx context.Context, q read.RowQuerier, c coverage.Caller, id string) (json.RawMessage, error) {
	s, err := h.Repo.SalesStaffAfterWrite(ctx, q, c, id)
	if err != nil {
		return nil, err
	}
	return json.Marshal(map[string]any{"data": s})
}
