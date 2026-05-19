-- Payment methods are configurable in Backoffice (app_settings.payment_methods
-- jsonb), so the orders.payment_method value can be any configured id (e.g.
-- 'bca', 'neo_bank'), not just the original cash/card/transfer/qris set.
-- The fixed CHECK rejected every sale paid with a custom method (SQLSTATE
-- 23514), permanently stalling sync. Drop it; NOT NULL still applies.
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_payment_method_check;
