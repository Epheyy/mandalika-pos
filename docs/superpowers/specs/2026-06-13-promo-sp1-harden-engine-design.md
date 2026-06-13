# SP-Promo-1 — Harden the Promotion Engine (Design)

**Date:** 2026-06-13
**Branch:** `prod-hardening`
**Module:** Promotion module, slice 1 of 4 (SP-Promo-1..4)
**Scope:** Backend (Go) + minimal backoffice. **No POS change → no APK.**
**Review tier:** Sonnet implements; engine/`order.go`/`resolvePromo`/refund/migration → **Opus**; backoffice badge → typescript-reviewer.

---

## 1. Context & problem

The promotion module spans four angles; this is the first slice — **harden what already exists** before adding new types. A current-state audit (see the gaps list at the end) found a rich schema where many rules are **stored but never enforced at checkout**:

- `discount_codes.usage_limit` — never checked; `usage_count++` (`order.go:421`) is unconditional and **race-prone** (no row lock).
- Discount-code `start_date`/`end_date`/`min_purchase` — not validated at checkout.
- Promotion `start_date`/`end_date`/`min_purchase`/`active_from_hour`/`active_to_hour`/`active_days`/`outlet_ids` — stored, **ignored server-side** (`resolvePromo` checks only `is_active=true`).
- Refund **does not restore** `usage_count` (asymmetric).

The engine is otherwise sound: pricing is server-authoritative (`service/pricing.go`), recomputed at checkout; percentage/fixed/BOGO math works; `discount_breakdown` denormalization works; the POS mirrors pricing for display only.

### The offline-first tension (the spine of this slice)

The POS is offline-first. An order can be **physically completed** (cash collected at the discounted price the cashier saw) before it reaches the server at sync time. The server distinguishes origin via `CreateOrderInput.Offline` (`order.go:71`): the online `POST /orders` handler sets `Offline:false` (`writes.go:938`); the sync path sets `Offline:true` (`sync.go:221`). The codebase **already uses this exact hybrid pattern** for stock: `order.go:261` allows negative stock with a `stockWarning` when `Offline`, but zero-floors when online. SP-Promo-1 mirrors that precedent for discounts.

---

## 2. Decisions (locked with user, 2026-06-13)

1. **First slice = SP-Promo-1 (harden).** Ordering of SP-Promo-2/3/4 decided later.
2. **Enforcement model = hybrid by origin.** Online invalid discount → **reject (HTTP 422)** so the cashier is stopped before completing the sale. Offline-synced invalid discount → **lenient: record as rung + flag** (cannot reject an already-made sale).
3. **Validation scope = enforce ALL stored rules** (code usage_limit race-safe, code dates, code min_purchase, promo dates, promo min_purchase, promo hours, promo days, promo outlets) **+ refund restores usage_count**. Combinability/stacking is explicitly SP-Promo-3.
4. **Offline invalid total = keep as rung + flag.** Apply the promo/code's **server-authoritative value** (client can't inflate the discount) but skip the rejection; record the order at the discounted total the cashier actually collected; set `discount_warning=true` with a reason. No phantom revenue; faithful to cash collected; mirrors `stock_warning`.
5. **Warning surface = minimal backoffice badge now** (not write-only). Backend + a small read-only `⚠ Diskon` badge on flagged orders. Full reconciliation/analytics UI deferred to SP-Promo-4.
6. **Code→promotion_id linkage = DEFERRED to SP-Promo-3** (it changes how a code resolves; belongs with the type-system work).

---

## 3. Approach

Mirror the repo's **"pure engine + thin DB wiring"** pattern (the shape of SP-CRM-8's `EvaluateLoyalty`): a pure, table-tested validator, plus thin wiring that applies the hybrid policy.

**Rejected alternative:** inline all checks in `resolvePromo` — smaller diff but un-unit-testable without a DB and grows an already-dense function; against the repo's tested-pure-core convention.

---

## 4. Components & data flow

### 4.1 Pure validator — `service/promo_validate.go` (no DB import)

