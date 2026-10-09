-- A11: exactly-once receipts for keyed /sync/batch writes (refund, shift_open,
-- shift_close, cash_flow, customer_create). The claim row is inserted as the first
-- statement of the same transaction as the effect, so a retry of a lost response
-- replays the stored outcome instead of applying the write again. Failed
-- operations roll back with their claim and are never recorded.
-- Additive only: safe to run while the previous revision keeps serving.
CREATE TABLE IF NOT EXISTS operation_receipts (
  idempotency_key text PRIMARY KEY,
  op_type         text NOT NULL,
  scope           text NOT NULL,
  fingerprint     text NOT NULL,
  outcome         jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_operation_receipts_created_at
  ON operation_receipts (created_at);
