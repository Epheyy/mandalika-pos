# Fase D backoffice: implementation plan

Date 2026-11-02 · base `prod-hardening` 0425f838 (live: backend `00149-xiz`, backoffice `1a3ccbf5`, POS OTA 2.5.0, "Bayar terpisah" on) · planner: Opus (plan only, no app code changed).

**Source rows.**
- UX direction `docs/plans/2026-10-27-pos-ux-direction.md` §4 backoffice: 4.1 navigation `:428-432`, 4.2 tables `:434-438`, 4.3 forms `:440-444`, 4.4 auditor inventory screens `:446-458`, terminology `:460`, wireframe `:462`.
- The same document, §5 "Fase D" `:516-522` (D1 shell + kit, D2 lists + forms, D3 inventory auditor, D4 router; about 9 sessions).
- Owner decisions already fixed:
  - D-11: no manual-discount gate.
  - D-12: no dark theme.
  - D-15: router, yes.
  - D-16: five-section sidebar.
  - D-17 + D-29: one token layer, three brand skins, build-time env per brand.
  - D-22: rename the English leftovers.

**Conventions.**
- Every claim about current behaviour cites `path:line` on 0425f838. `BO/` means `apps/backoffice/src/`.
- **Owner decisions continue the register at D-67.** D-30 to D-66 are already used by the C3, C4 and C6 plans. The task brief said "from D-30", which would collide (see section 9).

**Mock for approval (before any D1 code).**
- A new page in the Kertas & Emas Figma file, created by the capture: https://www.figma.com/design/iMyGehblek8VJXbMIRRPrf?node-id=15-2. It shows BO1 to BO4 plus a kit sheet. The page name was set by the capture tool; rename it "Fase D · Backoffice".
- Source HTML (token-accurate, re-capturable): `docs/plans/assets/2026-11-02-fase-d-backoffice-mock.html`.
- Section 10 explains how it was made and what is left in the Figma file.

---

## 0. Read this first

1. **The browser gate is the real constraint on every slice.** `corepack pnpm browser:ci` runs 12 backoffice scenarios.
   - They run on Vite dev servers with `maxFailures: 1`, so the first break hides the rest.
   - Clicks use `getByRole('button', {name, exact: true})` on sidebar items and tab labels (for example `tests/browser/backoffice-scenarios.ts:69,83,94`).
   - Some steps depend on structure, not text:
     - order rows are `div role="button"` that expand in place (`BO/screens/Orders.tsx:206`);
     - promotion row buttons are found by index (`backoffice-scenarios.ts:219`);
     - the Modal is found by the CSS class `.fixed.inset-0.z-50` (`:220,224,232`).
   - The fixture aborts any request outside the two app origins and the mocked API (`tests/browser/fixture.ts:30-66`). **A Google Fonts or CDN request fails every scenario**, so fonts must be self-hosted.
   - Renamed or removed tests must be edited in `tests/browser/required-scenarios.json` in the same commit (50 ids), or the gate fails at discovery.
   - Section 6 lists every scenario each slice touches.
2. **Pengaturan has a data-loss bug as well as the missed-save problem.**
   - Today "Simpan Semua" sends the whole draft (`BO/screens/SettingsScreen.tsx:80-96`). The PUT overwrites every column except `recipesEnabled`, `inventoryApprovalRequired`, `splitTenderEnabled` and `documents` (`backend/internal/write/settings.go`, handler `UpdateAppSettings`, the `UPDATE app_settings SET tax_enabled=…` block).
   - The UI also always sends `recipesEnabled` and `inventoryApprovalRequired`, so those are not protected either.
   - The draft is seeded once and ignores later polls (`SettingsScreen.tsx:71-78`).
   - Result: **a second open tab, or a tab left open for an hour, silently reverts other people's changes** to tax, rounding, payment methods, receipt and stock settings. Only `splitTenderEnabled` is protected (`:86-87`).
   - The save redesign (D-70, slice D1-P) must fix this, not just move the button.
3. **The router is decided up front and its foundation moves into D1** (D-67/D-68).
   - A hand-rolled hash router with filters in the query string. No new dependency.
   - The sidebar is built on it from the first day.
   - D4 shrinks to "finish URL state on the screens D2 and D3 did not touch".
4. **Products already page on the server; Promotions do not.**
   - `GET /products` takes `page`/`limit` (`packages/api/src/client.ts:741`). The backoffice calls it through `loadAllProducts`, which walks every page every 12 s (`BO/screens/products/useProductsData.ts:24`). So D2 needs search and filter parameters, not paging itself.
   - `GET /promotions` and `GET /discount-codes` return the whole list (`client.ts:855,861`).
   - Section 3 has the backend contract.
5. **Overlays must not use `createPortal` unguarded.**
   - Three vitest suites render modals with `renderToStaticMarkup` in node: `products/DeleteConfirmModal.test.tsx`, `products/erpReadOnly.test.tsx`, `promotions/promotionKeyForm.test.ts`.
   - A portal throws there. Kit overlays render in place, or portal only when `document` exists.
6. **Gold text contrast.** White on Mandalika gold `#b07d18` is 3.6:1, below AA for 14 px labels.
   - The POS gets away with it because the Bayar bar label is large text.
   - Backoffice filled controls use a new `--color-brand-strong` (Mandalika = brand-pressed `#8f6412`, 5.3:1). Decision D-73.
7. **Not everything is a table.** Some screens stay inline-expand lists, and the tests depend on that: Orders and the Ekspor tab (`Orders.tsx:206`, `reports/ExportTab.tsx:191`), and Sync review (`syncReview/SyncReview.tsx:81`).
   - They adopt the kit's FilterBar and labels but keep their row semantics.
   - An order-detail SlideOver would block the second-row clicks in BO-SPLIT-ORDER (`backoffice-split-scenarios.ts:108,146`).
8. **Figma Starter cap.**
   - The Figma file's team is on the Starter plan. Figma documents a cap of about 20 MCP read/write tool calls a month for it, so most of this month's allowance was presumably used by earlier sessions.
   - This session's sixth read/write call was refused.
   - The mocks reached Figma through the capture tool, which is exempt from the cap.
   - One failed kit script may have left an empty or half-made variable collection named "Desktop" in the file. Delete it if it is there (section 10).

## 0.1 TL;DR

Eleven slices in four waves. **12-17 sessions** (about 14 is typical), against the 9 in the direction doc. The extra sessions are:
- the Pengaturan fix;
- the router foundation;
- the backend list parameters;
- the optional D5 sweep (2 of the 17).

| Wave | Slices (can run in parallel inside a wave) | Sessions |
|---|---|---|
| 1 | **D1-P** Pengaturan save bar + stale-overwrite fix · **D1a** tokens, kit, label maps (new files only) | 1 + 1-2 |
| 2 | **D1b** shell: grouped sidebar, header scope, hash router foundation, nav guard, test helpers, top-level renames (needs D1a + D1-P) | 2 |
| 3 | **D2-API** backend list params (Products search/filter, Promotions/Codes paging, ERP location names, Barang Masuk list) → then **D2a** Products · **D2b** Promotions · **D3a** Pergerakan + Kartu Stok · **D3b** Transfer, Opname, Penyesuaian, Barang Masuk · **D3c** Persetujuan, ERP, Tinjauan Sinkron, Log Kesalahan | 1 + 1 + 1-2 + 1-2 + 1-2 + 1 |
| 4 | **D4** URL-state completion (screens not touched in wave 3) · **D5** remaining tables sweep (optional, D-74) | 1 + 1-2 |

- **First card: D1-P** (Sonnet 5.5 medium, Opus 5.5 high review because it touches the payment settings PUT). Run D1a beside it.
- Both wait only on the owner approving the mock (BO1-BO4) and D-67 to D-82.

---

## 1. Current state (what the plan changes)

### 1.1 Shell and navigation

- **Navigation is plain state, nothing is in the URL.**
  - Navigation is `useState` (`BO/App.tsx:135`). Only the active screen is mounted (`:155-156, 270-272`), so every tab, filter and page resets on each switch.
  - Nothing is in the URL. No screen persists anything; the only localStorage keys are the two auth keys (`BO/auth.tsx:12-14`).
  - The outlet scope is React state (`BO/outlet.tsx:29`), mirrored to `authStore.outletId`, and resets on reload.
- **Sidebar and header.**
  - The sidebar is 13 flat items (`App.tsx:45-62`). It has three red count badges with different meanings and no legend (`:215-226`), and the user plus "Keluar" in the footer (`:231-255`).
  - The header holds only the hamburger and the native `<select>` OutletSwitcher (`:259-268`, `outlet.tsx:81`).
- **Cross-screen jumps** use a window event. There is one dispatcher, `requisitions/RequisitionDetail.tsx:28` (target `warehouses`), and it lands on the Stok tab instead of the transfer, so the jump loses its target.
- **Access**: `lib/navAccess.ts` `canSeeNav`. Admin sees everything; `errors` and `erpOutbox` are admin-only. Inner tabs repeat the permission checks inside the screens.
- **Brand and theme.**
  - `BO/lib/brand.ts` is a single hard-coded brand; there is no `VITE_BRAND` (the POS has the full system, D-29).
  - `apps/backoffice/index.html` has `lang="en"`.
  - `BO/index.css` has only a warm `gray-*` remap, a `gold-*` ramp and a dead `indigo-*` ramp. It has no semantic, radius or font tokens; status colours are raw Tailwind (red 193 uses, amber 111, green 43).
  - The POS has the semantic layer: `apps/pos/src/index.css:17-50` (paper/ink/brand, ok/warn/danger/info/promo/reward, radii, Roboto). Its hex values match the backoffice gray/gold almost exactly, but nothing is shared.

### 1.2 Kit (`BO/ui/`)

