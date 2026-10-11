# HANDOFF — current state (read this first)

Short, living handoff for Claude sessions (local and cloud/mwsh-vl). **Overwrite the "Now"
and "Next" sections at each milestone; keep it under ~150 lines.** History lives in git log
and `docs/`. The old `SESSION_HANDOFF.md` (~435 KB, Codex era, local-only) is historical:
read it by section only if a task needs old detail.

Last updated: 2026-10-11 by Claude (Opus 5.5; slice 6 code by Sonnet 5.5).

## Progress board (update when a slice moves; show it at the end of every reply)

Goal: production-ready POS = 8 P0 audit findings closed + release gates. As of 2026-10-10:

| P0 | Finding | Status |
|---|---|---|
| A13 | Concurrent transfers double-move stock | **Done** — live (slice 1) |
| A11 | Retried writes applied twice | **Done** for /sync/batch — live (slice 2) |
| A01 | Sale not durable on device | **Partial** — APK 1.1 awaits writes; full fix = SQLite journal (slice 9) |
| A02 | Network failures park/delete financial events | **Done** — slice 5 in APK 1.2/1.3 (emulator-verified 2026-10-11) |
| A03 | Transfer-receive errors treated as competing receipt | **Done** — slice 5 client + slice 3 server (transfer receive not yet run on device) |
| A04 | Queued events not bound to cashier/outlet | **In review** — slice 6 (A04a) on `feat/a04-envelope`, not merged/deployed: capture-time envelope + server attribution + fixed terminal; legacy cutoff (`SYNC_LEGACY_ENVELOPE_UNTIL`) to be set at fleet rollout (a date-only value means 00:00 UTC = 07:00 WIB; use an explicit +07:00 offset for a WIB midnight) (APK 1.5 on all tablets + 14 days); slice 10 device registration still open |
| A06 | Refund permission bypassed via sync | **Partial** — server gate live; slice 7 completes it |
| A09 | Sale/tender invariants not enforced | **Done (backend live)** — slice 8 tender rules + 8c cash identity live as 00088-qoh; POS cash input ships in APK 1.4; discount permission split to 8b |

**APK 1.1 emulator checklist (2026-10-10, partial):** pass — "Ya, hapus" gone / new bundle
running; online cash sale synced (`BSD-G0001`); guest sale; offline sale queued; queued sale
survived force-close; synced after manual "Coba lagi" (`BSD-G0002`). **Fail/findings:**
(1) restarting the app while offline LOGS OUT (refresh treated as rejected) — fixed in slice 5;
(2) after re-login, flushes before an outlet is picked got 403 "no active outlet" ×5 → sale
parked — fixed in slice 5 (403 counts nothing); (3) receipt showed `MND-127242` but server
stored `BSD-G0001`, and a new device restarts the per-device counter → duplicate order numbers
across devices (new follow-up); (4) admin's outlet choice not remembered across restarts
(slice 6 removes the switcher). **Not yet run:** customer+loyalty sale, promos (linked code /
BXGY / bundle), refund, Rekapan/Riwayat, shift close, transfer receive (needs owner PIN).
Test sales are tagged "EMU TEST" in notes.

**APK 1.2 emulator checklist (2026-10-11, build 38070526937, `db1a275`):** pass — login survives
upgrade; customer+loyalty sale (Danny, BCA, 225 pts, tier Baru→Biasa, `BSD-G0003`); stacked
combinable promos Tierison+TEST 2 + 225-pt redemption, cash (`BSD-G0004` Rp 87,750, synced, tier
→Setia); BXGY/min-spend guards greyed correctly; Riwayat lists all; refund of G0003 synced with reason;
Rekapan loads; shift close (Selisih 0) + new shift open synced; queue 0 throughout. **Fail:**
restart-while-offline STILL logs out (slice 5 only fixed the mid-session refresh; app-start path in
`auth.tsx` cleared the session on any error and read the token from localStorage because `getKV()`
was captured at import) → fix on `fix/pos-offline-boot` (39b4df7 + 1028b65, Opus-reviewed), ships
in APK 1.3. **Findings:** after upgrade with no outlet picked the app shows "Offline" (outlet-less
`/sync/version` 500 → engine treats as unreachable); receipt numbers `MND-698667`/`MND-467330` vs
server `BSD-G0003/4` again; receipt shows one promo label for two stacked promos and omits the points
redemption line (printed lines don't add up); points earned on pre-redemption total (110 on Rp 110,250
not 87 on Rp 87,750 — policy?); refund claws back earned points but clamps at 0 when already spent
(115 pts written off — policy?); Riwayat date defaults to the UTC day before 07:00 WIB; Rekapan shift
totals include older test orders (not reconciled). **Not run:** linked discount code, bundle,
transfer receive (needs owner PIN). Android stylus-handwriting popup disabled on the AVD
(`settings put secure stylus_handwriting_enabled 0`).

