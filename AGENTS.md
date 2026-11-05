# Mandalika POS — agent working guide

Offline-first POS (Capacitor Android tablets) + Backoffice (web) + Go backend, used as a
template for three perfume brands (Mandalika, Flamboyan, Performance Perfume).
Monorepo: `apps/pos`, `apps/backoffice`, `packages/{sync,printer,api,types}`, `backend/` (Go).
Current status: pre-launch, test data only, not production-ready.

## Workflow (Claude-only, since 2026-10-09)

The Codex-execute / ChatGPT-review relay is retired. Claude plans, implements, reviews
and verifies; the owner decides business policy, scope, risk and release. No review
packets, ZIP bundles or programme-authority ceremony. The relay-era packets and programme docs
were removed on 2026-11-05; read them with `git show 0fa804c9:<path>`.

### Working rules (every task)

1. **Ask, don't assume.** Clarify before guessing.
2. **Don't touch unrelated code.** Stay scoped.
3. **Flag uncertainty.** Say what is unsure.
4. **Verify on failure.** Investigate; never retry blindly or fake success.
5. **Show changes.** Surface diffs and what changed.
6. **Admit gaps.** State plainly what wasn't done or isn't known.

### Model routing (Claude 5 family)

Pick the reviewer by what the change **touches**, not by its size.

| Role | Model / effort | Used for |
|---|---|---|
| guardian | Fable 5.1, high | Only on explicit owner request: production migrations, security review, release go/no-go, problems Opus could not crack |
| planner / reviewer | Opus 5.5, high | Plans; review of anything touching SyncEngine, stock, offline outbox, optimistic updates, generated types, auth, payments, client-IP trust — even one-line diffs |
| implementer | Sonnet 5.5, medium | Writing code and tests |
| scout / chore | Haiku 5.5, low | Search, reading, summaries, copy/style/docs/config with no new logic |

- These roles exist as subagents in `.claude/agents/` with model and effort pinned; dispatch
  them by name.
- Opus re-derives any Haiku finding from source before accepting or dismissing it.
- Announce "tier + effort + one-line reason" before each delegated task.
- **End every reply with a short progress summary** from the `HANDOFF.md` "Progress board"
  (P0 status + what's next), and update the board whenever a slice moves (owner request).
- **Start every session by reading `HANDOFF.md`** (short, current state). Update it at each
  milestone and before context compaction. `SESSION_HANDOFF.md` is the old Codex-era log:
  read it by section only, never whole.
- Advisor (`/advisor`): recommended `advisorModel: opus`. Best value is a Sonnet 5.5 main
  session with the Opus advisor for implementation work; use an Opus main session for
  planning. Don't use a Fable advisor by default (bills usage credits). Ask for an advisor
  check before committing to an approach on risky surfaces.

## Audit backlog

The Sep 2026 Codex audit is kept as a **backlog, not a process**:

- Findings: `AUDIT_REPORT.md` (A01–A44). Status: `docs/AUDIT_COVERAGE_TRACKER.md`.
- Priority: the eight P0s (A01, A02, A03, A04, A06, A09, A11, A13) are unresolved and
  come first. A31 is the only resolved finding.
- A34 client-IP spoofing is **fixed** (2026-10-10, no load balancer). The A34 parent
  (CI enforcement) is still open. Client IP comes only from `internal/clientip`; never
  re-add chi `RealIP` (a test guards this). `TRUSTED_PROXY_HOPS` must equal the number of
  proxies in front: 1 for `*.run.app`. Adding a load balancer or custom domain means
  hops=2 **in the same change** that closes direct `run.app` ingress, never mixed.
- Audit evidence (`docs/A2*`–`docs/A34*`, the ingress packets) was removed on 2026-11-05; read it with
  `git show 0fa804c9:docs/<file>`. Don't regenerate it.

## Branches and deployment

- `prod-hardening` — the deploy branch (Cloudflare Pages backoffice auto-deploys on push;
  backend on Cloud Run; Neon Postgres; Android APK via `android-release.yml`).
- `audit/hosted-proof-20260922` — Codex audit work, **fast-forwarded into `prod-hardening`
  on 2026-10-10** after an Opus review. Work on `prod-hardening` (or short branches off it)
  from now on. Live backend and backoffice both run the merged code (see `HANDOFF.md`).
- APK builds use the code on **origin**: push before triggering a build.
- Commits that must not trigger a Cloudflare deploy start with `[CF-Pages-Skip]`.
- Deploys, APK builds, OTA releases and pushes to `prod-hardening` need the owner's go-ahead
  unless the owner has said otherwise for the current batch.

## Commands

```sh
corepack enable && corepack prepare pnpm@9.15.0 --activate
corepack pnpm quality:ci     # full JS/TS gate: tests, typecheck, builds, OpenAPI gen check
corepack pnpm gen:check      # OpenAPI TypeScript regeneration check
corepack pnpm browser:ci     # Chromium browser gate
make ota-release VERSION=x.y.z   # POS OTA bundle (web layer only; native changes need an APK)
```

Backend targets live in `backend/Makefile`. Any `package.json` change must ship with an
updated `pnpm-lock.yaml`, or the Cloudflare deploy breaks silently.

## Never

- Commit secrets, `.env` files, keystores, or review ZIP bundles.
- Auto-merge duplicate customers, or weaken a stock/sync/refund guard to make a test pass.
- Treat old deployment notes or handoff claims as current verification.
