# SP-Promo-2 — POS Promo Display & Parity (Design)

**Date:** 2026-06-13
**Branch:** `prod-hardening`
**Module:** Promotion module, slice 2 of 4 (SP-Promo-1..4). SP-Promo-1 (harden engine) DONE+deployed (rev `00063-h6m`).
**Scope:** POS app (offline-first cashier) + shared validation. **= APK** (POS UI changes). No backend change expected.
**Review tier:** Sonnet implements; POS pricing/checkout/sync-adjacent + the ported validator → **Opus** (typescript-reviewer) per model-routing-policy; pure presentational tweaks → typescript-reviewer.

---

## 1. Context & problem

SP-Promo-1 made the **server** enforce all stored promo/discount rules (dates, min_purchase, active hours/days, outlets, code usage_limit). The POS UI is now **out of parity**:

- `PromoPanel.tsx` filters available promos by `isActive` + dates + `minPurchase` only — **NOT** active hours/days/outlet. A cashier can pick a promo the server now considers invalid.
- `handleApplyPromoCode` (CashierScreen) validates a typed code against dates/usage_limit/min_purchase but **silently `return`s** on failure — the cashier gets **no reason**.
- Neither path tells the cashier *why* a promo/code was rejected.

### The decisive architectural fact
**The POS submits every order through the offline-first outbox → `/sync` push, which the server processes as `Offline:true`** (confirmed: `handleConfirmPayment` uses `engine.enqueue('order', …)`; `sync.go:221` sets `Offline:true`; the SP-CRM-9c root-cause note states the same). Per SP-Promo-1's hybrid-by-origin model, `Offline:true` orders are **lenient**: the server records the sale at the rung price and sets the `discount_warning` flag — it **never 422-rejects a POS order**.

Consequence: **local POS validation is the SOLE real-time guard** against an invalid discount being applied. The server-side 422 reject path is effectively unreachable from the POS (it exists for any future/external online client). This is why "block at POS" (decided with the user) is not just nicer UX — it is the only prevention; the `discount_warning` flag is the fallback for whatever slips through (clock skew, stale promo cache).

---

## 2. Decisions (locked with user, 2026-06-13)

1. **Keep manual promo selection** (no auto-apply) — SP-Promo-2 makes the panel show only currently-valid promos as selectable and improves feedback. Auto-apply is a possible later slice.
2. **Block invalid promo/code application locally** (online OR offline), showing the same reason the server would. Prevents the bad discount so `discount_warning` stays rare.
3. **On-screen savings only** — ensure the cart + receipt-preview clearly show the discount line(s); **thermal-print formatting deferred** (its own printer task, shared with the SP-CRM-9 GRATIS-on-thermal gap).
4. **PromoPanel shows invalid promos GREYED-OUT with the reason** (not hidden) — full transparency for "why isn't my promo applying?".

---

## 3. Approach

Mirror the established **`pricing.ts` "port-of-Go"** pattern: a pure TS port of the SP-Promo-1 validator, wired into the POS touchpoints.

**Rejected alternatives:** inline checks per component (drift, untestable); server round-trip to validate (breaks offline-first — the POS must validate offline).

---

## 4. Components & data flow

### 4.1 `apps/pos/src/cashier/promoValidate.ts` (new, pure, unit-tested)
TS port of `backend/internal/service/promo_validate.go`. Single source of POS-side promo validity.

```ts
export type Violation =
  | 'not_started' | 'expired' | 'below_min_purchase'
  | 'wrong_day' | 'outside_hours' | 'wrong_outlet' | 'usage_limit_reached'

export interface PromoEvalContext { now: Date; outletId: string; subtotal: number }

export function validatePromo(p: Promotion, ctx: PromoEvalContext): Violation[]
export function validateCode(c: DiscountCode, ctx: PromoEvalContext): Violation[]
export function violationMessage(v: Violation): string  // Indonesian, panel-phrased (same intent as the backend 422 messages; not required to byte-match since the POS never receives them)
```

