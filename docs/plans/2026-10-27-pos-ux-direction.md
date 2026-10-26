# Arah UI/UX POS Mandalika — dokumen arah desain (2026-10-27)

Status: **direction approved by the owner on 2026-10-27 with amendments (see the D-register), no code changed.** Branch `claude/pos-ux-direction-2026-10-27` (off `prod-hardening`). Nothing is built before the ERP demo on 2026-11-02; the owner has a **POS polish window of 2026-11-02 to 2026-11-07** if the POS is not part of the 2 Nov demo, and wants the items that this document first deferred ("No", "Skip in v1", "Later") pulled into that window.

Scope: the POS cashier app (`apps/pos/src`, Capacitor + React, Android tablets 10-11 inch in landscape, offline-first, OTA via Capgo) first, then the web backoffice (`apps/backoffice/src`). The product is a template for three perfume brands (Mandalika, Flamboyan, Performance Perfume), so every visual decision below is expressed as tokens that can be re-skinned per brand.

How to read: section 1 is what exists today (read from the code, with `file:line`). Section 2 is what cashiers already know from other POS products (cited). Section 3 is the recommended POS direction. Section 4 is the backoffice. Section 5 is the phased plan. Section 6 is tooling. Every assumption that the owner must confirm is tagged **D-n** and collected in the register at the end.

---

## 0. Ringkasan untuk pemilik (TL;DR)

- **The cashier screen is already the right shape** (catalog left, cart right, one primary Bayar). The problems are density, size and vocabulary, not structure. Most of the fix is a restyle that ships over OTA without touching the SyncEngine.
- **Ten frictions dominate** (section 1.3): sub-44 px touch targets on the hot path, 10-11 px fixed text that the font setting cannot scale, a 3-tap variant popup that starts every size at 0, a wrong "Stok habis" warning, silent wipes of promos/customer/cart, six words for "discount" behind two buttons, two offline indicators that disagree, a parked sale that only turns a chip red, whole-order-only refunds buried 9 taps deep, and a printed receipt that does not match the screen.
- **Recommended direction: "Kertas & Emas"** (paper and gold): warm-paper surfaces, ink-black text at 16 sp minimum, one gold reserved for the primary action and brand, and a strict semantic palette for state (stock, offline/sync, promo, reward) that is never gold. Big tiles, a persistent customer chip, a single "Promo & Diskon" door, one connection-and-queue chip, and a Bayar bar that always shows the total.
- **Evidence from the market** (section 2): Majoo, Moka, Qasir, Square, Shopify, Toast, Loyverse and Lightspeed converge on 14 patterns; we already do 8 of them structurally and do the offline ones better than the Indonesian vendors. The gaps are the tender screen, the variant sheet, the line-edit sheet, and visible per-order sync state.
- **Plan**: Figma mocks before the demo (Fase 0); in the 2-7 Nov polish window the 4 OTA-safe restyle slices plus held orders, blind count and the denomination counter (about 7 sessions); then 3 UI-flow slices inside the POS web layer (about 6 sessions, reviewed against the cart reducer); then data/flow slices that touch SyncEngine, stock, the receipt schema or tender invariants, including split tender (about 11 sessions). Backoffice follows in 4 slices (about 9 sessions). Total about 34 sessions. Section 5 has the order and the first three things to do.

---

## 1. Inventaris layar POS saat ini

Source of truth: `apps/pos/src` (paths below are relative to it), `packages/sync/src`, `packages/printer/src`, read on 2026-10-27 at `prod-hardening` `40be0691`. Stack: React 19, Tailwind v4 (CSS-first, no `tailwind.config`), Capacitor 8. All copy is inline Indonesian with English leaks; there is no i18n layer. There is no router: one adaptive `cashier/CashierScreen.tsx` with the header, the product panel and a 320 px cart column (`:1090`) that mounts only after the first item is added; everything else is a modal or sheet opened from the hamburger `cashier/MenuDrawer.tsx`. Android Back is hand-managed (`CashierScreen.tsx:947-964`).

### 1.1 Layar dan alur (one line on what the cashier must understand)

