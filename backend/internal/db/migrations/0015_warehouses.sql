-- 0015: warehouses (separate stock subsystem) + goods-in, adjust, and
-- location-polymorphic stock-count. Warehouses are never POS-synced.
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
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id   uuid NOT NULL REFERENCES goods_receipts(id) ON DELETE CASCADE,
  product_id   uuid NOT NULL REFERENCES products(id),
  variant_size text NOT NULL,
  qty          integer NOT NULL,
  unit_cost    numeric(14,2)
);

CREATE TABLE warehouse_stock_adjustments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id uuid NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  product_id   uuid NOT NULL REFERENCES products(id),
  variant_size text NOT NULL,
  new_qty      integer NOT NULL,
  reason       text NOT NULL,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- location-polymorphic opname (reuse, don't duplicate): a stock count belongs to
-- exactly one of an outlet OR a warehouse.
ALTER TABLE stock_counts ALTER COLUMN outlet_id DROP NOT NULL;
ALTER TABLE stock_counts ADD COLUMN warehouse_id uuid REFERENCES warehouses(id) ON DELETE CASCADE;
ALTER TABLE stock_counts ADD CONSTRAINT stock_counts_one_location
  CHECK (num_nonnulls(outlet_id, warehouse_id) = 1);
