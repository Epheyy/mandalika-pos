-- 0094: Void phase 5. Release the ERP documents that Void phase 1 parked as held/void_erp_pending
-- (void documents, replacement sale documents, refunds of a replacement). The relay now builds a
-- void as a refund document, so they can be sent. No ordering is needed: every ERP qty is a signed
-- delta and documents have no order. Never roll the backend back past this: an older relay sees
-- kind 'void' as unknown and marks the rows dead. The same applies in the deploy window: this runs
-- when the new revision starts, before it is promoted, so pause the erp-relay Scheduler job from the
-- tagged deploy until promote (or, after promote, requeue dead rows: kind='void' AND payload IS NULL
-- AND last_error='erp: unknown document kind'). Additive only (data release, no schema change).
SET LOCAL lock_timeout = '5s';

UPDATE erp_outbox
   SET status = 'pending', hold_reason = NULL, next_attempt_at = now(), updated_at = now()
 WHERE status = 'held' AND hold_reason = 'void_erp_pending';
