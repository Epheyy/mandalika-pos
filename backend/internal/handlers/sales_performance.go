package handlers

import (
	"net/http"
	"strings"

	"github.com/mandalika/pos-backend/internal/api"
	"github.com/mandalika/pos-backend/internal/httpx"
	"github.com/mandalika/pos-backend/internal/read"
	"github.com/mandalika/pos-backend/internal/service"
)

// salesReportFilter reads the required business-day range and the outlet scope shared by both
// sales-performance reports. It writes the 400 itself.
func salesReportFilter(w http.ResponseWriter, r *http.Request) (read.OrderFilter, bool) {
	q := r.URL.Query()
	from, to := q.Get("dateFrom"), q.Get("dateTo")
	if from == "" || to == "" {
		httpx.Err(w, http.StatusBadRequest, "dateFrom dan dateTo wajib diisi (YYYY-MM-DD)")
		return read.OrderFilter{}, false
	}
	if !dayRange(w, from, to) {
		return read.OrderFilter{}, false
	}
	return read.OrderFilter{Scope: scope(r), DateFrom: from, DateTo: to}, true
}

// SalesPerformance is GET /reports/sales-performance. Not cached: ratings arrive live.
func (h *Handlers) SalesPerformance(w http.ResponseWriter, r *http.Request) {
	f, ok := salesReportFilter(w, r)
	if !ok {
		return
	}
	rep, err := h.Repo.SalesPerformance(r.Context(), f)
	if err != nil {
		writeErr(w, r, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, rep)
}

// SalesRatings is GET /reports/sales-ratings: the individual ratings behind a salesperson row.
func (h *Handlers) SalesRatings(w http.ResponseWriter, r *http.Request) {
	f, ok := salesReportFilter(w, r)
	if !ok {
		return
	}
	q := r.URL.Query()
	salesman := strings.ToLower(strings.TrimSpace(q.Get("salesmanId")))
	if salesman != "" && salesman != "none" && !service.IsCanonicalUUID(salesman) {
		httpx.Err(w, http.StatusBadRequest, "Filter tidak valid.")
		return
	}
	flagged := strings.EqualFold(q.Get("flaggedOnly"), "true")
	p, l := pageLimit(r)
	rows, total, err := h.Repo.SalesRatings(r.Context(), f, salesman, flagged, p, l)
	if err != nil {
		writeErr(w, r, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, api.SalesRatingList{Data: rows, Meta: *meta(total, p, l)})
}
