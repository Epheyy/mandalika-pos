# Recipe / Formula Module — SP-Recipe-2: Recipes & Versioning — Design

Date: 2026-05-28 · Branch: `prod-hardening`

## Module context (the whole Recipe vision, for continuity)

The Recipe / Formula module ties a **production formula** to each product
variant — primarily for the **Flamboyan Perfume** and **Performance Perfume**
brands. The Mandalika POS codebase is a shared template used by all three
brands; Mandalika itself will not enable this module.

The module is decomposed into two sequenced sub-projects:

- **SP-Recipe-1 — Ingredient inventory subsystem** *(DONE, deployed: backend
  rev `00034-9jc`, migrations 0019 + 0020)*: a parallel warehouse-stock
  subsystem for raw materials with fractional qty, ingredient transfers with
  printable surat jalan + tanda terima, opname, plus SKU / Kategori / UOM.
- **SP-Recipe-2 — Recipes & versioning** *(this spec)*: per-variant recipes
  with full version history, a right-side slide-over editor inside the product
  edit modal, informational cost estimation, and live ingredient-stock
  visibility. Consumes SP-Recipe-1's ingredients catalog.

**Module-wide locked decisions** (apply across both SPs — do NOT relitigate):

- **Scope = reference-only formula + live ingredient-stock view.** No
  auto-deduct on "produce"; the recipe is documentation. Stock changes go
  through the existing ingredient ops (adjust, goods-in, transfer).
- **Ingredient model = separate `ingredients` table** (SP-Recipe-1), flat with
  a single unit, `numeric(14,3)` stock, SKU + category + UOM.
- **Recipes are per-variant** (not per-product): each variant (30ml / 50ml /
  100ml) has its own recipe row.
- **Recipe versioning = full history.** Each save creates a new
  `recipe_versions` row with an ingredient snapshot (name, qty, unit, cost
  frozen at save time). UI shows a version selector; older versions are
  read-only; "Pulihkan" creates a new version from a snapshot.
- **POS exposure = none.** Recipes and ingredients are backoffice-only;
  `@mandalika/sync` is untouched.
- **Permissions = reuse `manage_inventory`** (existing). Admin implicit.
- **Module gate = `app_settings.recipes_enabled boolean` DEFAULT false.**
  When off (Mandalika default), the Resep affordance hides and the routes
  return 404. When on (Flamboyan / Performance), the module surfaces.
- **Cost = informational only.** No COGS, no valuation. Recipe screen shows
  "Estimasi biaya bahan: Rp X" computed from `qty × default_unit_cost`, hidden
  if any ingredient lacks a cost.

## SP-Recipe-2 goal

Add per-variant recipes to the backoffice: a "Resep" button on each variant
row in the product edit modal opens a **right-side slide-over editor** (Layout
A, locked in the SP-Recipe-1 brainstorm). The editor lists ingredient lines
(name + fractional qty + auto-filled unit + stock hint), shows a live cost
estimate, and saves an append-only **version** every time. A header version
selector browses history; any past version can be restored (which creates a
new version). Entirely backoffice; no POS; gated by `manage_inventory` +
`recipes_enabled`.

## SP-Recipe-2 locked decisions (resolved in this brainstorm)

1. **Version-history UI = header dropdown → inline history list** (option A).
   The version pill in the slide-over header expands to a list of versions
   (version_no, date, author, notes); selecting one loads it read-only.
2. **"Pulihkan ke versi ini" restores immediately** — no confirm step.
3. **Restore recomputes cost at today's prices** — the new version snapshots
   each ingredient's *current* `default_unit_cost`, not the historical
   `cost_at_save`. Consistent with "cost frozen at save time" (the save is
   happening now).
4. **Concurrent saves use optimistic locking.** The save request carries the
   `expectedCurrentVersionId` the editor loaded from; if it no longer matches
   `recipes.current_version_id`, the server returns **409 Conflict** and the
   editor reloads the current version. No silent overwrite.
