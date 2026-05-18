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
| #2 | B — Read APIs + client seam + app scaffolds | DONE |
| #3 | C — Writes + order tx + offline core + Cashier split | DONE |
| #4 | D — Migrate remaining backoffice screens | DONE |
| #5 | E — Native shell + Bluetooth printing | DONE |
| #6 | F — Data migration + cutover | DONE |

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

**Status: Phase B COMPLETE.** Delivered: full `api/openapi.yaml`; oapi-codegen
tool dep + `internal/api/api.gen.go` (DTOs+chi/strict); `internal/read` (outlet-
scoped repo via `json_build_object`, reports/summary aggregation);
`internal/handlers` (17 GET endpoints + Redis cache-aside, per-outlet TTL 15s,
degradable); users CRUD + admin `/auth/register` (501 replaced); `make
gen-check` drift gate + `.github/workflows/backend.yml`. pnpm workspaces:
`packages/{types,api,sync}`, `apps/{pos,backoffice}` (both `tsc -b`+`vite build`
clean). Auth Context per app, role-gated (POS=cashier only, Backoffice=admin/
manager). Backoffice `ProductsScreen` verified read-only vs live Go.
pnpm via `corepack pnpm@9.15.0` (corepack `enable` EPERM on this host).

Open follow-ups → C: all writes still on Firebase (strangler); legacy `src/`
untouched (Cashier split = C §7a, backoffice screens = D); Redis cache
invalidation hooks are no-ops until writes land (C); `packages/sync` is a stub;
POS tokens in localStorage until Phase E secure storage.

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

**Status: Phase C COMPLETE.** Backend: `service/pricing.go` (ports §9
verbatim, 11 golden-parity tests pass), `service/order.go` (`POST /orders`
one pg tx — server-computed totals, `SELECT FOR UPDATE` stock decrement
[online zero-floor / offline negative-flag], customer+promo-usage update,
per-outlet/day server order number; idempotent via Redis fast-path +
`processed_keys`), `service/shift.go` (open + server-reconciled close, cash
flow), order refund+restore (idempotent), `write/repo.go` (reference CRUD;
every mutation bumps per-outlet `content_version`+`data_manifest`),
`sync/sync.go` (`GET /sync/version`, `GET /sync/pull` atomic snapshot,
`POST /sync/batch` ordered idempotent outbox + reconciliation),
`uploads/sign.go` (server-signed Cloudinary). Routes RBAC-gated; Redis
read-cache invalidated on write. Migration `0002_phase_c.sql` (surcharge,
offline-reconcile audit, `order_counters`). `openapi.yaml` extended to the
full Phase C contract; `api.gen.go` regenerated & committed (CI `make
gen-check` green). Smoke-verified: order tx, idempotent replay exactly-once,
stock lock, refund+restore, `sync/batch` dup-safety, content-version bump.
Frontend: `packages/sync` (durable outbox keyed `device_id:order_uuid`,
read-only Snapshot, SyncEngine flush/wall/resync; localStorage KV with a
Capacitor-SQLite seam for E); `packages/api/schema.d.ts` regenerated;
`apps/pos` Cashier split per §7a (orchestrator + 9 components + 3 hooks +
reducer + display-only `pricing.ts` + SyncWall + OutletSwitcher + migrated
SettingsScreen + signed uploadImage). All files <800 lines; `apps/pos` +
`apps/backoffice` build clean (`tsc -b`+`vite`); no firebase/inline-fetch in
`apps/pos`. pnpm via `corepack pnpm@9.15.0` (corepack enable EPERM on host).

Open follow-ups → D: backoffice screens still on Firebase (Phase C added the
reference-CRUD + sync APIs and migrated the POS app only; Backoffice screens
migrate in D against the new CRUD endpoints). Provided but not yet
E2E-tested: Playwright checkout/offline/sync-wall E2E (plan §11 C items) —
add in D. `packages/sync` uses localStorage (Capacitor SQLite swap deferred
to E per plan). Backoffice-added customers/codes not in POS snapshot until
next resync (expected offline-first, §5a). Cashier client pricing is
display-only; server authoritative (smoke + service golden tests).

---

## Phase D — Migrate remaining backoffice screens

