-- 0023: outlets can store ingredients. Mirrors the polymorphic pattern
-- (migrations 0015 + 0022) — exactly one of (outlet_id, warehouse_id) per row.
-- Goal: ingredient_outlet_stock table + location-polymorphic goods_receipts,
-- stock_adjustments, transfers, and stock_counts for ingredients.

-- 1) New outlet ingredient stock table (numeric qty like ingredient_warehouse_stock).
CREATE TABLE ingredient_outlet_stock (
  outlet_id     uuid NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
  ingredient_id uuid NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  qty           numeric(14,3) NOT NULL DEFAULT 0,
  PRIMARY KEY (outlet_id, ingredient_id)
);

-- 2) Polymorphic ingredient_goods_receipts.
ALTER TABLE ingredient_goods_receipts ALTER COLUMN warehouse_id DROP NOT NULL;
ALTER TABLE ingredient_goods_receipts ADD COLUMN IF NOT EXISTS outlet_id uuid
  REFERENCES outlets(id) ON DELETE CASCADE;
ALTER TABLE ingredient_goods_receipts ADD CONSTRAINT ingredient_goods_receipts_one_location
  CHECK (num_nonnulls(outlet_id, warehouse_id) = 1);

-- 3) Polymorphic ingredient_stock_adjustments.
ALTER TABLE ingredient_stock_adjustments ALTER COLUMN warehouse_id DROP NOT NULL;
ALTER TABLE ingredient_stock_adjustments ADD COLUMN IF NOT EXISTS outlet_id uuid
  REFERENCES outlets(id) ON DELETE CASCADE;
ALTER TABLE ingredient_stock_adjustments ADD CONSTRAINT ingredient_stock_adjustments_one_location
  CHECK (num_nonnulls(outlet_id, warehouse_id) = 1);

-- 4) Polymorphic ingredient_transfers (mesh: any source kind ↔ any dest kind).
-- Drop the warehouse-distinct constraint; "no self-transfer" is enforced in
-- application code (same pattern as the regular product transfers).
ALTER TABLE ingredient_transfers DROP CONSTRAINT IF EXISTS ingredient_transfers_distinct;
ALTER TABLE ingredient_transfers ALTER COLUMN source_warehouse_id DROP NOT NULL;
ALTER TABLE ingredient_transfers ALTER COLUMN dest_warehouse_id   DROP NOT NULL;
ALTER TABLE ingredient_transfers ADD COLUMN IF NOT EXISTS source_outlet_id uuid
  REFERENCES outlets(id);
ALTER TABLE ingredient_transfers ADD COLUMN IF NOT EXISTS dest_outlet_id uuid
  REFERENCES outlets(id);
ALTER TABLE ingredient_transfers ADD CONSTRAINT ingredient_transfers_one_source
  CHECK (num_nonnulls(source_outlet_id, source_warehouse_id) = 1);
ALTER TABLE ingredient_transfers ADD CONSTRAINT ingredient_transfers_one_dest
  CHECK (num_nonnulls(dest_outlet_id, dest_warehouse_id) = 1);

-- 5) Polymorphic ingredient_stock_counts.
ALTER TABLE ingredient_stock_counts ALTER COLUMN warehouse_id DROP NOT NULL;
ALTER TABLE ingredient_stock_counts ADD COLUMN IF NOT EXISTS outlet_id uuid
  REFERENCES outlets(id) ON DELETE CASCADE;
ALTER TABLE ingredient_stock_counts ADD CONSTRAINT ingredient_stock_counts_one_location
  CHECK (num_nonnulls(outlet_id, warehouse_id) = 1);
