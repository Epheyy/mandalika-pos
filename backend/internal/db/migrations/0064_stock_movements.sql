-- Step 2 ledger: append-only record of every stock movement (plan §2). One row per
-- non-zero line; a Go guard test forbids any UPDATE/DELETE on it (single DB role, so
-- REVOKE cannot). No FKs to locations/products: history must survive deletes.
--
-- Additive only: a new table, no change to the stock tables; the previous revision
-- ignores it, so rollback is a plain redeploy. Never renumber this file.
SET LOCAL lock_timeout = '5s';
CREATE TABLE stock_movements (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),   -- movement_id sent to the ERP
  seq           bigserial NOT NULL UNIQUE,                     -- diagnostics/ordering only
  document_id   uuid NOT NULL,                                 -- ERP Idempotency-Key
  dedupe_key    text NOT NULL UNIQUE,
  kind          text NOT NULL CHECK (kind IN ('sale','refund','transfer_out','transfer_in','transfer_cancel',
                  'receipt','adjust','count','opening','write_off')),
  location_type text NOT NULL CHECK (location_type IN ('outlet','warehouse')),
  location_id   uuid NOT NULL,      -- no FK: history must survive deletes
  product_id    uuid NOT NULL,      -- no FK, same reason
  variant_id    uuid,
  variant_size  text NOT NULL,
  qty           integer NOT NULL CHECK (qty <> 0 OR kind = 'opening'),
  qty_before    integer NOT NULL,
  qty_after     integer NOT NULL CHECK (qty_after = qty_before + qty),
  ref_type      text NOT NULL, ref_id uuid, ref_number text, ref_line text,
  actor         text, device_id text,
  occurred_at   timestamptz NOT NULL,
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  flags         text[] NOT NULL DEFAULT '{}',
  refund_of_movement_id uuid REFERENCES stock_movements(id)
);
CREATE INDEX stock_movements_loc_variant ON stock_movements (location_type, location_id, product_id, variant_size, seq);
CREATE INDEX stock_movements_ref      ON stock_movements (ref_type, ref_id);
CREATE INDEX stock_movements_document ON stock_movements (document_id);
CREATE INDEX stock_movements_occurred ON stock_movements (occurred_at);
