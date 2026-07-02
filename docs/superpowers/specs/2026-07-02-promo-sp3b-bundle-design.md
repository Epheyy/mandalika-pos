# SP-Promo-3b-bundle — Multi-Product Bundle (Design)

**Date:** 2026-07-02
**Branch:** `prod-hardening`
**Status:** Design approved — ready for implementation plan
**Slice:** the multi-product **bundle** new-type slice of SP-Promo-3 (follows 3a stacking, 3c code-linkage, 3b buy-X-get-Y, 3b-reward-fulfillment, 3b-tiered). This is the **last new promo type**; after it the module's remaining OPEN items are the `promo_reward_grants` reporting view + SP-Promo-4 (authoring/UX overhaul).

---

## Context

The promotion module supports `percentage`, `fixed`, `bogo`, `buy_x_get_y`, `tiered` types; new types live in a per-type `jsonb` config blob ("Approach 2", e.g. `bxgy_config`, `tiered_config`) so the gap-class wiring surface stays one field. This slice adds a `bundle` type: **buy a specific set of products together → the set is priced at a fixed `bundlePrice`**.

**The owner's real promo (the design target):** *Gorgeous Tuberose* combo = 110ml Extrait + a 10ml Atomizer + a 2ml Extrait, individually ~Rp800,000, bundled at **Rp575,000** (= the 110ml's price, the anchor). The set is defined semi-generically: main product 110ml **or** 120ml, **any** atomizer, main product 2ml/vial.

**Owner's presentation requirement (crucial):** the discount must NOT appear as a lump "bundle discount" line. Instead the **cheaper set items show Rp0 / GRATIS per line** while the anchor keeps full price — so it reads as a promotion (free gift) rather than obvious bundle-repricing ("to avoid customer suspicion that they're just paying bundles not a promotion"). For the target promo: 110ml stays Rp575,000, atomizer + 2ml show GRATIS, customer pays Rp575,000.

**Not to be confused with the legacy `bundles` SKU feature** (`bundles`/`bundle_items` tables, backoffice `products/BundlesPanel.tsx`, `GET /api/v1/bundles`, POS sync `bundles`, `order_items.is_bundle`). That is a *static composite product sold as a unit* — a different mechanism that reads as a bundle, which is exactly what the owner does not want here. **The legacy feature is untouched by this slice.**

---

## Decisions (locked during brainstorm)

1. **Discount kind = `fixed_price` only.** The set is priced at a single `bundlePrice`. (Percentage / fixed-off bundle kinds are dropped — YAGNI; fixed_price matches the business model.)
2. **Set model = slots with alternatives.** Each slot = a list of eligible product-variant keys + a required quantity; a full set = one unit satisfying each slot × its quantity. Covers "110 or 120" and "any atomizer" without combinatorial explosion.
3. **Repeats with a cap.** Multiple full sets in the cart apply the bundle multiple times, up to `maxApplications` (0 = unlimited) — mirrors buy-X-get-Y.
4. **Freeing rule = cheapest-first, keep the expensive anchor.** The discount is realized by zeroing the cheapest consumed units; the most expensive unit(s) keep full price.
5. **Presentation = materialization via reward lines.** Freed units become `isReward` Rp0 lines keyed to the bundle promo, so cart / receipt preview / thermal print / backoffice reprint all show GRATIS automatically (they already key on `isReward && subtotal <= 0`). No lump discount line, no display-only trick.
6. **Server-authoritative**, hybrid-by-origin (online invalid → 422; offline → honor the rung sale at the client price + flag, never drop — a freed line is a physical unit the customer is taking, so dropping it would lose the item and leak stock), stock conserved (a freed unit replaces a paid unit — decrements once).
7. **Picker modal only when a slot is ambiguous** — if a slot has MORE eligible units in the cart than it requires (e.g. two different atomizers, slot needs one), the cashier selects which unit(s) fill that slot; the unchosen eligible units stay standalone paid items. When every slot is unambiguous (exactly enough eligible units), auto-apply with no modal. Freeing within the chosen consumed set stays deterministic (cheapest-first, keep anchor).
8. Stacking (3a) + code-linkage (3c) inherit for free (a bundle is just another `PromoSpec`).
9. **Overlapping slots rejected at save-time** (a key in two slots) so application-counting stays deterministic — mirrors bxgy's overlap rejection.
10. **Outlet selector deferred to SP-Promo-4.** Bundle stays whole-fleet by default (`outlet_ids` empty = all outlets), unchanged.

