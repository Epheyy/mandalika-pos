# Mandalika POS — Context Handoff

**Created:** 2026-08-21 (Asia/Jakarta)
**Purpose:** Continue the repository audit and stabilization-planning task on another device without relying on the original chat history.
**Current workspace at handoff:** `C:\Users\PC\Downloads\mandalika-pos`
**Application code changed in this task:** No.

## 1. Start here on the new device

1. Clone `https://github.com/Epheyy/mandalika-pos.git`.
2. Fetch all remote branches.
3. Open this file and the repository `AGENTS.md` instructions supplied to the new task.
4. Treat `origin/prod-hardening`, not `main`, as the stabilization target.
5. Do not implement application changes yet. Resume at the pending design-approval checkpoint in section 9.

Suggested continuation prompt:

> Read `CONTEXT_HANDOFF.md` completely, then verify every branch/commit/test fact against the current repository before relying on it. Follow the supplied AGENTS.md workrules. Continue the Mandalika POS stabilization design from the pending approval checkpoint. Do not touch application code until the design and implementation plan are reviewed and approved.

## 2. Git and repository state at handoff

Verified immediately before creating this file:

- Current local branch: `main`.
- Current `main` commit: `af00d87b22e73a362890ba63fce190f386de78c0` (`ci: drop nondeterministic cap:assets step`).
- Before this document was added, `main` matched `origin/main` and the working tree was clean.
- Remote: `https://github.com/Epheyy/mandalika-pos.git`.
- Remote stabilization branch: `origin/prod-hardening`.
- Observed `origin/prod-hardening` commit: `4691c781842f0114acaf2e4371e0d11f0076f553`.
- Only `main` existed as a local branch in this workspace.
- Only the primary worktree existed.

Important: `main` is the legacy client-only prototype. `prod-hardening` is a materially different, much more mature monorepo. Do not produce a stabilization plan for `prod-hardening` from the `main` source tree.

## 3. User objective and locked operating requirements

The user wants a stabilization plan first, with review checkpoints before implementation.

Locked requirements:

- Backend direction: Cloud Run API.
- Current phase: prototype/testing on `prod-hardening` using free-tier services such as Neon and Upstash.
- Goal: a stable free-tier testing baseline that stays within safe quotas, while keeping the architecture launch-ready so production does not require a redesign.
- Scale: 25+ outlets and growing.
- POS deployment: one operational POS device per outlet.
- Back-office users: approximately 5–10.
- Transaction volume across all outlets combined:
  - about 400 transactions on low-traffic days;
  - 1,500+ transactions on peak days.
- Required outage tolerance: up to 60 minutes.
- Required offline workflows:
  - sales;
  - refunds;
  - stock transfer creation/sending and receiving;
  - goods receiving;
  - stock counts.
- Offline sales are completed locally and later synchronized.
- Refunds and inventory-sensitive operations may be captured as pending/provisional offline and finalized by the server after reconnect.
- A sale acknowledged to the cashier must survive app crash, forced close, device reboot, and battery loss without cashier re-entry.
- There is no fixed rollout date. The project may take months or a year; progression should be gated by evidence and thresholds rather than dates.

## 4. Approved high-level strategy

The user approved a progressive two-gate hardening strategy:

### Gate A — Free-tier-safe testing baseline

Purpose: make testing safe and observable while remaining inside defined free-tier budgets.

Core outcomes:

- eliminate acknowledged-sale loss and silent transaction deletion;
- introduce genuinely durable device persistence;
- correct request and Redis-command amplification;
- add missing TypeScript and money-path CI coverage;
- monitor provider quotas and data growth;
- make dependency failures degradable where correctness permits;
- support the required 60-minute offline workflows.

### Gate B — Launch-ready production gate

Purpose: prove operational readiness and activate paid services only when reliability or measured capacity requires them.

Core outcomes:

