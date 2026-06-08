# SP-CRM-5b — POS Segment Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the customer's segment (instead of the old spend-tier) in the POS cashier picker, retire `getCustomerTier`, and remove the orphaned backoffice "Sistem Tier" toggle.

**Architecture:** Pure frontend + POS. The segment (`customer.segment` = `{id,name,color}|null`) is already on the POS-facing reads from SP-CRM-5a, so there is NO backend/migration/OpenAPI/client change. The POS picker renders a small colored segment chip (decoupled from `loyaltyEnabled`; points stays gated by it); the backoffice drops the now-dead "Sistem Tier" toggle. POS changes reach devices via an APK.

**Tech Stack:** React + TS (Vite) — POS app + backoffice app. Shared `@mandalika/api` types (already have `Customer.segment`).

**Spec:** `docs/superpowers/specs/2026-06-08-crm-sp5b-pos-segment-display-design.md`

---

## Testing posture (read first)
- No test runner in either app → verification is `tsc -b` + `vite build` + an **on-device APK check**.
- **No backend work** — no `go` gates, no `make gen-check`, no deploy, no migration.
- **Commits:** `git add <paths>` then `git commit` SEPARATELY (chained `&&` trips the hook). Never `--no-verify`. Conventional commits.
- The POS change only reaches devices via an **APK** (user-gated dispatch).

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `apps/pos/src/cashier/segmentColors.ts` | palette token → chip classes (POS-local) | Create |
| `apps/pos/src/cashier/CustomerPicker.tsx` | show `customer.segment` chip; drop getCustomerTier | Modify |
| `apps/pos/src/cashier/pricing.ts` | remove `getCustomerTier` | Modify |
| `apps/backoffice/src/screens/Customers.tsx` | remove "Sistem Tier" toggle + status mention | Modify |

---

## Phase A — POS (reaches devices via APK)

### Task A1: POS segment chip in the cashier picker

**Files:**
- Create: `apps/pos/src/cashier/segmentColors.ts`
- Modify: `apps/pos/src/cashier/CustomerPicker.tsx`, `apps/pos/src/cashier/pricing.ts`

- [ ] **Step 1: Create the POS color map**

`apps/pos/src/cashier/segmentColors.ts`:
```ts
// POS-local segment palette → chip classes. Mirrors the backoffice tagColors
// tokens (the backend validates exactly these 8). The apps don't share a UI lib.
const CLASSES: Record<string, string> = {
  amber: 'bg-amber-100 text-amber-800',
  blue: 'bg-blue-100 text-blue-800',
  green: 'bg-green-100 text-green-800',
  red: 'bg-red-100 text-red-800',
  purple: 'bg-purple-100 text-purple-800',
  gray: 'bg-gray-100 text-gray-700',
  pink: 'bg-pink-100 text-pink-800',
  teal: 'bg-teal-100 text-teal-800',
}

/** Chip classes for a segment color token; falls back to gray. */
export function segmentChipClasses(color: string): string {
  return CLASSES[color] ?? CLASSES.gray
}
```

- [ ] **Step 2: Confirm `getCustomerTier` has no importer besides CustomerPicker**

Run: `grep -rn "getCustomerTier" apps/pos/src`
Expected: only `CustomerPicker.tsx` (import + 2 usages) and `pricing.ts` (the definition). If anything else imports it, stop and report.

- [ ] **Step 3: Selected-customer line — show the segment chip, decoupled from loyalty**

In `apps/pos/src/cashier/CustomerPicker.tsx`, replace the selected-customer detail `<p>` (lines 85-95):
```tsx
            <p className="text-[10px] text-indigo-600">
              {selectedCustomer.phone}
              {loyaltyEnabled && (
                <>
                  {' · '}
                  {getCustomerTier(selectedCustomer.totalSpent)}
                  {' · '}
                  {selectedCustomer.points} poin
                </>
              )}
            </p>
```
with:
```tsx
            <p className="text-[10px] text-indigo-600 flex items-center gap-1 flex-wrap">
              <span>{selectedCustomer.phone}</span>
              {selectedCustomer.segment && (
                <span className={`px-1.5 py-0.5 rounded-full text-[9px] font-bold ${segmentChipClasses(selectedCustomer.segment.color)}`}>
                  {selectedCustomer.segment.name}
                </span>
              )}
              {loyaltyEnabled && <span>· {selectedCustomer.points} poin</span>}
            </p>
```

