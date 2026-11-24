# Multi-outlet coverage for Manajer users — design

Status: draft for owner approval (2026-11-23). Brainstormed with the owner in session
"multi-outlet coverage"; decisions below are the owner's unless marked **(Claude's call)**.

## Why

The owner's company has area supervisors (role Manajer) who each look after several outlets. Today a user
has exactly one outlet (`users.outlet_id`) or "Semua Outlet (tanpa pembatasan)" (NULL), so a supervisor
can only be given one outlet or all of them. Found while setting up users on the Supabase test DB on
2026-11-23.

## Goals

1. A Manajer can be given a chosen set of outlets ("coverage"), for example 3 of 27.
2. In the Backoffice a Manajer with more than one covered outlet gets an **outlet switcher** (the one admins
   have today) listing only their covered outlets; every screen works on the outlet picked.
3. A Manajer can **log in on a POS tablet at any covered outlet**; everything done there is recorded against
   that tablet's outlet.
4. **Approval and receive-PIN rights follow coverage**: a Manajer may approve inventory documents and give the
   receive PIN for any covered outlet (the Settings approver-role rule still applies).
5. **A Manajer can be set to "Semua Outlet" = covers every outlet**, including outlets added later:
   switcher over all outlets plus a combined all-outlet view, tablet login anywhere, approve anywhere.
   **Granted only by an explicit setting** (owner, after the builder check showed that today such an
   account is mostly refused: only catalogue-style reads fall through to "all"; reports, orders, stock
   counts, approvals, receive PIN and POS refuse it). A Manajer saved today with no outlet stays blocked
   until the owner ticks "Semua Outlet" or gives them outlets. Nobody gains powers at deploy.
6. **Refund and void from the combined view stay admin-only** (owner): a Manajer-"all" in the combined view
   is refused with a message to pick the order's outlet in the switcher first (`handlers/orders.go:226-239`,
   `handlers/orders_void.go:24-30` keep their admin-only "order's own outlet" path).
7. The server is the authority: an outlet outside a user's coverage is refused (403), not only hidden.

## Non-goals

- A combined "Outlet saya" view that sums only the covered outlets (owner: switcher first; may come later).
- Named areas reused across users (may come later on top of this design without rework).
- Multi-outlet cashiers: **a Kasir keeps exactly one outlet** (owner).
- Changes to Admin behaviour (sees and switches every outlet, as today).
- Changes to customer visibility (`customerScope`), ERP, reports' content.

## Anti-goals (would be a failure even if it "works")

- Any path where a covered (non-"all") Manajer's request resolves to an empty outlet and so reads **all**
  outlets. The read repos treat `Scope.OutletID == ""` as all outlets (`read/catalog.go:21,77,97,113`,
  `read/bundles.go:136`, `read/products_filtered.go:40`); a covered Manajer must resolve to a covered outlet
  or get a 403/400, never `""`.
- Weakening any existing stock, sync or auth guard to make a test pass.
- A coverage change that leaves an already-issued token able to use a removed outlet beyond its next request.

## Approaches considered

1. **Coverage list carried in the access token** — chosen by the owner. Login/refresh writes the user's
   covered outlet ids into the JWT; middleware checks the requested outlet against it. Changing coverage
   bumps `users.perm_version`, so open tokens are refused on their next request and refresh (existing #138
   mechanism). No per-request DB read. Cost: ~1 KB more token for a user covering 27 outlets.
2. Server lookup per request (token holds only the home outlet; coverage read from DB/cache each call).
   Always current but adds a read to every API call on a free-tier DB and is a second freshness mechanism
   beside `perm_version`. Not chosen.
3. Named areas (area → outlets, user → areas). Not asked for; adds a screen. Deferred; can sit on top of 1.

## Data model

- `user_outlets(user_id, outlet_id)` already exists in `0001_init.sql:36` (PK `(user_id, outlet_id)`,
  both FKs `ON DELETE CASCADE`) and has 0 rows: reused as is.
- **One migration (0097):** `users.all_outlets boolean NOT NULL DEFAULT false`, with a CHECK that
  `all_outlets` implies `outlet_id IS NULL`. Additive; the previous backend ignores it (rollback-safe).
- Meaning of a user's outlet fields:

