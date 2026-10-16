# A15 — sold stock reappears on the POS after a sale is acknowledged (plan)

Date 2026-10-17 · Planner: Opus 5.5 (read-only) · Base: prod-hardening @ 339ab5f
Sources: AUDIT_REPORT.md §A15 (line 304); docs/audits/2026-10-14-audit-status-sweep.md §A15 (line 122).
Every task touches SyncEngine, stock and optimistic display, so every task gets an **Opus 5.5 high** review.

## 1. What the code does today (verified)

- **How display stock is computed.** Display stock = snapshot − pending order lines.
  - `SyncEngine.pendingStockDeltas()` (packages/sync/src/engine.ts:546-558) walks `outbox.pending()` only.
  - `pending()` (packages/sync/src/outbox.ts:329-335) drops acked items and parked items (failed with attempts ≥ 5).
  - `CashierScreen.tsx:215-218` applies the deltas via `applyPendingStock` (apps/pos/src/cashier/stock.ts:8-20).
- **What an ack does.** `applyBatch` (engine.ts:892-962) settles the item as acked (settle at :943) and prunes it
  (:947). The debit vanishes in that same step.
- **When the snapshot changes.** Only in `resync()` (engine.ts:352-365), which runs in two places:
  - on mount (apps/pos/src/cashier/SyncProvider.tsx:186);
  - from the manual button (apps/pos/src/hooks/useOfflineData.ts:120-130).

  `start(12_000)` (SyncProvider.tsx:197) only flushes and polls `/sync/version`.
- **What the batch version means.** The batch `version` is `content_versions` (backend/internal/sync/sync.go:252).
  - Sales and refunds never bump it, so it cannot retire a sale debit.
  - Transfer receive does bump it (backend/internal/write/transfer.go:396). That is why `PendingCredits` works for
    receives (packages/sync/src/pendingCredits.ts; stampAck at engine.ts:904, retire at engine.ts:356).
- **`/sync/pull` is NOT cached.** `SyncPull` (backend/internal/handlers/writes.go:1417-1429) calls `Sync.Pull` directly,
  not `h.cached` (handlers.go:92-112; readTTL 15 s at :27). `SyncBatch` also calls `invalidate`. The 15 s TTL is
  therefore not a race window for the POS.
- **`Pull` (sync.go:84-145) is not one transaction.** It reads the version first, then the products, in separate pool
  queries. Per-variant `stock` is read inside one statement (backend/internal/read/repo.go:113-130, outlet-scoped by `$1`).
- **How a sale writes stock.** In backend/internal/service/order.go, `CreateOrder`:
  - locks rows in sorted order (:416);
  - lazily inserts a 0 row (:422);
  - runs `UPDATE ... SET stock=$1` (:464).

  Lines with no variant row are skipped and flagged `unresolved_variant` (A44).
- **What the ack carries.** `ItemResult` (sync.go:157-170) has `stockWarning` but no stock data. OpenAPI defines
  `SyncItemResult` (backend/api/openapi.yaml:1908) and `ProductVariant` (:684).

## 2. Timeline and race windows

Example: snapshot stock 5, sell 2. "Pull" means a `/sync/pull` request.

| Case | Today | Phase A (client) | Phase B (+ server seq) |
|---|---|---|---|
| Offline sale | 3 ok | 3 ok | 3 ok |
| Ack, no pull yet | **5 BUG** | 3 ok (debit kept until a pull sent after the ack) | 3 ok |
| Ack, app restart, still no pull | **5 BUG** | 3 ok (store in KV) | 3 ok |
| Pull sent after the ack | 3 ok | 3 ok (retires) | 3 ok |
| Pull in flight across the ack (sent before, read after commit) | 3 (luck) | **1 LOW** until the next pull | 3 ok (row seq ≥ ack seq retires at once) |
| Lost response, pull, then duplicate ack | 1 LOW until the dup ack | 1 LOW until the next pull | usually ok at the dup ack; LOW if another sale hit the row meanwhile |
| Sale parked for review | **5 BUG** | 3 ok (owner Q1) | 3 ok |
| Settle write fails after the ack | 3 (item stays pending) | 3 ok (pending wins over the provisional copy) | 3 ok |
| Two pulls answer out of order | n/a | **guard needed**: ignore a response older than the last applied one | same |
| Another tablet sells the same SKU | stale until a pull | stale until a pull (not A15) | same (optional auto-pull, T4) |

**Residual in every design.** If the server committed a sale but the response was lost, that sale is subtracted twice
until its retry ack or the next pull. The error is always LOW, never "stock reappears". Strict exactly-once here would
need the pull to report which idempotency keys of this device it already contains. Not proposed (owner Q3).

## 3. Design decision

### Phase A — client only, OTA, fixes the reported bug

- New persisted KV store `settlingDebits`, built like `pendingCredits.ts`.
- When an order acks (`ok` or `duplicate`), copy its lines into the store **before** `outbox.settle`, stamped with the
  current pull generation.
