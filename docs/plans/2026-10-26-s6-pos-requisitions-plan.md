# S6: Permintaan Barang on the POS tablet (cashier requisitions): plan

Date: 2026-10-26. Base: branch `inv-integration` @ 2710d54, which holds S0–S5. It is local only and not deployed. This is a plan only: no code, no deploy.
Every path is relative to the repo root, and every `file:line` was read on `inv-integration`. "Unverified" means I did not confirm the item against code.

**Mandate.** Owner answer 9 (`docs/plans/2026-10-25-inventory-controls-plan.md:587`): cashiers raise PBs on the POS tablet (create, submit, cancel, track status) through the S5 endpoints. This needs a POS release: OTA if the change is web-only, APK if native. It supersedes the earlier "S5 POS impact: none" line (`:433`).

---

## 1. Spec (what the cashier sees and does)

**Entry point.** A new item **Permintaan Barang** in the Operasional column of the menu drawer, next to *Terima Transfer* and *Riwayat Transfer* (`apps/pos/src/cashier/MenuDrawer.tsx:121-130`). It is shown only when the signed-in user may request stock (§2).

| Screen | The cashier sees | The cashier can |
|---|---|---|
| **List** | This outlet's PBs, newest first: number (`PB-2026-00001`), status badge, needed-by date, created by, linked transfer number and status. Filter chips: Semua / Draf / Diajukan / Disetujui / Transfer Dibuat / Ditolak / Dibatalkan. | Open a PB. "Buat Permintaan". Pull to refresh / "Muat ulang". |
| **Detail** | Status chain **Draf → Diajukan → Disetujui → Transfer Dibuat → Dikirim → Diterima**. The last two come from `transfer.status` (`in_transit` / `completed`). Rejected and cancelled show as a dead-end badge with the warehouse's decision note. Also shown: lines (product · size · SKU, qty diminta, qty disetujui, qty dikirim), source gudang, and history (events with actor and time). | Draft: **Ubah**, **Ajukan**, **Batalkan**. Submitted: **Batalkan**. Transfer `in_transit`: **Buka Terima Transfer**, which closes the panel and opens the existing receive panel (A08 step-up unchanged). Anything else is read-only. |
| **Form** (create / edit a draft) | Variant picker over the tablet's cached catalog (search by name/SKU; product · size · SKU; hint "Stok outlet: N"). Per-line qty (integer ≥ 1). "Dibutuhkan pada" date (optional). Catatan (optional). | Add or remove lines (one line per product+size; the server refuses duplicates). **Simpan Draf**, or **Simpan & Ajukan** (create, then submit). |

**What a cashier can never do on the tablet:**
- approve, reject, fulfil ("Buat Transfer"), or choose a source gudang;
- see another outlet's PBs;
- edit a PB after it is submitted.

The server already enforces all of this (§2). The POS also never renders or calls those actions, whatever permissions the user holds.

**Server facts this relies on:**

| Fact | Evidence |
|---|---|
| Reads: any authenticated user, permission checked in the handler (`request_stock` or `manage_inventory`) | `backend/internal/server/server.go:179-181`; `backend/internal/handlers/requisitions.go:37-43`, `:67-72`, `:88-93` |
| Outlet writes behind `RequirePermission("request_stock")` only, no role gate | `server.go:365-372` |
| Approve / reject / fulfil behind `manage_inventory` | `server.go:373-379` |
| Write outlet = the request context's outlet. A non-admin `X-Outlet-Id` ≠ the token outlet → 403 | `requisitions.go:31-34`, `:115-124`; `backend/internal/middleware/middleware.go:28-38` |
| Another outlet's PB → 404 on writes | `backend/internal/write/requisition_repo.go:49-58` |
| Outlet staff read only their own outlet. `manage_inventory` / admin also read every submitted PB | `backend/internal/read/requisition.go:10-13`, `:65-72` |
| Status flow; cancel allowed from draft or submitted; edit on drafts only | `backend/internal/write/requisition.go:67-92`; `requisition_repo.go:171-229` |
| Validation: ≥1 line, qty > 0, no duplicate product+size, uuid product, non-empty size, `YYYY-MM-DD` date | `requisition.go:99-121`; `backend/internal/write/transfer.go:83-105` |
| Idempotency-Key is required on all 7 writes → 400 `header Idempotency-Key wajib` | `requisitions.go:47-53` |
| Four-eyes: creator, editor or submitter can't decide or fulfil | `requisition_repo.go:80-96` |
| Proven for a `cashier` token with only `request_stock`, plus spoofing and scope cases (gate RQ) | `backend/internal/handlers/requisition_integration_test.go:117-121`, `:278-293` |

