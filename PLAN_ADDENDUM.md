# Proposed addendum to PRODUCTION_READINESS_PLAN.md

**Date:** 2026-09-19  
**Status:** review proposal; not applied to the repository; no implementation or deployment authorization implied.  
**Companion:** `AUDIT_REPORT.md`, findings A01–A44.

## 1. Preserve the approved policy, strengthen the implementation contract

Keep the existing consolidated policy matrix. Do not replace it with the older assumption that an offline receipted sale is merely a provisional shopping cart whose money/goods may be silently rewritten. The canonical system decides authorized effects and tracks exceptions; it must not erase authentic already-completed physical or monetary facts.

Retain guest sales, permissioned independent same-outlet offline cash refunds, online-only cross-outlet returns/redemption, sealed-main rules, tester/inspection holds, manual-finance payable tracking, original-open-shift TL correction and the distinction between restored points and future-earning adjustment. Loyalty may remain disabled until launch policy is configured.

Add the following launch requirements and evidence gates.

## 2. Required command envelope and local journal

Every captured operation has a stable operation ID, registered device identity and monotonic sequence, operation type and schema version, original outlet, original actor, original shift, original occurrence time/business date, payload fingerprint and appropriate authorization evidence. A current login does not rewrite historical attribution. IDs in the payload alone are not trusted authorization.

Record original sale/item identities, captured prices and complete promotion/loyalty rules or immutable references, discount/tax/fee/tender allocations, receipt total, actual confirmed collections/payouts and parent/child links. Separate captured, accepted and settled times. Keep original and effective customer assignment with an audit trail.

A success indication requires an awaited verified transaction in the native journal. Migrations are resumable and non-destructive until verified. Errors, invalid JSON, full storage or missing plugins cannot silently substitute an empty successful journal. Unsynchronized financial/physical event records cannot be deleted by a support-log export, retry limit, logout, outlet change or ordinary cleanup.

Local original receipts/history must survive reboot and remain queryable for permitted offline returns and reprinting. Printer failure never requires recapturing a completed sale. Device replacement/backup restoration must not silently duplicate the operational device identity or change original event IDs.

## 3. Shared server receipt and authorization boundary

Every financial or inventory command, direct or batched, uses the same operation authorization, semantic validation and scope rules. Commit the immutable command receipt, business effect and audit together. The same key/body returns the original canonical outcome; the same key with a different body/scope/type is a visible conflict. Different events with identical baskets are not automatically deduplicated.

Cover sale, refund, shift open/close, cash flow, transfer create/send/receive/cancel, goods receipt, adjustment, count capture/complete, inspection release, payment/payout settlement, customer correction/attachment, exchange, paid void and recovery as each is introduced. A receipt attached only to orders is insufficient.

Validate quantity/range/finite values, item/tender conservation, payment confirmation and supported state transitions. Historical quote validation must preserve legitimate stale offline prices while refusing to grant new authority to malformed/forged commands. An authentic captured cash fact needing review remains evidence rather than a newly authorized entitlement.

Define durable refresh/session rotation and revocation plus a bounded offline-shift authority mechanism. Do not distribute reusable approver PIN hashes or put raw PINs into durable event payloads. Redis outage is not a reason to lose captured facts or silently allow unauthorized online writes.

## 4. Explicit inventory and shift workstream

Expand Phase 3 to name offline transfer sending, receiving, goods receiving and stock counts. Keep these distinct from refund inspection holds. All required workflows must survive the agreed 60-minute outage; 60 minutes is not event retention or a guarantee that outages cannot last longer.

Serialize product transfer state changes and guarded stock decrements. Give product counts the same terminal-state discipline as ingredient counts. Repeated completion returns its old receipt rather than resetting live stock. Use frozen count baseline plus intervening movements and an approved conflict reviewer.

Create one explainable movement history with source/destination/in-transit and received/inspection/sellable distinctions. Pending projections remain applied until a canonical version demonstrably includes them. A successful sale acknowledgement must not make sold inventory reappear.

