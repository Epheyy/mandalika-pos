package handlers

import (
	"net/http"
	"strconv"

	"github.com/mandalika/pos-backend/internal/api"
	"github.com/mandalika/pos-backend/internal/httpx"
	"github.com/mandalika/pos-backend/internal/read"
)

// maxTzOffsetMin bounds the viewer's UTC offset (minutes): UTC-14:00 .. UTC+14:00 covers every zone.
const maxTzOffsetMin = 14 * 60

// dashboardFilter validates GET /reports/dashboard. The outlet comes from scope(r) only.
func dashboardFilter(w http.ResponseWriter, r *http.Request) (read.DashboardFilter, bool) {
	q := r.URL.Query()
	bad := func(msg string) (read.DashboardFilter, bool) {
		httpx.Err(w, http.StatusBadRequest, msg)
		return read.DashboardFilter{}, false
	}
	from, to, pFrom, pTo := q.Get("dateFrom"), q.Get("dateTo"), q.Get("prevDateFrom"), q.Get("prevDateTo")
	if !dayRange(w, from, to) || !dayRange(w, pFrom, pTo) {
		return read.DashboardFilter{}, false
	}
	// Day strings are fixed-width YYYY-MM-DD, so string order is calendar order.
	if from != "" && to != "" && from > to {
		return bad("dateFrom setelah dateTo")
	}
	if (pFrom == "") != (pTo == "") {
		return bad("prevDateFrom dan prevDateTo harus dikirim bersamaan")
	}
	if pFrom != "" && (from == "" || pFrom > pTo || pTo >= from) {
		return bad("jendela sebelumnya harus berakhir sebelum dateFrom")
	}
	trend := q.Get("trend")
	if trend != read.DashboardTrendHour && trend != read.DashboardTrendDay && trend != read.DashboardTrendMonth {
		return bad("parameter trend tidak valid")
	}
	offset := 0
	if v := q.Get("tzOffset"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < -maxTzOffsetMin || n > maxTzOffsetMin {
			return bad("parameter tzOffset tidak valid")
		}
		offset = n
	}
	return read.DashboardFilter{
		Scope: scope(r), From: from, To: to, PrevFrom: pFrom, PrevTo: pTo, Trend: trend, TzOffsetMin: offset,
	}, true
}

// DashboardAggregate serves the Ringkasan numbers. Like /orders it is open to any authenticated user
// (clamped to their outlet by scope(r)); it exposes strictly less than the order list.
func (h *Handlers) DashboardAggregate(w http.ResponseWriter, r *http.Request) {
	f, ok := dashboardFilter(w, r)
	if !ok {
		return
	}
	h.cached(w, r, ckey(r), func() (any, int, error) {
		v, err := h.Repo.DashboardAggregate(r.Context(), f)
		if err != nil {
			return nil, 500, err
		}
		return api.DashboardAggregateResponse{Data: v}, 200, nil
	})
}
