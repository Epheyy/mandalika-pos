# SP-Promo-3b — Configurable Buy-X-Get-Y (Design)

**Date:** 2026-06-22
**Branch:** `prod-hardening`
**Status:** Design approved — ready for implementation plan
**Slice:** SP-Promo-3b (the new-promo-types slice of the SP-Promo-3 decomposition; follows 3a stacking/combinability and 3c code→promotion linkage). This slice delivers **buy-X-get-Y only**; tiered and bundle are separate later slices.

---

## Context

The promotion module is a 4-angle overhaul decomposed into SP-Promo-1..4. SP-Promo-3 was split into 3a (stacking/combinability — DONE, rev `00066-lwf`, mig 0036), 3c (code→promotion linkage — DONE, rev `00067-nv2`, mig 0037), and **3b (this slice — new promo types)**.

The 3c spec deliberately landed *before* 3b so that richer mechanics can be added **once on `promotions`** and discount codes inherit them for free via the code→promotion linkage. Today a promotion supports `percentage`, `fixed`, and a *simple* `bogo` (the existing `bogo` discounts the cheapest qty-expanded unit in a scoped set when ≥2 units are present — it is not a configurable buy-X-get-Y). SP-Promo-3b adds a real, parameterized **buy-X-get-Y** type.

**Why this is safe to add now:** a `buy_x_get_y` promotion is just another resolved `PromoSpec`. It plugs into the 3a additive stacking engine and the 3c linkage with no new wiring on those paths — the only genuinely new logic is the discount *calculation* and its config storage.

---

## Decisions (locked during brainstorm)

1. **Buy-X-get-Y only** for this slice. Tiered and bundle are deferred to their own slices.
2. **Both same-set and separate buy→get sets.** Empty get-set ⇒ same-set mode; specified get-set ⇒ distinct trigger and reward groups.
3. **Y discount = free / % off / fixed-amount-off.** Free is expressed as `percentage` 100. Fixed is capped at the discounted unit's price so a line never goes negative.
4. **Repeats with a configurable cap** (`maxApplications`; 0 = unlimited).
5. **Storage = one `jsonb` blob** (`promotions.bxgy_config`) — "Approach 2". Chosen over discrete columns to (a) minimize the multi-layer wiring surface that produced the SP-Promo-3a column-wiring gap, and (b) give a clean self-contained extension point for the deferred tiered/bundle types. The entire rule travels through every layer as one field.
6. **Old `bogo` is untouched.** `buy_x_get_y` is a new `DiscountKind` added alongside it; existing `percentage`/`fixed`/`bogo` rows are unaffected.
7. **Variant-level buy/get sets are in-slice.** Buy and get sets are composite `pid|size` key arrays using the existing SP-CRM-9b `variantKey` convention (`"pid"` = whole product/any variant; `"pid|size"` = that variant only).

---

## 1. Data model

New migration **0038**:

- **Alter the `promotions.type` CHECK constraint** from `IN ('percentage','fixed','bogo')` to `IN ('percentage','fixed','bogo','buy_x_get_y')`. (Drop + re-add the constraint; additive, existing rows unaffected.)
- **`ALTER TABLE promotions ADD COLUMN bxgy_config jsonb`** (NULL for every non-BXGY row).

The blob shape — defined once as a Go struct (`BXGYConfig`), once as a TS interface; parity is pinned by tests:

```jsonc
{
  "buyQuantity": 2,                 // X, integer ≥ 1
  "getQuantity": 1,                 // Y, integer ≥ 1
  "buyProductIds": ["pid", "pid|size"], // trigger set; composite keys; empty = any cart item qualifies as a buy unit
  "getProductIds": ["pid|size"],    // reward set; composite keys; empty = same-set mode
  "getDiscountKind": "percentage",  // "percentage" | "fixed"
  "getDiscountValue": 100,          // 100 = free; 50 = half off; or a fixed Rp amount
  "maxApplications": 0              // 0 = unlimited; otherwise the per-order cap
}
```

For a `buy_x_get_y` promotion, the top-level `value` and `applicable_product_ids` columns are **unused** — the blob is the single source of truth (no field overloading; rejected "Approach 3").

