# Production readiness: consolidated plan

## Current A34e13 checkpoint — 2026-09-24

E64: CG-A34E12-VITE-20260924-01-R1 accepts A34e12 atbc738ac within its actual
Windows/Linux/pure-editor evidence limits. E11-REPORT-01 is closed as corrected
attribution; original logs preserved, no extra replay/milestone. E9 stays closed.
30accepted milestones across the same11findings. All44parents remain; A31 alone
resolved; original8P0 parents, A34/T29,A38/T33 and all release gates stay open.
E65: A34E13-XMOD-20260924-01 qualifies x/mod0.40.0, requiring x/tools0.49.0,
x/net0.58.0 and telemetry20260811. Real generatorv2.4.1 and generated contracts
preserved. Test-only offline lookup/tile regressions: old3pass/2behavioral failures,
fixed5/5. Fresh scan14raw/12actionable/27report-only/2reviewed/0exceptions; only
GO-2026-6179/6180 records removed. Six local native18.3 PostgreSQL gates pass,
142named tests, zero skips, verified identity/cleanup; local CGO-disabled/no-race.
Default localGo is1.26.2, distinct from scanner/hosted1.26.8. Existing cached1.26.8
was selected per process for this work; no persistent/global toolchain change.
Fresh patched-toolchain downloads in owned cache match preserved initial bytes;
this does not establish historical cache integrity or a POS runtime exploit.
Hosted same-SHA proof pending. Earlier checkpoints remain historical.

## Current A34e12 checkpoint — 2026-09-24

E62: CG-A34E11-JSYAML-20260924-01-R1 accepts A34e11 at7d2ab47 within supplied
limits, including EXACT project-qualified Redocly1.34.14 -> js-yaml4.3.2 override.
Not range-satisfied, publisher approved or a blanket pin bypass. Consumer/generator
tests preserved.29accepted milestones across the same11findings; all44 parents
retained; A31 alone resolved; A34/T29,A38/T33 and every release gate open.
E11-REPORT-01 corrected: before-tests18/12; before-final17/13 includes unrelated
missing-flat-config fixture; fixed active/clean30/30. Original logs unchanged.
E9 remains closed; neither evidence correction adds a milestone.
E63: A34E12-VITE-20260924-01 qualifies Vite8.0.16/Rolldown1.0.3 and minimal
support graph. Three supervised groups pass active/clean; real Windows NTFS ADS
and actual8.3 alias vectors are blocked after qualified old-version reproduction.
UNC evidence is exact-source/extracted-pure-predicate only, with no UNC I/O/editor.
Local quality passes; security16raw/14actionable/27report-only/2reviewed/0exceptions.
Only Vite's oneHigh + oneModerate records disappear. Hosted proof verified below; ChatGPT review pending.
Earlier checkpoints are historical; A34e12 is not yet ChatGPT-accepted.

## Current A34e11 checkpoint — 2026-09-24

E60: CG-A34E10-BROWSERSLIST-20260924-01-R1 accepts A34e10 at 4f63473.
28 accepted milestones across the same 11 findings. E9-REPORT-01 is closed as
corrected evidence, not an extra milestone or parent. No new E9 replay required.
All 44 parents retained; A31 alone resolved. A34/T29, A38/T33 and release gates open.
E61: A34E11-JSYAML-20260924-01 locally verifies js-yaml4.3.2 through both
ESLint/eslintrc and Redocly/OpenAPI. Exact Redocly pin override is documented,
not claimed range-satisfied.30/30 active/clean; before-tests18/12, before-final17/13
(extra missing-flat-config fixture; corrected by E11-REPORT-01). Fresh scan17raw/15actionable/
28report-only/2reviewed/0exceptions;3High+1Moderate IDs removed. Hosted proof verified below; ChatGPT review pending.
Earlier checkpoints are historical. The next slice is not yet accepted.

## Current A34e10 checkpoint — 2026-09-24

E58: CG-A34E9-POSTCSS-20260923-01-R1 accepts A34e9 at 79403f2 within its
supplied evidence. 27 accepted milestones across the same 11 findings. All 44
parents remain; A31 alone is resolved. A34/T29, A38/T33 and every release gate open.
E9-REPORT-01 corrects active evidence: before-corrected 12/3; before-final 11/4
includes a separate Vite path fixture failure; after-final and clean 15/15.
A new exact-final-harness replay on the qualified old graph is 12/3; original
logs are retained. See A34E10_BROWSERSLIST_REMEDIATION.md for hashes and limits.
E59: A34E10-BROWSERSLIST-20260924-01 implements compatible Browserslist 4.28.7
and four required minimum data updates. 15 checks pass active and clean; old
qualified graph 8 pass / 7 targeted failures. Fresh local security: 20 raw /
18 actionable / 29 report-only / 2 reviewed / 0 exceptions. Two Browserslist
High IDs disappear; the existing Moderate baseline-browser-mapping record
only changes selected version. Hosted proof verified below; ChatGPT review pending.
Earlier sections are historical checkpoints, not current acceptance counters.

Policy baseline reviewed 2026-09-15; full-audit reconciliation added 2026-09-19.
Current authority: [AUTH-MANDALIKA-20260919-01](PROGRAMME_EXECUTION_AUTHORITY.md)
covers the full A01–A44 programme and all phases with environment/release safeguards.
S0a and S0b containment subtasks are review-accepted within their evidence limits.
S0c A09-input-numeric is scoped review accepted under CG-S0C-20260920-01-R1.
S0d outer-envelope correction and the narrow A23 tieredConfig mapper are scoped
review accepted by CG-S0D-ENVELOPE-A23-20260920-01-R1. LP05 identity containment
is scoped accepted by CG-A23-LP05-20260920-01-R1. A23-linked-fulfillment
is scoped ChatGPT accepted via the owner relay of 2026-09-21. Semantic promotion-key
validation is scoped accepted by CG-A23-SEMANTIC-KEYS-20260921-01-R1. A23 target/browser qualification and A24 guest containment are scoped accepted by CG-A23-QUAL-A24-GUEST-20260921-01-R1 (E24). A26 pagination is scoped accepted (E26); A27 summary arithmetic is locally verified (E27), review pending. Parent findings and release gates remain open. Historical scoped
authority statements below record their own runs; they do not restrict future phases.
Policy source: [decision draft](PRODUCTION_READINESS_DRAFT.md). This document
consolidates accepted decisions without treating proposed technical controls as
already implemented. Later explicit policy decisions govern earlier draft text.

## Baseline and evidence limits

The following remote/source inspection describes September 15, not a new remote
check. September 19 local HEAD remains `4691c78`; current evidence and all finding
dispositions are in [AUDIT_COVERAGE_TRACKER.md](AUDIT_COVERAGE_TRACKER.md).

Local branch `prod-hardening`, HEAD `4691c781842f0114acaf2e4371e0d11f0076f553`,
matches the remote branch in a fresh read-only `git ls-remote --heads origin`.
Other remote heads remain `main@af00d87`, stabilization-design `25e0d1c`, and
context-handoff-migration `6b2fab3`. No fetch, checkout, commit or push performed.
Only the planning draft was untracked before this document was added.

This pass inspected refund, sync, storage, shift, loyalty and customer-selection
code. Earlier repository-wide findings remain historical evidence, not newly
executed checks. No application tests, live transactions, deployments, provider
telemetry checks or database migrations were run in this documentation pass.
Negative findings mean no implementation was identified in inspected paths;
they are not proof that every file or deployed service has been exhaustively tested.

## Consolidated policy matrix

