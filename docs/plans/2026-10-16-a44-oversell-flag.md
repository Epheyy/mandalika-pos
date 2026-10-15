# A44 — Oversell flag and report ("Stok Minus") — implementation plan

Date: 2026-10-16 · Author: Claude (Opus 5.5, planner) · Branch: `prod-hardening` · Status: PLAN (not started)

Sources: `AUDIT_REPORT.md` A44 (and A17 context), `docs/audits/2026-10-14-audit-status-sweep.md` A44,
`HANDOFF.md` Decisions 2026-10-14: **"A44 short stock: never block a sale (negative stock allowed, matches
allowNegativeStock default) but flag and report every oversold line so auditor/cashier human errors surface."**

## 1. Current code (verified 2026-10-16 at 0c14609)

- **Sale stock decrement**: `backend/internal/service/order.go` `createOrder`, lines ~387-430. `lockStockRowsSorted`
  (`service/lockorder.go:93`) sorts the row locks (A42). Then, per line: lazy `INSERT … outlet_variant_stock … 0 WHERE
  EXISTS product_variants`, `SELECT stock … FOR UPDATE`, `next := stock - qty`.
  - `ErrNoRows` → `continue` (`:411`): a line whose variant has no `product_variants` row (deleted/renamed variant) moves
    no stock and leaves **no record** (the other half of A44).
  - `next < 0 && in.Offline` → keep the negative, `stockWarning = true` (`:418-419`).
  - `next < 0 && !in.Offline` → **`next = 0`** (`:421`): the shortfall disappears silently and is not flagged.
- **Which path real sales take**: `sync/sync.go:381` hard-codes `Offline: true` for every `/sync/batch` order. No app
  or package calls `POST /api/v1/orders` (grep of `apps/`, `packages/`, `scripts/`, `tests/`; only the PG-gate
  harnesses do). So **every real POS sale already goes negative and gets flagged**; the zero floor only hits the direct
  API route (tests and any future direct client).
- **Order flag**: `orders.stock_warning` (mig 0002) is set but **never read**: `read/repo.go` `orderObj` (~:960) does
  not project it, the OpenAPI `Order` schema lacks it, and the backoffice never shows it. It only reaches the tablet as
  `SyncItemResult.stockWarning` (`sync.go:161,387`). `discount_warning`/`tender_warning` are projected, and
  `Orders.tsx:191` shows a discount badge.
- **No per-line record anywhere.** No exception/movement table exists (A17: sales/refunds/transfers mutate balances
  directly; there is no unified movement ledger).
- **Refund** `RefundTx` (`order.go:770-800`) restocks **every** `order_items` row by upsert, with no `product_variants`
  EXISTS guard. Effects:
  - With the online clamp: stock 0, sell 2 → 0, refund → **2** (phantom +2).
  - For a line the sale skipped (no variant row): refund creates or increments an orphan stock row (phantom stock). If
    the whole product was deleted, the products FK makes the refund fail.
- **`allowNegativeStock`** (mig 0033, default `true`; read `read/repo.go:902`, write `write/repo.go:980`, backoffice
  toggle "Izinkan stok minus" `SettingsScreen.tsx:139`). The server **ignores it** (always lenient). The POS uses it
  only in `CheckoutPanel.tsx:115` `overstockLines(...)`:
  - `false` → a warn + "Lanjutkan" override modal at Konfirmasi.
  - `true` (the default) → no checkout warning at all.
  - **Correction to the brief:** with the default setting the cashier sees no oversell warning at checkout.
- **POS blocks before checkout, regardless of the setting.** Pending-adjusted stock comes from
  `SyncEngine.pendingStockDeltas()` → `applyPendingStock` → `displayProducts`.
  - `ProductGrid.tsx:107` disables the tap when the product's total stock ≤ 0.
  - The variant popup "+" is capped at `v.stock` (`:394`).
  - Barcode scan toasts "Stok habis" and refuses (`CashierScreen.tsx:327`).
  - Not capped: the cart "+" (`Cart.tsx:139`) and reward/bundle lines.
  - So today, oversell reaches the server mainly through the cart "+", multi-tablet races on one outlet, stale
    snapshots, and late offline syncs. See owner question Q2.
