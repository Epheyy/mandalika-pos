# Kaca design-fidelity audit: mocks vs what is live

Date 2026-11-06 · base `prod-hardening` `460fa704` · auditor: Claude (Opus 5.5), docs only, no app code changed.

**Question (owner):** did the Kaca builds follow the 19 visual mocks in `docs/design-kaca/screens/*.dc.html`?

**Short answer:** Partly. The builds use the Kaca tokens, colours, materials and kit, and every owner rule is applied (solid dialogs, no PINs, cart appears on add, one glass band). But the slices built from the plan's written rows and never saw the rendered mocks, so many layout and component details differ. Of 200 visible differences, 38 are intended, 111 were missed (2 structural, 38 component, 71 polish) and 51 need your call. 75 of the 111 misses were never asked for in the plan rows; 36 were asked for and not built. The most serious show on the real tablet: Bayar's amount field and keypad sit below the fold, and the cart shows about one line once a customer and a promo are attached.

**What was compared.**
- **Mocks:** all 19 `.dc.html` files rendered with the rebuilt `screens/support.js` (served over `python -m http.server`), full page at each mock's `$preview` size, Tweaks props at their defaults. W1/Main were also captured with the cart emptied, and W1 once at 1006×601 for reference.
- **Built = live.** POS code at `460fa704` is identical to POS OTA 2.10.0 (`git diff --stat 59dbc2ac 460fa704 -- apps/pos packages` is empty). Backoffice = `prod-hardening` tip, which Cloudflare serves (every later commit is `[CF-Pages-Skip]` docs).
- **How the built screens were reached:** the repo's browser-test fixture with synthetic data only (no real login, no real API). (1) A full `browser:ci` run harvested every `captureShot` the Kaca slices added (gate passed). (2) A throwaway capture spec (not in CI, not committed) reused `setupPos`, the fixture and three backoffice mock APIs to reach the states the gate doesn't shoot. The POS fixture was seeded like the mock: categories, low and zero stock, the outlet giveaway, an Otomatis promo, an attached customer, and an offline pass with 2 queued sales.
- **Viewports:** POS at **1006×601** (the real Galaxy Tab A9 landscape viewport) and 1280×800 (the mocks' size); Bayar also at 1280×667. Backoffice at 1440 wide (960 tall to match the mocks; 900 in gate shots), plus 768 and 375 for the shell.
- **Screenshots** are in the review page (Artifact), not in git.

**How each difference is classified.**
- **(a) intended:** an owner rule, a §1.2 material rule, a §7 decision, a D-99 merge entry, or a recorded owner policy covers it. Cited.
- **(b) missed:** the mock is clear, nothing covers it, the build differs. Severity: **high** = layout/structure, **medium** = component/visual, **low** = polish. Tagged **plan-gap** (the plan's §3 row never asked for it, so the slice followed the plan) or **build-gap** (the plan asked, the build doesn't do it).
- **(c) owner call:** the mock conflicts with something real (data, policy, the 1006×601 fleet viewport, a slice choice flagged "owner to eyeball"), or it is ambiguous.

Not counted as differences: font rendering (the mocks load a web font; the POS uses system Roboto per D-88, the backoffice self-hosted Roboto), synthetic names/prices/counts, missing product photos.

**Spec boards.** W6, W7, BO-Kit, BO5–BO8 and Tokens are annotated component boards, not page layouts; each annotated component was compared with its built counterpart. Many board annotations name QA fixes that wave A–E already shipped; only their look was checked.

**Not reached in the capture** (judged from source where noted): the Tambah/Ubah Pelanggan and Tambah Pengguna slide-overs; a receive-transfer with an inbound transfer (the fixture has none); the Inventori overview matrix (the gate's B3 shots were used instead).

**Review page with every mock beside its live screen:** https://claude.ai/artifact/NB89QuGDDjitjAyNZnXTgU

## 1. At a glance

| Screen | (a) intended | (b) high | (b) medium | (b) low | (c) owner call | Total |
|---|---:|---:|---:|---:|---:|---:|
| W1 · Kasir: katalog, keranjang, header | 8 | 0 | 5 | 6 | 9 | 28 |
| W2 · Bayar | 1 | 1 | 2 | 6 | 3 | 13 |
| W3 · Pelanggan (pilih pelanggan) | 0 | 0 | 1 | 1 | 1 | 3 |
| W3b · Profil pelanggan | 1 | 0 | 1 | 7 | 0 | 9 |
| W4 · Riwayat dan refund | 3 | 0 | 2 | 2 | 3 | 10 |
| W5 · Koneksi dan antrean | 0 | 0 | 2 | 4 | 2 | 8 |
| W6 · Rekap dan Tutup Shift (board) | 2 | 0 | 6 | 5 | 3 | 16 |
| W7 · Menu, pesanan tersimpan, diskon, terima transfer (board) | 4 | 0 | 4 | 5 | 1 | 14 |
| Tokens (rule sheet) | 5 | 0 | 0 | 0 | 1 | 6 |
| BO-Kit · komponen bersama (board) | 1 | 0 | 7 | 3 | 1 | 12 |
| BO1 · Produk + shell (sidebar, top bar) | 2 | 1 | 1 | 11 | 8 | 23 |
| BO2 · Ubah produk | 1 | 0 | 0 | 4 | 5 | 10 |
| BO3 · Pengaturan | 1 | 0 | 1 | 4 | 3 | 9 |
| BO4 · Keluar dari Pengaturan | 0 | 0 | 1 | 1 | 0 | 2 |
| BO5 · Ringkasan dan Laporan (board) | 3 | 0 | 2 | 0 | 3 | 8 |
| BO6 · Inventori dan opname (board) | 2 | 0 | 1 | 5 | 4 | 12 |
| BO7 · Pelanggan dan Promosi (board) | 1 | 0 | 1 | 5 | 3 | 10 |
| BO8 · Operasional dan sistem (board) | 3 | 0 | 1 | 2 | 1 | 7 |
| **All** | **38** | **2** | **38** | **71** | **51** | **200** |

Of the 111 missed items, **75 are plan-gaps** (the mock shows it, the §3 row never asked) and **36 are build-gaps** (the plan asked, the build doesn't do it). Duplicates across screens are merged into one row (the merged IDs are listed in the row).

## 2. Top missed items

| ID | Severity | What | Fix slice |
|---|---|---|---|
| W2-10 | high | Bayar: amount field and keypad below the fold. At 1280×800 the last keypad row hides under Konfirmasi; on the 1006×601 tablet with a customer both are fully out of view. The mock fits on one screen. | F2 |
| SH-01 | high | Backoffice frame: the mock's sidebar, top bar and slide-over are floating rounded panels; the build draws them flush against the screen edges on every page. | G2 + G1 |
| W1-23 | medium | Cart lines use a full −/+ stepper where the plan asked for one 36 px quantity pill; on the tablet each line wraps to two rows. | F1 |
| W1-26 | medium | D-93 add-to-cart toast "Ditambahkan · {nama}" was never built: a tile tap gives no confirmation, and a scan shows "Ditambah: …" for 3 s. | F1 |
| W6-09 | medium | Tutup Shift with a difference: the confirm button is gold; D-98 says red only in that confirm (the dialog is opened without tone="danger"). | F4 |
| BO5-02 | medium | Laporan Transaksi (and the customer detail) show raw "Cash"/"Qris" instead of Tunai/QRIS, although #5 is counted as fixed. | G4 + G6 |
| BO7-01 | medium | Promosi rows still show a switch plus a coloured status pill; M-8 said switch plus a plain word. | G6 |
| W7-07 | medium | Pesanan tersimpan: "Lanjutkan" is a white secondary button; the plan asked for the gold primary. | F6 |
| BO4-01 | medium | Leave-settings dialog is still 384 px; "Simpan & lanjut" wraps to a second row (plan: one row, wider dialog). | G1 |
| KIT-05 | medium | Status pills have no coloured dot anywhere in the backoffice; every board shows dot + word. | G1 |
| W1-21 | medium | Cart totals block is about 130 px taller than the mock and shows the total twice (plus both "Hemat promo" and "Total hemat"). | F1 |
| BO8-04 | medium | Log Kesalahan shows raw English messages ("order rejected"); the plan asked for the label map. | G6 |
| SH-07 | medium | At 375 px the top bar cuts off the outlet select and pushes the user menu (Keluar) off-screen. | G2 |

## 3. Decisions needed from the owner

The most consequential (c) rows. The full list is in section 5 (class c).

- **W1-28.** Is the cart usable on the A9? At 1006×601 with a customer and a promo, about one line name shows (its stepper clipped); a 12-line cart shows two lines. Fixing W1-21 and W1-23 helps, but you decide whether the column also changes.
- **W2-01 · W4-01 · W5-01.** Sub-flows: keep Bayar, Pelanggan, Profil, Koneksi, Riwayat and Refund as sheets/pop-ups over the screen, or move them into the cart column as the mocks draw them (catalogue stays visible). This is the biggest structural difference.
- **W2-02.** Close control: × top-right (built, one place on every sheet) or "‹ Kembali" top-left (every mock).
- **W1-02.** Search: own row under the header (built) or inside the header bar (mock). With Tutup Shift in the header (D-98) it may not fit at 1006 px.
- **W1-27.** Toast look: light surface with a coloured dot (built, K3) or ink-900 with white text (plan §1.2).
- **W1-09 · W1-14.** Catalogue: add "Terlaris" and "Promo" tabs and gift/bundle tiles (mock), and keep the Favorit chip (built, not in the mock)?
- **KIT-07.** Pagination: numbered pages + "per halaman" (mock) or the plan's prev/next only.
- **BO1-15.** Produk row switch: make it live, or keep it read-only and restyle it so it does not look disabled.
- **W6-12 · BO2-07.** Formatted money entry ("Rp 1.000.000") beyond Bayar: shift recap, denominations, backoffice prices?
- **W5-03.** List each queued sale in Koneksi (mock) instead of only a count (needs the queue items passed in).
- **BO6-14.** Table headers: UPPERCASE grey (BO5-BO8 boards) or sentence case on a tinted band (BO-Kit board, built). The boards disagree.
- **TK-06.** Restate the design target as 1006×601 (the real tablet) instead of 1280×800 for later work.
- **Slice Z timing.** Z deletes `docs/design-kaca/`. Recommendation: keep `screens/` (with `support.js`) until this fix wave is merged, so each fix slice can render its mock and compare side by side; delete it in Z afterwards. Also widen Z's grep to raw Tailwind greys/ambers (`gray-`, `amber-`), which K1-K3 did not catch (KIT-09, BO6-13).

## 4. Proposed fix wave

Same rules as the restyle plan §6: Sonnet `implementer` (medium); Opus `reviewer` (high) when a slice touches cart, pricing, payment, stock, refund, money totals, sync UI, auth or outlet scope, otherwise the standard `code-reviewer`. Owned files are the only files a slice edits. Only (b) rows are scheduled; (c) rows wait for the owner. **New for this wave:** every slice renders its mock (`docs/design-kaca/screens`, served as in the README) and compares it side by side with its own screenshots at 1006×601 and 1280×800 (POS) or 1440/768/375 (backoffice) before review.

| Slice | Owns (files) | Gaps covered (b) | Model / review | Release | Notes |
|---|---|---|---|---|---|
| **F1** POS cart column + band details | `POS/cashier/Cart.tsx`, `POS/cashier/CashierScreen.tsx` (toast calls and cart-column chrome only; no state or mount change), `POS/cashier/ShiftBar.tsx` (shift pill), `POS/lib/connectionChip.ts`, `POS/cashier/ProductGrid.tsx` (category tab sizing) | W1-04, W1-05, W1-10, W1-17, W1-18, W1-19, W1-21, W1-23, W1-24, W1-25, W1-26 | Sonnet implementer · Opus reviewer (cart, toast precedence) | POS OTA | Do after the owner answers W1-28 (cart on the A9). Screenshots: empty, 1, 4 lines + customer + promo, 12 lines, at 1006×601 and 1280×800. |
| **F2** POS Bayar | `POS/cashier/CheckoutPanel.tsx` (relabel TOTAL in the panel only: `receiptRows.ts` also feeds the printed receipt) | W2-04, W2-05, W2-06, W2-07, W2-08, W2-09, W2-10, W2-11, W2-13 | Sonnet · Opus (payment) | POS OTA | Fit target: everything visible without scrolling at 1006×601 with a customer and rewards. Screenshots at 1006×601, 1280×800 and 1280×667, with and without a customer. Depends on W2-01 if the owner wants the in-column layout. |
| **F3** POS Pelanggan, Profil, Koneksi | `POS/cashier/CustomerPicker.tsx`, `POS/cashier/CustomerProfileSheet.tsx`, `POS/components/SyncStatus.tsx` (sheet body) | W1-25 (part), W2-08 (part), W3-01, W3-03, W3b-02, W3b-03, W3b-04, W3b-05, W3b-06, W3b-07, W3b-08, W3b-09, W5-04, W5-05, W5-06, W5-07, W5-08 | Sonnet · Opus (sync UI) | POS OTA | W5-03 (list queued sales) only if the owner says yes. |
| **F4** POS Rekap shift + Hitung lembar | `POS/cashier/ShiftRecapPanel.tsx`, `POS/cashier/DenominationSheet.tsx`, `POS/components/ui/ConfirmDialog.tsx` (only if W6-10 needs a richer body) | W5-02 (part), W6-02, W6-03, W6-04, W6-05, W6-06, W6-08, W6-09, W6-10, W6-13, W6-14, W6-16 | Sonnet · Opus (money display) | POS OTA | W6-09 is a one-line fix (tone="danger"). |
| **F5** POS Riwayat + refund | `POS/cashier/OrderHistoryPanel.tsx`, `POS/cashier/RefundDialog.tsx` | W4-02, W4-03, W4-08, W4-09 | Sonnet · Opus (refund) | POS OTA | Display only; refund amounts, payload and outbox untouched. |
| **F6** POS menu, held orders, discount sheets, receive | `POS/cashier/MenuDrawer.tsx`, `HeldOrdersSheet.tsx`, `PromoSheet.tsx`, `ManualDiscountSection.tsx`, `BxgyRewardModal.tsx`, `BundleSlotPicker.tsx`, `POS/cashier/receive/ReceiveTransferPanel.tsx` | W5-02, W6-16 (part), W7-04, W7-05, W7-06, W7-07, W7-08, W7-11, W7-12, W7-13, W7-14 | Sonnet · Opus (pricing UI, stock receive; the A08 PIN path stays exactly as it is) | POS OTA | W7-03 (menu cut off at 601 px) needs the owner's menu answer; M-11 merges stay deferred. |
| **G1** Backoffice kit | `BO/ui/*` (Button, FilterBar, StatusBadge, Badge, Switch, Field, PageHeader, Card, ConfirmDialog, SaveBar, SlideOver, DataTable, ExportButton) | KIT-01, KIT-02, KIT-03, KIT-04, KIT-05, KIT-06, KIT-08, KIT-09, KIT-12, SH-01 (part), BO2-08, BO3-07, BO4-01, BO6-07, BO7-07, BO7-11 | Sonnet · standard code-reviewer + a11y pass | Cloudflare | Kit look changes reach every page. Update browser-gate selectors that change; screenshots of Produk, Kartu Stok, Pengaturan, ERP at 1440/768/375. |
| **G2** Backoffice shell frame | `BO/shell/*`, `BO/App.tsx`, `BO/outlet.tsx` | KIT-09 (part), SH-01, SH-02, SH-04, SH-05, SH-06, SH-07 | Sonnet · Opus (header outlet select = outlet scope; user menu = auth) | Cloudflare | Floating sidebar/top-bar panels (SH-01) without breaking K2b's scroll-under or the sticky table header; fix the 375 px top bar (SH-07). |
| **G3** Backoffice Produk + Pengaturan | `BO/screens/products/*`, `BO/screens/settings/*`, `BO/screens/SettingsScreen.tsx` | BO1-02, BO1-04, BO1-05, BO1-08, BO1-12, BO1-14, BO1-16, BO2-03, BO2-05, BO2-06, BO3-01, BO3-02, BO3-03, BO3-04, BO4-02 | Sonnet · Opus (payment-method settings, prices) | Cloudflare | After G1. |
| **G4** Backoffice Laporan + Ringkasan | `BO/screens/Orders.tsx`, `BO/lib/splitPayment.ts`, `BO/screens/dashboard/*` | BO5-01, BO5-02 | Sonnet · Opus (report money) | Cloudflare | BO5-02 label fix also covers the CSV path check. After G1. |
| **G5** Backoffice Inventori | `BO/screens/inventory/*`, `BO/screens/ingredients/*`, `BO/screens/StockCount.tsx`, `BO/screens/stockcount/*`, `BO/screens/transfers/transferAction.ts` | KIT-10, BO6-05, BO6-07 (part), BO6-08, BO6-09, BO6-11, BO6-13 | Sonnet · Opus (stock display only) | Cloudflare | After G1 (G1 adds the DataTable row-height prop BO6-07 needs). |
| **G6** Backoffice Pelanggan, Promosi, Pengguna, ops | `BO/screens/promotions/*`, `BO/screens/customers/*`, `BO/screens/Users.tsx`, `BO/screens/users/*`, `BO/screens/syncReview/*`, `BO/screens/ErrorLogs.tsx`, `BO/lib/labels/*` | BO5-02 (part), BO7-01, BO7-02, BO7-06, BO7-07 (part), BO7-10, BO8-03, BO8-04, BO8-06 | Sonnet · Opus (promotions = pricing; users = auth) | Cloudflare | After G1. |

**Order.**
1. Owner answers the section 3 calls that change scope first: W1-28, W2-01/W4-01/W5-01, W2-02, W1-02. F1-F3 depend on them.
2. **Wave A (parallel, disjoint files):** G1, G2, F1-F6. POS slices ship as one batched POS OTA; G1/G2 via Cloudflare.
3. **Wave B (parallel):** G3-G6, after G1 is merged so the screens are reviewed on the new kit.
4. Then slice Z (with the timing note above).

Shared test files follow plan §6: `tests/browser/*-scenarios.ts` selector edits are line-local and merge in table order. No slice changes the backend, OpenAPI, migrations or sync, and none needs an APK.

## 5. Gaps by screen

Columns: Class (a intended, b missed, c owner call) · Cite for (a), severity for (b), the decision needed for (c) · Gap = plan-gap / build-gap for (b) · Slice = fix-wave slice. Paths: `POS/` = `apps/pos/src/`, `BO/` = `apps/backoffice/src/`.

### W1 · Kasir: katalog, keranjang, header

Same overall shape as the mock (tiles left, order column right, gold Bayar bar) and the tiles are close. Different: search sits on its own row under the header instead of inside it. The cart is a flush column, not a floating card, with −/+ steppers instead of a quantity pill, buttons above the totals, and a much taller totals block that shows the total twice. On the real tablet (1006×601) the cart can show as little as one line. Main.dc.html is the same design with 12 products.

| ID | Element | Mock | Built | Class | Cite / severity / decision | Owning file(s) | Gap | Slice |
|---|---|---|---|---|---|---|---|---|
| W1-01 | Header material | Two separate floating, rounded, inset glass bars (header row; category bar) | One combined glass band (header + search + categories) flush to the top edge; the catalogue scrolls under it | a | D-85 (one combined band) | `POS/cashier/ProductGrid.tsx`, `POS/cashier/CashierScreen.tsx` |  |  |
| W1-02 | Header row layout / search placement | One row: wordmark + outlet, search field INSIDE the header (search icon, gold "Pindai" text action in the field), shift pill, Koneksi pill, menu | Row 1: logo + outlet + shift pill + Tutup Shift … Koneksi pill + menu. The search is on its own 2nd row (catalogue column only), with no search icon and a separate square scan-icon button | c | Owner: accept the two-row band or ask for search inline. D-98 puts Tutup Shift in this row (the mock has none), and the mock's own 1006 squeeze clips Koneksi + menu, so inline search may not fit the fleet | `POS/cashier/ProductGrid.tsx` (search), `POS/cashier/CashierScreen.tsx` (header) |  |  |
| W1-03 | Tutup Shift | No Tutup Shift control in the header | Neutral secondary "Tutup Shift" pill next to the shift pill | a | D-98 | `POS/cashier/ShiftBar.tsx` |  |  |
| W1-04 | Shift pill | "● Shift aktif · 09:12" on a green-tinted pill (start time shown) | "● Shift Aktif ▾" on a white pill; start time only inside its popover | b | low | `POS/cashier/ShiftBar.tsx:94-103` | plan-gap | F1 |
| W1-05 | Koneksi pill copy | "Offline · 2 tersimpan" | "Offline · 2 tersimpan di tablet" | b | low | `POS/lib/connectionChip.ts` (pill in `POS/components/SyncStatus.tsx`) | plan-gap | F1 |
| W1-06 | Menu icon badge | Plain menu icon, even with 2 sales pending | Red dot (pending/inbound) or red count (perlu ditinjau) on the menu icon | c | Owner: keep the existing status badge the mock omits? | `POS/cashier/CashierScreen.tsx:1244-1248` |  |  |
| W1-07 | Header seam when the cart is open | Header bar spans the full width above both catalogue and cart; the cart card starts below it | The glass band covers only the catalogue column. The header's right side (Koneksi + menu) sits on bare ambient above the cart column, which starts right under the header | c | P6a HANDOFF "owner to eyeball: the seam where the glass ends at the cart column" | `POS/cashier/CashierScreen.tsx`, `POS/cashier/ProductGrid.tsx` |  |  |
| W1-08 | Customer placement | Customer card inside the cart under "Pesanan" (avatar, "Budi Santoso · Gold", "1.250 poin · 1 hadiah tersedia", "Ganti ›") | Today's customer bar: top of the cart column when open (avatar, name, phone · poin, Ganti / Lepas). With the cart closed it is a full-width "+ Pelanggan" row inside the band | a | D-90 | `POS/cashier/CustomerChip.tsx`, `POS/cashier/CashierScreen.tsx` |  |  |
| W1-09 | Category set | Tabs: Semua, Terlaris, Promo, Paket & Hadiah, Extrait, Eau de Parfum; no Favorit control | Semua + catalogue categories only (Extrait, Eau de Parfum, Paket & Hadiah); separate "♡ Favorit" chip at the right end | c | "Terlaris"/"Promo" virtual filters would be new behaviour (no slice); Favorit is an existing feature the mock omits: owner decides both | `POS/cashier/ProductGrid.tsx` |  |  |
| W1-10 | Category tab sizing | Tabs spread evenly across the whole bar | Tabs hug their text, left-aligned; the rest of the bar is empty | b | low | `POS/cashier/ProductGrid.tsx` (CategoryTabs) | plan-gap | F1 |
| W1-11 | Tile material | Translucent 60 % "Kaca" tiles | Solid white tiles | a | §1.2 cards solid | `POS/cashier/ProductGrid.tsx` |  |  |
| W1-12 | Type weight | Bold product / line / customer names | Lighter names (regular/medium) | a | D-88 + digest fonts note (system Roboto, weights by role) | - |  |  |
| W1-13 | "Habis" tile | Plain tile; only the "Habis" word is red | Red outline round the tile + faded thumbnail; still tappable | a | A44 (POS warns, never blocks; outline is the warning cue, `ProductGrid.tsx:155`) | `POS/cashier/ProductGrid.tsx:155-165` |  |  |
| W1-14 | Gift / bundle tiles | "Tas Kanvas · Hadiah · tidak dijual · Gratis" tile and a "Paket Duo Alpha+Bravo · Paket harga tetap · ● Promo" tile | No such tiles | c | P1 recorded that there is no gift tile in the catalogue grid, and bundles are promotions, not products. Owner decides whether the grid should show them (the plan row asked for a gift "Gratis" tile) | `POS/cashier/ProductGrid.tsx` |  |  |
| W1-15 | Tile layout at fleet size | Thumbnail left of the name | At 1006×601 (3 columns) the thumbnail sits above the name, even when the cart is closed and tiles are ~320 px wide (layout keyed on column count) | c | Fleet-only; owner decides whether wide fleet tiles should keep the thumb-left layout | `POS/cashier/ProductGrid.tsx:100-106` (HEAD_LAYOUT) |  |  |
| W1-16 | Empty cart | Cart panel always mounted: "Keranjang kosong. Ketuk produk di kiri untuk menambah.", Bayar Rp 0 | No cart column until a product is added | a | rule 2 | `POS/cashier/CashierScreen.tsx` |  |  |
| W1-17 | Cart panel + Bayar shape | Floating rounded card with margins, top aligned with the category bar; Bayar = rounded, inset gradient button with shadow | Flush full-height column with a left border, starting right under the header row; Bayar = full-bleed square gradient bar on the bottom edge | b | medium | `POS/cashier/Cart.tsx:161`, `:407-428`; `POS/cashier/CashierScreen.tsx` | plan-gap | F1 |
| W1-18 | Cart count copy | "Pesanan" with "3 barang" right-aligned in grey | "Pesanan 4 item" inline | b | low | `POS/cashier/Cart.tsx:166-172` | plan-gap | F1 |
| W1-19 | Cart action row | Three equal icon buttons: Promo (purple tint), Catatan, Kosongkan. They sit BELOW the totals, right above Bayar | Two buttons, "Promo & Diskon" and "Catatan", with no icons, ABOVE the totals. Kosongkan moved to the title row as a text button | b | medium | `POS/cashier/Cart.tsx:174-190`, `:316-327` | build-gap | F1 |
| W1-20 | Hold-order controls | None | "Simpan" in the cart title row, "Tersimpan (N)" when parked carts exist, and a "Pesanan tersimpan (1)" button row in the band when the cart is closed | c | Existing hold-order feature (D-6) the mock omits; owner decides placement (menu merges M-11 deferred) | `POS/cashier/Cart.tsx:174-190`, `POS/cashier/CashierScreen.tsx` (band topSlot) |  |  |
| W1-21 | Cart totals block | Compact Subtotal / Total hemat / PPN; the total appears only on the Bayar bar | Subtotal, a promo chip row, BOTH "Hemat promo" and "Total hemat" for one promo, a bold "Total" row (total shown twice with the Bayar bar), "⏱ Tersimpan di tablet" when pending. About 360 px from action row to bottom vs about 230 px in the mock (PPN hidden at 0 = fixture/settings, not a gap) | b | medium | `POS/cashier/Cart.tsx:330-400` | plan-gap | F1 |
| W1-22 | Auto promo display | Auto promo as a cart line: "Beli 2 hemat 10 % [Promo] Otomatis · bisa digabung − Rp 139.000 ›" | Promo as a chip row in the totals: "PROMO Otomatis Sepuluh [Otomatis] ×" | a | D-95 (mock auto promo line not built; shipped as "Otomatis" promos) | `POS/cashier/Cart.tsx:335-345` |  |  |
| W1-23 | Quantity control on lines | One 36×36 grey qty pill per line (edit through the line ›) | Full "− 1 +" Stepper (~48 px keys) on every sold line; the pill only on gift lines | b | medium | `POS/cashier/Cart.tsx:239-244` (Stepper), `:230`, `:280` (pill, reward/giveaway only) | build-gap | F1 |
| W1-24 | Line subtitle | "50 ml · Extrait" (size · category) | Size code only ("L", "M", "STD") | b | low | `POS/cashier/Cart.tsx:225` | plan-gap | F1 |
| W1-25 | Label / tag case | Sentence case: "Hadiah", "Promo", "Gratis", "Cocok dengan nomor ini", "Terakhir dilayani di tablet ini", "Bahan obrolan", "Pembelian terakhir", "Sering dibeli" | All caps: "HADIAH", "PROMO", "GRATIS" (cart) and "COCOK DENGAN NOMOR INI", "TERAKHIR DILAYANI DI TABLET INI", "BAHAN OBROLAN", "SERING DIBELI", "PEMBELIAN TERAKHIR" | b | low | `POS/cashier/Cart.tsx:211,234,275,283,338,348,363`; `POS/cashier/CustomerPicker.tsx:139,145`; `POS/cashier/CustomerProfileSheet.tsx:108,115,130` | plan-gap | F1+F3 |
| W1-26 (+W7-16) | Add-to-cart toast | (No toast in the mock; D-93 decided: opaque "Ditambahkan · {nama}", 1.6 s, on every successful add) | Tile or variant tap: no success toast at all. Scan: "Ditambah: {nama} {size}" info toast at the 3 s default | b | medium | `POS/cashier/CashierScreen.tsx:467` (tap), `:512` (scan); `POS/components/ui/toastController.ts:17` | build-gap | F1 |
| W1-27 (+W7-15) | Toast surface | (No toast in the mock; plan §1.2: ink-900 solid, white text) | Light opaque card with a coloured dot and dark text | c | K3 chose a light surface (digest "note if it differs"); no owner answer recorded | `POS/components/ui/Toast.tsx` |  |  |
| W1-28 | Cart lines at fleet size | At 1280×800: 4 lines plus spare room above the totals | At 1006×601 the 320 px column wraps each line into 2 rows (stepper under the name). Customer + promo leave room for about ONE line name, with its stepper clipped; a 12-line cart shows 2 lines | c | P6a HANDOFF "owner to eyeball on the A9: … 12-line cart"; fleet-only. Highest-priority owner call: with W1-21 and W1-23 it decides whether the cart is usable on the A9 | `POS/cashier/Cart.tsx`, `POS/cashier/CashierScreen.tsx` |  |  |

### W2 · Bayar

All the mock's parts are there: total, rewards and points, amount, quick-cash chips, keypad, Konfirmasi. But Bayar opens as a sheet over the whole screen instead of replacing the cart, and the keypad sits under everything instead of beside the change. At 1280×800 the last keypad row hides under the confirm bar. On the real tablet with a customer, the amount field and the keypad are both below the fold.

| ID | Element | Mock | Built | Class | Cite / severity / decision | Owning file(s) | Gap | Slice |
|---|---|---|---|---|---|---|---|---|
| W2-01 | Where the panel opens | Bayar / Pelanggan / Profil replace the cart panel inside its column; the catalogue stays visible and live | Right-side sheet over a dimmed scrim covering the catalogue | c | The W2 plan row chose a sheet ("layout inside the sheet"). For W3/W3b, rule 2 means there is no cart column to host the picker when the cart is empty | `POS/cashier/CheckoutPanel.tsx`, `POS/cashier/CustomerPicker.tsx`, `POS/cashier/CustomerProfileSheet.tsx`, `POS/components/ui/Sheet.tsx` |  |  |
| W2-02 | Close control: which corner | "‹ Kembali" (W2, W3) or "‹ Pelanggan" (W3b, back to the picker) top-left; title centred ("Bayar", "Pelanggan", "Profil") | × ("Tutup") top-right; title left-aligned ("Bayar Rp …", "Pelanggan", "Profil Pelanggan"); the W3b × closes instead of returning to the picker | c | K3 asked the owner to eyeball it (M-12 fixed one place, not which). Owner: keep × top-right or switch every sheet to "‹ Kembali" top-left | `POS/components/ui/Sheet.tsx` |  |  |
| W2-03 | Summary in Bayar | No summary rows; total only in the header | Grey summary card at the top (Subtotal, promo row, total) | a | D-92 (subtotal/discount rows visible but compact) | `POS/cashier/CheckoutPanel.tsx:199-202` |  |  |
| W2-04 | Extra "TOTAL" row | Total once in the header (and on Konfirmasi) | Summary card adds a bold all-caps "TOTAL" row, so the total shows 3 times (header, summary, Konfirmasi) | b | low | `POS/cashier/CheckoutPanel.tsx:201`; label from shared `POS/cashier/receiptRows.ts:45` (also feeds the printed receipt) | build-gap | F2 |
| W2-05 | Customer card in Bayar | Customer named only in the reward heading "Hadiah & Poin · Budi (Gold)" | Separate grey customer card (name + phone) above "Hadiah & Poin · {name}", so the name shows twice | b | low | `POS/cashier/CheckoutPanel.tsx:204-213` | plan-gap | F2 |
| W2-06 | Reward pick | One-tap chip "✓ Tas Kanvas · Gratis" (teal fill when chosen) beside "Tukar 500 poin ›" | White fold-out row "Customer gift — Tersedia! ▾" (expand, then pick); "Tukar 100 poin ›" chip on its own line below | b | medium | `POS/cashier/CheckoutPanel.tsx:223-330` | plan-gap | F2 |
| W2-07 | Payment-method selector | Segmented switch (Tunai / Kartu / QRIS / Transfer): grey track, white thumb, no label | "Metode Pembayaran" label + 56 px choice chips, selected = gold fill (missing Kartu/Transfer = fixture settings, not a gap) | b | medium | `POS/cashier/CheckoutPanel.tsx:382-404` | plan-gap | F2 |
| W2-08 | Input border colour | Gold (brand) border on the amount field and on the picker search field | Ink / near-black border (amount `border-ink-700`; picker field focus ring `ink-900`) | b | low | `POS/cashier/CheckoutPanel.tsx:422`, `POS/cashier/CustomerPicker.tsx:46` | plan-gap | F2+F3 |
| W2-09 | Quick-cash chips | One row of equal rounded-rectangle chips without "Rp" ("Uang pas", "1.300.000", …) | Pill chips with "Rp" that wrap onto a 2nd row | b | low | `POS/cashier/CheckoutPanel.tsx:424-434` | plan-gap | F2 |
| W2-10 | Keypad layout and fit | Keypad takes 2/3 of the width beside a right column (Kembalian, Sales); all of Bayar fits 1280×800 without scrolling, rewards block included | Full-width keypad stacked under the chips. At 1280×800 its last row hides under the sticky bar even with NO customer. With a customer + rewards the keypad is entirely below the fold (worse at 1280×667 and 1006×601) | b | high | `POS/cashier/CheckoutPanel.tsx:198-470` | plan-gap | F2 |
| W2-11 | Keypad keys | White keys with a hairline border | Solid beige (paper-1) keys with no border | b | low | `POS/cashier/CheckoutPanel.tsx:436-446` | build-gap | F2 |
| W2-12 | Kembalian + Sales placement | Large green "Kembalian" and "Sales (opsional) · Tanpa sales ▾" in the right column beside the keypad | Kembalian in the sticky bar left of Konfirmasi; Sales as a row in the sticky bar (NOT visible: fixture has no salesmen, so the row does not render) | c | Plan explicitly chose this (P-5 Kembalian in the sticky bar, V-8 Sales near the confirm) | `POS/cashier/CheckoutPanel.tsx:471-510` |  |  |
| W2-13 | Konfirmasi bar | Gold gradient bar with shadow: "Konfirmasi" left, amount right | Flat gold button with "Konfirmasi Rp …" centred, plus a line "Order akan terkirim otomatis" under it | b | low | `POS/cashier/CheckoutPanel.tsx:512-520` | plan-gap | F2 |

### W3 · Pelanggan (pilih pelanggan)

Works like the mock (phone search, Cari, + Baru, Pilih ›, offline notice) but opens as a sheet over the screen. Result rows are plain lines instead of cards: no letter avatar, no highlight on the exact match, no tier or reward count. Headings are in capitals and the offline notice has no dot.

| ID | Element | Mock | Built | Class | Cite / severity / decision | Owning file(s) | Gap | Slice |
|---|---|---|---|---|---|---|---|---|
| W3-01 | Result row | Bordered rounded card: initial avatar, "Name · phone" on line 1, "Tier · poin · N hadiah tersedia" on line 2, gold "Pilih ›". The exact match has a teal tint + teal border | Flat row with no card, avatar or match highlight: name on line 1, "phone · poin" on line 2 (no reward count, tier only when known), "Pilih ›" in ink | b | medium | `POS/cashier/CustomerPicker.tsx:48-70` (Row) | plan-gap | F3 |
| W3-02 | "Profil" button on rows | No profile entry on picker rows | Extra "Profil" text button on each row | c | Existing feature (opens W3b); the mock does not show how W3b is reached. Owner decides | `POS/cashier/CustomerPicker.tsx:63-67` |  |  |
| W3-03 | Offline notice | Warn box with a dot, pinned at the bottom of the panel: "Offline: hanya pelanggan yang pernah dilayani di tablet ini. Pencarian lengkap butuh internet." | Warn box with NO dot, right under the results: "Offline: hanya pelanggan yang pernah dilayani di tablet ini yang bisa dicari." | b | low | `POS/cashier/CustomerPicker.tsx:149-151` | build-gap | F3 |

### W3b · Profil pelanggan

Every information block is there. The styling differs: the four stats sit in a 2×2 grid of plain tiles instead of one tinted row, points show as "1250" without the dot, headings are in capitals and the tip box is beige instead of blue. Ubah, Semua riwayat and + Tambah catatan are left out by decision (D-95).

| ID | Element | Mock | Built | Class | Cite / severity / decision | Owning file(s) | Gap | Slice |
|---|---|---|---|---|---|---|---|---|
| W3b-01 | Ubah / Semua riwayat / + Tambah catatan | "Ubah" in the header, "Semua riwayat" link | Not present | a | D-95 | `POS/cashier/CustomerProfileSheet.tsx` |  |  |
| W3b-02 | Identity line + avatar | Teal filled avatar; "0812 3456 7890 · pelanggan sejak Mar 2025 · 14 transaksi" | Beige avatar; phone only (no customer-since or transaction count) | b | low | `POS/cashier/CustomerProfileSheet.tsx:80-90` | plan-gap | F3 |
| W3b-03 | Tier chip | Small grey "Gold" chip right after the name | All-caps peach "GOLD" chip at the far right of the row | b | low | `POS/cashier/CustomerProfileSheet.tsx:89` | build-gap | F3 |
| W3b-04 | Stats | Four tiles in ONE row. The hadiah tile is teal and names the reward ("1 hadiah · Tas Kanvas"); the days tile is warn/orange ("47 hari · sejak terakhir"); money is compact ("Rp 5,9 jt") | 2×2 grid of neutral beige tiles; "Hadiah tersedia" without the reward name; full "Rp 2.500.000"; no tints | b | medium | `POS/cashier/CustomerProfileSheet.tsx:44-51`, `:95-100` | build-gap | F3 |
| W3b-05 | Points number format | "1.250" | "1250" (no thousands dot; the picker uses `formatPoints`, the profile passes the raw number) | b | low | `POS/cashier/CustomerProfileSheet.tsx:96`, `:103` | build-gap | F3 |
| W3b-06 | Bahan obrolan box | Blue info tint with a small blue heading | Beige box with a gold border and a gold all-caps heading | b | low | `POS/cashier/CustomerProfileSheet.tsx:106-112` | plan-gap | F3 |
| W3b-07 | Section order | Pembelian terakhir, then Sering dibeli | Sering dibeli first, then Pembelian terakhir | b | low | `POS/cashier/CustomerProfileSheet.tsx:113-150` | plan-gap | F3 |
| W3b-08 | Purchase rows | Bordered card: items in bold on line 1, "date · outlet · method · hadiah" on line 2, amount right, grey "Ulangi" | No card: small grey "date · relative time · amount" first, items second; white outlined "Ulangi"; no outlet or method | b | low | `POS/cashier/CustomerProfileSheet.tsx:128-150` | plan-gap | F3 |
| W3b-09 | Footer CTA | Gold gradient button with shadow, label left + "›" chevron | Flat brand-strong button, label centred, no chevron | b | low | `POS/cashier/CustomerProfileSheet.tsx:164-169` | build-gap | F3 |

### W4 · Riwayat dan refund

The refund dialog matches well: opaque, gold ticks, reason chips, Batal left, red Refund bar right. The mock's Riwayat page with the refund in the right column became two centre pop-ups. The Riwayat list uses Dari/Sampai date boxes instead of Hari ini / Kemarin / Pilih tanggal. The PIN notice and the restock choice are gone on purpose (rule 3, D-95).

| ID | Element | Mock | Built | Class | Cite / severity / decision | Owning file(s) | Gap | Slice |
|---|---|---|---|---|---|---|---|---|
| W4-01 | Riwayat + refund structure | Riwayat page (list left) + refund panel in right column | Riwayat centre dialog over cashier; refund a second centre dialog | c | Owner: keep dialogs (plan W4 "opaque dialog", P4) or adopt split view | `POS/cashier/OrderHistoryPanel.tsx`, `RefundDialog.tsx` |  |  |
| W4-02 | Riwayat date filter | Segmented "Hari ini / Kemarin / Pilih tanggal" | "Dari / Sampai" native date inputs + "Muat" button | b | medium | `POS/cashier/OrderHistoryPanel.tsx` | plan-gap | F5 |
| W4-03 | Riwayat row | "#No · Pelanggan", "Kemarin 16:42 · Tunai", status by amount, chevron, gold selected outline | Number + status left, customer in meta, absolute date, no chevron, inline expand | b | medium | `POS/cashier/OrderHistoryPanel.tsx` | plan-gap | F5 |
| W4-04 | Riwayat status words | Sync words: Terkirim / Sudah direfund / Perlu ditinjau | Order words: Selesai / Refund | c | Owner: list shows sync status or order status? (server list has no local review state) | `POS/cashier/OrderHistoryPanel.tsx` |  |  |
| W4-05 | Refund PIN notice | "Butuh PIN penyetuju untuk refund (A06)" | No notice | a | rule 3 no PIN | `POS/cashier/RefundDialog.tsx` |  |  |
| W4-06 | Restock choice | "Stok: Kembalikan ke stok / Tidak (barang rusak)" | Not present; note "Stok akan dipulihkan oleh kantor pusat" | a | D-95 | `POS/cashier/RefundDialog.tsx` |  |  |
| W4-07 | Reason chips | Rusak / Salah ukuran / Berubah pikiran / Lainnya | Rusak/cacat / Salah varian / Berubah pikiran / Tidak cocok/alergi / Lainnya | a | D-94 | `POS/cashier/RefundDialog.tsx` |  |  |
| W4-08 | Refund header | "Refund #BSD-00398" + time · method · Kasir · pelanggan | "Refund Order" + "SYN-10001 · Dibayar Tunai Rp …" only | b | low | `POS/cashier/RefundDialog.tsx` | plan-gap | F5 |
| W4-09 | Refund item rows | Grouped block, "50 ml · Extrait" subline, qty column "1 ×" | Single rows, "1 dari 1 bisa direfund" subline, struck original price, no qty column | b | low | `POS/cashier/RefundDialog.tsx` | plan-gap | F5 |
| W4-10 | Gift line in refund | Gift "Tas Kanvas · Gratis" tickable | Gift excluded, note "Tas hadiah tidak ikut direfund" | c | Owner: confirm gifts stay non-refundable (behaviour, not look) | `POS/cashier/RefundDialog.tsx` |  |  |

### W5 · Koneksi dan antrean

Koneksi is a full-height side sheet instead of the mock's panel in the cart column. It says "Tersimpan di tablet (2)" but does not list the queued sales, shows one full-width "Kirim sekarang" instead of three buttons, and leaves out the "data diperbarui" line.

| ID | Element | Mock | Built | Class | Cite / severity / decision | Owning file(s) | Gap | Slice |
|---|---|---|---|---|---|---|---|---|
| W5-01 | Koneksi container | Inset floating panel in cart column, catalogue not dimmed | Full-height side sheet flush right, scrim over catalogue | c | Owner: in-column panel vs overlay sheet (P2 kept Sheet) | `POS/components/SyncStatus.tsx`, `POS/components/ui/Sheet.tsx` |  |  |
| W5-02 | Close control not in one place | One close control, same place on every sheet (M-12); the boards draw "‹ Kembali" top-left | Sheets: × top-right. BXGY / Bundle pickers: "‹ Kembali" top-right. Receive detail: "‹" top-left (source). Rekap: "× Kembali ke Kasir" bottom-left | b | medium | `POS/components/ui/Sheet.tsx`, `BxgyRewardModal.tsx`, `BundleSlotPicker.tsx`, `receive/ReceiveTransferPanel.tsx`, `ShiftRecapPanel.tsx` | build-gap | F6+F4 |
| W5-03 | Queued-sale list | Rows "#L-0412 · Penjualan · Tunai", time, amount, "Menunggu" | Only "Tersimpan di tablet (2)" + "Aman. Akan terkirim…" | c | Owner: needs outbox items passed in (only a count today) | `POS/components/SyncStatus.tsx` |  |  |
| W5-04 | Footer actions | Kirim sekarang (2) / Perbarui data / Bagikan log in one row | Only "Kirim sekarang (2)", full width; others appear only when needed, stacked | b | low | `POS/components/SyncStatus.tsx` | build-gap | F3 |
| W5-05 | Status notice copy | "Offline sejak 14:02 · penjualan tetap bisa", dot, "(10 jam lagi)" | "Offline · 2 tersimpan di tablet", no dot, "Sisa sekitar 12 jam.", count line repeats title | b | low | `POS/components/SyncStatus.tsx` | build-gap | F3 |
| W5-06 | Section headings | Warn "Tersimpan di tablet" / danger "Perlu ditinjau" + count pill | Ink heading with "(2)" in text | b | low | `POS/components/SyncStatus.tsx` | build-gap | F3 |
| W5-07 | Review card (source-only) | Red-bordered card, "#L-0399 · Refund · Rp 350.000", danger-outline "Coba lagi" + "Detail teknis" in a row | No border; per-row "Coba lagi" secondary; extra full-width "Coba lagi"; "Tandai sudah ditangani" | b | medium | `POS/components/SyncStatus.tsx` (`ReviewRow`) | build-gap | F3 |
| W5-08 | Data freshness line | "Data produk & promo: diperbarui 13:58" (info dot) | Not shown; versions only inside "Detail teknis" | b | low | `POS/components/SyncStatus.tsx` | plan-gap | F3 |

### W6 · Rekap dan Tutup Shift (board)

A spec board, not a page; the build keeps its three-part recap page. The board's short coloured Ringkasan Penjualan is a long neutral table, the method cards are laid out differently, and the close confirm is a plain sentence with a gold button (D-98 says red there). The Hitung lembar sheet shows each count twice.

| ID | Element | Mock | Built | Class | Cite / severity / decision | Owning file(s) | Gap | Slice |
|---|---|---|---|---|---|---|---|---|
| W6-01 | Recap structure | One panel: "‹ Kembali / Rekap & Tutup Shift / Shift Aktif", summary then methods | Full-screen page: left nav (Rekapan/Riwayat), centre methods, right tables | c | Owner: board is not a page; keep 3-pane page (M-3 deferred)? | `POS/cashier/ShiftRecapPanel.tsx` |  |  |
| W6-02 | Ringkasan Penjualan | Short 4-row block on top: promo purple, refund red, Bersih in gold | Long neutral table in right column under cash-flow tables | b | medium | `POS/cashier/ShiftRecapPanel.tsx` | build-gap | F4 |
| W6-03 | Method card layout | Small "Hitung lembar ›" top-right; label left + half input right; Tercatat/Selisih footer row; "Sesuai (Rp 0)" | Tercatat top-right; full-width input; full-width "Hitung lembar" button; Selisih line only; "Sesuai" no amount | b | medium | `POS/cashier/ShiftRecapPanel.tsx` | build-gap | F4 |
| W6-04 | Cash composition line | "Kas awal Rp 200.000 + Kas masuk Rp 50.000 − Refund tunai" under Tunai | Not shown | b | low | `POS/cashier/ShiftRecapPanel.tsx` | build-gap | F4 |
| W6-05 | Blind-count notice | Warn tag "Hitung buta aktif" + warn notice with dot | Blue info notice with "i" icon + grey "Total Terhitung" hint | b | low | `POS/cashier/ShiftRecapPanel.tsx` | build-gap | F4 |
| W6-06 | Method tags | "Non-tunai" tag on QRIS; warn tag "Dinonaktifkan di BO · Ada 1 transaksi" | No Non-tunai tag; inactive = plain grey text "Metode nonaktif · ada transaksi" (source :531) | b | low | `POS/cashier/ShiftRecapPanel.tsx` | build-gap | F4 |
| W6-07 | Recap CTA colour | Red danger bar | Gold | a | D-98 (red only in the confirm) | `POS/cashier/ShiftRecapPanel.tsx` |  |  |
| W6-08 | Recap CTA label | "Tutup Shift · Ada Selisih −Rp 5.001" | "Tutup Shift" (no amount) | b | low | `POS/cashier/ShiftRecapPanel.tsx` | build-gap | F4 |
| W6-09 | Close confirm button colour | Red "Konfirmasi & Tutup Shift" | Gold "Tutup Shift" (no `tone="danger"`, :658-664) | b | medium | `POS/cashier/ShiftRecapPanel.tsx` | build-gap | F4 |
| W6-10 | Close confirm content | Title with amount, sentence, totals block, "Periksa Lagi" | One sentence listing selisih; "Batal" / "Tutup Shift" | b | medium | `POS/cashier/ShiftRecapPanel.tsx`, `POS/components/ui/ConfirmDialog.tsx` | build-gap | F4 |
| W6-11 | Selisih reason field | "Catatan / alasan selisih (wajib bila selisih ≠ 0)" | Not present | a | D-96 | `POS/cashier/ShiftRecapPanel.tsx` |  |  |
| W6-12 | Money inputs | Formatted "Rp 2.470.000" | Raw "1000000"; native number spinners (QRIS, Kas Akhir, denomination) | c | Owner: extend D-113 formatting (Bayar only) to recap? | `POS/cashier/ShiftRecapPanel.tsx`, `DenominationSheet.tsx` |  |  |
| W6-13 | Denomination row | Stepper "− [20] +" with the count editable inside | "− 12 +" plus a second input "12" (count twice) | b | medium | `POS/cashier/DenominationSheet.tsx` | build-gap | F4 |
| W6-14 | Denomination header/footer | "Hitung Lembar Tunai", "Reset" in header; one bar "Pakai Hasil Hitung Rp …" | "Hitung lembar"; Reset link by description; "Total" + separate "Pakai" | b | low | `POS/cashier/DenominationSheet.tsx` | build-gap | F4 |
| W6-15 | After-close card (not verified) | Ok notice "Shift berhasil ditutup · 22:40 WIB" + "Cetak Rekap Shift" / "Buka Shift Baru" | Not captured; source has open-shift form + secondary "Cetak Rekap" | c | Owner/QA: capture post-close state and compare | `POS/cashier/ShiftRecapPanel.tsx` |  |  |
| W6-16 | Primary action material | Gold gradient "bar utama" (Tokens: one per screen) | Flat gold buttons: recap "Tutup Shift", "Pakai", receive "Terima" (source) | b | medium | `ShiftRecapPanel.tsx`, `DenominationSheet.tsx`, `receive/ReceiveTransferPanel.tsx` | plan-gap | F4+F6 |

### W7 · Menu, pesanan tersimpan, diskon, terima transfer (board)

The menu is a wide two-column sheet with plain rows; the board shows a narrow column of filled rows with chevrons and counts. "Lanjutkan" in Pesanan tersimpan is a white button where the plan asked for gold. The Promo/Kode/Manual tabs (M-10), the merged menu entries (M-11) and the PIN note (rule 3) are left out on purpose. On the real tablet the menu list is cut off.

| ID | Element | Mock | Built | Class | Cite / severity / decision | Owning file(s) | Gap | Slice |
|---|---|---|---|---|---|---|---|---|
| W7-01 | Menu entries merged | "Riwayat & Struk", "Transfer & Permintaan", "Pengaturan tablet (satu pintu)" | Separate entries; "Operasional" / "Pengaturan" | a | M-11 (D-99) | `POS/cashier/MenuDrawer.tsx` |  |  |
| W7-02 | "Rekap & Tutup Shift" row | In the menu | "Rekap Shift"; Tutup Shift stays in header | a | D-98 / M-11 | `POS/cashier/MenuDrawer.tsx` |  |  |
| W7-03 | Menu panel shape + fit | Narrow single-column floating card | Wide two-column full-height sheet; at 1006x601 list cut ("Perbarui data" hidden) | c | Owner: single column needs M-11 merges to fit 601 px | `POS/cashier/MenuDrawer.tsx` |  |  |
| W7-04 | Menu row style | Filled 44 px tiles, chevron › / ↗, active row gold outline | Plain rows with round icon chips, no fill, no chevrons | b | medium | `POS/cashier/MenuDrawer.tsx` | plan-gap | F6 |
| W7-05 | Menu count badges | "Pesanan Tersimpan 2", transfer "1 dikirim" | No counts; red dot on Terima Transfer, "Baru" on Perbarui data | b | medium | `POS/cashier/MenuDrawer.tsx` | plan-gap | F6 |
| W7-06 | Menu header identity | Gold square initial, "Reffy · Kasir", "Mandalika BSD · Shift #104"; "Buka Back Office ↗" row | "Mandalika POS" title, round avatar, "Admin · Shift Aktif"; Back Office link in header | b | low | `POS/cashier/MenuDrawer.tsx` | plan-gap | F6 |
| W7-07 | Held order "Lanjutkan" | Gold primary | White secondary (`variant="secondary"`, :64) | b | medium | `POS/cashier/HeldOrdersSheet.tsx` | build-gap | F6 |
| W7-08 | Held order row | "Ibu Sari · 14:20" title, "3 item · Rp 640.000" right | Name; date "06/11 23:57" right; items/amount below | b | low | `POS/cashier/HeldOrdersSheet.tsx` | plan-gap | F6 |
| W7-09 | Discount tabs | "Promo Toko / Kode Voucher / Diskon Manual" tabs; title "Promo, Kode & Diskon" | One "Promo & Diskon" sheet with sections | a | M-10 (D-99) | `POS/cashier/PromoSheet.tsx`, `PromoPanel.tsx` |  |  |
| W7-10 | PIN > 20 % notice | "Potongan manual di atas 20% memerlukan PIN" | Not present | a | rule 3 no PIN | `POS/cashier/ManualDiscountSection.tsx` |  |  |
| W7-11 | Promo sheet header | "Subtotal Rp 100.000" beside title | Title only | b | low | `POS/cashier/PromoSheet.tsx` | plan-gap | F6 |
| W7-12 | Manual discount block (source-only) | Open block, "bukan PROMO" tag, Nominal first, max hint, formatted input, inline red error | Collapsed "Diskon manual / Biaya tambahan ▾"; Persen first; raw input; no hint/inline error | b | low | `POS/cashier/ManualDiscountSection.tsx` | plan-gap | F6 |
| W7-13 | BXGY gift + bundle pickers | Row card: name, "Stok tersedia · Gratis (Rp 0)", − 1 + stepper; "Gratis" tag | Small chips "Name · M Rp 10.000 · Stok 100" (bundle slots the same); strip "Pilih 1 hadiah lagi" | b | medium | `POS/cashier/BxgyRewardModal.tsx`, `BundleSlotPicker.tsx` | plan-gap | F6 |
| W7-14 | Receive detail (source-only) | "Terima Transfer · TRF-00014" + "Dikirim" tag, route + rule sentence, "Konfirmasi Penerimaan & Cetak Tanda Terima" | "Terima TRF-…" + "Dari X", no tag/sentence; "Terima" + "Kembali" | b | low | `POS/cashier/receive/ReceiveTransferPanel.tsx` | build-gap | F6 |

### Tokens (rule sheet)

Colours, radii, type steps and motion in the token files match the board. Every material difference is an owner rule: dialogs, panels and cards are solid, and the glass is 72 % white, not 56 %. The board states the cashier tablet as 1280×800; the real fleet tablet is 1006×601.

| ID | Element | Mock | Built | Class | Cite / severity / decision | Owning file(s) | Gap | Slice |
|---|---|---|---|---|---|---|---|---|
| TK-01 | Glass alpha | "Kaca atas · blur 20, putih 56%" | `--surface-glass-bg` rgba(255,253,249,.72), blur 20 + saturate 180 | a | plan §1.2 (α .72) | `packages/ui-tokens/materials.css` |  |  |
| TK-02 | Glass on dialogs/slide-overs/save bar | Board lists them as Kaca | Solid `--surface-solid-bg` #fffdf9 | a | rule 1 | `packages/ui-tokens/materials.css` |  |  |
| TK-03 | Panel (cart, right panels) | "putih 88%, tanpa blur" | Solid #fffdf9 | a | rule 1, §1.2 | `packages/ui-tokens/materials.css` |  |  |
| TK-04 | Card + Group | Card "putih 60% + garis paper/2"; Group "putih 62%" | Card solid white + paper-2 border; Group solid color-mix 62 % white | a | §1.2 cards solid (digest Materials) | `packages/ui-tokens/materials.css` |  |  |
| TK-05 | Pill radius | "penuh untuk pill status" | `--radius-chip: 22px` | a | plan §1.1 (keep chip 22 for pills) | `packages/ui-tokens/tokens.css` |  |  |
| TK-06 | Target viewport | "Kasir: tablet 1280×800 dp" | Fleet Galaxy Tab A9 = 1006×601 CSS px | c | Owner: restate spec target (fleet fit, e.g. W7-03) | n/a (spec) |  |  |

### BO-Kit · komponen bersama (board)

The building blocks exist: gold primary, tabs with a white thumb, switches, one label map, confirms that name the item. They look different from the board. Secondary buttons are white with a border instead of filled beige, filter chips are round white pills, status pills have no dot, form labels are in capitals, the date filter is two date boxes plus pills that never show which range is active, and filters sit loose instead of on a light panel.

| ID | Element | Mock | Built | Class | Cite / severity / decision | Owning file(s) | Gap | Slice |
|---|---|---|---|---|---|---|---|---|
| KIT-01 | Secondary button ("Batal", "Batalkan perubahan", "Tetap di sini", "Unduh CSV", "Impor") | Filled paper/beige tile, no border | White with a 1 px paper-2 border; ConfirmDialog hard-codes the same white/border "Batal" | b | medium | `BO/ui/Button.tsx:11` (secondary), `BO/ui/ConfirmDialog.tsx:169` | plan-gap | G1 |
| KIT-02 | Filter chips and select-chip | Rounded-xl tiles: gold fill when selected, paper fill otherwise, count after the label ("Semua 312"); select-chip "Kategori: Semua ˅" filled paper, no border | Fully round pills, white with border when unselected (gold when selected); select is a white bordered box with a grey "Kategori:" prefix | b | medium | `BO/ui/FilterBar.tsx:19-20` (CHIP), `:220-245` (SelectField) | plan-gap | G1 |
| KIT-03 | FilterBar container | Filters grouped on a light "Group" panel (rounded, white ~62 %) | No container: controls sit loose on the ambient ground | b | medium | `BO/ui/FilterBar.tsx:26` | build-gap | G1 |
| KIT-04 (+BO6-03) | FilterBar date range | Segmented "Hari ini / 7 hari / 30 hari / Bulan ini" with a white thumb on the active preset; one "📅 Dari 1 Nov · Sampai 2 Nov" button | "Dari [date]" and "Sampai [date]" native date inputs, then four outline pill chips; no preset shown as selected | b | medium | `BO/ui/FilterBar.tsx:141-166` | plan-gap | G1 |
| KIT-05 (+BO5-08) | StatusBadge | Tinted pill with a coloured dot + word (the board title: "warna + titik + kata") | Tinted pill with the word only, no dot ("Draf", "Selesai") | b | medium | `BO/ui/StatusBadge.tsx:24-29`, `BO/ui/Badge.tsx:22-24` | plan-gap | G1 |
| KIT-06 | Switch, off state | Light grey track, white knob ("Nonaktif") | Default off track `bg-ink-500` reads dark taupe (Tampilan Struk toggles) | b | low | `BO/ui/Switch.tsx:20` | plan-gap | G1 |
| KIT-07 | Pagination | "‹ 1 2 3 … 13 ›" numbered pages with a white current-page tile, "Menampilkan 1–25 dari 312" on the left, "25 per halaman ˅" on the right | "Baris: [25]" select, "Hal 1/N", "Menampilkan a–b dari N catatan", "‹ Sebelumnya / Berikutnya ›" buttons | c | Plan §2.4 explicitly says "Numbered pages are not added"; the mock wants them. Owner: keep prev/next or add numbers + "per halaman". | `BO/ui/Pagination.tsx` |  |  |
| KIT-08 (+BO7-04) | Field labels | Sentence case, bold small ("Nama produk *", "Kategori", "Deskripsi") | UPPERCASE with wide letter-spacing ("NAMA PRODUK *", "JUMLAH SALINAN", "TEKS HEADER") | b | medium | `BO/ui/Field.tsx:19` (labelClass) | plan-gap | G1 |
| KIT-09 | Leftover Tailwind greys (not tokens) | Readable ink-500/700 subtitles, token borders | PageHeader subtitle `text-gray-400` (pale, low contrast: "Katalog, harga dasar…"), title `text-gray-900`; Card `border-gray-100`; header outlet select `border-gray-200` + `focus:ring-gold-500/40`. Slice Z only greps indigo/orange, so it won't catch these | b | medium (subtitle contrast) | `BO/ui/PageHeader.tsx:21,25,27`, `BO/ui/Card.tsx:7`, `BO/outlet.tsx:129` (no slice owns it) | plan-gap | G1+G2 |
| KIT-10 | ConfirmDialog example copy (Kirim transfer) | "Stok 12 unit akan keluar dari Gudang Pusat sekarang dan tercatat “Dikirim” sampai BSD menerima." | "Stok 7 unit akan keluar dari Gudang Pusat sekarang." (no "tercatat Dikirim sampai … menerima" part) | b | low | `BO/screens/transfers/transferAction.ts` (B3) | plan-gap | G5 |
| KIT-11 | Control heights | 44 px buttons, ~52 px tab track | 40 px buttons/inputs/selects/tabs, 36 px pagination/row icons | a | D-89 (BO 40 px, 36 px pagination/row icons; 44 only on POS touch surfaces) | `BO/ui/Button.tsx:17-20`, `BO/ui/Tabs.tsx:47` |  |  |
| KIT-12 (+BO6-10) | Export button label | "Unduh CSV · 312" (row count in the label) | "Unduh CSV" with no count (Kartu Stok); Produk export is inside the Impor/Ekspor menu | b | low | `BO/ui/ExportButton.tsx` | plan-gap | G1 |

### BO1 · Produk + shell (sidebar, top bar)

Produk works as the plan asked: one Impor/Ekspor menu, switch plus word, the Varian & Stok column, a blurred top bar. The biggest difference is the frame: the mock's sidebar, top bar and slide-over are floating rounded panels, the build's touch the screen edges. Filters have no counts, scope line or Kolom button. On a phone the user menu (Keluar) is pushed off-screen.

| ID | Element | Mock | Built | Class | Cite / severity / decision | Owning file(s) | Gap | Slice |
|---|---|---|---|---|---|---|---|---|
| SH-01 | Shell frame: sidebar, top bar, slide-over | Floating rounded glass panels with ~12 px margins: sidebar card, separate top-bar card, slide-over card inset from the right/top/bottom | Flush, full-bleed: sidebar full height at the left edge with square corners, top bar spanning the column edge to edge (it stops at `<main>`'s scrollbar gutter, leaving a small notch at the right), slide-over full height flush right (rounded left only) | b | high | `BO/shell/Sidebar.tsx:45-50`, `BO/shell/Header.tsx:24`, `BO/App.tsx:80-90`, `BO/ui/SlideOver.tsx:70` | plan-gap | G2+G1 |
| SH-02 | Sidebar details | Active item = tinted fill with brand-coloured text and icon; thin dividers between sections; "Masuk sebagai Admin" footer; "Arti angka di menu" centred | Active item = paper-1 fill, ink-900 bold text, 3 px brand inset bar; no dividers; "Masuk sebagai …" lives in the user-menu dropdown; legend link left-aligned. (Missing logo and counts = fixture.) | b | low | `BO/shell/Sidebar.tsx:78-105`, `BO/shell/LegendPopover.tsx:19` | plan-gap | G2 |
| SH-03 | Sidebar section collapse | A chevron "˅" on every section heading (PENJUALAN, PELANGGAN…), so sections look collapsible | Plain h2 headings, not collapsible (source comment: tests need every item visible) | c | Owner: should sections collapse? That is behaviour, and the build chose not to. | `BO/shell/Sidebar.tsx:72-75` |  |  |
| SH-04 | Top-bar outlet scope | Filled paper pill "Cakupan  Semua outlet ˅" (muted "Cakupan" prefix) | Native white bordered select "Semua Outlet" (capital O), no "Cakupan" prefix | b | low | `BO/outlet.tsx:124-137`, `BO/shell/Header.tsx:56` | plan-gap | G2 |
| SH-05 | User chip | "R  Reffy · Admin" on one line, no chevron | Avatar + two lines (name / role) + chevron (dropdown with Keluar) | b | low | `BO/shell/UserMenu.tsx:28-41` | plan-gap | G2 |
| SH-06 | Breadcrumb | "Produk & Stok › Produk"; "Operasional › Pengaturan" | Adds the tab as a 3rd level: "Produk & Stok › Produk › Produk" (duplicate) and "Operasional › Pengaturan › Transaksi" | b | low | `BO/shell/Header.tsx:28-45` | plan-gap | G2 |
| SH-07 (+BO5-09) | Top bar on a phone | (no 375 mock) D-101: 375 must have no horizontal overflow | The header content is wider than the screen: the outlet select is clipped at the right edge and the user menu (Keluar) is off-screen and unreachable. The column's `overflow-hidden` hides it, so the gate's scroll-box check passes. The drawer + scrim at 375 is fine (solid drawer, plain dim scrim). | b | medium | `BO/shell/Header.tsx:24,56`, `BO/shell/UserMenu.tsx` | build-gap | G2 |
| BO1-01 | Import/export actions | "Impor" button in the header + "Unduh CSV · 312" button in the filter panel | One "Impor / Ekspor ˅" menu in the header | a | D-99 M-4 (one Impor/Ekspor menu, DO in B1) | `BO/ui/ImportExportMenu.tsx`, `BO/screens/products/ProductsListView.tsx` |  |  |
| BO1-02 | Button and label copy | "Tambah produk" (kit rule "Tambah {benda}"); "Tambah varian"; footer "Simpan perubahan"; label "Merek" | "+ Tambah" (page), "+ Tambah" (variant section), "Simpan" (slide-over footer), "Brand *" | b | low | `BO/screens/products/ProductsListView.tsx:110`, `BO/screens/products/VariantRows.tsx:39`, `BO/screens/products/ProductFormSlideOver.tsx` (footer, brand label) | plan-gap | G3 |
| BO1-03 | View switch in the title row | No view switch: only "Produk 312 produk" + actions | Segmented "Produk / Kategori / Bundle" strip next to the actions | c | Bundle tab: D-99 M-7 "drop the empty Bundle tab" is DEFERRED. Owner: where Kategori/Bundle live (the mock shows neither). | `BO/screens/Products.tsx`, `BO/screens/products/ProductsListView.tsx` |  |  |
| BO1-04 | Page header text | "Produk  312 produk" (count regular, muted); no subtitle | Adds the subtitle "Katalog, harga dasar dan ketersediaan per outlet. Stok diatur di Inventori."; count in bold ink | b | low | `BO/screens/products/ProductsListView.tsx:97`, `BO/ui/PageHeader.tsx:22` | plan-gap | G3 |
| BO1-05 | Scope line | "Cakupan: Semua outlet · mengikuti pilihan di header" above the filters | Missing (the kit has `FilterBar.Scope`, but Produk doesn't use it) | b | low | `BO/screens/products/ProductsFilters.tsx` | plan-gap | G3 |
| BO1-06 | Filter set and layout | One row: search, "Semua / Aktif / Nonaktif / Stok rendah" chips, "Kategori: Semua ˅", "Kolom" on the right | Search, "Kategori:", "Urutkan: Terbaru", "Semua / Aktif / Nonaktif" chips, then a 2nd row "Semua stok / Stok rendah / Habis" | c | Owner: merging stock into the status chips and dropping "Habis" / "Urutkan" changes the filters (behaviour) | `BO/screens/products/ProductsFilters.tsx`, `BO/screens/products/productsListState.ts` |  |  |
| BO1-07 | Chip counts | "Semua 312 · Aktif 298 · Nonaktif 14 · Stok rendah 9" | No counts (FilterBar supports `count`; the list has no per-status totals) | c | Owner: counts need per-status totals (extra list calls or an API field) | `BO/screens/products/ProductsFilters.tsx`, `BO/screens/products/useProductsList.ts` |  |  |
| BO1-08 | Column chooser | "Kolom" button at the right of the filter panel | None on Produk (the DataTable chooser exists and shows on ERP, but ProductsTable passes no `columnPrefsKey`) | b | low | `BO/screens/products/ProductsTable.tsx:105-116` | plan-gap | G3 |
| BO1-09 | Row checkboxes | Header + per-row checkboxes (bulk select) | None | c | Owner: bulk selection is a new feature (no bulk action exists) | `BO/screens/products/ProductsTable.tsx` |  |  |
| BO1-10 | Columns | Kategori · Varian ("3 ukuran") · Harga (range) · Stok · semua outlet (+ "Stok rendah · 1 varian" tag) · Status | Kategori · Varian & Stok (per-variant chips "30 ml: 20", "Stok: Habis", "30 ml: 2 (rendah)") · Status · Aksi | a | D-102 (keep "Varian & Stok", not separate Harga + Stok columns) | `BO/screens/products/ProductsTable.tsx:53-66` |  |  |
| BO1-11 | Product sub-line | Product code under the name ("PP-AMB-OUD") | Brand under the name ("Mandalika") | c | Owner: products have no product-level SKU (only variants do, per `Product` schema); pick brand or a variant SKU | `BO/screens/products/ProductsTable.tsx:46` |  |  |
| BO1-12 | Kategori cell | Plain text ("Extrait de Parfum") | Neutral tag chip ("Floral", "Woody") | b | low | `BO/screens/products/ProductsTable.tsx:52` | plan-gap | G3 |
| BO1-14 | Row height | ~52 px rows, small blank thumb | ~65 px rows, 40 px icon tile | b | low | `BO/screens/products/ProductsTable.tsx:40`, `BO/ui/DataTable.tsx` | plan-gap | G3 |
| BO1-15 | Row status switch | Live, full-colour gold switch (kit note: the switch replaces click-to-change pills) | Switch drawn read-only + disabled (50 % opacity), so it looks faded; status changes only in the editor | c | Switch + state word is per D-99 M-8. Owner: make the row switch live (an inline save = behaviour) or keep it read-only and style it so it doesn't look broken | `BO/screens/products/ProductsTable.tsx:73-74`, `BO/ui/Switch.tsx:35` |  |  |
| BO1-16 | State word colour | "Aktif" / "Nonaktif" in neutral ink | "Aktif" in bold green (ok), "Nonaktif" ink | b | low | `BO/screens/products/ProductsTable.tsx:76` | plan-gap | G3 |
| BO1-17 | Row actions | One "⋯" more-menu per row | Pencil + trash icon buttons under an "Aksi" header | c | Plan B1 row chose "Icon buttons labelled"; a ⋯ menu adds a click (behaviour). Owner call. | `BO/screens/products/ProductsTable.tsx:84-101` |  |  |

### BO2 · Ubah produk

The edit panel is solid (rule 1) with an error summary. It is wider and flush right, labels are in capitals, prices show as "150000", and it has real fields the mock leaves out (photos, Unggulan, Dijual, per-outlet price).

| ID | Element | Mock | Built | Class | Cite / severity / decision | Owning file(s) | Gap | Slice |
|---|---|---|---|---|---|---|---|---|
| BO2-01 | Panel/dialog material + scrim | Translucent glass slide-over and leave dialog (background blurred through them) | Opaque solid panel and dialog; plain dim scrim | a | Owner rule 1 (no see-through dialogs/slide-overs) + D-110 (no scrim blur) | `BO/ui/SlideOver.tsx:62,70`, `BO/ui/ConfirmDialog.tsx:101,109` |  |  |
| BO2-02 | Form scope + panel width | ~560 px panel: Info produk (Nama, Kategori + Merek, Deskripsi, Aktif) + Varian (Ukuran/SKU/Barcode/Harga) only | 720 px panel with extra real fields: Foto produk uploader, Produk Unggulan + Dijual ke pelanggan checkboxes, recipe (flask) icon per variant, "Harga & ketersediaan per outlet" section | c | Owner: confirm the extra fields stay (they are live data) and the 720 px width (slide-over `width="lg"`) | `BO/screens/products/ProductFormSlideOver.tsx:67,92-130`, `BO/ui/SlideOver.tsx:26` |  |  |
| BO2-03 | Slide-over title | "Ubah produk" (sentence case) + a sub-line starting with the product name | "Ubah Produk" (Title Case), no sub-line (a subtitle shows only for ERP products) | b | low | `BO/screens/products/ProductFormSlideOver.tsx:70-71` | plan-gap | G3 |
| BO2-04 | "terakhir diubah 28 Okt oleh Reffy" | Last-edited date + editor in the sub-line | Not shown | c | Owner: needs audit data (updated-at/by) the editor may not load | `BO/screens/products/ProductFormSlideOver.tsx` |  |  |
| BO2-05 | Aktif toggle | Own group row: "Aktif" + helper "Tampil di POS saat tablet sinkron berikutnya", switch at the right | Inline row "[switch] Produk Aktif  ☐ Produk Unggulan  ☑ Dijual ke pelanggan", no helper | b | low | `BO/screens/products/ProductFormSlideOver.tsx:83-92` | plan-gap | G3 |
| BO2-06 | Variant grid | Columns Ukuran (static label) · SKU · Barcode · Harga; "+ Tambah varian" below the rows | Ukuran (input) · Harga Dasar · SKU · Barcode · recipe icon; "+ Tambah" at the right of the "VARIAN *" heading | b | low | `BO/screens/products/VariantRows.tsx` | plan-gap | G3 |
| BO2-07 | Price inputs | Formatted "Rp 320.000" | Raw "150000" | c | Owner: formatted money entry changes input behaviour (D-113 was decided for the POS only) | `BO/screens/products/VariantRows.tsx`, `BO/screens/products/OutletConfigSection.tsx` |  |  |
| BO2-08 | Validation summary | Pink banner, ⚠ "2 kolom perlu diperbaiki: SKU varian 50 ml, Harga varian 100 ml." | (source; error state not captured) "Periksa isian berikut:" + bulleted list of links | b | low | `BO/ui/SlideOver.tsx:93-104` | plan-gap | G1 |
| BO2-09 | Duplicate-SKU message | Inline red "SKU sudah dipakai Night Jasmine 50 ml" | No client-side duplicate check (`validateForm.ts` has none); not captured | c | Owner: naming the clashing product needs a lookup (server or list data) | `BO/screens/products/validateForm.ts` |  |  |
| BO2-10 | Merek field | "Merek" select (dropdown) | "Brand *" free-text input | c | Owner: brand is free text in the data; a select needs a brand list. (The label copy is in BO1-02.) | `BO/screens/products/ProductFormSlideOver.tsx:75` |  |  |

### BO3 · Pengaturan

Tabs, the dirty dot and a solid save bar that lists the changes are there. The cards are narrower, a changed card gets an amber side bar instead of a tinted row with the previous value, and the save bar runs edge to edge.

| ID | Element | Mock | Built | Class | Cite / severity / decision | Owning file(s) | Gap | Slice |
|---|---|---|---|---|---|---|---|---|
| BO3-01 | Page subtitle | "Berlaku untuk semua outlet; tablet mengambilnya saat sinkron berikutnya." | "Konfigurasi sistem POS" (source; the page top is not in any built shot) | b | low | `BO/screens/SettingsScreen.tsx:87` | plan-gap | G3 |
| BO3-02 | Card column width | Cards ~900 px wide | `max-w-2xl` (672 px) | b | low | `BO/screens/settings/TransaksiSection.tsx:32`, `BO/screens/SettingsScreen.tsx:95,115,264` | plan-gap | G3 |
| BO3-03 | Unsaved-change marking | "Belum disimpan" tag inline after the card title; the changed ROW tinted peach with a previous-value hint "Sebelumnya nonaktif" | Whole card gets a 4 px amber left bar + "Belum disimpan" tag in the top-right corner; no row tint, no previous-value hint | b | medium | `BO/screens/settings/SettingsCard.tsx:12-16`, `BO/screens/settings/TransaksiSection.tsx` | plan-gap | G3 |
| BO3-04 | Card and row titles | Sentence case: "Pajak & pembulatan", "Metode pembayaran", "Bayar terpisah", "Struk"; row "Aktifkan pajak (PPN)" | Title Case: "Pajak & Pembulatan", "Metode Pembayaran", "Pembayaran Terpisah", "Pengaturan Struk"; row "Aktifkan PPN" (first two from source) | b | low | `BO/screens/settings/TransaksiSection.tsx:35,38,85,165`, `BO/screens/settings/SplitTenderCard.tsx` | plan-gap | G3 |
| BO3-05 | Pajak & pembulatan content | Two switch rows; rate/rounding shown as helper text ("Tarif 11%", "Ke Rp 100 · ke bawah") | Switch rows + editable fields "Tarif Pajak (%)", "Pembulatan ke", "Tipe Pembulatan" (source; not in any shot) | c | Owner: the mock hides where rate/rounding are edited; keep the fields | `BO/screens/settings/TransaksiSection.tsx:34-81` |  |  |
| BO3-06 | Metode pembayaran rows | One "Aktif" switch per row; "Masuk laci kas" as a helper under Tunai | Column headers "Masuk laci kas" / "Aktif", two switches per row + delete icon, add-method input (source; not in any shot) | c | Plan B1 row (#18) explicitly chose column headers; the mock differs. Owner call. | `BO/screens/settings/TransaksiSection.tsx:84-159` |  |  |
| BO3-07 | Sticky save bar | Rounded floating card aligned with the cards: "● 2 perubahan belum disimpan" (warn colour) + the list, "Batalkan perubahan" filled secondary, "Simpan perubahan" primary | Solid bar edge to edge across the content column, bold ink count (no dot), "Batalkan perubahan" as ghost text | b | low | `BO/ui/SaveBar.tsx:28,44-50` | plan-gap | G1 |
| BO3-08 | Bayar terpisah card | One-line helper ("…Tablet harus sudah versi 2.5.0.") + row "Izinkan bayar terpisah" | Big title + toggle, a large amber warning box about POS 2.5.0, and an extra paragraph about switching off | c | Owner: keep the prominent rollout warning (safety copy) or shorten it to the mock's one line | `BO/screens/settings/SplitTenderCard.tsx` |  |  |
| BO3-09 | Save bar on a phone | (no 375 mock) | "1 perubahan belum disimpan" wraps to 4 lines and crowds the buttons | a | D-101 (phone layouts out of scope) | `BO/ui/SaveBar.tsx` |  |  |

### BO4 · Keluar dari Pengaturan

The question and the three answers are right. The dialog is still narrow, so "Simpan & lanjut" wraps to a second row (the plan asked for one row), and the text names the tab instead of the changed cards.

| ID | Element | Mock | Built | Class | Cite / severity / decision | Owning file(s) | Gap | Slice |
|---|---|---|---|---|---|---|---|---|
| BO4-01 | Leave dialog layout | Wide (~520 px) dialog, three buttons on ONE row: Buang perubahan · Tetap di sini · Simpan & lanjut | 384 px (`max-w-sm`), buttons wrap: "Buang perubahan" + "Tetap di sini" on row 1, "Simpan & lanjut" alone on row 2 | b | medium | `BO/ui/ConfirmDialog.tsx:109,153` (no width prop), `BO/screens/SettingsScreen.tsx:305-315` | build-gap | G1 |
| BO4-02 | Leave dialog text | "Ada 2 perubahan yang belum disimpan (Metode pembayaran, Bayar terpisah). Kalau ditinggalkan, perubahan ini hilang." | "Ada 1 perubahan yang belum disimpan. Di: Transaksi." (names the TAB, not the changed cards; no consequence sentence) | b | low | `BO/screens/SettingsScreen.tsx:37-38,308` | build-gap | G3 |

### BO5 · Ringkasan dan Laporan (board)

Ringkasan and Laporan are on the kit: KPI cards, a categorical donut, segmented tabs, today as the default range. Laporan Transaksi shows raw "Cash"/"Qris" instead of Tunai/QRIS. The KPI trend is bare % text instead of the "↗ 14,2% vs 30 hari lalu" pill. The merged Transaksi table with "Unduh Laporan ▾" waits on the deferred M-1/M-2 merges.

| ID | Element | Mock | Built | Class | Cite / severity / decision | Owning file(s) | Gap | Slice |
|---|---|---|---|---|---|---|---|---|
| BO5-01 | KPI card anatomy and trend | Grey label on top ("Penjualan Bersih (30 Hari)"), big value, delta as a green tinted pill "↗ 14,2% vs 30 hari lalu" under the value; no icon tile | Gold icon tile, value, label below. From source (`dashboard/components.tsx` KpiCard): delta is bare coloured text at top right, integer % ("14%"), comparison words only in a `title` tooltip. Not rendered in the capture because the fixture had no prior period | b | medium | `BO/screens/dashboard/components.tsx`, `BO/screens/Dashboard.tsx` | build-gap | G4 |
| BO5-02 | Payment method label in rows | "Tunai", "QRIS", "BCA (dikembalikan via Tunai)"; "Metode: Tunai, QRIS, BCA, BRI (terpetakan via PAY_LABELS)" | Raw method ids, capitalised: "Cash", "Qris" (`Orders.tsx:266` renders `orderMethodText`, which returns the raw id at `lib/splitPayment.ts:50`; `methodLabel` exists but is not used). Unduh data and the Ringkasan legend correctly show "Tunai" / "QRIS". The same bug is at `customers/CustomerDetailSections.tsx:182` | b | medium | `BO/screens/Orders.tsx`, `BO/lib/splitPayment.ts`, `BO/screens/customers/CustomerDetailSections.tsx` | build-gap | G4+G6 |
| BO5-03 | List layout | Table with columns No Order · Waktu (WIB) · Outlet · Metode Bayar · Total Bersih · Status | Expandable card-list rows (icon tile, number, one meta line, status pill, amount, chevron); outlet not shown in the row | c | Owner: convert to a table now, or together with M-1/M-2 (the board draws this table as the merged "Transaksi & Refund Terpadu" view) | `BO/screens/Orders.tsx` |  |  |
| BO5-04 | Download entry point | One "Unduh Laporan ▾" menu (Excel · CSV · CSV Refund); no "Unduh data" tab | Separate "Unduh data" tab; "Unduh Excel" on Transaksi; "Unduh CSV refund" + "Unduh CSV" on Unduh data | a | M-1 (D-99) deferred | `BO/screens/Reports.tsx`, `BO/screens/reports/ExportTab.tsx` |  |  |
| BO5-05 | Refund as a status chip | Chips "Semua (142) / Selesai (136) / Refund / Sebagian (6)" on Transaksi | "Semua Status" select plus a separate Refund tab | a | M-2 (D-99) deferred | `BO/screens/Orders.tsx`, `BO/screens/reports/RefundReportTab.tsx` |  |  |
| BO5-06 | "Ikuti rentang tanggal" off | Off = date inputs hidden (#16) | Dari/Sampai stay visible but disabled (`Reports.tsx:124-133` `disabled={datesInert}`) | c | Owner: hide the fields, or keep them disabled so the hub's date card does not jump between tabs | `BO/screens/Reports.tsx`, `BO/screens/reports/OversellTab.tsx` |  |  |
| BO5-07 | Row presentation | Compact 2-line card row: checkbox, "MND-000084 · Bravo 50ml", subline "Mandalika BSD · Stok tercatat −1 saat penjualan BSD-AQ0001", "Belum dicek" pill | 11-column DataTable (Pilih, Waktu jual, No. transaksi, Produk, Qty, Stok, Kurang, Kasir, Jalur, Status, Cek). The sticky note + "Tandai sudah dicek" bar exists in source (`OversellTab.tsx:367`) | c | Owner: compact row (mock) vs audit table with all columns (build) | `BO/screens/reports/OversellTab.tsx` |  |  |
| BO5-10 | 375 px row meta | n/a | Meta line wraps one word per line ("1 item · / Cash · / A26 / Cashier …") | a | D-101 phone layouts out of scope | `BO/screens/Orders.tsx` |  |  |

### BO6 · Inventori dan opname (board)

Kartu Stok has the full-width filter bar the board asks for. The quick ranges never show which one is active, there are 12 grouped movement chips instead of 6, the movement type is plain text instead of a tag, dates are numeric, and rows are not an even 52 px.

| ID | Element | Mock | Built | Class | Cite / severity / decision | Owning file(s) | Gap | Slice |
|---|---|---|---|---|---|---|---|---|
| BO6-01 | Control height | "Semua kontrol tinggi 44px sejajar" | 40 px controls | a | D-89 (BO controls 40 px; 44 px only for POS touch) | `BO/ui/FilterBar.tsx` |  |  |
| BO6-02 | Filter labels and one-row layout | Labels stacked above controls ("Produk / Varian (SKU / Barcode)", "Lokasi", "Rentang Tanggal"); everything on one row | Inline prefixes ("SKU:", "Lokasi:", "Dari", "Sampai"); controls wrap to two rows at 1440 (the board has no sidebar, so it is about 250 px wider) | c | Owner: plan K2 §2.3 (V-3) explicitly chose "no labels stacked above controls", which conflicts with this board | `BO/ui/FilterBar.tsx`, `BO/screens/inventory/StockCard.tsx` |  |  |
| BO6-04 | Movement-type chips | One row "Filter Jenis Gerakan:" with "Semua Gerakan" (selected, gold) + Barang Masuk, Penjualan, Refund, Transfer, Opname / Penyesuaian | 12 chips in labelled groups "Masuk: / Transfer: / Penyesuaian:" + Minus, over 2 rows; no "Semua Gerakan" (reset via "Atur ulang filter (n)"); "Arti jenis gerakan" disclosure | c | Owner: the plan row kept the groups ("group labels tidied") and the ledger has 12 kinds; collapse to 6 categories + "Semua" or keep | `BO/screens/inventory/StockCard.tsx` |  |  |
| BO6-05 | Movement type cell | Tag pill ("Penjualan" neutral, "Transfer Masuk" green) | Plain text ("Penjualan") (`StockCard.tsx:333`) | b | medium | `BO/screens/inventory/StockCard.tsx` | plan-gap | G5 |
| BO6-06 | Table column set and names | 8 columns: Waktu Kejadian · Lokasi · Jenis Gerakan · Dokumen Referensi · Masuk · Keluar · Saldo Akhir · Oleh / Catatan | 12 columns: Waktu Kejadian · Jenis · Dokumen · Masuk · Keluar · Saldo · Oleh · Penyetuju · Alasan · Tanda · Waktu Tercatat · ERP; no Lokasi (one location is selected) | c | Owner: the extra audit columns (Penyetuju, Tanda, Waktu Tercatat, ERP) are not on the board; keep, hide by default, or rename to the mock's labels | `BO/screens/inventory/StockCard.tsx` |  |  |
| BO6-07 | Row height | Even rows of about 50 px | Rows grow to about 90 px when Tanda holds two tags ("Minus" + "Tercatat terlambat" wraps); the plan's 52 px rows were not done (HANDOFF B3: "kit DataTable has no row-height prop") | b | low | `BO/screens/inventory/StockCard.tsx`, `BO/ui/DataTable.tsx` | build-gap | G1+G5 |
| BO6-08 | Signed quantities | Masuk "+9" (green), Keluar "−1" (red) | Keluar "1", "7" in red with no sign (`StockCard.tsx:373-374`) | b | low | `BO/screens/inventory/StockCard.tsx` | plan-gap | G5 |
| BO6-09 | Date/time format | "04 Nov 2026 · 14:22" | "03/01/2026, 12.00" (numeric month, `inventory/stockCardFormat.ts:54`), while ERP/Persetujuan show "03 Jan 2026 12:00" and Laporan "06 Nov 2026 23:57" | b | low | `BO/screens/inventory/stockCardFormat.ts` | plan-gap | G5 |
| BO6-11 | Total columns (from source, not captured) | Two columns "Total Outlet Tampil" + "Total Semua Lokasi (+Gudang)" with "295,5 g (di Gudang Bahan)" | One sticky "Total" column; "Semua lokasi: X" sub-label only when a filter hides columns (`IngredientOverviewMatrix.tsx:173-216`) | b | low | `BO/screens/ingredients/IngredientOverviewMatrix.tsx` | plan-gap | G5 |
| BO6-12 | Penyesuaian / Stok Masuk history tables | "tab Penyesuaian / Stok Masuk menampilkan tabel riwayat" | Not built as part of Kaca | a | D-105 (separate slice after Kaca) | `BO/screens/ingredients/PenyesuaianTab.tsx`, `StokMasukTab.tsx` |  |  |
| BO6-13 | Create dialog (from source, not captured) | "Dialog Buat Opname Baru · Mandalika BSD" (names the location); white box "Cakupan yang dibekukan: 30 produk aktif (51 baris varian ukuran)" | Centred Modal "Tambah opname"; raw-amber box (`bg-amber-50 text-amber-700`, not tokens) "Stok 30 produk · 51 varian aktif akan dibekukan sebagai referensi." (`StockCount.tsx:486-516`, `stockcount/countScope.ts:55`) | b | low | `BO/screens/StockCount.tsx`, `BO/screens/stockcount/countScope.ts` | plan-gap | G5 |
| BO6-14 (+BO1-13) | Table header style | BO5/BO6/BO8 boards: UPPERCASE small grey headers; BO-Kit board: sentence case | DataTable headers sentence case, bold, on a tinted band; Opname Produk's hand-rolled table is uppercase grey (`StockCount.tsx:418`), so the build is mixed | c | Owner: pick one header style (the boards disagree), then apply it to DataTable and Opname | `BO/ui/DataTable.tsx`, `BO/screens/StockCount.tsx` |  |  |

### BO7 · Pelanggan dan Promosi (board)

The customer and promo forms are solid slide-overs with an error summary. Labels are in capitals, Promosi rows show a switch plus a coloured pill (M-8 said switch only), and the promo form uses six type cards instead of a select.

| ID | Element | Mock | Built | Class | Cite / severity / decision | Owning file(s) | Gap | Slice |
|---|---|---|---|---|---|---|---|---|
| BO7-01 | Row status control | One switch + the plain word "Aktif" ("M-8 Fixed: satu switch tanpa tag ganda"); BO-Kit: "Switch menggantikan pil status" | Switch + coloured status pill side by side ("Aktif" green, "Terjadwal" blue, "Berakhir", "Nonaktif") (`PromotionsTable.tsx:57-58`) | b | medium | `BO/screens/promotions/PromotionsTable.tsx` | build-gap | G6 |
| BO7-02 | Row meta | One meta line under the name: "Otomatis di kasir · Semua outlet · 25–30 Nov 2026" | Separate Jenis/Nilai/Periode columns; outlet scope not shown in the list at all; period as "03 Nov → 06 Des 26" / "— → ∞" | b | low | `BO/screens/promotions/PromotionsTable.tsx`, `promoDisplay.ts` | plan-gap | G6 |
| BO7-03 | Jenis tag colour | No type tag in the row; plan: category tags neutral | "Persentase" / "Bertingkat" in violet (`promo` token tone, `lib/labels/promotion.ts`) | c | Owner: is promo type a category (neutral) or keep violet as the promo colour | `BO/lib/labels/promotion.ts`, `BO/screens/promotions/PromotionsTable.tsx` |  |  |
| BO7-05 | Type selector | "Jenis Potongan" select ("Persentase (%)") next to "Nilai Diskon" on one row | 6-card type picker grid (Persentase, Nominal, Buy 1 Get 1, Beli X Gratis/Diskon Y, Bertingkat, Paket Bundel), then "Nilai" full width below | c | Owner: a select would hide the six types' descriptions; keep the cards or follow the board | `BO/screens/promotions/PromoTypeFields.tsx` |  |  |
| BO7-06 | Value field | Label "Nilai Diskon (1% – 100%) *"; error under it "Maksimal 100% untuk tipe persentase, dan wajib > 0." | Label "NILAI" with no range and no required mark, prefilled "0"; errors "Nilai harus lebih dari 0." / "Persentase tidak boleh lebih dari 100." (`promotionForm.ts:145-146`) | b | low | `BO/screens/promotions/PromoTypeFields.tsx`, `promotionForm.ts` | plan-gap | G6 |
| BO7-07 | Error summary wording | "Tidak dapat menyimpan promosi:" / "Periksa 2 isian berikut sebelum menyimpan:" with full-sentence items; shown after a save attempt | Shared "Periksa isian berikut:" with links; promo items name only the field ("Nilai", "Nama promosi"); Simpan is disabled while problems exist (tooltip) (`ui/SlideOver.tsx:92-105`, `PromotionEditorHost.tsx:103`) | b | low | `BO/ui/SlideOver.tsx`, `BO/screens/promotions/promotionForm.ts`, `PromotionEditorHost.tsx` | plan-gap | G1+G6 |
| BO7-08 | Duplicate phone | Blocking error in the summary: "Nomor ini sudah dipakai oleh Reffy (0812-3456-7890)." | Non-blocking warn line under the field: "⚠ Nomor ini sudah dipakai oleh X. Tetap bisa disimpan; akan masuk antrean Duplikat." (from source `CustomerFormSlideOver.tsx:44`) | a | Owner CRM policy "soft phone-dupe" (never blocks; Duplikat queue, SP-CRM-Merge) | `BO/screens/customers/CustomerFormSlideOver.tsx` |  |  |
| BO7-09 | Phone rule hint | "Hanya angka 9–15 digit. Deteksi duplikat otomatis memeriksa awalan 08 dan +628." | "Nomor Indonesia (0812… / +62…) atau internasional (+65…)" (from source `CustomerFormSlideOver.tsx:42`); international numbers are accepted | c | Owner: the board's 9–15-digit Indonesian-only rule conflicts with today's international-phone support; choose rule and copy | `BO/screens/customers/CustomerFormSlideOver.tsx` |  |  |
| BO7-10 | Copy (from source) | Title "Tambah / Ubah Pelanggan"; "Nama Lengkap *", "Nomor Telepon (WhatsApp) *", "Email (Opsional)"; primary "Simpan Pelanggan" | "Tambah Pelanggan" / "Edit Pelanggan" (promo form says "Ubah Promosi"); "Nama *", "No. Telepon *", "Email"; primary "Simpan" (`CustomerFormSlideOver.tsx:30-46`) | b | low | `BO/screens/customers/CustomerFormSlideOver.tsx` | plan-gap | G6 |
| BO7-11 | Slide-over close control | × top right inside a grey filled rounded square | × top right, transparent; background only on hover (`ui/SlideOver.tsx` close button `hover:bg-paper-1`) | b | low | `BO/ui/SlideOver.tsx` | plan-gap | G1 |

### BO8 · Operasional dan sistem (board)

Restyled on the kit. ERP shows a plain reason with the raw error tucked away, and the sidebar shows the red ERP count. Log Kesalahan still shows raw English messages, and "Permission" appears where the mock says "izin akses". The single "Masalah" panel (M-6) and header-only outlet scope (M-5) are deferred.

| ID | Element | Mock | Built | Class | Cite / severity / decision | Owning file(s) | Gap | Slice |
|---|---|---|---|---|---|---|---|---|
| BO8-01 | One "Masalah" panel | One table "Tinjauan Sinkron, Integrasi ERP & Log Kesalahan" with a Sumber column (ERP Outbox / Sinkron POS) and an "11 Dokumen ERP Gagal" pill | Three separate pages (Tinjauan Sinkron, Integrasi ERP, Log Kesalahan); red ERP count is in the sidebar (D-103 done) | a | M-6 (D-99) deferred | `BO/screens/syncReview/*`, `BO/screens/integration/*`, `BO/screens/ErrorLogs.tsx` |  |  |
| BO8-02 | Row actions and technical detail | Aksi column inline: "Kirim Ulang" (secondary) / "Tinjau" (gold primary); "▾ Lihat detail teknis" inline under the summary | No action column; a row click opens a detail panel holding "Detail teknis" and "Kirim ulang" with a confirm (`ErpOutboxDetail.tsx:101-122`); Sinkron rows open their detail | c | Owner: inline actions (board, likely with M-6) vs keep them in the row's detail panel | `BO/screens/integration/ErpOutboxScreen.tsx`, `ErpOutboxDetail.tsx`, `BO/screens/syncReview/SyncReview.tsx` |  |  |
| BO8-03 | Row reason + status | Neutral summary text ("Transaksi ditolak server (422)…") + warn pill "● Perlu Ditinjau" | Reason in red text ("Ditolak: tidak berwenang / PIN salah", `SyncReview.tsx:121`); no status pill | b | low | `BO/screens/syncReview/SyncReview.tsx` | plan-gap | G6 |
| BO8-04 | Message text | "Ringkasan masalah (Bahasa Indonesia)" | Raw English message "order rejected" in Pesan (`ErrorLogs.tsx:81` renders `e.message`); only kind/source are mapped. Messages are free text, so this needs a code→label map, with the raw text kept under "Detail teknis" | b | medium | `BO/screens/ErrorLogs.tsx`, `BO/lib/labels/errorSource.ts` | build-gap | G6 |
| BO8-05 | Built-in roles | Read-only tags "Admin · Semua Akses (Bawaan)", "Manajer · Operasional & Persetujuan (Bawaan)", "Kasir · POS & Shift (Bawaan)" | Manajemen Role lists custom roles only ("Supervisor D5") | a | D-106 deferred | `BO/screens/Users.tsx`, `BO/screens/users/*` |  |  |
| BO8-06 | "Permission" wording | "izin akses" ("wajib memilih ≥ 1 izin akses") | English "Permission" in the users-table header and the Tambah Pengguna field label, and "1 permission aktif" on role cards | b | low | `BO/screens/users/userColumns.tsx`, `AddUserModal.tsx`, `BO/screens/Users.tsx` | plan-gap | G6 |
| BO8-07 | Outlet scope | "Cakupan Header Tunggal (#20)": header select only | Page-level "Outlet: Semua outlet" select next to the header's "Semua Outlet" (Permintaan and Shift already read "Cakupan: … mengikuti pilihan di header") | a | M-5 (D-99) deferred | `BO/screens/approvals/ApprovalQueue.tsx`, `BO/screens/syncReview/SyncReview.tsx` |  |  |

## 6. Limits of this audit

- Desktop Chromium screenshots, not the tablet's WebView: font weights render as on desktop (D-88), and real-device fit was judged at the measured 1006×601 CSS viewport.
- Synthetic data: product names, counts and prices are fixture values; differences caused only by data were not counted.
- Not reached, judged from source: the Tambah/Ubah Pelanggan and Tambah Pengguna slide-overs, the receive-transfer detail (no inbound transfer in the fixture), the Koneksi "Perlu ditinjau" card, the manual-discount block, the after-close recap card, the Pengaturan page top (gate shots are scrolled), the BO2 error state.
- The 768 px backoffice gate shots catch the sidebar drawer mid-transition (300 ms slide vs a two-frame wait in `shots.ts`), so the 768 drawer and scrim could not be judged; at 375 px they are correct.
- Mocks were rendered with the 2026-11-06 stand-in `support.js`; it reproduces the mocks' templates and defaults but is not the design tool's own runtime.

## 7. How the captures were made (reproducible, not committed)

- Mocks: `cd docs/design-kaca/screens && python -m http.server 8765 --bind 127.0.0.1`, then a Playwright script screenshots each `.dc.html` at `window.__dc.preview`, full page.
- Built: `corepack pnpm browser:ci --output <dir>` (passed; writes every `captureShot`), plus a throwaway spec with its own Playwright config that imports `tests/browser/fixture.ts` and `setupPos` and reaches the other states. Neither script is in the repo or in CI; both lived under the gitignored `artifacts/` folder.
