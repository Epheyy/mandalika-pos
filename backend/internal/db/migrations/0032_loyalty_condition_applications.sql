-- 0032_loyalty_condition_applications.sql
-- SP-CRM-8: append-only audit of which loyalty_conditions fired on which order.
-- One row per matched condition (set_points / multiply_points / product_reward).
-- points_contributed is the engine's per-condition attribution for reporting; the
-- order's true earned total lives in orders.points_earned + the earn ledger entry.
-- product_reward rows carry reward_product_ids and points_contributed=0 (fulfillment
-- is deferred to a future POS slice).

CREATE TABLE loyalty_condition_applications (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id           uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  customer_id        uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  condition_id       uuid REFERENCES loyalty_conditions(id) ON DELETE SET NULL,
  condition_name     text NOT NULL,
  trigger            text NOT NULL,
  reward_type        text NOT NULL,
  reward_value       numeric(14,2) NOT NULL DEFAULT 0,
  points_contributed integer NOT NULL DEFAULT 0,
  reward_product_ids jsonb,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_lca_order      ON loyalty_condition_applications (order_id);
CREATE INDEX idx_lca_condition  ON loyalty_condition_applications (condition_id, created_at DESC);
CREATE INDEX idx_lca_customer   ON loyalty_condition_applications (customer_id, created_at DESC);
CREATE UNIQUE INDEX uq_lca_order_condition
  ON loyalty_condition_applications (order_id, condition_id);
