# Sales staff list ("Tim Sales") — design spec

Date: 2026-11-27. Status: draft for owner approval. Approach A (below) chosen by Claude under the
owner's standing "follow my recommendation" preference; the six policy answers are the owner's
(2026-11-27, this session).

## Why

The checkout "Sales (opsional)" picker on the POS lists every user account of the whole company
(it is built from `snapshot.users`, which the pull fills with `Read.Users` = all users, every
outlet, every role, with email, role, coverage and permissions). On the BSD tablet this shows
people like Rey SPV who never work at BSD. Shop sales staff also don't use the POS themselves, yet
today each must be a login account with email and password to be pickable. The customer rating
feature (live 2026-11-27, COO demo pending) credits ratings to the order's salesperson, so the
picker has to show the right people.

## Goals

- A Backoffice-managed list of sales staff: name, one or more outlets, active switch, optional link
  to a user account. No login, no email, no password.
- The POS picker shows only the **active** sales staff of the **tablet's outlet**, offline (cached in
  the snapshot like the rest of the pull).
- Tablets receive only `{id, name}` per salesperson, and stop receiving other users' email, role,
  coverage and permissions.
- Performa Sales keeps one row per person across old (user-id) picks and new (staff-id) picks.

## Non-goals

- No change to existing orders, ratings or receipt links (they keep their snapshotted
  `salesman_id` / `salesman_name`).
- No required-salesperson rule, no per-outlet "required" setting.
- No commission, targets, or schedules.
- No change to the rating page or the Backoffice Users edit dialog (parallel session owns
  `backend/internal/receiptlink/*` and the `Users.tsx` edit dialog).

## Anti-goals (would be a failure even if it works)

- A sale gets rejected or parked because of who was picked as salesperson.
- Managers or supervisors who never sell reappear in a picker automatically.
- A Manajer can see or change sales staff of outlets they don't cover.
- Past sales change name or lose their row in Performa Sales.

## Owner decisions (2026-11-27)

1. **Several outlets per person:** yes (ticked outlets, like Manajer coverage).
2. **Who appears:** only people on the list. Cashiers who also sell are added once and linked to
   their user account. No automatic inclusion of Kasir/Manajer.
3. **Migration:** yes. Every user account already picked as salesperson on a past order is copied
   in: linked to that account, at the outlets where they were picked, **switched off (Nonaktif)**
   (owner follow-up after the builder check: the test DB has demo picks of admins/managers/Rey SPV,
   so nobody wrong may appear on a tablet; the owner switches the real salespeople on in Tim
   Sales). Their old and new sales add up in one Performa Sales row.
4. **Required at checkout:** no, stays optional ("Tanpa sales" as today).
5. **Deactivation:** tablets drop a deactivated/removed person at their next sync. A held or open
   cart that already has them keeps the pick and is credited to them. The server never rejects a
   sale over the salesperson.
6. **Who manages:** admin, plus a new permission `manage_sales_staff` ("Kelola sales") given to
   Manajer by default and adjustable per role. A Manajer sees and edits only staff at outlets they
   cover and can only tick those outlets.
7. **Shared staff** (owner follow-up): a Manajer who does not cover *every* outlet of a person may
   only tick/untick their own outlets on that person. Name and the Aktif switch are read-only for
   them; their "Nonaktif" removes only their outlets (the person stays at the others). Admin, or a
   Manajer covering all of the person's outlets, may rename and switch the person off everywhere.

## Approaches considered

- **A. Separate `sales_staff` list (chosen).** New tables, own Backoffice page and permission, pull
  ships `{id,name}` for this outlet. Matches every owner answer; history untouched.
- **B. Login-less user accounts.** Reuses Users page and coverage, but mixes non-login people into
  auth, Users is admin-only (owner wants managers to edit), and each person would need a fake email.
- **C. Name list per outlet in outlet settings.** One person at two outlets becomes two entries,
  splitting their Performa Sales row; no place for the user link.

## Design

### Data (migration 0104, additive)

