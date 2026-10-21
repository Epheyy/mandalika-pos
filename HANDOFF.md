# HANDOFF — current state (read this first)

Short, living handoff for Claude sessions. **Overwrite "Now" and "Next" at each milestone; keep it under
~150 lines.** History: git log, `docs/plans/`, and earlier versions of this file (`git log -p HANDOFF.md`).
`SESSION_HANDOFF.md` (Codex era) is historical — read by section only.

Last updated: 2026-10-21 by Claude (Sonnet 5.5) - releases 8, 9, 10 live; everything pushed; see NEXT SESSION - START HERE at the top of Next.

## Progress board (update when a slice moves; show it at the end of every reply)

> 2026-10-17: A37 error_logs (redaction, 60-day retention, admin-only read pinned; PG gate EL 56459) is code-complete on
> branch a37-error-logs, NOT pushed or deployed (see Decisions #7).
>
> 2026-10-15: A33/A07 (Postgres auth authority, Redis optional; mig 0054, AU gate 56455) is code-complete and
> locally verified on a worktree branch, NOT yet pushed or deployed. Pending owner steps: Neon pre-deploy revoke of
> rows the current server already refuses (show count first), Neon snapshot, deploy-backend.sh smoke, promote.

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

- **SECRET ROTATION DONE 2026-10-17** (leak: Neon `DATABASE_URL` + `SEED_ADMIN_PASSWORD` in old versions of `.claude/settings.local.json`,
  commits a595fc6/34676aa; full-history search found NO other current secret; plan `docs/plans/2026-10-17-secret-rotation-and-history-purge.md`).
  Owner reset the Neon role password and added `DATABASE_URL` v2 (v1 disabled). Claude rolled Cloud Run revision **`00116-vev`**
  (100%, tag `rot1`, same image as rel7 + env `SECRETS_ROTATED_AT`; the service was down from the Neon reset until this roll:
  `/livez` 503 "db down" → 200). Admin password rotated via the app's own `auth.Store.ResetPassword` (209 sessions revoked, one-off
  script, not committed), new random value stored as `SEED_ADMIN_PASSWORD` v2 (v1 disabled); new password → 200, old → 401.
  Rollback note: older revisions also read `latest`, so rolling back to an old revision still uses the NEW secrets (good).
  STILL OPEN: (a) git history purge of the file — prepared + dry-run verified, waits for the owner's explicit GO (collaborators
  mikaeladityan/kujangga must be warned; plan in the docs file); (b) owner to review Neon connection history since 2026-05-18;
  (c) CI secret-scan guard merged locally (`scripts/ci/secret_scan.py` in quality.yml), not pushed yet; (d) emulator/tablet admin
  sessions were revoked → log in again with the new password (owner reads it: `gcloud secrets versions access latest --secret=SEED_ADMIN_PASSWORD --project mandalika-pos`);
  (e) the local untracked `.claude/settings.local.json` still holds the now-dead old values — the owner can delete those lines.

- **Backend (2026-10-17, release 7 = OTA built-in fix):** revision **`00114-win`** (100%, tag `rel7`, commit 5f11921, NO migration; rollback =
  `00112-paw`). **BUG FOUND ON THE EMULATOR 2026-10-17:** a device on the BUILT-IN bundle sends `version_name` = the APK versionName
  ("2.1", with `version_build` "2.1"), NOT "builtin"; the old Decide() could not parse "2.1" so OTA 2.1.1/2.1.2 were never offered
  to real tablets ("no update"; plugin logs "Error no url or wrong format"). Fix: built-in when version_name=="builtin" or
  == non-empty version_build that parses; 2-part device versions compare as x.y.0; garbage still fails safe; `version_build` logged.
  Verified on the tag + live: built-in 2.1/2.1 code 12 → offered 2.1.2; 2.1.1 → offered; 2.1.2 → up-to-date; 2.1.5 → no update;
  codes 11/13 → "no release"; abc/abc → no update. Smokes on rel7: oversell 28/28, import 21/21, ingredient 8/8, release 1/2
  18/18, auth 11/12 (one 429 from the refresh limiter). Opus review: ship; lows (optional): built-in skips the comparison when
  the release label is not newer than the APK name (future APK 2.2 + release 2.1.9), keep APK versionNames 2-part / OTAs patch≥1,
  handler test does not reach the offered path (no repo seam), one spec line inexact.
  **EMULATOR (APK 2.1, 2026-10-17, bundle 2.1.2 installed BY HAND via CapacitorUpdater.download+set):** A35 bundle confirmed
  (notifyAppReady, session/shift survived, persisted across force-stop); A44 stock-0 item adds to cart with the "tetap ditambahkan"
  message and the warn-and-override sheet, sale BSD-AB0003 synced, server order stock_warning + shortage row (0→-1) + stock -1;
  A15: sold 1× HOLY SWEET 10ml ATOMIZER (BSD-AB0004), picker 42→41 and stayed 41 (server 41), settling store held 2 entries,
  retired on the startup pull (entries 0), stock still correct. Test data left: BSD-AB0003/AB0004 (+1 unacknowledged oversell
  record, visible in Stok Minus). Privacy note: the Capgo plugin sends stats batches to Capgo's servers by default (device_id,
  app_id, version); disable with `statsUrl: ''` in capacitor.config (needs an APK). **OTA END-TO-END PROVEN 2026-10-17 (after rel7):** emulator reset to
  built-in 2.1 (CapacitorUpdater.reset + delete), then on the next foreground the plugin checked `/ota/check`, logged "New bundle:
  2.1.2 found. Current is: 2.1", downloaded it (checksum e3fb14d8… matched, setNext true), and after the next background→foreground it
  applied 2.1.2, `notifyAppReady()` was called inside the window, status success, session/shift intact. (The plugin's "Error no url or
  wrong format" log line just means up-to-date / no update.) USER-PENDING: backoffice import-dialog walkthrough (needs the owner's login
  in the Browser pane). Tablets on APK 2.1 now receive OTA 2.1.2 automatically on their next foreground.
  Release 6 was: **`00112-paw`** (tag `rel6`, commit
  1edfa65, NO migration, still through **0056**; rollback = `00110-cis`). Contains: import never re-creates a merged-away customer
  (skip + warning naming the keeper, redacted in import_runs), ingredient new-SKU assign (one target per ingredient, `unit_mismatch`,
  inactive warning), `/livez` (Cloud Run reserves `/healthz`; live returns `{"db":"ok","redis":"ok","status":"ok"}`), OpenAPI 400/413
  docs for login/refresh/logout, `/ota/check` logs device_id/custom_id (verified in Cloud Run logs). Smoke on the tag: import 21/21,
  ingredient SKU 8/8, oversell 28/28, release 1/2 18/18; live auth smoke 12/12 (script updated to /livez + X-Outlet-Id). The
  merged-away skip was NOT smoked hosted (test DB has 0 tombstones; a merge leaves immutable audit rows) — covered by gate IM. CI note:
  the first postgres run on 1edfa65 failed on a runner port-bind flake (56448 in use); `gh run rerun --failed` passed; follow-up:
  retry once on fixture start. The login limiter (10/5 min per IP+email, per instance) bites repeated smoke logins: reuse ADMIN_TOKEN.
  Release 5 was: revision **`00110-cis`** (tag `rel5`, commit 7392d08, migrations
  through **0056** `import_runs`; rollback = `00108-naz` — additive table, the old revision ignores it). Smoke on the tag:
  import flow 21/21 (guards, dup-in-file→422, preview writes nothing, commit applied, same-key replay, different-file 409,
  formatted-phone dedupe skip, stale 409, throwaway customers deleted), oversell 28/28, release 1/2 18/18, auth 10/12
  (same two known script-side items; a first run showed 429s from login volume only). Read-only SQL: 0056 applied, the 1
  stored import_runs row contains none of the smoke's phone/email/name, customers back to 12. Product list cache TTL is
  15 s and live serves `basePrice` on all variants, so no manual invalidation was needed. Backoffice import dialogs deploy
  with the next non-skip push. Release 4 was: revision **`00108-naz`** (tag `rel4`, commit 29f6f1a, migrations through
  **0055**; rollback = `00106-riq`). Smoke on the tag: oversell flow 28/28
  (sale beyond stock → -2 + stockWarning + 1 row; replay no double move; report; acknowledge idempotent; refund restores 0),
  release 1/2 18/18, auth 10/12 (`/healthz` 404 = Cloud Run reserved path, follow-up; sync-pull 403 = smoke script sent no
  X-Outlet-Id, fine with it). Live: /readyz 200 + authed report/open-count 200. Smoke residue on Neon test DB: 1 refunded
  order + 1 acknowledged exception row. Release 3 was: revision **`00106-riq`** (tag `rel3`, commit 1e8309e, migrations
  through **0054**; rollback = `00104-den` — check the RUNBOOK rollback log keys first). Release 2 was:
  revision **`00104-den`** (100%, tag `rel2`, commit a2cffe3, migrations through
  **0053**, Cloud Run max-instances 4, DB_MAX_CONNS default 10; rollback = `00102-vas`). Release 1 was `00102-vas` (tag
  `a14rcpt`, cfd6917, migrations 0051+0052; its rollback = 00100-wul). Previously: revision `00100-wul` (tag `gates50`, labels commit-sha=`f08c94f`,
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
- **2026-10-17 owner policy answers (medium-findings scoping):**
  1. **A05 offline authority:** offline sales allowed until shift close, capped at 12 h after the last successful online contact;
     enforced on next sync (recommendation accepted).
  2. **A27 refunds in reports:** recognised on the REFUND date.
  3. **A28 time:** TWO timezones in use, WIB and WITA (not WIB-only) → each outlet needs a timezone; the business day belongs to
     the SHIFT'S OPENING date; NO return deadline until the owner sets one.
  4. **A30 customer privacy:** cashiers look customers up BY PHONE only (no browsing); managers see their own brand's customers;
     admins see all.
  5. **A41 local receipts:** keep 7 days OR the last 500 receipts on the tablet; offline returns for sales made on that tablet
     before reconnecting = YES.
  6. **A08 transfer-receive PIN:** NOT approvable offline → online step-up; stop shipping PIN hashes in the sync bundle; remove
     the raw PIN from the queued payload; server-side lockout.
  7. **A37 error_logs:** retention 60 days, admin-only read. **IMPLEMENTED on branch a37-error-logs (not pushed/deployed):**
     redaction twins `packages/sync/src/redact.ts` + `backend/internal/redact` share one vector file
     (`packages/sync/src/__fixtures__/redact-vectors.json`). Two tiers: SECRETS (credential keys, Bearer/JWT/URL-secret patterns;
     used for review reports to head office, which keep customer data) and LOGS (secrets + PII keys, email/phone patterns, size
     caps; used for error logs, the sync log and the cashier "Kirim log" diagnostics). The server redacts inside
     `write.InsertErrorLogs` (covers old POS bundles and the panic path) and the Sentry event text; 60-day sweep at startup and
     at most hourly from POST /error-logs; read bounded to 60 days; PG gate EL (port 56459). Release: backend deploy (no
     migration), then OTA for the on-device redaction. Existing test rows: read-only count first, then owner picks scrub or delete.
  8. **Import vs merged-away customer:** never re-create one; skip the row with a warning pointing to the keeper (A39 follow-up). **IMPLEMENTED on branch import-followups (not pushed/deployed).**
  9. **Ingredient import:** a row with a new SKU whose exact name matches exactly one ingredient with a blank SKU ASSIGNS the SKU to
     it (no duplicate) (A39 follow-up). **IMPLEMENTED on branch import-followups (not pushed/deployed).**
  10. **OTA rollout (A35):** pilot outlet first, once more than one outlet's tablets are on APK 2.1 (staged-rollout mechanism
      to be built when that is true; until then all-at-once on the single pilot set).
  11. **Migration numbering:** A37 takes no migration. Whichever plan merges first takes 0057; any later plan renumbers in the
      same PR and updates its plan text and PG gate.

