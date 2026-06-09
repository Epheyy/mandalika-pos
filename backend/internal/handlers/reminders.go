package handlers

import (
	"errors"
	"net/http"
	"time"

	"github.com/mandalika/pos-backend/internal/api"
)

var errReminderType = errors.New("type harus birthday, anniversary, atau all")

// Reminders lists customers with a birthday/anniversary in the next window days.
func (h *Handlers) Reminders(w http.ResponseWriter, r *http.Request) {
	p, l := pageLimit(r)
	window := 7
	switch r.URL.Query().Get("window") {
	case "", "7":
		window = 7
	case "30":
		window = 30
	default:
		writeErr(w, http.StatusBadRequest, errors.New("window harus 7 atau 30"))
		return
	}
	typ := r.URL.Query().Get("type")
	switch typ {
	case "", "all":
		typ = "all"
	case "birthday", "anniversary":
		// ok
	default:
		writeErr(w, http.StatusBadRequest, errReminderType)
		return
	}
	rows, total, err := h.Repo.Reminders(r.Context(), time.Now(), window, typ, p, l)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, api.ReminderListResponse{Data: rows, Meta: *meta(total, p, l)})
}
