-- 0034_customer_merges.sql
-- SP-CRM-Merge: soft-tombstone + redirect for merged duplicate customers,
-- plus an audit spine that makes a mistaken merge recoverable by hand.

ALTER TABLE customers ADD COLUMN merged_into uuid REFERENCES customers(id) ON DELETE SET NULL;
ALTER TABLE customers ADD COLUMN merged_at   timestamptz;

-- Only tombstoned rows are indexed (rare), so redirect lookups stay cheap
-- without bloating the big customer indexes.
CREATE INDEX idx_customers_merged_into ON customers(merged_into) WHERE merged_into IS NOT NULL;

CREATE TABLE customer_merges (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  keeper_id         uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  dup_id            uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  field_choices     jsonb NOT NULL,
  dup_snapshot      jsonb NOT NULL,
  moved_order_ids   uuid[] NOT NULL DEFAULT '{}',
  points_moved      integer NOT NULL DEFAULT 0,
  performed_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  performed_by_name text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_customer_merges_keeper ON customer_merges (keeper_id, created_at DESC);
