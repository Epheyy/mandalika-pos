# Mandalika POS — Stabilization Re-audit Handoff

**Date:** 2026-08-25 (Asia/Jakarta)
**Branch:** `feat/mandalika-stabilization-design`
**Base:** `origin/prod-hardening@4691c781842f0114acaf2e4371e0d11f0076f553`
**Application code changed:** No

## Milestone reached

The durable handoff from `feat/context-handoff-migration` was read completely, the remote stabilization commit was reverified, an isolated sibling worktree was created, dependencies were prepared, baseline checks were run, and the June 2026 audit was compared with the current source. The user explicitly approved the reliability architecture on 2026-08-25. The next design section is the quota/capacity budget; implementation remains unauthorized.

## Locked operating requirements

- Cloud Run is the intended API boundary.
- Gate A must be a stable, quota-safe free-tier testing baseline; Gate B must be launch-ready without redesign.
- Fleet: 25+ outlets, one operational POS per outlet, 5–10 back-office users.
- Combined daily volume: about 400 transactions on low days and 1,500+ on peaks.
- Required outage tolerance: up to 60 minutes.
- Required offline workflows: sales, refunds, stock transfer/send and receive, goods receiving, and stock counts.
- A cashier-acknowledged sale must survive crash, force-close, reboot, and battery loss without re-entry.
- Offline sales are completed business facts; refunds and inventory-sensitive operations may remain provisional until server validation.
- Progress is evidence-gated, with no fixed launch date.

## Verified repository and workspace state

- `origin/prod-hardening` has not moved since the earlier handoff; it remains at `4691c781842f0114acaf2e4371e0d11f0076f553`.
- Planning worktree: `C:\Users\PC\Downloads\mandalika-pos-worktrees\stabilization-design`.
- Planning branch: `feat/mandalika-stabilization-design`, initially tracking `origin/prod-hardening`.
- Test inventory remains 25 Go test files, 16 TypeScript test files, and 3 GitHub Actions workflows.
- No application source was edited during setup or re-audit.

## Fresh baseline evidence

- JavaScript dependencies: `pnpm install --frozen-lockfile --ignore-scripts` passed with pnpm 11.19.0. The ignored `core-js@3.49.0` lifecycle script only prints a funding banner; the repository still lacks an explicit pnpm 11 allow/deny policy.
- TypeScript tests: 164 passed (POS 153, printer 7, backoffice 4).
- Package typechecks: `@mandalika/printer` and `@mandalika/sync` passed.
- Go: `go test ./...` passed when `GOTMPDIR` was placed under ignored `node_modules`; Windows Application Control blocks generated test executables launched from `%TEMP%` on this machine.
- Production frontend builds: backoffice and POS passed. Both emitted chunk-size warnings; POS also emitted an ineffective dynamic-import warning for Capacitor core.
- Lint baseline is red: 116 errors and 4 warnings across 29 files.
- Important limitation: current Go tests contain no Postgres-backed `CreateOrder`/`Refund`/idempotency integration suite. Current order tests are pure pricing, promotion, loyalty, and helper tests.

## June audit comparison

### Material progress since June

- POS pricing, promotion validation, stock helpers, reward/bundle behavior, and cashier reducer coverage now exist and pass.
- Go pure-logic coverage expanded materially across pricing, promotions, rewards, bundles, and OTA behavior.
- Refund capture is queued offline and described to the cashier as pending stock restoration.
- Transfer receiving has an offline outbox operation with optimistic local credit and server-side validation.
- Root onboarding documentation was expanded, although the root README and primary RUNBOOK remain stale.

### Critical or high-impact findings still open