**APK 1.3 (2026-10-11, run 38075138469, `11b4d7a`) on emulator:** offline-restart fix
**CONFIRMED** — online boot migrated the token (marker set, token in Preferences, user cached,
localStorage copy gone); force-stop + relaunch offline stays logged in with the cached profile;
on reconnect the session renews (outlet list loads, BSD picked → Online/Tersinkron). **New finding
(POS, not fixed):** after an offline start the header shows "Buka Shift" even though the server
has an open shift — `apps/pos/src/hooks/useShift.ts:40-57` fetches `/shifts/current` once on mount,
an offline failure leaves `null` (no persisted last-known shift) and nothing refetches on
reconnect/outlet pick. Risk: cashier opens a duplicate shift (server allows two opens). Fix: persist
last-known shift + refetch on reachability/outlet change. Same reconnect also needs an outlet
re-pick for admin before going Online (outlet-less `/sync/version` 500).

**APK 1.4 (2026-10-11, run 38086323189, `0021eb3`, versionCode 5): emulator-VERIFIED** after a Windows restart (old qemu hung): TUNAI shows "Jumlah Dibayar" + quick amounts; typed 100000 < 225000 → "Kurang Rp 125.000", Konfirmasi disabled; Rp 300.000 → Kembalian Rp 75.000, receipt prints tunai/Kembalian, server `BSD-G0005` tunai paid 300000 change 75000 no flag; blank field → `BSD-G0006` paid 225000 change 0 no flag. Session survived the reboot. Not re-checked: Rekapan "Terhitung" survives resync.

**Emulator tip:** the AVD hangs after the PC sleeps (qemu becomes unkillable -> Windows restart). Close the emulator before the PC sleeps, or cold-boot it (emulator flag: no snapshot load).

**Emulator:** AVD `mandalika-tab` (Android 15 google_apis x86_64, 2560×1600, 4 GB) in
`%USERPROFILE%\.android\avd`; start `"%LOCALAPPDATA%\Android\Sdk\emulator\emulator.exe" -avd mandalika-tab`.
Drive with `%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe` (install, `input tap`, `screencap`,
`svc wifi/data disable|enable`, `am force-stop com.mandalika.pos`). The release APK has WebView
debugging on: `adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>` (pid from
`adb shell pidof com.mandalika.pos`) then Chrome DevTools Protocol `Runtime.evaluate` reads the
DOM and `Capacitor.Plugins.Preferences` (outbox key `mandalika.pos.outbox`). Claude may not type
passwords/PINs — the owner logs in (admin = `admin@mandalika.test`, password from
`gcloud secrets versions access latest --secret=SEED_ADMIN_PASSWORD --project mandalika-pos`),
then picks outlet Mandalika BSD.

Supporting work done: A34 client-IP spoofing fix, sync error contract (slice 3), backend CI
green, audit branch merged. **Waiting on owner:** APK 1.1 install + checklist
(`Downloads/mandalika-apk/mandalika-pos-1.1-build2.apk`).

## Now

