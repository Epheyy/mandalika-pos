package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/mandalika/pos-backend/internal/observability"
	"github.com/mandalika/pos-backend/internal/write"
)

type fakeSink struct{ rows []write.ErrorLog }

func (f *fakeSink) InsertErrorLogs(_ context.Context, logs []write.ErrorLog) error {
	f.rows = append(f.rows, logs...)
	return nil
}

// A real panic through the real recoverer: 500 to the client and one backend
// row handed to the sink (redaction itself lives in write.InsertErrorLogs and is
// proven against PostgreSQL by gate EL).
func TestSentryRecovererRecordsARealPanic(t *testing.T) {
	sentry, err := observability.NewSentry("", "test", "r")
	if err != nil {
		t.Fatal(err)
	}
	sink := &fakeSink{}
	h := sentryRecoverer(sentry, sink)(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		panic("boom for budi@example.com")
	}))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/api/v1/orders", nil))
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d", w.Code)
	}
	if len(sink.rows) != 1 {
		t.Fatalf("rows = %d", len(sink.rows))
	}
	r := sink.rows[0]
	if r.Source != "backend" || r.Kind != "panic" || r.Action != "POST /api/v1/orders" || len(r.Payload) == 0 {
		t.Fatalf("unexpected row: %+v", r)
	}
}