- **Reports**: `Reports.tsx` tabs `Transaksi | Ekspor | Shift | Hadiah Promo | Kode Diskon`. Server-side reports
  (`read/repo.go` `PromoRewardGrantReport`, `DiscountCodeReport`) use `{summary, data, meta}`, WIB date bounds,
  `pageLimit` (max 200) and `scope(r)` outlet clamping (handlers.go:440-480; the grant report once had an outlet IDOR).
  Routes sit in the `view_reports` group (`server/server.go:300-306`). `MovementSummary` (`read/repo.go:1687`) derives
  sold/refunded from `order_items`.
- **Badge pattern**: `useSyncReviewCount` (60 s poll + change event) feeds the sidebar badge (`App.tsx:121,193`).
- **CSV**: `lib/csvUtils.ts exportToCSV` is **not formula-safe** (A39 will fix this; coordinate).

## 2. Decision: the online path records the true negative (drop `next = 0`)

Under the owner rule (never block, negative allowed), **both paths decrement the full quantity, let stock go negative,
set `stock_warning`, and write a per-line record.** Justification:

1. **Balance = sum of movements.** The clamp is an unrecorded `+shortfall` adjustment, so the balance stops being
   explainable (A17), and sale→refund is no longer an inverse. Example: stock 0, sell 2 → 0, refund +2 → 2. Without
   the clamp: −2 + 2 = 0, which is correct.
2. **A14 difference apply** (`final = current + (counted − frozen)`) assumes every sale decrements exactly. A clamped
   sale during a count yields a wrong final stock.
3. **One rule for one business event.** The only production path (sync) already goes negative. The clamp exists only
   on an unused route and was kept for "legacy parity", not by owner policy.
4. **Accuracy effect.** The negative balance shows exactly how far the system is behind physical reality until a stock
   count (A14) corrects it. The count's difference then appears in the opname column of the movement summary.

**`allowNegativeStock=false` conflict**: none on the server. The setting stays a POS-only "warn the cashier" switch
(warn + override, never block), so the owner rule holds for both values. The server records the oversell for both
values. (Optional, not in scope: relabel the toggle "Peringatkan kasir saat stok kurang" so `false` does not read as
"block".)

**Tests that change on purpose** (owner decision 2026-10-14, not a weakened guard; the reviewer must see this note):
- `service/order_input_test.go` `TestSaleInputPreservesKnownReceiptAndQ08Shortage`: subtest "direct floor" →
  `wantStock -1`, `warn == true` on both paths. Rename it to "direct negative".
- `handlers/lock_order_integration_test.go:119` `sale_vs_sale_new_stock_rows` asserts 0/0 → assert `-qty` each.
- Checked, no other change needed: `sale_input_integration_test.go:279-307` (S0C) already expects −1 on the batch
  path. `tender_rules_integration_test.go:233-240` (TD) and `linked_fulfillment_integration_test.go:188,242` (LF) assert
  an exact `before − qty`, which stays true. The other `lock_order` stock checks (:104,:107,:142,:297,:325) sell from
  1,000,000 stock. `stock_count_integration_test.go` (SC) sells within stock.

No backfill: the existing `stock_warning`/negative rows are test data (pre-launch), and `stock_before` cannot be
reconstructed. The report starts at deploy time.

## 3. Data model — migration `0055_sale_stock_exceptions.sql`

0055 is the next free number after 0054, but the A39 plan (`docs/plans/2026-10-16-a39-csv-import.md:57,212`) also
claims 0055 (`import_runs`) and gate port 56456. Whichever merges second renumbers: A44 becomes **0056** if A39 lands
first. A39 also plans the formula-safe exporter, which T13 reuses.

