# SP-CRM-9b — Variant-Level Loyalty Selectors + Collapsible "Hadiah Loyalti" (Design)

Date: 2026-06-11 · Status: APPROVED (user, this session) · Builds on SP-CRM-9 (rev 00059-297) + `cf26e9d` (Produk Hadiah picker)

## Problem

1. Loyalty-condition product pickers (Produk Pemicu = `applicableProductIds`, Produk Hadiah = `rewardProductIds`) select **whole products only**. A product with many variants (perfumes have 5 sizes incl. Rp1 2ml samples) can't be narrowed — the business cannot say "free 10ml ATOMIZER only" or "only buying the 110ml triggers the promo".
2. The POS checkout "🎁 Hadiah Loyalti" section renders every menu product's full variant list inline — long and cluttered exactly when a promo is generous.

## Locked decisions (user, this session)

- Variant-level selection takes effect in **BOTH** the reward menu and the product_purchase trigger.
- Encoding: **composite IDs in the existing string arrays** — no migration, no OpenAPI schema change.
- POS: collapsed-by-default status rows, label language Indonesian (**"Tersedia!"**).

## 1. Data model — composite IDs, zero migration

`rewardProductIds` and `applicableProductIds` remain `string[]` (jsonb). Entry forms:

| Entry | Meaning |
|---|---|
| `"<productId>"` | whole product — any variant (exactly what all existing rows mean → full backward compat, no backfill) |
| `"<productId>\|<size>"` | that specific variant only, e.g. `6560a172…\|10ml ATOMIZER` |

`\|` does not occur in size names; the backoffice form refuses to emit a variant entry whose size contains `\|` (silent skip + console-free; just exclude from the picker) — defensive only.

## 2. Backend

### 2.1 Engine (`service/loyalty.go`)
- `EvalContext.ProductIDs` (the set) is built by **callers** with BOTH keys per paid cart line: `pid` and `pid|size`. The `product_purchase` matcher stays a plain set lookup — a whole-product entry hits the `pid` key, a variant entry hits `pid|size`. **No parsing inside the engine.**
- Both call sites (`CreateOrder` in order.go, `PreviewRewards` in loyalty_preview.go) updated to add the composite key. Reward lines (`IsReward`) are still excluded from the set.

### 2.2 Preview menu (`service/loyalty_preview.go`)
- `rewardProductMenu(ids)` parses entries: group by productId; a whole-product entry ⇒ all sellable variants (today's behavior); variant entries ⇒ only those sizes. If the same product appears both whole and as variants, whole wins (superset).
- SQL unchanged (query by product ids, active only); variant filtering in Go. Response shape `products[].variants[]` unchanged — just fewer variants. Existing "drop product with no surviving variants / drop reward with empty menu" behavior kept.

### 2.3 Commit validation + grant (`service/order.go`)
- A reward line is valid iff the matched condition's menu contains `it.ProductID` **or** `it.ProductID + "|" + it.VariantSize`.
- The grant's `reward_product_ids` single element now records `"<productId>|<size>"` (precise audit). Lenient-drop semantics unchanged.

### 2.4 Backoffice grant display
- `rewardGrantSummary` (`screens/customers/rewardTypes.ts` / CustomerDetail) parses an optional `|size` suffix: shows "NAME · size"; old product-only grants render as today.

## 3. Backoffice form — shared drill-down picker

New `ProductVariantPicker` component (`apps/backoffice/src/screens/customers/ProductVariantPicker.tsx`), used for BOTH Produk Pemicu and Produk Hadiah, replacing the two flat checkbox lists in `Customers.tsx`:

- Product row: checkbox (= whole product, emits `pid`) + name + chevron toggle.
- Expanded: per-variant checkboxes (emit `pid|size`).
- Mutual exclusion per product: checking the product clears its variant entries; checking any variant clears the whole-product entry.
- Value in/out: the composite `string[]` directly (controlled component).
- Existing save guards from `cf26e9d` unchanged (≥1 reward product — whole OR variant entry counts; campaign needs both dates).

## 4. POS checkout — collapsed status rows (`CheckoutPanel.tsx`, presentation-only)

Per eligible reward (from the existing preview fetch):

- **Collapsed (default):** `#NAME — Tersedia!` + chevron. One row per condition.
- **Expanded (tap):** the existing product/variant pick menu (shorter now that menus are variant-filtered).
- **Picked:** re-collapses to `GRATIS: <PRODUCT> · <size>` with **Ganti** (re-expand) and **Hapus** (clear) controls.
- Local `useState` per-condition expand map inside CheckoutPanel; reducer (`CART_ADD_REWARD`/`CART_REMOVE_REWARD`), cart, receipt, and submit flow **untouched**.

## 5. Out of scope

- Offline reward eval (still the standing deferral from SP-CRM-9).
- Variant-level semantics for promotions/discount codes (separate feature; this touches loyalty conditions only).
- Strict-reject of invalid reward lines (stays lenient+logged).
- Persisting `is_reward` on order_items.

## 6. Edge cases

- Mixed entries for one product (whole + variants): whole-product entry wins (menu superset; trigger matches via `pid` key anyway).
- Variant entry whose size was later deleted/renamed: menu join finds no `product_variants` row → that size silently absent; product dropped if no sizes survive; reward dropped if menu empty (existing behavior).
- Condition authored pre-9b (plain pids): identical behavior to today at every layer.
- POS APK older than backend: old APK ignores nothing — preview shape unchanged, so old clients keep working (they just show the old uncollapsed UI).

## 7. Verification

- Engine table tests: variant trigger matching (whole hit / variant hit / variant miss-wrong-size / mixed), menu filtering (whole-wins, size-filter, dead-size drop).
- Existing gates: backend `go build` + `go test ./...` + `make gen-check`; POS `tsc -b` + vite build + vitest; backoffice `tsc -b` + build.
- Live smoke (deployed): PUT a variant-level entry onto a test condition → preview returns only that size; restore after.
- On-device: collapsed "Tersedia!" row → expand → pick → "GRATIS: … · size" row; commit hands over the exact variant.

## 8. Rollout

Backend deploy (Cloud Run) + backoffice auto-deploy (Cloudflare, on push) + **NEW APK build + reinstall** (POS UI change — `android-release.yml` workflow_dispatch, USER triggers).