| Screen / flow (label the cashier sees) | Files | How reached | What the cashier must understand | Offline? |
|---|---|---|---|---|
| Masuk (login) | `App.tsx:10-132` | No session | Email + Kata Sandi. | Online (`auth.tsx:146`) |
| "Akun belum terikat ke outlet" | `App.tsx:134-152` | Non-admin account without outlet | Cannot sell; call admin. | Static |
| Pilih outlet terminal ini (device binding) | `screens/OutletPickScreen.tsx` | Admin account on an unbound tablet | Choice is permanent until "Lepas terminal" in Pengaturan. | Online |
| Outlet akun berbeda dengan terminal | `screens/OutletMismatchScreen.tsx` | Account outlet ≠ bound outlet | Sales disabled, queue still drains, release only online with empty queue (`:33-38`). | Flush-only |
| Terminal / Lepas terminal | `screens/TerminalSection.tsx`, `SettingsScreen.tsx:367` | Menu → Terminal | Releasing logs out; only online with no unsent sales (`:66-67`). | Online |
| Header: Buka Shift / Shift Aktif / Tutup | `cashier/ShiftBar.tsx` | Always | No shift, no sale (`CashierScreen.tsx:328-332`). "Tutup" here closes the **shift** via Rekapan. | Open = online (`hooks/shiftView.ts:9-10`); close queued but blocked if the open is unsynced (`:11-12`) |
| Buka Shift Baru modal | `ShiftBar.tsx:159-196` | Buka Shift, or any sell attempt without a shift | Enter "Uang awal (kas)". | Online |
| Rekapan / Riwayat shift | `cashier/ShiftRecapPanel.tsx` | Menu → Rekapan, header Tutup | Enter "Terhitung" per payment method before "Tutup Shift" (`:358`); prints Rekap Shift. | Loads online with stale notice |
| Katalog (grid) | `cashier/ProductGrid.tsx` | Default screen | Tap a card to add; chips Semua / categories / ♥ Favorit; search or scan; long-press 200 ms to reorder (`:221-226`); 4 columns default. Price and stock are **hidden by default** (`CashierScreen.tsx:117-118`). | Yes (snapshot) |
| Scan | `ProductGrid.tsx:286-296`, `CashierScreen.tsx:370-417` | Search field Enter (wedge) or camera icon | Unknown code → toast "Kode tidak dikenal". | Yes |
| Variant popup (size picker) | `ProductGrid.tsx:362-416` | Tap a product with >1 variant | Every size starts at 0 (`:249-251`); "Tambah ke Keranjang" disabled until ≥1. | Yes |
| Keranjang (cart) | `cashier/Cart.tsx` | After first item | +/- qty, × remove, "Hapus semua" (no confirm); order-level Catatan / Diskon / Promo buttons; Bayar. | Yes |
| Catatan Order | `cashier/AdjustmentDrawer.tsx:52-77` | Cart → Catatan | Order-level note only (no per-line notes). | Yes |
| Diskon / Surcharge (manual) | `AdjustmentDrawer.tsx:79-136` | Cart → Diskon | Persen/Nominal; replaces rather than stacks (`cashierReducer.ts:412-428`); no PIN/authorization step in UI. | Yes |
| Promo & Kode Diskon | `cashier/PromoPanel.tsx` | Cart → Promo | Applied list with savings; "Kode Promo" + Pakai; "Promosi Aktif" cards (percentage, fixed, BOGO, buy-X-get-Y, Bertingkat, Paket Bundel) with "Bisa digabung / Tidak digabung" (`:37-49`); red reason when unavailable (`:337-343`); tiered hint "Belanja X lagi…" (`:383-395`). | Yes, local `promoValidate.ts` |
| Stacking toggle | `cashierReducer.ts:450-529` | Tap a promo card | A non-combinable promo silently replaces the whole set (`:483-492`); tap again to remove. | Yes |
| Pilih Hadiah (BXGY reward picker) | `cashier/BxgyRewardModal.tsx` | Applying a separate-set buy-X-get-Y | Pick exactly N gifts, capped by stock (`:63-70`); Terapkan. Opens **on top of** PromoPanel. | Yes |
| Pilih Item Paket (bundle slots) | `cashier/BundleSlotPicker.tsx` | Applying an ambiguous bundle | Fill each "Slot N". Also on top of PromoPanel. | Yes |
| Hadiah Loyalti | `cashier/CheckoutPanel.tsx:200-304` | Inside checkout, only with customer + loyalty on | Collapsed by default; expand, pick a variant; adds a Rp0 line. | **Online-only** (`CashierScreen.tsx:290-296,442`) |
| Tukar Poin Loyalti | `CheckoutPanel.tsx:306-346` | Checkout, customer with points | Redeem points for money; "Semua". | Not gated (snapshot points) |
| Pelanggan (lookup/attach) | `cashier/CustomerPicker.tsx`, `customerFinder.ts` | Top of product panel, always visible | Phone number ≥ 8 digits, Cari or Enter, "+ Baru". Attaching **strips reward lines and bundle/BXGY promos** (`cashierReducer.ts:378-397`). | Server lookup online; tablet memory offline (`customerFinder.ts:52-56`); create queued |
| Konfirmasi Pembayaran (checkout) | `cashier/CheckoutPanel.tsx` | Cart → Bayar | Method grid (default = first enabled, `:323`); blank cash = exact (`tender.ts:15`); quick-amount chips; Kembalian / Kurang; optional "Sales". No split payment, no card/QRIS reference field. | Yes (outbox) |
| Stok Tidak Mencukupi (override) | `CheckoutPanel.tsx:459-513` | Konfirmasi when `allowNegativeStock` is false (`stock.ts:37-57`) | Batal / Lanjutkan. Default setting is true (`CashierScreen.tsx:83`), so rarely seen. | Yes |
| Pembayaran Berhasil (receipt preview) | `cashier/ReceiptPreview.tsx` | After ORDER_SUCCESS | Auto-print if a printer is paired (`CashierScreen.tsx:762`); Cetak Ulang; Tutup / Transaksi Baru both reset everything. | Yes |
| Print | `printer.tsx`, `packages/printer/src/escpos.ts` | Auto or reprint | BLE ESC/POS 58 mm, 32 columns. No share/PDF/WhatsApp. | Local BLE |
| Riwayat Transaksi | `cashier/OrderHistoryPanel.tsx` | Menu → Riwayat | Date range (defaults to the shift's day), search, expand, Cetak Ulang, Refund Transaksi Ini. | Online GET with cached fallback and amber notice (`:87-102`) |
| Struk di Tablet Ini | `cashier/LocalReceiptsPanel.tsx`, `localReceipts.ts:15-20` | Menu | This tablet's sales with badges Belum tersinkron / Perlu ditinjau / Tersinkron / Refund menunggu / Sudah direfund; reprint; refund. 7 days or 500 receipts (`receiptArchive.ts:7-8`). | Fully offline |
| Refund Order | `cashier/RefundDialog.tsx`, `refundView.ts` | History or local receipt | **Whole order only**; typed reason required; needs permission and a synced open shift (`refundView.ts:50-59`). | Queued; 12 h lock |
| Stock awareness | `cashier/stock.ts`, `ProductGrid.tsx:117-175`, `CashierScreen.tsx:239-243,342-366` | Always | Card stock = server stock minus unsynced sales (`engine.ts:993-1016`); "Habis" badge; oversell is never blocked (A44), only warned. | Yes |
| Uang Masuk / Keluar | `screens/SettingsScreen.tsx:369-424` | Menu | Kas Masuk/Keluar + amount + Keterangan. | Queued; 12 h lock |
| Pengaturan Cetakan | `SettingsScreen.tsx:250-364` | Menu | Pick bonded printer, Tes Cetak, Hapus Printer (no confirm). | Local |
| Pengaturan Tampilan Produk | `SettingsScreen.tsx:198-246` | Menu | Ukuran Font SM/MD/LG (scales rem root only), columns 2/3/4/6, toggles Harga/Stok/Varian. | Local |
| Terima Transfer | `cashier/receive/*` | Menu (red dot if inbound) | Count received vs sent, reason for discrepancy, approver + PIN. | Receive queued; PIN approval online |
| Tanda terima siap | `cashier/transfers/TandaTerimaPrompt.tsx` | Engine callback, auto-pops (`CashierScreen.tsx:223-234`) | Print slip. Can land **over a sale in progress** (z-70). | Needs printer |
| Permintaan Barang | `cashier/requisitions/*` | Menu (permission `request_stock`) | Draf → Diajukan → Disetujui/Ditolak → Transfer Dibuat → Dikirim → Diterima; "Simpan Draf" vs "Simpan & Ajukan". | **Online-only** (`requisitionFlow.ts:11,72`) |
| Sync chip + popover | `components/SyncStatus.tsx` | Header | See 1.4. There is no sync screen, only a w-72 popover. | n/a |
| Per-sale giveaway (canvas bag) | **not present in POS UI** | n/a | Server decrements one unit per completed order (`backend/internal/service/ledger_hooks.go:180-190`); the tablet never shows or subtracts it (`engine.ts:993-1016` sums order lines only). | Server-side |
| OTA update prompt | **not present** | n/a | Capgo `autoUpdate: true` (`capacitor.config.ts:44-49`), `otaNotifyReady()` at boot (`native.ts:59-67`). The chip's "Pembaruan tersedia" is reference data, not an app update. | Silent |

Not present in code (stated so nothing is assumed): split payment, payment reference for card/QRIS/transfer, per-line notes, per-line refund, held orders (the menu item "Ambil Pesanan" only closes the menu, `MenuDrawer.tsx:127`), the strings "voucher", "retur", "member".

### 1.2 Jumlah ketukan hari ini (from the catalog, shift open)

| Task | Taps | Path |
|---|---|---|
| Sell one variant product, cash, exact, print | **5** (+1 to dismiss) | card → "+" on size (starts at 0) → Tambah ke Keranjang → Bayar → Konfirmasi; print is automatic if paired. Single-variant product: 3. |
| Apply a promo code | 3 | Promo → code field → Pakai (panel auto-closes on success). Linked BXGY/bundle codes add a picker (+1 per pick, +1 Terapkan). |
| Attach an existing customer by phone | 3 online, 2 offline | phone field → type ≥8 digits → Cari → tap hit. Attaching after promos wipes bundle/BXGY/reward lines. |
| Give a loyalty reward | 2 inside checkout (7 total with the customer) | Bayar → expand collapsed card → tap variant chip → Konfirmasi. Online-only; never previewed in the cart. |
| Refund one line of yesterday's order | **not possible** (whole order only); 9 via Riwayat, 5 via Struk di Tablet Ini | Menu → Riwayat → Dari → date dialog → OK → expand → Refund Transaksi Ini → type reason → Konfirmasi Refund. Cancelling the dialog does not return to the list (`CashierScreen.tsx:1219,1239`). |
| Check whether the outbox has unsynced sales | 0 online, 1 offline | Online the chip reads "Menyinkronkan N…"; offline it reads only "Offline" with no count (`SyncStatus.tsx:117`), the count is inside the popover button "Kirim N antrian sekarang". |

### 1.3 Sepuluh friksi terbesar (evidence, why it hurts, fix class)

Fix class: **R** = pure restyle/copy (no behaviour change, OTA-safe, no reducer); **F** = UI flow change inside the POS web layer (touches `CashierScreen`/`cashierReducer`, OTA-safe, needs reviewer); **S** = touches SyncEngine, stock paths, receipt schema or backend.

1. **Undersized hot-path touch targets.** Cart qty +/- and remove are 24 px (`Cart.tsx:130,141,147`), applied-promo remove 16 px (`:207,221,244`), variant +/- 28 px (`ProductGrid.tsx:385,394`), bundle/BXGY +/- 20 px (`BundleSlotPicker.tsx:226`, `BxgyRewardModal.tsx:170`), the header shift "Tutup" about 22 px high next to the logo (`ShiftBar.tsx:104`). A standing cashier with one hand on the tablet mis-taps the sale itself. **R.**
2. **Micro-text that does not scale, and price/stock hidden by default.** Card price `text-[11px]`, stock and Habis badge `text-[10px]` (`ProductGrid.tsx:141,155,169,172`) are literal px, so "Ukuran Font LG" (root rem only, `CashierScreen.tsx:916-920`) never enlarges the numbers that matter; price and stock toggles default off (`:117-118`). **R** (+ default flip, **D-9**).
3. **Variant popup: 3 taps and every size starts at 0.** `ProductGrid.tsx:249-251,385-413`. The most common perfume sale (one bottle, one size) costs card + "+" + Tambah, and the popup does not show which size is in stock until opened. **F** (local to ProductGrid; no reducer semantics change if "tap size = add 1").
4. **Oversell wording and the single 3-second toast.** "Stok habis - tetap ditambahkan, dicatat sebagai stok minus" (`stock.ts:60`) fires whenever `inCart + add > stock` (`:68-70`), including when 1 is left and 2 are added; the toast slot is one message for 3 s (`CashierScreen.tsx:204-207`). **R.**
5. **Silent destructive clears.** The confirm-time re-guard clears **all** promos with a toast (`CashierScreen.tsx:616-695`); `SET_CUSTOMER` strips reward lines and bundle/BXGY promos (`cashierReducer.ts:378-397`); "Hapus semua" wipes cart, customer, promos and note with no confirm (`Cart.tsx:87-92`, `cashierReducer.ts:359-376`). **F** (confirm/undo; per-promo removal).
6. **Six words and two doors for "discount".** Cart has "Diskon" (manual) and "Promo" (`Cart.tsx:179,189`); a typed code is "Kode Promo" (`PromoPanel.tsx:240`), "Kode diskon" (`CashierScreen.tsx:660`), "Kode:" (`Cart.tsx:218`); the reduction is "Potongan", "Diskon", "hemat", "Total Promo" vs "Total Diskon" (`PromoPanel.tsx:54,63,379`, `Cart.tsx:231,254`); rewards are split between checkout (online-only loyalty) and modals (BXGY). The cashier must know which button a code, a promo, a manual discount, points and a free gift belong to. Copy **R**; single entry point **F**.
7. **Two offline indicators that disagree, and vague sync labels.** A grey "Offline" pill (`CashierScreen.tsx:998-1006`, text-gray-400 on gray-100) sits beside an amber "Offline" chip (`SyncStatus.tsx:116-123`); offline the chip hides the pending count (`:117`); "Pembaruan tersedia" (`:140`) means reference data, not an app update; "Sinkronkan" in the menu is a data **pull** while "Kirim N antrian sekarang" is the **push** (`MenuDrawer.tsx:135`, `SyncStatus.tsx:199`); the receipt preview's "Menunggu sinkronisasi" keys off the **global** pending count (`ReceiptPreview.tsx:85-93`, `CashierScreen.tsx:1160`), so an earlier pending sale hides this sale's number. The cashier cannot tell "my sale is safe on the tablet" from "something is wrong". **R** (per-sale state reads `engine.localReceipts()`, no engine change).
8. **A parked sale is silent and its text is raw.** Dead-letter (`attempts >= 5`, `outbox.ts:65`) only turns the chip red "Perlu ditinjau" (`SyncStatus.tsx:124-126`); the popover shows raw `lastError` (`:51-53`); `onDeadLetter` reports to the backoffice error log but never toasts the cashier (`SyncProvider.tsx:83-102`); "Coba lagi" re-queues everything (`:211-216`). **R** for visibility and wording; per-item retry is **S**.
9. **Refund is whole-order only and buried.** `RefundDialog.tsx:48-60`, `refundView.ts:67-80` (payload has no items); 9 taps via Riwayat; gate reasons are muted 11 px text (`RefundAction.tsx:16`). Refunding one wrong item of a three-item sale refunds all three. Shortcuts, reason presets and gate text **R/F**; per-line refund **S** (payload, server stock restore, sync schema).
10. **The printed receipt disagrees with the screen.** Reward lines print "0" (`receiptQuote.ts:104-110` → `escpos.ts:159`) where the screen says GRATIS (`ReceiptPreview.tsx:127`); `ReceiptData` has no surcharge or redeemed-points fields (`escpos.ts:26-42`, `receiptQuote.ts:111-116`) although `total` includes them (`CheckoutPanel.tsx:157,167-172`); "Diskon" prints with no promo name (`escpos.ts:164-166`); with no paired printer the sale completes with no hint (`CashierScreen.tsx:762`). The customer's slip may not add up. **S** (receipt quote is queued with the order and stored server-side; schema check).

Also recorded: modal-on-modal stacking (BXGY/bundle pickers z-60 over PromoPanel z-40, `BxgyRewardModal.tsx:98`, `PromoPanel.tsx:152`; overstock confirm z-60 over checkout z-50; TandaTerimaPrompt z-70 from an engine callback over anything), and Android Back ignoring the variant popup, the pickers, the overstock confirm, the receive modal and the SyncStatus popover (`CashierScreen.tsx:947-964`). Design tokens today: only `--color-indigo-*` remapped to gold `#b07d18` (`index.css:3-15`); no font declared; no spacing/radius/type tokens; no shared component library (`components/` holds `Skeleton.tsx` and `SyncStatus.tsx`; the modal shell is copy-pasted in about 14 files; `PAYMENT_LABELS` duplicated in 4 files; emoji used as icons in 7 places).

### 1.4 Apa yang mesin sinkron tahu vs apa yang kasir lihat

| Engine state | Defined | Shown to the cashier? |
|---|---|---|
| OutboxStatus `pending` / `failed` (<5 attempts) | `packages/sync/src/outbox.ts:27` | As a count, or "Tertunda" (online only, `SyncStatus.tsx:110`) |
| `failed` with `attempts >= 5` (parked) | `outbox.ts:65` | Red "Perlu ditinjau" chip; no toast |
| `sent` / `acked` | `outbox.ts:27` | No |
| WallState.raised | `engine.ts:38-43` | "Pembaruan tersedia"; Cart hard-codes `wallRaised={false}` (`CashierScreen.tsx:1108`) so its label is dead |
| OfflineLevel `unknown` / `ok` / `warn` (10 h) / `locked` (12 h) | `offlineContact.ts:25`, `offlineCap.ts:20-25` | `warn` and `locked` only; the lock text is about 190 characters in a 3 s toast |
| FailureKind `offline` / `unauthorized` / `transient` / `rejected` / `account` | `engine.ts:170` | Only `account` ("Masalah akun/outlet") |
| ResyncStatus `applied` / `stale` / `deferred` | `engine.ts:279` | No |
| LocalReceipt.state `queued` / `parked` / `synced` | `engine.ts:252` | Only inside Struk di Tablet Ini |

Reachability is a real probe (`engine.isReachable()`, `useOfflineData.ts:85-103`) polled every 12 s by the engine (`SyncProvider.tsx:197`) and read every 2 s by the UI (`useOfflineData.ts:144-163`). That plumbing is sound; the presentation is the gap.

---

## 2. Riset: apa yang sudah dikenal kasir (web research)

Method: two research passes on 2026-10-27 over official help centers, product pages and app-store listings; where an official page refused the fetch, a search-result excerpt of that page is used and tagged **[snippet]**. **[3P]** is a third-party source. **UNVERIFIED** means no source was found and the point is not used as evidence. No screenshots were inspected, so layout claims come from prose.

### 2.1 Produk POS Indonesia

| Product | What the cashier screen does (evidence) | Notable for us |
|---|---|---|
| **Moka POS (GoTo)** | Top menus POINT OF SALE / SHIFT / ACTIVITY; cart "Keranjang Belanja"; items from Library or Favorite; search by name or SKU; tap a cart line to change qty, variant, modifier, discount, note; checkout = Charge → method → Charge → Print/Send (about 3 taps); Save Bill / Billing List; refund from ACTIVITY with "Reason For Refund"; shift = Starting Cash → End Shift → Actual Ending Cash → Print Summary: https://help.mokapos.com/materi-8-menggunakan-aplikasi-moka . Discounts item or whole cart: https://help.mokapos.com/s/article/900000441563?language=in . PIN-gated discounts [3P]: https://www.hashmicro.com/id/blog/review-aplikasi-moka-pos/ | The owner's reference. Mixed English/Indonesian labels. Offline indicator UNVERIFIED. |
| **Majoo** (best documented) | "Mode Grid": category column on the LEFT (collapsible), large tiles, pseudo-categories Semua kategori / Favorit / Produk Paket / Promo; bill on the RIGHT; "+Pelanggan" top-right; "Promosi" bottom-right: https://majoo.id/panduan-pengguna/detail/52 , https://majoo.id/panduan-pengguna/detail/303 . "Mode SKU" list for retail: https://majoo.id/panduan-pengguna/detail/53 . Cash: method list left, "Uang Pas", "Lainnya" preset nominals, "Custom" keypad, total / sisa tagihan / kembalian at top: https://majoo.id/panduan-pengguna/detail/65 . Promosi → Promo / Kupon (code + validity checkmark) / Poin (Total Tagihan or Gratis Produk → Tukar Poin): https://majoo.id/panduan-pengguna/detail/263 , https://majoo.id/panduan-pengguna/detail/302 , https://majoo.id/panduan-pengguna/detail/303 . Offline status "Status: Online/Offline" + "Local Server" top-left: https://majoo.id/panduan-pengguna/detail/53 . Tutup Kasir with PIN and "Laporan Tutup Kasir": https://majoo.id/panduan-pengguna/detail/340 | Closest Indonesian model for our layout and vocabulary (Bayar, Uang Pas, Kembalian, Promosi, Kupon, Poin, Buka/Tutup Kasir). |
| **Pawoon** | Manual discount via three-dot → Diskon → Simpan; special promos need the "Memberikan Diskon" right; automatic promos fire on add [snippet]: https://help.pawoon.com/hc/id/articles/360001768815-Transaksi-Menggunakan-Diskon-Manual . Offline: transactions stored, manual "Update Data" sync; finish "Tersimpan" orders before Rekap Kas: https://www.pawoon.com/faq/ , https://news.dailysocial.id/post/penggunakan-aplikasi-kasir-pawoon/ | Manual-sync is the anti-pattern we avoid. "Rekap Kas" term. |
| **Olsera** | "Diskon Pesanan" with $ / % icons → Simpan: https://crm.olsera.co.id/knowledge-base/article/cara-membuat-diskon-transaksi-manual-dari-aplikasi-pos-olsera . POS Pass Keys (6-digit) per action: void, paid-order management, manual discount, customer management: https://crm.olsera.co.id/knowledge-base/article/cara-mengatur-pass-key-atau-password-pada-aplikasi-kasir-olsera-pos-pos-pass-key . Customer attach required/optional, PIN on points redemption, shift cannot close with pending orders: https://apps.apple.com/id/app/olsera-point-of-sale-v2/id1172633730?l=id | Per-action PIN and "block close while pending" are directly reusable. |
| **Qasir** | Phone-first; "Cari Produk", camera barcode; variant chosen BEFORE Add to Cart; payment page: enter amount given, quick-amount buttons, "Uang Pas", Tender (change): https://www.qasir.id/tutorial/record-your-transaction-with-qasir , https://bantuan.qasir.id/id/articles/1444114-menggunakan-fitur-transaksi-kasir-digital . Offline rows stay in "Riwayat Transaksi" until synced (same tutorial). Rekap Kas: Buka Kasir → Kas Masuk/Keluar → Tutup Kasir → "Penerimaan Aktual", optional blind count: https://bantuan.qasir.id/id/articles/5756416-rekap-kas-di-aplikasi-qasir | Choose-variant-first; quick-cash chips; blind count. |
| **iReap POS Pro** | Per-product discount by tapping the line (admin/manager/supervisor only); whole-sale "Dokumen Diskon" before payment: https://www.ireappos.com/id/how-to-ireappos-pro/cara-menambah-diskon-per-produk-saat-melakukan-transaksi-di-aplikasi-kasir-android-ireap-pos-pro.php . Referenced retur requires online: https://www.ireappos.com/id/how-to-ireappos-pro/kasir-toko-mobile-android-ireap-pos-bagaimana-membuat-transaksi-pengembalian-retur-penjualan.php | Role-gated discounts; online-only refund precedent. |
| **Kasir Pintar** | Category buttons narrow the list; search; barcode icon; tap/long-press item → Edit pop-up (+/- qty, + Addon, temporary price, per-qty discount, short note); payment page fields Pelanggan / Keterangan / Diskon / Pajak / Metode; quick amounts on the keypad: https://help.kasirpintar.co.id/knowledge-base/cara-melakukan-transaksi-penjualan-kasir-pintar-pos/ . Retur from Laporan Penjualan with reason, partial, restock [snippet]: https://help.kasirpintar.co.id/knowledge-base/cara-melakukan-retur-transaksi-penjualan-kasir-pintar-pos/ . "Mode Wajib Online" setting [snippet]: https://apps.apple.com/app/id1594336570 | One line-edit sheet for everything; "tukar poin menjadi barang". |

### 2.2 Referensi global

| Product | Evidence used | Notable for us |
|---|---|---|
| **Square (Retail)** | Grid pages + search (keyword/UPC/SKU) + barcode; quantity bar; item-details screen for variations with modifier auto-advance; swipe-to-delete cart lines: https://squareup.com/help/us/en/article/8238-build-your-customer-s-cart-in-the-square-retail-pos-app . Discounts: "Apply automatically" toggle, passcode-gated, % on item or sale, amount on sale only: https://squareup.com/help/us/en/article/6606 . Offline: automatic, top banner with countdown, "pending" rows, declines invisible until reconnect, pending lost on sign-out: https://squareup.com/help/us/en/article/7777-process-card-payments-with-offline-mode . Refund: Transactions → Issue refund → items/amount → reason: https://squareup.com/help/us/en/article/6116 . Rewards prompt at checkout or Library → Rewards [snippet]: https://squareup.com/help/ie/en/article/5522-apply-rewards-to-purchases | Offline banner + per-record "pending"; auto-vs-manual discount split. |
| **Shopify POS** | Split-screen tablet home (grid beside an always-visible cart): https://changelog.shopify.com/posts/shopify-pos-split-screen-home-layout-for-tablet . Smart grid pages, tiles for products/collections/discounts, per-variant tiles (11.17): https://help.shopify.com/en/manual/sell-in-person/getting-started/smart-grid . Help page counts taps: cart discount ≈3, line discount ≈4: https://help.shopify.com/en/manual/sell-in-person/shopify-pos/process-sales-transaction . 11.10: suggested cash amounts first, change due inline, split = choose type then amount: https://www.shopify.com/hk-en/blog/shopify-retail-roundup-july-2026 . Offline orders carry "Payment pending" / "Paid" / "Card declined" badges; Connectivity screen bottom-left: https://help.shopify.com/en/manual/sell-in-person/shopify-pos/selling-offline/offline-payments . Combinable discounts, best wins: https://help.shopify.com/en/manual/sell-in-person/shopify-pos/discount-management/combining-discounts . POS extension rules: 44 px targets, 8 px gaps, <2 s response: https://shopify.dev/docs/apps/build/performance/point-of-sale | The only vendor that publishes tap counts and touch numbers. |
| **Lightspeed Retail X** | Quick Keys + search + scan [snippet]: https://x-series-support.lightspeedhq.com/hc/en-us/articles/25534062778651-Using-the-Retail-POS-Sell-screen . Offline after 2 min, status under the store name, Status page with "Retry errored sales", no name search offline, loyalty disabled offline [snippet]: https://x-series-support.lightspeedhq.com/hc/en-us/articles/25534272395163-Selling-in-offline-mode , https://x-series-support.lightspeedhq.com/hc/en-us/articles/25533948150043-What-causes-errored-sales . Register close with a denomination counter [snippet]: https://x-series-support.lightspeedhq.com/hc/en-us/articles/25534185400347-Opening-and-closing-a-register | A Status page with Retry is the model for our sync screen. |
| **Loyverse** | Tablet grid pages, default A-Z page: https://help.loyverse.com/help/how-arrange-sale-screen-loyverse . Variant dialog: https://help.loyverse.com/help/how-use-variants-items . Add client → Redeem points → appears under Discounts: https://help.loyverse.com/help/points-discounts . Offline: receipts marked "Unsynced", refund disabled offline, sign-out blocked while unsynced: https://help.loyverse.com/help/offline-work-of-pos . Shift with expected cash hideable [snippet]: https://help.loyverse.com/help/shift-management-loyverse-pos | "Unsynced" badge + sign-out guard; blind count. |
| **Toast** | Quick Order: check on the left, Print and Pay always visible, less-used actions in an overflow menu: https://support.toasttab.com/en/article/New-POS-Experience-Ordering-Screens . Quick cash computed from the total (21/25/30 for 20.43) plus exact: https://support.toasttab.com/en/article/Taking-Payments . Yellow "Offline Mode" banner after about 40 s that explains cause, allowed actions and resolution; receipts show "Pending": https://support.toasttab.com/en/article/Using-Toast-in-Offline-Mode | A banner that says what still works; the quick-cash algorithm. |

### 2.3 Empat belas pola yang disaring

Fit: **Strong** = adopt as is; **Adapt** = adopt with a perfume-counter twist; **Skip**.

| # | Pattern | Evidence | Fit for a perfume counter (30-50 SKUs × 2-4 sizes, landscape 10-11 in) |
|---|---|---|---|
| P1 | Catalog left, persistent cart right, no tab switching | Majoo Grid https://majoo.id/panduan-pengguna/detail/303 ; Shopify split-screen https://changelog.shopify.com/posts/shopify-pos-split-screen-home-layout-for-tablet ; Toast check panel https://support.toasttab.com/en/article/New-POS-Experience-Ordering-Screens ; Square [3P] https://community.squareup.com/t5/Archived-Discussions-Read-Only/Updated-iPad-checkout-screen-is-unreadable-and-unnecessary/m-p/376170/highlight/true | **Strong.** We already do this. No vendor publishes the ratio; we propose 62/38 and test (**D-1**). |
| P2 | Three parallel ways to add: tile, search, barcode | Square https://squareup.com/help/us/en/article/8238-build-your-customer-s-cart-in-the-square-retail-pos-app ; Lightspeed [snippet] (sell-screen URL above); Majoo "Cari" https://majoo.id/panduan-pengguna/detail/52 | **Strong.** 30-50 SKUs fit on one or two grid pages; search is the rare lookup; barcode matters once ERP barcodes are on bottles. |
| P3 | Favorit / pseudo-categories instead of category trees | Majoo https://majoo.id/panduan-pengguna/detail/52 ; Moka Library/Favorite (help URL above); Loyverse default A-Z page https://help.loyverse.com/help/how-arrange-sale-screen-loyverse | **Adapt.** One chip row: Semua · Terlaris · Promo · Paket & Hadiah · (categories). "Semua" is the A-Z fallback. |
| P4 | Variant chosen at add time, in one sheet showing price and stock per size | Qasir (tutorial URL above); Loyverse https://help.loyverse.com/help/how-use-variants-items ; Square item-details (8238 URL); Shopify per-variant tiles https://www.shopify.com/blog/retail-release-roundup | **Strong.** Sizes differ in price and stock. Tap size = add one. Option to promote the best-selling size to its own tile (**D-2**). |
| P5 | One line-edit sheet: qty, size, note, line discount, remove | Moka (help URL above); Kasir Pintar Edit pop-up (URL above); Lightspeed expand line [snippet] | **Strong.** Replaces the scattered 24 px +/- and 16 px × controls. |
| P6 | Checkout in 2-4 taps: Bayar → method → amount → Selesai | Majoo https://majoo.id/panduan-pengguna/detail/56 ; Moka Charge; Shopify tap counts (URL above) | **Strong.** One Bayar bar with the total on it. |
| P7 | Cash tender: quick-amount chips from the total + Uang Pas + keypad, change inline | Majoo https://majoo.id/panduan-pengguna/detail/65 ; Qasir; Toast https://support.toasttab.com/en/article/Taking-Payments ; Shopify 11.10 (roundup URL) | **Adapt.** IDR chips: Uang Pas · next 50k · next 100k · next 500k · 1.000.000 (**D-3**). QRIS/Transfer/Kartu in the same method list. |
| P8 | Automatic promos appear as labelled lines with no cashier action; manual discount and code entry share one door; combinability is an explicit rule | Square auto toggle https://squareup.com/help/us/en/article/6606 ; Shopify combining (URL above); Majoo Promosi → Promo/Kupon/Poin https://majoo.id/panduan-pengguna/detail/303 ; Pawoon auto promo [snippet] | **Strong.** The engine already has auto, code, stacking, BXGY, tiered, bundle. The UI job is one "Promo & Diskon" button and labelled cart lines. |
| P9 | Manual discount, refund and reward redemption are PIN or role gated, visibly | Olsera Pass Keys; iReap role gate; Moka PIN [3P]; Square passcode discounts | **Adapt, partially.** No permission gate exists today (HANDOFF slice 8b was never built) and the owner does not want one: it would slow the counter (**D-11**). Keep the PIN only where it already exists (refund approval, A06). Refund and reward gating follow the vendors; manual discount stays open to every cashier. |
| P10 | Customer is a persistent chip in the cart header; loyalty appears only after attach; a reward becomes a cart line | Majoo +Pelanggan / Ganti / Tanpa Pelanggan https://majoo.id/panduan-pengguna/detail/52 and Poin → Gratis Produk https://majoo.id/panduan-pengguna/detail/303 ; Loyverse https://help.loyverse.com/help/points-discounts ; Square rewards [snippet]; Olsera required/optional attach | **Strong.** Matches SP-CRM-9 (reward = Rp0 line). The chip should show tier and reward count without opening anything. |
| P11 | Offline is automatic and visible: one status chip, per-order state (queued / sent / failed), and a status page with Retry | Square (7777 URL); Toast banner (offline URL); Shopify badges + Connectivity (offline-payments URL); Lightspeed Status page [snippet]; Loyverse "Unsynced"; Majoo Status top-left https://majoo.id/panduan-pengguna/detail/53 | **Strong.** Indonesian vendors mostly leave this implicit; doing it well is a differentiator and our engine already exposes the states (1.4). |
| P12 | Explicit capability downgrade offline: online-only actions disabled with a reason, selling stays | Lightspeed [snippet]; Loyverse (refund disabled offline); Toast (loyalty unavailable); iReap referenced retur; Kasir Pintar "Mode Wajib Online" [snippet] | **Strong.** We already gate loyalty preview, requisitions and shift open online-only; the button should say so. |
| P13 | Guard rails: no sign-out / shift close while unsynced items exist | Loyverse (sign-out blocked); Square (pending lost on sign-out); Olsera (close blocked with pending orders); Toast (close blocked with open checks) | **Strong.** Already true for Lepas terminal; extend to Tutup Shift and Keluar with a count. |
| P14 | Refund from history, item-level, with reason + restock + authorization; shift close with counted cash and an optional blind count | Square https://squareup.com/help/us/en/article/6116 ; Shopify https://help.shopify.com/en/manual/sell-in-person/shopify-pos/order-management/complete-refund-orders ; Majoo https://majoo.id/panduan-pengguna/detail/381 ; Qasir blind count (rekap URL); Lightspeed denomination counter [snippet] | **Adapt.** Perfume refunds are rare and high value: PIN + reason preset + restock choice. Blind count and denomination counter are owner calls (**D-4**, **D-5**). |

Set aside: held orders (Majoo Daftar Order, Moka Save Bill; Moka blocks split bill with a promo in the cart) and split tender exist everywhere but are low value at this ticket size and counter flow. **Skip for v1** unless the owner wants them (**D-6**). The phrase "Simpan Pesanan" was not found on any vendor page; vendors use Simpan / Tersimpan / Daftar Order.

---

## 3. Arah desain POS yang direkomendasikan

### 3.1 Nama arah: "Kertas & Emas" (Paper & Gold)

**One sentence:** a quiet, warm, high-contrast counter tool where the only gold on screen is the thing you tap next, and every colour other than gold means a state.

**Rationale.**
- *Purpose and audience:* a cashier repeats the same 5-tap sale all day, standing, often one-handed, under shop lighting, sometimes offline. The screen must be scannable at arm's length, not pretty at desk distance. Dense-and-quiet beats expressive (the ECC design-direction rule for daily tools).
- *Brand fit without "dark luxury":* the backoffice already defines warm paper neutrals (`gray-50 #f9f7f3`, `gray-900 #1a1008`) and the gold ramp (`gold-600 #b07d18`) in `apps/backoffice/src/index.css:8-45`; the POS remaps `indigo-*` to the same gold (`apps/pos/src/index.css:3-15`). "Kertas & Emas" formalises what both apps half-do. A dark theme would look premium in a mock-up and fail on a glossy tablet in a lit store; it is not proposed (**D-12**).
- *Three brands:* all colours below are tokens (`--brand-primary`, `--paper-*`, `--ink-*`, semantic set). Mandalika gets gold; Flamboyan and Performance Perfume swap `--brand-primary` and the logo only. Semantic colours never change per brand, so cashiers moving between brands keep the same meaning of red, amber, green (**D-17**).
- *Memorable detail:* the **Bayar bar**, a full-width gold bar at the bottom of the cart that always shows the live total in tabular figures and is the only gold element on the main screen. When the cart is empty it reads "Pilih produk" in ink on paper, not gold, so gold always means "you can pay now".
- *Fixing the amber problem:* today warnings, rewards and the login button are amber, which is the same hue family as brand gold (`App.tsx:120`, `CheckoutPanel.tsx:204`). In this direction amber is warning only; rewards get teal, promos get plum, and gold is reserved.

### 3.2 Arsitektur informasi layar kasir

**Always visible (never scrolls away, never behind a modal):**
1. Header strip (56 dp): outlet name · shift chip (Buka Shift / Shift aktif 09:12) · **one** connection-and-queue chip (3.5) · hamburger.
2. Catalog: search + scan field, chip row (Semua · Terlaris · Promo · Paket & Hadiah · categories), the tile grid (4 columns at 1280 dp, price and stock on every tile).
3. Cart column (38 % of width, about 480 dp at 1280): customer chip at the top (empty state "+ Pelanggan"), cart lines, applied promo/discount/reward lines, totals, "Promo & Diskon" and "Catatan" secondary buttons, the Bayar bar.

**One tap away (a sheet that slides over the cart or the catalog, never two deep):**
- Variant sheet (tap a multi-size tile): size rows with price and stock, tap = add one, "+ 1" repeat.
- Line sheet (tap a cart line): qty stepper, size switch, line discount (if permitted), note, Hapus.
- Promo & Diskon sheet: code field at top, active promos as toggle cards with the "Bisa digabung" rule, manual Diskon/Biaya tambahan at the bottom, open to every cashier (D-11). Pickers for BXGY/bundle replace the sheet's content (same sheet, back arrow), never stack on it.
- Pelanggan sheet: phone field, recent customers, result with tier and "N hadiah tersedia", + Baru.
- Checkout sheet (Bayar): methods, cash chips, keypad, change, loyalty reward and points in a "Hadiah & Poin" block above the methods when a customer is attached, Konfirmasi.
- Connection sheet (tap the chip): status, queue list with per-order state, "Kirim sekarang", "Perbarui data", "Bagikan log".

**Hidden (hamburger menu, grouped):** Transaksi: Riwayat · Struk di Tablet Ini · Rekapan · Kas Masuk/Keluar. Stok: Terima Transfer · Riwayat Transfer · Permintaan Barang. Perangkat: Printer · Tampilan · Terminal · Keluar. Remove "Ambil Pesanan" (it does nothing, **D-18**). "Back Office" moves under Perangkat with an external-link icon.

**Things that must never interrupt a sale:** the TandaTerimaPrompt and engine toasts become a badge on the hamburger plus a line in the Connection sheet; they pop only when the cart is empty (**F**, see 5).

### 3.3 Aturan target sentuh dan tipografi (Android tablet 10-11 inci, lanskap)

Assume 1280 × 800 dp effective (most 10.1-11 inch Android tablets land at 1200-1340 × 800 dp). Rules are in dp/sp so they hold across densities; in Tailwind v4 they become spacing and type tokens, never `text-[10px]`.

| Element | Rule |
|---|---|
| Any tappable control | ≥ 48 × 48 dp, ≥ 8 dp gap (Android floor; above Shopify's 44 px / 8 px rule) |
| Primary action (Bayar bar, Konfirmasi) | 64 dp tall, full width of its column |
| Catalog tile | ≥ 180 × 150 dp at 4 columns; name 2 lines; whole tile is the target |
| Chips (categories, cash amounts, sizes) | 44 dp tall minimum, 12 dp horizontal padding, 8 dp gap |
| Steppers (+ / −) | 48 dp each, qty between them ≥ 40 dp wide |
| Remove (×) on a line | never a bare glyph: 48 dp hit area, or swipe-left to reveal "Hapus" (Square pattern) |
| Header controls (shift, chip, menu) | 44 dp tall, 48 dp hit area |
| Modal close | 48 dp, top-right, plus Android Back and backdrop |
| Typography base | 16 sp body; nothing below 12 sp anywhere; everything in rem so "Ukuran Font" scales all of it |
| Tile | name 15-16 sp semibold, price 16 sp bold tabular, stock 13 sp |
| Cart line | name 15 sp, size 13 sp, qty 16 sp, amount 16 sp bold tabular |
| Totals | rows 15 sp; Total 24 sp bold; Bayar bar amount 22 sp |
| Checkout | amount field 32 sp; change due 28 sp bold; chips 16 sp |
| Status chip text | 14 sp semibold |
| Font | system sans (Roboto on Android) with `font-variant-numeric: tabular-nums` for every money column; no web-font download on a tablet that may be offline (**D-7**: owner may prefer a bundled brand font; it then ships in the APK, not OTA) |
| Density | 8 dp spacing scale (8/12/16/24/32); radius 12 dp controls, 16 dp sheets; one shadow level for sheets only |
| Motion | 150-200 ms slide for sheets, no decorative animation; the pulsing "Online" dot goes |

### 3.4 Semantik warna (tokens; hex are proposals, brand swaps only `--brand-*`)

| Token group | Meaning | Proposed | Used for |
|---|---|---|---|
| `--paper-0/-1/-2` | surfaces | `#fbf9f5` / `#f3efe7` / `#e9e3d8` | background, cards, sheets |
| `--ink-900/-700/-500` | text | `#1a1008` / `#4a3f33` / `#7a6f62` | body, secondary, hints (hint ≥ 4.5:1 on paper-0; today's `text-gray-400` is about 2.6:1) |
| `--brand-primary` | **the next action and the brand** | `#b07d18` (Mandalika) | Bayar bar, Konfirmasi, selected chip, logo. Nothing else. |
| `--state-ok` | success, synced, online, stock healthy | green `#1f7a4d` | Tersinkron, Online, "Stok 9" |
| `--state-warn` | attention, degraded but safe | amber `#b45309` | Offline (sales safe), "Stok 2" (≤ low-stock threshold, **D-20**), "Tertunda", 10 h warning |
| `--state-danger` | blocked, lost, negative | red `#b42318` | Habis / stok minus, Perlu ditinjau, Offline terkunci, Refund, destructive buttons |
| `--state-info` | updating, informational | blue `#1d4ed8` | Memperbarui data, Pembaruan data tersedia, hints |
| `--promo` | any discount or promotion line (auto, code, manual) | plum `#6d28d9` | promo cards, applied lines, "Promo & Diskon" button tint |
| `--reward` | anything free: loyalty gift, BXGY gift, bundle free item, giveaway bag | teal `#0f766e` | GRATIS lines, "N hadiah tersedia", reward picker |

Rules: gold never encodes state; state never uses gold. Stock on a tile shows a number with the colour (green ≥ threshold, amber below, red at 0 or negative) and the word "Habis" only at 0. A badge is colour + icon + word, never colour alone.

### 3.5 Model status offline / sinkron (what the cashier sees)

Two axes exist in the engine already (connection and queue). The UI shows **one chip** whose text is picked from this matrix, plus **per-order states**, plus **per-action locks**.

Connection axis (from `engine.isReachable()` and `OfflineLevel`): `online` · `offline` · `offline-warn` (≥ 10 h) · `offline-locked` (≥ 12 h).
Queue axis (from `QueueSummary` and `FailureKind`): `empty` · `sending N` · `queued N` · `stuck N` (retryable ≥ 10) · `parked N` (dead-letter) · `account` (unauthorized / outlet mismatch).

| Connection \ Queue | empty | sending / queued N | stuck N | parked N | account |
|---|---|---|---|---|---|
| online | ● Online · Tersinkron (ok) | ● Mengirim N… (info) | ▲ N tertunda (warn) | ■ N perlu ditinjau (danger) | ■ Masalah akun (danger) |
| offline | ○ Offline · aman (warn) | ○ Offline · N tersimpan di tablet (warn) | same as queued | ■ Offline · N perlu ditinjau (danger) | ■ Masalah akun (danger) |
| offline-warn | ▲ Offline 10 jam · N tersimpan (warn) | same | same | same | same |
| offline-locked | ■ Offline terkunci · hubungi admin (danger) | ■ Offline terkunci · N tersimpan (danger) | same | same | same |

Per-order state (shown as a badge on the receipt preview, in Struk di Tablet Ini and in the Connection sheet; read from `LocalReceipt.state` and `OutboxStatus`, no engine change):
- **Tersimpan di tablet** (queued, amber): "Aman. Akan terkirim otomatis saat online."
- **Terkirim** (acked, green): shows the server receipt number.
- **Perlu ditinjau** (parked, red): "Tidak bisa terkirim setelah 5 kali coba. Hubungi admin; transaksi tidak hilang." The raw `lastError` goes behind "Detail teknis".
- **Refund menunggu** / **Sudah direfund** as today.

Per-action locks (shown on the control itself, with a lock icon and a reason line, never only as an error after the tap): Buka Shift, Hadiah Loyalti preview, server customer search, Permintaan Barang, Terima Transfer approval, Lepas terminal, Riwayat beyond cache. Reason copy: "Butuh internet" or "Menunggu N transaksi terkirim".

Events that today are silent become one of three things: a badge count on the hamburger (new inbound transfer, parked sale), a line in the Connection sheet, or (only when the cart is empty) a dismissible banner. The 3-second single toast stays for confirmations only ("Pelanggan tersimpan"), never for anything the cashier must act on.

Guard rails (P13): Tutup Shift, Keluar and Lepas terminal show the unsynced count and a reason before the button enables; the 12 h lock message becomes a persistent banner with one action, not a 190-character toast.

### 3.6 Pedoman salinan (copy) dalam bahasa Indonesia

Tone: short, plain, second person implied, no blame, no system words ("server", "sinkronisasi", "stok minus", "outbox", "antrian"). Every message that reports a problem has three parts in this order: what happened · what to do now · whether the sale is safe. Buttons are verbs. One word per concept, from this glossary.

| Concept | Use | Do not use (today's variants) |
|---|---|---|
| Pay | **Bayar**; confirm = **Konfirmasi Rp X** | Charge, Proses |
| Cash / exact / change | **Tunai**, **Uang Pas**, **Kembalian**, **Kurang Rp X** | — |
| Methods | **Tunai · Kartu · QRIS · Transfer** | — |
| Automatic or listed promotion | **Promo** | Promosi Aktif, BOGO, tier, Bertingkat (use "Beli lebih, hemat lebih") |
| Typed code | **Kode Promo** | Kode diskon, Kode:, Kode |
| Manual reduction | **Diskon manual** (no permission gate, D-11) | Diskon / Surcharge; "Surcharge" → **Biaya tambahan** |
| The amount saved | **Hemat Rp X** on lines; **Total hemat** in totals | Potongan, Total Promo, Total Diskon |
| Combinable | **Bisa digabung** / **Tidak bisa digabung** | tidak digabung |
| Anything free | **Hadiah** (line label **GRATIS**) | Hadiah Loyalti / Hadiah Promo as separate concepts; "giveaway" |
| Points | **Poin**, **Tukar Poin** | — |
| Customer | **Pelanggan**, **+ Pelanggan**, **Ganti**, **Lepas** | member |
| Shift | **Buka Shift**, **Tutup Shift**, **Kas Awal**, **Kas Masuk**, **Kas Keluar**, **Rekap Shift** | Uang Masuk/Keluar, Uang awal (kas), Rekapan, bare "Tutup" for the shift |
| Dismiss | **Tutup** means only "close this sheet"; a sheet with changes says **Batal** / **Simpan** | — |
| Refund | **Refund** (what Moka-trained cashiers and the backoffice already say; **D-8** if the owner prefers Retur) | Pengembalian, retur |
| Stock | **Stok 9**, **Stok 2** (amber), **Habis** (0), **Stok akan minus** (override) | stok minus as a casual phrase, "Stok habis" when not zero |
| Connection | **Online**, **Offline** | tersambung (keep for the printer only), koneksi |
| Queue | **Tersimpan di tablet**, **Terkirim**, **Perlu ditinjau**, **Tertunda** | antrian/antrean, belum terkirim, Menunggu sinkronisasi, disinkronisasi |
| Actions on the queue | **Kirim sekarang** (push), **Perbarui data** (pull) | Sinkronkan, Sinkronkan data terbaru, Pembaruan tersedia |
| App update | **Versi baru siap, mulai ulang saat kasir kosong** (if a prompt is added, **D-19**) | Pembaruan tersedia |
| Printer | **Cetak**, **Cetak ulang**, **Pasangkan printer** | — |
| Receipt | **Struk** | — |

Message templates:
- Oversell: "Stok {name} tinggal {n}. Tambah {m} akan membuat stok minus. Lanjutkan?" (replaces "Stok habis - tetap ditambahkan…"; **R** as a sheet-level note, **F** if it becomes a confirm).
- Parked: "Transaksi #{local} belum bisa terkirim. Hubungi admin. Transaksi aman di tablet ini."
- Offline lock: "Tablet offline lebih dari 12 jam. Penjualan dikunci sampai online. Transaksi yang sudah ada tetap aman." with one button **Cek koneksi**.
- Promo invalid at confirm: "Promo {name} tidak berlaku lagi ({reason}). Dihapus dari keranjang; promo lain tetap." (per-promo, not all).
- Online-only lock: "Butuh internet" under the greyed control.
- No printer at sale end: "Struk tidak dicetak: printer belum dipasangkan." with **Pasangkan** and **Lewati**.

English stays only for QRIS, SKU, PIN, Rp and brand names. `index.html` gets `lang="id"`.

### 3.7 Wireframe lo-fi (ASCII, 1280 × 800 dp, lanskap)

**W1. Katalog + Keranjang (main screen)**

```
┌─ Mandalika · BSD ──── ● Shift aktif 09:12 ─────────── ○ Offline · 2 tersimpan ── ≡ ─┐ 56
├─────────────────────────────────────────────┬────────────────────────────────────────┤
│ [🔍 Cari nama / SKU / scan ▮▮▮          📷] │ [👤 + Pelanggan                      ] │ 48
│ (Semua)(Terlaris)(Promo)(Paket & Hadiah)(…) │────────────────────────────────────────│
│                                             │ Rehearsal Alpha · 50 ml          1 ×   │
│ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ │   Rp 350.000            Rp 350.000  › │ 64
│ │        │ │        │ │        │ │        │ │ Rehearsal Bravo · 110 ml         2 ×   │
│ │ Alpha  │ │ Bravo  │ │Charlie │ │ Delta  │ │   Rp 520.000          Rp 1.040.000  › │
│ │Rp 350k │ │Rp 350k │ │Rp 350k │ │Rp 350k │ │ ✨ GRATIS Tas Kanvas (Hadiah)   1 × 0 › │
│ │Stok 9 ·│ │Stok 1▲ │ │Stok 9  │ │Habis ■ │ │ ◆ Promo Beli 2 hemat 10 %  −Rp 139.000 │
│ │2 ukuran│ │2 ukuran│ │        │ │        │ │────────────────────────────────────────│
│ └────────┘ └────────┘ └────────┘ └────────┘ │ Subtotal                  Rp 1.390.000 │
│ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ │ Total hemat                 −Rp 139.000 │
│ │  …     │ │  …     │ │  …     │ │  …     │ │ PPN                            Rp 0    │
│ └────────┘ └────────┘ └────────┘ └────────┘ │ [◆ Promo & Diskon]  [✎ Catatan] [Hapus]│ 48
│                                             │ ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓ │
│                                             │ ┃  BAYAR            Rp 1.251.000      ┃ │ 64 gold
│                                             │ ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛ │
└─────────────────────────────────────────────┴────────────────────────────────────────┘
          62 %                                                 38 %
```
Tile: name (2 lines), price, stock in state colour, "2 ukuran" if multi-size. Tapping a multi-size tile opens the variant sheet over the catalog (sizes as 56 dp rows: "50 ml · Rp 350.000 · Stok 9 [+]"; tap row = add one; the sheet closes; a second tap on the tile opens it again). Cart line "›" opens the line sheet. "Hapus" (semua) asks "Kosongkan keranjang?" with Batal/Kosongkan.

**W2. Bayar (checkout sheet, slides over the cart column, catalog stays visible but dimmed)**

```
┌───────────────────────────────────────────────┐
│ ‹ Kembali        Bayar Rp 1.251.000            │ 56
│───────────────────────────────────────────────│
│ 🎁 Hadiah & Poin · Budi (Gold) · 1 hadiah     │
│  (✓ Tas Kanvas · GRATIS)  (Tukar 500 poin ▸)   │ 48  (only with a customer; "Butuh internet" if offline)
│───────────────────────────────────────────────│
│ [ Tunai ✓ ] [ Kartu ] [ QRIS ] [ Transfer ]    │ 56
│                                               │
│ Diterima   ┌───────────────────────────────┐  │
│            │ Rp 1.300.000                  │  │ 64, 32 sp
│            └───────────────────────────────┘  │
│ (Uang Pas)(1.300.000)(1.350.000)(1.500.000)(2.000.000)   │ 44 chips
│ ┌───┬───┬───┐                                 │
│ │ 1 │ 2 │ 3 │   Kembalian                      │
│ │ 4 │ 5 │ 6 │   Rp 49.000                      │ 28 sp bold green
│ │ 7 │ 8 │ 9 │                                 │
│ │000│ 0 │ ⌫ │   Sales: (Tanpa sales ▾)         │
│ └───┴───┴───┘                                 │
│ ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓ │
│ ┃  KONFIRMASI Rp 1.251.000                   ┃ │ 64 gold
│ ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛ │
└───────────────────────────────────────────────┘
```
Kartu/QRIS/Transfer hide the keypad and show "Tagihan Rp 1.251.000" plus an optional "No. referensi" (new field, **D-21**). The success view replaces the sheet: big ✓, "Terkirim · #BSD-00412" or amber "Tersimpan di tablet · akan terkirim otomatis", Cetak ulang, **Transaksi baru** (gold).

**W3. Pelanggan + Hadiah (customer sheet over the cart column)**

```
┌───────────────────────────────────────────────┐
│ ‹ Kembali        Pelanggan                     │
│ [📞 0812…               ] [Cari]  [+ Baru]    │ 48
│ Terakhir di tablet ini                        │
│ ┌───────────────────────────────────────────┐ │
│ │ Budi Santoso · 0812 3456 7890             │ │
│ │ Gold · 1.250 poin · 1 hadiah tersedia  🎁 │ │ 72
│ └───────────────────────────────────────────┘ │
│ ┌───────────────────────────────────────────┐ │
│ │ Sari · 0813 … · Silver · 0 hadiah         │ │
│ └───────────────────────────────────────────┘ │
│ ○ Offline: hanya pelanggan yang pernah dilayani di tablet ini │
└───────────────────────────────────────────────┘
```
After attach, the cart header chip reads "👤 Budi · Gold · 1 hadiah 🎁 (Ganti · Lepas)". Rewards are previewed in the cart as soon as the customer is attached and the tablet is online ("🎁 1 hadiah tersedia · pilih di Bayar"); choosing happens in the W2 block. Attaching a customer no longer wipes bundle/BXGY lines silently: if a conflict exists the sheet says "Menambahkan pelanggan akan menghapus Promo Paket X. Lanjutkan?" (**F**).

**W4. Refund (from Riwayat or Struk di Tablet Ini)**

```
┌───────────────────────────────────────────────┐
│ ‹ Kembali        Refund #BSD-00398 · kemarin   │
│ Dibayar Tunai Rp 1.251.000 · Kasir Rina        │
│───────────────────────────────────────────────│
│ ☑ Rehearsal Alpha 50 ml    1 ×   Rp 350.000   │ 56  (v1: all lines locked ☑ = whole order;
│ ☑ Rehearsal Bravo 110 ml   2 × Rp 1.040.000   │       per-line is phase C, see 5)
│ ☑ GRATIS Tas Kanvas        1 ×        Rp 0    │
│───────────────────────────────────────────────│
│ Alasan  (Rusak)(Salah ukuran)(Berubah pikiran)(Lainnya…)     │ 44 chips
│ Stok    (● Kembalikan ke stok)(○ Tidak)       │
│ Dikembalikan ke pelanggan    Rp 1.251.000     │
│ 🔒 Butuh PIN penyetuju (A06)                  │
│ ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓ │
│ ┃  REFUND Rp 1.251.000   (red)               ┃ │ 64
│ ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛ │
└───────────────────────────────────────────────┘
```
Gate reasons ("Buka shift dulu", "Shift belum terkirim", "Butuh izin refund") appear as a full-width amber line above the button, not 11 px grey text. Cancel returns to the list. Riwayat defaults to "Hari ini" with a "Kemarin" chip (saves 3 taps).

**W5. Koneksi & antrean (sheet from the header chip)**

```
┌───────────────────────────────────────────────┐
│ ‹ Kembali        Koneksi & antrean             │
│ ○ Offline sejak 14:02 · penjualan tetap bisa   │
│   Terkunci otomatis jika offline > 12 jam (10 jam lagi) │
│───────────────────────────────────────────────│
│ Tersimpan di tablet (2)                        │
│  #L-0412 · 14:05 · Rp 1.251.000 · Tunai        │
│  #L-0413 · 14:11 · Rp 350.000 · QRIS           │
│ Perlu ditinjau (1)                      ■      │
│  #L-0399 · 11:40 · Refund · Rp 350.000         │
│   "Tidak bisa terkirim setelah 5 kali coba.    │
│    Hubungi admin. Transaksi aman."  (Detail teknis ▸) │
│───────────────────────────────────────────────│
│ Data produk & promo: diperbarui 13:58          │
│ [Kirim sekarang (2)]  [Perbarui data]  [Bagikan log] │ 48
└───────────────────────────────────────────────┘
```
"Kirim sekarang" is the push; "Perbarui data" is the pull. The existing popover becomes this sheet; the second (grey) Offline pill is removed.

---

## 4. Backoffice (ringkas)

Source: `apps/backoffice/src` read the same day. No router: the active screen is a `useState` (`App.tsx:135,270`), sub-tabs and detail views are in-screen swaps (`screens/transfers/Transfers.tsx:34-73`, `screens/requisitions/RequisitionList.tsx:20-40`), so filters, tab and drill-down are lost on every switch and nothing is bookmarkable. The shell is `h-screen flex bg-gray-50 overflow-clip` with `<main class="relative flex-1 overflow-y-auto">` (`App.tsx:159,269`, the 2026-10-26 overflow fix). Tailwind v4 with a warm-paper `gray-*` and a `gold-*` ramp (`index.css:8-45`); no font declared; `index.html` has `lang="en"`. A small UI kit exists (`ui/`: Button, Badge, Card, EmptyState, Field, IconButton, Modal, PageHeader, Pagination, Tabs) but **no Table, FilterBar, DateRange or SlideOver**; 34 hand-written `<table>`s in 30 files; about six ad-hoc gold "selected" recipes besides `Button`.

### 4.1 Navigasi

Today: 13 flat sidebar items (`App.tsx:45-62`) with three red count badges that mean different things (Stok Minus unchecked, approvals pending, sync reviews open) and no legend. One audit chain (sale → stock → approval → ERP) spans five menus. Two competing scope controls: the header "Semua Outlet" (`outlet.tsx:81-97`) and a separate "Lokasi" select on Pergerakan, Kartu Stok and Transfers (`MovementSummary.tsx:96-115`, `StockCard.tsx:158-177`, `Transfers.tsx:178-198`); `useLocations` ignores the header (`useLocations.ts:45-54`), so the header can say "Semua Outlet" while the table shows one.

Recommended (same "Kertas & Emas" tokens; desktop density): group the sidebar into five sections (**D-16**): **Penjualan** (Dashboard, Laporan), **Pelanggan** (Pelanggan, Promosi), **Produk & Stok** (Produk, Inventori, Persetujuan Stok, Permintaan Barang), **Operasional** (Pengguna, Tinjauan Sinkron, Pengaturan), **Sistem** (Integrasi ERP, Log Error). Badges get a tooltip legend and a single colour rule (red = needs a human decision, amber = waiting). One scope: the header outlet selector is the only scope; screens that need a warehouse add "Gudang" as a filter chip that visibly inherits the header scope ("Outlet BSD · semua gudang"). URL state (hash router, filters in the query string) is a behaviour change scheduled in 5 (**D-15**).

### 4.2 Tabel

Today: common recipe `Card > overflow-x-auto > table.w-full`, headers `text-xs font-black text-gray-400 uppercase` (`ProductsTable.tsx:45-50`, about 2.6:1 contrast), densities vary (`px-5 py-3` / `px-4 py-2` / `text-[10px]` on ERP), sticky headers only inside modals, Kartu Stok has 13 `whitespace-nowrap` columns with no sticky first column (`StockCard.tsx:311-330`), Products and Promotions load everything with no pagination (`useProductsData.ts:24,67`, `Promotions.tsx:312-407`), four export labels ("Export", "Unduh CSV", "Ekspor CSV", "Export Refund CSV"), raw enums leak (`in_transit`, `reasonCode`, `erpStatus`, `outlet 1a2b3c4d` at `DocumentModal.tsx:68-131`, `StockCard.tsx:377`, `erpOutboxFormat.ts:58`).

Recommended: one `DataTable` component (sticky header, optional sticky first column, 14 px body, 13 px uppercase headers at ≥ 4.5:1, zebra off, row hover, 44 px rows, column chooser), one `FilterBar` (scope line · date range with presets Hari ini / 7 hari / 30 hari / Bulan ini · search · chips), one `ExportButton` ("Unduh CSV" everywhere, with the row count and the applied filters in the tooltip), one label map for every enum (status, reason codes, ERP status, transfer states) so no raw code reaches the screen. Pagination: the existing `ui/Pagination` everywhere, server-paged Products and Promotions (behaviour, 5).

### 4.3 Formulir

Today: centred `ui/Modal` with a dirty-guard ("Buang perubahan?"), Batal/Simpan footer; errors mostly a single red line at the bottom (`ProductFormModal.tsx:153`) although `Field` supports per-field errors (`ui/Field.tsx:30`); the promotion form is a 3-step wizard (`PromoFormModal.tsx:250-301`) with outlet selection as a collapsed checkbox list (not chips, `:489-510`) and Jam Aktif hidden behind a checkbox that clears values when unticked (`:320-341`); opname completion uses `window.confirm` (`StockCount.tsx:219`); transfer Kirim/Batalkan have no confirmation (`Transfers.tsx:321,331`); promotion status pills mutate on click with no button affordance (`Promotions.tsx:340,393`).

Recommended: edit forms open in a right **SlideOver** (the recipe slide-over already exists) so the table stays visible; per-field errors with the field red and a summary at the top; one `ConfirmDialog` for every stock-moving or destructive action (Kirim, Batalkan, Selesai opname, Hapus) with the consequence in one sentence; status toggles become a labelled switch, not a badge. Promotion outlet selection becomes chips with "Semua outlet" as the first chip; Jam Aktif stays visible with "Sepanjang hari" as the default state.

### 4.4 Layar inventori yang dipakai auditor

| Screen | What the auditor must understand today | Recommended |
|---|---|---|
| **Pergerakan** (`screens/inventory/MovementSummary.tsx`) | Saldo Awal + Masuk + Penjualan + Refund + Transfer + Penyesuaian + Hadiah = Saldo Akhir per SKU; bucket definitions only in `title` tooltips (`:201`); `bucketsReconcile()` exists but is used only in tests (`pergerakanBuckets.ts:21`); "Tanggal tercatat" is the filter basis while Kartu Stok leads with "Waktu Kejadian". | A legend row under the filter bar with the six bucket definitions; a reconcile indicator per row (✓ or a red "Selisih Rp" badge) using the existing function; a one-line note "Rentang tanggal mengikuti waktu tercatat, bukan waktu kejadian"; row click → Kartu Stok with the same range (already). |
| **Kartu Stok** (`screens/inventory/StockCard.tsx`) | 13 columns; Saldo header only after a SKU is picked (`:195`); 10 kind chips vs 6 Pergerakan buckets (two vocabularies for one ledger); ERP column prints raw `erpStatus`; "Alasan" and "Penyetuju" mix a name and a document number. | Sticky first two columns (Waktu Kejadian, Jenis) and sticky header; group columns Waktu · Gerakan (Jenis, Dokumen, Masuk, Keluar, Saldo) · Siapa (Oleh, Penyetuju) · Catatan (Alasan, Tanda, ERP); kind chips grouped under the same six bucket names as Pergerakan with the finer kind as a sub-chip; ERP status mapped to Terkirim / Menunggu / Gagal with colour; "Pilih satu SKU" hint replaced by a SKU-first layout (SKU picker on the left, like Majoo's Mode SKU list). |
| **Penerimaan / Barang Masuk** | No list screen; created via "Barang Masuk" on a location's stock view (`LocationStockView.tsx:72-74`, `GoodsInModal.tsx`); old receipts only via Kartu Stok document links; three names for one thing (Penerimaan / Barang Masuk / Stok Masuk). | One name: **Barang Masuk** (the ledger kind label follows); a Barang Masuk list tab under Inventori with the same DataTable and the Garansi tag visible. |
| **Transfer** (`screens/transfers/Transfers.tsx`) | Filter labels ("Draft", "Dalam pengiriman") differ from badge labels ("Draf", "Dikirim") (`:36-41` vs `:170-175`); Kirim/Batalkan fire immediately. | One status map; ConfirmDialog on Kirim/Batalkan with "Stok akan keluar dari {source}". |
| **Opname** (`screens/StockCount.tsx`) | Titled "Stock Count" while the tab says "Opname"; columns "Stok Beku / Stok Aktual" here, "Acuan / Aktual" in approvals, "Sistem / Aktual" in the document modal; `window.confirm` on completion. | One name **Opname**, one column pair **Stok sistem / Stok dihitung**, ConfirmDialog with the net difference. |
| **Koreksi / Penyesuaian** (`screens/warehouses/AdjustModal.tsx`) | Sets an absolute new qty (not a delta); four names (Penyesuaian, Koreksi, Koreksi Stok, Buat penyesuaian). | One name **Penyesuaian Stok**; the modal shows "Stok sekarang 9 → baru 7 (−2)" so the delta is explicit. |
| **Persetujuan Stok** (`screens/approvals/*`) | No filters or export; dense but correct copy about drift since request (`ApprovalDetail.tsx:59`). | Add outlet/type filters and the DataTable; keep the drift sentence, add the numbers in a 3-column strip (Saat diajukan · Sekarang · Yang diterapkan). |
| **Integrasi ERP** (`screens/integration/*`) | Default tab "Gagal"; Lokasi prints `outlet 1a2b3c4d`; relay line uses jargon ("dikembalikan ke antrean"); status labels Diulang/Ditahan unexplained. | Outlet name from the API (behaviour); status legend; relay report as three counts (Terkirim · Ditahan · Gagal) with "lihat yang ditahan". |
| **Tinjauan Sinkron**, **Log Error**, **Stok Minus** | Good reason labels but "(rejected)" / "(conflict)" leak (`reviewLabels.ts:22-23`); Stok Minus ignores the page's date range by default (`OversellTab.tsx`). | Strip raw codes behind "Detail teknis"; Stok Minus follows the Laporan date range by default. |

Backoffice terminology table (one word per concept): Barang Masuk (not Penerimaan/Stok Masuk), Penyesuaian Stok (not Koreksi), Opname (not Stock Count), Refund (not Retur, to match the POS), Unduh CSV (not Export/Ekspor), Tambah {noun} for every create button (not Buat/Baru/Catat), Dari/Sampai for every date range, Draf/Dikirim/Diterima for transfers everywhere, English leftovers (Dashboard → Ringkasan, Overview → Ringkasan, Template → Templat, Log Error → Log Kesalahan) (**D-22**).

Backoffice wireframe (described, not drawn): the shell keeps the 256 px sidebar with section headers in 11 px uppercase ink-500 and items at 40 px; the header carries the single outlet scope and the user; every list screen is PageHeader (title, count, one primary Tambah) → FilterBar → DataTable → Pagination; every detail opens as a 560 px SlideOver on the right with the table still visible; Kartu Stok is the exception with a left SKU rail (240 px) and the ledger on the right.

---

## 5. Rencana bertahap

Constraints: nothing touches code before the 2026-11-02 demo; POS web-layer changes ship over OTA (Capgo) without an APK, native changes (fonts in the APK, Capacitor plugins) need an APK; anything that touches `packages/sync`, `cashier/stock.ts`, the cart reducer's order payload, `receiptQuote`, or the backend goes through the reviewer agent and the Neon e2e routine. "Session" = one focused Claude Code session of implementation plus review, per the repo's existing routine.

### Fase 0 — sebelum demo (now until 2026-11-02): decisions and mocks only
- Owner has answered the D-register (2026-10-27). Zero code before 2 Nov.
- Hi-fi mocks of W1-W5 in **Figma** (the `design:figma` connector is authorised): A1 tokens as Figma variables (paper, ink, brand, semantic), the five screens at 1280×800, plus the three brand skins as variable modes. This is the approval artifact for Fase A and the reference `impeccable` reviews against. 1 session.

### Fase 0b — jendela polish POS 2026-11-02 → 2026-11-07 (only if the POS is not in the 2 Nov demo)
Five working days. What fits, in order, all OTA-safe and none touching SyncEngine or the order payload:
1. **A1 tokens + kit** (day 1-2).
2. **A4 status, copy, locks** (day 2-3).
3. **A2 catalog + cart** including the best-size tile promotion (**D-2**, now Yes) and price/stock on tiles (day 3-4).
4. **A3 checkout** (day 4-5).
5. The deferred items the owner pulled forward, as far as they are POS-local:
   - **Held orders / Simpan pesanan** (**D-6**, now Yes): save the current cart to tablet storage with a name, a "Pesanan tersimpan (N)" chip in the cart header, restore and delete. Cart-reducer plus local storage only; no payload change. Fits in the window (1 session).
   - **Blind count at Tutup Shift** (**D-4**, now Yes as an option in Pengaturan): hide "Sistem" amounts until "Terhitung" is entered. Display-only in `ShiftRecapPanel.tsx`. Fits (half a session).
   - **Denomination counter at Tutup Shift** (**D-5**, now Yes): 100k/50k/20k/10k/5k/2k/1k/coins × count → fills "Terhitung Tunai". Display-only. Fits (half a session).
   - **OTA "Versi baru siap" prompt** (**D-19**, now in the window): needs Capgo manual mode, a native config change, so it ships as an **APK**, not OTA; build it in the window but it reaches tablets only through the fleet rollout.
   - **Split tender** (the other half of D-6): touches the tender invariants (A09), the order payload, the sync schema and the backend. **Not safe inside the window**; scheduled as C6 after the window with the reviewer and Neon e2e.
   - **Dark theme** (**D-12**): No, confirmed by the owner.
If the POS **is** in the 2 Nov demo, Fase 0b collapses into the first week after the demo in the same order.

### Fase A — restyle tanpa perubahan perilaku (POS, OTA-safe, class R) — about 7 sessions
| Slice | Content | Files (POS) | Sessions |
|---|---|---|---|
| A1 Tokens + kit | `index.css` tokens (paper, ink, brand, semantic, spacing, type), `font-variant-numeric`, `lang="id"`; shared `Sheet`, `Button`, `Chip`, `StatusBadge`, `Stepper`, `Money` components replacing the 14 copy-pasted modal shells and the 4 `PAYMENT_LABELS`; emoji → icons | `index.css`, new `components/*`, every modal file (mechanical swap) | 2 |
| A2 Katalog + keranjang | Tile layout with price and stock on by default (**D-9**), 48 dp steppers and remove, 2-line names, chip row, cart typography, Bayar bar, "Hapus semua" confirm wording | `ProductGrid.tsx`, `Cart.tsx`, `CashierScreen.tsx` (layout only) | 2 |
| A3 Checkout + struk preview | W2 layout, cash chips (**D-3**), change display, success view with per-order state badge read from `engine.localReceipts()` | `CheckoutPanel.tsx`, `ReceiptPreview.tsx`, `tender.ts` (display only) | 1 |
| A4 Status, copy, kunci | Single chip with the 3.5 matrix, W5 sheet replacing the popover, remove the grey pill, per-action lock labels, the glossary applied everywhere (3.6), oversell wording, parked-sale wording, refund gate line | `SyncStatus.tsx`, `ShiftBar.tsx`, `MenuDrawer.tsx`, `stock.ts` (string only), `refundView.ts` (strings), `offlineCap.ts` (strings) | 2 |

Review: `chore` agent for mechanical swaps, `reviewer` for anything in `CashierScreen.tsx`; `react-doctor` and `browser:ci` as gates. Ship as one OTA bundle per slice, min-version guard as today.

### Fase B — perubahan alur di lapisan web POS (OTA-safe, class F; reviewer on the cart reducer) — about 6 sessions
| Slice | Content | Risk to check | Sessions |
|---|---|---|---|
| B1 Variant sheet + line sheet | Tap size = add one (**D-10**); line sheet with qty, size switch, note (per-line note is a new field in the order payload → check with the server, else keep order-level), Hapus; swipe-to-delete | `ProductGrid.tsx` local state; `cashierReducer` ADD/UPDATE_LINE semantics unchanged; the overstock warning path in `stock.ts` must still fire | 2 |
| B2 One "Promo & Diskon" door + safe clears | Merge AdjustmentDrawer and PromoPanel into one sheet; pickers replace sheet content instead of stacking; per-promo invalidation at confirm (not clear-all); customer-attach conflict confirm; Android Back covers every sheet | `CashierScreen.tsx:616-695` re-guard, `cashierReducer.ts:378-397,450-529`; the promo validator stays `promoValidate.ts` 1:1 with Go | 2-3 |
| B3 Pelanggan chip + hadiah di keranjang | W3 sheet; chip with tier and reward count; reward preview moved from checkout into the cart header (still online-only); "Hadiah & Poin" block in W2 | Loyalty preview call unchanged (`/sync/loyalty-preview`); reward line shape unchanged (SP-CRM-9) | 1-2 |

### Fase C — perubahan data / alur yang menyentuh SyncEngine, stok, struk atau backend (class S) — about 8 sessions
| Slice | Content | Sessions |
|---|---|---|
| C1 Struk = layar | `ReceiptData` gains promo names, surcharge, points redeemed, GRATIS lines; `receiptQuote` and `escpos` updated; server-stored quote schema checked; "no printer" hint | 1-2 |
| C2 Parked sale, per-item | `onDeadLetter` → cashier-visible event; per-item retry/dismiss in the W5 sheet; guard rails on Tutup Shift / Keluar with counts | 1-2 |
| C3 Giveaway visible | POS reads the outlet giveaway config, shows the GRATIS bag line in the cart and subtracts it in the stock display (`engine.ts:993-1016`); server behaviour unchanged (**D-13**) | 1-2 |
| C4 Refund per baris | Refund payload with items, server stock restore per line, sync schema, backoffice Refund report; reason presets; PIN (**D-14**) | 3 |
| C5 Native | Bundled brand font (if **D-7** changes) and the OTA "Versi baru siap" prompt (Capgo manual mode) → APK (**D-19**, built in Fase 0b, shipped by fleet rollout) | 1 |
| C6 Split tender | Choose type then amount (Shopify/Loyverse model), tender invariants (A09), order payload, sync schema, backend, receipt; the second half of **D-6** | 2-3 |

### Fase D — backoffice — about 9 sessions
| Slice | Content | Sessions |
|---|---|---|
| D1 Shell + kit | Grouped sidebar (**D-16**), badge legend, DataTable, FilterBar, ExportButton, ConfirmDialog, SlideOver, enum label maps, contrast fixes, terminology pass (**D-22**) | 2-3 |
| D2 Lists + forms | Products/Promotions on server paging, SlideOver edit forms, per-field errors, promotion chips, status switches | 2 |
| D3 Inventori auditor | Pergerakan legend + reconcile badge, Kartu Stok sticky/grouped columns + SKU rail, Barang Masuk list, Opname/Penyesuaian renames, Transfer confirms, ERP outlet names | 2-3 |
| D4 Router / URL state | Hash router with filters in the query string, back button, bookmarkable Kartu Stok (**D-15**) | 2 |

### Urutan setelah demo (first three things, in order)
1. **A1 tokens + kit** (unblocks everything; invisible to cashiers, so low risk right after the demo).
2. **A4 status, copy, locks** (the cheapest change with the largest effect on "is my sale safe"; pure strings and one chip).
3. **A2 catalog + cart** (the hot path; touch targets and visible price/stock), then A3, then B1.

Total: Fase 0 about 1, A about 7 (of which about 5 fit the 2-7 Nov window), B about 6, C about 11 (with C6), D about 9 → about 34 sessions, with 0b+A+B (about 14) delivering the visible cashier result.

---

## 6. Keterampilan (skills) yang disarankan untuk fase implementasi

Installed already (invoke, do not reinstall):
- **frontend-design** (Anthropic): produces the first real screen with intentional hierarchy; use it for A2/A3 with this document as the brief so it does not default to a generic card grid.
- **impeccable:impeccable**: direction contract + finish review; use `impeccable-finish-reviewer` on every A/B slice against W1-W5 before OTA.
- **ecc:frontend-design-direction**: the five-question framing used in 3.1; re-run it once per brand skin (D-17).
- **ecc:make-interfaces-feel-better**: micro-interaction and state polish pass after A2/A3 (pressed states, sheet motion, focus).
- **design:design-critique**: structured critique of the static mock (Fase 0) and of each slice's screenshots at 1280×800.
- **design:ux-copy**: apply the 3.6 glossary and the three-part error template across both apps (A4, D1).
- **design:accessibility-review** or **ecc:frontend-a11y**: contrast (ink-500 on paper), 48 dp targets, focus order in sheets, Android Back handling.
- **ecc:click-path-audit**: re-measure the 1.2 tap counts after B1-B3 and fail the slice if a path got longer.
- **ecc:design-system**: turn A1 into a documented token/component set shared by POS and backoffice (one source for three brands).
- **ecc:browser-qa** / **browser-automation** (with the Playwright plugin already connected): screenshot W1-W5 at 1280×800 and 1200×800, both offline and online states, as the visual gate for every OTA bundle.
- **react-doctor** and **ecc:react-review**: the existing lint/architecture gate; run on every slice (prefer-useReducer and no-giant-component findings matter for `CashierScreen.tsx`).
- **dataviz**: only for backoffice reports (Laporan, Pergerakan reconcile strip) so charts share the token palette.
- **ecc:ui-demo**: record a short demo of the restyled hot path for the owner's approval between A3 and B1.

- **design:figma** (connector authorised by the owner on 2026-10-27): Fase 0 hi-fi mocks of W1-W5 with the A1 tokens as Figma variables and three brand modes; later `get_design_context` / Code Connect so the React components in A1 map to the Figma components, and `get_screenshot` as the reference the finish reviewer compares each OTA slice against.
- **design:design-handoff**: turns the Figma frames into the per-slice specs (spacing, states, copy) that the `implementer` agent builds from.

Worth installing (not present): nothing essential.

---

## Daftar keputusan pemilik (owner decisions, D-register)

Owner answered on 2026-10-27: "agree with most of all the defaults"; D-11 no permission gate; every "No" / "Skip in v1" / "Later" item pulled forward into the 2-7 Nov window; Figma connector authorised. The "Decided" column is the current state.

| ID | Decision | Default proposed | Decided (2026-10-27) |
|---|---|---|---|
| D-1 | Catalog/cart split ratio in landscape | 62 / 38 | 62 / 38 |
| D-2 | Promote the best-selling size of a product to its own tile | No in v1 | **Yes**, in Fase 0b (A2) |
| D-3 | Cash quick-amount chip set | Uang Pas · next 50k · next 100k · next 500k · 1.000.000 | As proposed |
| D-4 | Blind count at Tutup Shift (hide expected cash from the cashier) | Off | **Yes**, as a setting, Fase 0b |
| D-5 | Denomination counter at Tutup Shift | Not in v1 | **Yes**, Fase 0b |
| D-6 | Held orders / split tender | Skip in v1 | **Yes**: held orders in Fase 0b (POS-local); split tender as C6 after the window (touches tender invariants, payload, backend) |
| D-7 | Font: system Roboto (OTA) vs bundled brand font (APK) | System | System |
| D-8 | "Refund" vs "Retur" | Refund | Refund |
| D-9 | Show price and stock on tiles by default | Yes | Yes |
| D-10 | Tap a size row adds one immediately (no 0-start popup) | Yes | Yes |
| D-11 | Permission gate (lock) on manual discount | Yes | **No gate.** Owner: a gate would slow the counter. Also closes HANDOFF's open "slice 8b discount permission" decision as "not wanted". |
| D-12 | Dark theme | No | **No** (owner confirmed 2026-10-27) |
| D-13 | Show the per-sale giveaway (canvas bag) as a GRATIS line on the POS and subtract it from displayed stock | Yes (phase C) | Yes (phase C) |
| D-14 | Per-line refund scope (backend + sync schema) | Yes, phase C, PIN-gated | Yes, phase C, PIN-gated (refund PIN is A06, already live) |
| D-15 | Backoffice router / URL state | Yes, phase D4 | Yes |
| D-16 | Sidebar grouping into five sections | As in 4.1 | As in 4.1 |
| D-17 | One token layer, three brand skins (only `--brand-*` and logo differ) | Yes | Yes, modelled as Figma variable modes |
| D-18 | Remove the dead "Ambil Pesanan" menu item | Yes | Yes (replaced by "Pesanan tersimpan" once D-6 lands) |
| D-19 | Add a visible OTA "Versi baru siap" prompt (Capgo manual mode, APK change) | Later | **Build in Fase 0b**, ships via APK fleet rollout |
| D-20 | Low-stock threshold for the amber tile state | 2 units per variant | 2 |
| D-21 | Optional reference number field for Kartu/QRIS/Transfer | Yes in A3 (display + payload field to confirm with the server) | Yes |
| D-22 | Backoffice English leftovers renamed (Dashboard, Overview, Template, Log Error) | Yes | Yes |
| D-23 | Hi-fi mocks in Figma before Fase A | (new) | **Yes**, Fase 0, via the authorised `design:figma` connector |

Known limits of this document: no screenshots of competitor apps were inspected (prose sources only); Lightspeed and Pawoon help centers refused fetches, so those facts are search excerpts; tap counts for the proposed design are targets, not measurements, until `ecc:click-path-audit` runs on a build; the POS inventory did not read `ShiftRecapPanel.tsx`, the requisition screens and `authBoot` in full.
