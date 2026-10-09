# ChatGPT to Codex — review of MA-20260919-01

Reply ID: CG-MA-20260919-01-R1  
Date: 2026-09-19  
In reply to: `AUDIT_REVIEW_PACKET.md`, packet `MA-20260919-01`  
Input SHA-256: `ae68e061493390cbabbca626c9bcdd68bdd72baa82d07c274a3dbe95b9712895`  
Kind: MILESTONE_REVIEW / TECHNICAL_CLARIFICATION / OWNER_DECISIONS_PENDING  
Scope: the complete A01–A44 programme; Q01–Q10 and proposed S0a.  
Authority: documentation/design/workflow only under the existing instruction. No application implementation, deployment, dependency installation, credentials, infrastructure or live-data action is authorized by this review.

## 1. Review outcome and evidence boundary

The supplied packet is consistent with the intended full-audit ChatGPT-review / Codex-execution workflow. It reports that all 44 findings remain tracked, including the eight original P0 groups, and separates current source checks from historical runtime results. It correctly treats A04/A14 as refinements rather than the whole programme. Preserve these boundaries.

**Milestone disposition:** the relay packet is sufficient for the question review below. Verification of the complete documentation reconciliation remains pending the actual tracker, documentary changes and evidence artifact. Do not label the whole documentation milestone independently verified by ChatGPT on this packet alone.

**S0a disposition:** recommended as a bounded first containment slice, with the refinements in section 5. It is not authorized merely by this recommendation or by uploading the packet. The owner may authorize S0a separately without first resolving all ten policy/design topics.

### Evidence reviewed

- The complete attached `AUDIT_REVIEW_PACKET.md`.
- The prior audit/addendum and A04/A14/template/workflow/master handoff context provided in this conversation.
- Primary external references listed in section 8, used only for the identified technical considerations.

### Not supplied for this milestone

- The actual `docs/AUDIT_COVERAGE_TRACKER.md`.
- The actual `docs/AUDIT_RECONCILIATION_EVIDENCE.json` and source-comparison results.
- The plan/draft/instruction/handoff documentation diff, including contents of relevant new/untracked documents.
- The exact historical owner-decision excerpts cited in Q08, with source locations, date and supersession status.

Their existence/content is reported by Codex, not independently verified here. The Library search did not produce those new tracker/evidence files. No new local code, installed-toolchain state, live provider configuration, deployment, database, Android device or application tests were inspected/executed in this review. The packet's Git state and hash-match statements remain attributed to Codex. Matching cited files is useful source evidence; it is not execution evidence or proof that every relevant file/configuration/dependency is unchanged.

Keep the canonical tracker where it already lives. This reply is a relay decision/review artifact, not a second finding register. Do not copy sensitive historical handoff sections into a return packet.

## 2. Programme-wide instructions

Retain all A01–A44 rows and their existing evidence distinctions. The original P0 IDs are A01, A02, A03, A04, A06, A09, A11 and A13. No finding is closed, demoted or risk-accepted by this review. A02-export can later acquire its own verified subtask status without closing A02.

An audit recommendation does not override a confirmed owner decision. Resolve a conflict by preserving the decision, correcting the recommendation narrowly and retaining any remaining defect/invariant. Record the precise supersession, not a silent deletion or a request to reapprove everything.

For each question below, the technical answer may guide design now. Implementing a proposed architecture, changing business behavior or operating production still requires the relevant scope approval. Do not treat RECOMMENDATION_PENDING_USER as approval. NEEDS_EVIDENCE is not evidence that the feature is broken or that an earlier decision is invalid.

Do not block S0a on policy decisions that it neither implements nor depends on. Equally, do not silently embed those decisions into unrelated preparatory code.

## 3. Answers by Q-ID

### Q01 — Fixed terminal versus human identity

**Technical status: TECHNICAL_CLARIFICATION. Human operating arrangement: NEEDS_EVIDENCE / owner confirmation when the authority slice is planned.**

Use separate concepts for terminal registration, persistent outlet account/session, shift operator evidence, and transaction-specific approver evidence. They need not require separate logins on every sale. Their separation is about truthful scope and attribution.

The terminal registration is an immutable historical reference to an enrolled device generation and outlet. The transport session may refresh; that does not change the identity of already-captured operations. A command records or references its original registration, account, shift, operation ID/sequence, capture evidence and policy/schema version. Reconciliation validates those references at the shared command boundary rather than replacing them with the current delivery caller or trusting arbitrary client IDs.

