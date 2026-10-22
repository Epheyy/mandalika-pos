package handlers

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/mandalika/pos-backend/internal/integration/erp"
)

type fakeErpRunner struct {
	gotMode erp.Mode
	report  erp.CatalogReport
	err     error
}

func (f *fakeErpRunner) Run(_ context.Context, m erp.Mode) (erp.CatalogReport, error) {
	f.gotMode = m
	return f.report, f.err
}

func TestErpCatalogPullHandlers(t *testing.T) {
	tests := []struct {
		name       string
		admin      bool
		runner     *fakeErpRunner // nil = integration disabled
		query      string
		wantStatus int
		wantMode   erp.Mode
		wantBody   string
	}{
		{"disabled", false, nil, "", 503, "", "ERP integration disabled"},
		{"scheduler default incremental", false, &fakeErpRunner{report: erp.CatalogReport{Status: erp.StatusCompleted}}, "", 200, erp.ModeIncremental, `"status":"completed"`},
		{"admin default full", true, &fakeErpRunner{report: erp.CatalogReport{Status: erp.StatusCompleted}}, "", 200, erp.ModeFull, `"status":"completed"`},
		{"explicit auto", false, &fakeErpRunner{report: erp.CatalogReport{Status: erp.StatusCompleted}}, "?mode=auto", 200, erp.ModeAuto, `"resources":[]`},
		{"unknown mode", true, &fakeErpRunner{}, "?mode=nope", 400, "", "mode must be"},
		{"failed run is still 200", false, &fakeErpRunner{report: erp.CatalogReport{Status: erp.StatusFailed, Resources: []erp.ResourceResult{{Resource: "outlets", Status: erp.StatusFailed, Error: "boom"}}}}, "", 200, erp.ModeIncremental, `"error":"boom"`},
		{"skipped_locked is 200", false, &fakeErpRunner{report: erp.CatalogReport{Status: erp.StatusSkippedLocked}}, "", 200, erp.ModeIncremental, `"skipped_locked"`},
		{"run error is 500", false, &fakeErpRunner{err: errors.New("lock acquisition secret-detail")}, "", 500, erp.ModeIncremental, "erp catalog pull failed"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			h := &Handlers{}
			if tc.runner != nil {
				h.SetErpCatalogRunner(tc.runner)
			}
			fn := h.ErpCatalogPullScheduler
			if tc.admin {
				fn = h.ErpCatalogPullAdmin
			}
			rec := httptest.NewRecorder()
			fn(rec, httptest.NewRequest(http.MethodPost, "/x"+tc.query, nil))
			if rec.Code != tc.wantStatus {
				t.Fatalf("status = %d, want %d (%s)", rec.Code, tc.wantStatus, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), tc.wantBody) {
				t.Fatalf("body %q lacks %q", rec.Body.String(), tc.wantBody)
			}
			if strings.Contains(rec.Body.String(), "secret-detail") {
				t.Fatalf("internal error text leaked: %s", rec.Body.String())
			}
			if tc.runner != nil && tc.wantMode != "" && tc.runner.gotMode != tc.wantMode {
				t.Fatalf("mode = %q, want %q", tc.runner.gotMode, tc.wantMode)
			}
		})
	}
}
