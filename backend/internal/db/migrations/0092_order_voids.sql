-- 0092: Void ("Batalkan transaksi"), phase 1. A wrong sale is cancelled whole (orders.status
-- 'cancelled', which 0077 already allows) and one append-only order_voids row records who, when,
-- why and what changed. Void never writes order_refunds. Additive only.
SET LOCAL lock_timeout = '5s';

-- ── Audit record: one row per void, never edited or deleted ────────────────────────────────
CREATE TABLE order_voids (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id                uuid NOT NULL UNIQUE REFERENCES orders(id),
  outlet_id               uuid NOT NULL,
  business_date           date NOT NULL,                  -- the ORIGINAL sale's day
  shift_id                uuid,                           -- the ORIGINAL sale's shift (NULL: unattributed)
  after_close             boolean NOT NULL,
  counted_in_close        boolean NOT NULL,
  source                  text NOT NULL CHECK (source IN ('pos','backoffice')),
  authority               text NOT NULL CHECK (authority IN ('own_shift','any')),
  mode                    text NOT NULL CHECK (mode IN ('none','replace','later')),
  replacement_order_id    uuid UNIQUE REFERENCES orders(id),
  reason_code             text NOT NULL CHECK (reason_code IN (
                            'salah_metode_pembayaran','salah_barang','salah_promo','salah_pelanggan',
                            'transaksi_ganda','transaksi_tes','lainnya')),
  note                    text,
  voided_by               uuid,
  voided_by_name          text,
  device_id               text,
  client_void_uuid        uuid,
  voided_at               timestamptz NOT NULL DEFAULT now(),
  original_total          numeric NOT NULL,
  original_payment_method text NOT NULL,
  original_tenders        jsonb NOT NULL,                 -- [{method, amount}]
  points_clawed           integer NOT NULL DEFAULT 0,
  points_forgiven         integer NOT NULL DEFAULT 0,
  points_restored         integer NOT NULL DEFAULT 0,
  spend_reversed          numeric NOT NULL DEFAULT 0,
  visit_reversed          boolean NOT NULL,
  codes_released          jsonb NOT NULL DEFAULT '[]'::jsonb,
  erp_document_key        text NOT NULL,                  -- 'void:<id>'
  CONSTRAINT order_voids_note_for_other CHECK (reason_code <> 'lainnya' OR char_length(btrim(COALESCE(note,''))) >= 10),
  CONSTRAINT order_voids_replace_link CHECK ((mode = 'replace') = (replacement_order_id IS NOT NULL)),
  UNIQUE (device_id, client_void_uuid)
);
CREATE INDEX idx_order_voids_outlet_day ON order_voids (outlet_id, business_date);
CREATE INDEX idx_order_voids_voided_at ON order_voids (voided_at);

-- One row per stock line the void looked at (the sale's own ledger movements, giveaway included).
CREATE TABLE order_void_items (
  void_id                uuid NOT NULL REFERENCES order_voids(id),
  movement_key           text NOT NULL,                   -- the sale movement's dedupe key
  order_item_id          uuid,                            -- NULL for the giveaway
  product_id             uuid NOT NULL,
  variant_size           text NOT NULL,
  qty                    integer NOT NULL CHECK (qty > 0),
  choice                 text NOT NULL CHECK (choice IN ('restock','skip_counted','gone')),
  counted_stock_count_id uuid,
  PRIMARY KEY (void_id, movement_key)
);

-- A later replacement or a "tanpa pengganti" mark: the audit row itself can never change, so
-- these later facts are their own insert-only rows (one per void).
CREATE TABLE order_void_followups (
  void_id              uuid PRIMARY KEY REFERENCES order_voids(id),
  kind                 text NOT NULL CHECK (kind IN ('replacement','no_replacement')),
  replacement_order_id uuid UNIQUE REFERENCES orders(id),
  actor                uuid,
  actor_name           text,
  note                 text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_void_followups_link CHECK ((kind = 'replacement') = (replacement_order_id IS NOT NULL))
);

CREATE FUNCTION forbid_void_audit_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'void audit rows are append-only';
END;
$$;
CREATE TRIGGER order_voids_append_only BEFORE UPDATE OR DELETE ON order_voids
  FOR EACH ROW EXECUTE FUNCTION forbid_void_audit_change();
CREATE TRIGGER order_void_items_append_only BEFORE UPDATE OR DELETE ON order_void_items
  FOR EACH ROW EXECUTE FUNCTION forbid_void_audit_change();
CREATE TRIGGER order_void_followups_append_only BEFORE UPDATE OR DELETE ON order_void_followups
  FOR EACH ROW EXECUTE FUNCTION forbid_void_audit_change();

-- ── Links on orders. void_id is deferred: the status UPDATE (with void_id) runs before the
-- audit INSERT, which in replace mode needs the replacement's id first. ──────────────────────
ALTER TABLE orders
  ADD COLUMN void_id uuid REFERENCES order_voids(id) DEFERRABLE INITIALLY DEFERRED,
  ADD COLUMN replaces_order_id uuid REFERENCES orders(id);
CREATE UNIQUE INDEX orders_replaces_once ON orders (replaces_order_id) WHERE replaces_order_id IS NOT NULL;
CREATE INDEX orders_void_id ON orders (void_id) WHERE void_id IS NOT NULL;

-- ── The new 'void' kind in the three closed vocabularies. The new CHECK is a superset of the old
-- one, so every existing row is valid. NOTE: the runner applies a file in one transaction, so the
-- earlier DROP/ADD already hold ACCESS EXCLUSIVE until commit and VALIDATE gives no lock relief
-- here. Acceptable at the current table sizes (test data, ~220k sales/yr). ─
ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_kind_check;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_kind_check
  CHECK (kind IN ('sale','refund','transfer_out','transfer_in','transfer_cancel',
                  'receipt','adjust','count','opening','write_off','void')) NOT VALID;
ALTER TABLE stock_movements VALIDATE CONSTRAINT stock_movements_kind_check;

ALTER TABLE erp_outbox DROP CONSTRAINT erp_outbox_kind_check;
ALTER TABLE erp_outbox ADD CONSTRAINT erp_outbox_kind_check
  CHECK (kind IN ('sale','refund','transfer_out','transfer_in','transfer_cancel',
                  'receipt','adjust','count','opening','write_off','void')) NOT VALID;
ALTER TABLE erp_outbox VALIDATE CONSTRAINT erp_outbox_kind_check;

ALTER TABLE point_transactions DROP CONSTRAINT point_transactions_type_check;
ALTER TABLE point_transactions ADD CONSTRAINT point_transactions_type_check
  CHECK (type IN ('earn','redeem','adjust','refund','void')) NOT VALID;
ALTER TABLE point_transactions VALIDATE CONSTRAINT point_transactions_type_check;

-- ── Void window setting (days after the business day). ────────────────────────────────────
ALTER TABLE app_settings
  ADD COLUMN void_window_days integer NOT NULL DEFAULT 7 CHECK (void_window_days BETWEEN 1 AND 30);

-- ── Grants (owner decision O1). No perm_version bump: the grant reaches a tablet at its next
-- token refresh; revocation stays instant through #138. ─────────────────────────────────────
INSERT INTO user_permissions (user_id, permission)
  SELECT id, 'void_own_shift' FROM users WHERE role = 'cashier'
  ON CONFLICT DO NOTHING;
INSERT INTO custom_role_permissions (role_id, permission)
  SELECT id, 'void_own_shift' FROM custom_roles WHERE name ~* '(kasir|cashier)'
  ON CONFLICT DO NOTHING;