- **Live (2026-10-11, later):** Cloud Run `00090-wof` (100%, tag `ev6`) from `prod-hardening` @ `6dd7baf` = slice 6 (A04a capture-time envelope + fixed terminal) on top of 00088-qoh. **No migration.** `SYNC_LEGACY_ENVELOPE_UNTIL` deliberately UNSET (legacy items accepted + logged); set it to (APK 1.5 on every tablet + 14 days) — a date-only value means 00:00 UTC = 07:00 WIB. Hosted smoke 10/10, zero residue (refund-of-missing-order returns `conflict` "order not refundable"; envelope v!=1 returns `actor_mismatch`, not `rejected`). Rollback: `--to-revisions mandalika-pos-00088-qoh=100` (envelope ignored there). **APK 1.5** (versionCode 6, run 38106865965) built green -> `Downloads/mandalika-apk/mandalika-pos-1.5-build6.apk`, **install + emulator check pending** (emulator hung again after host sleep; needs a Windows restart). Check: one-time "Pilih outlet terminal ini" for admin -> BSD, outlet name in header, survives restart, no logout/switcher, offline start shows open shift, Buka Shift blocked offline, offline sale carries `envelope` in Preferences and syncs to BSD.
- **Before that:** Cloud Run revision `00088-qoh` (tag `s8c`) from `prod-hardening` @ `34f4da0` = slice 8 (A09 tender rules, migration **0046** applied) + 8c payment-method cash identity (`isCash` flag; `tunai` = cash; shift cash_sales per flag) + admin reset password (`POST /users/{id}/reset-password`, PUT password removed). Hosted smoke 16/16, zero residue. Rollback: `--to-revisions mandalika-pos-00086-pac=100` (0046 columns harmless). APK 1.3 (offline-restart fix) built run 38075138469.
- **Previous:** Cloud Run `mandalika-pos` revision `00086-pac` (tag `errc`), built from
  `prod-hardening` @ `249fd35` = merged audit work + P0 slices 1 (A13), 2 (A11) and 3 (sync
  error contract), deployed 2026-10-10. Migration 0045 applied. Backoffice on Cloudflare from
  `fe52d6e` (slices 1–3 are backend-only).
  Rollback: `gcloud run services update-traffic mandalika-pos --region asia-southeast2 --to-revisions mandalika-pos-00084-rav=100`
  (00084-rav = A13+A11 without the error contract; older: 00082-yig, 00080-noh).
- **Develop on `prod-hardening`** (local checkout switched 2026-10-10).
- **Shipped 2026-10-10:** client-IP spoofing fix (A34e15: no chi RealIP, `TRUSTED_PROXY_HOPS=1`,
  IPv6 /64 buckets, normalized login email) + per-account failed-login cap (30 / 15 min).
  Live forged-header check passed 7/7.
- **Branches:** `audit/hosted-proof-20260922` was **fast-forwarded into `prod-hardening` on
  2026-10-10** (Opus review: no code blockers; JSON wire output unchanged). Backoffice changes
  (Reports date fix, full pagination) went live via Cloudflare (new bundle verified).
- **Until the next APK:** nobody presses "Ya, hapus" on the tablet — the old app deletes
  parked items, and the merged backend rejects more invalid input than before.
- **Pre-existing bugs seen in the deploy smoke (same on the old revision):** `/sync/version`
  returns 500 with a raw Postgres error for an account with no outlet (should be 400, and
  must not leak DB text); `/sync/outlet-transfers` needs a `status` param.
- **Workflow:** Claude-only (`AGENTS.md`), subagents in `.claude/agents/`.

## Decisions (owner, 2026-10-10)

Owner accepted all recommendations in `docs/plans/2026-10-10-p0-remediation-plan.md` §4:
merge the audit branch after the §3 checks; POS account = shared terminal (operator recorded
per shift); remove POS outlet switcher + logout, never wipe an unsynced queue; old-format queued
events accepted for one release / 14 days then review; offline-authority duration deferred to
slice 10; cash below total = reject online / accept-and-flag offline; non-cash mismatch = keep
and flag; denied offline refund = visible needs-review cash movement, never deleted; competing
transfer receipt = first valid wins, second → review; all tablets at 0 pending before
sync-changing deploys while pre-launch. Still open: who resolves needs-review refunds (head
office vs outlet TL).