```
sales_staff (
  id          uuid PK default gen_random_uuid(),
  name        text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
  active      boolean NOT NULL DEFAULT true,
  user_id     uuid NULL UNIQUE REFERENCES users(id) ON DELETE SET NULL,
  created_at, updated_at timestamptz, created_by/updated_by uuid (audit, no FK)
)
sales_staff_outlets (
  staff_id  uuid REFERENCES sales_staff(id) ON DELETE CASCADE,
  outlet_id uuid REFERENCES outlets(id) ON DELETE CASCADE,
  PRIMARY KEY (staff_id, outlet_id)
)
index on sales_staff_outlets(outlet_id)
```

- One staff entry per user at most (`user_id UNIQUE`).
- **Name of a linked entry:** the stored `name` is the source for the picker and reports. When a link
  is made in Backoffice the name field is prefilled from the user's display name; it stays editable
  (Claude's call: a read-through name would make a Manajer unable to fix a name without the
  admin-only Users page).
- No hard delete in the UI: people are switched off (`active=false`). Claude's call — keeps
  Performa Sales names stable and matches MOKA "Nonaktif". The API may offer DELETE only for
  entries never used on an order; left to the plan whether to include it at all (default: no).
- **Duplicate names:** the server rejects creating/renaming/activating an entry whose trimmed,
  case-insensitive name equals another *active* entry that shares at least one outlet (the picker
  would show two identical names). 409 with an Indonesian message.
- **Data migration** (same migration, owner decision 3): for every distinct `orders.salesman_id`
  that matches a `users.id`, insert a `sales_staff` row (name = the user's current `display_name`,
  `active = false`, `user_id` = that user) and one `sales_staff_outlets` row per distinct `orders.outlet_id`
  where they were picked. Orders whose `salesman_id` matches no user are left alone (they keep
  their snapshot name in reports).
- **Permission grant** (owner decision 6), same pattern as 0092: insert `manage_sales_staff` into
  `user_permissions` for `users.role = 'manager'` and into `custom_role_permissions` for custom roles
  whose name matches `(manajer|manager)`. No `perm_version` bump (grant only).

### Backend API (OpenAPI first, regenerated types)

Under the authenticated group, `RequirePermission("manage_sales_staff")` (admin passes):

- `GET /sales-staff?outletId=&active=&q=` — list with outlets and linked user `{id, displayName}`.
  Scoped by the caller's coverage: a covering-some-outlets Manajer sees only entries that have at
  least one outlet they cover; outlets outside their coverage are summarised, not listed (P1).
- `POST /sales-staff`, `PUT /sales-staff/{id}` — name, active, outletIds (≥1), userId (nullable).
  A Manajer may only add/remove outlets they cover; outlets outside their coverage on an existing
  entry are preserved untouched. Decision 7 is enforced server side: a Manajer not covering every
  outlet of the entry gets 403 on a changed name/active/userId; their deactivation is sent as
  "remove my outlets". If that leaves the entry with no outlets, it is set inactive (an entry
  always keeps ≥1 outlet while active; an inactive entry may keep its outlets).
- `GET /sales-staff/linkable-users?outletId=` — `{id, displayName}` of users the caller may link:
  users whose coverage includes one of the caller's covered outlets and who are not linked yet.
  (Needed because `/users` is admin-only.)
- Validation: name 1–60 chars after trim, ≥1 outlet, outlets exist, linked user exists and is
  unlinked, duplicate-name rule above. Writes are audited (created_by/updated_by + existing audit log
  pattern if one applies).

### Pull (tablet sync)

- New field `salesStaff: [{id, name}]` = active entries linked to the pull's outlet, ordered by name.
- `users` shrinks to `[{id, displayName}]` of users whose coverage includes this outlet (admins and
  "Semua Outlet" managers included, since they also sign in at tablets). Its only POS reader after
  this change is `ownerLabel` (names the other cashier on a parked sync item), which falls back to
  the id when someone is missing. No email, role, coverage or permissions reach a tablet any more.
