# Mandalika POS — Technical Audit & Improvement Plan

**Audited:** 2026-06-10, branch `prod-hardening` · ~400 tracked files · Analysis only, no code modified.
**Method:** Four-phase audit (discovery → evidence-based findings → strategy → task plan), executed by five parallel review agents (backend architecture, security, frontend, testing/performance, deps/devex/docs) with manual spot-verification of the highest-impact claims (`wallRaised={false}` hardcode, swallowed decode on shift endpoints, PIN hashes shipped to devices, debug flags in the Capacitor release config — all confirmed).
**Depth note:** Core 20% reviewed deeply (order/refund/stock/sync/auth, the two repo god-files, sync engine, CashierScreen, CI/ops). Lighter review: backoffice ingredient/recipe/transfer screens, printer package internals, Android Gradle config, generated code (`api.gen.go`, `schema.d.ts` skipped by design).

---

## Executive Summary

**Overall health: B.** The hard parts of a POS — server-authoritative checkout in a single transaction with idempotency and row locks, an offline outbox with dead-lettering, argon2id + alg-pinned JWT auth with fail-fast prod config validation — are done unusually well for a project this size, and there are **zero hardcoded secrets and zero SQL injection findings**. What drags the grade down is the safety net, not the code: the 650-line order/refund money path has **no automated tests**, the entire TypeScript side (POS app, sync engine, backoffice) has **no CI at all**, and three deliberate "TEMP" debug switches (`webContentsDebuggingEnabled: true`, `loggingBehavior: 'debug'`, sync `debug: true`) are sitting in release-build configs. **Top 3 risks:** (1) a realistic *sale-loss path* — ~60s of server unreachability dead-letters pending sales and the cashier's one-tap "discard failed" escape hatch deletes them permanently; (2) approver PIN argon2id hashes are shipped to every POS device while lockout is client-side only, making 4-digit PINs offline-brute-forceable; (3) any TS regression — including in the sync engine that guards revenue — merges green because nothing runs lint/tsc/vitest. **Top 3 opportunities:** (1) a one-day CI + money-path-test milestone that converts the strongest code in the repo from "manually proven once" to "continuously proven"; (2) ~10 small fixes (fetch timeout, transient-vs-terminal retry classification, decode-error returns) that close every known data-corruption window; (3) a 30-line root README + doc-hierarchy fix that makes the excellent-but-buried documentation actually navigable. No Critical security findings; the architecture does not need restructuring before launch — it needs gates, tests, and the TEMP flags flipped.

---

## Repo Map

**Purpose:** Multi-outlet retail POS for perfume brands (Mandalika, template for Flamboyan + Performance Perfume): offline-first Android cashier app, web backoffice (inventory, recipes, CRM/loyalty), Go API. Pre-launch test deployment (Cloud Run + Neon Postgres + Upstash Redis + Cloudflare Pages), engineering target 50k–500k customers.

**Maturity:** Late pre-production. Real deployment pipeline, real device hardware (I-Ware C5813 printer), test data only.

**Stack:** Go 1.26 (chi, pgx/v5, golang-jwt/v5, go-redis) · TypeScript 5.9 / React 19 / Vite / Tailwind 4 · Capacitor 8 (Android) · pnpm workspace · OpenAPI-first (oapi-codegen → Go server interfaces; openapi-typescript → TS client types).

**Architecture sketch:**

```
apps/pos (Capacitor) ──┐  packages/sync (outbox/snapshot) ── offline-first
apps/backoffice (web) ─┤  packages/api (generated client)
                       ▼
        backend: chi router (server.go, permission-group middleware)
          ├─ handlers/ (HTTP, cache invalidation, idempotency)
          ├─ read/ (SQL→JSON DTO queries)   ├─ write/ (reference-data writes)
          ├─ service/ (order, pricing, loyalty — transactional core)
          ├─ sync/ (POS push/pull engine)   └─ auth/, middleware/, cache/, db/ (boot migrations)
                       ▼
        Neon Postgres (32 migrations) + Redis (cache, rate limit, idem keys)
```

**Key directories:** `backend/internal/service` — money path (best code in repo) · `backend/internal/read|write` — SQL repos (read side is a 1,760-line god-file) · `packages/sync` — offline engine (business-critical, well-designed) · `apps/pos/src/cashier` — cashier UI (901-line screen) · `docs/superpowers` — 25 dated spec/plan pairs (excellent decision record) · `RUNBOOK.md`, `SESSION_HANDOFF.md` — real ops knowledge.

**Surprises:** Root `README.md` is verbatim Vite boilerplate while the actual docs are excellent but scattered; `vercel.json` exists though hosting is Cloudflare Pages; the repo's *own* TEMP comments honestly flag every debug switch left on; near-perfect TS type hygiene (exactly one `any` in the whole workspace, zero `@ts-ignore`).

