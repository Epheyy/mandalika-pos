-- A27: reports recognise a refund on the REFUND business day (orders.refund_business_date, A28).
-- Additive and idempotent. 0057 stays reserved for A15 B.
--
-- 0059 stamped refund_business_date only where refunded_at was set; a legacy refunded row without
-- refunded_at kept NULL and would vanish from the refund side of the summary. Give it the sale day
-- (the same fallback the INSERT trigger uses).
UPDATE orders o SET refund_business_date = COALESCE(
    (SELECT s.business_date FROM shifts s WHERE s.id = o.refund_shift_id),
    business_date_at(o.outlet_id, COALESCE(o.refunded_at, o.created_at)))
  WHERE o.status = 'refunded' AND o.refund_business_date IS NULL;

-- The summary reads the refund side by (outlet, refund day) or by refund day across outlets.
CREATE INDEX IF NOT EXISTS idx_orders_outlet_refund_bd ON orders(outlet_id, refund_business_date)
  WHERE refund_business_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_refund_bd ON orders(refund_business_date)
  WHERE refund_business_date IS NOT NULL;