Note: the RQ test builds its own router mirroring `server.go` (`requisition_integration_test.go:124-140`). The real `server.go` grouping is therefore not pinned by a test (unverified that another test does it). §6 adds a hosted smoke for that.

## 2. Permissions and rollout

| Topic | Finding | Plan |
|---|---|---|
| Where permissions live | Tokens carry `user_permissions` only (`backend/internal/auth/store.go:53`, `:81-99`). Custom roles are templates that the Users screen copies into a user's permissions when editing (`apps/backoffice/src/screens/Users.tsx:365`). There are no role defaults: a new user starts with `[]` (`Users.tsx:115`). | Grant `request_stock` per account in Backoffice → Pengguna (label "Ajukan Permintaan Barang", `apps/backoffice/src/screens/users/PermissionPicker.tsx:16`). **No migration by default** (Q1). |
| Shared terminal account | Owner decision 2026-10-10: a shared terminal account per tablet (`HANDOFF.md:179`). | Granting the permission enables PBs for everyone using that tablet. `requested_by` and the history show the terminal account, not a person (Q2). |
| Getting a grant onto the tablet | Refresh rotation re-reads the user and permissions (`backend/internal/auth/sessions.go:133` → `store.go:53`). The access TTL defaults to 15 min (`backend/internal/config/config.go:203`). On a silent refresh the POS replaces the cached user (`apps/pos/src/auth.tsx:110-122`). | No re-login. The menu item appears after the next silent refresh, at most about 15 min plus the next request. Release note for the admin: "tunggu ±15 menit atau buka ulang aplikasi". Revocation lags the same way; the server refuses with 403 in the meantime. |
| Admin / manager on the tablet | Any role may sign into the POS (`auth.tsx:36-41`). `HasPermission` lets admin through (`backend/internal/auth/permissions.go:9-11`). A `manage_inventory` reader sees every outlet's submitted PBs (`read/requisition.go:68-69`). | The POS **always** sends `outletId=<authStore.outletId>` on the list call (`apps/pos/src/api.ts:28-35`). Four-eyes still blocks a creator from approving in the backoffice. |
| UI gate | Pattern: `canRefund` reads the cached user (`packages/types/src/index.ts:76`). `REQUEST_STOCK` exists (`:54`). | Add `canRequestStock(user)` = `role === 'admin' \|\| permissions.includes('request_stock')` next to `canRefund`. A 403 from the server shows the revoked copy (§4) and hides the item until the next refresh. |

## 3. Online-only design (no outbox)

**Rule.** PB calls go straight through `api.*` (`packages/api/src/client.ts:408-413`, `:940-950`), as `TransferHistoryPanel` does today (`apps/pos/src/cashier/TransferHistoryPanel.tsx:37-45`).
- They are **never** enqueued.
- `packages/sync` (SyncEngine, outbox, journal) is **not touched**.
- Reachability comes from `useOfflineData().isOnline`, i.e. the engine's real reachability (`apps/pos/src/hooks/useOfflineData.ts:81-88`).

| Situation | Behaviour |
|---|---|
| Offline when opening | Panel shows "Permintaan Barang butuh koneksi internet." and "Coba Lagi". No cached list in v1. |
| Offline when pressing a write | Refused before any call (pattern: `receiveApprovalFlow.ts:6`, `:50-52`). The form content is kept. |
| Network error / timeout (`ApiError.kind` `network` / `timeout`, `client.ts:205-218`) | Keep the **same Idempotency-Key**, show "Server belum menjawab. Tekan Coba Lagi — permintaan tidak akan tercatat dua kali." The server runs the effect once per key and replays the stored outcome (`backend/internal/service/receipts.go:36-37`; `backend/internal/handlers/keyed_write.go:62-120`). |
| Same key, different content → 409 `kunci idempotensi sudah dipakai…` (`receipts.go:20`) | Should not happen: the key is tied to a content signature. If it does, mint a new key and ask the cashier to save again. |
| Submit/cancel 409 `aksi tidak diizinkan dari status '…'` (`requisition.go:56-58`, mapped by `backend/internal/handlers/stock_counts.go:57-59`) | Treat as "status changed": refetch and show the current PB (e.g. a retried submit after a lost response with a fresh key). |
| 404 | Detail: "Permintaan tidak ditemukan", back to the list. List: "Fitur Permintaan Barang belum aktif di server" (an old backend; guarded by release order §5). |
| 403 | "Akun ini belum punya izin Permintaan Barang. Minta admin menambahkan izin." |
| 400 | Show the server's Indonesian text (e.g. `qty harus lebih dari 0`, duplicate line). The cashier edits, which changes the signature and mints a new key. |