**Refund permission (read-only query of the TEST Neon DB, 4 accounts, 2026-10-10):** all 4
effectively hold `process_refund` (Administrator = admin role; Yasmine/cashier BSD,
Anggun/manager BSD, test/manager PMS = explicit rows). The real fleet is not on this DB yet.
No role grants it by default: backoffice user creation stores only what is ticked in
`PermissionPicker` ("Proses Refund"), and the Firestore import (`fsmigrate/tables.go:264-268`)
copies each user's old permissions as-is. **Merge-prep item:** any real cashier without the
row can refund today via `/sync/batch` but will be denied after the A06 merge — audit the
real accounts' permissions before go-live (feeds decision 8). 7 refunded orders total, 6 under "test", 1 unattributed (no `refunded_by`
column exists — refunder isn't recorded). Administrator has 149 unexpired refresh tokens
(tokens accumulate / shared login) — worth a cleanup + token-reuse review later.

## Next

1. ~~Browser gate~~ **Fixed 2026-10-10 (`e1f7455`)**: it was a real backoffice bug — Reports
   defaulted to the UTC date but filtered by local day, so 00:00–07:00 WIB showed yesterday.
   Gate green inside that window. Same UTC-date pattern remains (not yet fixed, owner to
   decide): `CustomerDetail.tsx:41`, `OpnameTab.tsx:182,202`, `MovementSummary.tsx:25`,
   `csvUtils.ts` filenames; `auth.tsx` login day rolls at 07:00 WIB (UTC day).
2. ~~Merge prep~~ done 2026-10-10. Dependency-security (26 blockers) is not a deploy gate and
   every blocker also exists on pre-merge `prod-hardening`. Follow-ups:
   - **Next APK:** Capacitor 8.3.4 → ≥ 8.5.1 (critical GHSA-rvm3-566m-v7fv) + removes the
     destructive "Ya, hapus" button. Both need a native rebuild.
   - **Backend slice:** Go toolchain patch (stdlib 1.26.8 has 13 advisories), x/crypto bump,
     chi upgrade; build-only npm (brace-expansion, source-map-js); rgbcolor licence evidence.
   - **Scaling:** backoffice now loads all order pages on every 12 s poll and errors
     ("Data berubah saat dimuat") if rows change mid-load — fine for 1 tablet, not for 26.
