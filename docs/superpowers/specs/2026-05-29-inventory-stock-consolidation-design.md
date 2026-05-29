# Inventory Stock Consolidation — Design

Date: 2026-05-29 · Branch: `prod-hardening`

## The 6 working rules (carry into the plan + implementation)

1. Ask, don't assume · 2. Don't touch unrelated · 3. Flag uncertainty ·
4. Verify on failure · 5. Show changes · 6. Admit gaps.

## Context

Today, product **stock** lives in two different homes:

- **Outlet (POS) stock** is managed inside the **Product** module — the
  `Products.tsx` edit modal renders a "Stok & Harga per Outlet" matrix with four
  per-outlet columns: **Stok · Harga · Jual (availability) · PAR**. This stock is
  POS-synced and is what the cashier sells from.
- **Warehouse stock** lives in the **Gudang** module (`Warehouses.tsx`): pick a
  warehouse → a stock table with **Barang Masuk** (goods-in, additive) + **Koreksi**
  (adjust-to-absolute + required reason). Never POS-synced.
- **Ingredient stock** lives in the **Bahan** tab (per-warehouse, flag-gated).

The goal: make **Inventory the single home for all product (and ingredient) stock
across every outlet and warehouse**, so stock is no longer managed inside the
Product module. The Product module returns to being catalog + merchandising
(price, availability, images) only.

This is primarily a **UI/UX reorganization** with a focused backend addition
(outlets gain the same auditable goods-in/adjust operations warehouses already
have). No stock data is relocated — `outlet_variant_stock` and
`warehouse_variant_stock` already exist; this changes *where stock is managed and
viewed*, not where it is stored.

## Locked decisions (from brainstorm, 2026-05-29)

1. **What moves out of the Product module:** **Stock + PAR**. Price (Harga) and
   "Jual" (availability) **stay** in the product modal as merchandising.
2. **Layout:** location-first drill-down as the **primary** view, plus a
   read-only **Overview matrix** (variant × location) as a second sub-view.
3. **Outlet editing model:** **same as warehouses** — outlets get **Barang Masuk**
   (goods-in, additive) + **Koreksi** (adjust-to-absolute + required reason),
   fully auditable. This replaces the old free-typed number.
4. **Module:** rename **`Gudang` → `Inventori`**; **fold the standalone "Stock
   Count" (Opname) screen in as a tab**. Tabs: **Stok Produk · Transfer · Bahan ·
   Opname**.
5. **Create form:** **remove the base "Stok" field** per variant. New variants
   start at 0 everywhere; stock is only ever set in Inventori.

## Approach: location-polymorphic stock operations

