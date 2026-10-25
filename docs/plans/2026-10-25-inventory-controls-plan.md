# Inventory controls (auditor): spec and slice plan

Date: 2026-10-25. Base: `prod-hardening` @ 461eeea (worktree `bold-perlman-cfdc21`). This is a plan only. No code, no deploy.
Path references are relative to the repo root. "unverified" means I did not confirm the item against code or data.

**Auditor request (verbatim):** "1. Stock Movement: Tracking pergerakan stok perlu detail per SKU, termasuk Canvas Bag, agar histori stok masuk, keluar, dan saldo dapat ditelusuri. 2. Adjustment: Tambahkan fitur adjustment terintegrasi dengan hasil opname, dilengkapi alasan, approval, dan histori perubahan stok. 3. Transfer Stock: Tambahkan transfer gudang ke toko dengan alur permintaan barang/PO agar pencatatan lebih rapi. 4. Stock Opname: Tambahkan fitur tarik dan upload data agar proses opname menggunakan scanner lebih praktis dan akurat."

**Owner decisions (2026-10-25), binding for this plan:**
- **D-A, canvas bag.** The bag is both sold as an item and given away. The giveaway is one unit per completed sale, from a configurable item per outlet (product + variant_size).
  - It is recorded as a ledger movement that carries the order ref.
  - It is not restored on refund.
  - It goes to the ERP inside the sale document as a zero-price line flagged `giveaway`. No new ERP document kind.
  - Sold bags stay ordinary sale lines.
- **D-B, approvals.** Approvals reuse the A08 approver roles and PIN step-up: `receive_approver_roles`, the receive PIN lockouts, and `internal/write/receive_approval.go`.
- **D-C, requisitions.** A "Permintaan Barang" (PB) document lives in the backoffice.
  - The outlet raises it. The warehouse approves and fulfils it. Fulfilling creates a transfer draft.
  - "PO" here means an internal requisition, not a supplier PO (that one belongs to the ERP).
- **D-D, stock-count CSV.**
  - Export columns: SKU, barcode, product, size, expected qty.
  - Import: barcode or SKU plus counted qty, from any barcode app.
  - A diff preview is shown before anything is applied.

---

## 1. Spec per control

### 1.1 Stock Movement ("kartu stok" per SKU, including Canvas Bag)

**What the auditor sees.** A new **Inventori → Kartu Stok** screen.

| They pick | They get |
|---|---|
| A location (outlet or gudang) and a SKU (search by SKU, barcode or name; Canvas Bag included) plus a date range | One row per movement. Columns: waktu kejadian, waktu tercatat, jenis, dokumen (order, transfer, opname, penyesuaian, penerimaan, link), masuk, keluar, **saldo**, oleh, alasan, penyetuju, tanda (Minus, Hadiah), status ERP |
| The same filters | A header with saldo awal, total masuk, total keluar, saldo akhir |
| "Unduh CSV" | The same rows as a file |
| "Ringkasan" | One line per SKU for a location: saldo awal, masuk by kind, keluar by kind, saldo akhir |

**What they will try:**
- Reconcile the Canvas Bag closing balance with the live stock figure.
- Trace one sale or one transfer from the receipt number.
- Export and re-sum the file.

**Facts in the code today:**

| Fact | Evidence |
|---|---|
| Every stock change already writes an append-only `stock_movements` row, with `qty_before` and `qty_after` | `backend/internal/db/migrations/0064_stock_movements.sql:8-29`; `qty_after = qty_before + qty` CHECK at `:22` |
| Writes go only through `internal/ledger` | `backend/internal/ledger/ledger.go:117-154` |
| Nothing reads the ledger yet | No non-test file under `internal/read` or `internal/handlers` references `stock_movements` (grep) |
| The current "Ringkasan Pergerakan" is built from source tables (`order_items`, `transfer_items`, …), not from the ledger, and has no opening balance | `backend/internal/read/inventory.go:287-400` |
| So that summary will never show the giveaway, and will stop reconciling with stock once S2 ships | follows from the row above |

**Decisions:**
- **Saldo is `qty_after` in `seq` order.** Per (location, product, size), `seq` is the order in which movements were applied: every writer locks the stock row before it records. So the chain `qty_before → qty_after` is continuous in `seq` order.
  - Offline sales carry an earlier `occurred_at` (`backend/internal/service/ledger_hooks.go:150-153`). Sorting by `occurred_at` would break the running balance.
  - The screen therefore sorts by `seq` and shows `occurred_at` as a column.
- **History starts at the backfill `opening` row.** The backfill ran on test Neon on 2026-10-22 (`HANDOFF.md:234`). Older activity exists only in the source tables.
- **The date range filters on `occurred_at`, read in the outlet's timezone.**
  - Saldo awal = `qty_before` of the first in-range row.
  - Saldo akhir = `qty_after` of the last in-range row.
  - With no rows in range, both equal the balance at the last earlier row.
- **"Ringkasan" is rebuilt on the ledger** (new endpoint). The old endpoint stays until the backoffice switches.

**Question:** none. Canvas Bag must exist as a product variant with a SKU. Whether it exists in the test DB is unverified (no DB access in this session); see S2 setup.

### 1.2 Adjustment (reasons, approval, history; tied to opname results)

**What the auditor sees:**
- **Penyesuaian stok** becomes a request. The form has location, SKU, new qty (the current qty is shown and stored), a mandatory reason code, and free text.
  - Reason codes: Rusak, Kedaluwarsa, Hilang, Ditemukan, Salah input, Tester/sampel, Selisih opname, Lainnya. Lainnya requires the text.
- The request waits in a new **Persetujuan Stok** queue.
- An approver opens it and sees before/after, drift since the request, and requester and reason. They press **Setujui** and enter their PIN, or **Tolak** with a note.
- **Opname integration.** When a count finishes, it is *submitted* (status `pending_approval`) with a count-level reason and optional per-line reasons.
  - The same queue shows the variance lines.
  - Approving applies the deltas (ledger kind `count`). Rejecting returns the count to `in_progress` for a recount.
- **History:** every submit, approve, reject, cancel and apply is an append-only event with actor and time. The resulting stock change appears on the kartu stok with reason and approver.

**What the auditor will try:**
- Bypass through the old direct adjust endpoint. Must be refused once the setting is on.
- Self-approve. Refused.
- A wrong PIN repeatedly. Lockout.
- Approve a request after stock moved. The drift is shown and the delta is applied.

**Facts in the code today:**

