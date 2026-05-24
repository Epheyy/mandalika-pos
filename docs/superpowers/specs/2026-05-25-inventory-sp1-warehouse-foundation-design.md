# Inventory Module — SP1: Warehouse Foundation — Design

Date: 2026-05-25 · Branch: `prod-hardening`

## Module context (the whole Inventory vision, for continuity)

The Inventory module = **warehouses + product transfers** for the multi-brand POS
template. It's decomposed into four sequenced sub-projects, each its own
spec → plan → build (this avoids one unreviewable mega-spec):

- **SP1 — Warehouse foundation** *(this spec)*: warehouses + their own stock +
  goods-in + manual adjust + warehouse stock-count. Backoffice only.
- **SP2 — Transfers core (backoffice)**: draft → send → in-transit → receive →
  discrepancy; mesh polymorphic locations; cancel; POS-sync bump on outlet legs.
- **SP3 — POS-side receiving + PIN**: in-transit transfers sync to the
  destination outlet's POS; receiver confirms on-device with their real counted
  qty (offline-capable enqueue); authoritative PIN + role gate.
- **SP4 — Transfer documents & sharing**: printable delivery note (thermal print
  via the existing BLE printer + in-device view) at send; PDF/image export +
  WhatsApp/OS-share.

**Module-wide locked decisions** (apply across SPs):
- Topology = **mesh** (any location ↔ any location: warehouse↔outlet,
  outlet↔outlet, returns).
- Transfer flow = **two-step send → receive with in-transit**; **draft** allowed
  before send (SP2).
- Warehouse modeling = **separate subsystem** (own table + own stock store,
  parallel to outlets; never POS-synced).
- Stock entry = **goods-in** action (qty + optional supplier/note/cost; cost is
  informational only — no valuation/COGS in v1).
- Discrepancy = **receive actual qty, record the difference** with a reason.
- Approval = **authoritative PIN + selected roles** (SP3).
- New permission **`manage_inventory`** gates all inventory ops (admin implicit),
  following the existing granular-permission pattern.

**Deferred to their SP** (do NOT design here): transfers (SP2), PIN model /
POS offline receiving (SP3), document/PDF/print/WhatsApp (SP4).

Status note: the app is deployed on free-tier infra but runs **test data only**
(not real sales) — standard deploy hygiene applies, no kid-gloves.

---

## SP1 goal

Add **warehouses** as a separate stock subsystem the user can stock and count:
CRUD, a per-warehouse per-variant stock store, **goods-in**, **manual adjust**,
and **warehouse stock-count** (reusing the existing opname machinery). Entirely
backoffice; no POS, no transfers, no PIN, no documents.

## Current-state facts (verified)

- `outlets` shape (to mirror): name, code, address, phone, is_active, created_at
  (`write.Outlet`).
- Per-outlet stock lives in `outlet_variant_stock (outlet_id, product_id,
  variant_size) → stock, par_level`. Warehouses get a **parallel** store.
- Opname today: `stock_counts` (id, name, status [planned/in_progress/completed/
  cancelled], **outlet_id**, planned_date, notes, created_by, started_at,
  completed_at) + `stock_count_items` (stock_count_id, product_id, product_name,
  variant_size, counted, difference). Flow: create→start→save→complete; complete
  writes counted qty into `outlet_variant_stock` and records the difference
  (`write/stockcount.go`). Currently outlet-scoped.
- Permissions are granular keys (`manage_products`, `manage_outlets`,
  `manage_stock_count`, …) in `apps/backoffice/src/screens/Users.tsx` `PERMS` +
  backend checks; admin implicitly has all.
- Warehouses are NOT POS-synced, so warehouse writes do **not** bump
  `content_version` (unlike outlet stock writes).

## Data model — new migration `0015_warehouses.sql` (0014 is current highest)

```sql
CREATE TABLE warehouses (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  code       text,
  address    text,
  phone      text,
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE warehouse_variant_stock (
  warehouse_id uuid NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  product_id   uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  variant_size text NOT NULL,
  stock        integer NOT NULL DEFAULT 0,
  PRIMARY KEY (warehouse_id, product_id, variant_size)
);

CREATE TABLE goods_receipts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id uuid NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  supplier     text,
  note         text,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE goods_receipt_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id    uuid NOT NULL REFERENCES goods_receipts(id) ON DELETE CASCADE,
  product_id    uuid NOT NULL REFERENCES products(id),
  variant_size  text NOT NULL,
  qty           integer NOT NULL,
  unit_cost     numeric(14,2)            -- informational only; nullable
);

CREATE TABLE warehouse_stock_adjustments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id uuid NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  product_id   uuid NOT NULL REFERENCES products(id),
  variant_size text NOT NULL,
  new_qty      integer NOT NULL,         -- absolute on-hand after the correction
  reason       text NOT NULL,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Make opname location-polymorphic (reuse, don't duplicate):
ALTER TABLE stock_counts ALTER COLUMN outlet_id DROP NOT NULL;
ALTER TABLE stock_counts ADD COLUMN warehouse_id uuid REFERENCES warehouses(id) ON DELETE CASCADE;
ALTER TABLE stock_counts ADD CONSTRAINT stock_counts_one_location
  CHECK (num_nonnulls(outlet_id, warehouse_id) = 1);
```
(If `stock_counts.outlet_id` already allows NULL, drop that ALTER. Verify at impl.)