1. Native persistence is still a synchronous in-memory mirror with fire-and-forget Capacitor Preferences writes. Storage errors are swallowed; acknowledged-sale durability is not proven.
2. Whole-batch network or HTTP failures increment attempts for every item. `MAX_ATTEMPTS=5` still parks items, and the ordinary UI can still permanently discard sale/refund events after saving a local diagnostic log.
3. API and refresh fetches still have no abort timeout. Response JSON is parsed before status handling without a parse guard.
4. Open/close shift still ignore malformed JSON; read-back errors remain ignored. Many infrastructure errors are still returned as raw 400 responses.
5. The sync wall remains hardcoded off in the cashier UI.
6. Approver PIN hashes are still shipped to POS devices and checked locally; client lockout remains extractable/resettable.
7. Android release/debug switches remain enabled: WebView debugging, debug logging, and sync debugging.
8. There is no TypeScript CI workflow. The sync package has five test files but no `test` script, so the recursive test command does not run them.
9. There is still no database integration suite for order creation, refunds, stock mutation, or durable idempotency.
10. POS sync still defaults to three operations every 20 seconds. The server still applies a Redis-backed global limiter to every request, starts only when Redis connects, and treats Redis as required by the deep health check.
11. Redis global limiting, auth/OTA limiting, refresh sessions, cache reads/writes, and coarse prefix scans remain command-amplifying. Upstash is not isolated from routine traffic.
12. Database migrations still run at process startup without an observed advisory lock, and pgx `MaxConns` remains unset.
13. Offline outbox operations still omit transfer creation/sending, goods receiving, and stock counts. Only `transfer_receive` is represented for the requested inventory workflows.
14. Root README remains Vite boilerplate; RUNBOOK still leads with Fly.io even though Cloud Run is the active direction. There is no scheduled backup/deploy workflow or observed alert configuration in the repository.
15. `golang-jwt` remains 5.2.1 and `go-redis` remains 9.7.0; advisory/version status must be reverified before dependency work.

## Architecture conflict to preserve

The June audit concluded that the architecture did not require restructuring before launch. That judgment predates the locked requirements for crash-proof acknowledged sales, 60-minute offline operation across multiple financial/inventory workflows, 25+ outlets, and explicit free-tier quota safety. Under the current requirements, native transactional SQLite journaling, idempotent operation envelopes, server-side reconciliation states, and reduced polling/Redis dependence are architectural requirements rather than optional cleanup.

## Approved reliability architecture

1. Cloud Run is the only remote API/write boundary.
2. Neon is the canonical ledger for sales, payments, inventory movements, refunds, promotions, loyalty, transfers, counts, and audit history.
3. Upstash contains no financial truth and is optional for transactional correctness.
4. Each POS uses an append-only native SQLite journal.
5. A complete sale is acknowledged only after an awaited and verified local SQLite transaction commits it.
6. Every operation has a stable device-scoped idempotency key.
7. Synchronization is at-least-once; duplicate submissions return the original canonical result.
8. Each accepted business operation, its idempotency receipt, stock/ledger effects, and audit record commit atomically in Neon.
9. A receipted offline sale is ingested as a historical business fact. Reference-data drift or expired authorization can raise an audit exception but cannot erase the sale.
10. Refunds, transfer/send and receive, goods receiving, and stock counts remain visibly provisional until server validation.
11. Unsynchronized financial events cannot be discarded through ordinary POS operation.
12. Neon/API outages invoke offline operation; Redis/Sentry failures must not corrupt, reject, or lose sales.

## Failure log from this milestone

- pnpm 11 initially exited nonzero because `core-js` had an unreviewed build script and automatically inserted a placeholder into `pnpm-workspace.yaml`. The placeholder was removed; no source/config change was retained.
- A project-local `.worktrees/` placement caused Vitest to discover the legacy checkout's parent `vite.config.ts`. The clean worktree was moved to an explicit sibling directory, eliminating ancestor-config contamination.
- Moving the worktree invalidated pnpm path links. A non-interactive reinstall first aborted its module purge; rerunning as a standalone CI-mode command rebuilt dependencies successfully.
- One combined shell command masked pnpm's nonzero result with a later successful status command. Subsequent verification commands were run standalone so exit codes were trustworthy.
- Windows Application Control blocked Go test executables under `%TEMP%`. A minimal reproduction passed with `GOTMPDIR` under ignored `node_modules`, and the full Go suite then passed.
- One `New-Item -LiteralPath` invocation failed because that parameter is unavailable for `New-Item` in this shell. It was corrected to an explicit `-Path`.
- Two read-only audit commands had PowerShell/parser or regex quoting errors. They were split into literal-path searches; no repository data changed.

## Exact next question

Ask the user for the typical daily powered-on/active hours per POS device. This is required to turn fleet polling and request budgets into measured monthly thresholds without assuming operating hours.

After that answer, present the quota/capacity design with warning, action, and upgrade thresholds.

Do not implement application changes.
