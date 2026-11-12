-- 0090: bundle sale lines. A bundle in a sale is three ordinary order lines (large bottle,
-- 10ml atomizer, 2ml vial), qty 1 each, tied by a per-order bundle_group. These columns are
-- NOT the legacy is_bundle flag (the Firestore bundle header). Adding nullable columns without
-- a default is a catalog-only change on PostgreSQL 11+.
SET LOCAL lock_timeout = '5s';

ALTER TABLE order_items
  ADD COLUMN bundle_group smallint CHECK (bundle_group BETWEEN 1 AND 32767),
  ADD COLUMN bundle_role text CHECK (bundle_role IN ('large','atomizer','vial')),
  ADD COLUMN bundle_line text,
  ADD COLUMN bundle_size text,
  ADD COLUMN bundle_discount numeric(14,2) CHECK (bundle_discount >= 0),
  ADD COLUMN bundle_promotion_id uuid,
  ADD CONSTRAINT order_items_bundle_pair CHECK ((bundle_group IS NULL) = (bundle_role IS NULL));
