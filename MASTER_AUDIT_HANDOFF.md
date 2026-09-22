# Mandalika POS — MASTER full-audit handoff

Date: 2026-09-19  
Version: 1.0  
Entry point: read this file first, then the referenced sources.  
Scope: **all 44 original grouped findings, A01–A44, across P0–P3**.  
Status: corrective scope consolidation and documentation/design handoff. This is not a fresh code audit, a declaration that all findings remain open today, an approval of every proposed fix, or implementation/release authorization.

## 1. The scope correction

The intended programme is the whole readiness audit. The subsequent A04/A14 conversation refined two findings; it did not remove the other 42.

`A04_A14_DESIGN_CLARIFICATION.md` and `A14_BACKOFFICE_TEMPLATE_SPEC.md` are deliberately focused supplements. `CHATGPT_CODEX_WORKFLOW.md` already makes the two-way workflow project-wide, but its adoption prompt concentrates on those two supplements. Those three files alone are not a self-contained full-audit backlog.

**For this full-audit adoption, use the bootstrap instruction in section 10 below instead of the narrower A04/A14-only adoption prompt in section 10 of `CHATGPT_CODEX_WORKFLOW.md`.** Keep that file's general roles, question packets, approval boundaries and evidence requirements. This master corrects the immediate review scope; it does not authorize implementation of the whole audit.

The baseline contains **44 total groups, including 8 P0 groups**—not 44 plus 8. Original priorities are 8 P0, 32 P1, 3 P2 and 1 P3. The original P0 set is **A01, A02, A03, A04, A06, A09, A11 and A13**. A14 is originally P1; its expanded requirements do not silently change that historical classification.

All 44 must remain visible in the current tracking system, even when the next approved implementation slice addresses only a few. The register is a minimum retained review scope, not a claim that the codebase can have no further defects.

## 2. Read the sources together

| File | Role | How to apply it |
|---|---|---|
| [MASTER_AUDIT_HANDOFF.md](MASTER_AUDIT_HANDOFF.md) | Full-scope entry point and completeness contract | Coordinates the sources and requires disposition/evidence for every A01–A44 entry. |
| [AUDIT_REPORT.md](AUDIT_REPORT.md) | Original full audit | Read all findings, source locations, required changes, acceptance evidence, policy questions and verification limits. Treat its source-state statements as historical evidence, not current-worktree facts. |
| [PLAN_ADDENDUM.md](PLAN_ADDENDUM.md) | Cross-project plan expansion | Preserve its command, inventory, reporting, policy, operational and acceptance requirements, with the narrowly identified clarifications below. T01–T34 are proposed checks, not passing results. |
| [A04_A14_DESIGN_CLARIFICATION.md](A04_A14_DESIGN_CLARIFICATION.md) | Targeted A04/A14 refinement | Replace the routine POS switching scenario with fixed-binding/recovery; expand count reconciliation. Preserve unrelated requirements. |
| [A14_BACKOFFICE_TEMPLATE_SPEC.md](A14_BACKOFFICE_TEMPLATE_SPEC.md) | A14 import/direct-entry technical proposal | Apply the user-confirmed Backoffice-template direction. Format/implementation defaults remain proposals to reconcile, not blanket business-policy approvals. |
| [CHATGPT_CODEX_WORKFLOW.md](CHATGPT_CODEX_WORKFLOW.md) | Project-wide two-way collaboration | Apply the review/execution/escalation loop to all 44 findings and subsequently discovered issues, using this master's broader adoption scope. |
| [findings.json](findings.json) | Unmodified machine-readable original register | Retains all 44 original findings and their evidence. Its historical A04/A14 wording is refined by the companion documents; do not implement that wording in isolation. |
| [verification_summary.json](verification_summary.json), [source_fingerprints.json](source_fingerprints.json), [evidence.zip](evidence.zip) | Historical test/reproduction evidence | Preserve the baseline, limitations and source provenance. Nothing in this packet says these checks were rerun on Codex's current worktree. |
| `docs/PRODUCTION_READINESS_PLAN.md`, `docs/PRODUCTION_READINESS_DRAFT.md`, applicable project instructions and current handoff/decision records | Codex's latest local project truth and approvals | Read them in the active worktree. They are intentionally not replaced by old archive copies in this packet. Report missing files or material conflicts. |

The five supporting narrative documents and all original audit evidence are bundled unchanged. This master and the packet manifest are new. Do not create a second conflicting plan or decision log merely to import this package. Reuse the existing canonical documents/tracker and retain these audit sources as reference material.

## 3. Authority, chronology and narrow clarifications

