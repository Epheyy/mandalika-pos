# Recipe / Formula Module — SP-Recipe-1: Ingredient Inventory Subsystem — Design

Date: 2026-05-27 · Branch: `prod-hardening`

## Module context (the whole Recipe vision, for continuity)

The Recipe / Formula module ties a **production formula** to each product
variant — primarily for the **Flamboyan Perfume** and **Performance Perfume**
brands. The Mandalika POS codebase is a shared template used by all three
brands; Mandalika itself will not enable this module.

The module is decomposed into two sequenced sub-projects, each its own
spec → plan → build (matches the SP1–SP4 pattern from the Inventory module):

- **SP-Recipe-1 — Ingredient inventory subsystem** *(this spec)*: a parallel
  warehouse-stock subsystem for raw materials (fragrance oils, alcohol,
  fixatives, etc.) with fractional qty, plus ingredient transfers with
  printable surat jalan + tanda terima documents.
- **SP-Recipe-2 — Recipes & versioning** *(separate brainstorm + spec later)*:
  per-variant recipes with full version history, a slide-over editor inside
  the product modal, cost estimation, and live ingredient-stock visibility.
  Consumes SP-Recipe-1's ingredients catalog.

**Module-wide locked decisions** (apply across both SPs):

- **Scope = reference-only formula + live ingredient-stock view.** No
  auto-deduct on "produce"; recipe is documentation. Stock changes go through
  the existing ingredient ops (adjust, goods-in).
- **Ingredient model = separate `ingredients` table** with `numeric(14,3)`
  qty. Decoupled from `products` (no SKU/barcode/variants; ingredients are
  flat with a single unit).
- **Ingredient location = warehouses only.** Outlets are sales points; raw
  materials never live there. Ingredient transfers are always
  warehouse ↔ warehouse.
- **Recipes are per-variant** (not per-product): each variant (30ml / 50ml /
  100ml) has its own recipe row. Different bottle sizes typically have
  different proportions and packaging.
- **Recipe versioning = full history.** Each save creates a new
  `recipe_versions` row with ingredient snapshot (qty, unit, cost frozen at
  save time). UI shows a version dropdown; older versions are read-only;
  "Pulihkan" creates a new version from a snapshot.
- **POS exposure = none.** Recipes and ingredients are backoffice-only;
  `@mandalika/sync` is untouched.
- **Permissions = reuse `manage_inventory`** (existing). All ingredient and
  recipe operations gate behind this perm. Admin implicit.
- **Module gate = `app_settings.recipes_enabled boolean` DEFAULT false.**
  When off (Mandalika default), the Bahan tab and the Resep slide-over hide
  entirely and the routes return 404. When on (Flamboyan / Performance
  deployments), the module surfaces.
- **Cost = informational only.** No COGS, no valuation. Each
  `ingredient.default_unit_cost` is editable; goods-in carries
  `unit_cost` per line (informational, like existing product goods-in).
  Recipe screen shows "Estimasi biaya bahan: Rp X" computed from
  `qty × default_unit_cost`, hidden if any ingredient lacks a cost.

**Deferred to SP-Recipe-2** (do NOT design here): the `recipes`,
`recipe_versions`, `recipe_ingredients` tables; the slide-over editor; cost
estimation UI; version restore action.

Status note: the app is deployed on free-tier infra but runs **test data
only** (not real sales) — standard deploy hygiene applies, no kid-gloves.

---

## SP-Recipe-1 goal

Add a parallel **ingredient inventory subsystem** to the backoffice:
ingredients CRUD, per-warehouse stock with fractional qty, goods-in, manual
adjust, warehouse ↔ warehouse transfers (with surat jalan + tanda terima
PDF/PNG share, mirroring SP4), and opname. Entirely backoffice; no POS;
gated by `manage_inventory` + `recipes_enabled`.

## Current-state facts (verified)

- `warehouses` (SP1) shape: `id`, `name`, `code?`, `address?`, `phone?`,
  `logo_url?`, `is_active`, `created_at`. Ingredients reuse these
  warehouses unchanged.
- Existing inventory tables for products carry **integer** stock. Ingredients
  get a **parallel** store with `numeric(14,3)` qty so fractional grams /
  ml work natively.