**Keys.**
- One key per (operation, outlet, PB id or "new", content signature), copying the backoffice rule (`apps/backoffice/src/screens/requisitions/RequisitionForm.tsx:51-58`, `:90`).
- Key scope on the server is `user:<id>` (`keyed_write.go:78`). UUID keys don't collide on a shared account.
- Mint with `crypto.randomUUID`, with the existing fallback (`apps/pos/src/cashier/CashierScreen.tsx:507-508`).
- **Create** is the only write whose lost key duplicates a document: a fresh key means a second draft PB. So the pending create `{sig, key, form}` is **persisted** in the app KV (`getKV()`, as at `auth.tsx:174`), keyed by user and outlet, and cleared on success.
  - This also restores a half-typed form after an app restart.
- Update, submit and cancel keys stay in memory. After a restart they get a fresh key. The outcome is harmless: an update re-applies the same content plus one extra `updated` history row; submit/cancel get the 409 above.
- A single-flight gate per action blocks double taps (`apps/pos/src/lib/durableSubmit.ts:20-36`).

**SyncEngine / auto-pull interaction.**
- Opening the panel adds a new `showRequisitions` flag to `AutoPullFlags` and `AUTO_PULL_IDLE` (`apps/pos/src/cashier/autoPullGate.ts:7-36`, `:38+`), passed in at `CashierScreen.tsx:276-284`. This is the same treatment as every other panel: the catalog is not swapped under an open form.
- The engine's queue, flush and reachability are otherwise untouched.

**Request deadline gap.**
- `client.ts` has no default request deadline: the A29 client half is open (`HANDOFF.md:19`, `:245`).
- The requisition methods take no `RequestOptions` (`client.ts:943-950`; options type `:221-225`). A hung request would spin forever.
- Plan: S6-0 adds an optional `opts?: RequestOptions` to the six outlet-side methods, as a serialized S0b commit (`docs/plans/2026-10-25-inventory-controls-plan.md:440-444`). The POS passes `timeoutMs: 20000`. A retry after a timeout is safe because it reuses the key.

## 4. Screens, components, copy

**New folder `apps/pos/src/cashier/requisitions/`:**

| File | Role |
|---|---|
| `requisitionFlow.ts` | Pure, deps-injected (`isOnline`, `api`), never throws. Maps every outcome of §3 to `{kind: 'ok' \| 'offline' \| 'retry' \| 'stale' \| 'gone' \| 'forbidden' \| 'invalid' \| 'keyConflict', message}`. Modelled on `apps/pos/src/cashier/receive/receiveApprovalFlow.ts`. |
| `requisitionKeys.ts` | Key minting, signature reuse, persisted pending create (KV). |
| `requisitionLabels.ts` | Labels and chain. A POS copy of `apps/backoffice/src/screens/requisitions/requisitionStatus.ts`, extended with the transfer steps. Copied rather than moved: that file imports `@mandalika/api` and `packages/types` has no deps (`packages/types/package.json`). The backoffice is not edited. |
| `RequisitionPanel.tsx` | Full-height slide-over like `TransferHistoryPanel`, with an in-screen list / detail / form view swap (no router). |
| `RequisitionList.tsx`, `RequisitionDetail.tsx`, `RequisitionForm.tsx` (+ `VariantPicker`) | Each under ~250 lines. Catalog = the engine snapshot already filtered to active products (`CashierScreen.tsx:235`). Stock hint from `displayProducts` (`:236-239`). No `/products` fetch. |