| Area | Confirmed policy | Remaining qualification |
|---|---|---|
| Hosting | Current services are polishing placeholders; production reliability and scalability govern. Possible Google Cloud migration later. | Establish target, budget, measured capacity, recovery and release conditions before operational changes under standing authority. |
| Refund scope | Entire sale; verified system sale sufficient; cross-outlet online allowed. | Concurrent unsynchronized returns need explicit conflict handling. |
| Offline returns | Same outlet, locally verified sale; permitted cashier can return cash. | Offline does not guarantee globally unique entitlement. Preserve actual payout if reconciliation conflicts. |
| Return eligibility | Original purchase date plus five calendar days through closing. Full refund: both main bottles sealed. Exchange: selected bottle sealed. | Exact calendar boundaries/configuration still unset. |
| SPV | Handling-outlet SPV authorizes late requests and full refund after exchange; phone/message recorded by cashier allowed. | No SPV inspection or opened/missing-main exception authority. |
| Tester/stock | Complimentary 2ml may be kept. Voluntary receipt held for inspection. Exchange returns held; ordinary sealed refund returns sellable only after server acceptance. | Inspection release requires inventory-management permission. No reuse of pending returned stock. |
| Exchange | Selected main bottles or full selection; original discounted credit; replacement today's prices/promos. Original date retained. | Preserve item allocations and linked chain. Offline uses last synchronized supported quote. |
| Upgrade/downgrade | Confirm upgrade payment before replacement handover. Accepted downgrade can hand over with agreed pending transfer. | Method-specific payment verification and recovery mechanics require design. |
| Cash/transfer | Cash during outlet hours; manual finance transfer during office hours. MODAL Rp1,100,000 is operational fund, not refund cap. | Actual available cash matters; no invented processing deadline. |
| Transfer controls | Cashier records customer-confirmed bank details; finance records reference/time/proof. Pending receipt shows amount owed/method/status. | Method switch requires finance confirmation of unsent transfer and coordinated prevention of later duplicate sending. |
| Void | Paid-sale correction linked to replacement, online, original still-open shift, TL identity authorization. | Closed-shift corrections separate; duplicate-sale replacement-link edge still open. |
| Recovery | No-movement exchange can be cancelled by cashier. Otherwise audited TL-authorized recovery, online finalization; finance resolves uncertain transfer. | Money/goods movement is never undone just by changing a status. |
| Shifts | Online authentication at start; offline authority for that shift. May close with pending work listed. | Preserve close submission; later settlement/correction linked with its actual cash-moving shift. |
| Customer | International phone lookup, guest sales, relatives' numbers permitted; no OTP requirement. | Account lookup is not ownership proof. Dedicated authorized cross-outlet verification needed. |
| Account correction | TL online within original open shift, reason, no redeemed/used earned points; other cases head-office review. | Unused points move with same expiry. Subsequent returns use corrected account; original linkage remains audited. |
| Guest attachment | Same TL/open-shift rule; original earning rules and remaining entitlement; unresolved payout leaves award pending. | Missing historical rules must not produce guessed awards. |
| Loyalty availability | Offline earnings pending until acceptance; redemption online; exchanges involving redeemed points online. | Eligible offline full refunds still queue loyalty restoration. |
| Loyalty adjustments | Final entitlement across chain; used earned points create future-earnings offset. Restored points stay usable and do not offset that balance. | Track available points separately from outstanding adjustment. |
| Loyalty allocation | Redeemed points proportional to eligible after-discount items; carry points first on downgrade; excess money/points returned separately. | Deterministic rounding and historical conversion evidence required. |
| Expiry | Configurable; existing expiry preserved; earliest-expiry-first redemption. Earned validity begins at availability with purchase-captured duration. Restored validity uses setting at restoration availability. | Calendar units/boundaries and initial configuration unset. Retry must not extend validity. |
| Loyalty administration | Authorized head-office administrators only; not yet in business use. | Rates/value/limits unset. Including points-funded value in earning is **provisional**, subject to later decision. |

## September 15 inspected gaps (historical subset, not the whole backlog)

| Priority | Evidence and current behavior | Required change/design |
|---|---|---|
| P0 | [storage.ts](../packages/sync/src/storage.ts): synchronous interface swallows localStorage errors; native Preferences writes are fire-and-forget. | Await durable financial journal commit before acknowledging capture; surface failure; migrate without deleting pending evidence. |
| P0 | [server.go](../backend/internal/server/server.go): direct refund has `process_refund`; [sync.go](../backend/internal/sync/sync.go) historically invoked service without equivalent permission. S0b now contains the request/token permission bypass; full A06 remains open. | Preserve S0b parity; complete shared command rules and authenticated offline-event recovery separately. |
| P0 | [shift.go](../backend/internal/service/shift.go) AddCashFlow inserts without event key; sync supplies no stable key to it. | Atomic operation receipt plus financial effect; lost-response retry must return prior result. |
| P0 | [outbox.ts](../packages/sync/src/outbox.ts) parks failed items after five attempts. | Classify transient vs permanent errors; retain recoverable events and visible reconciliation; no quiet abandonment. |
| P1 | [order.go](../backend/internal/service/order.go) Refund locks order, short-circuits refunded status, restocks all lines and reverses loyalty in one transaction. | Keep useful locking/idempotence but separate entitlement, physical return, inspection, payable and actual settlement; do not restore unreturned tester. |
| P1 | Same refund implementation floors earned-point clawback to balance and forgives remainder. | Outstanding adjustment ledger, separate restoration, expiry lots and future-earning offsets. Current behavior conflicts with policy. |
| P1 | CreateOrder consumes/awards aggregate customer points and sync passes `Offline: true`; no explicit offline redemption rejection identified in inspected redemption block. | Enforce online-only redemption server-side; immutable rule/lot evidence and allocation; don't rely solely on disabled UI. |
| P1 | CloseShift already locks and returns on closed status, but aggregates current order statuses. OpenShift checks then inserts. | Preserve close evidence plus later reconciliation; prove concurrent-open protection in DB; link real payout to actual executing shift. |
| P1 | [CustomerPicker](../apps/pos/src/cashier/CustomerPicker.tsx) searches name/phone and selects account; [OrderHistoryPanel](../apps/pos/src/cashier/OrderHistoryPanel.tsx) is outlet-scoped. | Profile/history/verified-return flow with explicit cross-outlet authorization; correction/attachment audit commands. |
| P1 | Inspected sync dispatch/refund flow has no exchange, paid-void or finance payout state machine matching this policy. | New linked domain commands and customer/staff flows, not overloaded refund status. |

Existing row locks, refund short-circuit, points transaction records, configurable
loyalty UI and closed-shift short-circuit are useful foundations. They do not by
themselves establish compliance with the new multi-step policies.

## Design boundaries and phases

The full-audit programme below expands this original phase summary. In particular,
inventory/counts, reporting, permissions, P2/P3 and release controls are not deferred
merely because the original six-phase summary emphasized returns and loyalty.

Technical recommendations below are reviewable design proposals, not launch claims.

1. **Contracts and evidence model.** Define immutable original sale/item prices,
   discount and tender allocations, policy versions and account corrections.
   Model return entitlement, inspection, replacement handover, payable, settlement,
   loyalty and shift reconciliation separately. Define integer money/points and
   deterministic remainder allocation. Exit: example chains conserve money,
   quantities and points; migration compatibility documented.
2. **Reliability and authorization foundation.** Await native journal commits;
   stable event IDs; server transaction receipts; shared permissions; dependency
   ordering, transient retries and explicit ambiguous physical-operation review.
   Exit: crash/replay/concurrent-request tests prove no duplicate canonical effect
   and no acknowledgement before durable storage.
3. **Refund, finance and inventory.** Implement entitlement and sealed-return
   policy, SPV evidence, inspection holds, manual payable workflow, receipts and
   post-close reporting. Exit: real cash facts survive rejection/conflict; finance
   and cash cannot independently settle the same obligation twice.
4. **Exchange, void and recovery.** Add original receipt links, component credit,
   current replacement pricing, confirmed upgrade handover, pending downgrade
   payable, TL void/correction and audited recovery. Exit: complete chain tested
   across outage, retry, late approval and shift transition.
5. **Customer and optional loyalty.** Add profile verification, account corrections,
   historical rules, per-item redeemed allocation, expiring point lots and distinct
   outstanding adjustments. Keep loyalty inactive until launch settings/policy
   are fixed. Exit: money-only operations work with loyalty disabled; enabled
   scenarios conserve available/restored/consumed points without duplicate earnings.
6. **Operational qualification and migration decision.** Database integration and
   Android durability tests; measured fleet workload at 12–14 hours/day; restore
   drill, monitoring, deployment/OTA compatibility and rollback rehearsal. Size
   services from measurements, then decide whether/when to migrate. Preserve
   PostgreSQL as canonical truth; Redis availability must not decide money correctness.

Phases 3–5 depend on the evidence model and reliability foundation. Customer
lookup UI can be developed independently later, but must consume approved contracts.
No dates, capacity ceilings or production readiness claims are justified yet.

## Acceptance scenarios to implement

| Scenario | Required observable outcome |
|---|---|
| Crash before/after device commit | Before commit: no success acknowledgement. After commit: event survives restart and submits once logically. |
| Server commits, response lost | Same event retry retrieves result; no second cashflow, inventory credit or points movement. |
| Two outlets return same online sale | Only permitted remaining entitlement accepted atomically. |
| Offline payout overlaps online return | Preserve both captured facts, expose conflict; never silently erase paid cash or automatically pay again. Prevention strategy remains open below. |
| Sealed refund with tester retained | Main quantities received once; tester not restocked; cash/transfer settlement separate. |
| Selected bottle exchange | Only selected discounted/tender allocation consumed; retained bottle unaffected; original deadline unchanged. |
| Upgrade uncertain payment | No replacement handover until confirmed; retry does not instruct second collection. |
| Downgrade pending transfer | Replacement can hand over after acceptance; receipt states debt; finance settlement later clears it once. |
| Finance/cash method-switch race | Confirm unsent, coordinate ownership of obligation; cannot complete both payouts. |
| Shift closes with pending return | Counted close remains visible; later transfer does not change drawer count; later cash attributed to actual shift. |
| Exchange return inspection | Neither reconnect nor submission enables resale; acceptance plus required inspection release does. |
| Full refund after exchange | SPV recorded; original money + received upgrades − returned downgrades; pending obligations reconciled; redeemed points never paid as cash. |
| Mixed tender downgrade | Rp80k money + Rp20k points to Rp70k replacement: Rp30k monetary payable, Rp20k points carried. |
| Points used before refund | Refund cash unchanged; outstanding earning adjustment offsets future new earnings; restored points remain available. |
| Expiry configuration changes offline | New earning uses captured duration starting on availability; restoration uses then-active duration; retry changes neither expiry. |
| Account correction/guest attachment | Correct role/open shift enforced; original audit retained; no duplicate award; later returns use approved corrected account. |
| TL recovery/paid void | Required online checks and TL identity; recovery preserves movements; void links correction within original open shift. |

