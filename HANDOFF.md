# HANDOFF — current state (read this first)

Short, living handoff for Claude sessions. **Overwrite "Now" and "Next" at each milestone; keep it under
~150 lines.** History: git log, `docs/plans/`, and earlier versions of this file (`git log -p HANDOFF.md`).
`SESSION_HANDOFF.md` (Codex era) is historical — read by section only.

Last updated: 2026-10-11 by Claude (Opus 5.5).

## Progress board (update when a slice moves; show it at the end of every reply)

Goal: production-ready POS = 8 P0 audit findings closed + release gates. **6 of 8 done.**

| P0 | Finding | Status |
|---|---|---|
| A13 | Concurrent transfers double-move stock | **Done** — slice 1 |
| A11 | Retried writes applied twice | **Done** for /sync/batch — slice 2 |
| A01 | Sale not durable on device | **Partial** - awaited writes (APK 1.1+); slice 9 SQLite journal: plan `docs/plans/2026-10-11-p0-slice9-a01-journal.md` (owner answers recorded), Phase A (seam + journal store) done locally + Opus-reviewed twice, not pushed; next Phase B (initJournal migration, wiring, synced refunds) |
| A02 | Network failures park/delete financial events | **Done** — slice 5 (APK 1.2+, emulator-verified) |
| A03 | Transfer-receive errors treated as competing receipt | **Done** — slices 3+5 (transfer receive not yet run on a device) |
| A04 | Queued events not bound to cashier/outlet | **Done** — slice 6, backend 00090-wof + APK 1.5 verified; legacy cutoff not set; slice 10 device registration open |
| A06 | Refund permission bypassed via sync | **Done (emulator-verified same-shift)** - slice 7 backend 00092-naf (mig 0047) + backoffice 64a608a + APK 1.6; not yet seen: cross-shift refund at close, backoffice refunder line visual |
| A09 | Sale/tender invariants not enforced | **Done** — slice 8 + 8c (backend 00088-qoh+, APK 1.4+); discount permission split to 8b |

## Now (live state)

