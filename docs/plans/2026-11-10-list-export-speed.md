# List and export speed: orders and customers (id-first pages, same-statement count, keyset export)

Date 2026-11-10 · base `origin/prod-hardening` @ `bc5b98da` (backend = `49506706`, the load-tested code) · status: PLAN (not started) · author: Opus planner
Source: `docs/qa/2026-11-10-load-test-local.md` on `origin/loadtest/step1-local`, "Slow statements and fixes" 1 and statement 3.

## Goal

Measured on the local load DB (`mandalika_load`, 1,018,650 orders, 500k customers):
1. `GET /orders`, all outlets, 30 business days (window is now **101,018** rows, not 92k: the C1 runs added today's orders), page 1 and page 200 at limit 50: p95 well under 1 s.
2. `GET /customers` list and `q=` search, page 1 and page 200: p95 well under 1 s.
3. Backoffice month export (sale basis, all outlets) under 30 s locally, through the real fetch path, without weakening A26.
4. Scope: `read.Repo.Orders`, `read.Repo.Customers`, the orders export. Every other `count(*) OVER()` list is a follow-up (list at the end).

## Architecture

**A. Offset pages (every existing caller, unchanged contract): id-first + same-statement count.**
One statement, one snapshot, so the total always matches the page (A26):

```sql
WITH t  AS (SELECT count(*) AS n FROM orders o <where>),
     pg AS (SELECT o.id, o.created_at FROM orders o <where>
            ORDER BY o.created_at DESC, o.id DESC LIMIT $L OFFSET $O)
SELECT CASE WHEN pg.id IS NULL THEN NULL ELSE <orderObj> END, t.n
  FROM t LEFT JOIN pg ON true LEFT JOIN orders o ON o.id = pg.id
 ORDER BY pg.created_at DESC, pg.id DESC
```

- The four correlated sub-selects of `orderObj` now run only for the page's rows, and the count is an index-only scan (`idx_orders_business_date`), not a `WindowAgg` over a full `idx_orders_created` scan (today's plan reads 1,018,650 index entries and filters 917,632).
- `t LEFT JOIN pg ON true` keeps the total on an empty page: one row with NULL JSON, which a new helper skips. **Behaviour change:** a page past the end now reports the real total instead of `total=0` (today `listJSON` sets 0 when no row comes back). Strictly more correct; covered by tests (Review Focus 4).
- **Filter evaluated once when it cannot use an index.**
  - With `q` or `paymentMethod` set, use a `f AS MATERIALIZED (SELECT o.id, o.created_at FROM orders o <where>)` CTE that both `t` (count) and `pg` (page) read from.
  - The plain two-CTE form evaluates the filter twice (once to count, once while walking `idx_orders_created` to the page). For `q=<order number>` over all orders that measured 2.1-2.3 s, against 1.1-1.2 s today. The MATERIALIZED form measured 1.0-1.1 s (JIT off).
  - For the index-friendly window (dates, outlet, shift, customer), the plain form is faster: 29/38 ms against 75/95 ms (p1/p200).
  - Broad terms checked too (JIT off, real output, two runs). MATERIALIZED is never slower than today in any of the five cases; the plain form loses badly on narrow terms:

    | q | matches | today | plain | MATERIALIZED |
    |---|---|---|---|---|
    | order number | 1 | 1.10-1.14 s | 2.08-2.11 s | 0.98-1.05 s |
    | phone | 1 | 1.19-1.22 s | 2.29-2.33 s | 1.08-1.11 s |
    | `Kasir L01-1` | 17,468 | 1.17-1.23 s | 1.02-1.09 s | 1.04-1.07 s |
    | `MND-1` | 100,001 | 1.13 s | 0.88 s | 0.93-0.97 s |
    | `Kasir` | 1,018,650 | 2.20-2.28 s | 0.89-0.92 s | 1.31-1.34 s |

  - `paymentMethod` is not measured: the load data is all cash.
