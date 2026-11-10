# Codex QA sweep R12: brief (prepared 2026-11-10)

For the Codex QA agent. Read this first, then `docs/qa/codex-deliberate-leftovers.md`. That doc tells you what
not to re-flag (section A), what is fixed and how it should behave now (section B), and what is still open
(section C).

## 1. What you are testing

Everything below is the pre-launch **test** environment and holds test data only.

| Part | Build | Where |
|---|---|---|
| Backend | Cloud Run revision `mandalika-pos-00179-duv` (commit `39ef5ec5`, migrations up to 0087) | `https://mandalika-pos-538849926142.asia-southeast2.run.app` |
| Backoffice | published from `01b98f0e` | `https://mandalika-pos.pages.dev` |
| POS (tablet) | **APK 2.3 (versionCode 14)**, built from `cdcfa44e`, plus OTA **2.13.9** | Android tablet |
| POS (browser) | the same web bundle in Chromium | dev and QA only (see A: F22 / W01) |

- **APK version matters.** A tablet on APK 2.1 (code 12) or 2.2 (code 13) has no Bluetooth Classic printing and receives no new OTAs. Note the APK version (Koneksi screen, or `versionName`) in every device finding.
- **Accounts:** the owner provides the sign-ins, including a manager and a cashier for the role checks. Claude does not create accounts on this environment.

## 2. What changed since R11

| PR | Change | Where to read "expected" |
|---|---|---|
| #132 | Open-shift totals read "Belum dihitung" in Laporan > Shift and the shift CSV | leftovers B |
| #133, #134 | APK 2.2: sheets stay above the soft keyboard; Android font size no longer scales the POS | leftovers C, "Found and FIXED in APK 2.2" |
| #135 | Export fixes: `-` placeholder, one date-time format, Tukar Poin and Biaya Tambahan columns, ingredient labels, Kartu Stok SKU search, refund-dialog names | leftovers B |
| #136 | Bluetooth Classic (SPP) receipt printing, APK 2.3 | leftovers B |
| #137 | Outlet edit scope, Admin-only Pengguna, Indonesian cashier refusal | leftovers B |
| #138 | Instant permission revocation and the open-shift guard on user delete and outlet move | leftovers B |

## 3. Focus areas, in priority order

1. **Sessions and revocation (#138).** This is new and touches sign-in for everyone. Try it in both the Backoffice and the POS:
   - Remove a permission from a signed-in manager, then use it. Within about 5 s it should be refused, and the session should continue with the remaining rights: no sign-out and no loop.
   - Demote a signed-in manager to cashier: the Backoffice signs them out.
   - Move a cashier with no open shift to another outlet: within seconds the bound tablet goes to the outlet-mismatch state and refuses sales until "Lepas terminal". Any queued old-outlet items go to sync review (`mismatchOutlet`); they are not dropped.
   - Reset a signed-in user's password: their sessions end at once. They sign back in with the new password, and their queue is kept.
   - Delete a user with no open shift: signed out. Try deleting, or moving the outlet of, a user **with** an open shift: 409 with the Indonesian message, and nothing changes.
   - Put the POS offline, revoke a right, bring it back online. Queued sales and refunds must not be dropped. A queued refund without permission stays unresolved (leftovers A).
   - Look for any path that signs a user out after a successful refresh, or that loops on refresh.
2. **Live role separation (#137 and the role-test findings).** Repeat `docs/qa/2026-11-10-role-test-local.md` on the live stack with real accounts:
   - the Backoffice nav and deep links per role;
   - API refusals (403) on gated routes;
   - outlet isolation (other outlets' orders and `X-Outlet-Id`);
   - outlet edits limited to the caller's own outlet;
   - Pengguna Admin-only.
3. **Printing (#136)**, if you have a device and a printer. Report the printer model and whether it is Classic or BLE.
   - Every print path: Tes Cetak, auto-print, Cetak Ulang Struk, History reprint, the shift recap, the tanda terima.
   - Back-to-back prints.
   - Printer off, Bluetooth off, permission denied.
   - A long receipt prints to the last line.
4. **Exports (#135):** CSV and XLSX column order, date-time format, and Subtotal − Diskon − Tukar Poin + Pajak + Biaya Tambahan = Total. Rounded orders are the known exception in C.
5. **OTA and APK:** on APK 2.3, OTA 2.13.9 applies with status `success`; a code-13 tablet is told it is up to date.
6. **Regression sweep:** spot-check every section B item from R10 and R11. A broken B item is a regression; label it so.

## 4. Ground rules

- **Test sales and refunds:** refund every test sale to zero and say so in the report. Use test products: the QA product, or the "Rehearsal DEMO" items.
- **Shared settings:** restore any setting you change (receipt flags, payment methods, points) and say what you touched.
- **No load testing** against this backend. It runs on free-tier Cloud Run and Neon; load testing runs on a local copy (leftovers C).
- **Test accounts:** remove any you create afterwards. Close their shift first, or the delete is refused by design.
- **Data:** no real customer data. Phone numbers in tests should be obviously fake.

## 5. Reporting

- **File:** `Mandalika-QA-Retest-R12-<date>.md`, in the same shape as R11.
- **Numbering:** new findings continue from **F37**.
- **Each finding includes:**
  - the build (backend revision, APK and bundle);
  - steps to reproduce;
  - expected, citing the leftovers row or this brief;
  - actual;
  - evidence (screenshot, response body, CSV bytes);
  - severity (P0-P3 or LOW).
- **Separate sections:**
  - "Regressions" (a B item broken);
  - "New findings";
  - "Re-checks passed";
  - "Not covered", with the reason.
- **Before reporting** anything in leftovers section A, check its "Expected" column. Report it only if what you see differs from that.