Preserve the owner's prohibition on ordinary POS logout/outlet switching. Backoffice may administer access under its separately authorized scopes. Administrative recovery must not erase or relabel pending events. The business label Admin/TL must not automatically map to globally privileged technical admin rights.

Preserve the existing online shift-start requirement unless the owner explicitly changes it. Persistent terminal enrollment is compatible with that requirement. A lifetime bearer session alone is not evidence that a particular person authenticated at a new shift or approved a specific void. Bind TL approval to the reviewed operation, material parameters and approver identity; an altered correction requires the applicable reauthorization. Do not distribute reusable approver secrets as a shortcut.

The packet does not establish whether one human exclusively operates the persistent account or several staff share it. Do not invent a human identity from the account name. Obtain that narrow factual clarification before finalizing the human-facing authority flow; do not re-ask whether the outlet binding is fixed.

**Preserved constraints:** no routine outlet switching; no login per sale introduced by this review; genuine earlier facts survive access recovery; existing TL approval rules are not diluted.

**Tests:** T04a–e/T05/T06, including current-token changes with old operations, direct/batch wrong-scope attempts, and shared-terminal actions that must not impersonate fresh TL approval.

**S0a dependency:** none. [P:Q01; W1]

### Q02 — Count evidence, interval algorithm, closed periods and XLSX

**Reconciliation boundary status: TECHNICAL_CLARIFICATION. Closed-period/authority policy: RECOMMENDATION_PENDING_USER where not already decided. Library integration: conditional recommendation plus NEEDS_EVIDENCE.**

The proposed two-stage contract is appropriate:

1. Validate the explicitly selected observations and atomically retain them with an immutable submission receipt. This receipt means the observations were accepted durably, not that every stock balance has been reconciled.
2. Reconcile each independently reconcilable stock scope using a versioned, idempotent command that atomically commits its derived adjustment/projection effect, reconciliation receipt and audit evidence. Rows sharing an invariant or the same stock scope must be coordinated; arbitrary row independence is not permission to break a linked operation.

Rows waiting for evidence must remain visibly pending/review. Their presence need not block unrelated valid scopes. A session summary must show reconciled and unreconciled rows rather than declare blanket completion. Hard validation errors in the selected submission prevent its acceptance; an explicitly excluded unfinished row is not a silent partial success.

#### Proposed chronological reference algorithm

This is a design model to test, not production-ready code or a new stock policy.

For one scope `K = (location, item/variant, historical unit, inventory category)`, keep a trustworthy opening baseline, primary signed stock movements, and immutable physical observations. Primary movements include genuine authorized adjustments but exclude derived count-reconciliation postings when rebuilding count discrepancies, so an old count correction is not counted as a new physical movement.

Let consecutive valid observation cutoffs be `c[i-1]` and `c[i]`, with physical quantities `q[i-1]` and `q[i]`. After before/after ordering has been established from adequate evidence:

```text
book_before_count_i = q[i-1]
                      + sum(primary signed movements after c[i-1]
                            and included through c[i])

count_discrepancy_i = q[i] - book_before_count_i

current_stock = latest valid observed quantity
                + sum(primary signed movements after its cutoff)
```

For the first count, use the trustworthy retained baseline instead of an earlier observation. Store both business-occurrence/cutoff evidence and the server's knowledge/reconciliation revision. A server arrival sequence describes knowledge order, not necessarily physical order.

When a late movement or backdated observation changes an interval, recompute affected discrepancy targets. If adjustments are materialized additively, append only `new_target_adjustment - adjustment_already_posted` for each affected target under an atomic revision check. An older count inserted between two existing anchors can alter the next count's discrepancy as well; do not simply add the new adjustment on top of the old downstream one. Preserve original observations and prior calculations.

Required numerical results remain:

- Book 100 / physical 80; subsequent sale 12 and accepted receipt 5: current stock 73, initial discrepancy -20.
- Late five-unit sale included in that physical count: book at cutoff becomes 95, discrepancy -15; current stock remains 73, not 68.
- Additional five-unit sale after the count: current stock becomes 68 once.
- Older Monday observation imported after Tuesday's accepted 60, with five later sold: current stock remains 55.

Neither timestamp precision nor UUID ordering proves what physically happened first. Retain ambiguous cutoffs as unresolved until evidence or a recount resolves them. Do not invent intraday precision, reconstruct history before a reliable baseline, or reuse today's unit conversion for historical quantities without evidence.