| Fact | Evidence |
|---|---|
| Adjust applies immediately and sets an absolute qty | `backend/internal/write/warehouse.go:334-381`, absolute set `:407-418` |
| Reason is mandatory | `backend/internal/write/stock_logic.go:29` |
| Route | `backend/internal/server/server.go:273` |
| Count statuses | `backend/internal/db/migrations/0001_init.sql:286` |
| Count completion applies deltas, not absolutes, so delaying it is safe | `backend/internal/write/stockcount.go:166-173`, `:517-567` |
| Counts and adjustments are backoffice-only; the POS never calls them | only `packages/api/src/client.ts:760-782` and two backoffice screens reference them (grep) |

**Decisions:**
- One app setting, `inventoryApprovalRequired` (migration default `false`, so the deploy is inert). When on:
  - `POST /inventory/adjust` and `POST /stock-counts/{id}/complete` answer **409 `approval_required`** for everyone.
- Approver = the logged-in backoffice user, who re-enters their own receive PIN.
  - Eligibility: admin, or a role listed in `receive_approver_roles` (`backend/internal/write/receive_fingerprint.go:47-57`).
  - Location scope (new helper): an outlet document needs admin or a user of that outlet. A warehouse document needs admin. `ReceiveScope` refuses warehouses (`receive_fingerprint.go:62-65`), so it is not reused.
  - Approver ≠ requester.
- An approved adjustment applies the **requested delta** (`requested_new_qty − qty_at_request`), not the absolute value (see Q3).

**Question:** Q2 (policy), Q3 (delta).

### 1.3 Transfer Stock with "Permintaan Barang"

**What the auditor sees.** A new **Permintaan Barang** screen.

| Who | Does what |
|---|---|
| Outlet staff (new permission `request_stock`) | Create a PB for their outlet: lines SKU and qty, needed-by date, note. Then submit or cancel. |
| Warehouse (`manage_inventory`) | Sees submitted PBs. Approves (per-line approved qty, source gudang) or rejects with a note. |
| Warehouse | **Buat Transfer** creates a transfer draft gudang → toko with the approved quantities and links it. Sending and receiving then use the existing transfer screens, including the A08 receive step-up at the outlet. |

- The PB shows its number (`PB-2026-00001`), status chain, linked transfer number and live transfer status, and event history.
- Not in scope: supplier POs (the ERP owns them) and any ERP document for the PB itself. Only the resulting transfer movements reach the ERP.

**Facts in the code today:**

| Fact | Evidence |
|---|---|
| Transfers move any location to any location | `backend/internal/db/migrations/0016_transfers.sql:8-25` |
| Status flow draft → in_transit → completed / cancelled | `backend/internal/write/transfer_logic.go:24-40` |
| Duplicate-line protection | `backend/internal/write/transfer.go:83` |
| Document numbers come from `doc_sequences` | `backend/internal/write/doc_sequences.go:15-16`, `:30-36` |
| `CreateTransfer` opens its own transaction | `backend/internal/write/transfer.go:219-243` |

**Decisions:**
- "Fulfilled" means a transfer was created and linked.
- If the linked transfer is later cancelled, the warehouse may press **Buat Transfer** again; the PB gets a new link and an event row. `cancelTransfer` is not touched.

### 1.4 Stock Opname with scanner (export / upload)

**What the auditor sees.** On an `in_progress` count:
- **Unduh CSV** gives sku, barcode, product, size, expected_qty, plus an empty counted_qty column.
- **Unggah Hasil Scan** accepts a CSV (barcode or sku, counted_qty) from any scanner app. Repeated scans of one code are summed.
- **Preview diff:** per line, expected, counted, difference, the value it overwrites, and warnings.
  - Warnings: unknown code, ambiguous SKU, not on this count, stock moved since the count started.
  - Lines missing from the file stay uncounted and are listed.
- **Terapkan** stores the counted quantities. The count is then submitted for approval (1.2).

**Facts in the code today:**

| Fact | Evidence |
|---|---|
| Import framework (preview, then commit with Idempotency-Key, file sha and expected summary, `import_runs` replay) | `backend/internal/write/import.go:84-196` |
| Barcode is unique; SKU is not yet (0067 is unshipped) | `backend/internal/db/migrations/0014_variant_barcode.sql:24-25` |
| A count can never add products | `backend/internal/write/stockcount.go:410-413` |
| Per-line saves capture a live baseline | `backend/internal/write/stockcount.go:315-339` |

**Decision:** the CSV upload saves lines without a per-line baseline, so the delta is taken against the count-start snapshot `frozen_qty`.
- Why: `stockcount.go:166-173` with `captureBaseline=false`, and `frozen_qty` is refreshed at start (`:302-310`).
- A baseline captured at upload time would wrongly treat sales made between scan and upload as count variance. The preview flags every line whose ledger shows a movement after `started_at` (see Q4).

---

## 2. Data model and migrations

The migration runner records applied file *names* (`backend/internal/db/db.go:79-125`). So 0068+ can ship before the reserved 0067 without skipping it. Each file runs in one transaction (`db.go:134-141`), so `CREATE INDEX CONCURRENTLY` is not available.

All migrations are additive. A widened CHECK uses the drop/add pattern of `0066_erp_external_ids.sql:78-80`.

| Mig | Slice | Content |
|---|---|---|
| 0067 | — | RESERVED (global SKU uniqueness). Not used here. |
| 0068 | S0 | `inventory_doc_events` (shared, append-only history) |
| 0069 | S1 | Ledger read index |
| 0070 | S2 | `outlet_giveaways` |
| 0071 | S3 | Approval columns and tables; settings flag; PIN-attempt doc refs |
| 0072 | S4 | `import_runs` kind `stock_count` + `target_id` |
| 0073 | S5 | `stock_requisitions`, `stock_requisition_items` |