## Remaining decisions, grouped for review

**Material policy or risk decisions:** concurrent offline/online return exposure
cannot be eliminated merely by checking online; choose whether to tolerate and
reconcile it or impose a reservation/availability restriction. Also define who
resolves inventory/count conflicts, missing-main return exceptions (SPV cannot),
and paid duplicate-sale corrections that have no replacement to link. These must
not be guessed from general customer-first preference.

**Configuration before pilot:** outlet/office calendars and time zones, initial
fund/replenishment accounting, finance and inventory role mapping, proof storage
requirements, and supported payment confirmation mechanisms. Loyalty launch
values and its provisional earning basis can remain deferred while disabled.

**Technical proposals to prepare without more micro-approvals:** deterministic
rounding, event keys, migrations, audit links, retry/backoff, read models, safe
offline rule snapshots, expiry boundary implementation, cross-outlet permission
scope, pending-operation visibility and reconciliation of account corrections
overlapping offline events. Escalate only if a choice changes customer treatment,
staff authority or loss exposure.

## Verification of this deliverable

This paragraph records September 15 activity. September 19 evidence is separately
recorded in the canonical tracker and latest session handoff.

Read-only code inspection and remote-head comparison completed. Documentation
review reconciled the tester disposition, original-shift customer-correction
restriction, MODAL and shift authentication references. Application tests were
not run because no application code changed. Acceptance scenarios above are
future checks, not passing test results. No service credentials or secrets read.

## Full-audit programme — September 19 adoption

One canonical register: [A01–A44 tracker](AUDIT_COVERAGE_TRACKER.md). Its 44 detailed
rows are incorporated here as explicit implementation/acceptance scope, including
the original 8 P0, 32 P1, 3 P2 and 1 P3. No finding is closed by this adoption.
The immutable [audit](../AUDIT_REPORT.md) and [addendum](../PLAN_ADDENDUM.md)
remain the acceptance baseline. T01–T34 are proposed tests, not pass results;
A40 has independent documentary acceptance. Current dispositions belong only in
the tracker, not this former ten-row gap summary.

| Stage / slices | Included findings | Outcome and dependency gate |
|---|---|---|
| S0 containment and evidence | A02, A06, A09, A23, A24, A26, A27, A31, A34, A37, A39, A40, A43 | S0a/S0b/S0c scoped review accepted; S0d shift decoding locally verified. Continue bounded milestones under standing authority; containment does not complete parent findings. |
| S1 shared contracts | A01–A11, A28–A30, A42, A44 | Journal, original identity/quote, receipts, validation, errors, authorization and lock order reviewed together. |
| S2 reliable sale path | A01, A04, A09–A12, A15, A17, A24, A26–A29, A41 | Capture → restart → authenticated acceptance → retained receipt → correct stock/shift/report projection. |
| S3 inventory and shifts | A11–A17, A28, A30, A38, A39, A42 | Transfer/goods receipt/count offline workflows, movement history, live/backdated reconciliation, shared writer concurrency. |
| S4 returns and recovery | A06, A12, A17–A19, A25, A28, A30, A41, A42 | Approved physical cash/goods and approval policies on verified primitives. |
| S5 optional loyalty / corrections | A20–A22, A25; A10, A11, A28, A30, A42 | Lots, online proof, historical conversion/ownership. Guest sales A24 stay mandatory independently. |
| S6 qualification | A31–A40 plus all affected acceptance gates | Exact artifact CI, real database/device evidence, restore, operational measurement and explicit owner release decision. |

Slice dependencies, migrations, feature boundaries and acceptance are per tracker
row. Shared test IDs do not close every linked row automatically. Reporting
completeness (A26), arithmetic (A27), time (A28), scope (A30), Backoffice polling
(A31) and generic CSV handling (A39) remain release-relevant throughout.

### A04 fixed-device contract

User-confirmed U04: fixed outlet/account POS, no normal logout/outlet selection;
Backoffice administers access and recovery. Enforce binding on the server and
retain historical device registration, account, actor/approver and shift through
refresh, revocation and replacement recovery. Proposed registration generations
must not clone operational identities or change event IDs. Replace original T04
with T04a–T04e for A04/A30. Legitimate Backoffice switching and A31 remain.
Existing online shift-start authentication and distinct TL authorization remain
approved; exact shared-versus-personal account meaning is Q01, not silently solved
by persistent login. No raw approval PIN/hash distribution is approved.

### A14 live/backdated counts and templates

User-confirmed U14 and template direction apply to direct entry and registered
Backoffice imports while selling continues. Adopt the detailed requirements of
[clarification §5–6](../A04_A14_DESIGN_CLARIFICATION.md) and
[template spec §3–8](../A14_BACKOFFICE_TEMPLATE_SPEC.md) as proposed technical
contracts subject to current decisions. Do not treat format suggestions as new
business authority. No entire-outlet sales freeze or absolute stock overwrite.

Preserve immutable observations with scoped quantity/unit/disposition, actual
per-line cutoff, timezone/precision and observer/uploader identities. Original
acceptance receipt is immutable; derived reconciliation may receive audited
revisions. With complete evidence, observed 80 minus later sales 12 plus receipt
5 yields 73. A late pre-count sale changes discrepancy, not current 73; a late
post-count sale of 5 changes current to 68. An older imported count does not
replace a newer anchor (Tuesday 60 less 5 stays 55). Replay count 10 after sale
2 stays 8. All movement types, chronological intervals, stock-scope concurrency
and POS coverage are required, not just count-row locking.

S3a: registered versioned template/direct-entry normalization and staging/preview
without stock effects. Literal fields, exact text IDs, blank versus zero,
explicit selected subset, bounded untrusted-file handling and no guessed cutoff.
XLSX is a proposal; A38 parser reachability must be reassessed before adding it.
S3b: immutable observations/command receipts plus movement-history interval
reconciliation. Proposed atomic selected submission, separate row reconciliation
states, stable logical fingerprint and linked corrections.
S3c: late evidence, shared writer races, stale preview recomputation, POS coverage
and recovery. T11a–T11n and I01–I23 all remain required, including original replay.
Missing history is visible; automatic reconciliation occurs when sufficient.
Backdating does not authorize rewriting sales, shift closes or financial periods.
Q02/Q04 cover period authority and stock-review boundaries. A39 remains a separate
CSV defect even if the new count format is XLSX.

### Review workflow and completion

Apply [CHATGPT_CODEX_WORKFLOW.md](../CHATGPT_CODEX_WORKFLOW.md) across every row.
The current packet in SESSION_HANDOFF.md separates technical review from owner
decisions and proposes one bounded next slice. Historical D01–D09 reproduce old
defects; convert them to corrected-invariant tests, never call their continued
success a repaired-system pass. No current advisory/production verification inferred.

### Review reply disposition — CG-MA-20260919-01-R1

The full [reply](../CHATGPT_REVIEW_RESPONSE_MA-20260919-01.md) is retained as
technical/design guidance with its explicit authority limits. This table records
the split status, not ten new approvals. All A01–A44 remain in the canonical tracker.
No external advisory/source claim in the reply was independently rechecked during S0a.

