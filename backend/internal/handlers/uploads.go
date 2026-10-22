package handlers

import (
	"net/http"

	"github.com/mandalika/pos-backend/internal/httpx"
)

func (h *Handlers) SignUpload(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Folder string `json:"folder"`
	}
	_ = httpx.DecodeLoose(r, &body)
	sig, err := h.Signer.Sign(body.Folder)
	if err != nil {
		writeErr(w, r, http.StatusServiceUnavailable, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": sig})
}
