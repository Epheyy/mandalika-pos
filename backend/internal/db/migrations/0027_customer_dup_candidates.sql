-- 0027_customer_dup_candidates.sql
-- SP-CRM-3: flag offline-miss duplicate customers (same phone) for a future
-- backoffice merge tool. Review-queue-ready via `status`.
CREATE TABLE customer_dup_candidates (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  new_customer_id      uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  existing_customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  phone                text NOT NULL,
  status               text NOT NULL DEFAULT 'pending', -- pending | merged | dismissed
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_dup_candidates_status ON customer_dup_candidates(status);
CREATE UNIQUE INDEX idx_dup_candidates_pair ON customer_dup_candidates (new_customer_id, existing_customer_id);

-- Supports RecentCustomersForOutlet on the hot, multi-million-row orders table.
CREATE INDEX idx_orders_outlet_created ON orders (outlet_id, created_at DESC);
