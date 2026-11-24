# Shift-less order attribution (A12 leftover) — plan

Author: Opus (plan + review). Implementer: Sonnet medium. Date 2026-11-24.

## The bug (re-found on prod-hardening fc6985a8)

Shift ids are minted by the server (`shift_open` → `OpenShiftTx`). While a tablet's `shift_open` is still in the
outbox (queued, retrying, held behind a retryable item, or parked), the POS shows a pending shift with id `''`:

- `apps/pos/src/hooks/useShift.ts:132` sets `authStore.shiftId = null` for a pending open, so the capture envelope
  omits `shiftId` (`packages/sync/src/engine.ts` `captureEnvelope`).
- `apps/pos/src/cashier/CashierScreen.tsx:1013` sends `shiftId: currentShift?.id || null` → `null` in the sale payload.
- Cash in/out (`cash_flow`) has the same shape.

So every sale and cash movement captured during a pending open reaches the server with no shift at all and is
stored with `orders.shift_id IS NULL` / `cash_flows.shift_id IS NULL` forever. The close snapshot
(`service/shift.go` `CloseShiftTx`, `WHERE o.shift_id=$1`), Backoffice shift reports and the POS historical recap
(`/orders?shiftId=`) never count them. (`attribute.go:290-293` — an unknown shift id dropped to NULL — is a
separate, rarer branch; it stays as is.)

No server-only fix can be exact: the order carries nothing that names its shift. The link must come from the tablet.

## Approach: link by the pending shift_open's idempotency key, backfill on open

1. **Client (packages/sync, needs an owner-approved OTA to reach tablets):** when `captureEnvelope` builds an
   envelope with no `shiftId`, it stamps `shiftOpenKey` = the idempotency key of the newest not-acked
   `shift_open` in this device's outbox for the same outlet, provided no newer `shift_close` is pending after it
   (i.e. exactly the pending shift the header overlays). Envelope only — the payload and its fingerprint (A11)
   are untouched. Items from old bundles carry no key and keep today's behaviour.
2. **Server attribute():** `Envelope.ShiftOpenKey` (`json:"shiftOpenKey,omitempty"`). Only read when
   `env.ShiftID == ""`. It must start with `env.DeviceID + ":"`; otherwise it is ignored with a warning (never
   parks a sale). If a completed `shift_open` receipt exists for (key, scope = attributed outlet), its shift id
   becomes `EnvelopeShiftID` (so voids/replacements/refunds see it too). Otherwise
   `Caller.PendingShiftOpenKey = key`.
3. **Order (non-replacement) and cash_flow writes:** when the payload shift resolves to `""` and the caller has a
   shift id from the envelope, use it; when it has only `PendingShiftOpenKey`, the write transaction itself
   (first statement) takes `pg_advisory_xact_lock(hashtextextended('shift_open:'||outlet||':'||key, 0))`,
   re-reads the receipt, and either stores the shift id or stores the key in the new nullable
   `pending_shift_open_key` column with `shift_id` NULL.
4. **shift_open:** inside the keyed receipt transaction, take the same advisory lock first, open the shift, then
   `UPDATE orders / cash_flows / sale_stock_exceptions SET shift_id = <new id>` for rows of that outlet with
   `shift_id IS NULL AND pending_shift_open_key = key` (sale_stock_exceptions via its order id). A receipt replay
   does not re-run the body, so the backfill runs once; later items resolve through the receipt.
5. **Migration 0098 (additive):** `orders.pending_shift_open_key text NULL`, `cash_flows.pending_shift_open_key
   text NULL`, partial indexes `(outlet_id, pending_shift_open_key) WHERE shift_id IS NULL AND
   pending_shift_open_key IS NOT NULL`. The column stays after backfill as audit evidence.

### Why backfill, not hold

A hold (retryable until the receipt exists) needs no migration, but if the `shift_open` is refused for good
(another shift already open at the outlet, mig 0053; coverage refusal) its sales would retry forever or need a
time-bound heuristic. Backfill lands sales at once (stock, ERP relay and daily reports are not delayed), never
loses or duplicates them, and still attaches them if the parked open is later retried from review. Idempotency
is untouched: `processed_keys` and receipts are keyed exactly as before; a replay returns the canonical order.

### Lock order

Both writers take the advisory lock as their first lock, so it cannot form a cycle with the documented
order/shift/stock lock order (`service/order.go:210`). Whichever commits first, the other sees it (READ
COMMITTED re-reads after the lock): order first → the open's UPDATE attaches it; open first → the order reads
the committed receipt.

### Close snapshot correctness

A `shift_close` needs the server shift id, so it can only be captured after the open was acked; any order
captured during the pending open has a lower seq. Server (`batch.go`) and client (`flush`) already hold a
`shift_close` behind an earlier retryable item. So the backfill always happens before the close in normal flow.
A sale parked and retried after the close attaches to the closed shift like any late sale today (A12 late-event
accounting is a separate item).

### Not decided here (owner policy)

Which cashier a shift belongs to is not touched: the key links a sale to the shift its own tablet was in, which
is what a known shift id does today. No sale is ever attached to some *other* open shift at the outlet.

## Out of scope / follow-ups

- Voids and void-replacement orders captured during a pending open get the shift only if the open landed before
  them (via `EnvelopeShiftID`); no backfill for `order_voids` / replacement orders.
- `attribute.go:290-293` unknown-shift-id → NULL branch unchanged.

## Tests

- PostgreSQL gate test `TestShiftlessAttributionPostgres` (new gate row): (a) order + cash_flow sent before the
  open lands → NULL with key; open lands → attached, stock exception row attached; close snapshot counts them;
  (b) open lands first → order attaches directly; (c) replay of the order → duplicate, one row; (d) no key (old
  bundle) → NULL as today; (e) key of another device prefix → ignored; (f) batch [shift_open retryable-held,
  order, shift_close] → close held, re-flush → snapshot includes the order; (g) concurrent order vs open on the
  same key → attached either way.
- Unit tests: attribute() key handling; packages/sync captureEnvelope stamps the key only for a pending open.