---

## 1. Data model (migration 0041)

- Extend the `promotions.type` CHECK constraint to add `'bundle'`.
- `ALTER TABLE promotions ADD COLUMN bundle_config jsonb` (NULL for non-bundle).

Blob shape (one Go struct `BundleConfig`/`BundleSlot`, one TS interface, parity-pinned):

```jsonc
{
  "slots": [
    { "productKeys": ["<tuberoseId>|110ml", "<tuberoseId>|120ml"], "quantity": 1 },
    { "productKeys": ["<atom1>", "<atom2>", "<atom3>"],            "quantity": 1 },
    { "productKeys": ["<tuberoseId>|2ml"],                          "quantity": 1 }
  ],
  "bundlePrice": 575000,
  "maxApplications": 0
}
```

- `productKeys`: `pid` (product-level) or `pid|size` (variant-level) — the SP-CRM-9b / SP-Promo-3b composite-key convention (`variantKey` builds it, `keyMatchesLine` matches it). Mixed levels allowed per slot.
- For a `bundle` promo the top-level `value` and `applicable_product_ids` are unused (like `bxgy_config`/`tiered_config`).

## 2. Engine — matching, application count, freed-unit selection

New Go structs in `service/pricing.go` (`BundleConfig{Slots []BundleSlot; BundlePrice float64; MaxApplications int}`, `BundleSlot{ProductKeys []string; Quantity int}`) + `DiscountBundle DiscountKind = "bundle"` + `PromoSpec.Bundle *BundleConfig`. Mirrored 1:1 in `pricing.ts`.

**Application count** (pure helper `bundleApplications(cfg, items) int`):
- For each slot, count matching units in `items` = Σ over lines whose key matches any `slot.productKeys` of `line.Quantity`.
- `nApp = min over slots of floor(matchingUnits / slot.Quantity)`, then `min(nApp, MaxApplications)` when `MaxApplications > 0`.
- Overlapping slots are rejected at save-time (§3), so per-slot counts don't double-claim a unit; greedy per-slot counting is exact.

