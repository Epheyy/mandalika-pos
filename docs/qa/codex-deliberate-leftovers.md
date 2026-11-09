# Codex QA findings: what is deliberately left as-is

For the Codex QA agent before the next retest. It covers the findings in
`Mandalika-QA-Report-2026-11-07.md` (F01-F33, W01) and `Mandalika-QA-Retest-R10-2026-11-09.md`.

- **Section A** lists behaviour we chose to keep. Please do not re-flag these as unresolved. If what you
  observe differs from the "Expected" column, that is a real finding.
- **Section B** is what was fixed.
- **Section C** is what is still open or untested. Those are fair game.

Citations: `HO:n` = line n of `HANDOFF.md` at commit `f491d988` (`git show f491d988:HANDOFF.md`);
`TRIAGE` = `docs/plans/2026-11-08-qa-triage.md`.

## A. Deliberately left (do not re-flag)

| Id | Decision and why | Expected behaviour | Source |
|---|---|---|---|
| F22 / W01 | **Mitigated with a one-tab guard at the entry point only.**<br>- The APK is the production POS. A browser is for dev and QA only, in Chromium with Web Locks.<br>- The KV outbox (`packages/sync/src/outboxStore.ts`) still rewrites its whole array on every save. That is by design: there is a single writer.<br>- Making the guard fail closed is an owner decision, not a defect. | - A second Chromium tab shows "POS sudah terbuka di tab lain": no cashier controls, no writes, and the draft is kept.<br>- When the owning tab closes or navigates away, the waiting tab takes over by itself, with no reload.<br>- If the owning tab reloads while another tab waits, the waiting tab becomes the owner.<br>- A browser without Web Locks (for example plain-http LAN serving) has no guard and shows "Perlindungan satu tab tidak aktif di browser ini. Buka POS di satu tab saja."<br>- The APK shows no warning; it has a single WebView.<br>- Do not report the whole-array outbox store as an open bug. | HO:47; TRIAGE W01 "by design single-writer"; `docs/runbooks/browser-pos-support-policy.md` |
| F19 | **The 5-minute stock-only auto-pull floor is deliberate** (`packages/sync/src/autoPull.ts`). Only the wording changed. | - Stock can be up to 5 minutes behind.<br>- The chip changes to "Stok menunggu diperbarui" only for stock changed elsewhere, after a 60 s hold-off. It never changes for follow-ups to the tablet's own sales.<br>- Koneksi -> "Perbarui stok" pulls stock immediately. | TRIAGE F19 "DESIGN"; HO:47 |
| F20 (sync batch) | **A queued `shift_open` with a negative opening cash is still accepted and stored as sent, but flagged.**<br>- A queued shift is never dropped.<br>- Clamping the amount would skew drawer reconciliation.<br>- The input field and a direct API call both reject a negative. A tablet on a bundle older than OTA 2.12.0 can still queue -1. | - Buka Shift refuses a negative amount.<br>- `POST /shifts` with a negative returns 400 "kas awal tidak boleh negatif".<br>- A queued negative shift lands with its value and shows a red "Kas awal negatif" badge in Laporan > Shift. | HO:59; HO:27 |
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

## C. Still open or untested (fair to report)

- **R10 gaps not covered by us:**
  - native A9/A11+ viewports, Samsung keyboard, font scale, insets, native Back, printer and scanner;
  - native offline sale and refund recovery, force-stop, power and storage pressure;
  - role-separated cashier and manager testing;
  - pinned deployed versions;
  - load.
- **R10 and R9 probe candidates with no fix or decision yet:**
  - ingredient detail stays stale after another tab saves;
  - repeated ingredient field labels;
  - SKU results kept while a new search runs;
  - many-variant picker height;
  - identifying long product names in refunds;
  - receipt preview versus settings parity.
- **CheckoutPanel:** a stale overstock / leave confirm can remain after Back. This predates the QA work and is not fixed (HO:53).
- **Narrow 375 px checkout horizontal scrollbar:** phone width is not a stated requirement. No owner decision is recorded.