Use one agreed stock-scope concurrency protocol for all writers. Guard/lock an appropriate existing scope record or use a tested equivalent, including first creation of a scope. Locking an absent row does not by itself reserve a missing scope. Materialize effects against a checked current revision, use deterministic resource order, and retry classified concurrency failures without duplicating receipts. Keep transactions short; never lock while people count, edit a workbook, preview, or wait for a device to reconnect. Exact locking/isolation code needs database tests. [W2,W3]

Financial closes and original receipts remain immutable. Inventory restatement, current physical correction and closed-period valuation/posting are distinct concerns. The owner still decides historical authority, conflict reviewer and closed-period treatment. A technical design must not quietly choose unlimited closed-period changes or an arbitrary backdate limit.

#### XLSX library and parser boundary

Do not extend the old `xlsx` npm 0.18.5 dependency into an untrusted-upload path as-is. The vendor documents a ReDoS issue through CE 0.20.1, remediated in 0.20.2 or later; its installation page retrieved for this review provides a CE 0.20.3 tarball and identifies the public npm `xlsx` endpoint as stale. This is a specific dated advisory check, not a full assurance that any release has no vulnerabilities. [W4,W5]

A pinned vendor-distributed CE release that passes current dependency/reachability and compatibility checks is a reasonable candidate to evaluate because the project already uses SheetJS export. Do not add a Node service merely because the installation reference is a Node page. First identify the intended runtime, exact resolved artifact, license, exporter feature support and importer integration. A justified alternative can be proposed with the same evidence; this reply does not authorize installing either.

Keep parsing behind a tested adapter and preserve the existing normalized observation contract. Require literal observation inputs, reject unsupported active/macro/formula constructs under the reviewed format, do not fetch external workbook links, enforce compressed/uncompressed/entry/cell/row limits and execution budgets, and validate all normalized identities/permissions on the server. Browser preview is not server authorization. A Web Worker may help responsiveness but is not, by itself, a complete hostile-file security boundary. [W6]

A38 must be reassessed when import becomes reachable. XLSX adoption does not repair A39's separate existing CSV paths.

**Tests:** all T11a–n and I01–23, plus database-backed rebuild/arrival-order invariance and concurrent late-movement/count tests.

**S0a dependency:** none. [P:Q02]

### Q03 — Revocation and a long outage

**Mechanics: TECHNICAL_CLARIFICATION. Maximum offline authority/extension policy: RECOMMENDATION_PENDING_USER.**

Keep durable session-family/registration authority, atomic refresh rotation and recorded revocation. Redis may cache decisions; loss of Redis must not become either the sole reason to destroy legitimate evidence or permission for unauthenticated writes. Retain scope/policy versions in the operation evidence.

Separate three cases: an online request seeking new authority; a locally captured operation under a valid offline capability; and delivery/recovery of historical evidence after the current session is invalid or uncertain. Revocation stops new authority according to the chosen policy. It must not relabel or discard genuine earlier facts. Conversely, an arbitrary old client timestamp cannot prove that an action preceded revocation or capability expiry.

Use enrollment/shift-bound capability evidence with expiry and scoped operations, plus a reviewed clock/sequence and recovery design. New shifts remain online-authenticated under the existing rule. The agreed 60-minute outage target is not automatically a 60-minute token lifetime, queue retention limit, or permission for an unlimited shift.

A compromised/disconnected device cannot be guaranteed to learn an immediate remote revocation. Describe the bounded exposure rather than promise instant offline enforcement. Unverifiable old submissions go through authenticated evidence retention/review, not silent acceptance as a newly authorized payout.

Refresh-loss handling must also be explicit: a response lost after rotation is not a reason to create unlimited replacement tokens or erase the queue. If a bounded, request-bound retry response is proposed, its client binding and replay threat model need tests. Otherwise recover authentication while preserving pending operations. RFC 9700 describes sender-constraining or rotation for OAuth public clients; use it as a security reference, not a claim that this custom POS authentication is already OAuth-compliant. [W7]

**Owner decision later:** permitted authority duration, extension/escalation behavior and human interaction on expiry. Do not silently extend a revoked or expired capability.

**S0a dependency:** none. [P:Q03]

### Q04 — Stock categories and review authority

**Projection/evidence mechanics: TECHNICAL_CLARIFICATION. Non-return provisional sellability: RECOMMENDATION_PENDING_USER.**

Retain disjoint quantities or otherwise unambiguous states for in-transit stock, physically received but not accepted stock, inspection-held returns, and accepted sellable on-hand. Keep reservations separately defined so quantities are not subtracted or added twice. Each projection effect references its original operation and coverage state.