| Question | Technical guidance retained | Still pending / where it blocks |
|---|---|---|
| Q01 | Separate terminal enrollment, account/session, shift operator and transaction-specific TL approval; preserve fixed outlet/no routine logout and online shift start. | NEEDS_EVIDENCE: shared or sole human account use, before authority UX/schema. No per-sale login introduced. |
| Q02 | Atomically accept selected immutable observations, reconcile coordinated stock scopes separately with revisioned receipts; retain pending evidence. Apply reply's interval/revision algorithm, exclude derived count postings from primary movements and preserve newer anchors. | RECOMMENDATION_PENDING_USER: backdate/correction/reviewer/closed-period authority. XLSX artifact/runtime/license/reachability NEEDS_EVIDENCE; no package installed. T11a–n/I01–23 stay required. |
| Q03 | Durable session-family authority, atomic rotation, scoped offline evidence; delayed delivery must neither destroy old facts nor manufacture current authority. | RECOMMENDATION_PENDING_USER: offline duration/extension/revocation exposure. 60 minutes is neither TTL nor retention limit. |
| Q04 | Distinguish in-transit, received/pending, inspection-held and accepted sellable stock; retain physical receipt evidence. | RECOMMENDATION_PENDING_USER: non-return provisional sellability and reviewer authority. No inferred SPV inspection power. |
| Q05 | Preserve same-outlet offline cash and cross-outlet online return requirements; online atomic claims cannot exclude an unseen offline payout. | RECOMMENDATION_PENDING_USER: availability versus exclusive allocation/risk bounds. Requested features alone are not risk acceptance. |
| Q06 | Separate duplicate record/one collection, actual double charge and genuinely separate sales; retain money/goods evidence and correction links. | RECOMMENDATION_PENDING_USER: duplicate replacement-link exception and new return exception authority. Do not infer head-office/SPV powers. |
| Q07 | Under an approved whole-point rule, used points = min(requested, available, policy cap, floor(eligible money/rate)); credit = used × rate. Preserve receipt/lot provenance. | RECOMMENDATION_PENDING_USER for policy changes; migration, launch configuration and actual enabled state NEEDS_EVIDENCE. Earning on points-funded value stays provisional. |
| Q08 | Preserve documented raw assigned-code IDs/reissue and POS warning/override. Version rule subjects; retain usage, original/effective ownership, replay and physical-stock evidence. | Requested source excerpts supplied in Q08_APPROVAL_EXCERPTS.md; original chat transcript unavailable. Cap subjects/reissue allowance still unresolved. No automatic reassignment or hard denial; A25/A44 stay open. |
| Q09 | Separate original sale, recognized return, cash collection/payout and payable measures; full-scope totals; retain occurrence/knowledge/settlement clocks and immutable closes. | RECOMMENDATION_PENDING_USER: exact tax/discount/report basis, calendars and cross-period posting/presentation. No report changes in S0a. |
| Q10 | Qualify exact dirty source/lockfiles/artifacts, DB concurrency, native durability, OTA compatibility, restore and measured workload independently. | RECOMMENDATION_PENDING_USER: recovery/retention/access, feature deferrals and operational/release scope; deployed state NEEDS_EVIDENCE. No release approval. |

For Q08/T22, merge/correction tests must preserve raw assigned-code eligibility
and test the policy-defined cap subject, not assume all merged profiles become one
coupon subject. Reissue provenance and remaining allowance need an explicit rule.
For Q08/T07, stock tests must preserve warning/override while retaining truthful
physical movements; neither a zero floor nor new blanket denial is a substitute.
Original audit/addendum remain unmodified historical inputs; these corrections
narrow conflicting recommendation wording without removing A25/A44 invariants.

### Historical S0a execution boundary and next step

The owner's explicit S0a-only message, read together with reply §5, authorizes
non-destructive detached diagnostic export, minimal adapters/UI and focused tests.
No migrations, installation, auth/retry/transfer-receive redesign, live changes
or deployment. S0A-20260919-01 returns source diff, test logs, synthetic UI evidence
and all documentation for ChatGPT review. CG-S0A-20260919-01-R1 subsequently accepted
the scoped export-containment milestone and supplied documentation; no further
slice is implicitly authorized. All larger A02/T02 and A01/A03/A37 requirements
and all release gates remain open. This S0a approval was later supplemented by
the separate S0b-only approval recorded below.

### Historical S0b execution boundary — 2026-09-19

CG-S0B-20260919-01-R1 answers Q-S0b-01: bounded Option A applies the existing
authenticated request/token predicate per refund before mutation, retaining denied
historical operations. The owner's later explicit "OWNER AUTHORIZATION — S0b ONLY"
supersedes the reply's approval-pending labels for this slice only. No second
general approval was required. S0B-20260919-01 returns the exact diff and local
evidence; A06-permission-parity is implemented/locally verified, review pending.
No database-backed effect or native durability claim follows from test seams.

The original cashier/admin behavior and scoped service transaction are preserved.
Unexpired token claims can still allow a refund after a Backoffice assignment
changes; immediate revocation remains A07/Q03. Denial is not evidence that cash
was never returned. Five-failure parking, current error display and original-key
manual retry remain unchanged; capture-time authority, outcome receipts and
historical recovery still need their separate design/qualification. Full A06/T06,
A02 and all other findings/release gates stay open. No Q01–Q10 recommendation is
implemented or approved by S0b; no next application slice is authorized.

### Historical continuation — S0C-20260920-01 (superseded next-step status)

CG-S0B-20260919-01-R2 accepts A06-permission-parity within the submitted source,
composed-test and synthetic-storage evidence; its independent helper test was
not the project's Windows suite or PostgreSQL qualification. Full A06/T06 stays open.
The full-programme grant supersedes the historical permission limits immediately above.

S0c adds shared new-sale numeric checks before business mutations, required numeric
line decoding and detached item resolution. Existing free/reward/bundle, configured
tender and Q08 shortage behavior are retained. See [S0C_VALIDATION_MATRIX.md](S0C_VALIDATION_MATRIX.md)
for supported representations, source anchors and C01–C12 evidence. Fresh real
authenticated direct/batch handlers and 45 existing migrations were exercised on
a new local PostgreSQL 18.3 cluster containing synthetic data only; it is stopped.
This is not production migration, external payment settlement, native durability,
Redis receipt, concurrency or release verification. A09/T07 remains open for
captured quote/tender, discretionary authority and legacy recovery work.

Next bounded engineering work: A43 shift-route decode containment. Trace current
OpenShift/CloseShift bodies and sync equivalents; reproduce malformed-body effects;
reject decoding errors before mutation while preserving legitimate zero opening
cash, null/omitted legacy method counts where supported, and original failed keys.
Use authenticated handler tests and the disposable database fixture to assert
unchanged shifts/financial rows, valid compatibility, mixed batches and retries.
Inspect compatibility before choosing empty-body behavior; do not broaden into
shift policy, offline authority or money reconciliation. No repeated execution
approval is required. In parallel, ChatGPT should review the S0c quote/tender and
quantity-expansion questions before dependent cross-cutting changes.

### Historical continuation — S0D-SHIFT-DECODE-20260920-01 (see correction below)

S0c's A09-input-numeric subtask is review accepted within E10 limits. The decision
draft records Q-S0c-01/02 as future technical direction, explicit legacy unknowns
and unresolved policy preserved. Error taxonomy links to A29/A11; A28 remains
business time. Promotion resource safety is tracked under A29 with A09/A23/A38,
not merely A40. No larger redesign was implemented in the shift slice.

S0d-shift-decode (A43, former S0k) rejects malformed, trailing, ambiguous duplicate,
missing/null required and nonrepresentable inputs before direct/batch mutations.
Explicit zero, signed existing numeric domain, optional outlet name and absent/
null/empty method counts are preserved. Cash uses numeric(14,2) bounds; JSONB
method counts retain finite float64 compatibility without an invented column cap.
OpenAPI required fields and generated DTOs now match the inspected producers and
decoder. Unknown metadata remains tolerated; authority remains authenticated scope.
Tests/limits are in S0D_SHIFT_VALIDATION_MATRIX.md. No full A43/T25 closure:
post-commit readback uncertainty, other decoders and universal shift receipts remain.

Next bounded work: **A23-linked-promotion-parity** (formerly proposed S0d).
Trace promoValidate/AppliedPromoCode/linkedPromoShape and server tier selection;
reproduce lost tier configuration, carry the existing snapshot through the mapping,
then test linked versus direct tiered pricing at thresholds, ties and missing config,
percentage/fixed tiers, unlinked codes, combinability and supported cart shapes.
Run affected POS pricing tests/types and shared golden examples against backend
pricing. Preserve raw code identity and captured offline values. This is a mapping
parity slice, not count-compressed pricing, receipt migration or new promotion policy.
If current behavior is ambiguous, isolate that case and send evidence/options and
recommendation to ChatGPT while continuing unambiguous parity work. No generic
execution approval is needed under AUTH-MANDALIKA-20260919-01.

Fixture status: the old S0c cleanup policy block remains recorded and unretired;
no bypass/retry attempted. A separately verified synthetic S0d PostgreSQL cluster
was started only on loopback, tested with the existing migrations, then stopped.
Its directory is retained; no deletion or live-data operation was attempted.

### Historical continuation — S0D-ENVELOPE-A23-20260920-01

CG-S0D-SHIFT-DECODE-20260920-01-R1 requests outer-envelope correction while
preserving direct/inner shift tests. E13 provides complete structural preflight
before dispatch; semantic failures remain per item. SD05/SD07 claims narrowed,
historical logs unchanged. Empty/missing/null items remain no-op compatibility;
unusable original keys reject the envelope. No library, schema or retry redesign.

A23 mapper carries the existing tieredConfig in both directions. E14 demonstrates
single-selection pricing parity and shared Go/TS goldens. A separate LP05 probe
fails for a combinable promotion selected directly and by linked code: POS 80000
instead of 90000, while backend resolvePromos deduplicates the promotion. Review
question Q-LP05-01 concerns the next bounded selection/quote/submitted-identity
parity contract. Recommend mirroring backend direct-first/first-code precedence,
without recapturing/repricing historical operations or consuming redundant code
entitlement. That behavior has NOT been changed by the three-line mapper fix.
Do not close A23/T21 or call all LP scenarios passed. The failing probe and its
source are included as evidence outside the passing application regression suite.