- `resync()` increments a persisted generation `g` before it sends the request. On the response:
  - if `g` is older than the last applied generation, ignore the response (stale-response guard);
  - otherwise retire every entry stamped below `g`.
- Why this is correct: the sale commits before the batch response is sent, and the pull reads the primary uncached.
  Any pull sent after the ack therefore includes the sale.
- No migration, no OpenAPI change, no generated types.
- Phase A is also the mandatory fallback for Phase B whenever a seq is absent: old server, rollback, or a failed read.

### Phase B — recommended hardening

Purpose: exact on in-flight pulls, and robust to a future read cache or replica.

- **Per-row sequence.** New column `outlet_variant_stock.stock_seq bigint`, fed from one global SEQUENCE by a trigger:
  BEFORE INSERT always, BEFORE UPDATE only when stock changes.
  - The trigger covers every writer without touching each one: sale, refund, transfers, goods receipt, stock count,
    CSV import, backoffice.
  - The value is monotonic per row because the trigger runs while the row lock is held.
- **Per-outlet counter rejected:**
  - it puts a hot row in every sale transaction;
  - that row must fit the A42 lock order;
  - "the snapshot covers N" would only hold if `Pull` ran in one REPEATABLE READ transaction.
- **Ack.** Returns `stockSeqs[{productId, variantSize, stockSeq}]`. For `ok` it is the WRITE-TIME seq via `UPDATE ... RETURNING stock_seq` (order.go:464), plumbed out of `CreateOrder` (also used by direct /orders). For `duplicate` it is read after commit.
  The duplicate read is conservative for A11 replays: if a concurrent same-SKU write landed in between it can only err LOW until the next pull. A post-commit read for `ok` too was rejected for the same reason.
- **Pull.** Returns `variant.stockSeq`, read in the same statement as `stock`.
- **Retirement.** An entry retires when the snapshot row seq is ≥ the entry seq, or by the Phase A generation rule,
  whichever comes first.
- **No stock-value overlay.** The post-sale stock value is deliberately not applied as an overlay: it would double-count
  unretired transfer-receive credits, and it adds surface for little gain.

### Rules for both phases

- Provisional entries never live in the outbox or the journal. Acked rows stay pruned, so `unsettledCount` and the
  release guard are unchanged.
- Skip an entry ONLY while its key is still unacked, i.e. in `pending()` or `deadLettered()` (the settle failed). An acked row that lingers because `prune()` was skipped (engine.ts:947 runs only if the refund-memory write succeeded) must NOT suppress the entry, or A15 returns.
- Count only items whose envelope `outletId` equals the current actor outlet (flushOnly / mismatch drain).
- Drop entries whose variant is missing from a new snapshot (rename, backend/internal/write/repo.go:278).
- Stamp inside `applyBatch`, so both callers are covered: `flush` (engine.ts:782) and the isolated resends in
  `onBatchFailure` (:850).
- Refunds unchanged: no optimistic credit; the restock shows at the next pull (owner Q2).
- `PendingCredits` unchanged.
- No content-version bump on sales: it would raise the "update available" wall on every sale.

## 4. Tasks

Every task is written tests-first, implemented by Sonnet 5.5 (medium) and reviewed by Opus 5.5 (high).

### Phase A — packages/sync + apps/pos, OTA only

**T1 (S) Settling-debits store**
- Files: `packages/sync/src/settlingDebits.ts` + `.test.ts`.
- Change: pure add / retire / quarantine-on-corrupt (copy pendingCredits.ts:46-77).
- Verify: vitest.

**T2 (M) Engine changes** (`packages/sync/src/engine.ts`)
- Change:
  - stamp entries in `applyBatch` before settle;
  - add the `resync` generation and the stale-response guard;
  - `pendingStockDeltas` = unacked pending orders + **parked** orders (owner Q1) + settling entries not still queued,
    filtered by outlet.
- Tests first, extending `engine.pendingStockDeltas.test.ts` (keep the existing 4):
  - ack before pull: kept;
  - pull sent after the ack: retired;
  - in-flight pull across the ack: not retired (documents the residual);
  - two pulls out of order: the older one is ignored;
  - lost response, then duplicate;
  - late retry after a retryable failure;
  - parked: kept; resolved/removed: gone;
  - restart between ack and pull (new engine, same KV): kept;
  - settle failure: no double count;
  - refund-memory write fails, so the acked order row is not pruned: debit still counted exactly once;
  - variant missing from the snapshot: dropped;
  - envelope from another outlet: excluded;
  - the `onBatchFailure` isolated path stamps.
- Verify: `corepack pnpm --filter @mandalika/sync test`, then `corepack pnpm quality:ci`.

**T3 (S) POS re-render check**
- Confirm the cashier re-renders after resync (onWall) and after an ack (onOutboxChange).
- Add a case to `stock.test.ts`.
- No `CashierScreen.tsx` logic change expected beyond the existing call at :215.

