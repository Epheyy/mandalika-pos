-- 0031_points_ledger.sql
-- SP-CRM-7: append-only points ledger + per-order earned-points record.
-- customers.points stays the cached authoritative balance; this table is the audit
-- spine (ledger-forward-only, no backfill). Balance never goes negative.

CREATE TABLE point_transactions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id     uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  type            text NOT NULL CHECK (type IN ('earn','redeem','adjust','refund')),
  points          integer NOT NULL,            -- signed delta (+earn, -redeem, ± adjust/refund)
  balance_after   integer NOT NULL,            -- cached balance immediately after this entry
  reason          text,
  order_id        uuid REFERENCES orders(id) ON DELETE SET NULL,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by_name text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_point_transactions_customer
  ON point_transactions (customer_id, created_at DESC, id DESC);

-- Earned points recorded per order from now on, so refund can claw back the exact
-- amount. Pre-existing orders keep 0 (no clawback; redeemed still restorable).
ALTER TABLE orders ADD COLUMN points_earned integer NOT NULL DEFAULT 0;
