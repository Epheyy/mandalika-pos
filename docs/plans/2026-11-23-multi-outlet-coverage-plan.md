# Multi-outlet coverage — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Manajer can cover several outlets (or every outlet via an explicit flag), switch between them in the Backoffice, log in on covered POS tablets, and approve/receive at covered outlets; the server refuses everything else.

**Architecture:** A leaf Go package `internal/coverage` owns the coverage value and the pure rules. Coverage is loaded with the user row, carried in the access token (two new claims), put in the request context by the middleware, and checked with `Covers()` everywhere a single outlet was compared before. Coverage writes bump `perm_version`, so open tokens refresh (#138). Backoffice and POS read `outletIds`/`allOutlets` from the generated `User` type.

**Tech Stack:** Go (chi, pgx, oapi-codegen), Postgres migrations, React + Vitest (Backoffice, POS), openapi-typescript.

**Spec:** `docs/plans/2026-11-23-multi-outlet-coverage-design.md` (owner-approved 2026-11-23). Read it first.

## Global Constraints

- Roles in code: `admin`, `manager` (UI "Manajer"), `cashier` (UI "Kasir").
- Cashier: exactly one outlet. Only `manager` may have extra outlets or `all_outlets`.
- "Every outlet" for a manager only via `users.all_outlets = true` (owner). A manager with `outlet_id` NULL and `all_outlets` false is **unassigned** and refused (no coverage).
- Refund and void from the combined (no active outlet) view stay admin-only (owner). `handlers/orders.go:226-239` and `handlers/orders_void.go:24-30` keep `c.role != "admin"`.
- Never let a non-admin, non-"all" request resolve to an empty outlet that read repos treat as all outlets.
- Every write that changes `user_outlets` or `all_outlets` bumps `perm_version` in the same transaction.
- No guard is weakened to pass a test. Existing tests stay green unchanged unless the spec changes their expectation (say so in the commit).
- OpenAPI first, then `make -C backend gen` (Go + TS). New schema fields use plain types (no `$ref` + `nullable`). If a new top-level test lands in `internal/api` or `internal/codegen`, add it to `scripts/ci/codegen_gate.py`.
- Base branch `origin/prod-hardening`. Conventional commits ending with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` (implementer) or Opus for review fixes.
- UI copy in Indonesian, exact strings below.

## Review Focus

1. **Coverage removed while a session is open:** a token issued before an outlet was removed, sending that outlet in `X-Outlet-Id`, is refused (401 revoked → refresh → 403), never served. Test in Task 4.
2. **Saved Backoffice switcher choice no longer covered:** the viewer lands on their home outlet, no 403 loop. Test in Task 6.
3. **Specific manager sends `?outletId=all` or an uncovered `?outletId=`:** 403, never cross-outlet data. Test in Task 2.
4. **Tablet bound to outlet B, supervisor no longer covers B:** `mismatch`, never a silent rebind. Test in Task 8.
5. **Unassigned manager (NULL outlet, flag off) calls a catalogue read (`GET /products`):** no products from any outlet, never all. Test in Task 3.

---

### Task 1: Coverage package, migration, user loading

**Files:**
- Create: `backend/internal/coverage/coverage.go`, `backend/internal/coverage/coverage_test.go`
- Create: `backend/internal/db/migrations/0097_users_all_outlets.sql`
- Modify: `backend/internal/auth/store.go` (`User`, `scanUser`, `byEmailRow`, `ByID`), `backend/internal/auth/sessions.go:~134` (refresh user load)
- Test: `backend/internal/auth/` integration test next to existing ones (same build-tag/env convention as `permversion_test.go`)

**Interfaces:**
- Produces (package `coverage`, imports nothing internal):
  - `type Coverage struct { All bool; OutletIDs []string }`
  - `func (c Coverage) Covers(outletID string) bool` — `All` → true; else case-insensitive membership; `""` → false.
  - `func Of(role, home string, extras []string, allOutlets bool) Coverage` — admin → `{All:true}`; manager+allOutlets → `{All:true}`; manager → home first then extras, deduped case-insensitively, empty home dropped; cashier → `{OutletIDs:[home]}` if home != "" else `{}`; unknown role → `{}`.
  - `const SelectCols = "u.all_outlets, ARRAY(SELECT uo.outlet_id::text FROM user_outlets uo WHERE uo.user_id = u.id ORDER BY uo.outlet_id)"` (append to a `FROM users u` select).
  - `func Load(ctx context.Context, q Querier, userID string) (role, home string, cov Coverage, err error)`; `type Querier interface { QueryRow(context.Context, string, ...any) pgx.Row }`. Unknown user → `pgx.ErrNoRows` wrapped.
- Produces (package `auth`): `User` gains `OutletIDs []string \`json:"outletIds"\`` (home first, then extras; `[]` when none) and `AllOutlets bool \`json:"allOutlets"\``; `func (u *User) Coverage() coverage.Coverage`.

- [ ] **Step 1:** Write `TestOf` table: admin→All; manager+all→All; manager home "A" extras ["B","a"]→`[A B]`; manager home "" extras []→empty (unassigned); cashier "A"→`[A]`; cashier ""→empty. `TestCovers`: All covers "x"; `[A]` covers "a"; `[A]` not "B"; nothing covers "".
- [ ] **Step 2:** `cd backend && go test ./internal/coverage/` → FAIL (package missing).
- [ ] **Step 3:** Implement `coverage.go`.
- [ ] **Step 4:** Migration 0097: `ALTER TABLE users ADD COLUMN IF NOT EXISTS all_outlets boolean NOT NULL DEFAULT false;` plus `CHECK (NOT all_outlets OR outlet_id IS NULL)` named `users_all_outlets_no_home`. Additive only.
- [ ] **Step 5:** Integration test `TestUserCoverageLoaded`: seed a manager with home A + `user_outlets` row B → `ByID` returns `OutletIDs == [A, B]`, `AllOutlets == false`; a manager with `all_outlets = true` → `AllOutlets == true`, `OutletIDs == []`. Run → FAIL.
- [ ] **Step 6:** Extend the three user SELECTs to `FROM users u` + `coverage.SelectCols`; scan into `User`; build `OutletIDs` = home first then the array minus home.
- [ ] **Step 7:** `go test ./internal/coverage/ ./internal/auth/...` → PASS. Commit `feat: coverage package and users.all_outlets (mig 0097)`.

### Task 2: Token claims and middleware active outlet

**Files:**
- Modify: `backend/internal/auth/jwt.go`, `backend/internal/auth/handlers.go:77` (`respond`), refresh path in `sessions.go` that calls `IssueAccessV`, `backend/internal/auth/context.go`, `backend/internal/middleware/middleware.go:72-82`
- Create: `backend/internal/middleware/outlet_test.go`

**Interfaces:**
- Consumes: Task 1 `coverage.Coverage`, `User.Coverage()`.
- Produces:
  - `Claims` gains `OutletIDs []string \`json:"ocv,omitempty"\`` (only for a manager with ≥2 covered outlets) and `AllOutlets bool \`json:"oall,omitempty"\``.
  - `func IssueAccessCov(secret []byte, ttl time.Duration, uid, role, outletID string, perms []string, pv int64, cov coverage.Coverage) (string, error)`; `IssueAccessV` delegates with `coverage.Coverage{}` (claims omitted). `respond` and the refresh issuer use `IssueAccessCov(..., u.Coverage())`; admin never gets `oall`.
  - `func (c Claims) Coverage() coverage.Coverage` — admin → All; `AllOutlets` → All; `len(OutletIDs) > 0` → those; `OutletID != ""` → `[OutletID]`; else `{}` (legacy tokens fail closed).
  - `auth.CtxCoverage` context key; `func CoverageFrom(ctx context.Context) coverage.Coverage`.

- [ ] **Step 1:** Write `outlet_test.go` (httptest through the auth middleware, signing tokens with `IssueAccessCov`), each asserting status and the `auth.CtxOutletID` seen by the next handler:
  - cashier home A: no header → 200, "A"; header A → 200; header B → 403 `outlet not permitted`.
  - manager coverage [A,B]: no header → "A"; header B → "B"; header C → 403.
  - manager coverage [A,B], `?outletId=all` → 403; `?outletId=C` → 403; `?outletId=B` → 200.
  - manager all: header C → 200 "C"; no header → "".
  - legacy token manager with `outlet_id` "" and no claims: header C → 403.
  - admin: unchanged (header C → 200).
- [ ] **Step 2:** `go test ./internal/middleware/ -run Outlet` → FAIL.
- [ ] **Step 3:** Implement: `cov := claims.Coverage()`; header accepted when `role == "admin" || cov.All || cov.Covers(h)`; for a manager that is neither admin nor All, an `outletId` query param that is `all` or not covered → 403 `outlet not permitted` (cashier query handling unchanged); store `cov` in context.
- [ ] **Step 4:** `go test ./internal/middleware/ ./internal/auth/...` → PASS (existing `jwt_test.go`, `revocation_test.go` unchanged). Commit `feat: coverage claims and middleware outlet check`.

### Task 3: Read scope and location checks

**Files:**
- Modify: `backend/internal/handlers/handlers.go:76-90` (`scope`), `backend/internal/read/repo.go` (add const), `backend/internal/handlers/outlets.go:29` (`canEditOutletID`), `backend/internal/handlers/inventory_approvals.go:~93` (`locationInScope`), `backend/internal/handlers/inventory_movements.go:~45` (`movementLocationAllowed`), and every explicit `!sc.CrossAll && sc.OutletID == ""` guard (e.g. `handlers.go:552,585,634`)
- Test: `backend/internal/handlers/scope_coverage_test.go` (unit) + one integration case

**Interfaces:**
- Consumes: Task 2 `auth.CoverageFrom`.
- Produces: `read.NoOutlet = "00000000-0000-0000-0000-000000000000"`; `func noActiveOutlet(sc read.Scope) bool` (true when `!sc.CrossAll && (sc.OutletID == "" || sc.OutletID == read.NoOutlet)`), used by every existing explicit guard so their 403 text stays.

- [ ] **Step 1:** Unit tests for `scope(r)` with context set directly: admin unchanged; manager-all behaves like admin (`?outletId=all` and no header → `CrossAll`; `?outletId=X` → X); manager [A,B] active B → `{OutletID: B}`; manager [A,B] active A with `?outletId=B` (already admitted by Task 2) → `{OutletID: B}`; unassigned manager and cashier with no outlet → `{OutletID: read.NoOutlet}`. `canEditOutletID`: manager [A,B] edits B → true, C → false. `locationInScope`/`movementLocationAllowed`: manager-all → true for any outlet; manager active A, location B → false.
- [ ] **Step 2:** Integration (Review Focus 5): unassigned manager `GET /products` returns no rows from any outlet (or the existing 403); a manager-all with no header gets the cross-outlet catalogue.
- [ ] **Step 3:** Run → FAIL. Implement: in `scope`, treat `cov.All` like admin; a non-admin, non-All caller with an empty active outlet gets `read.NoOutlet`; `canEditOutletID` uses `CoverageFrom(ctx).Covers(id)` for non-admins; the two location helpers return true for `cov.All`.
- [ ] **Step 4:** `go test ./internal/handlers/... ./internal/read/...` → PASS. Commit `feat: read scope follows outlet coverage, fail closed`.

### Task 4: User admin API writes coverage

**Files:**
- Modify: `backend/api/openapi.yaml` (`User`, `CreateUserRequest`, `UpdateUserRequest`), regenerate (`make -C backend gen`), `backend/internal/handlers/users.go`, `backend/internal/auth/store.go` (`CreateUser`, `UpdateUser`, open-shift helper), `backend/internal/read/users.go` (`userObj`), `backend/internal/auth/rights_guard_test.go` (guard `user_outlets` writes and `all_outlets`)
- Create: `backend/internal/coverage/validate.go`, `validate_test.go`
- Test: users integration test (create/update/perm bump/revocation)

**Interfaces:**
- OpenAPI: `User` adds required `outletIds: {type: array, items: {type: string, format: uuid}}` and required `allOutlets: {type: boolean}`; both request schemas add optional `outletIds` (same array) and `allOutlets: {type: boolean}`. `outletIds` is the full coverage (home first).
- `func Validate(role, home string, outletIDs []string, allOutlets bool) error` in `coverage` returning `ErrCashierOneOutlet`, `ErrManagerNeedsCoverage`, `ErrHomeNotCovered`, `ErrAdminNoCoverage`, `ErrAllWithHome` (mapped to 400 with Indonesian text: "Kasir harus ditempatkan di tepat satu outlet.", "Manajer perlu Semua Outlet atau minimal satu outlet.", "Outlet utama harus termasuk outlet yang dicakup.", "Admin tidak memakai daftar outlet.", "Semua Outlet tidak bisa digabung dengan outlet utama."). Cashier valid when home set and `outletIDs` empty or `[home]`.
- `Store.CreateUser(ctx, email, password, name, role, outletID string, perms []string, outletIDs []string, allOutlets bool) (string, error)`; `Store.UpdateUser(ctx, id string, name, role, outletID, photo *string, perms *[]string, outletIDs *[]string, allOutlets *bool) error`. Omitted fields keep current values; the **merged** result must pass `Validate`; unknown outlet ids → 400 "Outlet tidak ditemukan.". Extras stored = `outletIDs` minus home.
- `func hasOpenShiftAt(ctx, q querier, uid string, outletIDs []string) (bool, error)` (`shifts.cashier_id = uid AND status = 'open' AND outlet_id = ANY(...)`); dropping a covered outlet with an open shift → `ErrOpenShiftMove`. Home-change rule unchanged.
- `rightsChanged` also when the extras set or `all_outlets` changes.

- [ ] **Step 1:** `validate_test.go` table covering every error above plus valid cases (cashier [home]; manager all; manager home A + [A,B]).
- [ ] **Step 2:** Integration tests: create manager [A,B] → response `outletIds == [A,B]`; update to [A] bumps `perm_version`; **Review Focus 1:** a token minted before that update, sending `X-Outlet-Id: B`, is refused; manager with open shift at B dropping B → 409; adding C with that open shift → 200; cashier with `outletIds [A,B]` → 400; turning `allOutlets` on bumps `perm_version`; legacy manager with NULL outlet edited without choosing → 400.
- [ ] **Step 3:** Run → FAIL. Implement OpenAPI + gen, handlers mapping (400 for validation errors), store writes (delete + insert `user_outlets` in the same tx), `userObj` adds `outletIds` (home first then extras) and `allOutlets`; extend `rightsWrites` in `rights_guard_test.go` to `user_outlets` writes and `all_outlets`.
- [ ] **Step 4:** `go test ./...` and `corepack pnpm gen:check` → PASS. Commit `feat: user API carries outlet coverage`.

### Task 5: Sync, approvals and receive follow coverage

**Files:**
- Modify: `backend/internal/handlers/writes.go:15-28` (`callerID`), `backend/internal/handlers/sync.go:65-72`, `backend/internal/sync/attribute.go:226-236` (+ `sync.Caller`), `backend/internal/write/inventory_approval.go` (`ApproverCovers` + loads at ~248-254, `recheckApprover`, `requireApprover`), `backend/internal/write/receive_fingerprint.go:62-69` (`ReceiveScope`), `backend/internal/write/receive_approval.go` (~317-342, ~428), `backend/internal/sync/sync.go:567`, `backend/internal/read/users.go:13-24` (`ReceiveApprovingUsers`)
- Test: existing `attribute_test.go`, `receive_fingerprint_test.go`, `transfer_receive_test.go` extended; new `inventory_approval_cover_test.go`; refund/void integration case

**Interfaces:**
- Consumes: `coverage.Load`, `User.Coverage()`.
- `sync.Caller` gains `Coverage coverage.Coverage` (filled from the users row via `callerID`, never from the token); non-admin attribution passes when `Coverage.Covers(env.OutletID)`.
- `func ApproverCovers(role string, approver coverage.Coverage, docOutlet string, approverRoles []string) bool` — role rule unchanged; `docOutlet == ""` → true; else `approver.Covers(docOutlet)` (admin's coverage is All).
- `func ReceiveScope(callerOutlet, destOutlet, approverRole string, approver coverage.Coverage) string` — dest must equal caller outlet (unchanged text); approver must cover dest else `"tidak berwenang"`.
- `ReceiveApprovingUsers` WHERE outlet clause becomes `(u.role = 'admin' OR u.outlet_id = $1 OR u.all_outlets OR EXISTS (SELECT 1 FROM user_outlets uo WHERE uo.user_id = u.id AND uo.outlet_id = $1))`.

- [ ] **Step 1:** Tests: attribution manager [A,B] envelope B → ok, C → `mismatchOutlet`; cashier unchanged. `ApproverCovers`: manager [A,B] doc B → true, doc C → false, manager-all → true, cashier-role in approver list with home A doc B → false. `ReceiveScope`: approver covers dest → ""; not → "tidak berwenang". `ReceiveApprovingUsers(B)` lists a manager [A,B] with a PIN and a manager-all, not a manager [A]. Refund and void as manager-all with no active outlet → 403 "Outlet aktif belum dipilih untuk akun ini." (owner rule).
- [ ] **Step 2:** Run → FAIL. Implement, loading approver coverage with `coverage.Load` where the single `outlet_id` was selected.
- [ ] **Step 3:** `go test ./...` → PASS. Grep the backend for any remaining `outlet_id = $` user filters and `role == "admin"` outlet branches; list each with its classification (scope → extended to All, rights → admin-only) in the commit body. Commit `feat: sync, approvals and receive follow outlet coverage`.

### Task 6: Backoffice outlet switcher and active outlet

**Files:**
- Modify: `apps/backoffice/src/outlet.tsx`, `apps/backoffice/src/lib/sessionRefresh.ts:36`, `apps/backoffice/src/screens/requisitions/RequisitionList.tsx:78`, `apps/backoffice/src/screens/inventory/useLocations.ts:39`, `apps/backoffice/src/screens/stockcount/countScope.ts` (check only), other `role === 'admin'` outlet branches found by grep
- Create/extend tests: `apps/backoffice/src/outlet.test.tsx` (or the existing outlet tests), `lib/outletPref` tests

**Interfaces:**
- Consumes: generated `User.outletIds: string[]`, `User.allOutlets: boolean`.
- Produces from `outlet.tsx`: `OutletState` gains `canSwitch: boolean` (admin || allOutlets || outletIds.length ≥ 2) and `allowCombined: boolean` (admin || allOutlets); `outlets` = all for admin/allOutlets, else `GET /outlets` filtered to `outletIds`; `export function useActiveOutletId(): string | null` = `outletId ?? user.outletId ?? null`.
- Specific manager: default `outletId` null (server uses home); switcher shows covered outlets only, no "Semua outlet" option; the select shows the home outlet when `outletId` is null. A remembered choice not in the list is dropped (falls back to home).

- [ ] **Step 1:** Tests: switcher hidden for cashier and manager with one outlet; shown for manager [A,B] with options exactly A,B and no "Semua outlet"; manager-all sees all outlets plus "Semua outlet"; **Review Focus 2:** remembered pref C for a manager [A,B] → active outlet falls back to A, no request sends `X-Outlet-Id: C`; `useActiveOutletId` returns the switcher choice, else the home outlet; `sessionRefresh` keeps the choice for a user who `canSwitch`.
- [ ] **Step 2:** Run `corepack pnpm --filter @mandalika/backoffice test` → FAIL. Implement; replace the `admin ? outletId : user.outletId` branches with `useActiveOutletId()`.
- [ ] **Step 3:** Backoffice tests + `corepack pnpm typecheck:ci` → PASS. Commit `feat(backoffice): outlet switcher for covered managers`.

### Task 7: Backoffice user form and list

**Files:**
- Create: `apps/backoffice/src/screens/users/coverage.ts` + `coverage.test.ts`, `apps/backoffice/src/screens/users/OutletCoverageField.tsx` + test
- Modify: `apps/backoffice/src/screens/users/AddUserModal.tsx:56-67`, `apps/backoffice/src/screens/Users.tsx` (edit form ~66, ~133, ~170), `apps/backoffice/src/screens/users/userColumns.tsx` (Outlet column)

**Interfaces:**
- `type CoverageValue = { mode: 'all' | 'specific' | 'none'; homeId: string; outletIds: string[] }`
- `function coverageFromUser(u: Pick<User,'role'|'outletId'|'outletIds'|'allOutlets'>): CoverageValue` (manager with no outlet and flag off → `mode: 'none'`).
- `function coverageError(role: Role, v: CoverageValue): string | null` — cashier without home → "Pilih satu outlet untuk kasir."; manager `none` or `specific` with no ticks → "Pilih Semua Outlet atau minimal satu outlet."; home not ticked → "Outlet utama harus salah satu outlet yang dicentang."; admin → null.
- `function coveragePayload(role: Role, v: CoverageValue): { outletId: string | null; outletIds: string[]; allOutlets: boolean }` — cashier `{home, [home], false}`; manager all `{null, [], true}`; manager specific `{home, [home, ...others], false}`; admin `{current outletId behaviour, [], false}`.
- `function outletLabel(u, nameOf: (id: string) => string): string` — allOutlets → "Semua Outlet"; admin with no outlet → "Semua Outlet"; ≥2 outlets → "<home> +N"; one → its name; non-admin with none → "Belum ada outlet".
- UI: Kasir = one required select (no "Semua Outlet" option). Manajer = radio "Semua Outlet" / "Outlet tertentu"; specific shows an outlet checklist and an "Outlet utama" select limited to ticked outlets (defaults to the first ticked). Save is disabled with the `coverageError` text shown. Admin: field hidden as today.

- [ ] **Step 1:** Unit tests for the four functions (every branch above) and a component test: switching role Manajer→Kasir keeps only the home outlet; unticking the "Outlet utama" outlet moves utama to the first remaining tick.
- [ ] **Step 2:** Run → FAIL; implement; wire both create and edit through `coveragePayload`.
- [ ] **Step 3:** Backoffice tests + typecheck → PASS. Commit `feat(backoffice): user form outlet coverage`.

### Task 8: POS terminal binding

**Files:**
- Modify: `apps/pos/src/terminalBinding.ts:107-126` (`resolveTerminal`), `apps/pos/src/App.tsx` (pick screen outlet list)
- Test: `apps/pos/src/terminalBinding.test.ts`, `terminal.mismatch.test.ts`

**Interfaces:**
- `resolveTerminal(user: Pick<User,'id'|'displayName'|'outletId'|'role'|'outletIds'|'allOutlets'>, ...)` — `allOutlets` manager behaves exactly like admin; manager with `outletIds.length ≥ 2`: binding covered → ok, binding not covered → mismatch, no binding + no pick → `pick`, no binding + covered pick → ok/created; a pick outside coverage → `pick` again. Everyone else unchanged. Missing `outletIds` (session stored before the upgrade) = `[outletId]`.
- `export function pickableOutlets<T extends { id: string }>(user, outlets: T[]): T[]` — admin/allOutlets → all; else covered only. Used by the pick screen.

- [ ] **Step 1:** Tests for each branch above, including **Review Focus 4** (binding B, coverage [A,C] → mismatch, binding untouched) and the old-session fallback.
- [ ] **Step 2:** Run `corepack pnpm --filter @mandalika/pos test` → FAIL; implement.
- [ ] **Step 3:** POS tests + typecheck → PASS. Commit `feat(pos): supervisors bind tablets within their coverage`.

### Task 9: Full gates and hand-over

- [ ] **Step 1:** `cd backend && go vet ./... && go test ./...` (integration tests against the local `roletest` DB per `backend/.env`), `corepack pnpm quality:ci`, `corepack pnpm gen:check` → all green.
- [ ] **Step 2:** Add a dated HANDOFF.md progress-board entry (built, PR link, not released; release order backend → Backoffice → POS OTA, each needs the owner's go-ahead; owner then sets coverage for supervisors; managers saved with no outlet stay blocked until edited). Commit `[CF-Pages-Skip] docs: HANDOFF multi-outlet coverage built`.