**T4 (S, optional — owner Q4) Throttled auto-resync**
- Runs only when all of these hold: settling entries exist, the cart is empty, no checkout is open, and `!wall.raised`.
- At most once per 60 s.
- It only shortens staleness; correctness must not depend on it.

**T5 Release A**
- `make ota-release VERSION=2.1.2`. Targets versionCode 12 / APK 2.1 (min-version guard, mig 0049). Codes 10/11 get
  it only via the next APK.
- Emulator checks (Holy Sweet 10ml @ BSD; read the WebView via CDP `Runtime.evaluate`):
  1. Note stock N. Go offline and sell 2: shows N−2.
  2. Go online and wait ≤ 12 s for the ack: still N−2 (today it shows N).
  3. Kill and relaunch before any pull: N−2.
  4. Run a manual resync: N−2, and the `settlingDebits` KV is empty.
  5. Sell, then tap resync during the flush: never above N−2.

### Phase B — backend + generated types (one backend deploy, then OTA)

**T6 (S) Migration**
- File: `backend/internal/db/migrations/0057_stock_seq.sql`.
  - `CREATE SEQUENCE`.
  - `ADD COLUMN stock_seq bigint NOT NULL DEFAULT 0` (metadata-only).
  - plpgsql trigger: on INSERT always set; on UPDATE only when stock changes.
- Tests first: new PG gate **ST `TestStockSeqPostgres`, port 56458**.
  - DSN `MANDALIKA_ST_TEST_DSN`, database `mandalika_st_synthetic`, user `st_test`.
  - Refuse a non-fixture target, as in oversell_integration_test.go:41.
  - Register it in `scripts/ci/postgres_gate.py` GATES.
- Cases:
  - a sale bumps the seq;
  - 2 concurrent sales of the same SKU from 2 devices: strictly increasing, and the pull row seq = the last one;
  - par_level / available / rename updates: no bump;
  - refund, transfer receive and stock-count apply: bump;
  - unresolved-variant line: no entry.
- Rollback: the old revision ignores the column, and the trigger is harmless.

**T7 (M) Server fields + OpenAPI**
- `sync.go`: `ItemResult.StockSeqs` (omitempty).
  - `ok`: write-time seqs returned from the sale tx (new out-field from `CreateOrder`, consumed at sync.go:383; direct /orders ignores it). `duplicate`: post-commit read.
  - The duplicate read is one `unnest` SELECT at the attributed `c.OutletID`, keyed from the payload lines.
  - A read error leaves it empty, which falls back to Phase A.
- `repo.go:113-130`: add the `stockSeq` key next to `stock` in the outlet-scoped object.
- OpenAPI:
  - `SyncItemResult.stockSeqs`: array of plain objects, optional.
  - `ProductVariant.stockSeq`: integer int64, optional, without `$ref` + `nullable` (codegen gotcha).
- Codegen: run both `corepack pnpm gen:check` and backend `make gen-check` (api.gen.go).
- Tests: a batch handler test showing the ack carries seqs, and that a duplicate replays them without a second stock
  move. OS / LO / RF gates must stay green.

**T8 (S) Engine retire-by-seq**
- Retire when the snapshot row stockSeq is ≥ the entry seq. Also check at ack time against the current snapshot.
- Tests:
  - in-flight pull across the ack: now exact;
  - old server (no seqs): generation rule only;
  - mixed batch.

**T9 Release B**
1. Push → CI → Neon snapshot.
2. `deploy-backend.sh` (mig 0057).
3. Smoke:
   - the sale ack has stockSeqs;
   - the pull has a stockSeq ≥ it;
   - a replay causes no double move.
4. Promote.
5. OTA 2.1.3.
6. Emulator steps 1–5, plus a second-device sale via the smoke script.

Tablets should be at 0 pending first (owner rule), even though the change is additive.

## 5. Open questions for the owner

1. **Parked (review) sales.** These never reached server stock. Should the tablet keep subtracting them until head
   office resolves them? Recommend yes; after resolve, server stock shows.
2. **Refunds.** Keep them as today: no optimistic restock, and stock rises at the next pull? Recommend yes, because a
   queued refund can still be refused.
3. **Exactness.** Is "may briefly show LOWER than true after a lost response" acceptable instead of strict
   exactly-once? Recommend yes.
4. **T4.** Ship it (automatic background refresh after sales, cart empty only), or keep manual resync?
5. **Phase B timing.** Ship it now, or Phase A now and Phase B before the Fable re-audit?

**Sizes:** Phase A ≈ 2 days (T1 S, T2 M, T3 S, T4 S optional). Phase B ≈ 2.5 days (T6 S, T7 M, T8 S) plus one deploy.

**Correction to the sweep:** neither phase needs an APK. Both are web-layer only and ship by OTA for versionCode 12.
