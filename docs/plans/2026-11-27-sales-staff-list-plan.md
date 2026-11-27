# Sales staff list ("Tim Sales") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace user accounts in the POS salesperson picker with a Backoffice-managed, per-outlet
sales staff list (no login), and stop shipping other users' email/role/permissions to tablets.

**Architecture:** New `sales_staff` + `sales_staff_outlets` tables (migration 0104) with a
coverage-scoped CRUD API under a new `manage_sales_staff` permission. The tablet pull gains
`salesStaff: [{id,name}]` (active, this outlet) and `users` shrinks to `[{id,displayName}]` of users
covering the outlet. Performa Sales maps a linked user's old picks onto the staff entry. Backoffice
gets a "Tim Sales" page; the POS picker reads `snapshot.salesStaff`.

**Tech Stack:** Go (chi, pgx, oapi-codegen via `go run ./cmd/codegen`), PostgreSQL, OpenAPI →
`openapi-typescript` (`packages/api`), React + Tailwind (Backoffice, POS), Vitest.

**Spec:** `docs/plans/2026-11-27-sales-staff-list-spec.md` (owner decisions 1–7 are binding).

## Global Constraints

- Migration number **0104** (`backend/internal/db/migrations/0104_sales_staff.sql`); renumber only if another branch took 0104 by merge time.
- Permission string `manage_sales_staff`, label "Kelola sales", desc "Tambah dan atur tim sales outlet".
- Name: 1–60 characters after trim. Every entry has ≥1 outlet.
- Pull fields: `salesStaff: [{id, name}]`, `users: [{id, displayName}]`. No email, role, coverage or permissions in the pull.
- Content-version resource name `"sales_staff"`, bumped via `bumpVersionOutlets` for old ∪ new outlets.
- Migrated entries are **inactive** (owner follow-up to decision 3).
- Never reject a sale over its salesperson; sale payload unchanged (`salesmanId`, `salesmanName`).
- Do not edit `backend/internal/receiptlink/*` or the `Users.tsx` edit dialog (parallel session). `PermissionPicker.tsx` is allowed.
- New Postgres integration test: prefix `SS`, port `26489`, registered in `scripts/ci/postgres_gate.py` as `("SS", "TestSalesStaffPostgres", 26489, "ss")`.
- No new top-level tests in `internal/api` or `internal/codegen` (if one is added, list it in `scripts/ci/codegen_gate.py`).
- Any `package.json` change ships with an updated `pnpm-lock.yaml`.
- Indonesian UI copy; Backoffice design tokens and existing components only.
- Branches stacked: slice 1 `claude/sales-staff-backend`, slice 2 `claude/sales-staff-backoffice` (on slice 1), slice 3 `claude/sales-staff-pos` (on slice 2). Gate each on an origin `gate/sales-staff-<slice>` branch. Never push `prod-hardening`, never deploy.

## Review Focus

1. **Partial-coverage Manajer edits a shared person** (BSD Manajer, Rina at BSD+LWB): sends name change, Nonaktif, or tries to add LWB. Expected: name/userId change and re-activation refused (403); Nonaktif removes only BSD; LWB stays and Rina stays active at LWB. → Task 3 test `TestSalesStaffPostgres/partial_manager`.
2. **Migration on real-shaped data:** a picked user with empty or 80-char `display_name`, orders with a `salesman_id` that matches no user, a user picked at two outlets. Expected: migration succeeds; name falls back/truncates; unmatched ids ignored; one entry with two outlets, inactive. → Task 1 test.
3. **Held cart with a salesperson who is no longer listed** (deactivated, or an old user id from before the OTA). Expected: picker still shows and keeps that name; sale sends that id. → Task 9 test.
4. **Tablet at an outlet removed from a person** must drop them: the removed outlet's content version moves. → Task 3 test `version_bump`.
5. **Performa Sales across the link:** user U picked on old orders, entry S linked to U, new orders with S. Expected: one row keyed by S with S's current name; ratings filter by S returns both old and new; unlinking splits them. → Task 6 test.

