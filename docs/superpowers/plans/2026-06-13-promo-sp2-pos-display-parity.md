# SP-Promo-2 — POS Promo Display & Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the POS promo/discount-code UI into parity with the SP-Promo-1 server validator so a cashier can no longer apply a promo the server considers invalid — invalid promos are greyed-out with a reason, invalid typed codes are blocked with a reason, and a checkout-time re-guard catches a cart that became ineligible while open.

**Architecture:** A pure TypeScript port of the Go validator (`backend/internal/service/promo_validate.go`) lives in `apps/pos/src/cashier/promoValidate.ts`, unit-tested 1:1 against the Go test cases to prevent drift. It is wired into three POS touchpoints: `PromoPanel` (greyed invalid + reason), `handleApplyPromoCode` (reason feedback + block), and `handleConfirmPayment` (light re-guard). The POS always submits orders offline via the `/sync` outbox, so the server never 422-rejects a POS sale — **this local validation is the sole real-time guard**; the SP-Promo-1 `discount_warning` flag is the fallback for clock skew / stale cache. No backend or migration change.

**Tech Stack:** React 19 + TypeScript, Vitest (table-driven tests), `@mandalika/api` generated types. Offline-first cashier (Capacitor APK).

---

## Background facts the implementer needs (verified, do not re-derive)

- **Files in play (all under `apps/pos/src/`):**
  - `cashier/promoValidate.ts` — **NEW** pure validator (this plan creates it).
  - `cashier/promoValidate.test.ts` — **NEW** vitest table tests.
  - `cashier/PromoPanel.tsx` — the promo modal (presentational). Currently filters promos by `isActive` + dates + `minPurchase` only.
  - `cashier/AdjustmentDrawer.tsx` — renders `PromoPanel` (so new props pass *through* it).
  - `cashier/CashierScreen.tsx` — owns `handleApplyPromoCode` (~line 446), `handleConfirmPayment` (~line 462), local state (`isValidatingCode` at line 128), and renders `AdjustmentDrawer` (~line 821) + `Cart` (~line 799) + `ReceiptPreview` (~line 855).
  - `cashier/state/cashierReducer.ts` — `CashierState` / `CashierAction` (no change expected, read-only reference).
  - `cashier/Cart.tsx` — savings lines (~line 184–227).
  - `cashier/ReceiptPreview.tsx` — success-modal discount line (~line 134).
  - `hooks/useCart.ts` — `derived` spreads `...pricing`, so `derived.promoDiscountAmount` and `derived.subtotal` exist.

- **Outlet UUID (resolved open question):** `api.getOutletId()` returns the current outlet **UUID** (`authStore.outletId`, set at login from `user.outletId` and by `OutletSwitcher` to `outlet.id`). `api` is already imported in `CashierScreen.tsx` (used at line 251 `api.loyaltyPreview`). The promo `outletIds` field holds outlet UUIDs, so the outlet rule **is** enforceable POS-side. No server-only fallback needed.

- **Generated schema fields** (`packages/api/src/schema.d.ts`, do not edit):
  - `Promotion`: `minPurchase?: number | null`, `outletIds?: string[] | null`, `activeFromHour?: string | null`, `activeToHour?: string | null`, `activeDays?: number[] | null`, `isActive: boolean`, `startDate?: string | null`, `endDate?: string | null`, `type: "percentage" | "fixed" | "bogo"`.
  - `DiscountCode`: `code: string`, `minPurchase?: number | null`, `usageLimit?: number | null`, `usageCount: number`, `isActive: boolean`, `startDate?: string | null`, `endDate?: string | null`.
  - Dates arrive as `"YYYY-MM-DD"` strings (the existing code compares them with `new Date().toISOString().slice(0,10)`). The port defensively `.slice(0, 10)`s them in case a full ISO datetime ever appears.

- **Go validator semantics to mirror exactly** (from `promo_validate.go`):
  - dates: `not_started` if saleDate `<` startDate; `expired` if saleDate `>` endDate (inclusive window), calendar-date compare in **WIB** (fixed UTC+7).
  - `below_min_purchase`: `subtotal < minPurchase`.
  - `wrong_day` (promo only): `activeDays` non-empty and does not contain WIB weekday (0=Sun..6=Sat). Empty/absent = all days.
  - `outside_hours` (promo only): **both** `activeFromHour` and `activeToHour` set, and WIB `"HH:MM"` `<` from or `>` to. Only one set = no constraint.
  - `wrong_outlet` (promo only): `outletIds` non-empty and does not contain `ctx.outletId`. Empty/absent = all outlets.
  - `usage_limit_reached` (code only): `usageLimit != null && usageLimit > 0 && usageCount >= usageLimit`. `0`/absent = unlimited.
  - Violations are appended in the **order checked** (the Go code returns them in source order). The port preserves that order so `[0]` is the first/primary reason.