### Approved intent is not the same as a proposed mechanism

Distinguish explicit user decisions, previously approved policy, technical recommendations, current implementation, and verified behavior. A newer assistant-generated document does not automatically override an older user-approved rule. Conversely, an explicit later user clarification refines the intended behavior even when the old implementation differs.

Read the latest local decisions before assuming any issue is still unresolved. Preserve newer verified work and all uncommitted edits. If sources conflict, identify the exact statements and their authority; seek clarification only for the consequential unresolved choice. Do not force the project back to the audit's historical commit.

### A04: fixed terminal, not ordinary outlet switching

User-confirmed intent: each operational POS is tied to one outlet/account; no routine POS logout/outlet switching; administration occurs through Backoffice. Retain original event attribution, server-enforced device/outlet scope, pending-event preservation and authenticated recovery. Reframe the original A04/T04 scenario accordingly; use T04a–T04e from the clarification.

Apply that correction wherever the older report/addendum mentions ordinary POS switching, including relevant A30 tests. Do not remove legitimate scoped Backoffice cross-outlet operation, A31's Backoffice stale-response issue, or recovery tests. Persistent terminal enrollment does not silently resolve the distinct staff/shift/TL identity decisions. Report conflicts with the latest local policy rather than choosing a new staff-authentication obligation.

### A14: historical observations while selling continues

User-confirmed intent: direct entry and Backoffice-template import must support ongoing sales and delayed/backdated counts, automatically reconciling when sufficient evidence exists. Retain the original immutable-completion/replay safeguard and expand it with T11a–T11n and I01–I23.

A frozen baseline means retained historical evidence, not stopped sales or a calculation that can never be revised. Keep physical observations immutable; use audited reconciliation revisions or linked corrections. Distinguish occurrence time from arrival time, pre-count from post-count movements, and older from newer accepted counts.

Do not close A14 after implementing XLSX export/import or an absolute balance update. A14 interacts with A11, A15, A16, A17, A28, A39 and A42. The template choice does not eliminate existing CSV defects elsewhere (A39), prove dependency safety (A38), or authorize changes to financial closed periods. Importing untrusted workbooks can change dependency reachability and must be assessed in the actual design.

### No implied demotion or closure

A clarification can correct a scenario without proving the code fixed. Record any priority change, superseded assertion, deferral or non-applicability with its reason, evidence and decision authority. Preserve the original finding ID. An optional feature genuinely disabled under an approved release scope can be tracked as deferred/disabled, not verified fixed.

## 4. Complete baseline register: A01–A44

The following index preserves every original finding. Only the display summaries of A04 and A14 are updated to reflect the later clarifications. Priorities are the **historical audit priorities**. No row is marked currently fixed, still open, or verified by this consolidation.

For every row, the detailed acceptance paragraph and source locations in `AUDIT_REPORT.md` remain part of the review; the test-ID column is an index, not an exhaustive replacement. A40 has its own audit acceptance requirement even though the addendum does not assign it a dedicated T-number. A shared test may support multiple findings but does not automatically close them all.

