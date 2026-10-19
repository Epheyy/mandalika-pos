-- A10: keep the receipt total the cashier quoted. Additive only.
--
-- quoted_total already exists (migration 0002). Before this migration it was written
-- with the server's OWN recomputed total, so every pre-0058 row has quoted_total == total
-- and carries no real quote. This migration deliberately does NOT rewrite those rows:
-- receipt_snapshot IS NULL is what marks "no real quote" (a real quote always has a
-- snapshot, or is NULL when the client sent none / an invalid one).
--
-- receipt_snapshot: the client's printed receipt (money + lines, no customer name or
-- phone), stored exactly as sent. Never exposed in list JSON, never changed by a refund.
-- quote_warning / quote_warning_reason: set when the quote differs from the server total
-- by more than Rp1 ('quote_mismatch') or was unusable ('quote_invalid'). Flag-only.
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS receipt_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS quote_warning boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS quote_warning_reason text;
