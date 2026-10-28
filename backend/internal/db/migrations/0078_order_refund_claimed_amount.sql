-- D-49: the refund amount of record (order_refunds.amount) is capped at what the order still has
-- left to refund, so the tablet's claimed (paid-out) amount is kept beside it as information.
-- NULL = no claim (legacy payload, backfilled rows, backoffice route) or an ignored malformed one.
-- Additive: an old binary never reads or writes the column.
ALTER TABLE order_refunds
  ADD COLUMN claimed_amount numeric(14,2) CHECK (claimed_amount >= 0);