| ID | Baseline priority | Finding / clarified scope | Proposed acceptance references |
|---|---|---|---|
| A01 | P0 | A successful local capture is not a durable commit | T01 |
| A02 | P0 | Transport failures can park financial events and a support action deletes them | T02 |
| A03 | P0 | Every per-item transfer-receive error is treated as a permanent competing receipt | T03 |
| A04 | P0 | Fixed device/account/outlet binding and original attribution across synchronization and Backoffice recovery; no routine POS outlet switching. | T04a–T04e |
| A05 | P1 | Authentication startup conflicts with offline shift recovery | T05 |
| A06 | P0 | Refund permission is enforced on one route but bypassed by sync | T06 |
| A07 | P1 | Refresh rotation and revocation do not have a durable, atomic authority model | T05 |
| A08 | P1 | Offline approval distributes reusable PIN verification material | T06 |
| A09 | P0 | Ordinary sale-line and tender invariants are not enforced at the command boundary | T07 |
| A10 | P1 | The original offline quote is not retained independently of recalculation | T07 |
| A11 | P0 | Exactly-once effects are not a shared property of every write | T08 |
| A12 | P1 | Shift ownership, concurrent opening and late-event accounting are incomplete | T09 |
| A13 | P0 | Product transfers can apply concurrent state transitions more than once | T10 |
| A14 | P1 | Immutable count observations and replay-safe completion, expanded to live/backdated input, late-event reconciliation and Backoffice-generated templates. | T11a–T11n, I01–I23 |
| A15 | P1 | Acknowledgement can make sold stock reappear on the POS | T12 |
| A16 | P1 | Required offline inventory workflows are not all represented | T13 |
| A17 | P1 | Inventory cannot yet be fully reconciled from a single movement history | T12 |
| A18 | P1 | Refund implementation does not represent the accepted return and payout policy | T14, T15 |
| A19 | P1 | Exchange, paid-void and recovery need new domain commands, not status reuse | T15, T16, T17 |
| A20 | P1 | Aggregate points cannot express the accepted restoration, expiry and adjustment rules | T18 |
| A21 | P1 | Online-only redemption cannot be enforced with the existing Offline flag | T19 |
| A22 | P1 | Redemption rounding can give monetary credit while consuming zero points | T20 |
| A23 | P1 | A linked tiered promotion loses its tier configuration in POS pricing | T21 |
| A24 | P1 | Guest sales are blocked despite the accepted policy | T22 |
| A25 | P1 | Customer merges and corrections need immutable historical ownership rules | T22 |
| A26 | P1 | Reports and shift recaps silently aggregate only the first 50 records | T23 |
| A27 | P1 | The backend summary subtracts refunded sales twice | T24 |
| A28 | P1 | Business time is inconsistent across pricing, reporting and return deadlines | T24 |
| A29 | P1 | Network and batch error contracts do not support safe recovery | T25 |
| A30 | P1 | The permission model needs an operation-by-scope matrix, not UI assumptions | T04, T06 |
| A31 | P2 | An old polling response can overwrite a newly selected outlet | T26 |
| A32 | P1 | Startup migration and connection budgeting are not multi-instance safe by design | T27 |
| A33 | P1 | Redis remains a required startup/auth dependency and routine traffic amplifier | T28 |
| A34 | P1 | CI does not enforce the full financial and client reliability baseline | T29 |
| A35 | P1 | OTA and native release gates do not yet protect a financial-journal migration | T29, T30 |
| A36 | P1 | Backup scripts are not evidence of recoverability and restore lacks guardrails | T31 |
| A37 | P1 | Sensitive evidence and local secrets need a separate handling policy | T32 |
| A38 | P2 | Dependency review is not a full reachability-verified vulnerability audit | T33 |
| A39 | P2 | CSV import corrupts escaped quotes and multiline fields | T32 |
| A40 | P3 | Documentation and baseline labels can cause work on the wrong assumptions | Audit A40 acceptance: current entry point, decisions, branch and reproducible checks |
| A41 | P1 | An outbox is not a durable local receipt and return-history ledger | T30 |
| A42 | P1 | Cross-command lock ordering can deadlock under concurrent business operations | T34 |
| A43 | P1 | Malformed financial request bodies can be accepted with zero/default values | T25 |
| A44 | P1 | Historical/deleted variants and stock shortage handling need explicit exceptions | T07 |

## 5. Required current-worktree traceability

Codex must reconcile all 44 entries against the actual active worktree and latest plan/draft, keeping one canonical tracker. Reuse an existing tracker with equivalent fields instead of adding a competing one. Expand grouped findings into linked subtasks where necessary, retaining their parent A-ID.

For each finding record:

- Original ID/priority/evidence class, any proposed revised priority and its rationale.
- Current worktree evidence: paths/lines or diff; commit plus relevant uncommitted changes; date/environment. Do not call an old source location current without checking it.
- Requirement/decision source and authority; whether it is approved, proposed, unresolved or superseded.
- Exact plan/draft section(s) covering the finding, with explicit/partial/missing coverage as assessed now—not copied blindly from the historical audit.
- Dependencies, bounded implementation slice/owner, migration/compatibility impact and affected workflows or feature flags.
- Acceptance criteria, linked test IDs, commands actually run, environment, outputs, skipped/blocked checks and residual risks.
- Current disposition and reason: for example needs revalidation, confirmed open, design needed, waiting for owner decision, ready within authorized scope, implemented but unverified, verified in a specified environment, deferred/disabled by approved scope, or superseded/not applicable with evidence.
- Release relevance and any exception source. Passing a local unit test is not production qualification; shipping an artifact is not proof the finding is resolved.

All 44 entries need an explicit disposition, including entries not yet revalidated. A docs-only reconciliation must not invent fresh test results. A verified current fix can be retained with evidence; do not reset completed work to open merely because the historical audit lists it.

Use a coverage check to ensure the original ID set is exactly A01–A44 without silent omission. Keep newly discovered issues in the same tracking system with distinct unused IDs and provenance; do not renumber the original findings or silently replace them. New evidence may extend the audit scope rather than being ignored because it is not one of the 44.