Next work: resolve Q-LP05-01 with ChatGPT, then implement/test same-ID cross-path
deduplication in both selection orders, two linked codes, code-only eligibility,
removal/replacement, reward ownership and outbound metadata against backend
resolution. No generic execution approval needed. Parent findings and all release
gates remain open. Larger Q-S0c-01/02 technical directions remain unchanged.

### Historical continuation — A23-LP05-20260920-01

E15 records scoped acceptance of outer-envelope containment and the three-line
tieredConfig mapper. E16 implements the reviewed direct-first promotion-ID rule
in reducer selection, pricing and captured metadata. Incoming direct selection
removes its linked code before testing combinability against unrelated selections;
first effective linked code otherwise wins. Rejected redundant entries are not
retained for later resurrection. New capture contains only effective identities.
Historical queued sales and captured receipts are not rewritten.

LP05_VALIDATION_MATRIX.md maps the requested 15 scenarios to 23 LP05 tests,
successful KV capture/reconstruction, unchanged backend source and remaining limits.
Final POS 204/204, sync 33/33, POS/explicit test types and 16 shared Go goldens pass.
No new database fixture, browser/native/provider check or SQL usage verification.
Prior fixture directories remain retained; the S0c cleanup block is not retried.

Next bounded work: A23 linked reward/bundle contract trace and test vectors,
separately from this identity fix. Q-LP05-02 in the current review packet describes
the missing linked selection/allocation path and recommends sharing direct mechanics
under one promotion-ID owner, with code eligibility/usage kept distinct. Obtain
ChatGPT analysis of that consequential design before changing its dependent path;
ordinary programme investigation continues under standing authority. Resource safety
remains A29/A09/A10 work, not bundled into this slice. Full A23/T21, A43/T25 and all
release gates remain open; other A01–A44 dispositions are unchanged.

### Historical continuation — A23-LINKED-FULFILLMENT-20260920-01

E17 records scoped LP05 acceptance; E18 implements Q-LP05-02 Option A. Linked
codes retain selection/usage ownership while promotion IDs own physical lines and
bundle maps. A shared pure execution plan handles direct/code allocation and picker
preview; confirmation recomputes and commits atomically. Cancel installs nothing.
Takeover restores/removes the old effect first. Removal, participant edits, reactive
invalidation, customer cleanup, exclusivity and clear no longer leave ghost codes.
New linked snapshot carries bundleConfig; historical queues are unchanged.

Twenty-seven focused tests, POS231, sync33, types, affected Go packages and eight
fresh isolated DB cases pass. LF_VALIDATION_MATRIX.md maps all24 review scenarios
to actual layers; browser/native checks remain unrun. Two fresh synthetic clusters
stopped/retained; prior cleanup block not retried. No backend production changes.

Next bounded work: review the contained overlapping-slot counterexample (Q-LF-01),
then define disjoint slot-consumption vectors and Go/TS compatibility before changing
that dependent allocator. Add browser/native picker qualification separately. Keep
A29 resource compression, A10/A11 quote/receipt migration and loyalty work separate.
Full A23/T21 and all release gates remain open. No generic execution approval needed.

### Historical continuation — A23-SEMANTIC-KEYS-20260921-01

E19 records the owner-relayed scoped acceptance of linked fulfillment. The latest
Q-LF-01 direction supersedes the prior proposed general allocator: bundle slots
and explicit BXGY buy/get sets are already disjoint by design. E20 validates their
semantic coverage across Backoffice, write methods, POS and server. P covers all
variants, P|size exactly one. Distinct variants remain allowed. Existing impossible
moves are still guarded. No historical row or queued-sale rewrites.

Online invalid mechanics reject with existing bundle/reward errors before new
business effects. Captured offline overlapping bundle/BXGY lines keep quantity,
price, provenance and warning/review treatment; no unearned validated grants.
The narrow new BXGY branch prevents this validation class from dropping a captured
physical line. Other invalid/missing mechanics and quote/receipt issues stay open.

Final POS241, BO19, sync33, app/test types and affected Go pass. Isolated PostgreSQL
covers47 leaf scenarios including22 authoring vectors,16 invalid online/offline
cases, eight unchanged valid fulfillment cases and read-only preflight. Two new
clusters stopped/retained; old cleanup block untouched. Full evidence/limits in
SK_VALIDATION_MATRIX.md, SK_VERIFICATION.json, SK_COMPATIBILITY.json.

Concrete next work: review E20; use the read-only PROMOTION_KEY_PREFLIGHT.md process
on an identified staging/release snapshot and retain a target-specific report;
qualify actual browser/native authoring/picker workflows separately. No clean live
catalog claim. Remediation of any flagged historical rule needs explicit reviewed
handling, never an automatic edit. A23/T21, A43/T25 and all release gates remain open.

### Current continuation — A27-SUMMARY-20260921-01

E26 records scoped acceptance of A26 completeness within supplied limits. Full
A26/T23 remains open for remaining consumer inventory/qualification; A31 stays
separate. The incoming owner convenience progress snapshot does not replace the tracker.

E27 corrects only the summary's second subtraction: under current status semantics,
netSales equals completed-only totalSales. Refunded-only30 now yields0 net; completed
100+refunded30 yields100. totalRefunds and every other response field retain their
contract. Repo-wide source search identifies no application screen consuming this
endpoint/netSales; no report UI changed. Real authenticated handler/PostgreSQL red
and green tests, no-mutation snapshots and typechecks support this bounded milestone.

Full A27/T24 remains open. Q09/A28 must separately define gross/recognized/net sales,
refund occurrence versus payout/settlement, cross-day posting, exchanges, post-close
payouts, tax/discount basis and outlet calendar. This slice preserves purchase
created_at [from,to), current status and parser/scope/cache semantics. No new event
tables, historical rewrite or broader accounting vocabulary was introduced.

Next checkpoint: ChatGPT review of E27, then select remaining bounded work from the
canonical full-programme tracker. Broader report metrics require the Q09 projection
contract; do not infer it from this containment. Standing authority continues.


### Current continuation — A31-POLLING-20260921-01

E28 records scoped ChatGPT acceptance of A27-summary-double-subtraction. Full
A27/T24 and Q09/A28 vocabulary/cross-day refund posting remain unresolved/open.
Prior bounded acceptances stand; all44 findings and all release gates remain.

E29 contains Backoffice polling publication: only the latest-started request of
an active dependency generation may write data, error or terminal loading state.
Scope change clears data/error and loads anew; unchanged scope keeps prior data
while refreshing. Cleanup invalidates both in-flight completion and old interval
callbacks. Manual refetch remains supported. Five outlet-dependent product/order
callers now declare that dependency; 63 call sites are inventoried. This changes
no permission, report arithmetic/calendar, pagination completeness or POS policy.

13 real React/Chromium deterministic checks, rendered Reports success/error races
with a late201-row A cohort, existing BO50 and app/harness types pass. A31 parent
remains open pending scoped review. No global cancellation, database snapshot
isolation, other ad-hoc polling, native or production qualification claim.

Next: review E29 and its T26 evidence. Separately inspect A34's existing CI checks
and map missing financial/client regressions before proposing bounded wiring;
keep Q09/A28 accounting decisions separate. No generic execution approval needed.
Prior stopped test fixtures remain retained; policy-blocked cleanup was not retried.


### Current continuation — A34A-CI-20260921-01

E30 accepts/resolves A31/T26 for the original stale-scope polling race, preserving
its historical evidence and separate I/O cancellation/POS/snapshot qualifications.
This is the first resolved parent:1/44,0/8 original P0s,0 release gates. Prior scoped
acceptances stand. The canonical tracker retains all44 IDs and priorities.

E31 adds a deterministic blocking JS/TS baseline under standing authority:
`corepack pnpm quality:ci` installs the frozen lockfile; tests POS, Backoffice,
sync and printer; checks six source packages and excluded app tests/TS browser
harnesses; builds both apps; regenerates/checks the TypeScript OpenAPI artifact.
Node22/pnpm9.15.0 setup follows the existing release convention. Root Node types
are explicit for reproducible test checking; lockfile versions are preserved.
Vitest transpilation is not substituted for TypeScript checking. A deliberate
legacy-null transfer test cast is clarified without changing business source.

One reusable workflow handles PR/push and Android release. Both quality and the
needs-blocked signing job check out caller github.sha. No signing secrets are
forwarded to quality. Backend and advisory React Doctor workflows are unchanged.
Local clean and isolated negative proofs are in A34A_CLEAN_RUNS.json and
A34A_NEGATIVE_GATES.json; machine inventories disclose default versus opt-in/manual
coverage. No hosted Actions run, signed artifact, push or deployment occurred.

