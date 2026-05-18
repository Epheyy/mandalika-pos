# Mandalika POS — Production Runbook

How to deploy, roll back, restore the database, and rotate secrets.

For a zero-cost test cutover (Cloud Run + Neon + Upstash + Cloudflare
Pages + Sentry, no domain purchase) jump to **Free-tier test cutover**.

## Architecture (production)

| Component   | Host (default)      | Why                                              |
|-------------|---------------------|--------------------------------------------------|
| Backend API | Fly.io (`fly.toml`) | Cheap, single region (`sin`), free managed TLS, built-in secret store |
| Postgres    | Neon                | Managed, daily snapshots + PITR, TLS-only        |
| Redis       | Upstash             | Managed, TLS (`rediss://`), free tier            |
| Backoffice  | Cloudflare Pages    | Static + global CDN, free, `_headers`/`_redirects` |
| POS app     | Signed Android APK  | Capacitor shell, bundled `dist`, points at HTTPS API |

These are the documented defaults. Any equivalent (Render / Supabase / Vercel)
works — only the connection strings and the deploy command change.

---

## One-time provisioning (needs YOUR accounts — not automatable here)

1. **Domain**: own `your-domain` (any registrar). Plan two records:
   `api.<your-domain>` → backend, `admin.<your-domain>` → backoffice.
2. **Neon**: create project + database `mandalika_pos`. Copy the **pooled**
   connection string (`...-pooler...`, `sslmode=require`).
3. **Upstash**: create a Redis database. Copy the `rediss://` URL.
4. **Fly.io**: `fly auth login`; from `backend/`: `fly launch --no-deploy
   --copy-config --name mandalika-pos`.
5. **Cloudflare Pages**: connect the repo, project root `apps/backoffice`,
   build `pnpm -w --filter @mandalika/backoffice build`, output `dist`.
6. **Android keystore**: `./scripts/gen-android-keystore.sh` — back up the
   `.jks` + passwords in a password manager (loss = cannot update the app).

## Secrets (host secret store — never committed)

Generate and push backend secrets to Fly:

```bash
./scripts/gen-secrets.sh    # JWT_ACCESS_SECRET / JWT_REFRESH_SECRET / SEED_ADMIN_PASSWORD
cd backend
fly secrets set \
  ENV=production \
  CORS_ORIGINS="https://admin.<your-domain>,https://localhost" \
  DATABASE_URL="<neon pooled url, sslmode=require>" \
  REDIS_URL="<upstash rediss url>" \
  JWT_ACCESS_SECRET="<from gen-secrets>" \
  JWT_REFRESH_SECRET="<from gen-secrets>" \
  SEED_ADMIN_EMAIL="admin@<your-domain>" \
  SEED_ADMIN_PASSWORD="<from gen-secrets>" \
  SEED_ADMIN_NAME="Administrator" \
  CLOUDINARY_CLOUD_NAME="..." CLOUDINARY_API_KEY="..." CLOUDINARY_API_SECRET="..." \
  SENTRY_DSN="<optional>"
```

`backend/.env.production.example` lists every variable. The server runs
`cfg.Validate()` at boot and **refuses to start** on any dev default, a
non-TLS DB URL, a localhost/http/wildcard CORS origin, or matching JWT
secrets. (Proven: `ENV=production` with dev secrets exits 1.)

---

## Deploy

### Backend

```bash
cd backend
fly deploy                       # builds Dockerfile, rolling release
fly certs add api.<your-domain>  # one-time; Fly provisions Let's Encrypt
# DNS: CNAME api.<your-domain> -> mandalika-pos.fly.dev
curl https://api.<your-domain>/healthz   # {"data":{"status":"ok"}}
```

Migrations apply automatically on boot (embedded, idempotent via
`schema_migrations`). Seed the first admin once:
`fly ssh console -C "/server"` is not interactive — instead run the seed
locally against the prod DB one time:
`DATABASE_URL=<neon> SEED_ADMIN_*=... go run ./cmd/seed`.

### Backoffice

Push to the deploy branch → Cloudflare Pages builds automatically. Set the
Pages env var `VITE_API_URL=https://api.<your-domain>`. Add custom domain
`admin.<your-domain>` in the Pages dashboard (CDN + TLS automatic).

### POS Android APK (signed release)

```bash
pnpm --filter @mandalika/pos build           # VITE_API_URL=https://api.<your-domain>
cd apps/pos && npx cap sync android
# keystore.properties present (storeFile/storePassword/keyAlias/keyPassword)
cd android && ./gradlew assembleRelease
# -> app/build/outputs/apk/release/app-release.apk  (signed, allowMixedContent=false)
```