```sql
-- 0068_inventory_doc_events.sql (S0)
SET LOCAL lock_timeout = '5s';
CREATE TABLE inventory_doc_events (
  id        bigserial PRIMARY KEY,
  doc_type  text NOT NULL CHECK (doc_type IN ('stock_count','adjustment_request','requisition','outlet_giveaway')),
  doc_id    uuid NOT NULL,                 -- no FK: history survives deletes (like 0064:16-17)
  action    text NOT NULL CHECK (action IN ('created','updated','submitted','approved','rejected',
                                            'cancelled','applied','imported','fulfilled','refulfilled')),
  actor_id  uuid,                          -- bare, like transfer_receive_approvals (0062)
  note      text,
  data      jsonb NOT NULL DEFAULT '{}',   -- e.g. {transferId}, {fromQty,toQty}, {importRunId}
  at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inventory_doc_events_doc ON inventory_doc_events (doc_type, doc_id, id);
-- Guard test (like ledger_guard_test.go) forbids UPDATE/DELETE on it.

-- 0069_stock_movements_loc_seq.sql (S1): location-wide keyset by seq
CREATE INDEX stock_movements_loc_seq ON stock_movements (location_type, location_id, seq);
-- per-SKU history already has stock_movements_loc_variant (0064:30)

-- 0070_outlet_giveaways.sql (S2)
CREATE TABLE outlet_giveaways (
  outlet_id    uuid PRIMARY KEY REFERENCES outlets(id) ON DELETE CASCADE,
  product_id   uuid NOT NULL,              -- no FK: a product delete must not hit a raw 23503
  variant_size text NOT NULL,
  enabled      boolean NOT NULL DEFAULT true,
  updated_by   uuid,
  updated_at   timestamptz NOT NULL DEFAULT now()
);  -- no row = no giveaway (inert on deploy)

-- 0071_inventory_approvals.sql (S3)
ALTER TABLE stock_counts DROP CONSTRAINT stock_counts_status_check;
ALTER TABLE stock_counts ADD CONSTRAINT stock_counts_status_check
  CHECK (status IN ('planned','in_progress','pending_approval','completed','cancelled'));
ALTER TABLE stock_counts
  ADD COLUMN submitted_by uuid, ADD COLUMN submitted_at timestamptz,
  ADD COLUMN approved_by uuid,  ADD COLUMN approved_at timestamptz,
  ADD COLUMN reason_code text,  ADD COLUMN reason_text text, ADD COLUMN rejected_note text;
ALTER TABLE stock_count_items ADD COLUMN reason_code text, ADD COLUMN reason_text text;
-- at most one OPEN count per location: the 0051:15-18 indexes cover in_progress only; keep them
-- (old revision + runningCountConflict names) and ADD a wider one:
CREATE UNIQUE INDEX stock_counts_one_open_outlet ON stock_counts (outlet_id)
  WHERE status IN ('in_progress','pending_approval') AND outlet_id IS NOT NULL;
CREATE UNIQUE INDEX stock_counts_one_open_warehouse ON stock_counts (warehouse_id)
  WHERE status IN ('in_progress','pending_approval') AND warehouse_id IS NOT NULL;
CREATE TABLE stock_adjustment_requests (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number            text NOT NULL UNIQUE,                 -- doc_sequences kind 'ADJ'
  status            text NOT NULL DEFAULT 'pending_approval'
                      CHECK (status IN ('pending_approval','approved','rejected','cancelled')),
  outlet_id         uuid REFERENCES outlets(id), warehouse_id uuid REFERENCES warehouses(id),
  CHECK (num_nonnulls(outlet_id, warehouse_id) = 1),
  product_id        uuid NOT NULL, variant_size text NOT NULL,   -- no product FK (see step2 follow-up 7)
  qty_at_request    integer NOT NULL,                     -- live qty the requester saw (server-read)
  requested_new_qty integer NOT NULL CHECK (requested_new_qty >= 0),
  reason_code       text NOT NULL CHECK (reason_code IN ('damaged','expired','lost','found','data_entry',
                                                         'tester_sample','count_variance','other')),
  reason_text       text,
  CHECK (reason_code <> 'other' OR length(btrim(coalesce(reason_text,''))) > 0),
  requested_by      uuid NOT NULL, requested_at timestamptz NOT NULL DEFAULT now(),
  approved_by       uuid, approved_at timestamptz, decision_note text,
  applied_adjustment_id uuid REFERENCES warehouse_stock_adjustments(id)
);
CREATE INDEX stock_adjustment_requests_pending ON stock_adjustment_requests (requested_at)
  WHERE status = 'pending_approval';
ALTER TABLE warehouse_stock_adjustments ADD COLUMN request_id uuid, ADD COLUMN reason_code text;
ALTER TABLE app_settings ADD COLUMN inventory_approval_required boolean NOT NULL DEFAULT false;
ALTER TABLE receive_pin_attempts ADD COLUMN doc_type text, ADD COLUMN doc_id uuid;  -- transfer_id stays NULL
-- same reason_code CHECK on stock_counts/stock_count_items (nullable)

-- 0072_import_runs_stock_count.sql (S4)
ALTER TABLE import_runs DROP CONSTRAINT import_runs_kind_check;
ALTER TABLE import_runs ADD CONSTRAINT import_runs_kind_check
  CHECK (kind IN ('customers','products','ingredients','sku_mapping','stock_count'));
ALTER TABLE import_runs ADD COLUMN target_id uuid;      -- the stock_count id for kind stock_count
CREATE INDEX import_runs_target ON import_runs (target_id) WHERE target_id IS NOT NULL;

-- 0073_stock_requisitions.sql (S5)
CREATE TABLE stock_requisitions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number        text NOT NULL UNIQUE,                     -- doc_sequences kind 'PB'
  status        text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','submitted','approved','rejected','fulfilled','cancelled')),
  outlet_id     uuid NOT NULL REFERENCES outlets(id),     -- requester / destination
  warehouse_id  uuid REFERENCES warehouses(id),           -- source; required from 'approved'
  needed_by     date, note text,
  requested_by  uuid NOT NULL, submitted_at timestamptz,
  decided_by    uuid, decided_at timestamptz, decision_note text,
  fulfilled_by  uuid, fulfilled_at timestamptz,
  transfer_id   uuid REFERENCES transfers(id),            -- latest linked transfer draft
  cancelled_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status NOT IN ('approved','fulfilled') OR warehouse_id IS NOT NULL)
);
CREATE INDEX stock_requisitions_status ON stock_requisitions (status, created_at DESC);
CREATE INDEX stock_requisitions_outlet ON stock_requisitions (outlet_id, created_at DESC);
CREATE TABLE stock_requisition_items (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requisition_id uuid NOT NULL REFERENCES stock_requisitions(id) ON DELETE CASCADE,
  product_id     uuid NOT NULL, variant_size text NOT NULL,
  requested_qty  integer NOT NULL CHECK (requested_qty > 0),
  approved_qty   integer CHECK (approved_qty >= 0),
  note           text,
  UNIQUE (requisition_id, product_id, variant_size)        -- same rule as transfer.go:83
);
```

**Giveaway movement kind: reuse `sale`, add flag `giveaway`. No new kind.** Reasons:

