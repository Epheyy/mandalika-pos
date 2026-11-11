package server

import (
	"bytes"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/mandalika/pos-backend/internal/config"
	mw "github.com/mandalika/pos-backend/internal/middleware"
	"github.com/mandalika/pos-backend/internal/observability"
)

// lockedBuffer is a log sink safe for the server goroutine and the test goroutine.
type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// A handler that fails after its headers and first bytes went out aborts with
// http.ErrAbortHandler (the kartu stok export does). Through the real outermost middleware chain
// (request id, client IP, access log, recoverer) and the real deadline middleware, the client must
// see a failed body, not a clean end of a short 200: the recoverer re-panics the abort so net/http
// drops the connection instead of finishing the chunked stream; the access log still gets its
// line; the export route is exempt from the request deadline.
func TestAbortedStreamReachesTheClientThroughTheMiddlewareChain(t *testing.T) {
	logs := &lockedBuffer{}
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(logs, nil)))
	t.Cleanup(func() { slog.SetDefault(prev) })

	sentry, err := observability.NewSentry("", "test", "r")
	if err != nil {
		t.Fatal(err)
	}
	sink := &fakeSink{}
	r := chi.NewRouter()
	useRequestObservers(r, &config.Config{}, sentry, sink)
	r.Use(mw.Deadline(deadlineFor))
	hadDeadline := make(chan bool, 1)
	r.Get("/api/v1/inventory/movements/export", func(w http.ResponseWriter, req *http.Request) {
		_, has := req.Context().Deadline()
		hadDeadline <- has
		w.Header().Set("Content-Type", "text/csv; charset=utf-8")
		_, _ = w.Write([]byte("id,saldo\n1,5\n"))
		w.(http.Flusher).Flush()
		panic(http.ErrAbortHandler)
	})
	srv := httptest.NewServer(r)
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/api/v1/inventory/movements/export")
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
	if has := <-hadDeadline; has {
		t.Fatal("the export route must be exempt from the request deadline middleware")
	}
	if len(sink.rows) != 0 {
		t.Fatalf("a deliberate abort is not a crash, but %d error rows were recorded", len(sink.rows))
	}
	// the access line is written by a defer on the unwinding goroutine: wait for it briefly
	const line = "path=/api/v1/inventory/movements/export"
	for i := 0; i < 200 && !strings.Contains(logs.String(), line); i++ {
		time.Sleep(10 * time.Millisecond)
	}
	if out := logs.String(); !strings.Contains(out, line) {
		t.Fatalf("the aborted request has no access-log line:\n%s", out)
	}
}

// With the JSON compressor installed, a stream that aborts after its headers and first flushed
// bytes must still drop the connection: the compressor's deferred Close must not turn the abort
// into a cleanly finished chunked body.
func TestAbortedCompressedStreamStillDropsTheConnection(t *testing.T) {
	sentry, err := observability.NewSentry("", "test", "r")
	if err != nil {
		t.Fatal(err)
	}
	r := chi.NewRouter()
	useRequestObservers(r, &config.Config{}, sentry, &fakeSink{})
	r.Use(mw.Deadline(deadlineFor))
	r.Use(compressJSON(jsonCompressLevel))
	r.Get("/api/v1/inventory/movements/export", func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[1,2,`))
		w.(http.Flusher).Flush()
		panic(http.ErrAbortHandler)
	})
	srv := httptest.NewServer(r)
	defer srv.Close()

	req, _ := http.NewRequest(http.MethodGet, srv.URL+"/api/v1/inventory/movements/export", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	resp, err := (&http.Client{Transport: &http.Transport{DisableCompression: true}}).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.Header.Get("Content-Encoding") != "gzip" {
		t.Fatalf("expected a gzip response, got %v", resp.Header)
	}
	if body, err := io.ReadAll(resp.Body); err == nil {
		t.Fatalf("client read %d bytes cleanly: a truncated compressed 200 must fail", len(body))
	}
}