| Component | State today |
|---|---|
| Button | primary, secondary, ghost, danger; sizes sm, md; `loading`, `icon`. |
| Badge | Tones are not exported. |
| Card, EmptyState | EmptyState has no CTA slot. |
| PageHeader | `title`, `subtitle`, `actions`; the title is an `<h2>` (`ui/PageHeader.tsx`). |
| Field / Input / Select | Take an `error` prop, but the `<label>` has no `htmlFor` and there is no `aria-invalid`. About five call sites pass `error`. |
| Modal | Dirty guard through `onChangeCapture`; Escape, the backdrop and × ask "Buang perubahan?" (`ui/Modal.tsx:47-57`). No portal, no `role="dialog"`, no focus trap or scroll lock. |
| Tabs | A segmented control of buttons with no ARIA; counts are baked into the label (`ui/Tabs.tsx`). |
| Pagination | Presentational, page size 25/50/100. |
| Toggle | Lives only in `screens/settings/Toggle.tsx` (`role="switch"`). Three raw icon toggles bypass it: `Customers.tsx:346`, `LocationsSection.tsx:149`, `SettingsScreen.tsx:194`. |
| Slide-over | Only `screens/recipes/RecipeSlideOver.tsx:44-177`: `fixed inset-0 z-[60]`, `max-w-md`. No Escape, dirty guard, focus handling or portal. Save is fire-and-forget. |

Other gaps:
- There are no Table, FilterBar, DateRange, ConfirmDialog or toast components.
- 35 `<table>` elements across 31 files.
- Seven or more copy-pasted "Konfirmasi Hapus" modals. The only shared confirm is `products/DeleteConfirmModal.tsx`.

### 1.3 Lists, filters, exports

| Screen | Paging today | Filters | Export label | Edit surface | Gaps |
|---|---|---|---|---|---|
| Produk (`Products.tsx`, `products/*`) | loads all (walks `GET /products` 200 per page, every 12 s) | client search + category | "Export" dropdown + Template + Import | Modal xl + RecipeSlideOver | subtitle count is `products.length`; raw `Satuan` sentinel shown |
| Promosi (`Promotions.tsx`, `promotions/*`) | none (whole list) | none | "Export" dropdown | Modal 2xl, 3-step wizard (`PromoFormModal.tsx:~277-305`) | status chip mutates on click (`:181,246`); save/dup/delete have no `catch`; `alert()` at `:155` |
| Pelanggan | **server OFFSET** (`read/customers.go:66-77`, `count(*) OVER()`, `meta.total`) | debounced search, sort, tag, segment | "Export" (ignores filters, `Customers.tsx:70-84`) | Modal + full-page detail | the reference pattern for D2 |
| Laporan › Transaksi (`Orders.tsx`) | server (50) | search, dates, status, payment | "Export" = **XLSX** (`:190`) | inline expand + refund form | keep inline expand (0.7) |
| Laporan › other tabs | mixed (server / hand-rolled pager / all) | shared Dari/Sampai | "Export CSV", "Export Refund CSV", "Ekspor CSV" | none | |
| Pengguna (`Users.tsx`) | loads all | none | "Export" (raw role, `:204`) | Modals | saves have no `catch` |
| Stok Produk › Overview | client paging over the whole matrix | location kind, search | none | drill-in to LocationStockView | PAR saves on every blur |
| Pergerakan (`inventory/MovementSummary.tsx`) | server (25) | Lokasi, Tanggal tercatat, search (not debounced, `:150-157`) | "Unduh CSV" | none | bucket definitions only in tooltips |
| Kartu Stok (`inventory/StockCard.tsx`) | cursor ("Muat lebih banyak") | Lokasi, SKU, dates, 10 kind chips + Hadiah/Minus | "Unduh CSV" | Modals | 13 columns, raw `erpStatus`/`refType` (`:342,378`) |
| Transfer (`transfers/Transfers.tsx`) | server (25) | status, lokasi, dates | "Export" dropdown | in-place views | Kirim/Batalkan fire with no confirm (`:321,331`); filter vs badge labels differ (`:36-41` vs `:170-174`) |
| Opname (`StockCount.tsx`) | server (25) | none | "Export" | inline autosave + Modal | `window.confirm` (`:219`); Mulai/cancel no confirm (`:346,368`) |
| Persetujuan Stok (`approvals/*`) | server (25) | none | none | Modal + PIN | no filters (4.4) |
| Permintaan Barang | server (25) | status | none | full-panel views | Ajukan/Batalkan/Buat Transfer/Setujui no confirm (`RequisitionDetail.tsx:131,135,138,226`) |
| Integrasi ERP (`integration/*`) | server (50) | status tabs, kind | none | Modal 2xl | `outlet 3f2a9c1d` (`erpOutboxFormat.ts:58`); relay/retry no confirm (`ErpOutboxScreen.tsx:79`, `ErpOutboxDetail.tsx:89`) |
| Tinjauan Sinkron | server (25) | status, outlet, reason | none | Modal lg | list rows are buttons (keep) |
| Log Error (`ErrorLogs.tsx`) | server (50) | source tabs | "Export" | none | raw `source · kind` (`:123`) |
| Bahan (`ingredients/*`) | server / mixed | search, category (client filter on a server page, `DaftarTab.tsx:76-79`) | "Export" | Modals | `window.prompt` (`TransferTab.tsx:352`), `window.confirm` (`OpnameTab.tsx:249`) |

- **Label maps already exist but are duplicated.**
  - Existing maps: `erpOutboxFormat.ts` (the model), `reviewLabels.ts`, `requisitionStatus.ts`, `stockCardFormat.ts`, `lib/orderStatus.ts`, `lib/inventoryApproval.ts`, `oversellLabels`, `refundReport`, `splitPayment`.
  - Duplicates: transfer STATUS ×3, ROLE_LABEL ×2, orderStatusLabel ×2 (these two already diverge: "Refund" vs "Direfund").
  - The `refund` kind is "Refund" in one map and "Retur" in another.
- **Raw enums still on screen**: `inventory/DocumentModal.tsx:70,74,86,103,158`, `App.tsx:246` (`user.role`), `ErrorLogs.tsx:123`, ERP `locationText`.

### 1.4 Pengaturan (owner pain point, 2026-11-02)

- **State and save.**
  - One draft object `s` plus a separate `approverRoles` array (`SettingsScreen.tsx:59,65`), seeded once (`:71-78`). There is no dirty flag.
  - "Simpan Semua" is in the PageHeader at the top (`:119-127`) and scrolls away; `main` scrolls (`App.tsx:269`).
  - Feedback is an inline `<p>` that never clears (`:128-130`). Its colour comes from `msg.includes('disimpan')`.
- **Tabs and layout.**
  - Four tabs (`:50-55`). Edits survive a tab switch. **Leaving through the sidebar unmounts the screen and silently drops the edits.** There is no `beforeunload` anywhere.
  - Transaksi tab order: Pajak & Pembulatan, Metode Pembayaran, **Bayar terpisah** (3rd, `settings/TransaksiSection.tsx:147`), Pengaturan Struk. That puts the switch roughly 800-900 px below the save button.
- **Outlet & Gudang tab: two save models on one tab.**
  - These save immediately: outlet active toggle with no confirm (`settings/LocationsSection.tsx:79-88`), outlet and warehouse modals, and the giveaway "Simpan Hadiah" inside the outlet modal.
  - Only "Izinkan Stok Minus" needs "Simpan Semua".
- **Data loss**: see section 0, item 2.

---

## 2. Design decisions made up front

### 2.1 One token layer, three skins, contrast (D-17, D-29, D-73, D-76)

- **Shared tokens file.**
  - New `packages/ui-tokens/tokens.css`, a plain directory with no `package.json`, so the lockfile does not change. It holds the `@theme` block now in `apps/pos/src/index.css:17-50`: paper/ink/brand, the semantic pairs, radii and the font stack.
  - It also adds `--color-brand-strong` and `--color-brand-strong-hover`, and the `*-strong` text tones where a pair fails AA.
  - The backoffice `index.css` imports it with `@import '../../../packages/ui-tokens/tokens.css';`. Tailwind v4 resolves the relative import at build; Vite dev serves files inside the workspace root.
- **POS migration later.** The POS moves to the shared file in its own small chore slice ("POS imports ui-tokens"), not in Fase D. That way no Fase D slice touches the POS web layer or forces an OTA. Acceptance for the chore: computed styles identical, shipped with the next POS OTA (D-76).
- **Brand skins for the backoffice.**
  - `BO/lib/brand.ts` becomes a registry keyed by `import.meta.env.VITE_BRAND` (mandalika | flamboyan | performance; default mandalika), mirroring `apps/pos/src/brand`.
  - **The Mandalika logo URL literal stays in `lib/brand.ts`**: `tests/browser/serve-app.mjs:21-27` rewrites that exact string.
  - The D-27/D-28 overrides apply: Flamboyan `promo` becomes blue and `info` slate; Performance solid danger becomes `ink-900`.
- **Contrast pairs** (computed; WCAG 2.x):

  | Pair | Ratio | Rule |
  |---|---|---|
  | white on `brand` `#b07d18` | 3.6:1 | only for text ≥ 18.66 px bold; filled controls use `brand-strong` `#8f6412` (5.3:1). Flamboyan `#9b59b6` is 4.7:1 and Performance `#a93226` is 6.6:1, so their `brand-strong` = `brand`. |
  | `warn` `#b45309` on `warn-bg` `#fdf0df` | 4.45:1 | badge text uses `warn-strong` `#a14a06` (5.3:1). The POS `warn` token stays unchanged. |
  | `ink-500` on `paper-1` | 4.25:1 | `ink-500` is allowed only on `paper-0`/white (4.65:1 / 4.9:1); on `paper-1` use `ink-700`. |
  | table header `ink-700` on `paper-1` | about 8:1 | replaces today's `text-gray-400` headers (about 2.6:1, `products/ProductsTable.tsx:49`). |

- **Font (D-75).** Self-hosted Roboto Variable: one latin-subset `woff2`, weights 400-700.
  - **Vendored** under `apps/backoffice/public/fonts/` with its `OFL.txt` (the same idea as `vendor/sheetjs`), declared by an `@font-face` in `tokens.css`.
  - **No npm dependency and no lockfile change**, consistent with the no-dependency router choice. That also avoids the Cloudflare frozen-lockfile failure mode.
  - It matches the POS and the Figma file.
  - It must be local: the browser gate aborts external font requests.
- Also: `index.html` gets `lang="id"`. There is no dark theme (D-12): no `dark:` variants, no `prefers-color-scheme` block.

### 2.2 Router (the D4 decision, made now) — D-67, D-68, D-69

