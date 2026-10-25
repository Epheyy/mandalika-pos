package server

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/mandalika/pos-backend/internal/handlers"
	mw "github.com/mandalika/pos-backend/internal/middleware"
)

const oneMiB = 1 << 20

func bodyLimitRouter(h *handlers.Handlers, sink func(error)) http.Handler {
	r := chi.NewRouter()
	r.Use(mw.BodyLimit(bodyLimitFor))
	r.Post("/api/v1/orders", h.CreateOrder)
	r.Post("/api/v1/ota/check", h.OtaCheck)
	stub := func(w http.ResponseWriter, req *http.Request) {
		_, err := io.Copy(io.Discard, req.Body)
		sink(err)
		w.WriteHeader(http.StatusNoContent)
	}
	for _, rule := range bodyLimitExceptions {
		r.MethodFunc(rule.method, concretePath(rule.pattern), stub)
	}
	// Mirrors chi's real fallback: PUT /products/import lands on the {id} handler.
	r.Put("/api/v1/products/{id}", stub)
	return r
}

// concretePath fills "{id}" placeholders with a sample segment.
func concretePath(pattern string) string { return strings.ReplaceAll(pattern, "{id}", "abc") }

// jsonBody is valid JSON of n+pad bytes so the decoder reads until the cap trips.
func jsonBody(n int) string {
	const frame = `{"notes":""}`
	return `{"notes":"` + strings.Repeat("a", n-len(frame)) + `"}`
}

func post(t *testing.T, router http.Handler, path, body string, chunked bool) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	if chunked {
		req = httptest.NewRequest(http.MethodPost, path, io.NopCloser(strings.NewReader(body)))
		req.ContentLength = -1
	}
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec
}

func TestBodyLimitDefaultRoutesReturn413(t *testing.T) {
	router := bodyLimitRouter(&handlers.Handlers{}, func(error) {})
	for _, path := range []string{"/api/v1/orders", "/api/v1/ota/check"} {
		for _, chunked := range []bool{false, true} {
			rec := post(t, router, path, jsonBody(oneMiB+1), chunked)
			if rec.Code != http.StatusRequestEntityTooLarge {
				t.Fatalf("%s chunked=%v: status = %d, want 413", path, chunked, rec.Code)
			}
			if got := strings.TrimSpace(rec.Body.String()); got != `{"data":null,"error":"request body too large"}` {
				t.Fatalf("%s chunked=%v: body = %q", path, chunked, got)
			}
		}
	}
}

func TestBodyLimitForTable(t *testing.T) {
	const syncMax = handlers.SyncBatchBodyLimit
	cases := []struct {
		method, path string
		want         int64
	}{
		{"POST", "/api/v1/sync/batch", syncMax},
		{"POST", "/api/v1/sync/review-items", handlers.SyncReviewBodyLimit},
		{"POST", "/api/v1/products/import", handlers.ImportBodyCap},
		{"POST", "/api/v1/customers/import", handlers.ImportBodyCap},
		{"POST", "/api/v1/ingredients/import", handlers.ImportBodyCap},
		{"POST", "/api/v1/admin/erp/sku-mapping/import", handlers.ImportBodyCap},
		{"POST", "/api/v1/stock-counts/abc/import", handlers.ImportBodyCap},
		{"PUT", "/api/v1/stock-counts/abc/import", oneMiB},
		{"POST", "/api/v1/stock-counts", stockCountBodyLimit},
		{"PUT", "/api/v1/stock-counts/abc", oneMiB},
		{"POST", "/api/v1/ingredient-stock-counts", oneMiB},
		{"PUT", "/api/v1/ingredient-stock-counts/abc/save", stockCountBodyLimit},
		{"POST", "/api/v1/orders", oneMiB},
		{"POST", "/api/v1/ota/check", oneMiB},
		{"POST", "/api/v1/anything/else", oneMiB},
		// method-blind regressions: chi falls back to /products/{id} etc.
		{"PUT", "/api/v1/products/import", oneMiB},
		{"PUT", "/api/v1/customers/import", oneMiB},
		{"PUT", "/api/v1/ingredients/import", oneMiB},
		{"GET", "/api/v1/sync/batch", oneMiB},
		// stock-count negatives: wrong method, extra segment, empty segment
		{"GET", "/api/v1/stock-counts", oneMiB},
		{"GET", "/api/v1/stock-counts/abc", oneMiB},
		{"POST", "/api/v1/stock-counts/abc", oneMiB},
		{"PUT", "/api/v1/stock-counts/abc/extra", oneMiB},
		{"PUT", "/api/v1/stock-counts/", oneMiB},
		{"POST", "/api/v1/stock-counts/abc/complete", oneMiB},
		{"POST", "/api/v1/ingredient-stock-counts/abc/save", oneMiB},
		{"PUT", "/api/v1/ingredient-stock-counts/abc", oneMiB},
		{"PUT", "/api/v1/ingredient-stock-counts//save", oneMiB},
		{"PUT", "/api/v1/ingredient-stock-counts/abc/save/x", oneMiB},
	}
	for _, c := range cases {
		req := httptest.NewRequest(c.method, c.path, nil)
		if got := bodyLimitFor(req); got != c.want {
			t.Errorf("bodyLimitFor(%s %s) = %d, want %d", c.method, c.path, got, c.want)
		}
	}
}

func TestBodyLimitPutToImportPathGets413(t *testing.T) {
	router := bodyLimitRouter(&handlers.Handlers{}, func(error) {})
	for _, p := range []string{"/api/v1/products/import", "/api/v1/customers/import", "/api/v1/ingredients/import"} {
		req := httptest.NewRequest(http.MethodPut, p, strings.NewReader(strings.Repeat("a", 2*oneMiB)))
		out := httptest.NewRecorder()
		router.ServeHTTP(out, req)
		if out.Code != http.StatusRequestEntityTooLarge {
			t.Fatalf("PUT %s: status = %d, want 413", p, out.Code)
		}
	}
}

func TestBodyLimitMiddlewareIsWiredAfterGlobalRateLimit(t *testing.T) {
	// Line-based so a commented-out line does not count as wired.
	rate, limit := -1, -1
	for i, line := range strings.Split(mustRead(t, "server.go"), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, `r.Use(mw.RateLimit(c, "api"`) && rate < 0 {
			rate = i
		}
		if line == "r.Use(mw.BodyLimit(bodyLimitFor))" && limit < 0 {
			limit = i
		}
	}
	if rate < 0 || limit < 0 || limit < rate {
		t.Fatalf("server.go must wire mw.BodyLimit(bodyLimitFor) after the global api RateLimit (rate=%d limit=%d)", rate, limit)
	}
}

func TestBodyLimitExceptionRoutesAcceptLargeBodies(t *testing.T) {
	var readErr error
	router := bodyLimitRouter(&handlers.Handlers{}, func(err error) { readErr = err })
	for _, rule := range bodyLimitExceptions {
		path := concretePath(rule.pattern)
		for _, chunked := range []bool{false, true} {
			readErr = nil
			req := httptest.NewRequest(rule.method, path, strings.NewReader(strings.Repeat("a", 2*oneMiB)))
			if chunked {
				req = httptest.NewRequest(rule.method, path, io.NopCloser(strings.NewReader(strings.Repeat("a", 2*oneMiB))))
				req.ContentLength = -1
			}
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)
			if rec.Code != http.StatusNoContent || readErr != nil {
				t.Fatalf("%s %s chunked=%v: status=%d readErr=%v", rule.method, path, chunked, rec.Code, readErr)
			}
		}
	}
}