Scope: migrate/split each backoffice screen to `packages/api` (Customers,
Products, Promotions, Orders, Users, StockCount, Outlets, Dashboard, Reports);
replace `onSnapshot` with `usePolledQuery`; enforce outlet scoping per screen;
decompose >800-line screens. Drop `firebase` dep from `package.json`; delete
`src/firebase.ts` + `src/lib/seedData.ts`. Exit: zero Firebase imports remain.

**Status: Phase D COMPLETE.**

Backend (OpenAPI-first, mirrors Phase C patterns):
- `api/openapi.yaml` extended: `CustomRoleInput`, `StockCountCreateInput`,
  `StockCountUpdateInput`, `StockCountCompleteInput`; new paths
  `POST/PUT/DELETE /custom-roles` (+`/{id}`), `POST/PUT /stock-counts`,
  `POST /stock-counts/{id}/complete`. `api.gen.go` regenerated; **`make
  gen-check` verified NO DRIFT** (CI green).
- `internal/write/stockcount.go`: custom-role CRUD (global ref data → bumps
  `content_version`); stock-count create/update(start/cancel/save)/complete.
  Complete applies actual qty → product variant stock in ONE pg tx and bumps
  `products` content version (POS resync, §5a). Outlet-scoped, server-resolved
  (`scopedSC` → 404 cross-outlet). `internal/handlers/writes.go` +
  `server.go` routes: custom-roles under admin group, stock-count writes under
  `RequirePermission("manage_stock_count")`. `go build` + `go vet` clean.
- Request/response shapes: custom-role `{name,permissions[]}`→`{data:{id}}`/
  `{ok:true}`; stock-count create `{name,plannedDate,notes,items[]}` (outletId
  from JWT, NOT body)→`{data:{id}}`; update `{status?|items?|notes?}`→`{ok}`;
  complete `{items?}`→`{data:StockCount}`.

Frontend:
- `packages/api/src/client.ts`: full typed CRUD for every resource
  (products/categories/customers/promotions/discount-codes/outlets/users/
  custom-roles/stock-counts/loyalty + reports/uploads). `getOutletId`→
  `X-Outlet-Id`.
- `apps/backoffice`: Tailwind v4 wired (`@tailwindcss/vite` + `index.css`);
  deps added (lucide-react, recharts, date-fns, xlsx). New shared infra:
  `hooks/usePolledQuery.ts` (visibility-aware polling = `onSnapshot`
  replacement), `outlet.tsx` (`OutletProvider`/`useOutlet`/`OutletSwitcher`,
  admin cross-outlet), `lib/{brand,csvUtils,uploadImage(signed §8)}`, `api.ts`
  (+outletId), shell `App.tsx` (sidebar nav + permission/role gating + screen
  registry), `main.tsx` (Auth→Outlet→App).
- All 10 screens ported to `packages/api` + `usePolledQuery`, no Firebase:
  Dashboard, Products(+categories; bundles read-only — see follow-ups),
  Customers(+loyalty settings/conditions/history), Promotions(+discount
  codes), Orders(server refund), Reports, StockCount, Outlets, Users(+custom
  roles), SettingsScreen. Each <800 lines.
- Teardown: deleted legacy `src/` tree (incl. `firebase.ts`,
  `lib/seedData.ts`), root `index.html`/`vite.config.ts`/`tsconfig.app|node`;
  root `package.json` is now a pnpm workspace root (firebase + legacy app deps
  removed; `build`=`pnpm -r build`). **Zero Firebase imports remain**
  (`grep -r firebase apps packages` → none).
- Verify: `pnpm -r build` clean — `apps/backoffice` & `apps/pos` both
  `tsc -b`+`vite build` green; backend `go build`/`go vet`/`gen-check` green.

Open follow-ups → E:
- Bundle write API not in Phase B/C contract → Products "Bundle" tab is
  read-only with an in-UI notice. Add bundle CRUD endpoints + editor when
  needed.
- Legacy `syncLogs` cashier-sync log panel (old Outlets screen) dropped — no
  backend read API; revisit if required.
- Outlet has no DELETE endpoint (server.go only POST/PUT) → Outlets screen
  edits/toggles but cannot delete; matches backend surface.
