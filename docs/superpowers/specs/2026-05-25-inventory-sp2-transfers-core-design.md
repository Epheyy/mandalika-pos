# Inventory Module — SP2: Transfers Core — Design

Date: 2026-05-25 · Branch: `prod-hardening`

## Module context (continuity)

The Inventory module = **warehouses + product transfers** for the multi-brand POS
template, decomposed into four sequenced sub-projects (each its own spec → plan →
build):

- **SP1 — Warehouse foundation** ✅ DONE & LIVE (backend rev 00021-d5c, migration
  0015): warehouses CRUD + `warehouse_variant_stock` + goods-in + adjust +
  location-polymorphic stock-count + `manage_inventory` perm.
- **SP2 — Transfers core (backoffice)** *(this spec)*: draft → send → in-transit →
  receive → discrepancy; mesh polymorphic source/dest; cancel; `content_version`
  bump on outlet legs.
- **SP3 — POS-side receiving + PIN**: in-transit transfers sync to the destination
  outlet's POS; receiver confirms on-device with real counted qty; offline-capable
  enqueue; authoritative PIN + role gate.
- **SP4 — Transfer documents & sharing**: printable delivery note (thermal BLE
  print + in-device view) at send; PDF/image export + WhatsApp/OS-share.

**Module-wide locked decisions** (apply across SPs):
- Topology = **mesh** (any location ↔ any: warehouse↔outlet, outlet↔outlet,
  returns).
- Transfer flow = **two-step send → receive with in-transit**; **draft** allowed
  before send.
- Warehouse modeling = **separate subsystem** (own tables; never POS-synced).
- Discrepancy = **receive actual qty, record the difference** with a reason.
- Approval = **authoritative PIN + selected roles** — **SP3 only** (NOT in SP2).
- Permission **`manage_inventory`** gates all inventory ops (admin implicit).

## SP2-specific decisions (locked this session)

1. **Receive boundary** — in SP2, backoffice can **receive ANY transfer**, including
   outlet destinations (full lifecycle is testable end-to-end in backoffice). SP3
   later *adds* the POS on-device receive (real-qty cross-check + PIN) as an extra
   surface that calls the **same receive API**.
2. **Cancel** — allowed for **draft** (no stock effect) **and in_transit** (reverse
   the send: full sent qty goes back to the source location, re-bumping the source
   outlet leg if it is an outlet).
3. **Polymorphic modeling** — **separate nullable FK columns** per endpoint with a
   `CHECK (num_nonnulls(...) = 1)` each (mirrors the `stock_counts` SP1 precedent;
   keeps real FKs + cascade).
4. **In-transit stock** — **implicit**: deduct source on *send*, credit dest on
   *receive*. While `in_transit`, goods are on nobody's on-hand (they are moving);
   "in transit" is purely the transfer's status. No virtual bucket.
5. **Discrepancy reason** — **one transfer-level `discrepancy_reason`**, required at
   receive when *any* line's received qty differs from its sent qty (not per-line
   reasons).
6. **UI placement** — Transfers live as a **tab inside the existing Gudang area**,
   not a separate top-level nav entry.

## Current-state facts (verified)

- **Stock stores have identical shape**: `outlet_variant_stock (outlet_id,
  product_id, variant_size) → stock, par_level` and `warehouse_variant_stock
  (warehouse_id, product_id, variant_size) → stock`. Transfers move qty between
  any two of these rows.
- **Polymorphic-location precedent**: `write/stockcount.go` already branches on
  `outlet_id` vs `warehouse_id` (`scopeCount`, and `CompleteStockCount` picks the
  stock table + tx wrapper by which id is set). SP2 follows the same shape.
- **Content-version bump**: `bumpVersionOutlets(ctx, tx, resource, outletIDs)` in
  `write/repo.go` already bumps *only the given outlets* — exactly what "bump only
  the outlet legs" needs. Stock-affecting writes use the resource name `"products"`
  (e.g. `CompleteStockCount` → `tx(ctx, "products")`), so the POS resyncs product
  stock. Warehouses are not POS-synced (`noBumpTx`).
- **Manual-tx pattern**: when a single tx must conditionally bump per outlet,
  `CompleteStockCount` uses `r.Pool.Begin` + branch (`noBumpTx` vs
  `tx(ctx,"products")`). SP2 reuses this: a manual tx that calls
  `bumpVersionOutlets` only for the outlet leg(s) actually touched.
- Permissions are granular keys checked in handlers; `manage_inventory` exists and
  gates the Gudang surface. Admin implicitly has all.
- Highest migration is **0015**; SP2 adds **0016**.

## Data model — new migration `0016_transfers.sql`