**Consumed units & freeing** (pure helper `bundleFreed(cfg, items, assignment) []FreedUnit` returning, per unit to free, its `{ProductID, VariantSize, fullPrice, net}`):
- Consume `slot.Quantity × nApp` units per slot. When a slot has EXACTLY enough eligible units, consume them (no choice). When a slot has MORE eligible units than needed (ambiguous), the **cashier's picker `assignment`** selects which specific units fill it (§5, §7); the unchosen eligible units remain standalone paid items. *(Common case: one unit per slot, `assignment` empty, no modal.)*
- `appBase` = Σ consumed unit prices for one application; total discount `D = Σ over applications max(0, appBase − bundlePrice)`. (Never negative — a `bundlePrice` above the set's actual value yields 0 discount.)
- Free the **cheapest consumed units first**, fully zeroing each until the freed nominal reaches `D`; the final freed unit may be **partially** discounted (`net = price − remaining`), all pricier consumed units keep full price. This keeps the expensive anchor at full price. Fully-zeroed units → `net = 0` (GRATIS); a partial unit → `net > 0` (reduced, not GRATIS).

**`calcPromotionDiscount(bundle)` → `0`** in both engines. The saving lives in the freed reward lines' reduced prices, so the promo itself contributes 0 to the additive discount stack (same rationale as buy-X-get-Y separate-set). This closes the double-discount hazard: a bundle in `promotionIds` + its freed reward lines is not discounted twice.

## 3. Validation — `validateBundleConfig` (save-time, online-authoritative)

- `slots` non-empty; each slot: `productKeys` non-empty, `quantity ≥ 1`.
- `bundlePrice > 0`.
- `maxApplications ≥ 0`.
- **Reject overlapping slots**: no `productKey` may appear in more than one slot.
- Engine treats a nil / structurally-invalid blob on a `bundle` promo as **no match (0 freed) + `slog.Warn`** — never panic/422 at the till. Gating violations (dates/hours/outlet/min) still follow the existing hybrid-by-origin path. `parseBundleConfig` hard-errors on malformed JSON but `validateBundleConfig` gates writes so it cannot reach the till (matches `parseBXGYConfig`/`parseTieredConfig`).

## 4. Server resolution — `resolveBundleLines` (new; sibling to `resolveRewardLines`)

Runs in `CreateOrder` BEFORE pricing/stock/insert, mutating `in.Items` in place. **Partitioned from `resolveRewardLines` by promo type** — each resolver ignores lines whose `rewardPromotionId` points at the other type (a bundle-freed line's promo is type `bundle`; a bxgy reward line's promo is `buy_x_get_y`). `resolveRewardLines`'s `bxgyFor` already returns nil cfg for a non-bxgy promo; it must **skip** (keep untouched) rather than drop such lines so bundle lines survive to `resolveBundleLines`.

For each bundle promo referenced by any `isReward` line with a `bundle`-type `rewardPromotionId`:
- **Owned units** = ALL of the customer's units of the set's products, counting BOTH the remaining paid lines AND the bundle-freed reward lines (a freed unit is one the customer owns — contrast bxgy, where reward lines are excluded from the buy-count). Re-derive the set match and `nApp` from these owned units using the §2 helpers (server = source of truth).
- **Slot assignment (ambiguity):** the cashier's picker choice is conveyed by *which units the client marked freed*. The server does NOT override that choice with its own cheapest-across-all pick; it **accepts** the client's freed-unit selection **provided it is legal** — each freed unit eligible for a distinct slot instance, a complete set present per application, freed count within `nApp`. This is the one place the server honors a client selection (like the cashier choosing a bxgy reward variant); everything monetary is still re-derived. The consumed anchor units (kept at full price) are identified from the remaining eligible owned units needed to complete each set; exact wire for conveying the assignment (freed lines alone vs an explicit consumed tag) → plan.
- **Reprice**: overwrite each freed reward line's `Price`/`Subtotal` with the server-computed `net` (0 for fully-freed, reduced for the partial). Never trust the client price.
- **Stock conservation**: total physical units of each product = paid-line qty + bundle-freed-line qty must equal what the customer actually has; the freed unit is not an extra. The POS achieves this by reducing the paid line by the freed count and adding the reward line (net zero-sum); the server validates the re-derived freed set is a subset of owned units and does not inflate quantities. Stock decrements once per physical unit (existing stock logic counts paid + reward lines uniformly).
- **Hybrid-by-origin**: an online order whose bundle lines don't match a valid re-derived freed set (tampering / cart changed) → `*ErrDiscountRejected{ViolationBundleInvalid}` → HTTP 422 ("Bundel tidak valid atau syaratnya tidak terpenuhi"). **Offline → honor the sale as rung**: keep the freed line at the client-quoted price (recorded + stocked — never dropped, because unlike a bxgy *added* reward it is a physical unit the customer is taking; dropping it would lose the item and leak stock) + set `discount_warning` + reason. Never silently change a collected total. (This is the deliberate divergence from `resolveRewardLines`, whose offline path drops the added reward.)
- **Grants**: write one `promo_reward_grants` row per freed unit (reuse the SP-Promo-3b-reward table: `full_price`, `reward_price = net`, `reward_value = full − net`), immutable on refund.
- **Refund**: freed units are real given-away/repriced items → refund restocks them like any line; grants stay immutable (the existing refund path already restocks all lines and leaves grants).

New violation constant `ViolationBundleInvalid` + Indonesian handler message. New `DiscountBundle` recognised in `loadPromoSpec` (parse `bundle_config` into `spec.Bundle`).

## 5. POS (= APK)

- **Pricing parity:** TS `calcBundleDiscount`-equivalent path returns 0 (mirrors Go); the freed-unit selection helper (`bundleFreed`) is ported 1:1 (vitest parity cases) and drives both the apply action and the savings display.
- **Apply gate:** a bundle promo greys in `PromoPanel` with "Syarat bundle belum terpenuhi" until the full set is present in the cart (`bundleApplications(cfg, cart) > 0`), like the buy-X-get-Y separate-set gate.
- **Apply → picker only when ambiguous:** on apply, if any slot has more eligible cart units than it requires, open a **`BundleSlotPicker`** modal (sibling to `BxgyRewardModal`): per ambiguous slot, the cashier selects which specific cart unit(s) fill it (radio/select among eligible units, showing name + price + `· Stok`). When no slot is ambiguous, skip the modal and apply directly. On confirm, the chosen consumed set's cheapest units are repriced to reward lines (`isReward`, `rewardPromotionId` = bundle promo id) at their `net`; a paid line is split (qty reduced + reward line added) only when its qty exceeds the freed count.
- **Reactive removal:** paid units dropping below the set → freed lines + the applied promo auto-removed (reuse the reducer's `CART_REMOVE_PROMO_REWARDS` / promo-removal wiring; counts UNITS).
- **Display:** cart + receipt show freed lines as GRATIS (existing `isReward && subtotal <= 0` rendering) or reduced (partial); the applied-promo name shows in the promo chips / receipt. No separate discount amount line for the bundle (its `calcPromoDiscount` is 0).
- **Checkout re-guard:** re-validates the bundle (gates + set still present) and mirrors the server; a client-passing order won't 422.

## 6. Backoffice — `promotions/PromoFormModal.tsx`

- Add a **"Paket Bundel"** type card to the descriptive `PromoTypePicker` (added in `2525f46`), with a 1-line description. Selecting it seeds a default 1-slot `bundleConfig` and hides the `value` + `applicableProductIds`/variant inputs (like bxgy/tiered).
- **Slot editor:** rows of slots; each slot = a `customers/ProductVariantPicker` multi-select (emits `pid` / `pid|size` PIPE keys — the same picker buy-X-get-Y reuses) + a quantity field; add/remove-slot. Plus `bundlePrice` (Harga paket) + `maxApplications` (Maks. kelipatan, 0 = tanpa batas). Client-side mirror of §3 invariants before save (≥1 slot, non-empty keys, qty ≥ 1, bundlePrice > 0, no overlapping keys across slots).
- **Edit-populate** (`Promotions.tsx` `openEditPromo` / `dupPromo` / `togglePromo`): carry `bundleConfig` (the SP-Promo-3b frontend gap-class lesson — the edit-form-populate path must carry every typed field or edit loads blank + re-save wipes it).
- **List labels** (`Promotions.tsx` `promoTypeLabel`/`promoValueLabel`): add `bundle` → "Paket Bundel" / "Harga paket Rp{bundlePrice}" (the `ff709b4` label lesson — every new type needs a list label or it defaults wrong).

## 7. Wire / type-gen (the gap-class trace)

- **OpenAPI:** `BundleSlot` + `BundleConfig` schemas; nullable `bundleConfig` on `Promotion` + `PromotionInput`; `bundle` in both `type` enums. Regenerate `api.gen.go` (`make gen-check`) + `schema.d.ts` (corepack pnpm for TS). Watch the nullable-`$ref` codegen gotcha — clear the field in TS by omitting/`undefined`, not `null`, if openapi-ts drops `|null` (it kept it for `bxgyConfig`/`tieredConfig`; verify).
- **Read repo** (`read/repo.go` `Promotions` json_build_object): add `'bundleConfig', bundle_config`.
- **Write repo** (`write/repo.go` `CreatePromotion` AND `UpdatePromotion`): add `bundle_config` to BOTH the INSERT and the UPDATE (marshal struct; nil → SQL NULL, guarded `var bundle any`).
- Handler decodes the body straight into `write.Promotion` (`decodeWrite`) — no api→write mapping needed (same as bxgy/tiered).

## 8. Testing & verification

- **Go table tests** (`bundleApplications`, `bundleFreed`, the `calcPromotionDiscount` branch = 0, `validateBundleConfig`): full set present → freed = cheapest-first, anchor kept; set absent → 0 apps; repeats up to cap; slots with alternatives (pick lowest-priced eligible); partial-free (bundlePrice not a boundary); variant-level keys; nil/invalid blob → 0; validation rejects empty slots / qty<1 / bundlePrice≤0 / overlapping keys.
- **`resolveBundleLines` tests:** valid freed set repriced to server net; stock conserved (paid+reward = owned); online tamper → `ViolationBundleInvalid` (422); offline invalid → freed line kept at rung price + `discount_warning` (not dropped); one grant per freed unit; partition — a bxgy reward line and a bundle freed line in the same order each handled by its own resolver, neither dropped by the other.
- **TS vitest parity** 1:1 for `bundleApplications`/`bundleFreed`/the 0-discount branch; POS apply→reprice→GRATIS display; reactive removal; the ambiguous-slot picker (two atomizers → cashier picks one → only the chosen unit freed, the other stays paid) + unambiguous → no modal.
- **`resolveBundleLines` assignment tests:** the server accepts a legal client freed-unit selection (chosen atomizer freed, other paid); rejects an illegal one (freed unit not eligible / no complete set / over `nApp`) online → 422.
- **`resolvePromos`/order:** a `bundle` promo resolves from the blob, stacks (3a), links via a code (3c).
- **Gap-class guard:** (1) static audit of every `promotions` field across read-json / INSERT / UPDATE = the new `bundle_config` at all three; (2) live authed round-trip smoke on the deployed rev (POST full `bundleConfig` → GET → slots + bundlePrice + maxApplications + type round-trip → DELETE, zero residue); (3) the backoffice edit-populate check (edit loads the slot editor populated; dup/toggle preserve it).
- **Live e2e** (throwaway `cmd/promo3bundle`, real `OrderService` vs Neon, never committed, deleted after, zero-residue): the target promo — cart {110ml, atomizer, 2ml} → order records 110ml full + atomizer & 2ml at Rp0, total = bundlePrice, `discount_amount` unaffected by the bundle (0), grants written per freed unit, stock decremented once per physical unit; repeats (2 sets → 2× freed, cap honored); online tamper (freed line without the set) → 422; refund restocks + grants immutable.
- Local gate: go build + `go test ./...` + `make gen-check`; POS tsc + vite + vitest; backoffice tsc + vite. Deploy (migration 0041); **new APK**; on-device acceptance.

## 9. Model routing & rollout

Sonnet implements. **Opus** reviews: the engine matching/freeing (`bundleApplications`/`bundleFreed`/the 0-branch), `resolveBundleLines` (stock conservation + hybrid-by-origin + grants + the resolver partition + the client-assignment acceptance/validation), type-gen (`api.gen.go`/`schema.d.ts`), and POS pricing parity + apply/reprice reducer + the `BundleSlotPicker` assignment wiring. **Haiku** for the form/copy + list labels + spec-conformance. Additive migration + type value; existing `percentage`/`fixed`/`bogo`/`buy_x_get_y`/`tiered` rows untouched. New APK; deploy pre-authorized (`autoMode.allow`); push before triggering the APK build (`gh workflow run` builds from origin).

## Deferred / out of scope

- Percentage / fixed-amount bundle kinds (fixed_price only this slice).
- Category-based slots (explicit product-key lists only).
- The outlet selector on the promo form (→ SP-Promo-4, with active-hours/days).
- The `promo_reward_grants` backoffice reporting view (still deferred, now fed by bundle grants too).
- The legacy `bundles` SKU feature — untouched.
