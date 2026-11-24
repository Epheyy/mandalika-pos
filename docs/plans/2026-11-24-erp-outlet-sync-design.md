# ERP outlet sync (both directions) - design

Date: 2026-11-24. Status: owner-approved behaviour ("A, go with your picks"; names: "Keep POS names"), design doc awaiting owner approval.

## Why

Owner, 2026-11-24: "if there's a new outlet added on ERP, POS should follow, this also applies vice versa".
It was prompted by GANCIT (MANDALIKA GANDARIA CITY), an outlet that exists in the POS but not in the staging ERP. Today the two outlet lists drift apart and someone has to notice and fix each one by hand.

## Today

- The ERP catalog pull (`backend/internal/integration/erp/catalog.go`, `catalog_store.go` `applyOutletItem`) runs every 15 minutes. It only LINKS an ERP outlet to an existing, unlinked POS outlet whose code equals the ERP code or slug (case-insensitive). It sets `outlets.erp_slug` and `erp_code` and never creates an outlet. ONLINE outlets are skipped. An ERP tombstone (`deleted_at`) switches the POS outlet off. An outlet missing from a full run is only reported, never switched off. The POS name and POS code are never touched after linking.
- The ERP integration API has outlets as GET only (list + `/:code`, scope `integration:outlet:read`). `integration:outlet:write` is not referenced anywhere on ERP `main`. Outlet `type` is RETAIL, POPUP or ONLINE.
- Outlet code rule `^[A-Z0-9][A-Z0-9-]{0,18}[A-Z0-9]$` (2-20 chars) lives only in the Backoffice form (`apps/backoffice/src/screens/inventory/outletBody.ts`). The backend and DB accept any code, unique on `upper(code)`, nullable.
- A new outlet (`write.CreateOutlet`) gets `timezone` Asia/Jakarta by default and a `content_versions` row. Staff, prices and receipt templates are admin setup. Receipt templates fall back to the default.
- The relay holds a sale from an outlet with no `erp_code` ("belum terhubung ke ERP") and re-checks it every 5 minutes. Once the outlet is linked, the held sales go out. GANCIT sales are therefore not lost.

## Goals

1. A new RETAIL or POPUP outlet in the ERP appears in the POS within one pull, **switched off**, marked "from ERP, not set up yet", for an admin to finish and switch on.
2. A new outlet created in the POS is created in the ERP, once the ERP team adds the endpoint and the owner turns the switch on. GANCIT goes over on the first run.
3. Outlet names, addresses and phones stay POS-owned after linking (mapping v3, owner 2026-10-26, reaffirmed 2026-11-24 "Keep POS names"). A new ERP outlet takes the ERP name, address and phone only when it is created.

## Non-goals

- No editing in either direction after an outlet exists on both sides. The pull never renames a POS outlet, and POS edits are never sent to the ERP. The two names may drift, by design.
- No automatic switching on. That covers both new ERP outlets and outlets the ERP restores after a delete.
- ONLINE outlets stay out of the POS.
- No warehouse build in this slice (staging has no `GET /warehouses` yet; see the Warehouses section).

## Anti-goals (a failure even if it "works")

- A tablet can log in and sell at an outlet nobody has set up (wrong time zone, so wrong business dates).
- Duplicate outlets on either side, or two POS outlets linked to one ERP outlet.
- The POS calls an ERP write endpoint without the owner's say-so. The switch defaults off, and turning it on against staging needs the owner's approval typed in the session that does it.
- A POS order-number prefix changes because the ERP changed a code.

## Approaches considered

1. **Chosen: extend the existing pull.** It creates outlets in `applyOutletItem`, and a new push step runs in the same pull run after the outlet pull. It reuses the pull's lock, budget, run notes and 15-minute schedule. Ordering is safe: the outlet pull links anything that already matches by code before the push looks for unlinked outlets.
2. Push at save time in the Backoffice outlet handler. Rejected: the admin's save would fail or hang whenever the ERP is slow or down, and there is no retry.
3. Push through the relay outbox. Rejected: the outbox is built for sales/stock documents (location holds, document kinds, dead-letter). An outlet is master data, and the pull already owns master data.