| Reason | Evidence |
|---|---|
| A new kind needs both CHECKs widened, or the INSERT fails and **rolls back the sale** | `0064_stock_movements.sql:13-14`, `0065_erp_outbox.sql:21-22` |
| It also needs `validKinds` and `knownKinds` | `ledger.go:47-51`, `backend/internal/integration/erp/payload.go:26-29` |
| The ERP enum would change | `docs/integration/stock-documents.v1.yaml:186-188` |
| The ERP answers 422 on a bad kind | `stock-documents.v1.yaml:36` |
| The relay dead-letters an unknown kind | `backend/internal/integration/erp/relay.go:258-260` |
| A new kind is exactly the "new document kind" the owner ruled out | D-A |

The flag needs no migration: `flags text[]` already exists (`0064_stock_movements.sql:27`).

---

## 3. Endpoints and OpenAPI shapes

**Where things live:**
- Spec: `backend/api/openapi.yaml`, 5566 lines. Existing anchors: adjust `:3812`, movement-summary `:3865`, stock-counts `:4673-4748`, receive approvals `:5283`.
- CSV export pattern: `:3431-3447`. Import responses: `:3426-3430`.
- Generators: Go via `make gen-go` → `backend/internal/api/api.gen.go` (`backend/Makefile:27-28`); TS via `corepack pnpm --filter @mandalika/api gen` → `packages/api/src/schema.d.ts` (`packages/api/package.json:10`).
- Generation checks: `make gen-check` (`.github/workflows/backend.yml:31`) and `corepack pnpm gen:check` (`package.json:18`).

**Routes are hand-wired** in `server.go`. The generated chi/strict `ServerInterface` (`backend/api/oapi-codegen.yaml:7-8`) is implemented by no non-generated file (grep). So spec-first paths compile without handler stubs.

**Codegen gate rule:** a new top-level test in `backend/internal/api` or `backend/internal/codegen` must be added to `CONTRACT`/`GUARD` in `scripts/ci/codegen_gate.py:18-19`. Those sets are exact (`:51-52`). This plan adds no such tests; if one is added, list it.

All write endpoints take an `Idempotency-Key` through `keyedMutated` (pattern: `backend/internal/handlers/stock_counts.go:73-86`). All reads apply `scope(r)` (`backend/internal/handlers/handlers.go:73`).

| Slice | Method + path (`/api/v1`) | Perm | Request → response |
|---|---|---|---|
| S1 | GET `/inventory/movements` | manage_inventory | Query: `locationType, locationId` (required); `productId, variantSize, kind[]` (sale, refund, …), `flag` (shortage\|giveaway), `from, to` (occurred_at, RFC3339 or date in outlet tz), `cursor` (opaque: seq), `limit` ≤ 200. Response `{data: StockMovementRow[], nextCursor, summary?}`; `summary` {opening, totalIn, totalOut, closing} only when one SKU is filtered. Order: `seq DESC`. |
| S1 | GET `/inventory/movements/export` | manage_inventory | Same filters; `text/csv`; range ≤ 93 days, ≤ 100k rows (413 above); `csvimport.GuardCell` (`backend/internal/handlers/erp_admin.go:27-30`) |
| S1 | GET `/inventory/movements/summary` | manage_inventory | Query: `locationType, locationId, from, to, q, page, limit`. Rows: `{productId, productName, variantSize, sku, barcode, opening, inByKind{}, outByKind{}, closing}` |
| S2 | GET / PUT `/outlets/{id}/giveaway` | manage_outlets (`server.go:262`) | `{productId, variantSize, enabled}` → `OutletGiveaway{…, productName, sku, erpMapped, valid}`. PUT answers 409 if the variant does not exist, or if ERP integration is on and the variant has no `erp_slug`+sku (see §4 Q-unmapped). Writes an `inventory_doc_events` row. |
| S3 | POST `/inventory/adjustment-requests` | manage_inventory | `{locationType, locationId, productId, variantSize, newQty, reasonCode, reasonText}`; server reads `qty_at_request` → 201 `AdjustmentRequest` |
| S3 | GET `/inventory/adjustment-requests`, GET `/{id}` | manage_inventory | Filter by status, location; offset paging (existing convention) |
| S3 | POST `/inventory/adjustment-requests/{id}/approve` | manage_inventory + approver rule | `{pin, note}` → 200 `{request, appliedAdjustmentId, liveQtyBefore, delta}`; refusals 403 (uniform `refusalMessage`, `receive_approval.go:31-35`) / 423-style `LockedError` (`:37-51`) / 409 (not pending, self-approval) |
| S3 | POST `…/{id}/reject`, POST `…/{id}/cancel` (requester) | manage_inventory | `{note}` (required on reject) |
| S3 | POST `/stock-counts/{id}/submit` | manage_stock_count | `{reasonCode, reasonText, lines?: [{productId, variantSize, reasonCode, reasonText}]}` → `StockCount` (pending_approval) |
| S3 | POST `/stock-counts/{id}/approve`, `/reject` | manage_stock_count + approver rule | approve `{pin, note}` applies deltas; reject `{note}` → in_progress |
| S3 | GET `/inventory/approvals?status=pending` | manage_inventory or manage_stock_count | Union queue `{type: count\|adjustment, id, number/name, location, requestedBy, at, lines, netDelta}` + pending count for the nav badge |
| S3 | `AppSettings.inventoryApprovalRequired` (GET/PUT `/settings/app`) | manage_settings | Additive field |
| S3 | POST `/inventory/adjust`, POST `/stock-counts/{id}/complete` | unchanged | 409 `{code: "approval_required"}` when the flag is on |
| S4 | GET `/stock-counts/{id}/export` | manage_stock_count | `text/csv`: `sku, barcode, product, size, expected_qty, counted_qty` (empty) |
| S4 | POST `/stock-counts/{id}/import` | manage_stock_count | Same contract as the product import: `ImportIdempotencyKey` param, dry run → report; commit with `fileSha256` + `expected` summary; 409 `ImportConflict` (stale / key), 422 `ImportRejected`. Report rows: `{row, code, matchedLine, expected, counted, previous, difference, warnings[]}`. |
| S5 | GET `/requisitions`, GET `/requisitions/{id}` | request_stock (own outlet) or manage_inventory | List filter by status / outlet; detail with items, events, linked transfer `{id, transferNo, status}` |
| S5 | POST `/requisitions`, PUT `/requisitions/{id}` | request_stock | `{note, neededBy, items: [{productId, variantSize, requestedQty, note}]}`; PUT on drafts only |
| S5 | POST `/requisitions/{id}/submit`, `/cancel` | request_stock | — |
| S5 | POST `/requisitions/{id}/approve` | manage_inventory | `{warehouseId, items: [{itemId, approvedQty}], note}` |
| S5 | POST `/requisitions/{id}/reject` | manage_inventory | `{note}` |
| S5 | POST `/requisitions/{id}/fulfil` | manage_inventory | Creates the transfer draft → `{transferId, transferNo}`; allowed again only when the linked transfer is `cancelled` |

