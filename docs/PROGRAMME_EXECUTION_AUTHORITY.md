# Mandalika POS — standing programme execution authority

Record ID: AUTH-MANDALIKA-20260919-01  
Recorded: 2026-09-19  
Source: the owner's direct message in the ChatGPT review conversation accompanying S0B-20260919-01.  
Scope: the entire Mandalika POS A01–A44 audit programme, its phases, required dependencies, verification and release work. This is an authority record, not a second implementation tracker.

## 1. Exact owner instruction

> here's codex results, and instead of you kept asking me to authorize something. yes i fully authorized everything everyphases so basically full access.

The owner has removed the requirement for repeated per-slice/per-phase execution approval. Treat this as standing programme authorization, not merely permission to propose S0c. Preserve the distinction between what the owner actually said and the operational interpretation below.

## 2. Operational effect

Proceed through all programme phases in bounded, dependency-aware, evidence-producing milestones without asking the owner to authorize each next phase, routine technical choice, file edit, test, or necessary development operation again. This includes S0c and later work; authority does not expire when a milestone review packet is produced.

Within this project and its established requirements, the grant covers repository investigation, implementation, refactoring, documentation, appropriate dependency/toolchain installation and upgrades, generation/build/test work, disposable test infrastructure, migration development and rehearsal, and normal project Git work. It also covers the programme's operational/release phases when the intended targets, access, budget constraints and verification conditions are established. Do not silently redefine the owner's broad grant as “documentation only” or “S0c only.”

Use proportionate safeguards for the operation rather than repeated generic authorization questions. Obtain packages through verified supported sources, preserve lockfiles and provenance, avoid unrelated global changes, keep test data synthetic or properly sanitized, and identify temporary resources for cleanup. Do not use a live database as a substitute for a disposable test database. An installation being technically allowed does not make every package or install script trustworthy.

Normal Git work may include scoped commits and publishing to the intended existing private repository under its established workflow. Preserve unrelated dirty/untracked work; do not stage everything indiscriminately or include review archives, credentials, or unrelated files by accident. Inspect branch/CI/deployment triggers before pushing: a push that deploys is subject to the release conditions, not merely a harmless backup. Do not rewrite shared history or discard other work as an implementation shortcut.

For deployment, live migrations and credential/provider changes: establish the exact existing project target and purpose, exercise staging/rehearsal where applicable, satisfy the relevant release gates, verify backup/recovery and compatibility where relevant, and prepare a bounded rollout/rollback. Standing authority is already granted; missing target, budget, recovery evidence or policy is the blocker—not a need to ask “do I authorize the phase?” again. Unspecified new paid commitments, unrelated destinations, destructive actions with unknown impact, or contradictory business requirements require concrete clarification rather than guessed consent. Do not use “full access” as a waiver of failed checks or acceptance of unknowable outcomes.

## 3. What this supersedes

For future programme work, this supersedes the *permission limits* in older handoffs such as “S0a only,” “S0b only,” “documentation-only,” “no further application slice authorized,” and routine “no install/migration/commit/push” restrictions attached to those earlier individual tasks. Those passages remain accurate historical records of their own runs; do not rewrite the old evidence or claim that past work had broader authority.

Retain their underlying correctness/security invariants and the approved business policies. A previous restriction that exists for an independent policy, external platform rule, known production hazard, or a specific unresolved decision must be reconciled on its merits rather than automatically discarded as boilerplate.

Full access has not answered mutually exclusive product-policy options, supplied unknown factual inputs, granted another person's account permissions, or changed Codex's actual runtime configuration. Respect real tool, organization and platform controls; do not bypass them or claim they have been changed by a Markdown file.

## 4. Collaboration and decision handling

ChatGPT remains the analysis/design/review partner; Codex remains the repository-aware investigator, implementer and verifier. This remains a user-relayed workflow. A local file is not automatically delivered to ChatGPT; do not invent a review or owner reply.

Codex should independently decide routine and well-supported engineering details within the approved requirements. Escalate a consequential technical ambiguity to ChatGPT with code evidence, options and a recommendation, not with an empty request for permission. Search the current decisions first. Batch related questions and continue independent authorized work when safe.

Ask the owner only for something genuinely missing that cannot be learned from project evidence or reasonably resolved as an engineering choice: an actual business fact, a conflict in intended policy, a new loss/exposure tradeoff, an unspecified spending commitment, or critical target/access information. State the exact question and consequence. Do not convert these into a new routine phase-approval ceremony. Preserve known policies while those specific choices remain unresolved; reversible scaffolding may proceed without implementing a guessed policy.

A milestone review is an evidence/quality checkpoint, not an expiry of execution authority. Fix ordinary review corrections under this standing grant. Continue clearly specified independent work when appropriate; changes dependent on a requested substantive design answer should wait for that answer. Report a compact milestone before producing an unreviewably large cross-domain rewrite.

## 5. Programme and release gates remain real

Maintain one canonical A01–A44 tracker. Distinguish proposed, implemented, locally verified, reviewed within stated evidence, and released. Preserve the original eight P0 groups and record any justified reassessment explicitly. A subtask's acceptance is not automatic closure of its parent finding, linked tests or release gate.

The standing grant does not by itself verify historical authority, durable native storage, database races, backups, budgets or a production artifact. Failures and unavailable tests stay visible. Provision an isolated test environment where appropriate under the grant instead of repeatedly treating “no test setup was authorized” as a permanent obstacle. Never substitute invented test results or unsafe live testing.

## 6. Persist once; do not create a paperwork loop

Adopt this record at `docs/PROGRAMME_EXECUTION_AUTHORITY.md` or the existing authoritative decision-record location. Keep one source of current authority and reference it from the existing collaboration workflow and applicable project instructions. Reuse existing conventions. Update only active summaries that would otherwise incorrectly block continuation; preserve historical packets and original approvals.

Suggested concise instruction entry:

```markdown
Standing authority: follow `docs/PROGRAMME_EXECUTION_AUTHORITY.md`
(AUTH-MANDALIKA-20260919-01) for the full A01–A44 programme. Do not ask
for repeated phase/slice execution approval. Apply the ChatGPT review /
Codex execution workflow; escalate genuine unresolved decisions with evidence.
Preserve business invariants, local work and release verification gates.
```

Integrate these small documentation changes alongside the next implementation milestone. Do not stop after updating the authorization wording or create a separate documentation-only round trip merely to acknowledge the grant.
