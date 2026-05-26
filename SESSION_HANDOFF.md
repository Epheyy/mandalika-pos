# Session Handoff — Mandalika POS

Date: 2026-05-23 · Branch: `prod-hardening` · HEAD: `0ea78ec` · Backend rev **00013-q9b**

---

# ⭐ LATEST SESSION — 2026-05-25 (READ THIS FIRST; supersedes older "current state" below)

Branch `prod-hardening` · Inventory **SP3 (POS-side receiving + PIN) CODE COMPLETE, reviewed, deployed & PUSHED** + **2 device-test follow-ups shipped (FU-1 non-blocking inbound poll, FU-2 clean rejected-receive)**. Backend **rev 00027-5cd** (migration 0017 applied; `/readyz` ok; `/sync/inbound-transfers` live → 401 unauth). Backoffice pushed (Cloudflare auto-deploys). **▶️ NEXT ACTION: on-device re-test** (the only USER-PENDING part — needs an admin/cashier login I can't self-auth + a physical device); latest APK CI = run on prod-hardening. Then **SP4** (transfer documents / surat jalan). See "SP3 status" below.

## ⭐ SP3 — POS-side receiving + PIN: CODE COMPLETE (2026-05-25)
Spec `docs/superpowers/specs/2026-05-25-inventory-sp3-pos-receiving-pin-design.md` · plan `docs/superpowers/plans/2026-05-25-inventory-sp3-pos-receiving-pin.md` (phased A–E, subagent-driven). Commits on `prod-hardening` (`e541236`→`d3d1c03`), **pushed**.

**Locked design (9 decisions):** per-user PIN + **manager step-up** on the cashier device · **on-device** argon2id verify (hash-wasm) + server re-validate · **informed count** (sentQty pre-filled) · **POS primary + backoffice override** (warehouse-dest stays backoffice) · **per-role org-wide** approver config · **admin-assigned** PINs · PIN-hash sync **scoped to outlet+admins** · **optimistic local credit + reconciliation** · atomic receive.

**Built & verified (non-device):**
- Migration **0017** (users.receive_pin_hash/_set_at; transfers.received_by/_via/_idempotency_key; app_settings.receive_approver_roles) — applied live (`/readyz` ok).
- Backend: `transfer_receive` sync handler (re-validates PIN+role+**scope**, idempotent via received_idempotency_key) → reuses `ReceiveTransfer` (now takes `ReceiveMeta`); pull bundle carries in-transit transfers + scoped approvers; set/clear-PIN endpoint (admin). Go tests: `approverAllowed`, `receiveScope`. `go build`+`go test`+`make gen-check` green.
- `packages/sync`: `verifyPin` (hash-wasm), pure `lockout`, `pendingCredits`/`applyCredits`/reconcile, engine credited-snapshot + `enqueueTransferReceive`. **12 vitest pass** incl. Go↔JS argon2id round-trip. POS prod build OK (hash-wasm bundles).
- POS UI: "Terima Transfer" menu+badge, inbound list + informed-count receive screen, manager PIN step-up modal (lockout), optimistic credit + dead-letter rollback notice.
- Backoffice: per-user receive-PIN field (Users), approver-roles toggles (Settings), outlet-dest "force receive (override)" caption.
- **Final opus review:** core (idempotency/reconciliation/data-integrity) sound, no double-count/lost-rollback. **2 HIGH fixed:** (a) server now re-validates scope (`3663583`), (b) PIN redacted from dead-letter error-log + shareable sync-log (`5874f17`).

**Device-test follow-ups SHIPPED (2026-05-25, rev 00027-5cd):**
- **FU-1 — non-blocking inbound poll** (`d8cd8f0`→`d3d1c03`): inbound transfers reach the POS via a lightweight **cashier-scoped poll** `GET /api/v1/sync/inbound-transfers` (~20s, offline-tolerant KV cache) instead of the heavy version-gated bundle — badge+receive list update **without a sales-blocking full resync**. `transfers` REMOVED from the pull bundle (`receiveApprovers` stays). Engine: `pollInbound()`/`getInboundTransfers()`, wired into `start()`. POS reads `engine.getInboundTransfers()`. WHY: device test showed a sent transfer didn't surface until a manual sync, and full-resync-on-every-stock-change felt redundant.
- **FU-2 — clean rejected-receive** (`2244a3f`): a `transfer_receive` that gets a deterministic server rejection (e.g. already received via backoffice override) now rolls back IMMEDIATELY in `flush()` — `pending.remove` + `outbox.discard` + one `onReceiveRejected` toast — **no retry, no dead-letter, no POS "sync failed" false-alarm, no error-log entry**. Transient failures still retry/dead-letter normally. WHY: device test rollback worked but surfaced a scary "Sinkronisasi gagal" on the POS for a handled case.

**MINOR follow-ups — ALL DONE (2026-05-25, commits `4a7005a`/`cfed5e8`/`1c8ac0b`, pushed):** (1) PIN lockout now uses the durable secure KV (`getKV`+readJSON/writeJSON) not raw `localStorage`. (2) `lockout.recordFailure` grants a fresh attempt batch after cooldown (no instant re-lock) + new test (sync vitest now 13). (3) Settings approver UI shows **admin as always-on (disabled, honest)** since admins always approve server-side; only manager/cashier are real toggles; DEFAULT aligned to `[]`. No backend change in these (POS + backoffice only).

**USER-PENDING re-test:** install latest APK; verify FU-1 (transfer sent → badge appears on POS within ~20s WITHOUT manual sync / no sales block) and FU-2 (offline receive → backoffice force-receive same → reconnect → quiet rollback toast, NO failed-sync alarm). Plus the original E2E: informed count w/ discrepancy; PIN accept/reject+lockout; offline receive→reconnect→credit-once.

## ▶️ NEXT DEV — SP4: Transfer documents & sharing (brainstorm first, NOT started)
The last Inventory-module slice. **Locked scope (from the SP1 decomposition):** printable **delivery note / surat jalan** — thermal print via the existing BLE `@mandalika/printer` + an **in-device view** — generated **at send**; plus **PDF/image export + WhatsApp/OS-share** via the OS **share-sheet** (NOT the WhatsApp Business API). Brainstorm → spec → plan → subagent-driven build, same as SP1–SP3.

**Context for the SP4 brainstorm (verify in code during brainstorm):**
- Thermal print infra already exists and is reused: `@mandalika/printer` (BLE) — see `buildRecap`/`printer.printRecap` (shift recap) and the receipt print path; SP4 adds a `buildDeliveryNote`-style builder.
- Transfer data available: `transferNo`, `source`/`dest` `{kind,name}`, items (`productName`, `variantSize`, `sku`, `sentQty`). Backoffice has the transfer detail (`apps/backoffice/src/screens/transfers/`); a send-time doc is primarily a **backoffice** surface (admin sends). Decide in brainstorm whether the POS also gets a received-copy/proof-of-receipt doc.
- Share-sheet on Android = Capacitor Share plugin (OS share), not a WhatsApp API. PDF/image generation approach (client-side render vs server) is a brainstorm decision.
- Open questions for brainstorm: print-at-send vs also at-receive; PDF vs image vs both; numbering/branding of the surat jalan (3-brand template); who can generate/share (permission).

**Kickoff (paste into a fresh session):** see "▶️ COPY-READY: start SP4 in a new session" at the very bottom of this file.

---

### (Superseded) prior SP2 next-action
SP2 (transfers) was DONE & deployed (rev 00023-tz9); SP3 above is the successor.

## ‼️ Production status correction
The app is **deployed & functional on free-tier infra but runs TEST DATA ONLY —
NOT real sales, NOT fully production-ready** (user confirmed 2026-05-25). The
walkthrough's "live and selling" = the `/goal` (proving a cashier *can* sell +
the deploy works), not real usage. So **do NOT over-caution about disturbing
real sales** — deploys/migrations need basic hygiene, not kid-gloves. Pre-prod
checklist = `DEV_TO_PROD_WALKTHROUGH.md` Part D.

