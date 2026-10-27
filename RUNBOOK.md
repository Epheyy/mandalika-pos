# Mandalika POS — Production Runbook

How to release the backend, backoffice and POS, roll back, and handle tablets.
Read `HANDOFF.md` ("Now") first for the live revision and open items.

## Architecture (current)

| Component   | Where                                   | Notes |
|-------------|-----------------------------------------|-------|
| Backend API | Cloud Run `mandalika-pos`, `asia-southeast2` | Project `mandalika-pos`; `scripts/lib/cloudrun.sh` holds the names |
| Postgres    | Neon, **pooled** endpoint (`-pooler`, `sslmode=require`) | `DATABASE_URL` in Secret Manager |
| Redis       | **Optional cache** (`REDIS_URL`; set-but-empty = disabled) | Provider: see Secret Manager `REDIS_URL` (not pinned in repo; config default is localhost). A Redis outage never blocks startup or logs anyone out; Postgres is the auth authority |
| Backoffice  | Cloudflare Pages `mandalika-pos.pages.dev` | Auto-deploys on push to `prod-hardening` |
| POS         | Signed Android APK via `android-release.yml` | Capacitor shell; OTA web-layer updates via `make ota-release` |

Secrets live in GCP Secret Manager and Cloud Run env. Never commit them.
The server refuses to boot on dev defaults, non-TLS DB URLs or bad CORS.

## Backend release (gated)

1. Commit, then `git push` to `prod-hardening`. CI must be green on that exact
   commit: `quality.yml`, `backend.yml`, `postgres.yml`, `browser.yml`.
2. `scripts/deploy-backend.sh <tag> [--env KEY=VALUE]`
   - Refuses unless the tree is clean, HEAD is on origin/prod-hardening and all
     four gates are green. Uploads a clean export of that commit.
   - Revision gets `commit-sha` and `deploy-tag` labels. **0% traffic.**
   - Prints the tag URL and the current 100% revision (your rollback target).
   - `MAX_INSTANCES` env, default **4**.
   - **Migrations run at revision start**, so a no-traffic revision already
     migrates the shared DB. Migrations are forward-only.
3. Smoke the tag URL: `curl -s <tag-url>/readyz` (expect 200), then check
   `/livez` (Cloud Run reserves `/healthz`: Google answers 404 there) and the sync path you changed.
4. `scripts/promote-backend.sh <tag>` — re-checks the commit-sha label is CI-green
   and `/readyz` is 200, then moves 100% traffic to the tag.
5. Record the new revision in `HANDOFF.md` "Now".

**Rollback** (the deploy script prints the exact previous revision):

```bash
gcloud run services update-traffic mandalika-pos --region asia-southeast2 \
  --project mandalika-pos --to-revisions <previous-revision>=100
```

### Schema compatibility (expand/contract)

- Migrations cannot be rolled back; restore from backup instead (see below).
- New code must tolerate the old schema only where a rollback is planned.
- The previous revision must tolerate new **additive** columns (it ignores
  them). Do not drop or rename a column while an older revision can still
  receive traffic. Contract changes ship in a later release.

### Per-line refund (C4a, migration 0077) release and rollback

- **Release order:** backend deploy (migration 0077 runs at revision start) -> smoke -> promote 100% -> let it soak
  **24 h** -> only then the C4b POS OTA (the first release that can send item-level refunds), and only after the ERP
  developer answered E-1..E-3 (Q28-Q30 of `docs/integration/2026-10-21-serah-terima-erp-pos.md`). The backoffice
  (Cloudflare) can deploy at any time: its totals fall back to `total` when `refundedAmount` is absent.
- **Until C4b ships no client can create a partial refund** (the legacy payload and the backoffice route refund whole
  orders only), so the first days are behaviourally identical to before apart from the new refund rows.
- **Rollback to the previous Cloud Run revision is safe only while no `order_refunds.scope='partial'` row exists.**
  The old binary ignores the new tables, but it does not write `order_refunds` rows for refunds made during the
  rollback. Check first:

  ```sql
  SELECT count(*) FROM order_refunds WHERE scope = 'partial';   -- must be 0
  ```

  After a rollback, re-sync refunded orders that have no refund row (the catch-up trigger
  `orders_refunded_legacy_row` already inserts one when an order flips to `refunded`, so this normally returns 0
  rows; run it after the roll-forward as well):

  ```sql
  SELECT o.id, o.order_number FROM orders o
   WHERE o.status = 'refunded'
     AND NOT EXISTS (SELECT 1 FROM order_refunds r WHERE r.order_id = o.id);
  ```

- **Do NOT roll back after a partial refund exists.** The old binary would compute shifts and reports without the
  partial amounts and would treat a `partially_refunded` order as not refundable (correct, but its money readers are
  wrong). Fix forward instead.
