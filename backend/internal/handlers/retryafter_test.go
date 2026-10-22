package handlers

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	chimw "github.com/go-chi/chi/v5/middleware"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/redis/go-redis/v9"

	"github.com/mandalika/pos-backend/internal/cache"
	mw "github.com/mandalika/pos-backend/internal/middleware"
	"github.com/mandalika/pos-backend/internal/write"
)

// expiredCtxRequest is a request whose server deadline has already fired.
func expiredCtxRequest(t *testing.T) *http.Request {
	t.Helper()
	ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	t.Cleanup(cancel)
	return httptest.NewRequest(http.MethodGet, "/x", nil).WithContext(ctx)
}

func TestWriteErrServerDeadlineAnswers503WithRetryAfter(t *testing.T) {
	captureLog(t)
	for name, err := range map[string]error{
		"bare deadline":    context.DeadlineExceeded,
		"wrapped deadline": fmt.Errorf("list products: %w", context.DeadlineExceeded),
		"pg timeout":       &pgconn.PgError{Code: "57014", Message: pgMessage},
	} {
		t.Run(name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			writeErr(rec, expiredCtxRequest(t), http.StatusInternalServerError, err)
			if rec.Code != http.StatusServiceUnavailable {
				t.Fatalf("status %d body %s", rec.Code, rec.Body)
			}
			if rec.Header().Get("Retry-After") != "2" {
				t.Fatalf("Retry-After %q", rec.Header().Get("Retry-After"))
			}
			if !strings.Contains(rec.Body.String(), msgRequestTimeout) {
				t.Fatalf("body %s", rec.Body)
			}
			assertNoLeak(t, rec.Body.String())
		})
	}
}

func TestWriteErrDeadlineErrorOnLiveRequestStaysGeneric500(t *testing.T) {
	captureLog(t)
	// A deadline error while the request context is alive is not the server deadline
	// (e.g. an inner timeout): no Retry-After, generic 500.
	rec := httptest.NewRecorder()
	writeErr(rec, httptest.NewRequest(http.MethodGet, "/x", nil), http.StatusInternalServerError, context.DeadlineExceeded)
	if rec.Code != http.StatusInternalServerError || rec.Header().Get("Retry-After") != "" {
		t.Fatalf("%d %v", rec.Code, rec.Header())
	}
}

func TestWriteErrClientCancelStaysGeneric500(t *testing.T) {
	captureLog(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	r := httptest.NewRequest(http.MethodGet, "/x", nil).WithContext(ctx)
	rec := httptest.NewRecorder()
	writeErr(rec, r, http.StatusInternalServerError, context.Canceled)
	if rec.Code != http.StatusInternalServerError || rec.Header().Get("Retry-After") != "" || !strings.Contains(rec.Body.String(), "internal error") {
		t.Fatalf("%d %v %s", rec.Code, rec.Header(), rec.Body)
	}
	// Even a deadline-flavoured error after the client cancelled is not the server deadline.
	rec = httptest.NewRecorder()
	writeErr(rec, r, http.StatusInternalServerError, context.DeadlineExceeded)
	if rec.Code != http.StatusInternalServerError || rec.Header().Get("Retry-After") != "" {
		t.Fatalf("cancelled ctx + deadline err: %d %v", rec.Code, rec.Header())
	}
}

func TestSyncFailStaysGeneric500EvenOnServerDeadline(t *testing.T) {
	captureLog(t)
	rec := httptest.NewRecorder()
	syncFail(rec, expiredCtxRequest(t), context.DeadlineExceeded)
	if rec.Code != http.StatusInternalServerError || rec.Header().Get("Retry-After") != "" {
		t.Fatalf("%d %v", rec.Code, rec.Header())
	}
}

func TestWriteErrDeadlineBodyCarriesRequestRefAndNoDriverText(t *testing.T) {
	captureLog(t)
	h := chimw.RequestID(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeErr(w, r.WithContext(expiredCtxRequest(t).Context()), 500, fmt.Errorf("x: %w", context.DeadlineExceeded))
	}))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/x", nil))
	if rec.Code != 503 || strings.Contains(rec.Body.String(), "deadline") {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
}

