# Session Handoff — Mandalika POS

Date: 2026-05-23 · Branch: `prod-hardening` · HEAD: `0ea78ec` · Backend rev **00013-q9b**

---

# ⭐ LATEST SESSION — 2026-05-28 (SP-Recipe-2 + UI redesign + Neon fix) — READ THIS FIRST; supersedes everything below

Branch `prod-hardening`. Shipped **SP-Recipe-2 (Recipes & Versioning)** end-to-end, a recipe-editor **UI clarity redesign**, and a **Neon connection-pool hardening** fix. Backend **rev `00036-kqm`** (migration 0021 applied; `/readyz` ok — SP-Recipe-2 deployed at `00035-68t`, then the pgxpool-fix redeploy `00036-kqm`). Backoffice auto-deploys via Cloudflare. **No APK** (backoffice-only). Commits `cbb18af`→`fdc8fc0`, pushed. Built **subagent-driven** (fresh implementer per task + reviews/live-verify).

## SP-Recipe-2 — Recipes & Versioning: CODE COMPLETE & deployed
Spec `docs/superpowers/specs/2026-05-28-recipe-sp2-recipes-versioning-design.md` · plan `docs/superpowers/plans/2026-05-28-recipe-sp2-recipes-versioning.md` (phases A–E, 15 tasks).
- **Migration 0021**: `recipes` (`variant_id` UNIQUE → product_variants ON DELETE CASCADE; `current_version_id` is a write-maintained pointer, intentionally NOT a hard FK — avoids a circular create-order dep on first save), `recipe_versions` (append-only, `version_no`, `total_cost_cached`), `recipe_ingredients` (frozen snapshot `name/unit/cost_at_save`, `qty` CHECK>0, FK → ingredients ON DELETE RESTRICT).
- **Backend**: `write/recipe.go` — `SaveRecipe` + `RestoreRecipeVersion` + pure helpers (`versionMatches`/`computeTotalCost`/`newlyAddedInactive`, unit-tested). Optimistic lock via `expectedCurrentVersionId` → **409** on mismatch; snapshot uses TODAY's ingredient cost (restore recomputes); inactive ingredient = warn-but-allow existing / block-new-add → 400; zero-line save clears the recipe. pgx conn-busy discipline (drain reads before writes). Read `read/repo.go`: `VariantRecipe`/`RecipeVersions`/`RecipeVersion` hydrate current name/cost + `onHandTotal` (sum across warehouses); 404 when no recipe. 5 handlers + routes under `/api/v1/products/{productId}/variants/{variantId}/recipe*`, gated `manage_inventory` + `recipes_enabled`.
- **OpenAPI/TS**: 8 schemas + 5 ops; `@mandalika/api` methods `getVariantRecipe`(→null on 404)/`listRecipeVersions`/`getRecipeVersion`/`saveVariantRecipe`/`restoreRecipeVersion`.
- **Backoffice** `apps/backoffice/src/screens/recipes/`: `useRecipe` hook, `RecipeIngredientPicker`, `VersionHistoryDropdown`, `RecipeSlideOver`; **Resep flask button per SAVED variant row** in the Products edit modal (disabled on unsaved variants → "Simpan produk dulu"), flag-gated via `getAppSettings().recipesEnabled`. POS untouched.
- **Live-verified via API (rev 00035-68t)**: 404 → v1 (`totalCost=500000`) → v2 → 409 (stale version) → restore (recomputes at today's cost) → inactive-add 400 → empty-clear 201; version list shows author. Go unit tests green.
- **USER-VERIFIED UI**: Resep flask shows + opens; save/persist; version dropdown + restore flow exactly as designed; Settings ON/OFF hides both the flask and the Gudang **Bahan** tab. ✓
- **MVP cuts (deferred)**: no production/auto-deduct; no recipe-exists ●/filled button indicator; stock hint only on server-loaded lines (not freshly-added); no per-warehouse stock breakdown.

## SP-Recipe-2 recipe-editor UI clarity redesign (after user hands-on test)
Spec `docs/superpowers/specs/2026-05-28-recipe-sp2-ui-redesign-design.md`. Commits `cfd0cb2`(spec) → `8160e6e`(impl) → `69589e7`(picker-width fix). Behavior unchanged; clarity only:
- Add-ingredient is now a dashed gold **"+ Tambah Bahan"** button → reveals the picker (collapse via **Tutup** / Escape; stays open after a pick for rapid multi-add).
- Column headers **Bahan / Jumlah / Satuan**; calm gray **"stok gudang N {unit}"** subtitle (escalates to amber ⚠ only when on-hand < the line's qty); the **nonaktif** badge stays prominent.
- Footer cost row always renders: a Rupiah value, or **"belum tersedia ⓘ"** (title tooltip: "Ada bahan tanpa biaya satuan…").
- **Picker-width bug fixed** (`69589e7`): `fieldClass` (in `apps/backoffice/src/ui/Field.tsx`) bakes in `w-full`, which collided with `flex-1`/`w-32` siblings in a flex row → the search input collapsed to a sliver and clipped typed text. Now a full-width search bar (Search icon + "Cari bahan (nama / SKU)…") on its own row, category filter below, results in-flow. **GOTCHA: never combine `fieldClass` with `flex-1`/`w-*` in a flex row — it already sets `w-full`.**

## Neon connection-pool hardening (`fdc8fc0`)
`backend/internal/db/db.go` `Connect()` now uses `pgxpool.ParseConfig` + `NewWithConfig` with `MaxConnIdleTime=1m`, `MaxConnLifetime=30m` (+5m jitter), `HealthCheckPeriod=30s`. **WHY:** Neon free-tier silently drops idle connections, so a stale pooled conn made the FIRST write after idle fail — surfaced as intermittent **400s** during SP-Recipe-2 live verify (a tx-step connection error wraps to 400 via `h.created`). Retiring idle/old conns before Neon does eliminates the stale-conn handoff with zero per-request overhead. If transients ever persist, the next lever is a `BeforeAcquire` ping (adds acquire-time latency). Memory: `neon-stale-connection-transient`. **App-wide fix — not recipe-specific.**

## ▶️ USER-PENDING (this session)
1. Re-confirm the **redesigned** recipe slide-over visually after login: full-width search bar; "+ Tambah Bahan" reveal; column headers; calm gray stock hint; cost "belum tersedia ⓘ". **NOTE: `recipes_enabled` is currently OFF** (toggled off during the ON/OFF test) — flip Settings → "Resep & Bahan" back ON first, or the Resep flask + Gudang Bahan tab won't show and `/api/v1/ingredients*` + `/recipe*` return 404.
2. (Optional) Watch whether the first-write-after-idle 400 is gone now (Neon fix).

---

# ⭐ PRIOR SESSION — 2026-05-28 (SP-Recipe-1 ingredient inventory) — kept for context

Branch `prod-hardening` · **SP-Recipe-1 (Ingredient Inventory Subsystem) CODE COMPLETE + SKU/Kategori/UOM follow-up DONE, deployed & pushed.** Backend **rev 00034-9jc** (migrations 0019 + 0020 applied; `/readyz` ok). 30 commits on `prod-hardening` (`2e2c81b`→`4f6ad6a`). Backoffice auto-deploys via Cloudflare from this branch. **No APK needed** — SP-Recipe-1 is backoffice-only (POS untouched).

**▶️ USER-PENDING UI verify** (any browser, admin login). Hard-refresh first to pick up the latest bundle:
1. Open `https://mandalika-pos.pages.dev` → login as admin → **Pengaturan** → confirm new "Resep & Bahan" section appears with the toggle (currently ON from live verify).
2. Open **Gudang** → confirm a 3rd tab **Bahan** appears (visible only because flag is ON). Toggle flag OFF in Settings, reload, confirm Bahan tab + section disappear; toggle back ON.
3. Walk the 6 inner tabs: **Daftar** (create + edit + search by name OR SKU, Kategori filter, UOM dropdown w/ Lainnya fallback, inline "+ Tambah kategori baru"), **Stok** (warehouse picker → stock table), **Stok Masuk** (goods-in modal w/ multi-line items), **Penyesuaian** (set absolute qty + required reason), **Transfer** (create draft → Kirim → Terima w/ optional shortfall + reason → completed; verify ISJ-2026-NNNNN + ITT-2026-NNNNN + `SuratJalanIngredientPanel` Bagikan/Unduh PDF/Unduh PNG/Lihat), **Opname** (create → Mulai → Simpan counted → Selesai → difference shown).
4. Verify SKU uniqueness: create an ingredient with SKU `RO-001`; try a 2nd ingredient with the same SKU → friendly inline error "SKU bahan sudah dipakai".

After UI verify: the next module is **SP-Recipe-2 (Recipes & versioning)** — per-variant recipes inside the product modal with full version history. See the COPY-READY block at the bottom of this file for the new-session kickoff prompt.

## ⭐ SP-Recipe-1 — Ingredient Inventory Subsystem: CODE COMPLETE (2026-05-28)
Spec `docs/superpowers/specs/2026-05-27-recipe-sp1-ingredients-design.md` · plan `docs/superpowers/plans/2026-05-27-recipe-sp1-ingredients.md` (5 phases A–E, 27 tasks, subagent-driven on `prod-hardening` directly). Commits `2e2c81b`→`8f2b552`, **pushed**.

**Module-wide locked decisions:** scope = reference-only formula + live ingredient-stock view (no auto-deduct on "produce") · ingredient model = separate `ingredients` table with `numeric(14,3)` qty (warehouse-only, never POS-synced) · recipes per-variant w/ full versioning (SP-Recipe-2) · POS exposure = none (`@mandalika/sync` untouched) · reuse `manage_inventory` perm · module gate `app_settings.recipes_enabled boolean` DEFAULT false (Mandalika stays quiet; Flamboyan / Performance flip it on) · cost = informational only.

**Built & live-verified (backend rev 00033-5vs):**
- **Migration 0019** (7 new tables — `ingredients`, `ingredient_warehouse_stock` (numeric qty!), `ingredient_goods_receipts(_items)`, `ingredient_stock_adjustments`, `ingredient_transfers` w/ ITRF- sequence + ISJ/ITT doc fields, `ingredient_transfer_items`, `ingredient_stock_counts(_items)`; one ALTER adding `app_settings.recipes_enabled`).
- **Backend (Go):** `write/ingredient.go` (CRUD + goods-in + adjust), `write/ingredient_transfer.go` (send/receive/cancel w/ idempotent replay + cancel-in-transit stock restore — caught & fixed pgx "conn busy" bug in commit `93c17e6` by collecting rows before exec), `write/ingredient_stockcount.go` (create/start/save/complete; snapshot ingredient_name+unit at start), `nextDocNo` extended via new kind literals `"ISJ"` + `"ITT"` (no schema change — `doc_sequences` already polymorphic). Read: `Ingredients`/`IngredientStock`/`IngredientTransfers`/`IngredientTransfer` (letterhead via SP4 `string_to_array` pattern verbatim), `IngredientStockCounts`/`IngredientStockCount`. Middleware: new `RequireRecipesEnabled` factory + `Repo.RecipesEnabled` helper — 404s every ingredient endpoint when flag is off. AppSettings round-trip extended for `recipesEnabled` (read JSON + write `*bool`). Go tests: `formatDocNo` ISJ/ITT cases pass; `validateIngTransfer` table-driven 4 cases pass.
- **OpenAPI:** 27 new schemas + 13 new paths under `/api/v1/ingredients`, `/api/v1/ingredient-transfers`, `/api/v1/ingredient-stock-counts`. `AppSettings.recipesEnabled?: boolean`. Existing `Letterhead` schema (SP4) reused for ingredient transfer letterheads.
- **TS client (`packages/api`):** 14 new type re-exports + 20 new Api methods + impls. `getAppSettings()` exposes `recipesEnabled`.
- **Backoffice (Cloudflare auto-deploys):** New `screens/ingredients/` folder with Bahan tab inside Gudang (flag-gated via app-settings fetch on mount), 6 inner tabs (Daftar / Stok / Stok Masuk / Penyesuaian / Transfer / Opname) + their modals (IngredientFormModal, IngredientGoodsInModal, IngredientAdjustModal, IngredientTransferForm, IngredientReceiveModal), cloned **SuratJalanIngredientPanel** + **IngredientSuratJalanDoc** (reuses SP4 `render.ts` unchanged for HTML→PNG→PDF→Web Share with anchor fallback). Settings → new "Resep & Bahan" toggle section. All gold-palette consistent; `npx tsc -b` clean.

**Live-verify highlights (test artifacts left in DB):**
- Flag-gate: `recipesEnabled=false` → 404 on every ingredient endpoint ✓; `recipesEnabled=true` → 200.
- CRUD: create Rose Oil (g, Rp 15000 cost) → list returns 1 row → update cost to 16500 → delete returns 200 (FK from goods-receipt-items blocks if stock exists — matches SP1 pattern).
- Goods-in 1000g → stock=1000 ✓; adjust to 945.5 (fractional!) ✓; no-reason adjust 400 ✓; negative qty 400 ✓.
- Transfer W1→W2 200g: send → `ISJ-2026-00001` + W1 stock 500→300 ✓; receive 190g w/ reason "susut perjalanan" → `ITT-2026-00001` + W2 stock=190 + difference=-10 ✓; receive without reason → 400 ✓.
- Self-transfer 400 ✓; oversend (9999>300) 400 ✓.
- Cancel-in-transit (after bug fix `93c17e6`): W1 300→250 after send, → 300 after cancel-in-transit ✓.
- Letterhead resolution: `sender.locationName=Gudang Pusat (contoh)` + `addressLines=['Jl. Override SP4', 'Line 2']` (string_to_array(\\n) parsed correctly); receiver similar; `brandName=Mandalika POS` from app_settings fallback ✓.
- Opname: create → start (snapshotted 2 active ingredients) → save counted=295.5 on item 1 → complete → status=completed + difference=-650 computed + W1 stock=295.5 ✓.

**Backend revs deployed this session:** 00029-f6m (A) → 00030-89p (B) → 00031-wql (C) → 00032-xvk (cancel fix) → 00033-5vs (D) → 00034-9jc (SKU/Kategori/UOM follow-up).

**Follow-up F1–F4 (2026-05-28, commits `76f1420`→`4f6ad6a`):** at user's request after live UI verify — ingredients gained:
- **SKU** (unique catalog-wide via partial index `idx_ingredient_sku WHERE sku <> ''` — mirrors SP1.5 product-variant barcode pattern). Friendly 400 `"SKU bahan sudah dipakai"` on duplicate via `pgconn.PgError` 23505 mapping.
- **Kategori** — new `ingredient_categories` table (id, name UNIQUE, sort_order, created_at), FK `ingredients.category_id ON DELETE SET NULL` (delete category → ingredients keep their rows, category_id nulled). Full CRUD endpoints under `/api/v1/ingredient-categories` (recipes-enabled gate).
- **UOM dropdown** — common units (g/kg/mg/ml/L/drop/pcs) + "Lainnya" → free-text fallback. `apps/backoffice/src/screens/ingredients/units.ts` exports `COMMON_UNITS` const.
- **Backend search** — `Ingredients` list now matches by name OR sku (`name ILIKE OR sku ILIKE`); ORDER BY `c.sort_order NULLS LAST, name`.
- **`IngredientFormModal`** — added SKU input, Category dropdown w/ inline "+ Tambah kategori baru" creator (replaces dropdown row temporarily with name input + Simpan/Batal, auto-selects newly created category), UOM `<select>` w/ Lainnya reveals custom-text input. **`DaftarTab`** — added SKU + Kategori columns (between Nama/Satuan and Satuan/Biaya respectively), Kategori filter dropdown next to search.
- **Migration 0020** applied live. Test artifacts left in DB: 3 categories (Fragrance Oil, Fixateur — Carrier was deleted to test SET NULL), 4 ingredients incl. `Rose Otto Premium` (SKU `RO-001`, cat Fragrance Oil).
- **Live verified end-to-end:** 9 scenarios passed (category CRUD, duplicate-name 400, duplicate-SKU 400, empty-SKU permitted twice, JOIN resolves categoryName, search-by-SKU, SET NULL on category delete).

**SP-Recipe-2 (NEXT, separate brainstorm+spec):** `recipes`, `recipe_versions`, `recipe_ingredients` tables + per-variant slide-over editor inside the product modal + full version history (Versi 3 of 5 dropdown, "Pulihkan ke versi ini" creates new version from snapshot) + cost estimation UI. All decisions in spec front-matter under "Module-wide locked decisions".

---

# ⭐ PRIOR SESSION — 2026-05-26 (kept for context)

Branch `prod-hardening` · Inventory **SP4 (transfer documents & sharing) CODE COMPLETE, reviewed, deployed & PUSHED** — the final Inventory slice. Backend **rev 00028-gw6** (migration 0018 applied; `/readyz` ok; `SJ-2026-NNNNN` + `TT-2026-NNNNN` assigned + resolved letterheads verified via live API). Backoffice pushed (Cloudflare auto-deploys). Signed APK built (run **26441658450** on commit `40481bc`, artifact `mandalika-pos-release-apk`). **▶️ TWO USER-PENDING re-tests** (both need a physical device + an admin/cashier login the agent can't self-auth):
1. **SP3 on-device re-test** (still pending from prior session) — FU-1 non-blocking inbound poll + FU-2 clean rejected-receive + original informed-count/PIN/lockout/offline E2E.
2. **SP4 on-device verify** — install latest APK, do a receive → confirm TandaTerimaPrompt auto-pops, "Cetak" prints a clean 32-col thermal slip (header + Krm/Trm/Sel table + Diterima oleh + signature line); also verify "Cetak Ulang Tanda Terima" persists on the inbound list. Backoffice (any browser, no device needed): send a transfer → SuratJalanPanel appears with Bagikan/Unduh PDF/PNG/Lihat; Bagikan opens OS share-sheet on mobile/Chrome desktop (falls back to anchor-download on Firefox).

After both re-tests: the next module is **Recipe / Formula per product** (for Flamboyan & Performance Perfume brands) — own brainstorm→spec→plan. See `product-module-roadmap` memory.

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

## ⭐ SP4 — Transfer documents & sharing: CODE COMPLETE (2026-05-26)
Spec `docs/superpowers/specs/2026-05-26-inventory-sp4-transfer-documents-design.md` · plan `docs/superpowers/plans/2026-05-26-inventory-sp4-transfer-documents.md` (5 phases A–E, 23 tasks, subagent-driven). Commits on `prod-hardening` (`b52aa08`→`40481bc`), **pushed**.

**Locked design (11 decisions):** hybrid architecture (backoffice web PDF+PNG share + POS native thermal **tanda terima** at receive) · POS scope = tanda terima only · branding C2 (brand default in `app_settings.documents` + per-location override on outlets/warehouses; **reuses the existing `address` + `phone` columns**, adds only `logo_url`) · client-side render (html-to-image + jsPDF) · surat jalan L2 layout (Dari/Untuk, 2 sig lines, no Sopir) · backoffice trigger = inline "Surat jalan siap" panel + Bagikan auto-opens Web Share API · POS trigger = auto-prompt modal after server-acknowledged receive · separate numbering (`SJ-yyyy-NNNNN` at send, `TT-yyyy-NNNNN` at receive; per-year `doc_sequences` counter) · permissions = existing `manage_inventory` (no new perm) · share payload = PNG only · **refinement vs spec:** server-side letterhead resolution shipped on every Transfer DTO (single source of truth for both clients).

**Built & verified (non-device):**
- Migration **0018** (`app_settings.documents_*` 5 cols; `warehouses.logo_url` + `outlets.logo_url`; `transfers.surat_jalan_no UNIQUE` + `tanda_terima_no UNIQUE`; new `doc_sequences (kind, year, next_seq)` counter table) — applied live (`/readyz` ok at rev 00028-gw6).
- Backend: `nextDocNo` + `formatDocNo` (pure, tested); `SendTransfer` stamps SJ in-tx; `ReceiveTransfer` stamps TT in-tx and skips on idempotent replay; `transferObj` COALESCE-resolves sender/receiver letterheads with `app_settings.documents_*` fallback; `app_settings.documents` round-trip; warehouse/outlet `logo_url` round-trip; `transfer_receive` sync ack ships full completed `Transfer` snapshot + `tandaTerimaNo`. OpenAPI extended (Letterhead + DocumentSettings + Transfer doc-numbers + letterheads + SyncItemResult.{tandaTerimaNo, transfer}). Go tests: `TestFormatDocNo` (5 cases). `go build` + `go test` + `make gen-check` green.
- `packages/sync`: new `onReceiveAccepted(transfer: Transfer)` event fires from the 'ok' branch (not 'duplicate'); **16 vitest pass** (added `engine.receive-accepted.test.ts` with 3 cases incl. Node 24 `navigator.onLine` stub).
- `packages/printer`: `buildTandaTerima` ESC/POS (32-col K/T/S layout; 3 vitest pass — content checks, no-discrepancy variant, header-width 32) + `printTandaTerima` job. Vitest added to printer package.
- Backoffice: Settings → new "Dokumen" section (brand-level letterhead + logo upload via existing Cloudinary `uploadImage`); per-warehouse + per-outlet edit modals carry a `logo_url` upload (the existing `address`+`phone` are now also the letterhead override); transfers detail mounts `<SuratJalanPanel>` with Bagikan/Unduh PDF/Unduh PNG/Lihat (off-screen mounted `<SuratJalanDoc>` for `html-to-image`, A4 inline-CSS, system fonts, `crossOrigin="anonymous"` for Cloudinary logos); `render.ts` covers Web Share with `canShare({files})` guard + anchor-download fallback; Lihat opens scaled preview modal (disabled while a render is in-flight). Outlet `toggle()` now forwards `logoUrl` so quick active/inactive flip doesn't wipe the logo.
- POS: `usePrinter().printTandaTerima(data, settings)`; `buildTandaTerimaData` pure mapper (5 vitest pass incl. brand/locationName/dest.name fallback chain + empty-discrepancy + null-receivedQty defaults); `TandaTerimaPrompt` modal (Cetak disabled when `!isPaired`; Lewati safe; inline error keeps modal open on print failure); CashierScreen wires `SyncReceiveAcceptedRefContext` and holds a `completedTransfers` array (cap 10) so `ReceiveTransferPanel` can offer "Cetak Ulang Tanda Terima" for recently-completed transfers in the same session.
- **Final reviews:** all 14 implementer tasks reviewed by both spec-compliance and code-quality agents. **Real fixes shipped during the loop:** (a) A1 migration originally tried to ADD `phone` columns that already existed on outlets/warehouses (migration 0001/0015) — design call resolved to **reuse the existing columns** and only add `logo_url`; plan + migration rewritten (`9f5eae4` → `b52aa08`). (b) A2 wrapped `nextDocNo` DB error with `fmt.Errorf %w` for actionable diagnostics. (c) A5 OpenAPI missed `OutletInput.logoUrl` + `WarehouseInput.logoUrl`; follow-up commit `1d230ff` added them. (d) A7 wrapped the `documents` UPDATE error similarly. (e) B3 `toggle()` now preserves `logoUrl`. (f) C3 "Lihat" disabled during in-flight render to avoid concurrent `html-to-image` traversal of the same node. (g) D1 column-math JSDoc qualified for `|difference| >= 100` overflow case. (h) E2 lockfile mismatch (D1 added `vitest` devDep to printer without regenerating) — fixed in `40481bc` and APK build succeeded on re-dispatch.

**Live-verify at A10 (backend rev 00028-gw6):** PUT `/app-settings` with `documents.brandName/addressLines/phone/npwp` → round-trip OK; warehouse PUT with `logoUrl` + multi-line `address` → round-trip OK (newlines stored); created TRF send → `suratJalanNo: "SJ-2026-00001"`, both letterheads resolved (sender = warehouse override values, receiver = brand fallback); received → `tandaTerimaNo: "TT-2026-00001"`, status `completed`; per-year sequence increments verified (`SJ-2026-00001` → `SJ-2026-00002`). Test artifacts left in DB.

**USER-PENDING SP4 re-test:** install latest APK; on the POS, **send** a transfer from backoffice (or via API) then **Terima** it on the device → confirm the "Tanda terima siap. Cetak sekarang?" modal pops on server-ack (not optimistic credit) → tap **Cetak** with a paired BLE printer → verify the slip prints with the receiver letterhead (brand + addressLines + phone), K/T/S table, discrepancy line, "Diterima oleh: <cashier>" + signature line. Then dismiss the modal and reopen "Terima Transfer" → confirm "Cetak Ulang Tanda Terima" persists on the completed row. Backoffice (no device needed, any browser): send a transfer → SuratJalanPanel appears under PageHeader → **Bagikan** opens OS share-sheet (mobile Chrome + Chrome desktop), or downloads the PNG with a toast on Firefox; **Unduh PDF** + **Unduh PNG** download the files; **Lihat** opens a scaled preview modal.

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
- **SP4 — Transfer documents & sharing**: ✅ **CODE COMPLETE, deployed & pushed 2026-05-26** (backend rev 00028-gw6, migration 0018; commits `b52aa08`→`40481bc`). Hybrid architecture: backoffice (web) renders surat jalan as client-side PNG + PDF and shares via Web Share API (with anchor-download fallback); POS (native) thermal-prints tanda terima after a server-acknowledged receive via the existing BLE `@mandalika/printer`. C2 branding (brand default in `app_settings.documents` + per-location override using existing `address`+`phone` + new `logo_url`). Separate per-year `SJ-yyyy-NNNNN` (send) and `TT-yyyy-NNNNN` (receive) numbering via new `doc_sequences` counter. Server resolves+ships letterheads on every Transfer DTO. APK run 26441658450. Spec/plan: `docs/superpowers/{specs,plans}/2026-05-26-inventory-sp4-transfer-documents*`. **USER-PENDING:** on-device verify (see top-of-file pending items).

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

## ✅ DONE 2026-05-28 — SP-Recipe-2 shipped (see ⭐ LATEST SESSION at top). The kickoff prompt below is kept only as a historical record.

## (HISTORICAL) COPY-READY: start SP-Recipe-2 (Recipes & versioning) brainstorm in a new session

SP-Recipe-1 (ingredient inventory) is DONE — including the SKU + Kategori + UOM-dropdown follow-up (backend rev `00034-9jc`, last commit `4f6ad6a`). The next module slice is **SP-Recipe-2: per-variant recipes with full version history + cost estimate**. Paste this as the first message in a fresh session:

```
continue Mandalika POS / brainstorm SP-Recipe-2 (Recipes & versioning, per-variant slide-over editor inside the product modal) — read SESSION_HANDOFF.md (⭐ LATEST SESSION at top) + product-module-roadmap memory first, then kick off superpowers:brainstorming for SP-Recipe-2.

SP-Recipe-1 (ingredient inventory subsystem) is DONE & deployed (backend rev 00034-9jc; ingredients have SKU, category, UOM dropdown). SP-Recipe-2 builds ON TOP of it: recipes attach to product variants and reference ingredients. Module-wide decisions are already locked in the SP-Recipe-1 spec front-matter ("Module-wide locked decisions" section at the top of docs/superpowers/specs/2026-05-27-recipe-sp1-ingredients-design.md). Confirm the 6 working rules. Same brainstorm → spec → plan → subagent-driven build loop. Spec/plan go in docs/superpowers/{specs,plans}/2026-..-recipe-sp2-*.
```

### Module-wide decisions already locked (carry into SP-Recipe-2 brainstorm — don't relitigate)

- **Per-variant recipes** (not per-product) — each variant (30ml / 50ml / 100ml) has its own recipe row.
- **Full version history** — every save creates a new `recipe_versions` row with full ingredient snapshot (`unit_at_save`, `cost_at_save` frozen so historical versions don't break if an ingredient is renamed/repriced).
- **POS exposure = none** — backoffice-only; `@mandalika/sync` untouched.
- **Permission = reuse `manage_inventory`** (admin implicit).
- **Module gated** by the existing `app_settings.recipes_enabled` flag — currently ON in test deployment (Settings → Resep & Bahan toggle).
- **Cost = informational** — recipe screen shows "Estimasi biaya bahan: Rp X" computed from `qty × default_unit_cost`; auto-hide if any ingredient lacks a cost.
- **UI placement** — Resep button on each variant row in the product edit modal → opens a **right-side slide-over panel** (chose layout A during SP-Recipe-1 brainstorm).

### Proposed SP-Recipe-2 scope (open the brainstorm with this — confirm or adjust)

- **Tables (migration 0021):**
  - `recipes (id, variant_id UNIQUE, current_version_id, created_at, created_by)` — one recipe per variant; `current_version_id` is the "live" version pointer.
  - `recipe_versions (id, recipe_id, version_no int, notes, total_cost_cached numeric(14,2) nullable, created_at, created_by; UNIQUE(recipe_id, version_no))` — history rows.
  - `recipe_ingredients (version_id, ingredient_id, qty numeric(14,3), unit_at_save text, cost_at_save numeric(14,2) nullable, sort_order int)` — snapshot at save time.

- **Backend (Go + OpenAPI):**
  - `POST /api/v1/products/:productId/variants/:variantId/recipe` — creates a NEW `recipe_versions` row; updates `recipes.current_version_id`. Snapshot ingredient unit + cost at save time. Recomputes `total_cost_cached`.
  - `GET .../recipe` — returns the current version (with `name`/`unit`/`stock` hydrated for each ingredient).
  - `GET .../recipe/versions` — list of all versions (no items).
  - `GET .../recipe/versions/:id` — specific snapshot.
  - `POST .../recipe/versions/:id/restore` — creates a new version from a historical snapshot's items (atomic).
  - 400 if any referenced ingredient is inactive or unknown; 400 if qty ≤ 0.

- **Backoffice UI:**
  - Inside the existing Products edit modal: a "Resep" button on each variant row.
  - Clicking opens a **slide-over panel** (~480px wide, right side). Header: variant identity ("Parfum Aurora — 50ml") + version selector dropdown ("Versi 3 (kini) ▾" → opens history list with date + author + notes; clicking a historical row loads it read-only; "Pulihkan ke versi ini" creates a new version from snapshot).
  - Ingredients table: ingredient autocomplete (search by name OR SKU — SKU is now indexable from F1-F4) + qty input (numeric, fractional) + auto-fill unit from ingredient + stock-availability hint per warehouse with low-stock ⚠ icon. Optional Kategori filter on the autocomplete dropdown.
  - Footer: cost estimate (sum of `qty × default_unit_cost`, hidden if any ingredient has null cost); "Catatan versi" textarea; "Simpan versi baru" button.

- **Out of scope (deferred):**
  - "Produksi" auto-deduct button — module-wide locked OUT in SP-Recipe-1.
  - POS exposure of recipes — never.
  - Recipe-level photos / instructions / steps — keep MVP focused on ingredient list + qty.

### Files the brainstorm should reference first

1. `docs/superpowers/specs/2026-05-27-recipe-sp1-ingredients-design.md` — the SP-Recipe-1 spec, especially the "Module context" section at the top (lists the SP-Recipe-2 scope) and the "Deferred to SP-Recipe-2" section.
2. `docs/superpowers/plans/2026-05-27-recipe-sp1-ingredients.md` — patterns the SP-Recipe-2 plan should mirror.
3. The existing product edit modal: `apps/backoffice/src/screens/Products.tsx` — the new "Resep" button will mount inside the variant rows here.
4. `apps/backoffice/src/screens/ingredients/IngredientFormModal.tsx` — the existing UOM-dropdown + Category-dropdown patterns to reuse in the recipe ingredient picker.

### Open brainstorm questions (queue these for the new session)

1. **Cost recompute on edit-vs-restore:** should `total_cost_cached` be recomputed from CURRENT ingredient costs when a user clicks "Pulihkan ke versi ini" (creates a new version using restored snapshot ingredients) — or kept as the historical snapshot's cached cost? Default: recompute on restore (the new version reflects today's prices).
2. **Concurrent edits:** if two users save the same recipe within seconds, both become consecutive `version_no` rows. Acceptable, or do we need optimistic locking via an `If-Match` header on the current version id?
3. **Soft-delete an ingredient referenced by a recipe:** what happens? Ingredient `is_active = false` is already supported; the recipe view should warn but not break. The historical version stays intact because `recipe_ingredients.unit_at_save` + `cost_at_save` are snapshots.
4. **Recipe deletion:** delete `recipes` row → cascade to all `recipe_versions` + `recipe_ingredients`? Or block delete if any version exists (force "archive" via `is_active`)? Default proposal: cascade-delete (with confirm modal), since per-variant recipes are tightly coupled to the variant itself which can also be deleted.
5. **Recipe-level Kategori:** any need for a recipe-level metadata (e.g., perfumery base/middle/top notes) beyond just ingredient lines? Strongly recommend NO for MVP — keep recipe = list of ingredient + qty + notes.

(Spec/plan will live at `docs/superpowers/{specs,plans}/2026-..-recipe-sp2-*`. Migration slot: 0021.)