- **Invariant to spot-check after the deploy** (D-49: expect 0 rows, no exception; the amount of record is capped at
  what the order still had left, the tablet's claim is kept in `claimed_amount`. Rows written before migration 0078
  and the D-49 deploy may still show up, those are the only ones that can):

  ```sql
  SELECT o.id, o.total, sum(r.amount) AS refunded
    FROM orders o JOIN order_refunds r ON r.order_id = o.id
   GROUP BY o.id, o.total
  HAVING sum(r.amount) > o.total + 1;
  ```

### Connection budget

Each instance holds up to `DB_MAX_CONNS` pooled connections (default **10**,
valid 1–100; `backend/internal/config`). Budget:
`MAX_INSTANCES × DB_MAX_CONNS ≤ Neon pooled client limit`.
Default 4 × 10 = **40**. Raise `MAX_INSTANCES` only together with a matching
`--env DB_MAX_CONNS=n` that keeps the product within the limit.

## Backoffice

Push to `prod-hardening` → Cloudflare Pages builds and deploys. Head commits
starting with `[CF-Pages-Skip]` do not deploy.
Deploy the backoffice **after** a backend that serves the API it needs.

### CSV import (onboarding the catalog, customers, ingredients)

Pelanggan, Produk and Bahan each have Template, Import and Export. The import is a server dry run first:

1. **Template:** download it, fill it in (one row per variant for products), keep the header names.
2. **Save as "CSV UTF-8"** in Excel. A file that is not UTF-8 is refused (accented names would be corrupted).
   For phone numbers format the Telepon column as Text first, or Excel drops the leading 0 or turns the number into `6.28E+11`
   (the import rejects that).
3. **Import:** pick the file. The preview shows new / updated / skipped / error rows, every problem with its row and line, and
   "Unduh laporan error". Nothing is written yet.
4. **Fix and re-pick** until there are no errors. **Terapkan** applies the whole file at once or not at all, and retrying the
   same apply does not duplicate anything.
5. **Rules:** import never deletes anything and never changes stock (load opening stock by goods receipt or stock count).
   A blank cell on a row that already exists keeps the current value (clear a field in the form instead). A customer whose
   phone already exists is skipped and listed, never merged or filled. A phone that only a merged-away customer had is skipped with a warning naming the keeper (never re-created). An ingredient row with a new SKU and the exact name of one ingredient that has no SKU assigns the SKU to it instead of creating a duplicate. A SKU that belongs to another product, a barcode that is
   taken, and a size rename onto another variant's size are row errors. A SKU kept with a new Ukuran renames the variant and
   the per-outlet stock/price (and warehouse stock) follow it. Prices are whole rupiah: `150000`, `150.000` and `Rp 150.000`
   all mean 150000.
6. **Limits:** 16 MiB, 50,000 rows, 40 columns per file. Each import writes one `import_runs` row (who, when, hash, summary,
   file name, and a redacted report: no phone/email/name values, customer row keys blank; never the file itself). A
   same-key retry replays that redacted report.

## POS APK

1. Push first. Workflows build from **origin**, not the local tree.
2. Bump `versionCode` in `apps/pos/android/app/build.gradle` for every build.
   One OTA bundle targets one versionCode, so never reuse a code.
3. Trigger the build:

   ```bash
   gh workflow run android-release.yml --ref prod-hardening \
     -f api_url=https://mandalika-pos-538849926142.asia-southeast2.run.app \
     -f release_type=test
   ```

   - `release_type`: `test` keeps debug settings; `production` fails on any
     debug setting (runs `scripts/ci/release_debug_gate_cli.mjs`).
   - If Docker Hub rate-limits (`toomanyrequests`), `gh run rerun <id> --failed`.
4. Download the artifact. It contains `release-manifest.json` (commit, run id,
   release_type, api_url, versionName/Code, APK sha256). Verify the signature
   with `apksigner verify --print-certs`.
5. Store the APK and manifest in `Downloads/mandalika-apk/`.

### Web-layer OTA

`make ota-release VERSION=x.y.z` (POS web bundle only; native changes need an
APK). It gates on a clean, pushed, CI-green commit (`OTA_RELEASE_TYPE=test|production`).

`scripts/ota-release.sh` also refuses journal-adjacent changes since the target
APK's build commit unless acknowledged (rule 4 below).

**Rollback facts (A35).**

- A bundle confirms (`notifyAppReady`) from App's mount effect, i.e. after the
  journal booted (`main.tsx` mounts App only after `bootStorage()` succeeded) and
  App first committed (the "Memuat…" frame). A BootError, or a crash while App
  itself first renders, leaves it unconfirmed. A crash in a LATER screen
  (Login/Cashier; there is no error boundary yet) is not auto-reverted: roll forward.