## Next

**NEXT SESSION — START HERE (written 2026-10-21; supersedes every older start-here block below):**
- **State:** `prod-hardening` = `origin/prod-hardening` (clean, nothing unpushed). Live: backend revision `00120-puj` (migrations through 0063 + 0057, rollback `00118-gup`), backoffice on Cloudflare (list/export fix live), POS OTA **2.1.5** (APK 2.1 versionCode 12, fleet APK rollout still NOT done). Releases 8, 9, 10 are documented right below. Emulator `mandalika-tab` and Docker Desktop were left running (close them; `adb emu kill`).
- **Pre-re-audit source of truth:** `docs/audits/2026-10-20-pre-reaudit-status.md` (all 44 findings, verified). The owner's earlier list 'A15 Phase B, A33 Task 9, A36' was incomplete; A15 Phase B is now DONE and live.
- **Do first (recommended, nothing owner-blocked):** (1) **dependency-security CI job FAILS with 2 new blockers** (npm 439 / go 143 scanned) on 4b0f7f7: no manifest changed, so newly published advisories. The CI artifact download timed out and the pinned Go scanner is unavailable locally: retry `gh run download <run id> ` for artifact `dependency-security-<sha>` (run `gh run list --branch prod-hardening`), or read the job log, name the 2 advisories, then fix (bump) or add dated exceptions (`scripts/ci/dependency-exceptions.json`, see A38 notes). Not a deploy gate today; A34 wants it to become one. (2) A29 parent follow-ups (Retry-After, default deadline, sanitised direct-handler errors, work budget, 500+ item test). (3) A34 cheap items (add dependency-security to `REQUIRED_CI_WORKFLOWS` AFTER (1) is green, store OTA release_type, PG gate port-bind retry). (4) A10 promotion version stamp + A23 server-path coverage, shift-less attribution (`attribute.go:283-285`), A36 restore guard (`scripts/db-restore.sh`), A33 Task 9 on/after 2026-10-30 (re-run Task 0 first), then the Fable re-audit only when the owner asks.
- **Owner decisions still open (ask, do not assume):** A25 merge/correction semantics; slice 8b discount permission (its A08-PIN-override premise is gone); A30 L1/L3/L5 (defaults built: cashier `/orders?q=<phone>` unthrottled, `manage_promotions` sees customerName, review payloads carry customer name/phone); operator-per-shift; A37 T10 scrub-or-delete; A36 O1-O4 (Neon paid plan, API key, age keys). Owner actions: lock tablet date/time (A05), set WITA outlets' timezone only after the OTA reached every tablet (A28), APK 2.1 fleet rollout then the legacy-envelope cutoff, admins re-set receive PINs for other roles if wanted (only the admin has one; admins-only approve by owner decision).
- **Working rules that bit this session:** the commit hook blocks any command containing `-n`-style tokens, including `grep -n`/`sed -n` in the SAME command as `git commit` (run them separately; write messages to a scratch file and `git commit -F`); never `git add` a directory (untracked ZIPs); the login limiter (10/5 min/IP+email) breaks repeated smokes: log in once and export `ADMIN_TOKEN`; the browser gate fixtures share fixed ports (retry on 'Strict fixture port already occupied'); worktrees with node_modules hit Windows long paths: remove with PowerShell `Remove-Item -LiteralPath`, `C:\a41base`-style stray dirs are blocked by the tool guard; Docker Desktop must be running for the full PG gate (`python scripts/ci/postgres_gate.py --no-race --output artifacts/postgres/result.json`, 29 gates incl. ST); OTA needs a clean pushed head with the four CI gates green and `OTA_JOURNAL_CHANGE_ACK=1` only when no journal-adjacent file changed since the previous OTA; deploy order = push -> CI green -> `scripts/deploy-backend.sh <tag>` -> smoke the tag -> `scripts/promote-backend.sh <tag>` -> `make ota-release VERSION=x.y.z`. Model routing per AGENTS.md (Opus plans/reviews anything touching sync/stock/auth/payments/generated types; Sonnet implements; Haiku docs).

**RELEASE 10 (2026-10-21, owner go-ahead): A15 Phase B live = backend revision `00120-puj` (tag `rel10`, commit 4b0f7f7, migration 0057 `outlet_stock_seq`, rollback = `00118-gup`) + POS OTA 2.1.5 (id dfe21449, journal guard acknowledged because NO journal-adjacent file changed since OTA 2.1.4; 2.1.4 still reads the new optional settling-entry fields, so rollback is safe).** CI: the four required gates green on 4b0f7f7; **dependency-security FAILED with 2 new blockers (npm 439 / go 143 scanned; details not retrievable: the artifact download timed out and the Go scanner is unavailable locally; no manifest changed in this release, so these are newly published advisories; NOT a deploy gate; follow-up: identify and fix or except them, A34/A38).** Smokes on the tag: auth 12/12, oversell 28/28, release 18/18 (the login limiter 429s repeated smoke logins: reuse ADMIN_TOKEN), NEW counter smoke 10/10 (version/pull/batch carry stockSeq incl. 0; a sale and a refund each move the BSD counter by exactly +1; a replay moves it by 0; PMS counter untouched). Migration: 0057 applied on first boot (4 counter rows = 4 outlets). EMULATOR (cold boot, session survived): 2.1.4 -> 2.1.5 downloaded and applied (success); FOREIGN SALE test: an API sale at BSD (server counter 4->5, data version unchanged 205) reached the tablet in 15 s (stock 42->41, counter 4->5, chip stayed Tersinkron = silent stock-only pull); the refund restock (counter 5->6) reached the tablet 297 s later (the 300 s stock floor), no tap, no chip. Test residue: one refunded BSD order (HOLY SWEET 10ml ATOMIZER, stock back to 42). Not tested on device: an own-sale ack causing no pull (vitest + browser scenario only). Emulator left running.
**RELEASE 9 (2026-10-20, owner go-ahead): backoffice list/export fix (pagefix) + POS auto-pull (OTA 2.1.4), no backend deploy, no migration.** RESULT: pushed 1a83837 (CI green), backoffice deployed (new bundle hash), POS OTA **2.1.4** published (id 3d475eb6, from 1a83837; journal guard acknowledged only after checking NO journal-adjacent file changed since OTA 2.1.3). /ota/check: 2.1.3 -> offered 2.1.4, 2.1.4 up-to-date, code 11 no release. EMULATOR (cold boot after the power loss, session survived): downloaded 2.1.4 on the first foreground and applied it on the second (status success); AUTO-PULL VERIFIED: a no-op admin re-save of /settings/app bumped the BSD data version 199->200->201; with an empty cart the chip went Pembaruan tersedia (14 s, the poll) -> Tersinkron by itself 6 s later (inside the 5-15 s jitter, no tap); with one item in the cart the chip stayed Pembaruan tersedia for ~85 s with no pull; clearing the cart gave Memperbarui... -> Tersinkron within ~7 s. Test writes: two identical-value settings saves (version bumps only, no data change). Not tested on device: offline no-op, the receive+TandaTerima nudge, production-size bundle. Emulator left running.
- **A15 Phase B (merge `0c47870`, 2026-10-20; RELEASED in release 10, see above):** per-outlet counter `outlet_stock_seq` (migration 0057, additive, outlet_variant_stock untouched) replaces the per-row design in `docs/plans/2026-10-17-a15-stock-reappear.md` §3; plan `docs/plans/2026-10-20-a15-phase-b-outlet-stock-seq.md`. Gates: PG ST 29/29, quality:ci, browser:ci, codegen green; Opus reviews fixed.
  RELEASE additions (owner go-ahead): backend with 0057 first (tablets at 0 pending), smoke (stockSeq on version/pull/batch; replay does not move it), push, `make ota-release VERSION=2.1.5` (no APK), emulator checks. Kill switch `SYNC_STOCK_SEQ=off`.
  Residuals (not fixed): out-of-order seq can look like a restore (one extra pull); a sale committed between Version() and Products, acked after that pull, shows a brief LOW until the next pull; L2 zero-change stock count bumps once.