**`StockMovementRow`:**
- From the ledger: `id, seq, occurredAt, recordedAt, kind, locationType, locationId, productId, variantSize, qty, qtyBefore, qtyAfter, refType, refId, refNumber, flags[]`.
- Joined: `locationName, productName, sku, barcode` (LEFT JOIN `product_variants` on (product_id, size), as in `payload.go:213-214`); `actorId, actorName`.
- `reasonCode, reasonText, approvedBy` from the adjustment request or count, by `ref_type/ref_id`.
- `erpStatus` from `erp_outbox` by `document_id`.

**Body caps and deadlines:**
- The import route needs an entry in `backend/internal/server/bodylimit.go:40-49` (`ImportBodyCap`).
- It also needs the import deadline exemption in `backend/internal/server/deadline.go:39-51`.

**Permission:**
- `request_stock` is new. It must be added to the UI list at `packages/types/src/index.ts:41-54`.
- Server checks are string-based (`backend/internal/auth/permissions.go:7-19`).

---

## 4. Ledger integration

**Rule.** Every new stock write goes through `internal/ledger` in the same transaction, before `BumpStockSeq` (`ledger.go:18-21`). New writes:
- S2: the giveaway decrement.
- S3: count apply on approval, which reuses `applyCountDeltas` (`stockcount.go:517-567`).
- S3: adjustment apply on approval, which is the adjustment writer with a delta and keeps `Key: "adjust:"+adjID`, kind `adjust` (`warehouse.go:369-378`).

S1, S4 and S5 write no stock:
- S4 stores counted quantities only.
- S5 creates transfer *drafts*. Stock moves only on send/receive, which already record (`write/transfer_ledger.go`).

Frozen functions `createOrderCore`, `RefundTx` and `processOneWithSeq` are **not edited**.

### 4.1 Giveaway design (S2)

1. **Lock order.**
   - The sale locks every stock row sorted by (product_id, variant_size) in `lockStockRowsSorted` (`backend/internal/service/lockorder.go:88-129`, called at `backend/internal/service/order.go:499`; rule at `order.go:160-183`).
   - Locking the bag row later, in the hook, could deadlock with a concurrent sale that sells a bag.
   - Fix, in non-frozen `lockorder.go` only:
     - read `SELECT product_id, variant_size FROM outlet_giveaways WHERE outlet_id=$1 AND enabled FOR SHARE`;
     - add that key to the sorted set for the lazy zero row (`:110-118`) and the sorted lock (`:119-126`);
     - include it in the `< 2 keys` early return (`:107-109`).
   - `FOR SHARE` keeps the setting stable until commit, so the hook re-reads the same row. A setting PUT updates only that row and takes no stock lock, so no cycle.
   - This edits a non-frozen helper. `createOrderCore`'s call at `order.go:499` is unchanged.
2. **Decrement and record**, inside `recordSaleMovements` (`backend/internal/service/ledger_hooks.go:88-165`), the D10 seam called once at `order.go:632`:
   - Read the sale lines first, as today (`:99-106`).
   - Then run `UPDATE outlet_variant_stock SET stock=stock-1 … RETURNING stock` for the giveaway key. The row is already locked.
   - Append one line **last**: `Qty -1, QtyBefore after+1, QtyAfter after, DedupeKey "giveaway:"+orderID, RefLine "", Flags ["giveaway"]` (+`"shortage"` if after < 0).
   - Pass it in the **same** `ledger.Record` call (`:154-160`).
   - Appending last keeps the per-key chain correct when a sold or reward bag shares the key: `Record` keeps caller order within a key (`ledger.go:253-264`).
   - The `len(ms)==0` early return (`:125-127`) must no longer skip the giveaway.
   - No setting row, disabled, or no stock row (variant gone): no giveaway, a `slog.Warn`, and **the sale never fails**.
3. **Guard files to update, each with a comment, Opus-reviewed:**
   - `backend/internal/write/stockseq_guard_test.go`: `ledger_hooks.go` stays a non-bumper (`:46`), because the sale bumps at `order.go:763`; add `{1,0}` to `stockSQLPins` (`:320-331`) and fix the comment.
   - `backend/internal/ledger/ledger_guard_test.go`: `ledger_hooks.go` now writes stock and calls `ledger.Record` directly, so it classifies as a recording writer (`:179-200`).

### 4.2 Answers to the five questions

| # | Question | Answer from code |
|---|---|---|
| 1 | Can a sale line mark a giveaway without a contract change? | **Yes on the wire; no on meaning.** (a) Schema: `flags` is an open string array documented with one known value, `shortage` (`stock-documents.v1.yaml:280-284`); `reason` is free text, "usually equals kind" (`:277-279`); `unit_price` is optional (`:269-272`); `StockLine` sets no `additionalProperties: false` (`:246-292`). (b) The ERP reply says unknown fields are ignored and POS may add fields (`C:\Users\MyBook Hype AMD\Downloads\Integrasi Stok ERP–POS.md:76`), flags are stored as information (`:80`, Q19 `:125`), `unit_price` is optional (Q21 `:127`). (c) **But:** the ERP books the −1 as a sale OUT and treats `flags` as information only. Whether the ERP's accounting accepts a Rp0 sale line for the bag, or must read the flag, is a **semantic contract change** to confirm with the ERP developer → **Q1**. Also update the YAML "Known value" text to list `giveaway` (docs-only). |
| 1b | Does the builder emit `unit_price: 0`? | **No, today it omits it.** The price comes from `order.LinePrice[m.RefLine]` (`payload.go:174-178`), and a giveaway has no order item. Fix in `buildLine` (`payload.go:151-180`): a `sale` line flagged `giveaway` gets `unit_price` 0, `reason` stays `sale`. Payloads are frozen at first build (`0065_erp_outbox.sql:3-6`), so earlier documents are unaffected. |
| 2 | One outbox row per movement? Kind → document mapping? Kind CHECK? | **One outbox row per document part**, not per movement (`ledger.go:276-293`, `backend/internal/ledger/outbox.go:21-32`, `:38-43`). The relay builds the payload from all movements of that `document_id` (`payload.go:209-215`). Kind passes through as the document kind (`payload.go:90-93`); unknown kinds are dead-lettered (`relay.go:258-260`). CHECKs exist on both tables (`0064_stock_movements.sql:13-14`, `0065_erp_outbox.sql:21-22`). Adding to an already-queued document **fails** (`ledger.go:334-340`), so the giveaway must ride the sale's single `Record` call. → reuse `sale` + flag (§2). |
| 3 | Is consumption replay-safe? | Sale movements are idempotent because a replay never reaches them: the `processed_keys` guard returns first (`order.go:241-247`). A lost same-key race rolls the whole transaction back (`order.go:592`, `:749-756`, `:796-809`; constraints `:779-786`). The sync path enters the same core (`backend/internal/sync/sync.go:184` → `CreateOrderSeq`). The giveaway UPDATE runs inside that transaction, so the **guard, not the dedupe key, protects the stock**. `dedupe_key` `ON CONFLICT DO NOTHING` (`ledger.go:295-300`) is only a backstop. `orderID` is new per committed order, so `giveaway:<orderID>` is one per order. |
| 4 | Does the refund leak the giveaway? | **No leak.** `recordRefundMovements` selects only `order_items` (`ledger_hooks.go:30-39`). Frozen `RefundTx` restocks only order lines. The ERP refund document is built only from the `refund:<order>` document's movements (`payload.go:209-215`). The giveaway is not an `order_items` row, so it is neither restocked nor present in the ERP refund. (The inverse matters: modelling the bag as an order item **would** restock it.) No fix needed; S2 adds a test that proves it. |
| 5 | What about zero bag stock? | `allowNegativeStock` is enforced only on the tablet (`apps/pos/src/cashier/CheckoutPanel.tsx:114-115`, setting at `backend/internal/db/migrations/0033_allow_negative_stock.sql:5`). The server never blocks a sale (A44, `order.go:532-537`). Decision: always decrement and go negative, flag the line `shortage`, never block. The tablet never sees the giveaway, so its overstock guard cannot apply. A `sale_stock_exceptions` row is impossible: `order_item_id` is NOT NULL (`backend/internal/db/migrations/0055_sale_stock_exceptions.sql:9`, `:31`). So the bag shortage shows on the kartu stok (flag filter), **not** in "Stok Minus" (→ Q5). |

