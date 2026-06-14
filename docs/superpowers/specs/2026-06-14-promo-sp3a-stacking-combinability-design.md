# SP-Promo-3a — Stacking / Combinability — Design

**Date:** 2026-06-14
**Branch:** `prod-hardening`
**Slice:** First of three sub-slices decomposed from SP-Promo-3 (stacking, new types, code→promotion linkage). This is **3a — stacking/combinability**.
**Surfaces:** backend (hot pricing/order path) + migration + OpenAPI/codegen + backoffice (code form) + POS (APK).
**Review tier:** Opus on the engine, `resolvePromos`, order/refund, sync, reducer, checkout, type-gen per [[model-routing-policy]]. Sonnet implements; Haiku only for mechanical edits.

---

## 1. Problem & current state (verified in code)

Today the system applies **exactly one** discount per order:

- **POS state** (`apps/pos/src/cashier/state/cashierReducer.ts`): `appliedPromotion: Promotion | null` **XOR** `appliedPromoCode: AppliedPromoCode | null` — applying one nulls the other (`:282`, `:291`).
- **Wire** (`backend/api/openapi.yaml`): order-create carries singular `promotionId` and `discountCode`.
- **Server** (`backend/internal/service/order.go`): `resolvePromo(promoID, code)` (`:576`) returns **one** `*PromoSpec`; if both are sent the promotion branch wins and the code is ignored. `Compute` (`pricing.go:152`) applies a single `Promo *PromoSpec`.
- **Money math** (`pricing.go:127`): `discount = min(manual + promo, subtotal)` — manual and promo are already **additive, each off the original subtotal, summed and capped at subtotal**.
- **Combinability columns** `promotions.combinable` / `promotions.combinable_with` exist (`0001_init.sql:166-167`) but are **never SELECTed or evaluated**. The backoffice **already authors `promotions.combinable`** (checkbox + "Bisa Kombinasi" badge, `Promotions.tsx:337/234`). `combinable_with` (the per-promo allowlist) is in the schema/types but has **no authoring UI**. `discount_codes` has **no `combinable` column**.
- **Order record is half-ready for stacking:** `orders.discount_breakdown jsonb` (migration 0008) is an array of `{label, kind, value, amount}`, and Cart / ReceiptPreview / OrderHistoryPanel **already iterate it** for display. `discount_breakdown` is **client-computed and persisted verbatim** (display artifact) — the authoritative discount is the server's `discount_value` from `Compute`.
- **Usage / refund:** `discount_codes.usage_count` is incremented for the one applied code (`order.go:431`, `FOR UPDATE` race-safe), and refund restores it via `UPDATE … usage_count = GREATEST(usage_count-1,0) WHERE code=$1` (`order.go:486`, idempotent).

**Goal:** let multiple combinable discounts (N automatic promotions + M discount codes) apply to one order, gated by a boolean `combinable` flag, computed additively, server-authoritative, with the online-strict / offline-lenient behavior established by SP-Promo-1.

---

## 2. Decisions (locked with user)