- tested backup and restore procedures;
- production alerting and incident runbooks;
- load, concurrency, reconnect-storm, and conflict tests;
- credential rotation and production release gates;
- safe schema migration procedure;
- explicit provider upgrade triggers;
- removal of debug/test release settings;
- launch approval based on measured thresholds, not a target date.

## 5. Architecture observed on `prod-hardening`

Read-only inspection found a monorepo with:

- Go HTTP API deployed to Cloud Run in Jakarta (`asia-southeast2`);
- Neon pooled Postgres over TLS;
- Upstash Redis;
- Cloudflare Pages for the back-office frontend;
- Capacitor/Android POS application;
- a shared TypeScript API package;
- a shared offline sync package;
- Capgo-style OTA bundles stored in Google Cloud Storage;
- database migrations and a broader automated-test suite than `main`.

Cloud Run was documented/configured with `min-instances=0`, port 8080, production validation, and Redis/Neon secrets. The server currently runs database migrations during application startup.

Repository test inventory observed during the audit:

- approximately 25 Go test files;
- approximately 16 TypeScript test files;
- 3 GitHub Actions workflows.

These counts are a handoff snapshot, not a guarantee. Recount them on the new device because `prod-hardening` can move.

## 6. Critical technical findings to preserve

### Device durability does not yet meet the acknowledged-sale requirement

The sync storage abstraction uses a synchronous in-memory mirror with Capacitor Preferences writes performed asynchronously and fire-and-forget. Storage exceptions are swallowed. Consequently, the UI can proceed while the native persistence operation is incomplete or has failed.

Required direction: an awaitable native SQLite transaction must commit the complete sale before the UI reports success or permits receipt printing.

### Current outbox can turn transient failures into dead letters

The outbox has `MAX_ATTEMPTS = 5`. Whole-batch failures, including transient network errors, increment attempts for all pending items. Dead-lettered items can be discarded after logging. A UI guard was added previously, but the underlying ability to remove an unrecorded financial event remains incompatible with the new zero-re-entry requirement.

Required direction: network failures retry indefinitely with bounded exponential backoff and jitter. Financial events are never deleted through ordinary POS operation. Deterministic rejections go to a durable, visible quarantine/resolution flow.

### API requests have no client timeout

The shared API client uses `fetch` without an abort timeout. A blackholed connection can freeze sync or UI operations.

### Current POS polling exceeds free-tier assumptions

`SyncEngine.start()` defaults to a 20-second interval and invokes:

- outbox flush;
- sync-version check;
- inbound-transfer poll.

Across 25 devices, three calls every 20 seconds generate approximately:

- 3.24 million requests/month at 8 operating hours/day;
- 4.86 million requests/month at 12 operating hours/day;

before sales and back-office traffic.

Cloud Run request-based billing includes two million free requests/month. The current polling pattern is therefore not a safe free-tier baseline.

### Global Redis rate limiting amplifies every API request

The server applies a Redis-backed global per-IP rate limiter to all API traffic. Each request performs at least one Redis `INCR`; the first request in a window also performs `EXPIRE`. Read caching and authentication add further commands.

Upstash Free currently allows 500,000 commands/month. The existing polling plus global limiter exceeds that allowance rapidly.

Required direction: remove Redis from the correctness path and from routine authenticated global request counting. Keep distributed limiting where justified, such as login and public OTA endpoints, and measure all remaining Redis commands.

### Offline workflow coverage is incomplete

Observed outbox types include:

- order;
- refund;
- shift open/close;
- cash flow;
- customer create;
- transfer receive.

The requested complete offline stock-transfer, goods-receiving, and stock-count workflows are not all represented. Do not assume these requirements are implemented.

### Server/operations risks requiring re-verification