- **Test command:** `corepack pnpm --filter @mandalika/pos test` (vitest run). **Typecheck/build:** `corepack pnpm --filter @mandalika/pos build` (`tsc -b && vite build`). Run these from the repo root `C:\Users\MyBook Hype AMD\Downloads\mandalika-pos`.

- **Commit discipline:** small commits per task; never `--no-verify`; if the pre-commit hook false-positives on a chained `git commit && …`, run `git add` then `git commit` as separate commands.

---

## Task 1: Create the pure promo validator (`promoValidate.ts`) — TDD

**Files:**
- Create: `apps/pos/src/cashier/promoValidate.ts`
- Test: `apps/pos/src/cashier/promoValidate.test.ts`

- [ ] **Step 1: Write the failing test** (mirrors `promo_validate_test.go` 1:1 + `violationMessage` coverage)

Create `apps/pos/src/cashier/promoValidate.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import type { components } from '@mandalika/api'
import {
  validatePromo,
  validateCode,
  violationMessage,
  type Violation,
} from './promoValidate'

type Promotion = components['schemas']['Promotion']
type DiscountCode = components['schemas']['DiscountCode']

// 2026-06-13 14:30 WIB == 2026-06-13 07:30 UTC. Saturday (weekday 6).
// Constructed as a UTC instant so the test is deterministic on any machine zone.
const NOW = new Date('2026-06-13T07:30:00Z')
const baseCtx = { now: NOW, outletId: 'outlet-a', subtotal: 100000 }

// Minimal promo/code builders — only the gating fields matter; the rest are
// filled with valid dummies so the objects satisfy the generated types.
function promo(partial: Partial<Promotion>): Promotion {
  return {
    id: 'p1',
    name: 'P',
    type: 'fixed',
    value: 1000,
    isActive: true,
    createdAt: '2026-01-01T00:00:00Z',
    ...partial,
  }
}
function code(partial: Partial<DiscountCode>): DiscountCode {
  return {
    id: 'c1',
    code: 'X',
    type: 'fixed',
    value: 1000,
    usageCount: 0,
    isActive: true,
    createdAt: '2026-01-01T00:00:00Z',
    ...partial,
  }
}

describe('validatePromo', () => {
  const cases: { name: string; row: Partial<Promotion>; want: Violation[] }[] = [
    { name: 'all empty passes', row: {}, want: [] },
    { name: 'not started', row: { startDate: '2026-06-20' }, want: ['not_started'] },
    { name: 'expired', row: { endDate: '2026-06-01' }, want: ['expired'] },
    { name: 'date window inclusive ok', row: { startDate: '2026-06-13', endDate: '2026-06-13' }, want: [] },
    { name: 'below min', row: { minPurchase: 150000 }, want: ['below_min_purchase'] },
    { name: 'min exact ok', row: { minPurchase: 100000 }, want: [] },
    { name: 'wrong day', row: { activeDays: [1, 2, 3] }, want: ['wrong_day'] },
    { name: 'right day ok', row: { activeDays: [6] }, want: [] },
    { name: 'outside hours', row: { activeFromHour: '09:00', activeToHour: '12:00' }, want: ['outside_hours'] },
    { name: 'inside hours ok', row: { activeFromHour: '09:00', activeToHour: '17:00' }, want: [] },
    { name: 'hour boundary inclusive', row: { activeFromHour: '14:30', activeToHour: '14:30' }, want: [] },
    { name: 'only one hour set = no gate', row: { activeFromHour: '09:00' }, want: [] },
    { name: 'wrong outlet', row: { outletIds: ['outlet-b'] }, want: ['wrong_outlet'] },
    { name: 'right outlet ok', row: { outletIds: ['outlet-a', 'outlet-b'] }, want: [] },
  ]
  for (const tc of cases) {
    it(tc.name, () => {
      expect(validatePromo(promo(tc.row), baseCtx)).toEqual(tc.want)
    })
  }
})

describe('validateCode', () => {
  const cases: { name: string; row: Partial<DiscountCode>; want: Violation[] }[] = [
    { name: 'all empty passes', row: {}, want: [] },
    { name: 'expired', row: { endDate: '2026-06-01' }, want: ['expired'] },
    { name: 'below min', row: { minPurchase: 150000 }, want: ['below_min_purchase'] },
    { name: 'usage limit reached', row: { usageLimit: 2, usageCount: 2 }, want: ['usage_limit_reached'] },
    { name: 'usage under limit ok', row: { usageLimit: 2, usageCount: 1 }, want: [] },
    { name: 'usage limit zero = unlimited', row: { usageLimit: 0, usageCount: 99 }, want: [] },
    { name: 'nil limit = unlimited', row: { usageCount: 99 }, want: [] },
  ]
  for (const tc of cases) {
    it(tc.name, () => {
      expect(validateCode(code(tc.row), baseCtx)).toEqual(tc.want)
    })
  }
})

describe('violationMessage', () => {
  const all: Violation[] = [
    'not_started', 'expired', 'below_min_purchase',
    'wrong_day', 'outside_hours', 'wrong_outlet', 'usage_limit_reached',
  ]
  it('returns a non-empty Indonesian string for every violation', () => {
    for (const v of all) {
      expect(violationMessage(v).length).toBeGreaterThan(0)
    }
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `corepack pnpm --filter @mandalika/pos test`
Expected: FAIL — `promoValidate.ts` does not exist / exports unresolved.

- [ ] **Step 3: Write the implementation**

Create `apps/pos/src/cashier/promoValidate.ts`:

```ts
/**
 * POS-side promo/discount-code validator — a pure TS port of
 * backend/internal/service/promo_validate.go (SP-Promo-1). Kept in lockstep
 * with promo_validate_test.go via promoValidate.test.ts to prevent Go/TS drift.
 *
 * The POS submits every order offline through the /sync outbox, which the server
 * processes leniently (records + flags, never 422). So this is the SOLE real-time
 * guard against an invalid discount being applied at the POS.
 */

