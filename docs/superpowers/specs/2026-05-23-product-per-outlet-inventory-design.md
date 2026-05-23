# Product Module — Phase 1: Per-Outlet Inventory & Pricing

Date: 2026-05-23 · Branch: `prod-hardening` · Apps: backend (Go), `apps/backoffice`, POS sync

## Goal
Stock, price, and availability are currently global (`product_variants.stock` /
`.price` are single numbers shared by every outlet). Make them **per-outlet** so
each outlet has its own stock, optional price overrides, and can have a product
turned off — without breaking the live order path or the offline POS sync.

This is **Phase 1 of 4** (foundation). Out of scope here: the multi-step
Add/Edit wizard (Phase 2), Type/sourcing semantics & internal transfers, the
"Atur" config menus (Phase 3), and the import template (Phase 4).

## Approved decisions
- Scope this build to **Phase 1 only**.
- **Backfill** existing global stock to the **primary outlet** (deterministic:
  outlet with the most completed orders, else oldest active outlet). Other
  outlets start at 0.
- **Base price stays on `product_variants.price`**; per-outlet rows are
  *overrides* only (no row ⇒ base price). Not every outlet needs a price.
- **Availability defaults ON** everywhere; per-outlet opt-out.
- Per-outlet rows key on **`(outlet_id, product_id, variant_size)`** — the same
  natural key the order decrement, `order_items`, and `stock_count_items`
  already use. Avoids orphaning when `UpdateProduct` deletes/reinserts variants.

## Data model (new migration `0010_per_outlet_inventory.sql`, additive)
```sql
CREATE TABLE outlet_variant_stock (
  outlet_id    uuid NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
  product_id   uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  variant_size text NOT NULL,
  stock        integer NOT NULL DEFAULT 0,
  par_level    integer,                       -- low-stock threshold (optional)
  PRIMARY KEY (outlet_id, product_id, variant_size)
);
CREATE TABLE outlet_variant_price (
  outlet_id    uuid NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
  product_id   uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  variant_size text NOT NULL,
  price        numeric(14,2) NOT NULL,
  PRIMARY KEY (outlet_id, product_id, variant_size)
);
CREATE TABLE outlet_product_availability (
  outlet_id   uuid NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
  product_id  uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  available   boolean NOT NULL DEFAULT true,
  PRIMARY KEY (outlet_id, product_id)
);
```
- `product_variants.stock` is kept (legacy/aggregate mirror) but is **no longer
  the source of truth**; `.price` stays as the base/default.
- **Backfill** (same migration): `INSERT INTO outlet_variant_stock(outlet_id,
  product_id, variant_size, stock) SELECT <primary>, v.product_id, v.size,
  v.stock FROM product_variants v;` where `<primary>` is chosen by the
  deterministic rule above (resolved in SQL via a CTE; the resolved outlet name
  is confirmed before running).

## Read resolution (`backend/internal/read/repo.go`)
- `productObj` becomes scope-aware. With an outlet in scope, each variant
  resolves: `stock = COALESCE(ovs.stock, 0)`, `price = COALESCE(ovp.price,
  v.price)`; products with `outlet_product_availability.available = false` for
  that outlet are excluded.
- `Products(scope)` / `Product(scope)` gain a `Scope` parameter (mirrors
  `Orders`/`Shifts`). Admin "Semua Outlet" (CrossAll) ⇒ `stock = SUM(ovs.stock)`
  across outlets, base price, all products shown.
- `handlers.Products/Product` pass `scope(r)`; the products cache key gains the
  outlet (currently unscoped).
- A dedicated management read for the edit modal:
  `GET /api/v1/products/{id}/outlet-config` → per-outlet matrix
  `{ variants: [{ variantSize, basePrice, outlets: [{ outletId, stock, price|null }] }],
     availability: [{ outletId, available }] }`. Kept out of the hot list/sync path.

## Sync (`backend/internal/sync/sync.go`)
- `Pull()` passes the cashier's outlet scope into `Read.Products(...)`, so the
  pull bundle carries **outlet-resolved** stock/price and omits unavailable
  products. The POS app keeps reading `variant.stock` / `variant.price`
  unchanged — it just receives the correct values. **No APK rebuild required.**
