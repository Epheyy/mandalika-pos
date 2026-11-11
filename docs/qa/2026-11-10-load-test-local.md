# Load test, step 1 (local copy), 2026-11-10

Backend code = `origin/prod-hardening` @ `49506706` (what is live). No application code was changed.
Harness and rerun steps: `loadtest/README.md`. Every request went to `http://localhost:8090`.

**These numbers are relative.** They find bottlenecks; they are not a production SLA (see Caveats).

## Verdict against the pass marks

| Mark | Result | Evidence |
|---|---|---|
| No failed or duplicate sale | **PASS** | 3,000 sales: exactly 3,000 new orders, 0 duplicate idempotency keys / order numbers / order uuids, replay of all 3,000 created 0 new orders, per-outlet stock moved by exactly the sold units (9,006) in all 2,400 stock rows. No 409/429/5xx on `/sync/batch`. **Qualifier:** that is the clean run (2 of the 4 runs with Backoffice load deferred 152 and 171 items as `busy`: not lost, not doubled, accepted only on the resend, so all 3,000 were accepted after about 46 s, not 34 s; see C1). |
| Sale upload p95 < 1 s per request | **FAIL** | 18.0 s p95 per 25-item request with 60 tablets + 5 Backoffice clients; 8.5 s without Backoffice; 0.9 s for a single tablet; 1.3 s for 10 tablets. |
| Backoffice lists and reports p95 < 2 s | **FAIL** | Lists pass on a chronologically ordered table (R2 0.4-1.0 s, R3 1.3 s, customers 1.0 s). `reports/summary` p95 2.1 s and `reports/dashboard` p95 5.8 s (max 10.5 s) fail. With the table in random heap order (the first run) nearly everything failed. During C1 the reports reached 6-10 s. |
| Month export < 30 s | **FAIL** | 461 pages of 200, 1,740 s (29 min). 1,435 s on the first (random heap order) run. |

## Data (in `mandalika_load`, kept)

Generated in Postgres with `generate_series` (`loadtest/sql/01_seed.sql`), honouring all constraints through migration 0086.

| Table | Rows |
|---|---|
| outlets | 30 |
| users | 62 (admin, 60 cashiers, 1 manager for L01 with view_reports/manage_customers/view_dashboard) |
| products / variants / outlet_variant_stock | 40 / 80 / 2,400 |
| customers | 500,000 (unique phones) |
| shifts | 10,950 (one per outlet per day, 365 days) |
| orders | 1,000,000 as seeded (about 2,740 a day), 1,018,650 now (the C1 and scaling runs added 18,650) |
| order_items / order_tenders / processed_keys | 2,499,721 / 1,000,000 / 1,000,000 as seeded |
| refunded orders / order_refunds / order_refund_items | 50,073 (5%) / 50,073 / 125,598 |

Database size after seeding and `ANALYZE`: 1,952 MB (orders 690 MB incl. indexes, order_items 605 MB, customers 218 MB).
Postgres 16.13 in the shared Docker container: `shared_buffers` 128 MB, default `work_mem` (4 MB), `/dev/shm` 64 MB, 12 CPUs / 3.8 GB visible to Docker.

Modelling limits: every sale is cash, no promotion, no loyalty points, no tax; the refund rows come from the production trigger
`orders_refunded_legacy_row`, so all are `legacy_full` (no partial refunds); all outlets are Asia/Jakarta; `customers.total_spent`
is not derived from orders.

### Physical order of `orders` (matters a lot)

The seed generated orders in random day order, so the rows of any 30-day window were scattered over the whole heap
(correlation of `created_at` about 0). Production inserts chronologically. After the first full read run I ran
`CLUSTER orders USING idx_orders_created` (correlation now -1, i.e. perfectly ordered) and reran. Both sets are reported.
Use the "chronological" set for conclusions about the code; the "random heap" set shows how much cold random I/O costs.

## Setup and limits changed for the test

- One backend binary on :8090, `DB_MAX_CONNS` default (10), about one Cloud Run instance (production: up to 4 x 10).
- `RATE_LIMIT_RPS=100000`, `RATE_LIMIT_BURST=100000` (production 20/40, i.e. 1,200 requests a minute per IP): all traffic is one IP.
- The `/auth/login` bucket (10 a minute per IP) is hard-coded in `server.go`. Left as is; the driver deletes the `rl:auth:*` keys in Redis db 1 (ours only) before each of the 61 sign-ins.
- `JWT_ACCESS_TTL_MIN=480` so tokens outlive a long run. Everything else default. Production keeps all limits.
- The cashier phone lookup has its own per-user limit; it returned 429 for 25 of 55 requests (by design, not changed).
- `ALTER DATABASE mandalika_load SET log_min_duration_statement = 300` for the slow-statement evidence (`pg_stat_statements` needs a restart of the shared container, which was off limits).

