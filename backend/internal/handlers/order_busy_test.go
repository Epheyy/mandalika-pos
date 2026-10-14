package handlers

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/mandalika/pos-backend/internal/service"
	"github.com/mandalika/pos-backend/internal/write"
)

// An unclassified error (e.g. a database error) answers a sanitized 500 that never
// carries its text; a classified (apperr) refusal keeps its 400 and message.
func TestCreateOrderErrorMapping(t *testing.T) {
	body := `{"orderUuid":"u","paymentMethod":"cash","items":[{"productId":"p","variantSize":"s","price":1,"quantity":1,"subtotal":1}]}`
	run := func(err error) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "/orders", strings.NewReader(body))
		r.Header.Set("Idempotency-Key", "k")
		w := httptest.NewRecorder()
		(&Handlers{}).createOrder(w, r, func(*http.Request) (callerID, error) { return callerID{outletID: "o"}, nil },
			func(context.Context, service.CreateOrderInput) (string, bool, bool, error) {
				return "", false, false, err
			})
		return w
	}
	w := run(fmt.Errorf("check shift: %w", &pgconn.PgError{Code: "08006", Message: "connection failure host=db.internal"}))
	if w.Code != http.StatusInternalServerError || strings.Contains(w.Body.String(), "db.internal") || strings.Contains(w.Body.String(), "08006") {
		t.Fatalf("unclassified error: %d %s", w.Code, w.Body.String())
	}
	w = run(service.ErrShiftNotInOutlet)
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), service.ErrShiftNotInOutlet.Error()) {
		t.Fatalf("classified error: %d %s", w.Code, w.Body.String())
	}
}

// A42: the direct sale route re-runs a deadlock victim as a whole fresh
// transaction and, after the retries are exhausted, answers a clean 409 that never
// carries raw database text.
func TestCreateOrderRetriesDeadlockThenCleanBusy(t *testing.T) {
	calls := 0
	create := func(context.Context, service.CreateOrderInput) (string, bool, bool, error) {
		calls++
		return "", false, false, fmt.Errorf("lock variant stock: %w", &pgconn.PgError{Code: "40P01", Message: "deadlock detected"})
	}
	body := `{"orderUuid":"u","paymentMethod":"cash","items":[{"productId":"p","variantSize":"s","price":1,"quantity":1,"subtotal":1}]}`
	r := httptest.NewRequest("POST", "/orders", strings.NewReader(body))
	r.Header.Set("Idempotency-Key", "k")
	w := httptest.NewRecorder()
	h := &Handlers{}
	h.createOrder(w, r, func(*http.Request) (callerID, error) { return callerID{outletID: "o"}, nil }, create)
	if calls != 3 {
		t.Fatalf("deadlock victim must be attempted 3 times, got %d", calls)
	}
	if w.Code != http.StatusConflict {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	if got := w.Body.String(); strings.Contains(got, "deadlock") || strings.Contains(got, "40P01") || !strings.Contains(got, write.ErrBusy.Error()) {
		t.Fatalf("response must be the clean busy message: %s", got)
	}
}
