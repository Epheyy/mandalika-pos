# Bundle price groups ("Kelompok Harga") — design spec

Date: 2026-11-28. Status: draft for owner approval. The four policy answers are the owner's
(2026-11-28, this session). Approach A was chosen by Claude under the owner's standing "follow my
recommendation" preference. Mock: `docs/plans/2026-11-28-bundle-price-groups/mock.html`.

## Why

The owner's company has 12 outlets that charge more for **bundles** (large bottle + 10ml atomizer
+ 2ml vial of the same line) than the other outlets. Single product prices are the same everywhere.
Today bundle prices are global: `bundle_prices` (migration 0089) has `PRIMARY KEY (line, size)`
with no outlet dimension, so a premium outlet cannot sell a bundle at its own price.

## Goals

- Price groups ("Kelompok Harga"), starting with **Standar** (default) and **Premium**.
- Every outlet belongs to exactly one group. New outlets, including ones the ERP pull creates,
  are in Standar without anyone touching them.
- Produk › Bundle shows one price column per group: the standard price per size plus optional
  per-line prices, for every group.
- Produk › Bundle has an "Outlet per kelompok" list where the 12 premium outlets are moved to
  Premium in one save.
- The owner (admin) can rename groups, add a group (a new column appears) and delete an empty
  group.
- The server, the tablet's bundle list (pull snapshot) and the server's sale validation all use
  the prices of the outlet's group.

## Non-goals

- Single product prices (`outlet_variant_price`) are not touched. Only bundles differ by group.
- No per-outlet bundle prices (outlets inherit their group's prices, nothing more).
- No change to how a bundle forms (large bottle in EXT / PERFUME INTENSE + 10ml ATOMIZER + 2ml of
  the same line), to Diskon Bundle, to refunds (whole bundle only) or to the ERP split.
- No price history or scheduled price changes.
- No change to the POS app (see "Tablet impact").

## Anti-goals (a failure even if it works)

- A Premium outlet sells a bundle at the Standar price because its tablet did not re-pull after
  the outlet was moved or a Premium price changed.
- A save from an old Backoffice tab (or the old Backoffice during the release window) wipes the
  Premium prices or the outlet assignments.
- A premium outlet stops offering a bundle it sold yesterday because one Premium field was left
  empty.
- A manager moves their own outlet to a cheaper group.

## Owner decisions (2026-11-28)

1. **Price rule: "Premium, else Standar".** For an outlet in group G:
   - if G has a standard price for size S, the bundle (line L, size S) costs G's line price for
     (L, S) when set, else G's standard price for S;
   - if G has no standard price for S, the outlet uses the Standar prices for S exactly as today
     (Standar line price for (L, S) when set, else the Standar standard price for S).
   - Example: Standar 120ml Rp1.200.000, Standar Extrait 120ml Rp1.500.000; Premium 120ml
     Rp1.400.000, no Premium Extrait price → Premium outlet sells Extrait 120ml at Rp1.400.000.
     With no Premium 120ml price at all → Rp1.500.000 (all Standar).
   - Consequence (and why the owner picked it): every bundle Standar sells is still sold at every
     outlet; a group only changes prices, it never adds or removes bundle sizes.
2. **Assignment: a list on the Bundle tab** ("Outlet per kelompok"), saved together with the prices.
   Not on the outlet form.
3. **Groups can be renamed and added** by the owner in the Backoffice.
4. **Admin only** may change anything here (prices of every group, outlet assignment, group
   rename/add/delete). This is a tightening: today a "Semua Outlet" Manajer with Kelola Produk can
   edit bundle prices; after this they see the tab read-only. Everyone who can open Produk can still
   see the prices.

## Calls made by Claude (owner may correct)

- **Group limits:** at most 5 groups; name trimmed, 1–40 characters, unique ignoring case.
- **Standar is the default group:** it can be renamed, never deleted. There is always exactly one
  default group.
- **Delete:** only a group with no outlets can be deleted; its prices are deleted with it.
- **A group's standard price needs a Standar standard price for that size** (the Standar sizes are
  the bundle sizes, decision 1). A group's line price needs that group's standard price for that
  size (the same rule the Standar column has today). Removing a Standar size that another group
  still prices is refused, naming the group.
