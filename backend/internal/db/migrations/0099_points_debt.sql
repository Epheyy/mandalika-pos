-- 0099_points_debt.sql
-- A20: a refund claw that the balance cannot cover is no longer forgiven. The shortfall becomes a debt on
-- the customer (points_debt), recovered from FUTURE sale earnings with no expiry, and is recorded on the
-- refund (points_debt_added) so the cumulative claw of a later refund of the same order treats it as
-- already taken. Additive only.

ALTER TABLE customers ADD COLUMN points_debt integer NOT NULL DEFAULT 0 CHECK (points_debt >= 0);
ALTER TABLE order_refunds ADD COLUMN points_debt_added integer NOT NULL DEFAULT 0;
