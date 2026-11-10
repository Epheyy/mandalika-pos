# Codex QA findings: what is deliberately left as-is

For the Codex QA agent before the next retest. It covers the findings in
`Mandalika-QA-Report-2026-11-07.md` (F01-F33, W01), `Mandalika-QA-Retest-R10-2026-11-09.md` and
`Mandalika-QA-Retest-R11-2026-11-09.md` (F34-F36 added). It also covers what Claude found and fixed on
2026-11-09 and 2026-11-10, after R11: the tablet run, the role test and printing.

**For R12, read `docs/qa/codex-r12-brief.md` first.** It gives the builds to test, what changed and the
focus areas. This doc is the "don't re-flag" and "expected now" reference.

**Corrected after R11:** two "Expected" entries in this doc were wrong:
- F22: navigating the owning tab to another site does not hand over.
- F20: Buka Shift drops a minus sign; it shows no error.

Both rows are fixed below. R11's F22 observation was correct.

- **Section A** lists behaviour we chose to keep. Please do not re-flag these as unresolved. If what you
  observe differs from the "Expected" column, that is a real finding.
- **Section B** is what was fixed.
- **Section C** is what is still open or untested. Those are fair game.

Citations: `HO:n` = line n of `HANDOFF.md` at commit `f491d988` (`git show f491d988:HANDOFF.md`);
`TRIAGE` = `docs/plans/2026-11-08-qa-triage.md`.

## A. Deliberately left (do not re-flag)

