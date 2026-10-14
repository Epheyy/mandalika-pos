-- 0051 (A14): product stock counts apply the counted difference instead of an
-- absolute value. Items gain a server-captured per-line baseline, a count time and
-- the stock seen before/after completion; a count line is unique per variant; and
-- a location can have at most one running count (two would apply the same shortfall
-- twice). Additive: no data rewrite; existing counts are completed with no duplicates.
ALTER TABLE stock_count_items
  ADD COLUMN IF NOT EXISTS baseline_qty integer,
  ADD COLUMN IF NOT EXISTS counted_at   timestamptz,
  ADD COLUMN IF NOT EXISTS stock_before integer,
  ADD COLUMN IF NOT EXISTS stock_after  integer;

CREATE UNIQUE INDEX IF NOT EXISTS stock_count_items_line_uq
  ON stock_count_items (stock_count_id, product_id, variant_size);

CREATE UNIQUE INDEX IF NOT EXISTS stock_counts_one_running_outlet
  ON stock_counts (outlet_id) WHERE status = 'in_progress' AND outlet_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS stock_counts_one_running_warehouse
  ON stock_counts (warehouse_id) WHERE status = 'in_progress' AND warehouse_id IS NOT NULL;
