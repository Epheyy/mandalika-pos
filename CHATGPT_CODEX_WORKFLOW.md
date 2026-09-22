# ChatGPT–Codex two-way review and execution workflow

Date: 2026-09-19  
Version: 1.2 — standing programme authority integrated after CG-S0B-20260919-01-R2  
Project application: Mandalika POS, across the audit and implementation work—not only A04/A14.  
Status: active collaboration contract. The owner's standing grant below supplies execution authority; this workflow does not independently pass quality/release gates or decide missing business policy.

## Current execution authority — AUTH-MANDALIKA-20260919-01

Follow [PROGRAMME_EXECUTION_AUTHORITY.md](docs/PROGRAMME_EXECUTION_AUTHORITY.md)
for standing full-programme execution authority. Routine implementation, phase,
test and necessary engineering operations do not need repeated approval.
Historical scoped restrictions below describe their original handoffs; they do
not revoke the later standing grant. Business decisions, consequential escalation
and environment/release safeguards remain in force. Milestone review does not
expire authority or automatically pass a release gate.

## 1. Purpose and relationship to the existing handoffs

The user wants ChatGPT for analysis, design clarification, diagnosis, and review, with Codex as the repository-aware executor. Codex must also be able to package questions, conflicting evidence, and consequential decisions for ChatGPT rather than silently inventing business rules.

The existing `A04_A14_DESIGN_CLARIFICATION.md` already states this role split and asks for a return handoff. `A14_BACKOFFICE_TEMPLATE_SPEC.md` asks for current-worktree reconciliation, a documentation/design diff, and evidence. This document adds the explicit escalation triggers, outbound question format, return decision format, and execution checkpoints.

It supplements those documents. It does not replace their business requirements, resolve their open policy questions, or turn proposed mechanics into approved decisions. Future feature handoffs should reference this shared workflow rather than copying it and creating divergent versions.

## 2. Responsibility and authority

| Participant | Responsibility | Boundary |
|---|---|---|
| User / project owner | Defines business intent; approves scope, policy, risk, spending, and release authority; relays the review packets in this workflow. | A request for analysis, a received file, or a ChatGPT recommendation is not blanket implementation or deployment approval. |
| ChatGPT | Analyzes the supplied evidence, challenges assumptions, recommends designs, resolves technical questions within approved constraints, and returns a focused execution/review contract. | Must distinguish facts from assumptions and recommendations from user approvals. Must not claim to have read unshared local edits or run tests it did not run. |
| Codex | Inspects the current repository; proposes grounded options; implements authorized scope; tests, diagnoses, integrates, and reports actual evidence. | Must not blindly implement a stale ChatGPT recommendation, invent a business policy, or treat an implementation convenience as owner approval. |

Codex remains an engineering agent, not a mechanical typist. It should resolve routine local implementation details and correct ordinary errors itself. ChatGPT is the escalation/review partner for consequential ambiguity, cross-cutting reasoning, and milestone assessment.

The selected integration root retains responsibility for the resulting code, tests, and acceptance evidence. A handoff does not transfer those responsibilities away from Codex or reset its prior failed-attempt history.

## 3. Continue the existing project, not a guessed copy

On adoption, and whenever a returned decision depends on changed source, Codex must inspect the active root/worktree, branch, HEAD, dirty state, applicable instruction files, and latest local plan/draft/decision record. A commit alone does not describe uncommitted changes.

Preserve local edits, established working agreements, approvals, and safety restrictions. Do not reset, clean, switch branches, replace an instruction file, or start a competing implementation merely to match an old ChatGPT snapshot. Reconcile conflicts explicitly. Current code is evidence of implemented behavior; it does not supersede the user's intended business rule merely because it is newer.

Keep portable collaboration preferences in the appropriate working agreements. Keep project business rules, architecture, deployment details, and decision records in the repository. Do not replace the user's global instructions with this project document.

## 4. The two-way loop

### File preflight for each relay

Amendment: CG-S0A-20260919-01-R1 §6 (2026-09-19). Each incoming relay lists
REQUIRED DOWNLOADS (prefer one small ZIP), extraction location, read-first file,
reply/parent packet IDs, mandatory dependencies and reference-only/already-present
files. Before dependent edits, confirm the actual readable reply path, IDs and
required dependencies. Resolve an obvious local path discrepancy once; report an
exact missing dependency once rather than repeatedly searching unrelated folders
or inferring contents from a filename. Receiving a file is not scope approval.

