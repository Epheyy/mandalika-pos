package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	mw "github.com/mandalika/pos-backend/internal/middleware"
)

// writeTimeout mirrors cmd/server/main.go; every non-exempt deadline must sit below it.
const writeTimeout = 30 * time.Second

func TestDeadlineForTable(t *testing.T) {
	cases := []struct {
		method, path string
		want         time.Duration
	}{
		{"GET", "/api/v1/products", DefaultDeadline},
		{"POST", "/api/v1/orders", DefaultDeadline},
		{"GET", "/api/v1/sync/pull", DefaultDeadline},
		{"POST", "/api/v1/sync/batch", LongDeadline},
		{"POST", "/api/v1/sync/review-items", LongDeadline},
		{"GET", "/api/v1/sync/batch", DefaultDeadline},
		{"POST", "/api/v1/internal/erp/relay", LongDeadline},
		{"POST", "/api/v1/admin/erp/relay", LongDeadline},
		{"POST", "/api/v1/internal/erp/catalog-pull", LongDeadline},
		{"POST", "/api/v1/admin/erp/catalog-pull", LongDeadline},
		// CSV imports extend their own read/write windows to 60 s / 150 s: exempt.
		{"POST", "/api/v1/products/import", 0},
		{"POST", "/api/v1/customers/import", 0},
		{"POST", "/api/v1/ingredients/import", 0},
		{"POST", "/api/v1/admin/erp/sku-mapping/import", 0},
		// the kartu stok export bounds itself (55 s context, 60 s write deadline): exempt.
		{"GET", "/api/v1/inventory/movements/export", 0},
		{"POST", "/api/v1/stock-counts/abc/import", 0},
		// chi falls back from the POST-only import route to /products/{id}: stays default.
		{"PUT", "/api/v1/products/import", DefaultDeadline},
	}
	for _, c := range cases {
		req := httptest.NewRequest(c.method, c.path, nil)
		if got := deadlineFor(req); got != c.want {
			t.Errorf("deadlineFor(%s %s) = %v, want %v", c.method, c.path, got, c.want)
		}
	}
}

func TestDeadlinesStayBelowWriteTimeout(t *testing.T) {
	if DefaultDeadline != 25*time.Second || LongDeadline != 28*time.Second {
		t.Fatalf("default %v long %v", DefaultDeadline, LongDeadline)
	}
	for _, rule := range deadlineExceptions {
		if rule.deadline != 0 && rule.deadline >= writeTimeout {
			t.Errorf("%s %s deadline %v must stay below the %v WriteTimeout", rule.method, rule.pattern, rule.deadline, writeTimeout)
		}
	}
}

func TestDeadlineMiddlewareReachesHandlers(t *testing.T) {
	left := map[string]time.Duration{}
	r := chi.NewRouter()
	r.Use(mw.Deadline(deadlineFor))
	probe := func(name string) http.HandlerFunc {
		return func(w http.ResponseWriter, req *http.Request) {
			if dl, ok := req.Context().Deadline(); ok {
				left[name] = time.Until(dl)
			} else {
				left[name] = -1
			}
		}
	}
	r.Get("/api/v1/products", probe("default"))
	r.Post("/api/v1/sync/batch", probe("batch"))
	r.Post("/api/v1/admin/erp/relay", probe("relay"))
	r.Post("/api/v1/products/import", probe("import"))
	for _, c := range []struct{ m, p string }{
		{"GET", "/api/v1/products"}, {"POST", "/api/v1/sync/batch"},
		{"POST", "/api/v1/admin/erp/relay"}, {"POST", "/api/v1/products/import"},
	} {
		r.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(c.m, c.p, nil))
	}
	near := func(name string, want time.Duration) {
		if got := left[name]; got < want-time.Second || got > want {
			t.Errorf("%s deadline in %v, want about %v", name, got, want)
		}
	}
	near("default", 25*time.Second)
	near("batch", 28*time.Second)
	near("relay", 28*time.Second)
	if left["import"] != -1 {
		t.Errorf("exempt import route must have no deadline, got %v", left["import"])
	}
}

func TestDeadlineMiddlewareIsWiredAfterGlobalRateLimit(t *testing.T) {
	rate, dl := -1, -1
	for i, line := range strings.Split(mustRead(t, "server.go"), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, `r.Use(mw.RateLimit(c, "api"`) && rate < 0 {
			rate = i
		}
		if line == "r.Use(mw.Deadline(deadlineFor))" && dl < 0 {
			dl = i
		}
	}
	if rate < 0 || dl < 0 || dl < rate {
		t.Fatalf("server.go must wire mw.Deadline(deadlineFor) after the global api RateLimit (rate=%d deadline=%d)", rate, dl)
	}
}
