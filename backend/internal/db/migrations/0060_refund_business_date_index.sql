-- A27: reports recognise a refund on the REFUND business day (orders.refund_business_date, A28).
-- Additive and idempotent. 0057 stays reserved for A15 B.
--
-- 0059 stamped refund_business_date only where refunded_at was set; a legacy refunded row without
-- refunded_at kept NULL and would vanish from the refund side of the summary. Give it the row's
-- own sale business day (a shift-opening day can differ from the created_at calendar day).
UPDATE orders o SET refund_business_date = COALESCE(
    (SELECT s.business_date FROM shifts s WHERE s.id = o.refund_shift_id),
    CASE WHEN o.refunded_at IS NOT NULL THEN business_date_at(o.outlet_id, o.refunded_at) END,
    o.business_date)
  WHERE o.status = 'refunded' AND o.refund_business_date IS NULL;

-- The summary reads the refund side by (outlet, refund day) or by refund day across outlets.
CREATE INDEX IF NOT EXISTS idx_orders_outlet_refund_bd ON orders(outlet_id, refund_business_date)
  WHERE refund_business_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_refund_bd ON orders(refund_business_date)
  WHERE refund_business_date IS NOT NULL;