After full-audit adoption, read the current delta and relevant tracker/decision/
source sections; reopen wider history only for a material conflict or dependency.
Keep A01–A44 visible. Return the explicitly identified CURRENT packet path and ID
plus one scoped bundle containing exact diff, new/untracked content and relevant
evidence. Same-named historical packets are not interchangeable; preserve immutable
inputs instead of rebuilding old bundles. The owner relays files; no bridge or
model-setting change is implied. Existing authorization and safety rules continue.

### Execution loop

1. **Codex establishes the current facts.** Read the relevant source and decisions. Define the smallest useful next outcome and the scope actually authorized. When the current task is documentation-only, remain documentation-only.
2. **Codex executes clear, authorized work.** Make ordinary implementation choices, run permitted tests, and repair ordinary failures without asking ChatGPT about every function or command.
3. **Codex packages a question when an escalation trigger is met.** Pause the dependent change. Gather relevant evidence and plausible options; do not implement a guessed policy while awaiting a decision. Independent work may continue only within already-authorized scope and without depending on the disputed choice.
4. **The user brings that packet to ChatGPT.** Attach or paste the handoff and the necessary sanitized source/diff/evidence, or supply a specific accessible committed revision. Merely creating a local file does not establish that ChatGPT received it.
5. **ChatGPT returns a decision/review packet.** Answer each question by ID; explain the reasoning, preserve invariants, identify owner decisions, and define the next bounded outcome and acceptance criteria. Do not silently widen scope.
6. **The user returns the review packet to the same Codex session.** AUTH-MANDALIKA-20260919-01 already covers routine programme execution across phases. Seek a specific decision only for missing business policy, consequential exposure or external facts outside the established grant; do not request generic phase/slice approval.
7. **Codex reconciles, executes, verifies, and reports.** Check that the returned assumptions still match the worktree. Report contradictions before dependent implementation. Return evidence at the agreed milestone or sooner if a new material blocker appears.

This document defines a user-relayed collaboration loop. It does not install an automatic message bridge, launch background agents, or establish shared live context between this ChatGPT conversation and a local Codex session. Do not claim a question was delivered or a decision received without an actual transfer.

## 5. When Codex should send a question

Escalate before making a previously unresolved choice that materially changes one of the following:

- Business behavior: who may authorize an operation; stock-count backdating/closed-period policy; refund or payment treatment; operator identity; mandatory staff actions; customer treatment.
- Financial/inventory correctness, durability, authorization, idempotency, historical attribution, offline behavior, recovery, or cross-command reconciliation.
- A cross-cutting schema, public command/API contract, concurrency strategy, significant dependency/infrastructure choice, or migration approach not already covered by the approved design.
- An approved requirement contradicted by new repository evidence, an impractical design assumption, or a regression whose correct expected behavior is unclear.
- Additional scope, risky/destructive actions, live data, credentials, production changes, new external exposure/cost, or release authority.
- A meaningful diagnostic impasse after the applicable bounded investigation: record what was attempted and what new evidence is missing rather than repeating failed approaches indefinitely. Preserve any existing attempt budget; do not reset it at handoff.

Before escalating, look for an existing answer in the repository and prior approved decisions. Do not ask ChatGPT for facts Codex can obtain directly from its own source or permitted tests. Batch related consequential questions where useful, but put any decision blocking a correctness-sensitive action first.

Do not escalate ordinary naming, file placement following an established pattern, straightforward test fixtures, formatting, or a well-understood local fix within authorized behavior. Report meaningful local choices in the milestone summary without blocking on them.

A recommendation is welcome in an escalation. Label it as a recommendation with tradeoffs, not as an approved decision. A new broad dependency or architecture should not be introduced merely because a question is awaiting review.

## 6. Outbound packet: Codex to ChatGPT

Reuse the repository's current durable handoff if suitable; add these sections instead of maintaining competing status files. If no suitable file exists, a proposed location is `docs/HANDOFF_TO_CHATGPT.md`. Report its actual path. Preserve resolved decisions in the existing decision log/history; do not erase them when refreshing the current handoff.

Keep the main packet focused on the next outcome. Attach only relevant diffs, source extracts, and logs. Include dirty/untracked source needed to explain the question. Do not include secrets, keystores, credentials, customer data, or an entire transcript by default.