- `pnpm lint` (root) reports `react-hooks` v7 strictness
  (`set-state-in-effect`/`exhaustive-deps`) in new infra hooks AND in
  pre-existing Phase C `apps/pos` (auth/SyncProvider/useShift/CashierScreen) —
  shared pattern, not a Phase D regression; `pnpm -r build` (the §11 gate) is
  clean. Tidy across pos+backoffice in a dedicated lint pass if desired.
- App still browser-only (native shell = E).

---

## Phase E — Native shell + Bluetooth printing

Scope: Capacitor iOS+Android builds for `apps/pos` (no-refresh shell, splash/
icon, secure token storage). Confirm printer model/device with user. BLE ESC/POS
via `@capacitor-community/bluetooth-le`; `printer/escpos.ts` builds buffer from
order + `app_settings.receipt`; wire `receipt.autoPrint`/`copies` post-order
(incl. offline-queued). Keep HTML preview fallback. Store-listing prep.

**Status: Phase E COMPLETE.** Printer confirmed with user: **I-Ware C5813**
(58 mm BLE ESC/POS, generic serial profile).

- Capacitor 8 wired into `apps/pos`: `@capacitor/{core,cli,android,ios,app,
  preferences,splash-screen,status-bar}@8.x` + `@capacitor-community/
  bluetooth-le@8.1.3` + `@capacitor/assets`. Typed `capacitor.config.ts`
  (appId `com.mandalika.pos`, `webDir: dist`, no `server.url` → bundled shell,
  cannot refresh to a browser; SplashScreen + BLE display strings).
- Android platform added (`apps/pos/android/`, all 5 plugins detected,
  `cap sync` clean). `AndroidManifest.xml`: API-31+ `BLUETOOTH_SCAN`
  (`neverForLocation`) + `BLUETOOTH_CONNECT`, legacy BT/location
  (`maxSdkVersion=30`), `bluetooth_le` feature required. `local.properties`
  git-ignored; `apps/pos/.gitignore` keeps native source, drops build/copied
  assets. iOS deferred (needs macOS — documented in `NATIVE.md`).
- New `@mandalika/printer` pkg (plan §6): `escpos.ts` (`buildReceipt` →
  ESC/POS bytes, 58 mm / 32 col, layout mirrors `ReceiptPreview`, honors
  `ReceiptSettings` toggles), `transport.ts` (`PrinterTransport` iface +
  `NoopTransport`), `ble.ts` (`CapacitorBleTransport` — auto-discovers first
  writable characteristic, prefers known vendor service UUIDs, chunked
  write-without-response), `print.ts` (`createTransport` native↔noop,
  `printReceipt` connect→copies 1–5→disconnect).
- Secure storage (plan §7): `@mandalika/sync` `initSecureKV()` swaps the KV
  seam to Capacitor Preferences on native (refresh token + outbox + device id
  + snapshot; localStorage on web), hydrated mirror keeps the sync KV
  interface; booted in `main.tsx` before React reads state. `auth.tsx` refresh
  token + `SyncProvider` engine now use `getKV()`.
- App glue: `native.ts` (StatusBar, Android back-button guard = minimize not
  exit mid-sale, splash hide on first-sync settle), `printer.tsx`
  (PrinterProvider — pair/reprint/test, paired id in secure KV). Cashier
  auto-prints on order success when `receipt.autoPrint` + paired (works on
  offline-queued orders — local BLE, sync-independent); `ReceiptPreview` adds
  "Cetak Ulang" + print-error line; `SettingsScreen` adds Bluetooth-printer
  pair/test/remove (HTML preview remains the no-hardware fallback).
- Store-listing prep: `STORE_LISTING.md` (id/desc/data-safety/permission
  rationale/release checklist), `NATIVE.md` (build/run), placeholder brand
  art in `assets/` + `gen-source.cjs`; `capacitor-assets generate` produced
  Android launcher/splash (74 assets).
- Verify: `pnpm -r build` green (`apps/backoffice` & `apps/pos`
  `tsc -b`+`vite`); `@mandalika/printer` + `@mandalika/sync` `tsc` clean;
  `cap add android` + `cap sync android` succeeded. pnpm via
  `corepack pnpm@9.15.0`.

