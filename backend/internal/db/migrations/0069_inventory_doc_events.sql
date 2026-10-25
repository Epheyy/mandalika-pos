-- Inventory controls S0: shared append-only history of inventory documents (counts, adjustment
-- requests, requisitions, outlet giveaway settings). A Go guard test forbids any UPDATE/DELETE on
-- it (single DB role, so REVOKE cannot). No FK on doc_id: history survives deletes, like 0064.
--
-- Additive only: a new table the previous revision ignores, so rollback is a plain redeploy.
-- 0067 is reserved (global SKU uniqueness); never renumber this file.
SET LOCAL lock_timeout = '5s';
CREATE TABLE inventory_doc_events (
  id        bigserial PRIMARY KEY,
  doc_type  text NOT NULL CHECK (doc_type IN ('stock_count','adjustment_request','requisition','outlet_giveaway')),
  doc_id    uuid NOT NULL,                 -- no FK: history survives deletes (like 0064)
  action    text NOT NULL CHECK (action IN ('created','updated','submitted','approved','rejected',
                                            'cancelled','applied','imported','fulfilled','refulfilled')),
  actor_id  uuid,                          -- bare, like transfer_receive_approvals (0062)
  note      text,
  data      jsonb NOT NULL DEFAULT '{}',   -- e.g. {transferId}, {fromQty,toQty}, {importRunId}
  at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inventory_doc_events_doc ON inventory_doc_events (doc_type, doc_id, id);
