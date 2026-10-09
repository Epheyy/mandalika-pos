# Codex to ChatGPT — MA-20260919-01

Read-only relay snapshot of the current SESSION_HANDOFF section; not a separate
status tracker. Regenerate from that section when sending a newer milestone.

## Current audit handoff — 2026-09-19

Packet ID: MA-20260919-01. Kind: MILESTONE_REVIEW / QUESTION.
This section supersedes older next-action/deployment instructions for this task;
all historical implementation records below are preserved. No fresh deployment,
provider configuration or live-data authority is granted.

### Objective, authority and repository

Owner requested documentation/design/workflow reconciliation of **all A01–A44**,
not implementation. Codex executes authorized engineering; ChatGPT reviews;
owner decides business/scope/risk/release. Master bootstrap supersedes the narrow
workflow bootstrap. AGENTS.md points to the shared workflow without replacing
user/global agreements. No automatic delivery to ChatGPT occurred.

Root: C:/Users/MyBook Hype AMD/Downloads/mandalika-pos (existing worktree).
Branch: prod-hardening. HEAD: 4691c781842f0114acaf2e4371e0d11f0076f553.
Entry status: no tracked changes; readiness plan/draft and supplied audit packet,
JSON and archives untracked. All preserved. No branch switch/reset/clean/fetch.
Remote not rechecked this turn. Historical remote checks are dated separately.

Canonical status: docs/AUDIT_COVERAGE_TRACKER.md, all 44 detailed rows with original
priority/evidence, current source evidence, coverage, authority, dependencies,
proposed slices, migration impact, tests, release gate and residual risk.
This handoff is a milestone delta, not another finding register.

### Evidence actually obtained

Windows/PowerShell, current root. git branch/rev-parse/status/diff checks exited
successfully. No tracked application edits at entry. Python SHA-256 comparison
of every non-readiness-document source cited in findings.json against supplied
source_fingerprints.json: every file matched exactly. Hash identity is fresh
source evidence, not a replay of any diagnostic or proof of full behavior.

Focused current reads confirmed:
- engine.ts:252–277 calls discardDeadLettered before capped log export;
  engine.ts:306–363 discards every transfer_receive error and fails all items on
  transport error. A02/A03 source-confirmed; runtime not rerun.
- transfer.go:225–304 still explicitly uses a read-then-write stock guard for
  single-admin assumptions. A13 race risk source-confirmed; no PostgreSQL race run.
- stockcount.go:133–287 still replaces count lines/reopens status and writes
  absolute stock. A14 expanded reconciliation is not supplied by these paths.
- writes.go:1056–1098 still ignores DecodeLoose and post-write read errors. A43.
- outbox.ts:122–136 removes entries; CashierScreen.tsx:976–1002 calls the support
  discard flow. These ground the smallest proposed S0a slice.

AUDIT_REPORT and PLAN_ADDENDUM were read in full using chunked reads after a
combined output was truncated. Clarification/template/workflow and current
plan/draft were reconciled. Latest session banner and relevant historical
policy records were examined; legacy credentials sections were not copied into
this packet. No secret values, archives of application data or provider access
were needed. Old full-suite/deployment claims are retained as historical only.

No application suite, D01–D09, full build, real DB/device test, current advisory
scan, restore or provider measurement ran. Documentation checks and file hashes
are the only fresh verification, recorded in docs/AUDIT_RECONCILIATION_EVIDENCE.json.

### Full-programme delta and P0 dispositions

All 44 groups retained (8 P0, 32 P1, 3 P2, 1 P3), none demoted or marked fixed.
Original P0: A01/A04/A06/A09/A11 have matching source and await current behavior
revalidation; A02/A03 remain source-confirmed loss paths; A13 remains a source-
confirmed concurrency risk requiring database tests. No P0 exception approved.
A14 remains P1 with expanded T11a–n/I01–23, not a substitute for the eight P0s.
A31 Backoffice race, A39 CSV defects and A38 import reachability remain separate.
A40 documentation entry/coverage improved, but all historical docs are not claimed
fully corrected. No new finding ID needed; conflicts are linked to existing rows.

Preserved useful implementation: transactional order/refund and existing locks,
closed-shift short-circuit, ingredient lifecycle patterns, promotion tests and
historical feature completions. Optional loyalty may be staged off by policy,
but a June handoff says it was enabled for testing; current deployed state is
unknown. Do not label it safely disabled or fixed without verification.

### Consequential questions for ChatGPT (owner decisions identified)

These are batched review questions, not requests to reapprove settled policy.
Source citations refer to current hash-matched files; historical authority is
explicitly identified. Return an answer per Q-ID with TECHNICAL_CLARIFICATION,
RECOMMENDATION_PENDING_USER or NEEDS_EVIDENCE. Owner chooses policy, not ChatGPT.