---

## Slice 1 — Backend (`claude/sales-staff-backend`)

### Task 1: Migration 0104 (tables, data migration, grants)

**Files:**
- Create: `backend/internal/db/migrations/0104_sales_staff.sql`
- Create: `backend/internal/handlers/sales_staff_integration_test.go` (holds `TestSalesStaffPostgres`; later tasks add subtests)
- Modify: `scripts/ci/postgres_gate.py` (add the SS tuple next to `("CR", ...)`)

**Interfaces:**
- Produces: tables `sales_staff(id uuid pk, name text, active bool, user_id uuid unique null → users ON DELETE SET NULL, created_at, updated_at timestamptz, created_by, updated_by uuid)`, `sales_staff_outlets(staff_id → sales_staff ON DELETE CASCADE, outlet_id → outlets ON DELETE CASCADE, PK(staff_id,outlet_id))`, index `sales_staff_outlets(outlet_id)`.

- [ ] **Step 1: Write the failing test** `TestSalesStaffPostgres/migration` using `gatePool(t, "SS", 26489)` (copy the fixture setup from `customer_rating_integration_test.go`). Because the fixture applies all migrations before the test, test the data-migration SQL by seeding first and then re-running the 0104 `INSERT … SELECT` statements through a helper that reads them from the file between `-- migrate:data-begin` / `-- migrate:data-end` markers. Seed: user A (display_name `''`), user B (display_name 80×"x"), user C (manager, never picked); orders: A at outlet O1, A at O2, B at O1, one order with a random `salesman_id` matching no user. Assert:
  - exactly 2 `sales_staff` rows; both `active=false`; A's name `'Sales'`, B's name 60×"x"; A has outlets {O1,O2}, B {O1};
  - re-running the data block inserts nothing new (idempotent: `ON CONFLICT DO NOTHING` / `NOT EXISTS`);
  - `user_permissions` has `manage_sales_staff` for C (role manager) and not for a cashier.
- [ ] **Step 2: Run** `MANDALIKA_SS_TEST_DSN=... go test ./internal/handlers -run TestSalesStaffPostgres -count=1` (via `scripts/ci/postgres_gate.py` locally as the other gates do). Expected: FAIL (table missing).
- [ ] **Step 3: Write `0104_sales_staff.sql`**: tables + CHECK `char_length(btrim(name)) BETWEEN 1 AND 60`; then the marked data block:

```sql
-- migrate:data-begin
INSERT INTO sales_staff (name, active, user_id)
SELECT COALESCE(NULLIF(left(btrim(u.display_name), 60), ''), 'Sales'), false, u.id
  FROM users u
 WHERE EXISTS (SELECT 1 FROM orders o WHERE o.salesman_id = u.id)
   AND NOT EXISTS (SELECT 1 FROM sales_staff s WHERE s.user_id = u.id);
INSERT INTO sales_staff_outlets (staff_id, outlet_id)
SELECT DISTINCT s.id, o.outlet_id
  FROM sales_staff s JOIN orders o ON o.salesman_id = s.user_id
 WHERE o.outlet_id IS NOT NULL
ON CONFLICT DO NOTHING;
-- migrate:data-end
```

  then grants mirroring `0092_order_voids.sql:117-124` (`users.role='manager'`; `custom_roles.name ~* '(manajer|manager)'`), no `perm_version` bump.
- [ ] **Step 4: Run** the same test. Expected: PASS.
- [ ] **Step 5: Commit** `feat: sales staff tables and migration (0104)`.

### Task 2: OpenAPI contract + generated types

**Files:**
- Modify: `backend/api/openapi.yaml`; regenerate `backend/internal/api/api.gen.go` (`go run ./cmd/codegen`) and `packages/api/src/schema.d.ts` (`make gen-ts`).

