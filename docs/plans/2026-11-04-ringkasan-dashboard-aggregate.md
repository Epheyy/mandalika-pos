# Ringkasan server aggregate: `GET /api/v1/reports/dashboard`

Date: 2026-11-04. Status: plan, critiqued by the Opus `planner` (section 9 lists what changed). Branch `perf/ringkasan-dashboard-aggregate`
off `prod-hardening` (after #61). Scope: backend read endpoint + OpenAPI + generated types + Ringkasan reads it (fallback to today's client math)
+ a parity proof. No migration (unless the scale check in section 6 says otherwise), no POS, no OTA, no deploy.

## 1. Problem

`screens/Dashboard.tsx` polls every 12 s: `fetchAllPages(listOrders)` for the window (current + previous period, sale basis) and again with
`dateBasis: 'refund'`, 200 orders per page, each order with items/tenders/refunds JSON. "Semua" is unbounded. `screens/dashboard/metrics.ts` then computes
every number in the browser. At 30k-500k customers one open Ringkasan downloads the whole period twice every 12 s. `GET /reports/summary` covers only part
of the numbers (it lacks items sold, customers, cashiers, promo tally, variant ranking, previous-period deltas, hourly trend), so it cannot replace this.

## 2. Contract

`GET /api/v1/reports/dashboard` (operationId `reportDashboard`, tag `reports`). Same scope rules as `/orders`: `scope(r)` (token role + outlet; admin-only
`?outletId=all|<id>`; `X-Outlet-Id` header handled by the existing middleware, a foreign one is a 403 for a non-admin). Never a raw outletId.

| query param | meaning |
|---|---|
| `dateFrom`, `dateTo` | current window, business days `YYYY-MM-DD`, inclusive. `dateFrom` omitted = open start (period "Semua"; the client still sends `dateTo` = today) |
| `prevDateFrom`, `prevDateTo` | previous window (deltas). Both or neither. Omitted = none ("Semua"). Must end before the current window starts (else 400: windows are disjoint) |
| `trend` | required `hour` / `day` / `month` (today / 7d+30d / all). Granularity only; labels and zero-fill stay client-side |
| `tzOffset` | minutes east of UTC of the viewer's browser (`-getTimezoneOffset()`), only read when `trend=hour`; range -840..840 |

The client computes the windows from the browser clock with the SAME `periodInterval` / `prevInterval` / `localDay` as today, so they are byte-identical to today's.
Response `{ data: DashboardAggregate }`; money `format: double` (like `ReportSummary`); `previous` is OPTIONAL (absent, not null: openapi-typescript drops `nullable` on `$ref`):

```
DashboardAggregate {
  current:  DashboardWindow
  previous?: DashboardWindow
  trend:    DashboardTrendBucket[]       // sparse, current window; client zero-fills
  grossByPaymentMethod:   {method: number}   // current window, methods that had a payment line
  refundsByPaymentMethod: {method: number}   // current window, by refund day, by payout method
  topProducts:    DashboardProductRow[]  // <= 10
  bottomProducts: DashboardProductRow[]  // <= 10 (= the reverse of the full ranking)
  distinctProducts: int                   // ranking.length ("N jenis produk")
  cashiers: DashboardCashierRow[]         // <= 8
  promoTally: DashboardPromoRow[]         // labels equal to some promotions.name only
}
DashboardWindow { gross, grossCount, refunds, refundedCount, net,                // NetKpis
                  orders, itemsSold, customers, stillSoldRevenue }               // Kpis (revenue = stillSoldRevenue, only used for AOV)
DashboardTrendBucket { bucket: 'HH'|'YYYY-MM-DD'|'YYYY-MM', sales, orders, refunds }
DashboardProductRow  { productId, productName, variantSize, qty }   // client builds the display name `${productName}${size ? ' '+size : ''}`.trim()
DashboardCashierRow  { id, name, transactions, revenue }
DashboardPromoRow    { label, count, amount }
```

Access: registered next to `/orders` (any authenticated user, outlet-clamped), NOT under `view_reports`. `view_dashboard` is a UI-only permission and `/orders` (full rows)
is open to every authenticated user today; a `view_reports` gate could 403 a dashboard-only role that works today. The aggregate exposes strictly less than `/orders`.
Cache: `h.cached(ckey(r))`, the same 15 s `readTTL` and key shape as `/orders` (`customerScope` only changes `q`, which this endpoint has not).

## 3. Field mapping (what replaces what)

| Ringkasan number | Today (`metrics.ts`) | Aggregate field |
|---|---|---|
| Penjualan (net), Kotor, Refund | `netKpis` -> `reportTotals` | `current.net/gross/refunds` |
| delta Penjualan | `delta(net, netPrev)` | client `delta(current.net, previous?.net)` |
| Transaksi, AOV | `computeKpis.orders`, `revenue / orders` | `current.orders`, `current.stillSoldRevenue` |
| Produk Terjual | `computeKpis.itemsSold` | `current.itemsSold` |
| Pelanggan | `computeKpis.customers` (distinct customerId) | `current.customers` |
| deltas of the 3 above | `computeKpis(prev)` | `previous.*` |
| Tren Penjualan (Bersih) | `buildTrend(salesIn, period, now, refundsIn)` | `trend[]` (revenue = sales - refunds) + client skeleton |
| trendEmpty | all-zero && no refund orders in window | all-zero && `current.refundedCount == 0` |
| Metode Pembayaran | `netPaymentBreakdown` | `grossByPaymentMethod - refundsByPaymentMethod`; client labels + sort |
| Top / Bottom 10, "N jenis produk" | `productRanking` | `topProducts`, `bottomProducts`, `distinctProducts` |
| Promosi | `promoUsage(completed, promotions)` | `promoTally` joined to the client's `promotions` list by name (no dedupe: duplicate promotion names keep today's double row) |
| Performa Kasir | `cashierPerformance(completed, 8)` | `cashiers` |
| Barang Habis | `lowStock(products)` | unchanged, client-side on the #61 product cache |

