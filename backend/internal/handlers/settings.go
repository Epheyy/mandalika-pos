package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/mandalika/pos-backend/internal/httpx"
)

func (h *Handlers) UpdateAppSettings(w http.ResponseWriter, r *http.Request) {
	var raw json.RawMessage
	if err := httpx.DecodeLoose(r, &raw); err != nil {
		httpx.Err(w, http.StatusBadRequest, "invalid body")
		return
	}
	h.mutated(w, r, h.Write.UpdateAppSettings(r.Context(), raw))
}

func (h *Handlers) UpdateLoyaltySettings(w http.ResponseWriter, r *http.Request) {
	var raw json.RawMessage
	if err := httpx.DecodeLoose(r, &raw); err != nil {
		httpx.Err(w, http.StatusBadRequest, "invalid body")
		return
	}
	h.mutated(w, r, h.Write.UpdateLoyaltySettings(r.Context(), raw))
}