**Interfaces (Produces):**
- Schemas: `SalesStaffPick {id: uuid, name: string}` (both required); `PullUser {id: uuid, displayName: string}` (both required); `SalesStaff {id, name, active, outletIds: uuid[], hiddenOutletCount: integer, user: PullUser|null (nullable), canEditDetails: boolean, updatedAt: date-time}`; `SalesStaffInput {name, active, outletIds (minItems 1), userId: uuid nullable}`.
- `SyncPullBundle`: `users` items → `PullUser`; new `salesStaff: SalesStaffPick[]`.
- Paths (tag `sales-staff`, security as other BO routes): `GET /sales-staff` (query `outletId`, `active` `true|false`, `q`) → `{data: SalesStaff[]}`; `POST /sales-staff` (header `Idempotency-Key` required) → 201 `{data: SalesStaff}`; `PUT /sales-staff/{id}` → `{data: SalesStaff}`; `GET /sales-staff/linkable-users` → `{data: PullUser[]}`. Errors 400/403/404/409 with the standard error body.

- [ ] **Step 1:** Edit the YAML.
- [ ] **Step 2: Run** `cd backend && go run ./cmd/codegen && make gen-ts && go run ./cmd/codegen -check && cd .. && corepack pnpm gen:check`. Expected: no diff on the check commands, `go build ./...` passes (fix the `Users any` pull field type only if the build requires it; the field stays JSON-compatible).
- [ ] **Step 3: Commit** `feat: sales staff OpenAPI contract`.

### Task 3: Write/read repository with coverage rules

**Files:**
- Create: `backend/internal/write/sales_staff.go`, `backend/internal/read/sales_staff.go`
- Test: subtests in `backend/internal/handlers/sales_staff_integration_test.go` (driven through the repo here, handlers in Task 4); pure-logic unit test `backend/internal/write/sales_staff_test.go`.

**Interfaces:**
- Produces (write):
  - `type SalesStaffCaller struct { UserID string; Admin bool; Cov coverage.Coverage }` (`Admin` = role admin; `Cov.All` covers "Semua Outlet" managers)
  - `type SalesStaffInput struct { Name string; Active bool; OutletIDs []string; UserID *string }`
  - `func (r *Repo) CreateSalesStaffTx(ctx context.Context, tx pgx.Tx, c SalesStaffCaller, in SalesStaffInput) (string, error)`
  - `func (r *Repo) UpdateSalesStaffTx(ctx context.Context, tx pgx.Tx, c SalesStaffCaller, id string, in SalesStaffInput) error`
  - `func planSalesStaffUpdate(c SalesStaffCaller, cur SalesStaffInput, in SalesStaffInput) (SalesStaffInput, error)` — pure; the decision-7 rules
  - Errors: `ErrSalesStaffInvalid`, `ErrSalesStaffNotFound`, `ErrSalesStaffForbidden`, `ErrSalesStaffDuplicateName`, `ErrSalesStaffUserTaken` (Indonesian messages, safe for `safeDomainText`)
- Produces (read):
  - `type SalesStaffFilter struct { OutletID string; Active *bool; Q string }`
  - `func (r *Repo) SalesStaffList(ctx context.Context, c write.SalesStaffCaller, f SalesStaffFilter) ([]api.SalesStaff, error)` — if `read` cannot import `write`, define the caller struct in `read` and alias it in `write` (pick one owner, no import cycle)
  - `func (r *Repo) SalesStaffByID(ctx, q RowQuerier, c SalesStaffCaller, id string) (api.SalesStaff, error)` (for the keyed-write Outcome)
  - `func (r *Repo) SalesStaffForOutlet(ctx context.Context, outletID string) ([]api.SalesStaffPick, error)` — active, linked to outlet, `ORDER BY lower(name), id`
  - `func (r *Repo) UsersForOutlet(ctx context.Context, outletID string) ([]api.PullUser, error)`
  - `func (r *Repo) LinkableUsers(ctx context.Context, c SalesStaffCaller) ([]api.PullUser, error)`

