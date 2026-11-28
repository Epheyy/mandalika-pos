# Bundle price groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Outlets belong to a price group ("Kelompok Harga", Standar default + Premium). Bundle prices are stored per group, and every outlet sells at its group's prices under the rule "Premium, else Standar". The pull, sale validation and the Backoffice all follow that rule. An admin edits every group's prices, moves outlets between groups and adds, renames or deletes groups on Produk › Bundle.

**Architecture:** Migration 0105 adds `price_groups`, `outlets.price_group_id` (NULL = default group), `bundle_prices.group_id` (PK `(group_id, line, size)`, DEFAULT = fixed Standar UUID) and a one-row `bundle_price_revision` table for stale-save detection. The pure `bundles.Effective(standar, group)` builds an outlet's prices. `bundles.LoadPrices(ctx, q, outletID)` resolves the outlet's group and returns the effective prices to the pull catalog and the sale path. `PUT /settings/bundles` is admin-only and keeps the old body working; it replaces only Standar plus any listed groups, assigns only listed outlets, and checks a revision. New admin-only `/price-groups` endpoints handle groups. In the Backoffice, Produk › Bundle is rebuilt per the mock, with a TS twin of `Effective` that shares the Go golden file.

**Tech Stack:** Go (chi, pgx, oapi-codegen via `go run ./cmd/codegen`), PostgreSQL 18, OpenAPI → `openapi-typescript` (`packages/api`), React + Tailwind (Backoffice), Vitest.

**Spec:** `docs/plans/2026-11-28-bundle-price-groups-spec.md` (approved 2026-11-28; owner decisions 1-4 are binding). Mock: `docs/plans/2026-11-28-bundle-price-groups/mock.html`.

## Global Constraints