- **Choice: a hand-rolled hash router** in `BO/lib/router/`, about 250 lines plus tests, no dependency.
- **Why not react-router v7?** `createHashRouter` + `useBlocker` + `useSearchParams` would also work, and it was considered. It loses on four counts:
  1. The app needs a flat route table, query-string state and one leave guard, a small fraction of the library.
  2. A new dependency means lockfile and dependency-security churn. The repo has been bitten by the Cloudflare frozen-lockfile build (memory gotcha).
  3. The browser gate depends on exact element roles and names, and owning the `<Link>`/tab markup keeps that under control.
  4. Pure `parseHash`/`buildHash` functions are unit-testable in the existing node vitest setup (there is no jsdom).
- **Why hash, not history mode?**
  - History mode would work: `apps/backoffice/public/_redirects` is `/* /index.html 200`, and the Vite dev fallback serves `index.html`.
  - Hash was chosen because:
    - The direction doc says hash (§4.1, §5 D4).
    - It needs no server rule on any host.
    - It keeps `/tests/polling-harness.html` and every root `page.goto(BO)` unchanged.
- **Module surface:**

```ts
// BO/lib/router/routes.ts — the single route table (also feeds the sidebar)
export interface RouteDef {
  id: NavId                 // existing nav ids stay ('dashboard', 'warehouses', …); navAccess.test.ts keys on them
  path: string              // Indonesian slug, e.g. 'inventori'
  label: string             // sidebar label (D-22 names)
  section: 'penjualan' | 'pelanggan' | 'produk-stok' | 'operasional' | 'sistem'
  icon: LucideIcon
  perm: string              // existing canSeeNav input
  load: () => Promise<{ default: ComponentType }>   // React.lazy per screen (recharts/jspdf leave the first bundle)
  tabs?: readonly { key: string; slug: string; label: string; perm?: string }[]
}
// BO/lib/router/hash.ts — pure, unit-tested
export function parseHash(hash: string): Location        // { path: string[]; query: Record<string,string> }
export function buildHash(path: string[], query?: Record<string, string | undefined>): string
// BO/lib/router/useRoute.ts — useSyncExternalStore on 'hashchange'
export function useRoute(): Location
export function navigate(to: string, opts?: { replace?: boolean }): Promise<boolean>   // false when the guard refused
export function Link(props: { to: string; navId?: string; className?: string; children: ReactNode }): JSX.Element
// BO/lib/router/useQueryState.ts — the list-state hook every FilterBar screen uses
export function useListState<S extends Record<string, string | number | boolean>>(
  schema: ListSchema<S>,    // keys, defaults, parse/serialise; defaults are omitted from the URL
): [S, (patch: Partial<S>, opts?: { replace?: boolean }) => void]
// BO/lib/navGuard.ts — created in D1-P, reused by the router
export function setLeaveGuard(g: LeaveGuard | null): void   // LeaveGuard = () => Promise<'save' | 'discard' | 'stay'>
export function confirmLeave(): Promise<boolean>
```

- **URL scheme (D-69).** Paths are Indonesian slugs that match the sidebar; query keys are short Indonesian words; values are the API codes (labels come from the label maps).

| Screen | Route | Notes |
|---|---|---|
| Ringkasan | `#/ringkasan?periode=7h` | was Dashboard |
| Laporan | `#/laporan/{transaksi\|ekspor\|shift\|hadiah-promo\|kode-diskon\|refund\|stok-minus}?dari=&sampai=&status=&bayar=&hal=` | a bare `#/laporan` = first permitted tab (keeps "sidebar Laporan lands on Transaksi", BO-PAGES-XLSX `:167-168`) |
| Pelanggan | `#/pelanggan`, `/pengingat`, `/duplikat[/:id]`, `/loyalitas[/kondisi]`, detail `#/pelanggan/:id` | |
| Promosi | `#/promosi`, `#/promosi/kode`; overlays `?ubah=<id>` / `?baru=1` | |
| Produk | `#/produk`, `/kategori`, `/bundle`; overlays `?ubah=<id>` / `?baru=1` | `?q=&status=&kategori=&hal=&per=` |
| Inventori | `#/inventori/stok[/{outlet\|gudang}/:id]`, `/pergerakan`, `/kartu-stok?sku=&lokasi=&dari=&sampai=&jenis=`, `/transfer[/baru\|/:id]`, `/barang-masuk`, `/bahan/{…}`, `/opname[/bahan]` | Kartu Stok becomes bookmarkable (4.4) |
| Persetujuan Stok | `#/persetujuan-stok?id=` | |
| Permintaan Barang | `#/permintaan-barang[/baru\|/:id\|/:id/ubah]` | the edit view refetches by id (today it holds the object, `RequisitionList.tsx:21-28`) |
| Pengguna | `#/pengguna`, `#/pengguna/role` | |
| Tinjauan Sinkron | `#/tinjauan-sinkron?status=terbuka&outlet=&alasan=&id=` | |
| Pengaturan | `#/pengaturan/{outlet-gudang\|transaksi\|operasional\|resep-bahan}` | |
| Integrasi ERP | `#/integrasi-erp?status=gagal&jenis=&id=` | |
| Log Kesalahan | `#/log-kesalahan?sumber=` | |

- **Mapping rules for today's in-screen swaps.**
  - Full-page views become path segments: the transfer detail, the customer detail, the requisition views and LocationStockView.
  - Overlays become query parameters, so the list stays mounted and Back closes the overlay: SlideOver edit (`?ubah=`), Modal detail (`?id=`).
  - Sub-tabs become path segments.
  - List filters and paging become query keys through `useListState`.
  - Async-gated tabs fall back to the first permitted tab and re-resolve when the flag arrives. Example: Bahan waits for `recipesEnabled` (`Warehouses.tsx:17-26,42-47`).
  - An unknown route becomes the first visible nav item with `replace`.
  - A route the user cannot see renders today's "Akses tidak diizinkan" view.
- **Kept out of the URL:**
  - **The outlet scope** stays global and moves to localStorage (`mandalika.backoffice.outletId`, a per-viewer convenience). Kartu Stok carries its own `lokasi=` filter, which is enough for a bookmark.
  - Transient UI state: expanded rows, selections, wizard step.
- **The window nav event.** D1b turns `RequisitionDetail.tsx:28` into `navigate('#/inventori/transfer/<id>')`, which fixes the lossy jump. The listener stays as a shim until D4 removes it.
- **Leave guard.**
  - `navigate()` and `<Link>` call `confirmLeave()` first.
  - **Browser Back/Forward while a guard is active** (an open check for D1b):
    - The `hashchange` has already happened, so the router has to undo it before asking.
    - Preferred: `history.go(+1)` / `history.go(-1)` back to the previous entry, with an "ignore the next hashchange" flag. This keeps the Forward history intact.
    - Alternative: `history.pushState(null, '', previousHash)`. It fires no `hashchange`, but it truncates Forward history and leaves a duplicate entry.
    - Then the dialog opens. "Buang perubahan" re-issues the original move.
    - BO-ROUTE-GUARD covers Back **and** Forward.
  - `beforeunload` is registered only while a guard is active.
- **Building the sidebar so D4 needs no rework.**
  - The sidebar renders from `routes.ts`, so sections, order, labels, icons and permissions come from one table.
  - Each item is a `<Link>` carrying `data-nav-id={id}` and the count badge.
  - The items are links, not buttons. The tests move to a `navTo(page, id)` helper keyed on `data-nav-id` in the same slice (6.2), so label renames never touch the tests again.
  - Section headers are `<h2>` elements, never `<p>`: a dashboard locator uses `p` with the exact text "Penjualan" (`backoffice-scenarios.ts:87`). They are never buttons and never collapsible: the review test needs the item visible (`backoffice-review-scenarios.ts:47`).
- **D4 moves earlier (D-68).**
  - The foundation (`routes.ts`, `hash.ts`, `useRoute`, `navigate`, `Link`, `useListState`, guard wiring, top-level and tab routes for every screen) lands in **D1b**.
  - D2 and D3 use `useListState` from their first commit, so their filters are URL state with no rework.
  - **D4** finishes the screens nobody touched: Customers sub-views, Users, ingredients, Laporan tab filters, Ringkasan period. It also handles deep-link and Back/Forward browser scenarios, scroll restore per route, and removing the event shim.

### 2.3 Shared kit APIs (D1a; D2/D3/D4 build on these without changing them)

General rules:
- New files go in `BO/ui/`. Props are named interfaces.
- No `createPortal` while `typeof document === 'undefined'`.
- One shared overlay z-stack: Modal 50, SlideOver 55, ConfirmDialog 60, toast 70. This fixes the Escape bug where a stacked RecipeSlideOver (z-60) over ProductFormModal (z-50) also closes the modal: only the top layer handles Escape.
- Exactly one `<main>` in the app (tests read `locator('main').innerText()`).
- Filters stay **native `<select>`** and the OutletSwitcher stays a native select (BO-RACE, BO-REFUND-LIST, BO-PAGES-CSV select by `option[value]`).

