package server

import (
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/mandalika/pos-backend/internal/observability"
)

// A handler that fails after its headers and first bytes went out aborts with
// http.ErrAbortHandler (the kartu stok export does). Through the real recoverer the client must
// see a failed body, not a clean end of a short 200: the recoverer re-panics the abort so net/http
// drops the connection instead of finishing the chunked stream.
func TestSentryRecovererLetsAStreamAbortReachTheClient(t *testing.T) {
	sentry, err := observability.NewSentry("", "test", "r")
	if err != nil {
		t.Fatal(err)
	}
	sink := &fakeSink{}
	srv := httptest.NewServer(sentryRecoverer(sentry, sink)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/csv; charset=utf-8")
		_, _ = w.Write([]byte("id,saldo\n1,5\n"))
		w.(http.Flusher).Flush()
		panic(http.ErrAbortHandler)
	})))
	defer srv.Close()

	resp, err := http.Get(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d (the headers were already sent)", resp.StatusCode)
	}
	body, err := io.ReadAll(resp.Body)
	if err == nil {
		t.Fatalf("client read %q cleanly: a truncated 200 must fail", body)
	}
	if len(sink.rows) != 0 {
		t.Fatalf("a deliberate abort is not a crash, but %d error rows were recorded", len(sink.rows))
	}
}