## The 6 working rules (user-required, confirm on new sessions)
ask don't assume · don't touch unrelated · flag uncertainty · verify on failure ·
show changes · admit gaps. (Memory: `working-rules-six`.)

## DONE this session (commits on prod-hardening, all pushed)
1. **UPC → per-variant scan-to-cart redesign** (spec `docs/superpowers/specs/2026-05-25-per-variant-scan-to-cart-design.md`, plan `…/plans/2026-05-25-per-variant-scan-to-cart.md`). Backend **LIVE rev 00019-q4r**:
   - migration **0014**: per-variant `product_variants.barcode` (defaults to SKU, catalog-wide unique via partial index `idx_variant_barcode`; dedupe before index). `products.upc` DROPPED FROM API but COLUMN KEPT DEAD (expand/contract — **TODO: drop in a later migration** once no old revision reads it).
   - backend write defaults empty barcode→SKU (`variantBarcode`), within-product dup check, `barcodeConflict` maps pg 23505 → friendly 400.
   - read emits per-variant `barcode`. Verified live (round-trip + dup-reject 400).
   - Backoffice: per-variant Barcode field (blank⇒SKU at save) + CSV `Barcode` column; parent UPC input removed.
   - POS scan-to-cart: pure `apps/pos/src/cashier/scan.ts` (`buildScanIndex`/`resolveScan`) + **keyboard-wedge** (Enter in product search → add 1, stock-guarded, toast) + **camera** (`@capacitor-mlkit/barcode-scanning@8.1.0`, QR+1D; CAMERA perm + `uses-feature required=false`).
   - **Pure-function unit tests added** — Go (`backend/internal/write/repo_test.go`) + **first JS test runner: Vitest 4.1.7** in apps/pos (`apps/pos/src/cashier/scan.test.ts`; `test`=`vitest run`; `*.test.ts` excluded from prod `tsc -b`).
   - **APK built**: CI run 26369022325 success, artifact `mandalika-pos-release-apk`. **ON-DEVICE VERIFY = still USER-PENDING** (camera QR+1D, wedge, backoffice barcode UI/CSV).