Method: 50 timed requests after 5 warm-ups, sequential, per principal. Reads are Redis-cached for 15 s, so every timed
read carries a unique `_cb` parameter (X-Cache MISS on all rows below); one row shows the cache-hit case. With n = 50, "max" is the same sample as p99.

## Reads (R1-R7)

Chronological heap (the set to use). R1-R3 from the third partial run, R4-R7 from the second, all after the `CLUSTER`. R1-R3 were measured twice on this layout and the runs differ, see the block after the table. Times in ms.

| Request | Principal | n | p50 | p95 | p99 | max | Errors |
|---|---|---|---|---|---|---|---|
| R1 orders, 1 outlet, today, p1 | admin | 50 | 63 | 68 | 72 | 72 | - |
| | manager L01 | 50 | 19 | 63 | 65 | 65 | - |
| R2a orders, all outlets, 30 d, p1 (limit 50) | admin | 50 | 318 | 361 | 368 | 368 | - |
| | manager | 50 | 39 | 45 | 46 | 46 | - |
| R2b same, page 200 | admin | 50 | 941 | 994 | 1,015 | 1,015 | - |
| | manager | 50 | 282 | 299 | 307 | 307 | - |
| R3a orders `q=<order number>` | admin | 50 | 1,125 | 1,155 | 1,159 | 1,159 | - |
| | manager | 50 | 113 | 120 | 141 | 141 | - |
| R3b orders `q=<customer phone>` | admin | 50 | 1,201 | 1,256 | 1,278 | 1,278 | - |
| | manager | 50 | 136 | 145 | 151 | 151 | - |
| R4a reports/summary, 30 d, all outlets | admin | 50 | 1,917 | **2,144** | 3,384 | 3,384 | - |
| | manager | 50 | 188 | 205 | 241 | 241 | - |
| R4b reports/dashboard trend=day | admin | 50 | 3,639 | **5,779** | 10,455 | 10,455 | - |
| | manager | 50 | 240 | 258 | 261 | 261 | - |
| R4c refund-report, 30 d | admin | 50 | 102 | 111 | 116 | 116 | - |
| | manager | 50 | 61 | 68 | 85 | 85 | - |
| R5a customers `q=<name prefix>` (about 10k matches) | admin | 50 | 913 | 1,036 | 1,059 | 1,059 | - |
| | manager | 50 | 913 | 972 | 1,021 | 1,021 | - |
| R5b sync/customers/lookup `phone=` | admin | 50 | 3.8 | 4.4 | 5.0 | 5.0 | - |
| | manager | 50 | 3.5 | 4.2 | 6.2 | 6.2 | - |
| | cashier L01 | 50 | 4.4 | 5.9 | 8.1 | 8.1 | 429 x 25 (per-user lookup cap) |
| R7 sync/pull | cashier L01 | 50 | 20.5 | 27.7 | 30.0 | 30.0 | - |
| R7 sync/version | cashier L01 | 50 | 4.8 | 5.8 | 6.4 | 6.4 | - |
| R2a, cache HIT (reference) | admin | 50 | 3.1 | 3.7 | 5.2 | 5.2 | - |

R1-R3 admin, the earlier chronological run (before the Docker crash, same layout, colder cache), p50 / p95 / p99: R1 16 / 21 / 60 ms, R2a 743 / **1,399** / 1,562, R2b 958 / 1,051 / **3,108**, R3a 1,114 / 1,271 / 1,324, R3b 1,192 / 1,291 / 1,320. The table above is the later, warmer run (R2a p95 361 ms). The variance is cache state (128 MB `shared_buffers`); read R2a as 0.4-1.4 s p95. Both pass 2 s; R2b and R3 sit near 1 s.

R6 month export (30 days, all outlets, limit 200, sequential like `fetchAllPages`):

