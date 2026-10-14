# HANDOFF — current state (read this first)

Short, living handoff for Claude sessions. **Overwrite "Now" and "Next" at each milestone; keep it under
~150 lines.** History: git log, `docs/plans/`, and earlier versions of this file (`git log -p HANDOFF.md`).
`SESSION_HANDOFF.md` (Codex era) is historical — read by section only.

Last updated: 2026-10-14 (night) by Claude (Opus 5.5).

## Progress board (update when a slice moves; show it at the end of every reply)

Goal: production-ready POS = 8 P0 audit findings closed + release gates. **8 of 8 P0s done.**
Remaining before go-live: fleet rollout of APK 1.9, legacy-envelope cutoff, A34 leftovers (see Known gaps), follow-ups below.

| P0 | Finding | Status |
|---|---|---|
| A13 | Concurrent transfers double-move stock | **Done** — slice 1 |
| A11 | Retried writes applied twice | **Done** for /sync/batch — slice 2 |
| A01 | Sale not durable on device | **Done** — slice 9 SQLite journal, APK 1.7, emulator-verified |
| A02 | Network failures park/delete financial events | **Done** — slice 5 (APK 1.2+) |
| A03 | Transfer-receive errors treated as competing receipt | **Done** — slices 3+5 (transfer receive not yet run on a device) |
| A04 | Queued events not bound to cashier/outlet | **Done** — slice 6; legacy cutoff not set; slice 10 device registration open |
| A06 | Refund permission bypassed via sync | **Done** — slice 7, emulator-verified (same-shift refund) |
| A09 | Sale/tender invariants not enforced | **Done** — slice 8 + 8c; discount permission split to 8b |

## Now (live state)

- **Backend:** Cloud Run `mandalika-pos` revision **`00100-wul`** (100%, tag `gates50`, labels commit-sha=`f08c94f`,
  deploy-tag=gates50), deployed + promoted with the new gated scripts. = review resolve (0048) + OTA guard (0049) +
  OTA commit binding (**0050**); env `JWT_REFRESH_TTL_HOURS=720`. Migrations through **0050**.
  - Rollback: `gcloud run services update-traffic mandalika-pos --region asia-southeast2 --project mandalika-pos --to-revisions mandalika-pos-00098-yun=100`
    (00098-yun = before 0050; it ignores the commit_sha column).
  - `SYNC_LEGACY_ENVELOPE_UNTIL` **unset on purpose** (envelope-less items from APK ≤1.4 accepted + logged).
    Set it to *APK ≥1.5 on every tablet + 14 days* via `--set-env-vars` on a deploy. Use an explicit `+07:00` offset.
- **Backoffice:** Cloudflare Pages `https://mandalika-pos.pages.dev`, last deployed `307fb1b` (new "Tinjauan Sinkron" screen +
  badge, permission `resolve_sync_review`). Auto-deploys on push unless the head commit starts `[CF-Pages-Skip]`.
- **POS:** **APK 1.9** (versionCode 10, run 38238041869, from `f08c94f`, release_type test) →
  `Downloads/mandalika-apk/mandalika-pos-1.9-build10.apk` + `.manifest.json` (sha256 `ceaf16cb…3ac4`). = 1.8 + native logging
  fix (`loggingBehavior 'debug'`: 1.7/1.8 shipped `'production'`, which ALWAYS logs). Emulator: 1.8→1.9 `install -r` kept
  session/terminal/queue; 0 console lines in logcat. **1.9 is the fleet APK** (1.8 build9 = superseded, same versionCode
  was reused by a test build with different native config, so never OTA against code 9).
  Older APKs (1.1–1.7) are in the same folder. **Fleet still on old versions** — not rolled out.
  - Slice 9 (plan `docs/plans/2026-10-11-p0-slice9-a01-journal.md`): outbox in an in-repo SQLite plugin
    (`OutboxJournalPlugin.java`, TRUNCATE + synchronous FULL, one transaction per save, never REPLACE, corruption
    never deletes the file); first-launch move copy→verify→backup→sentinel→sealed (resumable, one-way; after takeover
    any failure = BootError, never an empty queue); synced-refund memory in the journal; Android backup excludes the
    journal, Capacitor Preferences, WebView storage and Capgo state (restored tablet starts clean); Capacitor logging = production.
  - Emulator-verified 2026-10-11: 1.6→1.7 offline upgrade moved 2 queued sales byte-identical and synced once each;
    kill -9 at 50/200/800/2000 ms after Konfirmasi kept every sale; corrupt DB header → BootError, file kept (same md5);
    backup/restore via bmgr → clean start. Not on device: kill during the first migration (unit-tested).
  - Slice 7 on APK 1.6+ (plan `docs/plans/2026-10-11-p0-slice7-a06-refund.md`): refund gate (permission / open shift /
    no queued refund), reason 1–500, review detail, recap net of same- and cross-shift refunds, server holds
    shift_close/shift_open behind an earlier retryable failure. Verified: offline same-shift refund BSD-G0007.