```sql
CREATE TABLE IF NOT EXISTS sale_stock_exceptions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id             uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  order_item_id        uuid NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  order_number         text NOT NULL,
  outlet_id            uuid NOT NULL REFERENCES outlets(id),
  product_id           uuid NOT NULL,              -- no FK: the product may be deleted later
  product_name         text NOT NULL,
  variant_size         text NOT NULL,
  kind                 text NOT NULL CHECK (kind IN ('shortage','unresolved_variant')),
  quantity             integer NOT NULL CHECK (quantity > 0),
  stock_before         integer,                    -- NULL for unresolved_variant
  stock_after          integer,                    -- NULL for unresolved_variant
  shortfall            integer NOT NULL CHECK (shortfall > 0 AND shortfall <= quantity),
  channel              text NOT NULL CHECK (channel IN ('sync','direct')),
  cashier_id           uuid NOT NULL,
  cashier_name         text NOT NULL,
  shift_id             uuid REFERENCES shifts(id) ON DELETE SET NULL, -- nullable: sale while shift_open still syncing
  device_id            uuid,
  sold_at              timestamptz NOT NULL,       -- COALESCE(client_created_at, now()): the business time
  recorded_at          timestamptz NOT NULL DEFAULT now(), -- server apply time; sold_at→recorded_at = sync lag
  acknowledged_at      timestamptz,                -- Q1; columns ship either way (nullable, cheap)
  acknowledged_by      uuid,
  acknowledged_by_name text,
  acknowledge_note     text CHECK (acknowledge_note IS NULL OR length(acknowledge_note) <= 500),
  UNIQUE (order_item_id, kind)                     -- one record per line and kind (sale-side; refund-side in Phase 4)
);
CREATE INDEX IF NOT EXISTS idx_sse_outlet_sold   ON sale_stock_exceptions (outlet_id, sold_at DESC);
CREATE INDEX IF NOT EXISTS idx_sse_sold          ON sale_stock_exceptions (sold_at DESC);
CREATE INDEX IF NOT EXISTS idx_sse_product_sold  ON sale_stock_exceptions (product_id, variant_size, sold_at DESC);
CREATE INDEX IF NOT EXISTS idx_sse_cashier_sold  ON sale_stock_exceptions (cashier_id, sold_at DESC);
CREATE INDEX IF NOT EXISTS idx_sse_order         ON sale_stock_exceptions (order_id);
CREATE INDEX IF NOT EXISTS idx_sse_open          ON sale_stock_exceptions (outlet_id) WHERE acknowledged_at IS NULL;
```

- **Shortfall maths, per line, under the row lock.** `covered = clamp(stock_before, 0, qty)` and
  `shortfall = qty − covered`. A row is written only when `shortfall > 0`. If stock was already ≤ 0, the whole line is
  short.
  - Several lines of one SKU (paid line plus reward/bundle line) are processed in order, and each line sees the previous
    line's decrement. So Σ shortfall over the order equals the total pushed below zero.
- **`channel` is transport, not connectivity.** The POS sends every sale through the outbox even when online, so
  "offline" in code means `sync`. The signal for "sold against stale stock" is the sync lag (`recorded_at − sold_at`)
  plus the device.
- **`stock_before` is the server balance when the sale is applied**, not what the tablet showed. A late offline sync
  can be recorded short because of other sales made in between. The report shows the lag so the auditor can tell a
  "cashier oversold" case from a "sync race".
- **Denormalized** (order number, outlet, names, cashier, shift, device) so the report reads one table plus an
  `orders` PK join for status. These are immutable sale-time facts.
- A narrow exception ledger, **not A17**: when A17's movement ledger lands, these rows map 1:1 to "sale movement with
  shortage" (`source = order_item_id`). No design conflict.

## 4. Tasks

Tier rule (AGENTS.md): Opus reviews anything touching stock, SyncEngine, outbox, generated types, auth, or payments.

### Phase 1 — record in the sale transaction (backend core) · size M (~1 day) · **Opus review**

**T1 Migration 0055** (above). Files: `backend/internal/db/migrations/0055_sale_stock_exceptions.sql`.
Verify: migrate a fresh PG plus a re-run (`IF NOT EXISTS`); `go test ./internal/db/...` if a migration-list test exists.

**T2 CreateOrder writes the record; drop the clamp.** Files: `backend/internal/service/order.go`, a new
`backend/internal/write/stock_exception.go` (`InsertSaleStockException(ctx, tx, row)`, mirroring
`write.InsertRewardGrant`).
- In the stock loop, compute `shortfall` from `stock` (before) and `it.Quantity`, and delete the `next = 0` branch.
  `stockWarning = true` whenever `shortfall > 0`, on both paths. Append `{lineIndex, stockBefore, stockAfter,
  shortfall, kind:"shortage"}` to a local slice (collected like `rewardGrants`; nothing is written before the order row
  exists).
