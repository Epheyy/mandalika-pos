# SP-CRM-9 — Product-Reward POS Fulfillment

**Date:** 2026-06-10
**Branch:** `prod-hardening`
**Status:** Design (approved) → ready for implementation plan
**Predecessor:** SP-CRM-8 (loyalty-conditions trigger engine) — deferred the `product_reward` *fulfillment* half; this slice delivers it.

---

## 1. Problem & Goal

SP-CRM-8 wired the loyalty-conditions engine into the earning path. For the three reward types:

- `set_points` and `multiply_points` ship fully (points → SP-CRM-7 ledger).
- **`product_reward` is evaluated and recorded only** — the engine writes an audit grant row (`loyalty_condition_applications`, with `reward_product_ids`), but **nothing hands the free item to the customer**: no cart line, no stock decrement, no receipt entry. The backoffice "Reward Produk" list shows these grants; today they mean *"was eligible,"* not *"received."*

**Goal:** let a cashier actually give the free item at checkout, with correct stock, receipt, and an accurate audit of what was handed over.

This is the second consecutive POS-touching loyalty slice on/near the hot order path. Same care as SP-CRM-7/8: math correctness, idempotency, don't pollute prod to verify.

## 2. Locked Decisions (from brainstorming)

1. **Reward semantics — pick one.** A `product_reward` condition's `reward_product_ids` is a *menu* of eligible free items; the cashier picks exactly **one** to give. (If a condition lists `[A, B]`, the customer gets one of A *or* B, cashier's/customer's choice.)
2. **Online-only v1.** The cashier sees the offer only when the device is online; a server preview call evaluates conditions. Offline orders simply don't offer a reward. The **Go engine remains the single source of truth** — no condition logic duplicated to the POS. (Offline on-device evaluation is an explicit future follow-up.)
3. **Offer at the checkout confirmation panel.** When the cashier opens the payment panel (cart + customer final), a "Hadiah Loyalti" section lists eligible free items; the chosen item becomes an **Rp0 cart line** that flows through the existing item → stock-decrement → receipt path.
4. **Grant = actually received.** A `product_reward` grant row is written **only when fulfilled**, and records the **specific product chosen**. The server validates the claim (condition matched + product in the menu). `product_reward` conditions that aren't fulfilled record nothing. This replaces SP-CRM-8's auto-record-on-match behavior for `product_reward` only.
5. **Invalid reward line → lenient.** If a reward line fails server validation (tampering / stale preview), the server **drops it from the audit and `slog.Warn`s, but does not fail the sale.** Rationale: the staff POS already trusts client-supplied item prices (a cashier can set any price), so this opens no new hole; blocking a sale at the register is high-friction. Strict-reject is a trivial future toggle.

## 3. Architecture

Three touch points, one engine:

```
POS CheckoutPanel ──(1) POST /sync/loyalty-preview {customerId, items, total} ─▶ backend
      ▲                                                                           │ reuses EvaluateLoyalty (pure Go)
      │  { rewards:[{conditionId, conditionName, products:[{id,name,variants}]}] }◀┘
      │
   (2) cashier taps a product (+size) → Rp0 cart line {price:0, isReward, rewardConditionId}
      │
      ▼
   (3) POST /orders  (items now include the reward line) ─▶ CreateOrder
                                                            • re-runs engine on PAID items only
                                                            • validates each reward line vs matched conditions
                                                            • records grant w/ chosen product (no auto-record)
                                                            • Rp0 line decrements stock via the existing path
```

**Key property:** the same pure `EvaluateLoyalty` engine powers both the advisory preview and the authoritative commit. The preview is best-effort (matches the existing "POS display is advisory, server authoritative" pattern); the commit re-evaluates and is the gate.

## 4. Backend Design

### 4.1 Preview endpoint — `POST /sync/loyalty-preview`

- **Auth/group:** cashier-authed sync group (mirrors `/sync/customers/lookup`).
- **Request:** `LoyaltyPreviewRequest`
  - `customerId: string` (required)
  - `items: [{ productId, quantity, price, subtotal }]` (the current cart)
  - `total: number` — **advisory** client-computed total, used for the `spending_threshold` trigger only; commit recomputes authoritatively.
  - `clientCreatedAt?: string` — sale moment for date triggers; server falls back to `now()`. Evaluated in **WIB** (reuse `service.wib`).