```sql
CREATE TABLE transfers (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_no        text NOT NULL,                 -- short human-readable ref
  status             text NOT NULL DEFAULT 'draft',  -- draft|in_transit|completed|cancelled
  source_outlet_id   uuid REFERENCES outlets(id)    ON DELETE RESTRICT,
  source_warehouse_id uuid REFERENCES warehouses(id) ON DELETE RESTRICT,
  dest_outlet_id     uuid REFERENCES outlets(id)    ON DELETE RESTRICT,
  dest_warehouse_id  uuid REFERENCES warehouses(id) ON DELETE RESTRICT,
  note               text,
  discrepancy_reason text,
  created_by         uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  sent_at            timestamptz,
  received_at        timestamptz,
  cancelled_at       timestamptz,
  CONSTRAINT transfers_one_source CHECK (num_nonnulls(source_outlet_id, source_warehouse_id) = 1),
  CONSTRAINT transfers_one_dest   CHECK (num_nonnulls(dest_outlet_id, dest_warehouse_id) = 1)
);

CREATE TABLE transfer_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id  uuid NOT NULL REFERENCES transfers(id) ON DELETE CASCADE,
  product_id   uuid NOT NULL REFERENCES products(id),
  variant_size text NOT NULL,
  sent_qty     integer NOT NULL,
  received_qty integer,                  -- NULL until received
  difference   integer                   -- received_qty - sent_qty, set at receive
);

CREATE INDEX idx_transfers_status ON transfers(status);
```

`ON DELETE RESTRICT` on the four location FKs: a location with transfer history
cannot be silently deleted out from under a transfer (SP1 already warns on
warehouse delete with stock; transfers harden it further). Self-transfer
(same kind + same id) is rejected at the app layer (a CHECK cannot compare across
the four nullable columns cleanly).

`transfer_no`: a short human-readable reference generated at create (format left to
the plan; e.g. `TRF-YYMMDD-####`). Used by the UI now and the SP4 delivery note
later.

## Behavior / lifecycle

```
draft ──send──▶ in_transit ──receive──▶ completed
  │                  │
  └─────── cancel ───┴──▶ cancelled
```

- **create** (`POST /transfers`) → `status='draft'`. Body carries source, dest, and
  items `[{productId, variantSize, qty}]`. No stock movement. Items + note freely
  editable while draft via `PUT /transfers/{id}`.
- **send** (`POST /transfers/{id}/send`) → only from `draft`. For each line, guard
  `qty ≤ source on-hand` (else reject, `stok tidak cukup`). **Deduct source** stock
  per line. Set `status='in_transit'`, `sent_at=now()`. Bump source leg if outlet.
- **receive** (`POST /transfers/{id}/receive`) → only from `in_transit`. Body:
  `{ items:[{productId, variantSize, receivedQty}], discrepancyReason? }`. For each
  line: **credit dest** with `receivedQty` (actual), set `received_qty` and
  `difference = receivedQty - sent_qty` (negative = shortfall/loss; positive = found
  extra — both allowed). If **any** line differs, `discrepancyReason` is required
  (else reject, `alasan selisih wajib`). Set `status='completed'`,
  `received_at=now()`. Bump dest leg if outlet.
- **cancel** (`POST /transfers/{id}/cancel`):
  - from `draft` → set `status='cancelled'`, `cancelled_at=now()`. No stock effect.
  - from `in_transit` → **restore each line's `sent_qty` to the source** location,
    set `status='cancelled'`, `cancelled_at=now()`. Bump source leg if outlet.
  - from `completed`/`cancelled` → reject (wrong-status guard).

### Discrepancy semantics (implicit in-transit, recapped)

On send the full sent qty leaves source. On receive only the actual `receivedQty`
lands at dest. The gap (`sent_qty − receivedQty`) is the recorded shortfall — a
documented in-transit loss; source stock is **not** restored for it (that is what
*cancel(in_transit)* is for — goods that physically came back intact). This is the
locked "receive actual + record discrepancy" behavior.

## Stock & sync rules

- A polymorphic stock mutator branches on which leg id is set: outlet →
  `outlet_variant_stock`, warehouse → `warehouse_variant_stock` (same upsert shape
  as `stockcount.go`). Deduct = `stock = stock - qty`; credit/restore = `stock =
  stock + qty` via `ON CONFLICT DO UPDATE`.
- **`content_version` bump only on outlet legs**: inside the action's manual tx,
  call `bumpVersionOutlets(ctx, tx, "products", []string{outletID})` for the outlet
  leg touched by that action (send→source, receive→dest, cancel-in-transit→source).
  Warehouse legs bump nothing. Resource name `"products"` matches the stock-count
  precedent so POS pulls fresh stock.
- Guards: send blocked if any line `qty > source on-hand` or `qty ≤ 0`; every action
  enforces the allowed from-status; receive requires `receivedQty ≥ 0`.

