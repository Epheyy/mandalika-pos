-- Head-office review of tablet sync items the server refused for good
-- (design: docs/plans/2026-10-12-review-resolve-design.md). Additive.
-- Rows are never deleted: the resolution columns are the audit record.
CREATE TABLE IF NOT EXISTS sync_review_items (
  idempotency_key    text PRIMARY KEY,
  outlet_id          uuid NOT NULL REFERENCES outlets(id),
  captured_outlet_id uuid,
  op_type            text NOT NULL,
  review_code        text,
  review_reason      text,
  last_error         text,
  owner_user_id      uuid,
  payload            jsonb NOT NULL,
  client_created_at  timestamptz NOT NULL,
  first_reported_at  timestamptz NOT NULL DEFAULT now(),
  last_reported_at   timestamptz NOT NULL DEFAULT now(),
  reported_by        uuid NOT NULL,
  resolved_at        timestamptz,
  resolved_by        uuid,
  resolution_note    text,
  CONSTRAINT sync_review_resolved_by CHECK ((resolved_at IS NULL) = (resolved_by IS NULL)),
  CONSTRAINT sync_review_resolved_note CHECK ((resolved_at IS NULL) = (resolution_note IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_sync_review_items_open
  ON sync_review_items (outlet_id, client_created_at) WHERE resolved_at IS NULL;
