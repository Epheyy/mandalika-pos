-- Phase C — write path: surcharge fields, offline reconciliation audit,
-- per-outlet order-number sequence.

-- Surcharge (CashierScreen.tsx:328-332 / :743) was computed client-side but
-- never persisted; the write path now stores it.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS surcharge_type   text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS surcharge_value  numeric(14,2);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS surcharge_amount numeric(14,2) NOT NULL DEFAULT 0;

-- Offline reconciliation (plan §5): the client-quoted total at sale time vs the
-- server-recomputed canonical total; stock_warning flags an order whose stock
-- decrement went negative (offline could not reserve stock).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS quoted_total  numeric(14,2);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS stock_warning boolean NOT NULL DEFAULT false;

-- Per-outlet, per-day order number sequence. order_number is assigned by the
-- server at (sync) time so offline/multi-device sales never collide (plan §5).
CREATE TABLE IF NOT EXISTS order_counters (
  outlet_id uuid NOT NULL,
  day       date NOT NULL,
  seq       bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (outlet_id, day)
);
