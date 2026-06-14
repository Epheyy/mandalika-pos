# Sync Dead-Letter Discard Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make discarding a dead-lettered (failed-sync) outbox item a deliberate two-step action with sale-aware wording, so one mis-tap can't permanently throw away an unrecorded transaction.

**Architecture:** A single presentational change in `apps/pos/src/components/SyncStatus.tsx`. The destructive discard (`onSendLog`) is gated behind a local `confirmingDiscard` state: first tap arms a warning + Batal/Ya-hapus row; only "Ya, hapus" calls `onSendLog`. The warning counts sale-bearing items (`order`/`refund`) from the existing `failed` prop. The arm state resets whenever the dropdown closes. No engine, sync-package, backend, or prop-signature change.

**Tech Stack:** React 19 + TypeScript, Tailwind. `@mandalika/sync` `OutboxType` (via the existing `FailedItem` type).

---

## Background facts (verified — do not re-derive)

- **Only file changed:** `apps/pos/src/components/SyncStatus.tsx` (153 lines). It's a `memo`'d component; current imports: `import { memo, useState } from 'react'`.
- **Current failed block** (lines ~108–142) renders, inside `{hasFailed && (…)}`: the failed-items list, then a **"Coba lagi"** button (`onClick={() => { onRetryFailed(); setOpen(false) }}`, filled red), then a **"Kirim Log &amp; Tutup"** button (`onClick={() => { onSendLog(); setOpen(false) }}`, outlined), then a gray caption `<p>Log disimpan untuk debug; transaksi gagal ditutup agar tidak menghalangi.</p>`.
- `failed: FailedItem[]` already carries `.type` (an `OutboxType` — `'order' | 'refund' | 'shift_open' | 'shift_close' | 'cash_flow' | 'customer_create' | 'transfer_receive'`); the component already reads `f.type` at line ~119. So the sale count needs **no new prop**.
- Close paths: the chip toggle `onClick={() => setOpen((v) => !v)}` (line ~64) and the backdrop `onClick={() => setOpen(false)}` (line ~75). An effect keyed on `open` resets the arm state for all close paths robustly.
- `onSendLog` / `onRetryFailed` semantics are unchanged — we only delay *when* `onSendLog` fires.
- **No test harness for this component** (presentational; consistent with the repo's web-testing posture). Verification = `tsc -b` + `vite build` clean + on-device tap-through.
- **Commands** (repo root `C:\Users\MyBook Hype AMD\Downloads\mandalika-pos`): build `corepack pnpm --filter @mandalika/pos build`; tests (regression, unrelated) `corepack pnpm --filter @mandalika/pos test`.
- **Commits:** `git add` then `git commit` as separate commands (chained `&&` can false-positive the pre-commit hook); never `--no-verify`.

---

## Task 1: Two-step discard confirm in SyncStatus

**Files:**
- Modify: `apps/pos/src/components/SyncStatus.tsx`

- [ ] **Step 1: Add the `useEffect` import**

Change the React import line:
```tsx
import { memo, useState } from 'react'
```
to:
```tsx
import { memo, useEffect, useState } from 'react'
```

- [ ] **Step 2: Add the arm state + reset-on-close effect + sale count**

Immediately after the existing `const [open, setOpen] = useState(false)` line, add:
```tsx
  const [confirmingDiscard, setConfirmingDiscard] = useState(false)

  // Disarm the destructive discard whenever the dropdown closes, so reopening
  // always starts from the safe (un-armed) state regardless of how it closed.
  useEffect(() => {
    if (!open) setConfirmingDiscard(false)
  }, [open])
```

Then, just after the existing `const hasFailed = failed.length > 0` line, add:
```tsx
  const saleCount = failed.filter(
    (f) => f.type === 'order' || f.type === 'refund',
  ).length
```

- [ ] **Step 3: Replace the discard button + caption with the two-step confirm**

In the `{hasFailed && (…)}` block, find the existing discard button and caption (the **"Kirim Log &amp; Tutup"** `<button>` and the gray `<p>Log disimpan untuk debug; transaksi gagal ditutup agar tidak menghalangi.</p>` that follow the "Coba lagi" button). Replace **those two elements** (leave the "Coba lagi" button above them untouched) with:

```tsx
                {!confirmingDiscard ? (
                  <button
                    onClick={() => setConfirmingDiscard(true)}
                    className="w-full py-2 border border-red-200 text-red-600 rounded-lg font-semibold"
                  >
                    Kirim Log &amp; Tutup
                  </button>
                ) : (
                  <div className="space-y-1.5 rounded-lg bg-red-50 p-2">
                    <p className="text-[11px] font-semibold text-red-700 leading-tight">
                      {saleCount > 0
                        ? `⚠️ ${saleCount} penjualan/refund belum tercatat & akan hilang permanen.`
                        : `${failed.length} item gagal sinkron akan dihapus.`}
                    </p>
                    <div className="flex gap-2">
                      <button
                        onClick={() => setConfirmingDiscard(false)}
                        className="flex-1 py-2 border border-gray-200 text-gray-600 rounded-lg font-semibold"
                      >
                        Batal
                      </button>
                      <button
                        onClick={() => { onSendLog(); setOpen(false) }}
                        className="flex-1 py-2 bg-red-600 text-white rounded-lg font-semibold"
                      >
                        Ya, hapus
                      </button>
                    </div>
                  </div>
                )}
```

(The "Coba lagi" button stays exactly as-is and remains the filled-red primary above this block. The old gray caption is removed — the armed warning now carries the consequence wording.)

- [ ] **Step 4: Typecheck + build**

Run: `corepack pnpm --filter @mandalika/pos build`
Expected: PASS — `tsc -b` clean (no unused-import or type errors; `f.type` narrows against `OutboxType`), `vite build` succeeds. The pre-existing `@capacitor/core` dynamic-import warning is unrelated noise.

- [ ] **Step 5: Regression check (unrelated suites stay green)**

Run: `corepack pnpm --filter @mandalika/pos test`
Expected: PASS — 57 tests (this change touches no tested module; this just confirms no accidental breakage).

- [ ] **Step 6: Commit**

```bash
git add apps/pos/src/components/SyncStatus.tsx
git commit -m "feat(sync): two-step confirm before discarding failed-sync items (POS)"
```

---

## Task 2: APK build + on-device hand-off

**Files:** none (release + verification).

- [ ] **Step 1: Confirm scope is POS-only**

Run: `git status --short` and `git diff --stat HEAD~1 HEAD`
Expected: the only code file changed is `apps/pos/src/components/SyncStatus.tsx` (plus the plan/spec docs). If anything under `backend/` or `packages/` changed, that's out of scope — investigate.

- [ ] **Step 2: Push + trigger the APK**

```bash
git push origin prod-hardening
"/c/Program Files/GitHub CLI/gh.exe" workflow run android-release.yml --ref prod-hardening
```
(The workflow's default `api_url` is the production Cloud Run URL — no `-f` needed.) Watch the run to green:
```bash
"/c/Program Files/GitHub CLI/gh.exe" run list --workflow=android-release.yml --limit 1
```

- [ ] **Step 3: On-device checklist (USER-PENDING)**

After installing the new APK, with at least one failed-sync item present (or simulate by going offline mid-sale then triggering a server reject):
1. Open the sync chip dropdown → "Coba lagi" (red, primary) + "Kirim Log & Tutup" (outlined) shown.
2. Tap "Kirim Log & Tutup" → it swaps in-place for the ⚠️ warning naming the sale count (e.g. "⚠️ 2 penjualan/refund belum tercatat & akan hilang permanen.") + "Batal" / "Ya, hapus". **Nothing is discarded yet.**
3. Tap "Batal" → returns to the un-armed view; the failed items are still listed.
4. Re-arm → "Ya, hapus" → items discarded (log shared as before) + dropdown closes.
5. Reopen the dropdown after a Batal/arm cycle → it starts un-armed.

---

## Self-Review

**Spec coverage:**
- §3.1 inline two-step confirm → Task 1 Step 3. ✅
- §3.2 guard all discards, warning names sale-bearing items → Task 1 Step 2 (`saleCount`) + Step 3 (conditional copy). ✅
- §3.3 defer auto-recovery → not built (out of scope). ✅
- §4 un-armed/armed behavior, Batal/Ya-hapus, `onSendLog` unchanged, retry stays primary → Task 1 Step 3. ✅
- §4 reset rule on close → Task 1 Step 2 effect. ✅
- §4 "no change to other labels/props" → only the discard button + caption replaced; "Coba lagi", resync, flush, empty state untouched. ✅
- §6 testing (tsc/build + on-device) → Task 1 Steps 4–5, Task 2 Step 3. ✅
- §7 out of scope (engine/outbox/backend/auto-recovery) → none touched. ✅

**Placeholder scan:** No TBD/TODO; every step has exact code/commands + expected output. ✅

**Type consistency:** `confirmingDiscard`/`setConfirmingDiscard`, `saleCount`, `f.type` (against `OutboxType`), `onSendLog`/`onRetryFailed`/`setOpen` all match the existing component and are used identically across steps. ✅