- **Backend:** Cloud Run `mandalika-pos` revision **`00092-naf`** (100%, tag `rf7`) from `prod-hardening`
  @ `c3f86d0`. Contains slices 1–3, 6, 7, 8 + 8c, admin reset password. Migrations applied through **0047**.
  - Rollback: `gcloud run services update-traffic mandalika-pos --region asia-southeast2 --to-revisions mandalika-pos-00090-wof=100`
    (0047 columns are ignored by 00090-wof; refunds parked by the new rules would pass the old rules if retried).
  - Slice 7 (A06) `docs/plans/2026-10-11-p0-slice7-a06-refund.md`: shared refund rules (reason trimmed 1-500, only completed orders, already-refunded/cancelled -> conflict -> review, sanitized errors, admin no-outlet -> order's outlet); refund_shift_id/refunded_by(_name); shift close snapshots cross-shift refunds per method + cash_refunds_paid (live while open, null pre-0047); fingerprint-checked probes; server holds shift_close/shift_open behind an earlier retryable failure in the batch. Hosted smoke 11/11 (rejects-only, zero receipts).
  - `SYNC_LEGACY_ENVELOPE_UNTIL` is **unset on purpose** (envelope-less items from APK ≤1.4 accepted +
    logged). Set it to *APK 1.5 on every tablet + 14 days* via `--set-env-vars` on the next deploy.
    Date-only = 00:00 UTC = 07:00 WIB; use an explicit `+07:00` offset for WIB midnight.
- **Backoffice:** Cloudflare Pages `https://mandalika-pos.pages.dev` from `prod-hardening` (auto-deploys on
  push unless the head commit starts with `[CF-Pages-Skip]`). Has: payment-method "Tunai (masuk laci kas)"
  toggle, ⚠ Bayar badge, settings-driven payment filters, admin reset-password button.
- **POS:** **APK 1.6** (versionCode 7, run 38126838968) -> `Downloads/mandalika-apk/mandalika-pos-1.6-build7.apk` (slice 7: refund gate, review detail, recap net of refunds, synced-refund memory, isolation hold); Emulator-verified 2026-10-11: refund button + reason counter/disabled-when-blank; offline refund of BSD-G0007 (same shift) gives Tunai Tercatat 675.000 to 450.000 with 'Refund belum tersinkron -Rp 225.000', Riwayat 'Refund menunggu sinkronisasi'; online sync: server refunded, refund_shift_id = sale shift, refunded_by_name Administrator; Tercatat stays 450.000, 1 refund counted once, synced-refund memory recorded. Not run: cross-shift refund + close, printed slip, account without process_refund.
  Previous: **APK 1.5** (versionCode 6, run 38106865965) → `Downloads/mandalika-apk/mandalika-pos-1.5-build6.apk`.
  Emulator-verified: one-time "Pilih outlet terminal ini" for admin (binding `mandalika.pos.terminal`),
  outlet name in header, no logout/switcher (menu "Terminal" + guarded "Lepas terminal"), offline restart
  keeps session + open shift, offline sale carries envelope and syncs to the bound outlet (`BSD-G0007`).
  Not run: "Buka Shift blocked offline" (needs a closed shift). Fleet still to be upgraded.
- **What's in the shipped slices (details in the plans):**
  - Slice 6 (A04a) `docs/plans/2026-10-11-p0-slice6-a04-envelope.md`: capture-time envelope
    {v, outletId, userId, deviceId, capturedAt, shiftId}; server `attribute()` (mismatch → non-retryable
    `actor_mismatch` → POS review, never deleted; already-applied retry replays as duplicate); fixed
    terminal; terminal unlocks for another account only when every unsettled item is parked AND stamped;
    mismatch screen keeps a flush-only engine; concurrent shift_open serialized (outlet row
    `FOR NO KEY UPDATE`); `/sync/version` without outlet → 403.
  - Slice 8 + 8c `docs/plans/2026-10-11-p0-slice8-a09-tender-rules.md`: tender rules (direct cash-short → 422;
    batch accepts + flags `tender_warning`/`_reason`; ±Rp1); per-method `isCash` (default `cash`/`tunai`);
    shift cash_sales per flag at close; POS cash field (blank = exact total).
  - Admin reset password `docs/plans/2026-10-11-admin-reset-password.md`: `POST /users/{id}/reset-password`
    (admin-only, not self, 8–128 chars, revokes all sessions via Redis marker, clears lockout); PUT password removed.
- **Hosted smokes:** zero-residue scripts pattern (Node fetch, secrets from Secret Manager, never printed).
  Neon test DB read-only checks: `psql "$(gcloud secrets versions access latest --secret=DATABASE_URL --project mandalika-pos)"`
  with `BEGIN READ ONLY`.
- **Deploy pattern:** CI green on the pushed commit → `gcloud run deploy mandalika-pos --source backend
  --region asia-southeast2 --project mandalika-pos --no-traffic --tag <≥3 chars> --quiet` → smoke the tag URL
  → `update-traffic --to-revisions <rev>=100`. Owner go-ahead needed for deploys, migrations, APK builds,
  pushes to prod-hardening. APK builds use **origin**: push first, then
  `gh workflow run android-release.yml --ref prod-hardening -f api_url=https://mandalika-pos-538849926142.asia-southeast2.run.app`.
- **CI:** backend (with `-race`), Mandatory PostgreSQL (10 gates incl. TD tender, EV envelope), JS/TS,
  Chromium browser gate. dependency-security fails on 24 pre-existing blockers (not a deploy gate; was 26).
  Local PG gate: `python scripts/ci/postgres_gate.py --runtime native --pg-bin "C:/Program Files/PostgreSQL/18/bin" --no-race --output <f>.json`
  (no cgo locally → `-race` only in CI). Git hook blocks any commit command line containing `-n`/`--no-…`
  tokens (e.g. `grep -n`, `--no-edit`, `--no-ff` in the same command) — run them separately.

## Emulator

AVD `mandalika-tab` (Android 15, 2560×1600). Start cold:
`"%LOCALAPPDATA%\Android\Sdk\emulator\emulator.exe" -avd mandalika-tab -no-snapshot-load`.
**It hangs after the PC sleeps** (qemu becomes unkillable → Windows restart): close it before sleep.
Drive with `adb` (`install -r`, `input tap`, `svc wifi/data disable|enable`, `am force-stop com.mandalika.pos`).
Prefer reading the WebView over screenshots: `adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>`
then CDP `Runtime.evaluate` (helper: a small `cdp.mjs`; Preferences keys `mandalika.pos.terminal`, `mandalika.pos.user`;
on APK 1.7+ `mandalika.pos.outbox` is only a sentinel (`{"movedTo":"journal",...}`) after migration: inspect the queue with
CDP `await Capacitor.Plugins.OutboxJournal.readAll()` -> `{rows:[{key,seq,json}], meta}`; `open()` reports `synchronous` (must be 2)). Claude may not type passwords/PINs — the owner logs in
(admin `admin@mandalika.test`). Stylus popup disabled via `settings put secure stylus_handwriting_enabled 0`.
Emulator DNS broke on 2026-10-11 (every host unknown, even with -dns-server); fixed with Private DNS: `adb shell settings put global private_dns_mode hostname` and `settings put global private_dns_specifier dns.google`.
Test sales: Holy Sweet 10ml (Rp 225.000) at BSD; customer Danny (081929128271).

## Decisions (owner)

- 2026-10-10 (remediation plan §4): shared terminal account; no POS outlet switcher/logout; never wipe an
  unsynced queue; old-format events accepted one release / 14 days then review; cash below total = reject
  online / accept-and-flag offline; non-cash mismatch = keep + flag; denied offline refund = visible
  needs-review cash movement, never deleted; competing transfer receipt = first wins, second → review;
  tablets at 0 pending before sync-changing deploys.
- 2026-10-11: tender ±Rp1; non-cash missing amount → 0 + flag; `isCash` flag per method; TUNAI blank = exact;
  offline "Buka Shift" blocked; admin accounts pick the terminal outlet once; different account refused
  while unstamped/pending items exist; late sales keep their closed shift (no recompute); operator per shift
  + refunder column deferred; reset password: admin types it, no forced change, revoke all sessions,
  admins may reset anyone except self.
- **Still open:** who resolves needs-review items (head office vs outlet TL) — no resolve screen exists yet.

## Next

1. **Slice 7 leftovers (optional):** cross-shift refund then close (server snapshot cash_refunds_paid), printed recap lines, refund as an account without process_refund, backoffice 'Refund dibayar (Tunai)' column and refunder line on BSD-G0007 (owner login).
0. ~~P0 slice 7 (A06 completion)~~ shipped 2026-10-11 — plan `docs/plans/2026-10-11-p0-slice7-a06-refund.md` (owner answers Q1–Q6, B1–B4 recorded). Phase A done locally (not pushed). Phase B = migration 0047 refund_shift_id/refunded_by + shift cash math + OpenAPI; Phase C = POS/backoffice → APK 1.6. Original scope per remediation plan §1/§2: refund reason
   parity, POS UI gate ("Proses Refund"), denied refund → visible needs-review cash movement (never
   deleted; deferred item: effect on shift expected cash), parity test table. Opus planner → Sonnet
   implementer → Opus review → failing-first PG gate → hidden-revision deploy. Pre-go-live: audit real
   accounts' `process_refund` (test DB: all 4 accounts have it; no role grants it by default).
2. **P0 slice 9 (A01b)** in progress: Phase B next (T4 initJournal, T5 wiring, T7 synced refunds), then Phase C (T6 Java plugin, T8 version 1.7, T10 decide.go strictly newer), then APK 1.7 + emulator kill tests. Read the plan's review-rule sections first.
3. **Rollout:** APK 1.5 to the fleet → set `SYNC_LEGACY_ENVELOPE_UNTIL`.
4. **Follow-ups (owner to prioritise):**
   - Slice 7: sales made while a shift_open is still syncing (incl. held by M3) carry no shift (envelope stamps only server-known shifts); pre-existing, window now longer.
   - Slice 7: backoffice list of late refunds (refunded_at > shifts.closed_at) missing; client sync batch has no size cap (413 risk on big backlogs); refund-vs-close race covered by reasoning only.
   - Head-office resolve screen for needs-review items (slice 6 review H1 follow-up).
   - Receipt numbers ≠ server numbers and can repeat across tablets (`apps/pos/src/cashier/orderRef.ts`:
     1-char device tag, per-install counter). Options: server per-outlet sequence, or registered device code (slice 10).
   - Receipt with stacked promos names only one and omits the points-redemption line.
   - Points policy: earned on pre-redemption total; refund claw-back clamps at 0 when already spent.
   - Refresh-token TTL is **8760 h (1 year)** — decide before go-live.
   - Slice 8b discount permission (who / max / offline override).
   - Riwayat & other screens use the UTC date before 07:00 WIB (`CustomerDetail.tsx:41`, `OpnameTab.tsx`,
     `MovementSummary.tsx:25`, csv filenames).
   - Operator per shift + `refunded_by` (needs a migration).
   - Slice 10 device registration; OTA `decide.go` must offer only strictly newer versions before first OTA.
   - Password ≥8 enforcement on user create / CSV import (default `changeme123`).
   - Engine flush-only mode could skip envelope-less items (slice 6 N1 LOW).

## Known gaps (not P0)

- No APK/OTA release ledger (artifacts expire after 90 days; OTA bucket empty) → keep APKs in `Downloads/mandalika-apk/`.
- Cloud Run runs as the default compute SA with `roles/editor` (over-privileged).
- A34 parent (CI enforcement) and all release gates remain open. Backoffice polls all order pages every 12 s.
- Administrator account had 149 unexpired refresh tokens (shared login) — cleanup/review later.
- Stale worktrees under `..\mandalika-pos-*` and `.claude\worktrees\` can be removed (branches merged).

## Working agreements (summary — full text in AGENTS.md)

Six rules (ask / scope / flag / verify / show / admit). Routing: Fable guardian only on request; Opus plan +
review of risky surfaces; Sonnet implements; Haiku search/chores. End every reply with the progress board.
Update this file before context compaction and at the end of each milestone.
