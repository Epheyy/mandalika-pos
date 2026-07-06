# Promo Modal — Wider Step-Wizard (Design)

**Date:** 2026-07-06
**Branch:** `prod-hardening`
**Status:** Design approved — build
**Slice:** UX redesign of the Tambah/Edit Promosi modal into a wider, left-sidebar **step wizard** (user reference: a 4-step promo wizard; "inspired by, not copied"). Backoffice-only; user will iterate live.

---

## Context
The promo form (`apps/backoffice/src/screens/promotions/PromoFormModal.tsx`) is a tall single-scroll modal (recently compacted with an accordion). The user wants a **wider modal** with a **left-sidebar step nav** that paginates the fields into short steps. All field logic, state (`form`/`setForm`), and validators (`tieredError`/`bundleError`/`hoursError`/`maxAppError`) from SP-Promo-4 stay intact — this is a **re-housing into steps + wizard shell**, not a logic change. The shared `Modal` (`apps/backoffice/src/ui/Modal.tsx`) currently maxes at `size='xl'` (`max-w-2xl`); needs a wider option.

## Decisions (locked during brainstorm)
1. **Full step wizard** (user chose this over a wider-single-form). Left sidebar stepper + right content pane; **Kembali / Lanjutkan / Simpan** footer.
2. **3 steps** (grouping approved): **Umum** → **Jenis Promosi** → **Lokasi & Ketentuan**.
3. **Free navigation** (click any sidebar step, or Kembali/Lanjutkan). No hard per-step blocking. **Simpan** stays gated by the existing validators; the sidebar **flags the step holding a validation error** so it's never hidden.
4. **Type cards** → horizontal **3-column, centered icon-on-top** cards (6 types → 2 rows), matching the reference card style; keep `role=radio`/gold-selected.
5. **Wider modal** via a new `Modal` size.

---

## 1. `Modal.tsx` — add a wider size
Extend `type Size` with `'2xl'` and `MAX` with `'2xl': 'max-w-4xl'` (≈896px). (Additive; other modals unaffected.) The promo modal uses `size='2xl'`.

## 2. Wizard shell (`PromoFormModal.tsx`)
- Add local UI state: `const [step, setStep] = useState(0)` (0/1/2). A `useEffect` keyed on `open` resets `step` to 0 when the modal opens (so a reused modal instance doesn't keep the prior step).
- `const STEPS = [{ label: 'Umum' }, { label: 'Jenis Promosi' }, { label: 'Lokasi & Ketentuan' }]`.
- **Per-step error map** (for the sidebar red flag): step 0 → `!!hoursError`; step 1 → `!!tieredError || !!bundleError || !!maxAppError`; step 2 → none. (No new validators; reuse the existing ones.)
- **Body layout:** replace the single `space-y-4` container with a 2-column flex: a `w-44 shrink-0` left `<nav>` (the stepper) + a `flex-1 min-w-0 space-y-4` right pane rendering the active step's fields (conditional on `step`).
- **Sidebar stepper:** vertical list of the 3 steps; each is a `type="button"` that `setStep(i)` (click-to-jump). Each item: a round badge (step number) — **gold-filled when active**, outlined otherwise, **red ring/dot when that step has an error** — plus the label (bold + gold when active). Style to echo the reference (numbered circles, active highlighted).
- **Footer (computed by step):** Batal (always) + **Kembali** (if `step>0` → `setStep(step-1)`) + **Lanjutkan** (if `step<2` → `setStep(step+1)`) or **Simpan** (if `step===2`, the existing save button with `disabled={!!tieredError||!!bundleError||!!hoursError||!!maxAppError}` + `loading={busy}` + `onClick={onSave}`). Build this as the `footer` node passed to `<Modal>`.

## 3. Step contents (re-house existing fields, no logic change)
**Step 0 — Umum:**
- Nama Promosi* (`Input`), Deskripsi (`Textarea`), Tanggal Mulai/Berakhir (existing 2-col date inputs).
- A **"Tentukan hari & jam" toggle** (a `<label>`+checkbox switch, local `const [schedOpen, setSchedOpen] = useState(...)`, initialized true if `activeDays?.length || activeFromHour || activeToHour` — via the same `open`-keyed effect). When **ON**, reveal: Aktif Hari chips (existing `toggleDay`) + Jam Aktif from/to time inputs + the `hoursError` message. When toggled **OFF**, clear the schedule so a hidden gate can't linger: `setForm(f => ({ ...f, activeDays: [], activeFromHour: '', activeToHour: '' }))`.

**Step 1 — Jenis Promosi:**
- `PromoTypePicker` restyled to a **`grid grid-cols-3 gap-2`** of centered cards (icon centered on top ~`w-6 h-6`, bold title centered, small muted desc centered; `line-clamp-2`), keeping `role="radio"`/`aria-checked`/gold border+bg on selected. Icons unchanged (Percent/Banknote/Gift/ShoppingBag/BarChart3/Package).
- Directly below: the type-specific config blocks exactly as they are — the `Nilai` input (percentage/fixed), the `buy_x_get_y` gold block, the `tiered` slots block, the `bundle` slots block (all keep their `bg-gold-50` styling + `setBxgy`/`setTiers`/`setBundle` + `maxAppError`/`tieredError`/`bundleError` messages).

**Step 2 — Lokasi & Ketentuan:**
- Outlet multi-select (the existing expand/collapse "Semua outlet / N dipilih" control + `toggleOutlet`).
- Min. Pembelian (`Input`).
- Bisa Kombinasi + Hanya Kode (the single-line toggle rows).
- Varian Spesifik (existing `applicableVariantKeys` picker, shown for the types where it applies — keep its existing `form.type !==` guard).

## 4. Preserve (do NOT change)
- All form-state keys + bindings, `selectType`, `toggleDay`, `toggleOutlet`, `toggleVariant`, `setBxgy`/`setTiers`/`setBundle`, and the four validators + the exact Simpan `disabled` expression.
- The accordion (`advOpen`) from the previous polish is **replaced** by the step wizard (the fields it held now live in steps 0/2) — remove the accordion wrapper; do not lose any field.

## 5. Testing & verification
- `cd apps/backoffice && corepack pnpm tsc --noEmit && corepack pnpm vite build` clean.
- Self-check: every `form.*` binding that existed pre-change still present (grep the moved fields); the four validators + save-gate unchanged; each of the 3 steps renders its fields; the type config blocks are under step 1.
- **USER-PENDING (live):** the wizard renders wider, sidebar steps switch content, Kembali/Lanjutkan/Simpan work, a validation error flags its step + keeps Simpan disabled, edit-mode opens on step 0 with all data intact + the schedule toggle reflecting existing hours/days.

## 6. Rollout
Sonnet implements (cohesive single-file wizard + the 1-line Modal size); Sonnet review (form-binding preservation + nav/step logic + validator integrity). Push → Cloudflare backoffice auto-deploy. No backend/POS/APK. User iterates the UX live.

## Out of scope
- Per-step hard-blocking validation (free nav chosen).
- New validators (name-required etc. — keep current behavior).
- Mobile/responsive stacking of the sidebar (backoffice is desktop).
