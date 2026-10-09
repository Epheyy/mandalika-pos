# A26 acceptance evidence — A26-PAGINATION-20260921-01

Contract: CG-A23-QUAL-A24-GUEST-20260921-01-R1 §5. Local verification, review pending.

| Scenarios | Actual evidence | Result / limits |
|---|---|---|
| Before fix | Rendered Reports with51/201/1000 available rows; CSV and visible counts50. Actual Go handler requests500/1000 also return50 with correct total metadata. | Reproduced; server cap deliberately unchanged. |
| 1–2 | Production shared helper:0/1/50/51/200/201/401/1000, exact IDs/order/call sequence. | Pass; empty dataset makes one request. |
| 3–7 | Rejected page2, short/empty pages, duplicate/missing IDs, total/limit/page drift, malformed metadata, oversized total. | Pass; no partial return. Explicit10,000-page safety ceiling (2,000,000 rows); over-limit fails. |
| 8–10 | Real Reports CSV and visible totals51/201/1000, Rp51,000/201,000/1,000,000. | Pass with synthetic API; same fOrders feeds CSV and cards. |
| 11 | Browser payment/status/date filtering plus fixed-period dashboard test. Real DB shift/date/outlet filters. | Pass; existing filter/calendar arithmetic unchanged. |
| 12 | Real shift CSV51/201/1000. | Pass. |
| 13 | Page2 error: prior complete1000 rows retained with error; CSV disabled. Transactions XLSX separately same behavior. | Pass; no prefix exported. |
| 14–16 | Dashboard51/201/1000 KPIs, payment/ranking and rendered trends; pure metrics verify exact all-input sums. Product201 on final page is out of stock and shown. | Pass. Time/calendar implementations byte-unchanged. |
| 17–20 | Actual POS recap401 orders/401 flows,251 history, navigate to Historical60,401 selected orders and flows. | Pass. Historical flows newly loaded/displayed and included in recap print data. |
| 21–22 | Real browser page2 failure retains identical cache bytes with stale notice; actual panel remount reconstructs active/history offline. Unit tests also reconstruct selected details and fail history page2 using the same storage. | Pass; cache write only after all constituent pages succeed. Legacy unmarked cache remains stored but cannot certify completeness; requires first successful full online load. |
| 23–25 | Fresh isolated PostgreSQL18.3; actual authenticated read handlers;0/51/201/1000 scoped orders,251 shifts,401 flows,201 products; token-scope resists cashier outletId=all; foreign shift empty. Saved actual JSON is reconstructed by production TS helper. | 11 Go scenarios pass;10 response datasets. Equal-time fixtures verify stable ID tie-breakers. Redis disabled in fixture. |
| Supporting caller | Real Reports Transactions tab XLSX51/201/1000 parsed with actual XLSX library; totals and error disable. | Pass; no refund action changed. |

Final frontend checks: POS258, Backoffice50 (including real PostgreSQL response
reconstruction), sync33. App and explicit new-test typechecks pass. Six affected Go
package commands pass (read has no ordinary tests; read SQL covered by fixture).
See A26_VERIFICATION.json for exact commands/cwd/exit/output and failed attempts.

Not verified: transactional snapshots under concurrent writes, Redis cache churn,
native interaction/storage, real printer, release artifact or large-catalog performance.
Offset pagination can miss undetectable same-count row replacement; detected drift
fails. Global outlet/poll race A31 remains open. A27 arithmetic and A28 calendars
were not changed. Full A26/T23 and all release gates remain open pending review and
remaining qualification; no parent closure follows from these local checks.