- **JIT off for these reads.**
  - The CTE forms lose the LIMIT cost discount, so selective or unindexed filters get estimates in the millions. JIT then compiles with inlining and optimisation on every execution: q-search MATERIALIZED took 1.9-2.1 s with JIT and 1.0-1.1 s without.
  - `Orders`, `Customers` and `OrdersKeyset` therefore send a pgx batch: `SELECT set_config('jit','off',true)`, then the statement. It is one round trip and one implicit transaction, and the setting resets afterwards.
  - Checked only in psql, with the simple-query protocol: within one multi-statement Query the setting reads `off`, and the next Query reads `on`. pgx batches use the extended-protocol pipeline with one Sync. That they share one implicit transaction is an **assumption** that T1 test `jit-off-is-statement-local` must prove; if it fails, use an explicit tx (BEGIN, SET LOCAL, statement, COMMIT, three extra round trips).
  - DB test `jit-off-is-statement-local` (T1).
- Refund basis keeps its order key, computed once in `pg`: `(SELECT max(r.refunded_at) FROM order_refunds r WHERE r.order_id=o.id) AS k ... ORDER BY k DESC NULLS LAST, o.id DESC`, outer `ORDER BY pg.k DESC NULLS LAST, pg.id DESC`.
- Customers: the same shape. Three extra rules:
  - inner CTEs stay **unaliased** `FROM customers`, because `tagFilter` correlates through bare `customers.id` and `segmentIdSel` through bare columns;
  - `pg` renames its columns (`id AS pid, total_spent AS k1, created_at AS k2`), so `customerObjWithTags`'s bare columns stay unambiguous;
  - the text-match clause is added in Go only when `q != ""`, replacing `($3 = '' OR ...)`. Under a generic plan, the `$3 = ''` form scans the whole `idx_customers_spent`: 359 ms for a no-match term, against 3 ms with a custom plan.
- **Tie-break fix (deliberate change).** Customers sort `total_spent DESC, created_at DESC` and `created_at DESC` have no unique tail. A CSV import gives many rows the same `created_at` (tx `now()`) and `total_spent 0`, so offset pages can overlap (caught by the id check) or skip (not caught). Add `, id DESC` to both. Orders already end in `o.id DESC`; verified at `orders.go:61`.