**Rules (`planSalesStaffUpdate`, the algorithm the tests pin):**
- `full := c.Admin || c.Cov.All || every outlet in cur.OutletIDs is covered`.
- Not full and no cur outlet covered → `ErrSalesStaffNotFound`.
- Any requested outlet not covered (and not already in cur) → `ErrSalesStaffForbidden`.
- Not full: changed name (trimmed), changed userId, or `in.Active && !cur.Active` → `ErrSalesStaffForbidden`. Result outlets = (cur ∖ covered) ∪ (in ∩ covered); if `!in.Active`, result outlets = cur ∖ covered and active stays `cur.Active`.
- Full: result = in.
- Result must have ≥1 outlet (else `ErrSalesStaffInvalid`).

**Other rules:** name trimmed, 1–60 runes; outlets must exist; `userId` must exist, be unlinked (unique violation → `ErrSalesStaffUserTaken`), and for non-admin, non-All callers the user's coverage (`coverage.Load`) must intersect the caller's. Duplicate name: when the result is active, reject if another active entry shares ≥1 outlet and `lower(btrim(name))` matches → `ErrSalesStaffDuplicateName`. Create: caller must cover every requested outlet. Every write sets `updated_by/updated_at` (`created_by` on create) and calls `bumpVersionOutlets(ctx, tx, "sales_staff", union(cur, result))`. List visibility: admin/All see everything; others see entries with ≥1 covered outlet, `outletIds` = covered ones, `hiddenOutletCount` = the rest, `canEditDetails` = full. `UsersForOutlet` and `LinkableUsers` load users with `coverage.SelectCols` and filter in Go with `coverage.Of(...).Covers` (reuse the rule, no SQL copy); `LinkableUsers` excludes users already linked; admin/All → all unlinked users. All lists `ORDER BY lower(name)`.

- [ ] **Step 1: Write failing unit tests** in `write/sales_staff_test.go`: `TestPlanSalesStaffUpdate` table cases — admin renames (ok); full-cover Manajer deactivates (active=false, outlets kept); partial Manajer: rename → Forbidden; Nonaktif → outlets = {LWB}, active stays true; add LWB → Forbidden; untick BSD keeps LWB; reactivate inactive → Forbidden; no covered outlet → NotFound; full editor empties outlets → Invalid.
- [ ] **Step 2: Run** `go test ./internal/write -run TestPlanSalesStaffUpdate`. Expected: FAIL.
- [ ] **Step 3: Implement** `planSalesStaffUpdate`; run; PASS.
- [ ] **Step 4: Write failing Postgres subtests** in `TestSalesStaffPostgres`: `create_and_list` (admin creates Rina at BSD+LWB; BSD Manajer list shows Rina with `outletIds=[BSD]`, `hiddenOutletCount=1`, `canEditDetails=false`); `partial_manager` (Review Focus 1, through `UpdateSalesStaffTx`); `duplicate_name` (second active "rina " at BSD → DuplicateName; at an unrelated outlet → ok; inactive duplicate → ok); `user_link` (link U → ok; second entry linking U → UserTaken; Manajer linking a user outside coverage → Forbidden); `version_bump` (Review Focus 4: `content_versions.version` moves for BSD and LWB when LWB is removed); `pull_lists` (`SalesStaffForOutlet(BSD)` = active BSD entries only, sorted; `UsersForOutlet(BSD)` includes admin, an All manager, the BSD cashier, a manager with BSD as extra outlet; excludes a LWB cashier and a manager with no home outlet).
- [ ] **Step 5: Run**; FAIL. **Step 6: Implement** the repo functions; run; PASS.
- [ ] **Step 7: Commit** `feat: sales staff repository with coverage rules`.

### Task 4: Handlers, routes, permission

**Files:**
- Create: `backend/internal/handlers/sales_staff.go`
- Modify: `backend/internal/server/server.go` (new `r.Group` with `mw.RequirePermission("manage_sales_staff")`, near the `view_reports` group)
- Test: HTTP subtests in `sales_staff_integration_test.go`