```markdown
# Codex → ChatGPT
Packet ID: <stable unique ID>
Kind: QUESTION / MILESTONE_REVIEW / BLOCKER
Created at: <timestamp and timezone>

## Objective and authority
Current objective / smallest next observable outcome:
Authorized scope and approval reference:
Explicit exclusions / operations not authorized:
Related finding, requirement, and acceptance-test IDs:

## Current repository evidence
Active root/worktree:
Branch and HEAD:
Working-tree changes relevant to this packet:
Relevant instruction/plan/decision files and versions:
Code locations or attached diff/source references:
Evidence supplied here vs. evidence still only available locally:

## Observed behavior
Expected behavior and its requirement source:
Actual behavior:
Evidence classification: reproduced / source-confirmed / inference / unverified
Commands run, working directory, exit status, key output, environment:
Tests not run and why:
Approaches attempted and their results:

## Decisions required
### Q-<ID> — <specific question>
Why this cannot safely be decided from existing approvals:
Relevant facts and constraints:
Option A — consequences and tradeoffs:
Option B — consequences and tradeoffs:
Codex recommendation and uncertainty:
What depends on the answer:
Does this require a user/business decision or technical clarification?

## Safe continuation and requested response
Work paused pending the answer:
Independent authorized work that remains safe, or none:
Exact response needed from ChatGPT:
Proposed next slice and acceptance evidence:
Attachments and known evidence gaps:
```

Options need not be artificially limited to two. An ordinary milestone without questions can omit the decision-options section and state that no policy/design choice is outstanding. Never fabricate a blocker to justify a handoff.

For Windows/local worktrees, paths identify Codex's workspace but are not attachments accessible to ChatGPT. Supply the required file content or an accessible reference, not only `C:\...` paths. A private GitHub link still needs its exact branch/commit and must contain the relevant changes; uncommitted files do not appear there automatically.

## 7. Return packet: ChatGPT to Codex

ChatGPT should answer the packet, not generate an unrelated redesign. Use this contract:

```markdown
# ChatGPT → Codex
In reply to packet:
Source baseline and supplied evidence reviewed:
Evidence not available / not independently verified:

## Answers by question ID
Q-<ID>:
Answer / recommended direction:
Reason and material tradeoffs:
Status: TECHNICAL_CLARIFICATION / RECOMMENDATION_PENDING_USER / NEEDS_EVIDENCE
Existing approval or constraint relied on:
User approval required, if any:

## Bounded next outcome
Observable result:
Included scope:
Explicit non-goals:
Invariants that must remain true:
Suggested implementation approach, subject to current repository reconciliation:
Required acceptance scenarios and expected results:
Stop/escalation conditions:

## Authorization and return evidence
Implementation authority: <existing explicit scope + source, or not supplied>
Policy / operational permissions not granted:
Return: relevant diff, exact test results, unresolved issues, and requirement status.
```

A technical clarification may be applied under an existing user-approved implementation scope when it stays within that scope. It is not necessary to make the user approve every local engineering detail. Conversely, label business-policy, scope, risk, and release choices that still require the user's decision. No assistant-generated approval label can substitute for authorization actually given by the user.

When ChatGPT lacks necessary evidence, request the smallest missing source/test artifact rather than guessing or asking for another complete repository archive.

## 8. Milestone evidence and durable decisions

Codex's return must distinguish **proposed**, **implemented**, **verified in a stated environment**, and **released**. A passing pure-function test is not a database concurrency test; an import preview is not proof that historical stock reconciliation works.

Report the relevant diff or commit plus dirty-state delta, changed behavior, exact commands/exit statuses, failures and skipped checks, remaining risks, and a practical demonstration of the intended outcome where available. Do not replace evidence with test counts or agent activity.

Record consequential decisions with stable IDs, their source, status, affected requirements/tests, and any superseded decision. Keep approved policy, proposed mechanics, and implementation evidence distinct. Do not re-ask resolved questions unless new evidence materially changes the decision; explain what changed when reopening one.

ChatGPT's review may request corrections or recommend that a milestone meets its acceptance criteria within the stated evidence limits. That is not automatic production approval. Codex must reconcile any review against the current worktree before acting.

## 9. Application to the current A04/A14 work

**A04:** preserve the user's fixed outlet/device account model and lack of routine POS logout/outlet switching. Clarify unresolved human-identity/shift/TL-approval interactions through a question packet rather than silently adding everyday login requirements or allowing a persistent TL account to impersonate fresh approval. Reference the latest local decisions before assuming the question is still open.