| Run | Pages | Rows | Wall time | Per page p50 / p95 / p99 / max (ms) |
|---|---|---|---|---|
| chronological heap, admin | 461 | 92,018 | **1,740 s** | 3,592 / 6,661 / 9,687 / 13,910 |
| chronological heap, manager L01 (own outlet) | 17 | 3,344 | 3.6 s | 218 / 436 / 436 / 436 |
| random heap, admin | 412 | 82,368 | 1,435 s | 3,418 / 6,158 / 8,519 / 10,175 |

**The two export runs are not the same window.** The random-heap run saw 82,368 rows; the chronological run saw 92,018, because the C1 runs in between added about 9,600 orders, all dated today and so inside the 30 days. Per page the two are about the same (p50 3.4 vs 3.6 s), so the chronological heap did not speed the export up; the export time scales with the page count. R1 ("today") also got heavier: today now holds the C1 orders (about 3,000 per run) on top of the seeded ones, in the R1 rows of the later run.

Random heap run (first run, for comparison), admin: R1 13/56 ms (p50/p95), R2a 2,887/3,568, R2b 1,459/3,197 (p99 6,139),
R3a 4,631/5,547, R3b 4,680/10,249 (p99 11,235), R4a 2,072/3,583, R4b 3,872/3,980, R4c 105/117, R5a 928/1,081. Manager values were small (R2a 21/23, R2b 183/197, R3 123-145 ms, R4 116-192 ms).

## C1, the busy moment

60 cashier clients (2 per outlet, each its own login), 50 sales each through `POST /api/v1/sync/batch` in chunks of 25 (`BATCH_MAX_ITEMS`
of `packages/sync`), all starting together, then all 3,000 resent. One shift per outlet is opened through the real `shift_open` item
(the DB allows one open shift per outlet, so the two cashiers of an outlet share it). Payload and envelope follow `orderPayload` /
`Envelope` of `backend/internal/sync`. 30% of the sales carry a customer. 5 Backoffice clients loop R2a + R4 (summary and dashboard) the whole time.

| Configuration | Requests | p50 | p95 | p99 | max | Time until all 3,000 accepted | Errors |
|---|---|---|---|---|---|---|---|
| 1 tablet (50 sales) | 2 | 817 ms | 905 ms | 905 ms | 905 ms | 1.7 s | - |
| 10 tablets (500 sales) | 20 | 1,209 | 1,293 | 1,293 | 1,293 | 2.5 s | - |
| **60 tablets, no Backoffice** | 120 | 8,363 | **8,479** | 8,580 | 8,604 | 16.8 s | none |
| **60 tablets + 5 Backoffice (final run, clean: no `busy`)** | 120 | 16,320 | **18,001** | 18,115 | 18,123 | 34.0 s | none |
| 60 tablets + 5 Backoffice, run A (clustered table) | 120 | 19,541 | 20,954 | 21,112 | 21,116 | 40.3 s upload; **about 46 s** until all 3,000 accepted (152 items `busy` in the upload pass, accepted on the resend) | 152 x `busy` (retryable, no effect) |
| 60 tablets + 5 Backoffice, run B (clustered table) | 120 | 18,959 | 20,820 | 20,830 | 21,047 | 39.5 s upload; **about 46 s** until all 3,000 accepted (171 `busy`, accepted on the resend) | 171 x `busy` |
| replay of 3,000 (final run) | 120 | 2,249 | 2,327 | 2,339 | 2,345 | 4.6 s | 3,000 x `duplicate` |
| replay, no Backoffice | 120 | 1,151 | 1,274 | 1,285 | 1,292 | 2.4 s | 3,000 x `duplicate` |

Throughput: 179 sales/s without Backoffice, 88 sales/s with it, for one instance with 10 connections.

Backoffice clients during the final run (these include cache hits, so p50 is low; p95 is the real cost): orders p95 2,384 ms, summary p95 5,806 ms, dashboard p95 10,271 ms.

Verification in SQL, final run: new orders after upload 3,000 (expected 3,000); `processed_keys` +3,000; `order_tenders` +3,000;
`order_items` +7,486; duplicate idempotency keys 0, duplicate order numbers among the new sales 0, duplicate order uuids 0; replay added 0 orders and 0 keys;
stock rows with a wrong delta 0 (9,006 units sold, every `outlet_variant_stock` row moved by exactly its sold quantity); `product_variants.stock` untouched; no 409/429/5xx.

Other runs of the same scenario, for honesty:

