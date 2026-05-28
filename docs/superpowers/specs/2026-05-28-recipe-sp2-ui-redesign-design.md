# SP-Recipe-2 — Recipe Editor UI Clarity Redesign — Design

Date: 2026-05-28 · Branch: `prod-hardening`

## Context

SP-Recipe-2 shipped and works, but the recipe slide-over editor reads poorly
(user feedback after hands-on test). This is a **visual-clarity polish only —
no behavior or API change**. Scope = two existing files:
`apps/backoffice/src/screens/recipes/RecipeSlideOver.tsx` and
`apps/backoffice/src/screens/recipes/RecipeIngredientPicker.tsx`. Gold-palette
backoffice; reuse existing `ui/` primitives.

Approved via visual-companion before/after mockup (picker-as-button confirmed).

## The four fixes

### 1. Add-ingredient = a button, not an always-open list
- **Now:** `RecipeIngredientPicker` is always rendered — a stray empty search
  input + a dominant "Semua" category `<select>` + a permanently-visible
  results list. Looks broken.
- **Redesign:** The slide-over body shows a single dashed **"+ Tambah Bahan"**
  button (gold, matching the dashed-add affordance used elsewhere). Clicking it
  reveals the picker inline (autofocused search input + Kategori filter); the
  results dropdown appears only while the input is focused / has matches.
  The expanded picker collapses back to the button on `Escape`, or on outside
  click / blur when the search is empty. After a successful pick the search
  input clears but the picker stays expanded (so several ingredients can be
  added in a row); a small "Tutup" affordance also collapses it.
- Implementation: lift an `adding` boolean into `RecipeSlideOver`; render the
  button when `!adding` and `<RecipeIngredientPicker>` when `adding`. The picker
  gains an `autoFocus` on its search input and an `onClose` callback (Escape /
  Tutup). The category `<select>` stays inside the expanded picker only.
- Read-only (history view) shows neither the button nor the picker (unchanged).

### 2. Column headers over the ingredient rows
- Add a header row above the lines: **Bahan · Jumlah · Satuan** (uppercase,
  `text-gray-400`, same treatment as other backoffice tables). The grid stays
  the existing 12-col layout; headers align to name / qty input / unit.
- The header row hides when there are zero lines (the empty-state text shows
  instead).

### 3. Calmer stock hint
- **Now:** every line shows red `⚠ stok 0`, even when stock is irrelevant
  (recipe is reference-only) — alarm fatigue.
- **Redesign:** show warehouse stock as a **muted gray subtitle** under the
  ingredient name: `stok gudang {onHandTotal} {unit}`. Escalate to an **amber**
  `⚠` treatment **only** when `onHandTotal < Number(qty)` (genuinely short for
  what this recipe line needs). The separate **"nonaktif"** badge (ingredient
  `is_active === false`) stays as a distinct amber/red warning — that is a real
  problem worth flagging. `onHandTotal` is only present on server-loaded lines;
  freshly-added lines show no stock subtitle until saved+reloaded (unchanged
  MVP limitation).

### 4. Cost estimate never silently vanishes
- **Now:** the "Estimasi biaya bahan" row is omitted entirely when any line
  lacks a unit cost — looks like a missing feature.
- **Redesign:** always render the cost row in the footer. When computable, show
  `Estimasi biaya bahan … Rp X` (current behavior). When not computable (a line
  has `defaultUnitCost == null` or a non-numeric qty), show a muted italic
  **"belum tersedia"** with an ⓘ and a `title` tooltip: *"Ada bahan tanpa biaya
  satuan, jadi estimasi tidak bisa dihitung."*

## Out of scope (unchanged)

Behavior, endpoints, version/restore logic, the optimistic-lock 409 flow, the
header version pill/dropdown, the read-only history banner, and the MVP cuts
(no recipe-exists ●, no per-warehouse breakdown, stock hint only on
server-loaded lines). No new dependencies.

## Testing

- `corepack pnpm --filter @mandalika/backoffice exec tsc --noEmit` clean +
  production build.
- Manual/Playwright UI check on the live site: button reveals picker; picker
  collapses on Escape/Tutup; headers render; stock subtitle is gray (amber only
  when short); cost row shows "belum tersedia" with tooltip when a costless
  ingredient is present and a Rupiah value when all lines have costs.