- **Line ids**: generate each `order_items.id` in Go (`uuid.New()`) and insert it explicitly. This is preferred over
  `RETURNING id` because `order_items` keeps `Exec`, which keeps the fake tx in `order_input_test.go` simple.
- After the `order_items` loop (and before `processed_keys`), insert one exception row per collected entry:
  - `channel = sync` if `in.Offline`, else `direct`
  - `sold_at = COALESCE(in.ClientCreated, now())`
  - `cashier_id/name = in.CashierID/Name` (server-attributed, A04)
  - `shift_id = in.ShiftID` (nullable), `device_id = in.DeviceID`, `order_number = orderNumber`
- Lock order (A42) is unchanged: these are inserts of new rows only. FK key-share locks land on rows this tx already
  locks or key-shares: own order and items, outlet, shift.
- Update the `createOrder` doc comment and the `CreateOrderInput.Offline` comment ("allows stock to go negative" → both
  paths).

Verify (unit, `service/order_input_test.go`, fake tx; extend the fake to capture exception inserts):
- direct and sync with stock 0, qty 1 → stock −1, `warn` true, one exception row (before 0, after −1, shortfall 1,
  channel correct)
- stock 1, qty 3 → shortfall 2
- stock −2, qty 1 → shortfall 1
- two lines of the same SKU (stock 1, qty 1 + 1) → line 1 shortfall 0 (no row), line 2 shortfall 1
- stock ≥ qty → no row, no warn
- replay of a known key → zero writes (existing assertion); the exception insert is not attempted

**T3 Replay/idempotency safety (verification only, no new mechanism).**
- The record lives in the same tx as the order. A replay returns at the `processed_keys` check (`:147-153`) before any
  write.
- A concurrent same-key race loses at a unique constraint and `replayAfterConflict` rolls back the whole tx,
  exception rows included.
- `RetryBusy` re-runs a full fresh tx. `UNIQUE(order_item_id, kind)` is defense in depth.
- The `/sync/batch` order path does not use `operation_receipts` (only refunds and shifts do), so no receipt
  interaction.
- Verify in the PG gate (T5): the same batch item sent twice, two concurrent sends of one key, and a direct POST replay.
  Each must leave exactly one exception row per short line.

**T4 Adjust the intentionally changed tests** (section 2 list). Each changed assertion gets a comment citing "A44 owner
decision 2026-10-14".

**T5 PG gate `OS` — `TestOversellPostgres`, port 56457** (56456 reserved for A39).
Files:
- new `backend/internal/handlers/oversell_integration_test.go`, using the fixture guard pattern from
  `stock_count_integration_test.go:33-58`: `MANDALIKA_OS_TEST_DSN`, `127.0.0.1:56457`, db `mandalika_os_synthetic`,
  user `os_test`, data-dir check
- `scripts/ci/postgres_gate.py` `GATES` + `("OS", "TestOversellPostgres", 56457, "os")`
- `RUNBOOK.md` gate list (AU is listed there)

Cases:
1. sync sale beyond stock → negative balance, `orders.stock_warning`, one row with exact fields (incl. shift, device,
   sold_at = client time)
2. direct sale beyond stock → negative (not 0), row with channel `direct`
3. replay (same key, sequential and 2 concurrent) → one row
4. multi-line same SKU maths
5. refund of an oversold order → stock back to the pre-sale value exactly; the row is unchanged
6. sale within stock → no row
7. report endpoint: filters, totals, scope clamp (a non-admin `?outletId=` other outlet → own outlet only), pagination
   meta, CSV-relevant fields present (added in Phase 2)

Verify: `python scripts/ci/postgres_gate.py --runtime native --pg-bin "C:/Program Files/PostgreSQL/18/bin" --no-race
--output os.json` → all gates green (current 17 + OS); `go test -race ./...`; `gofmt -l`.

### Phase 2 — read API, OpenAPI, generated types · size M (~1 day) · **Opus review** (generated types)