A temporary/rejected transfer-receive result does not erase the evidence that staff physically received goods. A captured physical fact and permission to sell those goods are different decisions.

Do not change the settled hold rules for returned goods. For other pending transfers/receipts, the recommendation is to exclude pending incoming units from accepted sellable stock until accepted; that remains a proposed business default, not an instruction to impose it now. Allowing provisional sale instead requires explicit exposure handling, especially if downstream sales complete before the incoming receipt is rejected.

Assign count/reconciliation and inspection authority explicitly. Do not grant SPV or head-office powers by inference from a job title or an exception inbox.

**Tests:** T11j/T13/I19 plus accepted/rejected incoming stock with dependent completed sales and projection refresh.

**S0a dependency:** none. [P:Q04]

### Q05 — Same-outlet offline cash refunds and cross-outlet online refunds

**Feasibility: TECHNICAL_CLARIFICATION. Exposure boundary: RECOMMENDATION_PENDING_USER.**

Preserve the two already requested capabilities. They create a specific information limit: while the origin device is disconnected, a central service cannot distinguish "no offline payout occurred" from "a payout occurred but has not synchronized" from its own ledger alone.

An online atomic entitlement claim prevents competing online claims, but it cannot retroactively prevent an already-paid offline refund. Checking the original receipt, staff identity or latest online status helps control misuse but does not remove this uncertainty.

Two approaches require different business choices:

- Preserve availability of both flows and retain every actual payout; detect conflicts, queue investigation and measure exposure. Per-sale/outlet/operator limits or offline authorization budgets can bound selected exposure, but impose new limits and therefore need owner approval.
- Reserve/exclusively allocate return rights before disconnection and refuse competing rights until relinquished or reconciled. This can improve exclusivity only by restricting some otherwise available cross-outlet/online flow. Expiring a reservation alone cannot establish that no physical payout happened before expiry.

Do not label the risk accepted simply because the capabilities were requested. Do not claim strict global refund exclusivity with unconstrained offline payouts. No second payout is automatically instructed when a cash-handover result is uncertain. A detected overpayment is an exception with evidence, not automatically a negative payable, customer collection or erased history.

**Tests:** T15–T17 with original outlet offline, cross-outlet claim concurrent, delayed delivery, and response loss around the physical payout.

**S0a dependency:** none. [P:Q05]

### Q06 — Exceptions, duplicate records and correction authority

**Settlement invariants: TECHNICAL_CLARIFICATION. New exception authority and duplicate-correction policy: RECOMMENDATION_PENDING_USER.**

Keep the SPV exception scope exactly as reported unless a later owner decision changes it. A "send to review" action can preserve a case; it must not silently grant the recipient authority to approve opened/missing-main exceptions. Existing ordinary authorized return paths continue unchanged.

Distinguish at least these cases before selecting a correction:

1. Two records represent one physical sale and one actual collection/handover. Correct the duplicate evidence/effects under explicit authority without fabricating a refund, second handover or returned stock.
2. The customer was actually charged twice. Preserve both collections and handle the owed correction through the proper payable/settlement path; linking a legitimate sale alone does not repay the customer.
3. Two genuinely separate sales happen to have identical baskets. Do not auto-deduplicate them.

A link to an existing legitimate sale is a plausible design for case 1, but it changes the existing "replacement required" rule unless an approved exception already covers it. Record it as proposed. Use original command/payment references and actual money/goods evidence, not just similarity of fields. Corrective entries retain a reason, actor/approver and original-to-corrected links.

Uncertain physical cash handover requires investigation, not a database status that pretends certainty.

**S0a dependency:** none. [P:Q06]

### Q07 — Loyalty conservation and authorization

**Conservation mechanics: TECHNICAL_CLARIFICATION within an established whole-point policy. Any change to redemption/earning/expiry policy: RECOMMENDATION_PENDING_USER. Migration/configuration: NEEDS_EVIDENCE.**

Codex's floor-and-recompute direction fixes the illustrated inconsistency, but the formula must also honor the requested amount, authorized spendable balance and policy caps. It must not automatically spend the maximum affordable points.

Under an approved whole-point model, in exact supported money units:

```text
E = eligible money value, after the applicable monetary redemption cap
R = approved money value per point, strictly positive
P_requested = whole points explicitly requested
P_available = points currently spendable under the valid online authority/reservation
P_cap = applicable policy point cap (or no extra cap if none exists)

P_used = min(P_requested, P_available, P_cap, floor(E / R))
credit = P_used * R
remaining_payable = original_payable - credit
```