```ts
// ui/DataTable.tsx — real <table>/<thead>/<th scope="col">/<tr>/<td>; tests use role row/cell/columnheader
export interface Column<Row> {
  id: string                        // stable; also the column-chooser key
  header: string                    // exact accessible name (no sort text inside the <th> name: BO-STOCK-CARD :102)
  cell: (row: Row) => ReactNode
  align?: 'left' | 'right'          // money/qty right + tabular-nums
  width?: number | string
  sticky?: boolean                  // leading columns only (Kartu Stok: Waktu Kejadian, Jenis)
  group?: string                    // two-row header groups (Kartu Stok: Waktu · Gerakan · Siapa · Catatan)
  hideable?: boolean                // default true unless sticky
  defaultHidden?: boolean
  sortKey?: string                  // server sort field; undefined = not sortable
}
export interface DataTableProps<Row> {
  caption: string                   // visually hidden <caption>
  columns: Column<Row>[]
  rows: readonly Row[]
  rowKey: (row: Row) => string
  loading?: boolean                 // skeleton rows, keeps header
  error?: string | null; onRetry?: () => void       // role="alert" once, inside the table card
  empty?: ReactNode                 // EmptyState (gains an optional action slot)
  onRowClick?: (row: Row) => void   // <tr> keeps onClick; the first cell gets a real <button> for keyboard users
  selectedKey?: string | null       // row tint + 3 px brand marker (the open SlideOver's row)
  sort?: { key: string; dir: 'asc' | 'desc' }; onSortChange?: (s: { key: string; dir: 'asc' | 'desc' }) => void
  columnPrefsKey?: string           // localStorage, hidden columns only (per viewer)
  stickyHeader?: boolean            // default true (sticky inside the card's own scroll box)
  footer?: ReactNode                // <Pagination/> or "Muat lebih banyak"
}
// ui/FilterBar.tsx — a layout shell with parts; values come from useListState
export function FilterBar(props: { children: ReactNode; actions?: ReactNode; onReset?: () => void; activeCount?: number }): JSX.Element
FilterBar.Scope      // "Cakupan: {outlet} · mengikuti pilihan di header" from useOutlet(); optional `extra` ("semua gudang")
FilterBar.Search     // { value, onChange, label, placeholder, debounceMs = 300 } — label is the aria-label; never just "Cari" (BO-STOCK-CARD getByLabel('Cari') is a substring match)
FilterBar.DateRange  // { from, to, onChange, presets?: ('hari-ini'|'7-hari'|'30-hari'|'bulan-ini')[] } — "Dari" / "Sampai", local day bounds
FilterBar.Chips      // { items: {id,label,count?}[], value: string | string[], onChange, multiple? }
FilterBar.Select     // native <select> with a visible label and aria-label
// ui/ExportButton.tsx
export interface ExportButtonProps {
  format?: 'csv' | 'xlsx'           // label "Unduh CSV" | "Unduh Excel" (D-78); never "Export"/"Ekspor"
  qualifier?: string                // when two exports share a screen: "Unduh CSV refund"
  rowCount: number | null           // shown "· 312"; null = unknown
  filterSummary: readonly string[]  // tooltip: "Unduh CSV · 312 baris · Filter: …"
  onExport: () => Promise<void> | void   // existing csvUtils builders (Blob + createObjectURL + anchor.click — the CSV tests stub exactly this)
  disabled?: boolean                // disabled at rowCount 0 (BO-PAGES-XLSX :196, BO-RACE :291)
}
// ui/ConfirmDialog.tsx — role="alertdialog", focus Batal on danger, Escape/backdrop = cancel (not while busy)
export interface ConfirmDialogProps {
  open: boolean
  title: string                     // a question: "Kirim transfer TR-0142?"
  consequence: ReactNode            // one sentence: "Stok 12 unit akan keluar dari Gudang Pusat sekarang."
  confirmLabel: string              // a verb phrase: "Kirim transfer"
  cancelLabel?: string              // "Batal"
  tone?: 'default' | 'danger'
  busy?: boolean
  error?: string | null             // server refusal shown inside (role="alert"), dialog stays open
  extra?: { label: string; tone: 'danger' | 'ghost'; onClick: () => void }   // the leave guard's "Buang perubahan"
  onConfirm: () => void | Promise<void>
  onCancel: () => void
}
export function useConfirm(): (opts: Omit<ConfirmDialogProps, 'open' | 'onConfirm' | 'onCancel'>) => Promise<boolean>
// ui/SlideOver.tsx — generalises RecipeSlideOver; right side, full height, aria-modal dialog, focus trap, returns focus to the opener
export interface SlideOverProps {
  open: boolean
  onClose: () => void               // routed through the dirty guard
  title: string                     // h2, exact (BO-STOCK-CARD needs heading 'Barang Masuk' exactly)
  subtitle?: ReactNode              // outside the h2
  width?: 'md' | 'lg'               // 560 | 720
  dirty?: boolean                   // explicit; falls back to the Modal onChangeCapture heuristic when omitted
  errorSummary?: readonly { fieldId: string; label: string }[]   // top alert, each item focuses its field
  footer?: ReactNode                // sticky; <SlideOver.Footer dirty> shows "Perubahan belum disimpan"
  children: ReactNode
}
// ui/PageHeader.tsx — backward compatible; gains `count?: ReactNode` next to the title. The title stays <h2>.
// ui/StatusBadge.tsx + lib/labels/*
export type Tone = 'ok' | 'warn' | 'danger' | 'info' | 'neutral' | 'promo' | 'reward'
export interface EnumLabel { label: string; tone: Tone; hint?: string }
export type LabelMap<K extends string> = Readonly<Record<K, EnumLabel>>
export function labelOf<K extends string>(map: LabelMap<K>, code: string | null | undefined): EnumLabel   // unknown → { label: 'Lainnya', tone: 'neutral', hint: code }
export function StatusBadge<K extends string>(p: { map: LabelMap<K>; value: string | null | undefined } | { tone: Tone; label: string }): JSX.Element
// lib/labels: TRANSFER_STATUS, REQUISITION_STATUS, OPNAME_STATUS, APPROVAL_STATUS, ORDER_STATUS, REFUND_STATE,
// ERP_STATUS, ERP_KIND, LEDGER_KIND (+ bucket), REASON_CODE, SYNC_REVIEW_REASON, ROLE, ERROR_SOURCE, PAYMENT_METHOD.
// Existing maps move here and the old modules re-export, so imports do not break mid-migration.
// ui/Switch.tsx — replaces settings/Toggle (role="switch", aria-label kept identical: BO-SPLIT-TOGGLE uses
//   getByRole('switch', { name: 'Bayar terpisah' })), the raw icon toggles and click-to-mutate status pills.
// ui/SaveBar.tsx + lib/useUnsavedChanges.ts (built in D1-P, section 2.4)
// ui/Tabs.tsx — keeps <button> semantics (BO-* click tabs as buttons; role="tab" would break 6 scenarios),
//   gains `dirty?: boolean` per tab (a dot with aria-label "ada perubahan") and an optional `href` for routed tabs.
```

**Testing the kit.**
- Pure logic gets vitest in node: `labelOf`, `parseHash`/`buildHash`, `ListSchema` parse/serialise, the settings diff, and the contrast table (a unit test computing the token pairs).
- Markup gets `renderToStaticMarkup`, the repo's existing pattern (`products/DeleteConfirmModal.test.tsx`).
- Behaviour (focus, Escape, guard) gets browser scenarios in the slice that first uses it.
- No jsdom or Testing Library is added.

### 2.4 Pengaturan save pattern (D-70; slice D1-P)

**Recommendation:** one draft, one save path, made impossible to miss.

1. **Remove "Simpan Semua" from the PageHeader.**
2. **A sticky SaveBar at the bottom of `main`.** It appears only while there are changes, while saving, or after an error.
   - It reads "{n} perubahan belum disimpan", with the list of changed settings in plain words ("Metode pembayaran: Transfer aktif · Bayar terpisah: aktif").
   - Buttons: "Batalkan perubahan" (ghost) and "Simpan perubahan" (primary, `brand-strong`). Mock BO3.
3. **Dirty cues.**
   - An amber dot on each tab that holds changes.
   - An amber left bar and a "Belum disimpan" badge on each changed card.
   - An amber tint plus "· sebelumnya {old}" on each changed row.
   - Switching tabs keeps the draft (as today).
4. **Leave guard.** The sidebar, the hash router, browser Back and `beforeunload` ask "Simpan perubahan Pengaturan?" with three buttons: "Simpan & lanjut", "Tetap di sini" and "Buang perubahan". Mock BO4.
5. **Stale-overwrite fix, client side, no backend change.**
   - `diffSettings(baseline, draft)` is a pure, unit-tested function. It produces the change list for the bar and the keys to save.
   - Saving follows the server's two key classes (`write/settings.go:50-156`):
     - **Present-only keys:** `documents`, `recipesEnabled`, `inventoryApprovalRequired`, `splitTenderEnabled`. The server applies these only when they are present.
       - They go out **only when the user changed them**. Absent means unchanged.
       - `inventoryApprovalRequired` runs `setApprovalSwitch`, which writes an audit doc-event on a real change (`write/inventory_approval.go:559-575`).
     - **Always-overwritten keys:** `taxEnabled`, `taxRate`, the rounding fields (including `roundingType`/`roundingApplyToTax`, which have no UI), `autoOpenShift`, `allowNegativeStock`, `paymentMethods`, `receipt`, `receiveApproverRoles`. The server zeroes these when they are omitted.
       - The body takes each one from a **fresh `GET /settings/app`** made at save time, with the user's changed keys applied on top.
     - After the PUT (which answers `{ok: true}`), the client GETs again and re-baselines.
   - **What this fixes:** untouched keys can no longer revert someone else's edit.
   - **Still last-writer-wins:**
     - two people changing the **same** key;
     - edits inside `paymentMethods` and `receipt`, which are replaced as whole JSON blobs (two admins editing different payment methods: the later save wins for the whole list).
     - A true conflict check needs a server version column: a follow-up, not in Fase D.
   - **The D1-P tests must assert all three:** the present-only keys are absent when unchanged; the always-overwritten keys come from the fresh GET; there is a re-GET after save.
6. **Outlet & Gudang tab.**
   - Its immediate actions get a visible "Disimpan langsung" note per card, so the two models are not confused.
   - The outlet active toggle gets a ConfirmDialog: "Nonaktifkan outlet {name}?" plus a one-sentence consequence. The implementer confirms the consequence wording against `write/outlets*.go` before writing it.
   - The "Izinkan stok minus" card joins the draft model.
7. **Feedback.** On success, the bar shows "Pengaturan disimpan · tablet mengambilnya saat sinkron berikutnya" for 4 s, then hides. On error, it stays with the server message.
8. **The "Bayar terpisah" confirm stays.** Heading "Aktifkan Bayar terpisah?", buttons "Batal" / "Ya, aktifkan", as the test expects. Its body adds "Berlaku setelah Anda menekan Simpan perubahan."

**Alternatives rejected.**
- Auto-save per field: there is no batch, and it is dangerous for kill-switch settings ("Bayar terpisah", "Izinkan stok minus"), where a mis-click becomes live at once.
- Per-card Save buttons: more buttons, still missable, and three save models on one screen.
- Keeping the top button and making the header sticky: it still sits far from a switch at the bottom of a long tab.

### 2.5 Terminology applied in Fase D (D-22 plus the 4.4 table)