## 6. Full programme coverage is different from the next execution slice

The whole programme includes every baseline finding. A bounded implementation slice includes only its explicit authorized work and dependencies. Neither scope should be confused with the other.

Preserve the audit's dependency-first direction, adjusted to current evidence and approvals:

| Stage | Intended outcome | Important guardrail |
|---|---|---|
| Baseline and containment | Reconcile all 44, expose regressions, establish reliable evidence; propose focused containment of data loss, unsafe inputs/permissions and incomplete reports. | Documentation-only authorization does not permit application edits. Containment is not proof of durable end-to-end behavior. |
| Shared command/authority/evidence contracts | Original identity and quote, durable journal/receipts, classified errors, authorization, money/stock/point invariants. | A04's fixed device does not remove original attribution; A11 is not just order uniqueness. |
| One complete reliable sale path | Durable capture, restart/retry, original receipt, canonical effects, accurate stock/shift/report projection. | Exercise online and offline behavior and Backoffice-managed recovery, not the obsolete routine outlet-switching journey. |
| Inventory and shifts | Product/ingredient transition consistency, shared stock history, live/backdated counts, all approved offline inventory workflows and concurrent close/write handling. | Count-row locking alone, an XLSX parser alone or a successful preview is not completion. |
| Returns, payouts, exchange, void and recovery | Implement the approved workflows using verified primitives and explicit physical money/goods states. | Do not silently convert paid facts into provisional intent, invent approval requirements, or auto-repeat uncertain cash payouts. |
| Optional loyalty/customer corrections | Approved configuration, lots/expiry, redemption authorization, conservation, historical ownership and merge/correction races. | Keep disabled when that is the approved staged boundary; disabled is not fixed. Guest-sale support is not optional loyalty work. |
| Release qualification | Exact-commit CI, real database/device checks, signed artifact/OTA compatibility, recovery/restore, operational limits and deployment evidence. | No release clearance from historical test counts or this handoff. Provider changes and live operations need their own authority. |

Reporting completeness (A26), refund/net arithmetic (A27), business-time semantics (A28), general validation/permissions, dependency/security checks and P2/P3 coverage must not disappear behind A04/A14 or be casually deferred past an affected live pilot. The original eight P0 groups must be explicitly accounted for before a real-money pilot of their affected workflows; applicable P1 requirements also remain release gates. Any narrower feature release needs an explicit, enforceable scope and justified deferrals, not hidden omissions.

The next implementation proposal should name exact finding IDs, intended observable result, dependencies, files/migrations, non-goals and tests. It should not be “implement all 44 in one pass,” and it should not present “implement A04/A14 only” as the complete audit programme.

## 7. ChatGPT ↔ Codex for every finding

Apply `CHATGPT_CODEX_WORKFLOW.md` across the complete programme:

**Codex inspects and supplies evidence → ChatGPT analyzes/reviews → the owner approves any required policy/scope/risk decisions → Codex executes authorized scope and verifies → ChatGPT reviews the returned evidence.**

Codex handles routine engineering independently within approved scope and should recommend options rather than act as a typist. Consequential unresolved financial, inventory, authority, recovery, design or release choices go back with evidence before the dependent behavior is changed. Read available local source/approved decisions first; do not ask ChatGPT to guess facts Codex can verify locally.

Every outbound packet identifies the relevant A-IDs and tests. Include the objective/authorization, root/worktree/commit/dirty state, inspected evidence, exact question, alternatives/tradeoffs, Codex recommendation, blocked work and safe independent work. Use the existing packet templates; they are not exclusive to A04/A14.

At each milestone include a compact delta against the full tracker: findings changed and supporting evidence, newly identified issues, outstanding P0 dispositions, other release-relevant blockers, approved deferrals and next slice. Do not regenerate 44 full descriptions at every small handoff, but do not let untouched findings vanish.

This is the previously selected user-relayed loop. Saving a local Markdown file does not mean this chat received it. Supply its content/attachment and necessary sanitized evidence, or an accessible committed reference. No automatic agent bridge, background monitoring, repository write or delivery is established by this packet.

## 8. Evidence and completion rules

The baseline is the earlier uploaded `mandalika-pos.rar` with critical GitHub comparisons at `prod-hardening@4691c781842f0114acaf2e4371e0d11f0076f553`. That is **not** a fresh check of the currently active local branch or all nested files. This consolidation reread the documents and assembled existing evidence; it did not inspect a current Codex workspace or run application tests.