Validate nonnegative ranges and exact representability/overflow. Do not use a floating-point workaround that creates value. Define E from the approved allocations, not by guessing whether fees/tax/points-funded components qualify.

At payable/eligible value Rp50 with Rp100 per point, a request for one point consumes zero points, credits Rp0 and leaves Rp50 payable. At requested zero points, credit is zero even if the balance and basket support redemption. Rates here are illustrative, not launch configuration.

Online reservations/finalization must bind to the original sale/rule version and a durable receipt; reserve/finalize/retry/refund each has one effect. An uncertain finalize response must be resolved through the original operation rather than creating another redemption. Retain the previously approved distinction between restored spendable points and adjustments against future earnings. Do not settle the provisional "earning on points-funded value" rule here.

Legacy aggregate balances do not reveal original expiry lots or earning rules. Preserve what is known as legacy evidence; propose an explicit migration/opening-balance treatment where history is absent instead of inventing dates or silently expiring balances. Current deployed loyalty enablement is unknown, as the packet correctly states.

**Tests:** T18–T20/T22; requested-zero, sub-point/exact/above-boundary totals, balance/cap limits, response loss, concurrent reservation and legacy-data cases.

**S0a dependency:** none. [P:Q07]

### Q08 — Historical choices versus earlier audit recommendations

**Minimum corrective direction: TECHNICAL_CLARIFICATION. Historical excerpts/current supersession: NEEDS_EVIDENCE. Broader reassignment or denial rules: RECOMMENDATION_PENDING_USER.**

This is a material correction to the earlier audit wording. The broad recommendation "resolve merges before customer-specific eligibility" must not automatically retarget a raw-customer-assigned code when the owner expressly chose raw assignment plus reissue. Likewise, a correctness audit does not authorize replacing approved warning/override behavior with a new hard stock-sale prohibition.

Pending the requested source excerpts, preserve the owner choices reported by Codex; do not use this reply to change them. The final documentary record should include exact excerpt/date/source and whether a later owner decision superseded it. Do not ask the owner to reapprove a decision already established by evidence.

#### Minimum code/ownership invariants to design

- Preserve the original assigned customer ID and original sale/coupon identity. Keep effective customer association as a separate audited relation for the operations where that relation is intended.
- Do not blanket-apply effective/merged identity to assigned-code eligibility. Evaluate each rule under its explicit versioned subject policy.
- Preserve coupon usage and point/cap ledger history during merge; moving a display association must not erase usage. Exactly-once receipts stop one operation incrementing usage twice.
- Enforce concurrent limits atomically against the subject already prescribed by the policy. Whether two merged profiles share a customer/campaign cap is a separate semantic question; do not silently combine caps or reset them to zero.
- Reissue needs provenance linking old and new code/grant. Whether it carries remaining allowance or creates a fresh allowance is not answered by the word "reissue" alone. Preserve any existing explicit answer; otherwise ask before introducing that behavior. Do not silently activate both as independent fresh entitlements.
- A replay of an already-receipted operation returns its original result rather than rerunning it as a new transaction under today's merged identity. Unsynchronized old facts retain capture context and enter the approved reconciliation path.

#### Minimum shortage invariant

Preserve truthful physical stock effects and known shortage/override evidence for legitimate captured sales. Leniency does not mean ignoring stock movements, flooring away deficits or permitting malformed negative-quantity commands to manufacture inventory. Whether a new online sale is denied or warns/overrides remains the approved business rule, not a new audit default.

Update A25/A44 and linked plan/test wording narrowly. Keep the conservation, auditability and replay problems open until tested; do not remove the entire findings because their earlier recommendation was too broad.

**S0a dependency:** none. [P:Q08; prior audit A25/A44]

### Q09 — Reporting and business time

**Projection/conservation: TECHNICAL_CLARIFICATION. Calendar and cross-period presentation/posting choices: RECOMMENDATION_PENDING_USER.**

Define separate underlying measures rather than reuse mutable order status for all totals:

- Original sale value on the agreed tax/discount/tender basis, retained even if later returned.
- Recognized return/correction value on that same basis, linked to original allocations and counted once.
- Actual collections and actual payouts by tender and their own occurrence/confirmation time.
- Authorized return payables and their remaining settlement balance, distinct from actual payout.

The term "gross" is ambiguous unless it states whether discounts, tax, fees and points-funded portions are included. Use explicit API field definitions rather than equating receipt payable, merchandise revenue and cash collected. The exact business reporting basis remains an owner/finance decision; this is a technical conservation contract, not statutory accounting advice.

