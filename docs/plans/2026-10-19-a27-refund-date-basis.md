# A27 refunds on the refund date: plan (2026-10-19)

Written by the Opus planner (read-only), saved by Claude. Base: prod-hardening incl. A26 + A28.
Owner policy (binding, HANDOFF Decisions 2026-10-17 item 2): reports recognise a refund on the REFUND date. Business day per A28:
`orders.refund_business_date` = refund shift's opening date in the outlet tz, else outlet-zone date of `refunded_at`.

## 0. Facts (checked in source)

- Refunds are whole-order only (one flip completed -> refunded, `service/order.go:840-846`); no partial refunds/exchanges.
- The audited double subtraction is already gone (`read/reports.go:59` `netSales = agg.total_sales`). Remaining defect is the BASIS:
  `reports.go:27` counts only status='completed' on the SALE day, so a later refund silently removes the sale from its own day;
  `reports.go:29` sums refunded rows from the same base filtered on the SALE business_date, so refunds show on the sale day.
  TRAP: once refunds move to the refund day, `netSales = totalSales - totalRefunds` would re-introduce double subtraction (a refunded
  sale is already missing from totalSales). Net must be **gross (completed+refunded, sale day) minus refunds (refund day)**.
- 0059 backfill gap: refund_business_date is stamped only `WHERE status='refunded' AND refunded_at IS NOT NULL`; legacy rows with
  refunded_at NULL stay NULL (INSERT trigger handles it, backfill did not). No index on refund_business_date.
- Shift close is a separate drawer model keyed by shift_id (`shift.go:173-197`); stays UNTOUCHED (zero diff to service/shift.go).
- customers.total_spent/visit_count are never decremented by refunds: lifetime figures, out of scope (A20-A22 policy).
- POS does not call /reports/summary; POS legacy /orders from/to stays byte-identical.
- Summary consumers: reports/ExportTab.tsx:113-145 (cards + payment breakdown), Orders.tsx:138 (header totalSales); topProducts/dailySales
  have no UI consumer; Dashboard is client-side over listOrders(status=completed) (Dashboard.tsx:70-79, dashboard/metrics.ts).

## 1. Semantics

Two row sets from ONE shared WHERE builder for filter F (scope, dateFrom/dateTo or legacy instants, status, paymentMethod, q):
- Sale set S: F with date bound on `o.business_date` (legacy instants: `o.created_at`); status IN ('completed','refunded') ∩ F.status.
- Refund set R: F with date bound on `o.refund_business_date` (legacy instants: `o.refunded_at`); status='refunded' ∩ F.status.
  So status=completed -> R empty; cancelled -> all zero; refunded -> R unchanged. Cancelled rows are never money.

| Field | Meaning | Changed? |
|---|---|---|
| totalSales, totalOrders | still-completed rows in S (sale day); equals sum of completed rows in /orders for F; drops if refunded later | unchanged |
| byPaymentMethod, avgOrderValue, dailySales[].sales/orders, topProducts | still-completed, sale day | unchanged (document) |
| grossSales, grossOrders | SUM/COUNT of S (sale stays on its sale day forever) | NEW |
| totalRefunds, refundedOrders | SUM/COUNT of R (refund day) | meaning moves to refund date |
| netSales | grossSales - totalRefunds; may be negative | meaning changes (was = totalSales) |
| grossByPaymentMethod | S grouped by raw payment_method | NEW |
| refundsByPaymentMethod | R grouped by ORIGINAL payment_method (refund paid back in original method) | NEW |
| dailySales[] | FULL OUTER JOIN of S by business_date and R by refund_business_date; adds grossSales, grossOrders, refunds, refundedOrders, netSales (required); refund-only day gets a row with sales 0 | rows additive |

Invariants for tests: unbounded range netSales == totalSales; any range sum(dailySales[].netSales) == netSales;
grossByPaymentMethod sums to grossSales; refundsByPaymentMethod sums to totalRefunds.