## Design

### ERP to POS (in `applyOutletItem`)

For an ERP outlet that is not a tombstone, is not ONLINE, and has no POS outlet linked to its slug, and when no unlinked POS outlet matches by code or slug (the existing link path runs first and is unchanged):

- **Create** a POS outlet with:
  - `name` = ERP name (spaces collapsed);
  - `code` = upper(ERP code);
  - `address` and `phone` from the ERP when present, otherwise NULL;
  - `is_active=false`, `timezone` default (Asia/Jakarta);
  - `erp_slug` and `erp_code` set;
  - `setup_pending=true` (new column, below);
  - plus its `content_versions` row (same as `CreateOutlet`);
  - bump `outlets`.
- If the ERP code fails the POS code rule (checked in Go with the same regex as the Backoffice), do not create. Write a run note "outlet X not created: code ... not valid for POS".
- If `upper(code)` is already used by a POS outlet that is linked to a different ERP slug, do not create. Write a run note (code clash). This can happen when the ERP swaps or reuses codes.
- More than one unlinked match stays an item error (unchanged).

For an ERP outlet already linked by slug:

- `erp_code` follows the ERP (unchanged).
- The POS `name`, `address`, `phone` and `code` are never written (unchanged, mapping v3). The code is also the order-number prefix.
- A tombstone switches the outlet off (unchanged). Nothing ever switches an outlet on.

Missing from a full run: still report-only (unchanged).

### "Not set up yet" marker