- SP4 introduced `doc_sequences (kind, year, next_seq)` plus
  `nextDocNo(kind, year)` and `formatDocNo(kind, year, seq)` helpers
  (currently for `surat_jalan` / `tanda_terima` of product transfers). The
  helpers are pure and extend cleanly: SP-Recipe-1 adds two new
  `kind` values — `ingredient_sj` and `ingredient_tt` — formatted as
  `ISJ-yyyy-NNNNN` and `ITT-yyyy-NNNNN`.
- SP4 backoffice components: `SuratJalanPanel.tsx`, `SuratJalanDoc.tsx`,
  `render.ts` (html-to-image + jsPDF + Web Share API + anchor-download
  fallback). SP-Recipe-1 clones this pattern for ingredient transfers (no
  POS thermal print — ingredient transfers never reach a POS).
- Existing letterhead resolution on a product transfer:
  `transferObj` server-side COALESCE-resolves sender/receiver letterheads
  from outlet/warehouse `address` + `phone` + `logo_url`, falling back to
  `app_settings.documents_*`. Ingredient transfers reuse this same
  resolution since both legs are warehouses.
- Permissions: `manage_inventory` already exists (SP1). No new perm.
- `app_settings` row is a singleton; columns are added via ALTER TABLE.

## Data model — new migration `0019_ingredients.sql`

(0018 is current highest. This migration covers SP-Recipe-1 only;
SP-Recipe-2 will add the recipe tables in a later migration, e.g. 0020.
`doc_sequences` is *not* altered — it is already polymorphic on `kind`,
and the SP4 `nextDocNo` helper inserts a new row on first use via
`ON CONFLICT`. Two new `kind` literals (`ingredient_sj`,
`ingredient_tt`) are introduced by the Go helper only.)

```sql
-- Module gate (singleton settings row gets one extra column)
ALTER TABLE app_settings ADD COLUMN recipes_enabled boolean NOT NULL DEFAULT false;

-- Ingredients catalog (flat — no variants)
CREATE TABLE ingredients (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text NOT NULL,
  unit                text NOT NULL,                 -- 'g'|'ml'|'L'|'kg'|'drop'|'pcs' etc, free-form
  default_unit_cost   numeric(14,2),                 -- nullable; informational
  notes               text,
  is_active           boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_ingredients_active_name ON ingredients(is_active, name);

-- Per-warehouse stock (fractional)
CREATE TABLE ingredient_warehouse_stock (
  warehouse_id  uuid NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  ingredient_id uuid NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  qty           numeric(14,3) NOT NULL DEFAULT 0,
  PRIMARY KEY (warehouse_id, ingredient_id)
);

-- Goods-in for ingredients (additive)
CREATE TABLE ingredient_goods_receipts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id uuid NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  supplier     text,
  note         text,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ingredient_goods_receipt_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id    uuid NOT NULL REFERENCES ingredient_goods_receipts(id) ON DELETE CASCADE,
  ingredient_id uuid NOT NULL REFERENCES ingredients(id),
  qty           numeric(14,3) NOT NULL,
  unit_cost     numeric(14,2)                                  -- informational only
);

-- Manual adjust (absolute set + reason)
CREATE TABLE ingredient_stock_adjustments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id  uuid NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  ingredient_id uuid NOT NULL REFERENCES ingredients(id),
  new_qty       numeric(14,3) NOT NULL,                        -- absolute on-hand after
  reason        text NOT NULL,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Warehouse-to-warehouse transfers, two-step (send → receive) with discrepancy.
-- Mirrors SP2 `transfers` (Postgres SEQUENCE for the short id; transfer-level
-- discrepancy_reason; per-item received_qty + computed difference).
CREATE SEQUENCE IF NOT EXISTS ingredient_transfer_no_seq;

CREATE TABLE ingredient_transfers (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_no              text NOT NULL DEFAULT ('ITRF-' || lpad(nextval('ingredient_transfer_no_seq')::text, 5, '0')),
  source_warehouse_id      uuid NOT NULL REFERENCES warehouses(id),
  dest_warehouse_id        uuid NOT NULL REFERENCES warehouses(id),
  status                   text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','in_transit','completed','cancelled')),
  surat_jalan_no           text UNIQUE,                         -- ISJ-yyyy-NNNNN, stamped at send
  tanda_terima_no          text UNIQUE,                         -- ITT-yyyy-NNNNN, stamped at receive
  note                     text,
  discrepancy_reason       text,                                -- transfer-level (SP2 parity), required when any item differs
  created_by               uuid,
  created_at               timestamptz NOT NULL DEFAULT now(),
  sent_at                  timestamptz,
  sent_by                  uuid,
  received_at              timestamptz,
  received_by              uuid,
  cancelled_at             timestamptz,
  cancel_reason            text,
  CONSTRAINT ingredient_transfers_distinct CHECK (source_warehouse_id <> dest_warehouse_id)
);
CREATE INDEX idx_ingredient_transfers_status ON ingredient_transfers(status);

CREATE TABLE ingredient_transfer_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id   uuid NOT NULL REFERENCES ingredient_transfers(id) ON DELETE CASCADE,
  ingredient_id uuid NOT NULL REFERENCES ingredients(id),
  sent_qty      numeric(14,3) NOT NULL,
  received_qty  numeric(14,3),                                  -- null until receive
  difference    numeric(14,3)                                   -- received_qty − sent_qty, set at receive
);
CREATE INDEX idx_ingredient_transfer_items_transfer ON ingredient_transfer_items(transfer_id);

-- Opname / stock-count for ingredients (warehouse-only)
CREATE TABLE ingredient_stock_counts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  status        text NOT NULL CHECK (status IN ('planned','in_progress','completed','cancelled')),
  warehouse_id  uuid NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  planned_date  date,
  notes         text,
  created_by    uuid,
  started_at    timestamptz,
  completed_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ingredient_stock_count_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stock_count_id  uuid NOT NULL REFERENCES ingredient_stock_counts(id) ON DELETE CASCADE,
  ingredient_id   uuid NOT NULL REFERENCES ingredients(id),
  ingredient_name text NOT NULL,                                -- snapshot at start (rename-safe)
  ingredient_unit text NOT NULL,                                -- snapshot
  counted         numeric(14,3),                                -- null until saved
  difference      numeric(14,3)                                 -- counted − frozen_qty, on complete
);
```

