# Void and shift policy (owner "Accept all", 2026-11-24) — plan

Author: Opus 5.5 (plan + review). Implementer: Sonnet 5.5 medium. Base: `prod-hardening` 6388eff6.
Policy text: `HANDOFF.md` "## Decisions (owner)" > "Policy answers". Void design: `docs/plans/2026-11-12-void-design.md`.

Keep unchanged: the A to B to A chain; offline voids of counted items stay "do it online" (O6); the one shared
outlet shift; parked items are cleared only by head office (Tinjauan Sinkron). No cross-outlet returns (A18).
No migration is needed for any item.

Coordination: `claude/shift-attribution-95cbed` changes `sync/attribute.go`, `OpenShiftTx`, order/cash_flow writes
(not `CloseShiftTx`). The promo session edits `service/refund.go` and loyalty. This plan touches neither file.

## 1. Shared-shift close while another tablet holds a parked void

**Gap (to prove first with a red test).** Tablet A parks a void (server refused it for good); A's own close is
blocked locally (`voidRecap.ts` `shiftCloseVoidBlock`, `useShift.ts` closeShift). One shift serves the outlet
(mig 0053), so tablet B can send `shift_close` for the same shift and the server closes it. The drawer then closes
with money A already handed back that the server never booked.

**Where the truth lives: `sync_review_items`.** Tablets already report parked items there (`POST
/sync/review-items`, `engine.checkInReviews`, new items within 30 s), per outlet, with the payload. Head office
resolving the item (Tinjauan Sinkron) sets `resolved_at`, which unblocks the close. No migration, no new tablet
state. Chosen over a new table or recording the refusal server-side because the refusal transaction rolls back
and the tablet is already the source of what it holds.

A shift is blocked when there is a row with: `op_type = 'void'`, `outlet_id = shift's outlet`,
`resolved_at IS NULL`, the key NOT in `operation_receipts` (a parked void retried later and acked leaves its
review row open; it must not block forever), and the void belongs to the shift:
`payload->>'originalShiftId' = shift id`, OR its sale (`payload->>'orderId'` = `orders.id::text`, or
`payload->>'saleOrderUuid'` = `orders.order_uuid::text`) has `orders.shift_id = shift id`, whatever the sale's
status (a void parked as "already voided elsewhere" may mean the cash was handed back twice, so a cancelled sale
still blocks). Same membership as the
tablet's `voidInShift`. Payload values are tablet-written; they can only block a close of their own outlet.