- [ ] **Step 4: Dropdown rows — show the segment chip**

In the dropdown result rows, replace the second `<p>` (around line 203-206):
```tsx
                  <p className="text-[10px] text-gray-500">
                    {c.phone}
                    {loyaltyEnabled && ` · ${getCustomerTier(c.totalSpent)}`}
                  </p>
```
with:
```tsx
                  <p className="text-[10px] text-gray-500 flex items-center gap-1">
                    <span>{c.phone}</span>
                    {c.segment && (
                      <span className={`px-1 py-0.5 rounded-full text-[9px] font-bold ${segmentChipClasses(c.segment.color)}`}>
                        {c.segment.name}
                      </span>
                    )}
                  </p>
```
(Match the actual surrounding JSX/indentation when editing.)

- [ ] **Step 5: Swap the import**

Change `CustomerPicker.tsx:3`:
```tsx
import { getCustomerTier } from './pricing'
```
to:
```tsx
import { segmentChipClasses } from './segmentColors'
```

- [ ] **Step 6: Remove `getCustomerTier` from pricing.ts**

Delete the function (`apps/pos/src/cashier/pricing.ts:166-171`):
```ts
export function getCustomerTier(spent: number): string {
  if (spent >= 5_000_000) return 'Platinum'
  if (spent >= 2_000_000) return 'Gold'
  if (spent >= 500_000) return 'Silver'
  return 'Member'
}
```

- [ ] **Step 7: Typecheck + build**

Run: `cd apps/pos && npx tsc -b && npx vite build`
Expected: both succeed. (`Customer` from `@mandalika/api` has `segment?: {id,name,color}|null` from 5a, so `selectedCustomer.segment`/`c.segment` typecheck.) Fix any leftover `getCustomerTier` reference.

- [ ] **Step 8: Commit**

```bash
git add apps/pos/src/cashier/segmentColors.ts apps/pos/src/cashier/CustomerPicker.tsx apps/pos/src/cashier/pricing.ts
git commit -m "feat(pos): cashier picker shows customer segment chip (retires getCustomerTier)"
```

---

## Phase B — Backoffice (push/Cloudflare, no APK)

### Task B1: Remove the orphaned "Sistem Tier" toggle

**Files:** Modify `apps/backoffice/src/screens/Customers.tsx`

- [ ] **Step 1: Remove the toggle block**