import type { components } from '@mandalika/api'

type Promotion = components['schemas']['Promotion']
type DiscountCode = components['schemas']['DiscountCode']

export type Violation =
  | 'not_started'
  | 'expired'
  | 'below_min_purchase'
  | 'wrong_day'
  | 'outside_hours'
  | 'wrong_outlet'
  | 'usage_limit_reached'

export interface PromoEvalContext {
  now: Date
  outletId: string
  subtotal: number
}

// Fixed WIB offset (UTC+7, no DST) so validation matches the server regardless
// of the device's local zone. Mirrors the Go validator's fixed `wib` zone.
const WIB_OFFSET_MIN = 7 * 60

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`
}

// Wall-clock parts of `now` in WIB. We shift the UTC epoch by +7h then read the
// UTC getters, which yields the WIB calendar date / weekday / HH:MM.
function wibParts(now: Date): { dateStr: string; weekday: number; hhmm: string } {
  const w = new Date(now.getTime() + WIB_OFFSET_MIN * 60_000)
  const dateStr = `${w.getUTCFullYear()}-${pad2(w.getUTCMonth() + 1)}-${pad2(w.getUTCDate())}`
  return { dateStr, weekday: w.getUTCDay(), hhmm: `${pad2(w.getUTCHours())}:${pad2(w.getUTCMinutes())}` }
}

// Normalize an API date that may be "YYYY-MM-DD" or a full ISO datetime to a
// calendar-date string for lexicographic (== calendar) comparison.
function dateOnly(s: string): string {
  return s.slice(0, 10)
}

export function validatePromo(p: Promotion, ctx: PromoEvalContext): Violation[] {
  const v: Violation[] = []
  const { dateStr, weekday, hhmm } = wibParts(ctx.now)

  if (p.startDate && dateStr < dateOnly(p.startDate)) v.push('not_started')
  if (p.endDate && dateStr > dateOnly(p.endDate)) v.push('expired')
  if (p.minPurchase != null && ctx.subtotal < p.minPurchase) v.push('below_min_purchase')
  if (p.activeDays && p.activeDays.length > 0 && !p.activeDays.includes(weekday)) v.push('wrong_day')
  // Both bounds required to gate; a half-set window is treated as no constraint.
  if (p.activeFromHour && p.activeToHour) {
    if (hhmm < p.activeFromHour || hhmm > p.activeToHour) v.push('outside_hours')
  }
  if (p.outletIds && p.outletIds.length > 0 && !p.outletIds.includes(ctx.outletId)) v.push('wrong_outlet')
  return v
}

export function validateCode(c: DiscountCode, ctx: PromoEvalContext): Violation[] {
  const v: Violation[] = []
  const { dateStr } = wibParts(ctx.now)

  if (c.startDate && dateStr < dateOnly(c.startDate)) v.push('not_started')
  if (c.endDate && dateStr > dateOnly(c.endDate)) v.push('expired')
  if (c.minPurchase != null && ctx.subtotal < c.minPurchase) v.push('below_min_purchase')
  // usage_limit of 0 (or absent) means UNLIMITED — only enforce a positive cap.
  if (c.usageLimit != null && c.usageLimit > 0 && c.usageCount >= c.usageLimit) {
    v.push('usage_limit_reached')
  }
  return v
}

const MESSAGES: Record<Violation, string> = {
  not_started: 'Promo belum dimulai',
  expired: 'Sudah kadaluarsa',
  below_min_purchase: 'Belum memenuhi minimum belanja',
  outside_hours: 'Tidak berlaku pada jam ini',
  wrong_day: 'Tidak berlaku hari ini',
  wrong_outlet: 'Tidak berlaku di outlet ini',
  usage_limit_reached: 'Kuota kode diskon sudah habis',
}

export function violationMessage(v: Violation): string {
  return MESSAGES[v]
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `corepack pnpm --filter @mandalika/pos test`
Expected: PASS — all `validatePromo`, `validateCode`, and `violationMessage` cases green.

- [ ] **Step 5: Commit**

```bash
git add apps/pos/src/cashier/promoValidate.ts apps/pos/src/cashier/promoValidate.test.ts
git commit -m "feat(promo): POS promo validator port + 1:1 tests (SP-Promo-2)"
```

---

## Task 2: PromoPanel — render all active promos, grey out invalid ones with a reason

**Files:**
- Modify: `apps/pos/src/cashier/PromoPanel.tsx`
- Modify: `apps/pos/src/cashier/AdjustmentDrawer.tsx` (thread a new `outletId` prop)
- Modify: `apps/pos/src/cashier/CashierScreen.tsx` (pass `outletId={api.getOutletId() ?? ''}` to `AdjustmentDrawer`)

- [ ] **Step 1: Add `outletId` to AdjustmentDrawer props and forward to PromoPanel**

In `apps/pos/src/cashier/AdjustmentDrawer.tsx`, add `outletId` to the props interface and destructure, then pass it to `<PromoPanel>`.

Interface (after `subtotal: number`):
```tsx
  subtotal: number
  outletId: string
  isValidatingCode: boolean