Server (backstop, both sync and HTTP paths): in `service.CloseShiftTx`, after the `FOR UPDATE` and the
`status == closed` early return, run the check; if blocked, return a new sentinel
`ErrShiftCloseVoidPending` (`apperr.Busy`, so the sync item is RETRYABLE: the close stays queued on tablet B and
lands by itself once head office resolves; a permanent code would park B's close as a second review item).
Message names the order numbers when cheap, otherwise generic:
"Tutup shift ditunda: ada pembatalan di perangkat lain yang menunggu Tinjauan Sinkron kantor pusat."
Check the HTTP status the handler maps Busy to and the POS retry backoff for Busy (must not hammer).

Online pre-check (the normal path; parking needs an online tablet so B is usually online too): add an optional
`pendingVoidReviews` (array of `{ orderNumber: string }`) to the `Shift` schema, filled ONLY by the current-shift
read (`read.CurrentShift`) via the same query (share one SQL fragment between read and service). In
`useShift.closeShift`, when online, read the current shift fresh before enqueueing; if the list is non-empty,
refuse with "Selesaikan pembatalan yang tertunda di tablet lain dulu (menunggu Tinjauan Sinkron kantor pusat):
#…". Offline, enqueue as today (server backstop holds it). Keep the existing local check first.

Accepted residual race: a parked void reported in the ~30 s after B's check, or a void still queued (not yet sent)
on an offline tablet, is not seen. Late voids after close already land as shift corrections.

Tests: PostgreSQL gate (extend `TestVoidPostgres` or `TestSyncReviewPostgres`; if a new top-level test, add a row to
`scripts/ci/postgres_gate.py` and check `scripts/ci/codegen_gate.py`): (a) RED first: report a parked void for
shift S from device A, `shift_close` S from device B → today closes; after the fix → retryable Busy, shift open;
(b) resolve the review item → close succeeds; (c) same key later in `operation_receipts` → not blocking;
(d) unattributed void (no originalShiftId) matched through orderId; (e) void of a sale in another (closed) shift →
not blocking; (f) another outlet's report → not blocking; (g) HTTP CloseShift gets the refusal; (h) current shift
read returns `pendingVoidReviews`. POS unit test for the pre-check message.

## 2. "Tanpa pelanggan" in the Backoffice void form

`VoidOrderForm.tsx`: three states for the replacement customer: original (default, nothing sent), picked
(`customerId: <id>`), none (`customerId: ""`, server already clears it: `void_replace.go` ReplacementOverride).
Add a "Tanpa pelanggan" button next to the search; only shown when the original sale has a customer. When none is
chosen show "Tanpa pelanggan" with "Pakai pelanggan asli" to go back. Tests in the form's test file.

POS (`voidReplacement.ts` ~100): the replacement draft keeps the original customer; check that the cart's normal
"remove customer" works on a replacement draft and that it also drops `reusePoints` / the redemption (no points
without a customer). If it does not, make it so. Report what was found.

## 3. Void report counts only replacements still standing

`read/void_report.go`: `totals.replacementTotal` = sum of replacements with `ro.status <> 'cancelled'` ("money
corrected"). Add a row field `replacementStanding` (boolean, true when the row's replacement exists and is not
cancelled). New invariant: `replacementTotal` = sum of rows' `replacementTotal` where `replacementStanding`.
Update the SQL comment, the OpenAPI descriptions (VoidReportTotals, VoidReportRow), regenerate types
(`corepack pnpm gen`/`gen:check`), and the Backoffice report (`voidReport.ts`, `VoidReportTab.tsx`, any SheetJS
export): label the total "Pengganti berlaku" (or similar), mark a voided replacement in its row ("dibatalkan"), and
make the export's totals use the same rule. `originalTotal` unchanged. Gate test: A voided with replacement B, B
voided with replacement C → replacementTotal = C only; rows flag B not standing.

## 4. Own-shift voids limited to the cashier's own sales

Identity: the token user (`orders.cashier_id` vs the void's capture-time `in.UserID`). With the shared terminal
account per tablet (owner 2026-10-10) this means "rung under the same account"; flag in PR.

`service/void_rules.go` `decideVoidAuthority`: keep `matchesCallerShift` (shift membership, incl. O5) driving
`ErrVoidShiftClosed`. `VoidOwnShift` additionally needs `f.CashierID == in.UserID` (add `CashierID` to `voidFacts`
where facts are read). A colleague's sale in the open shift falls to `CanVoidAny` → `VoidAny`, else a new
`ErrVoidNotOwnSale` (Forbidden): "Transaksi ini dicatat kasir lain. Pembatalannya perlu izin membatalkan semua
transaksi." Grep every consumer of `Authority`/`VoidOwnShift` (editable replacement /
`ReplacementAtOriginalTotal`, after-close, ERP relay, reports): behaviour that depends on "sale in the caller's
open shift" must stay keyed on shift membership, not on the authority value; list what you found.

POS mirror (`voidRules.ts` voidAvailabilityBase): same shift + own sale (`order.cashierId === user.id`; local
unsynced orders rung here count as own: check what cashier id they carry) needs `canVoidOwnShift`; same shift +
colleague's sale needs `canVoidAny`, else new blocked text matching the server's. Offline path: capture-time
gating is this POS check; the server re-judges at sync with the capture-time user (A04).

Tests: unit (`void_rules_test.go`, `voidRules.test.ts`) and PostgreSQL gate: colleague's sale + own-shift only →
refused; + void_any → VoidAny; own sale → VoidOwnShift; O5 unattributed colleague sale → refused. Existing tests that
seed seller ≠ voider and expect VoidOwnShift: update on purpose and list them.

## Gates before push

Full PostgreSQL gate (`python scripts/ci/postgres_gate.py`), `go test ./...`, `corepack pnpm quality:ci`.
