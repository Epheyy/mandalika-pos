# Product Add/Edit Enhancements — Implementation Plan

> REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use `- [ ]`; update+commit as you go (durable resume point). Rules: ask don't assume; don't touch unrelated; flag uncertainty; verify on failure; show changes; admit gaps.

**Goal:** Add four fields to the existing single-modal product editor (NOT a wizard): per-outlet **PAR level**, **UPC/barcode**, **"Jual ke pelanggan" sellable flag**, and **multiple images (up to 5)**. Wire PAR into the Dashboard "Barang Habis". Keep the live sale path untouched.

**Context:** This project is a template for 3 perfume brands; Inventory (warehouse transfers) + Recipe/Formula are planned later — design the sellable flag as the first slice of a future product-type model. (See memory `product-module-roadmap`.)

**Data model:**
- `products`: add `upc text DEFAULT ''`, `sellable boolean DEFAULT true`, `images jsonb DEFAULT '[]'` (array of urls; `[0]` = main, kept in sync with `image_url`).
- `outlet_variant_stock.par_level` already exists (migration 0010) — just expose/edit it.

**Behavior:**
- `sellable=false` → product hidden from POS everywhere (sync filters it); still shown in backoffice (with an "Internal" badge).
- PAR: Dashboard low-stock = `stock <= par` (per outlet); fall back to 5 when no par set.
- Multi-image: main = first; reorder + remove in the modal.

---

## Task 1: Migration 0013
Create `backend/internal/db/migrations/0013_product_upc_sellable_images.sql`:
```sql
ALTER TABLE products ADD COLUMN IF NOT EXISTS upc      text    NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN IF NOT EXISTS sellable boolean NOT NULL DEFAULT true;
ALTER TABLE products ADD COLUMN IF NOT EXISTS images   jsonb   NOT NULL DEFAULT '[]'::jsonb;
-- seed images from the existing single image_url
UPDATE products SET images = jsonb_build_array(image_url)
 WHERE image_url IS NOT NULL AND image_url <> '' AND images = '[]'::jsonb;
```
- [ ] write + commit.

## Task 2: OpenAPI + regen
- `Product`: add `upc` (string), `sellable` (boolean), `images` (array of string).
- `ProductInput`: add `upc`, `sellable`, `images`.
- `ProductVariant`: add `parLevel` (integer, nullable) — resolved per outlet on scoped reads.
- `OutletVariantConfig`: add `parLevel` (integer, nullable).
- Regen Go (`make gen-go`); commit `api.gen.go`.

## Task 3: Backend read (`read/repo.go`)
- `productObjScoped` BOTH branches: add `'upc',p.upc,'sellable',p.sellable,'images',p.images`.
- Scoped branch only: add `'parLevel',(SELECT op.par_level FROM outlet_variant_stock op WHERE op.outlet_id=$1 AND op.product_id=v.product_id AND op.variant_size=v.size)` to the variant object (null when none). (CrossAll: omit/null.)
- `ProductOutletConfig`: add `'parLevel', s.par_level` to the matrix row.
- POS sellable filter: add `SellableOnly bool` to `read.Scope`; in `Products`, when set, append `AND p.sellable`. In `sync.Pull`, set `sc.SellableOnly = true` before `Read.Products`. (Backoffice scope() leaves it false → shows all.)

## Task 4: Backend write (`write/repo.go`)
- `Product` struct: add `UPC string`, `Sellable bool`, `Images []string` (json: upc/sellable/images).
- `CreateProduct`/`UpdateProduct`: persist upc, sellable, and `images` (json-encode; also set `image_url = images[0] or ''` for back-compat).
- `SetProductOutletConfig`: include `par_level` in the `outlet_variant_stock` upsert from `OutletVariantConfig.parLevel` (null allowed). Add `ParLevel` handling — the gen type is `nullable.Nullable[int]` (or *int); write null when unset.

## Task 5: Deploy backend + verify
- `make gen-check && go vet && gofmt -l && go build && go test`; deploy; `/readyz`.
- Verify: product read returns upc/sellable/images; set par via outlet-config → GET shows it; set sellable=false → product absent from a POS sync pull (use the cashier flow or check the scoped read with SellableOnly) but present in admin list.

## Task 6: Frontend (`packages/api` regen + `Products.tsx`, `screens/dashboard/metrics.ts`)
- Regen TS client.
- Form: add `upc`, `sellable`, `images: string[]`; EMPTY → `upc:'', sellable:true, images:[]`; openEdit sets them from the product.
- Modal: UPC input (near category); **"Dijual ke pelanggan"** toggle in the active/featured row; replace single image with **multi-image** (upload appends, thumbnails with remove + move-to-first; main = images[0]).
- save body: include upc, sellable, images.
- Per-outlet table: add a **PAR** number input per variant row (ocfgMap carries parLevel; items include parLevel; show 0/empty like stock).
- CSV importer: set `sellable: true` (or from an optional 'Jual' column), keep images empty.
- List: small **"Internal"** badge when `!sellable`.
- Dashboard `metrics.lowStock`: use `stock <= (variant.parLevel ?? 5)`; `productRanking`/Barang Habis source the scoped `parLevel`.

## Task 7: build/deploy/verify UI + update memory/checkboxes.

## Progress / resume notes
- **DONE & VERIFIED LIVE (2026-05-24, backend rev 00018-sdc, frontend 1cf9d7a).** Migration
  0013 (upc/sellable/images on products; par_level already existed from 0010). Verified: UPC +
  images persist; sellable=false hides the product from POS sync, sellable=true shows it
  (clean re-pull confirmed); per-outlet PAR round-trips on outlet-config + the scoped product
  read; Dashboard Barang Habis uses per-outlet PAR (fallback 5). Single modal kept (no wizard):
  multi-image strip (≤5, reorder, first=main), UPC field, "Dijual ke pelanggan" toggle,
  per-outlet PAR column, "Internal" list badge; CSV export/import carry UPC + Jual.
- Note (Rule 6): a sellable-toggle write then an *immediate* cashier sync pull can briefly read
  stale (pooled-connection visibility lag); self-corrects on next pull — not a real issue.
  POS sync filters via `read.Scope.SellableOnly` (set in sync.Pull).
- Roadmap (memory `product-module-roadmap`): Inventory (warehouse transfers) + Recipe/Formula
  modules planned next for the multi-brand template.