Verify before distributing: `apksigner verify --print-certs app-release.apk`.

---

## Rollback

- **Backend**: `fly releases` → `fly deploy --image <previous-image>` (or
  `fly releases rollback`). The new build only goes live after `/readyz`
  passes, so a bad image self-aborts the rolling deploy.
- **Backoffice**: Cloudflare Pages → Deployments → "Rollback to this
  deployment" (instant, CDN-level).
- **POS**: clients keep a local offline snapshot and queue; if a release is
  bad, distribute the previous signed APK. The sync contract is unchanged,
  so queued offline sales still flush against the rolled-back backend.
- **Migration**: forward-only. To undo schema, restore the DB (below) — so
  always run the backup immediately before a deploy that adds a migration.

## DB restore (disaster recovery + drill)

Neon keeps automated daily snapshots and PITR — primary recovery is the
Neon console ("Restore"/branch to a timestamp). The portable second copy:

```bash
DATABASE_URL=<prod> ./scripts/db-backup.sh           # -> backups/mandalika_<ts>.dump
# restore into a fresh/standby DB and verify row counts:
TARGET_DATABASE_URL=<target> ./scripts/db-restore.sh backups/mandalika_<ts>.dump
```

`db-restore.sh` prints `orders/order_items/products/shifts` counts after
restore — they must match the source. **This drill was executed and passed
locally** (dump → fresh DB → identical counts), so the mechanism is proven;
run it quarterly against prod backups.

Schedule `db-backup.sh` daily (cron / CI scheduled workflow) and copy the
artifact off-host. Backups contain PII → `backups/` is gitignored.

## Secret rotation

```bash
./scripts/gen-secrets.sh
fly secrets set JWT_ACCESS_SECRET=<new> JWT_REFRESH_SECRET=<new>
```

Setting secrets triggers a restart. Rotating JWT secrets invalidates all
sessions — cashiers re-login (offline queue survives). Rotate the Neon and
Upstash credentials from their dashboards and `fly secrets set` the new
URLs. The dev secrets in git history were never production values; prod
secrets only ever exist in the Fly secret store.

## Monitoring

- `GET /readyz` — liveness (no deps), drives the Fly health check.
- `GET /healthz` — deep (DB + Redis), for uptime monitoring (e.g. a free
  uptime checker hitting it every minute).
- Structured JSON request logs on stdout in production (`fly logs`):
  `method, path, status, duration_ms, request_id, ip`.
- Panics → 500 + structured `error` log + Sentry event when `SENTRY_DSN`
  is set (no-op otherwise).
- Rate limits: global per-IP (`RATE_LIMIT_RPS`×60/min), auth endpoints
  10/min/IP → HTTP 429 with `Retry-After`.

---

# Free-tier test cutover (Cloud Run + Neon + Upstash + Cloudflare + Sentry)

$0, no domain. Platform subdomains carry valid TLS certs and satisfy the
HTTPS + CORS gate. Same `Dockerfile` as the Fly path.

Prereqs once: install `gcloud` and `psql`, then `gcloud auth login` and
`gcloud config set project <YOUR_GCP_PROJECT>`.

### 1. Neon (Postgres)

1. Neon console → create project, region closest (e.g. AWS Singapore),
   database `mandalika_pos`.
2. Copy the **Pooled** connection string (host has `-pooler`). Ensure it
   ends `?sslmode=require`. Call this `DATABASE_URL`.
3. Backups: Neon free keeps automated history — restore via console
   (Branches / "Restore to timestamp"). Portable copy: `scripts/db-backup.sh`.

### 2. Upstash (Redis)

1. Upstash console → create Redis database (region near Neon).
2. Copy the **`rediss://`** URL (TLS). Call this `REDIS_URL`.

### 3. Sentry

1. Sentry → new project, platform **Go**. Copy the **DSN** → `SENTRY_DSN`.

### 4. Secrets → Google Secret Manager

```bash
./scripts/gen-secrets.sh   # prints JWT_ACCESS_SECRET / JWT_REFRESH_SECRET / SEED_ADMIN_PASSWORD

gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
  secretmanager.googleapis.com artifactregistry.googleapis.com

# Create one secret per value (paste value when prompted, Ctrl-D to end):
for K in DATABASE_URL REDIS_URL JWT_ACCESS_SECRET JWT_REFRESH_SECRET \
         SEED_ADMIN_PASSWORD SENTRY_DSN CLOUDINARY_API_SECRET; do
  printf '%s' "PASTE_$K" | gcloud secrets create "$K" --data-file=- 2>/dev/null \
    || printf '%s' "PASTE_$K" | gcloud secrets versions add "$K" --data-file=-
done
# (Re-run a single one to set the real value, e.g.:)
printf '%s' 'postgres://...pooler...neon.tech/mandalika_pos?sslmode=require' \
  | gcloud secrets versions add DATABASE_URL --data-file=-
```

