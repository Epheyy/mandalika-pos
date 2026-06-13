-- SP-Promo-1: flag an order whose applied discount violated a stored rule but was
-- accepted anyway because the sale arrived via the offline sync path (cash already
-- collected). Mirrors stock_warning (0002): record reality, flag for reconciliation.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_warning        boolean NOT NULL DEFAULT false;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_warning_reason text;
