# A27-summary-arithmetic — A27-SUMMARY-20260921-01

Contract: CG-A26-PAGINATION-20260921-01-R1. Local verification; review pending.

| Review scenario | Evidence | Result |
|---|---|---|
| 1 empty | `empty` authenticated PostgreSQL request | All amounts/counts0; average0; empty payments/products/daily. |
| 2 completed100 | `completed-only` | sales100/refunds0/net100/orders1. |
| 3 refunded30 | `refunded-only` | Before -30; after0 net; sales0/refunds30/orders0. |
| 4 completed100+refunded30 | `completed100-refunded30` | Before70; after100 net; sales100/refunds30/orders1. |
| 5 payment/average | `payments-products-daily` | cash100/card60; sales160/orders2/average80; refunded30 excluded from payments. |
| 6 cancelled | `cancelled-only`, mixed payment fixture | Cancelled900 contributes to neither completed nor refund measures. |
| 7 top products/daily | Every successful scenario checks rows; mixed fixture includes refunded/cancelled product lines | Completed quantity2/revenue160; daily2/orders160 sales; noncompleted-only cases empty. All non-net response fields identical before/after. |
| 8 scope | OutletA, cashier attempted cross-all, adminB override, admin bound default, explicit cross-all, unbound admin | Existing boundaries retained. Cross-all completed300/refunded30/net300. |
| 9 date boundaries | `created-at-half-open-boundaries` | Exact from and last microsecond before to included; just before from and exact to excluded; sales30/orders2. |
| 10 late refund | Purchase Jan2, refunded_at Jan10; query both windows | Jan2 sales0/refunds30/net0; Jan10 all0. Purchase-date/current-status behavior preserved, not settlement posting. |
| 11 handler | All15 successful scenarios invoke actual ReportSummary handler with real signed synthetic token and permission middleware; additional permission scenario | Exact response field set, HTTP200; missing token401/no permission403. Redis nil. |
| 12 schema/client | Existing generated Go/API compile and installed TypeScript app builds | Pass; generated Go, OpenAPI and TS schema/client byte-identical to entry. No regeneration. |
| 13 no mutation | All15 successful responses include before/after full orders/items JSON and SHA256; denied reads also assert unchanged | Pass. Fixture seed/reset occurs before snapshot boundary, in fresh synthetic DB only. |
| 14 affected checks | read/handlers/api/server Go checks;30 existing report/pagination tests; app typechecks | Pass; no standalone tests in read/api/server, compiled and read SQL covered by real fixture. |

`A27_BEFORE_FIX_POSTGRES.json` is the corrected-fixture red run; six scenarios fail
only their netSales assertions. `A27_POSTGRES.json` is the green run with the same
test source. `A27_RESPONSE_PARITY.json` verifies every other response field matches
exactly across those runs and all successful report requests preserve data.

Initial fixture run inherited host timezone+07 and also failed timestamp-string /
daily-bucket assumptions; its JSON and logs remain recorded. Synthetic pool timezone
was pinned UTC and window assertions compare instants. No production timezone or
date parser changed. Final16 database scenarios pass on a fresh third cluster.

Limits: no live/Redis/browser/native/performance/release qualification; no precision
type redesign (existing float32 generated report fields retained). Q09/A28 gross/net
vocabulary, refund occurrence/settlement clocks, exchanges, post-close payouts,
tax/discount basis and business calendars remain open. Full A27/T24 is not closed.