- Capgo protects only a bundle's **first launch** (about 30 s for a not-yet
  confirmed bundle; native config, APK-only). An unconfirmed bundle is rolled
  back to the previous good bundle or the APK's builtin, and that version is
  **never retried** on that tablet: publish a higher semver.
- A bundle that has already confirmed is never auto-reverted. A later defect
  (BootError on a later launch, bad queue writes) needs a higher-version fix OTA
  (roll forward) or an APK.
- With real journal corruption the rollback lands on the previous good bundle or
  the builtin, which hits the same error. The queue is kept (nothing is lost); use `quarantineCorruptRows`.
- **Receipts and C1 (OTA 2.2.0).** Rolling a tablet back to a bundle older than C1 means that
  bundle cannot reprint receipts archived in the v2 format (itemised promos, GRATIS, Biaya
  tambahan, Tukar poin, Pembulatan). It fails closed: the reprint is refused, no money moves and
  the sale itself is unaffected. Reprint those receipts from the backoffice instead, or roll
  forward to a bundle at or above 2.2.0.

**Journal rollback-compatibility rule (A35).** Any OTA bundle can be rolled back
automatically, so every OTA must leave the journal readable, and correctly
handled, by the previous bundle and by the APK's builtin.

1. **APK only, never OTA:**
   - the `packages/sync/src/journalBoot.ts` migration states and keys (`migration`
     meta values, `TAKEOVER_KEY`, `LEGACY_BACKUP_PREFIX`, quarantine keys);
   - `journalSentinel.ts` (`SENTINEL_VERSION`, sentinel shape) and `OUTBOX_KEY`;
   - the format of journal meta values (e.g. `SYNCED_REFUNDS_KEY`,
     `mandalika.pos.syncedRefunds`);
   - removing or renaming an `OutboxItem` field, or changing what a `status` means;
   - anything native (`OutboxJournalPlugin.java`).
2. **OTA-safe:** additive optional `OutboxItem` fields or payload keys that older
   bundles ignore (status rewrites spread the stored item, so they survive).
   Data the server needs must live in `payload` or `envelope`: an older bundle
   sends only `type`, `idempotencyKey`, `payload` and `envelope`.
3. **A new `OutboxType` or a new required payload key:** two steps. Ship the
   server that accepts it first, then the bundle that writes it. If the builtin's
   local views (queue summary, refund gate, recap) do not tolerate the new item,
   it is APK-only.
4. The bundle's commit must descend from the commit the target APK was built from.
   `ota-release.sh` checks ancestry against `APK_BUILD_SHA`. The ancestry check
   only bites when you supply `APK_BUILD_SHA` (from the APK manifest); the default
   base (the last commit that changed `versionCode`) always passes it. It also
   refuses journal-adjacent file changes since the base unless
   `OTA_JOURNAL_CHANGE_ACK=1`. Once such a change exists since the APK base, every
   later OTA on that versionCode needs the ack again (expected: re-read the list).
5. Today a journal-adjacent OTA reaches every tablet on that versionCode at once
   (staged rollout is not built yet). Prefer shipping it by APK; if it must be an
   OTA, confirm 0 pending sales first and watch the first tablets to update.
   `/ota/check` logs `device_id`/`custom_id`; the Cloud Run access log carries the
   caller IP for the same request, so the two can be joined.

## Tablet upgrade rules

1. Confirm **0 pending** sales on the tablet first (outbox empty).
2. Install over the existing app: `adb install -r <apk>`. Never uninstall.
3. Never uninstall or clear data while items are pending.
4. Confirm the session and queue survive, then log in and smoke one sale.

## Backups and restore

- Neon: automated history and point-in-time restore via the Neon console.
- Portable copy: `DATABASE_URL=<prod> ./scripts/db-backup.sh`, restore with
  `TARGET_DATABASE_URL=<target> ./scripts/db-restore.sh <dump>`. Compare the
  printed row counts. Backups hold PII and stay out of git.
- `db-restore.sh` logs only host/port/database for a URL DSN and a fixed placeholder for anything else, never the connection string (`scripts/dsn-label.test.sh` proves it with fake DSNs).
- **After ANY database restore, advance `outlet_stock_seq` past its pre-restore maximum** (A15 Phase B, migration 0057). A restore that lowers the counter makes clients turn seq rules off and pull once, but a counter that climbs back past an old tablet value could still retire a low-range own sale wrongly.
- Off-host, scheduled, locked backups are **not built yet**: see
  `docs/plans/2026-10-15-a36-backup-build-plan.md`.

## Secret hygiene

