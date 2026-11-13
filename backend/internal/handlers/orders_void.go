package handlers

import (
	"errors"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/httpx"
	"github.com/mandalika/pos-backend/internal/read"
	"github.com/mandalika/pos-backend/internal/service"
	"github.com/mandalika/pos-backend/internal/write"
)

// directVoidDevice is the device_id of a Backoffice void's replay key: "backoffice:<user>". The
// client uuid is required for a void, so there is always a key (unlike a direct refund).
func directVoidDevice(userID string) string { return "backoffice:" + userID }

// voidOutlet resolves the outlet a void applies at: the caller's, or for an admin on "Semua outlet"
// the order's own outlet (no new authority). Any other caller without an outlet is refused.
func (h *Handlers) voidOutlet(w http.ResponseWriter, r *http.Request, c callerID, orderID string, fail func(error)) (string, bool) {
	if c.outletID != "" {
		return c.outletID, true
	}
	if c.role != "admin" {
		httpx.Err(w, http.StatusForbidden, "Outlet aktif belum dipilih untuk akun ini.")
		return "", false
	}
	o, err := h.OrderSvc.OrderOutlet(r.Context(), orderID)
	if err != nil {
		fail(service.ErrVoidNotFound)
		return "", false
	}
	return o, true
}

// VoidOrder is the Backoffice void (route-gated on void_any). Phase 1 accepts mode "none" only.
func (h *Handlers) VoidOrder(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ReasonCode     string            `json:"reasonCode"`
		Note           string            `json:"note"`
		ClientVoidUUID string            `json:"clientVoidUuid"`
		Mode           string            `json:"mode"`
		StockChoices   map[string]string `json:"stockChoices"`
	}
	if err := httpx.DecodeLoose(r, &body); err != nil {
		if isBodyTooLarge(err) {
			writeDecodeErr(w, err)
			return
		}
		httpx.Err(w, http.StatusBadRequest, "Isi permintaan pembatalan tidak valid.")
		return
	}
	if !service.IsCanonicalUUID(body.ClientVoidUUID) {
		httpx.Err(w, http.StatusBadRequest, "clientVoidUuid tidak valid.")
		return
	}
	id := chi.URLParam(r, "id")
	fail := func(err error) {
		status, msg := refundHTTPError(err)
		if status >= http.StatusInternalServerError {
			slog.Error("void failed", "orderId", id, "err", err)
		}
		httpx.Err(w, status, msg)
	}
	c, _ := h.caller(r)
	outlet, ok := h.voidOutlet(w, r, c, id, fail)
	if !ok {
		return
	}
	in := service.VoidInput{
		OutletID: outlet, OrderID: id,
		Reason: service.VoidReasonCode(body.ReasonCode), Note: body.Note,
		Mode: service.VoidMode(body.Mode), Source: service.VoidSourceBackoffice,
		UserID: c.userID, UserName: c.name,
		DeviceID: directVoidDevice(c.userID), ClientVoidUUID: body.ClientVoidUUID,
		CanVoidOwnShift: auth.HasPermission(r.Context(), "void_own_shift"),
		CanVoidAny:      auth.HasPermission(r.Context(), "void_any"),
		Channel:         "direct",
	}
	if len(body.StockChoices) > 0 {
		in.StockChoices = make(map[string]service.VoidStockChoice, len(body.StockChoices))
		for k, v := range body.StockChoices {
			in.StockChoices[k] = service.VoidStockChoice(v)
		}
	}
	if in.Mode != service.VoidModeNone {
		fail(service.ErrVoidReplacementInvalid) // replacements arrive in Void phase 2
		return
	}
	if err := write.RetryBusy(r.Context(), func() error {
		_, err := h.OrderSvc.VoidOrder(r.Context(), in)
		return err
	}); err != nil {
		fail(err)
		return
	}
	h.invalidate(r)
	o, err := h.Repo.Order(r.Context(), read.Scope{OutletID: outlet}, id)
	if err != nil {
		slog.Error("void committed but the read-back failed", "orderId", id, "outletId", outlet, "err", err)
		httpx.Err(w, http.StatusInternalServerError, "Pembatalan tersimpan, tetapi data transaksi belum dapat dimuat. Segarkan halaman dan jangan batalkan ulang.")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": o})
}

// VoidPreview is the read-only "what would this void do" (void_any or void_own_shift).
func (h *Handlers) VoidPreview(w http.ResponseWriter, r *http.Request) {
	canOwn := auth.HasPermission(r.Context(), "void_own_shift")
	canAny := auth.HasPermission(r.Context(), "void_any")
	if !canOwn && !canAny {
		httpx.Err(w, http.StatusForbidden, service.ErrVoidForbidden.Error())
		return
	}
	id := chi.URLParam(r, "id")
	fail := func(err error) {
		if errors.Is(err, service.ErrVoidNotFound) {
			httpx.Err(w, http.StatusNotFound, err.Error())
			return
		}
		status, msg := refundHTTPError(err)
		if status >= http.StatusInternalServerError {
			slog.Error("void preview failed", "orderId", id, "err", err)
		}
		httpx.Err(w, status, msg)
	}
	c, _ := h.caller(r)
	outlet, ok := h.voidOutlet(w, r, c, id, fail)
	if !ok {
		return
	}
	p, err := h.OrderSvc.VoidPreview(r.Context(), outlet, id, service.VoidInput{
		UserID: c.userID, CanVoidOwnShift: canOwn, CanVoidAny: canAny,
	})
	if err != nil {
		fail(err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": p})
}
