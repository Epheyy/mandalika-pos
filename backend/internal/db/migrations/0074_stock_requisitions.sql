-- Inventory controls S5: "Permintaan Barang" (PB), the outlet's request to a warehouse.
-- The warehouse approves per line and fulfils it into a gudang -> toko transfer DRAFT; stock
-- moves only through the existing transfer send/receive. The PB gets no ERP document.
--
-- Additive only: new tables the previous revision ignores, so rollback is a plain redeploy.
-- Numbers come from doc_sequences kind 'PB' (no schema change needed).
SET LOCAL lock_timeout = '5s';
CREATE TABLE stock_requisitions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number        text NOT NULL UNIQUE,                     -- doc_sequences kind 'PB'
  status        text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','submitted','approved','rejected','fulfilled','cancelled')),
  outlet_id     uuid NOT NULL REFERENCES outlets(id),     -- requester / destination
  warehouse_id  uuid REFERENCES warehouses(id),           -- source; required from 'approved'
  needed_by     date, note text,
  requested_by  uuid NOT NULL, submitted_at timestamptz, submitted_by uuid,
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
  product_id     uuid NOT NULL REFERENCES products(id), variant_size text NOT NULL,
  requested_qty  integer NOT NULL CHECK (requested_qty > 0),
  approved_qty   integer CHECK (approved_qty >= 0),
  note           text,
  UNIQUE (requisition_id, product_id, variant_size)        -- same rule as transfer item validation
);