Open follow-ups → F:
- Native device verification is a manual hardware step (real APK on a device,
  BLE pair + print on the I-Ware C5813, secure-storage persistence across
  reinstall) — code/config/permissions are in place; not run in this session
  (no device/CI; gradle `assembleDebug` not executed here).
- iOS platform not added (Windows host). On macOS: `cap add ios`, set
  `NSBluetoothAlwaysUsageDescription` (see `NATIVE.md`).
- Brand art is a placeholder ("M" indigo) — replace before store submission.
- BLE characteristic auto-discovery is generic; if the C5813 exposes multiple
  writable chars, pin its service/char UUID in `ble.ts KNOWN_SERVICES`.
- `INEFFECTIVE_DYNAMIC_IMPORT` vite warning (storage.ts dynamic-imports
  `@capacitor/core` to stay web-safe while native.ts imports it statically) —
  benign, no chunk split; left as-is.
- Still dual-write Firebase + Go (strangler) → resolved in F.

---

## Phase F — Data migration + cutover

Scope: Firestore export → Postgres migration script (collection→table map per
plan §2). Staging dry-run; per-collection row-count parity; spot-check orders/
shift totals. Offline-sync soak test. Decommission Firebase project. Remove
Firebase env vars.

Exit: production on Go/Postgres; Firebase off.

**Status: Phase F COMPLETE.** App code was already Firebase-free (Phase D);
Phase F delivers the data-cutover tooling + runbook.

- `backend/internal/fsmigrate` (`fsmigrate.go` loader/runner/report,
  `tables.go` per-collection upserts): Firestore JSON export → Postgres,
  collection→table map per plan §2 (18 collections incl. flattened
  `variants[]`/`items[]`/`permissions[]` child tables + `appSettings`/
  `loyaltySettings` singletons). Deterministic UUIDv5 ids (fixed namespace) so
  cross-doc FKs (`order.customerId`, `discountCode.promotionId`, …) resolve
  with no lookup table and the run is **idempotent** (`ON CONFLICT` upsert;
  children delete+reinsert per parent). Whole run is ONE pg tx; `--dry-run`
  rolls back so staging parity never mutates. Timestamp coercion handles
  RFC3339 / epoch / Firestore `{_seconds}`. Migrated users get an unusable
  password hash (Firebase was Google-popup, no passwords) — flagged in the
  report; admins re-provision.
- `backend/cmd/migrate-firestore` CLI (`--input`, `--dry-run`); `make
  migrate-fs[-dry] EXPORT=...`. Parity report = per-collection rows vs input
  (✓/⚠) + `SUM(orders.total)`/`SUM(shifts.total_sales)` spot-check (plan §11).
- `CUTOVER.md` runbook: `firebase-admin` dump script, staging dry-run + parity
  gate, offline-sync soak (plan §11, 5 checks), production cutover (freeze →
  drain outboxes → final export → apply → verify → user re-provision →
  monitor), Firebase decommission checklist + env/secret teardown.
- `fsmigrate` unit tests (id determinism/distinctness, FK-nil, num/timestamp/
  jsonb coercion, Load) — `go test ./internal/fsmigrate/...` green.
  `go build ./...`, `go vet`, `gofmt` clean.
- Final Firebase scrub: `.gitignore` comment de-Firebased + ignores cutover
  artifacts (`export.json`, `dump-firestore.mjs`, PII). `grep -ri firebase
  apps packages backend --include='*.ts' --include='*.go'` → none (only docs/
  historical migration comments remain).

Open follow-ups (operational, not code — require the live Firebase project):
- Real Firestore export, staging dry-run, parity numbers, offline soak, prod
  cutover, and project deletion are the §1–§5 manual ops steps in `CUTOVER.md`
  (no production credentials in this environment).
- Migrated-user password reset / re-provision is an admin action during the
  cutover window (communicated per runbook §4.6).

**Re-platform complete: Phases A–F done.**

---

## Verification per phase (plan §11)

Backend: `go test ./...` (+ `-race`), testcontainers PG+Redis, golden pricing
parity, oversell concurrency, idempotency dup-safety, RBAC, multi-outlet
isolation. Frontend: `pnpm -r build` + `tsc -b` per app; Playwright checkout E2E
(C), offline E2E + sync-wall E2E (C), native build (E). `gofmt`/`go vet` clean.