**A14:** preserve live-operation and delayed/backdated counts, the Backoffice-generated template direction, historical observation cutoffs, chronological reconciliation, and the original audit acceptance cases. Do not equate successful XLSX parsing with accurate stock correction.

**Example escalation, not a new policy:** if the latest local plan still leaves closed-period backdating unresolved, Codex should describe which records would be restated, present options and their impacts, and ask for the technical review plus the owner's policy decision. It must not invent a 30-day limit or silently reopen a closed financial period.

**Example independent work:** Codex may implement established literal-value validation and preview tests under standing programme authority while a separable period-policy question remains open, provided that work does not apply stock effects or encode the unresolved rule. The earlier documentation-only handoff is historical.

The workflow applies equally to other audit findings; it is not permission to address all 44 groups at once.

## 10. Persisting the instruction without replacing existing agreements

Suggested repository location: `docs/CHATGPT_CODEX_WORKFLOW.md`, adjusted to an existing convention where appropriate. Add a small reference in the applicable project instruction file, preserving its other content. OpenAI's AGENTS.md documentation describes startup instruction discovery and scoped precedence; do not assume an arbitrary Markdown document becomes active guidance merely because it is present [O1]. For the currently open session, explicitly ask Codex to read and apply the file now.

Suggested concise addition, after reconciling existing instructions:

```markdown
## ChatGPT review / Codex execution
Follow `docs/CHATGPT_CODEX_WORKFLOW.md` for two-way review and execution.
Codex owns repository inspection, authorized implementation, integration, and
verification. Resolve routine local engineering details independently. Before
making a consequential unresolved policy/design choice or changing approved
scope/invariants, pause the dependent work and produce a self-contained
question/evidence packet for the user to relay to ChatGPT. Include a grounded
recommendation. Reconcile returned guidance with current source and explicit
user approvals before execution. Preserve local work and existing safety gates.
Return milestone evidence; never equate a recommendation with owner approval.
```

If a relevant instruction file already names the same workflow, update it minimally rather than duplicating sections. Check applicable overrides; do not rewrite global settings or remove overrides to force adoption. The main protocol remains in the linked document so the instruction entry stays small.

### Message to give the active Codex session

```text
Continue in the current worktree and session. Read CHATGPT_CODEX_WORKFLOW.md
and reconcile it with your applicable instructions, latest local plan/draft,
and existing approvals. Preserve all local work and settled decisions.

Adopt the ChatGPT-analysis / Codex-execution loop. Persist the workflow in the
repository with a concise reference from the applicable project instructions;
do not replace my global working agreements or create duplicate handoff logs.
Read and apply the new workflow explicitly in this session.

For this turn, make documentation/workflow changes only. Reconcile the existing
A04/A14 clarification and Backoffice-template specification with current local
decisions. Return the exact files/diff plus a self-contained handoff for ChatGPT:
current root/branch/commit and relevant dirty state, confirmed/open decisions,
consequential questions with evidence/options/your recommendation, and the next
bounded implementation slice with its required tests. State when no decision
question remains; do not invent one.

After a slice is explicitly authorized, resolve routine implementation details
and verify independently. Escalate material conflicts or unresolved choices
before changing dependent behavior. Do not treat this workflow setup as approval
to implement the audit, deploy, alter credentials, or mutate live data.
```

## 11. Evidence and delivery boundary

This workflow was prepared in ChatGPT after reading the two supplied handoff documents. No current Codex workspace was inspected, no repository instruction file was edited, and no question packet was sent automatically to Codex. The user can adopt it through the message above. The existing feature documents remain unchanged.

Document references:
- `A04_A14_DESIGN_CLARIFICATION.md`, sections 1 and 8: role split, current-worktree reconciliation, return evidence, separate implementation authority.
- `A14_BACKOFFICE_TEMPLATE_SPEC.md`, section 9: documentation/design deliverable, conflict reporting, implementation slices and evidence boundary.
- [O1] OpenAI, “Custom instructions with AGENTS.md,” accessed 2026-09-19, official entry point: `https://developers.openai.com/codex/guides/agents-md/` (redirects to OpenAI's ChatGPT Learn documentation). This source supports instruction discovery, not the custom authority/workflow policy proposed here.