### 5. Deploy backend to Cloud Run

`asia-southeast2` = Jakarta (closest to Lombok).

```bash
gcloud run deploy mandalika-pos \
  --source backend \
  --region asia-southeast2 \
  --allow-unauthenticated \
  --port 8080 \
  --min-instances 0 \
  --set-env-vars ENV=production,SEED_ADMIN_EMAIL=admin@mandalika.test,SEED_ADMIN_NAME=Administrator,CLOUDINARY_CLOUD_NAME=<name>,CLOUDINARY_API_KEY=<key>,RATE_LIMIT_RPS=20,RATE_LIMIT_BURST=40 \
  --set-secrets DATABASE_URL=DATABASE_URL:latest,REDIS_URL=REDIS_URL:latest,JWT_ACCESS_SECRET=JWT_ACCESS_SECRET:latest,JWT_REFRESH_SECRET=JWT_REFRESH_SECRET:latest,SEED_ADMIN_PASSWORD=SEED_ADMIN_PASSWORD:latest,SENTRY_DSN=SENTRY_DSN:latest,CLOUDINARY_API_SECRET=CLOUDINARY_API_SECRET:latest
```

`CORS_ORIGINS` is set in step 7 (needs the Pages URL). First deploy will
boot-fail config validation until then — expected; redeploy in step 7.

Note the service URL: `https://mandalika-pos-XXXXXX-et.a.run.app` = `API_URL`.
Cold start ~1–2s after idle (min-instances 0) — fine for a test.

### 6. Seed the first admin (once)

Run locally against Neon (Cloud Run image has no shell):

```bash
cd backend
DATABASE_URL='<neon pooled url>' SEED_ADMIN_EMAIL=admin@mandalika.test \
SEED_ADMIN_PASSWORD='<from gen-secrets>' SEED_ADMIN_NAME=Administrator \
go run ./cmd/seed
```

### 7. Cloudflare Pages (backoffice + the CORS origin)

1. Pages → Create → connect the repo.
2. Build command: `corepack pnpm install --frozen-lockfile && corepack pnpm --filter @mandalika/backoffice build`
   Build output dir: `apps/backoffice/dist`  ·  Root: repo root.
3. Env var: `VITE_API_URL = <API_URL>` (the Cloud Run URL).
4. Deploy → note the URL `https://mandalika-pos.pages.dev` = `ADMIN_URL`.
5. Set CORS and redeploy backend:

```bash
gcloud run services update mandalika-pos --region asia-southeast2 \
  --update-env-vars CORS_ORIGINS="<ADMIN_URL>,https://localhost"
```

`https://localhost` = Capacitor Android native origin (validated &
allowed; iOS would add `capacitor://localhost`).

Verify: `curl <API_URL>/healthz` → `{"data":{"status":"ok"}}`.

### 8. POS signed APK → phone

```bash
./scripts/gen-android-keystore.sh                 # once; back up the .jks
# write apps/pos/android/keystore.properties (gitignored):
#   storeFile=/abs/path/mandalika-release.jks
#   storePassword=...
#   keyAlias=mandalika
#   keyPassword=...

cd "$(git rev-parse --show-toplevel)"
VITE_API_URL=<API_URL> corepack pnpm --filter @mandalika/pos build
cd apps/pos && npx cap sync android
cd android && ./gradlew assembleRelease
apksigner verify --print-certs app/build/outputs/apk/release/app-release.apk
```

Transfer `app-release.apk` to the phone, install (allow unknown sources),
open over mobile data / any internet, log in as the seeded admin, ring up
a sale. `allowMixedContent=false` + HTTPS API = secure path. Screenshot
the completed sale = criterion 6 proof.

### Criteria mapping (free-tier)

1 ✅ `*.run.app` valid cert, CORS = Pages URL + `https://localhost`.
2 ✅ Neon managed, automated history + `db-backup.sh`/`db-restore.sh`.
3 ✅ all secrets in Google Secret Manager, none in git.
4 ✅ backoffice on Cloudflare CDN; signed APK, prod API, mixed-content off.
5 ✅ `/healthz` `/readyz`, JSON logs (`gcloud run services logs read mandalika-pos`),
   Sentry, rate limit; this runbook.
6 ✅ real sale screenshot over the internet + these docs.