**Wiring:**
- `MenuDrawer.tsx`: new prop `onRequisitions` and `canRequestStock` (props `:15-36`, items `:121-130`).
- `CashierScreen.tsx`:
  - `showRequisitions` state next to `:191-192`;
  - mount next to `TransferHistoryPanel` (`:1250-1255`);
  - Back handler line (`:944-966`);
  - gate flag (`:276-284`);
  - "Buka Terima Transfer" → `setShowReceive(true)` (`:1205`).
- Net growth of `CashierScreen.tsx` (1321 lines) is about 15 lines.

**Indonesian copy.** Terms match the backoffice: Draf / Diajukan / Disetujui / Ditolak / Transfer Dibuat / Dibatalkan; Ajukan, Ubah, Batalkan (`requisitionStatus.ts:7-14`).

| Key | Text |
|---|---|
| Menu / title | Permintaan Barang |
| Empty list | Belum ada permintaan barang dari outlet ini. |
| Buttons | Buat Permintaan · Simpan Draf · Simpan & Ajukan · Ajukan · Ubah · Batalkan Permintaan · Coba Lagi · Buka Terima Transfer |
| Cancel confirm | Batalkan {nomor}? Permintaan yang dibatalkan tidak bisa dibuka lagi. |
| Transfer steps | Disiapkan gudang (transfer `draft`) · Dikirim (`in_transit`) · Diterima (`completed`) · Transfer dibatalkan, menunggu gudang (`cancelled`) |
| Validation (client) | Tambahkan minimal satu barang. · Qty harus bilangan bulat lebih dari 0. · Barang ini sudah ada di daftar; ubah qty-nya saja. |
| Offline / retry / 403 / stale | as in §3 |

## 5. Release: OTA only, no APK

| Check | Result |
|---|---|
| Native change? | None. Uses `fetch`, `<input type="date">` (WebView native), `crypto.randomUUID` (already used), the existing KV. No new Capacitor plugin and no `capacitor.config` change. If any `package.json` changes, `pnpm-lock.yaml` ships with it. |
| Target APK | versionCode 12 / "2.1" (`apps/pos/android/app/build.gradle:24-25`). The bundle targets exactly that code (min-version guard, `scripts/ota-release.sh:11-12`, `:75-81`). |
| Journal guard | S6 touches none of the guarded files (`scripts/lib/ota-journal-guard.sh:20-27`). Diff since OTA 2.1.5 (4b0f7f7) → `inv-integration` in POS-reaching code: `apps/pos/package.json`, `apps/pos/src/lib/apiClient.errors.test.ts`, `packages/api/src/{client.ts,schema.d.ts}`, `packages/types/src/index.ts`, with no journal file among them. The guard will still ask for `OTA_JOURNAL_CHANGE_ACK=1`, because journal files changed since the APK 2.1 base (`ota-journal-guard.sh:15-16`; release 8, `HANDOFF.md:257`). Acknowledge only after re-running that diff on the release commit. |
| Bundle contents | Also ships the S0 client/schema/types additions made since 2.1.5. They are additive and the POS does not call them. |
| Order | (1) After the **Nov 2 demo**, with owner go-ahead: backend deploy with 0069–0074 (S0–S5). (2) Hosted smoke (§6). (3) Admin grants `request_stock` to the pilot outlet's terminal account. (4) Push, CI green (Actions minutes until about Nov 1, `docs/plans/2026-10-25-inventory-controls-plan.md:478`). (5) `make ota-release VERSION=2.1.6`. (6) Pilot outlet first (`HANDOFF.md:234`). (7) On-device check. Deploy order per `HANDOFF.md:250`. |
| Mixed versions | Old bundle + new server: unaffected (the POS never calls `/requisitions`). New bundle + old server: list 404 → "belum aktif" copy. Step order prevents it. |

## 6. Tests and gates

**Postgres:** no migration and no schema change. One optional backend validation (S6-B, Q3) adds an RQ subtest. Without S6-B there is no PG gate run for S6.