**Complexity hotspots (by size, generated files excluded):** `backend/internal/read/repo.go` 1,760 · `backend/internal/handlers/writes.go` 1,337 · `apps/pos/src/cashier/CashierScreen.tsx` 901 · `apps/backoffice/src/screens/Products.tsx` 867 · `apps/pos/src/cashier/ShiftRecapPanel.tsx` 857 · `backend/internal/write/repo.go` 789 · `apps/backoffice/src/screens/Customers.tsx` 699 · `packages/api/src/client.ts` 695 · `backend/internal/service/order.go` 650.

---

## Audit Report

Severity ordering within each dimension. **F** = verified fact, **J** = judgment.

### Correctness & data integrity (the ugly parts — utmost priority)

| # | Finding | Where | Consequence | Sev |
|---|---|---|---|---|
| C1 | Transient network failures count toward dead-lettering (`MAX_ATTEMPTS=5`, flush every 12s); the cashier-facing recovery button calls `discardFailed()` which **permanently deletes queued sales** (F) | `packages/sync/src/engine.ts:329-342`, `outbox.ts:33`, `apps/pos/src/cashier/CashierScreen.tsx:565-591` | ~1 min of server unreachability parks all pending sales as "failed"; one tap loses real revenue. The only realistic sale-loss path in the system | **High** |
| C2 | No timeout/AbortSignal on any `fetch`; engine sets `flushing=true` until the promise settles (F) | `packages/api/src/client.ts:316-348`, `engine.ts:271` | A blackholed socket on flaky Android Wi-Fi freezes all outbox flushing for minutes; pending sales pile up | **High** |
| C3 | Malformed JSON silently ignored on financial endpoints (`_ = httpx.DecodeLoose`) — verified | `backend/internal/handlers/writes.go:983` (OpenShift), `:1003` (CloseShift), `:1135` (CompleteStockCount) | A client bug closing a shift with bad JSON records `closingCash=0` — silent cash-reconciliation corruption instead of a 400 | **High** |
| C4 | All write errors (incl. pgx/connection failures) returned as **400 with raw `err.Error()`** (F) | `handlers/handlers.go:114-123`, `writes.go:47-67` | Retryable infra blips look like permanent validation failures to clients (this plausibly explains the known "Neon first-write 400" symptom); Postgres internals leak to devices | **Medium** |
| C5 | Outbox persistence failures swallowed (empty catch; fire-and-forget native write) (F) | `packages/sync/src/storage.ts:19-25, 96-99` | Enqueued sale can exist only in memory; app kill loses it with zero surfacing | **Medium** |
| C6 | `wallRaised={false}` hardcoded; the sync-wall blocking UI in Cart is dead code — verified | `apps/pos/src/cashier/CashierScreen.tsx:737`, `Cart.tsx:252-255` | POS sells on stale prices/promos indefinitely; reads as a forgotten toggle | **Medium** |
| C7 | Read-back errors ignored after successful mutations (`v, _ :=`); `caller()` always returns nil error (F) | `writes.go:994, 1010, 25-36` | 201 responses can carry zero-value shift objects on a DB blip, desyncing POS state | **Medium** |
| C8 | Promo-code rejection has six silent early-return paths — no toast/error (F) | `CashierScreen.tsx:369-383` | Cashier can't distinguish "invalid code" from frozen UI | **Medium** |
| C9 | Customer CSV export silently truncates at 10,000 rows vs 500k target; CSV import has no catch — mid-import failure leaves partial state with no message (F) | `Customers.tsx:135-149`, `Products.tsx:336-416`, `ImportExportBar.tsx:46-58` | Incomplete exports that look complete; un-diagnosable partial imports | **Medium** |
| C10 | Non-deterministic `FOR UPDATE` lock order in cart-item loop (F); deadlock surfaces as 400 via C4 (J) | `service/order.go:200-234` | Concurrent overlapping orders can deadlock; retry masks it but generates noise | **Low** |