```
Destructure (after `subtotal,`):
```tsx
  subtotal,
  outletId,
  isValidatingCode,
```
In the `<PromoPanel … />` JSX, add the prop (after `subtotal={subtotal}`):
```tsx
      subtotal={subtotal}
      outletId={outletId}
```

- [ ] **Step 2: Pass `outletId` from CashierScreen**

In `apps/pos/src/cashier/CashierScreen.tsx`, find the `<AdjustmentDrawer … />` render (~line 821). Add the `outletId` prop next to `subtotal`:

```tsx
        subtotal={derived.subtotal} outletId={api.getOutletId() ?? ''} isValidatingCode={isValidatingCode}
```

(`api` is already imported and used in this file.)

- [ ] **Step 3: Rewrite PromoPanel's promo list to grey out invalid promos**

In `apps/pos/src/cashier/PromoPanel.tsx`:

(a) Add the import near the top:
```tsx
import { validatePromo, violationMessage } from './promoValidate'
```

(b) Add `outletId: string` to `PromoPanelProps` (after `subtotal: number`) and to the destructured params (after `subtotal,`).

(c) Replace the `activePromos` filter (lines ~37–44) with a derivation that keeps **all** active promos and computes their violations:

```tsx
  const now = new Date()
  const evalCtx = { now, outletId, subtotal }
  const activePromos = promotions
    .filter((p) => p.isActive)
    .map((promo) => ({ promo, violations: validatePromo(promo, evalCtx) }))
