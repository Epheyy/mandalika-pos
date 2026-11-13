-- 0093: Void phase 2 (replacement and shift accounting). A replacement may carry a signed price
-- adjustment ("Penyesuaian koreksi"), and a void or replacement on a CLOSED shift is booked as
-- append-only per-method correction rows next to the frozen close figures (the close snapshot is
-- never recomputed). Additive only.
SET LOCAL lock_timeout = '5s';

ALTER TABLE orders
  ADD COLUMN correction_amount numeric NOT NULL DEFAULT 0;

-- Points the replacement did NOT earn because the void had already written them off (the customer
-- spent them before the void): owner rule "deduct written-off". Recorded on the void row for a
-- replacement made with the void, on the followup row for a later "Buat pengganti".
ALTER TABLE order_voids ADD COLUMN replacement_points_deducted integer NOT NULL DEFAULT 0;
ALTER TABLE order_void_followups ADD COLUMN replacement_points_deducted integer NOT NULL DEFAULT 0;

CREATE TABLE shift_corrections (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id   uuid NOT NULL REFERENCES shifts(id),
  void_id    uuid NOT NULL REFERENCES order_voids(id) DEFERRABLE INITIALLY DEFERRED,
  order_id   uuid NOT NULL REFERENCES orders(id),
  kind       text NOT NULL CHECK (kind IN ('void','replacement')),
  method     text NOT NULL,
  amount     numeric NOT NULL CHECK (amount <> 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, kind, method)
);
CREATE INDEX idx_shift_corrections_shift ON shift_corrections (shift_id);

CREATE TRIGGER shift_corrections_append_only BEFORE UPDATE OR DELETE ON shift_corrections
  FOR EACH ROW EXECUTE FUNCTION forbid_void_audit_change();
