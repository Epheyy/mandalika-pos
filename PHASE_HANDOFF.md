# Mandalika POS Re-platform — Phase Handoff

Per-phase session guide. Run **one new session per phase**. Authoritative plan:
`.claude/plans/so-this-entire-thing-mellow-lake.md` (read it first each session).

Tell each new session verbatim:
> continue Phase <X> per .claude/plans/so-this-entire-thing-mellow-lake.md and PHASE_HANDOFF.md; prior phases complete.

---

## Resume Context (global)

- Migration: Firebase → Go + PostgreSQL + Redis, OpenAPI-first, two native apps
  (POS offline-first via Capacitor, Backoffice web), JWT email/password auth,
  multi-outlet, conflict-free append-only sync + Backoffice sync wall.
- React frontend kept; Cloudinary kept (hardened to signed uploads).
- GateGuard disabled for this repo via `.claude/settings.local.json` env (persists).
- Backend lives in `backend/` (Go 1.26). Host machine owns Postgres :5432 →
  **container remapped to :5433**.
- `pnpm` not installed yet — `corepack enable` in Phase B.
- Status: **Phase A COMPLETE** (compiles, smoke-tested). Phases B–F pending.

### Phase status (tasks created this session)
| Task | Phase | Status |
|------|-------|--------|
| #1 | A — Monorepo + Go backend foundation | DONE |
| #2 | B — Read APIs + client seam + app scaffolds | PENDING |
| #3 | C — Writes + order tx + offline core + Cashier split | PENDING |
| #4 | D — Migrate remaining backoffice screens | PENDING |
| #5 | E — Native shell + Bluetooth printing | PENDING |
| #6 | F — Data migration + cutover | PENDING |

---

## Start-of-Session Commands (every phase B+)

```bash
cd backend
docker compose up -d            # Postgres :5433, Redis :6379
export DATABASE_URL="postgres://mandalika:mandalika@localhost:5433/mandalika_pos?sslmode=disable"
export REDIS_URL="redis://localhost:6379/0"
export SEED_ADMIN_PASSWORD=devpass123
go run ./cmd/seed               # idempotent: migrates + ensures admin
go run ./cmd/server             # http://localhost:8080
# verify:
curl localhost:8080/healthz
curl -X POST localhost:8080/api/v1/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"admin@mandalika.local","password":"devpass123"}'
```
End of session: `docker compose stop`; kill stray `go run ./cmd/server`.

---

## Phase A — Foundation  ✅ DONE

Built: full schema (`backend/internal/db/migrations/0001_init.sql`, multi-outlet +
sync/idempotency tables), argon2id+JWT auth (login/refresh/logout/me, rotation,
Redis revocation, rate-limit), RBAC + `X-Outlet-Id` middleware, pgx pool, embedded
migrator, Redis cache, JSON envelope, chi router, seed CLI, `api/openapi.yaml`
skeleton, docker-compose, README. Verified end-to-end.

---

## Phase B — Read APIs + client seam + app scaffolds

Scope:
1. OpenAPI codegen pipeline: `oapi-codegen` → Go DTOs+chi stubs; `openapi-typescript`
   → `packages/api` TS client. CI gate fails on handler/spec drift.
2. GET endpoints (outlet-scoped) for all resources: products(+variants),
   categories, bundles, customers, loyalty-conditions, promotions, discount-codes,
   outlets, users, custom-roles, orders (keyset pagination), shifts, stock-counts,
   settings/app, settings/loyalty; `GET /reports/summary?range=` server aggregation.
3. Redis read-cache per-outlet (TTL 10–30s) + invalidate-on-write hooks (writes land C).
4. Users CRUD + admin provisioning (replace 501 stub at `server.go` `/auth/register`).
5. Monorepo: `corepack enable`; pnpm workspaces — `apps/pos`, `apps/backoffice`,
   `packages/{types,api,sync}`. Move React `src/` → two apps. Shared `packages/types`
   from `src/types/index.ts`.
6. Auth Context per app (replace prop-drilled `appUser`), role-gated login (POS
   rejects non-cashier, Backoffice rejects cashier).
7. Exit criterion: one screen runs read-only against Go end-to-end.

Open follow-ups → C: writes still on Firebase (strangler); cache invalidation stubs.

---

## Phase C — Writes + order tx + offline core + Cashier split

Scope:
1. Full CRUD write endpoints; Redis cache invalidation on write.
2. `POST /api/v1/orders`: ONE Postgres tx — server computes subtotal/discount/
   promo/tax/rounding/loyalty, `SELECT FOR UPDATE` stock decrement, customer +
   promo-usage update. `Idempotency-Key` required (Redis + `processed_keys`).
   Server assigns `order_number`. Refund + restore. Shift close reconciliation.
   Port logic from `CashierScreen.tsx` (plan §9 line map) — golden-value parity.
3. `packages/sync`: Capacitor SQLite local store; durable outbox
   (`device_id:order_uuid` idempotency key, survives restart); sync engine
   (ordered, one in-flight) → `POST /sync/batch`; server reconciliation summary.
4. Sync wall (§5a): `content_version`/`data_manifest`; `GET /sync/version`,
   `GET /sync/pull?since=`; Backoffice writes bump version; POS blocks NEW sale
   until Resync, never blocks outbox flush.
5. Split `CashierScreen.tsx` (3471 lines) per plan §7a → orchestrator + 8
   components + hooks + reducer in `apps/pos`. Migrate `SettingsScreen`.
6. Signed Cloudinary: `POST /uploads/sign` (Go signs, secret server-only);
   rewrite `uploadImage()`.
7. Outlet switcher for multi-outlet users; stop hardcoded `outletId:'default'`.

Open follow-ups → D: backoffice screens still on Firebase.

---

## Phase D — Migrate remaining backoffice screens

Scope: migrate/split each backoffice screen to `packages/api` (Customers,
Products, Promotions, Orders, Users, StockCount, Outlets, Dashboard, Reports);
replace `onSnapshot` with `usePolledQuery`; enforce outlet scoping per screen;
decompose >800-line screens. Drop `firebase` dep from `package.json`; delete
`src/firebase.ts` + `src/lib/seedData.ts`. Exit: zero Firebase imports remain.

Open follow-ups → E: app still browser-only.

---

## Phase E — Native shell + Bluetooth printing

Scope: Capacitor iOS+Android builds for `apps/pos` (no-refresh shell, splash/
icon, secure token storage). Confirm printer model/device with user. BLE ESC/POS
via `@capacitor-community/bluetooth-le`; `printer/escpos.ts` builds buffer from
order + `app_settings.receipt`; wire `receipt.autoPrint`/`copies` post-order
(incl. offline-queued). Keep HTML preview fallback. Store-listing prep.

Open follow-ups → F: still dual-write Firebase + Go.

---

## Phase F — Data migration + cutover

Scope: Firestore export → Postgres migration script (collection→table map per
plan §2). Staging dry-run; per-collection row-count parity; spot-check orders/
shift totals. Offline-sync soak test. Decommission Firebase project. Remove
Firebase env vars.

Exit: production on Go/Postgres; Firebase off.

---

## Verification per phase (plan §11)

Backend: `go test ./...` (+ `-race`), testcontainers PG+Redis, golden pricing
parity, oversell concurrency, idempotency dup-safety, RBAC, multi-outlet
isolation. Frontend: `pnpm -r build` + `tsc -b` per app; Playwright checkout E2E
(C), offline E2E + sync-wall E2E (C), native build (E). `gofmt`/`go vet` clean.