- **Outlet list shows every outlet**, active first, inactive ones marked "Nonaktif" but assignable
  (ERP-pulled outlets start inactive and can be put in a group before they open).
- **The "Aroma yang punya bundle" list** keeps showing Standar prices, and its subtitle says so.
- **Renaming a group does not touch tablets** (tablets never see group names).

## Approaches

- **A. Price groups as data (chosen).** New `price_groups` table; `outlets.price_group_id`
  (empty = default group); `bundle_prices` gains `group_id` and its key becomes
  `(group_id, line, size)`. The server resolves an outlet's effective prices from its group plus
  Standar. A third group is a row, and the screen grows a column with no code change.
- **B. A second table for non-Standar prices** (`bundle_prices` stays Standar-only). Smaller
  migration, but two places hold one concept and group rename/add would need code per group. Does
  not fit decision 3.
- **C. Per-outlet bundle prices, no groups.** 12× data entry and no shared "Premium" price;
  contradicts the accepted direction.

## Design

### Data (migration 0105, additive)

- `price_groups (id uuid PK, name text NOT NULL, is_default boolean NOT NULL DEFAULT false,
  sort_order int NOT NULL, created_at, updated_at)`; unique index on `lower(name)`; partial unique
  index allowing one `is_default = true` row. Seeded with Standar (default, sort 0) and Premium
  (sort 1).
- `outlets.price_group_id uuid NULL REFERENCES price_groups(id)` (no default, nullable: adding it
  does not rewrite `outlets`). **NULL means the default group.** Writes store NULL when an outlet is
  put in the default group, so there is one representation per state.
- `bundle_prices.group_id uuid REFERENCES price_groups(id) ON DELETE CASCADE`: backfill every
  existing row to Standar, then `NOT NULL`, then primary key `(group_id, line, size)`. The table has
  a handful of rows. Standar is seeded with a **fixed UUID** that is also the column's `DEFAULT`, so
  an older backend's `INSERT (line, size, price, updated_by)` still lands in Standar (rollback
  safety).
- `SET LOCAL lock_timeout = '5s'` as in 0089.

### Effective prices (Go, pure, `internal/bundles`)

A pure function builds the effective `bundles.Prices` for a group from the Standar prices and the
group's own prices:

