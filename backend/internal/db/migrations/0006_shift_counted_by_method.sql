-- Per-method counted cash for shift reconciliation. The cashier fills in the
-- physically-counted income per payment method at close; the read model
-- surfaces it as "Terhitung" against the server-computed "Tercatat" so the
-- Selisih (difference) is visible in the recap + shift history.
-- Nullable: shifts closed before this feature (and shifts not yet reconciled)
-- simply have no counted figures.
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS counted_by_method jsonb;
