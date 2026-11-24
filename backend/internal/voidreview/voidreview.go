// Package voidreview holds the one SQL fragment that answers "which parked voids of other tablets still wait for
// head office on this shift". It lives in its own tiny leaf package because the shift close (package service) and
// the current-shift read (package read) both need it and neither imports the other.
//
// Void policy 2026-11-24: one shift serves the whole outlet (migration 0053), so a void that the server refused for
// good and one tablet parked (cash already handed back) is not in the shift's books. Closing the shift from another
// tablet would freeze a drawer that is short by that amount. The truth is sync_review_items: tablets report every
// parked item there (POST /sync/review-items) and head office resolving it (Tinjauan Sinkron) sets resolved_at.
package voidreview

// PendingSQL lists the transaction numbers of the open review items that hold shift $1 from closing, one row per
// item (the number is empty when the tablet's payload carries none). Membership mirrors the tablet's voidInShift:
//   - the void names its shift (payload originalShiftId): it belongs to that shift;
//   - an unattributed void (no originalShiftId) belongs to the shift its sale is in, found through payload orderId
//     or saleOrderUuid, whatever that sale's status (a void parked as "already voided elsewhere" may mean the cash
//     was handed back twice, so a cancelled sale still blocks until head office resolves it).
//
// An item whose key is in operation_receipts was acked later by a retry and no longer blocks. The payload is
// tablet-written, but it only ever blocks the close of the reporting tablet's own outlet (r.outlet_id = the shift's).
const PendingSQL = pendingHead + `
   AND r.resolved_at IS NULL` + pendingTail

// HeldAtSQL is PendingSQL for a close captured at $2 (timestamptz): it also lists the items head office resolved
// AFTER that instant, because the count was taken while they still held the shift. A close captured on an earlier
// business day is refused for good on these rows (void policy 1b), so resolving the void later cannot let it land
// with totals that include sales after the count. A superset of PendingSQL, same membership and ordering.
const HeldAtSQL = pendingHead + `
   AND (r.resolved_at IS NULL OR r.resolved_at > $2::timestamptz)` + pendingTail

const pendingHead = `
SELECT COALESCE(r.payload->>'orderNumber', '')
  FROM sync_review_items r
  JOIN shifts sh ON sh.id = $1::uuid AND sh.outlet_id = r.outlet_id
 WHERE r.op_type = 'void'`

const pendingTail = `
   AND NOT EXISTS (SELECT 1 FROM operation_receipts rc WHERE rc.idempotency_key = r.idempotency_key)
   AND CASE
         WHEN COALESCE(r.payload->>'originalShiftId', '') <> '' THEN r.payload->>'originalShiftId' = sh.id::text
         ELSE EXISTS (SELECT 1 FROM orders o
                       WHERE o.shift_id = sh.id
                         AND (o.id::text = r.payload->>'orderId' OR o.order_uuid::text = r.payload->>'saleOrderUuid'))
       END
 ORDER BY r.client_created_at, r.idempotency_key`