- Database migrations run automatically during server startup without an observed advisory migration lock.
- The pgx pool has lifetime/idle/health settings but no observed explicit maximum connection count.
- Redis connection failure aborts server startup even though most cache behavior is described as degradable.
- Refresh-session state is Redis-backed, increasing operational dependence on Upstash.
- Coarse cache invalidation scans the `rd:` prefix after writes.
- A prior audit noted malformed JSON handling, raw/incorrect HTTP error taxonomy, server-side authorization/PIN issues, debug production flags, and dependency concerns. Re-audit the current branch rather than assuming every older finding is still open.

## 7. Proposed reliability architecture — pending user approval

This section was presented to the user but was interrupted by the device-migration discussion before explicit approval. Treat it as a proposal, not a locked decision.

Proposed invariants:

1. Cloud Run is the only remote API/write boundary.
2. Neon is the canonical ledger for sales, payments, inventory movements, refunds, promotions, loyalty, transfers, counts, and audit history.
3. Upstash contains no financial truth and is optional for transactional correctness.
4. The POS uses an append-only native SQLite journal.
5. A complete sale is acknowledged only after an awaited and verified local SQLite commit.
6. Every operation has a stable device-scoped idempotency key.
7. Synchronization is at-least-once; the API returns the original canonical result for duplicates.
8. The API applies each accepted business operation atomically in Neon, including its idempotency receipt and audit record.
9. A receipted offline sale is ingested as a historical business fact. Reference-data drift or token expiry can create an audit exception but must not erase the sale.
10. Refunds, transfers, receiving, and stock counts remain visibly provisional until server validation.
11. Unsynchronized financial events cannot be discarded from the ordinary UI.
12. Dependency failures are isolated: Neon/API outages invoke offline operation; Redis/Sentry failures must not corrupt or lose sales.

Pending approval question to ask the user:

> Does this reliability architecture match your intended business behavior, especially the distinction between completed offline sales and provisional refunds/inventory operations?

## 8. Current provider limits and planning implications

Limits were checked on official provider pages on 2026-08-21. Re-verify before finalizing the plan because pricing and quotas change.

### Neon Free

- 100 CU-hours/month per project.
- 0.5 GB storage per project.
- autosuspend after five minutes of inactivity.
- six-hour restore history, limited by change volume.
- 5 GB/month public network transfer was documented separately.

Implication: suitable for controlled testing only. At 25 outlets, storage growth, compute wake time, and restore requirements need alerts and explicit upgrade thresholds. Production should not be called launch-ready while relying only on a six-hour restore window.

Official source: <https://neon.com/pricing>

### Upstash Redis Free

- 256 MB data.
- 500,000 commands/month.
- 10 GB bandwidth/month.
- no production SLA/multi-zone HA/encryption-at-rest package on Free.

Implication: current global request limiting is incompatible with the free quota. Upstash must be minimized and measured. A budget-capped pay-as-you-go or fixed/production tier is a later threshold decision, not an unplanned surprise.

Official source: <https://upstash.com/pricing/redis>

### Cloud Run request-based billing

- two million requests/month in the free tier;
- 180,000 vCPU-seconds/month;
- 360,000 GiB-seconds/month;
- Jakarta is supported, but free discounts are calculated from Tier 1 pricing and network egress can still be billable.

Implication: `min-instances=0` is appropriate for Gate A, but polling must be reduced. Gate B should decide whether paid warm capacity is justified by measured cold-start and availability requirements.

Official source: <https://cloud.google.com/run/pricing>

### Cloudflare Pages Free

- 500 builds/month;
- one concurrent build;
- 20-minute build timeout;
- 20,000 files/site;
- 25 MiB maximum individual asset size.

Implication: static back-office hosting has comfortable headroom if Pages Functions are not introduced accidentally.

Official source: <https://developers.cloudflare.com/pages/platform/limits/>

### Other free-tier observations

- Google Secret Manager: six active secret versions and 10,000 access operations/month free.
- Artifact Registry: 0.5 GiB-month storage free across the billing account.
- Cloud Storage Always Free applies only in selected US regions, not a Jakarta bucket; OTA storage/egress should be budgeted even if the absolute cost is small.
- Sentry Developer: one user, 5,000 errors, 5 GB logs, 5 million spans, 50 replays, and one uptime monitor based on the observed pricing page.