5. **Inactive ingredient handling = warn but allow existing; hide from
   new-add.** A line whose ingredient is now `is_active = false` shows a ⚠
   badge and still saves. The add-ingredient autocomplete lists only active
   ingredients, so a *newly added* inactive ingredient is rejected (400).
   Historical versions stay intact via the snapshot columns.
6. **No manual recipe deletion.** A recipe is permanent once it has a version;
   it disappears only when its variant/product is deleted (FK cascade). No
   "Hapus resep" action. (Clearing a recipe = saving a version with zero
   lines, which is allowed.)

## Current-state facts (verified)

- `product_variants(id uuid PK, product_id → products ON DELETE CASCADE, size,
  price numeric(14,2), stock integer, sku, barcode)`. Deleting a product
  cascades to its variants; SP-Recipe-2 recipes cascade from the variant.
- A variant's `id` is **stable only after the product is saved** — the product
  edit modal (`apps/backoffice/src/screens/Products.tsx`) loads base variants
  via `api.getProduct(...)` (line ~112) and only sends `variant.id` on update.
  A brand-new product or a freshly-added-but-unsaved variant row has no `id`,
  so the "Resep" button must be **disabled** on such rows ("Simpan produk
  dulu").
- `ingredients(id, name, sku, unit, category_id → ingredient_categories ON
  DELETE SET NULL, default_unit_cost numeric(14,2) NULL, notes, is_active,
  created_at)` (migrations 0019 + 0020). `api.listIngredients({ limit })`
  returns `{ data: Ingredient[] }`, searchable by name OR sku;
  `api.listIngredientCategories()` for the Kategori filter.
- `ingredient_warehouse_stock(warehouse_id, ingredient_id, qty
  numeric(14,3))` holds per-warehouse stock. The recipe stock hint aggregates
  **total on-hand across warehouses** (per-warehouse breakdown deferred).
- Highest migration = `0020_ingredient_metadata.sql` → SP-Recipe-2 is **0021**.
- `app_settings.recipes_enabled` gate + `RequireRecipesEnabled` middleware
  factory + `Repo.RecipesEnabled` helper already exist (SP-Recipe-1). Reuse
  verbatim; no new perm.
- Backoffice gate pattern: the Bahan tab fetches app-settings on mount and
  hides when the flag is off. The Resep affordance follows the same pattern.
- **OpenAPI `$ref` + `nullable` codegen gotcha** (memory
  `openapi-nullable-ref-codegen-gotcha`): `openapi-typescript` drops
  `nullable:true` on `$ref` schemas, so nullable fields surface as
  `T | undefined` in TS. Clear nullable fields by omitting them / using
  `undefined`; Go uses pointer-omitempty so missing == null at the wire.
- **pgx "conn busy" lesson** (SP-Recipe-1 commit `93c17e6`): collect query
  rows fully before issuing another exec on the same connection inside a tx.
  The save/restore transactions follow this.

## Data model — new migration `0021_recipes.sql`

(0020 is current highest. Three normalized tables, mirroring the existing
`*_items` snapshot pattern used by transfers / goods-receipts / stock-counts.)

```sql
-- One recipe per variant. Deletion only via variant cascade (no manual delete).
CREATE TABLE recipes (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  variant_id         uuid NOT NULL UNIQUE REFERENCES product_variants(id) ON DELETE CASCADE,
  current_version_id uuid,                       -- live-version pointer; set after first save
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid REFERENCES users(id)
);

-- Append-only version history.
CREATE TABLE recipe_versions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipe_id         uuid NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  version_no        int  NOT NULL,
  notes             text,
  total_cost_cached numeric(14,2),               -- NULL if any line lacks a cost
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid REFERENCES users(id),
  UNIQUE (recipe_id, version_no)
);
CREATE INDEX idx_recipe_versions_recipe ON recipe_versions(recipe_id);

-- Frozen ingredient snapshot per version.
CREATE TABLE recipe_ingredients (
  version_id    uuid NOT NULL REFERENCES recipe_versions(id) ON DELETE CASCADE,
  ingredient_id uuid NOT NULL REFERENCES ingredients(id) ON DELETE RESTRICT,
  qty           numeric(14,3) NOT NULL CHECK (qty > 0),
  name_at_save  text NOT NULL,                   -- snapshot so old versions render after rename
  unit_at_save  text NOT NULL,
  cost_at_save  numeric(14,2),                   -- NULL allowed (ingredient had no cost)
  sort_order    int  NOT NULL DEFAULT 0,
  PRIMARY KEY (version_id, ingredient_id)
);
```

Deferred FK note: `current_version_id` is intentionally *not* a hard FK to
`recipe_versions` (it would create a circular create-order dependency inside the
first-save transaction). It is maintained by the write layer; integrity is
guaranteed by the single-transaction save. `ingredient_id ON DELETE RESTRICT`
protects historical snapshots from hard-deletes; combined with `name_at_save`,
old versions always render fully.

## Backend (Go + OpenAPI)

New `backend/internal/write/recipe.go` + read methods in `read/repo.go`. All
routes gated by `RequireRecipesEnabled` + `manage_inventory`.

- `GET /api/v1/products/{productId}/variants/{variantId}/recipe`
  → current version, hydrated: `currentVersionId`, `versionNo`, `notes`,
  `totalCostCached`, `versionCount`, and `items[]` each with `ingredientId`,
  `nameAtSave`, current `name` (joined), `qty`, `unitAtSave`, `costAtSave`,
  current `defaultUnitCost`, `isActive`, `onHandTotal` (sum across warehouses).
  **404** if the recipe doesn't exist yet → the UI treats it as a blank/new
  recipe.
- `GET …/recipe/versions` → summaries (`id`, `versionNo`, `notes`,
  `totalCostCached`, `createdAt`, `createdBy`), no items, newest first.
- `GET …/recipe/versions/{versionId}` → one snapshot, hydrated read-only.
- `POST …/recipe` → save a new version. Body:
  `{ expectedCurrentVersionId: uuid | null, notes: string | null,
  items: [{ ingredientId, qty, sortOrder }] }`.
  - **Optimistic lock:** compare `expectedCurrentVersionId` to
    `recipes.current_version_id` (both null on first save). Mismatch → **409**
    `"Resep sudah diubah orang lain. Muat ulang."`
  - Creates the `recipes` row on first save. Inserts a `recipe_versions` row
    (`version_no = COALESCE(max,0)+1`). Snapshots each line's `name_at_save` /
    `unit_at_save` / `cost_at_save` from the *current* ingredient. Computes
    `total_cost_cached = Σ qty×cost`, **NULL** if any line's cost is NULL.
    Repoints `recipes.current_version_id`. Single transaction (collect rows
    before exec).
  - **Validation:** `qty > 0` per line (400); `ingredientId` must exist (400);
    a line whose ingredient `is_active = false` is allowed **only if** it was
    present in the prior current version — a newly-added inactive ingredient →
    **400** `"Bahan nonaktif tidak bisa ditambahkan."`; zero items is allowed
    (clears the recipe).
- `POST …/recipe/versions/{versionId}/restore` → creates a new version from
  that snapshot's items (`qty`, `sortOrder`), **re-snapshotting name/unit/cost
  at today's prices**. Same optimistic-lock guard (body carries
  `expectedCurrentVersionId`). Restores immediately.

