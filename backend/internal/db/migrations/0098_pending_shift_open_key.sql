-- 0098: shift-less sale attribution. A sale or cash movement captured while its tablet's shift_open
-- is still in the outbox carries no shift id (the server mints it). The tablet stamps the pending
-- open's idempotency key in the capture envelope; the server stores it here with shift_id NULL and
-- the shift_open backfills shift_id for rows of its outlet carrying that key. The column stays after
-- the backfill as audit evidence. Additive only: both columns are nullable and unread by old code.
SET LOCAL lock_timeout = '5s';

ALTER TABLE orders ADD COLUMN IF NOT EXISTS pending_shift_open_key text;
ALTER TABLE cash_flows ADD COLUMN IF NOT EXISTS pending_shift_open_key text;

CREATE INDEX IF NOT EXISTS idx_orders_pending_shift_open
  ON orders (outlet_id, pending_shift_open_key)
  WHERE shift_id IS NULL AND pending_shift_open_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cash_flows_pending_shift_open
  ON cash_flows (outlet_id, pending_shift_open_key)
  WHERE shift_id IS NULL AND pending_shift_open_key IS NOT NULL;