- **Logic:**
  1. Load the customer's loyalty fields (`birthday, anniversary, visit_count`) — no row lock needed (read-only preview).
  2. Load active conditions (reuse `loadActiveConditions`, or a pool-based sibling since there's no tx).
  3. Build `EvalContext{ Total: total, BasePoints: floor(total/1000)*ppt (or 0 — base only matters for multiply attribution, irrelevant to product_reward filtering), ProductIDs: set(items), SaleDate: wib, Customer: ... }`.
  4. Run `EvaluateLoyalty`; filter `Applied` to `RewardType == "product_reward"`.
  5. For each, resolve `reward_product_ids` → `{ id, name, variants:[{ size, price }] }` by joining `products` + `product_variants` (only sellable/active products + their variants). Drop products that no longer exist.
- **Response:** `LoyaltyPreviewResponse { rewards: [{ conditionId, conditionName, products:[{ id, name, variants:[{ size, price }] }] }] }`. Empty `rewards` when none match. `{data:...}` envelope per house style.
- **No DB writes.** Not cached (freshness matters; cart-specific).

### 4.2 Engine reuse

`EvaluateLoyalty` already returns `product_reward` entries in `Applied` (with `RewardProductIDs`). The preview filters that list; **no engine logic change** for the preview. A thin exported helper may wrap "evaluate + filter to product_reward" for the handler to call.

### 4.3 Commit-time change — `service/order.go` `CreateOrder`

- **Item split:** add `IsReward bool` + `RewardConditionID string` to `service.OrderItem`. Partition incoming items into **paid** and **reward** lines.
- **Eval inputs from PAID items only:** build the engine's `ProductIDs` set from paid items, and base points from paid items. (Total is already unaffected — reward lines are Rp0.) This prevents a free item from cascading into extra points or triggering additional conditions.
- **Application-writing loop changes (the only behavioral change to SP-CRM-8):**
  - `set_points` / `multiply_points` → written exactly as today (byte-unchanged).
  - `product_reward` → **no longer auto-written.** Build `matched: map[conditionID]→reward_product_ids` from the engine's product_reward matches. For each **reward line**:
    - Validate `RewardConditionID ∈ matched` **and** `line.ProductID ∈ matched[RewardConditionID]`.
    - Valid → `write.InsertConditionApplication` with `reward_type="product_reward"`, `reward_product_ids=[line.ProductID]`, `points_contributed=0`.
    - Invalid → `slog.Warn` and skip (lenient; do not fail the sale).
  - `UNIQUE (order_id, condition_id)` already enforces ≤1 grant per condition per order.
- **Stock / receipt / refund:** the Rp0 reward line is an ordinary `order_items` row → stock decrement (existing per-line `FOR UPDATE` logic), receipt rendering, and refund restock all work **with no new code**.

### 4.4 No migration

- Audit reuses the existing `loyalty_condition_applications.reward_product_ids` column (single-element array = the chosen product). The backoffice "Reward Produk" list already resolves these to names.
- `order_items` is unchanged. `isReward` / `rewardConditionId` are **request-only** fields consumed inside the order tx, not persisted.
- **Trade-off (accepted):** a *reprinted* historical receipt won't carry a "Hadiah" label (only the live receipt will); free-item reporting joins through the grant table. Persisting `is_reward` on `order_items` (a small migration) is an optional future enhancement.

### 4.5 OpenAPI / codegen

- Add `isReward` + `rewardConditionId` (optional) to `OrderItemInput` and `CartItem`.
- Add `LoyaltyPreviewRequest` / `LoyaltyPreviewResponse` schemas + the `/sync/loyalty-preview` path (cashier security).
- Regen: `go tool oapi-codegen` + `pnpm --filter @mandalika/api gen`; build/test; `make gen-check` (commit `api.gen.go`).
- Note: OpenAPI paths use the `/api/v1/...` prefix; Go route registration uses the un-prefixed form (group adds it).

## 5. POS Design

- **`pricing.ts`:** unchanged — reward lines are Rp0, so totals and the earn estimate are already correct.
- **`@mandalika/api` client:** add `loyaltyPreview(customerId, items, total, clientCreatedAt?)` → `rewards[]`.
- **`CheckoutPanel`:** new **"Hadiah Loyalti"** section near "Tukar Poin," shown only when `loyaltyEnabled && selectedCustomer && online`. On open, fetch the preview (loading state; silent hide on error/offline). Render each reward as `conditionName` + a product menu; if a product has multiple variants the cashier also picks the size. Tap a product → add the reward line + mark fulfilled; tap again → remove it. The Rp0 line shows in the summary as **"GRATIS."**
- **Cart state (`useCart` / `cashierReducer`):** a reward line is `quantity:1`, `price:0`, `subtotal:0`, `isReward:true`, `rewardConditionId`. No quantity stepper; removable. Add a dedicated reducer action (e.g. `addRewardItem` / `removeRewardItem`) so reward lines can't be price/qty-edited like normal items.
- **`Cart.tsx` / `ReceiptPreview.tsx`:** render reward lines distinctly ("GRATIS / Hadiah Loyalti").
- **Order submit:** map reward lines into `items` with their flags. If the selected customer is cleared, drop any reward lines.

## 6. Edge Cases

- **Preview offline / fails:** section hidden, sale proceeds normally (no degradation).
- **Customer removed after picking:** reward lines cleared from the cart.
- **Reward product out of stock at the outlet:** the free line still decrements (online zero-floor / offline `stock_warning`), consistent with normal sales; no pre-block in v1.
- **Multiple matching conditions:** multiple reward sections, each independently fulfillable; `UNIQUE (order_id, condition_id)` caps one grant per condition.
- **Same product chosen for two different conditions:** two Rp0 lines + two grants (distinct `condition_id`) — fine.
- **Reward product overlaps a promo's applicable set:** the free line's subtotal is 0, so it adds no discount base — negligible; noted.
- **Replay / idempotency:** reward lines + grants live inside the order tx → `processed_keys` guard makes replays safe; the `UNIQUE` index is a second backstop.
- **Refund:** restocks the free line (existing logic); grant rows are immutable order-time facts and are not reversed (per SP-CRM-8).

## 7. Testing

- **Go unit (pure):** preview helper (product_reward filtering, variant resolution); commit-validation table tests — condition matched/unmatched, product in/out of menu, reward line excluded from the eval product-set (→ no point inflation), lenient drop of an invalid line, `UNIQUE` one-per-condition.
- **Live e2e** (real `service.OrderService`, throwaway `cmd/`, loyalty toggled on→off, **all artifacts deleted** — same protocol as SP-CRM-7/8): fulfilled reward → Rp0 line decrements stock, grant records the chosen product, base points unaffected by the free item, refund restocks it, replay idempotent. Confirm loyalty back OFF and zero leftovers afterward.
- **Handler:** preview returns menus for a matching condition; `401` without token; empty `rewards` when nothing matches.
- **POS:** `tsc -b` + `vite build` (both apps clean); reducer reward-action unit test; component behavior (pick adds line, un-pick removes, hidden offline). `-race` not run locally (no cgo on this Windows box); CI runs race on Linux.

## 8. Scope

**In:** preview endpoint; checkout "Hadiah Loyalti" section; Rp0 reward cart lines; commit-time validation + chosen-product grant recording (replacing `product_reward` auto-record); "GRATIS" receipt label; OpenAPI/types; APK build + fleet rollout.

**Out (deferred):**
- Offline on-device condition evaluation (the future offline follow-up).
- Persisting `is_reward` on `order_items` (v1 is migration-free).
- Strict-reject of invalid reward lines (v1 is lenient + logged).
- Reward stock pre-check / blocking out-of-stock picks.
- Multi-unit rewards (always quantity 1).
- Auto-adding the free item without a cashier tap.

## 9. Rollout

POS-touching → reaches devices only via an APK build (GH Actions `android-release.yml`) + fleet rollout, like SP-CRM-3 / SP-CRM-5b. Backend deploys via `gcloud run deploy`. Because fulfillment is online-only and additive, **no deployed device degrades** before updating: old APKs simply never show the reward section; the backend change is backward-compatible (reward fields are optional; absent ⇒ today's behavior). Sequence: deploy backend → verify → build APK → roll out → confirm on-device.

## 10. Open Items for the Plan

- Exact preview request/response field names and the `products[].variants` shape.
- Whether the preview loads conditions via a pool-based read (no tx) or reuses `loadActiveConditions` with a short-lived tx.
- POS reducer action names + how reward lines are visually distinguished in `Cart.tsx`.
- The handler's product/variant resolution query (active/sellable filter).