## Behavior / data flow

- **Module gate:** every ingredient endpoint checks `app_settings.recipes_enabled`
  at handler entry and returns **404** when false (not 403, so deployments
  without the module look like the routes don't exist). The backoffice
  hides the Bahan tab + Settings toggle visibility when the existing
  `GET /app-settings` response carries `recipesEnabled = false`. POS is
  not in scope (recipes/ingredients never sync to outlets).
- **Goods-in** (`POST /ingredients/goods-receipt`): create a receipt + items
  in one tx; each line does
  `INSERT … ON CONFLICT (warehouse_id, ingredient_id) DO UPDATE SET qty = ingredient_warehouse_stock.qty + EXCLUDED.qty`.
  Additive only.
- **Adjust** (`POST /ingredients/adjust`): set absolute `new_qty (≥0)` with a
  required reason; upserts `ingredient_warehouse_stock` to `new_qty` and
  logs an `ingredient_stock_adjustments` row.
- **Transfer send** (`POST /ingredient-transfers/{id}/send`): validate
  source on-hand ≥ each `sent_qty`; deduct source in tx; stamp
  `status = in_transit`, `sent_at`, `sent_by`, `surat_jalan_no =
  formatDocNo('ingredient_sj', year, nextDocNo(...))`.
- **Transfer receive** (`POST /ingredient-transfers/{id}/receive`): take
  `received_qty` per line and compute `difference = received_qty − sent_qty`
  per line. When any line has a non-zero `difference`, the transfer-level
  `discrepancy_reason` is required (400 otherwise — matches SP2 product
  transfer behaviour). Credit dest with the actual `received_qty` in tx;
  stamp `status = completed`, `received_at`, `received_by`,
  `tanda_terima_no = formatDocNo('ingredient_tt', year, ...)`. Idempotent
  on a replay (same id + already-completed → return current state, do not
  re-credit; no `received_idempotency_key` column needed since there's no
  POS sync engine — handler-level state check is sufficient).
- **Transfer cancel** (`POST /ingredient-transfers/{id}/cancel`): draft →
  void; in-transit → restore source qty in tx and mark cancelled with a
  `cancel_reason`.
- **Opname**: same create → start → save → complete flow as the existing
  warehouse opname; on **complete**, write counted qty into
  `ingredient_warehouse_stock` and record each line's `difference`.
  Snapshot `ingredient_name` + `ingredient_unit` at start so a later rename
  or unit change doesn't break the historical record.
- No `content_version` bump anywhere (POS is not in the picture).
- Letterhead resolution on an ingredient transfer DTO: reuse the SP4
  COALESCE pattern. Both legs are warehouses; both fall back to
  `app_settings.documents_*`. New helper `resolveIngredientTransferDoc`
  produces the same letterhead shape SP4 uses, so the cloned
  `SuratJalanDoc` component renders unchanged.

## Components / boundaries

| Unit | Responsibility | Depends on |
|---|---|---|
| migration `0019` | ingredient tables + `recipes_enabled` flag + new doc-sequence kinds (data-only; helpers extend) | warehouses, app_settings, doc_sequences |
| openapi + codegen | `Ingredient`, `IngredientWarehouseStockRow`, `IngredientGoodsReceiptInput`, `IngredientAdjustInput`, `IngredientTransfer{,Input}`, `IngredientStockCount{,Item}`, plus `AppSettings.recipesEnabled` | — |
| write repo (`ingredient.go`) | ingredients CRUD, goods-in, adjust | schema |
| write repo (`ingredient_transfer.go`) | send / receive / cancel + doc stamping | `nextDocNo` (extended) |
| write repo (`ingredient_stockcount.go`) | create / start / save / complete | ingredient_warehouse_stock |
| read repo | list ingredients, ingredient warehouse-stock matrix, transfer detail w/ letterheads | schema |
| handlers | route + `manage_inventory` gate + `recipes_enabled` 404 gate | write/read |
| backoffice `Gudang` → new `Bahan` tab | `Daftar` / `Stok` / `Stok Masuk` / `Penyesuaian` / `Transfer` / `Opname` inner tabs | API types |
| backoffice `SuratJalanIngredientPanel` | clone of SP4 `SuratJalanPanel` for ingredient transfers | render.ts (reused) |
| backoffice `SettingsScreen` | "Resep & Bahan" section with the on/off toggle (admin) | API |

## API (gated by `manage_inventory` + `recipes_enabled` → else 404)

**Ingredients catalog**
- `GET /ingredients`, `POST /ingredients`, `PUT/DELETE /ingredients/{id}`

**Stock**
- `GET /ingredients/stock?warehouseId=` — ingredients × on-hand qty
- `POST /ingredients/goods-receipt` — `{ warehouseId, supplier?, note?, items:[{ingredientId, qty, unitCost?}] }`
- `POST /ingredients/adjust` — `{ warehouseId, ingredientId, newQty, reason }`

**Transfers**
- `GET /ingredient-transfers` (filterable), `GET /ingredient-transfers/{id}`
- `POST /ingredient-transfers` — create draft `{ sourceWarehouseId, destWarehouseId, items:[...], note? }`
- `POST /ingredient-transfers/{id}/send`
- `POST /ingredient-transfers/{id}/receive` — `{ items:[{itemId, receivedQty, discrepancyReason?}] }`
- `POST /ingredient-transfers/{id}/cancel` — `{ reason }`

**Opname**
- Same shape as the existing warehouse opname endpoints, namespaced under
  `/ingredient-stock-counts/...`. Reuse the create / start / save / complete
  flow (separate handlers, not polymorphic on the existing ones — keeps
  blast radius zero).

**Settings**
- `PUT /app-settings` already exists; extend its body with
  `recipesEnabled: boolean`.

## Backoffice UI

- **Gudang screen** gets a third tab "Bahan", visible only when
  `recipes_enabled = true`. Inside Bahan, an inner tab strip:
  - **Daftar** — ingredients CRUD (name + unit + default cost + notes +
    active).
  - **Stok** — warehouse × ingredient matrix with on-hand qty; warehouse
    picker at the top.
  - **Stok Masuk** — goods-in form + history list.
  - **Penyesuaian** — adjust form + history list.
  - **Transfer** — clone of the existing product Transfer tab; lists
    ingredient transfers; create / send / receive / cancel; the **inline
    surat jalan panel** appears under the detail header after a send (uses
    the cloned `SuratJalanIngredientPanel` for Bagikan / Unduh PDF / Unduh
    PNG / Lihat — same UX as SP4).
  - **Opname** — clone of the existing warehouse opname, scoped to
    ingredients.
- **Settings → Pengaturan** gains a "Resep & Bahan" admin-only toggle that
  flips `recipes_enabled`.

## Error handling

- Validate ingredient exists/active; qty > 0 on goods-in items;
  `new_qty ≥ 0` and required reason on adjust; non-empty item lists on
  transfer create.
- Self-transfer (source == dest) → 400 by CHECK constraint + handler
  short-circuit.
- Oversend (qty > source on-hand) → 400 with the offending line(s).
- Receive without a transfer-level `discrepancy_reason` when any line's
  `received_qty <> sent_qty` → 400.
- Cancelling a `completed` transfer → 400 (no-op).
- Module flag off → 404 on every ingredient/transfer/opname endpoint
  (handler-level early return).
- Deleting an ingredient cascades stock/receipts/adjustments/transfer-items;
  block if it is currently referenced by an *in-transit* transfer.
- Unknown ingredient in a line → reject with a clear message.

## Testing

Follow the SP1–SP4 pattern:
- Pure-function Go tests: extend `formatDocNo` table-tests for
  `ingredient_sj` / `ingredient_tt`; new tests for the ingredient transfer
  validation helpers (oversend, self-transfer, discrepancy-required).
- Handler-level Go tests for the 404-when-disabled gate.
- Backoffice JS tests (vitest, where the package has it): doc-no formatter
  + transfer mapper tests. The backoffice doesn't currently have vitest
  globally; SP4 added it locally to `packages/printer`. For SP-Recipe-1,
  add vitest to `apps/backoffice` (carry over the SP4 config) only if a
  pure helper genuinely needs it — otherwise live verification covers the
  UI surface.
- Live verification on `prod-hardening`: deploy migration 0019 → admin
  flips `recipes_enabled = true` → create two ingredients → goods-in into
  W1 → adjust shrinkage → create transfer W1 → W2 → send → verify
  `ISJ-2026-00001` stamped + sender/receiver letterheads resolved →
  receive with shortfall + reason → verify `ITT-2026-00001` stamped + dest
  credited with the actual qty → cancel an in-transit transfer (separate
  one) → verify source restored → opname W1 → complete → verify on-hand
  matches counted.

## Out of scope (SP-Recipe-1)

- Recipes themselves (`recipes`, `recipe_versions`, `recipe_ingredients`),
  the slide-over editor, cost-estimation UI, version restore action — all
  SP-Recipe-2.
- Auto-deduct on a "Produksi" button — explicitly chosen out (module-wide
  decision; revisit only if user changes mind).
- POS exposure of ingredients or recipes — none.
- Ingredient sync to outlets — never (warehouse-only domain).
- COGS / inventory valuation.
- Suppliers as entities, purchase orders.
- Per-warehouse staff binding for ingredients (reuses existing
  `manage_inventory`).
- POS-side thermal print of an ingredient tanda terima — N/A (POS doesn't
  see ingredient transfers).
- Multi-unit conversions per ingredient (e.g., buy in kg, use in g) — each
  ingredient has a single unit; user converts manually when entering.
- CSV import/export for ingredients — defer to a Phase 2 once volume
  justifies it.

## Plan phasing hint

**A:** migration 0019 + openapi + `recipes_enabled` flag + ingredients CRUD
+ ingredient_warehouse_stock + read/stock view.
**B:** goods-in + adjust.
**C:** ingredient transfers — send + receive + cancel + idempotency, plus
extend `nextDocNo` / `formatDocNo` for the two new kinds.
**D:** ingredient opname (create / start / save / complete).
**E:** backoffice UI — Bahan tab + inner tabs + cloned
`SuratJalanIngredientPanel` + Settings toggle + live verification.
