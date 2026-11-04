# Handoff spec: Mandalika POS — "Kertas & Emas · Kaca" redesign

## Overview
Visual-only redesign of the cashier tablet app (W1–W5) and the Phase D backoffice (BO1–BO4 + Kit D1).
Behaviour, data flow, copy meaning and screen structure stay the same. What changes: materials (glass),
radii, selection styling, button hierarchy, status styling, spacing, and state-change motion.

**Source of truth:** the files in `screens/`. Each `*.dc.html` is a self-contained HTML+CSS mockup
from a Claude Design canvas. Read the `<style>` block for exact values and the markup for structure.
They are NOT runnable app code: `{{...}}` holes, `<sc-for>`/`<sc-if>` and the `class Component extends DCLogic`
script are the design tool's template runtime. Translate them into this repo's own components.

| File | Screen |
|---|---|
| `Tokens.dc.html` | Tokens & rules (read first) |
| `Main.dc.html` | W1 Katalog + Keranjang (interactive reference: add to cart, category selector, toast) |
| `W1-Kaca.dc.html` | Same as Main + perf test tools (FPS meter, auto-scroll). Reference only, do not ship the tools |
| `W2-Bayar.dc.html` | W2 Bayar (checkout) |
| `W3-Pelanggan.dc.html`, `W3b-Profil.dc.html` | W3 customer search, W3b customer profile |
| `W4-Refund.dc.html` | W4 Refund from history |
| `W5-Koneksi.dc.html` | W5 Connection & queue |
| `BO1-Produk.dc.html` … `BO4-KeluarPengaturan.dc.html`, `BO-Kit.dc.html` | Backoffice Phase D + shared kit |
| `W6-ShiftRecap.dc.html` | POS Rekap & Tutup Shift, Hitung Lembar (`DenominationSheet`), Blind Count & Variance Confirm Dialog (`P-14`, `P-15`, `P-16`, `CS-3`, `CS-4`) |
| `W7-MenuDanStok.dc.html` | POS Unified Menu Drawer, Pesanan Tersimpan (`HeldOrdersSheet`), Diskon/Promo/BXGY/Bundle Sheet & Terima Transfer / Permintaan Barang |
| `BO5-RingkasanLaporan.dc.html` | Backoffice Ringkasan KPI/Chart fixes (`#5`, `#8`) & Laporan merged Transaksi + Unduh menu + sticky Stok Minus bar (`#16`, `#17`, `M-1`) |
| `BO6-InventoriOpname.dc.html` | Backoffice Inventori: Stok Produk Outlet Total fix (`#6`), full-width Kartu Stok (`#31–#34`), Bahan `id-ID` + History tables (`#7`, `#30`), Opname scope fix (`#29`) |
| `BO7-PromosiPelanggan.dc.html` | Backoffice Pelanggan & Promosi: SlideOver with pinned `errorSummary` (`#3`, `#4`, `#9`, `#10a`), phone/duplicate normalization, single Switch column (`M-8`) |
| `BO8-OperasionalSistem.dc.html` | Backoffice Pengguna (`#2`, `#27`), Persetujuan Stok, Permintaan Barang (`#20`), and Unified Masalah & Sinkron (`Tinjauan Sinkron` + `ERP` + `Log Kesalahan`, `#12`, `#23`, `#24`) |

Default look = Tweaks `Material: Kaca ringan`, `Kartu: Kaca`, `Ambient: on`, `Gerak: Pegas`.
The `Datar` material in each file shows the old flat look, for comparison.

## Live QA findings
See `QA-FINDINGS.md`: bugs and inconsistencies found in the live backoffice (P1 → P3). Fix P1/P2 while restyling the same components; the P3 inconsistency list maps directly onto the standard components in this spec (one slide-over form, one ConfirmDialog, one toast, one selected style).