**T6 Repo query** `read/repo.go` `SaleStockExceptionReport(ctx, f ExceptionReportFilters, page, limit)`.
- Filters (all optional, the same `$n = '' OR …` style as the grant report): `dateFrom`/`dateTo` (WIB days on
  `sold_at`), `outletId`, `productId`, `variantSize`, `cashierId`, `kind`, `status` (`open`/`acknowledged`, used only if
  Q1 = acknowledge).
- Returns:
  - Summary over the filtered set: `lines`, `orders`, `totalShortfall`, `activeShortfall` (order completed),
    `reversedShortfall` (order refunded/cancelled), `openCount`, plus `byProduct` and `byCashier` breakdowns
    (top 50 by shortfall).
  - Page rows: all record fields plus `orderStatus` (JOIN `orders` by PK), `currentStock` (LEFT JOIN
    `outlet_variant_stock`), `sku` (LEFT JOIN `product_variants`), and `outletName`. Ordered `sold_at DESC, id`.
- `count(*)` for meta.

**T7 Handlers + routes** in `handlers/handlers.go` (or a new `handlers/oversell.go`) and `server/server.go`:
- `GET /api/v1/oversell-report` in the `view_reports` group. **Outlet from `scope(r)` only**, never the raw query
  param.
- `GET /api/v1/oversell-report/open-count` → `{openCount}` (cheap, partial index) for the badge. Same group.
- Only if Q1 = acknowledge: `POST /api/v1/oversell-records/acknowledge` with body `{ids: [≤200 uuids], note?}`.
  - Strict body decode (A43 pattern: malformed → 400, 16 KiB cap).
  - `UPDATE … SET acknowledged_* … WHERE id = ANY($1) AND acknowledged_at IS NULL AND outlet in scope` returns the
    count (idempotent; a re-ack is a no-op).
  - Permission: see Q1 (default proposal `manage_stock_count`).

**T8 Expose `orders.stock_warning`** (completes the full path for an existing column): add `'stockWarning',
o.stock_warning` to `orderObj` (`read/repo.go` ~:968) and `stockWarning: { type: boolean }` to the OpenAPI `Order`
schema. Write path: already in the `INSERT INTO orders` at `order.go:450`; no UPDATE path exists.

**T9 OpenAPI + codegen**:
- `backend/api/openapi.yaml`: the paths above, schemas `OversellReport{summary,data,meta}`, `OversellRecord`,
  `OversellSummary`, `OversellBreakdown`, `OversellAckInput`.
- Regenerate `backend/internal/api/api.gen.go` and `packages/api/src/schema.d.ts`.
- `packages/api/src/client.ts`: `oversellReport(params)`, `oversellOpenCount()`, `acknowledgeOversell(...)`.
- Nullable fields (`stockBefore`, `shiftId`, `acknowledgedAt`) are plain `nullable: true`. **Not `$ref` + nullable**:
  that is the known openapi-typescript drop.

Verify: `corepack pnpm gen:check`, `scripts/check-api-schema.mjs`,
`handlers/contract_consumers_integration_test.go` (if it enumerates routes), and the PG gate case 7.

### Phase 3 — backoffice "Stok Minus" tab, badge, CSV · size M (~1 day) · **Haiku review** (no stock/auth logic)