Go pure-function units (table-driven, mirroring SP-Recipe-1's `formatDocNo` /
`validateIngTransfer` tests): next `version_no`, `total_cost_cached`
null-propagation, optimistic-lock comparison, newly-added-inactive rejection,
restore re-snapshot mapping.

## OpenAPI + TS client (`packages/api`)

New schemas: `Recipe`, `RecipeVersionSummary`, `RecipeIngredientLine`,
`RecipeSaveInput` (+ `RecipeSaveItem`). Five new `Api` methods:
`getVariantRecipe`, `listRecipeVersions`, `getRecipeVersion`,
`saveVariantRecipe`, `restoreRecipeVersion`. `make gen-check` must stay green
(commit the regenerated `api.gen.go`). Apply the `$ref`+`nullable` gotcha:
treat `notes`, `expectedCurrentVersionId`, `costAtSave`, `totalCostCached`,
`defaultUnitCost` as optional/omittable in TS.

## Backoffice UI (`apps/backoffice/src/screens/recipes/`)

New feature folder: `RecipeSlideOver.tsx` (panel + header version selector),
`RecipeIngredientPicker.tsx` (autocomplete row), `VersionHistoryList.tsx`
(inline dropdown), and a small `useRecipe` data hook. Mounted from
`Products.tsx` variant rows.