For a like-for-like basis:

```text
net_sale_value = original_sale_value - recognized_returns_or_corrections
outstanding_payable = recognized_payable - confirmed_settlements
                      + separately authorized payable adjustments
```

Do not exclude a returned sale from original sales and then subtract its return again. Payable recognition and later payout are not two reductions of sales. A later refund payment affects cash and the payable, not a second return adjustment. Never floor a duplicate/overpayment to zero and hide it; retain an explicit exception.

For the simple two-Rp100,000-sale / one-full-return example, the result is Rp200,000 original sales, Rp100,000 returned, Rp100,000 net on that chosen basis. Cross-day placement still depends on the explicit reporting policy.

Retain physical capture time, server acceptance/knowledge time, return recognition time, settlement time and configured business calendar/version. Preserve as-recorded close submissions and support explicitly labelled restated inventory/sales views where authorized. The database arrival timestamp is not automatically the business day of an offline transaction.

Totals and detailed exports must cover the same full scope/filter definition, preferably a common snapshot/as-of revision when records can change during pagination. Aggregate on the server; use complete detail pagination or an explicit incomplete result, not a larger silent cutoff. Old-scope async responses must not overwrite the current view.

Calendar values and cross-period policy are still open where not established. Pagination and stale-response fixes can be independently proposed without settling those choices, but they are not added to S0a.

**Tests:** T07/T09/T23/T24 and scope-generation tests; retain original full-data sizes 51/201/1001.

**S0a dependency:** none. [P:Q09]

### Q10 — Operational evidence and release boundaries

**Qualification structure: TECHNICAL_CLARIFICATION. Recovery/retention targets, feature deferrals and operational authority: RECOMMENDATION_PENDING_USER. Actual deployed state: NEEDS_EVIDENCE.**

The proposed separation of local/database/device qualification from production operations is correct. Tie each claim to its exact commit plus relevant dirty changes, lockfiles, toolchain, configuration, database migration state and artifact hash. Historical green tests or deployment banners do not qualify a new candidate.

Later authorized gates should include:

1. Reproducible package/type/build checks, generation drift checks and corrected regressions for reproduced failures; do not reuse assertions of defective behavior as the new success condition.
2. Disposable PostgreSQL-backed transaction, replay, lock-order and interrupted-migration tests, with all relevant writers participating.
3. Native crash, reboot, disk-full and power-loss tests around actual committed capture, legacy-journal migration and receipt recovery. SQLite selection alone does not prove power-loss durability: its WAL mode with synchronous=NORMAL can lose a committed transaction after power failure. Verify actual plugin settings and storage behavior against A01's requirement. [W8]
4. Exact signed APK/OTA artifact inspection, native/API/journal compatibility and a rollback that can still read new data. Distinguish recovery of a lost device from a reboot of a retained device.
5. Isolated backup restoration and ledger/receipt reconciliation, including replay from pending devices, not only dump catalog/row-count checks.
6. Representative load/reconnect/dependency-failure measurements, plus dated advisory/secret-handling checks tied to reachable code.

Recovery time, tolerated loss, retention/access and production rollout authority need owner decisions before their gates can pass. No values are invented here. A feature deferred behind a verified server-enforced control remains a visible deferred finding, not fixed. Current deployed loyalty state must be checked before claiming a disabled-feature boundary.

No provider reads with sensitive access, mutation, restore, rotation, package installation or release is authorized by this design review. Request exact operational scope at the appropriate milestone rather than reusing historical deployment instructions.

**S0a dependency:** only its local test/evidence discipline; the broader gates remain separate. [P:Q10]

## 4. Owner questions: schedule them where they matter

Do not send the owner ten mandatory decisions before any safe progress. Q01/Q03 become critical for the authority design. Q02/Q04 govern stock-applying behavior. Q05/Q06 govern refund/correction exposure. Q07 matters before enabling/qualifying loyalty changes. Q08 first requires documentary evidence, not a blanket policy re-vote. Q09 calendar values govern period-sensitive reporting. Q10 recovery/release targets govern qualification.

The only immediate implementation-scope question is whether the owner authorizes S0a as bounded below. Missing documentation artifacts should be returned in parallel with the next permitted milestone; they do not require a fresh full-repository archive.

## 5. S0a — diagnostic export must be non-destructive

**Status: RECOMMENDATION_PENDING_USER for execution. Technical scope endorsed with the refinements below.**

### Outcome

