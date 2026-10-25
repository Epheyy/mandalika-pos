package server

import (
	"net/http"
	"time"
)

// DefaultDeadline is the server-side context deadline for every route not listed in
// deadlineExceptions. It is 25 s, just under the 30 s http.Server WriteTimeout
// (cmd/server/main.go): slow reads (sync pull, reports, report exports) can legitimately
// take 15-30 s at scale and succeed today, so the deadline only bounds runaway work that
// would miss WriteTimeout anyway.
const DefaultDeadline = 25 * time.Second

// LongDeadline is for the routes that legitimately work longer. It stays under the
// 30 s WriteTimeout and the POS client's 30 s /sync/batch timeout. /sync/review-items
// has a shorter client timeout (REVIEW_CHECKIN_TIMEOUT_MS = 20 s, packages/sync engine.ts),
// so there the client may abort first; the server still finishes safely and idempotently.
const LongDeadline = 28 * time.Second

type deadlineRule struct {
	method   string
	pattern  string // same matching as bodyLimitExceptions ("{id}" = one non-empty segment)
	deadline time.Duration
}

// deadlineExceptions is the per-route companion of bodyLimitExceptions (bodylimit.go):
// together the two tables document every route that departs from the global defaults.
// A deadline of 0 means no middleware deadline. Rules are keyed on method AND path for
// the same chi-fallback reason as the body limits.
//   - POST /sync/batch, /sync/review-items: LongDeadline. Batch work is also bounded
//     by sync.Engine.WorkBudget (20 s, checked between items) so the remaining items
//     are deferred as retryable Busy instead of the whole batch failing.
//   - POST /internal/erp/relay, /admin/erp/relay: LongDeadline. The relay run budget is
//     20 s (erp.NewRelay default) and its final state writes use WithoutCancel contexts.
//   - POST /internal/erp/catalog-pull, /admin/erp/catalog-pull: LongDeadline. The HTTP
//     pull budget is 20 s plus a 5 s run grace (25 s) and the lock release uses its own
//     context, so 28 s does not cut a legitimate run.
//   - POST */import (products, customers, ingredients, admin/erp/sku-mapping, stock-counts/{id}): EXEMPT.
//     These routes extend their own deadlines (read 60 s, write 150 s, imports.go) for a
//     16 MiB upload plus a 50k-row plan, which a 28 s context would cut mid-transaction.
//     They are bounded by those windows and the two-slot concurrency cap instead.
var deadlineExceptions = []deadlineRule{
	{http.MethodPost, "/api/v1/sync/batch", LongDeadline},
	{http.MethodPost, "/api/v1/sync/review-items", LongDeadline},
	{http.MethodPost, "/api/v1/internal/erp/relay", LongDeadline},
	{http.MethodPost, "/api/v1/admin/erp/relay", LongDeadline},
	{http.MethodPost, "/api/v1/internal/erp/catalog-pull", LongDeadline},
	{http.MethodPost, "/api/v1/admin/erp/catalog-pull", LongDeadline},
	{http.MethodPost, "/api/v1/products/import", 0},
	{http.MethodPost, "/api/v1/customers/import", 0},
	{http.MethodPost, "/api/v1/ingredients/import", 0},
	{http.MethodPost, "/api/v1/admin/erp/sku-mapping/import", 0},
	{http.MethodPost, "/api/v1/stock-counts/{id}/import", 0},
}

func deadlineFor(r *http.Request) time.Duration {
	for _, rule := range deadlineExceptions {
		if r.Method == rule.method && pathMatches(rule.pattern, r.URL.Path) {
			return rule.deadline
		}
	}
	return DefaultDeadline
}
