-- 0100_points_debt.sql
-- A20: a refund claw that the balance cannot cover is no longer forgiven. The shortfall becomes a debt on
-- the customer (points_debt), recovered from FUTURE sale earnings with no expiry, and is recorded on the
-- refund (points_debt_added) so the cumulative claw of a later refund of the same order treats it as
-- already taken. Additive only.

ALTER TABLE customers ADD COLUMN points_debt integer NOT NULL DEFAULT 0 CHECK (points_debt >= 0);
ALTER TABLE order_refunds ADD COLUMN points_debt_added integer NOT NULL DEFAULT 0;

-- The part of an order's gross earn (points_earned) that paid down the customer's points debt at sale
-- time. A void reinstates it as debt (the earn was never really the customer's), instead of erasing it.
-- order_voids.points_debt_reinstated records what that void put back.
ALTER TABLE orders ADD COLUMN points_debt_settled integer NOT NULL DEFAULT 0 CHECK (points_debt_settled >= 0);
ALTER TABLE order_voids ADD COLUMN points_debt_reinstated integer NOT NULL DEFAULT 0 CHECK (points_debt_reinstated >= 0);

-- Every debt movement is auditable in the points ledger. debt_delta is the signed change of
-- customers.points_debt; a row may move only the debt (points = 0), so the old points <> 0 check
-- (auto-named by 0031) becomes "points or debt moved".
ALTER TABLE point_transactions ADD COLUMN debt_delta integer NOT NULL DEFAULT 0;
ALTER TABLE point_transactions DROP CONSTRAINT point_transactions_points_check;
ALTER TABLE point_transactions ADD CONSTRAINT point_transactions_points_check
  CHECK (points <> 0 OR debt_delta <> 0);