Rule semantics (must match the Go validator exactly):
- **dates:** `startDate ≤ saleDate ≤ endDate`, calendar-date compare in **WIB** (use a fixed UTC+7 offset so it matches the server regardless of device zone — device is in Indonesia so this is usually a no-op, but pin it).
- **min_purchase:** `subtotal ≥ minPurchase`.
- **active days (promo only):** `activeDays` contains `saleWeekday` (0=Sun..6=Sat); empty = all.
- **active hours (promo only):** `activeFromHour ≤ "HH:MM"(now,WIB) ≤ activeToHour`; **both** must be set to gate, else no constraint (mirrors Go).
- **outlet (promo only):** `outletIds` contains `ctx.outletId`; empty = all.
- **usage_limit (code only):** `usageLimit > 0 && usageCount >= usageLimit` → reached. `usageLimit == 0` or absent ⇒ unlimited (matches the backoffice `∞`).
- `violationMessage` returns: `not_started`→"Promo belum dimulai", `expired`→"Sudah kadaluarsa", `below_min_purchase`→"Belum memenuhi minimum belanja", `outside_hours`→"Tidak berlaku pada jam ini", `wrong_day`→"Tidak berlaku hari ini", `wrong_outlet`→"Tidak berlaku di outlet ini", `usage_limit_reached`→"Kuota kode diskon sudah habis".

### 4.2 `PromoPanel.tsx` — greyed-out invalid promos with reason
Render **all `isActive` promos** (drop the partial inline filter). For each, compute `validatePromo(promo, ctx)`:
- **valid (no violations):** selectable, current styling.
- **invalid:** rendered **disabled/greyed** (reduced opacity, not clickable), with the first violation's `violationMessage` shown as a small reason line (e.g. "Belum memenuhi minimum belanja"). The applied-promo highlight is unaffected.
The empty state ("Tidak ada promosi aktif") shows only when there are zero `isActive` promos at all.

### 4.3 `handleApplyPromoCode` (CashierScreen) — reason feedback + block
Replace the silent `return` chain with: find the code (by `code` + `isActive`); if not found → reason "Kode tidak ditemukan"; else run `validateCode(dc, ctx)`; if violations → set an inline error message (first `violationMessage`) and do **not** dispatch `APPLY_PROMO_CODE`; if valid → dispatch as today. The reason is surfaced via existing panel state (a new `promoCodeError` piece of local state passed to `PromoPanel`).

### 4.4 Checkout-time re-guard (light, `handleConfirmPayment`)
Before enqueuing the order, re-run validation on the applied promo (`validatePromo`) and/or applied code (`validateCode`) against the **current** cart subtotal + `now`. If it has become invalid (e.g. an hour boundary passed while the cart sat open, or a removed item dropped the subtotal below min), block the sale with the reason and clear the offending discount so the cashier can re-confirm. This is the net that keeps `discount_warning` a true rarity.

### 4.5 Savings display (on-screen)
Confirm the cart + `ReceiptPreview` discount line for a promo/code shows the **name + saved amount** (`Diskon · {name} — −{rupiah}`). `discountBreakdown` already carries this; adjust labels only if needed. No thermal change.

---

## 5. Outlet id resolution (planning detail)
The `outlet_ids` rule needs the POS's current **outlet UUID**. The engine snapshot exposes `outletCode`; planning must confirm a UUID `outletId` is available POS-side (session/snapshot/`useOutlet`). If only the code is present and no UUID is reachable, the outlet rule is scoped to server-only for v1 (the server still flags it) and that limitation is documented — decided in planning, not guessed here.

---

## 6. Testing
- `promoValidate.test.ts` (vitest, table-driven) mirroring `promo_validate_test.go`: every violation, empty=all-pass, WIB hour/day/date boundaries, `usage_limit==0`=unlimited, `violationMessage` coverage.
- A handler/reducer test: an invalid typed code sets the reason and does **not** dispatch `APPLY_PROMO_CODE`; a valid one dispatches.
- Manual/visual (USER-PENDING, needs APK): greyed promos show reasons; typed bad code shows reason; checkout re-guard blocks a cart that became ineligible; savings line shows name + amount.

---

## 7. Out of scope (explicit)
- Auto-apply best eligible promo (kept manual).
- Thermal/ESC-POS receipt savings (printer task).
- Stacking/combinability, new promo types, code→`promotion_id` linkage → **SP-Promo-3**.
- Backoffice promo authoring/UX overhaul (incl. authoring UI for `active_from_hour`/`active_to_hour`, which has no form field today) → **SP-Promo-4**.
- Backend changes — none expected (the Promotion/DiscountCode read types already carry every field the validator needs).

---

## 8. Risks & mitigations
- **Logic drift between Go and TS validators** (two copies, like pricing.go/pricing.ts): mitigate by mirroring the Go test cases 1:1 in the TS tests so both encode the same contract.
- **Device clock / timezone:** validate in a fixed WIB offset to match the server; device is in Indonesia so practical impact is minimal, but pin it rather than rely on local zone.
- **APK required:** POS UI changes mean a new APK build + on-device check (USER-PENDING) — `gh workflow run android-release.yml` is available to the agent.
- **No backend/migration:** smaller blast radius; the slice is POS-only.