A34a is locally verified/review pending, not full A34/T29 closure. Next bounded
work should define safe mandatory PostgreSQL financial fixtures/CI entrypoints,
then wire hosted browser regressions separately. Preserve fixture target checks;
never use live DSNs as a CI shortcut. Database concurrency, dependencies/SBOM/
licenses/advisories, secret scanning, native APK/OTA provenance/debug checks and
required-status/hosted-run evidence stay open. Prior database cleanup remains
stopped; its policy block was not retried or bypassed.


### Current continuation — A34B-POSTGRES-CI-20260921-01

E32 records scoped ChatGPT acceptance of A34a from CG-A34A-CI-20260921-01-R1.
A31/T26 remains resolved; all44 findings remain tracked,0/8 P0 parents and0
release gates close. Full A34/T29 is open. Standing AUTH-MANDALIKA-20260919-01
covers this bounded continuation without another routine authorization request.

E33 makes the six existing PostgreSQL entrypoints mandatory through a reusable
fail-closed workflow and checked-in runner. Each uses a fresh PG18.3 fixture,
exact loopback/port/database/user and SHOW data_directory/empty-schema checks,
synthetic credentials, bounded startup/test timeouts, named PASS/no-SKIP proof,
and owned finally teardown. Guard prefixes are unchanged. A stale S0c test-only
BXGY fixture now uses disjoint products, with its original allocation assertions
and a product-scoped stock assertion. No production business source changed.

Android signing now needs quality, database and the reusable existing backend
baseline at the same caller SHA; signing secrets are not forwarded. All six
native local PG18.3 gates passed; five required negative proofs plus wrong data
directory failed correctly and cleaned their fixtures. Nine runner contracts pass.
The dirty HEAD-relative gen-check failure is disclosed; identical regeneration
passes in a disposable current-tree index. No active generated source changed.

Docker engine, local CGO/race and hosted Actions execution are unavailable here;
CI remains configured for Ubuntu/Docker and race. Local proof does not close
hosted qualification. Genuine A13/A42 concurrent DB scenarios are not implemented;
sequential replay and race instrumentation do not substitute for them. A34B
verification/inventory/matrix retain all limits. No release gate closes.

Next bounded work: A34c hosted browser CI for existing synthetic browser harnesses,
with named-scenario completion and negative fail-closed proof, then obtain hosted
JS/TS+DB+backend results on a reviewed complete source snapshot. Keep A13/A42
business concurrency separate; do not add superficial coverage. No policy decision
blocks this slice. Prior stopped DB cleanup policy block remains untouched. New
Python cache deletion was also policy-blocked; retained cache is excluded from
review artifacts. Only fresh owned DB fixtures from this slice were cleaned.


### Current continuation — A34C-BROWSER-CI-20260921-01

E34 records CG-A34B-POSTGRES-CI-20260921-01-R1 scoped acceptance of A34b
as implemented/locally verified. Hosted Docker/race remains pending. Counts are
44 findings,1 resolved parent(A31),0 P0 parents/gates and15 accepted milestones
across10 findings. Standing AUTH-MANDALIKA-20260919-01 remains in effect.

E35 implements the A34c mandatory Chromium browser gate: pinned Playwright1.63.0,
26 required ordinary tests, discovery/completion checks for missing/skipped/failed
cases, strict loopback Vite servers, synthetic APIs/auth and default external
network denial. Existing accepted A23/A24/A26/A31 journeys and S0a/S0b rendered
retention harnesses are covered. Real hook harness gains a case selector; business
source stays unchanged. Manual native/provider residuals are explicitly inventoried.

Final local26/26 zero skips and seven actual negative probes pass with confirmed
process/port cleanup. JS quality347 pass plus one existing optional DB-page replay
skip; source/test types, both builds and TS schema regeneration pass. Evidence is
in A34C_VERIFICATION.json, A34C_VALIDATION_MATRIX.md and the scenario registry.
Android signing now needs quality/database/backend/browser at the same caller SHA;
none receives signing/provider secrets. A34a/b workflows are preserved.

A34c is implemented/locally verified, ChatGPT and hosted proof pending. Full
A34/T29 and all release gates stay open. Local Windows Node24 Chromium does not
qualify hosted Ubuntu Node22, native storage, providers or DB business concurrency.
No genuine A13/A42 concurrency tests were added. Dependency/SBOM/license/advisory,
secret scanning, required-status configuration and full APK/OTA provenance remain.
Historical stopped DB and Python-cache cleanup remain untouched/excluded.

Next bounded work: prepare one reviewed complete source snapshot for hosted
quality/backend/PostgreSQL/browser proof. Inventory all currently untracked
programme implementation/fixtures, separate review-only archives, inspect actual
push/deployment triggers and preserve local decisions before publishing. Use
standing authority with release safeguards; do not push an incomplete HEAD-only
subset or interpret a green synthetic gate as release approval. Genuine A13/A42
business-concurrency design/verification stays a separate bounded task.


### Current continuation — A34D-HOSTED-PROOF-20260922-01

E36 records scoped acceptance of A34c by CG-A34C-BROWSER-CI-20260922-01-R1:
16 accepted bounded milestones across10 findings, A31 alone resolved, all44
findings and original8 P0 parents retained; all release gates remain open.
A34a/b/c hosted proof is pending until all four workflows pass on one final SHA.
A34d prepares audit/hosted-proof-20260922 using an explicit reviewed allowlist,
staged SHA256/tree manifest and staged-text scan. Sensitive/local settings and
review relay/evidence are excluded and retained locally; no history rewrite.
Known external integrations receive branch-scoped deployment safeguards while
quality/backend/PostgreSQL/browser remain mandatory. No release dispatch/OTA,
live data or credential operations belong to this checkpoint. A13/A42 actual
business concurrency, dependency/security/status/provenance gates remain open.

## A34d hosted proof — A34D-HOSTED-PROOF-20260922-01

The explicitly staged complete programme snapshot is published on
`audit/hosted-proof-20260922`. Final source commit `e782c5dfbf3eedefb5d655f6726590dfbea5bf87` passes quality,
backend, postgres and browser on the same SHA. The initial gofmt failure is
preserved; its correction changes formatting only. Hosted proof covers the
accepted Node 22/frozen-lockfile quality definition, the backend gen/vet/fmt/build/
race baseline, six Docker PostgreSQL 18.3 fixtures (142 PASS events, zero skips),
and pinned Chromium (26/26, zero skips, clean network and cleanup).

A34c scoped ChatGPT acceptance is recorded in canonical tracker E36. A34d E37
awaits review; it does not close A34/T29 or any release gate. A13/A42 true business
concurrency, dependencies/SBOM/license/advisories, A37 secret scanning, required
statuses and A35 APK/OTA provenance remain separate work. No signing, deployment,
live-data or credential operation occurred. The historical stopped DB/cache
cleanup remains untouched. Post-proof documentation is a local review after-image,
not another source revision claimed tested by these runs.

Next bounded proposal: A34e dependency/security baseline inventory and a pinned
SBOM/license/advisory gate design using this complete source SHA. Keep A37 secret
scanning and A13/A42 concurrency as explicit workstreams; do not silently treat
generic Go race mode as business concurrency coverage. Consequential policy to
review: advisory severity/reachability thresholds, acceptable licence policy and
exception ownership/expiry; investigate the current evidence before enforcement.

## A34e dependency security — current continuation

CG-A34D-HOSTED-PROOF-20260922-01-R1 scoped-accepts A34d's exact e782c5d hosted
checkpoint. Canonical tracker E38 records 17 scoped acceptances across 10 findings;
A31 remains the sole resolved parent, all 44 findings and all eight P0 parents stay
tracked, and no release gate closes.

A34e/A38 applies DEPSEC-INITIAL-20260922. Exact-base inventory precedes dependency
edits. Node/Go graph, CycloneDX SBOMs, licenses, public advisories and Go called
symbols are retained. A reusable full-baseline gate, supplemental npm PR delta,
empty reviewed-exception register and disposable negative proofs are implemented.
JWT/Redis receive narrow patch fixes. Remaining policy blockers are not waived:
proxy trust, SheetJS distribution/remediation and rgbcolor license evidence need
precise follow-up. No broad license-family policy is invented. Android dependency
wiring waits for a clean/exactly-excepted baseline, as the review requires.

The current packet carries final scan/hosted results and residual decisions.
A34/T29, A38/T33, A37, A13/A42 business concurrency, A35 provenance, branch status
rules and all release gates remain open. Stopped DB/cache cleanup is untouched.

## A34e review accepted; A34e1 Go remediation

CG-A34E-DEPENDENCY-SECURITY-20260922-01-R1 accepts A34e as implemented and
hosted-exercised while correctly BLOCKED by current dependencies. A38 receives
scoped reachability-baseline progress; full A34/T29, A38/T33 and every release
gate remain open. There are18 accepted bounded milestones across11 findings;
all44 findings remain, A31 alone resolved and0/8 original P0 parents closed.

Apply docs/A34E_REVIEW_DECISIONS.md: no chi version-only repair before ingress
trust evidence; vendor exact official SheetJS0.20.3 in a later separate slice;
rgbcolor approval is pending and no license exception is added.

