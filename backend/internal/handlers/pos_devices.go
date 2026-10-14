package handlers

import (
	"log/slog"
	"net/http"

	"github.com/google/uuid"
	"github.com/mandalika/pos-backend/internal/apperr"
	"github.com/mandalika/pos-backend/internal/httpx"
)

// RegisterPOSDevice: POST /pos/devices/register {deviceId} -> {data:{code}}. The code is the
// install's receipt-number tag at the caller's outlet; idempotent per (device, outlet).
func (h *Handlers) RegisterPOSDevice(w http.ResponseWriter, r *http.Request) {
	var body struct {
		DeviceID string `json:"deviceId"`
	}
	if err := httpx.DecodeLoose(r, &body); err != nil {
		httpx.Err(w, http.StatusBadRequest, "invalid body")
		return
	}
	id, err := uuid.Parse(body.DeviceID)
	if err != nil {
		httpx.Err(w, http.StatusBadRequest, "deviceId harus UUID")
		return
	}
	c, _ := h.caller(r)
	if c.outletID == "" {
		httpx.Err(w, http.StatusForbidden, "outlet terminal tidak diketahui")
		return
	}
	if _, err := uuid.Parse(c.outletID); err != nil {
		httpx.Err(w, http.StatusBadRequest, "outlet tidak valid")
		return
	}
	code, err := h.Write.RegisterPOSDevice(r.Context(), id.String(), c.outletID, c.userID)
	if err != nil {
		kind, _ := apperr.CodeOf(err)
		switch kind {
		case apperr.NotFound:
			httpx.Err(w, http.StatusNotFound, err.Error())
		case apperr.Busy:
			httpx.Err(w, http.StatusConflict, err.Error())
		default:
			slog.Error("pos device register failed", "outletId", c.outletID, "err", err)
			httpx.Err(w, http.StatusInternalServerError, "gagal mendaftarkan perangkat")
		}
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"code": code})
}