| Today | Fase D | Exceptions and notes |
|---|---|---|
| Dashboard | **Ringkasan** | sidebar + route; tests move to `navTo` (BO-PAGES-CSV `:83,127,167`) |
| Log Error | **Log Kesalahan** | no test depends on it |
| Overview (Stok Produk sub-tab) | **Ikhtisar** | not "Ringkasan": that would collide with the sidebar item in exact-name queries |
| Template (import) | **Templat** | |
| Export / Ekspor / Export CSV / Ekspor CSV / Export Refund CSV | **Unduh CSV** (+ qualifier when two share a screen: "Unduh CSV refund") | XLSX-only exports read **"Unduh Excel"** (Orders `:190`, D-78); the ImportExportBar dropdown reads **"Unduh"** (CSV · Excel). The Laporan tab "Ekspor" becomes **"Unduh data"** |
| Penerimaan / Stok Masuk / Catat barang masuk | **Barang Masuk**; action **"Tambah barang masuk"** | ledger kind label `stockCardFormat.ts:15`; BO-STOCK-CARD strings change in D3a |
| Koreksi / Koreksi Stok / Buat penyesuaian | **Penyesuaian Stok**; action **"Tambah penyesuaian"** | AdjustModal shows "Stok sekarang 9 → baru 7 (−2)" |
| Stock Count / Buat Stock Count | **Opname**; **"Tambah opname"**; columns **Stok sistem / Stok dihitung** | |
| Draft / Dalam pengiriman | **Draf / Dikirim / Diterima / Dibatalkan** | one map, filter = badge |
| Buat / Baru / Catat {x} | **Tambah {x}** | the refund stepper aria-labels `Tambah ${line}` stay (they are per line) |
| Retur (ERP kind) | **Refund** | matches the POS (D-8) |
| user role raw / `capitalize` | ROLE map: Admin, Manajer, Kasir | |

---

## 3. Backend needs (and OpenAPI/codegen impact)

### 3.1 What pages today

| Kind | Endpoints |
|---|---|
| OFFSET + `meta.total` + filters (the reference is Customers: `handlers/handlers.go:269`, `read/customers.go:53-77`) | customers (`q` with a trigram index from migration 0026, `sort`, `tagId`, `segmentId`), orders, transfers, ingredient transfers, requisitions, sync review, error logs, ERP outbox (+ counts), refund report, ingredients (`q`), Pergerakan (`q`) |
| OFFSET + `meta.total`, **no filters** | **products** (`read/catalog.go:95-110`: `ORDER BY p.created_at DESC, p.id DESC LIMIT/OFFSET`, no `q`/category/active), users, stock counts (rows embed every item), ingredient stock counts, approvals |
| Cursor, no total | Kartu Stok (base64 seq cursor, limit 1-200, location required) |
| **Unpaged, no params, no meta** | **promotions** (`read/promotions.go:9`, ignores outlet), **discount codes** (`:38`) |
| **No list at all** | **goods receipts** (only `GET /inventory/goods-receipts/{id}`, `server/server.go:309`); ingredient receipts have no list or detail |

Quirks D2/D3 must respect:
- `pageLimit` turns `limit > 200` into **50**, not 200 (`handlers/handlers.go:91-100`).
- `listJSON` returns total 0 for a page past the end. Only ERP outbox, refund report and approvals handle that; the kit's Pagination steps back one page on an empty past-the-end page.
- Several list queries have no `id` tie-break in `ORDER BY`, so rows can repeat or vanish across pages: customers, users, stock counts, transfers, ingredient transfers, ingredient stock counts, ingredients, error logs.

### 3.2 POS impact: none, as long as the repo signatures stay

- The tablet never calls these HTTP lists. `sync/pull.go:120,132,135` calls `Read.Products(ctx, sc, 1, 100000)`, `Read.Promotions(ctx)` and `Read.DiscountCodes(ctx)` directly.
- D2-API adds **new** repo methods (`ProductsFiltered`, `PromotionsPage`, `DiscountCodesPage`) and leaves those three unchanged.
- It adds no field to the `Product`/`Promotion`/`DiscountCode` schemas, because new fields would ride into the tablet bundle.
- `/orders`, `/shifts`, `/requisitions` and `/outlets` are also used by the POS. D2-API does not touch them.

### 3.3 D2-API scope (one backend session, before D2a/D2b/D3 merge)

| # | Change | Why | Notes |
|---|---|---|---|
| a | `GET /products` gains optional `q` (name, brand, variant SKU/barcode via `EXISTS`), `categoryId`, `active` (`true`/`false`), `stock` (`low`/`out`, threshold D-81) and `sort` (`terbaru`/`nama`) | D2a server filters | Same response (`data` + `meta`). The implementer confirms the stock source `productObjScoped` uses before adding `stock=`; if it is costly per outlet scope, drop the "Stok rendah" chip for v1. No migration expected (products are in the hundreds). Facet counts on the chips are optional: the ERP outbox `counts` field is the precedent. |
| b | `GET /promotions` and `GET /discount-codes` gain optional `page`, `limit`, `q`, `status`, `type`. **Without `page` they return the full list exactly as today.** | D2b paging without breaking the full-list dependents | The response gains an optional `meta`. The TS client gets new `listPromotionsPage`/`listDiscountCodesPage`; the old calls stay for pickers. |
| c | ERP outbox rows gain `locationName` | D3c, raw `outlet 3f2a9c1d` | A `COALESCE((SELECT name FROM outlets …), (SELECT name FROM warehouses …))` scalar subquery in `itemColumns` (`integration/erp/admin.go:51`; subqueries because `retrySQL … RETURNING` reuses the same column list). Add `LocationName` to `OutboxItem`, `itemToAPI`/`detailToAPI` (`handlers/erp_outbox.go:181,209`). Spec: inline `{type: string, nullable: true}`. The formatter falls back to the short id (the location may be deleted). |
| d | New `GET /inventory/goods-receipts?locationType=&locationId=&dari=&sampai=&q=&source=&page=&limit=` | D3b Barang Masuk list (4.4) | `manage_inventory` + `scope(r)`. A new read query and a new list schema. The implementer checks the existing indexes; if needed, migration **0080** adds `goods_receipts (location_type, location_id, created_at DESC)` (small table, plain `CREATE INDEX`). Postgres gate subtest. |
| e | `GET /inventory/approvals` gains `outletId` and `kind` | D3c filters | |
| f | `id` tie-break in `ORDER BY` for transfers, ingredient transfers, stock counts, error logs, users | stable paging for the lists D3/D5 migrate | Read-only change. |
| g | Check: does `POST /inventory/goods-receipt?kind=&id=` (`server/server.go:289`) honour `Idempotency-Key`? The same question applies to the direct `POST /inventory/adjust` | `createLocationGoodsReceipt` / `adjustLocationStock` send none (`packages/api/src/client.ts:926-931`), so a retried receipt can double-count. The approval writes already require a key (`handlers/inventory_approvals.go:25-36`) | If the server supports it, D3a sends one key per SlideOver open. If not, add it here, following the `requireIdempotencyKey` pattern. The reviewer must see this one. |

**Not needed:**
- Settings: the D1-P fix is client-side (2.4).
- Kartu Stok: the cursor stays.
- Pergerakan: already paged.
- Customers and orders: already have what D4/D5 need.

### 3.4 OpenAPI and codegen

- **Where things live.**
  - The spec is `backend/api/openapi.yaml` (OpenAPI 3.1).
  - Go: `make gen-go` / `make gen-check` produce `backend/internal/api/api.gen.go` (CI `backend.yml:31`).
  - TS: `corepack pnpm --filter @mandalika/api gen` produces `packages/api/src/schema.d.ts`. The drift gate is `corepack pnpm gen:check`, inside `quality:ci`.
- **Schemas that change:**
  - query parameters for products, promotions, discount codes and approvals;
  - optional `meta` on the promotion and code list responses;
  - `ErpOutboxItem.locationName`;
  - new `GoodsReceiptListItem` + list response.
  - Hand-written TS that must follow: `ListResult`, `ErpOutboxList` and the inline query builders in `client.ts`.
- **Gotchas.**
  - `openapi-typescript` drops `nullable` on a `$ref` (`openapi.yaml:712` gives a non-null type at `schema.d.ts:3455`). Use inline scalars, or the existing `allOf` wrapper (`openapi.yaml:1006`).
  - `json_build_object` stays under 100 arguments: `orderObj` is at about 92, `requisitionBase` at 46 keys. D2-API does not touch either.
  - The spec is not enforced at runtime, so the Postgres gate subtests are the proof.
- **Client type bug** to fix in D1-P: `updateAppSettings` is typed `Promise<AppSettings>`, but the server returns `{ok: true}`. D1-P re-reads with GET after a save and never uses the PUT response as the new baseline.

### 3.5 Full-list dependents (D2 must not change the unfiltered default)

These keep `loadAllProducts` / `listPromotions()` as today:
- `ProductVariantPicker` (`Customers.tsx:681,699`, `promotions/PromoFormModal.tsx:379,383,454`)
- `StockCount.tsx:41,139` (snapshots every product × variant)
- `requisitions/RequisitionForm.tsx:44`
- `reports/PromoGrantsTab.tsx:46`
- `Dashboard.tsx:103,106`
- the promotion `combinableWith` pickers and every export

Pre-existing bug, fixed in D2a: `inventory/OutletGiveawaySection.tsx:26` reads only `listProducts(1, 200)`, the first page, so the giveaway picker misses products past 200.

Load note: there is one per-IP rate bucket of 1200/min, shared by an office and its tablets. Six screens re-download the whole catalogue every 12 s; D2a stops it on Produk and D5 on the rest.

---

## 4. Slices