**Interfaces:**
- Consumes: Task 3 repo functions; `auth.CoverageFrom(ctx)`, `auth.CtxRole`, `callerUserID(r)`; `keyedMutated` exactly as `SetOutletGiveaway` (`handlers/outlet_giveaway.go`).
- Produces: `ListSalesStaff`, `CreateSalesStaff`, `UpdateSalesStaff`, `ListSalesStaffLinkableUsers` on `*Handlers`.

Error mapping: Invalid → 400, Forbidden → 403, NotFound → 404, DuplicateName/UserTaken → 409, all via `safeDomainText`. POST without `Idempotency-Key` → 400 `"header Idempotency-Key wajib"`; PUT accepts an optional key (Unkeyed path runs the effect in a plain tx). Bad uuid in path/body → 400.

- [ ] **Step 1: Write failing HTTP subtests** `http_permissions`: cashier without the permission → 403 on all four routes; manager with the permission → 200 list; admin → 200; `http_create_update`: POST without key → 400, POST with key → 201 and replay with same key returns the same body; PUT rename by partial Manajer → 403 with Indonesian text; PUT duplicate → 409.
- [ ] **Step 2: Run**; FAIL. **Step 3: Implement**; run; PASS.
- [ ] **Step 4: Commit** `feat: sales staff API`.

### Task 5: Pull ships `salesStaff` and trimmed `users`

**Files:**
- Modify: `backend/internal/sync/pull.go:182-185` and the `PullBundle` struct (`Users any` → `[]api.PullUser`, add `SalesStaff []api.SalesStaffPick \`json:"salesStaff"\``); the `Read` interface the engine uses (add the two methods).
- Test: `pull_bundle` subtest in `TestSalesStaffPostgres` (or the existing pull test file if one asserts bundle fields — extend it instead).

- [ ] **Step 1: Write failing test**: pull for BSD returns `salesStaff` = active BSD entries `[{id,name}]` and `users` whose JSON objects have exactly the keys `id`, `displayName` (assert no `email`, `role`, `permissions`, `outletIds` keys anywhere in the raw JSON of `users`); empty lists serialise as `[]`, not `null`.
- [ ] **Step 2: Run**; FAIL. **Step 3: Implement** (replace `e.Read.Users(ctx, 1, 100000)` with `UsersForOutlet(ctx, outletID)`; add `SalesStaffForOutlet`; a read error fails the pull like its neighbours). **Step 4: Run**; PASS.
- [ ] **Step 5: Commit** `feat: pull sends outlet sales staff and slim users`.

### Task 6: Performa Sales grouping across the link

**Files:**
- Modify: `backend/internal/read/sales_performance.go` (`SalesPerformance` CTEs `sb` and `ra`, final name expression; `SalesRatings` filter and returned salesman id)
- Test: `sales_performance_link` subtest in `TestSalesStaffPostgres` (reuse helpers from `customer_rating_integration_test.go` for orders/ratings if exported in-package)

Change: join `LEFT JOIN sales_staff lk ON lk.user_id = o.salesman_id` and use `COALESCE(lk.id, o.salesman_id, none)` as `skey` in both `sb` and `ra`; final name = `COALESCE(st.name, <today's expression>)` with `LEFT JOIN sales_staff st ON st.id = key`. `SalesRatings`: filter `COALESCE(lk.id, o.salesman_id) = $n::uuid`; return that key as the row's salesman id. Update the doc comments (salesman = staff id, user id, or "none").

- [ ] **Step 1: Write failing test** (Review Focus 5): orders 1–2 with `salesman_id=U` (`salesman_name='Old'`), order 3 with `salesman_id=S`, S linked to U named "Rina": one row, key S, name "Rina", transactions 3; `SalesRatings(salesman=S)` returns ratings of orders 1 and 3; after unlinking (user_id NULL) two rows (U "Old", S "Rina"). Existing rating/performance tests still pass.
- [ ] **Step 2: Run**; FAIL. **Step 3: Implement**. **Step 4: Run** `go test ./...` plus the CR and SS Postgres gates; PASS.
- [ ] **Step 5: Commit** `feat: Performa Sales groups linked users with their sales staff entry`.