**RELEASE 8 (2026-10-20, owner go-ahead "full release, in order"): backend LIVE = revision `00118-gup` (tag `rel8`, commit 777000c, 100%, migrations through 0063 incl. the receive-PIN wipe; rollback = `00116-vev`, additive schema except the PIN wipe).** Contents: A28, A27 (incl. T7), A05, A30, A41, A08 + A29/A26/A10/A23. Pushed prod-hardening (all CI green on 777000c after the codegen-gate required-test-set fix `777000c`). Pre-deploy read-only Neon counts: 69 orders (16 re-bucketed by shift day, 2 refunds change day), 0 malformed phones, 2 receive PINs wiped, 2 transfers in transit. Smoke on the tag: auth 12/12, oversell 28/28, release 18/18, new-endpoint smoke 13/13 (pull customers [] + receiveApprovers [] + outletTimezone, signed contact, phone lookup, no hash). Backoffice: deployed by the non-skip push 7629f7d (verified live: Buka kunci PIN, Zona Waktu, offline_expired label). POS OTA **2.1.3** published (id 6ad79227, sha256 6d215f14…dfe3, from 7629f7d, OTA_JOURNAL_CHANGE_ACK=1 after the A35 guard listed journalBoot/journalOutboxStore/outbox/storage: additive changes only, see the A41/A08 reviews); /ota/check offers it to APK 2.1 versionCode 12 (built-in and 2.1.2), up-to-date at 2.1.3, no release for code 11. Tablets on APK 2.1 get it on their next foreground; the grant-based receive flow, phone-only customer picker, Struk di Tablet Ini and 12 h offline lock arrive with it. Owner actions still open: lock tablet date/time settings (A05); admins set NEW receive PINs before tablets need to receive transfers (A08, 2 transfers are in transit); set WITA outlets timezone only after the OTA reached every tablet (A28).
- **After release 8 (2026-10-20), merged locally, NOT released:** `pagefix` (backoffice list/export 50-row truncation fix, merge `03726cf`) and `autopull` (POS auto-pulls reference data by itself, OTA only, merge `b06846e`, plan `docs/plans/2026-10-20-pos-auto-pull.md`). Pre-re-audit source of truth: `docs/audits/2026-10-20-pre-reaudit-status.md` (the owner's earlier list 'A15 Phase B, A33 Task 9, A36' was incomplete).
**UPDATE 2026-10-19 (policy builds, part 1): A28 DONE LOCALLY, released in release 8 (2026-10-20).** `prod-hardening` = `7ffd6dc`, 41 commits ahead of origin.
- Phase A merge `0635d4e` (backend + backoffice, no OTA): migration **0059** (`outlets.timezone` WIB/WITA/WIT CHECK, `shifts.business_date`, `orders.business_date` + `refund_business_date` via SQL functions + BEFORE triggers incl. insert-already-refunded), all report/list date filters on the business day (shift opening date), `bizday` Go pkg (fixed offsets, no LoadLocation), backoffice `lib/businessDay.ts` + outlet "Zona Waktu" field; gate **BD port 56462**; PG gate 23/23.
- Phase B merge `7ffd6dc` (backend + POS web layer, OTA, no APK): promo/loyalty/preview clocks use the OUTLET's local time (owner answer 2026-10-19: yes), pull bundle `outletTimezone`, POS `zoneParts` twin + shared vectors `service/testdata/promo_timezone_vectors.json`, POS order history on business days. Opus reviews both phases Ship-with-minors, minors fixed; I re-ran PG gate 23/23, quality:ci, browser:ci, both gen checks on each merged tip.
- Plan `docs/plans/2026-10-19-a28-outlet-timezone.md`. Migrations applied locally through 0059 (0057 still reserved for A15 Phase B).
- RELEASE additions (R2/R7): before the backend deploy run a READ-ONLY Neon `SELECT timezone, count(*) FROM outlets GROUP BY 1` (all must still be Asia/Jakarta) and show the owner the count of orders whose computed business_date differs from `(created_at AT TIME ZONE 'Asia/Jakarta')::date`; the 0059 migration briefly locks outlets/shifts/orders while rewriting all rows (tablets at 0 pending); set WITA outlets ONLY AFTER the OTA reached every tablet (a new server + old POS bundle disagree on promo hours at a WITA outlet). No return deadline built (seam: compare orders.business_date with the refund shift business_date in service/order.go RefundOrder).
- A28 follow-ups (not built): backoffice code report 'kedaluwarsa' label + segment recency stay Jakarta; promo clock-skew bound belongs to A05; owner action: set WITA outlets' timezone before go-live (history is frozen at write time; test-DB re-derive only on request); BD gate gaps: no CloseShift run in case 2, non-admin outletId scope asserted on summary only.
- **A27 T1-T6 DONE LOCALLY (merge `bb75e5a`, migration 0060, backend + backoffice only, no OTA/APK; released in release 8 (2026-10-20)).** Summary = gross (completed+refunded, sale day) minus refunds (refund business day) = net (never totalSales - totalRefunds); new fields grossSales/grossOrders/grossByPaymentMethod/refundsByPaymentMethod + richer dailySales rows; `GET /orders?dateBasis=refund`; 0060 backfill (refund shift day, else outlet-zone day of refunded_at, else sale business_date) + 2 partial indexes; Ekspor cards Kotor/Refund/Bersih + refund CSV; ShiftsTab relabelled. service/ and POS untouched. Cross-outlet 30-day summary at 500k orders ~500 ms locally. Opus review Ship-with-minors, fixed; PG gate 23/23, quality:ci, browser:ci, gen checks re-run by me. Plan `docs/plans/2026-10-19-a27-refund-date-basis.md`.
  **A27 T7 DONE LOCALLY (merge `3a469c7`, backoffice only; owner answered YES 2026-10-19):** Dashboard Penjualan KPI/trend/payment mix = net (refunds on the refund day) with a Kotor / Refund subtitle; ranking, cashier, promo panels unchanged (Q2); old-backend guard falls back to completed-only, refund-request failures keep previous data. Opus review Ship-with-minors, fixed; quality:ci + browser:ci re-run by me. Known follow-ups: browser mock has no refunded order (vitest covers it), two full order fetches every 12 s in "Semua", payment % divide by positive net. **A27 is complete.**
  RELEASE additions: R1 read-only Neon counts before deploy (refunded orders whose refund day differs from sale day; refunded rows with refunded_at NULL); migration order 0058 -> 0059 -> 0060, backend first (tablets at 0 pending), then the push. A27 follow-ups: F1 per-product net of returns, F2 grant/code reports on refund basis, customer lifetime totals ignore refunds (A20-A22 policy).
- **A05 DONE LOCALLY (merge `8310855`, released in release 8 (2026-10-20)).** Plan `docs/plans/2026-10-19-a05-offline-cap.md`, no migration. Backend: `/sync/version?deviceId` returns a server-signed contact token (HMAC of access secret); sync envelope (v stays 1) carries contact/contactDeviceAt/offlineMs; `/sync/batch` refuses order/refund/cash_flow offline >12 h + 5 min as non-retryable `offline_expired` -> sync review (never dropped; old bundles without evidence accepted and logged); promo/loyalty use bounded EvalTime with a clock_skew flag only; `/sync/loyalty-preview` clamps to +-5 min. POS (OTA only): ok/warn(10 h)/locked(12 h) blocks cart, checkout, refund, cash in/out (shift close allowed); silent refresh treats only 401 as rejected. Backoffice label 'Offline lebih dari 12 jam'. PG gate OC 25/25 (port 56463), Opus Fix-first both fixed.
  RELEASE additions: backend first (tablets at 0 pending), then `make ota-release`; backoffice label ships with the first non-skip push. Rotating JWT_ACCESS_SECRET silently disables the signed fast path (safe). OWNER ACTION: lock date/time settings on tablets (kiosk/MDM). Follow-ups: clock_skew badge on promo orders when tablet >5 min slow; no suspect-clock column; native monotonic clock needs an APK.
- **A30 DONE LOCALLY (merge `c093157`, commits `9ae85b7`..`44cf506`, released in release 8 (2026-10-20)).** Plan `docs/plans/2026-10-19-a30-customer-privacy.md`; migration 0061 (`customers.phone_norm` generated via IMMUTABLE `normalize_phone`, partial index, content_versions bump; brief ACCESS EXCLUSIVE rewrite). Policy: cashier phone-only (even with manage_customers); manager with manage_customers and admin see all; manager without it phone-only. Server: `/customers*` behind RequireCustomerReader (cashier 403); `/sync/customers/lookup` uncached, exact phone_norm, max 3 reduced fields, 30/min + 400/day per user (429 + Retry-After); `/sync/pull` customers `[]`, discount customerName stripped; `/orders` and `/reports/summary` q ignore customer name/phone for phone-only callers. POS (OTA): no browsable list, KnownCustomers memory (300, 30 days, exact phone), phone-only picker, legacy snapshot purged. PG gate 26/26, quality:ci, browser:ci, gen checks green; Opus Fix-first fixed.
  RELEASE additions: read-only Neon check first `SELECT count(*) FROM customers WHERE normalize_phone(phone)=''`; backend with 0061 first (tablets at 0 pending; 0061 bumps content versions, one re-pull and one sales-wall rise), then push, then OTA. Old POS bundles on new server: typed names return nothing, full phone works.
  Open owner questions (defaults built): Q1 separate vs shared brand systems; L1 `/orders?q=<full phone>` maps phone to name for cashiers, no rate limit; L3 `/discount-codes` customerName visible to any manage_promotions holder incl. cashier; L5 sync-review payloads carry customer name+phone to resolve_sync_review holders.
- **A41 local receipts + offline returns DONE LOCALLY (merge `a163d61`, commits `2a8a3e0`..`3156a83`, released in release 8 (2026-10-20)).** Plan `docs/plans/2026-10-20-a41-local-receipts.md`; NO migration, NO OpenAPI change. Backend: refund may carry `saleOrderUuid` + `deviceId`; sync resolves the sale inside the keyed transaction, scoped to outlet and same device; old payloads unchanged. POS (OTA only): ack stores the server id (`ackedOrderId`); `ReceiptArchive` keeps receipts 7 days OR newest 500 per outlet; linked refunds held until their sale is acked (a held refund also holds shift close, A06/M3); 'Struk di Tablet Ini' panel (reprint never enqueues); typed order-history searches no longer cached. PG gate OF (port 56465) 27/27; quality:ci, browser:ci 29/29, both gen checks green; Opus Ship-with-minors, fixed.
  RELEASE additions: backend first (tablets at 0 pending; old servers turn uuid-only refunds into review items), then `make ota-release`; no APK.
  Follow-ups (not built): SyncedRefunds window ~250 linked refunds/30 days; `orders:last` cache alias may keep an older build's last search; archive is one ~1-2 MB value (on-device timing unverified); refund in a shift opened offline stays blocked (Q1).
- **A08 transfer-receive PIN DONE LOCALLY (merge `d794fdb`, commits `e683c7c`..`ccc8094`, released in release 8 (2026-10-20)).** Plan `docs/plans/2026-10-20-a08-receive-stepup.md`; migrations 0062 (approval grants, lockouts, attempts, content version bump) and separate 0063 PIN wipe. Receiving needs an online step-up: server PIN check with Postgres lockout mints a single-use 12 h grant; the queued item carries `approvalGrantId` only, no PIN; sync no longer ships PIN hashes. POS (OTA only): ReceiveApprovalModal, legacy PINs scrubbed. PG gate RA (port 56466); full PG gate 28/28.
  RELEASE additions: backend first (tablets at 0 pending; 0062 always). **OWNER DECISION 2026-10-20: apply 0063 = YES (include the receive-PIN wipe in the release; admins must set new PINs before tablets need to receive).** It clears every receive PIN hash (recommended yes; the hashes sat on tablets). It cannot be undone, so set new admin PINs before tablets need to receive. Then push, then OTA. Old POS bundles lose receive approval until the OTA lands.
  Follow-ups (not built): retention of attempts and expired grants; any outlet's cashier can hard-lock the global admin's receive PIN (admin can unlock); approver lock events not shown in backoffice.
- **NEXT:** the answered-policy builds are all done locally (A28, A27 incl. T7, A05, A30, A41, A08). Superseded by releases 8 and 9. Next: A15 Phase B is built locally (see the bullet under RELEASE 9); release it with the owner's go-ahead, then A29, A34 cheap items, A10/A23, A36 restore guard, A33 Task 9 on/after 2026-10-30, and the Fable re-audit only on the owner's ask. See `docs/audits/2026-10-20-pre-reaudit-status.md`.
- **Owner answer 2026-10-20 (A30 Q1): the three brands run SEPARATE systems (one deployment each)**, so the A30 default stands (manager with manage_customers sees all customers of the deployment); the brand-sharing model in the A30 plan section 3 appendix is NOT needed.

**(OLD, superseded 2026-10-21) NEXT SESSION — START HERE (written 2026-10-19, supersedes the 2026-10-17 block below; its Task 1/Task 2 are DONE, see their result lines further down):**
- State: `prod-hardening` = `41d0e55`, 30 commits AHEAD of `origin/prod-hardening`, NOTHING pushed, nothing deployed. Merged locally: A29 batch cap (`36beb48`), A26 reports aggregation (`350f2f7`), A23 promo parity tests (`32049dc`), A10 quoted receipt total (`f925a59`, migration 0058, gate QT 56461).
  Owner put the RELEASE ON HOLD ("I'll say when to release"): when told, follow RELEASE ORDER (backend deploy first with tablets at 0 pending and 0058 applied, then the first non-skip push so Cloudflare deploys the backoffice, then `make ota-release` for the A29 client + A10 POS; no APK). Ask before every push/deploy/OTA/Neon write.
- Local-only leftovers (safe to remove, `git worktree remove --force <path>` + `git branch -D`): worktrees `.claude/worktrees/{a10,a23,a26,a29}` and their branches; untracked `PHASE_HANDOFF.md`, empty `scratch_msg.txt`, and many untracked `*.zip` review bundles (NEVER `git add` a directory: a past `git add docs` swept ZIPs into a commit; add explicit files). Docker Desktop was started for the PG gate and may still be running.
- **Next work = the answered-policy builds**, owner answers in "Decisions (owner)" item "2026-10-17 owner policy answers" above (A05 12 h offline cap; A27 refunds on REFUND date; A28 per-outlet WIB/WITA, business day = shift opening date, no return deadline; A30 phone-only cashier lookup, manager = own brand, admin all; A41 local receipts 7 days OR last 500 + offline returns; A08 transfer-receive PIN online-only step-up, drop PIN hashes from sync bundle, server lockout).
  Suggested order and coupling: A28 first (per-outlet timezone is the one helper `wibDayStart` in read/orderfilter.go + `validWIBDay`; migration needs an outlets.timezone column, next free migration is 0059 after A10's 0058; 0057 stays reserved for A15 Phase B), then A27 (edits ONLY the shared summary SQL basis in read/reports.go + tests, refund-date basis, builds on A26), then A05, A30, A41, A08 (A41 and A08 touch the POS/offline store: new APK vs OTA decided per slice). Each is a plan -> slice cycle.
- Per-slice recipe that worked: Opus `planner` (read-only; I save its plan under docs/plans/) -> `git worktree add .claude/worktrees/<n> -b <branch> HEAD` -> Sonnet `implementer` (TDD; tell it to run the gates, use scratch-dir commit message files with unique names and `git commit -F`, add explicit files only) -> Opus `reviewer` on anything touching sync/stock/auth/payments/generated types/OTA -> fix round via SendMessage -> I re-run gates MYSELF (full PG gate `python scripts/ci/postgres_gate.py --no-race --output artifacts/postgres/result.json` needs Docker Desktop; `corepack pnpm quality:ci`; `corepack pnpm browser:ci`) -> `git merge --no-ff <branch> -F <msgfile>` -> docs (sweep `docs/audits/2026-10-14-audit-status-sweep.md`, tracker, this file). Lessons: both codegen outputs must be regenerated after an OpenAPI edit (`make gen-go` in backend AND `corepack pnpm --filter @mandalika/api gen`); the local PG gate caught two real bugs (float32 totals, SQL typing) that unit tests missed; the commit hook blocks flag-like text in command lines and any command mixing `grep -n` with `git commit`.
- Open follow-ups to fold into slices when they fit: A29 parent (Retry-After, default deadline, sanitised direct-handler errors); persistent retryable shift_open lets later orders attribute shift-less (attribute.go:276-279); A26 F5/F6 and Dashboard "Semua" unbounded; A10 promotion version stamp; A23 server-path coverage for fixed/unscoped/separate-set BXGY/bundle; A15 Phase B (0057); A33 Task 9 on/after 2026-10-30; A36 once the owner does O1–O4; Fable re-audit only when the owner asks.
- Working rules unchanged: keep replies short (owner watches the context window), end each reply with the P0 progress board, announce tier + effort + one-line reason before each delegated task.

**(OLD, superseded) NEXT SESSION — START HERE (2026-10-17, final state of the long session):**
- Prod: backend revision `00116-vev` (100%, migrations through 0056, secrets rotated, `/livez` health), backoffice on Cloudflare (auto-deploys on non-skip push), POS OTA 2.1.2 (offered to APK 2.1 /
  versionCode 12 devices; proven end-to-end on the emulator), APK 2.1 fleet rollout NOT done. `prod-hardening` = `origin/prod-hardening` at the head recorded in git (history was rewritten today: all older SHAs
  in docs are stale). All today's work (A44, A39, A35, A15, A37, secret rotation, CI secret-scan guard, history purge) is merged, pushed and CI-green. Smoke scripts now live in `scripts/smoke/` (see its README).
- **Task 1 (owner asked for it in the new session): backoffice import walkthrough** on https://mandalika-pos.pages.dev via the in-app Browser pane. Claude must NOT type the password: the OWNER logs in
  (admin@mandalika.test; the password is the Secret Manager value `SEED_ADMIN_PASSWORD`, read with `gcloud secrets versions access latest --secret=SEED_ADMIN_PASSWORD --project mandalika-pos` in the
  owner's own terminal). Then drive Pelanggan / Produk / Bahan: "Template" download and "Import" dialog (preview → errors table → "Unduh laporan error" → commit) with THROWAWAY CSVs (names `ZZ Smoke …`,
  phones `0899…`), then delete what the import created (UI delete or API) — a customers import records a redacted `import_runs` row by design. Check: preview wrote nothing, dedupe skip, error rows
  downloadable, Terapkan disabled when errors, stale (409) message, ingredient SKU assign / unit mismatch messages in Indonesian, Stok Minus tab under Laporan (the oversold sale BSD-AB0003 from the emulator
  check is an unacknowledged record to try "sudah dicek" on — acknowledging it is fine). Record the result in HANDOFF.
- **Task 1 DONE 2026-10-19** (owner logged in; throwaway `ZZ Smoke` CSVs injected into the page file input via DataTransfer, since the in-app browser has no file picker). Customers/Products/Ingredients all PASS:
  Template CSVs download (headers match the server spec); preview writes nothing (counts unchanged); errors table in Indonesian (required, phone 6-20 digits, email warning, date range, Harga angka tidak valid,
  Brand wajib, Satuan wajib untuk bahan baru, Biaya Default angka tidak valid); "Unduh laporan error" yields a CSV (Baris,Baris di file,Kolom,Tingkat,Kode,Pesan,Nilai); Terapkan disabled with errors,
  enabled without; commit OK (customers 3, products 2 variants, ingredients 2); re-import = Dilewati (phone/SKU dedupe, "tidak ada perubahan"); stale 409 shows "Data berubah sejak pratinjau..." (reproduced by committing
  the same row from a 2nd tab) and Terapkan stays disabled until re-preview; "Kategori baru" counter shown; product size change warns; ingredient SKU-assign preview (no commit) says "SKU ... ditetapkan ke bahan yang
  sudah ada", assign with different unit = unit_mismatch error. Note: unit_mismatch fires only on the SKU-assign path; a SKU match with a different unit just previews as Diperbarui (code reading, ingredients.go:196-199; not a bug report, owner may want a warning).
  Stok Minus: BSD-AB0003 ticked + "Tandai sudah dicek" -> acknowledged (list empties under default filter, shows "Dicek" under Sudah dicek). Cleanup: 4 customers, 1 product, 2 ingredients deleted via UI; counts back to
  baseline (12 customers, 8 products, 6 ingredients). A customers import leaves a redacted `import_runs` row by design. Not tested: direct API writes (auto-mode denied replaying the session bearer token; use UI only).
- **A29 batch cap DONE locally 2026-10-19 (merge `36beb48` on prod-hardening; NOT pushed/released).** Client chunks of 25, server 200 items / 8 MiB → 413, OpenAPI+Go+TS codegen regenerated, 414 sync tests, quality:ci green;
  PG integration test NOT run (no Postgres/Docker locally). Opus review: round 1 Fix-first (rule 2 stall + api.gen.go drift), round 2 Ship-with-minors. Plan `docs/plans/2026-10-19-a29-batch-cap.md` (rule 2 revised).
  RELEASE (needs owner OK): client first via `make ota-release` (verify 413 handling is in the OTA 2.1.2 base via the release tag), then backend deploy, tablets at 0 pending. A29 parent stays OPEN (Retry-After, default deadline,
  sanitised direct-handler errors, work budget). Follow-ups from review: persistently-retryable shift_open lets later orders attribute shift-less (pre-existing, attribute.go:276-279); no "ditunda" reason shown on client-held shifts (engine.ts:562); retryable check `=== true` (engine.ts:935) vs `!== false` in flush.
  Worktree `.claude/worktrees/a29` + branch `a29-batch-cap` still exist (remove after push). Optional Neon 25-order timing e2e not approved.
- **A26 reports aggregation DONE locally 2026-10-19 (merge `350f2f7`; NOT pushed/deployed; backoffice + backend only, no APK/OTA, no migration).** Shared order filter, WIB-day params, double money fields (25), server-paged Transaksi/Ekspor/Shifts, Dashboard window, CustomerDetail fix.
  Gates: full PG gate 20/20 on PG 18.3 via `python scripts/ci/postgres_gate.py --no-race --output artifacts/postgres/result.json` (Docker Desktop must be running; this also proved A29's BE gate), quality:ci, browser:ci. The PG gate caught a REAL bug (float32 order totals made list sums differ from the exact summary); lesson: run the PG gate locally, it works here now.
  Opus review Ship-with-minors; F1 (view_transactions-only role: client skips the summary and shows "–", no server permission change; owner may want server-side OR-permission later under A30) and F2 (search spans all dates) fixed. Follow-ups: F5 payment filter (configured methods only), F6 Rp0 flash on reload, F4 has no browser test, perf of summary+q at scale, Dashboard "Semua" unbounded.
  Owner defaults taken (change if wrong): Transaksi tab = last 30 days + "Semua tanggal"; search ignores the date window. Release = push (Cloudflare auto-deploys backoffice) then backend deploy; ASK first. Worktrees `.claude/worktrees/a26` + `a29` and branches `a26-reports-agg`, `a29-batch-cap` still exist (remove after push).
- **RELEASE ORDER for A29 + A26 (both unpushed; needs owner OK):** (1) push prod-hardening ONLY AFTER the backend is live, because the new backoffice (Cloudflare deploys when the pushed HEAD commit is not `[CF-Pages-Skip]`; every commit so far is tagged skip, so the backoffice will only update on the first non-skip push; push that one only after the backend deploy) sends dateFrom/dateTo/summary params that the OLD backend ignores/lacks; so: deploy backend first (A26 params and A29 413 are backward compatible with old clients), tablets at 0 pending before the sync-changing deploy (owner rule 2026-10-10), (2) then push (backoffice deploys), (3) then `make ota-release` for the A29 client (check the OTA 2.1.2 base has the 413 isolation fallback via the release tag). Run the PG gate on the pushed head in CI.
- **QUEUE STATE 2026-10-19 (end of session part 2):** A29 + A26 + A23 (tests only, merge `32049dc`, no drift) + **A10 (merge `f925a59`, migration 0058, gate QT port 56461, PG gate 22/22, OTA only)** merged locally (release ON HOLD by owner). Highest gate port now 56461; migrations applied through 0058 (0057 reserved for A15 Phase B).
  A10 follow-ups: promotion version stamp + per-promotion id/version in discountBreakdown (A23 handover, not built); hostile snapshot with \u0000/lone surrogate makes Postgres refuse that one sale (goes to review; POS cannot produce it); outbox grows ~50-70% per cart line; points-cover-whole-bill rounding mismatch POS vs server (pricing.ts:401-404 vs order.go:343-358) now also shows the Struk badge. Owner default: reports keep the server total.
  RELEASE now bundles A29 + A26 + A10: same order (backend first with tablets at 0 pending and migration 0058 applied, then push, then OTA for A29 client + A10 POS; no APK needed). Then the policy builds (A05, A27, A28 per-outlet tz, A30, A41, A08), then A15 Phase B (0057).
  Per-slice recipe that worked: Opus planner (read-only, I save the plan) -> fresh worktree `git worktree add .claude/worktrees/<n> -b <branch> HEAD` -> Sonnet implementer (TDD, runs gates) -> Opus reviewer -> fix round -> I re-run gates -> merge --no-ff locally with `git merge -F <msgfile>` -> docs. Docker Desktop must be running for `scripts/ci/postgres_gate.py --no-race`.
- **Task 2 DONE 2026-10-19:** the `.claude/worktrees/a37` leftover was an empty dir; removed with a plain `Remove-Item -LiteralPath ... -Recurse -Force` (the `\\?\` form is blocked by the tool guard).
- **Then** the queue in item 5 of the block below (A29 → A26 → A10 → A23 → answered-policy builds A05/A27/A28/A30/A41/A08 → A15 Phase B → A33 Task 9 on/after 2026-10-30 → A36 once the owner does O1–O4 → Fable
  re-audit only when the owner asks). Owner decisions are in "Decisions (owner)" above (incl. the 2026-10-17 policy answers). Working rules: plan with Opus `planner`, implement with Sonnet `implementer` in a
  FRESH worktree created by you (`git worktree add .claude/worktrees/<name> -b <branch> HEAD`, tell the agent to `cd` there; the harness `isolation: worktree` once handed out a stale base), Opus `reviewer` for anything
  touching sync/stock/auth/payments/generated types/OTA, run the gates yourself, merge locally, ASK before push/deploy/OTA/Neon writes. Commit messages via the file tool + `git commit -F` (hook blocks flag-like text).
  Keep replies short (owner watches the context window) and end each reply with the P0 progress board.

**RESUME HERE (written 2026-10-17 at ~88% context):**
**HISTORY PURGE DONE 2026-10-17** (supersedes the push/purge steps below). `.claude/settings.local.json` removed from ALL history of all 12 GitHub branches (0 tags) with `git filter-branch`
(dry-run then guarded push, `--force-with-lease` per branch pinned to the cloned SHA; first attempt failed for all 12 because the mirror clone has `remote.origin.mirror=true`, which forbids explicit
refspecs — GitHub was untouched; fixed with `git config --unset remote.origin.mirror` and re-pushed: 12/12). Verified: 0 commits touch the file, 0 mention the leaked Neon hostname fragment; local tip
content identical to the rewritten tip. prod-hardening is now `6992105` (was fc5a3ca) and ALL commit SHAs from the first file-touching commit onward changed — every SHA cited elsewhere in this file/plans/audits
is STALE (use `git log --grep`/subjects). Cloud Run revision `commit-sha` labels and OTA `commit_sha` records point at old SHAs (`promote-backend.sh` refuses to re-verify OLD labelled revisions;
new deploys from rewritten SHAs are fine; `gcloud run services update-traffic` rollback still works). Local: all stale worktrees/branches removed (1 locked dir left under `.claude/worktrees`, delete
manually), old objects gc'd (`fc5a3ca`, `34676aa`, `a595fc6`, `e957154` no longer exist locally), scratch mirrors deleted. The backup bundle with the OLD history/secrets is
`C:\Users\MyBook Hype AMD\Downloads\mandalika-backup\mandalika-pos-original-*.bundle` — OWNER deletes it when satisfied. OWNER TODO: contact GitHub Support (purge cached views + `refs/pull/*` of PR #1;
old commits stay reachable by SHA until then — harmless, the secrets are rotated); tell collaborators mikaeladityan/kujangga to re-clone or `git fetch && git reset --hard origin/<branch>`.
Hook gotcha: the commit hook blocks command lines containing flag-like text (e.g. `-race` in a message) → write commit messages with the file tool and use `git commit -F`.
**UPDATE: A37 is MERGED LOCALLY as `44a6b4a` (5 fix rounds, final head a7a6481; every phone shape in the independent harness 0 leaks, TS/Go parity 0 diffs; full PG gate 20/20, quality:ci 0,
secret-scan OK with an allowlist entry for the fake-DSN test fixtures). 25 commits are unpushed. NEXT: owner OK → `git push origin prod-hardening` (CI runs the secret scan) → run `purge-run.sh push`
(copy at `Downloads\mandalika-backup\purge-run.sh`) → local reset/cleanup → owner contacts GitHub Support. Items 1–2 below are superseded by this line except the backlog notes.**
1. **A37** (error-log redaction + 60-day retention): branch `a37-error-logs`, worktree `.claude/worktrees/a37`, head `ed37314` (round 4: fail-closed phone scanner, committed corpus
   `packages/sync/src/__fixtures__/redact-phone-corpus.json`, linear JWT scan, JSON-secret parser, dsn-label fail-closed). Implementer + gates green (EL ×3, full PG gate 20/20, quality:ci,
   browser:ci). PENDING: independent Opus differential attack (own generator) + my own full gate (output in the session scratchpad `k.out`). If clean (only the accepted leaks: <9 national digits,
   >2 consecutive separators, digits past the 12th, '08 1234 5678', glued +62, ≥20-digit hyphen chains) → merge into prod-hardening (merge commit), re-verify, push, then the purge. If a NEW
   common leak shape is found → another fix round (SendMessage to the implementer agent). Backlog from A37: panic-recoverer (ErrAbortHandler swallowed; 500 written after an unbounded sync
   insert; sink panic ⇒ no 500), own rate bucket for POST /error-logs (declined: global limiter), T10 existing error_logs rows (read-only COUNT, then owner decides scrub/delete).
2. **Unpushed local commits on prod-hardening** (docs: A37 plan, secret plan, HANDOFF notes; merge `248fe9d` = CI secret-scan guard `scripts/ci/secret_scan.py` + quality.yml step + RUNBOOK
   "Secret hygiene"). Push needs the owner's OK; push them BEFORE the purge so the rewrite includes them.
3. **HISTORY PURGE — owner gave GO 2026-10-17** (collaborators warned by owner; pre-flight clean: 12 heads, 0 tags, all commits by Epheyy, 1 open PR #1 by Epheyy, no branch protection).
   Script `purge-run.sh` in the session scratchpad (`dry` | `push`): fresh mirror clone → backup bundle to `C:\Users\MyBook Hype AMD\Downloads\mandalika-backup\` (contains old secrets; delete
   after confirming) → `git filter-branch` removing `.claude/settings.local.json` (~12 min) → verify (file unreachable, no other content change) → `--force-with-lease` per head pinned to the cloned SHA
   (never refs/pull/*). Then locally: `git fetch origin`, reset local prod-hardening to origin, delete stale worktrees/branches under `.claude/worktrees` (22 listed), re-create what's needed.
   Dry-run 2026-10-17 verified. Side effects: every SHA changes (HANDOFF/plan SHAs stale), Cloud Run `commit-sha` labels + OTA `commit_sha` records dangle (`promote-backend.sh` of OLD labelled
   revisions refuses; gcloud rollback works), CI reruns on the new heads. OWNER then asks GitHub Support to purge cached views + `refs/pull/*`. If the script is gone, redo from
   `docs/plans/2026-10-17-secret-rotation-and-history-purge.md`.
4. **Owner pending:** GitHub Support request after the purge; backoffice import-dialog walkthrough (login with the NEW admin password works — read it with
   `gcloud secrets versions access latest --secret=SEED_ADMIN_PASSWORD --project mandalika-pos`); Neon connection history not checkable (free tier) — accepted; APK 2.1 fleet rollout not done.
5. **Then (in order):** A29 batch cap, A26 reports aggregation, A10 quoted receipt total, A23 tiered-promo leftover; answered-policy builds (A05, A27, A28 per-outlet tz WIB/WITA, A30, A41, A08);
   A15 Phase B (mig 0057 stock_seq — renumber if 0057 is taken); A33 Task 9 cleanup on/after 2026-10-30 (re-run the Task 0 audit first; Redis-only keys are orphans); A36 backups build once the owner
   does O1–O4; PG gate runner: retry once on port-bind failure; then the Fable re-audit (owner must ask). Smoke scripts live in the session scratchpad (login limiter: 10/5 min per IP+email per instance → reuse ADMIN_TOKEN).

0. **NOW (2026-10-14): finish non-policy audit findings** — source of truth `docs/audits/2026-10-14-audit-status-sweep.md`.
   Order: (a) A14 completion guard + difference apply; (b) receipt numbers repeat across tablets/reinstalls (orderRef.ts);
   (c) A38 dependency blockers; (d) quick wins A43/A12 leftovers, A32 pool limits, A40 RUNBOOK, A42 lock order;
   (e) A36 research → plan; A33 Redis-optional auth; A39 CSV; A44 oversell flag/report; (f) medium: A05/A07, A10, A15, A41,
   A28, A30, A37, A23/A26/A27/A29/A35 leftovers. Then the Fable re-audit (new session).
   **Status 2026-10-15:**
   - **Released 2026-10-15** (backend rev `00102-vas`, tag `a14rcpt`, from cfd6917, migrations **0051 + 0052**, smoke 14/14;
     rollback `--to-revisions mandalika-pos-00100-wul=100`; backoffice via the next non-skip push):
     - (a) A14 stock counts: difference apply, server-owned baseline (freeze at create + start, per-line baseline on save),
       lifecycle under FOR UPDATE, replay = zero writes / disagreeing replay 409, one running count per location; backoffice
       saves per line on blur, flush-then-complete. Plan `docs/plans/2026-10-14-a14-stock-count-delta.md`. Not browser-checked.
     - (b) receipt numbers: server-assigned device code unique fleet-wide (`pos_devices`, `POST /pos/devices/register`),
       numbers `{OUTLET}-{CODE≥2 letters}{SEQ}`, counter reserved durably before enqueue + floor from the queued outbox,
       legacy format until registered. POS change → needs the new APK. Plan `docs/plans/2026-10-14-receipt-number-device-code.md`.
     - (c) A38: Go 1.26.9, chi v5.3.0, npm pins; owner-approved exceptions (x/crypto openpgp GO-2026-5932, rgbcolor licence,
       expire 2027-01-12); xlsx applicability renewed to 2027-01-13 (reviewed_at 2026-10-14 UTC). CI scan on cfd6917:
       22 of 24 cleared, the 2 xlsx rows were "not yet valid" (UTC date slip) → fixed in the following commit.
       CI artifacts download only via PowerShell `Invoke-WebRequest` (gh's TLS to the blob host times out here).
   - **Released 2026-10-15 (release 2, rev `00104-den`, smoke 18/18):** (d) A12/A43/A42/A32 — mig 0053 one open shift per
     outlet; direct order/cash-flow shiftId must belong to the caller's outlet (checked after replay; /sync/batch unchanged,
     all batch sales are Offline); strict optional bodies (malformed → 400); unclassified direct-sale errors → sanitized 500;
     deterministic lock order (codes → customer (re-resolved after merge) → stock sorted → order) in sale/refund/goods
     receipt + RetryBusy on direct routes; DB_MAX_CONNS (1..100, default 10) + --max-instances 4; merge.go nil-slice fix;
     PG gates SO 56453 + LO 56454 (16 gates total). A40 RUNBOOK refreshed (d3bce8f). POS success pop-up now shows the
     reserved receipt number (was the MND- hash) → APK 2.1 (versionCode 12).
   - APK 2.0 (build 11, 374e14a) emulator-verified 2026-10-15: 1.9→2.0 `install -r` kept session/binding/shift; device
     code `AB`; test sale synced as **BSD-AB0001** (codes AA and AC belong to smoke-test devices).
   - APK **2.1** (build 12, a2cffe3, run 38750599071, sha256 `db1deae1…8e0d`, stored in Downloads/mandalika-apk) emulator-verified
     2026-10-15: 2.0→2.1 `install -r` kept everything; success pop-up shows **BSD-AB0002**, server has the same number.
     **2.1 is now the fleet candidate** (supersedes 1.9); fleet still not rolled out.
   - Neon read-only 2026-10-15: no outlet has 2 open shifts (0053 safe); all outlet codes match ^[A-Za-z0-9]{2,4}$.
   - (e) A36 research done: `docs/plans/2026-10-15-a36-backup-research.md`. **Owner decisions 2026-10-15:** Neon **Launch**
     (7-day PITR, daily snapshots, snapshot before every migrating deploy) + own encrypted daily `pg_dump` to a locked GCS
     bucket in Jakarta (dailies 35 d, monthlies **24-month retention lock**); "< 3%" = ≤ ~20 min of a trading day's server
     writes for normal incidents, provider loss accepted at ≤ 24 h of server data (unsynced tablet sales always safe);
     PDP limitation of locked backups accepted (document it). Owner must upgrade the Neon plan (payment) — Claude can't.
     Build (~6 days) = backup Cloud Run Job + bucket script + pre-migration snapshot in deploy-backend.sh + restore script +
     restore drill + backup-age alert + RUNBOOK; optional tablet keep-acked-sales item NOT chosen.
   - A33/A07 (Postgres auth authority, Redis optional): plan `docs/plans/2026-10-15-a33-postgres-auth-authority.md` + owner
     decisions (old-token replay → refuse that request only; role change within 15 min; Neon read + pre-deploy revoke OK).
     Task 0 read-only audit 2026-10-15: refresh_tokens 725 (514 revoked, 35 expired, 189 live); Upstash refresh:* keys 193;
     all 189 live rows have a key; 4 Redis keys without a live row (adopt only when NO pg row exists); live rows without a
     key = 0. Implementation running in a worktree (mig 0054, PG gate AU 56455).
   - **Released 2026-10-16 (release 3, rev `00106-riq`, mig 0054):** A33/A07 — Postgres is the login authority (atomic
     rotation, lost-response re-mint, old-token replay → 401 for that request only, logout with any session token ends the
     session (owner 2026-10-16), reset revokes under the user lock); Redis optional (disabled/degraded modes, breaker,
     in-memory login limits, hashed email keys, 8 KiB login / 16 KiB refresh+logout body caps); PG gate AU (17 gates).
     Pre-deploy (read-only): 189 live tokens all mirrored, 4 Redis-only keys have NO pg row (adopted), nothing to revoke.
     Smoke on tag: login/refresh/re-mint/deep-replay 401/logout/oversize 400 all pass + release-1/2 smoke 18/18; startup
     log: migrations applied, refresh_sweep deleted 35, no redis_degraded/disabled. CI gate now pulls postgres:18.3 by
     pinned digest with mirror fallback (mirror.gcr.io → ECR; ECR hit "Data limit exceeded" 3×).
   - Follow-ups: (1) `/healthz` is reserved by Cloud Run (Google 404 on live too) → serve health at an unreserved path and
     fix the RUNBOOK step; (2) postgres.yml reports go1.26.0 (go-version-file ignores the toolchain line?) → pin 1.26.9;
     (3) OpenAPI: document 400 on logout/refresh, 413 on login; (4) A33 Task 9 cleanup (drop Redis mirror + adoption) on or
     after 2026-10-30 after a Task 0 re-run shows 0 Redis-only live tokens.
   - A44 plan `docs/plans/2026-10-16-a44-oversell-flag.md` + owner decisions 2026-10-16 (badge = unchecked lines with an
     auditor 'sudah dicek' step; POS stops blocking out-of-stock items, warns instead, via OTA). A39 plan
     `docs/plans/2026-10-16-a39-csv-import.md` + owner decisions (stopgap c7d0d71 hides product import / retires users import;
     no stock column; phone dupes skipped; users import retired). Order: A44 (mig 0055, port 56457), then A39 (mig 0056, 56456).
   - **A44 LIVE 2026-10-17: backend rev 00108-naz (mig 0055), backoffice deployed (901b499), POS OTA 2.1.1 PUBLISHED
     (test type, targets versionCode 12 / APK 2.1, from 61379ef, sha256 fd353089…9497; /ota/check offers it to
     version_name builtin/2.1.0 on code 12, "no release" on codes 10/11/13). First OTA ever published. First attempt failed
     safely before upload (Capgo CLI needs cwd=apps/pos + --package-json; fixed + CLI pinned 8.83.0 in ota-release.sh).
     USER-PENDING: emulator check (open POS, restart once to apply 2.1.1; tap/scan stock-0 item → warns, adds; sale goes
     through; shows in backoffice Stok Minus + "⚠ Stok" badge).** Merged as 477fc8f; Opus review found no
     CRIT/HIGH; fix round 2031c75 (M1 non-live refund lines never restocked incl. bundles; Q6 unresolved_variant sale sets
     orders.stock_warning; L1 report totals = kind shortage only; L2 qty<=0 skip) + 536603d (api.gen.go regen — `make gen-check`
     in backend is separate from `pnpm gen:check`; breakdown sums shortage-only). Opus re-review: no runtime defect. Verified on
     merged tree: OS ×3 + full PG gate 18/18 (no -race), go test ./..., both gen checks, quality:ci exit 0. NOT run locally:
     browser:ci, EXPLAIN on 200k rows. Deferred LOWs: L3 renamed-variant label, L4 CSV `'` strip on re-import (A39), L6
     `::text` filters not index-friendly, L7 variant popup ignores cart qty, L8 report handler untyped map. Awaiting owner
     go-ahead: push → CI → Neon snapshot/read-only check → deploy-backend (mig 0055) → smoke → promote → backoffice (push
     of a non-skip commit) → OTA for POS warning (versionCode 12) → emulator check.
   - (history) A44 branch `worktree-agent-ae978051544692d45`, commits 71f7f34 (P1 mig 0055 `sale_stock_exceptions`, no online clamp,
     exception rows in the sale tx, PG gate OS 56457), 710c86f (P2 oversell-report / open-count / acknowledge API, OpenAPI +
     types, `Order.stockWarning`), 0f2befd (P3 backoffice Stok Minus tab + badges + formula-safe CSV), f2d6d0f + f94fc34 (P4
     unresolved variants; refund restocks only what the sale took), 5636ceb (P5 POS stops blocking out-of-stock, warns; OTA).
     Implementer-reported: go build/vet/test green, gofmt clean, codegen + gen:check pass, full PG gate 18/18, OS alone ×3,
     quality:ci exit 0. Two existing tests intentionally changed (cite owner decision): order_input_test
     TestSaleInputPreservesKnownReceiptAndQ08Shortage (direct sale now -1 + warn), lock_order sale_vs_sale_new_stock_rows (-2/-2).
     Notes: exportToCSV now formula-safe for ALL exports (a lone "-" exports as `'-`) — coordinate with A39; Stok Minus tab
     ignores the date range by default (checkbox to restrict); no 200k-row EXPLAIN run; RF gate not extended; POS vitest
     covers helpers only. Open question: should an `unresolved_variant` sale also set orders.stock_warning (left unset)?
   - **NEXT SESSION, in order:**
     1. Opus review of the A44 branch (stock/refund/sale path, generated types, report scope/IDOR, acknowledge permission,
        replay safety, POS warning flow) — re-derive claims, run OS gate ×3 yourself. Fix round if needed (resume or new
        implementer in that worktree). Answer the stock_warning question (recommend: yes, set it).
     2. Merge into prod-hardening → full local verify → owner go-ahead → push → CI → Neon snapshot/read-only check →
        deploy-backend (mig 0055) → smoke (sale beyond stock → negative + 1 row; report; acknowledge) → promote →
        backoffice deploys on the next non-skip push → OTA (`make ota-release VERSION=x.y.z`, targets versionCode 12/APK 2.1)
        for the POS warning, emulator-check it.
     3. **A39 LIVE 2026-10-17: backend rev 00110-cis (mig 0056, commit 7392d08), import_runs stores a REDACTED report (owner:
        "redact"; message was cut off after that word, so the other two owner decisions below stay at plan behaviour until
        answered); backoffice dialogs deploy with the next non-skip push. USER-PENDING: on-screen walkthrough of the
        Import/Template dialogs for Customers, Products, Ingredients (backoffice).** Two parallel Opus reviews + a re-review found no data-destroying bug; fixed: rename vs in-flight
        transfers/stock counts (size_in_flight, re-checked inside the apply tx), concurrent-edit guard (409), lock order +
        retryBusy, phone normalization on stored side, per-route deadlines + max 2 concurrent imports (429), scientific-notation
        barcodes/SKUs, export BASE price (new `basePrice` on variants) + update-row reasons, leading-zero rupiah ambiguity, new
        category counts as change, dialog guards. Verified on merged tree: IM ×3 + full PG gate 19/19 (no -race), go test,
        both gen checks, quality:ci, browser:ci (implementer). Release-5 notes: invalidate the product-list cache once after
        deploy (cached lists lack basePrice → outlet-scoped export falls back to the override price until expiry). OPEN OWNER
        DECISIONS: (a) RESOLVED 2026-10-17: import_runs.result is stored redacted (no phone/email/name values; customer row keys blanked). (b) may an import re-create a merged-away customer whose phone differs from the keeper's (plan D5 says yes)?
        (c) ingredient rows with no SKU + a new SKU create duplicates (plan D5). Backlog: UpdateProduct form rename leaves
        warehouse stock + ignores open documents; functional index on normalized phone if customers >~100k; transfer/stock-count
        create paths do not validate the variant exists; variant-level promo/loyalty/bundle selectors not re-keyed on rename;
        gate case for the 40P01 retry→503 path. Original line:
        A39 CSV import: **built 2026-10-16 on a local branch** per docs/plans/2026-10-16-a39-csv-import.md
        (mig 0056 `import_runs`, PG gate IM port 56456, BO-CSV-IMPORT browser scenario). Needs an Opus review (idempotency/replay,
        stock-adjacent rename path, generated types, sync-wall bump), then the usual push/CI/Neon snapshot/deploy-backend (0056)
        sequence. Backoffice commits are `[CF-Pages-Skip]`; the next non-skip push deploys the new dialogs. New backlog (not
        fixed): the Customers and Ingredients exports fetch a single 10,000-row page and silently truncate above that.
     4. Small follow-ups: ~~/healthz reserved by Cloud Run~~ DONE on branch followups-1017 (deep health also at `/livez`, RUNBOOK
        fixed; live check after deploy: `curl <url>/livez`); ~~pin Go 1.26.9 in postgres.yml~~ DONE (explicit go-version +
        check-latest false in all three setup-go steps; the next postgres gate log should print `go1.26.9`); ~~OpenAPI 400 on
        refresh/logout, 413 on login~~ DONE (docs only; pushed 8c4e19b, CI green, postgres gate now prints go1.26.9;
        `/livez` goes live with the next backend deploy); A33 Task 9 cleanup on/after
        2026-10-30; A36 build once owner does O1–O4.
        **A33 Task 0 re-run 2026-10-17 (read-only, tool deleted):** PG rows 719, live 200, Redis refresh keys 204; live with
        key 200, live WITHOUT key 0, keys on revoked/expired rows 0; Redis-only keys (no PG row) = 4, but none belongs to an
        existing user (adoption requires the user to exist), TTLs run to 2027-05/2027-10 (legacy long-TTL tokens) → they are
        dead orphans, adoption can never use them, Task 9 may drop adoption + the Redis mirror on/after 2026-10-30 (re-run the
        audit once more first; optionally delete the 4 orphan keys, owner OK needed for the Upstash write).
     5. Then the medium findings → Fable re-audit. **Scoping pass 2026-10-17** (source: docs/audits/2026-10-14-audit-status-sweep.md;
        A07/A33 now DONE, A12/A14/A32/A39/A42/A43/A44 DONE): NO owner decision needed — A35 notifyAppReady fires at first React
        render, BEFORE journal open/migration (`App.tsx:163-166`; matters now that OTA 2.1.1 is live; also no staged rollout /
        web-layer journal-compat rule) M; A15 acked sale debits let stock reappear on the POS (SyncEngine/optimistic, cashier-
        visible) M; A37 recursive redaction in sync redactor/error reporter/server error-log insert + restore log line S–M;
        A29 no sync batch cap/oversized-backlog handling M; A26 reports client-side full-table aggregation (scale) M; A10 retain
        the quoted receipt total/lines server-side + "differs" warning M; A23 tiered-promo POS/server disagreement leftover M.
        NEED OWNER DECISION first: A05 offline authority window after revoke (shift end vs fixed hours); A27 refund
        recognition basis (sale date vs refund date); A28 timezones/day cutoff/return window; A30 customer-read scope across
        brands/outlets (privacy); A41 local receipt retention + offline-return need; A08 offline PIN hashes (design choice);
        A37 retention/access for error_logs (light). Suggested order: A35 → A15 → A37 → A29 → A26 → A10 → A23.
        **A35 + A15 BUILT, REVIEWED (Opus ×3 each), MERGED 2026-10-17 (A35 fd9a49c, A15 41d6947; pushed, CI green on b88c7f8).
        **OTA 2.1.2 PUBLISHED 2026-10-17** (test type, versionCode 12, from b88c7f8, sha256 e3fb14d8…3a4b, id faa132c5; journal guard
        flagged only terminalBinding.ts = one-line OUTLET_CACHE_KEYS addition, owner acknowledged with OTA_JOURNAL_CHANGE_ACK=1;
        /ota/check offers 2.1.2 to builtin/2.1.1 on code 12, "no release" on 11/13, zip checksum matches). `/ota/check`
        device_id/custom_id logging approved by owner; it goes live with the next backend deploy.**
        A35 premise was stale (App mounts only after bootStorage/initJournal; confirm is in App's mount effect) → delivered
        tests locking the order, RUNBOOK journal-rollback rule, `scripts/lib/ota-journal-guard.sh` in ota-release.sh (refuses
        journal-adjacent changes since the APK base unless OTA_JOURNAL_CHANGE_ACK=1; pass APK_BUILD_SHA for the real ancestor
        check), `/ota/check` logs device_id/custom_id (live only after the next backend deploy; owner sign-off pending),
        flake fix. A35 backlog: staged rollout (tasks 6-8, mig 0057, setCustomId) only once >1 outlet is on APK 2.1; no error
        boundary — a crash in a LATER screen is already confirmed and not auto-reverted. A15 phase A (client only, OTA
        versionCode 12, publish as 2.1.2): settling-debits store keeps acked sales reducing displayed stock until a pull sent
        after the ack is applied; parked sales keep reducing; refunds unchanged; hold ≤3 then ack-anyway; 2000-entry cap.
        A15 backlog: Phase B (stock_seq trigger, mig 0057→ renumber, gate ST 56458) after A has soaked; T4 throttled
        auto-resync (cap hits only after ~6.7 days without restart/manual sync at ~300 sales/day); rehydrate() reload can drop
        a failed-write in-memory entry on a flushOnly flip (double fault); release-note: old parked orders start lowering stock.
        USER-PENDING: emulator check of A15 after the OTA (stock must not jump back up after a sale syncs; watch Preferences
        write cost).
        **All policy questions ANSWERED 2026-10-17 (see Decisions) → now also buildable:** A39 follow-ups (merged-away skip,
        ingredient SKU assign) S; A37 (60-day retention job + redaction) S–M; A27 refund-date basis M; A28 per-outlet timezone
        (WIB/WITA) + shift-opening business day M–L; A30 phone-only customer lookup + brand scoping M; A41 local receipts
        7d/500 + offline returns M; A05 offline cap 12 h/shift close S–M; A08 online-only step-up + drop PIN hashes M–L.
   - Environment notes: network to GitHub/Upstash is flaky from this PC (retry pushes; PowerShell Invoke-WebRequest for CI
     artifacts); CI postgres gate now uses digest-pinned image with mirror fallback; the emulator must be started by the
     owner (cold-start command in the Emulator section) — Claude's own start command was blocked by a safety check.
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
