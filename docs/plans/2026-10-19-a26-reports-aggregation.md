# A26 reports aggregation: plan (2026-10-19)

## State
DONE: `fetchAllPages` (packages/api/src/pagination.ts) fails loudly and backs Reports, Dashboard, OrdersPanel, POS recap; tests pagination_integration_test.go (gate A26),
paginationPostgres.test.ts, report_summary_integration_test.go (gate A27); `/reports/summary` is outlet-scoped via `scope(r)` behind `view_reports`.
LEFT: every backoffice report still downloads the whole `orders` table (+ all shifts) and filters in the browser, re-polling every 12 s; `/reports/summary` has no UI caller.
Also: `CustomerDetail.tsx:52` reads one page only (`listOrders({customerId, limit:200}).then(r=>r.data)`).
Money bug: generated Go `api.ReportSummary` money fields are float32 (api.gen.go ~2889-2899; `DailySalesRow.Sales`, `ProductSalesRow.Revenue`): totals above 2^24 (~Rp16.7M) round. Needs `format: double` in the spec.
POS trap: POS `OrderHistoryPanel.tsx:47-75` sends `from`/`to` as UTC YYYY-MM-DD read as UTC days. DO NOT change that meaning; add NEW `dateFrom`/`dateTo` (WIB days).
No migration (idx_orders_outlet_created, idx_orders_created cover it; next number would be 0057, claimed by A15 Phase B).

## Remaining scope
1. Summary contract: `format: double` on money fields; add `refundedOrders`; filters `status`, `paymentMethod` (match `lower(btrim())`), `q`; WIB day params `dateFrom`/`dateTo`;
   400 on unparseable dates (today it silently falls back to 30 days). Basis unchanged: `created_at` + current status (refund-date basis belongs to A27 build).
2. `/orders`: document + add `dateFrom`, `dateTo`, `status`, `paymentMethod`; `q` also matches `o.cashier_name`. Legacy `from`/`to` untouched.
3. `/shifts`: `dateFrom`/`dateTo` on `opened_at` (WIB), matching the owner's A28 rule (business day = shift opening date).
4. Backoffice: Reports Export tab = server totals + server-paged list, CSV built via fetchAllPages on click; Shifts tab date-filtered; fetch only the active tab's data; Dashboard date-bounded;
   OrdersPanel server paging/search/totals from summary; CustomerDetail uses fetchAllPages.

## Design
- One filter builder `read.OrderFilter{Scope, DateFrom, DateTo, Status, PaymentMethod, Q, ShiftID, CustomerID, LegacyFrom, LegacyTo}` -> `buildOrderWhere(f) (where string, args []any)`,
  used by BOTH `Repo.Orders` and `Repo.ReportSummary` so summary and list/CSV cover identical rows.
- One day->instant helper `wibDayStart(d)` = `($n::date)::timestamp AT TIME ZONE 'Asia/Jakarta'`, dateTo exclusive at day+1 (as read/oversell.go:23-24); validate with `validWIBDay` (handlers/oversell.go:21).
  A28 later swaps this single helper for per-outlet WIB/WITA.
- `byPaymentMethod` stays grouped by raw `payment_method` (as Reports.tsx:106 does); only the FILTER is normalised.
- Owner default (taken 2026-10-19, owner may change): Laporan -> Transaksi defaults to the last 30 days with a "Semua tanggal" option; search still covers all dates; summary must also support an unbounded range.

## Tests first
- Go: extend `TestReportSummaryPostgres` (no new gate; scripts/ci/postgres_gate.py untouched): total > 2^24 with non-round amounts; completed/refunded/cancelled (cancelled excluded from money, counted in N transaksi);
  rows at 16:59 and 17:01 UTC around WIB midnight; payment methods " QRIS" and "qris" (filter matches both, grouping keeps them separate); two outlets incl. non-admin passing ?outletId=<other> gets own outlet only;
  invalid dateFrom -> 400; then summary totals == sums over all /orders pages for the same filter.
- Go: extend `TestPaginationPostgres`: dateFrom/dateTo/status/paymentMethod/q(cashier name) on /orders, dateFrom/dateTo on /shifts, legacy from/to byte-identical to before.
- Vitest: extract inline reducers (Reports.tsx:98-109) into pure `reportTotals(orders)` in screens/reports/reportTotals.ts; golden test vs the PG harness (env-gated like paginationPostgres.test.ts); unit test for the Dashboard fetch-window helper.

## Steps (fresh worktree `.claude/worktrees/a26`, branch a26-reports-agg)
1 failing tests. 2 OpenAPI (double format, refundedOrders, new params on /orders /shifts /reports/summary) + regenerate api.gen.go (`make gen-go`) AND schema.d.ts (`pnpm --filter @mandalika/api gen`), `pnpm gen:check` + `go run ./cmd/codegen -check` [Opus review].
3 backend buildOrderWhere + WIB helper; refactor Repo.Orders (repo.go ~986) + Repo.ReportSummary onto them; Repo.Shifts (~1053) date bounds; handlers (~316,340,422) validate, 400 on bad input [Opus: money, outlet scope, POS from/to contract].
4 packages/api/src/client.ts type reportSummary params + listOrders params. 5 Reports.tsx (summary cards/payment breakdown from api.reportSummary; list server-paged 50/page; CSV via fetchAllPages on click; Shifts via fetchAllPages with dateFrom/dateTo; queries gated by active tab; drop isWithinInterval).
6 Dashboard.tsx + dashboard/metrics.ts: fetch status=completed with dateFrom = WIB day of (prevStart - 1 day), dateTo = today (superset for WITA browsers; existing completedIn trims exactly); "all" period stays unbounded (note it).
7 Orders.tsx OrdersPanel server paging/q/status/payment filters, total chip from summary. 8 CustomerDetail.tsx:52 -> fetchAllPages({customerId}); grep other single-page `.then((r) => r.data)` reads feeding money figures.
9 gates: `corepack pnpm quality:ci`, `browser:ci`, `go test ./...`, PG gate A26+A27; Opus final review of whole diff. Backend+backoffice only (no APK/OTA). ASK before push/deploy; post-deploy smoke: summary total == CSV sum (today, 30 days, per outlet, all).

## Risks
- Money: float32 today -> the format change and >2^24 test are mandatory. `Order.total` and `Shift.totalSales` are also float32 (per row < 2^24, safe; adjacent finding out of A26 scope).
- Parity: cancelled orders count in "N transaksi" not money (keep). Daily buckets are UTC on both sides today (reports.go:52, metrics.ts:154): require period-total parity only; WIB buckets = deliberate A28.
  Reports date range moving from browser-local to server WIB days shifts the window 1 h for a WITA browser (intended move toward A28).
- Refunds: A27 (refund-date basis) will deliberately change totalRefunds/netSales: build A26 with no semantic change, A27 then edits only the shared summary SQL + tests.
- Scope/IDOR: always `scope(r)`, never raw outletId (bug caught earlier in the grant report). POS: do not touch from/to (UTC-day latent A28 bug, flagged); POS recap bounded by shiftId.
