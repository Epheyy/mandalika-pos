package server

import (
	"net/http"
	"strings"

	"github.com/mandalika/pos-backend/internal/handlers"
)

// DefaultBodyLimit caps every request body not matched by bodyLimitExceptions.
const DefaultBodyLimit int64 = 1 << 20

// stockCountBodyLimit covers stock-count bodies that carry the full variant/ingredient
// line list; it grows with the catalog (about 150-170 bytes per line).
const stockCountBodyLimit int64 = 8 << 20

type bodyLimitRule struct {
	method  string
	pattern string // exact path; a "{id}" segment matches one non-empty segment without a slash
	limit   int64
}

// bodyLimitExceptions lists the routes allowed a larger cap. Rules are keyed on
// method AND path: chi falls back from a POST-only static route such as
// /products/import to /products/{id} for other methods, and those must stay on the
// default cap. The handlers below enforce their own (same-sized) cap too; the outer
// cap must not be smaller or it would silently win.
//   - POST /sync/batch, /sync/review-items: tablet queue/check-in batches (8 MiB).
//   - POST */import (products, customers, ingredients, admin/erp/sku-mapping, stock-counts/{id}): CSV text
//     inside a JSON body (20 MiB).
//   - POST /stock-counts (backoffice StockCount.tsx sends every product x variant) and
//     PUT /ingredient-stock-counts/{id}/save (OpnameTab.tsx sends every item): full line
//     lists (8 MiB). PUT /stock-counts/{id}, POST /stock-counts/{id}/complete and
//     POST /ingredient-stock-counts carry one line, a status or a header only and stay
//     on the default cap. "{id}" matches exactly one non-empty path segment with no
//     slash; extra segments do not match.
//
// Smaller inner caps (auth, oversell-ack, error-logs) stay in their handlers.
// Per-route request deadlines are documented in deadlineExceptions (deadline.go).
var bodyLimitExceptions = []bodyLimitRule{
	{http.MethodPost, "/api/v1/sync/batch", handlers.SyncBatchBodyLimit},
	{http.MethodPost, "/api/v1/sync/review-items", handlers.SyncReviewBodyLimit},
	{http.MethodPost, "/api/v1/products/import", handlers.ImportBodyCap},
	{http.MethodPost, "/api/v1/customers/import", handlers.ImportBodyCap},
	{http.MethodPost, "/api/v1/ingredients/import", handlers.ImportBodyCap},
	{http.MethodPost, "/api/v1/admin/erp/sku-mapping/import", handlers.ImportBodyCap},
	{http.MethodPost, "/api/v1/stock-counts/{id}/import", handlers.ImportBodyCap},
	{http.MethodPost, "/api/v1/stock-counts", stockCountBodyLimit},
	{http.MethodPut, "/api/v1/ingredient-stock-counts/{id}/save", stockCountBodyLimit},
}

func pathMatches(pattern, path string) bool {
	ps, xs := strings.Split(pattern, "/"), strings.Split(path, "/")
	if len(ps) != len(xs) {
		return false
	}
	for i, p := range ps {
		if p == "{id}" {
			if xs[i] == "" {
				return false
			}
			continue
		}
		if p != xs[i] {
			return false
		}
	}
	return true
}

func bodyLimitFor(r *http.Request) int64 {
	for _, rule := range bodyLimitExceptions {
		if r.Method == rule.method && pathMatches(rule.pattern, r.URL.Path) {
			return rule.limit
		}
	}
	return DefaultBodyLimit
}
