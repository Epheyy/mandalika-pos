# SP-Promo-3b-reward-fulfillment — Buy-X-Get-Y as Reward Giveaway (Design)

**Date:** 2026-06-24
**Branch:** `prod-hardening`
**Status:** Design approved — ready for implementation plan
**Builds on:** SP-Promo-3b (configurable buy_x_get_y, rev `00068-2vr`, migration 0038) + its on-device fixes (POS apply-gate, backoffice edit `bxgyConfig`, checkout re-guard drop).

---

## Context & motivation

SP-Promo-3b shipped `buy_x_get_y` as an **in-cart discount**: the "Y get" items had to already be in the cart, and `calcBXGY` discounted the cheapest qualifying get-set unit. On-device, the user found this counter-intuitive: a "buy 2 Gorgeous, get 1 Holy Sweet free" promo should **give** the Holy Sweet, not require the customer to add it and have it discounted. The desired semantics are a **reward giveaway** — when the buy criteria is met, the promo adds the configured Y reward to the cart (free or at a reduced price), with a picker modal when there are multiple reward choices.

This is the SP-CRM-9 loyalty-reward paradigm (auto-added, server-validated, stock-tracked, refundable reward lines), extended from free-only to priced rewards and **keyed to a promotion** instead of a loyalty condition.

## Decisions (locked during brainstorm)

1. **Same-set unchanged.** Behavior forks on `bxgyConfig.getProductIds`: empty → same-set, keeps today's `calcBXGY` in-place discount; non-empty → separate-set, becomes reward fulfillment.
2. **Tap-to-apply.** The promo turns eligible (green) when the buy criteria is met; the cashier taps to apply, which triggers the reward add. No silent auto-apply (avoids surprise + respects 3a stacking/exclusivity).
3. **Pick each due unit.** `nApp × getQuantity` reward units are due; the modal lets the cashier choose each (variants may differ). Auto-add only when exactly one option and one unit.
4. **Full-range reward price.** Reward line carries the configured net price: free (100%) → Rp0, percentage → reduced, fixed → reduced.
5. **Approach 1 — pre-priced managed reward line** (not full-price-plus-engine-discount). Reuses SP-CRM-9 reward-line rendering/stock/refund; reward count + price are server-authoritative.
6. **Lenient server** (drop invalid/over-quota reward line + `slog.Warn`, never block) — mirrors SP-CRM-9.
7. **No new table, no migration** — reward-line flags are request-only; the reward is a normal `order_item`; the order's `promotionIds` + the line capture it for reporting.
8. **No preview endpoint** — BXGY eligibility is pure cart math the POS already does; reward options resolve client-side from the in-memory promotions + products list.

---

## 1. Eligibility & reward count (separate-set only)

Pure helpers (Go in `service`, mirrored in POS TS), parity-tested:

- `buyUnits` = qty-expanded paid (non-reward) cart units matching `buyProductIds` (empty `buyProductIds` ⇒ any unit not in `getProductIds`).
- `nApp = floor(buyUnits / buyQuantity)`, then `min(nApp, maxApplications)` if `maxApplications > 0`.
- **Reward units due** `D = nApp × getQuantity`.
- **Eligible** ⇔ `D ≥ 1`. (Get-set presence no longer gates eligibility — this revises the SP-Promo-3b on-device apply-gate for separate-set; same-set still gates on `calcBXGY > 0`.)

## 2. Reward options resolution (client-side)

`getProductIds` entries are resolved against the products list:
- `"pid"` (whole product) → one option per active variant of that product.
- `"pid|size"` → exactly that variant.
Each option = `{ productId, productName, variantSize, fullPrice }`. The **reward net price** per option: `percentage` → `fullPrice − round(fullPrice × value/100)` (so 100 ⇒ 0); `fixed` → `max(0, fullPrice − value)`.

## 3. Reward line representation (request-only, no migration)

Reuse the SP-CRM-9 reward-line pattern. The cart/order line is a normal item with **request-only flags** (not persisted as columns):
- existing `isReward: true`
- existing `rewardConditionId` (loyalty) — unused for BXGY
- **new request-only `rewardPromotionId: string`** — the `buy_x_get_y` promo that fulfilled this line.
The line's `price`/`subtotal` = the reward net price (§2). Qty per reward line = 1 (each due unit is its own line, mirroring per-unit picking). Rendering: "Hadiah: {promo name}" badge; GRATIS when net 0 (reuse SP-CRM-9 Cart/Receipt treatment), qty locked, removable only by removing the promo.

