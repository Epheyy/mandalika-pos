# Recipe Variant Indicator (gold tint) — Design

Date: 2026-05-29 · Branch: `prod-hardening`

## Context

Follow-up to SP-Recipe-2. In the product edit modal, the **Resep** flask button
renders identically on every saved variant row whether or not that variant
actually has a recipe — so you can't tell which variants have one without
opening each. This adds an at-a-glance **gold-tint** indicator. **Backoffice
only**; no behavior change to recipes themselves. (This was the MVP cut
"recipe-exists ●/filled indicator" deferred in SP-Recipe-2.)

## Decision: how the UI knows which variants have a recipe

Three options were considered: (a) call `getVariantRecipe` once per variant on
modal open (N requests, wasteful), (b) fold a `hasRecipe` flag into the existing
product read (touches a hot, shared path), or (c) a dedicated lightweight
endpoint. **Chosen: (c)** — one small request per product-modal open, zero blast
radius on existing reads.

## Backend

New endpoint:

- `GET /api/v1/products/{productId}/recipe-variant-ids` → `{ "variantIds": ["<uuid>", …] }`
  - Gated `manage_inventory` + `recipes_enabled` (same group as the other
    recipe routes).
  - Read: the variant ids under this product that have a recipe row:
    `SELECT r.variant_id FROM recipes r JOIN product_variants v ON v.id = r.variant_id WHERE v.product_id = $1`.
    A `recipes` row only exists once a recipe has been saved (the row + version 1
    are created atomically in `SaveRecipe`), so existence == "has a recipe."
  - OpenAPI: one new schema `RecipeVariantIdsResponse { variantIds: string[] }`
    + one path; regen Go + TS; one TS client method `getRecipeVariantIds(productId)`.

## Backoffice UI (`apps/backoffice/src/screens/Products.tsx`)

- On `openEdit(product)` (only meaningful for an existing/saved product), and only
  when `recipesEnabled`, fetch `getRecipeVariantIds(product.id)` and store the
  result as a `Set<string>` in state (`recipeVariantIds`). Reset it when the
  modal closes / a different product opens. Non-fatal on error (empty set).
- The Resep flask per variant row:
  - **Has a recipe** (`variant.id ∈ recipeVariantIds`): gold-tinted —
    `text-gold-600` with a subtle gold fill (e.g. `bg-gold-50 rounded`), tooltip
    "Resep tersedia".
  - **No recipe**: current neutral outline (`text-gray-400`), tooltip "Belum ada resep".
  - **Unsaved variant** (`!variant.id`): unchanged — disabled, "Simpan produk dulu".
- After saving a recipe in the slide-over and closing it, refresh the set so a
  newly-created recipe tints immediately (re-fetch on slide-over `onClose`, or
  optimistically add the variant id to the set).

## Out of scope

Per-variant recipe version counts or any badge beyond has/has-not; changing the
recipe slide-over itself; POS.

## Testing

- Backend live verify: a variant with a recipe appears in `variantIds`; one
  without does not; flag-off → 404.
- Backoffice `tsc --noEmit` clean + build; visual check that the flask tints gold
  only for variants with a recipe and refreshes after a save.