Additional correctness notes:
- `JSON.parse(text)` runs before the `res.ok` check with no guard (`client.ts:362-367`) — a Cloudflare 502 HTML page throws `SyntaxError` instead of `ApiError(502)`, losing the status (F, Medium; interacts with C1's retry classification).
- Customer merge order in the POS picker prefers the stale snapshot over fresh server lookups (`CashierScreen.tsx:199-208`) — stale points display; server re-validates so cosmetic-to-minor (F/J, Low).

### Security

No Critical findings. No SQL injection (all dynamic SQL interpolates only placeholder indices — verified across `read/repo.go`, `write/repo.go`). No tracked secrets; keystore properly gitignored and never committed (verified via `git log --all`).

| # | Finding | Where | Consequence | Sev |
|---|---|---|---|---|
| S1 | Approver argon2id **PIN hashes shipped to every POS device** — verified (`receivePinHash` in payload, `read/repo.go:891`) — and PIN lockout is client-side only (KV-stored, reset by clearing app storage); no server-side attempt counter (F) | `read/repo.go:889-900`, `apps/pos/src/cashier/receive/PinStepUpModal.tsx:14-22, 54` | 4–8 digit PINs offline-brute-forceable by anyone with a register; "something you know" becomes an extractable secret. Server *does* re-verify PIN on the sync path (good) — the hash distribution is the flaw | **High** |
| S2 | Release APK ships `webContentsDebuggingEnabled: true` + `loggingBehavior: 'debug'` + sync `debug: true` — all self-flagged "TEMP, revert before true-final" — verified | `apps/pos/capacitor.config.ts:21, 25`, `SyncProvider.tsx:66-69` | Anyone with ADB/physical access inspects the WebView, reads tokens in memory/KV, watches API traffic | **High** (at go-live; deliberate for test phase) |
| S3 | `golang-jwt v5.2.1` — likely vulnerable to CVE-2025-30204 (memory-amplification DoS via malicious Bearer header), fixed v5.2.2 (J — verify advisory) | `backend/go.mod:9` | Unauthenticated DoS vector on the hot path of every request | **High** (pending verification) |
| S4 | Rate limiters fail **open** on Redis error, including the `/auth/login` strict limiter (F, deliberate per code comment) | `middleware/ratelimit.go:26-28`, `cache/cache.go:72-80` | Redis outage removes all credential-stuffing protection while login still works (Postgres only) | **Medium** |
| S5 | Cloudinary upload signatures unconstrained (only timestamp+folder signed; client-supplied folder passed through) (F) | `uploads/sign.go:32-59`, `writes.go:1239-1250` | Any `manage_products` holder can upload arbitrary file types anywhere in the Cloudinary account | **Medium** |
| S6 | No schema-level request validation (kin-openapi present but unused for validation; `DecodeLoose` + ad-hoc checks) (F) | `httpx/httpx.go:39-49` | Robustness gap, bounded by permission gating; root cause of C3 | **Medium** |
| S7 | Refresh-token reuse detected but family not revoked; access tokens not revocable (≤15 min TTL mitigates) (J) | `auth/handlers.go:98-101` | Stolen-token containment is partial | **Low** |

Minor: `AllowCredentials:true` in CORS is unnecessary (tokens in Authorization header, not cookies) — Low/optional. Refresh tokens in localStorage on web surfaces — standard SPA residual risk, mitigated by day-bound backoffice sessions. Dev fallback secrets (`dev-access`/`dev-refresh`) compiled into binary but blocked in prod by `config.Validate()` — Low.

**Security strengths:** argon2id with OWASP params + constant-time compare (`auth/password.go:14-63`); JWT alg-confusion defense (`jwt.go:62-82`); refresh rotation + reuse detection; **production config validation that refuses to boot on weak secrets/wildcard CORS/sslmode=disable** (`config/config.go:106-159`); distributed Redis rate limiting; outlet scoping enforced from JWT (`middleware/middleware.go:28-37`); zero `dangerouslySetInnerHTML`; server-side PIN re-verification on the offline receive path (`sync/sync.go:317-345`); per-route-group permission middleware with no unprotected mutating routes found (`server/server.go:79-282`).

### Testing

| # | Finding | Where | Sev |
|---|---|---|---|
| T1 | **Order create/refund — the money path — has zero automated tests** (F: no `order_test.go`; validated once via manual live e2e) | `service/order.go:82, :367` | **Critical** (as a gap) |
| T2 | **Zero TypeScript CI.** No workflow runs `pnpm lint`, `tsc`, or the 8 existing vitest suites; `packages/sync` has 4 test files but no `test` script (F) | `.github/workflows/` (absence) | **High** |
| T3 | No DB integration tests anywhere — ~2,500 lines of SQL across read/write/service verified only by manual poking (F: no test references pgxpool/testcontainers/sqlmock) | all repos | **High** |
| T4 | POS client pricing (`pricing.ts`, 172 lines) untested → silent drift risk vs the tested backend `service/pricing.go` (F gap / J risk) | `apps/pos/src/cashier/pricing.ts` | **High** |
| T5 | Auth, middleware, handlers (incl. the idempotency path `writes.go:919-946`) untested; "stock logic tests" cover only input validators, not stock arithmetic (F) | `internal/auth`, `write/stock_logic_test.go` | **Medium–High** |
| T6 | Zero component tests, zero E2E (no Playwright/Cypress config exists) (F) | `apps/*` | **Medium** (pre-launch) |

**Test inventory (F):** Go: 14 test files, ~1,082 lines (loyalty 280, pricing 127, fsmigrate 101, transfer-receive 91, plus validator/helper suites). TS: 8 test files, ~644 lines (engine receive-accepted 165, tanda-terima 82, scan 73, escpos 64+60, pendingCredits 49, lockout 33, pin 18). No concurrency tests anywhere — CI's `-race` flag has nothing concurrent to exercise.

**Coverage picture per area:** loyalty engine **well-covered** (16 tests incl. WIB midnight boundary) · backend pricing **partial-good** · order/refund **NONE** · stock arithmetic **NONE** (validators only) · transfers **partial** · sync engine **partial-good** (flush/retry/persistence paths untested) · POS pricing **NONE** · handlers/auth/middleware **NONE** · read queries **~NONE** · React components/E2E **NONE**.

**Testing strengths:** the pure-logic islands are genuinely well-tested — `loyalty_test.go` (winner/loser attribution, timezone regression guards), pricing, validators, scan-wedge edge cases. Go CI runs `-race`, gofmt gate, and an **OpenAPI codegen drift gate** (`make gen-check`) — unusual rigor.

### Performance (calibrated to the 50k–500k target; fine today)

| # | Finding | Where | Sev |
|---|---|---|---|
| P1 | Customer list/search: `count(*) OVER()` on every page + per-row correlated segment subquery; segment-*filtered* list runs the RFM predicate per candidate row pre-LIMIT (F pattern / J impact). Mitigant: pg_trgm GIN indexes in `0026_customer_scale_indexes.sql` do match the ILIKE patterns | `read/repo.go:643-705, 724` | **High @ scale** |
| P2 | Every write nukes the entire read cache via Redis SCAN (`DelByPrefix("rd:")`) — hit rate collapses exactly under load (F) | `handlers/handlers.go:47-51`, `cache/cache.go:48-63` | **Medium** |
| P3 | `MaxConns` unset on pgxpool (defaults ~4/CPU) vs Neon free-tier conn ceiling; no per-request context timeouts (server WriteTimeout 30s is the only backstop) (F) | `db/db.go:21-46`, `cmd/server/main.go:52-53` | **Medium** |
| P4 | Sync pull = full catalog (`limit=100000`) per device on every version bump; any global reference write bumps all outlets (F; deliberate atomic-snapshot design) | `sync/sync.go:94-122`, `write/repo.go:28-41` | **Medium** (the fleet-rollout scaling cliff) |
| P5 | Backoffice: no code splitting at all — `xlsx`, `recharts`, `jspdf`, `html-to-image` eagerly in the main bundle incl. login (F) | `Dashboard.tsx:14`, `csvUtils.ts:1`, `docs/render.ts:17-18` | **Medium** |
| P6 | CashierScreen re-renders every 2s forever (polling hook returns fresh array identities; memoized scan index defeated by per-render `.filter()`; `getInboundTransfers()` JSON.parses localStorage per render) (F) | `useOfflineData.ts:91-99`, `CashierScreen.tsx:189-208`, `engine.ts:386-388` | **Medium** |
| P7 | One open Customers tab ≈ 35 req/min (7 polled queries × 12s); no shared cache; no backoff/jitter on POS polling → thundering herd at fleet scale (F/J) | `Customers.tsx:64-109`, `SyncProvider.tsx:113` | **Medium** |

Lower-severity: OFFSET pagination everywhere (24 sites — locked project decision); `InventoryOverview`/`IngredientOverview` full-table pulls into Go maps (`read/repo.go:1346-1595`); migration runner has no `pg_advisory_lock` (concurrent cold-start crash-loop risk once min-instances > 1, `db/db.go:52-106`); `ErrorLogs.tsx:67` fetches limit 10000 in one request.

**Performance strengths:** no N+1 anywhere (single-statement JSON aggregation); indexes match query shapes; sync customer set properly bounded (90-day/1,000-cap `RecentCustomersForOutlet`, `sync.go:103`); Neon-aware pool tuning with documented rationale (`db/db.go:27-36`); visibility-gated polling.

### Architecture & code quality

- **A1 (Medium, F):** God files — `read/repo.go` 1,760 lines spanning ten domains; `handlers/writes.go` 1,337 lines — both violate the project's own 800-line rule, while `write/` already shows the correct per-domain seams.
- **A2 (Medium, F):** Stock-mutation SQL duplicated across `service/order.go:201-233`, `write/transfer.go:131-148`, `write/repo.go:182-210` — already diverged (sale path zero-floors, transfer path doesn't).
- **A3 (Low–Medium, F):** Cross-app duplication with visible drift: `uploadImage.ts`, `auth.tsx`, `Skeleton.tsx`, `api.ts` exist in both apps; backoffice `del()` lacks the catch that the Customers version has (`Products.tsx:300-304`).
- **A4 (Low, F):** `write.Repo.delete` concatenates the table name (`write/repo.go:741-749`) — all call sites are compile-time constants today (verified safe), but the pattern is one careless call site away from injection.
- **Strengths:** clean layering with no circular imports; constructor DI; `pendingCredits.ts` and `cashierReducer.ts` are exemplary pure/immutable state code; near-perfect type hygiene (one `any`, zero `@ts-ignore` across the workspace); trade-offs documented at the point of code (e.g. the accepted send-race comment in `transfer.go:244-250`).

### Dependencies, DevEx, Documentation

- **D1 (High, F):** Root README is stock Vite boilerplate — the project's front door describes a project that doesn't exist.
- **D2 (Medium→High at go-live, F):** Backups documented (`db-backup.sh` is robust — `set -euo pipefail`, `pg_restore -l` integrity check, 14-dump retention; restore drill executed per RUNBOOK.md:134-135) but **no scheduled workflow exists**; no metrics, no alerting, no configured uptime check — errors are findable, never pushed.
- **D3 (Medium, F):** No deploy automation (manual `gcloud run deploy`); no `packageManager` field in root package.json (pnpm drift risk; CI pins 9.15.0 via corepack).
- **D4 (Medium, F/J):** `xlsx@0.18.5` is npm-frozen with unfixed parse CVEs (CVE-2023-30533, CVE-2024-22363; currently export-only — low exposure, permanent npm-audit noise); `go-redis v9.7.0` possibly behind a response-ordering fix (~9.7.3, verify).
- **D5 (Medium, F):** Doc drift: RUNBOOK leads with Fly.io while reality is Cloud Run (+orphan `fly.toml`, orphan `vercel.json`); `backend/README.md` stale ("Phase A", wrong DB port 5432 vs compose's 5433 — `config.go:69` also defaults to 5432); both READMEs link a `.claude/plans/...` file that isn't tracked.
- Low: stray screenshots in repo root (`recipe-gold-tint.png`, `recipe-picker-redesigned.png`); `mandalika-release.jks` in root (correctly gitignored, never committed — residual `git add -f` risk); `.claude/settings.local.json` tracked; `atoi()` in config silently ignores malformed numeric env vars; Sentry reporter uses deprecated legacy `/store/` endpoint; duplicate `0005_` migration prefix (documented, do-not-rename); no GPL/AGPL in direct deps.
- **Strengths:** OpenAPI drift gate in CI; signed-APK pipeline with post-build `apksigner verify`; embedded idempotent boot migrations (fail-fast); distroless nonroot image; structured JSON request logging (`middleware/logging.go`); self-hosted POS client-error pipeline with a backoffice viewer (`errorReporter.ts` → `/error-logs` → ErrorLogs screen); single frozen lockfile with aligned versions (React/TS/vitest/Capacitor exact-pinned consistently); `SESSION_HANDOFF.md` + 25 dated spec/plan pairs form an exceptional decision record; `apps/pos/NATIVE.md` accurate and hardware-specific.

---

## Improvement Strategy

### Theme 1 — The money path is proven once, not continuously
T1, T3, T2, T4, C10. The transactional core is the best code in the repo, but its correctness rests on one manual live e2e. **Target state:** every commit re-proves order/refund/stock/idempotency against a real Postgres, and TS regressions cannot merge. **Principle:** test depth proportional to blast radius — money first, screens last. **Done when:** CI runs a Postgres-backed `order_test.go` suite + `pnpm lint/tsc/vitest` on every PR, and POS pricing has a mirror suite of the backend's.

### Theme 2 — Failure handling assumes failures are rare and terminal
C1–C5, C7, C8, S4, P3. The system distinguishes duplicate-vs-fresh meticulously but conflates transient-vs-terminal everywhere else (retry classification, decode swallows, 400-for-everything, fail-open limiter, no timeouts). **Target state:** transient errors retry indefinitely with backoff, terminal errors dead-letter, malformed input always 400s loudly, infra errors return 5xx. **Principle:** an offline-first POS's entire value is its behavior during failure. **Done when:** the sale-loss path is closed (only 4xx counts toward `MAX_ATTEMPTS`; `discardFailed` requires explicit confirmation showing order contents), all fetches time out, and zero `_ = Decode`/`v, _ :=` remain on money endpoints.

### Theme 3 — Known-unsafe launch toggles have no enforcement
S2, S1, S3, D2. The repo *knows* its gaps — "TEMP, revert before true-final" comments — but nothing enforces the revert. **Target state:** a release checklist enforced by CI/grep-gate, PIN verification server-side-only with durable lockout, deps patched. **Done when:** CI fails the android-release workflow if `webContentsDebuggingEnabled: true` or `loggingBehavior: 'debug'` is present; `receivePinHash` is gone from the API surface; jwt ≥5.2.2.

### Theme 4 — Scale-shaped debt is concentrated and known
P1–P7, P4. The backend was visibly designed with scale in mind (indexes, bounded sync); the remaining cliffs are enumerable: customer search, cache nuking, pool ceiling, full-snapshot pulls, unsplit bundle. **Target state:** each cliff has either a fix or a written "accepted until X devices/customers" decision. **Done when:** segment-filter and search EXPLAINs are bounded at a seeded 100k-customer dataset, cache invalidation is prefix-scoped per entity, `MaxConns` is set, and the snapshot-pull limit has a documented trigger for the delta-sync rework.

### Explicitly NOT fixing (effort vs payoff)
- **OFFSET pagination** — locked decision, humans rarely deep-page; only the `count(*) OVER()` cost is worth revisiting (folded into Theme 4).
- **God-file decomposition as a project** — split opportunistically when touching domains; a big-bang refactor of `read/repo.go` risks regressions in exactly the untested SQL Theme 1 must cover first. Sequence: tests → then split.
- **React Query/SWR migration in backoffice** — real improvement, but internal-tool polling at 35 req/min is tolerable; do it only if/when backoffice grows operators.
- **Metrics/OTel stack** — premature for a free-tier test env; an uptime check + Cloud Run alert policy gives 80% of the value (Milestone 2).
- **Component/E2E test suites** — defer until after launch; visual surfaces change too fast pre-launch to amortize.
- **80% blanket coverage** — intentionally subordinated to blast-radius-weighted coverage; chasing the number on UI code would starve the money-path work.

---

## Task Plan

### Milestone 0 — Safety net (before touching anything else)

| ID | Task | Files | Acceptance | Effort | Risk | Deps |
|---|---|---|---|---|---|---|
| M0.1 | **TypeScript CI workflow**: lint + `tsc -b` + vitest across workspace; add `test` script to `packages/sync`; add `packageManager` field | `.github/workflows/ts.yml`, root + sync `package.json` | PR with a type error or failing sync test goes red | **S** | None | — |
| M0.2 | **Postgres-backed integration tests for the money path**: CreateOrder (happy, idempotent replay, stock decrement, points), Refund (clawback, idempotency), OpenShift/CloseShift | new `service/order_test.go`, CI service container | `go test ./...` exercises real SQL in CI; the manual e2e scenarios from SP-CRM-8 are encoded | **L** | None (test-only) | — |
| M0.3 | **Scheduled DB backup workflow** running `db-backup.sh` daily, artifact off-host | `.github/workflows/backup.yml` | Dated dump artifact exists; restore drill re-run once from it | **S** | None | — |
| M0.4 | POS pricing vitest suite mirroring `pricing_test.go` cases | `apps/pos/src/cashier/pricing.test.ts` | Backend & client agree on every shared case | **M** | None | M0.1 |

### Milestone 1 — Critical correctness & security fixes

| ID | Task | Files | Acceptance | Effort | Risk | Deps |
|---|---|---|---|---|---|---|
| M1.1 | **Close the sale-loss path**: count only `ApiError` 4xx toward `attempts`; transient failures retry with backoff+jitter; `discardFailed` becomes per-item with confirmation showing order totals | `engine.ts:329-342`, `outbox.ts`, `CashierScreen.tsx:565-591` | Simulated 5-min outage: zero dead-letters, all sales land on recovery; new engine tests | **M** | Medium (core engine — M0.2/M0.4 first) | M0.1 |
| M1.2 | **AbortController timeout (~20s) in `request()` + refresh path** | `client.ts:316-348` | Hung socket test: flush resumes next tick | **S** | Low | — |
| M1.3 | **Stop swallowing decode errors on money endpoints**: `DecodeLoose` failures → 400; fix `v, _ :=` read-backs and dead `caller()` error | `writes.go:983,1003,1135,994,1010,25-36` | Malformed close-shift body returns 400, never `closingCash=0` | **S** | Low | — |
| M1.4 | **Server-side PIN security**: remove `receivePinHash` from API/OpenAPI; verify PIN via endpoint; durable Redis per-approver lockout | `read/repo.go:889-900`, `openapi.yaml`, `sync/sync.go`, `PinStepUpModal.tsx` | No hash in any client payload; 5 failures lock server-side across reinstalls | **M** | Medium (offline receive UX — see Open Q3) | — |
| M1.5 | **Dependency bumps**: golang-jwt ≥5.2.2 (verify CVE-2025-30204), go-redis ≥9.7.3, opportunistic chi/pgx/kin-openapi | `go.mod` | `go test ./...` green; advisories verified during work | **S** | Low | M0.2 |
| M1.6 | **Error taxonomy**: map infra errors to 502/503 with generic body (keep detail in logs/Sentry); raw `err.Error()` never reaches clients on 5xx | `handlers.go:114-123`, `writes.go:47-67` | Killed-DB test returns 503; client retry semantics correct; likely resolves the "Neon first-write 400" memory item | **M** | Medium (client status handling) | M1.1 |
| M1.7 | **Go-live gate in CI**: android-release fails on `webContentsDebuggingEnabled: true`, `loggingBehavior: 'debug'`, sync `debug: true` (flip to `import.meta.env.DEV` now) | `capacitor.config.ts`, `SyncProvider.tsx:66-69`, `android-release.yml` | Release build with any debug flag fails CI | **S** | None | — |

### Milestone 2 — High-leverage improvements

| ID | Task | Files | Acceptance | Effort | Risk | Deps |
|---|---|---|---|---|---|---|
| M2.1 | Root README rewrite + doc hierarchy (architecture sketch, run-all-three, authority order); fix `backend/README.md` port/phase; reconcile RUNBOOK to Cloud Run-first; delete or annotate `fly.toml`/`vercel.json` | docs | New dev reaches running stack from README alone | **M** | None | — |
| M2.2 | Scoped cache invalidation (per-entity prefixes `rd:orders:`, `rd:products:`…) replacing the global `rd:` nuke | `handlers.go:47-51`, `cache.go` | Order write no longer evicts product cache; hit rate measurable | **M** | Medium (stale-read bugs — needs M0.2) | M0.2 |
| M2.3 | Pool + timeout hardening: `MaxConns` explicit, per-request `context.WithTimeout` (~10s), sort cart items before lock loop (C10) | `db.go`, middleware, `order.go:200` | Verified under concurrent load test | **S** | Low | M0.2 |
| M2.4 | Customer search at scale: seed 100k synthetic customers; EXPLAIN segment-filter + lookup; decide capped-count (`count(*)` → `LEAST(5000, …)`) and materialized segment membership if needed | `read/repo.go:643-728` | p95 < 300ms on seeded dataset, or written accepted-limit decision | **M** | Low | M0.2 |
| M2.5 | Wire engine events to UI: replace 2s poll in `useOfflineData` with `onWall`/`onOutboxChange` subscriptions; fix memo defeats; resolve `wallRaised` (wire `offlineData.wall` or delete the dead prop) | `useOfflineData.ts`, `CashierScreen.tsx:189-208,737` | No interval-driven re-render; wall decision explicit | **M** | Medium (UI behavior) | M0.4 |
| M2.6 | Deploy automation: `workflow_dispatch` Cloud Run deploy with WIF; uptime check + Cloud Run 5xx alert policy | new workflow, RUNBOOK | Deploys traceable to commits; `/healthz` failure notifies | **M** | Low | — |
| M2.7 | Outbox persistence failure surfacing: await native KV writes, surface a persistent banner on failure | `storage.ts:19-25,96-99` | Forced quota error shows cashier-visible warning | **S** | Low | — |

### Milestone 3 — Quality & polish

| ID | Task | Effort | Notes |
|---|---|---|---|
| M3.1 | Promo-code rejection feedback (six silent paths → toasts) — `CashierScreen.tsx:369-383` | **S** | Quick win |
| M3.2 | Export pagination loop + import row-level error report (`Customers.tsx:135`, `Products.tsx:336`, `ImportExportBar.tsx:46`) | **M** | |
| M3.3 | Backoffice code splitting: `React.lazy` screens; dynamic-import xlsx/jspdf/recharts | **M** | Largest perf win per effort |
| M3.4 | Extract shared `uploadImage`/auth plumbing to `packages/`; consolidate stock-mutation SQL into one helper (A2); table-name allowlist in `write.Repo.delete` | **M** | |
| M3.5 | Opportunistic split of `read/repo.go`/`writes.go` by domain as files are touched | **L** (amortized) | After M0.2 only |
| M3.6 | Cloudinary signature scoping (`allowed_formats`, `max_file_size`, fixed folder); auth-limiter in-process fallback when Redis down; refresh-family revocation on reuse | **M** | S4/S5/S7 |
| M3.7 | Sync-pull delta path design doc (the P4 cliff) — decide trigger threshold (devices × catalog) | **M** | Design only for now |
| M3.8 | Repo hygiene: move stray root PNGs, untrack `.claude/settings.local.json`, fix `config.go:69` default port, Sentry `/envelope/` migration, migration `pg_advisory_lock` | **S** | |

### Quick wins (do immediately — all S, high impact)
1. **M1.7** — flip the three debug flags + CI grep gate (the repo already tells you to).
2. **M1.3** — un-swallow decode errors on shift/stock-count endpoints (3 lines each).
3. **M1.2** — fetch timeout.
4. **M0.1** — TS CI workflow.
5. **M0.3** — scheduled backup.
6. **M3.1** — promo-code feedback.
7. **M1.5** — `go get -u github.com/golang-jwt/jwt/v5` + verify.

### Implementation sketches — top 3

**M0.2 Money-path integration tests.** Add a `postgres:16` service container to `backend.yml`; gate DB tests behind `TEST_DATABASE_URL` (skip when unset so local pure-logic runs stay fast). Test harness: spin pool → run `database.Migrate` (reuses prod migration path — also regression-tests migrations) → seed minimal outlet/product/variant/customer via SQL fixtures. Cases: happy-path order (assert stock decrement, points ledger row, `processed_keys` row); idempotent replay (same key → same order id, no double decrement); refund (stock restore, points clawback, replay no-op); concurrent same-variant orders with `errgroup` (asserts the C10 lock behavior and gives `-race` real work). Gotchas: tests must create their own schema or truncate between cases (parallel `go test` packages share the DB — use one DB per package or serialize); WIB-timezone loyalty assertions need fixed clock injection — `service/loyalty.go` already takes evaluation time as a parameter, follow that seam.

**M1.1 Transient-vs-terminal retry split.** In `engine.ts` flush catch: `const terminal = err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429`. Only terminal increments `outbox.fail()`; transient marks reachability false and schedules retry with exponential backoff + jitter (cap ~5 min) instead of waiting for the fixed 12s tick — this also dissolves the POS thundering-herd issue (P7). Keep the existing per-item rejection path (server `'rejected'` acks) unchanged — that one is genuinely terminal. UI: `discardFailed()` → per-item discard with a confirm dialog rendering order ref + total from the dead-lettered payload; add "retry all failed" as the primary action, discard as destructive-styled secondary. Gotchas: the `JSON.parse` crash in `client.ts:362` currently converts HTML 502 pages into `SyntaxError`, which would be misclassified as terminal — fix the parse guard *in the same change* (`try { JSON.parse } catch { throw new ApiError(res.status, text.slice(0,200)) }`); M1.6's 400→503 server change shifts Neon blips into the transient bucket, so land M1.1 client logic first (it's status-driven and tolerates both server behaviors).

**M1.4 Server-side PIN.** Remove `receivePinHash` from the `ReceiveApprover` schema in `openapi.yaml`, regen (drift gate enforces both sides). Add `POST /receive-pin/verify {approverId, pin}` → existing `auth.VerifyPassword` + Redis `INCR pinfail:{approverId}` with TTL; ≥5 → 423 until expiry; this limiter should **fail closed** (unlike sales limiters) since it's a security gate. Keep client lockout UX as a fast local hint only. Gotcha: the current design verifies PINs *offline* (hash on device) — the receive flow per SP3 spec may legitimately need offline approval; if so, the fallback is queue-the-receive-unsigned + server re-verification on sync (which `sync/sync.go:317-345` already does — meaning the *online* verify endpoint is purely additive and the hash can still be dropped). Check `docs/superpowers/specs/2026-05-25-inventory-sp3-pos-receiving-pin-design.md` for whether offline-verify was a hard requirement before deleting the hash from the payload — this is Open Question 3.

---

## Open Questions

1. **Go-live date / gate:** Several severities flip from Medium to High at launch (backups, alerting, debug flags). Is there a target date, so M1.7/M0.3/M2.6 can be sequenced against it?
2. **Fleet size at launch:** How many POS devices initially? P4 (full-snapshot pulls) is fine at ~5 devices and a cliff at ~50; the answer decides whether M3.7 is a doc or a sprint.
3. **Offline receive-PIN requirement:** Was offline PIN verification (hash on device) a hard product requirement, or is online-verify-with-sync-fallback acceptable? Determines M1.4's shape.
4. **Backoffice operator count:** If it stays 1–3 internal users, the polling architecture and bundle size stay Milestone-3; if outlet managers get accounts, both move up.
5. **`vercel.json` and `fly.toml`:** Confirm both are dead so they can be deleted rather than annotated.
6. **xlsx roadmap:** Any planned "import spreadsheet" feature? That flips D4 from Medium noise to High (vulnerable parse path) and would justify switching to the SheetJS CDN build or `exceljs` now.
7. **Performance target:** Is there an explicit p95 latency goal for POS-facing endpoints to anchor M2.4's "done" (assumed <300ms on seeded 100k customers)?

---

**Bottom line:** This is a B-grade codebase with A-grade bones — the transactional core, auth, and offline design are better than most production POS systems at this stage. The work between here and launch-ready is not redesign; it is Milestone 0+1: roughly two weeks of tests, CI gates, failure-handling fixes, and flipping the switches the code already tells you to flip.