**Slice 1 close:** Opus review of the whole slice diff (touches sync pull + generated types + auth scoping) → fixes → push `claude/sales-staff-backend` and `gate/sales-staff-backend`, all five gates green → PR to `prod-hardening` (do not merge) → HANDOFF note (`[CF-Pages-Skip] [skip ci] docs:` commit on the PR branch).

---

## Slice 2 — Backoffice (`claude/sales-staff-backoffice`, on slice 1)

### Task 7: API client, permission label/default, route

**Files:**
- Modify: `packages/api/src/client.ts` (types `SalesStaff`, `SalesStaffInput`, `PullUser` from `S[...]`; methods below), `apps/backoffice/src/screens/users/PermissionPicker.tsx` (PERMS entry + manager default), `apps/backoffice/src/lib/router/routes.ts` (route), `apps/backoffice/src/lib/navAccess.ts` only if `canSeeNav` needs nothing (it doesn't: plain `perms.includes(perm)`)
- Test: `PermissionPicker` tests file next to it (create `permissionsForRole.test.ts` if none), `navAccess.test.ts`

**Interfaces (Produces):**
- `listSalesStaff(params?: { outletId?: string; active?: 'true' | 'false'; q?: string }): Promise<SalesStaff[]>`
- `createSalesStaff(input: SalesStaffInput, idempotencyKey: string): Promise<SalesStaff>`
- `updateSalesStaff(id: string, input: SalesStaffInput): Promise<SalesStaff>`
- `listSalesStaffLinkableUsers(): Promise<PullUser[]>`
- Route `{ id: 'salesStaff', path: 'tim-sales', label: 'Tim Sales', section: 'operasional', icon: Users (lucide), perm: 'manage_sales_staff', load: () => import('../../screens/SalesStaff') }`, placed right after the `users` route.
- `permissionsForRole`: `role === 'manager'` and empty selection → `['manage_sales_staff']`; leaving `manager` drops it only while it is exactly that auto default (mirror the cashier rule).

- [ ] **Step 1: Failing tests**: `permissionsForRole('manager', [])` → `['manage_sales_staff']`; `('manager', ['view_reports'])` unchanged; `('cashier', ['manage_sales_staff'], 'manager')` → `[]`; `canSeeNav('salesStaff', 'manage_sales_staff', {role:'manager', permissions:['manage_sales_staff']})` true, without it false.
- [ ] **Step 2: Run** `corepack pnpm --filter backoffice test -- permissionsForRole navAccess`; FAIL. **Step 3: Implement**; PASS.
- [ ] **Step 4:** Write a one-paragraph note to the parallel session in the shared notes folder (`…/side-session-notes/local_79c72bf2-…/sales-staff/permission-picker.md`): `PermissionPicker.tsx` gained one PERMS entry and a manager default; `Users.tsx` untouched.
- [ ] **Step 5: Commit** `feat: Kelola sales permission and Tim Sales route`.

### Task 8: Tim Sales screen

**Files:**
- Create: `apps/backoffice/src/screens/SalesStaff.tsx` (page: header, filters, table) and `apps/backoffice/src/screens/salesStaff/SalesStaffDialog.tsx` (add/edit), `salesStaff/salesStaffForm.ts` (pure form state → `SalesStaffInput`, validation)
- Test: `salesStaff/salesStaffForm.test.ts`, `salesStaff/SalesStaffDialog.test.tsx`

Behaviour: table columns Nama, Outlet (chips of visible outlets + "+N outlet lain" when `hiddenOutletCount>0`), Akun tertaut, Status (Aktif/Nonaktif pill). Filters: outlet select (caller's covered outlets, from the existing outlets hook the Users/Reports screens use), status (Semua/Aktif/Nonaktif, default Aktif), search. Empty state: "Belum ada tim sales. Tambahkan sales agar muncul di pilihan Sales di kasir." "Tambah sales" opens the dialog: Nama (max 60), Outlet checklist (covered outlets only), Tautkan ke akun (select, "— Tidak ditautkan —" + `listSalesStaffLinkableUsers`; choosing one prefills Nama if empty), Aktif switch. When `canEditDetails=false`: Nama, akun and Aktif are disabled with the note "Sales ini juga bertugas di outlet lain. Anda hanya bisa mengatur outlet Anda; menonaktifkan hanya melepas outlet Anda." and the footer offers "Lepas dari outlet saya" (sends `active:false`, server removes covered outlets). Server 4xx text is shown in the dialog. Copy the dialog/table structure and tokens from an existing small Backoffice dialog (e.g. `screens/settings` cards / `CrossOutletLookups.tsx` table); no new dependencies.

- [ ] **Step 1: Failing tests**: `salesStaffForm`: trims name, rejects empty/61 chars ("Nama wajib diisi" / "Nama maksimal 60 karakter"), requires ≥1 outlet ("Pilih minimal satu outlet"), maps "tidak ditautkan" to `userId: null`; dialog test: `canEditDetails=false` disables Nama/akun/Aktif and shows the note; prefill from linked user when Nama empty.
- [ ] **Step 2: Run**; FAIL. **Step 3: Implement**; PASS. **Step 4: Run** `corepack pnpm quality:ci` and `corepack pnpm browser:ci`; PASS.
- [ ] **Step 5: Commit** `feat: Tim Sales page`.

**Slice 2 close:** Opus review → fixes → `gate/sales-staff-backoffice` green → PR (base: slice 1 branch, or `prod-hardening` noting it stacks) → HANDOFF note. Render the page locally against the local test stack (`roletest`, test accounts only on localhost) and screenshot list + dialog for the PR.

---

## Slice 3 — POS (`claude/sales-staff-pos`, on slice 2)

### Task 9: Picker from `snapshot.salesStaff`

**Files:**
- Create: `apps/pos/src/cashier/salesPicker.ts`, `apps/pos/src/cashier/salesPicker.test.ts`
- Modify: `apps/pos/src/cashier/CashierScreen.tsx:353` (use the helper), `packages/sync/src/snapshot.salesStaff.test.ts` (new; persistence)

**Interfaces (Produces):**
- `export function salesPickList(snapshot: { salesStaff?: readonly { id: string; name: string }[]; users?: readonly { id: string; displayName?: string }[] }, selected: { id: string; name: string } | null): { id: string; name: string }[]`

Rules: `salesStaff` present (even empty) → use it; absent (old server) → `users` mapped to `{id, name: displayName ?? ''}`, dropping empty names. If `selected` is not in the list, append it (Review Focus 3). No sorting on the client (server order).

- [ ] **Step 1: Failing tests**: staff list wins over users; `salesStaff: []` → `[]` (picker hidden) even when users exist; absent → users fallback; selected missing from list → appended last; selected present → no duplicate; snapshot test: `salesStaff` survives `Snapshot.replace` + reload.
- [ ] **Step 2: Run** `corepack pnpm --filter pos test -- salesPicker` and `--filter @mandalika/sync test -- snapshot.salesStaff`; FAIL. **Step 3: Implement** and wire `CashierScreen` (`salesPickList(snapshot, state.selectedSalesman)`); PASS.
- [ ] **Step 4: Run** `corepack pnpm quality:ci` and `browser:ci`; PASS.
- [ ] **Step 5: Commit** `feat: POS sales picker uses the outlet sales staff list`.

**Slice 3 close:** Opus review → `gate/sales-staff-pos` green → PR → HANDOFF note with the release order (backend 0104 → Backoffice → POS OTA, owner go-ahead; after deploy the owner switches the real salespeople on in Tim Sales before the next sale; old picker on non-OTA tablets = known gap). Final whole-branch Opus review across the three slices before asking for release.
