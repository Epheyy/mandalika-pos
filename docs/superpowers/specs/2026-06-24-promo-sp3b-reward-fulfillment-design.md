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
6. **Hard-reject, hybrid-by-origin.** A bogus / over-quota reward line on an **online** order → **HTTP 422** (new `ViolationRewardInvalid`, Indonesian message), so the cashier is stopped rather than silently giving a freebie. On an **offline-synced** order (can't 422 a completed sale) → **drop the unearned reward line** (do NOT give it free) + set `orders.discount_warning` + reason + `slog.Warn`. The POS local guard is the real-time prevention (it bounds the modal to the earned count), so a 422/drop is the rare tamper/stale-promo defense. (Stricter than SP-CRM-9's all-lenient stance — the user chose hard-reject.)
7. **Grant audit table (new migration).** Each **honored** BXGY reward line writes a `promo_reward_grants` row inside the `CreateOrder` tx (which promo gave which product/variant, full vs reward price, and the giveaway value). Immutable on refund (matches SP-CRM-9 grant semantics; refund restocks stock but the grant stays as the sale-time record).
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

## 3. Reward line representation (request-only flags)

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

For each item with `rewardPromotionId` set, the server re-derives entitlement from the **paid** (non-reward) lines — never trusting the client price:
- The promo exists, is `buy_x_get_y` with a non-empty get-set, and passes gating (`ValidatePromo`); else invalid.
- The reward product ∈ the promo's get-set (`pid` / `pid|size` match, reusing `variantKey`/`keyMatchesLine`); else invalid.
- Per promo: total reward units ≤ `D` (= `nApp × getQuantity`, cap applied) computed from the order's paid buy-set units. Units beyond `D` are over-quota → invalid.
- The line price must equal the configured net (looked up from the real product price); a price mismatch is **invalid** (not silently corrected — under hard-reject we reject rather than re-price a tampered freebie).

**Hybrid-by-origin enforcement** (mirrors SP-Promo-1 / stock):
- **Online** (`Offline=false`): any invalid reward line → `*ErrDiscountRejected{ViolationRewardInvalid}` → handler maps to **HTTP 422** + Indonesian message (e.g. "Hadiah promo tidak valid / melebihi kuota").
- **Offline** (`Offline=true`, the POS sync path): **drop the invalid reward line from the order** (it is NOT recorded and NOT given free), set `orders.discount_warning` + reason + `slog.Warn`. A completed sale is never blocked, but an unearned freebie is never honored.

Honored reward lines: decrement stock (real items handed over, gated by `allowNegativeStock`, SP-CRM-9c) and **write a `promo_reward_grants` row** (§6a) in the same tx. **Refund restocks** the reward lines via the existing line-refund path; the grant row is immutable (sale-time record).

## 6a. Grant audit table — migration 0039

```sql
CREATE TABLE promo_reward_grants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      uuid NOT NULL REFERENCES orders(id),
  promotion_id  uuid NOT NULL REFERENCES promotions(id),
  product_id    uuid NOT NULL,
  product_name  text NOT NULL,          -- snapshot
  variant_size  text NOT NULL DEFAULT '',
  full_price    numeric(14,2) NOT NULL,  -- catalog unit price at sale time
  reward_price  numeric(14,2) NOT NULL,  -- net charged (0 for free)
  reward_value  numeric(14,2) NOT NULL,  -- full_price - reward_price (the giveaway value)
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_promo_reward_grants_order ON promo_reward_grants(order_id);
CREATE INDEX idx_promo_reward_grants_promo ON promo_reward_grants(promotion_id);
```

One row per honored reward line (qty is per-unit, §3). Written via a `write`-layer helper inside the `CreateOrder` tx. Read side: a repo method `RewardGrantsByOrder`/`...ByPromotion` for reporting; a backoffice reporting view is **deferred** (the data is captured + queryable now). Refund does not delete grant rows (immutable audit; mirrors SP-CRM-9 `loyalty_condition_applications`).

## 7. Wire / type-gen

- **Migration 0039**: `promo_reward_grants` (§6a).
- OpenAPI: add request-only `rewardPromotionId` (string, optional) to `OrderItemInput` and `CartItem` (siblings of the existing `rewardConditionId`). Regenerate `api.gen.go` + `schema.d.ts` (`make gen-check`; corepack pnpm for TS). No `bxgyConfig`/promotions schema change. (A `RewardGrant` read schema only if a reporting endpoint is added — deferred; the table is written regardless.)
- New `ViolationRewardInvalid` promo-violation + its Indonesian handler message.

## 8. Backoffice

`PromoFormModal.tsx`: functionally unchanged (already authors buy/get sets, qty, free/%/fixed). Minor copy: label the get-set picker "Produk Hadiah (diberikan ke pelanggan)" to reflect the giveaway semantics. The SP-Promo-3b on-device fix already loads `bxgyConfig` on edit.

## 9. Testing & verification

- **Go table tests:** `bxgyRewardDue` (buy units → D, cap), options resolution (`pid` → variants, `pid|size`), net price per kind (free/%/fixed, fixed capped at price), server entitlement — **online** invalid/over-quota/wrong-product/price-mismatch → `ViolationRewardInvalid` (422), **offline** same → dropped + `discount_warning`; honored line writes a `promo_reward_grants` row (full/reward/value correct); refund restocks + grant row immutable.
- **TS parity** for the due/options/net-price helpers; **vitest** for the reducer (add N reward lines, paid-op isolation, reactive removal) + the auto-add-vs-modal decision + the POS local guard blocking an over-earned reward before submit.
- **Live e2e** (`cmd/promo3breward`, throwaway, real `OrderService` vs Neon, zero-residue): apply buy-2-get-1-free → 1 reward line at Rp0 → order records it + stock −1 + **one grant row** (reward_value = full price) → over-quota reward line **online-rejected (422)** and **offline-dropped+flagged** → 50%-off reward priced + granted correctly → refund restocks + grant immutable → cleanup.
- **Gap-class guard (incl. frontend dimension — the lesson from the SP-Promo-3b on-device bugs):** verify (a) the order persists/returns the reward line, (b) the backoffice edit loads `bxgyConfig`, (c) the POS apply-gate + modal behave — not only API persistence.
- Local gate (go build+test+gen-check; POS tsc+vite+vitest; backoffice tsc+vite); deploy; **new APK**; on-device acceptance.

## 10. Model routing & rollout

Sonnet implements; **Opus** reviews the server entitlement validation, the POS reducer + reactive removal, and the type-gen (money/stock path); Haiku for copy + spec-conformance. `rewardPromotionId` is additive/back-compatible (old orders/APKs send none). Retiring the separate-set `calcBXGY` *discount* path is behavior-changing but confined to `buy_x_get_y` with a non-empty get-set (no existing same-set/percentage/fixed/bogo promo is affected); the SP-Promo-3b live promo "BELI 2 GRATIS 1" transitions from discount-on-present-item to reward-giveaway.

## Deferred / out of scope

- A **backoffice reporting view** for `promo_reward_grants` (the table is written + queryable now; surfacing it in the UI is SP-Promo-4 / analytics).
- A `GET` reward-grants endpoint + `RewardGrant` OpenAPI schema (add when the reporting view lands).
- Tiered (SP-Promo-3b-tiered) and bundle (SP-Promo-3b-bundle) promo types — separate slices.
- SP-Promo-4 authoring/UX overhaul (incl. active-hours form fields).
- Same-set converting to a reward model (kept as in-place discount).