**Composite-key convention (SP-CRM-9b):** an entry is either `"pid"` (matches any variant of that product) or `"pid|size"` (matches exactly that variant). `|` never appears in a size name. A key matches a line iff `key == line.ProductID` **or** (`line.VariantSize != ""` and `key == variantKey(line.ProductID, line.VariantSize)`).

## 2. Engine — `pricing.go` (Opus-review surface)

### 2.1 Required plumbing change: `LineItem.VariantSize`

The pricing `LineItem` (`pricing.go:22`) currently carries only `ProductID`. Variant-level matching requires the size on each line. Add:

```go
type LineItem struct {
    ProductID   string
    VariantSize string // NEW — for pid|size matching (buy_x_get_y); empty = product-level line
    Price       float64
    Quantity    int
    Subtotal    float64
}
```

Populate `VariantSize` from `OrderItem.VariantSize` (Go, `order.go`) and from `CartItem.variantSize` (TS, `pricing.ts`) at every site that builds `LineItem`s. This is additive — existing percentage/fixed/bogo calculations ignore the new field, so their golden-value parity tests are unaffected (verify the parity tests still pass after the struct change).

### 2.2 `PromoSpec` extension

```go
type PromoSpec struct {
    Kind                 DiscountKind // percentage | fixed | bogo | buy_x_get_y
    Value                float64
    ApplicableProductIDs []string
    IsBOGO               bool
    BXGY                 *BXGYConfig // NEW — non-nil iff Kind == buy_x_get_y
}
```

### 2.3 Algorithm (`calcPromotionDiscount` gains a `buy_x_get_y` branch)

The branch returns the **total discount** for this spec as a single number, summed into the existing additive `Promos` loop (so 3a stacking and the `min(manual+promo, subtotal)` cap apply unchanged).