**Q01 — Fixed terminal versus human identity (A04/A05/A08/A30; T04a–e,T05,T06).**
Evidence: U04 binds an outlet Admin/TL account permanently; draft still requires
online shift-start authentication and TL's own identity for void/recovery.
sync.go:158–223 uses current delivery caller; OutletSwitcher.tsx:32–58 exposes
routine selection. Is the outlet account shared by staff or the sole human's
identity? Recommend separate terminal registration, shift operator evidence and
transaction-bound TL step-up without logout. Alternative: one actual sole named
operator, only if owner confirms reality; persistent token alone cannot prove a
fresh TL approval. ChatGPT review the identity model; owner confirms shared/sole
account and staff interaction. Blocks authority schema/UI, not evidence-preserving
export containment. Do not invent routine multi-outlet switching.

**Q02 — Count evidence and closed periods (A14/A17/A28/A38/A42; T11a–n,I01–23).**
Evidence: stockcount.go applies actual quantity absolutely; U14 explicitly allows
live/backdated input and Backoffice templates. Recommend immutable observations,
separate receipt/reconciliation revisions, selected-submission atomic acceptance
and per-row pending/review; shared scoped locks plus history coverage. Alternative
single all-or-nothing reconciliation delays good rows behind missing history.
ChatGPT review command boundaries/interval algorithm and safe XLSX library choice;
owner defines who may backdate/correct, conflict reviewer and closed-period policy.
Recommend preserve financial closes and expose inventory restatement separately;
no arbitrary 30-day limit. Blocks stock-applying slice, not design or separately
authorized no-stock staging. Parsing alone cannot close A14 or generic A39.

**Q03 — Revocation and long outage (A04–A08/A29/A33; T04c,T05,T06,T28).**
Evidence: approved shift-start online authentication and 60-minute tolerance do
not define expiry beyond a shift or delayed revocation; auth store/handlers are
hash-matched to audit's Redis/rotation path. Recommend durable session authority,
shift-bound offline evidence, no new shift offline, authenticated review/recovery
for old facts. Alternative emergency extension changes authority and needs owner
approval. ChatGPT propose revocation/recovery mechanics; owner sets any maximum
or extension policy. Blocks final authority enforcement, not retained journal design.

**Q04 — Stock categories and review authority (A14/A16/A17/A30/A44; T11j,T13,I19).**
Evidence: draft prohibits resale of pending returned stock; expressly leaves
other pending transfer/goods-receipt sellability and count conflict reviewer open.
Recommend keep pending incoming quantities separate from sellable until accepted;
alternative provisional sale allowance increases reconciliation exposure. Owner
must choose for non-return stock and assign reviewer; do not grant SPV inspection
powers. ChatGPT review projection and evidence requirements. Blocks sellability
policy, not disposition/history structure.

**Q05 — Cross-outlet offline refund exposure (A18/A19/A11; T15–T17).**
Evidence: user requires same-outlet offline cash payout and cross-outlet online
returns. A server cannot see an unsynchronized payout. Recommend preserve those
approved capabilities with explicit review of conflicts and measured exposure;
this is a recommendation requiring owner risk acceptance, not approved tolerance.
Alternative exclusive reservations restrict customer availability and require
policy change. ChatGPT compare feasible controls; owner chooses exposure boundary.
No automatic second payout on uncertain handover. Blocks final entitlement design.

**Q06 — Exception/correction authority (A18/A19/A30; T14–T17).**
Evidence: SPV authorizes lateness/post-exchange full refund, not opened/missing
main bottle exceptions. Paid void requires replacement; duplicate paid entry may
have an existing legitimate sale instead. Recommend route undefined exceptions to
head-office review without granting that authority until owner confirms; propose
link to existing legitimate sale for duplicate-record correction, preserving actual
payments. Alternative retain restriction and wait for a distinct correction policy.
ChatGPT review settlement invariants; owner assigns authority/exception scope.
Blocks those exception paths only; ordinary approved returns remain settled.

**Q07 — Loyalty conservation (A20–A22/A25; T18–T20,T22).**
Evidence: order.go:254–267 and pricing.ts:391–400 cap money then floor points;
audit D06 is historical reproduction. Earning on points-funded value is explicitly
provisional. Recommend whole-point redemption = floor(eligible amount/rate), then
recompute exact monetary credit; sub-point remainder stays monetary. Alternative
fractional points is a new domain policy. ChatGPT review integer conservation,
reservation/receipt proof and lot migration; owner needed only for altered policy,
not to repeat agreed restoration/expiry rules. Keep launch values unset and do not
claim current deployed loyalty disabled. Blocks enabled loyalty qualification.

