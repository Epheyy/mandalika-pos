# A14 — product stock count: lifecycle guard + difference apply

Date: 2026-10-14. Owner decision (HANDOFF 2026-10-14): add an already-completed guard; stock moving during a count
must not block operations; apply the difference, `final = current + (counted − frozen)`. Owner example: frozen 15,
3 sold during count → 12; counted 14 → 11; counted 16 → 13. Caveat: counts must reflect stock at freeze/count time
(per-item count timestamp).

Scope: product stock counts only (`backend/internal/write/stockcount.go`, routes `/stock-counts*`, backoffice
`apps/backoffice/src/screens/StockCount.tsx`). Backend + backoffice; **no POS / APK change**. Ingredient counts
(`ingredient_stockcount.go`) also write absolute values but ingredient stock only moves through backoffice
operations, not sales → follow-up, not this slice.

## Today (broken)

- `frozenQty` comes from the client (polled product list at create). Update and Complete DELETE + re-INSERT the
  client's items, so the client can change `frozenQty` and add products at completion.
- No status guard, no lock. Complete writes the absolute `actual_qty` (`SET stock = EXCLUDED.stock`). A retried or
  double-clicked completion after a sale restores the old count and erases the sale.
- Unknown `status` values are ignored silently.

## Design

### Server owns the baseline

- **Freeze at create and again at start.** `CreateStockCount` ignores client `frozenQty`/`actualQty`/`difference`
  and stores live stock (outlet_variant_stock or warehouse_variant_stock, missing row = 0). `planned → in_progress`
  re-snapshots `frozen_qty` from live stock for every item (a planned count can sit for days). Product name / size /
  sku from the client stay as display labels.
- **Per-item baseline.** In `in_progress`, saving an item's `actualQty` stores, server-side, `baseline_qty` = live
  stock at that moment and `counted_at = now()` — only when the value changes (re-sending the same value keeps the
  original baseline). Clearing (`actualQty: null`) clears actual, baseline and counted_at.
- **Completion applies a delta per counted line:** `delta = actual − COALESCE(baseline_qty, frozen_qty)`;
  `stock = stock + delta`. A line whose actual first arrives (or changes) in the Complete payload has no per-line
  save, so it falls back to `frozen_qty` (the owner's literal formula) with `baseline_qty` NULL.
- `difference` = `actual − COALESCE(baseline_qty, frozen_qty)` (the variance). Reports summing `difference`
  (`read/repo.go` ~1746/~1817) keep meaning "variance".
- Per line record `stock_before` and `stock_after` (audit).
- **Negative results are kept, not clamped** (A44 spirit: never hide the error). The line shows it.

### Lifecycle (all checks in-tx under `SELECT … FROM stock_counts WHERE id=$1 FOR UPDATE`)

| From | Action | Result |
|---|---|---|
| planned | start (`status: in_progress`) | in_progress, `started_at`, re-freeze |
| in_progress | start | no-op 200 (double click) — no re-freeze |
| planned / in_progress | cancel | cancelled |
| cancelled | cancel | no-op 200 |
| planned | items | replace list (labels only; frozen recomputed server-side) |
| in_progress | items | partial update of `actualQty` for existing `(productId, variantSize)` lines; unknown line → 400; no add/remove |
| in_progress | complete | apply deltas, completed |
| completed | complete (replay) | **zero writes**, 200 with stored result |
| planned / cancelled | complete | 409 |
| completed / cancelled | start / items / notes / cancel | 409 |
| any | unknown status string | 400 |

- Overlap: at most one `in_progress` count per location (partial unique indexes). A second start → 409
  "stock count lain di lokasi ini masih berjalan". Prevents two counts applying the same shortfall.
- Stock rows updated in `(product_id, variant_size)` order (matches transfers); lock conflicts → `ErrBusy` (409,
  retryable) via the existing `mapBusy`/`retryBusy` helpers. Outlet counts still bump the products content
  version; warehouse counts don't.
- Errors: new coded sentinel(s) with `apperr.Conflict` → handler maps to **409**.

### Migration 0051 (additive; Neon holds 3 completed counts, 0 duplicate lines — checked read-only 2026-10-14)

- `stock_count_items`: `baseline_qty integer`, `counted_at timestamptz`, `stock_before integer`, `stock_after integer`
  (all nullable); `UNIQUE (stock_count_id, product_id, variant_size)`.
- `stock_counts`: partial unique indexes `(outlet_id) WHERE status='in_progress'` and
  `(warehouse_id) WHERE status='in_progress'`.

### Contract (gap-class trace: OpenAPI → read json → write SQL → gen:check → backoffice)

- `StockCountItem` adds `baselineQty`, `countedAt`, `stockBefore`, `stockAfter` (nullable, no `$ref`).
- 409 responses on PUT `/stock-counts/{id}` and POST `/complete`; summaries describe difference-apply.
- `read/repo.go` `stockCountObj` (~1182) emits the new fields.

### Backoffice (`StockCount.tsx`)

- Save each line on blur / Enter (`PUT {items:[line]}`) so the baseline is captured at entry time; show
  "dihitung HH:MM" per counted line. Keep "Simpan Progres" working.
- Complete confirm text: the difference is applied to current stock; sales during the count are kept.
- Completed view: Beku / Aktual / Selisih / Stok sebelum → sesudah.
- Show 409 messages instead of failing silently.

### Known limit (document, A17)

An offline sale made before an item was physically counted but synced after its baseline was captured is still
subtracted twice. Needs the movement ledger (A17).

## Tests

- Unit: lifecycle transition table; delta function.
- New PG gate **SC**: `TestStockCountPostgres`, port `56451`, slug `sc`, env `MANDALIKA_SC_TEST_DSN` /
  `MANDALIKA_SC_TEST_DATA_DIR`, db `mandalika_sc_synthetic`, user `sc_test`; register in
  `scripts/ci/postgres_gate.py` GATES. Cases:
  1. count 10, sell 2 through the real sale path, complete with counted 10 (frozen fallback) → 8; replay complete → still 8, zero writes.
  2. owner cases: frozen 15, 3 sold, counted 14 → 11; counted 16 → 13.
  3. sold-before-count with per-line save: frozen 15, 3 sold, save counted 11 (baseline 12), complete → 11.
  4. same value re-sent in Complete keeps the per-line baseline.
  5. client-sent `frozenQty` at create and in items is ignored.
  6. planned → sales → start re-freezes.
  7. two concurrent completes → stock applied exactly once.
  8. second start at the same location → 409; complete planned/cancelled → 409; edits on completed → 409; unknown status → 400; unknown line in in_progress → 400.
  9. warehouse count applies the delta to warehouse stock and does not bump content version.

## Release

Backend deploy (migration 0051) + backoffice (Cloudflare on push). No APK. Review: Opus (stock + generated types).
