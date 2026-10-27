SET LOCAL lock_timeout = '5s';
-- C4a per-line refund. A refund becomes a row (order_refunds) with its refunded lines
-- (order_refund_items) instead of single-valued columns on orders, so one order can carry
-- several partial refunds. Additive: the orders.refund_* columns stay (written by the refund
-- that completes the order), an old binary ignores the new tables and columns.

CREATE TABLE order_refunds (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id            uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  outlet_id           uuid NOT NULL REFERENCES outlets(id),
  seq                 smallint NOT NULL CHECK (seq > 0),          -- 1, 2, ... per order ("Refund 2")
  scope               text NOT NULL CHECK (scope IN ('full', 'partial', 'legacy_full')),
  amount              numeric(14,2) NOT NULL CHECK (amount >= 0), -- amount of record: what was paid out
  computed_amount     numeric(14,2) NOT NULL CHECK (computed_amount >= 0),
  amount_warning      text,                                       -- amount_mismatch / over_total
  payment_method      text NOT NULL,                              -- = orders.payment_method (no re-tender)
  reason              text NOT NULL,
  reason_code         text,
  shift_id            uuid REFERENCES shifts(id) ON DELETE SET NULL,
  refunded_by         uuid,
  refunded_by_name    text,
  approval_grant_id   uuid,                                       -- reserved (refund PIN slice, dropped)
  device_id           text,
  client_refund_uuid  uuid,
  ledger_document_key text NOT NULL UNIQUE,
  points_clawed       integer NOT NULL DEFAULT 0,
  points_restored     integer NOT NULL DEFAULT 0,
  refunded_at         timestamptz NOT NULL DEFAULT now(),
  refund_business_date date,                                      -- outlet zone, same rule as orders (0059)
  UNIQUE (order_id, seq),
  UNIQUE (device_id, client_refund_uuid)
);
CREATE INDEX idx_order_refunds_order ON order_refunds(order_id);
CREATE INDEX idx_order_refunds_shift ON order_refunds(shift_id) WHERE shift_id IS NOT NULL;
CREATE INDEX idx_order_refunds_outlet_day ON order_refunds(outlet_id, refund_business_date);

CREATE TABLE order_refund_items (
  refund_id     uuid NOT NULL REFERENCES order_refunds(id) ON DELETE CASCADE,
  order_item_id uuid NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  quantity      integer NOT NULL CHECK (quantity > 0),
  amount        numeric(14,2) NOT NULL CHECK (amount >= 0),
  restocked     boolean NOT NULL,
  PRIMARY KEY (refund_id, order_item_id)
);
CREATE INDEX idx_order_refund_items_item ON order_refund_items(order_item_id);

-- A refund stamps its own business date once, the way orders do (0059): the closing shift's
-- date when known, else the outlet-zone date of the refund instant.
CREATE OR REPLACE FUNCTION order_refunds_set_business_date() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.refund_business_date IS NULL THEN
    NEW.refund_business_date := COALESCE(
      (SELECT s.business_date FROM shifts s WHERE s.id = NEW.shift_id),
      business_date_at(NEW.outlet_id, NEW.refunded_at));
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER trg_order_refunds_business_date BEFORE INSERT ON order_refunds
  FOR EACH ROW EXECUTE FUNCTION order_refunds_set_business_date();

-- Sale-time line identity and allocated net share (service/allocate.go). NULL on every order
-- created before this migration: those stay whole-order refunds only.
ALTER TABLE order_items
  ADD COLUMN line_no smallint,
  ADD COLUMN net_amount numeric(14,2),
  ADD COLUMN refund_group text;
ALTER TABLE order_items
  ADD CONSTRAINT order_items_net_amount_check CHECK (net_amount IS NULL OR net_amount >= 0);
CREATE UNIQUE INDEX idx_order_items_order_line_no ON order_items(order_id, line_no) WHERE line_no IS NOT NULL;

ALTER TABLE orders DROP CONSTRAINT orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check
  CHECK (status IN ('completed', 'partially_refunded', 'refunded', 'cancelled'));

-- Backfill: one legacy_full refund row per already-refunded order. Amount = orders.total (what
-- the whole-order refund implicitly paid). Points clawed/restored are not recorded on the order,
-- so they stay 0. refund_business_date is copied (already stamped by the 0059 triggers).
INSERT INTO order_refunds (order_id, outlet_id, seq, scope, amount, computed_amount, payment_method,
                           reason, shift_id, refunded_by, refunded_by_name, ledger_document_key,
                           refunded_at, refund_business_date)
SELECT o.id, o.outlet_id, 1, 'legacy_full', o.total, o.total, o.payment_method,
       COALESCE(o.refund_reason, ''), o.refund_shift_id, o.refunded_by, o.refunded_by_name,
       'refund:' || o.id, COALESCE(o.refunded_at, o.created_at), o.refund_business_date
  FROM orders o
 WHERE o.status = 'refunded';

-- One item row per line (full quantity). amount is the line subtotal as informational history
-- only: for legacy rows the money readers use order_refunds.amount. restocked = the line has a
-- refund stock movement (refunds before the ledger have none).
INSERT INTO order_refund_items (refund_id, order_item_id, quantity, amount, restocked)
SELECT r.id, oi.id, oi.quantity, oi.subtotal,
       EXISTS (SELECT 1 FROM stock_movements m WHERE m.dedupe_key = 'refund:' || oi.id)
  FROM order_refunds r
  JOIN order_items oi ON oi.order_id = r.order_id
 WHERE r.scope = 'legacy_full' AND oi.quantity > 0;
