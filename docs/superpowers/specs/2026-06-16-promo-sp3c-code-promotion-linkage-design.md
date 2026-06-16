# SP-Promo-3c — Code → Promotion Linkage (Design)

**Date:** 2026-06-16
**Branch:** `prod-hardening`
**Status:** Design approved — ready for implementation plan
**Slice:** SP-Promo-3c (third sub-slice of the SP-Promo-3 decomposition; follows 3a stacking/combinability)

---

## Context

The promotion module is a 4-angle overhaul decomposed into SP-Promo-1..4. SP-Promo-3 was split into 3a (stacking/combinability — DONE, rev `00066-lwf`, mig 0036), **3c (this slice — code→promotion linkage)**, and 3b (new promo types: buy-X-get-Y / tiered / bundles).

**Why 3c before 3b:** the user confirmed that discount **codes** must be able to deliver the richer promo mechanics (BOGO/bundle/tiered), not just plain %/Rp-off. Today a `discount_codes` row carries its own `type`/`value` (capped to `percentage`/`fixed`) and is structurally weaker than a `promotions` row (which also allows `bogo` and product scoping). If we wire codes to inherit a linked promotion's mechanics *first*, then 3b can add the new types **once on `promotions`** and codes get them for free — no duplicated type system on `discount_codes`.

**The dead-FK finding:** `discount_codes.promotion_id` already exists (FK → `promotions`, `ON DELETE SET NULL`, since `0001_init`), is persisted by the write repo, and is returned by the read API as `promotionId` — but `resolvePromos` (`backend/internal/service/order.go:640-741`) **never dereferences it**. When a code resolves, it builds a `PromoSpec` purely from the code's own `type`/`value`. So 3c is "wire an existing dead FK," not "add a column."

**Intended outcome:** a discount code can act as a *key* that unlocks a promotion's full mechanics. The code supplies only the gate (redemption cap + its own dates/min); the promotion is the single source of truth for *what* the discount is. A promotion can be marked "code-only" so it is reachable exclusively via a linked code (hidden from the auto-browse POS panel).

---

## Decisions (locked during brainstorm)

1. **Codes deliver rich types** → build 3c first, then 3b.
2. **Model A — "code is a key" (inherit fully).** When a code has a non-null `promotion_id`, the linked promotion supplies *all* discount mechanics (type, value, product scoping, BOGO, hours/days). The code's own `type`/`value` are ignored for linked codes (kept only as the fallback for **unlinked** codes — today's behavior, fully backward compatible). Extra flat discounts are expressed via the 3a stacking engine (apply a second discount), never overloaded onto one code.
3. **`code_only` promotions.** A promotion can be marked code-only: hidden from the POS panel, resolves only when unlocked by a linked code.
4. **Intersection gating.** Effective gating = the promotion's own rules **AND** the code's own rules; both must pass.
5. **Dedupe.** A promotion arriving both via a code link and directly in `promotionIds` applies once.

---

## 1. Data model

- **`promotions.code_only boolean NOT NULL DEFAULT false`** — new migration `0037`. `true` ⇒ excluded from the POS panel; resolves only via a linked code. Backoffice still lists it.
- **`discount_codes.promotion_id`** — already exists; no schema change. Resolution starts honoring it.
- **`discount_codes.type` / `value`** — kept. The discount source for **unlinked** codes (backward compatible). Ignored for linked codes. No CHECK-constraint change (`discount_codes.type` stays `('percentage','fixed')` — linked codes bypass it entirely).
- FK is `ON DELETE SET NULL`: deleting a linked promotion auto-nulls the code's `promotion_id`, cleanly reverting the code to its own type/value. No dangling state.

## 2. Backend resolution — `resolvePromos` (Opus-review surface)

In the code loop of `resolvePromos` (`order.go`), after loading a code row:

- **If `promotion_id` is non-null:** load that promotion (same SELECT shape as the promo-id loop) and build the `PromoSpec` from the **promotion's** `type`/`value`/`applicable_product_ids`/`bogo`. The code's own `type`/`value` are not read.
- **Intersection gating:** validate the code's gates (`ValidateCode`: usage_limit, code start/end dates, code min_purchase) **and** the linked promotion's rules (`ValidatePromo`: promotion dates, `active_from/to_hour`, `active_days`, `outlet_ids`, promotion min_purchase, plus `is_active`). All violations collected; any one fails the discount.
- **Combinability:** a linked entry contributes the **promotion's** `combinable` to the existing 3a `combinabilityViolation` gate (the code's own `combinable` is ignored when linked).
- **Dedupe:** extend the existing dedupe so that if the same resolved promotion identity arrives both via a code link and directly in `promotionIds`, its `PromoSpec` is applied once. (Today `dedupeNonEmpty` only dedupes raw id/code strings; add a post-resolution guard keyed on the resolved promotion id.)
- **Hybrid-by-origin unchanged:** an invalid linked promotion → online (`Offline=false`) returns `*ErrDiscountRejected` → handler `errors.As` → HTTP 422 with an Indonesian reason (e.g. "Promo tertaut tidak berlaku: …"); offline (`Offline=true`) records at server-authoritative value + sets `orders.discount_warning` + reason. Mirrors SP-Promo-1/3a.
- **Usage accounting unchanged:** the linked code still increments its own `usage_count` (race-safe via the existing `FOR UPDATE`), and refund still restores it via `applied_discount_codes` (3a). The linked promotion has no per-promotion usage counter (out of scope).

