# Performance follow-ups, wave 2: order search, reports, remaining lists and quick wins

Date 2026-11-11 - base `origin/prod-hardening` @ `e7e8d2d4` (#140 live: backend 00181-yus, Backoffice 685633a1) - status: PLAN (not started) - author: Opus planner
Source: `docs/qa/2026-11-10-load-test-local.md` (`origin/loadtest/step1-local`) and the "Follow-ups" of `docs/plans/2026-11-10-list-export-speed.md`.
Targets: 30+ outlets, 50k-500k customers, thousands of sales a day.

Three independent slices (A, B, C). Each has its own files, tests and PR; no file is touched by two slices (overlap table at the end).

## How the numbers were taken

- Local load DB `mandalika_load` (Docker project `roletest`, Postgres 16.13, 3.8 GB, `shared_buffers` 128 MB, `work_mem` 4 MB): 1,018,650 orders (CLUSTERed by `idx_orders_created`), 500,000 customers, 2.5M `order_items`, 1.0M `order_tenders`, 50,073 `order_refunds`.
- Read-only. Indexes were tried only as `BEGIN; CREATE INDEX ...; EXPLAIN/EXECUTE ...; ROLLBACK;`.
- PREPAREd statements, warm (second run) unless stated, wall time from `\timing` with output discarded.
- **Search (A):** `jit=off` (what the list batch sends), `plan_cache_mode=force_custom_plan` unless "generic" is stated, default parallelism. The statement is the list's `f` CTE + count + page ids. The `orderObj` projection of 50 rows is excluded; it adds about the same to every form.
- **Reports (B):** the exact statements the backend sent, taken from the load test's Postgres log. Run with `max_parallel_workers_per_gather=0` for safety: the earlier parallel run crashed the shared container on `/dev/shm`. JIT on and off are both reported.
- **Not measured:** `customer_name` is mostly NULL in the load data (5,552 of 1,018,650 rows), so its index is small here and will be larger in production. `error_logs`, `customer_dup_candidates`, `goods_receipts` and `ingredient_transfers` are empty in the load DB, so the Slice C choices rest on projected growth, not measurement.
- **Container incident:** `roletest-postgres-1` had exited (255) before this work started; last up 2026-11-10 09:51 UTC. I restarted it with `docker start`; WAL recovery was clean. It was still up when the plan was written.

---

## Slice A: order text search (`GET /orders?q=`, list and keyset paths only)

### Goal

`GET /orders?q=` with a selective term over all outlets and all dates: SQL under 200 ms at 1M orders, down from 1.3-2.0 s today. This covers an order number, a phone number, a customer name and a cashier name.
- Selective terms get 7-40x faster.
- Terms that match most of the table get up to about 50% slower. Measured: Kasir, which matches every order, 1.70-2.01 -> 2.46 s over all dates, 42 -> 63 ms for one day, 228 -> 264 ms for 30 days. Such terms are not real searches, and narrowing the gate further would need a breadth probe (Follow-ups A6).
- Terms too short for a trigram (1-2 characters) keep today's statement unchanged.
- Identical rows, order and totals (A26).

### Architecture

**A.1 Migration `0088_orders_search_trgm.sql`.** Three GIN trigram indexes, the same shape as the customer search indexes (0026, 0082):

```sql
SET LOCAL lock_timeout = '10s';
CREATE INDEX IF NOT EXISTS idx_orders_order_number_trgm  ON orders USING gin (order_number  gin_trgm_ops) WITH (fastupdate = off);
CREATE INDEX IF NOT EXISTS idx_orders_cashier_name_trgm  ON orders USING gin (cashier_name  gin_trgm_ops) WITH (fastupdate = off);
CREATE INDEX IF NOT EXISTS idx_orders_customer_name_trgm ON orders USING gin (customer_name gin_trgm_ops) WITH (fastupdate = off);
```

- `pg_trgm` already exists (0026).
- All three are needed: a BitmapOr only happens if every OR arm has an index.
- **`fastupdate = off`** makes every sale insert pay a small, steady GIN cost instead of an occasional foreground pending-list flush inside a sync batch. Review Focus 4 measures it; flip to the default only if the measurement says so.
- **Indexes alone do nothing for the CustomerSearch form.** Measured with the indexes present, today's statement still runs a Seq Scan (1,258 ms). The `OR EXISTS (customers ...)` arm cannot join a BitmapOr. Hence A.2.

**A.2 A two-arm UNION for the list's filtered set** (new file `read/order_search.go`). Used only by `Repo.Orders` and `Repo.OrdersKeyset`. The shared WHERE clause that `ReportSummary` uses keeps its shape; A.4 is the only change to it.

```sql
f AS MATERIALIZED (
  SELECT <cols> FROM orders o <W> <extra> AND (o.order_number ILIKE $q OR o.cashier_name ILIKE $q OR o.customer_name ILIKE $q)
  UNION
  SELECT <cols> FROM orders o <W> <extra> AND o.customer_id IN (SELECT c.id FROM customers c WHERE c.phone ILIKE $q OR c.name ILIKE $q))
```

- `<W>` = `appendOrderWhere` of the same filter with `Q` cleared, so scope, dates, status, payment method and the refund-basis EXISTS sit inside each arm. `<extra>` = the keyset `asOf` bound.
- `<cols>` = `o.id, o.created_at`, plus the refund key `k` on the refund basis.
- **Why it is exact:**
  - W AND (A OR B) = (W AND A) UNION (W AND B).
  - `EXISTS (c.id = o.customer_id AND P(c))` is equivalent to `o.customer_id IN {c.id | P(c)}`. A NULL `customer_id` is false in both, inside a WHERE.
  - UNION de-duplicates an order that matches both arms; `id` is the primary key.
  - The pattern is the same `'%' || q || '%'` string. It moves into a shared `qPattern(q)`, and LIKE wildcards stay unescaped exactly as today.
- **Restricted form** (A30, `CustomerSearch=false`):
  - arm 1 is `order_number`/`cashier_name` only;
  - arm 2 exists only when `phone.Normalize(q) != ""`, as `o.customer_id IN (SELECT id FROM customers WHERE phone_norm=$k AND merged_into IS NULL UNION ALL SELECT id FROM customers WHERE phone_norm=$k AND merged_into IS NOT NULL)`.
  - Today's clause has no `merged_into` condition, so both halves are needed. Split this way, the partial indexes serve it: 1.8 ms against a 60 ms seq scan.
- **Gate:** `useSearchIndex(f) = f.Q != "" && trigramUsable(f.Q) && f.ShiftID == "" && f.CustomerID == ""`.
  - `trigramUsable(q)` is true when `q` contains a run of 3 or more letters or digits; `%`, `_`, spaces and punctuation break a run. pg_trgm cannot extract a trigram from shorter runs and falls back to a full index scan.
  - Shift and customer filters already drive a tiny index set (the POS recap and CustomerDetail paths), so they keep today's form.
  - Date windows are allowed: measured within about +/-50 ms of today, and better for selective terms (table below).
  - The gate only picks the plan shape. Both shapes return the same rows (Review Focus 1).

**A.3 Custom plans for the search statement.**
- Under a generic plan, pgx's statement cache reuses one plan for every term. Measured: Kasir 3.27 s generic against 2.46 s custom.
- The search path sends a batch prelude of `SELECT set_config('jit','off',true), set_config('plan_cache_mode','force_custom_plan',true)`, then the statement: one round trip, one implicit transaction, the same proof as #140's `jit-off-is-statement-local`.
- `repo.go` gains `pagedBatchPrelude(ctx, p, prelude, sql, args, read)`, and `pagedBatch` becomes a one-line call with `jitOffSQL`, so its behaviour is unchanged. Only the search path uses the new prelude.

**A.4 The shared restricted clause on short terms.**
- Once the indexes exist, the planner uses them for the restricted (non-CustomerSearch) clause in `appendOrderWhere`. That clause also feeds the summary and the POS cashier search.
  - Good for trigram-usable terms: order number 688 -> 27 ms; Kasir 2.38 -> 1.64 s.
  - Bad for 2-letter terms: `ab` 0.60 -> 2.06 s, from a full GIN scan. (`12` ran 1.69 -> 1.08 s unguarded, but it fails `trigramUsable`, so the guard below keeps it at today's 1.69 s.)
- So when `!trigramUsable(q)`, `appendOrderWhere` renders the restricted columns as `(o.order_number || '')` and `(o.cashier_name || '')`. The index cannot match those expressions, so the plan stays today's seq scan.
- It is semantically identical: `x || ''` = x, and NULL stays NULL.
- The CustomerSearch clause needs nothing: its `OR EXISTS` already blocks bitmap plans.

### Global constraints (A)

- **A26:** the count and the page come from one statement over the same `f`. The list's rows equal the rows of the shared WHERE clause (the summary's predicate), proven by a parity test against `legacyOrdersSQL`, which is built from `read.OrderWhere`.
- `ReportSummary`'s SQL is unchanged, apart from the A.4 expression wrapping for short restricted terms.
- No OpenAPI or generated-type change. No new top-level test in `internal/api` or `internal/codegen`.
- DB tests are subtests inside `runListSpeedSubtests` (`pagination_speed_integration_test.go`, already called by `TestPaginationPostgres`). No new gate entry, no change to `pagination_integration_test.go`, and no `verify()` records, so `paginationPostgres.test.ts` is unchanged.
- Never weaken the keyset `asOf` freeze: the bound goes inside each arm.

### Review Focus (A)

1. **The UNION form returns a different set** (a missed arm, a double count, wrong NULL behaviour).
   - Test `TestPaginationPostgres/orders-search-parity`. The fixtures cover a match on each column, a match by linked-customer phone and name, an order matching both arms, a NULL `customer_id`, a merged customer (`merged_into` set) under `phone_norm`, and `q` containing `%` and `_`.
   - Filters crossed with them: refund basis without dates, `status`, `paymentMethod` (cash, split, tender-line method), manager scope, and dated windows.
   - Every case runs with CustomerSearch on and off, with the form forced legacy and indexed through a test seam.
   - Check: ids in order and the total equal `legacyOrdersSQL`. For sale basis, keyset ids equal offset ids.
2. **Placeholder mis-numbering** when W, the pattern, `phone_norm`, `asOf`, cursor and limit share one arg list.
   - Unit test `TestOrderSearchSetPlaceholders` (package `read`): every `$n` in the SQL is below `len(args)`; the pattern arg equals `qPattern(q)`; the restricted form without a phone has no customers arm; the phone form has both `merged_into` halves.
   - DB subtest `orders-search-keyset`: keyset pages with `q` and a cursor concatenate to the offset order.
3. **Plan regressions the gate does not catch** (generic plans, short terms, dated windows).
   - Unit test `TestTrigramUsable`: `MND-361872`, `Budi` and `081` are true; `12`, `ab`, `a_b%c` and `Bu di` are false.
   - Unit test `TestUseSearchIndexGate`: `shiftId`/`customerId` give false.
   - Unit test `TestRestrictedShortTermHidesIndex`: `|| ''` present only for short terms.
   - DB subtest `restricted-short-term-parity`. `legacyOrdersSQL` builds its WHERE through the `read.OrderWhere` seam, which now contains the wrap, so it cannot serve as the oracle here. Keep a hard-coded, unwrapped restricted clause in the test file and compare ids and totals with the wrapped clause on fixtures for `ab`, `12` and `a_`.
   - DB subtest `search-custom-plan-is-statement-local`: inside the batch, `plan_cache_mode` reads `force_custom_plan` and `jit` reads `off`; the next query reads the defaults. New seam `Repo.SearchPlanProbe`, modelled on `JITProbe`.
   - Script `loadtest/sql/explain-search.sql` on the loadtest branch reruns the timing table below.
4. **Sale write path gets slower** (three GIN indexes on `orders`, `fastupdate=off`).
   - Measure on a throwaway local DB or the Postgres gate fixture, never `mandalika_load`: insert 3,000 sales through the real `/sync/batch` path (the loadtest C1 harness, 1 and 10 tablets) with and without migration 0088.
   - Pass: sale request p95 within 5%. Record the GIN insert cost per order.
   - If it fails, try `fastupdate=on` and re-measure. Do not drop an index without re-measuring A.
5. **The migration blocks sales too long, or loops at deploy.**
   - Its SHARE lock blocks INSERT/UPDATE/DELETE on `orders` for the whole build, inside the runner's transaction.
   - Test `TestPaginationPostgres/orders-search-indexes-exist`: the three indexes exist and are valid (`pg_index.indisvalid`), and the migration file contains `lock_timeout` and `IF NOT EXISTS`.
   - Runbook in the migration comment: above about 200k orders, build each index with `CREATE INDEX CONCURRENTLY` by hand first and check `indisvalid`. Then the migration is a no-op.

### TDD tasks (A)

Every task: Opus review. It touches the A26 guard, the orders hot table (sale write path) and a shared money-report predicate (A.4).

**A1. Migration.**
- File: `backend/internal/db/migrations/0088_orders_search_trgm.sql` (text above, plus a comment block on the lock, the measured build times and the CONCURRENTLY runbook).
- Test first: subtest `orders-search-indexes-exist`.
- Verify: `go test ./internal/db/...`, `python scripts/ci/postgres_gate.py` (A26 gate), and a Review Focus 4 write-cost run before merge.

**A2. Search set builder + gate + `qPattern`.**
- Files:
  - `backend/internal/read/orderfilter.go`: extract `func qPattern(q string) string`; add `func trigramUsable(q string) bool`; apply A.4; add an unexported `searchForm int8` field (0 auto, 1 legacy, 2 indexed) used only by the seam.
  - new `backend/internal/read/order_search.go`:
    - `func useSearchIndex(f OrderFilter) bool`;
    - `func orderSearchSet(f OrderFilter, cols, extra string, args []any) (body string, out []any)`;
    - `func orderPageSQLFromSet(f OrderFilter, setBody, cursorPred, limitOffset, extraCols string) string`.
- `orderPageSQL` keeps its signature. Its MATERIALIZED branch calls `orderPageSQLFromSet` with `SELECT <cols> FROM orders o <countWhere>`, so `list_statements_test.go` is unchanged.
- Tests first, in new `backend/internal/read/order_search_test.go`: `TestTrigramUsable`, `TestUseSearchIndexGate`, `TestOrderSearchSetPlaceholders`, `TestRestrictedShortTermHidesIndex`, `TestOrderSearchStatementsHaveNoWindowCount` (no `OVER(`; ends in `pg.id DESC`).

**A3. Custom-plan prelude.**
- Files: `backend/internal/read/repo.go` (`pagedBatchPrelude`; `pagedBatch` delegates), `backend/internal/read/order_search.go` (`const searchPreludeSQL`, `pagedSearchJSON[T]`), `backend/internal/read/testseam.go` (`SearchPlanProbe`, `ForceSearchForm(f *OrderFilter, indexed bool)`).
- Test first: `search-custom-plan-is-statement-local`. The existing `jit-off-is-statement-local` must stay green.

**A4. Wire `Orders` and `OrdersKeyset`.**
- Files: `backend/internal/read/orders.go`, `backend/internal/read/orders_keyset.go`.
- `Orders`: `if useSearchIndex(f)`, build `orderSearchSet` + `orderPageSQLFromSet` and run it through `pagedSearchJSON`.
- `OrdersKeyset`: allocate the `asOf` placeholder first, pass `" AND o.created_at <= "+asOfExpr` as `extra`, keep `cursorPred` on `pg` only, and read through `pagedBatchPrelude(searchPreludeSQL, ...)`.
- Signatures unchanged.
- Tests first: the Review Focus 1-3 DB subtests (including `restricted-short-term-parity`) in `backend/internal/handlers/pagination_speed_integration_test.go`, added to `runListSpeedSubtests`.
- Verify: `go test ./internal/read/... ./internal/handlers/...`, `python scripts/ci/postgres_gate.py`, `python scripts/ci/codegen_gate.py` (nothing new expected), `corepack pnpm quality:ci`.

**A5. Load-test proof** (loadtest branch, Haiku review): `loadtest/sql/explain-search.sql` plus R3a/R3b reruns through the real handler. Record the results in the results doc.
- Also EXPLAIN, with the indexes present, the POS cashier path: `shiftId` + `q` in the restricted form. The gate keeps today's statement there, but the new indexes could change its unforced plan. It must still drive from `idx_orders_shift`; not measured yet.

### Measured before / after (A)

All outlets, all dates, CustomerSearch on, list `f` + count + page ids, warm, JIT off, custom plans:

| q | matches | today | A (UNION + indexes) |
|---|---|---|---|
| `MND-361872` (order number) | 1 | 1,260-1,274 ms | **33-58 ms** |
| `081200334809` (phone, 1 order) | 1 | 1,500 ms (a phone with no orders) | **53-67 ms** |
| `Budi` (10k customers) | 6,073 | 1,675 ms | **125-183 ms** |
| `Kasir L01-1` (cashier) | 17,468 | 1,964 ms | **181 ms** |
| `MND-1` | 100,001 | 1,267 ms | 422-487 ms |
| `Kasir` (every order) | 1,018,650 | 1,696-2,011 ms | 2,463 ms (generic plan: 3,271 ms) |
| `081` (every phone) | broad | 3,551 ms | 2,128 ms |
| `a`, `12` (gate keeps today's form) | broad | 1,836 / 4,309 ms | unchanged |

Other scopes and windows (today -> A):
- business day 2026-11-10: Kasir 42 -> 63 ms; Budi 101 -> 64 ms.
- 30 days: Kasir 228 -> 264 ms; Budi 206 -> 83 ms; order number -> 35 ms.
- outlet L01 (manager), all dates: Budi 352 -> 139 ms; Kasir 247 -> 260 ms.

Rejected shapes, both measured:
- `o.customer_id = ANY(ARRAY(SELECT ...))` in one OR: 35 ms for the order number, but `12` took **144.8 s**. The broad customer array is rechecked linearly per heap row.
- `o.id IN (arm UNION ALL arm)` as a predicate: Kasir 9.5 s; 30-day Kasir 663 ms.

Not in this slice: **summary with `q`** (`/reports/summary`, which the Orders screen requests next to the list; see Follow-ups).
- Today it measured 3.1-4.3 s for an order number over all dates.
- An ungated MATERIALIZED match set took 50-75 ms (selective), 0.93 s (Budi) and 1.43 s (Kasir L01-1), but 5.1 s on `MND-1` and over 40 s (timeout) on `Kasir`.
- So it needs a capped breadth probe (measured 24-490 ms). It is planned as follow-up A6, not built here.

### Migration and lock notes (A)

- Local build at 1M orders, in one transaction under one SHARE lock:
  - `order_number` 3.5-5.2 s (36 MB);
  - `cashier_name` 2.6-3.5 s (15 MB);
  - `customer_name` 0.33-0.46 s (1.2 MB; mostly NULL here, larger in production);
  - total **6.5-9 s**, during which every sale, refund and status write to `orders` waits. Reads continue.
- Neon is likely slower: shared CPU, `maintenance_work_mem` default. Assume 2-4x (an estimate, not measured), so 15-35 s of blocked sales at 1M rows.
- **Today** (pre-launch, small test data): well under a second. This is acceptable, and it is the reason to ship A first, while `orders` is small.
- **At 1M rows**, do not let the runner build these. Use the CONCURRENTLY runbook in Review Focus 5.
- `lock_timeout 10s`: if a long transaction holds `orders`, the migration fails, the new revision does not become ready, and the old revision keeps serving. Retry the deploy.
- Migrations run at server start (`cmd/server/main.go`), so a slow build also delays readiness. One more reason to keep the runner build for small tables only.

### Release order (A)

1. Backend revision with 0088 and A2-A4, deployed in one step: the migration runs before the server accepts traffic, so the indexes exist when the new code runs.
   - Rolling back to the old revision is safe; the extra indexes are harmless.
   - Before deploying, confirm the live `orders` count is small (Q1).
2. No Backoffice change, no OTA, no APK.
3. A5 on the loadtest branch.

---

## Slice B: reports (`/reports/summary`, `/reports/dashboard`)

### Goal and verdict

- **The cheap correct read-side fix buys 10-20%. It does not reach the 2 s mark.** Do the one read-side change that is clearly correct and scales (B1). **Defer the rollup** until it has been measured on Neon and the owner has decided (Q2, Q3).
- Measured, 30 days, all outlets, warm, parallel off:
  - summary: 2.8-2.9 s with JIT on (the live setting; JIT does not trigger in these plans), 2.9-3.8 s with JIT off;
  - dashboard (30 days plus the previous 30): 4.5-5.1 s with JIT on, 4.7-5.1 s with JIT off;
  - **cold first run: 9.1 s (JIT on) and 17.3 s (JIT off).** The second is over the 15 s server deadline: both routes get `DefaultDeadline` in `server/deadline.go`, and the server deadline fires before the dashboard's own 20 s timeout. A Neon scale-to-zero wake-up behaves like this.

### Where the time goes (warm, parallel off)

- **Summary:**
  - `sb` (100k orders by business date + refunds): 0.35 s;
  - payment lines `sbl`: **1.4 s**, of which about 1.36 s is two full scans and hash joins of all 1,018,650 `order_tenders`: the JOIN branch plus the NOT EXISTS branch of `tenderlines.SetLines`. That part grows with the table, not the window;
  - `prod`, the `order_items` probe for 97k orders: 1.1 s warm, 12 s cold;
  - the rest: about 0.3 s.
- **Dashboard:**
  - items for 175k orders (both windows): 1.4-1.7 s;
  - the `row_number()` sort for `rk` over 183k rows: 0.5 s, spilling 19 MB;
  - the product-rank sort: 0.64 s;
  - cashiers: 0.22 s;
  - `sb`: 0.3 s;
  - the rest: about 1 s.

### Architecture (B1, now)

`tenderlines.SetLines(base, keep)` becomes one LEFT JOIN LATERAL with the same output columns (`id, <keep...>, method, amount, synthetic`):

```sql
SELECT o.id<keep>, CASE WHEN t.order_id IS NULL THEN o.payment_method ELSE t.method END,
       CASE WHEN t.order_id IS NULL THEN o.total ELSE t.amount END, t.order_id IS NULL
  FROM <base> o LEFT JOIN LATERAL (SELECT t.order_id, t.method, t.amount
                                     FROM order_tenders t WHERE t.order_id = o.id) t ON true
```

- **Exact:**
  - an order with k >= 1 stored lines yields the same k rows;
  - an order with none yields one synthetic row (`payment_method`, `total`, true), as the anti-join branch did;
  - `method` and `amount` are NOT NULL in `order_tenders`, and the CASE keys on `t.order_id`.
- **Measured** (the payment-line part alone; JOIN+anti-join / LEFT JOIN / LEFT JOIN LATERAL):
  - 30 days: 1,081-1,116 / **599-645** / 623-714 ms;
  - 365 days (about 1M orders): 3,030-3,266 / **2,064-2,120** / 2,172-2,190 ms.
  - **Choice: LATERAL.** Plain LEFT JOIN is about 5-10% faster today, but its plan is a Hash Left Join over a Seq Scan of all 1,018,650 `order_tenders`. It halves today's cost and still grows with table history: at 5M orders a 30-day report would scan 5M tender rows. LATERAL probes `order_tenders_pkey` once per order in the window, so its cost follows the window, not the table.
  - Its price is +25-70 ms on 30 days and +50-110 ms on a whole year at today's 1M orders.
- **End to end:** summary 2.8-2.9 -> about 2.3 s (2,287-2,367 ms, measured with this LATERAL form); dashboard 4.5-4.7 -> 4.2-4.4 s. The dashboard uses `SetLines` only for the current window's gross-by-method.
- The `tenderlines.go` header says SP subtest 14 keeps `Lateral`, `SetLines` and `order_default_payout_method` in step; the rule they share does not change.

### Rejected read-side options (measured)

| Option | Result | Why not |
|---|---|---|
| Covering index `order_items (order_id) INCLUDE (id, product_id, variant_size, product_name, quantity, subtotal)` | 253 MB, 18 s build; summary 2.9-3.4 s, dashboard 4.0-4.1 s, no gain | Cost without benefit |
| `SET LOCAL work_mem = '32MB'` per statement | summary -0.1 s, dashboard -0.1 s | Memory risk on a small Neon compute under concurrency, for about 3% |
| JIT off per statement (as in #140) | No gain: JIT did not fire in these plans | Not a lever here |
| A longer report cache TTL, or skipping invalidation on writes | Not measured | The totals and the list are separately cached requests, so a longer TTL lets them disagree for longer (A26 same-rows). Owner policy (Q3) |

### Why the rollup is deferred (design note, no code)

A per-(outlet, business day, method) rollup table makes these reads O(days x outlets) instead of O(orders). It is the only option that reaches tens of ms and keeps "Semua" (all-time) under the 20 s dashboard timeout at 1M orders; at that size the all-time dashboard would likely exceed it (an estimate, not measured). Its traps:
- **Old sale days change.**
  - A refund today changes the sale day's `net_total`. `totalSales` and `byPaymentMethod` are still-sold amounts by sale day, unclamped (C4a), so the day of any past sale can change.
  - An offline tablet uploads old `business_date` sales late.
  - There is no "closed day". Every order and refund write must update the rollup in the same transaction, which is the sale/refund write path and its lock contention: a hot row per outlet-day while a C1-style burst runs.
- **Some dashboard metrics do not add up across days:**
  - `COUNT(DISTINCT customer_id)`;
  - first-seen tie-breaks of the product and cashier ranks (`rk`);
  - hour buckets by the viewer's `tzOffset`;
  - `promoTally` from `discount_breakdown`.
  - The dashboard would still scan orders for these, so a rollup helps the summary fully and the dashboard only partly.
- Every summary filter except scope and day range (`status`, `paymentMethod` D-66, `q`, legacy instants) still needs the live path, so two code paths would have to agree to the cent (A27/D-66 parity tests for both).
- **The gate before any rollup work:** load-test step 2 on Neon. If summary/dashboard p95 on Neon at realistic data is under 2 s, a rollup is not needed yet. If it is not, write a separate plan with an append-only delta table (insert-only, no hot row), a compaction job, and full parity tests. That is Opus-planned and needs the owner's approval.

### Global constraints (B)

- Numbers identical to today, to the cent: A27 sale-day versus refund-day, C4a unclamped `net_total`, D-66 method limits, business day per the outlet zone (A28).
- `tenderlines.Lateral` and the SQL function `order_default_payout_method` are unchanged.
- No migration, no OpenAPI change, no new gate. Tests extend existing gates: SP subtest 14 (`TestSplitTenderPostgres`), A27 (`TestReportSummaryPostgres`), DB (`TestDashboardAggregatePostgres`), RF.

### Review Focus (B)

1. **A tenderless order loses or doubles its synthetic line.** `TestSplitTenderPostgres/14 lateral vs set lines` compares `Lateral`, the new `SetLines` and the retired form (kept in the test as `legacySetLines`). Fixtures: 0, 1 and 3 stored lines, refunded and partially refunded orders. The check is multiset-equal rows.
2. **The output columns move** (callers read `id, <keep...>, method, amount, synthetic` by position).
   - Unit test, new `backend/internal/tenderlines/tenderlines_test.go`: `TestSetLinesIsOneLateralJoin` (one `LEFT JOIN LATERAL` on `order_tenders`, no `NOT EXISTS`, keep columns in order).
   - Gates A27 and DB pass unchanged.
3. **Split-tender and refund-in-another-method netting changes** (D-66, C6a). Run the existing `split_tender_summary_equiv_test.go` cases and the RF refund-parity gate unchanged; no expected-value edits allowed.
4. **Narrow windows get slower** (a manager on one outlet, today's day). Script `loadtest/sql/explain-reports.sql`: summary and dashboard for L01 over today and 30 days, and for all outlets over 30 days, old against new; new must be no slower.
5. **A cold-cache timeout goes unnoticed.** Record the first-run time on the load DB after a restart, and on Neon in step 2, against the request deadline of `/reports/summary` and `/reports/dashboard`. Report only, no code change.

### TDD tasks (B)

**B1. One-join (LATERAL) `SetLines`.** Opus review (payment and money projection).
- Files: `backend/internal/tenderlines/tenderlines.go`; new `backend/internal/tenderlines/tenderlines_test.go`; `backend/internal/handlers/split_tender_lines_equiv_test.go` (add `legacySetLines` and the fixtures above).
- Signature unchanged: `func SetLines(base string, keep []string) string`. Update the doc comment: replace "hash join plus anti-join" with the measured reason.
- Tests first: Review Focus 1-2.
- Verify: `go test ./internal/tenderlines/... ./internal/read/...`; `python scripts/ci/postgres_gate.py` (SP, A27, DB, RF); explain script.

**B2. Report proof** (loadtest branch, Haiku review): `loadtest/sql/explain-reports.sql`, plus R4a/R4b reruns. Record the results.

### Release order (B)

One backend revision. No client change, so rollback is safe in either direction.

---

## Slice C: remaining `count(*) OVER()` lists, JSON compression, customer export by spend

Three sub-slices with disjoint files (C1 lists, C2 compression, C3 export). One PR each is fine; all three are independent of A and B.

### C1. Id-first lists

**Convert** (same shape as #140: `t` count + `pg` ids + `t LEFT JOIN pg`, through the existing `pagedCountJSON`, so JIT is off and a past-end page reports its real total):

| List | File | Why at target scale |
|---|---|---|
| Error logs | `read/error_logs.go` `ErrorLogs` | 60-day retention. A noisy release on 60 tablets can reach 10k-100k rows. Today every row's `payload` and `breadcrumbs` JSON is built just to count. |
| Duplicate candidates | `read/dupcandidates.go` `DupCandidates` | With 500k customers the pending set can reach thousands. `Customers.tsx` calls it with `limit 1` only for the badge total, and today that builds two full customer objects (with segment) per pending row. |
| Goods receipts | `read/goods_receipt_list.go` `GoodsReceipts` | Two sub-selects per row, plus a second count query for a past-end page (dropped). |
| Ingredient transfers | `read/ingredient_transfers.go` `IngredientTransfers` | Builds the items JSON per row. `TransferTab` exports through `fetchAllPages` (A26). |

**Not worth converting:**
- `catalog.go` `Products`: tens to hundreds of rows. Its `SellableOnly` variant feeds the tablet pull, so a change there is sync-adjacent and must be byte-identical.
- `ingredient_stock_counts.go`: a few rows a month; the list carries no items.
- `dashboard.go`: its `count(*) OVER ()` runs over product groups inside the aggregate, not a paged list.

Also unconverted, and small at target scale: inventory approvals, products filtered, promotions page, refund report (R4c 102-111 ms at 50k refunds), reminders, requisitions, shifts, stock counts, sync review, transfers, users.

**Constraints:**
- Same row order (each already ends in `id DESC`).
- Same filter semantics.
- Total from the same statement.
- Do not edit `repo.go` (Slice A owns it); call `pagedCountJSON` as it is.

### C2. JSON response compression

- **Current state:**
  - The server has no compression: no `Compress` in `server/server.go`, and no `Content-Encoding` anywhere in `backend/internal`.
  - chi v5.4.0 ships `middleware.Compress(level, types...)`. It sets `Vary: Accept-Encoding`, drops `Content-Length` when it compresses, and passes Flush through for content types it does not compress. No new dependency, no `go.mod` change.
  - Browsers send `Accept-Encoding: gzip, deflate, br, zstd` on every Backoffice fetch and decode it transparently. The POS uses WebView fetch (no `CapacitorHttp` in `apps/pos`), which does the same.
  - The middleware compresses only when the request sends `Accept-Encoding`.
  - **Cloud Run:** I believe the Google front end does not compress app responses. **Not verified.** T0 below checks it.
- **Gain** (measured with CLI gzip on a 1000-order JSON page of 2,543,862 bytes): level 1 -> 417,623 B (6.1x); level 5 -> 328,794 B (7.7x); level 6 -> 317,675 B.
  - For the 101-page month export that is about 257 MB -> 33-42 MB on the shop or office link.
  - CPU per page: the CLI timing includes process start, so it is not usable. Go's `compress/flate` must be benchmarked (C2b) before the level is chosen.
  - Budget: the #140 export estimate is about 24 s of its 30 s budget. At 101 pages, every 10 ms of compression per page adds 1 s.
- **Design:** `compressJSON(level)` in new `server/compress.go`:
  - wraps `chimw.Compress(level, "application/json")`;
  - passes through untouched any path under `/api/v1/ota/` (keeps the OTA path out) and `/api/v1/auth/` (small token responses; no reason to touch auth);
  - is mounted in `server.New` right after `mw.Deadline`, inside the request observers. `ClientIP` and `RequestLogger` keep their order; `realip_guard_test.go` must stay green;
  - CSV and other non-JSON streams are never compressed (type list = JSON only).

### C3. Customer export sorted by spend

- The sort key `total_spent` changes with every sale. While an export pages by offset over it, a customer can move across a page boundary and be skipped. A skip leaves the total unchanged, so the A26 check does not catch it.
- **Fix** (Backoffice only):
  - When the chosen sort is `belanja`, `exportCustomers` in `Customers.tsx` pages with `terbaru` (`created_at DESC, id DESC`; immutable keys) through the unchanged `fetchAllPages`.
  - The rows are then sorted in the browser with the server's exact order: `totalSpent DESC, createdAt DESC, id DESC`.
  - `createdAt` is compared at microsecond precision by parsing the RFC3339 string (fraction up to 9 digits, any offset); `Date` drops microseconds.
  - `id` is compared as a lowercase UUID string, which matches Postgres uuid order.
- **What does not change:**
  - Speed: offset 400,000 measured 1.31 s (`created_at` sort) and 1.47 s (spend sort), so 500k customers = about 2,500 pages = tens of minutes, plus 500k rows in browser memory.
  - Completeness: a customer registered or merged during the export changes the total, and the export fails, as today.
- Q4 asks whether a 500k export is really needed; customer keyset paging would be its own slice.

### Global constraints (C)

- **A26:**
  - C1 totals come from the same statement as the page.
  - C3 keeps `fetchAllPages` and all its checks; the browser sort happens only after a complete, validated fetch.
- **No `package.json` or lockfile change.** C2 uses chi's own middleware.
- **No change** to `pagination_integration_test.go`, `postgres_gate.py`, `gate_fixture_test.go`, `codegen_gate.py` or `paginationPostgres.test.ts`.
- **DB tests:**
  - C1 adds subtests to `TestListParamsPostgres` (LP, which already covers goods receipts and stable paging) and to `TestErrorLogsPostgres` (EL);
  - C2 tests are plain unit tests in `internal/server`, outside the codegen-gate directories.

### Review Focus (C)

1. **C1 parity or past-end drift.**
   - LP subtests `15 goods receipts: id-first parity and past-end total`, `16 ingredient transfers: id-first parity, filters, past-end total`, `17 dup candidates: id-first parity, limit-1 badge total`; EL subtest `id-first parity and past-end total`.
   - Each compares ids, order and total with the retired `count(*) OVER()` statement, kept in the test file.
   - Fixtures include equal `created_at` values, for the `id DESC` tie-break.
2. **A screen breaks on `data: []` with `total > 0`** (new past-end behaviour).
   - Check `ErrorLogs.tsx`, `customers/DupCandidates.tsx`, `inventory/GoodsReceiptsList.tsx` and `ingredients/TransferTab.tsx` by hand.
   - If one shows an empty "page N of M", add a redirect by importing `pastEndPage` from `apps/backoffice/src/screens/customersPastEnd.ts` (#140). Import it; do not move it, so C1 never touches C3's files.
3. **C2 compresses a stream or the OTA/auth path, or breaks an abort.**
   - In new `server/compress_test.go`:
     - `TestCompressJSONWhenAccepted`: gzip and Vary set; the decoded body equals the identity body (cache HIT and MISS);
     - `TestNoCompressionWithoutAcceptEncoding`;
     - `TestCSVStreamNotCompressedAndFlushes`;
     - `TestOtaAndAuthPathsNotCompressed`.
   - Extend `abort_stream_test.go`: a stream that aborts after its headers still drops the connection with the compressor installed.
4. **C2 CPU eats the export budget.**
   - `BenchmarkCompressOrderPage` in `server/compress_test.go` builds a 1000-`api.Order` page and compares levels 1 and 5.
   - Pick level 1 if level 5 costs more than about 15 ms a page (about 1.5 s per export).
   - Record ns/op and the ratio in the PR.
5. **The C3 browser order differs from the server order.**
   - In `customers/customerExport.test.ts`: `sortBySpend` orders by spend; breaks spend ties by `createdAt` at microsecond precision (`...:00.000001Z` after `...:00Z`); compares mixed offsets (`+07:00` against `Z`) as instants; breaks full ties by `id` DESC; and does not mutate its input.
   - Also `exportCustomers` pages with `terbaru` only for the `belanja` sort, through an extracted pure `exportPageSort(sort)`.

### TDD tasks (C)

**C1a-d. Lists** (one commit per list). Haiku review by the rule. **Recommended Opus for C1d** (ingredient transfers export, A26).
- Files:
  - `backend/internal/read/error_logs.go` (extract `errorLogsPageSQL(...) (string, []any)`);
  - `dupcandidates.go` (`dupCandidatesPageSQL`);
  - `goods_receipt_list.go` (`goodsReceiptsPageSQL`; delete the second count query);
  - `ingredient_transfers.go` (`ingredientTransfersPageSQL`);
  - new `backend/internal/read/list_statements_more_test.go` with `TestMoreListStatementsHaveNoWindowCount`;
  - `backend/internal/handlers/list_params_integration_test.go` (LP subtests 15-17);
  - `backend/internal/handlers/error_logs_integration_test.go` (EL subtest);
  - only if Review Focus 2 finds a broken screen, that screen's `.tsx` plus a test.
- Signatures of the `Repo` methods unchanged.
- Verify: `go test ./internal/read/... ./internal/handlers/...`; `python scripts/ci/postgres_gate.py` (LP, EL, A26); `corepack pnpm quality:ci`.

**C2a-b. Compression.** **Opus review**: a server-wide middleware next to `ClientIP` that wraps auth-adjacent and sync responses.
- T0 (before code): `curl -s -o /dev/null -D - -H 'Accept-Encoding: gzip' https://<run.app>/api/v1/...` on one authenticated JSON list using the owner's own session (no test accounts on run.app). Confirm there is no `Content-Encoding` today. Ask the owner to run it, or approve it (Q5).
- Files: new `backend/internal/server/compress.go` (`func compressJSON(level int) func(http.Handler) http.Handler`); `backend/internal/server/server.go` (one `r.Use(compressJSON(...))` line); new `backend/internal/server/compress_test.go`; `backend/internal/server/abort_stream_test.go`.
- Tests first: Review Focus 3-4.
- Verify: `go test ./internal/server/...`; `corepack pnpm quality:ci`; after deploy, the T0 curl shows `Content-Encoding: gzip` and the Backoffice month export runs end to end.

**C3. Customer export by spend.** Haiku review.
- Files: `apps/backoffice/src/screens/Customers.tsx` (`exportCustomers`); `apps/backoffice/src/screens/customers/customerExport.ts` (`export function sortBySpend(rows: readonly Customer[]): Customer[]`, `export function exportPageSort(sort: CustomerSort): CustomerSort`, `createdAtKey(s: string): [number, number]`); `apps/backoffice/src/screens/customers/customerExport.test.ts`.
- Tests first: Review Focus 5.
- Verify: `corepack pnpm quality:ci`.

### Release order (C)

- C1 and C2: backend revision(s).
  - C1's only wire change is the real total on a past-end page.
  - C2 is transparent to every client that sends `Accept-Encoding`.
  - Roll back C2 by removing the one `r.Use` line.
- C3: Backoffice (Cloudflare Pages on push). No backend dependency.

---

## Not now: fewer statements per sale (measurement step only)

Local trace: about 31 statements and 6 ms of DB time per sale, but 25-33 ms of wall time, so most of it is round trips. The test to run first, against Neon:
1. With the owner's approval for Neon writes, enable `pg_stat_statements` on the Neon test DB and reset it.
2. Through the deployed backend, upload 50 and then 500 sales from one throwaway outlet and device, using the loadtest C1 envelope. Delete them afterwards, leaving nothing behind.
3. Read `calls`, `mean_exec_time` and `total_exec_time` per statement, and the request latency from the Cloud Run logs.
4. Per-sale round-trip share = wall - sum of exec. If it is above about 70% (local: about 75-80%), plan pgx batching of the per-item lookups (the shift state, the outlet row, the user's permissions). That plan needs Opus: SyncEngine and stock.

---

## File overlap table

| File | A | B | C |
|---|---|---|---|
| `backend/internal/db/migrations/0088_orders_search_trgm.sql` (new) | x | | |
| `backend/internal/read/orderfilter.go` | x | | |
| `backend/internal/read/order_search.go`, `order_search_test.go` (new) | x | | |
| `backend/internal/read/orders.go`, `orders_keyset.go` | x | | |
| `backend/internal/read/repo.go` | x | | |
| `backend/internal/read/testseam.go` | x | | |
| `backend/internal/handlers/pagination_speed_integration_test.go` (`runListSpeedSubtests`) | x | | |
| `backend/internal/tenderlines/tenderlines.go`, `tenderlines_test.go` (new) | | x | |
| `backend/internal/handlers/split_tender_lines_equiv_test.go` | | x | |
| `backend/internal/read/error_logs.go`, `dupcandidates.go`, `goods_receipt_list.go`, `ingredient_transfers.go` | | | x (C1) |
| `backend/internal/read/list_statements_more_test.go` (new) | | | x (C1) |
| `backend/internal/handlers/list_params_integration_test.go`, `error_logs_integration_test.go` | | | x (C1) |
| `backend/internal/server/server.go`, `compress.go` (new), `compress_test.go` (new), `abort_stream_test.go` | | | x (C2) |
| `apps/backoffice/src/screens/Customers.tsx`, `customers/customerExport.ts`, `customerExport.test.ts` | | | x (C3) |
| `loadtest/sql/explain-search.sql` (A) / `explain-reports.sql` (B), loadtest branch, separate files | x | x | |

**Edited by no slice:** `pagination_integration_test.go`, `list_statements_test.go`, `reports.go`, `dashboard.go`, `scripts/ci/postgres_gate.py`, `scripts/ci/codegen_gate.py`, `gate_fixture_test.go`, `paginationPostgres.test.ts`, `openapi.yaml`, the generated types, `package.json`, `pnpm-lock.yaml`.
**`HANDOFF.md`** is edited only at merge/release time by the orchestrator, never inside a slice PR. That is the one shared file that would otherwise collide.

**Semantic coupling** (no shared file, so it is safe to merge in any order):
- A and B both change SQL that the A27/A26 gates run. Each PR runs every Postgres gate, so whichever merges second is re-gated on top of the first.
- C1 reads through `pagedCountJSON`, which A3 leaves unchanged: `pagedBatch` delegates to `pagedBatchPrelude` with the same `jitOffSQL`.

## Build order

1. **A first.** It has the largest measured gain on a screen people use all day (search: 1.3-2.0 s -> 35-180 ms), and its migration is cheapest while `orders` is small. Every month of trading makes the lock longer.
2. **C in parallel** (C3 is the smallest and safest; C2 after T0).
3. **B1 any time.** A small, exact, scale-proofing change with a modest gain. B's real decision waits for Neon step 2.

## Follow-ups (not in this wave)

- **A6, summary with `q`.**
  - A MATERIALIZED match set (the A.2 arms over scope only) replaces the q-clause in `ReportSummary`.
  - It is used only when there is no date or instant bound, the term passes `trigramUsable`, and a capped probe (`SELECT count(*) FROM (<arms> LIMIT 20001)`, 24-490 ms) reports 20,000 rows or fewer.
  - Measured 50-75 ms for a selective term against 3.1-4.3 s today. Without the probe, `MND-1` took 5.1 s and `Kasir` over 40 s.
  - It touches `reports.go` and `orderfilter.go`: after A and B merge. Opus.
- Custom plans (`force_custom_plan`) for the customer list too. #140 measured generic plans at 252-503 ms against 38-78 ms custom.
- Customer keyset export, if Q4 says a 500k export is needed.
- The rollup design (B), gated on Neon step 2.

## Decisions (2026-11-11)

The owner asked to "work on the next follow-ups" and prefers Claude's recommendations. Opus answered the planner's questions as follows; the owner may veto any of them.

1. **Live order count:** not measured. Claude does not sign in to Neon. The live database holds test data with order numbers in the tens per outlet, so the 0088 index build is trivial today.
   - Above about 200k orders, build these indexes by hand with `CREATE INDEX CONCURRENTLY` before deploying the migration (the plan's lock notes).
2. **Report rollup is deferred** until it is measured on Neon (load-test step 2). Only B1, the read-side `tenderlines.SetLines` LATERAL rewrite, is built now.
3. **Reports stay invalidated by every write.**
4. **Customer export by spend:** build C3 for correctness (no skipped rows). Making a 500k-customer export fast is not a priority now.
5. **gzip:** covers JSON responses including `/sync/*`, and excludes `/ota/*` and `/auth/*`. The live `Content-Encoding` check against run.app is the owner's, in browser devtools, because Claude does not sign in there.

**Build order:**
- Slice A and Slice C in parallel; they share no file.
- B1 after A's measurements, so the two do not compete on the local load database.