## Design tokens
| Token | Value | Usage |
|---|---|---|
| `paper-0` | #fbf9f5 | page ground |
| `paper-1` | #f3efe7 | thumbs, inset fields (flat), qty pill (flat) |
| `paper-2` | #e9e3d8 | card border, dividers |
| `ink-900 / 700 / 500` | #1a1008 / #4a3f33 / #7a6f62 | text primary / secondary / hints (≥4.5:1 on paper) |
| `brand` | #b07d18 | brand mark, primary bar in flat mode only. Never white text < 18.66px bold on it (3.6:1) |
| `brand-press` | #8f6412 | gold text, selected chip fill, small primary buttons, switch on, selected label in selectors |
| `bar-primary` | linear-gradient(180deg,#a8771a,#93670f) + inset 0 1px 0 rgba(255,255,255,.28) | one primary bar per screen (Bayar, Konfirmasi, Pilih…) |
| `bar-danger` | linear-gradient(180deg,#c22a1d,#a51f14) | Refund / destructive primary |
| status `ok / warn / danger / info / promo / reward` | #1f7a4d / #b45309 / #b42318 / #1d4ed8 / #6d28d9 / #0f766e, bg tints #e3f3ea / #fdf0df / #fbe4e1 / #e3eafc / #efe7fb / #dff3f0 | status only, never gold |
| radius | 24 floating panel · 16 group, primary bar, dialog · 12 control & card · 6 tag · full for status pills | |
| type | Roboto, tabular numbers for money. 12 min · 13 secondary · 14 buttons · 15 body/names · 16–17 prices · 20 bar label · 22 panel title · 26 bar amount | |
| touch | controls ≥ 44dp (target 48); text ≥ 12sp | |

## Materials (the glass system)
| Material | Spec | Used on |
|---|---|---|
| Glass top | rgba(255,253,249,.56) + backdrop-filter blur(20px) saturate(180%), border 1px rgba(255,255,255,.7), shadow `inset 0 1px 0 rgba(255,255,255,.85), 0 0 0 .5px rgba(26,16,8,.08), 0 14px 36px -14px rgba(70,46,10,.28)` | header, category bar, BO sidebar/topbar, slide-over, dialogs, sticky save bar |
| Panel | rgba(255,252,246,.88), same border/shadow, NO blur | cashier right panel (cart / sheets) |
| Card | rgba(255,255,255,.6), border 1px paper-2, `inset 0 1px 0 rgba(255,255,255,.9)`, no blur, no drop shadow. "Solid" variant = #fff | product tiles, list rows, tables, keypad keys |
| Group | rgba(255,255,255,.62), no border | customer chip in cart, summaries, filter bar, info blocks |
| Ambient | 4 soft radial gold/peach gradients behind everything (see `.amb`) | page background |

**Performance rule (hard):** blur only on layers that do not scroll. Never blur cards, rows or anything inside a
scrolling list. Measured on Samsung Galaxy Tab A9: 59–61 fps in Kaca ringan with 72 tiles. If the app stack
can't do backdrop blur cheaply, fall back to the Panel material (no blur) for the top layers too.

## Components (key ones)
| Component | Spec |
|---|---|
| Selector (categories, payment method, date range, tabs) | track rgba(26,16,8,.05) (or glass), white thumb with soft shadow sliding under the selected item; selected label #8f6412, others ink-700 |
| Choice chip / button | 44h, radius 12, bg rgba(26,16,8,.05); selected = #8f6412 fill + white text |
| Product tile | 150h, padding 12, radius 12, card material. Row 1: 56×56 thumb (radius 8) + name (15/600, max 2 lines, ellipsis) + family (12, ink-500). Price (16/700) then stock line (8px dot + 13/600 in status colour). Out of stock = "Habis" (danger), disabled. Gift = price "Gratis" in reward |
| Cart line | name aligned left (tags after the name, never before), qty pill 36×36 radius 12 (slot kept even when empty), amount column 112px right-aligned, "@ Rp…" only when qty > 1 |
| Status tags | 22h, radius 6, 12/700, tint bg + colour; StatusBadge in BO adds a 6px dot |
| Notices | 10/14 padding, radius 12, tint bg, dot + text; inside panels, above the primary bar |
| Switch (BO) | 44×26, on = #8f6412 |

## States and interactions
| Element | State | Behaviour |
|---|---|---|
| Tile, buttons, rows, bar | Pressed | scale .965 / .96 / .985, 160ms |
| Tile | Tap | adds line (slides in from -8px, 300ms) + toast "Ditambahkan · {name}" above the grid, 1.6s |
| Out-of-stock tile | Disabled | no press, no add |
| Selector | Change | thumb translateX, 380ms |
| BO edit form | Error | field border 2px danger + 12px message under the field + summary notice at top. Never an alert |
| BO forms/settings | Dirty | "Perubahan belum disimpan" (warn) in the footer/sticky bar; changed rows tinted warn-bg with "Sebelumnya …" |
| BO navigation with dirty state | Leave | ConfirmDialog (BO4): Buang perubahan (danger text) / Tetap di sini / Simpan & lanjut (primary) + beforeunload |

## Animation / motion
Motion only on state change, only transform/opacity.
| Preset | Easing | Durations (selector / enter / press / toast) |
|---|---|---|
| Pegas (default) | cubic-bezier(.32,.72,0,1); toast cubic-bezier(.34,1.56,.64,1) | 380 / 300 / 160 / 340 ms |
| Halus | cubic-bezier(.2,0,0,1) | 200 / 180 / 120 / 180 ms |
Respect prefers-reduced-motion (and the OS "remove animations" setting): no motion.

## Responsive
Cashier: fixed tablet layout 1280×800dp landscape (catalog 788 + panel 456, 12dp gutters).
Backoffice: fluid. Sidebar 248 + content; below ~820px the sidebar stacks above content; tables scroll inside their card.

## Accessibility
Real buttons/links/inputs; icon-only buttons have aria-labels; selectors use role=tab/aria-selected or aria-pressed;
switches role=switch + aria-checked; dialogs role=dialog/alertdialog + aria-modal + labelled; errors aria-invalid.
Colour is never the only signal: every status has a word.

## Out of scope / do not change
Business logic, sync/offline behaviour, data models, copy meaning, navigation structure.
Sample data in the mocks (products, prices, SKUs, counts) is illustrative.


## Claude Code Execution Playbook (File-by-File Implementation Order)

Execute these 4 phases in order so data/logic bugs and systemic layout primitives are fixed at the root before screen-level restyling:

### Phase 1 — Cross-System Data, Validation & Sync Integrity (P1 Bugs)
1. **Stok Opname Outlet Scope Fix (`CS-1` / `#29`)**:
   - `apps/backoffice/src/screens/StockCount.tsx:84, 144-189, 241`: Move `productCatalogue.get({ force: true })` (`line 144`) *after* `authStore.outletId = locId` (`line 145`). Add a `withScope(sc.outletId, () => ...)` wrapper around `start(sc)` (`line 178`), `cancel(sc)` (`line 189`), `saveLine` (`line 84`), `complete` (`line 241`), and `submitFor` so `X-Outlet-Id` is always sent when the header scope is `"Semua outlet"`. Update the create dialog text to show both product and variant counts (`{products.length} produk ({variantCount} varian aktif)`), block creating a second open opname at the same location, and sort newest first.
2. **Promotion, Discount Code & Manual Discount Validation (`CS-2` / `#4, #10a, P-17`)**:
   - `apps/backoffice/src/screens/promotions/promotionForm.ts:132-144`: Reject `form.value <= 0`, `form.type === 'percentage' && form.value > 100`, and `form.endDate < form.startDate`.
   - `apps/backoffice/src/screens/promotions/discountCodeForm.ts:38-41`: Reject `form.value <= 0` and `form.type === 'percentage' && form.value > 100`. Pass `errorSummary={err}` to `<SlideOver>` in `CodeFormSlideOver.tsx`.
   - `backend/internal/write/promotion.go:158-174` & `backend/internal/write/discount_code.go:29-43`: Enforce `Value > 0` and `percentage <= 100` server-side.
   - `apps/pos/src/hooks/useCart.ts:110-114` & `ManualDiscountSection.tsx`: Cap manual percentage discount at `100%` and nominal discount at `subtotal`.
   - `apps/pos/src/cashier/pricing.ts:373-383` & `Cart.tsx:329-349`: Clamp `promoDiscountAmount` to `discountAmount` so cart discount rows never exceed the payable subtotal, and change `<Tag tone="promo">PROMO</Tag>` on manual discounts (`Cart.tsx:336`) to neutral `"Diskon manual"`.
3. **Shift Recap Net Sales, Blind Count & Payment Method Reconciliation (`CS-3, CS-4` / `P-14, P-15, P-16`)**:
   - `apps/pos/src/cashier/recapAggregate.ts:93`: Change `b.net = b.gross - b.discount` to `b.net = b.gross - b.discount - b.refundTotal`.
   - `apps/pos/src/cashier/ShiftRecapPanel.tsx:497-506`: Include payment methods where `pm.isEnabled || (cur.byMethod[pm.id] ?? 0) > 0` plus any unmapped keys in `cur.byMethod` so `Total Tercatat` always equals the sum of listed rows.
   - `apps/pos/src/cashier/ShiftRecapPanel.tsx:529` & `CashierScreen.tsx:145`: Never put `String(recorded)` into the `Terhitung` input `placeholder` (`placeholder="0"` always); default `blindCount` to `true`.
   - `apps/pos/src/cashier/ShiftRecapPanel.tsx:323-342`: Require a `ConfirmDialog` (and reason note when `diffTotal !== 0`) before calling `onCloseShift` (see `screens/W6-ShiftRecap.dc.html`).
4. **Customer & User Form Hardening (`CS-6` / `#2, #3, #9, #11, P-22`)**:
   - `apps/backoffice/src/screens/users/AddUserModal.tsx:46-51`: Add `autoComplete="off"` on email and `autoComplete="new-password"` on password.
   - `apps/backoffice/src/shell/LoginScreen.tsx:10`: Clear pre-filled `admin@mandalika.local` default state to `''`.
   - `apps/backoffice/src/screens/customers/customerForm.ts:44-45` & `CustomerFormSlideOver.tsx:53`: Validate phone (`9–15` digits, normalized `08`/`62`) and email format; move error banner to `<SlideOver errorSummary={err}>`.
   - `apps/pos/src/cashier/CustomerPicker.tsx:60`: Hide internal `c.segment` badge from cashier search results and format loyalty points with `id-ID` thousand separators.

### Phase 2 — Systemic Back Office UI Kit & Layout Fixes (`V-1` to `V-5`)
1. **Single Page Scroll (`apps/backoffice/src/ui/DataTable.tsx:213`)**: Remove `max-h-[70vh]` and vertical `overflow-auto`; use `overflow-x-auto` so tables grow naturally with the page and only scroll horizontally when needed.
2. **Distinct Sidebar Icons (`apps/backoffice/src/lib/router/routes.ts:171, 182`)**: Keep `ClipboardCheck` for `approvals` (*Persetujuan Stok*) and use `RefreshCw` / `CloudAlert` for `syncReview` (*Tinjauan Sinkron*), plus add a red badge on `Integrasi ERP` when `dead > 0`.
3. **Payment Method Label Normalization (`apps/backoffice/src/screens/dashboard/metrics.ts:397-406` & `settings/TransaksiSection.tsx:91-99`)**: Normalize `cash`/`tunai` → `"Tunai"`, `bca` → `"BCA"`, `bri` → `"BRI"`, `qris` → `"QRIS"` before grouping chart/report series; fix `TransaksiSection.tsx:96` switch labels to `"Masuk laci kas"` and `"Aktif"`.
4. **Dashboard Trend & Y-Axis (`apps/backoffice/src/screens/dashboard/metrics.ts:200` & `Charts.tsx:24, 48`)**: Return `null` from `delta(cur, prev)` when `cur === 0 || prev <= 0`; format Y-axis values `>= 1_000_000` as `"Rp Xjt"` with `width={68}`.
5. **Inventory Totals, Kartu Stok Full-Width Bar & Bahan Formatting (`OverviewMatrix.tsx:68`, `StockCard.tsx:160`, `IngredientOverviewMatrix.tsx`, `PenyesuaianTab.tsx`, `StokMasukTab.tsx`, `OpnameTab.tsx`)**: Follow `screens/BO6-InventoriOpname.dc.html`.

### Phase 3 — Cashier POS Layout & Flow Polish (`W1`–`W7`)
1. **Always-Mounted Cart + LocalStorage Persistence (`CashierScreen.tsx:1237` & `cashierReducer.ts`)**: Keep the right cart column mounted at all times on tablet/desktop with the `W1-Kaca` empty state, and persist open cart state to `localStorage`.
2. **2-Line Product & Cart Names + Live Remaining Stock (`ProductGrid.tsx` & `Cart.tsx:215`)**: Replace single-line `truncate` with `line-clamp-2` and deduct in-cart quantity from displayed tile stock (`Stok N` → `Sisa M`).
3. **Checkout Hierarchy (`CheckoutPanel.tsx`, `W2-Bayar.dc.html`)**: Place `Kembalian` in the sticky bottom confirmation bar area, style `Uang Pas` with the standard choice chip (`#8f6412` when selected, neutral otherwise), format the cash input with `id-ID` separators, and move `Sales (opsional)` below tender selection.
4. **Refund Dialog (`RefundDialog.tsx`, `W4-Refund.dc.html`)**: Replace `indigo-600` checkboxes with `--brandp`, add quick reason chips, put `Batal` on the left and `Refund Rp …` (`bar-danger`) on the right, and emit a toast on completion.
5. **Remove Remaining `indigo-*` and `orange-*` Classes**: Clean up `MenuDrawer.tsx`, `AdjustmentDrawer.tsx`, `TransferHistoryPanel.tsx`, `SettingsScreen.tsx`, and `ShiftRecapPanel.tsx` per `W6-ShiftRecap.dc.html` and `W7-MenuDanStok.dc.html`.

### Phase 4 — Kertas & Emas · Kaca Visual Tokens (`packages/ui-tokens/tokens.css`)
Apply the CSS variables and surface classes from `screens/Tokens.dc.html` (`--paper0: #fbf9f5`, `--paper1: #f3efe7`, `--paper2: #e9e3d8`, `--ink9: #1a1008`, `--brand: #b07d18`, `--brandp: #8f6412`, `.surf.top` with `backdrop-filter: blur(20px) saturate(180%)` on non-scrolling headers/sidebars/drawers only, and `.surf.panel` without blur on scrolling containers).