A34e1 targets minimum fixed pgx5.9.2 and x/text0.39.0 with graph-proven MVS support
only. Capture exact module/sum/graph and govulncheck/policy ID deltas before/after;
require generated drift, fmt/vet/build/unit checks, all six safe local PostgreSQL
fixtures and same-SHA hosted quality/backend/postgres/browser success plus a
completed dependency scan. Unrelated dependency blockers must remain visible.
No business-source, migration, auth/client-IP, deployment, OTA or live-data change.


## A34e1 scoped acceptance; A34e2 x/crypto continuation

E42 accepts A34e1 under CG-A34E1-GO-REMEDIATION-20260922-01-R1 (19 bounded
milestones, 11 findings; parents/release gates open). Execute A34e2 before the
already-approved SheetJS slice, per docs/A34E2_XCRYPTO_SCOPE.md. Target x/crypto
v0.56.0 plus proven MVS support only. Keep actual pre-upgrade synthetic Argon2id
fixture, encoded parameters, verification/rejection and malformed-hash behavior.
No credential migration, policy exception or business change. Preserve no-fixed
OpenPGP GO-2026-5932 and demonstrate actual imports/calls. Require fresh module/
advisory delta, local Go/password tests, six real PostgreSQL/race gates and four
same-SHA hosted application passes plus a completed dependency scan. Record
existing stored-hash parser limitations separately; do not expand this update
into parser hardening. Return to SheetJS only after the A34e2 ChatGPT review.


## A34e2 accepted; A34e3 vendor coverage

E44 records scoped A34e2 acceptance (20 milestones / 11 findings), with the
stored-hash parser residual linked to A07/A09 for separate rejection hardening.
A34e3 uses the official versioned xlsx 0.20.3 artifact through a pinned repository
file dependency and preserves scanner identity, licenses, SBOM, advisory queries
and digest-sensitive PR deltas. Archive/install negatives and real workbook
exports are required alongside same-SHA gates. Any feed/publisher applicability
conflict remains blocked pending review; do not rename or suppress the component.
No A14 import or A27/A28 behavior change. See A34E3_SHEETJS_REMEDIATION.md.

## A34e3 accepted; A34e4 exact applicability

E46 records CG-A34E3-SHEETJS-20260923-01-R1 scoped acceptance (21 milestones/11
findings). E47 implements the reviewed two-advisory assessment, binding actual
xlsx0.20.3 bytes/provenance/lock, approved source evidence and a 2026-10-23 re-review
deadline. Preserve raw findings and separate reviewed-not-affected from exceptions;
use identical baseline/PR projection. Evidence changes and nonmatching artifacts
keep normal enforcement. No package-wide ignore or policy/license downgrade.
The canonical tracker and A34E4_SHEETJS_APPLICABILITY.md hold results/residuals;
parent findings and release gates stay open. No broader remediation bundled.

A34e4 final verification (2026-09-23): commit31080a4, four application workflows
pass; fresh security scan completes with48 raw/46 actionable/2 reviewed-not-affected
and zero exceptions. The two exact SheetJS decisions are review-pending implementation;
21 milestones remain accepted. No parent/release gate closure or next-family upgrade.

## A34e5 tar checkpoint — 2026-09-23

E48 accepts A34e4 exact applicability:22 milestones/11 findings. E49 changes only
Capacitor CLI8.3.4's tar edge to7.5.21 with a scoped override, clean installed-parent
proof and six bounded archive regressions in canonical quality. Local raw blocker
48->45/actionable46->43 delta retains SheetJS reviewed2/exceptions0. Hosted proof
and A34e5 review pending. All44 findings, existing business decisions and release
gates remain; no native/platform upgrade or next-family remediation is included.

A34e5 final proof:095dcff, four application workflows pass; completed fresh security
scan raw45/actionable43/reviewed2/exceptions0. Six bounded tar cases, six mandatory
Docker18.3/race fixtures and26 Chromium scenarios pass. A34e5 review pending;22
accepted milestones retained. Two temporary dependency install copies remain after
policy-blocked cleanup; no bypass and no historical DB-cleanup action.

## A34e6 current checkpoint

E50 accepts A34e5:23milestones/11findings. E51 xmldom0.9.12 via existing plist
range is locally verified with10bounded cases and full quality. Fresh scan
34raw/32actionable/2reviewed/0exceptions;13family IDs removed,no new findings.
Hosted proof/review pending. No parent/gate closure; all44 retained,A31 alone resolved.
Prior blocked installation-copy cleanup remains untouched.

## Final hosted verification — 2026-09-23

Final source `36d3d3abd146949c922d7bd6a32312ff50eca4e6`, tree `0806541d8d9c2d3ae9223a897a110c93c8d1d9db`.
Quality35834359162/backend35834359922/PostgreSQL35834359187/browser35834359063
all succeed on this SHA. Hosted Node22 passes10XML+6tar cases. Docker18.3/race:
6gates/142named passes/zero skips/identity+cleanup verified. Chromium26/26passes,
zero skips,no unexpected external access,process/port cleanup confirmed.
Backendgen/vet/fmt/build/race and quality frozen/types/build/schema pass.
Fresh security35834359219 completes RED:34raw/32actionable/2reviewed/0exceptions.
Source-input hashes match committed blobs; normalized findings equal local after.
No new/changed unrelated finding. A34e6 implemented and hosted-verified;ChatGPT
review pending.23accepted milestones;all44 retained,A31 alone resolved.
A34/A38/release gates open. Post-proof documentation is a local reporting after-image;
all executable source matches the hosted commit. New install-copy cleanup was also
policy-blocked; prior A34e5 copies untouched; no deletion retry or bypass.

## A34e7 current checkpoint

E52 accepts A34e6:24milestones/11findings. E53 compatible brace-expansion patches
on3existing lines pass20bounded tests and quality. Fresh local25raw/23actionable/
2reviewed/0exceptions;9matched records removed. Hosted/review pending;no gate closes.
All44 parents remain,A31alone resolved. Existing business policies and denied
installation-copy cleanup restrictions remain. See A34E7_BRACE_EXPANSION_REMEDIATION.md.

## Final hosted checkpoint — 2026-09-23

Source `1e76b42755bfe6f827905d465ec1e49bc461f8d0`, tree `f81f55057670110fd17cdcce97a6d01371d2f9a7`. Quality35839087570,
backend35839087581,PostgreSQL35839087627,browser35839087589 all succeed on this SHA.
Hosted Node22:20brace+10XML+6tar cases pass;349app tests with1existing optional replay
skip. Types/build/schema pass. Backendgen/vet/fmt/build/race passes. Docker18.3/race:
6gates,142named passes,zero skips,identity/cleanup verified. Browser26/26,zero skips,
clean network/owned-process/port state. Fresh security35839087632 completes RED:
25raw/23actionable/2reviewed/0exceptions. Input hashes match committed blobs; hosted
normalized findings equal local after-scan. No new/changed unrelated finding.
A34e7 implemented and hosted-verified;ChatGPT review pending.24accepted milestones,
all44 retained,A31alone resolved,A34/A38/release gates open. Post-proof documentation
is local reporting,distinct from the committed executable snapshot.
Four previously denied install copies untouched;two new install copies retained for
review/reproduction without a deletion attempt. Tiny fixtures/processes cleaned.

## Current A34e8 checkpoint — 2026-09-23

E54: CG-A34E7-BRACE-EXPANSION-20260923-01-R1 scoped accepts A34e7 at1e76b42.
25 accepted milestones across the same11findings; all44 remain,A31 alone resolved.
E55: A34E8-NANOID-20260923-01 updates PostCSS's compatible Nano ID edge3.3.12
->3.3.18.16bounded cases pass; corrected before-final6pass/10fail. Fresh local
25->23raw/23->21actionable,reviewed2/exceptions0. Exactly2targeted IDs removed;
no new/changed unrelated records. Hosted proof verified; ChatGPT review pending. A34/T29,A38/T33
and all release gates stay open. See A34E8_NANOID_REMEDIATION.md.
Earlier checkpoint sections preserve historical evidence; this section is current.

## Final hosted proof — 2026-09-23

Source `4cd7f89d857d64b0ae265605c9a25d39185522ac`, tree `c62232f832865e7954849268f49a2d14e7a3ac76`.
Quality35843981412,backend35843981448,PostgreSQL35843981371,browser35843981343
succeed on this exact SHA. Hosted Node22 passes all16Nano ID cases and prior
20brace/10XML/6tar checks. Backendgen/vet/fmt/build/race passes. Docker18.3/race:
6fixtures,142named passes,zero skips,verified identity and cleanup. Chromium26/26,
zero skips,no unexpected external requests,owned processes/ports cleaned.
Fresh security35843981401 completes RED:23raw/21actionable/2reviewed/0exceptions.
Committed input hashes match; hosted normalized findings equal local after-scan.
Only the two targeted Nano ID IDs disappear; no unrelated finding changes.
A34e8 implemented/locally+hosted verified; ChatGPT review pending. A34e7 accepted;
25accepted milestones/same11findings,all44retained,A31alone resolved. A34/T29,
A38/T33 and every release gate remain open. Post-proof documentation is a local
after-image, distinct from the hosted executable snapshot. No deployment dispatch.
Four denied installation copies untouched;A34e7/A34e8 copies retained without
new deletion attempts. No disk fixtures from Nano ID tests; children reaped.