Build a **unit list** by qty-expanding each matching line into individual `(price)` units (mirrors today's `bogo` expansion).

**Same-set mode** (`getProductIds` empty):
1. `pool` = units whose line matches `buyProductIds` (or all units if `buyProductIds` empty).
2. `nApp = floor(len(pool) / (buyQuantity + getQuantity))`; if `maxApplications > 0`, `nApp = min(nApp, maxApplications)`.
3. Discount the **`nApp * getQuantity` cheapest** units in `pool`.

**Separate mode** (`getProductIds` non-empty):
1. `buyPool` = units matching `buyProductIds` (if `buyProductIds` empty: any unit **not** matching `getProductIds`); `getPool` = units matching `getProductIds`.
2. `nApp = min(floor(len(buyPool)/buyQuantity), floor(len(getPool)/getQuantity))`; cap by `maxApplications` if > 0.
3. Discount the **`nApp * getQuantity` cheapest** units in `getPool` (buy units are never discounted).

**Per-discounted-unit amount:**
- `percentage`: `round(unitPrice * getDiscountValue / 100)` (100 ⇒ unit free).
- `fixed`: `min(getDiscountValue, unitPrice)` (cap prevents a negative line).

Sum across all discounted units = the spec's discount.

"Cheapest units discounted" is the customer-friendly convention and matches today's `bogo`.

## 3. Validation invariants

Enforced at save time in the write repo (online-authoritative) and defensively in the engine:

- `buyQuantity >= 1`, `getQuantity >= 1`, `maxApplications >= 0`.
- `getDiscountKind ∈ {percentage, fixed}`; `percentage ⇒ 0 < value <= 100`; `fixed ⇒ value > 0`.
- Separate mode: `buyProductIds ∩ getProductIds = ∅` (overlap rejected — use same-set mode for same-product offers).
- **Engine leniency:** a `buy_x_get_y` promotion whose `bxgy_config` is nil or structurally invalid yields **0 discount + `slog.Warn`** — never a panic, never an HTTP 422. A misconfigured promotion is a configuration error, not a cashier-facing order violation. (Gating violations — dates/min/hours/outlet — still follow the existing hybrid-by-origin path.)

## 4. Resolution — `order.go` `resolvePromos` (Opus-review surface)

- When a loaded promotion has `type == buy_x_get_y`: unmarshal `bxgy_config` into `BXGYConfig`, set `spec.Kind = buy_x_get_y` and `spec.BXGY = cfg`.
- **3c linkage is free:** `loadPromoSpec` already builds the spec from a linked promotion, so a code linked to a `buy_x_get_y` promotion inherits it with no new code.
- **3a combinability is free:** the promotion's `combinable` flag flows through the existing `combinabilityViolation` gate unchanged.
- Hybrid-by-origin enforcement, usage-count accounting, and refund restoration are all unchanged (a `buy_x_get_y` promotion adds no per-promotion usage counter; a linked code still owns the redemption cap).

## 5. POS (= APK) — Opus-review surface (money path)

- **Pricing parity:** mirror the `buy_x_get_y` branch in the TS pricing calc (`apps/pos/src/cashier/pricing.ts`, the port of `calcPromotionDiscount`), 1:1 with Go, including the `LineItem.variantSize` plumbing and the `pid|size` match helper. Pinned by vitest parity cases mirroring the Go table tests.
- **`promoValidate.ts`:** no new *gating* (a `buy_x_get_y` promo uses the same promo-level gates as any promotion) — only the discount calc changes.
- **PromoPanel:** a `buy_x_get_y` promotion renders like any promotion; its savings line uses the TS calc. SP-Promo-2/3a greying + combinability pills carry over unchanged.
- **Checkout re-guard** (`handleConfirmPayment`): structurally unchanged — it re-validates gates; the discount is recomputed by the pricing function.

## 6. Backoffice (Haiku-tier)

Promosi form (`apps/backoffice/src/screens/Promotions.tsx`): add `buy_x_get_y` to the type selector (label e.g. "Beli X, Gratis/Diskon Y"). When selected, show the BXGY sub-form and hide the `value`/`applicableProductIds` inputs:

- Buy quantity (X), Get quantity (Y), Max applications (0 = "tanpa batas").
- Buy-products picker and Get-products picker — both reuse the existing **drill-down `ProductVariantPicker`** from SP-CRM-9b (whole-product or per-variant), emitting composite `pid|size` keys. Empty get-set picker = note "sama dengan produk beli".
- Y-discount kind selector (`percentage`/`fixed`) + value, with a **"Gratis"** shortcut that sets `percentage`/100.
- Client-side mirror of the §3 invariants before save.

## 7. Wire / type-gen (the 3a/3c lesson, applied)

- **OpenAPI:** add `bxgyConfig` as a nested object schema (nullable) on `Promotion` + `PromotionInput`. ⚠️ **`openapi-typescript` silently drops `nullable` on `$ref` object schemas** ([[openapi-nullable-ref-codegen-gotcha]]): in TS, clear the field by omitting it / `undefined`; Go uses pointer + `omitempty`. Handled deliberately, not discovered live.
- Regenerate `api.gen.go` + `schema.d.ts` (`schema.d.ts` regen needs `corepack pnpm@10.11.1 --filter @mandalika/api gen` — pnpm is not on the subagent PATH). `make gen-check` green (note: gen-check gates `api.gen.go` only; verify `schema.d.ts` drift by hand).
- **Read repo** (`read/repo.go` `Promotions`): add `'bxgyConfig', bxgy_config` to the `json_build_object`.
- **Write repo** (`write/repo.go` `CreatePromotion` **and** `UpdatePromotion`): add `bxgy_config` to **both** the INSERT and the UPDATE, marshalling the struct (nil → SQL NULL).

## 8. Gap-class guard (explicit, required)

The SP-Promo-3a defect was: a new column wired into OpenAPI + the form but **missing** from the read `json_build_object` and/or the write INSERT/UPDATE, so it silently never persisted/returned. To make that class **structurally impossible to ship undetected for `bxgy_config`**, the following is a **required** gate, not optional:

> **Round-trip serialization smoke:** authed `POST /promotions` with a fully-populated `bxgyConfig` (all sub-fields, both buy and get sets, variant-level keys) → `GET /promotions` → assert **every** blob sub-field round-trips identical. A half-wired read or write fails this immediately.

This runs in the local/CI-style check (against the test DB) **and** again live after deploy.

### 8.1 Bonus gap-audit (in-slice, user-requested)

While in the read/write repos, do a focused sweep confirming **no other promotion/discount-code field is currently half-wired** — for each field present in the OpenAPI `Promotion`/`DiscountCode` schemas (e.g. `combinable`, `combinableWith`, `codeOnly`, `applicableVariantKeys/Sizes`), verify it appears in the read `json_build_object` **and** in both write INSERT and UPDATE. Report findings (expected: all wired, since 3a's `combinable` gap was fixed in `ef1dced` and 3c's `code_only` passed its check). Fix any genuine half-wiring found; if none, record "audit clean" in the handoff. This closes the gap-class across the board, not only for `bxgy_config`.

## 9. Testing & verification

- **Go table tests** (`calcBXGY` / the new branch): same-set buy-2-get-1 free; separate-set buy-2-get-1 of a reward product; `%`-off Y; fixed-off Y (capped at unit price); `maxApplications` cap honored; repeat (6 eligible units, buy-2-get-1 → 2 discounted); not enough units → 0; empty pools → 0; nil/invalid blob → 0 + warn; variant-level keys (`pid|size`) match only the right variant; whole-product `"pid"` key matches any variant.
- **Go parity guard:** existing `percentage`/`fixed`/`bogo` golden-value tests still pass after the `LineItem.VariantSize` struct change.
- **TS vitest parity:** mirror every Go `calcBXGY` case 1:1 in `pricing.ts`'s test, plus the variant-key matcher.
- **`resolvePromos` test:** `type == buy_x_get_y` builds the spec from the blob; a linked code (3c) inherits it; combinability taken from the promotion.
- **Round-trip serialization smoke** (§8) — required.
- **Live e2e** (throwaway `cmd/promo3be2e`, real `OrderService` against the test DB, zero-residue cleanup): create a `buy_x_get_y` promotion → order proving the discount (same-set free; separate-set %-off; cap; repeat; variant-level) → refund restores → dedupe with a 3c link → cleanup verified.
- **Local gate:** `go build` + `go test ./...` + `make gen-check`; POS `tsc -b` + `vite build` + `vitest`; backoffice `tsc -b` + build.
- **Deploy** (migration 0038) → run the round-trip smoke live → **APK build** (push to origin BEFORE triggering, per [[apk-builds-from-origin-gotcha]]) → on-device acceptance.

## 10. Model routing (per [[model-routing-policy]])

Sonnet implements. **Opus** reviews: the engine calc (`pricing.go`), `resolvePromos`/order/refund, the type-gen, and the POS pricing parity (money path). **Haiku** for the backoffice form/copy and spec-conformance checks. Opus re-derives any Haiku finding from source before accept/dismiss.

## 11. Rollout / risk notes (working rules)

- **Flag uncertainty (rule 3):** the `type` CHECK-constraint change and the new column are additive; existing rows are untouched. Pre-deploy, confirm no existing `promotions` row already uses `buy_x_get_y` (expected zero — no form can author it yet).
- **Don't touch unrelated (rule 2):** scope is confined to the pricing engine's BXGY branch + `LineItem.VariantSize` plumbing, `resolvePromos` BXGY parsing, the two write-repo promo functions + the read-repo promo json, the codegen for `bxgyConfig`, the POS pricing/PromoPanel, and the backoffice Promosi form. No changes to loyalty, stock, codes' own type/value, or unrelated order logic. The bonus gap-audit (§8.1) is read-only unless a genuine half-wiring is found.
- **`LineItem.VariantSize` is the one cross-cutting struct change** — every `LineItem` construction site must set it. Enumerate those sites in the plan so none is missed (this is the BXGY analogue of the "trace every wiring site" lesson).

## Deferred (explicitly out of scope)

- **Tiered / threshold** promo type — its own later slice (own `*_config` blob).
- **Bundle** promo type — its own later slice (own `*_config` blob).
- Per-promotion usage limits (codes still own the redemption cap).
- Backoffice authoring of `active_from_hour`/`active_to_hour` (stored-but-not-authored) — SP-Promo-4.
- The specific brand promo the user has in mind — revisited after this lands, or sooner if it turns out the current config can't express it.
- BXGY savings on the thermal-printed receipt beyond the existing discount line (consistent with SP-CRM-9 v1 receipt limitation).