## Behavior / data flow

- **Goods-in** (`POST /warehouses/{id}/goods-receipt`): create a receipt + items
  in one tx; each line does `INSERT … ON CONFLICT (warehouse_id, product_id,
  variant_size) DO UPDATE SET stock = warehouse_variant_stock.stock + EXCLUDED.qty`.
  Additive only.
- **Adjust** (`POST /warehouses/{id}/adjust`): set absolute `new_qty` (≥0) with a
  required reason; upserts `warehouse_variant_stock` to `new_qty` and logs a
  `warehouse_stock_adjustments` row. Handles decreases/shrinkage that goods-in
  can't.
- **Warehouse stock-count**: same create→start→save→complete flow, but scoped by
  `warehouse_id`; **complete** writes counted qty into `warehouse_variant_stock`
  (not `outlet_variant_stock`) and records each line's difference. The repo
  functions branch on which location id is set.
- No `content_version` bump anywhere in SP1 (warehouses aren't POS-synced).

## Components / boundaries

| Unit | Responsibility | Depends on |
|---|---|---|
| migration `0015` | warehouse tables + polymorphic opname | products, outlets, stock_counts |
| openapi + codegen | `Warehouse`, `WarehouseStockRow`, `GoodsReceiptInput`, `WarehouseAdjustInput`, warehouse-scoped stock-count shapes | — |
| write repo (`warehouse.go`) | warehouses CRUD, goods-in, adjust | schema |
| write `stockcount.go` | branch outlet vs warehouse on complete/scope | warehouse_variant_stock |
| read repo | list warehouses, warehouse stock matrix | schema |
| handlers | route + `manage_inventory` gate | write/read |
| backoffice `Gudang` screens | warehouses list/CRUD, stock view + Goods-in + Adjust, warehouse opname UI | API types |

## API (gated by `manage_inventory` / admin)

- `GET/POST /warehouses`, `PUT/DELETE /warehouses/{id}`
- `GET /warehouses/{id}/stock` — products×variants with on-hand qty
- `POST /warehouses/{id}/goods-receipt` — `{ supplier?, note?, items:[{productId, variantSize, qty, unitCost?}] }`
- `POST /warehouses/{id}/adjust` — `{ productId, variantSize, newQty, reason }`
- Warehouse-scoped stock-count: extend existing endpoints to accept a warehouse
  location (or `?warehouseId=`), reusing the create/start/save/complete handlers.

## Backoffice UI

New **"Gudang"** nav entry (visible with `manage_inventory`): warehouses
list/CRUD (reuse `ui/` primitives, gold tokens, semantic colors); a per-warehouse
stock view (products×variants + on-hand, searchable like Products) with
**Goods-in** and **Adjust** actions; warehouse stock-count screens (the opname UI
scoped to a warehouse).

## Error handling

- Validate warehouse exists/active; qty ≥ 0; goods-in items non-empty; adjust
  `reason` required and `newQty ≥ 0`.
- Deleting a warehouse cascades its stock/receipts/adjustments; block or warn if
  it has stock (decision: warn, allow — test data). Surface friendly messages.
- Unknown product/variant in a line → reject with a clear message.

## Testing

Follow the repo pattern: pure logic unit-tested where it exists; DB/IO verified
live (build → deploy → `/readyz` → backoffice smoke). Any pure helper (e.g. a
location-branch resolver in stockcount) gets a small Go table-test. No JS test
runner required for SP1 (backoffice has none yet).

## Out of scope (SP1)

Transfers (SP2), POS anything (SP3), PIN (SP3), documents/PDF/print/WhatsApp
(SP4), inventory valuation/COGS, suppliers-as-entities / purchase orders,
per-warehouse staff binding.

## Plan phasing hint

**A:** migration + warehouses CRUD + warehouse stock store + read/stock view.
**B:** goods-in + adjust. **C:** warehouse stock-count (polymorphic opname).
**D:** backoffice Gudang UI + `manage_inventory` permission wiring.