- **Earlier slices:** plans in `docs/plans/2026-10-11-p0-slice6-a04-envelope.md`, `…slice8-a09-tender-rules.md`,
  `…admin-reset-password.md`, `docs/plans/2026-10-10-p0-remediation-plan.md`.
- **Deploy pattern:** CI green on the pushed commit → `scripts/deploy-backend.sh <tag>` (refuses unless clean + on
  origin/prod-hardening + all 4 gates green; deploys a clean export of that SHA, labels the revision `commit-sha`; traffic-free;
  prints rollback) → smoke the tag URL → `scripts/promote-backend.sh <tag>` (re-checks the label's commit is CI-green, then `/readyz`). APK builds use **origin**: push first, then
  `gh workflow run android-release.yml --ref prod-hardening -f api_url=https://mandalika-pos-538849926142.asia-southeast2.run.app`.
  The release workflow re-runs the PG gate; Docker Hub rate limits ("toomanyrequests") → `gh run rerun <id> --failed`.
- **CI:** backend (`-race`, **gofmt** — committed files must be gofmt-clean; CRLF working copies look dirty locally,
  check with `git show HEAD:<f> | gofmt -l`), Mandatory PostgreSQL (11 gates incl. RF refund parity), JS/TS
  (`corepack pnpm quality:ci`), Chromium browser gate (`corepack pnpm browser:ci`). dependency-security fails on
  24 pre-existing blockers (not a deploy gate). Local PG gate:
  `python scripts/ci/postgres_gate.py --runtime native --pg-bin "C:/Program Files/PostgreSQL/18/bin" --no-race --output <f>.json`.
- **Git hook:** blocks any command line containing `-n`/`--no-…` tokens (also inside commit text, e.g. "pre-native").
  Write commit messages to a file and use `git commit -F <file>`; run greps separately.
- **Hosted checks:** smoke scripts use Node fetch with secrets from Secret Manager (never printed). Neon read-only:
  `psql "$(gcloud secrets versions access latest --secret=DATABASE_URL --project mandalika-pos)"` with `BEGIN READ ONLY`.

## Emulator

AVD `mandalika-tab` (Android 15, `userdebug` → `adb root` works). Start cold:
`"%LOCALAPPDATA%\Android\Sdk\emulator\emulator.exe" -avd mandalika-tab -no-snapshot-load`. **Close it before the PC
sleeps** (`adb emu kill`, then stop leftover `emulator.exe`). APK 1.8 installed, admin logged in, terminal outlet = Mandalika BSD, shift open, queue empty.
- DNS often breaks after a cold boot: re-apply Private DNS
  (`settings put global private_dns_mode off`, then `hostname`, `private_dns_specifier dns.google`).
- Read the WebView, not screenshots: `adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>` + a small CDP
  `Runtime.evaluate` helper. Queue: `await Capacitor.Plugins.OutboxJournal.readAll()`; `open()` must report
  `synchronous: 2`, `journalMode: "truncate"`. `mandalika.pos.outbox` in Preferences is only the sentinel now.
- Claude may not type passwords/PINs — the owner logs in (admin `admin@mandalika.test`).
- Test sales: Holy Sweet 10ml (Rp 225.000) at BSD. Receipt numbers BSD-G0010..13 now exist twice on the server
  (June test orders + 2026-10-11 tests) — the known receipt-number reuse, not duplicates.

## Decisions (owner)

- 2026-10-10: shared terminal account; no POS outlet switcher/logout; never wipe an unsynced queue; old-format events
  accepted one release / 14 days then review; cash below total = reject online / accept-and-flag offline; denied offline
  refund = visible review item, never deleted; competing transfer receipt = first wins; tablets at 0 pending before
  sync-changing deploys and APK upgrades.
- 2026-10-11 (slices 6/8): tender ±Rp1; per-method `isCash`; TUNAI blank = exact; offline "Buka Shift" blocked; admin
  picks terminal outlet once; late sales keep their closed shift; reset password rules.
- 2026-10-11 (slice 7): already-refunded/cancelled → refuse → review; refund cash recorded on the refunding shift
  (mig 0047, refunded_by); refund paid back in the original method; backoffice refunds → no drawer; POS refund needs an
  open shift; reason ≥1 non-space, ≤500; tablet remembers synced refunds; server holds shift_close AND shift_open
  behind an earlier temporary failure in the same batch.
- 2026-10-11 (slice 9): journal failure before takeover → keep selling on old storage + warning; after takeover → stop;
  in-repo SQLite plugin; transfer PIN stays in the queued item (follow-up: one-time server approval); OTA strictly newer;
  backup excludes journal + Preferences + WebView/Capgo state; debug logging off; OTA "builtin" risk = release rule now.
- 2026-10-12: **head office** resolves review items (see + mark handled, no approve-and-apply); resolved items are removed
  from the tablet; new permission `resolve_sync_review`; refresh-token TTL **30 days** (`JWT_REFRESH_TTL_HOURS=720`, ships
  with the next backend deploy); **APK 1.7 rollout held** for 1.8 (= 1.7 + review reporting); debug flag stays on until go-live.

- 2026-10-14 (audit-sweep answers): **finish every non-policy open finding before the Fable re-audit**; findings that need
  owner policy (A16–A22 loyalty/returns/exchanges/offline inventory, A08 offline transfer approval) wait for the re-audit.
  APK 1.9 is NOT rolled out until production-ready; legacy-envelope cutoff = go-live checklist step.
  - **A36 backups:** prod will leave the Neon free tier. Keep backups **1–2 years**; acceptable data loss **< 3%** (owner's words —
    translate into a concrete RPO/RTO with the owner, e.g. PITR ≤ 15 min + daily off-host logical dumps). Research POS DB-management
    best practice + best value managed Postgres/backup services and recommend before building.
  - **A14 stock count:** add an already-completed guard (no double apply). Stock moving during a count must not block operations:
    apply the **difference** — final = current + (counted − frozen). Owner example: frozen 15, 3 sold during count → 12; counted 14
    → 11, counted 16 → 13. Caveat to design for: counts must reflect stock at freeze/count time (per-item count timestamp).
  - **A33 Redis:** owner unsure → recorded default: tablets sell offline through at least a full trading day with no degradation;
    a Redis outage must never log anyone out or block server startup — Postgres is the auth authority, Redis a cache only.
  - **A39 CSV:** import is a real onboarding feature (initial catalog/customers) → fix properly (standards parser, preview, row
    errors, formula-safe export).
  - **A44 short stock:** never block a sale (negative stock allowed, matches allowNegativeStock default) but **flag and report**
    every oversold line so auditor/cashier human errors surface.

## Next

0. **NOW (2026-10-14): finish non-policy audit findings** — source of truth `docs/audits/2026-10-14-audit-status-sweep.md`.
   Order: (a) A14 completion guard + difference apply; (b) receipt numbers repeat across tablets/reinstalls (orderRef.ts);
   (c) A38 dependency blockers; (d) quick wins A43/A12 leftovers, A32 pool limits, A40 RUNBOOK, A42 lock order;
   (e) A36 research → plan; A33 Redis-optional auth; A39 CSV; A44 oversell flag/report; (f) medium: A05/A07, A10, A15, A41,
   A28, A30, A37, A23/A26/A27/A29/A35 leftovers. Then the Fable re-audit (new session).
   **Status 2026-10-14 (nothing pushed/deployed):**
   - (a) A14: plan `docs/plans/2026-10-14-a14-stock-count-delta.md`; commits 81efa55 + 42fd319 on prod-hardening (mig 0051,
     PG gate SC). Two Opus fix rounds → **done** on prod-hardening through 9a9e148 (520bc19 replay-disagree 409, e8d75c2
     save race + flush-then-complete, 9a9e148 refresh-before-clear + 20 s PUT timeout). SC gate 16 subtests. Not yet
     browser-checked. Neon read-only 2026-10-15: no outlet has 2 open shifts; all outlet codes match ^[A-Za-z0-9]{2,4}$.
   - (d) A12/A43/A42/A32 quick wins: one worktree implementer (mig 0053 open-shift partial unique index, shiftId outlet
     check on direct routes, strict bodies, sorted stock/code locks + retryBusy on direct routes, DB_MAX_CONNS=10 +
     --max-instances 4). A40 RUNBOOK after merges. **xlsx applicability decisions expire 2026-10-23** (re-review due).
   - (b) receipt numbers: plan `docs/plans/2026-10-14-receipt-number-device-code.md`; commit 0d801ab on branch
     `worktree-agent-ac068f1def4d42db0` (mig 0052 `pos_devices`, `POST /pos/devices/register`, PG gate DV, numbers
     `{OUTLET}-{CODE≥2 letters}{SEQ}`); Opus review running.
   - (c) A38: 6 commits on branch `worktree-agent-ab63d06de246a2821` (Go 1.26.9, chi v5.3.0, npm pins, exceptions for
     x/crypto openpgp GO-2026-5932 + rgbcolor licence, expiry 2027-01-12 — **owner sign-off needed**); full scan not
     runnable locally (network) → CI confirms on push; Opus review running. CI artifacts download only via PowerShell
     `Invoke-WebRequest` (gh's TLS to the blob host times out here).
   - Release order: merge both branches → push → CI green → deploy backend (0051+0052) BEFORE any backoffice deploy (new
     StockCount screen against the old backend wipes count lines) → APK for receipt numbers (emulator check).
0b. **Done 2026-10-12:** head-office review resolve shipped (backend 00096-neh, backoffice 307fb1b, APK 1.8 built + emulator-verified).
1. **Rollout (ready):** APK 1.9 to every tablet (each at 0 pending first; install over the old app — `install -r` keeps data,
   never uninstall with pending items). Then set `SYNC_LEGACY_ENVELOPE_UNTIL` = rollout date + 14 days.
2. **OTA guard DONE 2026-10-12** (rev 00098-yun, mig 0049): each OTA release targets exactly one APK build
   (`ota_releases.native_version_code`); `/ota/check` matches Capgo's `version_code` and fails safe (missing/invalid → no release);
   `/ota/publish` requires `nativeVersionCode`; `make ota-release VERSION=x.y.z` reads it from `apps/pos/android/app/build.gradle`
   (gated on a clean, pushed commit with all 4 CI gates green, built from a clean worktree of that SHA; `OTA_RELEASE_TYPE=test|production`,
   production also runs the debug gate; each release is bound to its commit via `commitSha` (mig 0050, live in 00100-wul).
3. **Optional device checks:** slice 7 cross-shift refund then close (cash_refunds_paid), printed recap lines, account
   without process_refund, backoffice refund column/"oleh" on BSD-G0007; slice 9 kill during first migration.
4. **Follow-ups (owner to prioritise):**
   - Review-resolve follow-ups (LOW): backoffice page step-back can cascade to page 1; "Dilaporkan" label can go stale after
     "Coba lagi" races; report endpoint body cap 8 MiB vs tablet 50 items; English 404 text; moved-tablet items never cleared.
   - Quarantine action for a corrupt journal row (`quarantineCorruptRows`
     exists, nothing calls it).
   - Receipt numbers repeat across tablets/reinstalls (`apps/pos/src/cashier/orderRef.ts`) → server sequence or slice 10 device code.
   - Sales made while a shift_open is still syncing carry no shift; backoffice list of late refunds; no client sync batch size cap.
   - Transfer-receive PIN → one-time server approval. `webContentsDebuggingEnabled: true` still TEMP in `capacitor.config.ts`.
   - Slice 8b discount permission.
   - Receipt with stacked promos names one promo and omits points redemption; points claw-back clamps at 0.
   - UTC-date-before-07:00-WIB screens (`CustomerDetail.tsx:41`, `OpnameTab.tsx`, `MovementSummary.tsx:25`, csv names).
   - Operator per shift; password ≥8 on user create/CSV import; slice 10 device registration; engine flush-only N1 LOW.
   - Pre-go-live: audit which real accounts hold `process_refund`.

## Known gaps (not P0)

- A34 release gates (2026-10-12): APK workflow has `release_type` test|production — production FAILS on debug settings
  (proven: run 38234410046 failed at the gate with exactly webContentsDebuggingEnabled + SyncProvider debug); every APK carries
  `release-manifest.json` (commit, version, sha256). OTA + backend paths gated by `scripts/lib/require-green-ci.sh` (clean
  tracked tree, HEAD on origin, 4 push-event gates green); builds/deploys come from a clean export of the tested SHA; Cloud
  Run revisions carry commit-sha + deploy-tag labels and `promote-backend.sh` re-verifies them. Open A34 leftovers: branch
  protection needs GitHub Pro (owner: spending); backoffice deploys on push (owner chose to keep); OTA release type defaults to
  test and is not stored; dependency-security's 24 blockers = A38; gate misses a backtick computed key; Git Bash rewrites
  `--env KEY=/path` values. Backoffice polls all order pages every 12 s. Backoffice polls all order pages every 12 s.
- Cloud Run runs as the default compute SA with `roles/editor` (over-privileged).
- No APK/OTA release ledger (CI artifacts expire after 90 days; OTA bucket empty) → keep APKs in `Downloads/mandalika-apk/`.
- Administrator account had 149 unexpired refresh tokens (shared login) — cleanup/review later.
- Untracked review ZIPs and `PHASE_HANDOFF.md` in the repo root/docs are leftovers (never commit them); stale worktrees
  under `..\mandalika-pos-*` and `.claude\worktrees\` can be removed.

## Working agreements (summary — full text in AGENTS.md)

Six rules (ask / scope / flag / verify / show / admit). Routing: Fable guardian only on request; Opus plan + review of
risky surfaces (every diff touching sync/outbox/stock/auth/payments/generated types, even after fixes — this session's
reviews caught several data-loss bugs); Sonnet implements, tests first; Haiku search/chores. End every reply with the
progress board. Update this file before context compaction and at each milestone.
