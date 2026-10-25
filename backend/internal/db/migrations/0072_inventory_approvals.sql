-- Inventory controls S3: approval workflow for manual stock adjustments and stock counts.
--
-- Additive only. Inert on deploy: app_settings.inventory_approval_required defaults to false, so
-- the direct adjust / complete endpoints behave exactly as before until an admin turns it on.
-- A count gains the status pending_approval (a submitted count waiting for an approver); an
-- adjustment becomes a request row that an approver applies as a DELTA. Rollback is a plain
-- redeploy: the previous revision ignores every new column and table.
SET LOCAL lock_timeout = '5s';

ALTER TABLE stock_counts DROP CONSTRAINT stock_counts_status_check;
ALTER TABLE stock_counts ADD CONSTRAINT stock_counts_status_check
  CHECK (status IN ('planned','in_progress','pending_approval','completed','cancelled'));
ALTER TABLE stock_counts
  ADD COLUMN submitted_by uuid, ADD COLUMN submitted_at timestamptz,
  ADD COLUMN approved_by  uuid, ADD COLUMN approved_at  timestamptz,
  ADD COLUMN reason_code text, ADD COLUMN reason_text text, ADD COLUMN rejected_note text;
ALTER TABLE stock_counts ADD CONSTRAINT stock_counts_reason_code_check
  CHECK (reason_code IS NULL OR reason_code IN ('damaged','expired','lost','found','data_entry',
                                                'tester_sample','count_variance','other'));
ALTER TABLE stock_count_items ADD COLUMN reason_code text, ADD COLUMN reason_text text;
ALTER TABLE stock_count_items ADD CONSTRAINT stock_count_items_reason_code_check
  CHECK (reason_code IS NULL OR reason_code IN ('damaged','expired','lost','found','data_entry',
                                                'tester_sample','count_variance','other'));

-- At most one OPEN count per location. The 0051 indexes (in_progress only, and the names
-- runningCountConflict knows) stay; these wider ones also cover pending_approval, so a rejected
-- count can always go back to in_progress and a second count cannot start behind a pending one.
CREATE UNIQUE INDEX stock_counts_one_open_outlet ON stock_counts (outlet_id)
  WHERE status IN ('in_progress','pending_approval') AND outlet_id IS NOT NULL;
CREATE UNIQUE INDEX stock_counts_one_open_warehouse ON stock_counts (warehouse_id)
  WHERE status IN ('in_progress','pending_approval') AND warehouse_id IS NOT NULL;

CREATE TABLE stock_adjustment_requests (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number            text NOT NULL UNIQUE,                 -- doc_sequences kind 'ADJ'
  status            text NOT NULL DEFAULT 'pending_approval'
                      CHECK (status IN ('pending_approval','approved','rejected','cancelled')),
  outlet_id         uuid REFERENCES outlets(id),
  warehouse_id      uuid REFERENCES warehouses(id),
  CHECK (num_nonnulls(outlet_id, warehouse_id) = 1),
  product_id        uuid NOT NULL,
  variant_size      text NOT NULL,                        -- no product FK: history survives a product delete
  qty_at_request    integer NOT NULL,                     -- live qty the requester saw (server-read)
  requested_new_qty integer NOT NULL CHECK (requested_new_qty >= 0),
  reason_code       text NOT NULL CHECK (reason_code IN ('damaged','expired','lost','found','data_entry',
                                                         'tester_sample','count_variance','other')),
  reason_text       text,
  CHECK (reason_code <> 'other' OR length(btrim(coalesce(reason_text,''))) > 0),
  requested_by      uuid NOT NULL,
  requested_at      timestamptz NOT NULL DEFAULT now(),
  approved_by       uuid,
  approved_at       timestamptz,
  decision_note     text,
  applied_adjustment_id uuid REFERENCES warehouse_stock_adjustments(id)
);
CREATE INDEX stock_adjustment_requests_pending ON stock_adjustment_requests (requested_at)
  WHERE status = 'pending_approval';
-- One pending request per location and SKU, enforced by the database so two racing creates
-- cannot both win (the write path answers 409 on a hit).
CREATE UNIQUE INDEX stock_adjustment_requests_one_pending
  ON stock_adjustment_requests (COALESCE(outlet_id, warehouse_id), product_id, variant_size)
  WHERE status = 'pending_approval';

ALTER TABLE warehouse_stock_adjustments ADD COLUMN request_id uuid, ADD COLUMN reason_code text;
ALTER TABLE app_settings ADD COLUMN inventory_approval_required boolean NOT NULL DEFAULT false;

-- The PIN lockout audit also records inventory approvals (transfer_id stays NULL for those).
ALTER TABLE receive_pin_attempts ADD COLUMN doc_type text, ADD COLUMN doc_id uuid;

-- A change of app_settings.inventory_approval_required is logged as an inventory_doc_events row
-- (doc_type 'app_setting', doc_id the fixed id write.InventorySettingDocID). Widen the 0069 CHECK
-- with the drop/add pattern of 0066; the doc-events guard allows DDL on the table in 0069 and here.
ALTER TABLE inventory_doc_events DROP CONSTRAINT inventory_doc_events_doc_type_check;
ALTER TABLE inventory_doc_events ADD CONSTRAINT inventory_doc_events_doc_type_check
  CHECK (doc_type IN ('stock_count','adjustment_request','requisition','outlet_giveaway','app_setting'));
