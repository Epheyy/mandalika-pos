# Catalogue edits under outlet coverage — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A covered-only Manajer (manager, not "Semua Outlet") with `manage_products` can no longer change the shared catalogue, and can read/write the per-outlet product config only for outlets they cover.

**Architecture:** One middleware (`RequireCatalogueWide`) on the shared-catalogue write routes; the two outlet-config routes move to their own `manage_products`-only group and filter/refuse by `auth.CoverageFrom(ctx)` in the handlers; the write repo's size-cleanup takes an optional outlet scope. The Backoffice derives `canEditCatalogue(user)` and hides/locks controls.

**Tech Stack:** Go (chi, pgx), React + TypeScript (Vitest), Postgres gate via `scripts/ci/postgres_gate.py`.

**Spec:** `docs/plans/2026-11-24-catalogue-coverage-design.md`

**Base:** branch `claude/outlet-config-coverage` off `origin/feat/multi-outlet-coverage` (PR #162, unmerged).

## Global Constraints

- Catalogue-wide = `role == "admin"` OR (`role == "manager"` AND `auth.CoverageFrom(ctx).All`). Nobody else.
- Middleware 403 body: `Hanya admin atau Manajer Semua Outlet yang dapat mengubah katalog.`
- Outlet-config PUT naming an uncovered outlet: 403 `outlet not permitted` (same text as `canEditOutletID`), nothing written.
- Outlet-config PUT with an empty `items` from a covered-only caller: 400 `Pilih minimal satu outlet.`
- Backoffice note text: `Katalog hanya bisa diubah oleh admin atau Manajer Semua Outlet.`
- Admin and All-manager behaviour byte-for-byte unchanged (GET returns every active outlet; cleanup spans all outlets).
- No OpenAPI change, no migration, no POS change. Do not weaken any existing guard or test.

## Review Focus

1. Cashier with a custom role holding `manage_products` → must be refused by `RequireCatalogueWide` (coverage never All for cashier). Test in Task 1.
2. Covered-only PUT that lists only some sizes → must not delete another outlet's `outlet_variant_price` row. Test in Task 3 (gate).
3. Outlet id case differences (`Covers` is case-insensitive) → an upper-cased covered id is accepted, not 403. Test in Task 2.
4. Covered-only GET for a product → never returns an uncovered outlet row, even inactive-but-covered edge (inactive outlets are already excluded for everyone). Test in Task 2/3.
5. Covered-only Manajer opening an existing product in the Backoffice → Simpan must not call `updateProduct` (would 403 and abort before the outlet save). Test in Task 4.

---

### Task 1: `RequireCatalogueWide` middleware + route wiring

**Files:**
- Modify: `backend/internal/middleware/middleware.go` (next to `RequirePermission`)
- Modify: `backend/internal/server/server.go:234-248`
- Test: `backend/internal/middleware/catalogue_wide_test.go` (new)

**Interfaces:**
- Produces: `func RequireCatalogueWide() func(http.Handler) http.Handler`; also export the predicate `func CatalogueWide(ctx context.Context) bool` in `internal/auth` (file `backend/internal/auth/context.go`) so handlers reuse the same rule.

- [ ] **Step 1: Write the failing test** `TestRequireCatalogueWide`: table over (role, coverage) → expected code: admin/{} → 200; manager/{All:true} → 200; manager/{OutletIDs:[A]} → 403 with the exact body text; manager/{} → 403; cashier/{All:true} → 403 (a cashier is never catalogue-wide even if a forged coverage says All); "" → 403. Build the request context with `context.WithValue` on `auth.CtxRole` and `auth.CtxCoverage`.
- [ ] **Step 2: Run** `cd backend && go test ./internal/middleware -run TestRequireCatalogueWide` → FAIL (undefined).
- [ ] **Step 3: Implement** `auth.CatalogueWide(ctx)` (admin, or manager with `CoverageFrom(ctx).All`) and `RequireCatalogueWide()` using it, writing `httpx.Err(w, 403, <constant text>)`.
- [ ] **Step 4: Wire routes** in `server.go`: keep the existing `manage_products` group for `/products/import`, `POST /products`, `PUT/DELETE /products/{id}`, categories, `/uploads/sign`, `/settings/bundles` and add `r.Use(mw.RequireCatalogueWide())` after `RequirePermission`. Move `GET/PUT /products/{id}/outlet-config` into a new sibling group with only `mw.RequirePermission("manage_products")`. Keep `/products/import` registered before `/products/{id}`.
- [ ] **Step 5: Run** `go test ./internal/middleware ./internal/server/...` and `go vet ./...` → PASS. If a route-table/guard test exists in `internal/server` (grep `outlet-config` in `*_test.go`), update it to the new grouping.
- [ ] **Step 6: Commit** `feat(backend): catalogue writes need admin or all-outlets manager`

### Task 2: outlet-config handlers follow coverage

**Files:**
- Modify: `backend/internal/handlers/catalog.go:38-53`
- Modify: `backend/internal/write/catalog.go:503-587` (cleanup scope)
- Modify: `backend/internal/handlers/stock_seq_writers_integration_test.go:434` (new arg `nil`)
- Test: `backend/internal/handlers/outlet_config_coverage_test.go` (new, pure unit, no DB)

**Interfaces:**
- Consumes: `auth.CatalogueWide(ctx)` from Task 1, `auth.CoverageFrom(ctx).Covers(id)`.
- Produces:
  - `func filterOutletConfig(rows []api.OutletVariantConfig, cov coverage.Coverage) []api.OutletVariantConfig` (handlers pkg; returns a new slice, never nil).
  - `func uncoveredOutlet(items []api.OutletConfigItemInput, cov coverage.Coverage) (string, bool)` (first uncovered outlet id).
  - `func (r *Repo) SetProductOutletConfig(ctx context.Context, productID string, items []api.OutletConfigItemInput, cleanupOutlets []string) error` — `cleanupOutlets == nil` = cleanup across all outlets (today's behaviour); non-nil = both cleanup DELETEs add `AND outlet_id = ANY($3::uuid[])`.

- [ ] **Step 1: Failing unit tests**: `TestFilterOutletConfig` (rows for A,B,C; cov {A,B} → only A,B rows in order; cov {All} → all rows; cov {} → empty non-nil). `TestUncoveredOutlet` (cov {A}: items [A, B] → "B", true; items [upper(A)] → "", false; items [] → "", false).
- [ ] **Step 2: Run** `go test ./internal/handlers -run 'TestFilterOutletConfig|TestUncoveredOutlet'` → FAIL.
- [ ] **Step 3: Implement** the two helpers; in `GetProductOutletConfig`, when `!auth.CatalogueWide(ctx)`, return `filterOutletConfig(rows, auth.CoverageFrom(ctx))`. In `PutProductOutletConfig`, when `!auth.CatalogueWide(ctx)`: empty items → 400 `Pilih minimal satu outlet.`; any uncovered → 403 `outlet not permitted`; else call the repo with `cleanupOutlets` = the distinct outlet ids of the covered caller's coverage (`cov.OutletIDs`). Catalogue-wide callers pass `nil`.
- [ ] **Step 4: Change the repo signature** and the scoped cleanup; update the one existing test caller to pass `nil`.
- [ ] **Step 5: Run** `go build ./... && go vet ./... && go test ./internal/handlers ./internal/write` → PASS (DB-gated tests skip without their env).
- [ ] **Step 6: Commit** `feat(backend): outlet-config reads and writes follow outlet coverage`

### Task 3: Postgres gate subtest

**Files:**
- Modify: `backend/internal/handlers/outlet_coverage_integration_test.go` (new `t.Run` at the end of `TestOutletCoveragePostgres`)

**Interfaces:** Consumes everything above. Use the existing `h`, `withCtx`, `mgr1` (covers outA+outB) / `mgr2` (All) fixtures; add a third outlet `outC` and a covered-only manager `mgr5` covering only `outA` (new UUIDs in the `8f20` range not yet used).

- [ ] **Step 1: Write subtest** `"catalogue edits follow coverage"`: product with sizes `50ml`,`100ml`; price overrides at outA and outC for both sizes. Router with the real middleware chain: `RequireCatalogueWide` on `PUT /products/{id}`, plain handlers for outlet-config GET/PUT. Assert:
  - mgr5 GET outlet-config → only outA rows.
  - mgr5 PUT naming outC → 403 `outlet not permitted`; outC overrides unchanged.
  - mgr5 PUT `[]` → 400.
  - mgr5 PUT outA with only `50ml` → 200; outC's `100ml` override still present (the cross-outlet wipe is closed); outA's `100ml` override is gone (cleanup still runs inside the caller's own outlets).
  - mgr5 `PUT /products/{id}` → 403 with the exact constant text.
  - mgr2 (All) GET → outA, outB, outC rows; mgr2 `PUT /products/{id}` passes the middleware (not 403).
- [ ] **Step 2: Run** the gate locally: `python scripts/ci/postgres_gate.py --only OCV` (check the script's flags; if it has none, run the documented command from its header). Expected PASS. If Postgres binaries are unavailable locally, say so and rely on CI.
- [ ] **Step 3: Commit** `test(backend): coverage gate covers catalogue edits`

### Task 4: Backoffice locks the catalogue for covered-only Manajer

**Files:**
- Modify: `apps/backoffice/src/lib/navAccess.ts` (add helper) + `navAccess.test.ts`
- Modify: `apps/backoffice/src/screens/products/ProductsListView.tsx`, `ProductsTable.tsx` (add/import/delete controls)
- Modify: `apps/backoffice/src/screens/products/ProductEditorHost.tsx`, `ProductFormSlideOver.tsx`, `VariantRows.tsx`, `useProductEditor.ts` (locked mode, save path)
- Modify: `apps/backoffice/src/screens/products/CategoriesView.tsx`, `CategoriesTable.tsx`, `BundleSettingsPanel.tsx` (view-only)
- Test: `apps/backoffice/src/screens/products/catalogueLocked.test.tsx` (new; static-markup style like `erpReadOnly.test.tsx`)

**Interfaces:**
- Produces: `export function canEditCatalogue(user: NavUser | null): boolean` — admin → true; manager with `allOutlets` → true; else false. Mirrors `auth.CatalogueWide`.
- Components take a `catalogueLocked: boolean` prop (true = view-only) rather than reading auth themselves; the screen roots (`ProductsListView`, `CategoriesView`, `BundleSettingsPanel`, `ProductEditorHost`) compute it once from `useAuth().user`.

- [ ] **Step 1: Failing tests**: `canEditCatalogue` cases (admin; manager allOutlets; manager with outletIds; cashier; null). Static-markup tests: `ProductFormSlideOver` with `catalogueLocked` → name/category/variant inputs disabled, no image upload button, no delete; outlet-config inputs still enabled; the note text present. `useProductEditor` save in locked mode calls `api.updateProductOutletConfig` and never `api.updateProduct` (mock `api`).
- [ ] **Step 2: Run** `corepack pnpm --filter backoffice test -- catalogueLocked navAccess` → FAIL.
- [ ] **Step 3: Implement**: hide "Tambah Produk", Import and Hapus when locked; editor locked mode (reuse the ERP read-only disabling approach, do not change ERP rules); in locked mode `save()` skips validation of shared fields and `updateProduct`, and sends only the outlet-config items (skip the call if there are no outlets); Categories and Bundle panels hide add/edit/delete/save and show the note.
- [ ] **Step 4: Run** `corepack pnpm --filter backoffice test` and `corepack pnpm --filter backoffice typecheck` (or the repo's equivalent script names) → PASS.
- [ ] **Step 5: Commit** `feat(backoffice): catalogue is view-only for covered-only managers`

### Task 5: Gates, HANDOFF, PR

- [ ] Run `corepack pnpm quality:ci` and backend `go test ./...` → green.
- [ ] Update the coverage spec's "Known follow-ups" line to point at this design; add a short HANDOFF entry.
- [ ] Opus review of the whole branch (auth-touching); fix CRITICAL/HIGH.
- [ ] Push, open PR against `feat/multi-outlet-coverage` (retarget to `prod-hardening` after #162 merges).
