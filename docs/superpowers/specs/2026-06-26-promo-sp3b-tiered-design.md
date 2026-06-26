# SP-Promo-3b-tiered — Spend-Threshold Tiered Discount (Design)

**Date:** 2026-06-26
**Branch:** `prod-hardening`
**Status:** Design approved — ready for implementation plan
**Slice:** the tiered/threshold new-type slice of SP-Promo-3 (follows 3a stacking, 3c code-linkage, 3b buy-X-get-Y + 3b-reward-fulfillment). Bundle (SP-Promo-3b-bundle) + SP-Promo-4 remain separate later slices.

---

## Context
The promotion module supports `percentage`, `fixed`, `bogo`, `buy_x_get_y` types; new types live in a per-type `jsonb` config blob ("Approach 2", e.g. `bxgy_config`) to keep the gap-class wiring surface to one field. This slice adds a `tiered` type: "spend more, save more." Unlike buy-X-get-Y, tiered is a **plain discount** (no reward lines, no modal, no server fulfillment, no grant table) — much simpler.

## Decisions (locked during brainstorm)
1. **Highest qualifying tier wins** (single tier, not cumulative), measured on the **cart subtotal**.
2. **Each tier carries its own discount kind+value** (`percentage` or `fixed`) — tiers may mix.
3. **Whole-cart** only (no product scoping this slice).
4. Below the lowest tier → **0 discount**; POS greys the promo (like below-minimum) until the first tier is reached; between tiers, the lower qualifying tier applies.
5. The promo's existing `min_purchase` is **unused** for tiered (the lowest tier threshold is the effective minimum).
6. Stacking (3a) + code-linkage (3c) inherit for free (just another `PromoSpec`).
7. **Storage = a `tiered_config` jsonb blob** (Approach 2, same pattern as `bxgy_config`).
8. **POS next-tier hint IN SCOPE** ("spend Rp X more for the next tier") — display-only.

---

## 1. Data model (migration 0040)
- Extend the `promotions.type` CHECK constraint to add `'tiered'`.
- `ALTER TABLE promotions ADD COLUMN tiered_config jsonb` (NULL for non-tiered).

Blob shape (one Go struct `TieredConfig`/`Tier`, one TS interface, parity-pinned):
```jsonc
{
  "tiers": [
    { "minSubtotal": 100000, "kind": "fixed",      "value": 10000 },
    { "minSubtotal": 250000, "kind": "percentage", "value": 15 },
    { "minSubtotal": 500000, "kind": "percentage", "value": 20 }
  ]
}
```
For a `tiered` promo the top-level `value` and `applicable_product_ids` are unused.

## 2. Engine — `pricing.go` `calcPromotionDiscount` + TS `pricing.ts` parity
New branch for `Kind == tiered`:
- Select the tier with the **largest `minSubtotal ≤ subtotal`** (sort tiers ascending defensively; pick the last qualifying).
- Apply: `percentage → round(subtotal × value/100)`; `fixed → min(value, subtotal)`.
- No qualifying tier (subtotal below the lowest `minSubtotal`) → **0**.
Returns a normal discount amount summed into the additive `Promos` stack. **No double-discount concern** — tiered is a plain discount (not a reward line), so it returns the real amount (contrast bxgy separate-set which returns 0). Pure helper `pickTier(cfg, subtotal) -> *Tier` (nil if none) shared by the branch.

## 3. Validation — `validateTieredConfig` (save-time, online-authoritative)
- `tiers` non-empty; each tier: `minSubtotal ≥ 0`, `kind ∈ {percentage, fixed}`, percentage ⇒ `0 < value ≤ 100`, fixed ⇒ `value > 0`.
- Reject **duplicate `minSubtotal`** across tiers (ambiguous selection).
- Engine treats a nil/structurally-invalid blob on a `tiered` promo as **0 + `slog.Warn`** (never panic/422 at the till); gating violations (dates/hours/outlet) still follow the existing hybrid-by-origin path.

