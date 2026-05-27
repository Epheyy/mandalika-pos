-- 0019: ingredient inventory subsystem (parallel to products/warehouses).
-- Numeric qty everywhere; warehouse-only; backoffice-only (never POS-synced).
-- Module-gated by app_settings.recipes_enabled (default false).

-- Module gate (singleton settings row gets one extra column)
ALTER TABLE app_settings ADD COLUMN recipes_enabled boolean NOT NULL DEFAULT false;

-- Ingredients catalog (flat — no variants)
CREATE TABLE ingredients (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text NOT NULL,
  unit                text NOT NULL,
  default_unit_cost   numeric(14,2),
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
  unit_cost     numeric(14,2)
);

-- Manual adjust (absolute set + reason)
CREATE TABLE ingredient_stock_adjustments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id  uuid NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  ingredient_id uuid NOT NULL REFERENCES ingredients(id),
  new_qty       numeric(14,3) NOT NULL,
  reason        text NOT NULL,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Warehouse-to-warehouse transfers (Postgres SEQUENCE for the short id,
-- mirroring SP2 `transfers.transfer_no`).
CREATE SEQUENCE IF NOT EXISTS ingredient_transfer_no_seq;

CREATE TABLE ingredient_transfers (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_no              text NOT NULL DEFAULT ('ITRF-' || lpad(nextval('ingredient_transfer_no_seq')::text, 5, '0')),
  source_warehouse_id      uuid NOT NULL REFERENCES warehouses(id),
  dest_warehouse_id        uuid NOT NULL REFERENCES warehouses(id),
  status                   text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','in_transit','completed','cancelled')),
  surat_jalan_no           text UNIQUE,
  tanda_terima_no          text UNIQUE,
  note                     text,
  discrepancy_reason       text,
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
  received_qty  numeric(14,3),
  difference    numeric(14,3)
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
  ingredient_name text NOT NULL,
  ingredient_unit text NOT NULL,
  counted         numeric(14,3),
  difference      numeric(14,3)
);