Worked example: sale X Rp100 cash on D1, refunded D3.
| Window | gross | totalSales | refunds | net | daily rows | grossBy / refundsBy |
|---|---|---|---|---|---|---|
| D1 | 100 (1) | 0 | 0 | 100 | D1: sales 0, gross 100, refunds 0, net 100 | cash 100 / {} |
| D2 | 0 | 0 | 0 | 0 | none | {} / {} |
| D3 | 0 | 0 | 100 (1) | -100 | D3: sales 0, gross 0, refunds 100, net -100 | {} / cash 100 |
| D1-D3 | 100 | 0 | 100 | 0 | D1 +100, D3 -100 | cash 100 / cash 100 |
Products stay "still-completed sales by sale day" (owner Q2 default). Shift close/drawer figures do NOT change and will not equal the
daily report net (deliberate, relabelled). Customer totals unchanged.

## 2. Changes (file:line)

Backend:
- `read/orderfilter.go:13-31` add `DateBasis string` (""|"sale"|"refund"); refactor `buildOrderWhere` (:34-84) into
  `appendOrderWhere(f, args []any) (string, []any)` so two WHERE clauses share one positional-arg slice in one statement;
  `buildOrderWhere(f)` stays as a wrapper. Refund basis: DateFrom/DateTo -> `o.refund_business_date` (:62-67); FromInstant/ToInstant ->
  `o.refunded_at` (:56-61); always `AND o.status='refunded'`. LegacyFrom/LegacyTo (:50-55, POS) stay created_at, byte-identical.
- `read/reports.go:14-63`: CTEs `sb` (sale) and `rb` (refund); `agg` adds gross; `ragg` sums rb; `pay` unchanged on sb completed; add
  `gpay`, `rpay`; `prod` unchanged; `daily` = FULL OUTER JOIN of sb and rb day aggregates ORDER BY date; `netSales` = gross - refunds (:59).
- `read/repo.go:978` orderObj adds `'refundBusinessDate',o.refund_business_date`; `:987-994` Repo.Orders: with refund basis
  `ORDER BY o.refunded_at DESC NULLS LAST, o.id DESC`.
- `handlers/order_filter.go`: `ordersFilter` parses `dateBasis` (sale default, refund; else 400 "dateBasis tidak valid"); summaryFilter takes none.
- Migration `0060_refund_business_date_index.sql` (0057 reserved for A15 B; idempotent):
  1. `UPDATE orders SET refund_business_date = COALESCE((SELECT s.business_date FROM shifts s WHERE s.id=o.refund_shift_id),
     business_date_at(o.outlet_id, COALESCE(o.refunded_at, o.created_at))) WHERE status='refunded' AND refund_business_date IS NULL`
  2. `CREATE INDEX IF NOT EXISTS idx_orders_outlet_refund_bd ON orders(outlet_id, refund_business_date) WHERE refund_business_date IS NOT NULL`
  3. `CREATE INDEX IF NOT EXISTS idx_orders_refund_bd ON orders(refund_business_date) WHERE refund_business_date IS NOT NULL`
Backoffice: `reports/ExportTab.tsx:113-145` cards + payment breakdown; `:49-87` CSV columns + second refund CSV; `reports/ShiftsTab.tsx:45,84,114`
labels only; `reports/reportTotals.ts` (+test) parity oracle; Dashboard (`Dashboard.tsx:70-79`, `dashboard/metrics.ts:82-109,124-183,283-293`)
ONLY after owner Q1; `Orders.tsx:138` stays on totalSales (equals list completed sum; A26 parity).
No change: service/shift.go, service/order.go, POS, oversell/grant/code reports (F2 follow-up).

## 3. OpenAPI (`backend/api/openapi.yaml`)

- `ReportSummary` (:1672-1695): add required grossSales, grossOrders, grossByPaymentMethod, refundsByPaymentMethod (additionalProperties number double);
  rewrite description to pin each field per section 1.
- `DailySalesRow` (:1665-1671): add required grossSales, grossOrders, refunds, refundedOrders, netSales (money format double).
- `Order` (:1308, near refundedAt :1355): `refundBusinessDate` {string, format date, nullable}, optional (plain field, no $ref).
- New parameter `OrderDateBasis` (name dateBasis, enum [sale, refund], default sale) on listOrders (:4130): refund = dateFrom/dateTo bound the
  refund business day, only refunded rows, ordered by refundedAt; legacy from/to unaffected.
- `/reports/summary` 200 description (:4464, stale): "sales by sale business day, refunds by refund business day".
- Codegen: make gen-go in backend AND corepack pnpm --filter @mandalika/api gen; corepack pnpm gen:check; go run ./cmd/codegen -check.