## 4. POS (= APK)
- **Pricing parity:** TS `calcPromoDiscount` mirrors the Go tier-selection 1:1 (vitest parity cases).
- **Next-tier hint (display-only, POS-only):** pure helper `tieredNextTier(cfg, subtotal)` returns the smallest tier whose `minSubtotal > subtotal` (or null at the top), plus the gap `minSubtotal − subtotal`. PromoPanel renders a muted hint under the promo: below the lowest tier (greyed) → "Belanja Rp{gap} lagi untuk {tier label}"; in a tier with a higher one → current savings **+** "Rp{gap} lagi untuk {next tier label}"; at the top tier → current savings only. Tier label: percentage → "hemat {value}%", fixed → "potongan Rp{value}". No server/Go parity needed (display-only).
- **PromoPanel gate:** a tiered promo greys with "Belum memenuhi minimum belanja" when `calcPromoDiscount === 0` (below the lowest tier), else shows the active tier's savings + the hint. Stacking pills (3a) carry over. **No modal, no reward lines.**
- **Checkout re-guard:** unchanged (re-validates gates; discount recomputed by pricing).

## 5. Backoffice — `PromoFormModal.tsx`
Add `tiered` to the type selector (label "Bertingkat — belanja lebih, hemat lebih"). When selected, hide the `value` + `applicableProductIds`/variant inputs and show a **tier editor**: rows of `{Min. belanja (minSubtotal), Tipe (Persentase/Nominal), Nilai}` with add/remove-row. Client-side mirror of §3 invariants before save (≥1 tier, ranges, no duplicate threshold). Seed a default 1-tier config when the type is selected (like the bxgy default-seed).

## 6. Wire / type-gen (the gap-class trace)
- OpenAPI: `Tier` + `TieredConfig` schemas; nullable `tieredConfig` on `Promotion` + `PromotionInput`; `tiered` in both `type` enums. Regenerate `api.gen.go` + `schema.d.ts` (corepack pnpm for TS; `make gen-check`). Watch the nullable-$ref codegen gotcha (clear in TS by omitting).
- **Read repo** (`read/repo.go` `Promotions`): add `'tieredConfig', tiered_config`.
- **Write repo** (`write/repo.go` `CreatePromotion` AND `UpdatePromotion`): add `tiered_config` to BOTH INSERT and UPDATE (marshal struct; nil → SQL NULL).
- **Backoffice edit-populate** (`Promotions.tsx` `openEditPromo`/`dupPromo`/`togglePromo`): carry `tieredConfig` (the SP-Promo-3b edit-form lesson — the gap-class has a frontend edit-populate dimension).

## 7. Testing & verification
- **Go table tests** (`pickTier`/the branch): below lowest → 0; between tiers → lower tier; at/above top → top tier; mixed kinds; fixed capped at subtotal; unsorted tiers handled; nil blob → 0; `validateTieredConfig` rejects empty/duplicate-threshold/out-of-range.
- **TS vitest parity** 1:1 for the discount branch, **plus** `tieredNextTier` cases (gap math, per-kind label, null at top, below-lowest gap to first tier).
- **`resolvePromos`/order:** a `tiered` promo resolves from the blob, stacks (3a), links (3c).
- **Gap-class guard:** authed round-trip smoke (POST `tieredConfig` → GET → all tiers + type round-trip) + the static read/INSERT/UPDATE wiring check + the backoffice edit-populate check.
- **Live e2e** (throwaway `cmd/promo3tiered`): a tiered promo on a real order discounts by the correct tier (between-tier + top-tier), refund, cleanup zero-residue.
- Local gate (go build+test+gen-check; POS tsc+vite+vitest; backoffice tsc+vite); deploy (migration 0040); **new APK**; on-device acceptance.

## 8. Model routing & rollout
Sonnet implement; **Opus** review the engine + `resolvePromos` + type-gen + POS pricing parity; **Haiku** for the form/copy + the next-tier-hint helper + spec-conformance. Additive migration + type value; existing `percentage`/`fixed`/`bogo`/`buy_x_get_y` rows untouched.

## Deferred / out of scope
- Product-scoped tiers (whole-cart only this slice).
- SP-Promo-3b-bundle (separate slice) + SP-Promo-4 (authoring/UX overhaul incl. active-hours form).
- A backoffice tiered-usage analytics view.
