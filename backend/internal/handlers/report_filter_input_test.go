package handlers

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// Input validation happens before any repository access, so a Handlers value with
// no database must answer 400 for every malformed filter (A26).
func TestReportFilterInputRejected(t *testing.T) {
	h := New(nil, nil, nil, nil, nil, nil, nil)
	cases := []struct {
		name    string
		handler http.HandlerFunc
		query   string
	}{
		{"summary bad dateFrom", h.ReportSummary, "dateFrom=2026-13-45"},
		{"summary bad dateTo", h.ReportSummary, "dateTo=yesterday"},
		{"summary bad legacy from", h.ReportSummary, "from=garbage"},
		{"summary bad legacy to", h.ReportSummary, "to=2026-01-02"},
		{"summary bad status", h.ReportSummary, "status=bogus"},
		{"orders bad dateFrom", h.Orders, "dateFrom=2026-02-30"},
		{"orders bad dateTo", h.Orders, "dateTo=x"},
		{"orders bad status", h.Orders, "status=bogus"},
		{"shifts bad dateFrom", h.Shifts, "dateFrom=nope"},
		{"shifts bad dateTo", h.Shifts, "dateTo=2026-1-1x"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/x?"+c.query, nil)
			w := httptest.NewRecorder()
			c.handler.ServeHTTP(w, req)
			if w.Code != http.StatusBadRequest {
				t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
			}
		})
	}
}
