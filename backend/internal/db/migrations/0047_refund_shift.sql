-- A06/Q2b: who paid a refund out, and from which shift's drawer. Additive: the
-- previous revision never reads or writes these columns (nullable / defaulted).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_shift_id  uuid REFERENCES shifts(id) ON DELETE SET NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refunded_by      uuid;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refunded_by_name text;
CREATE INDEX IF NOT EXISTS idx_orders_refund_shift ON orders(refund_shift_id) WHERE refund_shift_id IS NOT NULL;
-- Close-time snapshot of refunds paid by this shift for sales of OTHER shifts.
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS refunds_paid_by_method jsonb;
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS cash_refunds_paid      numeric(14,2) NOT NULL DEFAULT 0;