| # | Decision | Choice |
|---|----------|--------|
| D1 | What may stack | **N combinable automatic promotions + M combinable discount codes** (all three options) |
| D2 | Combinability model | **Boolean `combinable` flag.** Combinable ones stack freely; a single non-combinable discount is exclusive and blocks any stacking. `combinable_with` allowlist deferred. |
| D3 | Stacking math | **Additive on original subtotal** (each % off subtotal / its scoped subset; fixed subtract directly; sum + manual; cap at subtotal). Matches today's manual+promo convention. |
| D4 | POS apply model | **Cashier multi-selects** (extends today's tap-to-apply; PromoPanel toggles; non-combinable selection clears others). |
| D5 | Online conflict | **Reject whole order, 422**, naming the offender (invalid discount OR combinability breach). Offline path stays lenient (record + flag). |
| D6 | Code combinable default | **Non-combinable (exclusive) by default**; creator opts in via a backoffice checkbox. Mirrors the promotion form. |
| D7 | Back-compat | **Keep singular `promotionId`/`discountCode` on the wire**; server prefers plural when present, falls back to singular. Old APKs keep working during rollout. |
| D8 | Multi-code refund | New `orders.applied_discount_codes jsonb` (array of code strings) so refund restores **each** code's usage. |

---

## 3. Architecture

### 3.1 Engine (`backend/internal/service/pricing.go`) — Opus review

- `PricingInput.Promo *PromoSpec` → **`Promos []PromoSpec`**.
- `Compute` sums `calcPromotionDiscount(spec, in.Items, subtotal)` over every spec:
  ```
  promoTotal := 0.0
  for i := range in.Promos { promoTotal += calcPromotionDiscount(&in.Promos[i], in.Items, subtotal) }
  discount := math.Min(manual + promoTotal, subtotal)
  ```
- `calcPromotionDiscount`, BOGO (cheapest qty-expanded unit), and product scoping are **unchanged** — only the caller loops.
- `PricingResult.PromoDiscount` = the summed promo discount.
- **Parity invariant:** a one-element slice produces byte-identical output to today's single-promo path. This is the golden-test anchor.

### 3.2 Combinability enforcement (`order.go`) — Opus review

Pricing stays pure math; **gating is policy** and lives in a refactor of `resolvePromo` →
**`resolvePromos(ctx, tx, promoIDs []string, codes []string, ec PromoEvalContext, offline bool) ([]PromoSpec, []string /*appliedCodeIDs*/, string /*warnReason*/, error)`**:

1. For each promo id: load (now also selecting `combinable`), build `PromoSpec`, run `ValidatePromo`.
2. For each code: load `FOR UPDATE` (now also selecting `combinable`), build `PromoSpec`, run `ValidateCode`, collect its row id.
3. Collect a `combinable` bool per resolved discount.
4. **Combinability rule:** if `len(specs) > 1` and any resolved discount has `combinable == false` → `ViolationNotCombinable`.
5. Apply D5 semantics:
   - **online:** any per-discount violation OR the combinability breach → return `*ErrDiscountRejected{Violations:…}` (caller → 422).
   - **offline:** return the specs + `JoinViolations(allViolations)` as `warnReason` (recorded + flagged); per-discount values are server-authoritative; codes still increment usage (accurate).
6. New violation constant `ViolationNotCombinable` in `promo_validate.go` + an Indonesian message in the handler `errors.As` mapping (`promo_message*.go`).

`PromoRow`/`CodeRow` gain a `Combinable bool` field. `ValidatePromo`/`ValidateCode` are **not** changed (combinability is a cross-discount set property, enforced in `resolvePromos`, not per-row).

**Input plumbing:** `CreateOrderInput` gains `PromotionIDs []string` and `DiscountCodes []string`. `CreateOrder` derives the effective lists: prefer plural when non-empty, else fall back to the singular `PromotionID`/`DiscountCode` (D7). Pass both lists to `resolvePromos`.

### 3.3 Wire + persistence — Opus review (type-gen + order/refund)

**OpenAPI (`backend/api/openapi.yaml` → regen `api.gen.go` + `schema.d.ts`):**
- Order-create input + `CartItem`: add `promotionIds: string[]` (nullable) and `discountCodes: string[]` (nullable). Keep `promotionId`/`discountCode`.
- `DiscountCode` schema + its input: add `combinable: boolean` (nullable, default false).

**Migration `0036_promo_stacking.sql`:**
```sql
ALTER TABLE discount_codes ADD COLUMN IF NOT EXISTS combinable boolean NOT NULL DEFAULT false;
ALTER TABLE orders         ADD COLUMN IF NOT EXISTS applied_discount_codes jsonb;
```
- `discount_codes.combinable` — D6 default false.
- `orders.applied_discount_codes` — D8; nullable, array of code strings; null for pre-feature / no-code orders.

**Order insert (`order.go`):** persist `applied_discount_codes` = the list of applied code strings (null when none). `discount_value` stays the authoritative summed discount. `discount_code` (singular) retained = the first/primary code for back-compat & existing displays. `discount_breakdown` continues to carry per-line display (now naturally multi-line).

**Usage++ (`order.go`):** loop the applied code ids, increment each (existing per-row `FOR UPDATE` lock already held from `resolvePromos`).

**Refund (`order.go`):** read `applied_discount_codes`; for each code run the existing `GREATEST(usage_count-1,0)` restore (idempotent). Fall back to the singular `discount_code` when `applied_discount_codes` is null (old orders).

**Sync (`sync.go`):** thread the new plural fields through the offline envelope (`:216`, `:436` area) so offline orders carry the stack.

### 3.4 POS state + UX (`apps/pos/src/cashier/**`) — Opus review on reducer + checkout

- **Reducer state:** `appliedPromotion → appliedPromotions: Promotion[]`; `appliedPromoCode → appliedPromoCodes: AppliedPromoCode[]`.
- **Actions:** `APPLY_PROMOTION` / `APPLY_PROMO_CODE` become **toggle/append** with exclusivity:
  - applying a **combinable** item appends it (dedup by id/code);
  - applying a **non-combinable** item replaces the whole set;
  - applying any item when a non-combinable one is already active replaces the set.
  - new `REMOVE_PROMOTION` / `REMOVE_PROMO_CODE`; `CLEAR_PROMOTIONS` unchanged; customer-change / cart-empty clears still apply.
- **`PromoPanel.tsx`:** render all active promos as multi-toggles (SP-Promo-2 greying of invalid promos unchanged); selected ones show as removable chips. Code entry appends to `appliedPromoCodes`.
- **`pricing.ts` / `promoValidate.ts`:** mirror the additive stack for the on-device total and the **SP-Promo-2 checkout re-guard**, which now re-validates **every** applied discount + the combinability rule before `handleConfirmPayment`. On any failure → existing toast + `CLEAR_PROMOTIONS` + block.
- **Submit (`CashierScreen.tsx`):** send `promotionIds` = applied promo ids, `discountCodes` = applied code strings (and keep singular = first of each for back-compat). `discountBreakdown` now itemizes each applied promo/code + manual (the builder at `:515` extends from 2 fixed slots to a mapped list).
- **Cart / ReceiptPreview / OrderHistoryPanel:** already iterate `discountBreakdown` → minimal change (ensure each stacked discount renders its own line; the collapsed single-"Diskon" fallback stays for old orders).

---

## 4. Data flow (happy path, online, 2 promos + 1 code)

1. Cashier taps Happy Hour (combinable) + Member 5% (combinable); types code SADHANA10 (combinable). Reducer holds `appliedPromotions=[HappyHour, Member]`, `appliedPromoCodes=[SADHANA10]`.
2. `pricing.ts` computes additive stack for the on-screen total; PromoPanel shows three chips.
3. Bayar → checkout re-guard re-validates all three + combinability locally → pass.
4. Submit sends `promotionIds=[hh,mem]`, `discountCodes=[SADHANA10]` (+ singular firsts), `discountBreakdown=[…3 lines…]`.
5. Server `CreateOrder` → `resolvePromos` validates each, checks all combinable, returns 3 specs → `Compute(Promos:[…3])` → authoritative `discount_value`.
6. Insert order with `applied_discount_codes=["SADHANA10"]`; increment SADHANA10 usage (`FOR UPDATE`).
7. Refund later → restore SADHANA10 usage from `applied_discount_codes`.

**Online conflict:** if any of the three is invalid or one is non-combinable → 422, Indonesian reason, whole order rejected; cashier removes the offender and re-rings.
**Offline:** order recorded at the rung price, `discount_warning=true` + reason = `JoinViolations(...)`; usage still increments for the applied codes.

---

## 5. Testing

- **Go table tests (`pricing_test.go`, `promo_validate_test.go`):** additive sums (%, fixed, scoped, BOGO mixed), cap at subtotal, **single-promo parity vs current golden**, combinability gate (online reject / offline flag), multi-code usage++ and refund restore-each, NULL-hours back-compat (guards the SP-Promo-1 `cannot scan NULL` regression class).
- **TS (`promoValidate.test.ts`, `cashierReducer.test.ts`):** stack total parity (TS == Go), reducer toggle/append/exclusivity/remove cases.
- **Live e2e (throwaway `backend/cmd/promo3e2e`, real `OrderService`, tx rollback / full cleanup, gcloud-secret `DATABASE_URL`):** multi-promo+code order decrements stock + applies summed discount; each code usage++; refund restores each; combinability breach rejected online; single-discount + NULL-hours back-compat passes. Delete the throwaway after.
- **Local gate:** `go build` + `go test ./...` + `make gen-check`; POS `tsc -b` + `vite build` + vitest; backoffice `tsc -b` + build.

---

## 6. Known limitations / deferred (honest)

- `combinable_with` allowlist remains unused (boolean only — D2). A later slice if a real conflict appears.
- Two scoped promos on the same product can sum beyond that product's own value (only the global subtotal cap applies). Acceptable v1; documented.
- No per-order max stack depth — the combinability gate + subtotal cap are the controls. Add a cap later if abused.
- Thermal-printed receipt itemization of stacked discounts follows whatever `discount_breakdown` rendering already does; no new thermal work in this slice.
- POS+backend+migration → **new APK** + **deploy-with-migration** (slot `0036`) required to land.

---

## 7. Out of scope (other SP-Promo-3 sub-slices)

- **3b** — new promo types (buy-X-get-Y, tiered/threshold, bundles).
- **3c** — code→`promotion_id` linkage (a code inheriting a linked promotion's rules).
- **SP-Promo-4** — backoffice authoring/UX overhaul incl. the missing `active_from_hour`/`active_to_hour` form fields.