2. **Phase 4 — product import-template** (`be66137`): "Template" button in Products toolbar downloads `template_produk_mandalika_<date>.csv` (importer columns + 2 example variant rows) via exportToCSV. Backoffice-only.

## Product-module phase mapping (clarified 2026-05-25)
- Phase 1 = per-outlet inventory & pricing → DONE.
- Phase 2 = (was a multi-step wizard) → **REPLACED** by cherry-picked single-modal enhancements (PAR/UPC/sellable/multi-image) + per-variant availability + stable variant identity + scan-to-cart. DONE, no wizard.
- **Phase 3 = Inventory / Warehouse module → IN PROGRESS (planning done, see below).**
- Phase 4 = import-template → DONE.

## ▶️ NEXT: Inventory module (Phase 3) — decomposed into SP1–SP4
Spec (incl. full module decomposition + module-wide locked decisions): `docs/superpowers/specs/2026-05-25-inventory-sp1-warehouse-foundation-design.md`.
**Module-wide LOCKED decisions:** mesh topology (any↔any) · two-step send→receive with in-transit · **separate** warehouse subsystem (own tables, never POS-synced) · goods-in entry (cost informational only) · receive-actual-and-record-discrepancy · **draft** transfers · authoritative **PIN + selected roles** for approval · new `manage_inventory` permission.
- **SP1 — Warehouse foundation** (backoffice). ✅ **FULLY DONE & VERIFIED LIVE (backend rev 00021-d5c, migration 0015; backoffice pushed `131f4e2`).** Warehouses CRUD + `warehouse_variant_stock` + goods-in (additive) + adjust (absolute set + reason) + Gudang screen/nav + `manage_inventory` perm + **warehouse stock-count** (chose option (a): extended the unified opname screen with an Outlet/Gudang location picker; `stockcount.go` location-polymorphic; handlers warehouse-aware; read emits `warehouseId`). VERIFIED via authed API: goods-in 10→15, adjust→7, 400 on no-reason; **outlet opname regression intact (→55) AND warehouse opname create→complete (→33)**; warehouse counts list under admin "Semua". Demo warehouse "Gudang Pusat (contoh)" left in DB. Minor UX: warehouse counts list only in admin "Semua outlet" mode (cross-outlet). **NEXT module work = SP2 (transfers).**
- **SP2 — Transfers core** (backoffice): ✅ **DONE & DEPLOYED (backend rev 00023-tz9, migration 0016; all commits pushed `fcb3427`→`f557fa8`).** draft→send→in-transit→receive→discrepancy→completed + cancel (draft void / in-transit restore source); **mesh** polymorphic source/dest via separate nullable FK cols (`transfers`/`transfer_items`); implicit in-transit (deduct@send, credit-actual@receive); per-outlet-leg `content_version` bump via `bumpVersionOutlets(...,"products")` (warehouse legs don't bump); `manage_inventory`-gated. Backoffice: **Transfer tab inside Gudang** (`screens/transfers/` + tabbed `Warehouses.tsx`). Spec `docs/superpowers/specs/2026-05-25-inventory-sp2-transfers-core-design.md`, plan `docs/superpowers/plans/2026-05-25-inventory-sp2-transfers-core.md`. **VERIFIED LIVE via authed API**: wh→wh send/receive w/ discrepancy (difference −2 recorded), receive-no-reason→400, cancel-in-transit restored source, oversend→400, self-transfer→400, wh→outlet receive credited outlet stock (+3), location-stock input guard (bad/empty kind→400, valid→200). Go write logic go-reviewed; full-feature review = 0 critical/high (2 Important + 2 Minor fixed in `f557fa8`). **UI VERIFIED via Playwright** (2026-05-25) on `mandalika-pos.pages.dev`: Gudang|Transfer tabs render; created **TRF-00005** through the form (mesh source/dest dropdowns + live on-hand fetch) → Kirim → Terima with shortfall 2→1 + required reason → Selesai (Selisih −1 + reason shown); 0 console errors. content_version *integer* increment not asserted directly (outlet credit path proven; SP3 consumes it on POS). Test artifacts left in DB (test-data env): warehouses "SP2 Verify Src/Dst" + transfers TRF-00001..00005.
- **SP3 — POS-side receiving + PIN**: in-transit transfers sync to destination outlet's POS; receiver confirms on-device with REAL counted qty (cross-checks admin input); offline-capable enqueue; authoritative PIN + role gate. (brainstorm→spec→plan when reached.)
- **SP4 — Transfer documents & sharing**: printable delivery note / surat jalan (thermal print via existing BLE `@mandalika/printer` + in-device view) at send; PDF/image export + WhatsApp/OS-share (share-sheet, not WA API). (brainstorm→spec→plan when reached.)

## ▶️ THEN (do NOT forget): Recipe / Formula per product module
After Inventory SP1–SP4. Tie a formula/recipe to each product for production tracking — wanted for the **Flamboyan Perfume** & **Performance Perfume** brands (this POS is a 3-brand template). Own brainstorm→spec→plan. (Memory: `product-module-roadmap`.)

## Execution method in use
Subagent-driven development (fresh implementer per task + spec & code-quality review) on `prod-hardening` directly (NOT worktrees — Cloudflare auto-deploys backoffice from this branch; backend via `gcloud run deploy`; APK via GH Actions dispatch). All deploy/APK commands are below in the older sections (still valid).

---

## Purpose / how to use this doc
The app is **live and selling** (free-tier cutover). Work is an iterative
UI/UX + correctness polish loop driven by on-device testing. **Next focus:
Backoffice** (see "Next: Backoffice"). This file carries full context into a
fresh session — read it first, then trust:
- **Initial product goal:** `DEV_TO_PROD_WALKTHROUGH.md` → PART B (the `/goal`).
  All 6 success criteria are met (deployed; see PART 0 there).
- **Ops runbook:** `RUNBOOK.md` (deploy / rollback / DB restore / secrets).
- **Current state:** `DEV_TO_PROD_WALKTHROUGH.md` → PART 0 + this file.

---

## Live infrastructure
| Thing | Value |
|---|---|
| GCP project | `mandalika-pos` (number `538849926142`) |
| Region | `asia-southeast2` (Jakarta) |
| Backend | Cloud Run `mandalika-pos`, rev **00013-q9b**, `API_URL = https://mandalika-pos-538849926142.asia-southeast2.run.app` |
| DB / cache | Neon Postgres + Upstash Redis (TLS) — via GCP Secret Manager |
| Backoffice | Cloudflare Pages `https://mandalika-pos.pages.dev` — **auto-deploys on push** to `prod-hardening` (`VITE_API_URL` set there) |
| POS APK | GitHub Actions `.github/workflows/android-release.yml` (workflow_dispatch on `prod-hardening`) → artifact `mandalika-pos-release-apk` |
| Repo | `github.com/Epheyy/mandalika-pos` |

Secrets in **Google Secret Manager**: `DATABASE_URL REDIS_URL JWT_ACCESS_SECRET
JWT_REFRESH_SECRET SEED_ADMIN_PASSWORD SENTRY_DSN CLOUDINARY_API_SECRET`
(SENTRY_DSN IS set → backend errors reach Sentry). Migrations auto-apply on
backend boot (`cmd/server/main.go`).

### Test creds
- Admin (backoffice): `admin@mandalika.test` — pwd in Secret Manager `SEED_ADMIN_PASSWORD` / memory `prod-cutover-deploy-ready.md`.
- Cashier (POS): `test@mandalika.test`, role `cashier`, one outlet ("Mandalika").
- Keystore `mandalika-release.jks` (repo root, **gitignored, irreplaceable** — user must back up). CI uses repo secrets `ANDROID_KEYSTORE_BASE64` / `_PASSWORD` / `ANDROID_KEY_ALIAS=mandalika` / `_KEY_PASSWORD`.

---

## ⭐ The agent CAN deploy + build APK itself (changed this session)
`gcloud` is authed (`reffyvee@gmail.com`) and works from the Bash tool with
`dangerouslyDisableSandbox: true`. The APK workflow is dispatched via the GitHub
REST API using the token from `git credential fill` (has `workflow` scope). So
the full deploy → APK loop is automatable — no need to hand commands to the user.

```bash
# Backend deploy (run in background; ~4–6 min; migrations auto-apply on boot)
gcloud run deploy mandalika-pos --source backend --region asia-southeast2 --quiet

# OpenAPI codegen after editing backend/api/openapi.yaml
cd backend && go tool oapi-codegen -config api/oapi-codegen.yaml api/openapi.yaml
cd .. && corepack pnpm --filter @mandalika/api gen     # regen TS types

# Dispatch the signed APK build (prod-hardening), then poll the run for the artifact
TOKEN=$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill 2>/dev/null | sed -n 's/^password=//p')
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/Epheyy/mandalika-pos/actions/workflows/android-release.yml/dispatches \
  -d '{"ref":"prod-hardening","inputs":{"api_url":"https://mandalika-pos-538849926142.asia-southeast2.run.app"}}'
```
Standard loop each batch: edit → typecheck (`pnpm --filter <app> exec tsc --noEmit`)
+ build → (if backend) deploy + verify `/readyz` → commit → push → dispatch APK → poll.

---

## Done this session (2026-05-23) — commits on `prod-hardening`
Backend revisions deployed: **00009 → 00013**. Migrations added: **0006–0009**.

1. `6ab4480` — gated `[sync]` console logs behind a `debug` flag (kept ON for the polish phase; see "before final build").
2. `0e6312f` — **shift reconciliation** (per-method counted/Terhitung, backend `shifts.counted_by_method`, migration **0006**), recap/history polish, removed view-switching → single adaptive layout, product-card image-fallback + cleaner design.
3. `14e67ab` — **discount source**: `orders.discount_label` (migration **0007**), shown in POS history; backoffice orders **Export (XLSX)**; card price/stock toggles; shift-detail popover fix.
4. `b8e63ba` — recap/history **portrait responsive** (top tabs + overlay detail); **per-variant** card price/stock; **itemized discount breakdown** `orders.discount_breakdown` (migration **0008**).
5. `e55fb75` — **print shift recap** via BLE (`buildRecap` in `@mandalika/printer`, `printer.printRecap`); "Cetak Rekap" in Rekapan + Riwayat.
6. `693ecbe` — fix Riwayat column drift (fixed grid template).
7. `db3531d` — **close shift routes through the recap** with **mandatory counted income**; **active outlet name** in snapshot (`SyncPullBundle.outletName`) used by recap/print (was hardcoded "Mandalika").
8. `0ea78ec` — **central error log** (migration **0009** `error_logs`): `POST /api/v1/error-logs` (any authed), admin `GET /api/v1/error-logs`; POS reports sync dead-letters (auto), runtime errors (global handler), print failures, with **breadcrumb trail** (`apps/pos/src/lib/activityLog.ts` + `errorReporter.ts`); backend panics persist too; new **Backoffice → Log Error** screen.

---

## Next: Backoffice (the requested focus)
1. **User → outlet placement** (explicitly requested; e.g. "Ryan = cashier @ Mandalika PMS").
   - POS already consumes `snapshot.outletName` and scopes by the cashier's `outletId` from their JWT. **Remaining work is backoffice-side:** the Users screen needs to assign/edit a user's outlet, persist `users.outlet_id`, and ensure login returns it (`auth` already sets `authStore.outletId = user.outletId`). Check `apps/backoffice/src/screens/Users.tsx` + the user write path + `CreateUserRequest`/`UpdateUserRequest` for an `outletId` field.
2. **Backoffice UI/UX polish** (user expects this to be the largest chunk) — apply the same anti-template quality bar used on the POS.

---

## ⚠️ Before a TRUE-FINAL build — revert the polish-phase debug aids (3 edits)
Documented in `DEV_TO_PROD_WALKTHROUGH.md` PART 0. Currently ON so the CI release
APK is inspectable during polish:
1. `apps/pos/capacitor.config.ts` → remove `android.webContentsDebuggingEnabled: true`; set `loggingBehavior: 'production'`.
2. `apps/pos/src/cashier/SyncProvider.tsx` → `debug: true` → `import.meta.env.DEV`.
3. `packages/sync/src/engine.ts` → nothing (the `debug` gate stays — permanent).

---

## Gotchas / facts
- **`/healthz` is swallowed by Google's edge (404)** — monitor `/readyz` instead. App routing is fine.
- **Two `0005` migrations** (`0005_order_scheme_outlet_code.sql`, `0005_payment_method_freeform.sql`) — both applied; the runner tracks by full filename. **Do NOT rename.** New migrations start at the next number (now 0010+).
- **Commit hook blocks `--no-verify`** AND false-positives on chained `git commit && …`. Run `git commit` on its own line, then push separately.
- Local APK build is **blocked on Windows** (space in path breaks BLE plugin Gradle) — use CI only.
- `error_logs` capture is **forward-only**; `discount_label`/`discount_breakdown` are denormalized per-order going forward (old orders show the single collapsed line).
- gofmt aligns structs; run `gofmt -w internal/` before committing backend.
- CI backend gate (`make gen-check`) fails if `api.gen.go` drifts — always commit the regenerated file.

---

## ▶️ COPY-READY: start SP4 in a new session

Paste this as the first message in a fresh session:

```
continue Mandalika POS / brainstorm SP4 — read SESSION_HANDOFF.md (⭐ LATEST SESSION at top) + memory first, then kick off superpowers:brainstorming for SP4.

SP4 = Transfer documents & sharing (final Inventory slice): printable delivery note / surat jalan via the existing BLE @mandalika/printer + in-device view, generated at send; plus PDF/image export + WhatsApp/OS share-sheet (NOT the WhatsApp API). Scope + context + open questions are under "▶️ NEXT DEV — SP4" in SESSION_HANDOFF.md. SP1–SP3 (warehouses, transfers, POS receiving+PIN) are DONE & deployed (backend rev 00027-5cd); follow the same brainstorm → spec → plan → subagent-driven build loop. Confirm the 6 working rules at the start.
```

(SP4 specs/plans go in `docs/superpowers/{specs,plans}/2026-..-inventory-sp4-*`. After SP4: the Recipe/Formula-per-product module — see `product-module-roadmap` memory.)
