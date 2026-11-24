# ERP outlet sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The ERP catalog pull creates POS outlets for new RETAIL/POPUP ERP outlets (switched off, "not set up yet"). A switch-guarded push step creates unlinked active POS outlets in the ERP.

**Architecture:** `applyOutletItem` (backend/internal/integration/erp/catalog_store.go) gains a create path after its unchanged link path. A new column `outlets.setup_pending` marks pulled outlets until an admin activates them. `Syncer` gets an optional `Pusher`. When it is set (env `ERP_OUTLET_PUSH_ENABLED=true`), `Run` pushes after the outlets resource completes and before finished goods, through a hand-written `OutletCreateClient` modelled on `stockdoc_client.go`. The Backoffice shows a badge and a hint.

**Tech Stack:** Go 1.26, pgx/v5, PostgreSQL 18 (postgres gate `ER`), oapi-codegen + openapi-typescript, React/Vitest Backoffice.

**Spec:** `docs/plans/2026-11-24-erp-outlet-sync-design.md` (read it first). ERP request: `docs/integration/2026-11-24-erp-outlet-create-request.md`.

## Global Constraints

- POS outlet code rule: `^[A-Z0-9][A-Z0-9-]{0,18}[A-Z0-9]$`, applied to `strings.ToUpper(code)`. Same as `OUTLET_CODE_RE` in `apps/backoffice/src/screens/inventory/outletBody.ts`.
- Created outlets: `is_active=false`, `setup_pending=true`, timezone default, `code=upper(ERP code)`, name with spaces collapsed (`collapseSpaces`), address/phone from the ERP or NULL, `erp_slug`/`erp_code` set, plus a `content_versions` row. Bump `outlets`.
- Linked outlets: name, address, phone, code NEVER written (mapping v3, owner "Keep POS names"). Nothing ever sets `is_active=true`.
- ONLINE never created. Tombstones never create.
- Push: off unless `ERP_OUTLET_PUSH_ENABLED` is `true`/`1` AND the ERP integration is enabled. `maxOutletPushPerRun = 10`. Only `is_active AND erp_slug IS NULL` with a valid code, oldest `created_at` first. Body type always `RETAIL`. `Idempotency-Key` = `external_id` = outlet UUID.
- Never call a real ERP write endpoint from tests or by hand. Tests use `erpstub` or `httptest`.
- Migration `0098_outlets_setup_pending.sql` (renumber at merge if 0098 is taken).
- Commits: conventional (`feat:`/`test:`/`docs:`), ending `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (implementer: use your own model name).

## Review Focus

1. A first pull on the live DB with 26 linked outlets and GANCIT: nothing linked changes, GANCIT untouched, 0 creations expected (ER subtest `pull-create-leaves-linked-and-pos-only-alone`, Task 2).
2. An ERP code differing only in case from an existing *linked* POS outlet's code (`upper(code)` unique index) must be a run note, never a 23505 that fails the whole page (Task 2, `code-clash-is-note`).
3. The push 404s because the ERP hasn't deployed the endpoint: the push stops, the run still completes finished goods, and the report shows one note, not 10 (Task 4).
4. The response is lost after the ERP created the outlet: the next run re-sends with the same key, a `replayed` answer links, and no duplicate appears (Task 4, stub replay test).
5. An admin saves an outlet with `is_active=false` (e.g. editing the address): `setup_pending` stays true. Only activation clears it (Task 1).

---

### Task 1: `setup_pending` column, read, activation clears it

**Files:**
- Create: `backend/internal/db/migrations/0098_outlets_setup_pending.sql`
- Modify: `backend/internal/write/outlet.go` (`UpdateOutlet`), `backend/internal/read/outlets.go` (json adds `'setupPending',setup_pending`), `backend/api/openapi.yaml` (Outlet schema: `setupPending: { type: boolean }`, required, read-only, not in the write schema), regenerated `backend/internal/api/api.gen.go` and the Backoffice/POS TS types via the repo's codegen command (see `scripts/ci/codegen_gate.py` / Makefile `codegen`).
- Test: `backend/internal/handlers/erp_integration_test.go` (new subtest in `TestErpIntegrationPostgres`)

**Interfaces:**
- Produces: column `outlets.setup_pending boolean NOT NULL DEFAULT false`; API field `Outlet.setupPending: boolean`.

- [ ] **Step 1: Failing test.** Subtest `setup-pending-cleared-only-on-activation`. Insert an outlet with `setup_pending=true, is_active=false`. `write.Repo.UpdateOutlet` with `IsActive:false` leaves `setup_pending` = true. With `IsActive:true` it sets it false. Then `IsActive:false` again keeps it false (never re-set). Also assert the outlets read JSON contains `"setupPending":false` for a normal outlet.
- [ ] **Step 2: Run** `python scripts/ci/postgres_gate.py --only ER` (or the local form in the script header). Expect FAIL: column missing.
- [ ] **Step 3: Implement.** Migration: `ALTER TABLE outlets ADD COLUMN setup_pending boolean NOT NULL DEFAULT false;`. `UpdateOutlet` SQL adds `setup_pending = setup_pending AND NOT $6` (where `$6` is is_active). Read + OpenAPI + codegen.
- [ ] **Step 4: Run** the ER gate and `go test ./...` in backend, plus the codegen gate. Expect PASS.
- [ ] **Step 5: Commit** `feat: outlets.setup_pending marker for ERP-created outlets`.

### Task 2: Pull creates new ERP outlets

**Files:**
- Create: `backend/internal/integration/erp/outlet_code.go` (+ `outlet_code_test.go`)
- Modify: `backend/internal/integration/erp/catalog_store.go` (`applyOutletItem`, the `case 0:` branch), `docs/runbooks/erp-catalog-sync.md` (outlet rows of the mapping table and the "never touched" paragraph: creation now happens; name/address/phone still never written on existing rows)
- Test: `backend/internal/handlers/erp_integration_test.go` (update `full-run-empty-pos`, add subtests)

**Interfaces:**
- Produces: `func ValidPOSOutletCode(code string) bool` (input already upper-cased by the caller; exported for Task 4) in package `erp`.
- Consumes: Task 1 column.

- [ ] **Step 1: Unit test** `TestValidPOSOutletCode`:
  - true: `BSD`, `TSM-CBB`, `A1`, 20-char `ABCDEFGHIJ0123456789`;
  - false: `A`, `-BSD`, `BSD-`, `BS D`, `bsd` (lower-case is not valid; callers upper first), a 21-char code, empty.
- [ ] **Step 2: Postgres tests (ER gate).** Update `full-run-empty-pos`:
  - BSD is now created: `outlet total` 2;
  - BSD row `is_active=false AND setup_pending AND code='BSD' AND erp_slug='bsd' AND erp_code='BSD' AND name='Mandalika BSD'`;
  - `content_versions rows` 2;
  - the note no longer contains `unlinked: no POS outlet code`.
  
  New subtests:
  - `pull-creates-retail-and-popup-off`: a POPUP is created too; an ONLINE is skipped with the existing `online channel` note; address/phone copied when present.
  - `pull-create-invalid-code-is-note`: ERP code `A` → no row, note contains `not created` and `A`.
  - `code-clash-is-note`: POS outlet `KMG` linked to slug `old`; ERP outlet slug `new` code `kmg` → no new row, page completes, note names the clash.
  - `pull-create-leaves-linked-and-pos-only-alone`:
    - a linked outlet with POS name `Kemang POS` and ERP name `Mandalika Kemang`, and an unlinked POS-only `GANCIT`;
    - after a full run the linked name is unchanged;
    - GANCIT is untouched (still `erp_slug IS NULL`, active, not pending);
    - a rerun is a no-op (`erVersion` unchanged).
  - `created-outlet-never-reactivated`: create via pull, set `is_active=true` by SQL, then an ERP tombstone sets it false; the next pull with the tombstone gone (outlet back in the list) leaves it false and does not create a second row.
- [ ] **Step 3: Run** the ER gate. Expect the new and updated subtests to FAIL.
- [ ] **Step 4: Implement.** In `applyOutletItem` `case 0:`:
  - `code := strings.ToUpper(strings.TrimSpace(o.Code))`;
  - an invalid code → `itemOutcome{skipped:true, note: fmt.Sprintf("outlet %s %q (%s) not created: code not valid for POS", ...)}`;
  - check `SELECT 1 FROM outlets WHERE upper(code)=$1` → clash note `outlet %s %q (%s) not created: POS code already used by another outlet`;
  - else INSERT with the Global Constraints values plus `INSERT INTO content_versions (outlet_id) VALUES ($1) ON CONFLICT DO NOTHING`;
  - `out.bump = []string{"outlets"}`, counted as upserted (not skipped).
  
  Keep the existing link path and the ONLINE/tombstone early returns before it.
- [ ] **Step 5: Run** the ER gate + `go test ./internal/integration/erp/...`. Expect PASS.
- [ ] **Step 6: Commit** `feat: ERP pull creates new RETAIL/POPUP outlets switched off`.

### Task 3: Outlet-create client + stub endpoint

**Files:**
- Create: `backend/internal/integration/erp/outlet_create_client.go`, `outlet_create_client_test.go`, `backend/internal/integration/erp/erpstub/outlets_create.go` (+ test in `erpstub/catalog_test.go` or a new `outlets_create_test.go`)
- Modify: `backend/internal/integration/erp/erpstub/server.go` (route `POST /api/integration/v1/outlets`)

**Interfaces:**
- Produces:
  ```go
  type OutletCreate struct { ExternalID, Code, Name string; Address, Phone *string } // type is always RETAIL on the wire
  type OutletCreateResult struct { Slug, Code string; Replayed bool }
  type OutletCreateOutcome int // OutletCreated, OutletCodeTaken, OutletRejected (other 4xx), OutletEndpointMissing (404/405), OutletUnavailable (5xx, timeout, network)
  type OutletCreator interface { CreateOutlet(ctx context.Context, in OutletCreate) (OutletCreateResult, OutletCreateOutcome, string /*detail for the run note: ERP code+message, or taken-by slug*/, error /*only ctx cancel*/) }
  func NewOutletCreateClient(baseURL, apiKey string, timeout time.Duration) *OutletCreateClient
  ```
- [ ] **Step 1: Client tests** (`httptest`), asserting the request has `POST .../outlets`, `Idempotency-Key == external_id`, a JSON body with `type:"RETAIL"`, and the API-key header the same way `StockDocClient` sends it:
  - 201 `{"status":"success","data":{"status":"applied","outlet":{"slug":"gancit","code":"GANCIT"}}}` → Created, slug `gancit`;
  - 200 `{"success":true,"data":{"status":"replayed","slug":"gancit","code":"GANCIT"}}` → Created, Replayed;
  - success with no slug anywhere → Rejected (detail mentions missing slug);
  - 409 `{"code":"OUTLET_CODE_TAKEN","details":{"slug":"x"}}` → CodeTaken, detail contains `x`;
  - 409 with no details → CodeTaken, detail `unknown`;
  - 409 `CONFLICT`, 422 and 401 → Rejected;
  - 404 and 405 → EndpointMissing;
  - 503 and a timeout → Unavailable;
  - the API key never appears in any returned string.
- [ ] **Step 2: Stub tests:**
  - first POST creates the outlet; it then appears in `GET /catalog/outlets` with type RETAIL;
  - the same key and body → 200 `replayed`, same slug;
  - the same key with another body → 409 `CONFLICT`;
  - a new key with an existing code (case-insensitive) → 409 `OUTLET_CODE_TAKEN` with `details.slug`;
  - a bad code → 422.
- [ ] **Step 3: Run** `go test ./internal/integration/erp/...`. Expect FAIL.
- [ ] **Step 4: Implement.**
  - Mirror `StockDocClient` (timeout, header names, `scrub`).
  - One decoder function `decodeOutletCreate(status int, body []byte)` holds the whole contract guess (spec: "one-file edit"). Success envelope: reuse `successEnvelope` from `classify.go`.
  - The stub reuses `validateOutletInput` and the existing outlet store. Its slug = lower-cased code.
- [ ] **Step 5: Run.** Expect PASS. **Step 6: Commit** `feat: ERP outlet-create client and stub endpoint`.

### Task 4: Push step behind `ERP_OUTLET_PUSH_ENABLED`

**Files:**
- Create: `backend/internal/integration/erp/outlet_push.go`, `outlet_push_test.go`
- Modify: `catalog.go` (`Syncer.Pusher OutletCreator`; `Run` calls the push after `ResourceOutlets` completes; `CatalogReport.OutletPush *PushResult`), `catalog_store.go` or `outlet_push.go` (store: `pushCandidates`, `linkPushed`), `backend/internal/config/config.go` (`ERPOutletPushEnabled`, parsed like `parseERPEnabled`), `backend/internal/handlers/erp_catalog_pull.go` and `backend/cmd/erp-catalog-pull/main.go` (set `Pusher` only when both switches are on), `docs/runbooks/erp-catalog-sync.md` (switch, scope `integration:outlet:write`, owner approval)
- Test: `outlet_push_test.go` (fakes), ER gate subtest `push-links-unlinked-active-outlets` (against `erpstub` via the existing `newErEnv` transport, or an `httptest` stub server)

**Interfaces:**
- Consumes: `ValidPOSOutletCode` (Task 2), `OutletCreator` (Task 3).
- Produces: `type PushResult struct { Attempted, Linked int; Status string /*completed|stopped|skipped_disabled*/; Notes []string }`, plus `const ResourceOutletPush = "outlet_push"` used in logs/report only (no watermark, no `erp_sync_runs` row).

- [ ] **Step 1: Unit tests** (fake creator + fake store):
  - `Pusher == nil` → no call, `OutletPush` nil;
  - candidates are capped at 10;
  - an invalid code → note, no call;
  - Created → `linkPushed(id, slug, code)` called;
  - CodeTaken → note `outlet GANCIT not created in ERP: code taken by x`, no link;
  - EndpointMissing → one note, the step stops (no further calls), `Status=stopped`, and finished goods still run;
  - Unavailable → stops as well;
  - Rejected → note, continue with the next.
- [ ] **Step 2: ER gate subtest.** Seed:
  - active unlinked `GANCIT`;
  - inactive unlinked `TEST1`;
  - active unlinked invalid code `X`;
  - linked `BSD`;
  - a stub outlet `KMG` that the pull links first.
  
  After a full run with the pusher on: GANCIT has `erp_slug='gancit'`; TEST1 and X are untouched; the stub received exactly 1 POST; the `outlets` content version is bumped. A second run sends 0 POSTs.
- [ ] **Step 3: Run.** Expect FAIL. **Step 4: Implement.**
  - Candidates SQL: `SELECT id::text, upper(code), name, address, phone FROM outlets WHERE is_active AND erp_slug IS NULL AND code IS NOT NULL ORDER BY created_at, id LIMIT 10`; filter by `ValidPOSOutletCode` in Go.
  - `linkPushed`: `UPDATE outlets SET erp_slug=$2, erp_code=$3 WHERE id=$1 AND erp_slug IS NULL` + bump `outlets` in one tx; 0 rows means another run linked it (fine).
  - Config: `ERP_OUTLET_PUSH_ENABLED` invalid value → same fail-fast as `ERP_INTEGRATION_ENABLED`.
- [ ] **Step 5: Run** the ER gate, `go test ./...`, `go vet ./...`. Expect PASS. **Step 6: Commit** `feat: push unlinked POS outlets to the ERP behind ERP_OUTLET_PUSH_ENABLED`.

### Task 5: Backoffice badge and hint

**Files:**
- Modify: the Backoffice outlet list (`apps/backoffice/src/screens/settings/LocationsSection.tsx`) and `apps/backoffice/src/screens/inventory/OutletFormModal.tsx`
- Test: `apps/backoffice/src/screens/settings/LocationsSection.test.tsx` (create or extend) and `OutletFormModal` test (create or extend)

- [ ] **Step 1: Failing tests:**
  - an outlet with `setupPending:true` renders the badge text `Dari ERP · belum diatur`; one with `false` does not;
  - the form for a pending outlet shows exactly `Outlet ini dibuat dari ERP. Periksa zona waktu, staf dan struk sebelum mengaktifkan.`
- [ ] **Step 2: Run** `corepack pnpm --filter backoffice test -- LocationsSection OutletFormModal`. Expect FAIL.
- [ ] **Step 3: Implement** with the existing chip/badge component used in that list (no new styling system).
- [ ] **Step 4: Run** the tests + `tsc` + eslint for the touched files. Expect PASS. **Step 5: Commit** `feat: Backoffice marks ERP-created outlets not set up yet`.

### Final (controller, not implementer)

- Opus whole-branch review.
- Full local gate set: go vet/test, `quality:ci`, all postgres gates via `--go-runner docker`.
- HANDOFF entry and PR into `prod-hardening`.
- Origin `gate/erp-outlet-sync` with 5/5 green run IDs.
- No deploy, no switch flip, no ERP write.