- Two earlier runs with Backoffice load on the clustered table returned **152 and 171 items as `busy`** ("Ditunda: batas waktu proses batch tercapai", the 20 s per-batch work budget) in the upload pass. They are retryable, took no effect, and landed on the resend (replay: 2,848 `duplicate` + 152 `ok`), ending at exactly 3,000 orders with exact stock. The tablet engine retries these by itself. So under combined load the budget is reached; nothing was lost or doubled.
- The first run (random heap, before the `CLUSTER`) had 3 + 3 HTTP 500s from Backoffice reads: Postgres `could not resize shared memory segment ... No space left on device` (parallel workers, Docker's 64 MB `/dev/shm`). A local Docker artifact, not an application bug.
- An earlier harness bug (client order numbers colliding across runs through a 4-hex device prefix) showed up as 50 duplicate order numbers. Fixed in the harness (8 hex); worth knowing that `orders.order_number` has no unique index (the client-supplied number is not enforced unique; production numbers carry a registered device code).

## Slow statements and fixes

`log_min_duration_statement = 300`, aggregated with `loadtest/slowlog.mjs` over the read runs and C1 (random and chronological heap):

| # | Statement (endpoint) | Calls over 300 ms | Avg | Max |
|---|---|---|---|---|
| 0 | `SELECT json_build_object(...) ... count(*) OVER() ... FROM orders o ... ORDER BY created_at DESC LIMIT/OFFSET` (`GET /orders`) | 645 | 3.6 s | 14.8 s |
| 1 | `WITH sb AS MATERIALIZED (...)` (`GET /reports/summary`) | 64 | 3.4 s | 12.1 s |
| 2 | `WITH win(w,f,t) AS (VALUES ...)` (`GET /reports/dashboard`) | 55 | 3.8 s | 5.0 s |
| 3 | `SELECT json_build_object(... customers ...) count(*) OVER()` (`GET /customers?q=`) | 110 | 0.9 s | 2.3 s |

### 1. `GET /orders` (R2, R3, R6): `count(*) OVER()` forces the whole filtered set through the row projection

`EXPLAIN (ANALYZE, BUFFERS)` of page 1, 30 days, all outlets (random heap): 3,261 ms. The plan is `Limit -> Incremental Sort -> WindowAgg ->
Index Scan using idx_orders_created`, which reads all 92,018 rows of the window (3.1 s) and evaluates the four correlated sub-selects of
`orderObj` (tenders, refunds, refund items, order items) for every one of them, to produce 50 rows. On the chronological heap the same plan takes 921 ms.

Measured on the random heap, without schema changes:

| Variant | Execution |
|---|---|
| current page 1 | 3,261 ms |
| page 1 without the window, plus a separate `SELECT count(*) ... WHERE business_date BETWEEN ...` | 10 ms + 203 ms (random heap; 37 ms on the chronological heap, index-only) |
| current page 200 (offset 9,950), window removed | 2,670 ms (the projection still runs for the 9,950 skipped rows) |
| page 200 selecting only `id` first (`FROM (SELECT id ... ORDER BY created_at DESC, id DESC LIMIT 50 OFFSET 9950) pg JOIN orders o ON o.id = pg.id`) | 31 ms |

**Proposed fix (no schema change):** in `read.Repo.Orders`, (a) drop `count(*) OVER()` and run a separate count (or skip it when the client does not need it), and (b) paginate by id first, then project
only the page's rows. Expected: R2a about 10-40 ms plus count, R2b about 30 ms, R3 limited by the `ILIKE` scan only. Same change for `GET /customers` (statement 3: the plan is `WindowAgg -> Index Scan using idx_customers_spent`, 10,000 filtered rows in 1.9 s for 50 returned).

The export then costs about 40 ms + count per page. At 461 pages that is 20-110 s depending on the count, still over 30 s unless `fetchAllPages` asks for the total once (it currently compares `meta.total` on every page), uses a keyset cursor, or the export becomes a server-side streamed CSV. This end-to-end figure is an estimate, not measured.

`q` search (R3): `customers` already has trigram GIN indexes on name, phone and phone_norm. The cost is that the `ILIKE '%x%'` over `orders.order_number`, `cashier_name` and `customer_name` has no trigram index, and the `OR EXISTS (SELECT 1 FROM customers c WHERE c.id = o.customer_id AND ...)` is evaluated once per order row, so the whole order set is scanned. A `pg_trgm` GIN index on `orders(order_number)` and `orders(customer_name)`, and resolving the customer match first (customer ids from the trigram index, then `o.customer_id = ANY(...)`), is the usual fix. Not measured.

### 2. `GET /reports/summary` and `/reports/dashboard` (R4a, R4b)

`EXPLAIN` of the logged summary statement: 3,423 ms (random heap) / 3,660 ms (chronological). Parallel bitmap scans over about 92k orders joined with
tender lines and refund rows, several sorts spilled to disk (`external merge` 2-18 MB, `temp read/written` about 14,500 blocks). `SET work_mem = '64MB'` only moved it to 3,355 ms, so the cost is the scan-and-aggregate of all orders in the window on every request, not just the spill. The dashboard statement is similar (5,950 ms; 4,761 ms with 64 MB). Both rise to 6-10 s under C1.

**Proposed fix:** a per-outlet, per-business-day, per-tender-method rollup (a table maintained in the sale/refund transaction, or refreshed incrementally) that the summary and dashboard read instead of scanning orders. Expected: tens of ms for a 30-day window. Not prototyped. A cheaper stop-gap is a longer cache TTL for these two reads (the current TTL is 15 s and every sale batch invalidates it).

### 3. Sale upload (C1)

The slow part is not one statement. From a `log_min_duration_statement = 0` trace of one tablet (100 sales): **about 31 statements per sale, 6 ms of database execution per sale, but about 25-33 ms wall per sale**, so roughly three quarters of the time is round trips and Go work between statements. Some repeat for every item of a batch: `SELECT outlet_id, status FROM shifts WHERE id=$1` about 4 times per sale, user and permission lookups, `SELECT 1 FROM outlets ... FOR NO KEY UPDATE`. A 25-sale request therefore takes about 0.8 s even alone, so the 1 s mark is already marginal before any contention. With 10 connections the ceiling is 10 / 0.055 s = about 180 sales/s; 60 requests arriving together queue behind each other (8.5 s p95), and the heavy Backoffice reads take connections and CPU from the sales (18 s p95, `busy` deferrals).

Local round trips cost about 0.3 ms; a Cloud Run to Neon round trip is several ms, so the same 31 statements may be several times slower in production. This is the number to re-measure first against Neon.

**Proposed fixes (not done, no code changed):** cache per-batch lookups (the shift state, the outlet row, the user's permissions) instead of re-reading them per item; cut the round trips per sale, for example with pgx batching; keep Backoffice aggregates off the sale connections (a separate pool or a read replica); raise `DB_MAX_CONNS` only together with the Neon pooler budget. Expected gain: sale latency roughly proportional to the statements removed; not measured.

## Incident during the test

During the chronological `reports/summary` run (14:06 local) Docker Desktop stopped both containers of the `roletest` project (exit 255, Postgres log shows an abrupt end, "not properly shut down; automatic recovery"). I do not know the cause (the summary query uses parallel workers and temp files; memory and `/dev/shm` pressure are suspects). The role-test Postgres and Redis were down for about 15 minutes. I restarted both with `docker start`; Postgres recovered from WAL and `mandalika_pos` is intact (not inspected beyond the database list). The role-test backend process on :8080 was not touched. Whoever owns the role test should know.

## Caveats

- One backend instance with the default `DB_MAX_CONNS` (10) is roughly one Cloud Run instance; production runs up to 4 x 10 connections. Not tested with several instances or a different pool size.
- Laptop Docker Postgres is not Neon: local round trips are about 0.3 ms, compute and cache are different (128 MB `shared_buffers` against a 2 GB database), and `fsync` goes to a Docker volume.
- The numbers are relative: they locate bottlenecks, they are not a production SLA.
- The heap layout effect (above) shows how sensitive the lists are to cache state; the cold random-heap numbers are a worst case, the chronological ones a warm-ish best case.

## Not covered

- Neon (latency, autoscaling, pooler), several instances, `DB_MAX_CONNS` sweeps, Cloud Run CPU.
- The real Backoffice browser and Cloudflare in front; response sizes (a 200-row page is about 390 KB of JSON).
- Sales with promotions, loyalty points, discount codes, split tenders, tax, bundles, BXGY; refunds and shift closes through sync; cash flows.
- Customer writes, imports, merges, the ERP outbox relay, OTA, stock transfers, inventory documents.
- Autovacuum / `VACUUM` state, index bloat, longer soak, a real-time busy moment at 30 outlets with offline backlogs larger than 50 sales.
- `GET /orders?q=` with a customer-name search and `refund`-basis lists; `/shifts`, `/products`, `/customers/{id}/profile`.
- The `pg_stat_statements` view (needs a Postgres restart of the shared container).
