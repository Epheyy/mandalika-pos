# Catalogue edits under outlet coverage — design

Date: 2026-11-24. Follow-up to `2026-11-23-multi-outlet-coverage-design.md` ("Known follow-ups": outlet-config spans all outlets).

## Owner decision (2026-11-24)

Asked: may a Manajer with "Kelola Produk" (`manage_products`) who covers only some outlets change the per-outlet
section (outlet price override + availability) of other outlets, and the shared product record?

Answer: **limit both.**

- **Catalogue-wide** = admin, or a Manajer set to "Semua Outlet" (`coverage.All`). Unchanged behaviour.
- **Covered-only** = a Manajer with specific outlets ticked. With `manage_products` they:
  - may read and change the per-outlet price override and availability **only for outlets they cover**;
  - may **not** change the shared catalogue: create/edit/delete products, CSV import, image upload,
    create/edit/delete categories, bundle prices. Those become view-only for them.

Why: since coverage landed, a covered Manajer is meant to act only on their outlets. The shared product record
(name, base price, variants) applies to every outlet, so editing it is an all-outlets action.

## Approaches considered

1. **Chosen: a "catalogue-wide only" middleware on the shared-catalogue write routes, plus coverage filtering in
   the outlet-config handlers.** One rule in one place; the outlet-config routes move to their own group gated by
   `manage_products` only.
2. Per-handler checks in each catalogue handler. Rejected: scattered, easy to miss a route.
3. A new permission (e.g. `manage_catalogue`). Rejected: the owner tied the rule to coverage, and a new permission
   would need every existing role re-ticked.

## Server

- New middleware `RequireCatalogueWide`: passes for role `admin` or `auth.CoverageFrom(ctx).All`; otherwise 403
  "Hanya admin atau Manajer Semua Outlet yang dapat mengubah katalog." Applied (after `RequirePermission("manage_products")`)
  to: `POST /products/import`, `POST /products`, `PUT /products/{id}`, `DELETE /products/{id}`, `POST /categories`,
  `PUT /categories/{id}`, `DELETE /categories/{id}`, `POST /uploads/sign`, `PUT /settings/bundles`.
- `GET /products/{id}/outlet-config` (`manage_products` only): a covered-only caller gets only rows for outlets
  they cover; catalogue-wide callers get every active outlet (unchanged).
- `PUT /products/{id}/outlet-config` (`manage_products` only), covered-only caller:
  - 403 if any item names an outlet they do not cover (whole request refused, nothing written);
  - 400 on an empty item list;
  - the size-cleanup deletes (rows for sizes not in the payload) run only within the caller's covered outlets.
    Today they run across every outlet, so a partial payload wipes other outlets' price overrides.
  - Catalogue-wide callers: unchanged (cleanup spans all outlets as before).

## Backoffice (covered-only Manajer)

- Produk: no "Tambah Produk", no Import, no Hapus. The editor opens with the shared fields locked (name, category,
  images, variants, base price, flags); only the per-outlet section is editable and shows only their outlets
  (the server already filters). Simpan sends only the outlet-config PUT.
- Kategori and Bundle tabs: view-only (no add/edit/delete, no bundle-price save).
- One note on those screens: "Katalog hanya bisa diubah oleh admin atau Manajer Semua Outlet."
- The UI only hides; the server enforces.

## Not changed

Recipes, promotions, inventory and catalogue reads (POS sync, product lists) keep their own permissions and scope.

## Tests

- Go unit: middleware pass/deny matrix (admin, All manager, covered manager, cashier); outlet-config filter and
  refusal.
- Postgres gate `TestOutletCoveragePostgres` subtest: covered manager sees only covered rows; PUT naming an
  uncovered outlet is 403 and writes nothing; partial PUT does not touch another outlet's price override;
  product edit is 403; All manager still edits.
- Backoffice: helper `canEditCatalogue` unit test; editor and lists render locked for a covered-only Manajer.

## Release

Stacked on PR #162 (multi-outlet coverage, not merged yet). Ships with it: backend first, then Backoffice. No
migration, no POS change.