Semantics copied from the client (the oracle is the screen):
- Sale set = `completed | partially_refunded | refunded` by SALE business day (gross, gross count, trend sales/orders, gross-by-method). Completed set = `completed | partially_refunded`
  (orders, itemsSold, customers, ranking, promo, cashiers, stillSoldRevenue = `SUM(total - sum(refund rows))`, unclamped, = `stillSoldMoney`).
- Refund set = `order_refunds` rows of orders whose status is `refunded | partially_refunded` (mirrors `isRefundedStatus`) by REFUND business day; refundedCount = distinct orders;
  refunds-by-method keyed `COALESCE(NULLIF(r.payment_method,''), o.payment_method)` (mirrors `refundSlices`). Never derived from `sbl.paid_out`.
- Sold quantity of a line: `GREATEST(quantity - (partially_refunded ? sum(order_refund_items.quantity) : 0), 0)` (`soldQty`). The ranking is written out in full, NOT copied from
  `ReportSummary.prod` (that drops fully returned lines, groups by product only, names `MIN(product_name)` and sorts by revenue): group by `(product_id, variant_size)`,
  keep 0-qty lines, name = the newest order's `product_name` (`created_at DESC, id DESC`, the list order).
- Hour bucket (trend=hour): sale hour = hour of `created_at` shifted by `tzOffset`; refund hour = hour of `refunded_at` shifted by `tzOffset` (client: browser-local `getHours()`
  of `createdAt` / the refund's `refundedAt`). The sale day stays the business day; a refund counts in the hourly view only when its refund day is in the window (today).
- Promo tally: per order, each `discount_breakdown` element when it is a non-empty jsonb ARRAY (guard like `promo_reports.go`: SQL NULL, jsonb `null` and `[]` all fall to the label path),
  else `discount_label` with `discount_amount`; skip empty labels; `count += 1` per element (the same label twice in one order counts 2); amount cast defensively (non-numeric = 0).
- Window figures, items, customers and stillSoldRevenue read `sb` (one row per order), never `sbl`, so split-tender orders are not multiplied. `grossByPaymentMethod` reads `sbl WHERE has_line`
  (a refund paid out in a method the sale never used would otherwise add a `cash: 0` key the screen does not show) restricted to the CURRENT window's `business_date`.
- Ties: today's order is deterministic apart from ties, because JS sort is stable over first-seen order in the `created_at DESC, id DESC` list. The server reproduces it:
  rank every completed order newest-first, tie-break by `MIN(rank)` of the groups' orders (top: qty desc, first-seen asc; bottom: qty asc, first-seen desc = the reverse; cashiers: transactions
  desc, first-seen asc), then `product_id, variant_size` / cashier id. Ties inside ONE order stay unspecified (`json_agg` has no ORDER BY today). The payment mix breaks ties by method name
  (today: tender insertion order, not reproducible from a map). The fixture contains ranking and cashier ties.