## Components / boundaries

| Unit | Responsibility | Depends on |
|---|---|---|
| migration `0016` | transfers + transfer_items, CHECK constraints, index | outlets, warehouses, products |
| openapi + codegen | `Transfer`, `TransferItem`, `TransferCreateInput`, `TransferReceiveInput` | — |
| write repo (`transfer.go`) | create/edit draft, send, receive, cancel; polymorphic stock mutate; per-leg bump | schema, stock tables, `bumpVersionOutlets` |
| pure helpers (`transfer.go`) | status-transition validator, difference calc, leg→bump resolver | — (unit-tested) |
| read repo | list transfers (+filters), transfer detail; resolve source on-hand for the create UI | schema, stock tables |
| handlers | route + `manage_inventory` gate + friendly error mapping | write/read |
| backoffice Gudang **Transfer tab** | list, create form, detail with send/receive/cancel | API types, `ui/` primitives |

## API (gated by `manage_inventory` / admin)

- `GET /transfers` — list; optional filters `?status=` and location.
- `GET /transfers/{id}` — detail incl. items + source on-hand snapshot for the UI.
- `POST /transfers` — create draft `{ source:{kind,id}, dest:{kind,id}, note?,
  items:[{productId, variantSize, qty}] }`.
- `PUT /transfers/{id}` — edit a **draft**'s items/note only.
- `POST /transfers/{id}/send`
- `POST /transfers/{id}/receive` — `{ items:[{productId, variantSize, receivedQty}],
  discrepancyReason? }`
- `POST /transfers/{id}/cancel`

**Location wire shape (fixed):** source and dest are each a
`{ kind: "outlet" | "warehouse", id: uuid }` pair. The handler maps each pair to the
matching nullable FK column (`source_outlet_id` / `source_warehouse_id`, etc.). This
is unambiguous and symmetric for both endpoints (unlike the stock-count body, where
the outlet came from the caller's scope — here both ends are explicit).

## Backoffice UI

A **Transfer** tab inside the existing **Gudang** area (visible with
`manage_inventory`):

- **List**: rows show `transfer_no`, source → dest (with kind icons/labels), status
  badge (semantic colors: draft = neutral, in_transit = amber, completed = green,
  cancelled = muted/red), created date; filter by status.
- **Create form**: pick source location, then dest location (self-transfer blocked);
  add product/variant lines with qty, each line showing **live source on-hand** so
  the user cannot over-send; save as draft.
- **Detail**: shows lines + status; action buttons by status — `draft` → Send /
  Edit / Cancel; `in_transit` → Receive / Cancel; `completed`/`cancelled` →
  read-only.
- **Receive screen**: per-line **actual received qty** input (defaults to sent_qty)
  + a single discrepancy-reason field that becomes required once any line differs;
  shows the computed difference per line.

Reuses `apps/backoffice/src/ui/` primitives, gold tokens, and semantic-only colors
(matching the SP1 Gudang screens).

## Error handling

- Validate both endpoints exist; reject self-transfer (same kind + id).
- Send: `qty > 0`, `qty ≤ source on-hand` per line (`stok tidak cukup`), ≥1 item.
- Receive: `receivedQty ≥ 0`; `discrepancyReason` required when any line differs
  (`alasan selisih wajib`).
- Wrong-status transitions rejected with a clear message (e.g. "transfer sudah
  diterima").
- Friendly Indonesian messages throughout; detailed context logged server-side.

## Testing

Repo pattern: pure logic unit-tested, DB/IO verified live. Add Go table-tests for
the pure helpers (status-transition validator, difference calc, leg→bump resolver).
Live verification (build → deploy → `/readyz` → backoffice smoke): full
draft→send→receive happy path across all leg combinations (wh→wh, wh→outlet,
outlet→wh, outlet→outlet), over-send rejection, discrepancy path (received ≠ sent +
reason), cancel-draft (no stock effect), cancel-in_transit (source restored), and
**confirm the outlet leg's `content_version` bumped** so a POS resync is triggered
(warehouse legs do not bump).

## Out of scope (SP2)

PIN + POS on-device receive (SP3); delivery note / PDF / thermal print / WhatsApp
share (SP4); inventory valuation / COGS; a generic stock-movement audit ledger;
suppliers-as-entities / purchase orders; partial/multi-shipment receiving against a
single transfer.

## Plan phasing hint

**A:** migration 0016 + write repo (create/edit draft) + read (list/detail) +
openapi/codegen. **B:** send + receive (polymorphic stock mutate + per-leg bump) +
pure helpers & tests. **C:** cancel (draft + in_transit restore). **D:** backoffice
Gudang Transfer tab (list / create / detail / receive).
