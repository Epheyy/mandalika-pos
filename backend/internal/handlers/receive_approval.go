package handlers

import (
	"errors"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/mandalika/pos-backend/internal/api"
	"github.com/mandalika/pos-backend/internal/apperr"
	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/httpx"
	"github.com/mandalika/pos-backend/internal/write"
)

// A08: online step-up approval for POS transfer receive.

const (
	maxApprovalItems = 500
	maxReceiptKeyLen = 200
	maxDeviceIDLen   = 100
)

// ListReceiveApprovers returns who may approve a receive at the caller's outlet.
// No PIN hash: the PIN is only ever verified on the server.
func (h *Handlers) ListReceiveApprovers(w http.ResponseWriter, r *http.Request) {
	c, _ := h.caller(r)
	if c.outletID == "" {
		writeJSON(w, http.StatusOK, api.ReceiveApproverListResponse{Data: []api.ReceiveApprover{}})
		return
	}
	rows, err := h.Repo.ReceiveApprovingUsers(r.Context(), c.outletID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	if rows == nil {
		rows = []api.ReceiveApprover{}
	}
	writeJSON(w, http.StatusOK, api.ReceiveApproverListResponse{Data: rows})
}

// CreateTransferReceiveApproval verifies an approver PIN on the server and mints a
// single-use grant for one receipt. The PIN is never stored or logged.
func (h *Handlers) CreateTransferReceiveApproval(w http.ResponseWriter, r *http.Request) {
	c, _ := h.caller(r)
	if c.outletID == "" || c.userID == "" {
		httpx.Err(w, http.StatusForbidden, "tidak berwenang")
		return
	}
	var body api.TransferReceiveApprovalRequest
	if err := httpx.DecodeLoose(r, &body); err != nil {
		httpx.Err(w, http.StatusBadRequest, "invalid body")
		return
	}
	if len(body.IdempotencyKey) == 0 || len(body.IdempotencyKey) > maxReceiptKeyLen ||
		len(body.Items) > maxApprovalItems || !validReceivePin(body.Pin) {
		httpx.Err(w, http.StatusBadRequest, "invalid body")
		return
	}
	in := write.MintInput{
		OutletID: c.outletID, RequesterID: c.userID,
		TransferID: body.TransferId.String(), ReceiptKey: body.IdempotencyKey,
		ApproverID: body.ApproverUserId.String(), PIN: body.Pin,
	}
	if body.DeviceId != nil && len(*body.DeviceId) <= maxDeviceIDLen {
		in.DeviceID = *body.DeviceId
	}
	if body.DiscrepancyReason != nil {
		in.Reason = *body.DiscrepancyReason
	}
	for _, it := range body.Items {
		if it.ReceivedQty < 0 || it.ProductId == "" {
			httpx.Err(w, http.StatusBadRequest, "invalid body")
			return
		}
		in.Items = append(in.Items, write.TransferReceiveItem{
			ProductID: it.ProductId, VariantSize: it.VariantSize, ReceivedQty: it.ReceivedQty,
		})
	}
	res, err := h.Write.MintReceiveApproval(r.Context(), in)
	if err != nil {
		mintError(w, err)
		return
	}
	id, _ := parseUUID(res.GrantID)
	writeJSON(w, http.StatusCreated, api.TransferReceiveApprovalResponse{Data: api.TransferReceiveApproval{
		ApprovalGrantId: id, ExpiresAt: res.ExpiresAt,
		ApproverUserId: body.ApproverUserId, ApproverName: res.ApproverName,
	}})
}

// mintError maps a mint refusal to its HTTP shape. Unknown, ineligible, no-PIN and
// wrong-PIN approvers all return the identical 403 body.
func mintError(w http.ResponseWriter, err error) {
	var locked *write.LockedError
	if errors.As(err, &locked) {
		secs := int(locked.RetryAfter.Seconds())
		if secs < 1 && !locked.Hard {
			secs = 1
		}
		if !locked.Hard {
			w.Header().Set("Retry-After", strconv.Itoa(secs))
		}
		writeJSON(w, http.StatusTooManyRequests, map[string]any{"error": locked.Error(), "retryAfterSeconds": secs, "hardLocked": locked.Hard})
		return
	}
	if errors.Is(err, write.ErrNotFound) {
		httpx.Err(w, http.StatusNotFound, "transfer tidak ditemukan")
		return
	}
	code, _ := apperr.CodeOf(err)
	switch code {
	case apperr.Forbidden:
		httpx.Err(w, http.StatusForbidden, err.Error())
	case apperr.Conflict:
		httpx.Err(w, http.StatusConflict, err.Error())
	case apperr.Busy:
		w.Header().Set("Retry-After", "2")
		httpx.Err(w, http.StatusServiceUnavailable, err.Error())
	default:
		slog.Error("receive approval mint failed", "err", err)
		httpx.Err(w, http.StatusInternalServerError, "terjadi kesalahan, coba lagi")
	}
}

// ClearUserReceivePinLockout clears both receive-PIN lockouts of a user (admin unlock)
// without changing the PIN.
func (h *Handlers) ClearUserReceivePinLockout(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if _, ok := parseUUID(id); !ok {
		httpx.Err(w, http.StatusBadRequest, "invalid user id")
		return
	}
	err := h.Store.ClearReceiveLockouts(r.Context(), id)
	if errors.Is(err, auth.ErrNotFound) {
		httpx.Err(w, http.StatusNotFound, "not found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// parseUUID accepts only the canonical 36-char form (google/uuid also takes braces,
// urn: prefixes and bare hex, which Postgres would read differently).
func parseUUID(s string) (uuid.UUID, bool) {
	if len(s) != 36 {
		return uuid.UUID{}, false
	}
	id, err := uuid.Parse(s)
	return id, err == nil
}