- Backward compatibility: a POS bundle older than the OTA ignores `salesStaff` and builds its
  picker from the trimmed `users` — which is already better than today (only this outlet's users).
  Release order: backend → Backoffice → POS OTA.
- Pull version: every staff write calls `bumpVersionOutlets` (`backend/internal/write/repo.go`,
  as giveaway and receipt templates do) for the union of the entry's old and new outlet sets, so a
  tablet at a removed outlet also drops the person. The data migration bumps nothing (all migrated
  entries are inactive).

### POS

- `CashierScreen` builds `salesmen` from `snapshot.salesStaff` when the field is present; falls back
  to `snapshot.users` only when it is absent (old server). Picker UI unchanged: the existing
  "Sales (opsional)" `<select>` with "— Tanpa sales —", hidden when the list is empty.
- A held cart, open-cart draft or void-replacement whose saved salesman is no longer in the list
  keeps the pick (owner decision 5). The `<select>` must still display that name (add it as an
  extra option when it isn't in the list) so the cashier sees who is credited and can change it.
- The sale payload is unchanged (`salesmanId`, `salesmanName`); new picks send the staff id.

### Performa Sales

- Grouping key per order: if `orders.salesman_id` equals some `sales_staff.user_id`, use that staff
  entry's id; otherwise use `orders.salesman_id` (a staff id, an unlinked user id, or none).
  Applies to both the sale and refund halves of `SalesPerformance` and to the `SalesRatings`
  `salesmanId` filter (filtering by a staff id must also match orders saved with its linked user id).
- Row name: the staff entry's current `name` when the key is a staff id; otherwise today's rule
  unchanged (`MAX(salesman_name)` of the orders, then `users.display_name`, then "Sales").
- Unlinking an entry later splits old user-id orders back into their own row — expected.

### Backoffice

- New page **"Tim Sales"** in the nav next to Pengguna, shown to admin and to holders of
  `manage_sales_staff` (`canSeeNav`). Table: Nama, Outlet (chips), Akun tertaut, Status (Aktif/
  Nonaktif). Filters: outlet, status, search. "Tambah sales" opens a dialog: Nama, Outlet
  checklist (only the caller's covered outlets), Tautkan ke akun (optional, from
  `linkable-users`), Aktif switch. Uses Backoffice design tokens and the existing dialog/table
  components; copy in Indonesian.
- Permission label and default (Claude's call after the builder check): add `manage_sales_staff`
  "Kelola sales" to the `PERMS` map in `apps/backoffice/src/screens/users/PermissionPicker.tsx` and
  to `permissionsForRole('manager')`, so it shows in the permission picker (custom roles and user
  permissions) and new Manajer accounts get it by default. This is a separate file from the
  `Users.tsx` edit dialog the parallel session owns; tell that session in the shared notes folder.
- Do not touch the `Users.tsx` edit dialog (parallel session).

## Constraints

- Offline-first: picker works from the cached snapshot; nothing here blocks a sale.
- Codegen gate: any new top-level Go test in `internal/api` or `internal/codegen` must be listed in
  `scripts/ci/codegen_gate.py`.
- Any `package.json` change ships with an updated `pnpm-lock.yaml`.
- Release needs the owner's go-ahead: backend (migration 0104) → Backoffice → POS OTA.
  No push to `prod-hardening`, no deploy from this work.

## Slices (one PR each, five gates green on a `gate/<name>` branch)

1. **Backend:** migration 0104 (tables, data migration, grants), OpenAPI + generated types, CRUD +
   linkable-users endpoints with coverage scoping, pull `salesStaff` + trimmed `users`, Performa
   Sales grouping, tests (incl. PostgreSQL integration).
2. **Backoffice:** Tim Sales page + nav + custom-role permission label.
3. **POS:** picker from `salesStaff`, keep-the-pick display, fallback for old servers, tests.

## Open points for the builder

- **P1** — how a Manajer sees an entry that also has outlets they don't cover: Claude's call = only
  covered outlet chips + "+N outlet lain", hidden ones preserved on save, name/Aktif read-only
  (decision 7) with a one-line note why.
- **P2** — whether staff edits need the generic audit log row in addition to created_by/updated_by.
- **Migration number:** 0104 unless another branch has taken it by merge time; renumber then.

## Known gaps

- A tablet that never takes the POS OTA (app version outside the OTA target) keeps the old picker
  logic on the trimmed `users` (this outlet's users, admins and "Semua Outlet" managers included)
  until it is updated. Better than today, not the final behaviour.