The original evidence records nine isolated Node diagnostics and an isolated existing pure-Go subset. Full backend testing was blocked, and full TypeScript, database concurrency, real Android durability, production builds, provider telemetry and restore qualification were not executed in that audit environment. Preserve the detailed limits from the report and verification summary.

D01–D09 are reproductions of the old defective behavior, not success criteria after a repair. Convert them into tests of corrected invariants; a diagnostic expecting a defect should not remain green as evidence that the defect is fixed. T01–T34, T04a–T04e, T11a–T11n and I01–I23 are proposed acceptance references, not claims of execution.

Closure requires the relevant behavior and evidence, not merely a document section, test file, code change, passing helper tests or successful import. Mark evidence by environment and scope. Preserve failed/blocked/skipped tests. Production release remains a separate explicit decision tied to the tested artifact and operational evidence.

## 9. Immediate documentation/design deliverables and completeness check

For the immediate adoption task, Codex should return:

1. The actual worktree/branch/commit and relevant uncommitted state, current document/instruction locations and any material differences from the old baseline.
2. A documentation/design diff and one full 44-entry traceability tracker (or updates to the existing tracker), preserving the original audit and later user clarifications.
3. Explicit disposition of the original eight P0 groups and applicable P1/P2/P3 work, with no unsupported fixed/verified/approved labels.
4. A dependency-aware sequence and the smallest next implementation slice, plus consolidated consequential questions for ChatGPT and clearly identified owner decisions.

Before calling this documentation milestone complete, check that A01–A44 are all present; the eight original P0 IDs match section 1; the report/addendum have actually been read; A04's scenario and A14's expanded reconciliation are applied narrowly; A31 and A39 remain tracked where applicable; all test references retain their scope and evidence status; and no newer approved work was reset or overwritten. Unknown current behavior is acceptable when labeled with the evidence still needed; fabricated certainty is not.

This milestone does not require re-approval of every ordinary engineering detail or re-review of the whole codebase before any later bounded fix. Implementation can proceed under actual existing or subsequently granted scope once its dependencies/decisions are clear.

## 10. Message for the existing Codex session

```text
Continue in the current worktree and session. Do not reset, clean, switch
branches, or discard local changes to match an older audit snapshot.

Read MASTER_AUDIT_HANDOFF.md as the entry point for the complete readiness
audit: A01–A44, including all eight original P0 groups and every P1/P2/P3
finding. Read AUDIT_REPORT.md and PLAN_ADDENDUM.md in full, alongside the
three later A04/A14/workflow documents and the latest local plan, draft,
applicable instructions, approvals and durable handoff.

The A04/A14 files are targeted refinements, not the whole backlog. Apply
CHATGPT_CODEX_WORKFLOW.md to the entire audit. Use this broader adoption
instruction instead of its earlier A04/A14-focused bootstrap prompt.

For this turn, make documentation/design/workflow changes only. Reuse one
canonical tracker and preserve local work and settled decisions. Give all
44 IDs an explicit current disposition, plan mapping, decision authority,
dependencies, proposed implementation slice and acceptance/evidence links.
Do not copy historical pass/fail or open/fixed states as current evidence.

Reconcile A04 with fixed device/outlet access and Backoffice recovery;
retain original attribution/authorization. Expand A14 for live/backdated
counts and the Backoffice template without dropping replay, late-event,
movement-history, projection or concurrency requirements. Do not silently
close unrelated findings because these two received further discussion.

Return the documentation diff, complete tracker, original P0 dispositions,
consequential questions for ChatGPT with evidence/options/recommendations,
and the smallest next implementation slice with required tests.
Identify policy decisions needing the owner. Do not invent questions that
are already answered in current approved documents.

After a slice is authorized, implement and verify routine details yourself.
Escalate material unresolved decisions or conflicting evidence before
changing dependent behavior. Keep the rest of the audit tracked. This
setup is not blanket approval to implement all 44, deploy, alter credentials,
change infrastructure or mutate live data.
```

## 11. Packet provenance

`PACKET_MANIFEST.json` records hashes and origins of the enclosed files. The originals are copied byte-for-byte from the supplied conversation artifacts and audit bundle. Hash validation establishes package integrity only, not application correctness or approval of the historical findings.

The five supporting narrative documents remain unchanged so their provenance and the difference between original findings and later clarifications stay visible. In this sentence, “five” means `AUDIT_REPORT.md`, `PLAN_ADDENDUM.md`, the two A04/A14 documents and `CHATGPT_CODEX_WORKFLOW.md`. The master is the new top-level instruction; a future authorized documentation reconciliation should update canonical local wording with explicit history rather than blindly overwriting it.