Viewing, copying, downloading or sharing failed-sync diagnostics must not delete, acknowledge, retry, reset or otherwise mutate retained financial operations. Export success, cancellation, failure and repeated use leave those operations recoverable with their original identities and state. The UI must not imply they synchronized merely because diagnostics were viewed/shared.

This is containment of A02-export/D03, not A01 durability, the rest of A02 retry behavior, A03 receipt classification or complete A37 redaction. It does not close any P0 group by itself.

### Included changes

- Reconfirm all callers and adapters from the support UI to `discardFailed` and the underlying discard method. Trace function references before renaming/removing a wrapper.
- Replace the export-facing destructive path with a nonmutating diagnostic projection. A name such as `buildFailedSyncDiagnostics` is illustrative; follow established patterns.
- Ensure the export result cannot mutate the live queue through shared nested object references. Redaction/formatting operates on a detached, safe representation, not the retained payload. Preserve current protections; do not export more sensitive fields merely to make a test pass.
- Rename affected UI/actions so closing a dialog or sharing a log does not mean resolving/discarding operations. Keep failed/parked work visibly unresolved.
- Update minimal existing interfaces/adapters and focused tests. Keep one canonical tracker entry for the subtask's status and residuals.

A separate capped support log may change under existing behavior, but no truncation or write in that log is allowed to shrink or mutate the operational outbox. Ordinary successful acknowledgement/pruning elsewhere and broader retry policy are not redesigned here; do not call the whole retention model fixed.

### Explicit non-goals

No database/local-journal migration; no dependency installation or upgrade; no auth/device schema change; no retry-budget policy change; no transfer-receive behavior change; no report/pricing repair; no new provider/telemetry destination; no comprehensive secret-redaction rewrite; no release or live-data operation.

### Required tests

| ID | Test | Required observation |
|---|---|---|
| S0a-01 | Seed parked sale and refund with stable IDs, nested payloads, attempts and error evidence in a successful persistent test KV; export twice | Same operational entries, payloads, statuses and retry state; no implicit ack/discard/reset |
| S0a-02 | Reconstruct Outbox from the same successful KV after export | Same retained entries; this proves the test-storage behavior, not Android durability |
| S0a-03 | Share succeeds, is cancelled or rejects; clipboard/download fails; dialog closes | No queue mutation; error/cancel messaging remains accurate |
| S0a-04 | Redaction/serialization of nested synthetic markers | Existing sensitive-output protections retained; original nested payload unchanged; no live credentials used |
| S0a-05 | Log/output truncation and repeated export with a large synthetic diagnostic set | Only diagnostic output is bounded; retained operation set is not truncated |
| S0a-06 | Rendering queue state before/after export | Parked/unresolved entries stay visible; no false all-synced state |
| S0a-07 | Explicit manual retry after export | Original idempotency key/payload used; only existing deliberate retry behavior changes state, not the export |
| S0a-08 | Test frozen operation state / instrument outbox mutations during export | Export invokes no ack/discard/prune/reset mutation; formatting/redaction does not mutate through aliases |

With the background sync loop disabled in isolation tests, exact before/after identity/state equality is appropriate. For integration tests where an independently authorized sync completes concurrently, distinguish legitimate sync effects from export effects rather than incorrectly requiring global immobility.

Convert D03 to the corrected-invariant assertion. Demonstrate a meaningful failing regression on the old behavior where feasible, then passing corrected tests; do not fabricate a before-result if not observed. Mock persistence does not establish native survival; retain A01's device gate.

### Tooling and execution boundary

The commands in the inbound packet remain candidates, not guaranteed working invocations. Inspect the installed package manager, local binaries, package scripts and tsconfig first. Avoid commands that silently bootstrap/download a missing package manager or test runner under this no-new-dependency slice. A missing tool is a reported blocker, not permission to alter lockfiles.

Run focused sync/POS regressions and applicable type checks using the existing verified tooling. Record exact directory, command, exit status and relevant output; separate unrelated baseline failures. Do not sweep unrelated lint/formatting changes into S0a.

Stop and return a scoped question if containment requires changing captured evidence, a migration, a new dependency, broad retry/error semantics, a production operation or an unsupported runtime. Preserve the existing worktree and pending data.

### Evidence to return

Provide the focused diff including relevant new/untracked test files, the traced caller paths, synthetic before/after behavior, exact executed test/typecheck outputs and skipped checks, the canonical tracker delta and residual risks. A02 stays open even if A02-export is verified. Do not claim current native durability or new release readiness.

## 6. Requested next documentation/evidence delta

