# A18 cross-outlet returns — spec (owner-approved 2026-11-26)

Audit finding A18, remaining rule. Earlier owner policy (HANDOFF "Decisions (owner)", 2026-11-24 "Accept all"):
no return deadline; no inspection hold (returned goods go back to sellable stock once the server accepts the
refund); returns at another outlet allowed ONLINE ONLY; per-line refunds (C4a) replace the old whole-sale rule.

## Owner answers 2026-11-26 (all four recommended options)

A customer bought at outlet **X** (the sale outlet) and returns at outlet **Y** (the returning outlet).

1. **Stock and cash: "Y stock, Y shift".** The returned units go back into Y's sellable stock (they are
   physically there). Y's open shift pays the money. X's open shift is not touched: X's expected cash must not
   drop for a refund X never paid.
2. **Reports: "Split: sales X, cash Y".** Net sales (and gross-minus-refunds summaries, sales by product, customer
   spend) drop at X, the outlet that counted the sale. The payout shows in Y's shift, cash and refund-payout
   views. Y's manager still sees the refunds Y paid in the refund list.
3. **Lookup: "No. order or phone".** Online only. In Riwayat the cashier at Y searches another outlet's sales by
   EXACT order number or customer phone (phone-only, A30 style; no browsing of X's day list). The result shows
   outlet name, date, items, amounts and what was already refunded. Any user with the refund permission can do
   it at their own active outlet.
4. **Rare clash: "Accept, review item".** X keeps its offline same-outlet refunds of local receipts (A41). If Y
   already refunded the same units online, the server refuses X's queued refund and parks it in Tinjauan Sinkron
   for a manager; X may already have paid cash.

## Rules (technical, decided by the planner)

- **Online only is a SERVER rule.** Cross-outlet refunds never go through the offline outbox / `POST /sync/batch`.
  The batch path stays pinned to the envelope's outlet (`resolveSaleTx`, `RefundLinesTx` `outlet_id=$2`), so a
  cross-outlet refund that somehow arrives queued is refused with a clear reason (review item), never applied
  late.
- **New synchronous endpoint** for a cross-outlet return, called only while online. It runs the same refund
  transaction as the batch path with: the caller's active outlet as the returning outlet, that outlet's open
  shift as the paying shift (refused if none is open), the device id, and a client refund uuid (idempotent: a
  retry after a timeout is a replay, never a second payout). The tablet tells the cashier to pay out only after a
  2xx; a timeout shows the A29 "cek dulu" copy and the retry reuses the same uuid.
- **The tablet refuses clearly while offline** ("Butuh internet"); same-outlet offline refunds work as today.
- **Voids stay same-outlet** (no change to `void.go`).
- **Loyalty / points behaviour unchanged** (restore, claw, A20 debt) — they follow the customer, not the outlet.
- **ERP:** the refund document's location is Y (stock and tender post at Y). The ERP trusts `location.code` and
  does not look up the original sale (erp-flamboyan `origin/main`, stock-document service), so it accepts it.
  Y must be an outlet the integration client owns (staging `pos_mandalika`: BSD/LWB/MKS). Question for the ERP
  developer (non-blocking): Y's books carry the refund tender for a sale booked at X — is that the wanted
  accounting?

## Done looks like

Owner-approved spec (this file) + plan, PR into `prod-hardening` with tests (PostgreSQL gate cases: cross-outlet
success, sync-batch refusal, offline refusal on the tablet, permission/coverage limits, stock landing at Y, X's
open-shift cash unaffected and Y's shift paying, ERP outbox location = Y), Opus review, HANDOFF entry, five CI
gates on `gate/a18-cross-outlet-returns`.
