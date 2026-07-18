# Mandalika POS — Complete Onboarding Walkthrough

**Who this is for:** someone sitting at a brand-new laptop who has never touched
this project. It assumes no prior knowledge of the repo. Follow it top to bottom.

**Time to a working local setup:** about 60–90 minutes, most of it downloads.

> **The single most important thing on this page:** a `git clone` is **not
> enough** to fully continue this project. Three things live outside git and
> cannot be recovered if lost. Read [Part 0](#part-0--things-git-cannot-give-you)
> before anything else.

---

## Table of contents

- [Part 0 — Things git cannot give you](#part-0--things-git-cannot-give-you)
- [Part 1 — What this project actually is](#part-1--what-this-project-actually-is)
- [Part 2 — Install the toolchain](#part-2--install-the-toolchain)
- [Part 3 — Clone and first-time setup](#part-3--clone-and-first-time-setup)
- [Part 4 — Run it locally](#part-4--run-it-locally)
- [Part 5 — Prove it works](#part-5--prove-it-works)
- [Part 6 — The daily development loop](#part-6--the-daily-development-loop)
- [Part 7 — Rules you must not break](#part-7--rules-you-must-not-break)
- [Part 8 — Shipping to the live test environment](#part-8--shipping-to-the-live-test-environment)
- [Part 9 — Repo map](#part-9--repo-map)
- [Part 10 — Troubleshooting](#part-10--troubleshooting)
- [Part 11 — Known documentation traps](#part-11--known-documentation-traps)
- [Glossary](#glossary)

---

## Part 0 — Things git cannot give you

Do this **before** you wipe or leave the old laptop. Everything in this section
is deliberately excluded from git (see `.gitignore`), so a fresh clone will be
missing it.

### 0.1 The Android signing keystore — IRREPLACEABLE

**File:** `mandalika-release.jks` (repo root on the old machine, ~4 KB).

This is **not in git** — `*.jks` is gitignored. Verified: `git ls-files` does not
list it.

Android will refuse to install an update over an existing app unless the new APK
is signed with the **same** key. If this file (or its passwords) is lost:

- every tablet already running the POS must **uninstall** the app,
- which **wipes local app storage**, including any unsynced offline orders sitting
  in the outbox.

**Action:** copy `mandalika-release.jks` to the new laptop **and** into a password
manager / encrypted backup, along with these four values:

| What | Where it's used |
|---|---|
| keystore password | `ANDROID_KEYSTORE_PASSWORD` |
| key alias (`mandalika`) | `ANDROID_KEY_ALIAS` |
| key password | `ANDROID_KEY_PASSWORD` |
| the `.jks` file itself, base64-encoded | GitHub secret `ANDROID_KEYSTORE_BASE64` |

Good news: the APK is normally built in **GitHub Actions**, which already holds
these as repository secrets. So day-to-day APK builds keep working on a new laptop
without the local file. You still want the backup — GitHub secrets are
write-only, you cannot read them back out.

### 0.2 `backend/.env` — your local secrets file

Not in git. You will recreate it in [Part 3](#part-3--clone-and-first-time-setup)
from the committed `backend/.env.example`. Nothing irreplaceable here (local dev
values only), but note the old laptop's `.env` holds the local admin password you
have been logging in with.

### 0.3 Account access

The code is portable; the accounts are not. Make sure you can still log in to:

| Service | What it holds | You need |
|---|---|---|
| **GitHub** (`Epheyy/mandalika-pos`) | the code, CI, Actions secrets | account + `gh` CLI auth |
| **Google Cloud** (project `mandalika-pos`) | backend hosting, all prod secrets, OTA bucket | `gcloud auth login` |
| **Neon** | the PostgreSQL database (all test data) | dashboard login |
| **Upstash** | Redis | dashboard login |
| **Cloudflare** | backoffice hosting (Pages) | dashboard login |
| **Sentry** | error tracking | dashboard login (optional) |
| **Cloudinary** | product image uploads | dashboard login |

You do **not** need to copy any secret values by hand — they live in Google Secret
Manager and GitHub Actions secrets. You only need account access.

---

## Part 1 — What this project actually is

> ⚠️ `README.md` in this repo is the **stock Vite starter template**. It was never
> replaced and tells you nothing about the project. Ignore it. This file is the
> real entry point.

**Mandalika POS** is an offline-first point-of-sale system for a small
multi-outlet Indonesian retail / F&B business (Lombok). The UI is in Bahasa
Indonesia ("Buka Shift", "Rekap", "Tutup Shift").

It was rebuilt from an earlier Firebase/Firestore browser-only app, which had
real problems: no server-side permission checks, money/stock/loyalty math that
ran on the client where it could be tampered with, and a stock decrement that
wasn't transactional (two cashiers could oversell the same item). The current
design is **server-authoritative** — the server decides prices, discounts, stock,
and loyalty; the client only proposes.

### The three runnable pieces

| Piece | Path | What it is | Who uses it |
|---|---|---|---|
| **Backend API** | `backend/` | Go 1.26 + chi + PostgreSQL + Redis | everything |
| **POS** | `apps/pos/` | React + Vite + Capacitor → **Android APK** | cashiers, on tablets |
| **Backoffice** | `apps/backoffice/` | React + Vite web SPA | the owner/admin, on a desktop |

Plus four shared libraries in `packages/`: `types`, `api` (generated API client),
`sync` (the offline engine), `printer` (Bluetooth receipt printing).

### The one idea that explains most of the code

**The POS must keep selling when the internet drops.** That single requirement
drives the hardest parts of the codebase:

- the POS keeps a **local snapshot** of products/prices/stock,
- completed orders go into a **durable outbox**, keyed `device_id:order_uuid`,
- a sync engine flushes them **one at a time, in order**, when connectivity returns,
- the server re-validates everything on arrival and is idempotent on replay.

So there are often **two implementations of the same business rule** — one in Go
on the server (authoritative) and one in TypeScript on the POS (optimistic, for
offline). Promotions are the clearest example: `backend/internal/service/` has
the Go validator, `apps/pos/src/cashier/promoValidate.ts` is its TypeScript port.
**When you change one, you must change the other.**

### Feature modules already built

Inventory & transfers · recipes/formulas · CRM (customers, tags, segments,
interactions, loyalty points ledger, duplicate-merge review) · a large promotions
engine (stacking, buy-X-get-Y, tiered spend, bundles, reward giveaways, grants
reporting) · discount codes (bulk generation, analytics, per-customer caps,
customer-assigned) · self-hosted OTA updates for the POS web layer.

Design documents for each of these live in `docs/superpowers/plans/` — one
markdown file per feature slice, dated. If you're wondering *why* something works
a certain way, that folder is the answer.

---

## Part 2 — Install the toolchain

Written for **Windows** (the machine this was developed on). macOS/Linux notes
are inline. Install in this order.

### 2.1 Required for everything

| Tool | Version | Why | Windows install |
|---|---|---|---|
| **Git** | any recent | clone the repo | [git-scm.com](https://git-scm.com/download/win) — includes **Git Bash**, which you'll want |
| **Docker Desktop** | any recent | runs local Postgres + Redis | [docker.com](https://www.docker.com/products/docker-desktop/) — must be **running**, and enable WSL2 when asked |
| **Go** | **1.26** | the backend | [go.dev/dl](https://go.dev/dl/) |
| **Node.js** | **22 LTS** | the two frontends | [nodejs.org](https://nodejs.org/) — CI uses 22; newer usually works |
| **pnpm** | **9.15.0** | package manager | via corepack, see below |

**About pnpm — read this, it is a real trap.** Do **not** `npm install -g pnpm`.
This repo is a pnpm *workspace* and is sensitive to the pnpm version, because a
mismatched version rewrites `pnpm-lock.yaml` and silently breaks the Cloudflare
deploy. Use corepack (ships with Node):

```bash
corepack enable
corepack prepare pnpm@9.15.0 --activate
```

If `corepack enable` fails with **EPERM** on Windows (common — it needs to write
to the Node install dir), don't fight it. Skip `enable` and prefix every command
with `corepack`, exactly as the rest of this guide does:

```bash
corepack pnpm install     # instead of: pnpm install
```

> ⚠️ **Version inconsistency to be aware of:** CI (`android-release.yml`) pins
> `pnpm@9.15.0`, but `pnpm-lock.yaml` was last regenerated with `pnpm@10.11.1`.
> Both write `lockfileVersion: 9.0` so they interoperate. **Use 9.15.0 to match
> CI.** If you ever need to regenerate the lockfile, see
> [Part 7.4](#74-touching-any-packagejson).

### 2.2 Required to deploy or inspect the live environment

| Tool | Why |
|---|---|
| **gcloud CLI** ([install](https://cloud.google.com/sdk/docs/install)) | deploy the backend, read secrets, publish OTA |
| **GitHub CLI `gh`** ([install](https://cli.github.com/)) | trigger the APK build |
| **psql** (PostgreSQL client tools) | optional — inspect the database directly |

Then authenticate once each:

```bash
gcloud auth login
gcloud config set project mandalika-pos
gh auth login
```

### 2.3 Only if you want to build the Android APK locally

**You almost certainly don't.** Release APKs are built by GitHub Actions, and
local release builds are **known to fail on Windows when the repo path contains a
space** — which it does on the current machine
(`C:\Users\MyBook Hype AMD\...`). The Bluetooth plugin's Gradle step chokes on it.

If you still want local debug builds:

- **Android Studio** (brings the Android SDK)
- SDK packages: `platforms;android-36`, `build-tools;36.0.0`, `platform-tools`
- **JDK 21 (Temurin)** — match CI. Note: this machine currently has **Java 23**;
  Gradle 8.14 may or may not accept it. If Gradle complains about the Java
  version, install JDK 21 and point `JAVA_HOME` at it.

Android build settings, for reference (`apps/pos/android/variables.gradle`):
`minSdk 24`, `compileSdk 36`, `targetSdk 36`, Android Gradle Plugin 8.13.0,
Gradle wrapper 8.14.3.

### 2.4 Verify

```bash
git --version
docker --version && docker ps      # `docker ps` must not error → daemon is running
go version                         # go1.26.x
node -v                            # v22.x
corepack pnpm -v                   # 9.15.0
gcloud --version
gh --version
```

---

## Part 3 — Clone and first-time setup

### 3.1 Clone

```bash
git clone https://github.com/Epheyy/mandalika-pos.git
cd mandalika-pos
git checkout prod-hardening
```

> **Why `prod-hardening` and not `main`?** `prod-hardening` is the active working
> branch and is **ahead of** `main`. All recent work lives there. Pushing to it
> also auto-deploys the backoffice. See [Part 7.1](#71-branches).

**Avoid a path with spaces** if you can — clone to something like `C:\dev\mandalika-pos`.
It sidesteps the Android/Gradle problem in [2.3](#23-only-if-you-want-to-build-the-android-apk-locally)
and assorted shell-quoting annoyances.

### 3.2 Restore the keystore

Copy `mandalika-release.jks` from your backup ([Part 0.1](#01-the-android-signing-keystore--irreplaceable))
into the repo root. It stays gitignored — that's correct, leave it that way.

### 3.3 Create `backend/.env`

```bash
cd backend
cp .env.example .env
```

Now open `backend/.env` and set **one** value — pick any local dev password:

```
SEED_ADMIN_PASSWORD=devpass123
```

Everything else in `.env.example` already points at the local Docker containers
and works as-is. Leave `CLOUDINARY_*` and `SENTRY_DSN` empty for local work —
image upload and error reporting simply no-op.

Full variable reference:

| Variable | Purpose | Required locally? | Default |
|---|---|---|---|
| `PORT` | listen port | no | `8080` |
| `ENV` | `development` / `production` | no | `development` |
| `CORS_ORIGINS` | comma-separated allowed browser origins | no | `http://localhost:5173` |
| `DATABASE_URL` | Postgres connection string | yes (`.env.example` is correct) | — |
| `REDIS_URL` | Redis connection string | yes (`.env.example` is correct) | — |
| `JWT_ACCESS_SECRET` | signs access tokens | no locally | `dev-access` |
| `JWT_REFRESH_SECRET` | signs refresh tokens; must differ from access | no locally | `dev-refresh` |
| `JWT_ACCESS_TTL_MIN` | access token lifetime | no | `15` |
| `JWT_REFRESH_TTL_HOURS` | refresh token lifetime | no | `168` |
| `SEED_ADMIN_EMAIL` | first admin's login | no | `admin@mandalika.local` |
| `SEED_ADMIN_PASSWORD` | first admin's password | **yes** — `cmd/seed` aborts if empty | — |
| `SEED_ADMIN_NAME` | display name | no | `Administrator` |
| `CLOUDINARY_CLOUD_NAME` / `_API_KEY` / `_API_SECRET` | signed image uploads | no | empty |
| `SENTRY_DSN` | error tracking; no-op when empty | no | empty |
| `RATE_LIMIT_RPS` / `RATE_LIMIT_BURST` | per-IP rate limiting | no | `20` / `40` |

> The single source of truth is `backend/internal/config/config.go`. Nothing else
> in the backend reads environment variables directly.
>
> **Production safety net:** when `ENV=production`, `cfg.Validate()` refuses to
> boot on any dev default, a database URL with `sslmode=disable` or pointing at
> localhost, a wildcard/`http://`/localhost CORS origin, or identical JWT
> secrets. That's intentional — a misconfigured production server dies loudly
> instead of running insecurely.

### 3.4 Install JavaScript dependencies

From the **repo root**:

```bash
corepack pnpm install
```

This installs for all six workspace packages at once. Takes a few minutes the
first time.

---

## Part 4 — Run it locally

You'll want **three terminals**. Keep them open.

### Terminal 1 — databases

```bash
cd backend
docker compose up -d
```

Starts PostgreSQL 16 and Redis 7 in containers.

> **Why port 5433 and not 5432?** The original dev machine already had a
> PostgreSQL installed on the standard 5432. The container is deliberately
> remapped to **5433** to avoid the clash. `.env.example` already accounts for
> this. If you connect with `psql` by hand, remember `-p 5433`.

Check they're healthy:

```bash
docker compose ps
```

### Terminal 2 — the backend

```bash
cd backend
go run ./cmd/seed      # first time (and after any migration change)
go run ./cmd/server    # → listening on :8080
```

**What `cmd/seed` does:** applies all database migrations, then creates the first
admin user. It is **idempotent** — safe to re-run; it no-ops if the admin already
exists.

**Optional — load sample data.** Empty database means an empty product catalog.
To get something to click on:

```bash
docker exec -i backend-postgres-1 psql -U mandalika -d mandalika_pos < sample_seed.sql
```

(Check the container name with `docker compose ps` if that errors.)

**How migrations work:** they're `.sql` files in
`backend/internal/db/migrations/`, embedded into the binary at compile time, and
applied **automatically on every boot** in filename order. Each applied file is
recorded in a `schema_migrations` table and skipped thereafter. There's no
separate migration tool and no `migrate up` command. Currently at `0044`.

### Terminal 3 — a frontend

```bash
# from the repo root
corepack pnpm --filter @mandalika/pos dev          # cashier   → http://localhost:5173
corepack pnpm --filter @mandalika/backoffice dev   # admin     → http://localhost:5174
```

Or the shorthands: `corepack pnpm dev:pos` / `corepack pnpm dev:backoffice`.

Both default to `http://localhost:8080` for the API when `VITE_API_URL` is unset,
which is exactly what you want locally. **There is no `.env` file for the
frontends** and none is needed — `VITE_API_URL` is the only frontend variable
that exists, and you only set it when building for a real device.

### Shutting down

```bash
cd backend && docker compose stop
```

Then Ctrl-C the server and dev-server terminals. (Windows sometimes leaves a stray
`go run ./cmd/server` process — check Task Manager if port 8080 is still busy.)

---

## Part 5 — Prove it works

Run these in order. If all four pass, your environment is correct.

**1. The API is alive**

```bash
curl localhost:8080/healthz
# → {"data":{"status":"ok"}}
```

**2. The backoffice loads and you can log in**

Open <http://localhost:5174>. Log in with:

- email: `admin@mandalika.local` (or whatever `SEED_ADMIN_EMAIL` says)
- password: whatever you put in `SEED_ADMIN_PASSWORD`

**3. The POS loads**

Open <http://localhost:5173>, log in with the same credentials, open a shift
("Buka Shift"), and ring up a sale. If you loaded `sample_seed.sql` there will be
products to sell.

**4. The test suites pass**

```bash
cd backend && go test ./...          # ~25 Go test files, pure logic, no DB needed
cd ..
corepack pnpm --filter @mandalika/pos test
corepack pnpm --filter @mandalika/backoffice test
corepack pnpm --filter @mandalika/printer test
```

> Note: `packages/sync` has tests but **no `test` script** in its package.json —
> a small gap. Run them with vitest directly if you need to.

---

## Part 6 — The daily development loop

1. `git pull` on `prod-hardening`.
2. Start the three terminals ([Part 4](#part-4--run-it-locally)).
3. Make your change.
4. **If you touched `backend/api/openapi.yaml`** → regenerate, see [7.2](#72-changing-the-api-shape).
5. **If you touched a business rule that also exists in the POS** → change both, see [7.3](#73-the-two-implementations-rule).
6. Run the relevant tests + `cd backend && make vet fmt`.
7. Commit. Conventional-commit style: `feat:` `fix:` `refactor:` `docs:` `test:` `chore:` `perf:` `ci:`.
8. Push → the backoffice auto-deploys; the backend does **not**.
9. Deploy/build whatever else changed ([Part 8](#part-8--shipping-to-the-live-test-environment)).

### Useful commands

**Backend** (`cd backend`, all via `make`):

| Command | Does |
|---|---|
| `make up` / `make down` | start / stop Docker Postgres + Redis |
| `make run` | `go run ./cmd/server` |
| `make seed` | `go run ./cmd/seed` |
| `make test` | `go test ./...` |
| `make vet` | `go vet ./...` |
| `make fmt` | `gofmt -l -w .` |
| `make gen-go` | regenerate Go types from the OpenAPI spec |
| `make gen-ts` | regenerate the TypeScript client from the OpenAPI spec |
| `make gen` | both of the above |
| `make gen-check` | fail if generated code is stale — this is the CI gate |

**Root:**

| Command | Does |
|---|---|
| `corepack pnpm build` | build every workspace package |
| `corepack pnpm lint` | ESLint across the repo |
| `corepack pnpm dev:pos` / `dev:backoffice` | dev servers |
| `corepack pnpm doctor` | react-doctor diagnostics (advisory) |

---

## Part 7 — Rules you must not break

These are the things that have actually bitten this project. Each one cost a
debugging session.

### 7.1 Branches

- **`prod-hardening`** — the active branch. Work here.
- **`main`** — the default branch, behind `prod-hardening`.
- Pushing to `prod-hardening` **auto-deploys the backoffice** to Cloudflare Pages.
  Nothing else auto-deploys.
- The backend **never** auto-deploys. It's always a manual `gcloud run deploy`.

### 7.2 Changing the API shape

`backend/api/openapi.yaml` is the **single source of truth** for the API. Both the
Go server types and the TypeScript client are generated from it. If you edit it:

```bash
cd backend
make gen        # regenerates internal/api/api.gen.go AND packages/api/src/schema.d.ts
```

Then **commit both generated files.** CI runs `make gen-check` and fails the build
if they're stale.

> **Codegen gotcha:** `openapi-typescript` silently drops `nullable: true` on
> schemas that use `$ref`. TypeScript will see `T | undefined` instead of
> `T | null | undefined`. When clearing such a field from TS, use `undefined` or
> omit the key — don't send `null`. (Go uses pointer + `omitempty`, so an omitted
> field and null are the same thing on the wire.)

### 7.3 The two-implementations rule

Business rules that must work offline exist **twice** — Go on the server, TS on
the POS. Promotions, pricing, stock, and loyalty eligibility all work this way.
Change one, change the other, or the POS will show a price the server then
rejects. `apps/pos/src/cashier/promoValidate.ts` is a deliberate 1:1 port of the
Go validator; keep it that way.

### 7.4 Touching any `package.json`

If you add/remove/bump **any** dependency, you must regenerate the lockfile and
commit it:

```bash
corepack pnpm install --lockfile-only
```

**Why this matters:** Cloudflare Pages builds with `--frozen-lockfile`. A
`package.json` that disagrees with `pnpm-lock.yaml` fails with
`ERR_PNPM_OUTDATED_LOCKFILE` — and because the backend CI is a completely separate
pipeline that stays green, **you won't notice** unless you check the Cloudflare
deploy. Always confirm the Pages build went green after a dependency change.

### 7.5 Adding a database column

The lesson from a real bug: adding a column means tracing **every** layer, not
just the obvious two. Checklist:

1. new migration file `NNNN_description.sql`
2. `backend/api/openapi.yaml`
3. the Go **write** struct
4. the `INSERT` statement
5. the `UPDATE` statement ← *this is the one that gets forgotten*
6. the **read** query / `json_build_object`
7. the backoffice form field
8. the form's edit/open path (loading an existing record must not wipe the field)

A column added to the spec and the form but not to the repo SQL will look
completely correct and silently save nothing.

### 7.6 Migration files are immutable

Migrations are tracked by **full filename**. Renaming an already-applied migration
makes the server think it's a brand-new one and **re-run it**. Never rename or
edit an applied migration — add a new one.

> Quirk: two files share the `0005` prefix (`0005_order_scheme_outlet_code.sql`
> and `0005_payment_method_freeform.sql`). This is harmless — ordering is lexical
> and both are recorded separately. **Do not "fix" it by renaming.**

### 7.7 Push before you build an APK

The APK workflow builds from **origin**, not your local working tree. Forgetting
`git push` first ships stale POS code and the resulting confusion is expensive.

---

## Part 8 — Shipping to the live test environment

> **Context:** the deployed environment is a **pre-launch test cutover**. It runs
> on free tiers and holds **test data**, not real customer data. Deploying is
> low-stakes — it's how changes get checked. It is *not* a live production system
> with real customers.

### The topology

| Component | Host | Deploys how |
|---|---|---|
| Backend API | Google Cloud Run, service `mandalika-pos`, region `asia-southeast2` (Jakarta) | **manual** `gcloud run deploy` |
| Database | Neon (managed PostgreSQL, pooled, TLS) | — |
| Redis | Upstash | — |
| Backoffice | Cloudflare Pages → `mandalika-pos.pages.dev` | **auto** on push to `prod-hardening` |
| POS app | signed Android APK | **manual** GitHub Actions dispatch |
| POS web layer | Capgo OTA, bundles in `gs://mandalika-pos-ota` | **manual** `make ota-release` |

API URL: `https://mandalika-pos-538849926142.asia-southeast2.run.app`

### 8.1 Deploy the backend

```bash
gcloud run deploy mandalika-pos --source backend --region asia-southeast2 --quiet
```

Takes ~4–6 minutes. Migrations apply automatically when the new container boots.

Verify with **`/readyz`**, not `/healthz` — Google's edge swallows `/healthz`:

```bash
curl https://mandalika-pos-538849926142.asia-southeast2.run.app/readyz
```

Logs: `gcloud run services logs read mandalika-pos --region asia-southeast2`

### 8.2 Deploy the backoffice

Just `git push` to `prod-hardening`. Cloudflare Pages picks it up. Then **check the
Cloudflare dashboard that the build went green** — see [7.4](#74-touching-any-packagejson).

### 8.3 Build a new POS APK

Needed whenever the POS changes in a way OTA can't deliver — see [8.4](#84-ship-a-pos-web-only-update-ota).

```bash
git push                                    # MUST come first — CI builds from origin
gh workflow run android-release.yml --ref prod-hardening \
  -f api_url=https://mandalika-pos-538849926142.asia-southeast2.run.app
```

Watch it: `gh run list --workflow=android-release.yml`

Download when green: the artifact is **`mandalika-pos-release-apk`**, containing
the signed `app-release.apk`. Transfer to the tablet and install.

The workflow does: Node 22 → pnpm 9.15.0 → install → build POS with your
`api_url` → JDK 21 → Android SDK 36 → `cap sync android` → decode the keystore
secret → `./gradlew assembleRelease` → `apksigner verify`.

> The API URL is **baked into the bundle at build time**. Pointing the app at a
> different backend means a rebuild.

### 8.4 Ship a POS web-only update (OTA)

This is the fast path — it updates the POS **without** reinstalling the APK on
every tablet.

```bash
make ota-release VERSION=1.0.1
```

The script refuses to republish the current version, builds the POS against the
production API, zips it with the Capgo CLI, uploads to `gs://mandalika-pos-ota`,
and calls the authenticated `/api/v1/ota/publish` endpoint. Needs `gcloud`
authenticated (it reads `SEED_ADMIN_PASSWORD` from Secret Manager).

**OTA can ship:** React/TS changes, styling, business logic in the web layer.
**OTA cannot ship:** Capacitor plugin changes, Android permissions, native
config, splash/icon changes, Capacitor version bumps. Those need a full APK.

### 8.5 Database backup / restore

```bash
DATABASE_URL='<connection string>' ./scripts/db-backup.sh    # → backups/, keeps last 14
TARGET_DATABASE_URL='<...>' ./scripts/db-restore.sh <dump>   # ⚠️ DESTRUCTIVE
```

Neon also keeps its own automated history — restore via the console
("Branches → Restore to timestamp").

### 8.6 The other scripts

| Script | Purpose |
|---|---|
| `scripts/gen-secrets.sh` | print fresh JWT secrets + an admin password for a secret store |
| `scripts/gen-android-keystore.sh` | one-time keystore creation (refuses to overwrite) |
| `scripts/gen-icons.ps1` | regenerate the Android adaptive app icon |

---

## Part 9 — Repo map

```
mandalika-pos/
├── ONBOARDING.md            ← you are here
├── README.md                ← ⚠️ stock Vite template, ignore it
├── RUNBOOK.md               deploy / rollback / restore / rotate secrets
├── DEV_TO_PROD_WALKTHROUGH.md   detailed local→device walkthrough
├── PHASE_HANDOFF.md         historical phase notes + session start commands
├── SESSION_HANDOFF.md       most recent session state — read when resuming
├── CUTOVER.md / CUTOVER_WALKTHROUGH.md   the Firestore→Postgres migration
├── Makefile                 `make ota-release`
│
├── backend/                 Go API — the authority on all business rules
│   ├── api/openapi.yaml     ★ API source of truth
│   ├── cmd/server/          the HTTP server
│   ├── cmd/seed/            bootstrap admin (idempotent, also migrates)
│   ├── cmd/migrate-firestore/  one-off legacy importer
│   ├── cmd/*e2e/            throwaway end-to-end harnesses per feature slice
│   ├── internal/api/api.gen.go   ★ GENERATED — never hand-edit
│   ├── internal/config/     the only place env vars are read
│   ├── internal/db/migrations/   ★ embedded SQL, auto-applied on boot
│   ├── internal/service/    business logic (pricing, promos, loyalty)
│   ├── internal/write/      transactional writes (stock, orders, transfers)
│   ├── docker-compose.yml   local Postgres :5433 + Redis :6379
│   └── Dockerfile           two-stage → distroless
│
├── apps/
│   ├── pos/                 cashier app (React + Capacitor → Android)
│   │   ├── src/cashier/     cart, pricing, promos, scanning, offline logic
│   │   ├── android/         committed native project
│   │   ├── capacitor.config.ts
│   │   └── NATIVE.md        local Android build notes
│   └── backoffice/          admin SPA (online-only)
│
├── packages/
│   ├── types/               shared TS types
│   ├── api/                 API client; src/schema.d.ts is ★ GENERATED
│   ├── sync/                ★ the offline engine — outbox, ordering, replay
│   └── printer/             Bluetooth ESC/POS receipts
│
├── scripts/                 ota-release, db-backup/restore, gen-secrets, keystore
├── docs/
│   ├── superpowers/plans/   ★ one design doc per feature slice — read these
│   └── audits/              repo audit + react-doctor handoff
└── .github/workflows/       backend CI · android-release · react-doctor
```

★ = read this before changing anything nearby.

**Where to start reading code**, depending on the task:

| Task | Start at |
|---|---|
| add an API endpoint | `backend/api/openapi.yaml` → `internal/api/` → `internal/service/` |
| change pricing/promo logic | `backend/internal/service/` **and** `apps/pos/src/cashier/` |
| POS cart behavior | `apps/pos/src/cashier/state/cashierReducer.ts` |
| offline sync issue | `packages/sync/src/engine.ts` |
| receipt formatting | `packages/printer/src/escpos.ts` |
| admin screen | `apps/backoffice/src/screens/` |

---

## Part 10 — Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `docker compose up` fails | Docker Desktop isn't running | start it, wait for the whale icon |
| backend: connection refused on 5433 | containers not up | `cd backend && docker compose ps` |
| backend exits immediately | bad config, or port 8080 taken | read the log line it prints; check for a stray `go run` process |
| `cmd/seed` fatals | `SEED_ADMIN_PASSWORD` empty | set it in `backend/.env` |
| Can't log in locally | password ≠ `.env`, or seed never ran | re-run `go run ./cmd/seed`, check `SEED_ADMIN_EMAIL` |
| Frontend loads, all API calls fail | backend down, or CORS | check `/healthz`; ensure your port is in `CORS_ORIGINS` |
| POS shows no products | database is empty | load `backend/sample_seed.sql` |
| CI fails on `gen-check` | edited `openapi.yaml`, forgot to regenerate | `cd backend && make gen`, commit both generated files |
| CI fails on gofmt | unformatted Go | `cd backend && make fmt` |
| Cloudflare: `ERR_PNPM_OUTDATED_LOCKFILE` | `package.json` changed without lockfile | `corepack pnpm install --lockfile-only`, commit |
| APK has old code | built before pushing | `git push`, re-dispatch the workflow |
| Android won't install the update | APK signed with a different key | you must use the original `mandalika-release.jks` |
| Local Gradle release build fails | space in the repo path | build via GitHub Actions, or clone to a space-free path |
| **First** DB write after idle returns HTTP 400 | Neon free-tier stale pooled connection — **not a bug in your code** | retry; it passes when warm |
| `corepack enable` → EPERM | Windows permissions | skip it; prefix commands with `corepack` |

---

## Part 11 — Known documentation traps

Things in this repo that will mislead you. Trust this list over the documents.

1. **`README.md` is the stock Vite template.** It has nothing to do with this
   project. This file replaces it.

2. **`RUNBOOK.md` describes Fly.io as the production host.** That's historical.
   The real deployment is the **"Free-tier test cutover"** section (line ~167
   onward): Cloud Run + Neon + Upstash + Cloudflare Pages. `backend/fly.toml`
   exists but is unused. **Do not follow the Fly.io sections.**

3. **`vercel.json` is dead.** Vercel is not used. It's a leftover SPA rewrite from
   before the re-platform.

4. **Two docs give different local admin passwords** (`PHASE_HANDOFF.md` says
   `devpass123`, `DEV_TO_PROD_WALKTHROUGH.md` says `adm_mndlk_2026`). Neither is
   authoritative — whatever *you* put in `backend/.env` is.

5. **pnpm version is inconsistent**: CI pins 9.15.0, the lockfile was last written
   by 10.11.1. Use 9.15.0.

6. **No `packageManager`, `engines`, or `.nvmrc` field exists**, so nothing
   enforces your Node/pnpm version. Node 22 + pnpm 9.15.0 are inferred from CI.

7. **The `0005` migration prefix is duplicated.** Intentional-by-now. Leave it.

8. **`backend/` contains committed-looking `.exe` build artifacts** (`promo1e2e.exe`
   etc.) from the e2e harnesses. Ignore them; don't treat them as source.

9. **The old laptop's working tree had uncommitted changes** — `package.json`,
   `apps/pos/package.json`, `pnpm-lock.yaml`, plus untracked PNGs and an audit
   doc. Check `git status` on the old machine and commit or discard before you
   consider the migration complete, or you'll lose them.

---

## Glossary

| Term | Meaning |
|---|---|
| **Outlet** | a physical store location. Most data is scoped per-outlet via the `X-Outlet-Id` header. |
| **Shift** | a cashier's working session. Opened ("Buka Shift") and closed with a cash count. |
| **Outbox** | the POS's durable queue of completed-but-not-yet-synced orders. |
| **Sync engine** | `packages/sync` — flushes the outbox one order at a time, in order, idempotently. |
| **OTA** | over-the-air update of the POS **web** layer (via Capgo), no APK reinstall. |
| **Capacitor** | the shell that wraps the React web app into a native Android app. |
| **Backoffice** | the admin web app (`apps/backoffice`). |
| **oapi-codegen** | generates Go server types from `openapi.yaml`. |
| **openapi-typescript** | generates the TS client types from the same spec. |
| **Neon** | the managed PostgreSQL host. |
| **Upstash** | the managed Redis host. |
| **Capgo** | the OTA update system, self-hosted here (bundles in a GCS bucket). |
| **Slice / SP-x** | one feature increment, each with a design doc in `docs/superpowers/plans/`. |

---

## First-day checklist

- [ ] `mandalika-release.jks` copied off the old laptop and backed up
- [ ] account access confirmed: GitHub, GCP, Neon, Upstash, Cloudflare
- [ ] old laptop's `git status` is clean (nothing uncommitted left behind)
- [ ] Git, Docker Desktop, Go 1.26, Node 22, pnpm 9.15.0 installed
- [ ] `gcloud auth login` + `gcloud config set project mandalika-pos`
- [ ] `gh auth login`
- [ ] repo cloned, on branch `prod-hardening`
- [ ] `backend/.env` created from `.env.example` with `SEED_ADMIN_PASSWORD` set
- [ ] `corepack pnpm install` succeeded
- [ ] `docker compose up -d` → both containers healthy
- [ ] `go run ./cmd/seed` → then `go run ./cmd/server`
- [ ] `curl localhost:8080/healthz` → ok
- [ ] logged into the backoffice at :5174
- [ ] logged into the POS at :5173 and rang up a test sale
- [ ] `go test ./...` and the vitest suites pass
- [ ] read `SESSION_HANDOFF.md` to see where work left off
