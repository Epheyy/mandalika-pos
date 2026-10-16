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
   `/healthz` and the sync path you changed.
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
   phone already exists is skipped and listed, never merged or filled. A SKU that belongs to another product, a barcode that is
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
- Off-host, scheduled, locked backups are **not built yet**: see
  `docs/plans/2026-10-15-a36-backup-build-plan.md`.

## Dependency-security exceptions

`scripts/ci/dependency-exceptions.json` lists accepted advisories. Each entry
has an owner, reviewer and `expires` date, and may last at most **90 days**.
`scripts/ci/dependency_policy.py` fails on expired entries. Renew only after a
new review.

## Monitoring

- `GET /readyz` — liveness, no dependencies (used for promotion checks).
- `GET /healthz` — deep check. DB down: 503. DB up, Redis down or disabled: **200** with
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
