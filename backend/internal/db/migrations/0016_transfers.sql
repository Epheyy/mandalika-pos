-- 0016: product transfers (mesh: any location ↔ any location). Two-step
-- send→receive with IMPLICIT in-transit — stock leaves the source on send and
-- lands at the dest on receive (it is on nobody's on-hand while moving). Source
-- and dest are each polymorphic: exactly one of an outlet OR a warehouse. Only
-- outlet legs bump content_version (done in Go), never here.
CREATE SEQUENCE IF NOT EXISTS transfer_no_seq;

CREATE TABLE transfers (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_no         text NOT NULL DEFAULT ('TRF-' || lpad(nextval('transfer_no_seq')::text, 5, '0')),
  status              text NOT NULL DEFAULT 'draft',
  source_outlet_id    uuid REFERENCES outlets(id),
  source_warehouse_id uuid REFERENCES warehouses(id),
  dest_outlet_id      uuid REFERENCES outlets(id),
  dest_warehouse_id   uuid REFERENCES warehouses(id),
  note                text,
  discrepancy_reason  text,
  created_by          uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  sent_at             timestamptz,
  received_at         timestamptz,
  cancelled_at        timestamptz,
  CONSTRAINT transfers_one_source CHECK (num_nonnulls(source_outlet_id, source_warehouse_id) = 1),
  CONSTRAINT transfers_one_dest   CHECK (num_nonnulls(dest_outlet_id, dest_warehouse_id) = 1)
);

CREATE TABLE transfer_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id  uuid NOT NULL REFERENCES transfers(id) ON DELETE CASCADE,
  product_id   uuid NOT NULL REFERENCES products(id),
  variant_size text NOT NULL,
  sent_qty     integer NOT NULL,
  received_qty integer,
  difference   integer
);

CREATE INDEX idx_transfers_status ON transfers(status);
CREATE INDEX idx_transfer_items_transfer ON transfer_items(transfer_id);