| Role | `users.outlet_id` | `user_outlets` rows | Coverage |
|---|---|---|---|
| admin | any / NULL | none (ignored) | every outlet (unchanged) |
| manager, specific | home outlet (required) | the **other** covered outlets | home ∪ rows |
| manager, "Semua Outlet" | NULL, `all_outlets = true` | none | every outlet ("all") |
| manager, unassigned | NULL, `all_outlets = false` | none | none: refused like today |
| cashier | the one outlet (required on save) | none | that outlet |

  **(Claude's call)** rows hold only the extra outlets, so coverage = home ∪ rows and the home outlet is
  always covered without a second invariant to keep in sync. Existing single-outlet managers need no data
  change. A rollback to the previous backend ignores `user_outlets`, so covered managers fall back to their
  home outlet only (fail-closed).

## Server behaviour

### Coverage value

One server-side type, e.g. `auth.Coverage{All bool; OutletIDs []string}` (OutletIDs includes the home
outlet), with a single `Covers(outletID) bool` (case-insensitive) used everywhere below.

### Token

- New claims (names left to the builder): the covered outlet ids for a specific manager, and an "all"
  flag for manager-"all"; both absent for admin and cashier. `outlet_id` claim stays the home outlet.
- Coverage is loaded with the user on login and refresh (`auth/store.go` user loads, `IssueAccessV`).
- **Legacy tokens** (no claims): coverage = `{outlet_id}` for a non-admin with an outlet; a non-admin with
  no outlet = no coverage (fail-closed). They are refused and refreshed anyway once `perm_version` moves.

### Active outlet (middleware.go ~line 72)

- admin: unchanged.
- manager-"all": `X-Outlet-Id` accepted (as admin today); no header = no active outlet, read scope = all.
- manager-specific: `X-Outlet-Id` must be in coverage, else 403 "outlet not permitted"; no header = home outlet.
- cashier: header must equal the token outlet (unchanged).
- Put the coverage in the request context so handlers can call `Covers` without re-parsing.

### Read scope (`handlers.go` `scope()`)

- admin: unchanged. manager-"all": same as admin (`?outletId=` override, `all` = cross-outlet, no
  header = cross-outlet).
- manager-specific (ruling H): `?outletId=all` is ignored (it never widens and is not refused); an explicit
  uncovered `?outletId=<id>` → 403 "outlet not permitted"; a covered id is accepted. Otherwise the active
  outlet (never `""`). An uncovered valid outlet id from such a manager is refused by the middleware (403 "outlet not permitted"); a malformed `?outletId` reaches the handler's validation (400), and `scope()` ignores it. For admin, All-manager or warehouse callers a non-uuid `?outletId` on a list that filters by it is a 400, not a 500.
- **(Claude's call)** any non-admin with no coverage (unassigned manager, cashier with no outlet): scoped
  reads answer 403 "Outlet aktif belum dipilih untuk akun ini." instead of today's catalogue-read fall-through to all outlets. This
  includes `GET /products` and `GET /products/{id}`: an unassigned user is refused (403).

### Places that compare a user's outlet today — all switch to coverage

- `sync/attribute.go:226-236`: non-admin envelope outlet must be **covered** (was: equal home). Coverage for
  sync is read from the DB with the users row (same as role/home today, A04), not from the token.
- `write/inventory_approval.go` `ApproverCovers` and its callers (approver outlet loaded at ~248-254, and
  `recheckApprover`/`requireApprover`): approver must cover the document outlet; manager-"all" covers all.
- `write/receive_fingerprint.go` `ReceiveScope` and callers (`write/receive_approval.go` ~317-342, ~428;
  `sync/sync.go:567`): destination must still equal the caller's active outlet; the approver must cover it.
- `handlers/outlets.go` `canEditOutletID` **(Claude's call)**: a non-admin may edit any covered outlet
  (still gated by `manage_outlets`).
- `handlers/inventory_approvals.go` `locationInScope`, `handlers/inventory_movements.go`
  `movementLocationAllowed`: where admin gets every location, manager-"all" does too; a specific manager is
  checked against the active outlet as today.
- `read/users.go:13-24` `ReceiveApprovingUsers` (the POS receive-approver picker) filters
  `u.outlet_id = $1 OR u.role = 'admin'`: it must list users whose coverage includes the outlet, or Goal 4
  fails on the tablet even though `ReceiveScope` accepts them. As built, `all_outlets` and `user_outlets`
  count only for role manager, and extras only when the manager has a home outlet, mirroring `coverage.Of`. The builder also greps SQL for other
  `outlet_id = ` user filters, not only Go `role == "admin"` branches.
- `scope()` returns only `read.Scope` and feeds every cache key (`ckey`); refusing from it means a
  `(Scope, ok)` shape or a guard at each caller. Builder's choice; it is a wider change than one function.
- The builder sweeps every other `role == "admin"` outlet branch (scout list in the plan) and classifies it:
  **scope** branches extend to manager-"all"; **rights** branches (settings, users, refund/void from the combined view, etc.) stay admin-only.

### User admin API

- `User` gains `outletIds: string[]` (home first, then the extra outlets; empty when the user has no home
  outlet) and `allOutlets: boolean`. `outletId` stays
  the home outlet. Create/Update requests accept optional `outletIds`.
- Validation (server, not only the form):
  - cashier: `outletId` required; `outletIds` absent or exactly `[outletId]`.
  - manager: either `allOutlets: true` with `outletId`/`outletIds` empty, or `outletId` set and
    `outletIds` contains it (≥1). Saving a manager with neither is refused.
  - `User` and the requests also carry `allOutlets: boolean`; turning it on or off bumps `perm_version`.
  - admin: `outletIds` must be empty.
  - every id must be an existing outlet.
- Any change to the coverage set bumps `perm_version` in the same transaction (the existing UpdateUser
  rights path; `auth/rights_guard_test.go` must keep passing).
- Open-shift rule (`ErrOpenShiftMove`, `auth/store.go` ~176-185) **(Claude's call)**: a change that drops
  an outlet where the user has an open shift is refused; adding outlets is always allowed. Today's
  `hasOpenShift` (`store.go:43-47`) checks any open shift, so this needs a per-outlet variant.
- OpenAPI first (`backend/api/openapi.yaml`), regenerate Go and TS. Watch the `$ref`+`nullable` codegen gotcha
  and the codegen-gate exact test list (`scripts/ci/codegen_gate.py`) if a top-level test is added in
  `internal/api` or `internal/codegen`.

## Backoffice

- **User form** (Tambah/Edit Pengguna):
  - Kasir: one outlet select, required (no "Semua Outlet").
  - Manajer: choice "Semua Outlet" (sets `allOutlets`) or "Outlet tertentu"; for the latter a checklist of
    outlets (≥1) and an "Outlet utama" select limited to the ticked ones (defaults to the first ticked).
    Editing an existing Manajer with no outlet and no flag opens with neither chosen and cannot be saved
    until one is picked.
  - Admin (ruling N): keeps today's single optional outlet select ("Semua Outlet (tanpa pembatasan)" = no
    home); no coverage list or flag. Promoting a user to admin does not carry their old home outlet.
- **User list**: Outlet column shows the home outlet plus "+N" (tooltip lists the rest) or "Semua Outlet".
- **Outlet switcher** (`outlet.tsx`): shown for admin, manager-"all", and a manager with ≥2 covered outlets.
  The list is the outlets the user covers (all outlets for admin/"all"; `GET /outlets` stays open to every
  authenticated user and is filtered client-side; the server is the real guard). Default for a specific
  manager = home outlet; manager-"all" = combined view (like admin). Ruling M: the Backoffice active outlet is null (combined view)
  for an admin or all-outlets manager with no switcher choice; a covered manager without a choice gets their
  home outlet. The per-viewer remembered choice is
  dropped if no longer covered.
- Screens that branch `role === 'admin' ? outletId : user.outletId` (e.g. `RequisitionList.tsx:78`,
  `inventory/useLocations.ts:39`, `stockcount/countScope.ts`) follow the active outlet for covered managers.
- `lib/sessionRefresh.ts:36` (non-admin clears the stored outlet) must not wipe a covered manager's choice.

## POS

- The login response's user carries `outletIds` and enables an "all" manager.
- `terminalBinding.ts` decision (~104-122), for a non-admin:
  - cashier: unchanged (binding must equal home; no outlet = unassigned).
  - manager-specific: stored binding covered = ok; stored binding not covered = mismatch; no binding yet =
    **pick once from covered outlets** (like the admin pick) **(Claude's call: never silently bind a new
    tablet to the home outlet when the supervisor may be standing at another one)**.
  - manager-"all": behaves like admin (pick once from all outlets; binding wins).
- The POS already sends the terminal outlet as `X-Outlet-Id` (shared client `packages/api/src/client.ts:672`),
  so the middleware rule above is what lets a supervisor work at a covered outlet.

## Tests (done = all green)

- Backend unit/integration: middleware header allowed/refused per role (covered, uncovered, legacy token,
  manager-"all", cashier); `scope()` never returns an empty outlet for a specific manager; sync attribution
  covered/uncovered; `ApproverCovers` and `ReceiveScope` covered/uncovered/"all"; user create/update
  validation table + `perm_version` bump on coverage or `allOutlets` change + a token issued before the change
  refused after; an unassigned manager (no outlet, flag off) refused everywhere incl. catalogue reads;
  manager-"all" refund/void in the combined view refused.
- Backoffice: user form (Kasir single required, Manajer all vs specific, utama limited to ticked), switcher
  visibility and list, active-outlet screens.
- POS: `terminalBinding` cases above.
- Existing suites unchanged and green; no guard weakened.

## Release (each step needs the owner's typed go-ahead)

Backend first (migration 0097 runs at deploy; additive; old clients keep working: an old POS compares the home outlet and stays
fail-closed), then Backoffice publish, then POS OTA. Then the owner sets coverage for their supervisors.

## Known follow-ups (not in this PR)

- Shift-open race: a shift open that waits on the user-row lock can still succeed after coverage was removed
  (pre-existing for home moves; same lock order).
- `GET/PUT /products/{id}/outlet-config` is gated only by `manage_products` and spans all outlets
  (pre-existing; a product-policy decision for the owner).

## Left to the builder

Claim name and encoding, the `Coverage` type's package and helper names, how coverage reaches context, query
shape for loading `user_outlets`, component structure of the form and switcher, exact test file layout.