```
type PromoViolation string // "expired" | "not_started" | "below_min_purchase"
                           // | "outside_hours" | "wrong_day" | "wrong_outlet"
                           // | "usage_limit_reached" | "not_found"

type PromoEvalContext struct {
    SaleTimeWIB time.Time // ClientCreated (WIB) or now(); same wib location as SP-CRM-8
    OutletID    string
    Subtotal    float64   // sum of line subtotals, pre-discount
}

// Loaded-row inputs (plain structs, populated by resolvePromo from the DB row):
type PromoRow struct { StartDate, EndDate *time.Time; MinPurchase *float64
                       ActiveFromHour, ActiveToHour string; ActiveDays []int; OutletIDs []string }
type CodeRow  struct { StartDate, EndDate *time.Time; MinPurchase *float64
                       UsageLimit *int; UsageCount int }

func ValidatePromo(p PromoRow, ctx PromoEvalContext) []PromoViolation
func ValidateCode(c CodeRow, ctx PromoEvalContext) []PromoViolation
```

**Rule semantics (empty/null = no constraint):**

| Rule | Promo | Code | Pass condition |
|---|---|---|---|
| Active | ✓ (`is_active`) | ✓ (`is_active`) | already enforced; kept |
| Date window | ✓ | ✓ | `start_date ≤ saleDate ≤ end_date` (date-only, WIB) |
| Min purchase | ✓ | ✓ | `subtotal ≥ min_purchase` |
| Active hours | ✓ | — | `active_from_hour ≤ HH:MM(saleTime) ≤ active_to_hour`; empty = all |
| Active days | ✓ | — | `active_days` contains saleWeekday (0=Sun..6=Sat); empty = all |
| Outlet | ✓ | — | `outlet_ids` contains order outlet; empty = all |
| Usage limit | — | ✓ | `usage_count < usage_limit`; null limit = unlimited; checked under row lock |

### 4.2 Wiring — `resolvePromo` (`service/order.go`)

Widen the function to:
- Load the **full** gating columns (today it selects only `type, value, applicable_product_ids` for promos; `id, type, value` for codes).
- For codes, the `SELECT` uses **`FOR UPDATE`** so the row lock is held from validation through the existing `usage_count++` at the end of the same tx (race-safe).
- Accept the `PromoEvalContext` + `Offline bool`.
- Run the validator and apply policy:
  - **valid** → return the authoritative `PromoSpec` (unchanged behavior).
  - **invalid + online** → return typed `ErrDiscountRejected{Violations}`.
  - **invalid + offline** → return the authoritative `PromoSpec` **plus** a non-nil `*DiscountWarning{Reason}` (joined violation codes). Caller sets `discountWarning`.
  - **missing/deleted row**: online → `ErrDiscountRejected{[]{"not_found"}}`; offline → no spec (no authoritative value to reconstruct) + warning `"not_found"` (rare; documented).

**Subtotal ordering:** compute `subtotal = Σ line.Subtotal` **before** `resolvePromo` (cheap, promo-independent), resolving the existing promo↔pricing circular dependency (`Compute` needs the promo, the validator needs the subtotal).

### 4.3 `CreateOrder` return + handler mapping

- `CreateOrder` returns the new `discountWarning bool` (extend the tuple to `(orderID, dup, stockWarning, discountWarning, err)` or introduce a small result struct — decided in planning).
- The online handler (`writes.go` CreateOrder) maps `ErrDiscountRejected` → **HTTP 422** with an Indonesian, reason-specific message:
  - `expired` → `"Kode/promo sudah kadaluarsa"`
  - `not_started` → `"Promo belum dimulai"`
  - `below_min_purchase` → `"Belum memenuhi minimum belanja"`
  - `outside_hours` → `"Promo tidak berlaku pada jam ini"`
  - `wrong_day` → `"Promo tidak berlaku hari ini"`
  - `wrong_outlet` → `"Promo tidak berlaku di outlet ini"`
  - `usage_limit_reached` → `"Kuota kode diskon sudah habis"`
  - `not_found` → `"Diskon tidak ditemukan"`
- The sync handler ignores `discountWarning` for control flow (the order still succeeds); the flag is persisted for reporting.

### 4.4 Schema — migration `0035` (next slot after 0034)

