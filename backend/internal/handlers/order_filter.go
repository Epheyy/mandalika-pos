package handlers

import (
	"net/http"
	"time"

	"github.com/mandalika/pos-backend/internal/httpx"
	"github.com/mandalika/pos-backend/internal/read"
)

func validOrderStatus(s string) bool {
	return s == "" || s == "completed" || s == "refunded" || s == "cancelled"
}

// wibDayRange validates the WIB day pair shared by /orders, /shifts and the summary.
// It writes the 400 itself and reports whether the request may continue.
func wibDayRange(w http.ResponseWriter, from, to string) bool {
	if !validWIBDay(from) || !validWIBDay(to) {
		httpx.Err(w, http.StatusBadRequest, "tanggal tidak valid (YYYY-MM-DD)")
		return false
	}
	return true
}

// ordersFilter builds the shared OrderFilter for GET /orders. Legacy from/to are
// passed through untouched (POS contract); the outlet comes from scope(r) only.
func ordersFilter(w http.ResponseWriter, r *http.Request) (read.OrderFilter, bool) {
	q := r.URL.Query()
	if !wibDayRange(w, q.Get("dateFrom"), q.Get("dateTo")) {
		return read.OrderFilter{}, false
	}
	if !validOrderStatus(q.Get("status")) {
		httpx.Err(w, http.StatusBadRequest, "status tidak valid")
		return read.OrderFilter{}, false
	}
	return read.OrderFilter{
		Scope:         scope(r),
		ShiftID:       q.Get("shiftId"),
		CustomerID:    q.Get("customerId"),
		LegacyFrom:    q.Get("from"),
		LegacyTo:      q.Get("to"),
		DateFrom:      q.Get("dateFrom"),
		DateTo:        q.Get("dateTo"),
		Status:        q.Get("status"),
		PaymentMethod: q.Get("paymentMethod"),
		Q:             q.Get("q"),
	}, true
}

// summaryFilter builds the OrderFilter for GET /reports/summary. Legacy from/to are
// RFC3339 instants [from,to) and now 400 when unparseable (they used to fall back
// silently to the last 30 days). With no date parameter the range is unbounded.
func summaryFilter(w http.ResponseWriter, r *http.Request) (read.OrderFilter, bool) {
	q := r.URL.Query()
	if !wibDayRange(w, q.Get("dateFrom"), q.Get("dateTo")) {
		return read.OrderFilter{}, false
	}
	if !validOrderStatus(q.Get("status")) {
		httpx.Err(w, http.StatusBadRequest, "status tidak valid")
		return read.OrderFilter{}, false
	}
	f := read.OrderFilter{
		Scope:         scope(r),
		DateFrom:      q.Get("dateFrom"),
		DateTo:        q.Get("dateTo"),
		Status:        q.Get("status"),
		PaymentMethod: q.Get("paymentMethod"),
		Q:             q.Get("q"),
	}
	for param, dst := range map[string]**time.Time{"from": &f.FromInstant, "to": &f.ToInstant} {
		v := q.Get(param)
		if v == "" {
			continue
		}
		t, err := time.Parse(time.RFC3339, v)
		if err != nil {
			httpx.Err(w, http.StatusBadRequest, "parameter "+param+" tidak valid (RFC3339)")
			return read.OrderFilter{}, false
		}
		*dst = &t
	}
	return f, true
}