**Bundles and reward lines:**
- Bundle lines without a variant skip stock (`order.go:518-528`).
- Loyalty and promo reward lines (`IsReward`, `order.go:61-68`) are ordinary `order_items` that move stock as `sale` lines keyed `sale:<order_item_id>`.
- The giveaway is keyed `giveaway:<order_id>` and added once per order, independent of cart content.
- Example: an order with a sold bag, a reward bag and the giveaway produces three ledger lines on one key, chained in application order, with nothing double-counted. Reward and sold lines get their order price (Rp0 for rewards); only the giveaway carries the flag.

**Unmapped bag (new risk).** If the bag variant has no ERP mapping, the builder **holds the whole sale document** (`payload.go:82-88`, `:110-136`, mapping SQL `:213-214`). So the S2 PUT refuses an unmapped variant while ERP integration is on, and the setting screen shows "belum dipetakan ke ERP".

**ERP document shape after S2** (sale part 0): sale lines unchanged, then `{movement_id, fg_code: <bag FG>, qty: -1, qty_before, qty_after, unit_price: 0, reason: "sale", flags: ["giveaway"]}`.
- `tenders` unchanged (`payload.go:184-195`).
- A sale whose lines all lacked a variant used to queue no document (`outbox.go:38-43`). It now sends one containing only the giveaway line plus the tender. That is correct, but new behaviour; it is covered by a test.

---

## 5. Backoffice screens and POS impact

| Slice | Screen (`apps/backoffice/src/…`) | Content |
|---|---|---|
| S1 | New `screens/inventory/StockCard.tsx` (tab beside `MovementSummary.tsx`) | Filters (location, SKU search, kind chips, date range in outlet tz), rows as §1.1, saldo column, badges `Hadiah`/`Minus`, ERP status, "Unduh CSV"; reference links to order / transfer / count / adjustment |
| S1 | `screens/inventory/MovementSummary.tsx` (238 lines) | Switch to `/inventory/movements/summary` (opening / in / out / closing per SKU); click a row to open its StockCard |
| S2 | New `screens/inventory/OutletGiveawaySection.tsx`, mounted in `OutletFormModal.tsx` | "Hadiah per transaksi": variant picker + toggle; shows ERP-mapped state and current bag stock |
| S3 | New `screens/approvals/ApprovalQueue.tsx` + nav badge (`lib/navAccess.ts`) | Pending counts and adjustments. Detail: lines, before/after, drift, reasons, requester, events. "Setujui" opens a PIN modal; "Tolak" requires a note |
| S3 | `screens/warehouses/AdjustModal.tsx` (94 lines) | Becomes a request form (reason code select + text); shows "Menunggu persetujuan" |
| S3 | `screens/StockCount.tsx` (442 lines) | "Ajukan Persetujuan" (count reason + per-line reasons) replaces "Selesaikan" when the flag is on; shows pending, rejected note, approver |
| S3 | `screens/SettingsScreen.tsx` (`:139`, approver roles `:183-186`) | Toggle "Wajib persetujuan stok" next to the approver roles |
| S4 | New `screens/stockcount/CountCsvPanel.tsx`, one mount line in `StockCount.tsx` | "Unduh CSV", "Unggah Hasil Scan", diff preview table (expected / counted / selisih / previous / warnings), "Terapkan". Reuses `lib/csvUtils.ts` and the `components/ImportDialog.tsx` state pattern |
| S5 | New `screens/requisitions/{RequisitionList,RequisitionForm,RequisitionDetail}.tsx` | Outlet view (own outlet: create / submit / cancel); warehouse view (approve with editable approved qty and source gudang, reject, "Buat Transfer"); links to `screens/transfers/Transfers.tsx` |

**POS tablet impact:**

| Slice | POS / APK / OTA |
|---|---|
| S1, S3, S4, S5 | None. Counts, adjustments and requisitions are backoffice-only (§1.2). The outlet *receive* of a PB transfer is the existing A08 flow. |
| S2 | No POS code. The sale already bumps the outlet stock counter last (`order.go:763`), so tablets pull the bag stock including the giveaway on their next stock pull. **Recommendation: do not show a bag count on the tablet in v1.** The server never blocks, the tablet cannot predict the giveaway, and a later OTA can add an optional "Tas kanvas tersisa N" hint if the owner wants it. Until the pull, the tablet's own bag count reads high by the number of unsynced sales. That is acceptable: the server is authoritative. |

---

## 6. Slices