Official sources:

- <https://cloud.google.com/secret-manager/pricing>
- <https://cloud.google.com/artifact-registry/pricing>
- <https://cloud.google.com/storage/pricing>
- <https://sentry.io/pricing/>

## 9. Exact continuation sequence

The next task should proceed in this order:

1. Verify `origin/prod-hardening` has not moved since commit `4691c781`.
2. Create an isolated local worktree/branch from the current `origin/prod-hardening`; do not replace or reset unrelated user work.
3. Recount tests and compare current code with the older June stabilization audit so resolved findings are not repeated.
4. Ask the pending reliability-architecture approval question from section 7.
5. After approval, present the quota/capacity-budget design section, including explicit warning/action/upgrade thresholds.
6. Present and approve the offline conflict/reconciliation section.
7. Present and approve security, release, observability, backup/restore, and incident-operation sections.
8. Write the approved design to `docs/superpowers/specs/YYYY-MM-DD-mandalika-stabilization-design.md` on the `prod-hardening`-based worktree.
9. Review the design document for contradictions and unresolved assumptions.
10. Obtain user review of the design.
11. Only then write the granular TDD implementation plan to `docs/superpowers/plans/YYYY-MM-DD-mandalika-stabilization.md`.
12. Do not implement the plan until the user separately authorizes implementation.

## 10. Process rules supplied by the user

The user supplied these working rules for every task:

1. Always ask; never assume.
2. Flag uncertainty.
3. Think deeply.
4. Write a context handoff at every achieved milestone.
5. Flag conflicts.
6. Log failures and check facts before suggesting.
7. Show changes.
8. Admit gaps.
9. Route Sol to review/planning, Luna to implementation, and Terra to small tasks that introduce new logic.

The planning workflow also used the Superpowers brainstorming and writing-plans disciplines:

- architecture questions are asked one at a time;
- alternatives and tradeoffs precede selection;
- the design is approved section by section;
- the design specification is written before the implementation plan;
- implementation planning identifies exact files, granular tests, verification, and review checkpoints.

## 11. Failure log and uncertainties

Failures during read-only analysis:

- Three initially guessed POS source paths under `apps/pos/src/lib/...` did not exist. The correct shared paths were under `packages/sync/src` and `packages/api/src`. No files changed.
- One PowerShell manual-read command lost Windows path backslashes through string escaping. The corrected literal path worked. No repository data changed.
- The first staged Markdown verification found trailing-space hard breaks and an extra blank line at EOF. Formatting was corrected before commit.

Known uncertainties/gaps:

- No full current test run was executed from `prod-hardening` in this workspace because the worktree stayed on `main` and the user requested analysis/planning before changes.
- Provider quotas can change and must be rechecked before implementation or deployment.
- Exact daily operating hours, average order-line count, payload sizes, current Neon database size, Upstash command telemetry, Cloud Run request latency, and OTA artifact growth were not measured.
- The current production-readiness state of backups, restore tests, alert policies, budgets, Android signing, and secret rotation still needs evidence.
- Desktop-to-desktop Codex handoff was unavailable because `Control other devices` had not reached this account/app rollout. This document is the supported manual continuation artifact; the repository itself remains the source of truth.

## 12. Completion definition for the planning task

The stabilization-planning milestone is complete only when:

- all design sections are explicitly approved;
- the design spec is saved on a `prod-hardening`-based branch;
- the implementation plan names exact files and tests;
- Gate A and Gate B each have measurable entry/exit criteria;
- quota thresholds identify warning, action, and upgrade points;
- offline sales and provisional inventory workflows have documented state machines and conflict policy;
- backup/restore, observability, security, and release gates have testable acceptance criteria;
- remaining assumptions and user-owned decisions are clearly listed.