1. Start from a copy of Standar (`Standard` and `Lines`).
2. For each size S the group prices (S is always one of Standar's sizes): set `Standard[S]` to the
   group's price and drop every Standar line price for S.
3. Add the group's line prices.

`PriceFor`, `Classify` and `Derive` stay unchanged and receive the effective prices, so the bundle
sizes are always Standar's (decision 1). The default group's effective prices are the Standar prices
themselves. Golden unit tests cover the owner's example, an empty group, a group with only some sizes,
line overrides on both sides, and the default group.

`LoadPrices` gains the outlet: it reads the outlet's group (`COALESCE(price_group_id, default)`)
and the needed price rows in the caller's transaction or pool and returns the effective prices.
An unknown or empty outlet ID resolves to Standar.

Callers:
- `read.BundleCatalog` with a tablet scope (`sc.OutletID`) → effective prices of that outlet
  (pull snapshot `BundleCatalog`, `internal/sync/pull.go`).
- `read.BundleCatalog` with `CrossAll` (Backoffice aroma list) and `read.BundleSettings`' line lookup
  → Standar.
- `service.resolveSetBundles` → effective prices of `in.OutletID`, inside the sale transaction, so
  the price check and the split use the outlet's group.

### Sale validation, offline sales, refunds, ERP

- Online sale: the tablet's bundle price must match the server's effective price for that outlet;
  a mismatch is the existing 422 (same as after a Standar price edit today).
- Offline sale captured under the old group or old price: kept as captured and flagged, exactly as
  after a Standar price edit today (existing `priceSetBundle` / `resolveSetBundles` path). A test
  covers a sale captured at the Standar price, synced after its outlet moved to Premium.
- Diskon Bundle, the whole-bundle refund group and the ERP split are computed from the bundle price
  the order carries and the outlet's single prices. They need no change; tests confirm the split of
  a Premium-priced bundle.

### Tablet impact (no POS change, no OTA)

The tablet never reads bundle price settings: it takes `offer.price` from the per-outlet
`BundleCatalog` in its pull snapshot, and a held cart is re-priced from today's offer
(`heldRestore.ts`). Serving the group's prices in that catalog is enough.

Tablets must re-pull when their prices change:
- Saving prices bumps the `bundle_prices` content version for every outlet (as today).
- Moving outlets between groups bumps the `bundle_prices` content version for the moved outlets
  only (`bumpVersionOutlets`).
- Deleting an empty group and renaming need no bump.

### API (exact shapes settled in the plan; generated types regenerate)

- `GET /api/v1/settings/bundles` (unchanged route and access) keeps `standard`, `linePrices` and
  `lines` as today (= Standar, so the old Backoffice still reads correctly) and adds:
  - `groups[]`: id, name, isDefault, outletCount, standard[], linePrices[] for every group, in sort
    order;
  - `outlets[]`: outletId, name, code, isActive, groupId (the default group's id when NULL).
- `PUT /api/v1/settings/bundles` becomes **admin only** (`RequireRole("admin")`, replacing
  `manage_products` + catalogue-wide).
  - **Old body** (`standard`, `linePrices`, no `groups`): replaces the **Standar** prices only.
    Other groups' prices and outlet assignments are never touched. A test proves an old-shape save
    leaves Premium rows and assignments intact.
  - **New body**: per-group prices (each listed group's prices are replaced; groups not listed are
    untouched) and optional outlet assignments (`outletId` → `groupId`, only listed outlets change).
    One transaction; content versions bumped as above.
  - Validation messages are Indonesian and shown verbatim, as today (existing rules per group, plus
    the cross-group rules under "Calls made by Claude").
- `POST /api/v1/price-groups` (name), `PUT /api/v1/price-groups/{id}` (rename),
  `DELETE /api/v1/price-groups/{id}` (409 when it is the default group or still has outlets):
  admin only. Group rename/add/delete happen at once from a small dialog, not via the save bar.
- Cached GET responses are invalidated by every one of these writes.
- New top-level Go tests in `internal/api` or `internal/codegen` are listed in
  `scripts/ci/codegen_gate.py`.

### Backoffice (Produk › Bundle), see the mock

Top to bottom:

1. **Kelompok harga** card: one chip per group with its outlet count; admin sees "Tambah kelompok"
   and, per group, rename and delete (delete disabled with a reason for Standar or a group with
   outlets).
2. **Harga bundle** table (replaces the two price cards): rows are the standard price per size
   ("Semua lini · 100ml" …) then each ERP line per size ("Extrait · 120ml" …); one column per group.
   An empty cell shows the price that applies as its placeholder (e.g. "= Rp 1.200.000 (Standar)"),
   computed with the same rule as the server. A Premium line cell is disabled until that group has
   a standard price for the size (with a hint).
3. **Outlet per kelompok** list: outlet name, code, Nonaktif badge, a group select per row, a search
   box and a filter by group.
4. **Aroma yang punya bundle** list: unchanged, subtitle notes "harga Standar".
5. One SaveBar for prices and assignments ("Harga bundle", "Kelompok outlet" as change items).

Non-admins (including "Semua Outlet" managers) see everything read-only with a note
"Hanya admin yang bisa mengubah harga bundle." The TS effective-price helper mirrors the Go one
and shares its golden cases.

## Release

1. Backend with migration 0105 first. The old Backoffice keeps working: its GET fields are
   unchanged and its PUT (old body) changes Standar only. Its save button now returns 403 for
   "Semua Outlet" managers, which is the intended rule (decision 4).
2. Backoffice second.
3. No POS OTA.
4. After release the owner moves the 12 outlets to Premium and fills the Premium prices. Until then
   every outlet sells at Standar, exactly as today.

Rollback: the previous backend revision ignores the new column and table. Caveat: it reads every
`bundle_prices` row as if it were Standar, so with Premium rows present an older backend would mix
them. A rollback after Premium prices exist therefore needs those rows deleted first; the plan
writes the one-line SQL into the release note.

## Verification

- Go unit tests (effective prices, validation), PostgreSQL integration tests (migration backfill,
  old-shape PUT, assignment bump, sale validation at a Premium outlet online and offline, ERP split),
  Backoffice unit tests (form, placeholders, save payload), all five CI gates on a `gate/` branch.
- Render the new Bundle tab on the local stack (localhost, test data) and compare it side by side
  with the mock before calling the Backoffice slice done.