Mirror `stock_warning`:
```sql
ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_warning        boolean NOT NULL DEFAULT false;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_warning_reason text;
```
`CreateOrder` writes both (reason = joined violation codes, e.g. `"usage_limit_reached,expired"`, or NULL when not flagged).

### 4.5 Refund usage restoration (`service/order.go` Refund)

When the refunded order carried a `discount_code`, **decrement `usage_count` (floor at 0)** inside the refund tx. Idempotent via the existing already-refunded short-circuit (a double-refund cannot double-decrement). An offline over-limit sale still incremented on create (accurate); the warning — not a blocked increment — records the anomaly.

### 4.6 Backoffice badge (minimal, read-only)

A `⚠ Diskon` badge on flagged orders in the existing transactions/order view, with the reason on hover (`title`). The order read payload gains `discountWarning` (+ optional reason). The exact orders list/detail read shape is confirmed in planning; no new endpoint if the existing orders read returns these rows. **No POS change → no APK.**

---

## 5. API / type changes

- OpenAPI: add `discountWarning` (+ optional `discountWarningReason`) to the **Order read** schema (additive, nullable-safe). Regenerate `api.gen.go` + `schema.d.ts`; `make gen-check` clean.
- No change to `PromotionInput`/`DiscountCodeInput` (all gating fields already exist).
- The 422 rejection is an error envelope, not a schema addition.

---

## 6. Testing

1. **Pure validator** (`promo_validate_test.go`, table-driven, mirrors `loyalty_test.go`): every violation; every "empty = all" pass-through; WIB hour boundary (early-morning), day-of-week mapping, date-window inclusive boundaries.
2. **Race-safety:** focused test — two concurrent code redemptions at `usage_limit=1` yield exactly one success (the second sees the `FOR UPDATE`-locked row and the limit). Runs under `-race` in CI (Linux); local box can't `-race` (no cgo) — run plain `go test`.
3. **Live e2e** (throwaway `backend/cmd/<name>`, real `service.OrderService` against the test DB, tx rolled back / all artifacts deleted, loyalty untouched — same protocol as SP-CRM-7/8/9):
   - online order with an expired/over-limit/out-of-window/below-min code → **422**, no order written.
   - offline order with the same invalid code → order recorded at the **discounted** total, `discount_warning=true`, reason populated, `usage_count` incremented.
   - refund of a code order → `usage_count` restored (floor 0); double-refund no double-restore.
   - valid order unaffected (byte-identical pricing when all rules pass).

---

## 7. Out of scope (explicit)

- Combinability / stacking (`combinable`, `combinable_with`) → **SP-Promo-3**.
- New promo types (buy-X-get-Y general, tiered/threshold, bundles, member/time-window) → **SP-Promo-3**.
- Code→`promotion_id` linkage (a code inheriting its linked promotion's constraints) → **SP-Promo-3**.
- POS-side pre-validation UX, auto-applied visibility, savings on cart/receipt → **SP-Promo-2** (APK).
- Full reconciliation/usage analytics UI → **SP-Promo-4**.

---

## 8. Risks & mitigations

- **Hot path / money:** all changes on the checkout pricing path → Opus review; pure validator keeps logic unit-testable; "byte-identical when all rules pass" is an explicit test assertion.
- **Behavior change for online orders:** previously an inactive/missing promo silently yielded no discount; now an explicitly-sent invalid discount **rejects online**. This is the intended hardening, but it's a behavior change — called out for review and covered by e2e. (Auto-applied promos that the POS shouldn't have offered will now 422; acceptable since the POS already filters most cases and SP-Promo-2 will tighten POS-side.)
- **Neon first-write-after-idle transient** (memory): re-run warm on a flaky 400 during live verification.
- **Migration:** deploy-with-migration `0035`, pre-authorized via `autoMode.allow`.

---

## 9. Audit gaps this slice closes

Closes audit findings: usage_limit not enforced (race), usage_count not restored on refund, temporal (hours/days) not validated, outlet scoping not validated, code dates/min_purchase not validated, promo dates/min_purchase not validated. Leaves to later slices: combinability, code→promotion linkage, new types, POS UX.