Delete the "Sistem Tier" toggle block (`Customers.tsx:292-300`):
```tsx
              <div className="flex items-center justify-between py-3 border-b border-gray-100">
                <div>
                  <p className="font-bold text-gray-900 text-sm">Sistem Tier</p>
                  <p className="text-xs text-gray-400">Member / Silver / Gold / Platinum</p>
                </div>
                <button onClick={() => setLoyaltyForm((f) => ({ ...f, tierEnabled: !f.tierEnabled }))}>
                  {loyaltyForm.tierEnabled ? <ToggleRight className="w-7 h-7 text-gold-600" /> : <ToggleLeft className="w-7 h-7 text-gray-400" />}
                </button>
              </div>
```
(Leave the `loyaltyForm.tierEnabled` field + `DEFAULT_LOYALTY.tierEnabled` intact — the save still sends it; it's a harmless vestigial. Do NOT touch the points `enabled` toggle, `pointsPerThousand`, `redemptionRate`, or the Kondisi UI.)

- [ ] **Step 2: Drop the tier mention from the status line**

Change `Customers.tsx:317`:
```tsx
              <p className="text-xs text-gray-400">Nilai aktif: {loyalty.enabled ? 'poin ON' : 'poin OFF'} · tier {loyalty.tierEnabled ? 'ON' : 'OFF'}</p>
```
to:
```tsx
              <p className="text-xs text-gray-400">Nilai aktif: {loyalty.enabled ? 'poin ON' : 'poin OFF'}</p>
```

- [ ] **Step 3: Check for now-unused imports**

After removing the toggle, `ToggleRight`/`ToggleLeft` may still be used by the points `enabled` toggle (they are — that toggle uses the same icons). Confirm with: `grep -n "ToggleRight\|ToggleLeft" apps/backoffice/src/screens/Customers.tsx` — if still referenced, keep the imports; if not, remove them. (Expected: still used by the Sistem Poin toggle → keep.)

- [ ] **Step 4: Typecheck + build**

Run: `cd apps/backoffice && npx tsc -b && npx vite build`
Expected: both succeed.

- [ ] **Step 5: Commit**

```bash
git add apps/backoffice/src/screens/Customers.tsx
git commit -m "feat(backoffice): remove orphaned Sistem Tier toggle (segments replaced tiers)"
```

---

## Phase C — Verification + APK + rollout

### Task C1: Build gates, push, APK, on-device

**Files:** none

- [ ] **Step 1: Full build gate (both apps)**

```bash
cd apps/pos && npx tsc -b && npx vite build
cd ../backoffice && npx tsc -b && npx vite build
```
Expected: both green (only the pre-existing chunk-size advisory). No backend/go gates this sprint.

- [ ] **Step 2: Push**

```bash
git push origin prod-hardening
```
Cloudflare auto-builds the backoffice (the "Sistem Tier" toggle disappears). No backend deploy.

- [ ] **Step 3: (optional) Re-confirm segment is on the POS read**

This was verified in 5a (18/18), unchanged here. If desired, one authed call (one-time SEED_ADMIN_PASSWORD; admin `admin@mandalika.test`):
`GET /api/v1/sync/customers/lookup?q=<>&limit=3` → each customer has a `segment` field. Skip if confident.

- [ ] **Step 4: APK build (USER-GATED)**

The POS segment display reaches devices only via an APK. **Ask the user before dispatching.** Dispatch `android-release.yml` (gh CLI not installed locally → Actions UI, or REST `POST /repos/Epheyy/mandalika-pos/actions/workflows/android-release.yml/dispatches {ref:"prod-hardening", inputs:{api_url:"https://mandalika-pos-538849926142.asia-southeast2.run.app"}}` using the git credential-manager token). Wait for the run to succeed; note the artifact.

- [ ] **Step 5: On-device check (USER-PENDING) + report**

Install the APK; in the cashier flow, attach a customer → the picker shows the **segment chip** (e.g. "Juara"/"Berisiko" with its color); confirm no tier text remains; points still shows only when the loyalty points system is on. Document results; fleet rollout. Note backoffice USER-PENDING: the Loyalitas settings no longer show "Sistem Tier".

---

## Self-Review (completed)

- **Spec coverage:** POS segment chip on selected line + dropdown rows, decoupled from loyaltyEnabled, points still gated (A1) ✓; POS color map (A1 Step 1) ✓; retire getCustomerTier (A1 Steps 5-6) ✓; remove backoffice "Sistem Tier" toggle + status mention, leave field vestigial (B1) ✓; APK rollout, no backend change (C1) ✓.
- **Placeholder scan:** none — real code in every step.
- **Type consistency:** `segmentChipClasses(color: string)` (A1 Step 1) used in A1 Steps 3-4; `customer.segment` ({id,name,color}|null) from `@mandalika/api` (5a) — `.name`/`.color` accesses guarded by `&&`; `getCustomerTier` removed from both its def (pricing.ts) and its only consumer (CustomerPicker), no dangling refs; `tierEnabled` left in the loyalty form/type (only the toggle UI + status mention removed), so `loyaltyForm`/`DEFAULT_LOYALTY` still typecheck.
- **No backend:** confirmed — segment already on the reads (5a); zero migration/openapi/client/go changes.