**S0 owns the OpenAPI spec and both generated files.** Contract-first:
- After S0 merges, no other slice edits `openapi.yaml`, `api.gen.go`, `schema.d.ts` or the `packages/api/src/client.ts` method set (S0 adds all client methods).
- If a slice needs a spec change, it lands as a serialized "S0b" commit on the current tip, with `make gen-go` **and** `corepack pnpm --filter @mandalika/api gen` re-run.
- Generated files are never hand-merged. On conflict, take the merged YAML and regenerate both.

**Shared files with append-only, line-adjacent conflicts.** Resolve by keeping both sides:
- `backend/internal/server/server.go` (routes)
- `scripts/ci/postgres_gate.py` `GATES` (`:32-63`)
- `apps/backoffice/src/lib/navAccess.ts`
- `HANDOFF.md`

**Pre-assigned per slice:**

| Slice | Size | Mig | New PG gate (prefix, test, port) | Depends | Parallel with |
|---|---|---|---|---|---|
| S0 contract | M | 0068 | — | — | — |
| S1 movements read + screen | M | 0069 | MV `TestStockMovementsReadPostgres` 56469 | S0 | S2, S3, S5 |
| S2 giveaway | M (small diff, high risk) | 0070 | GW `TestGiveawayPostgres` 56471 | S0 | S1, S3, S5 |
| S3 approvals | L | 0071 | AP `TestInventoryApprovalPostgres` 56472 | S0 | S1, S2, S5 |
| S4 stock-count CSV | M | 0072 | CV `TestStockCountCsvPostgres` 56473 | S0, **after S3** (both touch `StockCount.tsx`; S3 owns `write/stockcount.go`) | S5 |
| S5 requisitions | L | 0073 | RQ `TestRequisitionPostgres` 56474 | S0 | S1, S2, S3 |

Ports 56469 and 56471-56474 are unused today (`postgres_gate.py:33-62`). `scripts/ci/test_postgres_gate.py` does not assert a gate count (it only uses `GATES[0]`, `:120-141`).

**Merge order:** S0 → S1 → S2 → S3 → S4 → S5 (S5 may merge any time after S0).

**Files per slice:**

| Slice | Backend | Frontend / other |
|---|---|---|
| S0 | `backend/api/openapi.yaml`; generated `internal/api/api.gen.go`; `db/migrations/0068_*.sql` + append-only guard test | `packages/api/src/schema.d.ts`, `packages/api/src/client.ts`, `packages/types/src/index.ts` (`request_stock`) |
| S1 | new `read/movements.go`, `handlers/inventory_movements.go`; `server.go` (manage_inventory group `:266-286`) | `StockCard.tsx`, `MovementSummary.tsx`; test `handlers/stock_movements_read_integration_test.go` |
| S2 | `service/lockorder.go`, `service/ledger_hooks.go`, `integration/erp/payload.go` (+`payload_test.go`), new `write/outlet_giveaway.go`, `read/outlet_giveaway.go`, `handlers/outlet_giveaway.go`, guard maps (§4.1); `server.go`; `docs/integration/stock-documents.v1.yaml` (flag text only) | `OutletGiveawaySection.tsx`; test `handlers/giveaway_integration_test.go` |
| S3 | `write/receive_approval.go` (extract the lockout + argon2 core of `mintReceiveApproval` `:207-292` into a shared `checkApproverPIN`, with the transfer path behaviour byte-equivalent; `insertAttempt` `:125-134` gains doc_type/doc_id); new `write/inventory_approval.go` (scope helper, adjustment requests, delta apply); `write/stockcount.go` (submit / approve / reject; `complete` 409 under the flag; `runningCountConflict` `:244-251` learns the new index names); `write/warehouse.go` (adjust 409 under the flag); `write/settings.go` + `read/settings.go`; `handlers/inventory_approvals.go`, `handlers/stock_counts.go`, `handlers/inventory.go`; `server.go` | `ApprovalQueue.tsx`, `StockCount.tsx`, `AdjustModal.tsx`, `SettingsScreen.tsx`, `navAccess.ts` |
| S4 | new `csvimport/stockcount.go` (Spec: barcode\|sku, counted_qty; sum duplicates); new `write/import_stockcount.go` (planner + apply via `saveCountLines(..., false)` under `lockCount`, `in_progress` only); `write/import.go` (`ImportRequest` `:29-39` gains `TargetID`; `specFor` / `planKind` `:54-82`; replay `:198+` also compares `target_id`); new `handlers/stock_count_csv.go`; `server.go`, `server/bodylimit.go`, `server/deadline.go` | `CountCsvPanel.tsx` |
| S5 | new `write/requisition.go`; `write/transfer.go` (extract `createTransferTx` from `CreateTransfer` `:219-243`, wrapper unchanged); `read/requisition.go`; `handlers/requisitions.go`; `server.go` (`request_stock` group) | `screens/requisitions/*`, `navAccess.ts` |

**Gates per slice.** Run locally: GitHub Actions minutes are exhausted until ~2026-11-01 (`HANDOFF.md:242`).
- **Common gate** (mirrors `.github/workflows/backend.yml:31-40`; archtest runs inside `go test ./...`):
  `cd backend && make gen-check && go vet ./... && test -z "$(gofmt -l .)" && go build ./... && python3 ../scripts/ci/codegen_gate.py && go test ./...`
  - Race coverage comes from the PG gate in docker.
  - Check gofmt with `git show HEAD:<f> | gofmt -l`, because of CRLF.
- **PG gates:**
  `python scripts/ci/postgres_gate.py --runtime docker --go-runner docker --only <list> --output artifacts/postgres/<slice>.json`
  - `--go-runner docker` requires `--runtime docker` (`postgres_gate.py:364`; docker is the default, `:436`).
  - Run the full set (no `--only`) before each merge.
- **JS:** `corepack pnpm quality:ci` (includes `gen:check`) and `corepack pnpm browser:ci`.

| Slice | `--only` | JS gates | Review |
|---|---|---|---|
| S0 | SL,ER,OB | quality:ci | Opus (generated types) |
| S1 | MV,SL,ER,OB | quality:ci, browser:ci | Opus (generated types; read scope / IDOR) |
| S2 | GW,SL,ST,TR,OB,ER,LO,OS,S0C,RF | quality:ci, browser:ci | Opus high (sale path, lock order, ERP payload) |
| S3 | AP,RA,SC,SL,ST,TR,OB,ER | quality:ci, browser:ci | Opus high (stock, auth / PIN) |
| S4 | CV,IM,SC,SL | quality:ci, browser:ci | Opus (stock count, generated types) |
| S5 | RQ,TR,RA,SL,ST,OB,ER | quality:ci, browser:ci | Opus (transfers, scope) |