- `bumpVersion` becomes outlet-scoped for per-outlet stock/price/availability
  writes (a change at outlet A only resyncs A). Base product meta/variant
  changes still bump all outlets.

## Order path (`backend/internal/service/order.go`) — highest risk
- `CreateOrder` stock decrement: replace the `product_variants` SELECT/UPDATE
  with `outlet_variant_stock WHERE outlet_id = in.OutletID AND product_id = $
  AND variant_size = $`. Use upsert-then-lock so the row always exists:
  `INSERT ... ON CONFLICT DO NOTHING;` then `SELECT stock ... FOR UPDATE;`
  `UPDATE ... SET stock = ...`. Preserves the existing race protection.
- Offline (`in.Offline`) still allowed to go negative; online still floors at 0.
- `Refund` restores to the same outlet's row (same key).
- `in.OutletID` already exists on `CreateOrderInput` (currently unused for
  stock) — thread it into the new query.

## Stock counts (`backend/internal/write/stockcount.go`)
- `CompleteStockCount` writes the counted quantity to
  `outlet_variant_stock` for the count's `outlet_id` (was a global
  `product_variants.stock` write). Already outlet-scoped for access; only the
  final write target changes.

## Backoffice management (`apps/backoffice/src/screens/Products.tsx`)
- List: when an outlet is selected in the switcher, show **that outlet's** stock
  + resolved price and hide unavailable products; "Semua Outlet" shows summed
  stock. (Driven by the existing `X-Outlet-Id` the API client already sends.)
- Edit modal: a **per-outlet section** — a table with a row per active outlet
  (available toggle · stock · price override input, blank = base). Loads via
  `GET /products/{id}/outlet-config`, saves via
  `PUT /api/v1/products/{id}/outlet-config`.
- Create modal: the existing per-variant stock field seeds the **currently
  selected outlet** (or primary outlet when "Semua Outlet"); other outlets start
  at 0. Base price + variants unchanged.

## OpenAPI / generated code
- New schemas: `OutletConfigResponse`, `OutletConfigInput` (+ rows). New paths
  `GET/PUT /products/{id}/outlet-config`. Regenerate `api.gen.go` (`make
  gen-check` gate) and the TS client (`pnpm --filter @mandalika/api gen`).
- `ProductVariant.stock`/`.price` semantics change to "resolved for scope"
  (shape unchanged).

## Rollout (backend-first; live selling app)
1. Migration + backend (read scope, sync scope, order/refund per-outlet,
   stock-count target, outlet-config endpoints). Deploy to Cloud Run; migrations
   auto-apply on boot. **Verify**: `/readyz` green; a test sale decrements the
   correct outlet's row; refund restores it; POS pull returns outlet stock.
2. Regenerate TS client; backoffice UI (list scoping + edit modal per-outlet
   table). Deploy via Cloudflare.
3. POS APK: not required (server-resolved). Rebuild only if verification shows a
   client gap.

## Risks & mitigations
- **Order path** (every sale): keep upsert + `FOR UPDATE` locking; add Go tests
  for decrement/refund per outlet incl. concurrent + offline-negative cases.
- **Partial migration drift**: in the same release, switch order, stock-count,
  and refunds to the new table together so nothing keeps writing the old column.
- **Sync starvation**: if scope resolution returns nothing, the cashier sees no
  stock — verify the pull for a real outlet before/after deploy.
- **bumpVersion broadcast cost**: scope per-outlet writes to the one outlet.

## Test plan
- Go unit/integration: read resolution (scoped vs CrossAll), order decrement &
  refund per outlet (online floor-0, offline negative, concurrency), stock-count
  apply per outlet, backfill correctness.
- Backoffice: list reflects selected outlet; edit modal round-trips per-outlet
  stock/price/availability; "Semua Outlet" sums.
- Manual: real sale at outlet A doesn't move outlet B's stock; product turned
  off at A is hidden in that POS after resync.
