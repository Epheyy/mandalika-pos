# HANDOFF — current state (read this first)

Short, living handoff for Claude sessions. **Overwrite "Now" and "Next" at each milestone; keep it under
~150 lines.** History: git log, `docs/plans/`, and earlier versions of this file (`git log -p HANDOFF.md`).
`SESSION_HANDOFF.md` (Codex era) is historical — read by section only.

Last updated: 2026-10-17 by Claude (Sonnet 5.5) — A44 merged locally, awaiting owner go-ahead to push/deploy; see Next item 0.

## Progress board (update when a slice moves; show it at the end of every reply)

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

- **Backend (2026-10-17, release 4 = A44):** revision **`00108-naz`** (100%, tag `rel4`, commit 29f6f1a, migrations through
  **0055**; rollback = `00106-riq` — additive table, the old revision ignores it). Smoke on the tag: oversell flow 28/28
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

## Next

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
     3. A39 build (plan docs/plans/2026-10-16-a39-csv-import.md + owner decisions; mig 0056, PG port 56456).
     4. Small follow-ups: /healthz reserved by Cloud Run → serve health at an unreserved path + fix RUNBOOK; pin Go 1.26.9 in
        postgres.yml (CI reports go1.26.0); OpenAPI 400 on refresh/logout, 413 on login; A33 Task 9 cleanup on/after
        2026-10-30 (re-run Task 0 first); A36 build once owner does O1–O4.
     5. Then the medium findings (A05/A07 leftovers, A10, A15, A41, A28, A30, A37, A23/A26/A27/A29/A35 leftovers) → Fable re-audit.
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