- Migration **0105** (`backend/internal/db/migrations/0105_bundle_price_groups.sql`). It is additive and starts with `SET LOCAL lock_timeout = '5s';` as in 0089.
- Fixed UUIDs: Standar `5ad7a12d-0000-4000-8000-000000000001` (default, sort 0), Premium `5ad7a12d-0000-4000-8000-000000000002` (sort 1). The Standar UUID is the `DEFAULT` of `bundle_prices.group_id`.
- Go code never hard-codes the Standar UUID outside tests. SQL finds the default group with `is_default` (`write` may not import `bundles`; see `backend/internal/archtest/arch_test.go`).
- `outlets.price_group_id` is **NULL = default group**. Writes store NULL when an outlet goes to the default group. Before comparing groups, normalize with `COALESCE(price_group_id, <default id>)`.
- Price rule "Premium, else Standar". If group G prices size S, it uses G's line price for (L,S) when set, else G's standard S. If G does not price S, Standar's rules for S apply. Group sizes that are not Standar sizes are ignored. Group line prices for a size the group does not price are ignored.
- Groups: **at most 5**. Name is trimmed, **1-40 characters** (runes), unique ignoring case. Standar can be renamed and never deleted. Only a group with no outlets can be deleted, and its prices go with it.
- **Admin only** for `PUT /settings/bundles`, `POST /price-groups`, `PUT /price-groups/{id}`, `DELETE /price-groups/{id}`. A refusal is a 403 with `Hanya admin yang bisa mengubah harga bundle.` `GET /settings/bundles` keeps today's access (any signed-in user).
- Content version resource `"bundle_prices"`. Any saved price change calls `bumpVersion` (all outlets). Outlets whose effective group changed get `bumpVersionOutlets` (moved outlets only). Group create, rename and delete cause no bump.
- Stale save: PUT carries `revision`. A mismatch is a **409** with `Harga bundle sudah diubah orang lain. Muat ulang.` Every successful PUT (old or new body) advances the revision and returns it. Group endpoints lock the revision row but do not advance it.
- Old PUT body (`standard` + `linePrices`, no `groups`/`outletGroups`) replaces **Standar rows only** and never touches other groups or assignments.
- Error copy, shown verbatim (status → text):
  - 400 `Revisi harga bundle wajib dikirim. Muat ulang.`
  - 400 `Kelompok harga tidak ditemukan. Muat ulang.`
  - 400 `Outlet tidak ditemukan. Muat ulang.`
  - 400 `Harga kelompok default dikirim lewat standard dan linePrices.`
  - 400 `Kelompok %s dobel`
  - 400 `Outlet dobel di daftar kelompok`
  - 400 `Harga %s %s butuh harga %s %s` (group, size, default-group name, size)
  - 400 `Ukuran %s masih punya harga di kelompok %s. Hapus harga itu dulu.`
  - 400 `Harga lini %s %s butuh harga standar %s %s` (non-default group; the default group keeps today's `Harga lini %s butuh harga standar %s`)
  - 400 `Nama kelompok wajib diisi`
  - 400 `Nama kelompok maksimal 40 karakter`
  - 409 `Nama kelompok sudah dipakai`
  - 409 `Maksimal 5 kelompok harga`
  - 409 `Kelompok default tidak bisa dihapus`
  - 409 `Kelompok %s masih dipakai %d outlet. Pindahkan outletnya dulu.`
  - 404 `not found` (unknown group id on rename/delete)
- Backoffice copy:
  - read-only note `Hanya admin yang bisa mengubah harga bundle.`
  - card titles `Kelompok harga`, `Harga bundle`, `Outlet per kelompok`, `Aroma yang punya bundle`; other strings verbatim from the mock
  - SaveBar items `Harga bundle`, `Kelompok outlet`
  - placeholders `= Rp 1.050.000 (Standar)` (another group's fallback) and `= Rp 1.250.000` (same column)
  - hints `Isi harga Premium 100ml dulu` / `Isi harga Standar 100ml dulu`
  - delete reasons `Kelompok default tidak bisa dihapus` / `Pindahkan 12 outlet dulu`
  - the `Nonaktif` badge
- Shared golden file: `backend/internal/bundles/testdata/effective_golden.json`, read by Go and by the Backoffice test (same pattern as `split_golden.json`).
- New Postgres subtests go into the existing `TestBundlesPostgres` (prefix `BN`, port `26481`); no new gate. Run locally with `python scripts/ci/postgres_gate.py --only BN --output <scratch>/pg-bn.json` (Docker), or add `--runtime native --pg-bin <pg18.3/bin> --no-race`.
- Do not add top-level tests in `backend/internal/api` or `backend/internal/codegen`. If one is added, list it in `scripts/ci/codegen_gate.py` (`CONTRACT`/`GUARD`).
- OpenAPI: never put `nullable: true` on a `$ref` (openapi-typescript drops it). New optional fields are plain optional, not nullable.
- Any `package.json` change ships with `pnpm-lock.yaml` (none planned).
- Write handlers end in `h.mutated` / `h.created` (cache invalidation) or call `h.invalidate(r)` before writing a custom success body.
- No POS app change, no OTA. Never push `prod-hardening`, never deploy, never merge. Slice 1 branch `claude/bundle-price-groups`, gate `gate/bundle-price-groups-backend`. Slice 2 branch `claude/bundle-price-groups-backoffice` (stacked on slice 1), gate `gate/bundle-price-groups-backoffice`.
- Every commit message ends with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Docs-only commits start with `[CF-Pages-Skip] [skip ci]`.

## Review Focus

1. **Stale-save false positives and negatives.** A second save from the same tab must pass: it adopts the revision the PUT returned. So must a save after a group dialog write, because group writes don't advance the revision. Two tabs loaded at the same revision: the second save gets a 409. An old-body PUT advances the revision, so a new tab loaded before it gets a 409. → Task 7 subtest `revision_cas`; Task 12 tests `adopts the saved revision` and `merge after a group write keeps the revision`.
2. **An old-body PUT (old Backoffice during the release window) must not wipe Premium rows or assignments.** Today's code runs `DELETE FROM bundle_prices`. → Task 7 subtest `old_body_keeps_premium`.
3. **The cross-group rule is checked on the merged post-save state.** Dropping Standar 100ml and Premium 100ml in one save passes. An old-body save dropping only Standar 100ml is refused with `Ukuran 100ml masih punya harga di kelompok Premium. Hapus harga itu dulu.`. A listed Premium 130ml with no Standar 130ml is refused with `Harga Premium 130ml butuh harga Standar 130ml`. → Task 7 unit `TestValidateBundleGroups` + subtest `cross_group_merged_state`.
4. **Outlet-move bumps.** Moving an outlet from NULL to Standar is not a move: no bump, still NULL. A move to Standar stores NULL. Only moved outlets are bumped, and an assignment-only save with unchanged prices does not bump every outlet. → Task 7 subtest `assign_bumps_moved_only`.
5. **Premium outlet vs a tablet still on Standar prices.** An online sale at the Standar price is a 422 (`Harga bundle sudah berubah. Tunggu katalog tersinkron lalu ulangi.`). A synced sale captured at the Standar price before the move is kept at the tablet price and flagged `bundle_price_changed`. A synced sale at the Premium price splits like any other bundle (shares = `Split(950000, basis)`, summing to 950000). A Standar outlet never sees Premium rows. → Task 3 subtest `effective_prices_by_outlet`, Task 4 subtests `premium_*`, Task 2 golden `premium_ext_120` in `split_golden.json`.

---

## Slice 1 — Backend (`claude/bundle-price-groups`)

### Task 1: Migration 0105 (price groups, group column, revision row)

Reviewer: **Opus** (feeds sale validation and the pull).

**Files:**
- Create: `backend/internal/db/migrations/0105_bundle_price_groups.sql`
- Create: `backend/internal/handlers/bundle_price_groups_integration_test.go` (holds `bundlePriceGroupMigrationSubtest`; later tasks add `bundlePriceGroupSubtests`)
- Modify: `backend/internal/handlers/bundles_integration_test.go` (call `bundlePriceGroupMigrationSubtest(t, pool, ctx)` right after the fixture seed, **before** `lines_before_any_price`)

**Interfaces (Produces):**
- `price_groups(id uuid PK DEFAULT gen_random_uuid(), name text NOT NULL CHECK (name = btrim(name) AND char_length(name) BETWEEN 1 AND 40), is_default boolean NOT NULL DEFAULT false, sort_order int NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`
- `UNIQUE INDEX price_groups_name_lower ON price_groups (lower(name))`
- `UNIQUE INDEX price_groups_one_default ON price_groups (is_default) WHERE is_default`
- seeds: Standar and Premium with the fixed UUIDs
- `outlets.price_group_id uuid NULL REFERENCES price_groups(id)` (no default, so no table rewrite)
- `bundle_prices.group_id uuid NOT NULL DEFAULT '5ad7a12d-0000-4000-8000-000000000001' REFERENCES price_groups(id) ON DELETE CASCADE`. The constant default fills existing rows, so it doubles as the backfill to Standar.
- `bundle_prices` PK (`bundle_prices_pkey`) swapped to `(group_id, line, size)`
- `bundle_price_revision(id boolean PRIMARY KEY DEFAULT true CHECK (id), revision bigint NOT NULL)`, seeded `(true, 1)`

- [ ] **Step 1: Write the failing test** `bundlePriceGroupMigrationSubtest` → `t.Run("price_groups_migration", ...)`:
  - `SELECT id::text, name, is_default, sort_order FROM price_groups ORDER BY sort_order` returns exactly `[(5ad7a12d-…0001, Standar, true, 0), (5ad7a12d-…0002, Premium, false, 1)]`
  - the `bundle_prices.group_id` `column_default` (information_schema) contains the id of `SELECT id FROM price_groups WHERE is_default`
  - `outlets.price_group_id` has `is_nullable = 'YES'` and a NULL `column_default`
  - the `bundle_prices` PK columns (from `pg_index` + `pg_attribute`) are `group_id, line, size` in that order
  - rollback-safety pin: `INSERT INTO bundle_prices(line,size,price,updated_by) VALUES('','130ml',1,NULL)` lands in the default group (delete it afterwards)
  - in a transaction that is rolled back: a second `is_default=true` row fails with 23505; the name `'standar'` fails with 23505; deleting Premium cascades a Premium `bundle_prices` row
  - `SELECT revision FROM bundle_price_revision` = 1
- [ ] **Step 2: Run** `python scripts/ci/postgres_gate.py --only BN --output <scratch>/pg-bn.json`. Expected: FAIL (`price_groups` missing).
- [ ] **Step 3: Write** `0105_bundle_price_groups.sql` with exactly these objects. Order: `price_groups` + indexes + seed, then the outlets column, then the bundle_prices column, then the PK swap, then the revision table.
- [ ] **Step 4: Run** the same command. Expected: PASS. Every existing BN subtest still passes: today's write path inserts without `group_id`, and those rows land in Standar.
- [ ] **Step 5: Commit** `feat: bundle price groups schema (migration 0105)`.

### Task 2: Pure effective prices + shared golden file

Reviewer: **Opus** (decides the amount a sale is charged).

**Files:**
- Create: `backend/internal/bundles/effective.go`, `backend/internal/bundles/effective_test.go`, `backend/internal/bundles/testdata/effective_golden.json`
- Modify: `backend/internal/bundles/testdata/split_golden.json` (append one case)

**Interfaces (Produces):**
- `func Effective(standar, group Prices) Prices`. Pure: returns new maps, never mutates either input, and leaves no empty inner `Lines` map.
- Golden case JSON: `{"name", "standar": {"standard": {size: price}, "lines": {line: {size: price}}}, "group": null | {same shape}, "expected": {same shape}, "priceFor": [{"line", "size", "price", "ok"}]}`. `group: null` = the default group, i.e. `Effective(standar, Prices{})`.

Algorithm (what the tests pin):
1. Deep-copy `standar`.
2. For each size S with `group.Standard[S] > 0` and `standar.Standard[S] > 0`: set `Standard[S]`, then delete every `Lines[*][S]`, dropping a line key once it is empty.
3. For each `group.Lines[L][S] > 0` where step 2 applied S: set `Lines[L][S]`. Ignore everything else.

Golden cases (EXT = `EXTRAIT DE PARFUM`, PI = `PARFUM INTENSE`; size keys like `"120ml"`):

| name | standar | group | expected | priceFor |
|---|---|---|---|---|
| owner_example | std {120:1200000}, EXT {120:1500000} | std {120:1400000} | std {120:1400000}, lines {} | EXT120 1400000, PI120 1400000 |
| owner_example_group_without_size | same | std {} | = standar | EXT120 1500000, PI120 1200000 |
| default_group | std {100:1050000,110:1150000,120:1200000}, EXT {120:1500000} | null | = standar | EXT120 1500000 |
| partial_sizes | std {100:1050000,110:1150000,120:1200000}, PI {120:1300000} | std {110:1250000} | std {100:1050000,110:1250000,120:1200000}, PI {120:1300000} | PI100 1050000, PI110 1250000, PI120 1300000 |
| line_overrides_both_sides | std {110:1150000}, EXT {110:1300000} | std {110:1250000}, PI {110:1350000} | std {110:1250000}, PI {110:1350000} | EXT110 1250000, PI110 1350000 |
| mock_screen | std {100:1050000,110:1150000,120:1200000}, EXT {120:1500000} | std {110:1250000,120:1400000}, PI {120:1450000} | std {100:1050000,110:1250000,120:1400000}, PI {120:1450000} | EXT100 1050000, EXT110 1250000, EXT120 1400000, PI100 1050000, PI110 1250000, PI120 1450000 |
| group_size_not_in_standar_ignored | std {120:1200000} | std {120:1400000,130:1600000} | std {120:1400000} | EXT130 ok=false |
| group_line_without_group_size_ignored | std {100:1050000,120:1200000}, EXT {100:1100000} | std {120:1400000}, EXT {100:999000} | std {100:1050000,120:1400000}, EXT {100:1100000} | EXT100 1100000 |

Split golden append: `{ "name": "premium_ext_120", "amount": 1400000, "basis": [1200000, 250000, 60000], "expected": [1112583, 231788, 55629], "minNet": 26 }`. The POS `apps/pos/src/cashier/setBundles.test.ts` reads this file too and must stay green.

- [ ] **Step 1: Write failing tests.**
  - `TestEffectiveGolden` loads the golden file (at least 8 cases). For each case: `Effective` equals `expected` (nil and empty top-level maps count as equal; an empty inner map is a failure), and every `priceFor` row matches `Prices.PriceFor`.
  - `TestEffectiveDoesNotMutateInputs`: deep copies of both inputs are unchanged after the call.
  - The new split case is picked up by the existing `TestSplitGolden` / `TestMinNetGolden`.
- [ ] **Step 2: Run** `cd backend && go test ./internal/bundles -run 'TestEffective|TestSplitGolden|TestMinNetGolden' -count=1`. Expected: FAIL (`Effective` undefined).
- [ ] **Step 3: Implement** `Effective` in `effective.go`, with a doc comment stating the two ignore rules.
- [ ] **Step 4: Run** the same command, plus `corepack pnpm --filter @mandalika/pos test -- setBundles`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: effective bundle prices per price group`.

### Task 3: `LoadPrices` by outlet; the pull catalog uses the outlet's group

Reviewer: **Opus** (sync pull).

**Files:**
- Modify: `backend/internal/bundles/load.go`, `backend/internal/read/bundles.go` (`BundleCatalog`, `BundleSettings`), `backend/internal/service/setbundle_resolve.go` (compile only: pass `""` for now; Task 4 changes it)
- Test: `bundlePriceGroupSubtests` in `backend/internal/handlers/bundle_price_groups_integration_test.go`, called at the very end of `TestBundlesPostgres` (after `bundleSaleSubtests`). It takes a `bundleEnv` struct `{pool, ctx, rd, wr, outlet, champ, do, tokFor, tokForRole}` built from the existing closures.

**Interfaces:**
- Produces: `func LoadPrices(ctx context.Context, q Querier, outletID string) (Prices, error)` returning `Effective(standar, groupOf(outletID))`.
  - An empty, unknown or non-UUID `outletID` (including `read.NoOutlet`) resolves to Standar.
  - The SQL compares `o.id::text` with the outlet parameter, so there is no uuid cast error, and finds the default group by `is_default`.
  - It reads only the default group's rows and the outlet group's rows.
- Consumes: `Effective` (Task 2).
- Callers:
  - `read.BundleCatalog`: `outlet := ""; if !sc.CrossAll { outlet = sc.OutletID }`.
  - `read.BundleSettings`: `LoadPrices(ctx, r.Pool, "")` (rewritten in Task 6).

- [ ] **Step 1: Write the failing subtest** `effective_prices_by_outlet`:
  - seed via SQL: Standar `('', '120ml', 795000)` and `('EXTRAIT DE PARFUM','120ml',850000)`; Premium (`group_id` 5ad7a12d-…0002) `('', '120ml', 950000)`; a second outlet `outlet2` (NULL group)
  - move `outlet` to Premium (`UPDATE outlets SET price_group_id = '5ad7a12d-…0002' WHERE id = outlet`)
  - `bundles.LoadPrices(ctx, pool, outlet)`: `PriceFor("EXTRAIT DE PARFUM","120ml")` = 950000 and `PriceFor("PARFUM INTENSE","120ml")` = 950000
  - `LoadPrices` for `outlet2`, `""`, `read.NoOutlet` and a random UUID: EXT120 = 850000 (anti-mix pin)
  - `syncpkg.New(pool, rd, nil, wr).Pull(ctx, read.Scope{OutletID: outlet}, outlet)` → CHAMPION's EXT 120ml offer price = 950000; the same pull for `outlet2` → 850000; `GET /bundles/catalog` (CrossAll) → 850000
  - `t.Cleanup` resets `price_group_id` to NULL and deletes the Premium rows
- [ ] **Step 2: Run** the BN gate. Expected: FAIL (compile error, then the Premium price is not applied).
- [ ] **Step 3: Implement** the new `LoadPrices` and update the callers.
- [ ] **Step 4: Run** `cd backend && go build ./... && go test ./internal/bundles ./internal/read ./internal/service -count=1` and the BN gate. Expected: PASS.
- [ ] **Step 5: Commit** `feat: bundle catalog uses the outlet's price group`.

### Task 4: Sale validation at the outlet's group (online, offline, ERP split)

Reviewer: **Opus** (payments, offline outbox sync).

**Files:**
- Modify: `backend/internal/service/setbundle_resolve.go` (`resolveSetBundles`: `bundles.LoadPrices(ctx, tx, in.OutletID)`, inside the sale transaction)
- Test: new subtests appended at the end of `bundleSaleSubtests` in `backend/internal/handlers/bundles_sale_integration_test.go` (they reuse `sale`, `syncSale`, `call`, `bundleItems`, `itemRows`, `str`)

**Interfaces:** Consumes `LoadPrices(ctx, q, outletID)` (Task 3). No signature change in `service`.

- [ ] **Step 1: Write the failing subtests.** Setup: Standar 120 = 795000 and EXT120 = 850000 (the existing seed); insert Premium `('', '120ml', 950000)`; move `outlet` to Premium. `t.Cleanup` restores NULL and deletes the Premium rows.
  - `premium_online_at_standar_price_is_422`: `call("POST","/orders", {Idempotency-Key}, sale(bundleItems(champ,250000,850000),850000))` → 422 with a body containing `Harga bundle sudah berubah. Tunggu katalog tersinkron lalu ulangi.`; no order row.
  - `premium_synced_at_standar_price_kept_and_flagged`: `syncSale` of a Standar-priced sale (captured before the move) → `discount_warning = true`, reason contains `bundle_price_changed`, piece prices sum to `850000.00`.
  - `premium_synced_at_premium_price_splits`: `syncSale(sale(bundleItems(champ,250000,950000),950000))` → no `bundle_price_changed` in the reason; `itemRows` prices equal `bundles.Split(950000, [3]int64{1200000,250000,60000})` = `[754968,157284,37748]` (assert both), sum `950000.00`, `refund_group = 'set:1'`.
- [ ] **Step 2: Run** the BN gate. Expected: FAIL (the server still prices at Standar, so the Premium-price sale is flagged).
- [ ] **Step 3: Implement** the one-line change.
- [ ] **Step 4: Run** the BN gate and `cd backend && go test ./internal/service ./internal/integration/erp -count=1`. Expected: PASS (`TestBuildDocumentBundlePiecesSumToBundleNet` unchanged).
- [ ] **Step 5: Commit** `feat: sale bundle prices follow the outlet's price group`.

### Task 5: OpenAPI contract + regenerated Go/TS types

Reviewer: **Opus** (generated types).

**Files:**
- Modify: `backend/api/openapi.yaml`
- Regenerate: `backend/internal/api/api.gen.go` (`cd backend && go run ./cmd/codegen`) and `packages/api/src/schema.d.ts` (`cd backend && make gen-ts`)
- Modify: `apps/backoffice/src/screens/products/bundleSettings.test.ts`: add `revision: 1, groups: [], outlets: []` to the `champion: BundleSettings` fixture so the typecheck stays green.
- Modify: `backend/internal/handlers/bundles.go` only if the build needs it.

**Interfaces (Produces, exact):**
- `BundlePriceGroup {id: string(uuid), name: string, isDefault: boolean, outletCount: integer, standard: BundlePriceEntry[], linePrices: BundleLinePriceEntry[]}`, all required.
- `BundleOutletGroup {outletId: string(uuid), name: string, code: string ('' when none), isActive: boolean, groupId: string(uuid) (the default id when NULL)}`, all required.
- `BundleSettings`: add required `revision: integer(int64)`, `groups: BundlePriceGroup[]` (sort order, default first) and `outlets: BundleOutletGroup[]` (active first, then `lower(name)`, then id). `standard`/`linePrices`/`lines` are unchanged (= Standar).
- `BundleGroupPricesInput {groupId: string(uuid), standard: BundlePriceEntry[], linePrices: BundleLinePriceEntry[]}`, all required.
- `BundleOutletGroupInput {outletId: string(uuid), groupId: string(uuid)}`, both required.
- `BundleSettingsInput`: `required` stays `[standard, linePrices]` (= Standar). Add **optional, non-nullable** `revision: integer(int64)`, `groups: BundleGroupPricesInput[]` (non-default groups only) and `outletGroups: BundleOutletGroupInput[]`. Field descriptions state the old/new body rules.
- `BundleSettingsSaved {revision: integer(int64)}` and `BundleSettingsSaveResponse {data: BundleSettingsSaved}`, all required.
- `PriceGroupInput {name: string}`, required.
- Paths (tag `settings`):
  - `PUT /api/v1/settings/bundles` → 200 `BundleSettingsSaveResponse`; 400/403/409 `Error`.
  - `POST /api/v1/price-groups` (body `PriceGroupInput`) → 201 `IdResponse`; 400/403/409.
  - `PUT /api/v1/price-groups/{id}` (`format: uuid` path param) → 200 `OkResponse`; 400/403/404/409.
  - `DELETE /api/v1/price-groups/{id}` → 200 `OkResponse`; 403/404/409.

- [ ] **Step 1:** Edit the YAML: schemas next to `BundleSettings`, paths after `/api/v1/settings/bundles`.
- [ ] **Step 2: Run** `cd backend && go run ./cmd/codegen && make gen-ts && go run ./cmd/codegen -check && go build ./... && go test ./internal/api ./internal/codegen -count=1 && cd .. && corepack pnpm gen:check && corepack pnpm --filter @mandalika/backoffice test -- bundleSettings`. Expected: no drift; build and tests PASS. (No new top-level test in `internal/api`, so `codegen_gate.py` is unchanged.)
- [ ] **Step 3: Commit** `feat: bundle price groups OpenAPI contract`.

### Task 6: GET `/settings/bundles` returns groups, outlets and revision

Reviewer: **Opus** (the revision it returns guards the stale-save check).

**Files:**
- Modify: `backend/internal/read/bundles.go` (`BundleSettings`)
- Test: subtest `settings_get_groups` in `bundlePriceGroupSubtests`

**Interfaces (Produces):** `func (r *Repo) BundleSettings(ctx context.Context) (api.BundleSettings, error)` (same signature).
- Revision, groups (`outletCount` = outlets whose `COALESCE(price_group_id, default)` is the group, inactive ones included), every group's price rows, and outlets are read in **one** `r.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})` snapshot. A revision can then never be newer than the prices sent with it.
- The line lookup (`deriveBundles`, CrossAll) stays outside that transaction.
- Top-level `standard` / `linePrices` = the default group's rows, ordered as today.

- [ ] **Step 1: Write the failing subtest**:
  - Seed Standar 120 = 795000 and Premium 120 = 950000; move `outlet` to Premium; leave `outlet2` NULL and make it inactive.
  - `GET /settings/bundles` as admin returns `revision` ≥ 1.
  - `groups[0] = {id: Standar, isDefault: true, outletCount: 1, standard: [{120ml, 795000}]}` and `groups[1] = {id: Premium, isDefault: false, outletCount: 1, standard: [{120ml, 950000}], linePrices: []}`.
  - `outlets`: `outlet` (active) comes before `outlet2` (`isActive: false`, `groupId` = Standar id although stored NULL). `code` is `""` for an outlet without a code.
  - Top-level `standard` = `[{120ml, 795000}]` only.
- [ ] **Step 2: Run** the BN gate. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the BN gate. Expected: PASS.
- [ ] **Step 5: Commit** `feat: bundle settings list price groups, outlets and revision`.

### Task 7: PUT `/settings/bundles` with groups, assignments and revision

Reviewer: **Opus** (content versions, stale-save guard, old-client compatibility).

**Files:**
- Modify: `backend/internal/write/bundles.go`, `backend/internal/handlers/bundles.go` (`UpdateBundleSettings`), `backend/internal/handlers/writes.go`
- Create: `backend/internal/write/bundle_groups.go` (pure helpers + errors), `backend/internal/write/bundle_groups_test.go`
- Modify: `backend/internal/write/bundles_test.go` (follow the rename of `validateBundleSettings`)
- Test: subtests in `bundlePriceGroupSubtests`

**Interfaces (Produces, write):**
- `type BundleGroupPricesIn struct { GroupID string; Standard []BundlePriceIn; LinePrices []BundleLinePriceIn }`
- `type BundleOutletGroupIn struct { OutletID, GroupID string }`
- `BundleSettingsInput` gains `Groups []BundleGroupPricesIn; OutletGroups []BundleOutletGroupIn; Revision *int64; NewShape bool`. `NewShape` = `groups` or `outletGroups` present in the JSON.
- `func (r *Repo) UpdateBundleSettings(ctx context.Context, userID string, in BundleSettingsInput) (int64, error)` returns the new revision.
- `func validateBundlePrices(std []BundlePriceIn, lines []BundleLinePriceIn, knownLines []string, groupLabel string) error` replaces `validateBundleSettings`. With an empty `groupLabel` the copy is exactly today's; otherwise line-rule sizes read `<group> <size>`.
- `type bundleGroupState struct { ID, Name string; IsDefault, Listed bool; Standard map[string]float64; Lines map[string]map[string]float64 }`
- `func validateBundleGroups(groups []bundleGroupState) error`. Groups come in sort order with the default first; sizes are checked smallest first. For each non-default group and each size it prices that the default lacks:
  - `Listed`: `Harga %s %s butuh harga %s %s`
  - not listed: `Ukuran %s masih punya harga di kelompok %s. Hapus harga itu dulu.`
- `type bundlePriceRow struct { GroupID, Line, Size string; Price float64 }` and `func bundlePriceRowsChanged(before, after []bundlePriceRow) bool` (order-insensitive)
- `type BundleConflictError struct{ Msg string }` (its `Error()` returns `Msg`) and `func IsBundleConflict(err error) bool`
- consts `MsgBundleStale`, `MsgBundleRevisionRequired`, `MsgPriceGroupUnknown`, `MsgBundleOutletUnknown`, with the Global Constraints copy

**Interfaces (Produces, handlers):**
- `func (h *Handlers) mutationFailed(w http.ResponseWriter, r *http.Request, err error) bool`, extracted from `mutated`. It keeps every existing mapping and adds `write.IsBundleConflict` → 409 via `safeDomainText`. `mutated` becomes "if not failed: invalidate, write ok".
- `created` also maps `IsBundleConflict` → 409.
- `UpdateBundleSettings` decodes `api.BundleSettingsInput` and maps it to the write input (uuid to string; `NewShape` = `body.Groups != nil || body.OutletGroups != nil`). On success it calls `h.invalidate(r)`, then writes 200 `api.BundleSettingsSaveResponse` carrying the new revision.

**Repo algorithm (pinned; SQL parameters are pgx positional parameters):**
1. `NewShape` with no `Revision` → 400 `MsgBundleRevisionRequired`, before any database work.
2. Begin the transaction. Atomic check-and-advance: `UPDATE bundle_price_revision SET revision = revision + 1 WHERE <rev> IS NULL OR revision = <rev> RETURNING revision`. No row → `BundleConflictError{MsgBundleStale}`. This row lock serializes every bundle write.
3. Load groups (`id, name, is_default, sort_order`) and every `bundle_prices` row (the "before" set).
4. Reject, in this order:
   - the default id in `Groups` (400 `Harga kelompok default dikirim lewat standard dan linePrices.`)
   - a duplicate group (400 `Kelompok %s dobel`)
   - an unknown group in `Groups` or `OutletGroups` (400 `MsgPriceGroupUnknown`)
   - a duplicate outlet (400 `Outlet dobel di daftar kelompok`)
   - an unknown outlet (400 `MsgBundleOutletUnknown`)
5. Run `validateBundlePrices` for the default group (empty label) and each listed group (label = its current name), against `bundleLineNames`.
6. Merge: the default group and listed groups take the body's values; unlisted groups keep their database values. Run `validateBundleGroups` on the merged list.
7. Delete the rows of the default and listed groups **only** (`group_id = ANY(<ids>)`), then insert the new rows with an explicit `group_id` and `updated_by`.
8. For each outlet group, the target is NULL for the default group, else the group id. Update the outlet only when its normalized group differs (`COALESCE(price_group_id, <default>) IS DISTINCT FROM COALESCE(<target>, <default>)`), with `RETURNING id::text` collecting the moved ids. A pg 23503 (group deleted concurrently) → 400 `MsgPriceGroupUnknown`.
9. If `bundlePriceRowsChanged(before, after)`: `bumpVersion(ctx, tx, "bundle_prices")`. Else, if any outlet moved: `bumpVersionOutlets(ctx, tx, "bundle_prices", moved)`. Do not use `r.tx`, which always bumps every outlet.
10. Commit and return the new revision.

- [ ] **Step 1: Write failing unit tests** in `write/bundle_groups_test.go`:
  - `TestValidateBundleGroups`:
    - listed Premium 130ml with no Standar 130 → `Harga Premium 130ml butuh harga Standar 130ml`
    - unlisted Premium 100ml after Standar dropped 100 → `Ukuran 100ml masih punya harga di kelompok Premium. Hapus harga itu dulu.`
    - both dropped → nil
    - a default renamed "Reguler" shows that name in the message
  - `TestValidateBundlePricesGroupLabel`: empty label → `Harga lini 120ml butuh harga standar 120ml` (unchanged); label "Premium" → `Harga lini Premium 120ml butuh harga standar Premium 120ml`.
  - `TestBundlePriceRowsChanged`: the same rows in another order → false; a changed price, an added row or a removed row → true.
- [ ] **Step 2: Run** `cd backend && go test ./internal/write -run "TestValidateBundle|TestBundlePriceRows" -count=1`. Expected: FAIL.
- [ ] **Step 3: Implement** the pure helpers; run again. Expected: PASS.
- [ ] **Step 4: Write failing Postgres subtests** (BN router, admin token):
  - `old_body_keeps_premium` (Review Focus 2): with Premium 120 = 950000 and `outlet` in Premium, the old body `{standard:[{120ml,800000}], linePrices:[]}` → 200. Afterwards the Premium row and `outlet.price_group_id` are unchanged, Standar 120 = 800000, and the revision went up by 1.
  - `revision_cas` (Review Focus 1): GET gives revision R.
    - A PUT of the new body with R → 200, returns R+1.
    - The same PUT again with R → 409 with the exact stale copy, and nothing changed.
    - With R+1 → 200.
    - A new-shape body without `revision` → 400 `Revisi harga bundle wajib dikirim. Muat ulang.`
  - `cross_group_merged_state` (Review Focus 3): one PUT dropping Standar 100 and Premium 100 → 200. An old body dropping Standar 100 while Premium prices 100 → 400 with the exact copy.
  - `assign_bumps_moved_only` (Review Focus 4): record the content versions of `outlet` and `outlet2`.
    - An assignment-only PUT (Standar prices unchanged) moves `outlet` to Premium and lists `outlet2` → Standar, which it already is (NULL).
    - `outlet`'s version and the `bundle_prices` counter in its data manifest each go up by 1. `outlet2`'s version is unchanged and its `price_group_id` is still NULL.
    - Moving `outlet` back to Standar stores NULL.
    - A price change bumps both outlets.
  - `group_put_rejections`:
    - default id in `groups` → 400
    - unknown group → 400
    - unknown outlet → 400
    - Premium line price without a Premium standard → 400 `Harga lini Premium 120ml butuh harga standar Premium 120ml`
- [ ] **Step 5: Run** the BN gate. Expected: FAIL.
- [ ] **Step 6: Implement** the repo and handler changes.
- [ ] **Step 7: Run** the BN gate and `cd backend && go test ./internal/write ./internal/handlers -count=1`. Expected: PASS, including the existing `version_bumps`, `settings_roundtrip` and `settings_invalid_is_400_with_copy`.
- [ ] **Step 8: Commit** `feat: bundle price save per group with outlet assignment and revision check`.

### Task 8: Price group create / rename / delete

Reviewer: **Opus** (shares the revision lock and the FK race with Task 7).

**Files:**
- Modify: `backend/internal/write/bundle_groups.go` (+ tests in `bundle_groups_test.go`), `backend/internal/handlers/bundles.go`
- Test: subtest `price_group_crud` in `bundlePriceGroupSubtests`. The BN test router gets the three routes behind `RequireRole("admin")` for now; Task 9 swaps that for `RequireBundleAdmin()`.

**Interfaces (Produces):**
- `const MaxPriceGroups = 5`, `const MaxPriceGroupNameLen = 40`
- `func normalizePriceGroupName(name string) (string, error)`: trims, then rejects with 400 `Nama kelompok wajib diisi` / `Nama kelompok maksimal 40 karakter` (counted in runes).
- `func (r *Repo) CreatePriceGroup(ctx context.Context, name string) (string, error)`: `sort_order` = max + 1. A 6th group → conflict `Maksimal 5 kelompok harga`.
- `func (r *Repo) RenamePriceGroup(ctx context.Context, id, name string) error`
- `func (r *Repo) DeletePriceGroup(ctx context.Context, id string) error`
- Shared rules for the three writes:
  - Each runs in its own transaction, not `r.tx`, because there is no content-version bump.
  - Each starts with `SELECT revision FROM bundle_price_revision FOR UPDATE` and does **not** advance the revision.
  - A duplicate name → conflict `Nama kelompok sudah dipakai`. Pre-check `lower(name)` against the other ids, and also map 23505 on `price_groups_name_lower`.
  - A non-uuid or unknown id → `ErrNotFound` (404).
- Delete specifics:
  - lock the group row (`FOR UPDATE`)
  - the default group → conflict `Kelompok default tidak bisa dihapus`
  - a group that still has outlets → conflict `Kelompok %s masih dipakai %d outlet. Pindahkan outletnya dulu.`
  - otherwise delete it (its prices cascade)
- Handlers: `CreatePriceGroup` (`h.created`), `RenamePriceGroup` and `DeletePriceGroup` (`h.mutated`). Body `api.PriceGroupInput`, id from `chi.URLParam(r, "id")`.

- [ ] **Step 1: Write failing tests.**
  - Unit `TestNormalizePriceGroupName`: `"  VIP "` → `"VIP"`; `""` and `"   "` → the "wajib" error; 41 runes → the "maksimal" error; 40 multi-byte runes → OK.
  - Subtest `price_group_crud`:
    - POST `"Mall"` → 201 with an id. POST `" mall "` → 409 `Nama kelompok sudah dipakai`. Create groups up to 5; the 6th → 409 `Maksimal 5 kelompok harga`.
    - PUT renaming Premium → `"Premium Mall"` → 200, and GET shows the new name.
    - Renaming to `"STANDAR"` → 409. Renaming an unknown uuid → 404.
    - DELETE Standar → 409 `Kelompok default tidak bisa dihapus`.
    - DELETE Premium while `outlet` is in it → 409 `Kelompok Premium Mall masih dipakai 1 outlet. Pindahkan outletnya dulu.`
    - DELETE an empty group that has a price row → 200, and its rows are gone.
    - Across all of these the revision and `content_versions` are unchanged.
- [ ] **Step 2: Run** the BN gate and `cd backend && go test ./internal/write -run TestNormalizePriceGroupName -count=1`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same commands. Expected: PASS.
- [ ] **Step 5: Commit** `feat: price group create, rename and delete`.

### Task 9: Admin-only routes with an Indonesian refusal

Reviewer: **Opus** (auth).

**Files:**
- Create: `backend/internal/handlers/bundle_admin.go` (`RequireBundleAdmin`)
- Modify: `backend/internal/server/server.go`:
  - remove `r.Put("/settings/bundles", ...)` from the `manage_products` + `RequireCatalogueWide` group
  - add a new `r.Group` with `r.Use(handlers.RequireBundleAdmin())` holding `PUT /settings/bundles`, `POST /price-groups`, `PUT /price-groups/{id}` and `DELETE /price-groups/{id}`
- Modify: `backend/internal/server/catalogue_routes_coverage_test.go` (drop `PUT /api/v1/settings/bundles` from `gated`; it now answers with the bundle-admin copy)
- Create: `backend/internal/server/bundle_admin_routes_test.go`
- Modify: `backend/internal/handlers/bundles_integration_test.go` (the test router's PUT group and the price-group routes use `RequireBundleAdmin()` instead of `RequirePermission("manage_products")` / `RequireRole("admin")`)

**Interfaces (Produces):** `func RequireBundleAdmin() func(http.Handler) http.Handler` reads the role from `auth.CtxRole`. A non-admin gets 403 `Hanya admin yang bisa mengubah harga bundle.` (`const MsgBundleAdminOnly`).

- [ ] **Step 1: Write the failing test** `TestBundlePriceRoutesAdminOnly` (in `internal/server`; uses `newRouteHarness`, `auth.IssueAccessCov`, `send`):
  - a covered-only manager, an **All-outlets manager** with `manage_products`, and a cashier each get 403 with exactly `Hanya admin yang bisa mengubah harga bundle.` on all four routes
  - an admin token gets neither 403 nor 404/405 (it reaches the handler)
  - `GET /api/v1/settings/bundles` as a cashier is not 403
- [ ] **Step 2: Run** `cd backend && go test ./internal/server -run "TestBundlePriceRoutesAdminOnly|TestCatalogueRoutesFollowCoverage" -count=1`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command and the BN gate (`settings_forbidden` still answers 403). Expected: PASS.
- [ ] **Step 5: Commit** `feat: bundle prices and price groups are admin-only`.

### Task 10: Slice 1 gates, PR, HANDOFF

Reviewer: **Haiku** (no new logic). First, an **Opus** whole-slice review of the diff against `origin/prod-hardening`; fix its findings in their own commits.

- [ ] **Step 1: Run the local gates** (all must pass):
  - `cd backend && go vet ./... && go build ./... && make gen-check && python ../scripts/ci/codegen_gate.py && go test ./... -count=1` (run `gofmt -l .` and require empty output)
  - `python scripts/ci/postgres_gate.py --only BN --output <scratch>/pg-bn.json`
  - `corepack pnpm gen:check && corepack pnpm quality:ci && corepack pnpm browser:ci`
- [ ] **Step 2: Push.** `git push -u origin claude/bundle-price-groups` and `git push origin claude/bundle-price-groups:gate/bundle-price-groups-backend`. Wait until backend, postgres, quality, browser and dependency-security are green on the gate branch (`gh run list --branch gate/bundle-price-groups-backend`). If a gate is red, investigate it; never re-run blindly.
- [ ] **Step 3: Open the PR.** `gh pr create --base prod-hardening --head claude/bundle-price-groups`, title `feat: bundle price groups (backend, migration 0105)`. The body states:
  - the release order: backend first, then Backoffice
  - that `PUT /settings/bundles` is now admin-only: a "Semua Outlet" Manajer gets 403 `Hanya admin yang bisa mengubah harga bundle.` from the old Backoffice
  - that the old Backoffice body changes Standar only
  - the rollback note: before going back to a pre-0105 revision while Premium rows exist, run `DELETE FROM bundle_prices WHERE group_id <> (SELECT id FROM price_groups WHERE is_default);`
  - the Claude Code attribution line at the end
  Do not merge.
- [ ] **Step 4: HANDOFF.** Add a `HANDOFF.md` Progress board entry: branch, gate, PR number, "not released, waiting on the owner". Commit it as `[CF-Pages-Skip] [skip ci] docs: HANDOFF bundle price groups backend PR` and push the branch.

---

## Slice 2 — Backoffice (`claude/bundle-price-groups-backoffice`, branched from slice 1's head)

Component tests in this app use `renderToStaticMarkup` (see `apps/backoffice/src/screens/products/catalogueLocked.test.tsx`); there is no testing-library. Backoffice tests run with `corepack pnpm --filter @mandalika/backoffice test -- <pattern>`.

### Task 11: API client methods + TS effective-price twin

Reviewer: **Haiku** (display-only helper; the server decides prices). An Opus re-check of the golden parity is part of the slice review.

**Files:**
- Modify: `packages/api/src/client.ts`
- Create: `apps/backoffice/src/screens/products/effectivePrices.ts`, `apps/backoffice/src/screens/products/effectivePrices.test.ts`

**Interfaces (Produces):**
- `client.ts` types: `BundlePriceGroup`, `BundleOutletGroup` and `BundleSettingsSaved`, each aliased from the generated schema as the file already does (`S[...]`).
- `client.ts` methods:
  - `updateBundleSettings(body: BundleSettingsInput): Promise<BundleSettingsSaved>` (now returns `data`)
  - `createPriceGroup(name: string): Promise<{ id: string }>`
  - `renamePriceGroup(id: string, name: string): Promise<void>`
  - `deletePriceGroup(id: string): Promise<void>`
- `effectivePrices.ts`:
  - `export type PriceTable = { standard: Record<string, number>; lines: Record<string, Record<string, number>> }`
  - `export function effectivePrices(standar: PriceTable, group: PriceTable | null): PriceTable`: the same algorithm and ignore rules as Go `Effective`; never mutates its inputs; no empty inner maps
  - `export function priceFor(p: PriceTable, line: string, size: string): number | null`: mirrors `Prices.PriceFor`; null where Go answers `ok=false`

- [ ] **Step 1: Write failing tests.**
  - `effectivePrices.test.ts` reads the golden file `backend/internal/bundles/testdata/effective_golden.json` through a `new URL(<five ../ segments>/backend/internal/bundles/testdata/effective_golden.json, import.meta.url)` and `readFileSync` from `node:fs`. The Backoffice already reads files this way in `src/lib/tokens.test.ts`.
  - It expects at least 8 cases. Each case: `effectivePrices(c.standar, c.group)` deep-equals `c.expected`, and each `priceFor` row matches (`ok: false` means null).
  - A no-mutation test, as in Go.
- [ ] **Step 2: Run** `corepack pnpm --filter @mandalika/backoffice test -- effectivePrices`. Expected: FAIL.
- [ ] **Step 3: Implement** the helper and the client methods. In `bundleSettings.ts`, change `SaveApi` to the new return type so the typecheck passes.
- [ ] **Step 4: Run** the same command plus `corepack pnpm --filter @mandalika/backoffice test -- bundleSettings`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: Backoffice price group client and effective-price twin`.

### Task 12: Form model for groups, assignments and revision

Reviewer: **Opus** (stale-save flow: which revision is sent and adopted).

**Files:**
- Create: `apps/backoffice/src/screens/products/bundleGroupsForm.ts`, `apps/backoffice/src/screens/products/bundleGroupsForm.test.ts`
- Modify: `apps/backoffice/src/screens/products/bundleSettings.ts`: keep `aromaRows` and `DEFAULT_LARGE_SIZES`. In Task 13, once the panel uses the new model, remove `settingsToForm` / `formToInput` / `formProblems` / `saveBundleSettings` and their tests in `bundleSettings.test.ts`.

**Interfaces (Produces):**
- `export type GroupColumn = { id: string; name: string; isDefault: boolean }`
- `export type GroupPricesForm = { standard: Record<string, string>; lines: Record<string, Record<string, string>> }` (raw input text; an empty string means empty)
- `export type BundleGroupsForm = { revision: number; sizes: string[]; lines: string[]; groups: GroupColumn[]; prices: Record<string, GroupPricesForm>; outletGroups: Record<string, string> }`
  - `sizes` = `DEFAULT_LARGE_SIZES` plus every stored size, smallest first
  - `lines` = the `lines[].line` values plus stored line names
  - `outletGroups` maps outletId to groupId
- `export function settingsToGroupsForm(s: BundleSettings): BundleGroupsForm`
- `export function groupsFormToInput(f: BundleGroupsForm, saved: BundleGroupsForm): BundleSettingsInput`:
  - `standard` / `linePrices` = the default group's column, with empty fields dropped
  - `groups` = **every** non-default column
  - `outletGroups` = only the outlets whose group differs from `saved`
  - `revision` = `f.revision`
- `export function groupsFormProblems(f: BundleGroupsForm): string[]`: the same copy as the server (Global Constraints) for a zero/invalid price, a line price without its group's standard, and a group standard without a Standar standard. Deduplicated, in display order.
- `export function cellState(f: BundleGroupsForm, groupId: string, line: string, size: string): { placeholder: string; disabled: boolean; hint?: string }` (`line` is the empty string for the standard row). Fallback values come from `effectivePrices` / `priceFor` over the parsed form (`parseMoneyInput`), formatted with the existing money formatter from `bundleSettings.ts` (export it). Pinned rules:
  - Default standard cell: placeholder `Rp 0`, never disabled.
  - Default line cell: placeholder `= <money(default standard)>` when that standard is set, else empty. Never disabled.
  - Group standard cell when the default standard for the size is empty: disabled, hint `Isi harga <Standar name> <size> dulu`, empty placeholder. **A cell that already holds a value stays enabled**, and the problem list shows the error.
  - Group standard cell, empty, with the default standard set: placeholder `= <money(Standar standard)> (<Standar name>)`.
  - Group line cell when the group has no standard for the size: disabled, hint `Isi harga <group name> <size> dulu`, placeholder `= <money(Standar priceFor(line, size))> (<Standar name>)`. **It stays enabled if it holds a value.**
  - Group line cell with the group standard set: placeholder `= <money(group standard)>`.
- `export function mergeGroupsIntoForm(f: BundleGroupsForm, s: BundleSettings): BundleGroupsForm`, used after a group dialog write:
  - adds columns for new groups (empty prices) and drops columns of deleted groups
  - takes the new names
  - outlets pointing at a dropped group go back to their group in `s`
  - keeps every typed value and **keeps `f.revision`**
- `export function changeItems(f: BundleGroupsForm, saved: BundleGroupsForm): string[]`: contains "Harga bundle" when any price differs (compared through `groupsFormToInput`) and "Kelompok outlet" when `outletGroups` differs.
- `export async function saveBundleGroups(api: { updateBundleSettings: (b: BundleSettingsInput) => Promise<BundleSettingsSaved> }, f: BundleGroupsForm, saved: BundleGroupsForm): Promise<{ ok: true; revision: number } | { ok: false; error: string; stale: boolean }>`. `stale` is true when the error is an `ApiError` with status 409 and the stale message from Global Constraints.

- [ ] **Step 1: Write failing tests** in `bundleGroupsForm.test.ts`. Fixture = the mock: Standar 100/110/120 = 1050000/1150000/1200000 and Extrait 120 = 1500000; Premium 110/120 = 1250000/1400000 and Parfum Intense 120 = 1450000; 3 outlets, one of them inactive.
  - Round trip settings → form → input: `standard` = the Standar rows; `groups` = one entry for Premium (standard 110 and 120, line PI 120); `outletGroups` empty; `revision` = the loaded revision.
  - Moving one outlet: `outletGroups` holds only that outlet, and `changeItems` gives exactly "Kelompok outlet". Also editing a price gives "Harga bundle" then "Kelompok outlet".
  - `cellState`, exact strings:
    - Premium 100ml standard → `= Rp 1.050.000 (Standar)`
    - Premium Extrait 100ml → disabled, hint `Isi harga Premium 100ml dulu`, placeholder `= Rp 1.050.000 (Standar)`
    - Premium Extrait 110ml → `= Rp 1.250.000`
    - Premium Extrait 120ml → `= Rp 1.400.000`
    - Standar Extrait 100ml → `= Rp 1.050.000`
    - a Premium line cell holding "Rp 999.000" with no Premium standard → enabled, and `groupsFormProblems` contains `Harga lini Premium 100ml butuh harga standar Premium 100ml`
    - Premium 130ml filled while Standar 130ml is empty → problem `Harga Premium 130ml butuh harga Standar 130ml`
  - `adopts the saved revision`: `saveBundleGroups` with an api mock resolving revision 8 returns ok with revision 8. A 409 `ApiError` carrying the stale copy returns not ok with `stale` true. Any other error returns `stale` false with its message verbatim.
  - `merge after a group write keeps the revision`: merge a form at revision 7 holding a typed Premium value with settings that add a group "Mall" and carry revision 9. The result keeps revision 7 and the typed value and gains a Mall column. Merging settings without Premium drops that column, and an outlet the form had moved to Premium goes back to its saved group.
- [ ] **Step 2: Run** `corepack pnpm --filter @mandalika/backoffice test -- bundleGroupsForm`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat: bundle price groups form model`.

### Task 13: Harga bundle table, admin-only editing, save and stale handling

Reviewer: **Opus** (stale-save flow in the screen, admin gating).

**Files:**
- Create: `apps/backoffice/src/screens/products/BundlePriceTable.tsx`, `apps/backoffice/src/screens/products/bundlePanel.test.tsx`
- Modify: `apps/backoffice/src/screens/products/BundleSettingsPanel.tsx` (replace `StandardPricesCard` + `LinePricesCard` with `BundlePriceTable`; switch to `bundleGroupsForm`), `apps/backoffice/src/screens/products/bundleSettings.ts` + `bundleSettings.test.ts` (drop the superseded helpers)

**Interfaces (Produces):**
- `export const BUNDLE_ADMIN_NOTE = "Hanya admin yang bisa mengubah harga bundle."` and `export function canEditBundles(user: NavUser | null): boolean` (true only for `role === "admin"`).
- `export function BundlePriceTable(props: { form: BundleGroupsForm; lineLabels: Record<string, string>; outletCounts: Record<string, number>; onChange: (groupId: string, line: string, size: string, raw: string) => void; readOnly: boolean })`
  - Layout per the mock: a "Harga standar (semua lini)" section row, one row per size, then one section per line labelled "<Label> (lini ERP)" with rows "<Label> <size>".
  - One column per group, with the outlet count under the group name.
  - Every cell is a `MoneyField` with `cellState` (placeholder, disabled, hint) and `aria-label` "<group> <row label>".
  - The card subtitle is the mock text.

**Panel behaviour (pinned):**
- `readOnly = !canEditBundles(user)`: show `BUNDLE_ADMIN_NOTE` (instead of `CatalogueLockedNote`), disable every input, render no SaveBar and no group actions.
- SaveBar: `count = changeItems(...).length`, `items = changeItems(...)`, notice "Tablet memakainya setelah sinkron berikutnya.", the existing success toast and message.
- On success, set `saved` and `form` to the saved form with `revision` = the returned revision.
- On `stale`: status error with the server message, and show a "Muat ulang" button. It refetches `getBundleSettings` and resets `saved` and `form` from the fresh settings, revision included. "Batalkan" resets to `saved` as today.
- The first-load-only rule stays: later polls never overwrite the form.

- [ ] **Step 1: Write failing tests** in `bundlePanel.test.tsx` (`renderToStaticMarkup` of `BundlePriceTable` with the Task 12 fixture):
  - the column headers "Standar" and "Premium" with their outlet counts
  - the Premium Extrait 100ml input is disabled, shows the hint text and has the `= Rp 1.050.000 (Standar)` placeholder
  - with `readOnly`, every input is disabled
  - `canEditBundles`: admin true; manager with `allOutlets: true` false; cashier false
- [ ] **Step 2: Run** `corepack pnpm --filter @mandalika/backoffice test -- bundlePanel`. Expected: FAIL.
- [ ] **Step 3: Implement** the table and the panel wiring.
- [ ] **Step 4: Run** `corepack pnpm --filter @mandalika/backoffice test` (whole app). Expected: PASS.
- [ ] **Step 5: Commit** `feat: Harga bundle table per price group, admin-only`.

### Task 14: Kelompok harga card, group dialogs, Outlet per kelompok list

Reviewer: **Haiku** (UI on top of Task 12 helpers; no new rule).

**Files:**
- Create: `apps/backoffice/src/screens/products/PriceGroupsCard.tsx`, `apps/backoffice/src/screens/products/PriceGroupDialog.tsx`, `apps/backoffice/src/screens/products/OutletGroupsList.tsx`, `apps/backoffice/src/screens/products/outletGroupsList.ts` + `.test.ts` (pure filter/sort)
- Modify: `apps/backoffice/src/screens/products/BundleSettingsPanel.tsx` (card order per the mock: Kelompok harga, Harga bundle, Outlet per kelompok, Aroma yang punya bundle; the aroma subtitle gains "Harga yang tertulis = harga Standar.")

**Interfaces (Produces):**
- `export function filterOutletRows(outlets: BundleOutletGroup[], outletGroups: Record<string, string>, q: string, groupId: string | null): BundleOutletGroup[]`: case-insensitive match on name or code; filters by the form's current group; keeps the server order (active first).
- `export function deleteBlockReason(group: GroupColumn, outletCount: number): string | null`: `Kelompok default tidak bisa dihapus` for the default group, `Pindahkan <n> outlet dulu` when it has outlets, else null.
- `PriceGroupsCard`:
  - one chip per group: name, a "Default" badge, "<n> outlet", and the admin-only links "Ubah nama" and "Hapus"
  - "Hapus" is disabled with the `deleteBlockReason` text as its title and as visible helper text
  - the admin-only "+ Tambah kelompok" button
  - outlet counts come from the form's current assignments
- `PriceGroupDialog` (uses `ui/Modal`): titles "Tambah kelompok harga" / "Ubah nama kelompok", field "Nama kelompok" (max 40), and the server error shown verbatim. Delete uses the existing `ConfirmDialog` with "Hapus kelompok <name>? Harga kelompok ini ikut terhapus."
- After every successful group write: refetch settings, then `mergeGroupsIntoForm` (Task 12). Group writes never touch the SaveBar.
- `OutletGroupsList`:
  - search box "Cari outlet atau kode"
  - segmented filter "Semua <n>" plus one button per group with its count
  - rows: outlet name with a "Nonaktif" badge when inactive, code, and a group select (disabled when read-only)
  - changed rows carry the mock's left-edge marker
  - subtitle "Tablet outlet yang dipindah memakai harga barunya setelah sinkron berikutnya."

- [ ] **Step 1: Write failing tests** in `outletGroupsList.test.ts`:
  - `filterOutletRows` finds "bsd" by code and "aeon" by name; the Premium filter uses the form's moved value, not the server value; an inactive outlet stays listed.
  - `deleteBlockReason` gives the default-group copy, `Pindahkan 12 outlet dulu` for 12 outlets, and null for an empty group.
  - A `renderToStaticMarkup` test of `PriceGroupsCard` for a non-admin shows no "Tambah kelompok", "Ubah nama" or "Hapus".
- [ ] **Step 2: Run** `corepack pnpm --filter @mandalika/backoffice test -- outletGroupsList`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `corepack pnpm --filter @mandalika/backoffice test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: price group chips, group dialogs and outlet assignment list`.

### Task 15: Local render vs the mock, gates, PR, HANDOFF

Reviewer: **Haiku** for the chores. First, an **Opus** whole-slice review of the slice 2 diff (against `claude/bundle-price-groups`); fix its findings in their own commits.

- [ ] **Step 1: Local stack** (localhost only; test accounts exist only there, never on run.app or pages.dev).
  - Reuse the "roletest" compose project: `docker compose -p roletest up -d` from `backend/`, with a gitignored `backend/.env` copied from the existing roletest worktree. Postgres is on port 5433.
  - `cd backend && go run ./cmd/seed` (applies 0105).
  - Start the backend with `go -C <this worktree>/backend run ./cmd/server` (:8080) and the Backoffice with `corepack pnpm --dir <this worktree>/apps/backoffice dev` (:5174). Run `corepack pnpm install --frozen-lockfile` in the worktree first if Vite cannot resolve a workspace package.
  - Test data: about 6 outlets, one inactive; Premium prices as in the mock; 3 outlets moved to Premium.
- [ ] **Step 2: Compare with the mock.**
  - Render Produk › Bundle at 1280 px as admin and open `docs/plans/2026-11-28-bundle-price-groups/mock.html` at the same width.
  - Compare them side by side: card order, columns, placeholders, disabled cells with hints, chips, outlet list, SaveBar text.
  - Repeat as a local "Semua Outlet" Manajer: everything is read-only, the note `Hanya admin yang bisa mengubah harga bundle.` shows, and there is no SaveBar or group action.
  - Exercise once: save, save again from the same tab (no stale error), a second tab saving at the old revision (stale message, then "Muat ulang"), adding and deleting a group while edits are unsaved (edits kept).
  - Save the screenshots as `docs/plans/2026-11-28-bundle-price-groups/build-admin.png`, `build-manager.png` and `mock.png`. Fix differences or list them in the PR as intended.
- [ ] **Step 3: Run the gates:** `corepack pnpm gen:check && corepack pnpm quality:ci && corepack pnpm browser:ci`. Expected: PASS.
- [ ] **Step 4: Push.** `git push -u origin claude/bundle-price-groups-backoffice` and `git push origin claude/bundle-price-groups-backoffice:gate/bundle-price-groups-backoffice`. Wait for the five gates to be green.
- [ ] **Step 5: Open the PR** into `prod-hardening`, stating that it stacks on the slice 1 PR, with the screenshots and the Claude Code attribution line at the end. Do not merge.
- [ ] **Step 6: HANDOFF.** Update the Progress board entry: the slice 2 PR, the release order (backend 0105 first, then Backoffice, no OTA), and the owner to-do after release (move the 12 outlets to Premium and fill the Premium prices). Commit it as `[CF-Pages-Skip] [skip ci] docs: HANDOFF bundle price groups Backoffice PR` and push.

---

## Decisions this plan makes (owner may correct)

- **Stale-save storage:** a one-row `bundle_price_revision` table.
  - Every successful PUT `/settings/bundles` advances it, the old body too, and returns it.
  - A PUT that sends `revision` is checked atomically.
  - The old body (no `revision`) is not checked, which keeps the old Backoffice working in the release window.
  - Group create, rename and delete lock the row but do not advance it, so an open form survives a group dialog.
- **PUT shape:** Standar always travels in the existing `standard` / `linePrices`; `groups` lists non-default groups only. `groups` or `outletGroups` present means the new shape, and `revision` is then required.
- **Version bumps:** every outlet is bumped only when a price row actually changed. An unchanged-price save no longer forces every tablet to re-pull.
- **Admin refusal** is Indonesian (`Hanya admin yang bisa mengubah harga bundle.`) through `handlers.RequireBundleAdmin`, not the English "insufficient role". The old Backoffice shows this text to a "Semua Outlet" Manajer.
- **Effective prices** ignore a group size Standar does not have, and a group line price for a size the group does not price.
- **Group cells:** a group standard cell is disabled while Standar has no price for that size, and a group line cell while the group has no standard for it. A cell that already holds a value stays editable.
- **UI copy not in the spec or mock:**
  - "Tambah kelompok harga" / "Ubah nama kelompok"
  - "Hapus kelompok <name>? Harga kelompok ini ikut terhapus."
  - "Muat ulang"
  - the Indonesian API error texts in Global Constraints
- **Exposure:** `GET /settings/bundles` stays readable by every signed-in user (the spec keeps its access), so it now also lists outlet names, codes and groups, cashiers included.

## Self-review against the spec

- **Coverage:**
  - data model and migration 0105 (T1)
  - pure rule + golden (T2)
  - `LoadPrices` with outlet; pull, Backoffice catalog and settings lookup (T3)
  - sale validation online, offline and ERP split (T4)
  - API shapes (T5); GET (T6)
  - PUT old/new body, assignment, bumps, cross-group rules, stale save (T7)
  - group CRUD with limits (T8); admin only (T9)
  - Backoffice: TS twin (T11), placeholders and payload (T12), table and read-only (T13), chips, dialogs and outlet list (T14), mock comparison (T15)
  - Aroma list subtitle (T14). Tablet impact: no POS code; the pull change is T3. Rollback SQL is in the T10 PR body.
- **Not covered by design:** a "tablet not yet updated" warning, price history, per-outlet prices (spec non-goals).
- **Type consistency:**
  - Go `write.BundleSettingsInput` (`Groups`, `OutletGroups`, `Revision *int64`, `NewShape`) maps from `api.BundleSettingsInput` (`groups`, `outletGroups`, `revision`). UUIDs travel as strings in `write`.
  - TS `BundleGroupsForm` → `BundleSettingsInput` uses the same field names.
  - `updateBundleSettings` returns `BundleSettingsSaved` in both the client and the save helper.
  - The golden JSON shape is identical for Go `TestEffectiveGolden` and TS `effectivePrices.test.ts`.
- **Review Focus pins:**
  - 1 → T7 `revision_cas`, T12 `adopts the saved revision`, `merge after a group write keeps the revision`
  - 2 → T7 `old_body_keeps_premium`
  - 3 → T7 `TestValidateBundleGroups`, `cross_group_merged_state`
  - 4 → T7 `assign_bumps_moved_only`
  - 5 → T3 `effective_prices_by_outlet`, T4 `premium_*`, T2 `premium_ext_120`
- **Gotchas checked:**
  - `write` never imports `bundles` (SQL uses `is_default`)
  - no new top-level test in `internal/api` / `internal/codegen`
  - no `nullable` on a `$ref`
  - no `package.json` change
  - writes go through `mutated` / `created` or call `invalidate`
  - `catalogue_routes_coverage_test.go` is updated for the route move (T9)
  - the BN test router follows the new middleware (T9)
  - the old `bundleSettings.test.ts` fixture is updated in T5 so typecheck stays green