3. ~~Backend deploy~~ done. ~~P0 slice 1 (A13)~~ done 2026-10-10: transfer row lock, guarded
   status updates, atomic guarded send decrement (sorted lines), lock-conflict retry
   (3 attempts) + clean 409 `ErrBusy`; PostgreSQL gate TR (11 subtests, fails on old code).
   ~~P0 slice 2 (A11)~~ done 2026-10-10: `operation_receipts` + `RunWithReceipt` make
   refund / shift_open / shift_close / cash_flow / customer_create exactly-once on
   `/sync/batch` (replay returns the original result; mismatch = clean conflict); migrations
   now run each file under `pg_advisory_xact_lock` (pooler-safe). PostgreSQL gate OR.
   CI gate image now pulled from `public.ecr.aws/docker/library/postgres:18.3` (Docker Hub
   rate limits blocked it).
   ~~P0 slice 3 (error contract)~~ done 2026-10-10: failed `/sync/batch` items carry `code`
   (rejected|forbidden|not_found|conflict|competing_receipt|key_conflict|busy|internal;
   actor_mismatch reserved) and `retryable` (present only on errors). Only marked
   rejections (`internal/apperr`) and PG class 22/23 except 23503 are non-retryable;
   unknown/server/connection errors are retryable `internal` with a sanitized message
   (raw error in logs). Concurrent duplicate orders return `duplicate`. **Clients must treat
   a missing or unknown `code` as today's behaviour.**
   ~~P0 slice 4 (A01a)~~ code done 2026-10-10 (`afc1b91`, `4c42dbe` on prod-hardening; ships
   in **APK 1.1 / versionCode 2**, built by run 38025511989 (`63c387d`; artifact `mandalika-pos-release-apk`, expires 2027-01-08), + Capacitor 8.5.3 critical-advisory fix):
   awaited fail-loud outbox writes (item only sendable after its write succeeded),
   corrupt-queue quarantine + banner, single-flight submit buttons, old engines disposed on
   logout, transfer_receive discarded only on competing_receipt/conflict/not_found,
   retryable errors don't burn attempts (reported after 10). **A01 still OPEN:**
   `@capacitor/preferences` uses `apply()`, so a resolved write isn't on disk yet — full
   durability needs the SQLite journal (slice 9). Tablet ran a `6093c6d` APK (v1.0).
   **Owner on-device checklist** (tablet at 0 pending/0 failed before install): sale
   survives force-close; "Ya, hapus" gone; guest sale; customer+loyalty sale; linked
   code/BXGY/bundle; refund (terminal account needs "Proses Refund", re-login); Rekapan +
   Riwayat; shift close; transfer receive prints TT; offline sale syncs after reconnect.
   **P0 slice 5 (A02+A03 client states)** — code + Opus review done on branch
   `feat/pos-review-states` (`193b741`, `80d1a03`), **NOT merged on purpose**: merge only
   after the owner signs off the APK 1.1 checklist (so a 1.1 hotfix can't ship untested
   slice 5), then ship in APK 1.2. Contents: rollback-safe review state (failed +
   attempts>=MAX + reviewCode), non-retryable codes → review, competing receipts → review
   with counts kept (PIN stripped), typed ApiError + 30 s batch / 15 s refresh timeouts,
   offline counts nothing, 5xx/timeout backoff 20 s→5 min, only 400/413/422 isolate items,
   other 4xx = "Masalah akun/outlet" (nothing parked). Deferred: denied-refund effect on
   shift expected cash. Before the first OTA: make `backend/internal/ota/decide.go` offer
   only strictly newer versions.
   CI flakiness today: Docker Hub, ECR Public and Maven Central all rate-limited/refused
   hosted runners once each (re-runs passed); consider caching the PG image in GHCR and
   Gradle download retries. setup-android no longer installs the removed `tools` package.
   Open follow-ups: corruption banner marker never clears; failed save burns an order
   number; release APK still has WebView debugging on; CI could inject versionCode.
   Follow-ups: no pruning job for `operation_receipts`; OR test goroutines use t.Fatalf;
   cold start ~1–3 s slower (locked per-file migration check); shift opens from two
   different keys at one outlet still both succeed.
   Small follow-ups: ingredient transfer sends don't sort lines (rare deadlock → raw 400 text);
   `/sync/version` 500 for outlet-less accounts.

## Known gaps (not P0)

- **Duplicate order numbers across devices (owner-flagged 2026-10-11).** `apps/pos/src/cashier/orderRef.ts`
  builds `{OUTLET}-{DEV}{SEQ}`: DEV is ONE base36 char hashed from the deviceId (1-in-36
  chance two tablets in an outlet share it) and SEQ is a per-install counter in KV, so a
  reinstall/new device restarts at 0001. Data stays correct (uniqueness key is
  `order_uuid`), but receipts/history can show the same number twice. Also seen: receipt
  `MND-127242` vs server `BSD-G0001` on APK 1.1. Fix options (owner to pick): server-assigned
  per-outlet sequence on sync with the client number as a provisional label, or a longer
  registered device code (fits slice 10 device registration).

- No APK/OTA release ledger (artifacts expired, OTA bucket empty) → no rollback artifact.
- Cloud Run runs as the default compute SA with `roles/editor` (over-privileged).
- A34 parent (CI enforcement) and all release gates remain open.

## Working agreements (summary — full text in AGENTS.md)

Six rules (ask / scope / flag / verify / show / admit). Routing: Fable guardian only on request;
Opus plan + review of risky surfaces; Sonnet implements; Haiku search/chores. Advisor: see
AGENTS.md. Update this file before context compaction and at the end of each milestone.