**T10 Tab** `apps/backoffice/src/screens/reports/OversellTab.tsx`, registered in `Reports.tsx` `ReportTab` +
`visibleTabs` (`view_reports`).
- Reuses the shared `dateFrom`/`dateTo` and outlet. Adds its own filters: product (reuse `ProductVariantPicker`),
  cashier (from `/users` if permitted, otherwise a select built from the summary's `byCashier`), kind, and status.
- Summary cards: lines / orders / total shortfall / still-active vs reversed by refund.
- By-product and by-cashier tables.
- Paged table: time, No. transaksi, outlet, product + size, qty, stock before → after, shortfall, cashier, shift,
  channel, sync lag, order status badge, current stock.
- Row click → inline order detail built from the record plus that order's other exception rows. Show the link to the
  `Transaksi` order detail only when the user has `view_transactions` (the tab itself only needs `view_reports`).
- Q1 = acknowledge: checkboxes + "Tandai sudah dicek" + optional note; fire a `mandalika:oversell-changed` event.

**T11 Badge**: `useOversellOpenCount` (copy of `useSyncReviewCount`, 60 s poll + change event).
- Count shown on the "Laporan" sidebar item (`App.tsx` ~:193) and the tab label "Stok Minus (N)".
- Without acknowledge (Q1 = plain count), the badge = lines in the last 7 days. With acknowledge = open rows.
- Clicking the badge opens the tab preset to the badge's own range/status, so the two numbers match.

**T12 Order-level badge**: `Orders.tsx` (~:191, next to discountWarning) shows "⚠ Stok" when `o.stockWarning`.

**T13 CSV export, formula-safe**: a `csvCell` rule in `apps/backoffice/src/lib/csvUtils.ts`.
- Only **string** cells starting with `= + - @ \t \r` get a leading `'`. Numbers pass through, so negative stock stays
  numeric. Add unit tests.
- If A39 has already shipped a shared safe exporter, use that instead (coordinate; do not fork two helpers).
- Export pages through the report at limit 200, up to 5,000 rows, with a visible "data terpotong" note when capped.
- Indonesian headers; filename `stok-minus_<from>_<to>.csv` (WIB date, not `toISOString`).

Verify: vitest for `csvCell`/export and the tab render (mock api); `corepack pnpm quality:ci`; `browser:ci` if a
scenario is added (optional: one Chromium scenario for the tab + export).

### Phase 4 — unresolved variants + refund restock guard (rest of A44) · size S-M · **Opus review** · droppable

**T14 Record skipped lines.** In the `ErrNoRows` branch (`order.go:410-411`), unless `it.IsBundle`, collect
`kind = 'unresolved_variant'`, `shortfall = qty`, `stock_before/after = NULL`. The sale still succeeds; stock is still
not moved.

**T15 Refund guard — one rule: restock exactly what the sale decremented.** In `RefundTx` (`:770-800`), skip the
restock for a line that has an `unresolved_variant` exception row (the sale moved no stock for it). Every other line is
restocked as today.
- Variants and products are **hard-deleted**: `write/repo.go:300` deletes the `product_variants` row and its
  `outlet_variant_stock` rows, and `DeleteProduct` (:326) deletes the product, cascading stock rows. Case: a line sold
  normally, then its variant was deleted before the refund. The upsert recreates an orphan stock row for a size that no
  longer exists. If the whole product was deleted, the products FK fails the refund.
- Decision for that case: do not restock and do not fail. Record it as an exception: add `'refund_unresolved_variant'`
  to the `kind` CHECK, and change the uniqueness to `UNIQUE (order_item_id, kind)` so a line can carry one sale-side and
  one refund-side row. The refund is then explainable, and no stock is silently lost or invented. Phase 4 ships this in
  0055 if it goes with Phases 1-3; otherwise add it in a follow-up migration.
- This changes refund stock behavior → Opus review.
- Extend the RF parity gate (`refund_parity_integration_test.go`) and the OS gate: sell an existing variant, delete the
  variant, sync a late offline sale of it → a row is recorded. Refund it → no orphan row, refund ok.

Matches the audit acceptance test ("delete/deactivate a variant after an offline sale … movement remains explainable").
`order_items` already carries product name and size; no change there.

### Phase 5 — POS (only if Q2 = "stop blocking") · size S · **Opus review** (touches `displayProducts`/pending stock UI)

- Allow tapping, variant "+" and scan for stock ≤ 0, with a red "Stok habis/minus" indicator and a toast warning
  instead of refusing. Files: `ProductGrid.tsx` (:107, :394), `CashierScreen.tsx` (:327). Keep the
  `CheckoutPanel` overstock modal behavior as it is.
- Web layer only → ships by **OTA** (or rides the next APK; the fleet is not rolled out yet). **No APK required.**
- Verify: `stock.test.ts` + component tests; emulator check of tap/scan at stock 0.

**No POS payload change is needed in any phase.** The server computes the shortfall from its own locked balance, so
every APK already in the field (1.x–2.1) is covered. A "cashier pressed Lanjutkan" flag was considered and deferred: it
is almost always false while the setting defaults to `true`.

## 5. Refunds and cancellations

- Exception rows are **immutable sale-time facts**, like `loyalty_condition_applications` and `promo_reward_grants`.
  `RefundTx` does not touch them (no new write in the refund path for Phases 1-3).
- With the clamp gone, refund is an exact inverse: −2 + 2 = 0. The report derives the status by joining `orders`:
  - Rows of a refunded order show "Direfund".
  - The summary splits `activeShortfall` from `reversedShortfall`.
  - Default view: all statuses. The auditor still sees that the cashier sold against no stock.
- **Cancelled**: no order-cancel command exists (`'cancelled'` is only in the CHECK constraint and the
  `MovementSummary` filter). The report treats it like refunded.
- A later stock count (A14) correcting the negative balance is shown indirectly through the `currentStock` column. No
  automatic "resolved" link (that is A17 territory).

## 6. Performance at scale (target 30k–500k customers, 3 brands)

- Exception rows are a small fraction of order lines. Even at 5 % of ~1M lines/year that is 50k rows/year.
- Every filter combination has a leading-column index: outlet+date, date, product+date, cashier+date, and a partial
  open-per-outlet index for the badge. The badge query is an index-only count over open rows.
- Summary/breakdown aggregates scan only the filtered date range. OFFSET pagination matches the other reports (A26
  convention).
- Writes add one INSERT per short line inside the sale tx and no new locks on shared rows.
- Verify once, locally: seed 200k synthetic rows (`generate_series`) in the OS fixture, `EXPLAIN (ANALYZE, BUFFERS)` the
  report (30-day range, one outlet, with and without product/cashier filters) and the open-count. Record the plans
  in this file. Not a CI assertion (too brittle).

## 7. Release

- Backend: Phase 1 + 2 together, plus Phase 4 if accepted.
  - Migration 0055 → **Neon snapshot before the migrating deploy** (A36 decision).
  - `scripts/deploy-backend.sh <tag>` → smoke on the tag: direct oversell → negative + row; sync oversell → row;
    replay → one row; report + open-count 200; scope clamp → `promote-backend.sh`.
  - Rollback to `00106-riq`: the new table is ignored by old code. Old code clamps online again, which is harmless.
- Backoffice: Phase 3 rides the next non-skip push to `prod-hardening` (Cloudflare).
- POS: nothing unless Q2 = stop blocking → OTA.
- Update `HANDOFF.md` and `docs/AUDIT_COVERAGE_TRACKER.md` (A44 → Mostly/Resolved) after release.

## 8. Risks

- **Changed guard tests** could look like weakening a stock guard. Mitigation: cite the owner decision in each changed
  assertion and in the review request.
- **`stock_before` semantics** (server balance at apply time, not the tablet view) can mislabel late-synced sales as a
  cashier error. Mitigation: show the sync lag + device; document it in the tab's help text.
- **Client clock** drives `sold_at` (date filter). A bad tablet clock misplaces rows by date. Same caveat as A28; the
  report also shows `recorded_at`.
- **Migration numbering / gate port** may collide with A39 work in flight. Check before merge.
- **Phase 4 refund change** alters stock on refunds of deleted-variant lines. It is a narrow case but money-adjacent →
  Opus review + RF gate.

## 9. Owner questions (only those that change the design)

- **Q1 — What does the badge mean?**
  - (a) Acknowledge workflow, like Tinjauan Sinkron: an auditor marks lines "sudah dicek" with an optional note, and
    the badge = unchecked lines. Adds one endpoint and a permission choice. Proposal: reuse `manage_stock_count`; say
    if you want a new permission.
  - (b) Plain count of the last 7 days (badge never clears by action).
  - Recommended: (a). The columns ship in 0055 either way.
- **Q2 — The POS blocks earlier than checkout.** Out-of-stock products cannot be tapped or scanned, and the variant
  "+" stops at stock. That contradicts "never block a sale" when the system stock is wrong but the bottle is on the
  shelf.
  - (a) Remove these blocks and show a warning instead. Recommended: it is what lets the oversell report catch auditor
    errors. Ships by OTA, no APK.
  - (b) Keep them; only the cart "+", multi-tablet races and late syncs produce oversell records.