**Every slice has these in common.**
- **Owner gate:** the mock (BO1-BO4) and D-67 to D-82 approved first.
- **Session setup:** its own session, worktree, branch off `prod-hardening`, PR and HANDOFF note.
- **Models:** Sonnet 5.5 medium implements; Opus 5.5 high (`reviewer`) reviews before the PR leaves draft.
- **Local gates:** `corepack pnpm quality:ci` and `corepack pnpm browser:ci` green locally.
- **Mirror CI:** push the branch to the `ci` remote and cite all five run ids (quality, backend, postgres, browser, dep-security).
- **Merge and deploy:** the owner merges; Cloudflare deploys the backoffice on push to `prod-hardening`.
- **No POS, OTA or APK change in any slice.** D2-API alone deploys a backend (owner's word, `scripts/deploy-backend.sh` + promote), before any UI that needs it merges.
- **Browser-gate rule:** a slice that renames or removes a scenario step edits `required-scenarios.json` and the counts in `accepted.spec.ts` in the same commit.

### D1-P · Pengaturan save bar + stale-overwrite fix (wave 1) — 1 session

- **Scope:** section 2.4, all of it.
- **New files:**
  - `BO/ui/SaveBar.tsx`
  - `BO/lib/navGuard.ts` + test
  - `BO/lib/useUnsavedChanges.ts`
  - `BO/screens/settings/settingsDiff.ts` + test (diff, human labels, merge onto fresh)
  - `BO/screens/settings/SettingsCard.tsx` (the `changed` cue)
- **Edits:**
  - `SettingsScreen.tsx`: remove the header button; baseline/draft/diff; merge-on-save; SaveBar; `approverRoles` joins the diff.
  - `settings/TransaksiSection.tsx`, `settings/SplitTenderCard.tsx` (copy line), `settings/LocationsSection.tsx` (outlet-toggle confirm through the existing Modal, "Disimpan langsung" notes).
  - `ui/Tabs.tsx`: optional `dirty` per tab.
  - `App.tsx`: the sidebar `onClick` and the nav-event listener await `confirmLeave()`. Two small hunks; D1b rewrites the shell later.
- **Leave dialog:** built from `ui/Modal` for now; D1b swaps in `ConfirmDialog`.
- **Tests:** rewrite BO-SPLIT-TOGGLE steps `:215-232`:
  - "Simpan Semua" becomes "Simpan perubahan";
  - the second save follows a second edit, and the PUT still omits `splitTenderEnabled`;
  - the success text changes;
  - the add-method button must stay the immediate sibling of its input (`:216`).
  - New **BO-SETTINGS-GUARD**:
    - (a) an edit followed by a sidebar click opens "Simpan perubahan Pengaturan?"; "Tetap di sini" keeps the edit, "Buang perubahan" navigates;
    - (b) the stale merge:
      - the mock serves a newer `taxRate` on the pre-save GET, and the PUT carries the fresh `taxRate` plus the edited key;
      - an untouched present-only key (`recipesEnabled`, `inventoryApprovalRequired`, `documents`, `splitTenderEnabled`) is absent from the PUT;
      - a GET follows the PUT.
- **Review:** `reviewer` (Opus high). It writes the payment-methods and split-tender settings.
- **Release:** backoffice only.

### D1a · Tokens, kit, label maps (wave 1, parallel with D1-P) — 1-2 sessions

- **Tokens, font, brand:**
  - `packages/ui-tokens/tokens.css` (new) and its import in `BO/index.css`. The `gray-*`/`gold-*` remap stays for unmigrated screens; the dead `indigo-*` ramp goes.
  - The vendored Roboto Variable `woff2` + `OFL.txt` in `apps/backoffice/public/fonts/`, with `@font-face` in `tokens.css`. No `package.json` change.
  - `index.html` `lang="id"`.
  - `lib/brand.ts` registry (2.1).
- **Kit (new, section 2.3):** `ui/DataTable.tsx`, `ui/FilterBar.tsx`, `ui/ExportButton.tsx`, `ui/ConfirmDialog.tsx` (+ `useConfirm`), `ui/SlideOver.tsx`, `ui/StatusBadge.tsx`, `ui/Switch.tsx`, `ui/overlayStack.ts`. Additive props: `PageHeader.count`, the `EmptyState` action slot, `Field` `htmlFor`/`id`/`aria-invalid`.
- **Label maps:** `lib/labels/{transfer,requisition,opname,approval,order,erp,ledger,reason,review,role,errorSource,payment}.ts`, one file per domain so wave-3 slices do not collide. The old modules re-export from them.
- **Proving ground:** migrate **Log Kesalahan** (`ErrorLogs.tsx`, 222 lines, admin-only, no browser scenario) to PageHeader + FilterBar + DataTable + ExportButton + StatusBadge.
- **Tests:** vitest for `labelOf`, the contrast table and markup (DataTable, ConfirmDialog, SlideOver, StatusBadge). The three `renderToStaticMarkup` suites must stay green; this proves the no-portal rule.
- **Gate:** confirm the Cloudflare deploy of the merge goes green and serves `/fonts/*.woff2`.
- **Review:** `reviewer` (Opus high), focused on a11y and the overlay stack.

### D1b · Shell + router foundation (wave 2) — 2 sessions

**Session 1:**
1. **Test helpers first, in their own commit, with `browser:ci` green before any app change.**
   - Add `openBackoffice(page)`, `navTo(page, navId)` and `openTab(page, screen, tabKey)` to `tests/browser/fixture.ts`.
   - Replace the 8 copied login blocks (`accepted.spec.ts:15-21`, `backoffice-scenarios.ts:65-68,273-275`, `backoffice-review-scenarios.ts:38-45`, `backoffice-import-scenarios.ts:51-58`, `backoffice-stockcard-scenarios.ts:83-90`, `backoffice-refund-scenarios.ts:12-21`, `backoffice-split-scenarios.ts:21-30`).
   - Add `data-nav-id` to today's sidebar buttons and `data-tab-key` to `ui/Tabs` buttons.
   - Move every nav and tab click to the helpers.
2. **Router core:** `lib/router/{routes,hash,useRoute,navigate,Link,useListState}.ts` + unit tests.
3. **Shell rewrite in `App.tsx`:**
   - grouped sidebar from `routes.ts`;
   - header with a breadcrumb, the native OutletSwitcher and a user menu holding "Keluar" (D-72);
   - badge legend popover and the D-71 colours;
   - outlet persisted in `outlet.tsx`;
   - `React.lazy` screens behind one `Suspense` fallback, "Memuat…";
   - the `lib/navGuard` hook-up, with ConfirmDialog replacing the D1-P Modal dialog.

**Session 2:**
- Route every screen's **top-level** tabs and views. The tab comes from the path, not `useState`, in: `Reports.tsx`, `Warehouses.tsx`, `inventory/StokProduk.tsx`, `inventory/OpnameSection.tsx`, `products/useProductsData.ts` (tab only), `Promotions.tsx` (tab only), `Customers.tsx` (`view` only), `Users.tsx`, `syncReview/SyncReview.tsx` (status), `SettingsScreen.tsx` (section), `ingredients/Ingredients.tsx` (inner).
- `transfers/Transfers.tsx` and `requisitions/RequisitionList.tsx` views become paths.
- `RequisitionDetail.tsx:28` calls `navigate()`.
- Renames: Ringkasan, Log Kesalahan, Ikhtisar (D-77).
- New scenarios:
  - **BO-ROUTE-DEEPLINK**: open `#/laporan/refund`, reload, still on Refund; `#/inventori/transfer/<id>` opens the detail.
  - **BO-ROUTE-GUARD**: a dirty Pengaturan plus browser Back (and Forward) puts the hash back and asks; "Buang perubahan" leaves; Forward history survives a refused Back.

**Not in D1b:** screen-internal filters (wave 3 and D4 own them).

**Review:** `reviewer` (Opus high). It is wide but mechanical; the guard and the Back revert are the risky parts.

### D2-API · Backend list parameters (wave 2-3; can run beside D1b) — 1 session

- **Scope:** the backend needs in section 3, as one backend PR.
- **Gates:** OpenAPI + codegen (`corepack pnpm gen:check`), Postgres gate subtests for each new parameter, `go vet`/`go test`/`gofmt`.
- **Review:** `reviewer` (Opus high), because it touches generated types.
- **Release:** `scripts/deploy-backend.sh d2api` → smoke → promote (owner's word) **before** D2a/D2b/D3 merge. The UI must also tolerate the old backend for the window between deploy and merge (new parameters ignored; new fields optional).

### D2a · Produk (wave 3) — 1 session

- **Screens, in order:** the Produk list, then Kategori, then Bundle (read-only).
- **List:**
  - DataTable + FilterBar through `useListState`: `q`, `status`, `kategori`, `stok`, `hal`, `per`.
  - Server parameters; ExportButton "Unduh" (CSV · Excel) over **all rows matching the filters**.
  - No more whole-catalogue polling on this screen; it fetches on filter change, polling only the visible page.
- **Edit and create:** `ProductFormModal` becomes a **SlideOver** (`?ubah=`/`?baru=1`, width lg) with per-field errors and a summary, and the per-outlet matrix as a section.
  - RecipeSlideOver becomes a `SlideOver` (Escape, dirty guard, loading on save) layered above it. The overlay stack keeps Escape on the top layer only.
- **Delete:** `DeleteConfirmModal` becomes `ConfirmDialog` and keeps the 409 reason (its test is updated).
- **Also:**
  - Status as a Switch inside the form (the list shows the Switch read-only plus the label).
  - The `saveCat` error goes to the category form, not the product form.
  - The raw `Satuan` sentinel is mapped.
  - Low-stock threshold per D-81.
- **Tests:** `products/erpReadOnly.test.tsx` and `products/DeleteConfirmModal.test.tsx` follow the new props and markup. New **BO-PRODUCTS-LIST**: the filters land in the URL, reload keeps them, paging and the SlideOver dirty guard work.

### D2b · Promosi + Kode Diskon (wave 3) — 1-2 sessions

- **Lists:** DataTable for both tabs, server paging (D2-API), FilterBar (`q`, `status`, `jenis`, period), ExportButton.
- **Status:** a labelled Switch with an undo toast (D-79).
- **Form:** the wizard becomes a single SlideOver lg with sections (D-80):
  - outlet chips with "Semua outlet" first;
  - Jam Aktif shown with "Sepanjang hari" as the default (4.3);
  - per-field errors.
- **Error handling:** a `catch` and visible error on save, duplicate, delete and batch. `alert()` goes; delete uses ConfirmDialog.
- **Tests:** BO-SEMANTIC is rewritten. It currently relies on:
  - the row button index (`backoffice-scenarios.ts:219,230`);
  - the `.fixed.inset-0.z-50` class (`:220,224,232`);
  - "Lanjutkan" ×2.
  - The rewrite uses the SlideOver heading and named row actions.
  - `promotions/promotionKeyForm.test.ts` follows the new form props.

### D3a · Pergerakan + Kartu Stok (wave 3) — 1-2 sessions

Per 4.4:
- **Pergerakan:**
  - a legend row with the six bucket definitions;
  - a reconcile badge per row (the existing `bucketsReconcile`, `inventory/pergerakanBuckets.ts:21`);
  - the "waktu tercatat" note;
  - debounced search;
  - URL state.
- **Kartu Stok:**
  - SKU rail (240 px) on the left;
  - sticky Waktu Kejadian + Jenis columns, and grouped headers;
  - kind chips grouped under the six Pergerakan bucket names;
  - ERP status as Terkirim / Menunggu / Gagal;
  - Alasan and Penyetuju split;
  - bookmarkable `#/inventori/kartu-stok?sku=&lokasi=&dari=&sampai=&jenis=`.
- **Modals to SlideOvers:**
  - `GoodsInModal` becomes the SlideOver "Barang Masuk": exact heading, fresh state per open, so the stale-lines resubmit bug at `LocationStockView` goes away.
  - `AdjustModal` becomes "Penyesuaian Stok" with "Stok sekarang 9 → baru 7 (−2)".
- **Tests:** BO-STOCK-CARD:
  - "Catat barang masuk" / "Catat Barang Masuk" become "Tambah barang masuk";
  - "Buat penyesuaian" becomes "Tambah penyesuaian";
  - the ledger kind "Penerimaan" becomes "Barang Masuk";
  - table semantics and the exact `columnheader` names are unchanged;
  - the `accepted.spec.ts:145` count is updated if steps change.

### D3b · Transfer, Opname, Barang Masuk list, stock confirms (wave 3) — 1-2 sessions

- **Transfer:**
  - DataTable, one status map (filter = badge), and no masking of unknown statuses as Draf (`Transfers.tsx` `?? STATUS.draft`).
  - **ConfirmDialog on Kirim and Batalkan** (new behaviour, not a replacement), copy "Stok {n} unit akan keluar dari {source} sekarang."
- **Opname:**
  - rename, and the column pair Stok sistem / Stok dihitung;
  - ConfirmDialog with the net difference, replacing `window.confirm` (`StockCount.tsx:219`);
  - confirms on Mulai and cancel (`:346,368`);
  - the same treatment for `ingredients/OpnameTab.tsx:249` and the cancel-reason `window.prompt` at `ingredients/TransferTab.tsx:352` (the reason becomes a field in the dialog).
- **Requisition:** confirms on Ajukan, Batalkan, Buat Transfer and Setujui (`RequisitionDetail.tsx:131,135,138,226`).
- **Barang Masuk:** a list tab under Inventori, using the D2-API endpoint and showing the Garansi tag.
- **LocationStockView:** PAR saves only when the value changed, with feedback.
- **Review:** `reviewer` (Opus high). Stock-moving actions and idempotency keys are involved.
- **Tests:** new **BO-TRANSFER-CONFIRM**: Kirim asks; Batal leaves the draft; confirming calls the API once.

### D3c · Persetujuan, Integrasi ERP, Tinjauan Sinkron, Stok Minus (wave 3) — 1 session

- **Persetujuan Stok:** outlet and type filters, DataTable, and the 3-column strip "Saat diajukan · Sekarang · Yang diterapkan".
- **Integrasi ERP:**
  - location **names** (D2-API);
  - a status legend;
  - the relay report as three counts (Terkirim · Ditahan · Gagal);
  - ConfirmDialog on "Kirim sekarang" and "Kirim ulang";
  - env-var names out of the visible relay text, behind "Detail teknis".
- **Tinjauan Sinkron:** raw codes behind "Detail teknis". The rows stay list buttons with their composed names (BO-REVIEW-RESOLVE `:55`).
- **Stok Minus:** follows the Laporan date range by default (`reports/OversellTab.tsx`).

### D4 · URL-state completion (wave 4) — 1 session

- **Routes and URL state for the screens not touched yet:**
  - Customers: detail, duplicates and loyalty sub-views, and the list filters.
  - Users: tab.
  - Ingredients: inner tabs and filters.
  - Laporan: the shared Dari/Sampai and the per-tab filters as query keys.
  - Ringkasan: period.
- **Navigation:** scroll restore per route, and removal of the nav-event shim.
- **Laporan export renames (D-78):** "Export CSV", "Export Refund CSV" and "Ekspor CSV" become "Unduh CSV" / "Unduh CSV refund"; the XLSX "Export" becomes "Unduh Excel"; the tab "Ekspor" becomes "Unduh data". This updates BO-PAGES-CSV, BO-PAGES-XLSX, BO-RACE, BO-REFUND-LIST and BO-SPLIT-ORDER.
- **Tests:** new **BO-ROUTE-BACK**: list → detail → Back keeps filters and page.

### D5 · Remaining tables sweep (wave 4, optional per D-74) — 1-2 sessions

- **DataTable/FilterBar/ExportButton** for:
  - the Pelanggan list (keep its paging contract);
  - Pengguna;
  - the remaining Laporan tables (Shift, Hadiah Promo, Kode Diskon, Refund, Stok Minus), where the hand-rolled pagers become `Pagination`;
  - ingredients Daftar (fix the client-side category filter on a server page, `DaftarTab.tsx:76-79`);
  - the Permintaan Barang list.
- **Cleanup:**
  - the seven copied "Konfirmasi Hapus" modals become `ConfirmDialog`;
  - add the missing `catch`es (Users, Customers);
  - the remaining ad-hoc gold "selected" recipes move to the kit;
  - a raw-enum sweep;
  - cut whole-catalogue polling in the remaining screens (Promotions picker, Customers, StockCount, Dashboard), as a perf follow-up to keep or split.
- **Agents:** `chore` (Haiku low) may do the mechanical swaps under Sonnet supervision; the reviewer adjudicates.

---

## 5. Screen migration matrix

| Screen | Slice | DataTable | FilterBar + URL | Edit surface | Confirms added | Notes |
|---|---|---|---|---|---|---|
| Log Kesalahan | D1a | yes | source chips (URL in D1b) | — | — | kit proving ground |
| Pengaturan | D1-P | — | tab in URL (D1b) | draft + SaveBar | outlet toggle | 2.4 |
| Shell / sidebar / header | D1b | — | top-level routes | — | leave guard | D-71, D-72 |
| Produk / Kategori / Bundle | D2a | yes | yes | SlideOver lg | delete | server filters |
| Promosi / Kode Diskon | D2b | yes | yes | SlideOver lg (no wizard) | delete | Switch + undo |
| Pergerakan | D3a | yes | yes | — | — | legend, reconcile |
| Kartu Stok | D3a | yes (sticky, grouped) | yes, bookmarkable | SlideOver Barang Masuk / Penyesuaian Stok | — | SKU rail |
| Ikhtisar (Stok Produk) | D1b (rename) / D5 | D5 | D4 | — | — | |
| Transfer (product + ingredient) | D3b | yes | yes | in-place views as routes | Kirim, Batalkan | |
| Opname (product + ingredient) | D3b | per-count cards stay | — | inline autosave stays | Mulai, Batal, Selesai | |
| Barang Masuk list | D3b | yes | yes | — | — | new list |
| Permintaan Barang | D3b (confirms) / D5 (list) | D5 | D1b routes | full-panel views as routes | Ajukan, Batalkan, Buat Transfer, Setujui | |
| Persetujuan Stok | D3c | yes | yes | Modal + PIN stays | (exists) | 3-col strip |
| Integrasi ERP | D3c | yes | yes | Modal stays | Kirim sekarang, Kirim ulang | names |
| Tinjauan Sinkron | D3c | list buttons stay | yes | Modal stays | (note exists) | |
| Laporan › Transaksi | D4 | inline expand stays | D4 | inline + refund confirm | (exists) | 0.7 |
| Laporan › other tabs | D4 (URL, labels) / D5 (tables) | D5 | D4 | — | — | |
| Pelanggan | D4 (routes) / D5 (table) | D5 | D4 | Modal → SlideOver in D5 | loyalty delete | |
| Pengguna | D4 / D5 | D5 | D4 | Modals stay | role delete exists | |
| Ringkasan | D1b (rename) / D4 | — | period | — | — | |

---

## 6. Test impact: how each slice keeps `browser:ci` green

### 6.1 Rules for every slice
- Iterate with `-g <ID>`. `maxFailures: 1` hides later failures. Then run the full gate.
- No external requests: fonts are bundled, images local, and the logo literal stays in `lib/brand.ts`.
- Exactly one `<main>`.
- Native `<select>` for filters and the OutletSwitcher.
- Tabs stay `<button>`s (`data-tab-key` from D1b).
- DataTable uses real table semantics, with header names exact and no sort text inside the accessible name.
- Keep the page-size defaults the scenarios assume: Refund report 50 (`backoffice-refund-scenarios.ts`).
- Keep `role="button"` row semantics where 0.7 says so.
- Keep the CSV download path (Blob + `createObjectURL` + anchor click, stubbed by `setupBackoffice:71`).
- Keep the **static** `import * as XLSX` in `lib/csvUtils.ts:1` (BO-PAGES-XLSX checks the module loaded before the first export, `:170-175`). Lazy routes are fine; a click-time dynamic import is not.
- A toast must not repeat an inline `role="alert"` text: strict-mode double match.
- New API calls get mocks in the scenario. The fallthrough returns `{data:[]}`, which crashes screens that expect an object.

### 6.2 Per slice

| Slice | Scenarios touched | Change |
|---|---|---|
| D1-P | BO-SPLIT-TOGGLE (`backoffice-split-scenarios.ts:170-236`, count `accepted.spec.ts:169`) | save label and flow, success text; **new BO-SETTINGS-GUARD** (+1 registry row) |
| D1a | none | vitest only; the `renderToStaticMarkup` suites stay green |
| D1b | **all 12 BO scenarios** (nav + tab clicks through helpers); BO-PAGES-CSV/XLSX (`'Dashboard'` at `backoffice-scenarios.ts:83,127,167`); BO-REVIEW-RESOLVE (`navTo('syncReview')` replaces the `/Tinjauan Sinkron/` regex; badge `aria-label` "1 item terbuka" kept) | helper commit first, green; then the shell. **New BO-ROUTE-DEEPLINK, BO-ROUTE-GUARD** |
| D2-API | Postgres gate subtests | backend only |
| D2a | vitest `erpReadOnly`, `DeleteConfirmModal` | **new BO-PRODUCTS-LIST** |
| D2b | BO-SEMANTIC (`backoffice-scenarios.ts:213-242`), vitest `promotionKeyForm` | rewrite against the SlideOver |
| D3a | BO-STOCK-CARD (`backoffice-stockcard-scenarios.ts:25-172`, count `accepted.spec.ts:145`) | Barang Masuk / Penyesuaian strings; table semantics kept |
| D3b | none existing | **new BO-TRANSFER-CONFIRM** |
| D3c | BO-REVIEW-RESOLVE (labels and rows kept) | "Detail teknis" toggle only |
| D4 | BO-PAGES-CSV, BO-PAGES-XLSX, BO-RACE, BO-REFUND-LIST, BO-SPLIT-ORDER | export label renames; **new BO-ROUTE-BACK** |
| D5 | BO-CSV-IMPORT (only if the Pelanggan export bar changes), BO-PAGES-CSV (Shift tab export) | labels; the `importDialogState.test.ts:100` "Error" column stays |

**Net new required scenarios:** BO-SETTINGS-GUARD, BO-ROUTE-DEEPLINK, BO-ROUTE-GUARD, BO-PRODUCTS-LIST, BO-TRANSFER-CONFIRM, BO-ROUTE-BACK. The registry goes from 50 to 56; the stale "33" in `tests/browser/README.md:21` is fixed in D1b.

---

## 7. Parallelism

```
wave 1:  D1-P ─┐        (disjoint files)
         D1a  ─┤
wave 2:        └─ D1b ──┐           D2-API ─┐   (backend; parallel with D1b)
wave 3:                 └───────────────────┴─ D2a ║ D2b ║ D3a ║ D3b ║ D3c
wave 4:                                            └─ D4 ─ D5 (optional)
```

- **D1-P ∥ D1a.** They share no file.
  - D1a: `packages/ui-tokens`, `BO/index.css`, `main.tsx`, `index.html`, `public/fonts/*`, `lib/brand.ts`, new `ui/*`, `lib/labels/*`, `ErrorLogs.tsx`.
  - D1-P: `SettingsScreen.tsx`, `settings/*`, `ui/Tabs.tsx`, `ui/SaveBar.tsx`, `lib/navGuard.ts`, `lib/useUnsavedChanges.ts`, two hunks of `App.tsx`, the split scenario file and the registry.
- **D1b is alone.** It touches `App.tsx`, every screen's top-level tab state and every BO test file.
  - **D2-API can run beside it**: backend, `openapi.yaml` and the generated types, which D1b does not touch.
- **Wave 3 runs up to five sessions in parallel.** Recommendation: at most three at once (owner review load), in this order:
  - first D2a, D3a, D3b (largest value);
  - then D2b, D3c.
- **Wave 3 file ownership:**

  | Slice | Owns |
  |---|---|
  | D2a | `products/*`, `Products.tsx`, `recipes/*` |
  | D2b | `Promotions.tsx`, `promotions/*` |
  | D3a | `inventory/MovementSummary.tsx`, `StockCard.tsx`, `pergerakanBuckets.ts`, `stockCardFormat.ts`, `DocumentModal.tsx`, `warehouses/*` (GoodsIn, Adjust) |
  | D3b | `transfers/*`, `StockCount.tsx`, `stockcount/*`, `ingredients/TransferTab.tsx` + `OpnameTab.tsx`, `inventory/LocationStockView.tsx`, `requisitions/*`, new `inventory/GoodsReceiptsList.tsx` |
  | D3c | `approvals/*`, `integration/*`, `syncReview/*`, `reports/OversellTab.tsx` |

  - Shared append-only files: `lib/router/routes.ts` (D3b adds one tab), `lib/labels/*` (one file per domain), `required-scenarios.json` and `accepted.spec.ts`.
  - Rule: rebase on `prod-hardening` before merging, and merge one at a time.
- **D4 then D5 are sequential.** Both touch Laporan and Customers.

---

## 8. Risks (ranked)

1. **Browser-gate churn.** Twelve scenarios, `maxFailures: 1`, exact names.
   - Mitigation: the helper commit first (D1b), `-g` iteration, and every rename landing with its test in the same slice.
2. **D1b breadth.** Every screen's tab state moves to the path in one slice.
   - Mitigation: mechanical edits only, no visual change inside screens, the Opus review, and nothing else in flight during wave 2 except D2-API.
3. **Leave guard with the hash router.** The revert-and-ask on browser Back is the subtle part.
   - Mitigation: BO-ROUTE-GUARD covers Back, a sidebar click and a reload (`beforeunload`).
4. **Merge-on-save semantics.** Pengaturan does a GET before each PUT; a failing GET blocks the save with a message (no blind PUT).
   - Same-key concurrent edits stay last-writer-wins; a server version column is a follow-up.
5. **Static assets and the Cloudflare build.** Fase D adds no npm dependency (the router is hand-rolled; the font is vendored), so the frozen-lockfile failure mode does not apply.
   - D1a still confirms the deploy goes green and the font is served.
   - Any later slice that does touch a `package.json` must ship the regenerated `pnpm-lock.yaml`.
6. **Generated types (D2-API).**
   - `openapi-typescript` drops `nullable` on `$ref` schemas (memory gotcha).
   - `json_build_object` stays under 100 arguments (the `orderObj` note in HANDOFF).
   - Old-backend tolerance during the deploy-then-merge window.
7. **Mixed look during migration.** Screens on the new kit sit beside unmigrated ones for a few weeks; D5 closes the gap.
8. **Pickers that need every product.** These keep `loadAllProducts`, so D2's paging must not change the default unpaged behaviour they rely on (section 3).

---

## 9. Owner decisions (D-register, continuing at D-67)

| ID | Decision | Recommended default |
|---|---|---|
| D-67 | Router implementation | **Hand-rolled hash router** in `BO/lib/router` (2.2); alternative react-router v7 `createHashRouter` (adds a dependency) |
| D-68 | When the router lands | **Foundation in D1b** (sidebar built on it, D2/D3 use URL state from their first commit); D4 becomes "URL-state completion" |
| D-69 | URL scheme | **Indonesian path slugs and query keys** (`#/inventori/kartu-stok?sku=…`); the outlet scope stays out of the URL and is remembered per viewer in localStorage |
| D-70 | Pengaturan save pattern | **Sticky SaveBar** shown only with changes, with the change list + dirty cues on tabs/cards/rows + leave guard + client-side merge-on-save; remove the top "Simpan Semua"; ship first as D1-P |
| D-71 | Sidebar count colours | **Red = needs a person's decision** (Persetujuan Stok, Tinjauan Sinkron), **amber = to check, not blocking** (Stok minus belum dicek on Laporan); a legend in the sidebar |
| D-72 | User and "Keluar" | **Move from the sidebar footer to a header user menu** (§4 wireframe) |
| D-73 | Small text on gold | **`brand-strong`** (Mandalika `#8f6412`) for filled controls; `warn-strong` `#a14a06` for badge text; POS tokens unchanged |
| D-74 | Fase D scope | **Add D5** so every list screen ends on the kit (+1-2 sessions); otherwise Pelanggan, Pengguna, the Laporan tables and Bahan stay on the old look |
| D-75 | Backoffice font | **Self-hosted Roboto Variable**, a vendored `woff2` in `public/fonts` (matches the POS and Figma; no new dependency); alternative system font |
| D-76 | Shared tokens | **`packages/ui-tokens/tokens.css` now for the backoffice**; the POS switches later in a no-visible-change chore shipped with its next OTA |
| D-77 | "Overview" sub-tab name | **"Ikhtisar"**, not "Ringkasan" as D-22 said: "Ringkasan" is the new Dashboard name and the two would collide |
| D-78 | Export wording | **"Unduh CSV"**, **"Unduh Excel"** for XLSX, the dropdown **"Unduh"** (CSV · Excel), a qualifier when two share a screen ("Unduh CSV refund"); the Laporan tab "Ekspor" becomes **"Unduh data"** |
| D-79 | Promotion/code status in the list | **Labelled Switch that saves at once** with an undo toast ("Promo X dinonaktifkan · Urungkan"); alternative: status only inside the form |
| D-80 | Promotion form | **One scrolling SlideOver (720 px) with sections**, no 3-step wizard |
| D-81 | Low-stock threshold in the backoffice | **2 per variant** (D-20, same as the POS); today the product list warns at ≤ 5 |
| D-82 | Order detail and sync review | **Keep inline expand / list rows** (no SlideOver), unlike §4's "every detail opens as a SlideOver": the refund flow and two browser scenarios depend on it |

---

## 10. Mocks (Figma) and Figma follow-ups

- **Frames**, on the new page created by the capture (node 15-2, https://www.figma.com/design/iMyGehblek8VJXbMIRRPrf?node-id=15-2), all 1440 × 900:
  - **BO1** shell + Produk list: grouped sidebar with the legend popover, header scope, PageHeader, FilterBar, DataTable, Pagination, the URL note.
  - **BO2** "Ubah produk" SlideOver: error summary, per-field errors, sticky footer with the dirty cue.
  - **BO3** Pengaturan › Transaksi: changed cards and rows plus the sticky SaveBar.
  - **BO4** the leave guard.
  - **Kit sheet**: buttons, StatusBadge + label map, FilterBar date presets + ExportButton tooltip, ConfirmDialog, Switch/Chip/Pagination.
- **How they were made.**
  - The HTML at `docs/plans/assets/2026-11-02-fase-d-backoffice-mock.html` uses the same token values as the Figma Semantic/Brand variables and the POS CSS.
  - It was captured into the file with Figma's `generate_figma_design`. The tool converts the page into editable layers, not a screenshot.
  - **Not verified in Figma itself**, because reading the file needed the capped tools:
    - the page name;
    - whether the five mocks are separate top-level frames or children of one frame holding the whole page body (headings and captions included);
    - whether the requested variable binding (`bindVariables=true`) attached the Semantic/Brand variables.
    - The owner's first look settles all three.
  - The layers are plain frames, not library components. If the owner wants Code Connect components later, rebuild the kit with `use_figma` once the monthly cap allows.
  - The HTML loads Roboto from Google Fonts for the capture only; that file is documentation, not app code.
- **Figma follow-ups for the owner.**
  1. The team is on the Figma **Starter** plan. Figma documents a small monthly MCP tool-call cap for it (about 20; capture tools are exempt). It was refused on this session's sixth call, so earlier sessions presumably used most of it. More agent edits in Figma this month need a paid seat, or must wait for the reset.
  2. Rename the captured page "Fase D · Backoffice".
  3. A failed kit script may have left a variable collection named **"Desktop"**, empty or holding one variable `bo/row`. Delete it in Figma (Local variables).
  4. Not caused by Fase D: the Brand collection still holds the old Flamboyan/Performance placeholder colours (`#9f1f4a`, `#1f3a8a`), although D-24 answered `#9b59b6` / `#a93226`.

---

## 11. Review

<!-- REVIEW -->