**Q08 — Historical choices versus audit recommendations (A25/A44; T07,T22).**
Evidence: July 7 session banner records owner choice of raw assigned-code customer
ID with reissue after merge. June 11 stock-awareness record says allowNegativeStock
is warning/override UX; server stays lenient for captured facts. Audit recommends
merge-before-eligibility and new-online shortage validation. Recommend preserve
existing approved behavior while introducing original/effective identity and
explicit shortage evidence; do not silently turn warning into denial or migrate
assigned-code ownership. ChatGPT identify minimum cap/ownership fix consistent
with these policies. Owner approval needed for code reassignment or stricter new-
sale rules. Blocks those behavior changes, not historical evidence preservation.

**Q09 — Business time/report definitions (A10/A12/A26–A28; T07,T09,T23,T24).**
Evidence: pageLimit caps large requests to 50; summary sums completed sales then
subtracts refunds. Configurable outlet/office calendars approved but actual values
unset. Recommend distinct gross captured sales, return adjustments and actual
cash/settlement metrics with occurrence/acceptance/settlement timestamps and
as-recorded/restated views. Alternative settlement-only sales metric misrepresents
physical sale time. ChatGPT define projection contract; owner confirms business-day
calendar and cross-day report policy. Pagination/stale-response containment can
proceed in separate authorized slices without inventing calendars.

**Q10 — Operational evidence and release boundary (A32–A38/A41; T27–T33).**
Evidence: old handoffs contain deployment/flag/test claims; no current provider,
restore, signing or advisory verification this turn. Recommend isolated DB/device
qualification, authenticated compatible OTA/journal migration and sanitized evidence;
request specific future operational scope before any provider or live mutation.
Alternative staged feature release requires enforced gates and explicit residual
risk/deferrals. ChatGPT review qualification plan; owner supplies recovery objectives,
retention/access and eventual release/operational scope. No credential rotation,
service migration, dependency addition or launch follows from this packet.

### Smallest next implementation slice — S0a (proposal, not authorized)

Finding A02, containment subtask A02-export; T02 export component, D03 converted
to a corrected-invariant regression. A01 storage durability, A02 retry policy,
A03 receive classification and A37 complete redaction remain tracked, not closed.

Observable outcome: viewing/sharing failed-sync diagnostics never removes parked
financial events, even if share is cancelled, clipboard fails, export repeats or
app state is reconstructed. Pending/review remains visible. Existing stable keys,
payloads, attempts and error evidence remain unchanged by export.

Current evidence: engine.discardFailed invokes outbox.discardDeadLettered; the
cashier support action invokes it before share succeeds. Proposed files:
packages/sync/src/engine.ts, outbox.ts only if needed for nonmutating snapshot;
apps/pos/src/cashier/{CashierScreen,SyncProvider}.tsx and the actual offline-data
adapter found by tracing discardFailed references; focused sync/POS regression
files. Reconfirm exact callers before edits. Rename UI/action semantics so closing
the dialog never means deleting operations. No database migration, new dependency,
credentials, provider, auth/schema redesign, retry-policy or transfer-receive change.
Preserve existing redaction, but do not claim comprehensive A37 coverage.

Required tests: seed five-failure parked sale/refund; export twice and reconstruct
Outbox from the same successful persistent KV; exact retained IDs/payload/state;
share cancellation and clipboard failure; queue count remains visible; manual retry
still uses original key. Exercise existing sync and POS tests for regressions.
Mock KV tests do not prove native durability; A01 remains a real-device gate.

Proposed commands (NOT RUN; verify installed tooling first):
`corepack pnpm --filter @mandalika/sync exec vitest run`
`corepack pnpm --filter @mandalika/sync typecheck`
`corepack pnpm --filter @mandalika/pos test`
`corepack pnpm --filter @mandalika/pos exec tsc --noEmit -p tsconfig.json`
Inspect actual tsconfig before selecting final typecheck; no automatic dependency
install to make these run. Stop if the slice requires changing captured evidence,
introducing a migration or broadening the error protocol. No P0 closure solely
from this slice. Return diff, actual outputs, residuals and tracker delta for review.

### Review transfer and safe continuation

ChatGPT: review the supplied tracker, current evidence and Q01–Q10; separate
technical guidance from owner decisions. Recommend/adjust S0a without widening it.
Owner: relay docs/AUDIT_REVIEW_PACKET.md (sanitized snapshot of this current
section), the canonical tracker, plan/draft diff and audit references. Local paths
are not attachments in ChatGPT and these uncommitted files are not on GitHub.
Saving this packet does not mean it was delivered or approved.

Safe authorized continuation is documentation consistency/traceability only.
Implementation, deployments, credentials, infrastructure and live-data changes
remain outside this turn. No background work or external message sent.

---