A reward line is **not** a buy unit (it's a get-set product; `validateBXGY` already forbids buy∩get overlap, so a get-set product is never counted in `buyUnits`).

## 4. POS flow

`apps/pos/src/cashier/`:
1. **PromoPanel gate** (separate-set): eligible ⇔ `D ≥ 1` (buy criteria met). Greyed with "Syarat beli belum terpenuhi" otherwise. Same-set keeps the `calcBXGY > 0` gate. Label "Beli {buyQuantity}, {Gratis|Diskon …} {getQuantity}".
2. **Apply** → resolve options (§2) + compute `D`. If exactly one option and `D === 1` → auto-add one reward line. Else → open the **reward-picker modal**.
3. **Reward-picker modal** (new, reuses SP-CRM-9b drill-down presentation + SP-CRM-9c `· Stok N`): cashier selects `D` reward units from the options (each pick = one reward line). Confirm dispatches the reward lines and adds the promo to `appliedPromotions`. Cancel = promo not applied.
4. **Reactive removal**: an effect (keyed on the paid-buy-unit count + applied buy_x_get_y promos) removes a promo's reward lines and un-applies the promo when the cart drops below `buyQuantity`. The checkout re-guard (already drops unqualified buy_x_get_y) stays as the belt-and-suspenders final check.
5. Reward lines are sent in `items` with `rewardPromotionId` set; the order also sends `promotionIds` including the promo.

Reducer: extend the reward-line actions to carry `rewardPromotionId` (a reward line's identity becomes `(rewardPromotionId | rewardConditionId, productId, variantSize, index)`; allow multiple reward lines per promo for `D > 1`). Paid-line operations never touch reward lines (existing invariant).

## 5. Pricing

`apps/pos/src/cashier/pricing.ts` `calcPromoDiscount` for `buy_x_get_y`:
- **same-set** (`getProductIds` empty) → `calcBXGY` (unchanged).
- **separate-set** (`getProductIds` non-empty) → **0** (the saving is already in the reward line's reduced price; no separate discount line — mirrors loyalty rewards, prevents double-count).
The reward net price computation (§2) is a shared pure helper, Go/TS parity-tested.

## 6. Server authority — `CreateOrder` (Opus-review surface)

For each item with `rewardPromotionId` set, the server re-derives entitlement from the **paid** lines (server-authoritative, never trusts the client price blindly):
- The promo exists, is `buy_x_get_y`, and passes gating (`ValidatePromo`); else invalid.
- The reward product ∈ the promo's get-set (`pid` / `pid|size` match, reusing `variantKey`/`keyMatchesLine`).
- Per promo: total honored reward units ≤ `D` computed from the order's paid buy-set units (`nApp × getQuantity`, cap applied). Units beyond `D` are over-quota.
- The line price = the configured net (looked up from the real product price); a mismatch is corrected to the server value (server-authoritative money, like the existing pricing recompute).
- **Lenient (mirrors SP-CRM-9):** an invalid / over-quota reward line is **dropped from the order + `slog.Warn`** (sale succeeds; never a 422). Offline keeps the hybrid-by-origin posture.
Stock: honored reward lines decrement stock (real items handed over), gated by the existing `allowNegativeStock` setting (SP-CRM-9c). **Refund restocks** them via the existing line-refund path. No grant table; the reward line + `orders.promotion_ids`/`applied_*` capture it.

## 7. Wire / type-gen (no migration)

- OpenAPI: add request-only `rewardPromotionId` (string, optional) to `OrderItemInput` and `CartItem` (siblings of the existing `rewardConditionId`). Regenerate `api.gen.go` + `schema.d.ts` (`make gen-check`; corepack pnpm for TS). No `bxgyConfig`/promotions schema change.
- No DB migration (request-only fields; reward line is a normal order_item).

## 8. Backoffice

`PromoFormModal.tsx`: functionally unchanged (already authors buy/get sets, qty, free/%/fixed). Minor copy: label the get-set picker "Produk Hadiah (diberikan ke pelanggan)" to reflect the giveaway semantics. The SP-Promo-3b on-device fix already loads `bxgyConfig` on edit.

## 9. Testing & verification

- **Go table tests:** `bxgyRewardDue` (buy units → D, cap), options resolution (`pid` → variants, `pid|size`), net price per kind (free/%/fixed, fixed capped at price), server entitlement (valid honored, over-quota dropped, wrong-product dropped, price corrected), refund restock.
- **TS parity** for the due/options/net-price helpers; **vitest** for the reducer (add N reward lines, paid-op isolation, reactive removal) + the auto-add-vs-modal decision.
- **Live e2e** (`cmd/promo3breward`, throwaway, real `OrderService` vs Neon, zero-residue): apply buy-2-get-1-free → 1 reward line at Rp0 → order records it + stock −1 → over-quota reward line dropped → 50%-off reward priced correctly → refund restocks → cleanup.
- **Gap-class guard (incl. frontend dimension — the lesson from the SP-Promo-3b on-device bugs):** verify (a) the order persists/returns the reward line, (b) the backoffice edit loads `bxgyConfig`, (c) the POS apply-gate + modal behave — not only API persistence.
- Local gate (go build+test+gen-check; POS tsc+vite+vitest; backoffice tsc+vite); deploy; **new APK**; on-device acceptance.

## 10. Model routing & rollout

Sonnet implements; **Opus** reviews the server entitlement validation, the POS reducer + reactive removal, and the type-gen (money/stock path); Haiku for copy + spec-conformance. `rewardPromotionId` is additive/back-compatible (old orders/APKs send none). Retiring the separate-set `calcBXGY` *discount* path is behavior-changing but confined to `buy_x_get_y` with a non-empty get-set (no existing same-set/percentage/fixed/bogo promo is affected); the SP-Promo-3b live promo "BELI 2 GRATIS 1" transitions from discount-on-present-item to reward-giveaway.

## Deferred / out of scope

- A dedicated BXGY reward-grant audit table (v1 derives reporting from the reward line + `promotionId`).
- Online strict-reject of invalid reward lines (v1 is lenient, per SP-CRM-9).
- Tiered (SP-Promo-3b-tiered) and bundle (SP-Promo-3b-bundle) promo types — separate slices.
- SP-Promo-4 authoring/UX overhaul (incl. active-hours form fields).
- Same-set converting to a reward model (kept as in-place discount).
