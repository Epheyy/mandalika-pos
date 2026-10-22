-- Step 5 ERP outbox (plan §5.1): one row per stock document part, written by
-- ledger.Record in the SAME transaction as its stock_movements rows, so a document is
-- queued iff its movements committed. The relay (integration/erp) claims due rows,
-- builds the payload once from stock_movements (frozen: retries resend the exact bytes,
-- the ERP answers 409 on a changed body) and posts it to the ERP.
--
-- Status: pending (due) | held (unmapped variant/location, retried without counting an
-- attempt) | sending (claimed under lease_token until lease_until) | delivered | replayed
-- (200 applied / replayed) | dead (needs a human: 422/409/403/400, or max attempts).
--
-- part/part_count: a document over 200 lines is split (handoff §4.6); part 0 with
-- part_count 1 is an unsplit document. ref_id is never null: documents without a source
-- id (opening/reanchor backfill) use their part-0 document id, shared by all parts.
--
-- Additive only: a new table; the previous revision ignores it. Never renumber this file.
SET LOCAL lock_timeout = '5s';
CREATE TABLE erp_outbox (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id      uuid NOT NULL UNIQUE,            -- = stock_movements.document_id = ERP Idempotency-Key
  doc_key          text NOT NULL,                   -- ledger document key, e.g. sale:<order_id>
  kind             text NOT NULL CHECK (kind IN ('sale','refund','transfer_out','transfer_in','transfer_cancel',
                     'receipt','adjust','count','opening','write_off')),
  location_type    text NOT NULL CHECK (location_type IN ('outlet','warehouse')),
  location_id      uuid NOT NULL,                   -- no FK: like stock_movements, survives deletes
  ref_type         text NOT NULL,
  ref_id           uuid NOT NULL,
  ref_number       text,
  part             integer NOT NULL DEFAULT 0,
  part_count       integer NOT NULL DEFAULT 1,
  status           text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','held','sending','delivered','replayed','dead')),
  attempts         integer NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  lease_until      timestamptz,
  lease_token      uuid,
  last_http_status integer,
  last_error       text,
  hold_reason      text,
  payload          jsonb,                           -- frozen at first build
  payload_sha256   text,                            -- sha256 of payload::text, the exact bytes sent
  erp_response     jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),  -- also the document's recorded_at
  updated_at       timestamptz NOT NULL DEFAULT now(),
  delivered_at     timestamptz,
  CHECK ((part = 0 AND part_count = 1) OR (part BETWEEN 1 AND part_count)),
  CHECK (attempts >= 0)
);
-- Relay scan: due rows in creation order (matches the claim's filter and ORDER BY).
CREATE INDEX erp_outbox_due ON erp_outbox (next_attempt_at, created_at) WHERE status IN ('pending','held','sending');
-- Admin list (dead-letter view, counts by status).
CREATE INDEX erp_outbox_status ON erp_outbox (status, created_at DESC);
CREATE INDEX erp_outbox_ref ON erp_outbox (ref_type, ref_id);
