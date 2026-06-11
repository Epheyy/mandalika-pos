-- SP-CRM-9c: per-deployment control over whether the POS may oversell.
-- Default true preserves the existing offline-first behavior (sell + flag for
-- reconciliation); set false to make the POS warn the cashier at checkout.
ALTER TABLE app_settings
  ADD COLUMN IF NOT EXISTS allow_negative_stock boolean NOT NULL DEFAULT true;