Known quirks kept on purpose (every number stays identical; each is a follow-up candidate, not part of this change):
1. A fully returned line of a partially refunded order stays in the ranking at 0 Pcs (bottom list) and counts in "jenis produk".
2. A product/cashier renamed over time shows the newest order's name.
3. `refundedQty` greater than `quantity` clamps at 0.

## 4. SQL approach (one statement, one snapshot)

`read.Repo.DashboardAggregate(ctx, DashboardFilter)` in `backend/internal/read/dashboard.go`. It reuses `appendOrderWhere` (the same scope code path as the list and `/reports/summary`)
with one filter copy per side over the UNION window (`prev.from .. cur.to`, or open): sale set `sb` (basis sale, status IN completed/partially_refunded/refunded) and refund set `rb`
(basis refund, one row per `order_refunds`, joined to `orders` for scope, and `AND r.outlet_id = $scope` when scoped so `idx_order_refunds_outlet_day` can serve it).
Each row falls into exactly one window through a 2-row `VALUES` table (`'cur'`, `'prev'`, bounds typed `::text::date` like `orderfilter.go`, an open start = `COALESCE(f, '-infinity'::date)`;
`BETWEEN NULL AND t` would match nothing).

- `sb`: MATERIALIZED, like `ReportSummary`'s unfiltered `sb` (`net_total = total - refunded` from one grouped LEFT JOIN over the refunds of the sale set) plus `created_at`, `customer_id`,
  `cashier_id`, `cashier_name`, `discount_label/amount/breakdown` and a newest-first `rank`.
- `sbl`: `summaryLinesCTE("sb")` for the by-method gross map (`has_line` only, current window).
- Per-window aggregates over `sb` with `FILTER`; items joined once for the completed set; `customers = count(DISTINCT customer_id)` (NULL skipped, uuid cannot be '').
- Ranking CTE: `GROUP BY product_id, variant_size`, `row_number()` both directions, top/bottom 10 + `count(*)`. Cashier CTE: top 8. Promo CTE joined to `(SELECT DISTINCT name FROM promotions)`.
- Trend: sale buckets and refund buckets FULL OUTER JOINed by bucket key, current window only.
- A refund row without `refund_business_date` cannot occur (trigger stamps it, `refunded_at` NOT NULL); confirm with a zero count on Neon read-only before relying on it.

Handler `h.DashboardAggregate`: `dayRange` on the four dates, `trend` enum and `tzOffset` range validated (400 `parameter ... tidak valid`), overlap/half-open previous = 400.

## 5. Frontend

- `packages/api` client `reportDashboard(params)`; types from the regenerated schema.
- `screens/dashboard/aggregate.ts` (pure): `dashboardAggregateParams(period, now)`, `viewFromAggregate(agg, period, now, promotions)`, `viewFromOrders(sale, refund, period, now, promotions)` (= today's inline
  computation moved out of `Dashboard.tsx`, unchanged; used by the fallback and as the parity oracle). Both return one `DashboardView`.
- `Dashboard.tsx` renders a `DashboardView`. The poll fetcher tries the aggregate; on `ApiError` status 404/405 (route missing, older backend) it falls back to today's two-list fetch and remembers
  "unsupported" for 5 minutes (then re-probes, so a backend deployed mid-session is picked up). Any other error is NOT swallowed (previous data stays, error shows). Refresh stays 12 s. The fetch records its
  own `now`; the view (windows, trend skeleton) is built with that same `now`, so a render across midnight cannot mix days. Low-stock keeps reading the #61 product cache; promotions keep their 60 s poll.

## 6. Indexes and scale (measured)

