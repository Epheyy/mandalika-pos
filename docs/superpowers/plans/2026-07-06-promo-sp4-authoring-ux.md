# SP-Promo-4 Authoring UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the missing promo-authoring fields to the backoffice form — an **outlet multi-select** and **active-hours** inputs — plus a `maxApplications ≥ 0` save guard and the edit-populate wiring, so the outlet/hours rules the engine already enforces become authorable.

**Architecture:** Pure backoffice-form change. `PromoFormModal.tsx` gains an `outlets` prop + outlet chip-toggles + two `<input type="time">` + validation; `Promotions.tsx` loads outlets, passes them, and carries the new fields through the three edit-populate handlers. Nothing downstream changes (write/read repo, OpenAPI, engine already support `outletIds`/`activeFromHour`/`activeToHour`).

**Tech Stack:** TypeScript / React (backoffice `apps/backoffice`), the hand-written `@mandalika/api` client (`api.listOutlets()`).

**Spec:** `docs/superpowers/specs/2026-07-06-promo-sp4-authoring-ux-design.md`

## Global Constraints

- **Backoffice-only.** No backend, no OpenAPI/codegen, no migration, no POS, no APK. Deploy = push → Cloudflare backoffice auto-deploy.
- `outletIds` empty = all outlets (engine treats empty `outlet_ids` as no filter). No explicit "all" chip.
- `activeFromHour`/`activeToHour` are `"HH:MM"` strings (engine string-compares to the current time). Empty (both blank) = no hour gate.
- **Overnight windows unsupported:** block save when `from > to` (the engine's `hm < from || hm > to` never fires for from>to → a dead promo).
- **Half-set hours invalid:** block save when exactly one of from/to is set.
- **Edit-populate is the gap-class:** `openEditPromo`/`dupPromo`/`togglePromo` must carry `outletIds` + `activeFromHour` + `activeToHour` (they currently omit `outletIds` — a latent bug that wipes outlet scoping on edit). `activeDays` is already carried.
- Reuse existing patterns: the day-chip toggle (PromoFormModal ~L336-342 + `toggleDay` ~L122), the `usePolledQuery` load + prop-pass (Promotions.tsx `pq`/`products` ~L100/L351), the `tieredError`/`bundleError` + `disabled={!!tieredError||!!bundleError}` save-gate (~L153/L170/L195).
- Skip the `bundlePrice`-below-anchor advisory (out of scope).
- Don't touch unrelated working-tree files (`package.json` doctor script, PNGs, audit doc).

## File Structure

- `apps/backoffice/src/screens/promotions/PromoFormModal.tsx` — MODIFY: `outlets` prop, `toggleOutlet`, the outlet chip `Field`, the two time `Input`s, `hoursError` + `maxAppError` validation, extended save `disabled`, `min={0}` on the maxApplications inputs.
- `apps/backoffice/src/screens/Promotions.tsx` — MODIFY: load outlets (`usePolledQuery`) + pass `outlets={outlets}`; edit-populate the 3 handlers.

---

## Task 1: Outlet selector + active-hours + validation (PromoFormModal + parent outlet load)

**Files:**
- Modify: `apps/backoffice/src/screens/promotions/PromoFormModal.tsx`
- Modify: `apps/backoffice/src/screens/Promotions.tsx` (add outlet load + pass the new prop)

**Interfaces:**
- Consumes: `api.listOutlets(): Promise<Outlet[]>`; existing `usePolledQuery`; `Field`/`Input` from `../../ui/Field`; `form.outletIds`/`activeFromHour`/`activeToHour` on `PromotionInput`.
- Produces: `PromoFormModal` gains a required `outlets: Outlet[]` prop; the form authors outletIds + active hours; save is blocked on invalid hours / negative maxApplications.

- [ ] **Step 1: Load outlets in `Promotions.tsx` + pass the prop**

Near the other queries (`pq` at ~L100) add (import `Outlet` from `@mandalika/api` if not already imported):
```tsx
  const ouq = usePolledQuery<Outlet[]>(() => api.listOutlets(), [])
  const outlets = ouq.data ?? []
```
In the `<PromoFormModal ... products={products}` invocation (~L346-351), add the prop:
```tsx
        outlets={outlets}
```

- [ ] **Step 2: Add the `outlets` prop + `toggleOutlet` to `PromoFormModal.tsx`**

Import the type (extend the existing `import type { Product, PromotionInput } from '@mandalika/api'`):
```tsx
import type { Product, PromotionInput, Outlet } from '@mandalika/api'
```
Add to `PromoFormModalProps` (after `products: Product[]`):
```tsx
  outlets: Outlet[]
```
Add `outlets` to the destructured params (after `products,`). Add the handler next to `toggleDay` (~L128):
```tsx
  const toggleOutlet = (id: string) =>
    setForm((f) => ({
      ...f,
      outletIds: (f.outletIds || []).includes(id)
        ? (f.outletIds || []).filter((x) => x !== id)
        : [...(f.outletIds || []), id],
    }))
```

- [ ] **Step 3: Add the `hoursError` + `maxAppError` validators**

Next to the existing `tieredError`/`bundleError` IIFEs (~L153-193), add:
```tsx
  const hoursError = (() => {
    const from = form.activeFromHour || ''
    const to = form.activeToHour || ''
    if ((from === '') !== (to === '')) return 'Isi kedua jam aktif atau kosongkan keduanya.'
    if (from !== '' && to !== '' && from > to)
      return 'Jam mulai harus lebih awal dari jam selesai (rentang lewat tengah malam tidak didukung).'
    return null
  })()
  const maxAppError = (() => {
    if (form.type === 'buy_x_get_y' && (form.bxgyConfig?.maxApplications ?? 0) < 0)
      return 'Maks/transaksi tidak boleh negatif.'
    if (form.type === 'bundle' && (form.bundleConfig?.maxApplications ?? 0) < 0)
      return 'Maks. kelipatan tidak boleh negatif.'
    return null
  })()
```

- [ ] **Step 4: Extend the save-gate `disabled`**

Change the Simpan button (~L195):
```tsx
          <Button className="flex-1" loading={busy} disabled={!!tieredError || !!bundleError || !!hoursError || !!maxAppError} onClick={onSave}>{busy ? 'Menyimpan...' : 'Simpan'}</Button>
```

- [ ] **Step 5: Add `min={0}` to the two maxApplications inputs**

- bxgy "Maks/transaksi" input (~L213): add `min={0}` to its `<Input>` props.
- bundle "Maks. kelipatan" input (~L326): add `min={0}` to its `<Input>` props.

- [ ] **Step 6: Render the outlet chips + active-hours + the errors**

After the "Aktif Hari" `<Field>` block (~L342), add:
```tsx
        <Field label="Outlet (kosong = semua outlet)">
          <div className="flex gap-1.5 flex-wrap">
            {outlets.map((o) => (
              <button key={o.id} type="button" onClick={() => toggleOutlet(o.id)} className={`px-3 py-1.5 rounded-lg text-xs font-bold border-2 ${(form.outletIds || []).includes(o.id) ? 'bg-gold-600 text-white border-gold-600' : 'border-gray-200 text-gray-600'}`}>{o.name}</button>
            ))}
          </div>
        </Field>
        <Field label="Jam Aktif (kosong = sepanjang hari)">
          <div className="grid grid-cols-2 gap-4">
            <Input label="Dari" type="time" value={form.activeFromHour || ''} onChange={(e) => setForm((f) => ({ ...f, activeFromHour: e.target.value }))} />
            <Input label="Sampai" type="time" value={form.activeToHour || ''} onChange={(e) => setForm((f) => ({ ...f, activeToHour: e.target.value }))} />
          </div>
          {hoursError && <p className="text-xs text-red-600 font-semibold mt-1">{hoursError}</p>}
        </Field>
```
And surface `maxAppError` near the config sub-forms (add, alongside the existing `{bundleError && ...}`/bxgy area):
```tsx
        {maxAppError && <p className="text-xs text-red-600 font-semibold">{maxAppError}</p>}
```
NOTE: `Input`'s `label` prop renders the field label (the file uses `<Input label=...>` throughout) — the `Field label` wrapper + inner `Input label` is fine (matches the dates row pattern at L332-335 which uses inner `Input label="Mulai"`). Match the file's exact `Input`/`Field` API (verify props); adapt class names to the surrounding style.

- [ ] **Step 7: Verify**

Run: `cd apps/backoffice && corepack pnpm tsc --noEmit && corepack pnpm vite build`
Expected: clean (the pre-existing chunk-size warning is fine).

- [ ] **Step 8: Commit**

```bash
git add apps/backoffice/src/screens/promotions/PromoFormModal.tsx apps/backoffice/src/screens/Promotions.tsx
git commit -m "feat(promo-sp4): outlet selector + active-hours fields + maxApplications guard in promo form"
```

---

## Task 2: Edit-populate the new fields (Promotions.tsx)

**Files:**
- Modify: `apps/backoffice/src/screens/Promotions.tsx` (`openEditPromo`, `dupPromo`, `togglePromo`)

**Interfaces:**
- Consumes: the `Promotion` read shape (`p.outletIds`/`p.activeFromHour`/`p.activeToHour`).
- Produces: editing/duplicating/toggling a promo preserves its outlet scoping + active hours (closes the `openEditPromo`-drops-`outletIds` latent bug).

- [ ] **Step 1: Carry the fields in all three handlers**

In `openEditPromo`, `dupPromo`, and `togglePromo` — each rebuilds a `PromotionInput` field-by-field and already carries `activeDays`, `bxgyConfig`, `tieredConfig`, `bundleConfig` (search each for `activeDays:`). Add to EACH of the three:
```tsx
      outletIds: p.outletIds ?? [],
      activeFromHour: p.activeFromHour ?? '',
      activeToHour: p.activeToHour ?? '',
```
(Place alongside the existing `activeDays: p.activeDays || []` line in each handler.) Confirm all three handlers get all three fields — a missing one silently wipes that field on that action.

- [ ] **Step 2: Verify**

Run: `cd apps/backoffice && corepack pnpm tsc --noEmit && corepack pnpm vite build`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add apps/backoffice/src/screens/Promotions.tsx
git commit -m "feat(promo-sp4): edit-populate outletIds + active hours (closes openEditPromo outletIds-wipe bug)"
```

---

## Task 3: Verify, deploy, handoff

- [ ] **Step 1: Full backoffice gate**

Run: `cd apps/backoffice && corepack pnpm tsc --noEmit && corepack pnpm vite build`
Expected: clean. (No backend/Go/e2e/migration/APK — backoffice-only slice.)

- [ ] **Step 2: Static self-check**

Run: `grep -n "outletIds\|activeFromHour\|activeToHour" apps/backoffice/src/screens/Promotions.tsx`
Expected: `outletIds`/`activeFromHour`/`activeToHour` present in all three edit-populate handlers (openEditPromo/dupPromo/togglePromo) + the `outlets={outlets}` pass.

- [ ] **Step 3: Push (Cloudflare backoffice auto-deploys)**

```bash
git push origin prod-hardening   # retry on the connection-reset gotcha
```
Confirm the push landed (`git ls-remote origin prod-hardening` or the push output). No backend redeploy, no APK.

- [ ] **Step 4: Handoff + memory**

Update `promotion-module-sp-promo` + `MEMORY.md` + `SESSION_HANDOFF.md`: SP-Promo-4 DONE (outlet selector + active hours + maxApplications guard + edit-populate fix). **The promotion module is now fully complete** — next queued work is the OTA slice ([[ota-capgo-self-hosted]]). USER-PENDING: visual check on `mandalika-pos.pages.dev` → Promosi → create/edit a promo (outlet chips + Jam Aktif populate + round-trip on reopen). Commit the handoff:
```bash
git add SESSION_HANDOFF.md docs/superpowers
git commit -m "docs(promo-sp4): handoff — SP-Promo-4 done; promotion module complete; next = OTA"
git push origin prod-hardening
```

---

## Notes for the implementer
- This is a small, low-risk backoffice slice — no correctness-critical surface (no engine/type-gen/money/stock). Review tier is light (Haiku/Sonnet).
- The one thing that MUST be right is the **edit-populate** (Task 2): every one of the three handlers must carry `outletIds`+hours, or that field silently resets when a user edits/dups/toggles a promo. Verify all three.
- `usePolledQuery`/`api.listOutlets`/`Input`/`Field`/`Outlet` are all existing — match their real signatures; adapt any snippet whose prop shape differs from the real component.
