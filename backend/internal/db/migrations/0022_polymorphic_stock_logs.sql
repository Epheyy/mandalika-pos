-- 0022: make goods-in + stock-adjustment logs location-polymorphic (outlet OR
-- warehouse) so outlets gain the same auditable goods-in / koreksi operations
-- warehouses have. Mirrors the stock_counts polymorphic pattern (migration 0015).

ALTER TABLE goods_receipts ALTER COLUMN warehouse_id DROP NOT NULL;
ALTER TABLE goods_receipts ADD COLUMN IF NOT EXISTS outlet_id uuid
  REFERENCES outlets(id) ON DELETE CASCADE;
ALTER TABLE goods_receipts ADD CONSTRAINT goods_receipts_one_location
  CHECK (num_nonnulls(outlet_id, warehouse_id) = 1);

ALTER TABLE warehouse_stock_adjustments ALTER COLUMN warehouse_id DROP NOT NULL;
ALTER TABLE warehouse_stock_adjustments ADD COLUMN IF NOT EXISTS outlet_id uuid
  REFERENCES outlets(id) ON DELETE CASCADE;
ALTER TABLE warehouse_stock_adjustments ADD CONSTRAINT warehouse_stock_adjustments_one_location
  CHECK (num_nonnulls(outlet_id, warehouse_id) = 1);