- Migration `0101_outlets_setup_pending.sql`, additive: `ALTER TABLE outlets ADD COLUMN setup_pending boolean NOT NULL DEFAULT false`. Existing rows are false. Renumbered from 0098 (taken by PR #166; 0099-0100 reserved by the promo and void-policy sessions).
- Only the pull sets it to true, on create. `write.UpdateOutlet` clears it when the saved `is_active` is true. Admin switching the outlet on is the "set up" signal.
- The outlet read (`read/outlets.go`, OpenAPI `Outlet` schema) returns `setupPending`. The Backoffice outlet list shows a badge "Dari ERP · belum diatur". The outlet form shows a one-line hint: check the time zone, staff and receipt before switching it on.
- The POS app ignores the new field. Inactive outlets are already not usable on tablets (builder: confirm the tablet outlet picker and login filter `is_active`).

### POS to ERP (new push step, behind a switch)

- **Switch:** env `ERP_OUTLET_PUSH_ENABLED`, parsed like `ERP_INTEGRATION_ENABLED`, default false. It only has effect when the ERP integration itself is enabled. The deployed backend does not set it. Turning it on is an owner-approved config change, and the ERP key also needs scope `integration:outlet:write`.
- **When:** in `Syncer.Run`, after the outlet resource completes, before finished goods. It runs only when the switch is on. It is not a paged/watermarked resource. It is a small step with its own `catalog_sync_runs`-style row (or a report entry and notes; builder's call, as long as the run report shows what was pushed and what failed).
- **Which outlets:** `is_active AND erp_slug IS NULL AND code` passes the code rule, oldest first, at most 10 per run (`maxOutletPushPerRun`). Inactive or invalid-code outlets are never pushed. An invalid code becomes a run note.
- **Request:** `POST /outlets` on the integration API (shape in `docs/integration/2026-11-24-erp-outlet-create-request.md`):
  - `Idempotency-Key` = body `external_id` = the POS outlet UUID;
  - body: `external_id`, `code`, `name`, `type` = `RETAIL` (the POS has no outlet type; owner can change it in the ERP), `address`, `phone`.
- **On 200/201** (`applied` or `replayed`): set `erp_slug` and `erp_code` from the response and bump `outlets`. From then on it is a normal linked outlet. Its held sales go out on the next relay pass only if the ERP has also registered the outlet for the `pos_mandalika` client. Today the staging client covers only BSD, LWB and MKS, and the relay keeps location-422s held, not dead. That is asked of the ERP team (request doc, question 0) and is not promised here.
- **Contract not confirmed yet (builder's call, Claude):** the endpoint shape is our request, not an ERP answer. Build the client tolerant:
  - success = 200 or 201 with either envelope the relay already accepts (`classify.go`: `{"status":"success"}` or `{"success":true}`);
  - read the slug from `data.outlet.slug` or `data.slug`;
  - treat a missing `details.slug` on 409 as unknown.
  
  Keep the shape in one decoder so a contract change is a one-file edit. Nothing calls the real ERP until the owner turns the switch on.
- **On 409 `OUTLET_CODE_TAKEN`:** do not link automatically (it might be a different shop). Write a run note naming the ERP slug from `details`. The next pull links it by code if the codes match exactly, which is the existing link rule. An admin resolves anything else.
- **On 422/409 (other), 401/403:** run note, try again next run (cheap: at most 10 calls per 15 minutes).
- **On 404/405 (endpoint not deployed), 5xx or timeout:** run note, stop the push step for this run. Finished goods still run.
- **Loop safety:** ERP-created outlets arrive with `erp_slug` set, so they are never pushed. A pushed outlet gets its slug, so it is never pushed twice. Idempotency on the POS UUID makes a lost response safe.
- **Client:** `erp.Client.CreateOutlet` next to the existing GET methods. `erpstub` gets `POST /outlets` (stores the outlet, returns slug, honours the idempotency key, 409 on a code clash) for tests and local e2e.

### ERP team request

`docs/integration/2026-11-24-erp-outlet-create-request.md`, in Indonesian and English: endpoint, scope, fields, idempotency, success and error shapes. It follows the conventions of the ERP's existing `POST /stock-documents`:
- `Idempotency-Key` must equal a body id;
- 409 `CONFLICT` for the same key with another payload;
- 422 `VALIDATION_ERROR`;
- error envelope `{success:false, error, message, code, details?, requestId}`.

### Warehouses (design only, not built here)

ERP `main` has `GET /warehouses` (scope `integration:warehouse:read`), but staging answers 404. Rows have `slug, name, type[], address, latitude, longitude, updated_at`, with no code and no `deleted_at` (deleted rows are filtered out). Detail adds the linked outlets. When staging has it:
- pull warehouses as a third resource;
- link a POS warehouse by name (POS warehouses have codes, ERP ones do not) or by hand in the Backoffice;
- create missing ones switched off with the same `setup_pending` marker;
- a warehouse missing from the list is report-only.

That is a separate slice with its own owner check, because linking by name is weaker than by code.

## Tests (TDD)

- Postgres tests in `catalog_test.go` style against a real DB:
  - create RETAIL and POPUP (off, pending, content_versions row);
  - ONLINE skipped;
  - invalid code noted, not created;
  - code clash noted;
  - existing link-by-code path unchanged;
  - an ERP rename does not touch the POS name;
  - POS code unchanged on ERP code change;
  - tombstone switches off;
  - never switches on;
  - full-run missing stays report-only.
- `UpdateOutlet` clears `setup_pending` on activation.
- Push step against `erpstub`:
  - switch off means no call;
  - only active, unlinked, valid-code outlets pushed, max 10;
  - success links;
  - replay links;
  - 409 code-taken note without a link;
  - 404 stops the step and finished goods still run;
  - an ERP-created outlet is never pushed.
- Backoffice: badge and hint render for `setupPending`.
- OpenAPI codegen updated. If a new top-level test is added in `internal/api` or `internal/codegen`, add it to `scripts/ci/codegen_gate.py`.

## Release notes

- Backend (mig 0101) + Backoffice. No POS change, no OTA.
- At the first pull after deploy, any RETAIL/POPUP staging ERP outlet not yet in the POS is created switched off. Today that is every non-ONLINE ERP outlet without a POS twin: 32 ERP outlets minus 6 ONLINE minus 26 linked = 0 expected. Check the run notes.
- Push stays off until the ERP endpoint exists and the owner approves turning it on.

## Left to the builder

- Exact run-report shape for the push step.
- Badge styling within the existing Backoffice chips.
- Where the Go code-rule helper lives (`internal/integration/erp` or a shared `outletcode` package used by both pull and push).