Enforce the approved active-shift uniqueness and event ownership rules. Preserve the counted close submission and link later cash movements to the actual executing shift. Coordinate sale/cash writes against close and define deterministic lock ordering across order, customer, promotion and inventory resources.

## 5. Reports, pricing and customer corrections are release requirements

Add a dedicated reporting/contract workstream. Totals must cover the whole selected period/outlet, not the first API page. Use server-side filters/aggregates and complete paginated exports. Reconcile displayed transaction count and amount against authoritative ledger totals. Reject or clearly report unsupported requested page sizes rather than silently providing a misleading subset.

Define gross sales, returned/refunded value, net sales, cash movements and outstanding payables once. Do not exclude refunded orders and subtract them a second time. Use the approved captured/accepted/settlement time basis consistently.

Use deterministic integer-money and point conservation with Go/TypeScript golden vectors. Include direct versus linked tiered promotions, bundles/rewards, cap/stack behavior and totals below one point’s conversion value. Online-only redemption needs proof of online authorization, not the existing Offline:true batch flag.

Remove the general customer gate for guest sales. Preserve feature-specific customer eligibility. Resolve customer merges before applying account-specific caps, and distinguish duplicate-profile consolidation from the approved TL/open-shift account correction. Define lifetime visit metrics separately from net-spend metrics.

## 6. Operational and client-state controls

Bound request bodies, batch sizes and execution work; add client deadlines, safe JSON/status parsing, stable error codes and backoff/jitter. Keep dependent operations ordered while independent operations can progress. Temporary receipt errors never masquerade as “received elsewhere.”

Use request/scope generations for client polling so a late response from a previous outlet cannot replace current data. Clarify manager/admin outlet switching and explicitly map read/write authority across direct, batch, warehouse and cross-outlet routes.

Serialize schema migrations; coordinate database connection budget with instance limits. Verify actual quota/cost limits from provider data before capacity decisions. Authenticate and version OTA artifacts against native, API and local-journal compatibility. First render alone does not prove successful financial-journal migration; network availability must not be required just to acknowledge a locally healthy app.

Guard restore targets, avoid logging credential-bearing URLs, make restore failure-safe and validate business ledgers after a drill. Inspect signed release artifacts for debug flags, backup/device-identity rules and compatible data migrations. Maintain dated dependency/advisory and nested secret/PII handling checks.

## 7. Additional acceptance matrix

These are **future required tests**, not passing results from this review. Current reproductions D01–D09 in the evidence bundle demonstrate selected existing defects.