No migration. The statement uses `idx_orders_outlet_business_date` / `idx_orders_business_date` (sale window), `idx_order_refunds_outlet_day` (refund window, with the added `r.outlet_id`
predicate), `idx_order_items_order`, `idx_order_refund_items_item` and tender lines via `tenderlines.SetLines`; `EXPLAIN (ANALYZE, BUFFERS)` was read for the "Semua" one-outlet statement only: index scan on `idx_orders_business_date` for the window, bitmap scan on `idx_order_refunds_outlet_day`,
a hash join over `order_items` (a seq scan of the whole table, which is the window there) and a parallel seq scan of `orders` inside the refunds semi-join. The plans of the narrow windows were not
inspected; their timings below are the evidence.
Measured on a throwaway local PostgreSQL 18 (never Neon): 300k orders over 12 months (about 830 a day, 2 outlets, 900k items, 7.5k refunds, 50k customers), default `work_mem` (4 MB, so the sorts spill):

| window | cross-outlet | one outlet |
|---|---|---|
| today (+ yesterday) | 27-68 ms | - |
| 7 days (+ previous 7) | 0.29 s | - |
| 30 days (+ previous 30) | 1.0-1.1 s | 0.6 s |
| "Semua" (150k-300k orders) | 8.2-9.5 s | 4.5-4.9 s |

Cost is linear in the orders of the window; the time goes to sorts and scans of `sb` (about 0.5 s per 150k orders for the build, about 1 s for the items join, 0.3-0.9 s per grouped pass).
Today the same screen downloads and JSON-parses every order of the window twice per poll, which at this size is minutes and hundreds of MB, so the aggregate is strictly cheaper, but "Semua" is
not cheap at 3M orders (about 80 s). Mitigations in this change: a 20 s deadline on the statement (the query is cancelled, the screen keeps its previous numbers and shows the error) and
the existing 15 s read cache. Not done, owner decision when it matters: serve "Semua" from a daily rollup table or accept a 60 s freshness for that one period (the read cache is dropped on every write,
so on a busy fleet it does not save the recompute). The cross-outlet refund window reads `order_refunds` by `refund_business_date` alone, which `(outlet_id, refund_business_date)` does
not serve on PostgreSQL < 18; the refund set is small (7.5k rows here) so it did not show up.

## 7. Parity proof (the main risk)

Fixture dir `tests/fixtures/dashboard-parity/`:
- `seed.json`: a compact order spec the Go test seeds (2 outlets, one of them WITA; 3 cashiers; customers; products). Coverage: completed; partially refunded (one refund; two refunds on different days;
  a line with `refundedQty` > quantity); fully refunded (legacy full; refunded later in the same period, next month); cancelled; split tender (2-3 lines); cash/card/qris/transfer; promos + discount
  code + multi-component breakdowns + a label with no promotion + duplicate label in one order + a jsonb `null` breakdown and a `[]` breakdown each with a label; an after-midnight shift sale (business day
  != created day); orders on first/last day of each window and one outside; a sale OUTSIDE the union window refunded INSIDE the current window; an order with refund rows in both prev and cur; a refund paid out
  in a method the sale never used (inside and outside the window); two lines of the same product+variant in one order; a renamed product; a customer in both windows; fractional amounts (cents);
  ties in ranking and cashier counts.
- `scenarios.json`: fixed `now` x period (`today`, `7d`, `30d`, `all`) x scope token (admin all, admin outlet A, cashier A, cashier A with a foreign `?outletId`, WITA outlet) with the exact query string
  the client sends, + the promotions list.
- `list-dumps.json`: what the REAL `GET /orders` returned after seeding, for the exact parameters Dashboard sends (sale basis and `dateBasis=refund`, limit 200, per scenario window + token).
- `expected-view.json`: the `DashboardView` per scenario, computed by TODAY's `metrics.ts` from the dumps (frozen; `UPDATE_DASHBOARD_PARITY=1` rewrites it, a diff must be justified).
- `expected-aggregate.json`: the raw endpoint response per scenario.

Assertions (chain: real list -> metrics.ts -> view <- map <- aggregate <- Go SQL over the same rows):
1. Go gate `TestDashboardAggregatePostgres` (port 26479, prefix `DB`): seeds `seed.json` in the order insert-as-completed, insert `order_refunds` + `order_refund_items`, THEN `UPDATE` status
   (an order inserted already `refunded` triggers the legacy full-refund row and the 0059 stamping), through the real handlers/router/tokens: (a) `GET /orders` for every scenario param == `list-dumps.json`;
   (b) `GET /reports/dashboard` == `expected-aggregate.json` (exact; money is numeric(14,2) rendered as decimal text). `UPDATE_DASHBOARD_PARITY=1` rewrites (a)/(b) locally for review.