| Layer | Test |
|---|---|
| Unit (vitest, `apps/pos`) | `requisitionFlow.test.ts`: every outcome row of §3; offline makes no call; retry keeps the key; 409-state → stale; 409-key → new key; 403/404/400 mapping. |
| | `requisitionKeys.test.ts`: same signature → same key across a new store on the same KV ("restart"); changed content → new key; cleared on success; scoped by user+outlet. |
| | `requisitionLabels.test.ts`: chain including transfer steps; dead ends. |
| | `canRequestStock` cases (admin, cashier ± perm, null). |
| | `autoPullGate.test.ts`: `showRequisitions` blocks. |
| Wiring guard | `requisitions.wiring.test.ts` (style of `customerPrivacy.wiring.test.ts`): no POS source references `approveRequisition`, `rejectRequisition` or `fulfilRequisition`; the list call always passes `outletId`. |
| Component | Form: duplicate line refused; "Simpan & Ajukan" = create then submit; failed submit leaves a draft with Ajukan. Style of `LocalReceiptsPanel.test.tsx`. |
| Browser (new required ID **POS-REQUISITION**) | New `tests/browser/pos-requisition-scenarios.ts`, a test in `tests/browser/accepted.spec.ts`, an entry in `tests/browser/required-scenarios.json` (32 → 33), and the README count (`tests/browser/README.md:21`). Needs a cashier variant of `setupPos`, which hard-codes an admin (`tests/browser/pos-scenarios.ts:26`). Unhandled paths fall through to `[]` (`:33-51`), so `/requisitions*` must be mocked with in-memory state. Asserts: (a) cashier without `request_stock` → no menu item; (b) with it: create 2 lines + date + note → POST carries `Idempotency-Key` and `outletId`; (c) submit answers synthetic 503, then "Coba Lagi" sends the **same** key; (d) the detail chain shows "Dikirim" and "Buka Terima Transfer" opens the receive panel; (e) cancel a draft; (f) offline → "butuh koneksi" and no write call; (g) **zero** requests to `/approve`, `/reject` or `/fulfil` across the run. |
| Hosted smoke (release step, Neon test DB, per-request owner OK) | Real cashier token with `request_stock`: create/submit 201/200; approve 403; other `X-Outlet-Id` 403; replay with the same key returns the same PB; cleanup = cancel. This pins the real `server.go` groups. |
| Gates | `corepack pnpm quality:ci` (tests, typecheck, builds, gen:check) and `corepack pnpm browser:ci`. With S6-B also the common Go gate and `python scripts/ci/postgres_gate.py --runtime docker --go-runner docker --only RQ,TR,SL`. |

## 7. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | **Nov 2 demo**: anything shipped early disturbs it | Nothing in S6 deploys before the demo. Code merges locally on `inv-integration`; the release follows §5 after the backend deploy, with owner go-ahead. |
| R2 | **Permission leakage**: a cashier reaches approve/fulfil, or an admin/manager on the tablet sees other outlets | Server groups (`server.go:365-379`); the POS never renders or calls the warehouse actions (wiring test + browser assert (g)); list pinned to `outletId`; hosted smoke approve → 403. |
| R3 | **Tablets offline** | Online-only with clear copy. No outbox, so nothing is half-queued. A requisition is never urgent to the second. |
| R4 | **Idempotency key lost on app restart** creates a duplicate draft | Pending create key persisted in KV (§3). Submit/cancel retries resolve to a 409 → refetch. |
| R5 | **Stale catalog**: a size deleted or renamed after the last pull. The server checks only uuid and non-empty size (`requisition.go:99-121`), and there is a product FK but no variant FK (`backend/internal/db/migrations/0074_stock_requisitions.sql:27-29`; `requisition_repo.go:120-131`), so a PB line for a non-existent size is accepted and reaches the transfer draft | Picker uses only active products from the current snapshot; auto-pull keeps it fresh while the panel is closed. **S6-B** adds a server variant-exists check (400) for the backoffice too (Q3). |
| R6 | Hung request (no default deadline) | S6-0 `timeoutMs`; a retry reuses the key. |
| R7 | Shared account hides who asked (audit) | Q2. |
| R8 | Permission change lag of about 15 min | Release note; the server is authoritative. |
| R9 | `CashierScreen.tsx` growth and react-doctor "giant component" | All logic lives in the new folder; about 15 lines of wiring. |
| R10 | "Buang isian" on an unconfirmed create replays the old key, refetches the PB (must still be an unchanged draft), then cancels. In the few milliseconds between that check and the cancel another device could submit the PB, and the server allows cancelling a submitted PB (no compare-and-set on status). | Accepted: the window is tiny and a shared terminal account makes a concurrent actor unlikely; the cancel is visible in the PB history. Documented in `discardPending`. |

## 8. Slices (order: S6-0 → S6-1 → S6-2 → S6-3 → S6-4; S6-B any time before the backend deploy)

