-- Inventory controls S4: the scanner CSV upload of a stock count reuses the import_runs
-- idempotency/replay record. kind gains 'stock_count'; target_id names the count so a replay
-- of the same key and file for a DIFFERENT count is a key conflict, not a replay.
--
-- Additive only: the previous revision ignores target_id and never writes the new kind, so
-- rollback is a plain redeploy. Never renumber this file.
SET LOCAL lock_timeout = '5s';
ALTER TABLE import_runs DROP CONSTRAINT import_runs_kind_check;
ALTER TABLE import_runs ADD CONSTRAINT import_runs_kind_check
  CHECK (kind IN ('customers','products','ingredients','sku_mapping','stock_count'));
ALTER TABLE import_runs ADD COLUMN target_id uuid;      -- the stock_count id for kind stock_count
CREATE INDEX import_runs_target ON import_runs (target_id) WHERE target_id IS NOT NULL;