| Id | Decision and why | Expected behaviour | Source |
|---|---|---|---|
| F22 / W01 | **Mitigated with a one-tab guard at the entry point only.**<br>- The APK is the production POS. A browser is for dev and QA only, in Chromium with Web Locks.<br>- The KV outbox (`packages/sync/src/outboxStore.ts`) still rewrites its whole array on every save. That is by design: there is a single writer.<br>- Making the guard fail closed is an owner decision, not a defect. | - A second Chromium tab shows "POS sudah terbuka di tab lain": no cashier controls, no writes, and the draft is kept.<br>- When the owning tab closes, the waiting tab takes over by itself, with no reload.<br>- If the owning tab reloads while another tab waits, the waiting tab becomes the owner.<br>- If the owning tab navigates to another site, the waiting tab stays blocked until that tab is closed; closing it hands over with the draft. **The owner accepted this on 2026-11-09 (R11 F22); it will not be fixed.** Releasing the lock on departure would touch the single-writer boundary, and the APK is unaffected.<br>- A browser without Web Locks (for example plain-http LAN serving) has no guard and shows "Perlindungan satu tab tidak aktif di browser ini. Buka POS di satu tab saja."<br>- The APK shows no warning; it has a single WebView.<br>- Do not report the whole-array outbox store as an open bug. | HO:47; TRIAGE W01 "by design single-writer"; `docs/runbooks/browser-pos-support-policy.md` |
| F19 | **The 5-minute stock-only auto-pull floor is deliberate** (`packages/sync/src/autoPull.ts`). Only the wording changed. | - Stock can be up to 5 minutes behind.<br>- The chip changes to "Stok menunggu diperbarui" only for stock changed elsewhere, after a 60 s hold-off. It never changes for follow-ups to the tablet's own sales.<br>- Koneksi -> "Perbarui stok" pulls stock immediately. | TRIAGE F19 "DESIGN"; HO:47 |
| F20 (sync batch) | **A queued `shift_open` with a negative opening cash is still accepted and stored as sent, but flagged.**<br>- A queued shift is never dropped.<br>- Clamping the amount would skew drawer reconciliation.<br>- The Buka Shift field cannot produce a negative, and a direct API call rejects one. A tablet on a bundle older than OTA 2.12.0 can still queue -1. | - The Buka Shift opening-cash field accepts digits only, like every cash field. A typed minus sign is dropped with no error, so typing `-1` gives Rp 1.<br>- `POST /shifts` with a negative returns 400 "kas awal tidak boleh negatif".<br>- A queued negative shift lands with its value and shows a red "Kas awal negatif" badge in Laporan > Shift. | HO:59; HO:27 |
| F07 | **The legacy `cash` id and the configured `tunai` id are not merged.** The server matches the exact id, so they are separate datasets. | Both appear in filters. The legacy one reads "Tunai (data lama)" and returns only orders with the legacy id. | HO:49; R10 F07 row |
| F06 | **Only the filter labels changed.** Retired methods show "(nonaktif)". Stored ids and filter values are untouched. | - Report rows and CSV print the raw method ids; that is intended.<br>- `neo_bank` and `neobank` remain distinct ids. | HO:25; HO:49 |
| F18 (edges) | **Typing now matches pasting, under a whole-rupiah rule.** Three edges are accepted:<br>- held digits are invisible while typing;<br>- nonsense input like `50.0.000` still differs between typed and pasted;<br>- a multi-character soft-keyboard key after a separator drops the held digits. | - `50.000` typed and `50.000` pasted both give Rp 50.000.<br>- A typed `.` or `,` holds the next digits: 3 digits join as a thousands group, 1-2 are dropped as a fraction, 4 or more all count.<br>- Leaving the field never changes the amount. | HO:13 |
| F33 (edges) | **The leave guard ships with two LOW edges:**<br>- a typed value equal to the saved value counts as unsaved;<br>- a draft for a count completed elsewhere keeps asking.<br>The sidebar and sign-out paths are unit-tested only. | Leaving with unsaved rows asks "Tinggalkan hitungan?" with the row count. Unsaved rows show "Belum disimpan". | HO:13 |
| F12 / F26 (edges) | **Some views skip the clock-skew trust window.** The refund dialog, the stock-card document view and reprint show the tablet's time without it.<br>The lists and exports do apply it: a tablet time is trusted only within 7 days before and 5 minutes after the server time. | They differ from the lists only when a tablet clock was badly wrong. | Release 2026-11-09 (#129) |
| F24 / R10 NULL-redemption probe | **The redemption-amount backfill (migration 0085) is conservative.** It fills only orders where the gap equals points times the current rate. Rounded or older cases stay NULL. | - New orders show "Tukar poin (N)" with the real amount.<br>- Old NULL orders keep the residual row "Tukar poin / pembulatan".<br>- Backoffice redemption rows with a NULL amount are expected. | HO:23; HO:19 |
| F17 | **The held order is relabelled "Subtotal" only.** There is no second total that could disagree with Bayar. | The held list shows the gross line subtotal labelled "Subtotal", not the payable total. | TRIAGE F17; HO:35 |
| F04 | **The form blocks decimals inline.** A decimal sent straight to the API gets the generic decode error. | - UI: an inline whole-number error; 0 skips the line.<br>- Direct API with 1.5: a generic 400. | HO:59 |
| F01 / F03 | **The loyalty check runs only while points are ON**, so switching points off is never blocked by an old value. A receipt cost of 0 is allowed. | - With points OFF, a save is not blocked.<br>- Cost 0 is accepted; a negative cost is refused. | HO:59 |
| F02 | **Receipt copies must be a whole number from 1 to 5.** An old stored value outside 1-5 blocks app-settings saves until it is corrected. | That save fails with a visible reason. | HO:59 |
| F21 | **The POS Sheet focus trap is fixed.** Android Back (`native.ts`/`backGuard`) is deliberately untouched. Hardware Esc is suppressed so it never also acts as Back. | Tab stays in the top sheet, Escape closes only the top sheet, and focus returns to the opener. | HO:53 |
| Split refund payout (D-56, from owner screenshots) | **A split-paid order refunds through one method.** The default is cash if the sale took cash, otherwise the largest method. The audit flag `payoutPicked` records whether the cashier chose it. The printed slip is unchanged on purpose. | - An amber warning shows when the payout exceeds what that method took.<br>- The recap shows "Refund split lewat X melebihi bagian X".<br>- Labels "otomatis" and "dipilih saat refund" are the intended record. | HO:68; HO:27 |
| Outbox status `'sent'` (code scan only) | **Dead type value, deferred.** It is never written. It will be removed with the next real sync change, because `outbox.ts` is on the OTA journal-guard list. | The type value is still present. | HO:70 |
| Role test 4 (2026-11-10) | **Backoffice refunds stay Admin-only** (`Orders.tsx` canRefund). A manager holding `process_refund` refunds on the POS only. Owner decision 2026-11-10. | No refund action in Backoffice Laporan > Transaksi for non-admins, even with `process_refund`. `POST /orders/{id}/refund` accepts holders of `process_refund`. | `docs/qa/2026-11-10-role-test-local.md` |
| Role test 5 (2026-11-10) | **Any signed-in role can read its own outlet's data through the API**, cashier included. The Backoffice refuses cashier sign-in, so a cashier never sees these screens. The dashboard is deliberately sign-in-only (`server.go`). Owner decision 2026-11-10. | A cashier token gets 200, own outlet only, on: `GET /reports/dashboard`, `/orders`, `/settings/app`, `/shifts`, `/stock-counts`, `/cash-flows` and `/discount-codes`. Other outlets are refused (403/404). | role-test report |
| Custom roles | **Custom roles are templates.** Assigning one copies its permissions onto the user, and the user table has no link back to the role. | Editing a custom role later does not change the users who were given it. | role-test report, finding 7 |
| `POST /outlets` | **Creating outlets stays open to `manage_outlets` holders.** Only editing is limited to the caller's own outlet. | A non-admin with `manage_outlets` can create an outlet but then cannot edit it (403 "outlet not permitted"). | #137 |
| Queued offline refund without permission | **Refund authority stays the A06 send-time rule** (`backend/internal/sync/sync.go` ~416). It is not judged at capture time, because capture time comes from the tablet and could be backdated. Owner decision 2026-11-10. | A refund that already committed replays as ok. An uncommitted refund sent by someone without `process_refund` is refused and stays stored on the tablet, unresolved, until someone allowed sends it. Nothing is dropped. | `docs/plans/2026-11-10-instant-permission-revoke.md`, Decisions 4 |
| Printer connect time | **Each print opens a fresh Bluetooth connection** and closes it after a short drain. | Bluetooth Classic printers take about 2-6 s to start a print from cold, and about 0.2 s right after another print. A slower first print is not a defect. | HANDOFF 2026-11-10 (#136) |

## B. Fixed

- **F01-F04, F16, F20 (input and API), F31:**
  - Backend `00171-gag`.
  - Backoffice `f3c6e901`.
  - POS OTA 2.12.0.
- **F28-F30 (ingredient count validation, field width, detail load):** Backoffice `f3c6e901`.
- **F05-F10, F27 (Backoffice) and F17, F19, F21, F23, F25, F32 (POS):**
  - Backoffice `206a7388`.
  - POS OTA 2.13.0.
- **F20 batch flag, F24 redemption amount:**
  - Backend `00173-heb`.
  - Backoffice `290b815e`.
  - POS OTA 2.13.3.
- **F18 typed equals pasted:** POS OTA 2.13.5.
- **F33 unsaved-count leave guard:** Backoffice `cab4ea26`.
- **F12 (history shows real dates and a "Hari shift" label), F26 (orders API returns `clientCreatedAt`, Backoffice and POS show the tablet time plus "Diterima server" when late, CSV columns Waktu Transaksi / Diterima Server / Hari Bisnis), F22 (takeover browser test and no-guard warning):**
  - Backend `00175-jos`.
  - Backoffice `89b230d6`.
  - POS OTA 2.13.6.
- **F11, F13, F14, F15:** resolved or superseded in Codex's own R2.
- **R11 F34, F35, F36:** Backoffice `82103714` and POS OTA 2.13.7 (PRs #130, #131). Expected now:
  - **F34:** a clean tab that reopens an ingredient count shows what another tab saved, without a page reload.
    A tab with unsaved input keeps that input.
  - **F35:** each of the eight receipt flags reads the same in the Backoffice switch, the on-screen receipt and
    the paper.
    - An absent or null flag means ON for order number, subtotal, discount, change and customer name, and OFF
      for tax, cashier and phone. This is what the printer has always done.
    - With today's stored settings, the switches for order number, customer name, discount, subtotal and change
      therefore show ON.
    - When "Tampilkan Kembalian" is OFF, the paper mock hides the change, and the success screen shows
      "Kembalian Rp X" above the receipt.
  - **F36:** the on-screen and printed receipt both show the time the sale was recorded on the tablet. That is
    the same value History shows, and it never moves on a rerender or sync.
- **R11 open-shift totals advisory** (owner decision 2026-11-09: label, no live aggregate). The totals stay a
  close-time snapshot. Expected in Laporan > Shift:
  - For an open shift, the Transaksi, Refund penjualan shift, Penjualan, Tunai, QRIS, Transfer and Kartu cells
    read "Belum dihitung" (hint: "Shift masih buka. Angka dihitung saat shift ditutup."), not 0.
  - The summary cards sum closed shifts only, and say how many shifts in the range are still open.
  - The CSV writes "Belum dihitung" in those columns (and Kas Akhir) for open shifts.
  - The cash-refunds-paid column stays live for open shifts.
- **LOW findings from our 2026-11-09 run** (PR #135): Backoffice `1043b4c4` and POS OTA 2.13.8 (APK 2.2 only). Expected now:
  - **CSV placeholder:** an empty "-" cell (or a lone + − – —) is written as `-`, not `'-`. Text that starts
    with = @ + - and is not a plain number still gets the guard quote.
  - **One date-time format:** every date-time cell in the sales CSV (Waktu Refund), the refund CSV (Waktu) and
    the shift CSV (Dibuka, Ditutup) reads `yyyy-MM-dd HH:mm`, the same as Waktu Transaksi.
  - **Totals add up:** the sales CSV and the Transaksi XLSX have "Tukar Poin" after the discount columns (right
    after Diskon in the CSV, after Rincian Diskon in the XLSX) and "Biaya Tambahan" after Pajak. Subtotal - Diskon - Tukar Poin + Pajak + Biaya Tambahan = Total, except for rounded orders,
    because orders store no rounding amount. A legacy order with points spent but no stored amount shows an
    empty Tukar Poin cell, not 0. The new columns shift later columns to the right.
  - **Ingredient count labels:** each count input is named "Jumlah dihitung <ingredient> (<unit>)".
  - **Kartu Stok SKU search:** starting a new search clears the previous results, so a stale SKU cannot be
    picked.
  - **POS refund dialog:** long product names wrap to two lines, and the full name shows on hover (title).
- **Bluetooth Classic receipt printing** (PR #136, **APK 2.3 / versionCode 14**). Expected now:
  - Serial-port (SPP) printers such as the Rongta RPP02N print. A printer chosen before the update keeps working without re-pairing.
  - BLE printers still go through BLE: the route is chosen per bonded printer at each print.
  - Tes Cetak, auto-print after a sale, Cetak Ulang Struk, History reprint, the shift recap and the tanda terima all print.
  - Two prints started back to back run one after the other, and neither is cut short.
  - Printer off or out of range: after about 10 s, a red "Gagal mencetak: printer tidak menjawab. Pastikan printer menyala, ada kertas, dan dekat dengan tablet."
  - Tablet Bluetooth off: at once, a red "Gagal mencetak: Bluetooth tablet mati. Nyalakan Bluetooth lalu coba lagi."
  - Bluetooth permission denied: "Gagal mencetak: izin Bluetooth ditolak. …". Every print error starts with "Gagal".
  - The rest of the app stays responsive while a print waits.
  - Verified on the test tablet on 2026-11-10 with the RPP02N.
- **Role test fixes** (PR #137; backend `00177-hab`, Backoffice `6456ed73`). Expected now:
  - **Outlet edits:** `PUT /outlets/{id}` from a non-admin whose own outlet is not `{id}` → 403 "outlet not permitted". Admin can edit any outlet, even when assigned to one or sending `X-Outlet-Id`.
  - **Outlet & Gudang in Pengaturan:** for non-admins, edit and active controls show only on their own outlet.
  - **Pengguna:** Admin-only in the nav and on deep links ("Akses tidak diizinkan"). `manage_users` is no longer offered in the permission picker.
  - **Cashier sign-in:** the Backoffice refusal reads "Akun ini akun kasir. Masuk lewat aplikasi POS."
- **Instant permission revocation** (PR #138; backend `00179-duv` with migration 0087; Backoffice `01b98f0e`; POS OTA 2.13.9 for APK 2.3). Expected now:
  - **Revocation takes seconds, not 15 minutes.** Changing a user's role, outlet or permissions, resetting their password, or deleting them makes their older access tokens fail within about 5 s.
    - The user keeps working with the new rights after one silent refresh, in the Backoffice and the POS.
    - A user demoted to cashier is signed out of the Backoffice. A deleted user is signed out.
    - A 401 right after a successful refresh never signs anyone out, and nothing queued on the tablet is dropped or parked.
    - The owner verified a live round trip on 2026-11-10.
  - **Open-shift guard:** deleting a user, or moving them to another outlet, while they have an open shift returns 409. The Backoffice shows the message in red:
    - "Pengguna ini masih punya shift yang buka. Tutup shift-nya dulu sebelum menghapus."
    - "… sebelum memindah outlet."
    - The refused request changes nothing. Permission-only changes are still allowed mid-shift.
  - **Copy:** the POS shows "Sesi sedang diperbarui. Coba lagi." for a refresh-in-progress 401, and keeps "Sesi habis…" for a real sign-out.

## C. Still open or untested (fair to report)

- **Builds:** tablets still on APK 2.1 (code 12) or 2.2 (code 13) have no Bluetooth Classic printing and get no further OTAs. Only APK 2.3 (code 14) receives OTA 2.13.9 and later.
- **Giveaway endpoints:** `GET/PUT /outlets/{id}/giveaway` refuse an admin who is assigned to an outlet, for other outlets, unless `?outletId=` is passed. Pre-existing, unchecked.
- **No "disable user" state yet:** delete is refused while a shift is open. A disable option is a later slice.
- **Load:** a local step-1 run (1M orders, 500k customers) is in progress. Results will be in `docs/qa/2026-11-10-load-test-local.md`. Production-scale load is untested.
- **BLE printer path after #136:** untested, because no BLE printer was available. iOS does not apply.

- **Covered by our own run on 2026-11-09** (SM-X115, Android 16, APK 2.1 + OTA 2.13.7, live Backoffice; details
  in HANDOFF):
  - **Passed:**
    - OTA 2.13.3 to 2.13.7 applied with status `success`; F12/F18/F24/F26/F35/F36 checked on the device.
    - Samsung keyboard typing (via adb key events).
    - Native Back closes the keyboard, then checkout, History and the picker.
    - Offline sale + force-stop + relaunch: the sale arrived exactly once.
    - Offline refund + force-stop + relaunch: the refund arrived exactly once.
    - Portrait and landscape layouts at normal font: F25 gap 25 px; the 5-size picker fits.
    - Deployed export bytes (shift CSV, sales CSV, refund CSV, Transaksi XLSX), including the new time columns.
    - Laporan > Shift "Belum dihitung" with a real open shift.
  - **Found and FIXED in APK 2.2 (versionCode 13, PRs #134 + #133), verified on the tablet:**
    - **Landscape keyboard:** every POS sheet now ends above the soft keyboard (`--kb` from `visualViewport`).
      - Expected: with the Samsung keyboard open on the cash field, the cash field, Kembalian and Konfirmasi are
        all visible, in both orientations.
      - Measured in landscape: panel ends at 299 (the visible area), Konfirmasi 239-288. Portrait: 676 / 615-664.
    - **System font scale:** the WebView text zoom is pinned to 100%; the app's own SM/MD/LG setting is the size
      control.
      - Expected: Android's font size has no effect on the POS layout.
      - Measured at `font_scale` 2.0: body 14 px, the same as at 1.0, with no clipping.
    - Tablets still on APK 2.1 (code 12) do not have these fixes and get no further OTAs until they install 2.2.
  - **Found as LOW, fixed in PR #135** (see B): the CSV `'-` placeholder, mixed date formats, and the missing
    point-redemption column. Still open: rounded orders can differ from Total by the rounding amount (no
    stored rounding field; closing it needs a backend change).
  - **Not covered:**
    - Printer: now covered (2026-11-10, APK 2.3, Rongta RPP02N over Bluetooth Classic). Scanner not tried.
    - Power and storage pressure.
    - Role-separated testing: now covered on a local copy on 2026-11-10 (`docs/qa/2026-11-10-role-test-local.md`, 28/28 API checks). Live role tests with real cashier and manager accounts on a tablet remain fair game.
    - Load: see the load item at the top of this section.
    - Real finger typing on the soft keyboard.
- **External consumers of the old `Tanggal` column** have not been inventoried (outside the repo).
- **R10 and R9 probe candidates, now settled:**
  - **Repeated ingredient field labels:** fixed in PR #135 (see B).
  - **SKU results kept during a new search:** fixed in PR #135 (see B).
  - **Many-variant picker height:** passes in both orientations, including at font scale 2.0.
  - **Long similar names in refunds:** fixed in PR #135 (see B): two lines plus a hover title.
- **CheckoutPanel:** a stale overstock / leave confirm can remain after Back. This predates the QA work and is not
  fixed (HO:53). It cannot occur while `allowNegativeStock` is on (the current setting), because the overstock
  confirm never appears.
- **Narrow 375 px checkout horizontal scrollbar:** phone width is not a stated requirement. No owner decision is recorded.