- **Resep button** per variant row (between SKU/Barcode and the remove ✕, or
  appended). Enabled only when the variant has a saved `id`; otherwise disabled
  with tooltip "Simpan produk dulu." Filled/● when a recipe exists, outline
  when empty (derived from a lightweight "has recipe" flag — acceptable to
  fetch lazily on open for MVP; an existence map can be added later).
- **Slide-over** opens over the dimmed product modal (gold palette, consistent
  with SP-Recipe-1 components). Header: variant identity ("Parfum Aurora —
  50ml") + version pill ("Versi N (kini) ▾").
- **Version pill → inline dropdown** listing versions (version_no, date,
  author, notes). Selecting a past version loads it read-only with a banner
  ("Versi K — hanya-baca") + "Pulihkan ke versi ini" (immediate) + "Kembali ke
  versi kini."
- **Ingredient rows:** autocomplete over active ingredients by name OR SKU
  (reuse `listIngredients`), optional Kategori filter (reuse
  `listIngredientCategories`); fractional qty input; unit auto-filled
  (read-only display of the ingredient's unit); ⚠ badge when the line's
  ingredient is inactive **or** `onHandTotal < qty`; remove row.
- **Footer:** live cost estimate `Σ qty × current defaultUnitCost` (hidden if
  any line lacks a cost); "Catatan versi" textarea; "Simpan versi baru."
- **409 on save** → toast "Resep sudah diubah orang lain. Memuat ulang…" +
  auto-reload the current version.
- **Empty state:** a variant with no recipe → blank editor, pill reads "Belum
  ada versi"; first save creates version 1.
- Friendly Indonesian inline errors throughout (mirror `IngredientFormModal`).
  The stock-hint hydration is non-fatal: if it fails, hide hints rather than
  blocking the editor.

## Out of scope (MVP — deferred)

- Production / auto-deduct "Produksi" button — module-locked OUT.
- POS exposure of recipes — never.
- Recipe-level metadata beyond per-version notes (no base/middle/top-note
  fields, no photos, no steps).
- Per-warehouse stock breakdown in the hint (MVP shows total on-hand only).
- A bulk "which variants have recipes" existence map (MVP may lazy-check on
  open; can optimize later).

## Testing

- **Go pure-function units:** version_no increment; cost null-propagation;
  optimistic-lock compare; newly-added-inactive rejection; restore re-snapshot.
- **Live-API verify after deploy:** create recipe v1 → edit to v2 → restore v1
  → v3 (cost reflects today's prices) → concurrent save with a stale
  `expectedCurrentVersionId` → 409 → add an inactive ingredient → 400 → save a
  version that keeps a pre-existing inactive line → 200 → save zero-line
  version → 200 (clears).
- **Backoffice:** `npx tsc -b` clean; Playwright UI smoke (open slide-over from
  a variant row, add a line, save, switch to an old version, restore).

## Notes

User approved this design for the brainstorm stage and intends to run a
hands-on test before finalizing; expect possible refinements after that test.
The spec and plan live at
`docs/superpowers/{specs,plans}/2026-05-28-recipe-sp2-recipes-versioning*`.
Execution: subagent-driven development on `prod-hardening` directly (Cloudflare
auto-deploys backoffice; backend via `gcloud run deploy`; no APK — backoffice
only). Migration slot: **0021**.
