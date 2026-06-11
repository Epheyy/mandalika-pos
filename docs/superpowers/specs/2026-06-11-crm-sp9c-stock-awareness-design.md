# SP-CRM-9c — Stock Awareness at the POS (Design)

Date: 2026-06-11 · Status: APPROVED (user, this session) · Builds on SP-CRM-9 / 9b (rev 00060-cdn)

## Problem (observed by user on-device)
1. The reward picker shows `product · size` with no stock — a cashier picked a free item that was out of stock and the sale went through, leaving stock at **−2**.
2. There is no business control over overselling. The POS submits every order through the offline-first **sync path** (`sync.go:221` sets `Offline: true`), which deliberately allows stock to go negative and flags `stockWarning` for reconciliation. (The direct online handler `writes.go:938` zero-floors, but the POS never uses it.) So overselling is the current contract, with no toggle.
3. The product card stock "doesn't update quickly" after a sale. **Diagnosis: intentional, not a perf bug.** The grid reads `ProductVariant.stock` from `engine.getSnapshot()`, which "only refreshes on resync" (`CashierScreen.tsx:196`). A local sale enqueues to the outbox but does not optimistically decrement the displayed stock.

## Locked decisions (user, this session)
- Negative-stock enforcement = **warn + allow override** at POS checkout (offline-first: the sale already happened on-device; a hard block could freeze a legitimate sale from stale counts).
- New setting default = **allow negative** (preserves today's behavior; opt-in to stricter).
- Include the **optimistic local decrement** in this slice (fixes #3 and makes the warning accurate vs. what the cashier sees).
- Server stays **lenient** — it records + flags, never rejects an offline sale. The setting drives POS UX only.

## Single source of truth
The product card already reads per-variant stock from the local sync snapshot (`ProductGrid.tsx:151`, `ProductVariant.stock`). The reward picker and the optimistic layer read from that SAME snapshot so all three surfaces agree.

## 1. Stock in the reward picker (POS-only, NO backend)
`CheckoutPanel` reward buttons currently render `product · size`. Cross-reference `snapshot.products` by `productId + size` to append stock: `GORGEOUS TUBEROSE · 10ml ATOMIZER · Stok 3`, styled red when ≤ 0 (mirrors `ProductGrid.tsx:151`). No server/preview change — the preview gives product/size, the snapshot carries stock. With change #3 the stock reflects pending sales too.

## 2. "Allow negative stock" setting (backend + backoffice + POS)
- **Data model:** add `allowNegativeStock bool` to `AppSettings` — Go struct, TS `AppSettings` interface (packages/types), OpenAPI `AppSettings` schema (regen api.gen.go + schema.d.ts). Persisted in the `app_settings` row (already synced into the POS snapshot and served by the settings endpoints). **Default `true`** (allow) — additive, no migration if app_settings is jsonb/columnar with a default; confirm the storage shape and default at the value layer so existing rows read `true`.
- **Backoffice (`SettingsScreen.tsx`):** a toggle "Izinkan stok minus" (allow negative stock), gated by the existing settings permission, wired through the existing settings save.
- **POS enforcement (warn + override):** at checkout, for each cart line compute `available = snapshotStock(pid,size) − pendingDelta(pid,size) − cartQty(pid,size)`. If `allowNegativeStock === false` AND any line (paid OR reward) would drive stock below 0, render an amber warning in `CheckoutPanel` listing the offending items; the confirm button STAYS enabled (override). When `allowNegativeStock === true`, no warning (today's behavior).
- **Server:** unchanged. Sync path still records + flags `stockWarning`; direct online path still zero-floors. No new rejection. Documented so no one expects server enforcement.

## 3. Optimistic local stock decrement (POS-only)
- **Accessor:** the `SyncEngine` exposes `pendingCount()` today. Add `pendingStockDeltas(): Map<string, number>` (or `Record<string,number>`) keyed by `\`${productId}|${size}\`` summing quantities of enqueued-but-unsynced order lines (paid + reward). FIRST plan task; if the engine already exposes pending order payloads, derive it without touching the engine.
- **Derivation:** in `CashierScreen`, build `displayProducts` = snapshot products with each variant's `stock` reduced by its pending delta (floored for display at the real number, i.e. allow showing negative so the cashier sees −2). Pass `displayProducts` to the grid, reward-picker stock lookup, and checkout enforcement.
- **Reconciliation:** deltas come from outbox entries; on resync the snapshot refreshes with server stock and the outbox drains, so a synced order's delta disappears exactly as the snapshot picks it up — no double count. (Edge: brief window where both snapshot reflects the sale AND the entry hasn't cleared → at most transient over-decrement; acceptable, self-heals next snapshot read.)

## Out of scope
- Server-side hard rejection of oversell (offline-first makes it impossible without losing the sale).
- Per-variant stock on the loyalty-preview API (not needed — snapshot already has it).
- Stock on the thermal receipt.

## Edge cases
- Variant absent from snapshot (deleted/bundle): no stock shown, no warning (matches the server skip).
- `allowNegativeStock` missing from an old snapshot (pre-deploy POS): default to `true` in the POS reader so an un-resynced device keeps today's behavior.
- Reward line + paid line of the same variant: both pending deltas subtract; the warning counts the combined draw.
- Two devices same outlet: each only sees its own pending deltas until resync — consistent with the existing offline-first model (not made worse).

## Verification
- Backend: settings round-trip test (allowNegativeStock persists + defaults true) + `go build`/`go test`/`make gen-check`.
- POS: vitest for `pendingStockDeltas` math and the checkout warning predicate (warn iff `!allowNegativeStock && anyLineNegative`); tsc + vite build + existing vitest green.
- Backoffice: tsc + build.
- Live smoke: GET settings shows `allowNegativeStock:true` default; PUT false; confirm snapshot/settings round-trip. (POS warning + optimistic decrement are on-device, USER-PENDING with the new APK.)

## Rollout
Backend deploy + backoffice auto-deploy + **new APK** (POS changed). One APK build also carries the still-pending SP-CRM-9b POS UI.