## 4. Backoffice display

- ExportTab cards: "Penjualan Kotor" = grossSales (grossOrders sub-line); "Refund (hari refund)" = totalRefunds (refundedOrders);
  "Penjualan Bersih" = netSales, red when negative ("-Rp" must render); keep "Jumlah Transaksi" = totalOrders. Help line: "Refund dihitung pada
  hari refund, bukan hari penjualan. Daftar di bawah memakai hari penjualan."
- Breakdown Pembayaran: per method (key union) Kotor / Refund / Bersih; percentages of grossSales.
- CSV: add "Waktu Refund" (refundedAt) and "Hari Refund" (refundBusinessDate); second button "Export Refund CSV" via fetchAllPages over
  listOrders({...params, dateBasis:'refund'}); its Total column sums to the Refund card.
- ShiftsTab: relabel "Total Refund" -> "Refund penjualan shift" + tooltip (follows the shift that made the sale; Ekspor uses the refund day). Values unchanged.
- Dashboard (T7, ONLY if owner Q1 = yes): fetch sale side without status filter and drop cancelled client-side, plus
  listOrders({dateBasis:'refund'}) for the same window; revenue KPI + daily/monthly trend = net with "Kotor / Refund" subtitle; hourly "today" trend
  buckets refunds by local hour of refundedAt; payment breakdown = net; ranking/cashier/promo panels stay still-completed. New pure helper
  `netKpis(saleRows, refundRows, iv)` in metrics.ts. Stays on /orders so users without view_reports keep a dashboard.

## 5. Tests (tests first)

A. Extend `TestReportSummaryPostgres` (gate A27, port 56444; scripts/ci/postgres_gate.py:38 untouched). Fixture INSERTs with refunded_at so the
INSERT trigger stamps refund_business_date. Deliberately FLIPPED assertions (do NOT bend back): `wantKeys` (:173) gains grossByPaymentMethod,
grossOrders, grossSales, refundsByPaymentMethod; blanket `netSales == c.sales` (:181) becomes per-case `net` (add `gross` to scenario struct);
`refunded-only` (:98; sale 01-02, refund 01-10, window 01-02): gross 30, refunds 0, net 30, one daily row (sales 0, gross 30);
`completed100-refunded30` (:99): gross 130, refunds 0, net 130, totalSales 100; `late-refund-purchase-period` (:109): refunds 0, net 30;
`late-refund-settlement-period-not-posted` (:110) -> rename `...-posted`: refunds 30, refundedOrders 1, net -30, gross 0, one daily row 2026-01-10
(net -30), refundsByPaymentMethod {cash:30} (legacy-instants driven, proves the refunded_at mapping); `:204-206` "no daily rows when orders==0"
applies only when S and R both empty.
New sub-tests: (1) D1/D2/D3 table above (POS refund with refund_shift_id on a shift opened D3), assert every field/daily rows/both maps;
(2) refund with no shift at 23:50 WIB lands on that WIB day; refund at 00:30 on a shift opened 22:00 previous day lands on the shift's opening day;
(3) multi-outlet W (Asia/Jakarta) + M (Asia/Makassar): each a shift-less sale at 15:30Z 2026-10-19 (W 22:30 WIB, M 23:30 WITA, both 10-19) and a
backoffice refund at 16:10Z (W 23:10 -> 10-19; M 00:10 WITA -> 10-20); admin outletId=all, 10-19: gross W+M, refunds W, net M; 10-20: refunds M,
net -M; non-admin passing ?outletId=<other> stays on own outlet; (4) legacy-instant refund side bounded: refund outside [from,to) must NOT appear;
(5) status interplay: completed -> R empty; refunded -> gross = refunded sales in window, refunds = R; cancelled -> all 0; (6) invariants (unbounded
net==totalSales; sum daily net == net; maps sum to totals); (7) parity extends `summary-equals-sum-of-all-order-pages` (:416-430): grossSales ==
sum of completed+refunded rows across /orders pages; with dateBasis=refund totalRefunds == sum of rows and refundedOrders == meta.total;
dateBasis=bogus -> 400; legacy POS from/to byte-identical (TestPaginationPostgres stays green); (8) 0060 applies via db.Migrate and is idempotent;
backfill proof: disable trg_orders_business_date, insert refunded row with NULL refunded_at and NULL refund_business_date, re-enable, re-exec the
0060 body from the embedded FS, assert the row gets its sale day; both indexes in pg_indexes; (9) CloseShift snapshot untouched after the D3 refund.
B. Keep green: BD (56462), A26 pagination, QT, RF, OS, contract tests (contract_migration_test.go:219-250 walks ReportSummary floats generically);
check go test ./... finds no Order key-set pins.
C. Vitest: `reportTotals(saleRows, refundRows)` -> {gross, grossCount, revenue, completedCount, refunds, refundedCount, net, grossByPay,
refundsByPay} with the D1/D3 golden numbers; ExportTab renders negative net + refund-CSV params (dateBasis:'refund'); Dashboard netKpis tests
only if Q1 yes; quality:ci, browser:ci.

