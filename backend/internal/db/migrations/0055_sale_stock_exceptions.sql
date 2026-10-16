-- A44: per-line record of every sale line that went short of stock (or whose
-- variant could not be resolved), written in the sale transaction. Immutable
-- sale-time facts plus an optional "sudah dicek" acknowledgement by an auditor.
-- 'refund_unresolved_variant' records a refund line whose variant no longer
-- exists (no stock restocked, refund still succeeds).
CREATE TABLE IF NOT EXISTS sale_stock_exceptions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id             uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  order_item_id        uuid NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  order_number         text NOT NULL,
  outlet_id            uuid NOT NULL REFERENCES outlets(id),
  product_id           uuid NOT NULL,              -- no FK: the product may be deleted later
  product_name         text NOT NULL,
  variant_size         text NOT NULL,
  kind                 text NOT NULL CHECK (kind IN ('shortage','unresolved_variant','refund_unresolved_variant')),
  quantity             integer NOT NULL CHECK (quantity > 0),
  stock_before         integer,                    -- NULL for the unresolved kinds
  stock_after          integer,                    -- NULL for the unresolved kinds
  shortfall            integer NOT NULL CHECK (shortfall > 0 AND shortfall <= quantity),
  channel              text NOT NULL CHECK (channel IN ('sync','direct')),
  cashier_id           uuid NOT NULL,
  cashier_name         text NOT NULL,
  shift_id             uuid REFERENCES shifts(id) ON DELETE SET NULL,
  device_id            uuid,
  sold_at              timestamptz NOT NULL,       -- COALESCE(client_created_at, now()): the business time
  recorded_at          timestamptz NOT NULL DEFAULT now(), -- server apply time; sold_at -> recorded_at = sync lag
  acknowledged_at      timestamptz,
  acknowledged_by      uuid,
  acknowledged_by_name text,
  acknowledge_note     text CHECK (acknowledge_note IS NULL OR length(acknowledge_note) <= 500),
  UNIQUE (order_item_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_sse_outlet_sold   ON sale_stock_exceptions (outlet_id, sold_at DESC);
CREATE INDEX IF NOT EXISTS idx_sse_sold          ON sale_stock_exceptions (sold_at DESC);
CREATE INDEX IF NOT EXISTS idx_sse_product_sold  ON sale_stock_exceptions (product_id, variant_size, sold_at DESC);
CREATE INDEX IF NOT EXISTS idx_sse_cashier_sold  ON sale_stock_exceptions (cashier_id, sold_at DESC);
CREATE INDEX IF NOT EXISTS idx_sse_order         ON sale_stock_exceptions (order_id);
CREATE INDEX IF NOT EXISTS idx_sse_open          ON sale_stock_exceptions (outlet_id) WHERE acknowledged_at IS NULL;
