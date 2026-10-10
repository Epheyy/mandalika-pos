package handlers

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/oapi-codegen/nullable"

	"github.com/mandalika/pos-backend/internal/api"
	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/httpx"
)

func nullableShift(s api.Shift) nullable.Nullable[api.Shift] {
	return nullable.NewNullableWithValue(s)
}

func nullableShiftNull() nullable.Nullable[api.Shift] {
	return nullable.NewNullNullable[api.Shift]()
}

func (h *Handlers) ListUsers(w http.ResponseWriter, r *http.Request) {
	h.cached(w, r, ckey(r), func() (any, int, error) {
		p, l := pageLimit(r)
		rows, total, err := h.Repo.Users(r.Context(), p, l)
		if err != nil {
			return nil, 500, err
		}
		return api.UserListResponse{Data: rows, Meta: meta(total, p, l)}, 200, nil
	})
}

func (h *Handlers) GetUser(w http.ResponseWriter, r *http.Request) {
	v, err := h.Repo.User(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, http.StatusOK, api.UserResponse{Data: v})
}

// CreateUser handles both POST /users and POST /auth/register (admin-only).
func (h *Handlers) CreateUser(w http.ResponseWriter, r *http.Request) {
	var req api.CreateUserRequest
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Err(w, http.StatusBadRequest, "invalid body")
		return
	}
	outlet := ""
	if v, err := req.OutletId.Get(); err == nil {
		outlet = v.String()
	}
	perms := []string{}
	if req.Permissions != nil {
		perms = *req.Permissions
	}
	id, err := h.Store.CreateUser(r.Context(), string(req.Email), req.Password,
		req.DisplayName, string(req.Role), outlet, perms)
	if err != nil {
		httpx.Err(w, http.StatusBadRequest, "create failed: "+err.Error())
		return
	}
	u, err := h.Repo.User(r.Context(), id)
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, http.StatusCreated, api.UserResponse{Data: u})
}

func (h *Handlers) UpdateUser(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var req api.UpdateUserRequest
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Err(w, http.StatusBadRequest, "invalid body")
		return
	}
	var role *string
	if req.Role != nil {
		s := string(*req.Role)
		role = &s
	}
	var outlet *string
	if req.OutletId.IsSpecified() {
		if v, err := req.OutletId.Get(); err == nil {
			s := v.String()
			outlet = &s
		} else {
			empty := ""
			outlet = &empty
		}
	}
	var photo *string
	if req.PhotoURL.IsSpecified() {
		if v, err := req.PhotoURL.Get(); err == nil {
			photo = &v
		}
	}
	if err := h.Store.UpdateUser(r.Context(), id, req.DisplayName, role, outlet,
		photo, req.Permissions); err != nil {
		if errors.Is(err, auth.ErrNotFound) {
			httpx.Err(w, http.StatusNotFound, "not found")
			return
		}
		httpx.Err(w, http.StatusBadRequest, "update failed: "+err.Error())
		return
	}
	u, err := h.Repo.User(r.Context(), id)
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, http.StatusOK, api.UserResponse{Data: u})
}

func (h *Handlers) DeleteUser(w http.ResponseWriter, r *http.Request) {
	err := h.Store.DeleteUser(r.Context(), chi.URLParam(r, "id"))
	if errors.Is(err, auth.ErrNotFound) {
		httpx.Err(w, http.StatusNotFound, "not found")
		return
	}
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handlers) SetUserReceivePin(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Pin   *string `json:"pin"`
		Clear *bool   `json:"clear"`
	}
	if err := httpx.DecodeLoose(r, &body); err != nil {
		httpx.Err(w, http.StatusBadRequest, "invalid body")
		return
	}
	id := chi.URLParam(r, "id")
	pin := ""
	if body.Pin != nil && (body.Clear == nil || !*body.Clear) {
		pin = *body.Pin
	}
	if pin != "" && (len(pin) < 4 || len(pin) > 8) {
		httpx.Err(w, http.StatusBadRequest, "PIN harus 4-8 digit")
		return
	}
	h.mutated(w, r, h.Store.SetReceivePin(r.Context(), id, pin))
}