`scripts/ci/secret_scan.py` runs in the `quality.yml` workflow on every push (and
`python scripts/ci/secret_scan.py` locally; `--rev <commit>` scans an old tree). It fails on
tracked files that contain: database URLs with a real password, literal `*_PASSWORD=` values,
private key blocks, JWTs, AWS/GitHub/Google/Slack tokens, Sentry DSNs with keys; and on any
tracked `.claude/settings.local.json`, `.env`/`.env.*` (except `*.example`/`*.sample`), `*.jks`,
`*.keystore`, `*.pem`, `*.p12`, `id_rsa*`. Output is `file:line: rule` only, never the value.

- **Allowlist**: add `path-glob | rule | reason` to `scripts/ci/secret_scan.allowlist`. The
  reason is mandatory. Only for synthetic fixtures and documented local-dev values, never a
  real credential.
- **If a secret was committed**: rotate it first (Neon password, `SEED_ADMIN_PASSWORD`, tokens),
  because history and clones already hold it. Then remove it from the tree, and purge history
  only afterwards if wanted (`git filter-repo`, force-push needs the owner's go-ahead).

## Error log retention and access

- `error_logs` rows live 60 days. The sweep deletes old rows in batches of 1000 (at most 20 batches, advisory-locked so only
  one instance sweeps): once at server start and at most hourly per instance from `POST /error-logs`. The read endpoint
  also hides rows older than 60 days, so the policy holds even if the sweep lags.
- Only the `admin` role can read the log (`GET /error-logs`); the backoffice "Log Error" tab shows for admin only.
- Payloads are redacted before storage (credentials, customer phone/email/name/address, Bearer/JWT/URL secrets), both on the
  tablet and again on the server. Rows stored before this change were not redacted: count them read-only, then scrub or delete
  with the owner's go-ahead.

## Dependency-security exceptions

`scripts/ci/dependency-exceptions.json` lists accepted advisories. Each entry
has an owner, reviewer and `expires` date, and may last at most **90 days**.
`scripts/ci/dependency_policy.py` fails on expired entries. Renew only after a
new review.

## Monitoring

- `GET /readyz` — liveness, no dependencies (used for promotion checks).
- `GET /livez` — deep check (same handler also at `/healthz` for non-Cloud-Run hosts; **on Cloud Run use `/livez`**, `/healthz` is reserved and returns Google's 404). DB down: 503. DB up, Redis down or disabled: **200** with
  `{"status":"degraded","db":"ok","redis":"down|disabled"}`. All up: `"status":"ok"`.
- Redis tuning (optional): `REDIS_DIAL_TIMEOUT_MS` (default 1000), `REDIS_OP_TIMEOUT_MS`
  (default 500). After 3 consecutive transport errors the in-process breaker skips Redis for
  30 s (`redis_breaker_open` / `redis_breaker_closed` log lines). Rate limits fall back to a
  per-instance in-memory window while Redis is unavailable (up to N x the limit with N instances).
- Migration 0054 is additive, so the previous revision starts and its INSERT/UPDATE still work.
  **But rollback is only safe if Redis stayed healthy since the deploy.** The previous revision
  accepts a refresh only if `refresh:<jti>` is in Redis, and the new revision writes that mirror
  (and the reset marker, and the DELs) best effort, after the Postgres commit. Before rolling
  back, search the logs since the deploy for any of these keys:
  `redis_breaker_open`, `redis_degraded_at_start`, `redis_disabled`, `refresh_mirror_failed`,
  `admin_password_reset_marker_failed`, `admin_password_reset_key_delete_failed`.
  If none appear, roll back (traffic switch to the previous revision at 100%).
  If any appear, do NOT roll back without a manual reconcile of Redis from Postgres first:
  1. Live sessions: for every `refresh_tokens` row with `NOT revoked AND expires_at > now()`,
     `SET refresh:<jti> <user_id> EX <seconds until expires_at>`.
  2. Revoked-but-unexpired rows (`revoked AND expires_at > now()`): `DEL refresh:<jti>`, so the old
     revision cannot revive them.
  3. Reset markers: for every user whose `users.refresh_revoked_before` is within the last 30 days,
     `SET refresh_revoked_before:<user_id> <unix seconds of refresh_revoked_before + 2> EX 31536000`.
  Use the Redis console you already have; no new tool is needed. Do not roll back past the
  cleanup release that removes the mirror.
- PostgreSQL gates: 18 (OS `TestOversellPostgres` on port 56457 is the newest; 56456 is reserved).
- Logs: `gcloud run services logs read mandalika-pos --region asia-southeast2`.

---

## Superseded (historical)

The Fly.io / Upstash / Sentry domain setup, the "zero-cost test cutover"
steps and the `fly deploy` / `fly secrets` commands no longer describe
production. Do not follow them. The current path is the sections above.