**What each new gate proves:**
- **MV:** saldo chain continuity, keyset paging, outlet-scope refusal, CSV equals JSON.
- **GW:**
  - one bag per sale;
  - replay and same-key race leave the bag untouched;
  - refund leaves the bag unrestocked and the ERP refund payload has no giveaway line;
  - sold bag + reward bag + giveaway chain correctly;
  - zero stock goes negative with the `shortage` flag;
  - no setting means no movement;
  - a concurrent bag sale in reversed cart order completes without deadlock;
  - the ledger invariant query returns 0 rows.
- **AP:** request → approve applies the delta; self-approval → 409; wrong PIN → lockout; flag on → old endpoints 409; count pending blocks a second open count; reject → in_progress.
- **CV:** duplicate scans summed; unknown or ambiguous code reported; stale-file commit 409; replay with the same key returns the stored result; a commit never applies stock.
- **RQ:** state machine; fulfil creates one draft with approved quantities; re-fulfil only after cancel; outlet scope.

**What the auditor can test after each slice** (on the test env, once deployed):

| After | Auditor test |
|---|---|
| S1 | Open the Canvas Bag kartu stok at an outlet: opening, receipts, transfers, sales, counts and adjustments with running saldo; closing = live stock; export and re-sum the CSV |
| S2 | Ring up a sale without a bag: the bag goes −1 with order number and badge "Hadiah". Refund it: the bag stays. ERP outbox payload: Rp0 line flagged `giveaway` |
| S3 | Request an adjustment, try the old path (refused), try self-approval (refused), approve with PIN (applied, history), reject one; submit a count → approve → kind `count` rows |
| S4 | Export a count CSV, scan with a phone app, upload, review the diff, apply, then submit for approval |
| S5 | Outlet raises PB → warehouse approves partial → "Buat Transfer" → send → outlet receives (A08) → PB shows the full chain |

---

## 7. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | **Nov 2 ERP demo** (`HANDOFF.md:47`) destabilised | No deploy before the demo unless the owner says so; build and merge locally only. S2 touches the sale path and the ERP payload: deploy it after the demo, with tablets at 0 pending (HANDOFF owner decision 2026-10-10). Every slice is inert on deploy: no giveaway row, approval flag false, new tables unused. |
| R2 | **ERP contract** | The wire is unchanged: no new kind, field types or required fields (§4.2 Q1). The **meaning changes**: the ERP will book a Rp0 sale line unless it reads `flags`. Flagged as Q1. The YAML "known value" text gets `giveaway`. |
| R3 | **Frozen functions** | `createOrderCore`, `RefundTx`, `processOneWithSeq`: no edits. S2 changes only `lockorder.go` and `ledger_hooks.go`, behind the D10 call (`order.go:632`). Reviewer checks that `git diff` shows no hunks inside those function ranges (declhash as in the reorg plan). |
| R4 | Lock-order deadlock from the giveaway row | Sorted pre-lock in `lockStockRowsSorted` + `FOR SHARE` on the setting (§4.1); GW reversed-cart test; LO gate. |
| R5 | **Unmapped bag holds every sale document** (`payload.go:82-88`) | PUT refuses unmapped variants while ERP is on; the screen shows the mapping state; demo ERP seed has only 24 FGs (ERP reply `:140`). |
| R6 | Giveaway vs refund | Not an order item, so neither restocked nor in the ERP refund (§4.2 Q4); GW asserts it. |
| R7 | Giveaway vs bundles / reward lines | Independent key per order; chain order (giveaway last); GW asserts three lines on one key. |
| R8 | Replay / double bag | `processed_keys` guard + full rollback on race (§4.2 Q3); GW asserts it. |
| R9 | Zero or negative bag stock | Never blocks; `shortage` flag; visible on kartu stok, not "Stok Minus" (Q5). |
| R10 | Variant rename/delete or ERP tombstone orphans the setting | Hook skips with a warn; setting screen shows "tidak valid"; event row on change. |
| R11 | Approval stalls | Only the admin has a PIN today; admins-only approve by owner decision (`HANDOFF.md:241`). A single admin cannot satisfy four-eyes (Q2). |
| R12 | Absolute adjustment applied late overwrites sales | Delta apply + drift shown (Q3). |
| R13 | Two open counts at one location double-apply | Wider unique index (0071); `runningCountConflict` updated. |
| R14 | CSV SKU ambiguity until 0067 ships | Barcode first; ambiguous SKU = row error. |
| R15 | Old "Ringkasan Pergerakan" disagrees with the ledger once the giveaway exists | S1 rebases it on the ledger; S1 merges before S2 is deployed. |
| R16 | Warehouse-side documents (PB transfers, warehouse adjustments) | Held in the ERP outbox by design (ERP reply `:60`, `:72`); expected, not a bug. |
| R17 | `receive_approval.go` refactor regresses A08 | RA gate in S3 and S5; Opus review; transfer-path behaviour byte-equivalent. |

---

## 8. Open questions for the owner

1. **ERP booking of the giveaway line.** It is wire-compatible, but the ERP will post it as a sale OUT at Rp0 unless it reads `flags`. Is that what the ERP's accounting wants?
   *Recommended default:* ship `reason: "sale"`, `flags: ["giveaway"]`, `unit_price: 0`; send the ERP developer a one-paragraph note before S2 is deployed. If they need a distinct marker, switch `reason` to `"giveaway"`: still kind `sale`, no schema change.
2. **Approval policy.**
   *Recommended default:* when the flag is on, every manual adjustment and every count with at least one non-zero difference needs approval; approver ≠ requester always, admin included; outlet documents are approved by admin or an approver-role user of that outlet; warehouse documents by admin only; PIN re-entry on every approval. Also: should admins set PINs for approver roles so a second person exists?
3. **An approved adjustment after stock moved.**
   *Recommended default:* apply the requested *delta* and show drift on the approval card. The alternative is to refuse as stale and require a new request.
4. **Scanner CSV baseline and blind counting.**
   *Recommended default:*
   - the upload measures against the count-start snapshot, and the preview flags SKUs that moved since start;
   - pause sales during opname, or count by section;
   - the export includes expected qty as decided.
   An optional "tanpa qty sistem" (blind) export can follow if the auditor asks.
5. **Giveaway edge policy.**
   *Recommended default:*
   - one bag per completed order, always, including Rp0 / reward-only orders and orders that also buy bags;
   - at zero stock, still decrement (negative + flag) rather than skip;
   - the bag shortage shows on the kartu stok and a giveaway low-stock badge, not in "Stok Minus";
   - no tablet bag counter in v1.