2. vitest `dashboardParity.test.ts` (asserts `TZ=Asia/Jakarta`): `dashboardAggregateParams(period, now)` == `scenarios[i].query` (windows cannot drift between hops); `refundSideOrNull(dump)` is not null;
   `viewFromOrders(dumps)` == `expected-view.json`; `viewFromAggregate(expected-aggregate.json)` == `expected-view.json` (money at cent precision, everything else exact); fixture self-check
   (`refunds[].items` add up to each item's `refundedQty`, `refundedAmount` = sum of refunds).
Go-only in the same gate: scope IDOR (cashier + foreign `?outletId` -> own outlet; cashier + foreign `X-Outlet-Id` -> 403; admin `all`), 400s (bad date, bad trend, bad tzOffset, half-open previous, overlapping
windows), empty window (zeros, empty arrays, `previous` absent), refund inside the window of a sale outside it, no mutation (row snapshot before == after).
Frontend: vitest for the 404 fallback + re-probe; existing browser scenarios (BO-PAGES-CSV, BO-CATALOGUE-CACHE) mock only `/orders`, the unmocked new route answers 404, so they exercise the fallback; a new browser
scenario serves the aggregate and asserts the same Ringkasan numbers and one request per poll (`deepLink`).
Gate wiring: `scripts/ci/postgres_gate.py` `("DB", "TestDashboardAggregatePostgres", 26479, "db")`, `.github/workflows/postgres.yml` reserved ports `26439-26479`, `scripts/ci/README.md`; the `PortPlan`
self-test (unique, < 32768) covers it. The test lives in `internal/handlers`, so `codegen_gate.py` CONTRACT/GUARD stay unchanged (verified by running the gate).

## 8. Rollout / compatibility

Additive route and schema, no migration. Cloudflare Pages deploys on push to `prod-hardening`; the backend deploy needs the owner's word. Best order is backend first, but the frontend falls back to today's
computation on 404 (and re-probes every 5 minutes), so either order has no broken window. Old frontend ignores the new route.

## 9. Critique folded in (Opus planner, 2026-11-04)

BLOCKER 1 ranking SQL contradicted quirk 1 -> written out in full (section 3). BLOCKER 2 hop 1 ran on hand-written data -> `list-dumps.json` from the real `/orders`, params + seeding order pinned (section 7).
SHOULD: open-start window join (4), hourly bucket identical to browser-local (`tzOffset`, replaces the outlet-timezone proposal; WITA outlet in fixture), `sbl.has_line` (the "always true" claim was only true for `sb`),
jsonb guard, real tie-break, `previous` optional, `r.outlet_id` + `EXPLAIN (ANALYZE, BUFFERS)`, cents in fixture, wider fixture list. NICE: NULL refund day cannot occur + status filter on `rb`, 403 for foreign
`X-Outlet-Id`, fetch-time `now`, rollout wording, re-probe, Opus review tier. Not verified (no access): real outlet timezones on Neon, whether production totals carry cents (fixture covers both), real timings.

## 10. Decisions taken (veto-able, none blocking)

Review (Opus `reviewer`, 2026-11-04) HIGH fixed: label-only orders with a SQL NULL breakdown were dropped from the promo tally (`NOT (NULL AND NULL)`); fixture now covers it, a `[]` breakdown with a listed promotion, 19 ranked products and 12 cashiers (top 10 / top 8 truncate). MEDIUM: scale measured above, deadline added; plan/commit completeness fixed; `isAggregate` guard covers every required field. Accepted LOW: ties between lines of ONE order follow `product_id` (the list's item order is unspecified), payment-mix ties by method name, `tzOffset` is the offset at fetch time.


(a) Open to any authenticated user like `/orders` (not `view_reports`). (b) Quirks 1-3 kept. (c) `has_line` rule: nothing to decide: the dashboard sends no payment-method filter, so the aggregate counts the same
orders as the client; the one place `has_line` matters (`sbl`) is handled explicitly. Review tier: Opus `reviewer` on the generated types, money numbers and outlet scope.
