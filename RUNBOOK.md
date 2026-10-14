# Mandalika POS — Production Runbook

How to release the backend, backoffice and POS, roll back, and handle tablets.
Read `HANDOFF.md` ("Now") first for the live revision and open items.

## Architecture (current)

| Component   | Where                                   | Notes |
|-------------|-----------------------------------------|-------|
| Backend API | Cloud Run `mandalika-pos`, `asia-southeast2` | Project `mandalika-pos`; `scripts/lib/cloudrun.sh` holds the names |
| Postgres    | Neon, **pooled** endpoint (`-pooler`, `sslmode=require`) | `DATABASE_URL` in Secret Manager |
| Redis       | Required at startup (`REDIS_URL`) | Provider: see Secret Manager `REDIS_URL` (not pinned in repo; config default is localhost) |
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
- `GET /healthz` — deep check (DB and Redis).
- Logs: `gcloud run services logs read mandalika-pos --region asia-southeast2`.

---

## Superseded (historical)

The Fly.io / Upstash / Sentry domain setup, the "zero-cost test cutover"
steps and the `fly deploy` / `fly secrets` commands no longer describe
production. Do not follow them. The current path is the sections above.
