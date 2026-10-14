-- A12: defense in depth for "one open shift per outlet". OpenShiftTx already
-- serializes opens under an outlet row lock; this index makes the invariant hold
-- even if a future path bypasses that lock.
CREATE UNIQUE INDEX IF NOT EXISTS shifts_one_open_per_outlet_idx
  ON shifts (outlet_id) WHERE status = 'open';
