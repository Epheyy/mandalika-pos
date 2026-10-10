-- A09: tender rules. Orders accepted offline (or non-cash online) with a tender that
-- does not match the due total are flagged for admin review instead of rejected.
-- Additive: the previous revision ignores both columns. Distinct from discount_warning.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tender_warning        boolean NOT NULL DEFAULT false;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tender_warning_reason text;