| Test ID | Scenario | Required outcome | Findings |
|---|---|---|---|
| T01 | Full disk, interrupted write, crash before/after local commit | No success before durable commit; all acknowledged events survive restart | A01 |
| T02 | Five or more network errors, then support export/reboot | Original event remains recoverable and visible; export does not delete it | A02 |
| T03 | Temporary receive error vs true competing receipt | Correct retry/review classification; captured physical receipt retained | A03 |
| T04 | Cashier/outlet change with old queued events | Original actor/outlet/shift preserved and authorized | A04, A30 |
| T05 | Reboot offline within approved shift; new shift while offline | Resume only valid existing authority; no unintended fresh authority | A05, A07 |
| T06 | Direct vs batch command for every role/scope | Identical new-authority enforcement, appropriate fact reconciliation | A06, A08, A30 |
| T07 | Negative quantity, altered subtotal, underpaid cash, stale legitimate quote | No fabricated stock/payment; authentic captured quote preserved | A09, A10, A44 |
| T08 | Response lost after each command’s commit; concurrent replay | One logical effect and original receipt; changed body rejected as conflict | A11 |
| T09 | Two opens; sale/cash write races close; later payout | Unique valid active state and immutable close, correct later shift | A12 |
| T10 | Send/send, receive/receive, send/cancel and shared-source stock races | One valid transition; conserved stock and retained competing evidence | A13 |
| T11 | Complete count; sell two units; replay completion | New sale’s debit remains; terminal count immutable | A14 |
| T12 | Ack/pull reordered; queue parks; late stock projection | Every physical movement represented exactly once in displayed stock | A15, A17 |
| T13 | All approved inventory workflows during 60-minute outage | Durable capture and dependency-aware reconciliation | A16 |
| T14 | Sealed return, retained tester, inspection release | Only actual eligible goods credited to the correct disposition | A18 |
| T15 | Offline cash overlaps online refund; crash during handover | Cash facts retained, conflict reviewed, no automatic second payout | A18, A19 |
| T16 | Upgrade payment uncertain; downgrade pending; finance/cash race | No premature handover on upgrade or duplicate settlement; debt visible | A19 |
| T17 | Exchange chain/full refund/void/recovery after movements | Original allocations/date preserved; authorized compensating history | A19 |
| T18 | Used earned points, restored points and expiry changes | Separate adjustment/restoration; conserved lots and stable retry expiry | A20 |
| T19 | Online redemption response lost; disconnected redemption attempted | Valid reserved/finalized redemption once; no offline new redemption | A21 |
| T20 | Total below/at/above one point’s value | Credited money equals actual point consumption under approved rule | A22 |
| T21 | Direct and linked tiered/bundle/reward promotions | Same rule/version/cart produces same allocation and total | A23 |
| T22 | Guest sale, later attachment, merge/correction during offline queue | No mandatory fake customer, double award or cap/ownership bypass | A24, A25 |
| T23 | 51, 201 and 1,001 orders; older period selected; export all | Correct complete reports, recap, export totals and counts | A26 |
| T24 | Two equal sales, one refund; cross-day return | No double subtraction; consistent approved reporting basis | A27, A28 |
| T25 | HTML 502, hanging fetch, 429, partial batch and malformed JSON | Safe classification, deadlines and no default-zero financial mutation | A29, A43 |
| T26 | Late old-outlet response after new-outlet response | Old response cannot overwrite current scope | A31 |
| T27 | Multiple cold starts and interrupted migration | One migration history and bounded total connections | A32 |
| T28 | Redis/Sentry failure and representative reconnect burst | Financial facts retained; measured capacity and authority controls hold | A33 |
| T29 | Failing sync/DB test, drift or debug flag in candidate release | Required checks block the exact artifact/commit | A34, A35 |
| T30 | OTA upgrade/rollback, interrupted journal migration, restored device | Pending journal readable, compatible and uniquely identified | A35, A41 |
| T31 | Isolated restore followed by pending-device replay | Complete ledger reconciliation and no duplicate effects | A36 |
| T32 | Nested marker secrets/PII and crafted CSV fields | Appropriate redaction and lossless safe import/export | A37, A39 |
| T33 | Current locked-dependency advisory scan | Reachability assessed; affected release blocked or exception approved | A38 |
| T34 | Concurrent sale/refund/merge with opposite resource order | Deterministic locking or classified idempotent retry | A42 |

## 8. Decision and completion tracking

For each accepted decision record: ID, status (approved/proposed/open/superseded), authority/owner, version/effective date, affected operations, financial/stock/points invariants and required test IDs. Do not choose loss exposure or customer treatment through an implementation default.

For each finding track: linked decision, implementation owner, commit/PR, migration impact, tests and commands actually executed, observed outputs, known residual risks and release gate. “Code written” and “test file exists” are not completion states.

Implementation order: baseline/failing tests → command/authority contracts → one durable sale path → inventory/shift concurrency → refunds/finance/exchange/void → optional loyalty/corrections → full release qualification. Reporting correctness and basic input/permission containment should be repaired early and rechecked at every stage.

No full launch recommendation should be issued until required tests pass on the exact release artifacts and environment. Do not infer readiness from historical test counts, a quiet queue, a generated APK or a successful health endpoint.