Generalize the warehouse goods-in/adjust write path to accept a **location target
`{kind: "outlet" | "warehouse", id}`** instead of a warehouse-only id — mirroring
the SP1 precedent where `stockcount.go` and `LocationStock` were made
location-polymorphic. Reads reuse the existing polymorphic `LocationStock`
(`getTransferLocationStock`). When `kind == "outlet"`, the write targets
`outlet_variant_stock` **and bumps that outlet's `content_version`** (POS resync);
when `kind == "warehouse"`, it targets `warehouse_variant_stock` with **no bump**
(warehouses aren't POS-synced).

Alternatives considered: (a) a parallel set of outlet-only endpoints — more
duplication, two code paths to keep in sync; (b) keep writing outlet stock through
`updateProductOutletConfig` — rejected: not auditable (no reason / no goods-in
record) and conflates stock with the price write. The polymorphic approach reuses
one validated pattern already in the codebase.

---

## A. Module & navigation

- `apps/backoffice/src/App.tsx`: the nav item `{ id: 'warehouses', label: 'Gudang' }`
  becomes `label: 'Inventori'` (icon unchanged or a boxes/inventory icon). The
  standalone `{ id: 'stock', label: 'Stock Count', perm: 'manage_stock_count' }`
  item is **removed from the top-level rail**; its screen moves inside Inventori as
  the **Opname** tab.
- **Permission gating (flag this):** the Inventori module is reached today only
  with `manage_inventory`. Because Opname uses `manage_stock_count`, a stock-count-only
  user would otherwise lose access. **Resolution:** the Inventori nav item is
  visible if the user has `manage_inventory` **OR** `manage_stock_count`, and each
  tab is individually permission-gated (Stok Produk / Transfer require
  `manage_inventory`; Bahan requires `manage_inventory` + `recipes_enabled`; Opname
  requires `manage_stock_count`). A user lands on the first tab they're allowed to see.
- `Warehouses.tsx` (the `Gudang` component) gains a `stok` tab and an `opname` tab.
  Tab order: **Stok Produk · Transfer · Bahan · Opname**. The existing "Gudang"
  warehouse-list/stock view becomes a **sub-view of Stok Produk** (see B), no longer
  a standalone tab.

## B. Stok Produk → "Lokasi" (primary sub-view)

A location list → drill into one location → its per-variant stock table.

- **Location list:** grouped into **Outlet** and **Gudang** sections,
  icon-distinguished (🏬 outlet / 🏭 warehouse). Outlets come from `listOutlets`,
  warehouses from `listWarehouses`. Inactive locations dimmed.
- **Per-location stock table:** reuses the existing `LocationStock` read
  (`getTransferLocationStock(kind, id)` → `WarehouseStockRow[]`: productName,
  variantSize, sku, stock). Columns: **Produk · Ukuran · SKU · Stok · [PAR] · Aksi**.
  - **Barang Masuk** (goods-in) button → the generalized goods-in modal (multi-line),
    targeting this location.
  - **Koreksi** per row → the generalized adjust modal (set absolute + required reason).
  - **PAR column shows for outlets only.** It is an inline-editable low-stock
    threshold per (outlet, variant), persisted via a focused PAR write (see E).
    Warehouses have no PAR (unchanged).
  - Low-stock styling: an outlet row whose stock ≤ PAR is flagged (red badge),
    same threshold the Dashboard "Barang Habis" uses.
- The existing warehouse `GoodsInModal` / `AdjustModal` (in `screens/warehouses/`)
  are generalized to accept a `{ kind, id, name }` location instead of a `Warehouse`,
  and call the polymorphic endpoints. Outlet and warehouse share the same modals.

## C. Stok Produk → "Overview" (second sub-view)

- **Read-only** matrix: rows = active product variants, columns = every active
  location (outlets then warehouses), cells = on-hand, plus a **Total** column.
- Backed by a **new single read** (E) so it's one request, not N per-location calls.
- Low-stock cells (outlet cell where stock ≤ that outlet's PAR) render red.
- Interaction: click a row → that variant filtered/highlighted; click a column
  header → jump to that location's Lokasi drill-down. (Navigation convenience only;
  no editing here.)
- Wide-table handling: horizontal scroll with a sticky first column (Varian) and
  sticky Total column.

## D. Product module changes (`apps/backoffice/src/screens/Products.tsx`)

- The per-outlet matrix heading "Stok & Harga per Outlet" → **"Harga & Ketersediaan
  per Outlet"**. Remove the **Stok** and **PAR** inputs/columns; keep **Harga** and
  **Jual (available)**.
- Remove the base **Stok** field from the variant rows in the **create/edit** form
  (and from `EMPTY_VARIANT`). Remove the "Stok diatur per outlet…" helper note (now
  obsolete) or reword to point at Inventori.
- CSV import/export: the **Stok** column is removed from the product importer/exporter
  (stock is no longer a product attribute). *(Flag: confirm whether existing import
  templates in the wild rely on a Stok column — for a test-data deployment this is
  safe; document the change.)*
- `getProductOutletConfig` still returns price/availability for the matrix; the
  `stock`/`parLevel` fields it returns are simply not rendered by the modal anymore
  (see E for the write decoupling).

## E. Backend

**E1. Polymorphic goods-in + adjust (write).**
- Generalize so the target is `{kind, id}`. Reuse `validLocKind` (already exists in
  `transfer_logic.go`).
- **Goods-in:** when `kind=="warehouse"` → existing `warehouse_variant_stock` +
  `goods_receipts(_items)` path via `noBumpTx`. When `kind=="outlet"` → insert into
  the outlet's goods-in log (new table or reuse — see E4) and upsert
  `outlet_variant_stock` **stock only** (`ON CONFLICT … DO UPDATE SET stock =
  outlet_variant_stock.stock + EXCLUDED.stock`), inside a tx that calls
  `bumpVersionOutlets(ctx, tx, "products", []string{outletID})`.
- **Adjust (Koreksi):** same split. Outlet adjust upserts `outlet_variant_stock`
  **stock only** to the absolute `newQty` (preserving `available` + `par_level`),
  logs the correction, and bumps the outlet version. Validation identical to
  warehouse: reason required (400 "alasan wajib diisi"), `newQty >= 0`
  (400 "stok tidak boleh negatif").
- **Critical:** outlet upserts must **never clobber `available` / `par_level`** —
  only the `stock` column. (The product-outlet-config write owns `available`; the
  PAR write owns `par_level`.)

**E2. Overview matrix (read).** New read returning `{ locations: [{id, kind, name}],
rows: [{ productId, variantSize, productName, sku, cells: {<locationId>: stock},
total }] }`, with each outlet cell optionally carrying the outlet's `par_level` for
low-stock coloring (or a precomputed `belowPar` flag). One query over
`product_variants` LEFT JOIN `outlet_variant_stock` + `warehouse_variant_stock`.

**E3. Decouple stock from the product-outlet-config write.** The
`updateProductOutletConfig` / `SaveProductOutletConfig` path currently upserts
`stock, available, par_level` together (`repo.go` ~L349). Change it so a product
save **only writes price + available** and **does not touch `stock` or `par_level`**
(omit those columns from the upsert / `ON CONFLICT DO UPDATE` set list). This
guarantees editing a product never resets stock or PAR. The OpenAPI
`OutletConfigInput` drops `stock` and `parLevel` (or makes them ignored on write).

**E4. PAR write (focused).** A small endpoint to set `par_level` per
(outletId, productId, variantSize) — upsert `outlet_variant_stock` **par_level
only**. Used by the inline PAR edit in the Lokasi outlet view. No version bump
needed (PAR is a backoffice/dashboard threshold, not POS-synced sale data —
**flag: confirm POS doesn't consume PAR**; if it does, bump).

**E5. OpenAPI / codegen.** New/changed schemas + paths for E1/E2/E4; drop
`stock`/`parLevel` from `OutletConfigInput` (E3). Regenerate Go (`oapi-codegen`) +
TS (`@mandalika/api gen`); commit `api.gen.go` (CI `make gen-check` gate).

**E6. Goods-in log table for outlets (decision).** Warehouses log goods-in to
`goods_receipts(_items)` (warehouse-scoped FK). Two options for outlets:
(a) add nullable polymorphic columns / a parallel `outlet_goods_receipts` table, or
(b) make the goods-in log location-polymorphic. **Recommended:** the minimal
migration that lets the existing log carry an outlet target (mirror how
`transfers` use nullable `source_outlet_id`/`source_warehouse_id`). The plan will
finalize the exact table shape; **this is the one likely migration** (provisionally
**0022**). Adjust logs (`warehouse_stock_adjustments`) get the same treatment or an
outlet-polymorphic equivalent.

## F. Data integrity & POS sync

- **POS resync:** every outlet stock mutation (goods-in, koreksi) bumps that
  outlet's `content_version` under `"products"` so cashiers re-sync the new on-hand,
  exactly as transfers do. Warehouse mutations do **not** bump.
- **Concurrency:** writes are single-tx upserts; last-write-wins on absolute adjust
  (same as warehouse today). No optimistic lock needed for stock set.
- **Stock never negative;** goods-in additive; adjust absolute ≥ 0.
- Friendly Indonesian 400s consistent with the existing warehouse messages.

## G. Permissions summary

| Surface | Permission |
|---|---|
| Inventori nav item visible | `manage_inventory` OR `manage_stock_count` |
| Stok Produk (Lokasi + Overview), Transfer | `manage_inventory` |
| Bahan | `manage_inventory` + `recipes_enabled` |
| Opname tab | `manage_stock_count` |
| Product price/availability matrix (stays in Produk) | `manage_products` |

## H. Testing

- **Go unit tests:** location-target validation (`{kind,id}` valid/invalid → 400);
  outlet goods-in increments stock + bumps version; outlet adjust sets absolute +
  preserves `available`/`par_level` + bumps version; warehouse path unchanged
  (no bump); reason/negative validation.
- **Live API verify (deployed rev):** outlet goods-in 0→N, koreksi→M with reason,
  no-reason→400, negative→400; confirm `content_version` bumped for that outlet
  (POS would resync); warehouse goods-in/koreksi still work and do NOT bump; Overview
  matrix totals match per-location reads.
- **Backoffice UI (Playwright + user walkthrough):** Inventori tabs render; Lokasi
  list groups outlets+warehouses; drill-in shows stock; Barang Masuk + Koreksi work
  for an outlet; PAR inline edit persists (outlets only); Overview matrix renders
  with low-stock coloring + drill navigation; product modal no longer shows Stok/PAR;
  create form has no Stok field; Opname tab works; Stock Count removed from top nav;
  permission gating (stock-count-only user still reaches Opname).
- **POS regression:** after an outlet koreksi in Inventori, the POS reflects the new
  on-hand after sync (this is the load-bearing correctness check — verify on device
  or via a sync pull).

## I. Out of scope / deferred

- No production / auto-deduct (module-wide locked out since SP-Recipe-1).
- No POS-side stock management UI (POS only consumes synced outlet stock).
- No per-warehouse PAR (PAR stays outlet-only).
- Overview is read-only (no bulk edit / no inline cell editing).
- Ingredient stock UX is unchanged (Bahan tab stays as-is; it already lives in this
  module).

## J. Risks / things to verify during planning

1. **Outlet goods-in/adjust log table shape** (E6) — exact migration; whether to
   make existing logs polymorphic or add outlet-parallel tables.
2. **CSV importer** dropping the Stok column — confirm no live template depends on it.
3. **PAR + POS** — confirm POS does not consume `par_level` before deciding no
   version bump on the PAR write (E4).
4. **`getProductOutletConfig` shape** — leaving `stock`/`parLevel` in the read
   response is harmless (modal ignores them), but the write (E3) must stop setting
   them; verify no other caller relies on the product-config write to set stock.
5. **Existing top-level `StockCount` route/deep-links** — ensure nothing else links
   to the removed nav id.
