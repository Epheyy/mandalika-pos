# Kertas & Emas · Kaca restyle: waves and slices

Date 2026-11-05 · base `prod-hardening` `d474f4fb` (live: backend `00163-deb`, backoffice `824a38aa`, POS OTA 2.6.0) · planner: Opus (plan only, no app code changed).

**Source.**
- The owner's polish spec, committed temporarily at `docs/design-kaca/`: (Removed in slice Z; read it with `git show 9e781db3:docs/design-kaca/<path>`.)
  - `HANDOFF.md`: tokens, materials, components, motion, and a 4-phase playbook;
  - `screens/*.dc.html`: 19 mockups;
  - `QA-FINDINGS.md`: the live QA run.
- The per-finding check against live code, done in side-session notes (`design-kaca-qa-verification.md`).
- The QA-fix wave A-E entries in `HANDOFF.md` (LIVE 2026-11-05).
- The earlier plans: `docs/plans/2026-10-27-pos-ux-direction.md` (Kertas & Emas, D-1..D-29) and `docs/plans/2026-11-02-fase-d-backoffice.md` (D-67..D-84).

**Conventions.**
- `BO/` = `apps/backoffice/src/`; `POS/` = `apps/pos/src/`.
- Line refs are on `d474f4fb`.
- QA IDs are the ones in `QA-FINDINGS.md`: `#n`, `P-n`, `V-n`, `M-n`, `N-n`, `CS-n`.
- New owner decisions continue the register at **D-85** (section 7). The parallel promo auto-apply plan (PR #70) numbers its decisions locally (1-10), so there is no collision.

**Owner rules (2026-11-05) override the spec wherever they conflict:**
1. No see-through dialogs, slide-overs, sheets, toasts or pop-ups. Anything with content to read is opaque. Glass blur is allowed only on non-scrolling chrome (header/top bar, sidebar, category bar), and it must not reduce readability.
2. The POS cart column keeps today's behaviour: it mounts once a product is added (`POS/cashier/CashierScreen.tsx:1254`). It is not always mounted. The spec's Phase 3 item 1 and the W1 mock are overruled.
3. No PIN or permission gates for manual discount or refund. The mocks' "PIN > 20 %" and refund PIN notices are dropped. The existing receive-transfer approver PIN (A08, `POS/cashier/receive/ReceiveApprovalModal.tsx`) is a different flow: P5 may restyle its visuals (its indigo lines must go for Z), but the PIN path and its behaviour stay exactly as they are.
4. No dark theme (D-12): no `dark:` variants, no `prefers-color-scheme` block.
5. `docs/design-kaca/` is deleted by the last slice (Z).
6. The spec's Gemini "phase" prompts are not run as written. This plan replaces its 4-phase playbook.

---

## 0. TL;DR

The Kaca pass is mostly a **token, material and kit change**. The P1/P2 bugs the spec bundled into "Phase 1" are already live from QA wave A-E, so this plan is visual and a11y work plus a short list of owner decisions.

**Already fixed (excluded from every slice; do not redo):**
- Promo/code value and date checks: form + server (CS-2, #4, #10a, #26).
- Opname outlet scope and the one-planned-opname rule (CS-1, #29).
- Role needs ≥ 1 permission (#27).
- Rekap Shift rows include methods holding money (P-16, CS-3); net minus refunds (CS-4); close confirm (P-15, confirm only); clamped "Hemat promo" (P-17); blind count ON (P-14).
- Stale-chunk reload + `no-cache` index (#1).
- New-user autofill and login prefill (#2, #11).
- Payment label map (#5).
- Inventory/Bahan visible totals (#6, CS-5); Bahan `id-ID` decimals (#7).
- Dashboard delta and axis (#8).
- Customer phone/email + duplicates (#3, #9, CS-6, P-22 segment/points).
- Customer header count (#10).
- Stok Minus dates + sticky bar (#16, #17).
- Tinjauan Sinkron icon (#23).
- Open cart persisted across reload (P-20).
- Earlier, or misdescribed by QA: manual-discount cap + label, per-line refund + reason chips, Kosongkan confirm, per-row payment switches, 2-line tile names.

| Wave | Slices (parallel inside a wave; disjoint files) | Sessions | Release |
|---|---|---|---|
| 1 | **K1** tokens + materials + per-brand `brand-strong` + POS imports `ui-tokens` + screenshot helper | 1 | Cloudflare (no visible change) + rides the next OTA (no visible change) |
| 2 | **K2** backoffice kit + shell (single scroll, heights, tabs, skip link, labels, one dialog/toast standard, shared Impor/Ekspor menu) · **K3** POS kit (`components/ui/*`, one sheet header and close control, a toast API with duration and precedence) | 2 | K2 Cloudflare; K3 rides the wave-3 OTA |
| 3 | **P1** catalogue tiles + category selector · **P2** Koneksi sheet + customer picker/profile + login + outlet screens · **P3** shift recap + denominations · **P4** refund + Riwayat + receipts · **P5** menu drawer + secondary POS sheets · **B1** Produk + Pengaturan · **B2** Ringkasan + Laporan · **B3** Inventori · **B4b** Pengguna + ops/system | 9 | B* Cloudflare; P1-P5 (+ K3) one batched POS OTA |
| 4 | **P6a** cart + header (after promo S4 and the A9 probe) · **P6b** Bayar · **P7** discount sheets (after promo S4) · **B4a** Pelanggan + Promosi (after promo S2; may move into wave 3 if S2 is merged by then) | 4 | B4a Cloudflare; P6/P7 one batched POS OTA |
| 5 | **Z** indigo/orange removal, legacy remap deletion, required `IconButton` labels, 3-brand screenshot sheet, delete `docs/design-kaca/` | 1 | Cloudflare + OTA |

No slice needs an APK (section 5.3). No slice changes the backend, OpenAPI, migrations or sync.

---

## 1. Token and material system

### 1.1 Tokens: the spec mapped onto `packages/ui-tokens/tokens.css`

Today:
- `packages/ui-tokens/tokens.css:6-48` holds the Kertas & Emas tokens as a Tailwind v4 `@theme`.
- The backoffice imports it (`BO/index.css:2`).
- The POS still keeps its own copy (`POS/index.css:3-50`) plus the legacy `indigo-*` → gold remap (`POS/index.css:4-14`). It re-derives that remap per brand at runtime (`POS/brand/apply.ts:24-41`).
- The spec's colours are already the same values as the tokens.

| Spec name | Existing token | Action |
|---|---|---|
| `paper0/1/2`, `ink9/7/5` | `--color-paper-0/1/2`, `--color-ink-900/700/500` | none (identical) |
| `brand` `#b07d18` | `--color-brand` (skinned at runtime) | none |
| `brandp` `#8f6412` | `--color-brand-pressed` / `--color-brand-strong` | use `brand-strong` for small text on gold and filled controls (D-73) |
| status `ok/warn/danger/info/promo/reward` + bg | same names | none. **Semantic colours never change per brand.** The only per-brand swaps stay the ones the owner already decided: Flamboyan `promo`→blue, `info`→slate (D-27); Performance solid danger → `ink-900` (D-28). Kaca adds none. |
| radius 24 / 16 / 12 / 6 / full | `--radius-control` 12, `--radius-sheet` 16, `--radius-chip` 22 | add `--radius-panel: 24px`, `--radius-tag: 6px`; keep `chip` 22 for pills |
| `bar-primary` gradient `#a8771a → #93670f` | none | add `--bar-primary-top: color-mix(in srgb, var(--color-brand) 88%, var(--color-brand-strong))` and `--bar-primary-bottom: var(--color-brand-strong)` + the inset highlight. Derived from the skin, so Flamboyan/Performance get their own bar without new hex values (D-99). |
| `bar-danger` `#c22a1d → #a51f14` | `--color-danger-solid` | gradient from `--color-danger-solid`, so the Performance skin's ink-900 rule (D-28) still applies |
| type scale 12 / 13 / 15 / 17 / 22 / 26 + 14 buttons + 16-17 prices + 20 bar label | none (ad-hoc `text-[…]`) | add `--text-*` steps; slices replace ad-hoc sizes on the screens they touch (V-9) |
| motion `--e`, `--pop`, `--d-*` | none | add the Pegas set (section 4) |
| glass, panel, card, group, ambient | none | `materials.css` utilities (1.2) |

Notes:
- **Per-brand `brand-strong` (K1).**
  - Today POS `applyBrand` (`POS/brand/apply.ts:24-41`) sets only `--color-brand` and `--color-brand-pressed`, and the POS `Brand` type has no strong colour (`POS/brand/brands.ts:33-34`).
  - Once the POS imports `ui-tokens`, `--color-brand-strong` would stay Mandalika `#8f6412` (`tokens.css:19`) on every skin. Every `brand-strong` control and the bar gradient would then be gold on a Flamboyan or Performance tablet.
  - K1 owns `POS/brand/{apply,brands}.ts` and sets `--color-brand-strong` and `--color-brand-strong-hover` per brand, the way `BO/lib/brand.ts:137-139` already does. Flamboyan and Performance pass AA with white, so their strong colour = their brand (D-73).
- **POS imports `ui-tokens` in K1** (the D-76 chore). Its duplicate `@theme` block goes; the `indigo-*` remap and `apply.ts` `INDIGO_STEPS` stay until slice Z. About 102 indigo/orange lines across 18 POS files still use them (114 in 20 counting tests). Each screen slice converts its own files to token classes, and Z deletes the remap once the grep is zero. The backoffice has `BO/ui/chartColors.ts` (owned by B2) and the `primary: 'indigo'` skin key in `BO/lib/brand.ts:110` (owned by Z).
- **Contrast stays as decided:**
  - white on `brand` only for text ≥ 18.66 px bold (bars, 20/26 px labels);
  - filled small controls use `brand-strong` (5.3:1);
  - `ink-500` only on paper-0/white.
- **Fonts.**
  - No Google Fonts link (the mocks have one). The browser gate aborts external fonts, and the POS is offline-first.
  - The backoffice already self-hosts Roboto Variable (`BO/index.css:4-13`).
  - The POS uses Android's system Roboto, which has 400/500/700 but no true 600. A `font-semibold` (204 POS uses) renders as 700 on the tablet but 600 in desktop screenshots. See D-88.
  - The shared `--font-sans` starts with `'Roboto Variable'` (`tokens.css:47`); the POS copy starts with `Roboto`. The POS ships no Roboto Variable file, so K1 keeps a POS override `--font-sans: Roboto, …` after the import. The K1 identity check then holds.

### 1.2 Materials under owner rule 1

The spec's material table puts glass on dialogs, slide-overs and the save bar, the cart panel is 88 % alpha, and tiles default to a 60 % "Kaca" card. All of that conflicts with rule 1. Restated:

| Material | Spec value | Used on (this plan) | Why it stays readable |
|---|---|---|---|
| **Glass-static** (default chrome) | `rgba(255,253,249,.72)`, 1 px white border, the spec's 3-layer shadow, **no `backdrop-filter`** | POS header and category bar; BO top bar; BO sidebar while docked (`lg:`) | **Nothing scrolls under any chrome in either app today:** the POS header is its own row (`CashierScreen.tsx:1139`), the BO top bar sits outside `<main>` (`BO/App.tsx:60-61`), and the sidebar sits beside it. Under that chrome there is only the static ambient, so a blur would show nothing visible and cost GPU time. Text is ink-900/700 on near-white (≥ 12:1). |
| **Glass** (real blur) | the same + `backdrop-filter: blur(20px) saturate(180%)` | only on chrome that content scrolls under: the POS header/category band if D-85 picks scroll-under, the BO top bar if D-86 does | α .72 (not the spec's .56), so content passing underneath can't pull hint text below 4.5:1. Needs the A9 probe (5.2) on the POS. |
| **Solid drawer** | `#fffdf9` opaque | BO sidebar below `lg`, when it is an overlay drawer (`BO/shell/Sidebar.tsx:40,46`), and the POS menu drawer | A drawer over content is a pop-up under rule 1, so it must be opaque. |
| **Solid panel** | `#fffdf9` (paper-0 lifted), same border/shadow, opaque | cart column, every POS `Sheet`, `ConfirmDialog`, BO `SlideOver`, `ConfirmDialog`, `Modal`, sticky save bar, menu drawer, POS/BO toasts (ink-900 solid, white text) | Opaque by rule 1. Scrims stay plain `rgba(26,16,8,.30-.40)`, no blur. `BO/ui/Modal.tsx:74` drops `backdrop-blur-sm` (D-110). |
| **Card** | the spec's Solid variant `#fff`, 1 px paper-2, inset top highlight, no shadow | product tiles, list rows, table cards, keypad keys | Solid default. The 60 % "Kaca" card is not used: tiles sit inside a scroller (perf rule) and must read the same over any ambient. |
| **Group** | `rgba(255,255,255,.62)` | summaries, customer chip, FilterBar, info blocks | Only ever placed on a solid panel or card, so it composites to a fixed colour. K1 defines it as a solid `color-mix` of white and paper-0 so it can't turn translucent by accident. |
| **Ambient** | 4 radial gold/peach gradients | page ground, both apps | One fixed, non-scrolling layer (`position: fixed; inset: 0; z-index: -1`; never `background-attachment: fixed`, which repaints on Android). Tint per brand: see D-87. |

The **blur budget** is in section 5.1.

---

## 2. Systemic backoffice fixes (slice K2)

All in `BO/ui/*`, `BO/App.tsx` and `BO/shell/*`, so one slice fixes every page.

1. **Single page scroll (V-1, #35, N-8).**
   - Today `BO/ui/DataTable.tsx:219` wraps every table in `overflow-auto max-h-[70vh]`. `stickyHeader` defaults to true, and none of the 22 files that use DataTable turns it off. `BO/App.tsx:61` `<main class="overflow-y-auto">` is the page scroller.
   - **Pitfall:** just switching the wrapper to `overflow-x-auto` still makes it a scroll container. `position: sticky` on `th` then sticks to the wrapper, not to `<main>`, so the header silently stops sticking.
   - **Rule:**
     - The wrapper is `overflow-x: clip` (not a scroll container) while the table fits. `th` is `sticky top-0` against `<main>`; the top bar sits outside `<main>`, so `top: 0` is right.
     - A `ResizeObserver` hook in DataTable (`useHorizontalOverflow`) switches the wrapper to `overflow-x: auto` with **no sticky header** once `scrollWidth > clientWidth`. Kartu Stok (13 columns), wide matrices, and anything at 768/375 then scroll sideways inside their card.
     - No per-table prop, so no screen file is touched.
   - **Two more traps:**
     - The DataTable root (`DataTable.tsx:182`) is `overflow-hidden` for its rounded corners. That also makes it a scroll container, so `th` would stick to it. K2 changes it to `overflow-clip`: corners still clip, and it is not a scroll container. `overflow-x: clip` with `overflow-y: visible` is valid, and sticky `thead th` works in Chromium 91+.
     - Under `border-collapse`, a sticky `th` loses its bottom border; draw it with a `box-shadow` instead.
   - **The overflow hook:**
     - It watches the `<table>` as well as the wrapper; data loads and column toggles change the table, not the wrapper.
     - It compares `table.offsetWidth` with `wrapper.clientWidth`.
     - The kit test needs a `ResizeObserver` stub in jsdom.
   - **Not covered:** screens that wrap their own tables in `Card … overflow-hidden` (`BO/screens/Orders.tsx:232`, `BO/screens/Customers.tsx:488`). Their owning slices (B2, B4a) remove that wrapper's clipping the same way.
   - Also: `scrollbar-gutter: stable` on `<main>` (P3 "layout jumps").
   - The sidebar keeps its own scroll only when it is taller than the window.
   - Other nested boxes are fixed in the slice that owns the file. For example, the `max-h-96 overflow-y-auto` in `BO/screens/ingredients/OpnameTab.tsx:51` (N-3) goes in B3.
   - The browser gate has **no** scenario using `scrollTop`, `scrollIntoView`, `70vh` or `max-h` (grep over `tests/browser`), so nothing depends on the inner box.
2. **Control heights (V-2, V-4, #32).** One scale:
   - header actions, inputs, selects and chips: 40 px;
   - pagination controls and row icon buttons: 36 px;
   - the spec's 44 is kept for POS-like touch surfaces only (D-89).
   - `BO/ui/Button.tsx:17-18` gets explicit heights instead of padding-derived ones.
   - Today's height classes in screens (h-7 ×4, h-8 ×5, h-9 ×2) are left to their owning B-slice.
3. **Filter labels (V-3).**
   - `FilterBar` (`BO/ui/FilterBar.tsx`) uses one rule: no labels stacked above controls.
   - Selects show an inline prefix ("Kategori: Semua"), and the accessible name comes from `aria-label`.
   - Chip groups keep `role="group"` + `aria-pressed` (scenarios read `aria-pressed`, e.g. `backoffice-back-scenarios.ts:64`).
   - Sentence case, 13 px.
4. **Pagination (V-4, #24).**
   - `BO/ui/Pagination.tsx`: prev/next + "Menampilkan 1–25 dari N" + a 36 px "Baris" select. Numbered pages are not added.
   - One default page size of 25. ErrorLogs and ERP change from 50 (D-104); `?per=` in the URL still works.
5. **Tab semantics (P3 tabs, a11y).**
   - `BO/ui/Tabs.tsx` becomes `role="tablist"` / `role="tab"` + `aria-selected`, with roving tabindex and ←/→/Home/End.
   - No `aria-controls`: it would need `role="tabpanel"` ids in the 11 screens that use `Tabs`, which K2 doesn't own.
   - The selected thumb is white on a 5 % ink track (spec selector). Tab widths no longer shift: `tabular-nums` and no bold swap on selection.
   - **Gate impact:**
     - Scenarios find tabs by `data-tab-key` (`tests/browser/fixture.ts:104`, `backoffice-d5a-scenarios.ts:86`) and read `aria-pressed` on them (`backoffice-route-scenarios.ts:67`, `:120`). K2 keeps `data-tab-key` and `data-dirty`, and moves the `pressed()` helper and the `:120` wait to `aria-selected`.
     - Any scenario that clicks a tab as `getByRole('button', { name })` (about 506 button-role calls overall) is grepped against the `Tabs` labels and moved to `'tab'` in the same PR.
     - FilterBar chips stay buttons with `aria-pressed`.
6. **Skip link (#30 nav, P3 a11y).**
   - "Lewati ke konten" is the first focusable element in `BO/App.tsx`. It is visible on focus and moves focus to `<main id="konten" tabIndex={-1}>`.
   - No scenario presses Tab (grep), so the new first focusable breaks nothing.
7. **Icon-button labels (V-5, P3 a11y, N-4).**
   - `BO/ui/IconButton.tsx` gets a `label` prop, rendered as `aria-label` + `title`, with a 36 px target.
   - It starts **optional**: making it required at once would fail typecheck at 29 call sites in screens K2 doesn't own. Each B-slice fills in its call sites, and Z makes it required.
   - B-slices also convert raw icon buttons in their own screens (e.g. `RecipeSlideOver` ×, N-4, in B1).
   - The ERP lock reason is shown once, as the `title` of the disabled control (V-5, #19), in B1.
8. **One dialog / slide-over / toast standard (P3 forms, confirms, #22).**
   - `SlideOver` (create/edit), `ConfirmDialog` (confirm, always names the item, danger token, Batal left / action right) and `Toast` (ink-900 solid, bottom-centre, `role="status"`, optional "Urungkan" where the action already supports undo) all get the solid material.
   - Remaining centred-modal forms move to `SlideOver` in their B-slice:
     - `users/AddUserModal.tsx` and `RoleModal.tsx` in B4b;
     - the Transfer Terima large modal in B3.
   - `Modal`'s literal `z-50` stays; scenarios rely on it.
   - Toasts are added only where an action today gives **no** feedback (#22): Tandai sudah dicek (B2), loyalty save (B4a), transfer receive (B3), user save (B4b). Feedback only; no new undo.
9. **Badges.**
   - `BO/ui/Badge.tsx:4-12` uses Tailwind defaults (gold-50, green-50…); it moves to tokens.
   - Role tags become neutral (#21; done in B4b at the call site `users/userColumns.tsx:60`).
   - "Dibatalkan" becomes neutral; gold is never a status (P3 status colours).
10. **Shared Impor/Ekspor menu (M-4, D-99).** K2 builds one `ImportExportMenu` in `BO/ui/` (next to `ExportButton.tsx`) and owns `BO/components/ImportDialog.tsx`. B1, B3 and B4a only swap their three header buttons for it, so the menu isn't built three times.
11. **Shell chrome.**
    - The top bar (`BO/shell/Header.tsx`) gets glass-static.
    - The sidebar (`BO/shell/Sidebar.tsx`) gets glass-static while docked (`lg:`), and the solid drawer material with a scrim below `lg` (#25 scrim). The ambient goes behind `App`. The top-bar outlet select becomes 40 px (V-2). The sidebar logo gets a legible size (P3).
12. **Login.** `BO/shell/LoginScreen.tsx`: white on `brand` fails AA (P3 a11y), so the button uses `brand-strong`; `type="email"`; visible labels, not placeholder-only. Keep the wave-B "no prefill". K2 owns auth UI here, hence the Opus review.

### 2b. POS kit (slice K3)

The POS screens share `POS/components/ui/*`. These must change once, before the screen slices; otherwise five wave-3 slices would each depend on another's half-finished `Sheet`.

1. **One sheet header (M-12).**
   - `Sheet` gets one close control in one place: top-left "‹ Kembali" or a top-right ×, decided once.
   - Its accessible name is frozen (`closeLabel`, default "Tutup") so scenarios keep finding it.
   - The 20+ sheet consumers get it for free; Bayar (P6b) and Koneksi (P2) drop their own extra close buttons.
2. **Primitives:** `Button`, `Chip` (choice chip: `brand-strong` fill when selected), `StatusBadge`, `ConfirmDialog` (Batal left, action right), `Banner` (notice: tint bg + dot + word), `Money`, `Stepper`, `tone` restyled on the K1 tokens. Same props.
3. **Toast API.**
   - Today the only toast is local state in `CashierScreen.tsx:244-247`, markup at `:1543`. It is fixed at 3000 ms, never clears the previous timer (a later toast gets cut short), and any message overwrites any other.
   - K3 adds `POS/components/ui/Toast.tsx`: a provider + `useToast()` with `duration`, a timer reset on every show, and precedence (a warning such as `OVERSELL_WARNING` is never replaced by an info toast like "Ditambahkan").
   - The provider is mounted in `POS/App.tsx`. P6a moves `CashierScreen`'s `showToast` onto it; P4's refund toast calls `useToast()` directly.
   - Existing messages and their scenarios stay as they are, e.g. "2 item ditambahkan ke keranjang" asserted at `tests/browser/pos-scenarios.ts:498`.

---

## 3. Screen restyles

Each row: what changes and its QA IDs.
- "Look" = presentation only.
- "Fb" = feedback-only addition (toast, label).
- Anything that changes behaviour is a decision in section 7, not in the slice.

### 3.1 POS (W1-W7), 1280×800 landscape

| Screen | Slice | Changes | QA IDs |
|---|---|---|---|
| W1 tiles + category bar | P1 | Look: tile per spec (150 h, 56 thumb, name 15/600 2-line, price 16/700, stock dot + word in status colour, "Habis" disabled, gift "Gratis" in reward). Category selector = white sliding thumb (transform only), `role="tablist"`. Loading skeleton matches the real tile shape. Horizontal category scrollbar hidden behind a fade edge. | P-2 (tiles), P3 skeleton, P3 category scrollbar, N-5 (`ProductGrid`) |
| W1 header | P6a | Look: glass-static header (D-85), 44 px controls, brand + outlet, shift pill, Koneksi pill, menu icon with `aria-label`. **Tutup Shift stays in the header** (P-8 is the owner's) but turns neutral secondary instead of red; red only in its confirm (D-98). | V-11 (targets), P-8 (colour only) |
| W1 cart column | P6a | Look: solid panel, "Pesanan" title + count, cart line per spec (name left, 2 lines; tags after the name; 36×36 qty pill, slot kept; 112 px right-aligned amount; "@ Rp…" only when qty > 1), action row, gradient Bayar bar. **Mount behaviour unchanged** (rule 2). Fb: "Ditambahkan · {nama}" toast on a successful add (D-93), through K3's toast API (1.6 s, never over a warning). P6a also owns the header parts of `ShiftBar.tsx` (shift pill, Tutup Shift at `:106`) and `SyncStatus.tsx` (the Koneksi pill); P2 and P3 have finished with those files by then. | P-2/V-10 (cart names), P-11 |
| W2 Bayar | P6b | Look/layout inside the sheet: one close control (P-10, M-12 for Bayar). Order method → amount → keypad → change, with "Sales (opsional)" as a small row near the confirm (V-8). **Kembalian in the sticky bar** next to Konfirmasi (P-5). Cash input formatted `id-ID` per D-113: this changes money entry, so it is a decision, not a look. If yes: `inputMode="numeric"` text + a pure parser with unit tests, replacing `type=number`. That changes the role from spinbutton to textbox, so `pos-scenarios.ts:189` (`getByRole('spinbutton', { name: 'Jumlah dibayar' })`) moves to `'textbox'`. (P-9) "Uang pas" uses the standard choice chip, selected by default when untouched (P-9, P3 blue chip). Total shown once in the header and on the confirm; summary rows stay visible but compact (D-92). No all-caps (P3). Type scale (V-9). | P-5, P-9, P-10, V-7 (D-92), V-8, V-9, M-12 (Bayar part) |
| W3 customer picker | P2 | Look: 48 px result rows (P-22), offline notice as a warn notice box, "Pilih ›" kept. | P-22 (rows) |
| W3b profile | P2 | Look: stats, tags, footer per mock. Mock-only "Ubah" / "Semua riwayat" / "+ Tambah catatan" are **not** built (D-95). | - |
| W4 refund | P4 | Look: opaque dialog, checkboxes `brand-strong` (N-1), **Batal left, "Refund Rp …" right** in the danger bar (P-18, N-1). Fb: success toast with the refund number after a confirmed refund, via K3's `useToast()` (P-18). Reason chips: keep today's list (D-94). No PIN (rule 3); no restock choice (D-95). | P-18 (order, toast), N-1 |
| W4 Riwayat | P4 | Look: `OrderHistoryPanel` rows + filters; one `id-ID` date/time format; payment label via the shared map (P-23). | P-23 |
| W5 Koneksi | P2 | Look: W5 layout in `components/SyncStatus.tsx`. One back-control position, the same as every sheet (P-24/P-25, M-12). "Detail teknis" as a disclosure. Footer "Tidak ada yang perlu dilakukan" as plain text, not button-like. "Coba lagi" danger-outline. OTA/"Tertunda berulang" sections kept. | P-24, P-25, M-12 (Koneksi part) |
| W6 Rekap / Tutup Shift | P3 | Look: W6 visuals in `ShiftRecapPanel.tsx` (31 indigo/orange lines go). Money rows `tnum`, selisih in status colours with words, blind state unchanged. `DenominationSheet`: per-row subtotal (display), total pinned; "Reset" per D-97. The close-reason field is **not** added (D-96). The two known edge cases left by QA slice B are D-115 and D-116. | P-14/15/16 visuals (logic already live), N-5, N-6 (visual) |
| W7 menu + sheets | P5 | Look: `MenuDrawer` 44 px rows incl. "Back Office" and "Tutup" (V-11), orange/indigo out (N-5). `HeldOrdersSheet` hierarchy (Lanjutkan primary, Hapus danger text). `AdjustmentDrawer` (Catatan Order), `TransferHistoryPanel`, `receive/*` and `requisitions/*` restyled. **`ReceiveApprovalModal` is restyled (its 3 indigo lines go), but its A08 approver PIN path stays exactly as it is.** POS `SettingsScreen` switches use the token switch (N-5). Menu entries are **not** merged (M-11, D-99). | V-11, N-5, M-11 (deferred) |
| W7 discount sheets | P7 | Look: `PromoPanel`, `PromoSheet`, `ManualDiscountSection` (bright green/orange buttons → secondary + primary; P-24/P-25 manual-discount part), `BxgyRewardModal`, `BundleSlotPicker` (10 indigo lines). **After promo S4 lands** (it rewrites `PromoPanel` + `Cart`). No "PIN > 20 %" notice (rule 3). No Promo/Kode/Manual tab merge (M-10, D-99). | P-24/P-25 (discount colours), N-5 |
| Login | P2 | Look: gold `brand-strong` button (P3 orange login button), password placeholder "Kata sandi" (P-6), the "30+ Outlet aktif" stat removed (P-7, D-112). In `POS/App.tsx`. | P-6, P-7, P3 login |

### 3.2 Backoffice (BO1-BO8)

| Screen | Slice | Changes | QA IDs |
|---|---|---|---|
| BO1/BO2 Produk + edit | B1 | Look: table on the K2 kit. Row switch + state word only, source as a small neutral tag (M-8 product part, D-99). ERP lock reason as `title` on the disabled controls (#19, V-5). Icon buttons labelled. Category delete confirm names the product count (#28; per D-114). `RecipeSlideOver` raw grey/amber → tokens, labelled 36 px delete (N-4). Truncated hints → tooltip (V-5). Harga/Stok columns per D-102. | #19, #28, V-5, M-8, N-4 |
| BO3/BO4 Pengaturan | B1 | Look: section tabs on `Tabs`, solid sticky save bar. Leave dialog buttons in one row (wider dialog) and **lists the changed sections** from the `changes` array it already has (#15). Payment-method rows get the column headers "Masuk laci kas" / "Aktif" (#18). | #15, #18 |
| BO5 Ringkasan | B2 | Look: KPI cards; payment donut on a categorical palette instead of gold shades (`ui/chartColors.ts`, the last backoffice indigo line); top/bottom product cards stop stretching to the Barang Habis height. | P3 Ringkasan |
| BO5 Laporan | B2 | Look: tab bar on `Tabs` (no width shift), Export button no longer wraps alone (P3), one default date range is D-108. Fb: toast on "Tandai sudah dicek" (#22). The Unduh-data tab merge is M-1 (D-99). | #22 (part), P3 Laporan |
| BO6 Kartu Stok | B3 | Layout: the left `SkuRail` (`inventory/StockCard.tsx:160-167, 414-425`) is replaced by a full-width filter row: SKU combobox · Lokasi · Dari–Sampai · quick ranges · movement chips, with Unduh CSV in the page header (#31, #32). Labels on one baseline, 40 px controls. Movement chips are already real filters (FilterBar chips); group labels tidied, help text in an "Arti jenis gerakan" disclosure (#33). Single header row, 52 px rows, document numbers in the body font (#34). Table full width; K2's overflow hook gives it horizontal scroll when needed. | #31-#34, N-10 |
| BO6 Inventori others | B3 | Look: Stok Produk / Bahan matrices (totals already fixed). `OpnameTab` nested `max-h-96` scroll removed (N-3). In-progress "Selisih" label per D-111. "Tambah Bahan" uses the standard primary, category filter in the one filter row (#30 style part). Transfer receive: over-quantity in warn, not green (#13); "Terima paksa" label + secondary style (#14; its confirm is D-107). Transfer detail: one gold primary; Batalkan as danger text (P3 primary actions). Fb: toast after receive (#22). Bahan history tables are D-105. | #13, #14, #30 (style), N-3, #22 (part) |
| BO7 Pelanggan | B4a | Look: list + tabs on the kit. Pengingat pale chips → standard selected style (P3). Empty search says "Tidak ada yang cocok dengan '…'" (P3). Fixed table layout (P3 column jumps). Fb: toast on loyalty save (#22). | P3 Pelanggan, #22 (part) |
| BO7 Promosi | B4a | Look: tables on the kit; "Bisa Kombinasi" and category tags neutral, not gold (P3). **After promo S2** (it edits `PromoFormSlideOver`, `promotionForm`, `PromotionsTable`, `PromotionsTab`, `promoDisplay`). | P3 status colours |
| BO8 Pengguna | B4b | Look: neutral role tags (#21). `AddUserModal` / `RoleModal` → `SlideOver`, keeping #2's `autoComplete="off"` / `"new-password"`; scenarios that find these forms by the modal's literal `z-50` move to the slide-over's dialog role. Delete confirm names the role. Fb: save toast. The built-in roles list is D-106. | #21, #22 (part), P3 forms |
| BO8 Persetujuan / Permintaan / Sinkron / ERP / Log | B4b | Look: on the kit. ERP document codes `white-space: nowrap`, human message + "Detail teknis" disclosure for the raw error (#12 display part). ErrorLogs kind/message through the label map (#24). Sidebar ERP badge is D-103. Merging Sinkron + ERP + Log into one "Masalah" area is M-6 (D-99). The duplicate outlet select is M-5 (D-99). | #12 (display), #24 |

---

## 4. Motion

**Tokens** (K1, in `tokens.css`):

| Preset | `--ease-std` | `--ease-pop` | selector / enter / press / toast |
|---|---|---|---|
| **Pegas** (default, both apps) | `cubic-bezier(.32,.72,0,1)` | `cubic-bezier(.34,1.56,.64,1)` | 380 / 300 / 160 / 340 ms |
| **Halus** (fallback, D-109) | `cubic-bezier(.2,0,0,1)` | `cubic-bezier(.2,0,0,1)` | 200 / 180 / 120 / 180 ms |

**Rules:**
- Motion only on a state change.
- Animate only `transform` and `opacity`:
  - selector thumb `translateX`;
  - cart line enter `translateY(-8px)` + fade;
  - press `scale(.965 / .96 / .985)`;
  - toast fade + `translateY` + `scale(.9→1)`.
- Never animate width, height, top/left, margin, padding, border or font-size.
- The 25 existing `transition-all` uses are replaced in the slices that own them; `transition-all` animates layout properties.
- The existing `slideinright` / `backdropfade` keyframes (`POS/index.css:78,88`) are checked to be transform/opacity-only and kept.

**`prefers-reduced-motion: reduce`.** Today there is no handling anywhere (zero hits). K1 adds one global block in `tokens.css` that sets animation and transition durations to `0.01ms`; the mocks' "Mati" preset is the same thing. On Android, the OS "Remove animations" setting should reach the WebView as reduced motion. **Verify on the A9** during the section 5 probe; if it doesn't, Halus stays.

**Guard.** A unit test in K1 greps both apps' `src` for `transition-all` and `transition-[width|height|…]` with an allow-list, so later code can't reintroduce layout animation. The allow-list starts with today's 25 hits. Each slice deletes its entries and Z asserts the list is empty.

---

## 5. Performance

### 5.1 Blur budget

- **Default: zero blurred layers in both apps.** Nothing scrolls under any chrome today (1.2), so glass-static gives the look at no GPU cost.
- **If D-85 (POS) or D-86 (BO) picks a scroll-under layout:**
  - at most **2 blurred layers on screen at once** (POS: header + category bar, better one combined chrome band; BO: the top bar only);
  - each ≤ 20 px radius, `saturate(180%)`;
  - **never** inside a scroller, never on a sheet, drawer, toast or dialog (rule 1).
- **Fallback:** the material is chosen through a single root attribute, `data-material="glass|static|solid"` on `<html>`.
  - It is set in each app's entry (`POS/main.tsx`, `BO/main.tsx`, owned by K1) from one constant.
  - Falling back is a one-line change shipped as an OTA (POS) or a Cloudflare deploy (BO).
  - No user-facing setting, so no behaviour change.

### 5.2 Measurement on a real Galaxy Tab A9

- **Who:** the owner, on a tablet. No automated device lab exists.
- **When:** before P6a ships the header material, and only needed if D-85 = scroll-under (the default "No" needs no probe). It also checks the ambient layer, Pegas motion and the OS "Remove animations" setting.
- **How:**
  - A **throwaway probe build** made from the wave-3 POS code plus a probe-only patch (grid scrolling under a blurred header/category band, `data-material` switchable). The scroll-under layout and the glass header don't exist before P6a, so the patch is needed. It is never merged.
  - Installed via the "test APK build" already pending in HANDOFF, which doubles as the uuid/glob APK check.
  - Use `chrome://inspect` remote debugging; `webContentsDebuggingEnabled` is on (`apps/pos/capacitor.config.ts`).
  - Record a Performance trace with Rendering → Frame rendering stats on.
- **Scenario:**
  - test outlet, catalogue with **72 tiles**, cart column open (the worst width case);
  - three 10 s fling-scroll runs per material (`solid`, `static`, `glass`), toggled with `data-material` from the DevTools console;
  - plus one run of category-switch + add-to-cart with Pegas.
- **Pass:**
  - median **≥ 55 fps** during scroll;
  - **no frame > 50 ms** in steady scroll;
  - the add-to-cart response stays within today's feel.
- **If it fails:** `glass` on the POS is dropped for good (`static`). If `static` also misses, `solid` is used and the ambient layer turns off on the POS.
- The mock's "59-61 fps on the A9" is a claim in `Tokens.dc.html`, not a measurement in this repo; it is not used as evidence.

### 5.3 OTA or APK

Everything ships over the air (POS OTA) or via Cloudflare (backoffice):
- fonts: system Roboto on Android, vendored Roboto already in the backoffice;
- CSS, tokens, components, motion.

`capacitor.config.ts` is unchanged. Things that would need an APK, and are therefore **out of scope**:
- the splash background (`#1a1008`);
- the status/navigation bar colour;
- the launcher icon;
- WebView flags.

D-88's vendored-font option would add about 35 KB to each OTA bundle; still no APK.

---

## 6. Waves and slices

Common to every slice:
- **Brief** reset onto `origin/prod-hardening` first.
- **Implementer:** Sonnet `implementer`, medium.
- **Review tier** by what the slice touches:
  - **Opus `reviewer`, high (mandatory)** when it touches cart, pricing (incl. tax, rounding, promotions), payment/checkout settings, stock, refund, money totals, sync UI, auth or outlet scope, even for "look only" diffs;
  - otherwise the standard `code-reviewer` (Sonnet).
- **Owned files** are the only files a slice edits. Kit primitives belong to K1/K2/K3. A screen slice that needs a kit change asks for it; it does not edit the kit.
- **Shared test files.** Several slices in one wave edit the same file:
  - `tests/browser/pos-scenarios.ts`: P1, P2 and P4 in wave 3; P6a and P6b in wave 4;
  - `tests/browser/required-scenarios.json` (any new scenario id);
  - the motion-guard allow-list.

  These edits are line-local. **Merge order inside a wave = the table order**, and later slices rebase. The allow-list has one entry per file (path + count, no line numbers), so removals rarely conflict.
- **Tests:**
  - **Screenshots:** K1 adds a capture-to-artifacts helper, `tests/browser/shots.ts`.
    - It calls `page.setViewportSize` per shot: POS 1280×800 (+ 1280×667 for Bayar); backoffice 1440, 768, 375.
    - It saves PNGs under the gate's output dir for the reviewer.
    - **No new Playwright project.** Projects inherit `testMatch`, so every scenario would run twice, and `required-reporter.ts` fails on duplicate ids.
    - Not `toHaveScreenshot` baselines: font rendering differs between machines and the gate would flake.
    - New scenario ids are registered in `required-scenarios.json`.
  - **Browser-gate selectors:** each slice updates the scenarios its role/label changes break. A role change from button to tab, a renamed control, a new `aria-label`, a moved close control or spinbutton → textbox all change what `getByRole` finds.
  - **Unit:** vitest for any new pure helper.
- **Release:**
  - Backoffice slices → Cloudflare on merge (push to `prod-hardening`).
  - POS slices → batched into one OTA per wave (`make ota-release`), with the usual journal ACK. No Kaca slice touches the journal files.
  - **CI gate:** origin's GitHub Actions currently starts no jobs (billing, 2026-11-05). While that lasts, every slice PR gates on the `ci` mirror (`mandalika-ci/mandalika-pos-ci`), the same way the wave merges did (`gate/<name>` branches). Go back to origin CI when billing is restored.

| Slice | Wave | Owns (files) | Depends on | Model / review | Tests | Release |
|---|---|---|---|---|---|---|
| **K1** tokens + materials | 1 | `packages/ui-tokens/tokens.css`, new `packages/ui-tokens/materials.css`, `POS/index.css` (drop duplicate `@theme`, import shared, keep the `Roboto` font override and the indigo remap), `BO/index.css`, `POS/brand/{apply,brands}.ts` (per-brand `brand-strong`; `INDIGO_STEPS` stays), `POS/main.tsx` + `BO/main.tsx` (`data-material`, ambient element), new `tests/browser/shots.ts`, new motion-guard test + allow-list | - | Sonnet · standard review (Opus glance at `apply.ts`: skins) | computed-style identity on key POS elements before/after (D-76: no visible change); `brand.test.ts` extended for `brand-strong` per skin; motion guard; gate green | Cloudflare (no visible change) + next OTA |
| **K2** BO kit + shell | 2 | `BO/ui/*` except `chartColors.ts`; new `BO/ui/ImportExportMenu.tsx`; `BO/components/ImportDialog.tsx`; `BO/App.tsx`; `BO/shell/*` except `navBadgeModel.ts`; `BO/ui/kit.test.tsx`; `tests/browser/fixture.ts` (`pressed()` helper); tab-selector edits in `tests/browser/backoffice-*.ts` | K1 | Sonnet · **Opus** (login + user menu = auth; header outlet select = outlet scope) + a11y pass | kit tests: tabs keyboard + `aria-selected`, overflow hook (ResizeObserver stub), skip link, sticky `th` stays in view while `<main>` scrolls; screenshots 1440/768/375 of Produk, Kartu Stok, Pengaturan; one scroll area per page asserted | Cloudflare |
| **K3** POS kit | 2 | `POS/components/ui/*` (incl. new `Toast.tsx`), `POS/App.tsx` (toast provider mount only) | K1 | Sonnet · standard review | `components/ui/*.test.tsx` updated; toast precedence + timer unit tests; screenshots of `Sheet` / `ConfirmDialog` / `Banner` | rides the wave-3 OTA |
| **P1** catalogue | 3 | `POS/cashier/ProductGrid.tsx`, `VariantSheet.tsx`, `POS/components/Skeleton.tsx` | K3 | Sonnet · **Opus** (tile stock display) | `pos-scenarios` selectors; screenshots 1280×800 with and without cart | OTA wave 3 |
| **P2** Koneksi + customer + login | 3 | `POS/components/SyncStatus.tsx` (sheet body; the header pill is P6a's), `QueueGuardLine.tsx`, `POS/cashier/CustomerPicker.tsx`, `CustomerChip.tsx`, `CustomerProfileSheet.tsx`, `POS/App.tsx` (login block only), `POS/screens/OutletPickScreen.tsx`, `OutletMismatchScreen.tsx`, `TerminalSection.tsx` | K3 | Sonnet · **Opus** (sync + auth + outlet binding) | existing tests; screenshots | OTA wave 3 |
| **P3** shift recap | 3 | `POS/cashier/ShiftRecapPanel.tsx`, `DenominationSheet.tsx`, `ShiftBar.tsx` (open-shift modal only; the header pill and Tutup Shift button are P6a's) | K3 | Sonnet · **Opus** (money display) | recap tests unchanged and green; screenshots incl. blind + selisih confirm | OTA wave 3 |
| **P4** refund + Riwayat | 3 | `POS/cashier/RefundDialog.tsx`, `RefundAction.tsx`, `OrderHistoryPanel.tsx`, `LocalReceiptsPanel.tsx`, `ReceiptPreview.tsx`, `ReceiptTotals.tsx` | K3 | Sonnet · **Opus** (refund) | refund + history tests; `pos-scenarios` refund selectors (button order); screenshots | OTA wave 3 |
| **P5** menu + secondary sheets | 3 | `POS/cashier/MenuDrawer.tsx`, `HeldOrdersSheet.tsx`, `AdjustmentDrawer.tsx`, `TransferHistoryPanel.tsx`, `POS/cashier/receive/*`, `POS/cashier/requisitions/*`, `POS/cashier/transfers/*`, `POS/screens/SettingsScreen.tsx` | K3 | Sonnet · **Opus** (stock: receive/requisition; the A08 PIN path must stay) | `pos-requisition-scenarios`; `MenuDrawer.brandFlag.test.tsx`; screenshots | OTA wave 3 |
| **B1** Produk + Pengaturan | 3 | `BO/screens/Products.tsx`, `BO/screens/products/*`, `BO/screens/recipes/*`, `BO/screens/SettingsScreen.tsx`, `BO/screens/settings/*` | K2 | Sonnet · **Opus** (payment-method + split-tender settings, tax/rounding, prices) | `backoffice-products`, `-settings`, `-catalogue`, `-split` selectors; screenshots ×3 widths | Cloudflare |
| **B2** Ringkasan + Laporan | 3 | `BO/screens/Dashboard.tsx`, `BO/screens/dashboard/*`, `BO/screens/Reports.tsx`, `BO/screens/reports/*`, `BO/screens/Orders.tsx`, `BO/screens/orders/*`, `BO/ui/chartColors.ts` | K2 | Sonnet · **Opus** (refund report + admin refund form, Stok Minus, shift money) | `backoffice-dashboard`, `-refund`, `-scenarios` (Laporan); screenshots | Cloudflare |
| **B3** Inventori | 3 | `BO/screens/inventory/*`, `BO/screens/ingredients/*`, `BO/screens/StockCount.tsx`, `BO/screens/stockcount/*`, `BO/screens/transfers/*`, `BO/screens/Warehouses.tsx`, `BO/screens/warehouses/*` | K2 | Sonnet · **Opus** (stock screens + opname outlet scope; check display-only) | `backoffice-stockcard`, `-bahan`, `-opname`, `-transfer`; screenshots | Cloudflare |
| **B4b** Pengguna + ops/system | 3 | `BO/screens/Users.tsx`, `BO/screens/users/*`, `BO/screens/approvals/*`, `BO/screens/requisitions/*`, `BO/screens/syncReview/*`, `BO/screens/integration/*`, `BO/screens/ErrorLogs.tsx`, `BO/lib/labels/*` (ErrorLogs map only), `BO/shell/navBadgeModel.ts` only if D-103 = yes | K2 | Sonnet · **Opus** (auth: users/roles; approvals PIN) | `backoffice-review`, `-d3c`, `-d5a`; screenshots | Cloudflare |
| **P6a** cart + header | 4 | `POS/cashier/Cart.tsx`, `LineSheet.tsx`, `POS/cashier/CashierScreen.tsx` (header + cart-column chrome; `showToast` → K3 toast; no state or mount change), header parts of `ShiftBar.tsx` and `SyncStatus.tsx` | P1-P5, promo **S4 merged**, A9 probe if D-85 = scroll-under | Sonnet · **Opus** (cart) | `pos-scenarios`, `pos-opencart-scenarios` stay green ("2 item ditambahkan…" at `:498` still shows); screenshots empty / 1 / 12 lines / promo lines | OTA wave 4 |
| **P6b** Bayar | 4 | `POS/cashier/CheckoutPanel.tsx`, `SplitTenderSection.tsx`, new `POS/cashier/cashInput.ts` (+ test) if D-113 = yes | P1-P5 | Sonnet · **Opus** (payment) | parser unit tests (`"350.000"`, empty → exact cash unchanged, paste, max); `pos-scenarios:189` spinbutton → textbox; `pos-split-scenarios` selectors; screenshots 1280×800 **and 1280×667** (P-5 was found at short height) | OTA wave 4 |
| **P7** discount sheets | 4 | `POS/cashier/PromoPanel.tsx`, `PromoSheet.tsx`, `ManualDiscountSection.tsx`, `BxgyRewardModal.tsx`, `BundleSlotPicker.tsx` | K3 + promo **S4 merged** | Sonnet · **Opus** (pricing UI) | `PromoSheet.test.tsx` + promo tests; screenshots | OTA wave 4 |
| **B4a** Pelanggan + Promosi | 4 (or 3) | `BO/screens/Customers.tsx`, `BO/screens/customers/*`, `BO/screens/Promotions.tsx`, `BO/screens/promotions/*` | K2 + promo **S2 merged** | Sonnet · **Opus** (promotions = pricing; full-body PUT round-trip) | `backoffice-customers`, `-promotions`; screenshots | Cloudflare |
| **Z** cleanup | 5 | `POS/index.css` (delete indigo remap), `POS/brand/apply.ts` (delete `INDIGO_STEPS`), `POS/brand/brand.test.ts` (`:81-97` indigo assertions), `BO/lib/brand.ts` (`primary: 'indigo'` at `:110`), `BO/ui/IconButton.tsx` (`label` required), any remaining `(indigo\|orange)-[0-9]` line, motion-guard allow-list → empty, `docs/design-kaca/` (**delete**), HANDOFF note | all of the above | Sonnet · standard (Opus glance at `apply.ts`: skins) | grep `(indigo\|orange)-[0-9]` = 0 in both apps' `src`; typecheck with required labels; 3-brand screenshot sheet (`VITE_BRAND=mandalika\|flamboyan\|performance`) of W1, W2, BO1 for the owner (D-87/D-100) | Cloudflare + OTA |

**Parallel safety.**
- Wave 2: K2 owns only backoffice files, K3 only POS kit files.
- Wave 3: P1-P5 own disjoint POS files on top of the finished K3 kit, and B1-B3 + B4b own disjoint backoffice folders. `ShiftBar.tsx` and `SyncStatus.tsx` are split by region: P3/P2 now, P6a in wave 4.
- Wave 4: P6a/P6b/P7 are disjoint POS files. `CheckoutPanel`'s props don't change, so P6a and P6b don't collide in `CashierScreen.tsx`.
- **Promo auto-apply (PR #70)** touches, in its S4: `cashierReducer.ts`, `CashierScreen.tsx`, `PromoPanel.tsx`, `Cart.tsx`, `heldOrders.ts`, `heldRestore.ts`, `openCartDraft.ts`, `useOpenCartDraft.ts`, `customerAttachImpact.ts` and `autoPullGate.ts`. Its S2 touches `BO/screens/promotions/*`.
  - Hence P6a/P7 wait for S4, and B4a waits for S2.
  - If the owner wants Kaca first instead, swap the order; the later one rebases.
- The customer-search fix session works on backend search (`read/customers.go`) and owns none of these files.

**Rough size:** K1 1 session · K2 1-2 · K3 1 · P1-P5 1 each · B1-B4b 1 each (B3 1-2) · P6a/P6b/P7 1 each · Z ½. Total about 17 sessions, 5 owner merge points (one per wave).

**Done when:**
- every screen in the spec has a 1280×800 / 1440 / 768 / 375 screenshot reviewed against its mock;
- the A9 probe passes, or the fallback is recorded (or D-85 = No);
- indigo/orange = 0;
- the motion allow-list is empty;
- `docs/design-kaca/` is gone.

---

## 7. Owner decisions (recommended default in **bold**; none blocks K1, K2 or K3)

- **D-85** · Should POS content scroll *under* the header and category bar, the way the W1 mock does (scroller padding-top 152)? That is the only case where real glass is visible, and the only case where it costs GPU time. **No: keep separate rows; header and category bar get the glass tint without blur ("glass-static").** Revisit only if the A9 probe passes the `glass` run. **Owner 2026-11-06: scroll-under with real glass (option 3), modals/sheets/dialogs stay solid.** POS content scrolls under one combined blurred header + category band, gated on the A9 probe (5.2); P6a builds it in wave 4. If the probe fails, the POS falls back to `static` (5.1).
- **D-86** · Backoffice chrome. The top bar sits outside `<main>`, so nothing scrolls under it, and the sidebar is beside the content. Real blur there would show only the static ambient. **Glass-static top bar and docked sidebar, no blur; the sidebar is a solid drawer with a scrim below `lg`.** Real blur only if the owner wants content to scroll under a translucent top bar, which is a layout change. **Owner 2026-11-06: scroll-under with real glass; modals stay solid.** `<main>` content scrolls under a blurred BO top bar (sidebar stays glass-static docked / solid drawer below `lg`). New wave-4 slice **K2b** (BO glass shell) owns `BO/App.tsx` layout, `BO/shell/Header.tsx`, `BO/main.tsx` (`data-material`, ambient) and its kit/browser tests; Opus review (outlet select in the header).
- **D-87** · Ambient background per brand. **Mandalika: the spec's gold/peach gradients. Flamboyan and Performance: neutral paper ambient (no purple/red wash; red reads as danger) until the owner sees Z's 3-brand sheet.** **Owner 2026-11-06 (with option 3): ambient ON** per this default. BO via K2b; POS via P6a after the A9 probe checks the ambient layer.
- **D-88** · POS font weights. The A9's system Roboto has no 600, so `font-semibold` renders as 700. **Keep system Roboto and write weights by role: 700 for product names, prices and bar labels (the spec's 600 renders as 700 on the tablet anyway), 500 for secondary labels.** Screenshots then match the device. Alternative: vendor Roboto Variable into the POS bundle (+~35 KB per OTA, no APK).
- **D-89** · Backoffice control height. **40 px (QA V-2), 36 px for pagination and row icons.** The spec's 44 applies to POS-style touch surfaces only.
- **D-90** · Customer in the cart header (W1 mock, V-6), replacing the 30 px phone bar above the product search. This moves a flow, so it is not in Kaca. **Defer to a small POS layout slice after P6a; keep today's customer bar in Kaca (restyled to 44 px controls).**
- **D-91** · Live remaining stock on tiles and lines ("Sisa N", P-3). Derived display, but it is stock. **Yes, as its own Opus-reviewed slice after P6a, not inside the restyle.**
- **D-92** · Bayar totals (V-7): the mock shows the total once and folds the summary into "Rincian". **Total in the header and on the confirm; keep subtotal and discount rows visible but compact (no hidden-by-default summary).**
- **D-93** · Add-to-cart feedback (P-11). **Yes: opaque "Ditambahkan · {nama}" toast, 1.6 s, only on a successful add.**
- **D-94** · Refund reason chips. Mock: Salah ukuran, Botol rusak, Salah input, Permintaan pelanggan. Code: 5 options from `refundSelection.ts:194-200`, incl. "Tidak cocok/alergi". **Keep the code's list; restyle only** (reports may group by reason).
- **D-95** · Mock-only features with no data or flow behind them: refund restock choice (W4), profile Ubah / Semua riwayat / + Tambah catatan (W3b), the mock's auto "Beli 2 hemat" lines and auto gift line (W1; that is the promo auto-apply plan, PR #70). **Not built in Kaca.** Restock and profile edits can come back as their own plans.
- **D-96** · Reason field when closing a shift with a difference (P-15, W6 mock). It needs a close-payload field + backend + migration. **Defer to its own backend slice; Kaca keeps today's confirm-only dialog.**
- **D-97** · Denomination sheet "Reset" (clears the local count inputs). **Yes**; per-row subtotals are display-only and included.
- **D-98** · "Tutup Shift" in the header (P-8). The owner reserved moving it. **Keep it in the header, restyled from red to neutral secondary; red only in its confirm.** Moving it into the menu stays with M-11 (D-99).
- **D-99** · The merge candidates (navigation/flow, out of the spec's own scope). Default for each:

  | ID | Change | Default |
  |---|---|---|
  | M-1 | Laporan Transaksi + Unduh data → one tab + "Unduh ▾" | **Defer** (navigation) |
  | M-2 | Refund tab → status chip on Transaksi | **Defer** |
  | M-3 | One shift-summary component, backoffice + POS | **Defer** (cross-app component) |
  | M-4 | Unduh/Templat/Import → one "Impor/Ekspor ▾" | **Do in B1 (Produk), B3 (Bahan) and B4a (Pelanggan):** same three actions, one menu; no navigation change |
  | M-5 | Drop page-level outlet selects; use the header scope | **Defer** (changes Persetujuan/Permintaan behaviour, #20) |
  | M-6 | One "Masalah" area for Sinkron + ERP + Log | **Defer** (navigation) |
  | M-7 | Loyalitas → Pengaturan; drop the empty Bundle tab | **Defer** |
  | M-8 | Switch only, no duplicate status tag | **Do in B1/B4a** (visual) |
  | M-9 | Stok Minus → Inventori | **Defer** |
  | M-10 | One "Diskon" sheet with Promo/Kode/Manual tabs | **Defer until promo auto-apply is live** |
  | M-11 | POS menu merges (Riwayat, Transfer, Shift, Koneksi, Pengaturan) | **Defer** (incl. P-8) |
  | M-12 | One close control, same place on every sheet | **Do** (P6b Bayar, P2 Koneksi; the shared `Sheet` header in K3) |

- **D-100** · Brand colours (D-24). The register says D-24 was **answered 2026-10-27**: Flamboyan `#9b59b6`, Performance `#a93226`. The POS applies them through `POS/brand/brands.ts` with the D-27/D-28 overrides, and the BO skins are in `BO/lib/brand.ts`. What is new in Kaca is the bar gradient and ambient per brand. **Derive both from `--color-brand` / `--color-brand-strong` (no new hex values); the owner approves Z's 3-brand screenshot sheet.** If the owner considers D-24 reopened, only the two palette hex values change.
- **D-101** · Phone and portrait layouts: backoffice list rows as cards < 640 px (#25), POS phone landscape (P-4), phone header (P-12), tablet-portrait bottom cart sheet. **Out of scope** (the fleet is the A9 in landscape). The 375 px screenshots only assert no horizontal page overflow and a drawer scrim.
- **D-102** · BO1 product table: the mock has separate Harga and "Stok · semua outlet" columns; code has "Varian & Stok" (`products/ProductsTable.tsx:53`). Variants carry different prices. **Keep the current columns.**
- **D-103** · Red ERP-failure count in the sidebar (#12). `BO/shell/navBadgeModel.ts:17-24` has no ERP entry. **Yes in B4b, if a `status=dead&limit=1` list call gives `meta.total` like the existing header count requests; otherwise defer** (no new endpoint in Kaca).
- **D-104** · One default page size. **25 everywhere** (ErrorLogs and ERP from 50; `?per=` still honoured).
- **D-105** · Bahan Penyesuaian / Stok Masuk history tables (#30, N-2). Needs ingredient-movement list data. **Separate slice after Kaca** (read endpoint + table), not a restyle.
- **D-106** · Built-in roles shown read-only (#26), and the role-delete confirm saying how many users hold it. **Defer the built-in list; name the role in the confirm (B4b).** The user count only if `Users.tsx` already has the data.
- **D-107** · Backoffice transfer "Terima paksa" (#14): the label and secondary style are in B3. **Add a confirm naming the TRF and quantities** (same pattern as Kirim).
- **D-108** · One default date range for Laporan tabs (P3: Transaksi 30 days, others today). **Today for every tab**, with the range kept in the URL as now.
- **D-109** · Motion preset. **Pegas in both apps; Halus on the POS if the A9 probe shows jank or the OS "Remove animations" setting isn't honoured.**
- **D-110** · Backoffice `Modal` scrim blur (`ui/Modal.tsx:74`). **Remove it; plain scrim** (rule 1 limits blur to chrome).
- **D-111** · Ingredient opname in progress: the "Selisih" column compares against the previously saved count, not system stock (N-3). **Relabel it "Belum disimpan" while in progress;** the real selisih shows after completion.
- **D-112** · POS login marketing stat "30+ Outlet aktif" (P-7). **Remove it.**
- **D-113** · Bayar cash input formatted as "Rp 350.000" while typing (P-9). Replacing `type=number` with a text field + parser changes how money is entered: the parser, paste, empty → exact cash. **Yes, in P6b with parser unit tests and an Opus review;** keep today's "empty means exact cash" rule.
- **D-114** · Category delete confirm (#28) naming how many products use it ("2 produk akan tanpa kategori"). **Yes, if the category list already carries a product count; otherwise defer** (no new query in Kaca). No move-to option.
- **D-115** · QA slice B edge case: a payment row with a **negative** recorded amount always opens the selisih confirm at Tutup Shift. **Leave the logic as is** (a negative recorded amount is worth a confirm); P3 only makes the dialog state the reason clearly.
- **D-116** · QA slice B edge case: in blind mode, a row for a **disabled** method that holds money shows no hint about why it is listed. **Add a neutral hint "Metode nonaktif · ada transaksi" (display only) in P3.**

---

## 8. Risks

- **Accessible-name churn breaks the browser gate.** Tabs → `role=tab`, labelled icon buttons, and one close control all change what `getByRole` finds. Each slice owns the scenario edits for its screens. K2 does the tab sweep.
- **Sticky header regression.** Section 2.1's pitfalls (the `overflow-hidden` root, `border-collapse` borders); covered by a K2 test that scrolls `<main>` and asserts the `th` stays in view on a fitting table.
- **Brand skins on new tokens.** Any token derived from `brand-strong` is wrong on Flamboyan/Performance until K1's per-brand values land. K1 tests it; Z's 3-brand sheet confirms it visually.
- **Desktop screenshots ≠ tablet rendering.** Font weight (D-88), WebView compositing. The A9 probe and an owner glance at the OTA are the real check.
- **Promo auto-apply ordering.** If S4 slips, P6a/P7 wait. Wave 2 doesn't depend on it.
- **Token import on the POS (K1)** could shift computed styles. The acceptance is a computed-style identity test on key elements before/after.