## Current A34e9 checkpoint — 2026-09-23

E56: CG-A34E8-NANOID-20260923-01-R1 scoped accepts A34e8 at4cd7f89.
26accepted milestones/same11findings;all44retained,A31alone resolved.
E57: A34E9-POSTCSS-20260923-01 updates actual Vite->PostCSS8.5.23, preserving
Nano ID3.3.18 and all16worker assertions through real consumer resolution.
15PostCSS cases pass;3targeted before-fix read/propagation failures. Freshlocal
23->22raw/21->20actionable/30->29report-only;reviewed2/exceptions0. OneHigh and
oneModerate PostCSS record removed,no unrelated change. Hosted verified;review pending.
FullA34/T29,A38/T33 and every release gate open. Earlier checkpoints are historical.

## Final hosted proof — 2026-09-23

Source `79403f23e63a3560a43a4c8845b91ff9102cfe96`, tree `c12e2c2228819ed126f90304c41b84b4d16461f8`. Quality35848841958,
backend35848841933,PostgreSQL35848841864,browser35848841866 all succeed
on this exact SHA. Hosted Node22 passes15PostCSS+16Nano ID+20brace+10XML+6tar.
Backendgenerateddrift/vet/gofmt/build/race passes. Docker18.3/race:6fixtures,
142namedpasses,zero skips,identity and cleanup verified. Chromium26/26,zero skips,
clean network/owned-process/port state. Fresh security35848842086 completes RED:
22raw/20actionable/29report-only/2reviewed/0exceptions. Committed input hashes match;
hosted normalized findings equal local after-scan. Exactly1High blocker and1Moderate
report-only PostCSS record removed; no other record changes. Nano ID3.3.18 covered.
A34e9 implemented/locally+hosted verified; ChatGPT review pending.26accepted milestones
across11findings; all44 remain,A31alone resolved,A34/A38 and every release gate open.
Post-proof docs are local reporting after-images, separate from tested executables.
Four denied installation copies untouched; prior/new retained copies not deleted.
Owned tiny fixtures/processes cleaned. No signing/deployment/OTA/live operation.

## Final A34e10 hosted proof — 2026-09-24

Commit `4f6347346ac738e9ac4c7c295dd26351e1cd9e94`, tree `a1f437a7433dee752d9acdeef89ca72fa462544d`, branch audit/hosted-proof-20260922.
All four application workflows succeed on this exact SHA. Node22 quality passes
15 Browserslist + 15 PostCSS + 16 Nano ID and prior dependency/application checks.
Backend gen/vet/fmt/build/race passes. Docker PostgreSQL18.3/race: six fixtures,
142 named passes, zero skips, verified identities and cleanup.
Chromium26/26, zero skips, no unexpected external requests, clean owned processes/ports.
Fresh security completes RED for remaining blockers: 20 raw / 18 actionable /
2 reviewed / 0 exceptions. Hosted normalized findings equal local; source hashes match.
Two Browserslist High IDs removed. Existing Moderate baseline-browser-mapping finding
remains with only its selected version changed. Publisher severity disagreement retained.
A34e10 implemented and locally/hosted verified, ChatGPT review pending. A34e9 accepted;
27 accepted milestones / 11 findings. All44 retained; A31 alone resolved. A34/A38 and
all release gates remain open. Post-proof documentation is a local reporting after-image.
Denied cleanup targets untouched; new installation copies retained without deletion.
No signing, deployment, OTA or live operation.

| Workflow | Run | Result |
|---|---|---|
| backend | [35950742331](https://github.com/Epheyy/mandalika-pos/actions/runs/35950742331) | success |
| dependency-security | [35950742289](https://github.com/Epheyy/mandalika-pos/actions/runs/35950742289) | failure |
| Mandatory PostgreSQL integration | [35950742279](https://github.com/Epheyy/mandalika-pos/actions/runs/35950742279) | success |
| JS/TS Quality | [35950742254](https://github.com/Epheyy/mandalika-pos/actions/runs/35950742254) | success |
| Mandatory Chromium browser gate | [35950742274](https://github.com/Epheyy/mandalika-pos/actions/runs/35950742274) | success |

## Final A34e11 hosted proof — 2026-09-24

Source `7d2ab470fa4edfa78c9ee8f3c435587590681e81`, tree `72682d1e8f74a14891e93360b8dfab762e961bda`, audit/hosted-proof-20260922.
Quality/backend/PostgreSQL/browser succeed on this exact SHA. HostedNode22 passes
30 js-yaml +15 Browserslist +15 PostCSS +16 NanoID and prior accepted checks.
Backend generated drift/vet/gofmt/build/race passes. DockerPostgreSQL18.3/race:
6 fixtures, 142 named passes, zero skips, verified identity/cleanup.
Chromium26/26, zero skips, clean network/owned processes/ports. Fresh security
completes RED: 17 raw / 15 actionable /28report-only/2reviewed/0exceptions.
Source input hashes match commit; hosted normalized findings equal local. Removed
three High and one Moderate js-yaml IDs; no new/changed unrelated record.
A34e11 locally/hosted verified, ChatGPT review pending. A34e10 accepted; E9-REPORT-01
closed as corrected evidence only.28accepted milestones/same11findings;all44parents
retained,A31alone resolved. A34/T29,A38/T33 and every release gate stay open.
Post-proof docs are local reporting after-images, not another executable revision.
Previously denied cleanup targets untouched; two new install copies retained.
No signing, deployment, OTA, live data or business policy change.

| Workflow | Run | Result |
|---|---|---|
| backend | [35953693676](https://github.com/Epheyy/mandalika-pos/actions/runs/35953693676) | success |
| Mandatory PostgreSQL integration | [35953693549](https://github.com/Epheyy/mandalika-pos/actions/runs/35953693549) | success |
| dependency-security | [35953693547](https://github.com/Epheyy/mandalika-pos/actions/runs/35953693547) | failure |
| JS/TS Quality | [35953693570](https://github.com/Epheyy/mandalika-pos/actions/runs/35953693570) | success |
| Mandatory Chromium browser gate | [35953693545](https://github.com/Epheyy/mandalika-pos/actions/runs/35953693545) | success |

## Final A34e12 hosted proof — 2026-09-24

Source `bc738ace71e2d86f39ff810aa525550d5adabd7d`, tree `a0636fc3f73d6eceddcf3f848917fc2488fe218b`, audit/hosted-proof-20260922.
Quality/backend/PostgreSQL/browser succeed on this exact SHA. HostedNode22 passes
three Vite groups plus YAML30, Browserslist15, PostCSS15, NanoID16 and prior checks.
Hosted Linux executes normal server/transforms/HMR/denial/source guards; Windows
ADS/8.3 is explicitly platform-not-applicable there. Separate local WindowsNTFS
old/fixed proof supplies that qualification. The actually loaded LinuxRolldown
binary hash matches the independently verified official1.0.3 archive.
Backend generated drift/vet/gofmt/build/race passes. DockerPostgreSQL18.3/race:
6fixtures, 142 named passes, zero skips, verified identities/cleanup.
Chromium26/26, zero skips, clean network/owned processes/ports. Fresh security
completes RED: 16raw/14actionable/27report-only/2reviewed/0exceptions.
Source input hashes match commit; hosted normalized findings equal local. Removed
oneHigh and oneModerate Vite record only. All unrelated records remain unchanged.
A34e12 locally/hosted verified, ChatGPT review pending. A34e11 scoped accepted:
29milestones/same11findings; all44parents retained; A31 alone resolved.
A34/T29,A38/T33 and every release gate remain open. E11-REPORT-01 corrected;
E9 stays closed. Post-proof docs are local reporting after-images; implementation
matches hosted SHA. No intermediate failed application workflow for this slice.
Denied cleanup targets untouched; new install copies retained. No deployment,
signing, OTA, live data or business-policy change.

| Workflow | Run | Result |
|---|---|---|
| backend | [35957157697](https://github.com/Epheyy/mandalika-pos/actions/runs/35957157697) | success |
| Mandatory PostgreSQL integration | [35957157788](https://github.com/Epheyy/mandalika-pos/actions/runs/35957157788) | success |
| dependency-security | [35957157726](https://github.com/Epheyy/mandalika-pos/actions/runs/35957157726) | failure |
| JS/TS Quality | [35957157736](https://github.com/Epheyy/mandalika-pos/actions/runs/35957157736) | success |
| Mandatory Chromium browser gate | [35957157951](https://github.com/Epheyy/mandalika-pos/actions/runs/35957157951) | success |
