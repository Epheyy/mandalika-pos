package server

import (
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
)

// The exact set of routes that answer without a bearer token or scheduler secret. A new public
// route (or an authed route that lost its guard) changes this set and fails here, so the customer
// receipt page stays the only customer-facing public surface.
func TestPublicRouteSetIsExact(t *testing.T) {
	router, _ := newRouteHarness(t)
	routes, ok := router.(chi.Routes)
	if !ok {
		t.Fatal("router does not expose its routes")
	}
	var public []string
	err := chi.Walk(routes, func(method, pattern string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		path := strings.ReplaceAll(strings.ReplaceAll(pattern, "/*", ""), "{", "")
		path = strings.NewReplacer("token}", "x", "id}", "22222222-2222-2222-2222-222222222222").Replace(path)
		// Anything not matched above still needs a literal segment.
		for strings.Contains(path, "}") {
			i := strings.Index(path, "}")
			j := strings.LastIndex(path[:i], "/")
			path = path[:j+1] + "x" + path[i+1:]
		}
		// Public by design but answering 401 without a cookie: not distinguishable by status.
		if method == http.MethodPost && pattern == "/api/v1/auth/refresh" {
			public = append(public, method+" "+pattern)
			return nil
		}
		rec := send(router, method, path, "", `{}`)
		switch rec.Code {
		case http.StatusUnauthorized, http.StatusForbidden:
			return nil
		}
		public = append(public, method+" "+pattern)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(public)
	want := []string{
		"GET /healthz", "GET /livez", "GET /readyz",
		"GET /r/{token}", "POST /r/{token}",
		"POST /api/v1/auth/login", "POST /api/v1/auth/logout", "POST /api/v1/auth/refresh",
		"POST /api/v1/ota/check",
		// Scheduler-secret routes: no bearer token, and with no secret configured they answer 503, not 401.
		"POST /api/v1/internal/erp/relay", "POST /api/v1/internal/erp/catalog-pull",
	}
	sort.Strings(want)
	if strings.Join(public, "\n") != strings.Join(want, "\n") {
		t.Fatalf("public routes changed.\n got:\n%s\nwant:\n%s", strings.Join(public, "\n"), strings.Join(want, "\n"))
	}
}

func TestReceiptLinkCreateNeedsAuth(t *testing.T) {
	router, _ := newRouteHarness(t)
	if rec := send(router, http.MethodPost, "/api/v1/receipt-links", "", `{}`); rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated POST /receipt-links = %d, want 401", rec.Code)
	}
}

func TestReceiptPageRateLimit(t *testing.T) {
	router, _ := newRouteHarness(t)
	// A malformed token never reaches the database, so the harness pool is enough: the first 10
	// POSTs from one address get the 404 page, the 11th is limited.
	for i := 1; i <= 11; i++ {
		req := httptest.NewRequest(http.MethodPost, "/r/x", strings.NewReader("stars=5"))
		req.RemoteAddr = "203.0.113.9:4000"
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		want := http.StatusNotFound
		if i == 11 {
			want = http.StatusTooManyRequests
		}
		if rec.Code != want {
			t.Fatalf("POST #%d = %d, want %d", i, rec.Code, want)
		}
	}
}

func TestReceiptPageGoneIsUniform(t *testing.T) {
	router, _ := newRouteHarness(t)
	a := send(router, http.MethodGet, "/r/x", "", "")
	b := send(router, http.MethodGet, "/r/"+strings.Repeat("A", 40), "", "")
	if a.Code != http.StatusNotFound || a.Code != b.Code || a.Body.String() != b.Body.String() {
		t.Fatalf("bad-shape tokens must share one 404 body (%d vs %d)", a.Code, b.Code)
	}
	if a.Header().Get("Cache-Control") != "no-store" || a.Header().Get("X-Robots-Tag") == "" {
		t.Fatal("public headers missing on the 404 page")
	}
}