| Slice | Size | Files | Change | Verify | Review tier |
|---|---|---|---|---|---|
| S6-0 client deadline (S0b) | S | `packages/api/src/client.ts` (`:408-413`, `:940-950`) | Optional `opts?: RequestOptions` on list/get/create/update/submit/cancel, merged with `idemRequired`. Warehouse methods unchanged. | client unit test (timeout → `ApiError` kind `timeout`, key header kept); `quality:ci` | **Opus** (shared API client contract) |
| S6-B variant check (if Q3 = yes) | S | `backend/internal/write/requisition_repo.go` (create/update), `requisition_integration_test.go` | Every line must match an existing `product_variants (product_id, size)` → 400 `ukuran … tidak ada untuk produk ini` | RQ subtest `unknown-variant-is-400`; common Go gate; PG `--only RQ,TR,SL` | **Opus** (stock document) |
| S6-1 logic | M | `apps/pos/src/cashier/requisitions/{requisitionFlow,requisitionKeys,requisitionLabels}.ts`, `packages/types/src/index.ts` (`canRequestStock`) + tests | §3 outcomes, persisted create key, labels | unit tests; `quality:ci` | **Opus** (idempotency, permission gate) |
| S6-2 screens | M | `RequisitionPanel/List/Detail/Form.tsx` (+ `VariantPicker`) + component tests | §1 / §4 UI and copy over S6-1 | component tests; `quality:ci` | Haiku (layout and copy only; no new logic beyond S6-1 calls) |
| S6-3 wiring | S | `MenuDrawer.tsx`, `CashierScreen.tsx`, `autoPullGate.ts` (+ test), `requisitions.wiring.test.ts` | Menu item, mount, Back, auto-pull flag, "Buka Terima Transfer" | wiring + gate tests; `quality:ci` | **Opus** (auto-pull gate governs SyncEngine pulls; permission surface) |
| S6-4 browser | M | `tests/browser/pos-requisition-scenarios.ts`, `accepted.spec.ts`, `required-scenarios.json`, `tests/browser/README.md` | POS-REQUISITION asserts (a)–(g) | `browser:ci` | **Opus** (asserts the leakage and idempotency guarantees) |
| S6-5 release | — | `HANDOFF.md` board | §5 order + hosted smoke + pilot + on-device | smoke results, `/ota/check` offers 2.1.6 to code 12 | Owner go-ahead; Opus go/no-go |

Implementer: Sonnet for S6-0..S6-4. Announce tier, effort and reason per AGENTS.md.

## 9. Open questions for the owner (each with a recommended default)

1. **How does `request_stock` reach the cashiers?**
   - **Default:** the admin ticks "Ajukan Permintaan Barang" per terminal account in Backoffice → Pengguna, pilot outlet first. No migration, nothing granted automatically.
   - Alternative: a one-off grant to every `cashier` account that has an outlet. That is a data change on Neon and needs your OK and a count first.
2. **Shared terminal account vs auditor traceability.** The PB records the terminal account as requester, not the person.
   - **Default:** accept for v1, and add an optional "Diminta oleh" name field on the tablet form that is saved at the start of the note. No schema change.
   - Alternative: wait for the operator-per-shift decision (`HANDOFF.md:248`).
3. **Server check that the size exists (S6-B).** Without it, a tablet with an old catalog can request a size that no longer exists.
   - **Default:** yes. Add it before the backend deploy; it is small, also protects the backoffice form, and gets an RQ subtest.
4. **Release.**
   - **Default:** ship S6 after the Nov 2 demo as OTA 2.1.6 (no APK), right after the S0–S5 backend deploy, to the pilot outlet's tablets first, then the rest.

### Owner answers (2026-10-26): recommended defaults accepted

1. `request_stock` is granted per terminal account in Backoffice → Pengguna, pilot outlet first. No migration, no bulk grant.
2. Shared terminal accounts are accepted for v1. The tablet form gets an optional "Diminta oleh" name, saved at the start of the note (no schema change).
3. S6-B is in: the server refuses a line whose product+size is not an existing variant (400), on create and update, before the backend deploy.
4. Release after the Nov 2 demo as OTA 2.1.6, right after the S0–S5 backend deploy, pilot outlet first. Nothing ships before the owner's go-ahead.