func TestMintErrorHardLockHasNoRetryAfter(t *testing.T) {
	rec := httptest.NewRecorder()
	mintError(rec, httptest.NewRequest(http.MethodPost, "/x", nil), &write.LockedError{Hard: true, RetryAfter: time.Hour})
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("status %d", rec.Code)
	}
	if _, present := rec.Header()["Retry-After"]; present {
		t.Fatalf("a hard lock has no countdown and must not send Retry-After: %v", rec.Header())
	}
}

func TestMintErrorSoftLockKeepsRetryAfter(t *testing.T) {
	rec := httptest.NewRecorder()
	mintError(rec, httptest.NewRequest(http.MethodPost, "/x", nil), &write.LockedError{RetryAfter: 90 * time.Second})
	if rec.Code != http.StatusTooManyRequests || rec.Header().Get("Retry-After") != "90" {
		t.Fatalf("%d %v", rec.Code, rec.Header())
	}
}

func TestImportSlotBusySendsRetryAfter(t *testing.T) {
	h := &Handlers{importSlots: make(chan struct{}, 1)}
	h.importSlots <- struct{}{} // the only slot is taken
	rec := httptest.NewRecorder()
	h.runImport(rec, httptest.NewRequest(http.MethodPost, "/api/v1/products/import", strings.NewReader("{}")), "products")
	if rec.Code != http.StatusTooManyRequests || rec.Header().Get("Retry-After") != "5" {
		t.Fatalf("%d Retry-After=%q", rec.Code, rec.Header().Get("Retry-After"))
	}
}

func TestImportErrBusySendsRetryAfter(t *testing.T) {
	rec := httptest.NewRecorder()
	if !answerImportBusy(rec, write.ErrBusy) {
		t.Fatal("ErrBusy must be answered")
	}
	if rec.Code != http.StatusServiceUnavailable || rec.Header().Get("Retry-After") != "2" {
		t.Fatalf("%d Retry-After=%q", rec.Code, rec.Header().Get("Retry-After"))
	}
	if answerImportBusy(httptest.NewRecorder(), errors.New("other")) {
		t.Fatal("only ErrBusy is answered here")
	}
}

// Through runImport: a runner answering ErrBusy must become 503 + Retry-After 2.
func TestRunImportErrBusyAnswers503WithRetryAfter(t *testing.T) {
	h := &Handlers{importSlots: make(chan struct{}, 1)}
	h.importRunner = func(context.Context, write.ImportRequest) (write.ImportResult, error) {
		return write.ImportResult{}, fmt.Errorf("import: %w", write.ErrBusy)
	}
	rec := httptest.NewRecorder()
	h.runImport(rec, httptest.NewRequest(http.MethodPost, "/api/v1/products/import", strings.NewReader(`{"csv":"a","dryRun":true}`)), "products")
	if rec.Code != http.StatusServiceUnavailable || rec.Header().Get("Retry-After") != "2" {
		t.Fatalf("%d Retry-After=%q body=%s", rec.Code, rec.Header().Get("Retry-After"), rec.Body)
	}
}

// End to end through the middleware: the deadline fires while the handler's work blocks.
func TestDeadlineMiddlewareThenWriteErrAnswers503(t *testing.T) {
	captureLog(t)
	h := mw.Deadline(func(*http.Request) time.Duration { return 20 * time.Millisecond })(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
		writeErr(w, r, http.StatusInternalServerError, fmt.Errorf("query: %w", r.Context().Err()))
	}))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/x", nil))
	if rec.Code != http.StatusServiceUnavailable || rec.Header().Get("Retry-After") != "2" || !strings.Contains(rec.Body.String(), msgRequestTimeout) {
		t.Fatalf("%d %v %s", rec.Code, rec.Header(), rec.Body)
	}
	assertNoLeak(t, rec.Body.String())
}

// After a deadline-cut request the read cache is still dropped.
func TestInvalidateSurvivesExpiredRequestContext(t *testing.T) {
	mr := miniredis.RunT(t)
	rc := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = rc.Close() })
	h := &Handlers{Cache: cache.NewFromClient(rc)}
	if err := rc.Set(context.Background(), "rd:products", "x", 0).Err(); err != nil {
		t.Fatal(err)
	}
	h.invalidate(expiredCtxRequest(t))
	if mr.Exists("rd:products") {
		t.Fatal("rd: keys must be dropped even when the request deadline already fired")
	}
}