```

(d) Replace the "Available promotions" block (lines ~135–179) so each promo renders selectable when valid, or disabled/greyed with the first violation's reason when invalid. The empty state keys off `activePromos.length`:

```tsx
          {/* Available promotions */}
          {activePromos.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-gray-700 mb-2">
                Promosi Aktif
              </p>
              <div className="space-y-2">
                {activePromos.map(({ promo, violations }) => {
                  const invalid = violations.length > 0
                  const isApplied = appliedPromotion?.id === promo.id
                  return (
                    <button
                      key={promo.id}
                      onClick={() => !invalid && onSelectPromotion(promo)}
                      disabled={invalid}
                      className={`w-full text-left p-3 rounded-xl border transition-all ${
                        invalid
                          ? 'border-gray-200 bg-gray-50 opacity-50 cursor-not-allowed'
                          : isApplied
                            ? 'border-green-400 bg-green-50'
                            : 'border-gray-200 hover:border-indigo-300 hover:bg-indigo-50'
                      }`}
                    >
                      <p className="text-xs font-bold text-gray-800">
                        {promo.name}
                      </p>
                      {promo.description && (
                        <p className="text-[10px] text-gray-500 mt-0.5">
                          {promo.description}
                        </p>
                      )}
                      <p className="text-[10px] text-indigo-600 mt-1">
                        {promo.type === 'percentage'
                          ? `Diskon ${promo.value}%`
                          : promo.type === 'fixed'
                            ? `Potongan ${formatRupiah(promo.value)}`
                            : 'BOGO'}
                        {promo.minPurchase
                          ? ` · Min. ${formatRupiah(promo.minPurchase)}`
                          : ''}
                      </p>
                      {invalid && (
                        <p className="text-[10px] text-red-500 mt-1 font-semibold">
                          {violationMessage(violations[0])}
                        </p>
                      )}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {activePromos.length === 0 && (
            <p className="text-xs text-gray-400 text-center py-4">
              Tidak ada promosi aktif
            </p>
          )}
```

- [ ] **Step 4: Typecheck + build**

Run: `corepack pnpm --filter @mandalika/pos build`
Expected: PASS — `tsc -b` clean, `vite build` succeeds. (If `tsc` flags `outletId` missing on `AdjustmentDrawer`/`PromoPanel`, the prop wasn't threaded through all three files — fix and re-run.)

- [ ] **Step 5: Commit**

```bash
git add apps/pos/src/cashier/PromoPanel.tsx apps/pos/src/cashier/AdjustmentDrawer.tsx apps/pos/src/cashier/CashierScreen.tsx
git commit -m "feat(promo): grey out invalid promos with reason in PromoPanel (SP-Promo-2)"
```

---

## Task 3: handleApplyPromoCode — block invalid typed codes with a reason

**Files:**
- Modify: `apps/pos/src/cashier/CashierScreen.tsx` (add `promoCodeError` state; rewrite `handleApplyPromoCode`; pass error + clearer through AdjustmentDrawer)
- Modify: `apps/pos/src/cashier/AdjustmentDrawer.tsx` (thread `promoCodeError` + `onClearPromoCodeError` to PromoPanel)
- Modify: `apps/pos/src/cashier/PromoPanel.tsx` (render the error; clear it on input change)
- Test: `apps/pos/src/cashier/promoValidate.test.ts` is unit-only; add a small reducer-free unit test for the apply decision in a new `apps/pos/src/cashier/applyPromoCode.test.ts`

**Note on testability:** `handleApplyPromoCode` is an inline closure over component state, awkward to unit-test directly. Extract its pure decision into a tiny helper `decideApplyCode` in `promoValidate.ts`, unit-test that, and have the handler call it. This keeps the "block vs dispatch" logic covered by tests (spec §6 asks for it) without rendering the component.

- [ ] **Step 1: Write the failing test for the apply-decision helper**

Create `apps/pos/src/cashier/applyPromoCode.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import type { components } from '@mandalika/api'
import { decideApplyCode } from './promoValidate'

type DiscountCode = components['schemas']['DiscountCode']

const NOW = new Date('2026-06-13T07:30:00Z') // 14:30 WIB Sat
const ctx = { now: NOW, outletId: 'outlet-a', subtotal: 100000 }

function code(partial: Partial<DiscountCode>): DiscountCode {
  return {
    id: 'c1', code: 'SAVE', type: 'fixed', value: 1000,
    usageCount: 0, isActive: true, createdAt: '2026-01-01T00:00:00Z',
    ...partial,
  }
}

describe('decideApplyCode', () => {
  it('rejects an unknown code with a not-found reason', () => {
    const r = decideApplyCode('NOPE', [code({ code: 'SAVE' })], ctx)
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('Kode tidak ditemukan')
  })

  it('rejects an inactive code as not found', () => {
    const r = decideApplyCode('SAVE', [code({ code: 'SAVE', isActive: false })], ctx)
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('Kode tidak ditemukan')
  })

  it('rejects a valid-but-ineligible code with the violation reason', () => {
    const r = decideApplyCode('SAVE', [code({ code: 'SAVE', minPurchase: 150000 })], ctx)
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('Belum memenuhi minimum belanja')
  })

  it('accepts an eligible code (case-insensitive match)', () => {
    const r = decideApplyCode('save', [code({ code: 'SAVE', value: 5000 })], ctx)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.code).toEqual({ code: 'SAVE', value: 5000, type: 'fixed' })
    }
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `corepack pnpm --filter @mandalika/pos test`
Expected: FAIL — `decideApplyCode` not exported.

- [ ] **Step 3: Add `decideApplyCode` to `promoValidate.ts`**

Append to `apps/pos/src/cashier/promoValidate.ts`:

```ts
export interface AppliedPromoCode {
  code: string
  value: number
  type: 'percentage' | 'fixed'
}

export type ApplyCodeDecision =
  | { ok: true; code: AppliedPromoCode }
  | { ok: false; reason: string }

// Pure decision for applying a typed promo code: find an active code by name
// (case-insensitive), validate it, and either return the payload to dispatch or
// a human reason to show. The handler stays a thin wrapper around this.
export function decideApplyCode(
  typed: string,
  codes: DiscountCode[],
  ctx: PromoEvalContext,
): ApplyCodeDecision {
  const upper = typed.trim().toUpperCase()
  const dc = codes.find((d) => d.code.toUpperCase() === upper && d.isActive)
  if (!dc) return { ok: false, reason: 'Kode tidak ditemukan' }
  const violations = validateCode(dc, ctx)
  if (violations.length > 0) return { ok: false, reason: violationMessage(violations[0]) }
  return { ok: true, code: { code: dc.code, value: dc.value, type: dc.type } }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `corepack pnpm --filter @mandalika/pos test`
Expected: PASS — all `decideApplyCode` cases green.

- [ ] **Step 5: Add `promoCodeError` state and rewrite the handler in CashierScreen**

In `apps/pos/src/cashier/CashierScreen.tsx`:

(a) Add the import (alongside other `./cashier`-local imports near the top of the file):
```tsx
import { decideApplyCode } from './promoValidate'
```

(b) Add local state next to `isValidatingCode` (line 128):
```tsx
  const [isValidatingCode, setIsValidatingCode] = useState(false)
  const [promoCodeError, setPromoCodeError] = useState<string | null>(null)
```

(c) Replace the body of `handleApplyPromoCode` (~lines 446–460) with:
```tsx
  const handleApplyPromoCode = async () => {
    const code = state.promoCodeInput.trim().toUpperCase()
    if (!code) return
    setIsValidatingCode(true)
    try {
      const decision = decideApplyCode(
        code,
        discountCodes,
        { now: new Date(), outletId: api.getOutletId() ?? '', subtotal: derived.subtotal },
      )
      if (!decision.ok) {
        setPromoCodeError(decision.reason)
        return
      }
      setPromoCodeError(null)
      dispatch({ type: 'APPLY_PROMO_CODE', code: decision.code })
    } finally {
      setIsValidatingCode(false)
    }
  }
```

- [ ] **Step 6: Thread `promoCodeError` + clearer through AdjustmentDrawer**

In `apps/pos/src/cashier/CashierScreen.tsx`, update the `<AdjustmentDrawer … />` props to pass the error and a clearer:
```tsx
        promoCodeError={promoCodeError}
        onClearPromoCodeError={() => setPromoCodeError(null)}
```

In `apps/pos/src/cashier/AdjustmentDrawer.tsx`:
- Add to the props interface:
```tsx
  promoCodeError: string | null
  onClearPromoCodeError: () => void
```
- Add to the destructure:
```tsx
  promoCodeError,
  onClearPromoCodeError,
```
- Pass to `<PromoPanel … />`:
```tsx
      promoCodeError={promoCodeError}
      onClearPromoCodeError={onClearPromoCodeError}
```

- [ ] **Step 7: Render the error in PromoPanel and clear it on input change**

In `apps/pos/src/cashier/PromoPanel.tsx`:
- Add to `PromoPanelProps`:
```tsx
  promoCodeError: string | null
  onClearPromoCodeError: () => void
```
- Add to the destructured params: `promoCodeError,` and `onClearPromoCodeError,`.
- In the code `<input>`'s `onChange` (line ~91), clear the error as the cashier edits:
```tsx
                onChange={(e) => {
                  onClearPromoCodeError()
                  onPromoCodeChange(e.target.value.toUpperCase())
                }}
```
- Directly below the input+button `<div className="flex gap-2">…</div>` (after line ~105, before the prefix-hint block), render the error:
```tsx
            {promoCodeError && (
              <p className="text-[10px] text-red-500 mt-1 font-semibold">
                {promoCodeError}
              </p>
            )}
```

- [ ] **Step 8: Typecheck + build**

Run: `corepack pnpm --filter @mandalika/pos build`
Expected: PASS — `tsc -b` clean, `vite build` succeeds.

- [ ] **Step 9: Commit**

```bash
git add apps/pos/src/cashier/promoValidate.ts apps/pos/src/cashier/applyPromoCode.test.ts apps/pos/src/cashier/CashierScreen.tsx apps/pos/src/cashier/AdjustmentDrawer.tsx apps/pos/src/cashier/PromoPanel.tsx
git commit -m "feat(promo): block invalid promo codes with reason at POS (SP-Promo-2)"
```

---

## Task 4: Checkout-time re-guard in handleConfirmPayment

**Files:**
- Modify: `apps/pos/src/cashier/CashierScreen.tsx` (`handleConfirmPayment`, ~line 462)

**Why:** A cart can sit open past an hour/day boundary, or lose items so the subtotal drops below `minPurchase`, making an already-applied promo/code invalid. Re-validate at confirm and block + clear the offending discount so `discount_warning` stays rare. `state.appliedPromoCode` only holds `{code,value,type}`, so re-look-up the full `DiscountCode` from `discountCodes` by code.

- [ ] **Step 1: Add the re-guard at the top of `handleConfirmPayment`**

In `apps/pos/src/cashier/CashierScreen.tsx`, insert the guard immediately after the `if (state.isProcessing) return` line and **before** `dispatch({ type: 'SET_PROCESSING', processing: true })`:

```tsx
  const handleConfirmPayment = () => {
    if (state.isProcessing) return

    // Re-guard: a promo/code valid when picked can lapse while the cart sits open
    // (hour/day boundary) or fall below min_purchase (items removed). Block + clear
    // the offending discount so the cashier re-confirms a clean total. This keeps
    // the server-side discount_warning flag a true rarity.
    const guardCtx = {
      now: new Date(),
      outletId: api.getOutletId() ?? '',
      subtotal: derived.subtotal,
    }
    if (state.appliedPromotion) {
      const vs = validatePromo(state.appliedPromotion, guardCtx)
      if (vs.length > 0) {
        setToast(`Promo dibatalkan: ${violationMessage(vs[0])}`)
        dispatch({ type: 'CLEAR_PROMOTIONS' })
        return
      }
    }
    if (state.appliedPromoCode) {
      const dc = discountCodes.find(
        (d) => d.code.toUpperCase() === state.appliedPromoCode!.code.toUpperCase() && d.isActive,
      )
      if (!dc) {
        setToast('Kode diskon dibatalkan: Kode tidak ditemukan')
        dispatch({ type: 'CLEAR_PROMOTIONS' })
        return
      }
      const vs = validateCode(dc, guardCtx)
      if (vs.length > 0) {
        setToast(`Kode diskon dibatalkan: ${violationMessage(vs[0])}`)
        dispatch({ type: 'CLEAR_PROMOTIONS' })
        return
      }
    }

    dispatch({ type: 'SET_PROCESSING', processing: true })
```

(Leave the rest of `handleConfirmPayment` unchanged. The early `return`s happen before `SET_PROCESSING`, so no processing flag needs resetting.)

- [ ] **Step 2: Add the imports**

Ensure `apps/pos/src/cashier/CashierScreen.tsx` imports the two validators (extend the Task 3 import line):

```tsx
import { decideApplyCode, validatePromo, validateCode, violationMessage } from './promoValidate'
```

- [ ] **Step 3: Typecheck + build**

Run: `corepack pnpm --filter @mandalika/pos build`
Expected: PASS. (`setToast` and `dispatch` are already in scope; `CLEAR_PROMOTIONS` is an existing action that resets `appliedPromotion`, `appliedPromoCode`, and `promoCodeInput`.)

- [ ] **Step 4: Commit**

```bash
git add apps/pos/src/cashier/CashierScreen.tsx
git commit -m "feat(promo): checkout-time re-guard clears lapsed promo/code (SP-Promo-2)"
```

---

## Task 5: On-screen savings display (cart + receipt-preview show name + amount)

**Files:**
- Modify: `apps/pos/src/cashier/Cart.tsx` (show the promo's saved amount on the "Promo:" line)
- Modify: `apps/pos/src/cashier/CashierScreen.tsx` (pass `promoLabel` to ReceiptPreview)
- Modify: `apps/pos/src/cashier/ReceiptPreview.tsx` (show the promo name beside the discount line)

**Why:** Decision §3/§4.5 — the cart already shows a "Promo: {label}" line but not its own saved amount, and the success ReceiptPreview shows only a combined "Diskon" line with no promo name. Surface name + amount on both. Thermal print is out of scope.

- [ ] **Step 1: Cart — append the promo's saved amount to the "Promo:" line**

In `apps/pos/src/cashier/Cart.tsx`, the applied-promo line (~lines 191–204) currently renders `Promo: {appliedPromoLabel}`. Add the promo's nominal from `derived.promoDiscountAmount` when positive:

```tsx
          {appliedPromoLabel && (
            <div className="flex justify-between items-center text-green-600">
              <span className="flex items-center gap-1">
                Promo: {appliedPromoLabel}
                {derived.promoDiscountAmount > 0
                  ? ` — −${formatRupiah(derived.promoDiscountAmount)}`
                  : ''}
                <button
                  onClick={onClearPromo}
                  className="w-4 h-4 rounded-full bg-green-100 text-green-700 text-[10px] leading-none hover:bg-green-200"
                  title="Hapus promo"
                >
                  ×
                </button>
              </span>
            </div>
          )}
```

(`derived` is already a Cart prop and carries `promoDiscountAmount`.)

- [ ] **Step 2: Pass `promoLabel` to ReceiptPreview**

In `apps/pos/src/cashier/CashierScreen.tsx`, the `<ReceiptPreview … />` render (~line 855) currently passes `discountAmount`/`taxAmount` but no promo name. Add:

```tsx
        promoLabel={state.appliedPromotion?.name ?? state.appliedPromoCode?.code ?? null}
```

- [ ] **Step 3: ReceiptPreview — render the promo name on the discount line**

In `apps/pos/src/cashier/ReceiptPreview.tsx`:
- Add to the props interface (near `discountAmount: number`):
```tsx
  promoLabel?: string | null
```
- Add `promoLabel,` to the destructured params (near `discountAmount,`).
- Update the discount line (~lines 134–138) to include the label when present:
```tsx
            {discountAmount > 0 && (
              <div className="flex justify-between">
                <span>{promoLabel ? `Diskon · ${promoLabel}` : 'Diskon'}</span>
                <span>−{formatRupiah(discountAmount)}</span>
              </div>
            )}
```

- [ ] **Step 4: Typecheck + build**

Run: `corepack pnpm --filter @mandalika/pos build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/pos/src/cashier/Cart.tsx apps/pos/src/cashier/CashierScreen.tsx apps/pos/src/cashier/ReceiptPreview.tsx
git commit -m "feat(promo): show promo name + saved amount on cart and receipt preview (SP-Promo-2)"
```

---

## Task 6: Full local gate + APK build (USER-PENDING on-device)

**Files:** none (verification + release).

- [ ] **Step 1: Full POS gate green**

Run both, expect PASS:
```bash
corepack pnpm --filter @mandalika/pos test
corepack pnpm --filter @mandalika/pos build
```
Expected: vitest all green (promoValidate + applyPromoCode + the pre-existing stock/scan suites); `tsc -b` clean; `vite build` succeeds.

- [ ] **Step 2: Confirm no backend drift (sanity — this slice touches no Go/OpenAPI)**

`git status` should show only `apps/pos/src/cashier/*` and the plan/spec docs. If any `backend/` or `packages/api/` file changed, that's out of scope for SP-Promo-2 — investigate before continuing.

- [ ] **Step 3: Trigger the APK build**

The agent has `gh` (full path `C:\Program Files\GitHub CLI\gh.exe`). Build a signed APK carrying the POS changes:
```bash
"/c/Program Files/GitHub CLI/gh.exe" workflow run android-release.yml --ref prod-hardening -f api_url=<cloudrun-url>
```
(Use the same Cloud Run URL the prior APKs used; confirm with the user if unsure.) Watch the run to green.

- [ ] **Step 4: Hand off the on-device checklist (USER-PENDING)**

Report to the user that the following need an on-device check after installing the new APK:
1. Open the Promo panel with a cart below a promo's `minPurchase` → that promo is **greyed-out** with "Belum memenuhi minimum belanja"; raise the cart above it → it becomes selectable.
2. A promo restricted by day/hour/outlet shows the right greyed reason when out of window.
3. Type a code that's expired / over usage limit / below min → an inline red reason appears and the code is **not** applied; type a valid code → it applies.
4. Apply a promo, then remove items so the subtotal drops below its min, then press Bayar → a toast says the promo was cancelled and the discount clears (re-confirm completes a clean sale).
5. Cart shows `Promo: {name} — −Rp…`; the success receipt-preview shows `Diskon · {name} −Rp…`.

---

## Self-Review

**Spec coverage:**
- §4.1 pure `promoValidate.ts` (validatePromo/validateCode/violationMessage) → Task 1. ✅
- §4.2 PromoPanel greyed-out invalid + reason → Task 2. ✅
- §4.3 handleApplyPromoCode reason feedback + block → Task 3. ✅
- §4.4 checkout-time re-guard → Task 4. ✅
- §4.5 savings display (cart + receipt-preview, name + amount) → Task 5. ✅
- §5 outlet UUID resolution → **resolved**: `api.getOutletId()` returns the outlet UUID; outlet rule enforced POS-side (no server-only fallback). Wired in Tasks 2–4. ✅
- §6 tests: 1:1 validator table tests (Task 1) + apply-decision test (Task 3) + manual/visual checklist (Task 6). ✅
- §6 WIB boundary / `usage_limit==0` / empty=all-pass cases → covered in Task 1 test table. ✅
- §7 out-of-scope (auto-apply, thermal, stacking/new-types, backoffice UX, backend) → none touched. ✅

**Placeholder scan:** No TBD/TODO; every code step shows full content; commands have expected output. ✅

**Type consistency:** `Violation`, `PromoEvalContext { now, outletId, subtotal }`, `validatePromo`, `validateCode`, `violationMessage`, `decideApplyCode`, `ApplyCodeDecision`, `AppliedPromoCode` are defined in Task 1/3 and used identically in Tasks 2–5. `outletId` prop name consistent across CashierScreen → AdjustmentDrawer → PromoPanel. `promoCodeError`/`onClearPromoCodeError` consistent across the same chain. `promoLabel` consistent CashierScreen → ReceiptPreview. ✅

**Risk note (flag uncertainty):** Promo date strings are assumed `"YYYY-MM-DD"`; the port `.slice(0,10)`s defensively so a full ISO datetime also works. If `tsc` reports the generated `Promotion`/`DiscountCode` shapes differ from the fields listed here, stop and reconcile against `packages/api/src/schema.d.ts` rather than casting.