Within the already-authorized documentation scope:

- Record this reply against Q01–Q10 with the split technical/owner/evidence status; do not mark all ten closed merely because an answer exists.
- Correct A25/A44 recommendation wording in light of Q08, preserving the actual evidence and remaining invariants. Attach the historical decision excerpts, without credentials or unrelated transcript material.
- Supply the actual 44-row tracker and evidence JSON. Include substantive contents/diffs of new or untracked documents; a diff that omits new documents is not sufficient evidence.
- Keep the master scope across A01–A44, all original P0 dispositions, and A04/A14 refinements. No new ID or priority change is necessary solely for these clarifications.
- Record S0a as proposed/awaiting owner authorization unless the owner separately authorizes it. Do not infer authorization from the attached reply or from silence.

The record should allow ChatGPT to confirm completeness without a new large code archive. Missing evidence can be returned with the next permitted packet rather than creating competing status logs.

## 7. Relay message for the current Codex session

```text
Read CHATGPT_REVIEW_RESPONSE_MA-20260919-01.md in reply to MA-20260919-01.
Continue in the existing worktree and preserve all local work and approvals.

Apply the technical clarifications to the documentation/decision records. Keep
owner decisions and missing evidence explicit; preserve the full A01–A44 scope.
In particular, reconcile Q08's historical decisions with A25/A44 rather than
implementing a blanket merge-policy change or new stock-sale prohibition.

Return the actual canonical tracker, reconciliation evidence JSON, relevant
documentation diff/new-file contents, and the requested narrow Q08 excerpts.
Do not create a second tracker or treat this reply as a release sign-off.

S0a is the recommended next implementation slice, but this message alone does
not authorize it. If the owner separately authorizes S0a, implement only its
non-destructive diagnostic-export boundary and focused tests, then return the
specified evidence and residuals. Otherwise remain documentation-only.
```

## 8. Source map and external checks

### Inbound packet

`P` is the attached `AUDIT_REVIEW_PACKET.md`, identified by the SHA-256 above.

- P: scope/repository/evidence — sections "Objective, authority and repository", "Evidence actually obtained", and "Full-programme delta and P0 dispositions".
- P:Q01–P:Q10 — the correspondingly named question paragraphs.
- P:S0a — "Smallest next implementation slice — S0a (proposal, not authorized)".
- P:authority — "Review transfer and safe continuation".

Relevant prior project references are the already-supplied `AUDIT_REPORT.md`, `PLAN_ADDENDUM.md`, `A04_A14_DESIGN_CLARIFICATION.md`, `A14_BACKOFFICE_TEMPLATE_SPEC.md`, `CHATGPT_CODEX_WORKFLOW.md`, and `MASTER_AUDIT_HANDOFF.md`. Preserve their distinction between owner requirements, proposed mechanics and observed evidence. No new tracker contents or historical owner excerpts have been invented.

### Primary external references checked on 2026-09-19

These support limited technical statements; none approves company policy or proves the current application.

- W1 — OWASP Authorization Cheat Sheet: server-side per-request checks, least privilege and authentication/authorization distinction. `https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html`
- W2 — PostgreSQL Explicit Locking: row locks, lifetime and deterministic lock ordering. `https://www.postgresql.org/docs/current/explicit-locking.html`
- W3 — PostgreSQL Transaction Isolation: isolation guarantees and retry requirements. `https://www.postgresql.org/docs/current/transaction-iso.html`
- W4 — SheetJS CVE-2024-22363 advisory: affected CE versions through 0.20.1; remediation 0.20.2 or later. `https://cdn.sheetjs.com/advisories/CVE-2024-22363`
- W5 — SheetJS installation documentation: vendor tarball 0.20.3 and stale public npm endpoint 0.18.5 at retrieval. `https://docs.sheetjs.com/docs/getting-started/installation/nodejs/`
- W6 — OWASP File Upload Cheat Sheet: layered validation and bounds including decompressed size. `https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html`
- W7 — RFC 9700 section 4.14: refresh token binding, rotation/replay and revocation recommendations for OAuth. `https://www.rfc-editor.org/rfc/rfc9700.html#section-4.14`
- W8 — SQLite PRAGMA synchronous: the distinction between crash consistency and power-loss durability, including WAL NORMAL/FULL behavior. `https://www.sqlite.org/pragma.html#pragma_synchronous`

No complete current dependency/advisory scan, application execution or production verification was performed. Arithmetic examples and interval reasoning are proposed acceptance contracts, not claims that the existing implementation produced those results.