## 3. POS (= APK)

- **Panel filter:** `PromoPanel` excludes `code_only` promotions from the browsable list (the POS already loads all promotions; one filter on `code_only !== true`).
- **Linked-code apply:** when a cashier types a code that has a `promotion_id`, the POS resolves that promotion from the **in-memory promotions list** and applies its mechanics + the code's gates. `apps/pos/src/cashier/promoValidate.ts` gains linked-code handling: validate the code's gates AND the linked promotion's rules (intersection), and compute savings from the promotion (reusing the same `calcPromoDiscount`/BOGO helpers the panel uses).
- **Checkout re-guard** (`handleConfirmPayment`) extends to re-validate the linked promotion, preserving the invariant "a client-passing order won't 422 server-side."
- **Display:** the applied-code chip / cart savings line shows the resulting discount and the linked promotion's name for clarity. No receipt-format change beyond the existing discount line.

## 4. Backoffice

- **Promosi form** (`apps/backoffice/src/screens/Promotions.tsx`): add a `code_only` toggle ("Hanya via kode") + a badge on code-only rows.
- **Kode Diskon form:** add a "Tautkan ke promosi" promotion picker (dropdown of existing promotions; nullable). When a promotion is selected, the code's own type/value inputs are visually disabled with a note ("Tipe & nilai diikuti dari promosi tertaut"). Unlinked = today's plain %/Rp-off.

## 5. Wire / type-gen

- OpenAPI: add `codeOnly` to the `Promotion` schema + its input; `promotionId` already exists on `DiscountCode`/its input (verify it is present and nullable). Regenerate `api.gen.go` + `schema.d.ts`; `make gen-check` green.
- **Read repo** (`read/repo.go` `Promotions`): add `'codeOnly',code_only` to the `json_build_object`.
- **Write repo** (`write/repo.go` Promotions create/update): persist `code_only` in INSERT + UPDATE. (Lesson from SP-Promo-3a: adding a column means tracing BOTH the read `json_build_object` AND the write INSERT/UPDATE — not just OpenAPI + form.)

---

## Testing & verification

- **Pure unit tests (Go, table-driven):** linked-code resolution builds the spec from the promotion; intersection gating (code valid + promo expired → reject; promo valid + code over-limit → reject); dedupe (code link + direct promo id → one spec); combinable taken from the promotion; `code_only` excluded from panel feed; offline path records + flags instead of rejecting.
- **TS parity:** mirror the linked-code cases in `promoValidate.test.ts` (1:1 with the Go validator, per the SP-Promo-2 pattern).
- **Live e2e (throwaway `cmd/promo3ce2e`, real `OrderService` against the test DB, zero-residue cleanup):**
  1. Create a `code_only` BOGO promotion + a code linked to it → order with the code unlocks the BOGO → correct discount, code `usage_count` increments, grant recorded.
  2. Underlying promotion expired → online order rejected (422 reason); offline order recorded + flagged.
  3. Dedupe: same promotion via code + directly selected → applied once.
  4. Refund a linked-code order → the code's `usage_count` restored (idempotent double-refund).
  5. Unlinked code (no `promotion_id`) → unchanged behavior (regression guard).
- **Local gate:** `go build` + `go test ./...` + `make gen-check`; POS `tsc -b` + `vite build` + `vitest`; backoffice `tsc -b` + build.
- **Deploy + authed smoke:** deploy backend (migration `0037`), confirm `codeOnly` serializes on GET promotions and persists on create/update (the 3a gap-class check). Then APK build + on-device acceptance.

## Rollout / risk notes (working rules)

- **Behavior-change flag (rule 3 — flag uncertainty):** resolution will start honoring `promotion_id`. Before deploy, check the test DB for any existing `discount_codes` row with a non-null `promotion_id`. The old backoffice form did not expose the link, so this is expected to be zero (no behavior change for existing codes); if any exist, review them before deploy.
- **Don't touch unrelated (rule 2):** scope is confined to the promotion resolution path, the two backoffice promo/code forms, the POS promo panel + code-apply path, and the codegen for `code_only`. No changes to loyalty, stock, or unrelated order logic.
- **Model routing:** Sonnet implements; **Opus** reviews `resolvePromos`/order/refund/dedupe + the type-gen; **Opus** reviews the POS validate/re-guard hot path; **Haiku** for the backoffice toggle/copy + spec-conformance checks. Per [[model-routing-policy]].

## Deferred (explicitly out of scope)

- Per-promotion usage limits (codes still own the redemption cap).
- The new promo *types* themselves (BOGO beyond today's support, bundle, tiered) — that is **SP-Promo-3b**, which builds on this linkage.
- Backoffice authoring of `active_from_hour`/`active_to_hour` (stored-but-not-authored) — **SP-Promo-4**.
- `combinable_with` allowlist (still boolean-only).