**B. Orders export: keyset pages with a per-page count and a frozen upper bound.**
- New query params on `GET /orders` only: `paging=keyset` (enum) and `cursor` (opaque). Limit 1..1000 in keyset mode only. The shared `Limit` component (max 200), `pageLimit`, the `old-limit-truncation` subtest and `pageLimitGuard.test.ts` stay as they are.
- Each keyset page is one statement: the same `t` count, plus `pg` = `... AND (o.created_at, o.id) < ($c, $i) ORDER BY o.created_at DESC, o.id DESC LIMIT $L`. It also returns `pg.created_at, pg.id`, so the server builds `nextCursor` from the last row with microsecond precision (pgx `time.Time`, RFC3339Nano).
- **asOf freeze.**
  - The first keyset page (no cursor) applies `o.created_at <= statement_timestamp()` in BOTH its count and its page, and returns that same `statement_timestamp()` as `asOf` inside the cursor. Every later page adds `o.created_at <= $asOf` to both CTEs.
  - Page 1 must apply exactly the bound it hands out. A bound taken at tx start (`now()`) but not applied on page 1 would let a sale that commits between BEGIN and the snapshot be counted on page 1 and dropped later: a spurious failure.
  - T5 must also ship without asOf (a constructor flag, default per the owner's answer to Q1); the <30 s goal does not depend on it.
  - A sale that arrives after the export started is outside the frozen filter, so the total stays exact and stable, and the export does not fail on every new sale. Today any export that includes "today" during trading hours is very likely to fail: a 30-minute export always sees a sale.
  - Still detected:
    - a transaction that began before `asOf` but commits later (`created_at` = tx start) raises the count: the export fails;
    - a refund that changes `status` under a `status` filter changes the count: the export fails.
  - **Needs the owner's approval** (Q1).
- **Why keyset and not a bigger offset page.**
  - At limit 1000, deep offset pages measured 375-390 ms (an external sort of 101k ids spills under 4 MB `work_mem`), against about 142 ms for a keyset page. The offset estimate is about 34 s; keyset about 24 s (Expected timings).
  - Keyset is also safer under concurrent changes. A row that leaves the filter before the cursor shifts nothing, so it cannot cause a skip with an unchanged total (with offset it can, under a `status` filter).
- **JIT.**
  - Server default is `jit=on` (`jit_above_cost` 100000). The 1000-row statement crosses it and JIT compiles on every execution, about 70 ms a page: 23.1 s against 15.0 s of DB time for the whole export.
  - All three reads switch JIT off per statement (the batch above). The unfiltered 50-row list pages cost about 13k and would not JIT anyway; the 1000-row keyset page and the selective filters do.
  - Check `SHOW jit` on Neon (Q3).
- Keyset requests **bypass the Redis read cache**: about 2 MB a page (1,976,178 bytes measured for 1000 orders), with a unique key and never re-read. Upstash request-size limits make caching them a liability.
- Refund basis + keyset is rejected (400): `max(refunded_at)` is a mutable key. Refund-basis lists keep offset paging (A).
- The cursor is not signed. It only carries a position and `asOf`; scope and filters still come from the token and the query string, so a forged cursor cannot widen access.

**C. Backoffice fetcher.**
- New `fetchAllByCursor` in `packages/api/src/pagination.ts`, sharing one per-page validation core with `fetchAllPages`, which keeps its behaviour. The POS `recapData.ts` uses `fetchAllPages` and ships by OTA: no POS change.
- Checks, equivalent to A26:
  - meta valid;
  - page-1 total equals every later total;
  - `data.length === min(limit, total - collected)`;
  - ids non-empty and unique;
  - while `collected < total`, `nextCursor` must be a non-empty string, otherwise fail;
  - stop exactly when `collected === total`;
  - `MAX_PAGES` guard.
- No client-side key-order check: Go's RFC3339Nano trims trailing zeros, so `createdAt` strings do not sort lexically, and `Date` drops microseconds. The server's keyset predicate guarantees order; Go tests prove it.
- **Old-backend fallback.** If page 1 answers with `meta.limit !== 1000` or without a `nextCursor` while `total > data.length`, the old backend ignored `paging`. Restart with `fetchAllPages` (offset, 200): slow but correct. It never relies on the id-duplicate check to notice.

### Global constraints

- **A26 is not weakened.** Every page carries an accurate count for the same filter, computed in the same statement as the rows. No cached or approximate totals. Any count change between pages fails the whole export. Keyset adds no tolerance.
- Row order is unchanged: orders `created_at DESC, id DESC`; refund basis `max(refunded_at) DESC NULLS LAST, id DESC`; customers gain `id DESC` as the last key.
- No schema change and no new index: none was needed for the goals. A `(created_at DESC, id DESC)` index would only remove a cheap incremental sort (0.8 ms for 1000 ids).
- **Codegen gate.** Do not add top-level tests in `backend/internal/api` or `backend/internal/codegen`; `scripts/ci/codegen_gate.py` CONTRACT/GUARD are exact sets. Regenerate both outputs (`make -C backend gen`) and pass `corepack pnpm gen:check`.
- **Postgres gate.** New DB tests are **subtests of `TestPaginationPostgres`**. A new top-level `*Postgres` test needs a `GATES` entry and port in `scripts/ci/postgres_gate.py` (plus `gate_fixture_test.go`), or it is skipped in CI. `apps/backoffice/src/screens/paginationPostgres.test.ts` asserts the exact list of record names: update it with any new record.
- `nextCursor` is optional and **not** `nullable`: the `$ref`+nullable codegen gotcha does not apply. It lives on `OrderListResponse`, not on the shared `Meta`, so the codegen impact stays on one endpoint.

## Review Focus (five likeliest failure modes, each with its test)

1. **Drift slips through the new fetcher or the asOf bound.**
   - `pagination.test.ts`: `fetchAllByCursor rejects changed-total / short / duplicate / missing-cursor-before-complete / bad-limit on page 2`, plus `stops at total without an extra request`.
   - Go `TestPaginationPostgres/keyset-drift`:
     - after page 1, insert an order with `created_at` before `asOf` in the window: page 2's total is +1, and the client replay of the recorded pages fails;
     - insert one with `created_at = now()` (after `asOf`): the total is unchanged and the row is absent;
     - page 1 counts only rows with `created_at <= asOf`: an order with `created_at` 1 ms after the returned `asOf`, committed before page 1, is neither counted nor listed on any page;
     - refund an order under `status=completed`: the total changes.
2. **Ordering and tie-breaks across page boundaries.**
   - `TestPaginationPostgres/keyset-ties`: 2,501 orders on ONE `created_at`, plus two rows 1 µs apart straddling a page boundary.
     - Keyset pages of 1000 concatenate to exactly the offset order (`created_at DESC, id DESC`) with no gap or overlap.
     - The cursor round-trips microseconds.
   - `TestPaginationPostgres/customers-ties`: 450 customers with equal `total_spent` and `created_at`, both sorts. Pages are disjoint and in `id DESC` order.
3. **Filter and search parity** (the new SQL must return the same set as the old one).
   - `TestPaginationPostgres/orders-filter-parity`: for scope one/all, `dateFrom/dateTo`, `status`, `paymentMethod` (cash, split, a tender-line method), `q` with CustomerSearch on and off, `shiftId`, `customerId`, legacy `from/to` and `dateBasis=refund`:
     - new offset ids == the old `count(*) OVER()` statement (kept in the test file as `legacyOrdersSQL`), same order and same total;
     - for sale basis, keyset ids == offset ids.
   - `TestPaginationPostgres/customers-filter-parity`: `q` (name, phone, `phone_norm` path), `tagId`, `segmentId`, both sorts against `legacyCustomersSQL`. `tagId` guards the alias trap.
4. **Empty result, last page, past the end.**
   - Go `TestPaginationPostgres/empty-and-past-end`:
     - total 0: `data: []`, `total 0`, no `nextCursor`, no 500 from a NULL row;
     - total = an exact multiple of the limit: the last page is full;
     - offset page past the end: `data []` with the real total (new);
     - keyset with a cursor after the last row: `data []`, real total.
   - Backoffice: no `Customers` screen test exists. Extract the past-end redirect target in `Customers.tsx` (the effect near the export function) into a pure `pastEndPage(page, totalPages, rowCount)` and test it in a new `apps/backoffice/src/screens/customersPastEnd.test.ts`: `past-end page lands on the real last page`. The effect now gets a real `totalPages`, not 0.
5. **Speed regressions hidden by plan choice** (generic plan, JIT, cold heap).
   - Verification script `loadtest/sql/explain-lists.sql` (loadtest branch) runs every new statement under `plan_cache_mode=force_generic_plan` and with the server's default JIT.
   - Pass marks: orders p1/p200 < 150 ms, customers p1/p200 < 600 ms worst case, keyset page < 250 ms. R3a/R3b (q = order number / phone, all outlets) are no slower than today (about 1.2 s), measured through the real handler with the server left at its default `jit=on` (so the T1 batch must be what turns it off).
   - Go unit test `TestListStatementsHaveNoWindowCount` (package `read`, NOT `api`): the `Orders` and `Customers` SQL contains no `OVER()` and ends its ORDER BY with an `id` key.

## TDD tasks

Tier rule: Opus reviews anything touching generated types or money/payment projections or the A26 guard; Haiku otherwise.

**T1. Paged JSON helper + JIT-off batch (read).** Opus review: a deliberate upgrade (the A26 guard), not required by the tier rule.
- Files: `backend/internal/read/repo.go`, new `backend/internal/read/repo_paged_test.go`.
- Add `func pagedJSON[T any](ctx context.Context, p *pgxpool.Pool, sql string, args ...any) ([]T, int, error)`. It sends a `pgx.Batch` of the local `set_config` for `jit` and the statement, scans `(raw, total)` with `raw` nullable `[]byte`, skips a NULL `raw`, and returns the total even when no object row exists.
- DB subtest `TestPaginationPostgres/jit-off-is-statement-local`: inside the batch `current_setting('jit')` is `off`; the next query on the same connection reads the server default.
- Leave `listJSON` untouched: other lists still use it.
- Tests first: `TestPagedJSONSkipsNullRowAndKeepsTotal`, `TestPagedJSONEmptyResultIsZero`. Use a pgx-free seam: extract `decodePaged(rows rowScanner)` for unit tests.

**T2. `Repo.Orders` id-first + same-statement count.** Opus (money projection, A26).
- Files: `backend/internal/read/orders.go`, `orderfilter.go` (unchanged API; `where` is reused in both CTEs with the same placeholders).
- `materialize := f.Q != "" || f.PaymentMethod != ""` picks the MATERIALIZED form. Parity tests run both forms.
- Signature unchanged: `func (r *Repo) Orders(ctx context.Context, f OrderFilter, page, limit int) ([]api.Order, int, error)`. The only caller is `handlers.go:364`.
- Tests first: Review Focus 3 (`orders-filter-parity`), 4, and `TestListStatementsHaveNoWindowCount`.
- Verify: `go test ./internal/read/...`; `python scripts/ci/postgres_gate.py` (A26 gate); EXPLAIN on the load DB per Expected timings.

**T3. `Repo.Customers` id-first + count + tie-break + q built in Go.** Opus: a deliberate upgrade (A26 and the alias trap); the tier rule alone would say Haiku.
- Files: `backend/internal/read/customers.go`.
- Signature unchanged. `order` strings become `total_spent DESC, created_at DESC, id DESC` / `created_at DESC, id DESC`.
- Only `Customers` changes; `Interactions`, `PointTransactions`, `CustomerByPhone` and `CustomerByPhoneNorm` are follow-ups.
- Tests first: Review Focus 2 (`customers-ties`), 3 (`customers-filter-parity`), 4.

**T4. OpenAPI + codegen.** Opus (generated types).
- Files: `backend/api/openapi.yaml`, regenerated `backend/internal/api/api.gen.go` and `packages/api/src/schema.d.ts`.
- `listOrders`: add a `paging` query param (string, enum `keyset`) and a `cursor` query param (string, maxLength 512).
- Replace the `Limit` ref on `listOrders` only with an inline `limit` (minimum 1, maximum 1000, default 50), described as "max 200 unless paging=keyset". Note: the spec is not enforced at runtime (no request validator), so the handler is the authority.
- `OrderListResponse`: add an optional `nextCursor` (type string).
- Verify: `make -C backend gen`, `corepack pnpm gen:check`, `python scripts/ci/codegen_gate.py` (no new tests in `internal/api`).

**T5. Keyset read + cursor + handler.** Opus (A26, generated types).
- New file `backend/internal/read/order_cursor.go`:
  - `type OrderCursor struct { AsOf, CreatedAt time.Time; ID string }`;
  - `func EncodeOrderCursor(c OrderCursor) string` (base64url JSON, version 1);
  - `func DecodeOrderCursor(s string) (OrderCursor, error)` (strict: version, RFC3339Nano times, uuid).
- New file `backend/internal/read/orders_keyset.go`: `func (r *Repo) OrdersKeyset(ctx context.Context, f OrderFilter, after *OrderCursor, limit int) (rows []api.Order, total int, next *OrderCursor, err error)`.
  - Sent as the T1 batch (`set_config` + statement).
  - With no cursor, `asOf` is the statement's `statement_timestamp()`, applied in both CTEs and returned as a column. With a cursor, both CTEs add `o.created_at <= asOf` and the page adds `(o.created_at, o.id) < (cursor.CreatedAt, cursor.ID)`.
  - `next` is set iff `len(rows) == limit`.
  - Rejects `f.refundBasis()`.
  - Keyset with `q` or `paymentMethod` uses the plain form. The count must still scan the whole filtered set up to `asOf`, so a q-filtered export costs about one full filter scan per page (about 1 s), the same as today. Such sets are small, few pages, except for broad terms. The cursor predicate goes on the page CTE only, never on the count.
- `backend/internal/handlers/handlers.go` `Orders`:
  - `paging=keyset` skips `h.cached`;
  - `keysetLimit(r)` gives 400 outside 1..1000; there is no silent clamp in the new mode;
  - 400 for: `cursor` without `paging`, `page` > 1 with `paging`, `dateBasis=refund` with `paging`, a malformed cursor;
  - `Meta{Total, Page: 1, Limit}` plus `NextCursor`.
- Tests first:
  - unit `TestOrderCursorRoundTripKeepsMicroseconds`, `TestDecodeOrderCursorRejectsTampered` (package `read`), `TestKeysetParamValidation` (package `handlers`, no DB);
  - DB subtests from Review Focus 1, 2 and 4;
  - `TestPaginationPostgres/keyset-scope`: a cashier's cursor replayed with `outletId=all` still sees only its own outlet.

**T6. `fetchAllByCursor` + client type.** Opus (A26 guard in the client).
- Files: `packages/api/src/pagination.ts`, `packages/api/src/index.ts` (export), `packages/api/src/client.ts`:
  - `listOrders` returns a `ListResult` of `Order` widened with an optional `nextCursor` string;
  - `ListOrdersParams` picks up `paging`/`cursor` from the generated types.
- Signature: `fetchAllByCursor(fetchPage: (cursor: string | undefined, limit: number) => Promise<CursorListResult<T>>, fallback: () => Promise<T[]>): Promise<T[]>`, with `T extends { id: string }`, `type CursorListResult<T> = ListResult<T> & { nextCursor?: string }`, and an exported `KEYSET_PAGE_SIZE = 1000`.
- Refactor the per-page checks of `fetchAllPages` into a shared `checkPage(...)`, without changing its messages or behaviour (the existing `pagination.test.ts` stays green unmodified). The `meta.page === page` check stays on the offset path only: every keyset page reports `page: 1`.
- Tests first, in `apps/backoffice/src/screens/pagination.test.ts`: the Review Focus 1 cases, `falls back to offset paging when the backend ignores paging=keyset`, and `retrieves 0/1/999/1000/1001/101018 rows with ceil(total/1000) calls`.

**T7. Backoffice exports use keyset.** Haiku review (UI wiring only; T6 holds the guard).
- Files: `apps/backoffice/src/screens/Orders.tsx` `handleExport`, `apps/backoffice/src/screens/reports/ExportTab.tsx` `runExport('sale')`, `apps/backoffice/src/screens/customers/CustomerDetail.tsx` (orders of one customer).
- Each calls `fetchAllByCursor` with a page function that sends `paging: 'keyset'`, the cursor and the limit, and a fallback to the existing `fetchAllPages` call.
- Not changed:
  - `fetchDashboard.ts` (an old-backend fallback only);
  - the refund export (it uses `/refund-report`);
  - `RefundReportTab`.
- `pageLimitGuard.test.ts` scans `apps/backoffice/src` for limit literals above 200. The literal 1000 lives in `packages/api`; add a guard case `keyset page size is only used through fetchAllByCursor`.
- Tests: there are no `Orders.tsx` / `ExportTab.tsx` tests today. Keep the screens thin: each passes a page function to `fetchAllByCursor`, which T6 already tests. Add one new `apps/backoffice/src/screens/ordersExportPaging.test.ts`, `Orders export pages by cursor and keeps server order`, against an extracted `orderExportPager(api, params)`.

**T8. Load-test proof.** Haiku (harness only), on the `loadtest/step1-local` branch.
- `loadtest/run-reads.mjs`:
  - add R6k: the keyset export through the same validation as `fetchAllByCursor`, admin and manager;
  - add R2a/R2b/R5a with generic-plan pressure: more than 5 identical requests per connection before timing.
- Add `loadtest/sql/explain-lists.sql` (Review Focus 5).
- Pass marks: Goals 1-3. Record the results in a new section of the results doc. Run once on the current CLUSTERed heap and state that.

## Expected timings (measured 2026-11-10 on `mandalika_load`, warm, CLUSTERed `orders` heap)

SQL time is `EXPLAIN ANALYZE` of PREPAREd statements with default settings unless stated; "generic" = `plan_cache_mode=force_generic_plan`.

| Request | Today | New SQL (custom plan) | New SQL (generic plan) |
|---|---|---|---|
| orders p1, limit 50, 30 d, all outlets | 1,870 ms (plan reads 1,018,650 index rows) | 30-53 ms | 71 ms |
| orders p200 (offset 9,950) | about 1,000 ms (R2b p95 0.99 s) | 43 ms | 92 ms |
| orders refund basis, 200 rows | 362 ms | 167 ms first / 64 ms deep | not measured |
| customers `q=''` p1 / p200 | 898 / 809 ms | 38-42 / 44-51 ms | 252 / 176 ms |
| customers `q=Budi` (10k matches) p1 / p200 | 871 ms / not measured | 50-78 ms warm (470 ms first, cold) / 78 ms | 64 / 503 ms |
| customers `q=Qzx` (no match) p1 | not measured | 4 ms | 413 ms |
| orders `q=<order number>` (R3a), all orders, CustomerSearch on, JIT off, real output | 1,104-1,140 ms | plain form 2,080-2,114 ms (**regression**); MATERIALIZED form **984-1,048 ms** | MATERIALIZED with JIT on: 1,914-1,971 ms |
| orders `q=<phone>` (R3b), same | 1,195-1,218 ms | plain 2,293-2,327 ms; MATERIALIZED **1,080-1,108 ms** | not measured |
| orders `shiftId` (72 orders, POS recap path), limit 200 | 44 ms (generic 11) | 9 ms | 6 ms |
| orders `customerId` (2 orders, CustomerDetail), limit 1000 | 4.4 ms (generic 1.0) | 1.8 ms | 1.0 ms |

The q-search rows show q-search is not sped up; it is held at today's cost only with the MATERIALIZED form and JIT off. The fix is the trigram-index follow-up. Without JIT off and MATERIALIZED, this slice would regress R3 by about 2x.

Today's interactive HTTP overhead on a 50-row page is about 3-5 ms (the cache-hit row of the results doc), so HTTP p95 should land at about SQL + 5 ms.

**Export, 101,018 orders, 101 keyset pages of 1000** (measured: a chained psql session, real output via `\o /dev/null`, PREPAREd):

| Part | JIT on (server default) | JIT off |
|---|---|---|
| DB statements, all pages | 23.1 s (p50 209, p95 332 ms) | **15.0 s** (p50 142, p95 177, max 196 ms) |
| Go `json.Unmarshal` into `api.Order` + `json.Marshal` of the response (measured: a scratch benchmark on 1000 real rows, the generated `api` package) | 6.5 s (40-51 + 17-21 ms a page) | 6.5 s |
| HTTP + browser `JSON.parse` of about 2 MB a page | about 2-3 s (estimate, not measured) | about 2-3 s (estimate) |
| **Total** | **about 32 s (misses)** | **about 24 s (meets)** |

- Offset paging at limit 1000 for comparison: pages 115 / 171 / 390 / 375 ms at offsets 0 / 30k / 60k / 90k (an external sort spill), about 34 s in total. At limit 200 (today's shape, new SQL): about 506 pages × (25 ms count + 14 ms rows + overhead), about 30 s, and at 20 req/s it collides with the production per-IP limit of 20 rps / 40 burst.
- The first, cold 1000-row page took 416-651 ms (3,751 blocks read); warm 142-172 ms.
- **CLUSTER dependence.** Every number above is on the `orders` heap CLUSTERed by `idx_orders_created` (correlation -1, like production's chronological inserts).
  - On a random heap, each 1000-row page adds up to 1000 random heap reads when cold.
  - `order_items` / `order_tenders` / `order_refunds` were not clustered (seeded in random day order), so the child probes are already pessimistic.
  - The count is index-only and depends on the visibility map (VACUUM state), not on heap order: the results doc's 203 ms random-heap count was before a full VM.
- Production (Neon, round trips of several ms, 2 MB uncompressed responses over shop Wi-Fi) is not covered by these numbers (Q4).
- If T8 measures more than 30 s end to end, the next levers are:
  - set-based child aggregation for a page (one grouped query per child table instead of per-row sub-selects; about 0.07 ms a row today);
  - skipping the Go decode/re-encode (6.5 s). That is not free: `omitempty` changes null-versus-absent keys on the wire.

## Release order

1. **Backend first** (T1-T5): one Cloud Run revision.
   - The offset path keeps its wire contract, except that a past-end page now returns the real total.
   - `paging`/`cursor`/`nextCursor` are additive. Old Backoffice builds never send them.
2. **Backoffice second** (T6-T7): Cloudflare Pages on push. A Backoffice that reaches an old backend falls back to offset paging (T6), so a reversed or rolled-back deploy is slow, never wrong.
3. POS: no change, no OTA, no APK.
4. T8 rides on the loadtest branch and is not deployed.

## Follow-ups (not in this slice)

- Other `count(*) OVER()` lists: `catalog.go:99,105`, `customers.go` (`Interactions`, `PointTransactions`, `CustomerByPhone`, `CustomerByPhoneNorm`, `CustomerLookup`), `dupcandidates.go:21`, `error_logs.go:42`, `goods_receipt_list.go:69`, `ingredient_transfers.go:77`, `inventory_approvals.go:51`, `products_filtered.go:79`, `promotions_page.go:93`, `refund_report.go:63` (the refund CSV export, same fetchAllPages cost), `reminders.go:71`, `requisition.go:88`, `shifts.go:49,140`, `stock_counts.go:37`, `syncreview.go:55`, `transfers.go:88,104,113`, `users.go:16,42`, plus `dashboard.go` / `ingredient_stock_counts.go` (named by the load agent).
  - All are small tables today. The T1 helper makes each a mechanical change, but each needs its own parity test, so they are not bundled.
- `GET /orders?q=` (R3, about 1.1 s): the count must evaluate `ILIKE` over the whole window. It needs trigram indexes on `orders(order_number)`, `(customer_name)`, `(cashier_name)` plus resolving the customer match first. Not measured (an index build on 1M rows inside a rolled-back tx was not attempted on the shared DB).
- The customer export (500k rows = 2,500 pages at 200; deep offsets about 500 ms) and its mutable `total_spent` sort key (Q2).
- `reports/summary` and `reports/dashboard` rollups (results doc section 2).

## Decisions (2026-11-10)

The owner said "Yes, fix it" and has standing preference "use your recommendations"; Opus answered the planner's questions with these recommendations, and the owner may veto any of them.

1. **asOf freeze: yes.** An export includes the orders received up to the moment it started (server receive time). The Backoffice states the cut-off time next to the export (for example "Data s.d. 10 Nov 14:52"). The drift checks stay equivalent to A26 within that snapshot: total, row count, unique ids, and complete pages.
2. **Customer export by spend: a follow-up, not this slice.** Paging customers in creation order and sorting in the browser goes on the follow-up list. This slice only adds the `id DESC` tie-break.
3. **JIT off per statement: yes**, for these list and export reads only, set inside the same implicit transaction as the query. The first task's test must prove that `SET LOCAL jit = off` reaches the query: that it holds for the pgx batch, and that it holds behind a transaction-pooling endpoint (Neon pooled). If it cannot be proven, use an explicit short transaction instead. It must not depend on Neon's server-level `jit` setting.
4. **Response compression: a separate slice.** About 2 MB per 1000-row page is acceptable for now.
