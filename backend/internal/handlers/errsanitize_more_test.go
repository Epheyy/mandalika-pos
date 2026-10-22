package handlers

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	chimw "github.com/go-chi/chi/v5/middleware"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/mandalika/pos-backend/internal/apperr"
	erp "github.com/mandalika/pos-backend/internal/integration/erp"
	"github.com/mandalika/pos-backend/internal/read"
	"github.com/mandalika/pos-backend/internal/service"
	syncpkg "github.com/mandalika/pos-backend/internal/sync"
	"github.com/mandalika/pos-backend/internal/write"
)

func captureLog(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	old := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))
	t.Cleanup(func() { slog.SetDefault(old) })
	return &buf
}

func TestSanitisedBranchesLogRawErrorOnceWithRequestID(t *testing.T) {
	for _, code := range []string{"22P02", "23505", "40P01", "42P01"} {
		buf := captureLog(t)
		h := chimw.RequestID(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			writeErr(w, r, 400, &pgconn.PgError{Code: code, Message: pgMessage})
		}))
		h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/x", nil))
		out := buf.String()
		if strings.Count(out, "\n") != 1 || !strings.Contains(out, "request_id=") || !strings.Contains(out, code) {
			t.Fatalf("%s: want exactly one log line with request id and raw error, got %q", code, out)
		}
	}
}

func TestSafeDomainTextLogsRealStatus(t *testing.T) {
	buf := captureLog(t)
	r := httptest.NewRequest(http.MethodGet, "/x", nil)
	got := safeDomainText(r, http.StatusForbidden, &pgconn.PgError{Code: "23505", Message: pgMessage})
	assertNoLeak(t, got)
	if !strings.Contains(buf.String(), "status=403") {
		t.Fatalf("log %q lacks real status", buf.String())
	}
}

func TestMintErrorBusyWithInfraKeepsRetryAfterAndFitsText(t *testing.T) {
	buf := captureLog(t)
	w := httptest.NewRecorder()
	err := apperr.Wrap(apperr.Busy, &pgconn.PgError{Code: "40P01", Message: pgMessage})
	mintError(w, httptest.NewRequest(http.MethodPost, "/x", nil), err)
	if w.Code != 503 || w.Header().Get("Retry-After") != "2" || !strings.Contains(w.Body.String(), "temporarily unavailable, retry") {
		t.Fatalf("%d %v %s", w.Code, w.Header(), w.Body.String())
	}
	assertNoLeak(t, w.Body.String())
	w = httptest.NewRecorder()
	buf.Reset()
	mintError(w, httptest.NewRequest(http.MethodPost, "/x", nil), errors.New("boom"))
	if w.Code != 500 || strings.Count(buf.String(), "\n") != 1 {
		t.Fatalf("default branch %d, logs %q", w.Code, buf.String())
	}
}

func TestWriteUserErr(t *testing.T) {
	r := httptest.NewRequest(http.MethodPost, "/x", nil)
	w := httptest.NewRecorder()
	writeUserErr(w, r, "create failed: ", &pgconn.PgError{Code: "23505", Message: pgMessage, ConstraintName: "users_email_key"})
	if w.Code != 400 || strings.Contains(w.Body.String(), "users_email_key") {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
	assertNoLeak(t, w.Body.String())
	w = httptest.NewRecorder()
	writeUserErr(w, r, "create failed: ", errors.New("email tidak valid"))
	if w.Code != 400 || !strings.Contains(w.Body.String(), "create failed: email tidak valid") {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
}

// The POS engine retries on 5xx, parks items on 400 and suspends pull on 404/409, so a
// whole-request failure on a sync route must always be a 5xx.
func TestSyncFailuresAreAlwaysGeneric500(t *testing.T) {
	errs := []error{
		&pgconn.PgError{Code: "22P02", Message: pgMessage},
		&pgconn.PgError{Code: "23505", Message: pgMessage, ConstraintName: "customers_phone_key"},
		pgx.ErrNoRows, read.ErrNotFound, write.ErrBusy,
	}
	for _, e := range errs {
		w := httptest.NewRecorder()
		syncFail(w, httptest.NewRequest(http.MethodGet, "/x", nil), e)
		if w.Code != 500 || !strings.Contains(w.Body.String(), "internal error") {
			t.Fatalf("syncFail(%v): %d %s", e, w.Code, w.Body.String())
		}
		assertNoLeak(t, w.Body.String())
		w = httptest.NewRecorder()
		(&Handlers{}).syncBatch(w, httptest.NewRequest("POST", "/sync/batch", strings.NewReader(`{"items":[]}`)),
			func(*http.Request) (callerID, error) { return callerID{outletID: "o"}, nil },
			func(context.Context, syncpkg.Caller, []syncpkg.BatchItem) (syncpkg.BatchResult, error) {
				return syncpkg.BatchResult{}, e
			})
		if w.Code != 500 || !strings.Contains(w.Body.String(), "internal error") {
			t.Fatalf("syncBatch(%v): %d %s", e, w.Code, w.Body.String())
		}
	}
}

func TestMutatedTypedConflictsWithInfraInChain(t *testing.T) {
	pg := &pgconn.PgError{Code: "23505", Message: pgMessage, ConstraintName: "customers_phone_key"}
	cases := map[string]error{
		"erp owned":  fmt.Errorf("%w: %w", &write.ErpOwnedError{Msg: "field dimiliki ERP"}, pg),
		"stock":      fmt.Errorf("%w: %w", write.ErrVariantHasStock, pg),
		"key":        fmt.Errorf("%w: %w", service.ErrReceiptKeyConflict, pg),
		"erp plain":  &write.ErpOwnedError{Msg: "field dimiliki ERP"},
		"stock only": write.ErrVariantHasStock,
	}
	for name, err := range cases {
		w := httptest.NewRecorder()
		(&Handlers{}).mutated(w, httptest.NewRequest(http.MethodPost, "/x", nil), err)
		if w.Code != 409 {
			t.Fatalf("%s: status %d body %s", name, w.Code, w.Body.String())
		}
		assertNoLeak(t, w.Body.String())
	}
}

func TestErpErrorTextSanitised(t *testing.T) {
	dbText := "commit run: ERROR: relation x (SQLSTATE 42P01)"
	rep := newErpPullReport(erp.CatalogReport{Status: "failed", Resources: []erp.ResourceResult{
		{Resource: "fg", Error: dbText}, {Resource: "bom", Error: "ERP returned 503"}}})
	if rep.Resources[0].Error != erpDBErrorText || rep.Resources[1].Error != "ERP returned 503" {
		t.Fatalf("%+v", rep.Resources)
	}
	e1, e2 := dbText, "timeout talking to ERP"
	runs, marks := sanitizeErpRuns(
		[]read.ErpSyncRun{{ID: "1", Error: &e1}, {ID: "2", Error: &e2}, {ID: "3"}},
		[]read.ErpWatermark{{Resource: "fg", LastError: &e1}})
	if *runs[0].Error != erpDBErrorText || *runs[1].Error != e2 || runs[2].Error != nil || *marks[0].LastError != erpDBErrorText {
		t.Fatalf("%+v %+v", runs, marks)
	}
	if e1 != dbText {
		t.Fatal("input mutated")
	}
}