## 6. Risks

R1 historical numbers move at deploy: every refund whose refund day differs from its sale day moves; sale days regain refunded sales in gross/net;
netSales != totalSales for bounded windows. BEFORE DEPLOY run READ-ONLY on Neon: `SELECT count(*), sum(total) FROM orders WHERE status='refunded'
AND (refunded_at AT TIME ZONE 'Asia/Jakarta')::date <> (created_at AT TIME ZONE 'Asia/Jakarta')::date` and `SELECT count(*) FROM orders WHERE
status='refunded' AND refunded_at IS NULL`; show the owner. R2 cross-screen consistency: summary totalSales == list completed sum; grossSales ==
sale-basis list sum (completed+refunded); totalRefunds == refund-basis list/CSV sum; ShiftsTab and shift close will NOT match the Ekspor refund card
(intentional, relabelled); until Q1 ships the Dashboard stays on still-completed rows and differs from Ekspor net. R3 double-subtraction trap: net =
gross - refunds (Opus review checks this line). R4 unbounded refund CTE if the legacy-instant mapping is missed (test 5A.4). R5 perf: two CTEs + FULL
OUTER JOINs at 500k rows; 0060 partial indexes; EXPLAIN the cross-outlet 30-day case once locally. R6 deploy order backend first, then backoffice
(new backoffice on old backend gets undefined grossSales: render "–"). R7 frozen refund dates (A28). R8 summary/list cache TTL (handlers.go:98-121)
may be briefly stale after a refund (existing).

## 7. Tasks (TDD order)

| # | Task | Verify | Reviewer |
|---|---|---|---|
| T1 | Failing A27 gate cases + flipped assertions; failing reportTotals vitest | fail as expected | Opus |
| T2 | Migration 0060 | 5A.8; BD/A26/A27 green | Opus |
| T3 | OpenAPI + both codegens | gen:check, codegen -check | Opus |
| T4 | OrderFilter.DateBasis + appendOrderWhere; summary SQL; Orders refund ordering; orderObj refundBusinessDate; dateBasis parse/400 | full A27 gate, A26, BD, go test | Opus |
| T5 | ExportTab cards/breakdown/negative net, CSV cols, refund CSV; reportTotals | vitest, quality:ci | Haiku (Opus re-derives findings) |
| T6 | ShiftsTab relabel + tooltip | vitest/browser | Haiku |
| T7 | Dashboard net (ONLY after owner Q1 = yes) | metrics tests; browser:ci | Haiku |
| T8 | Docs, all gates, final review | full PG gate, quality:ci, browser:ci, go test, gen checks | Opus |

## 8. Release

Backend (mig 0060) + backoffice (Cloudflare on first non-skip push). No OTA/APK. Joins the held release: order 0058 -> 0059 -> 0060; backend first
with tablets at 0 pending; show the R1 counts first. Post-deploy smoke (today, 30 days, per outlet, all outlets): Refund card == refund CSV sum; Kotor
== sale CSV sum of completed+refunded; Bersih == Kotor - Refund; one live D1/D3 pair on a test outlet. Ask before every push, deploy and Neon read.

## 9. Owner questions

1. Dashboard headline revenue: follow the same rule (net = sales minus refunds on the refund day)? Recommended YES (builds T7). 
2. Product ranking and returns: count returned units as negative on the return day? Recommended: unchanged for now (follow-up F1).
Recorded technical defaults: legacy refunded rows without refund time = sale day; refunds grouped by original payment method; shift close keeps
its shift basis; customer lifetime totals untouched; grant and code reports keep current basis (F2).
