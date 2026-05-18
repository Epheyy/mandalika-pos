# Mandalika POS — Dev → Production Walkthrough

This file assumes you know **nothing**. Read top to bottom. Part A gets the app
running and tested on your machine and phone. Part B is a ready-to-run `/goal`
prompt that drives the app to production. Part C is the honest list of what is
still missing before real customers touch it, mapped to every layer of a
full-stack product.

Glossary (words used below):

- **Backend** — the Go program in `backend/`. Serves the API on port `8080`.
- **Frontend** — two web apps in `apps/`: `pos` (cashier, port 5173) and
  `backoffice` (admin, port 5174).
- **Postgres** — the database. Runs in Docker on port `5433`.
- **Redis** — fast cache. Runs in Docker on port `6379`.
- **Snapshot / sync** — the POS works offline. On login it pulls a copy of
  products/customers/etc. and queues sales locally, flushing to the server
  when online.
- **APK** — the installable Android app file.
- **LAN IP** — your PC's address on your Wi‑Fi. Here it is `192.168.1.14`
  (re-check with `ipconfig`; it changes between networks).

---

## PART A — Test it in development (zero experience needed)

You need three things alive at the same time: **database**, **backend**,
**frontend**. Open three terminals. Keep each running.

### A0. One-time prerequisites

Already installed on this machine, but for a fresh machine you need: Docker
Desktop, Go, Node.js, and (for Android) Android Studio + its SDK.

### A1. Start the database (Terminal 1)

```bash
cd backend
docker compose up -d           # starts Postgres (5433) + Redis (6379)
```

Wait ~10s. Verify: `docker compose ps` shows both as healthy.

### A2. Seed data + create the admin (Terminal 1, same place)

```bash
go run ./cmd/seed                                            # runs DB migrations, creates admin
docker exec -i backend-postgres-1 psql -U mandalika -d mandalika_pos < sample_seed.sql
```

What this does: builds the tables, creates the login
`admin@mandalika.local`, and loads sample data (1 outlet, 3 categories,
8 products, and binds the admin to the outlet so the POS can pull data).

> The admin password is whatever is set in `backend/.env` at
> `SEED_ADMIN_PASSWORD` (currently `adm_mndlk_2026`).

### A3. Start the backend (Terminal 2)

```bash
cd backend
go run ./cmd/server
```

Leave it running. It prints `listening on :8080`. Test it: open
<http://localhost:8080/healthz> in a browser — it should say OK.

### A4. Test in the browser (Terminal 3)

```bash
corepack pnpm install                                  # first time only
corepack pnpm --filter @mandalika/pos dev              # cashier  → http://localhost:5173
corepack pnpm --filter @mandalika/backoffice dev       # admin    → http://localhost:5174
```

(Run each in its own terminal, or one then the other.)

Open <http://localhost:5173>, log in with `admin@mandalika.local` /
`adm_mndlk_2026`.

**Smoke test the features that were built:**

1. Products appear in the grid (8 items). If empty: log out and back in
   (forces a fresh sync), and confirm the backend was restarted after the
   last code change.
2. Add items to cart → **Bayar** (checkout). On the checkout screen you should
   see the **Sales** dropdown (salesman picker) and, if the customer has
   points and loyalty is enabled, the **Tukar Poin** field.
3. Open a shift ("Buka Shift"), make a sale, then header → **Rekap** shows the
   payment-method breakdown and cash reconciliation.
4. Header → **Riwayat** → pick a date range → expand an order → **Refund**.
5. Offline test: open DevTools → Network → Offline. Make a sale. It should
   succeed and show "menunggu sinkronisasi". Go back Online → it flushes.
6. Backoffice (5174): products, customers, dashboard, gold theme.

If all six pass, the dev build is correct.

### A5. Test on a real Android phone

The phone cannot use `localhost` — it must reach your PC over Wi‑Fi.

1. **Phone and PC on the same Wi‑Fi.** PC IP here: `192.168.1.14`.
2. **Open the firewall once** (admin PowerShell):
   ```powershell
   New-NetFirewallRule -DisplayName "Mandalika POS 8080" -Direction Inbound -Protocol TCP -LocalPort 8080 -Action Allow
   ```
3. **Backend must be restarted** after the CORS change (it now allows the
   native app origin `https://localhost`).
4. **Build the app pointed at your PC's IP:**
   ```bash
   VITE_API_URL="http://192.168.1.14:8080" corepack pnpm --filter @mandalika/pos build
   corepack pnpm --filter @mandalika/pos exec cap sync android
   cd apps/pos/android && ./gradlew assembleDebug
   ```
   APK lands at
   `apps/pos/android/app/build/outputs/apk/debug/app-debug.apk`.
5. **Install it.** USB cable + USB debugging on the phone, then:
   ```bash
   "C:\Users\MyBook Hype AMD\AppData\Local\Android\Sdk\platform-tools\adb.exe" install -r "...\app-debug.apk"
   ```
   Or copy the APK to the phone and tap it ("install from unknown sources").
6. Phone-browser sanity check first: open `http://192.168.1.14:8080/healthz`.
   If that loads, the app will too. If it hangs → firewall or Wi‑Fi client
   isolation.
7. Open the app, log in, repeat the A4 smoke tests. Bluetooth receipt
   printing only works on a real device with the I-Ware C5813 printer.

**The API URL is baked in at build time.** PC IP changes → rebuild (step 4).

---

## PART B — The production goal (run this with `/goal`)

Paste the block below into Claude Code as a `/goal`. It is written so an agent
can run autonomously to ship.

```
/goal Mandalika POS is live in production: HTTPS domain, managed database with backups, real secrets, monitoring, and a documented deploy — a real cashier can take real sales on a phone over the internet.

— CONTEXT —
· Project: Mandalika POS — offline-first cashier (Capacitor Android) + backoffice admin SPA, server-authoritative Go API, Postgres, Redis.
· Stack: Go (chi) backend, React + Vite + Tailwind v4 frontends, Capacitor 8 Android, PostgreSQL 16, Redis 7, pnpm monorepo.
· Current state: feature-complete in dev. Runs locally (Postgres/Redis in Docker, backend on :8080, POS :5173, backoffice :5174). Android debug APK builds and runs over LAN. Migrations 0001–0003. Backend CI exists (.github/workflows/backend.yml).
· Working dir: C:\Users\MyBook Hype AMD\Downloads\mandalika-pos
· Constraints: small business; low budget; single region acceptable; must keep offline selling working; do not break the sync contract; no customer data in git.
· Audience: non-technical cashiers on Android; one or two admins on the backoffice.

— SUCCESS CRITERIA (ALL MUST BE TRUE) —
1. Backend reachable at a real HTTPS domain with a valid certificate; CORS restricted to the real frontend + native origins only (no localhost in prod config).
2. Managed/persistent Postgres with automated daily backups and a tested restore; no data lives only in an ephemeral Docker volume.
3. All secrets (JWT access/refresh, DB URL, admin bootstrap, Cloudinary) come from the host's secret store, not committed files; dev secrets rotated/replaced.
4. Backoffice deployed as static hosting behind a CDN; POS release APK signed, pointed at the prod API, with allowMixedContent=false.
5. Health check, structured request logging, error tracking, and basic API rate limiting are live; a runbook documents deploy, rollback, and DB restore.
6. Final deliverable runs without errors and is provable: a screenshot of a real sale from the phone over the internet, plus the deploy/runbook docs.

— OPERATING RULES — NON-NEGOTIABLE —
1. PLAN FIRST. Output a numbered task list before writing code.
2. WORK AUTONOMOUSLY. Don't ask clarifying Qs unless genuinely blocked (e.g. which host/domain — then note options and pick a sensible default).
3. SELF-VERIFY. After every step: build, run, hit the endpoint, confirm.
4. DEBUG YOURSELF. If it fails, diagnose + fix. Don't hand back.
5. USE EVERY TOOL. Terminal, web, code exec, real builds, real deploys.
6. NO PLACEHOLDERS. No stub secrets, no TODO infra — real working config.
7. PROGRESS LOG. Track completed / in-flight / decisions / blockers.
8. STAY ON GOAL. Off-spec discoveries → note and keep moving.
9. IF BLOCKED. Document the wall, continue everything parallelizable.
10. CHECK SUCCESS BEFORE STOPPING. Re-read all 6 criteria; confirm each.

— QUALITY BAR —
· Code: clean, typed, matches existing conventions (Go: gofmt; TS: tsc clean).
· Security: no secret in git; CORS locked; HTTPS only; rate limited; gosec clean.
· Output: a cashier could use it unaided; admin docs exist.
· Docs: every new env var, deploy step, and decision logged in the repo.

— FINAL DELIVERABLE —
✅ Each of the 6 criteria confirmed
📁 Every file created/modified listed
▶ How to deploy / roll back / restore the DB
📊 Proof: screenshot of a real sale over the internet + URLs
📝 Decisions + known limitations

Begin by outputting your plan. Then execute end-to-end without checking in until done or genuinely blocked.
```

---

## PART C — Full-Stack Production Reality (every layer)

Where this project actually stands, layer by layer. ✅ = done, ⚠️ = dev-only /
needs work, ❌ = missing.

| Layer | Status | Reality + what to do before shipping |
|---|---|---|
| **Frontend** | ✅ / ⚠️ | POS + backoffice build and work; gold theme. ⚠️ POS API URL is baked at build time — set `VITE_API_URL` to the prod HTTPS API and rebuild. Revert `apps/pos/capacitor.config.ts` `allowMixedContent` to **false** for release. Sign the release APK (keystore) instead of debug. |
| **APIs & Backend Logic** | ✅ | Go API, server-authoritative orders, idempotent sync, refund/shift/cashflow. Build a release binary (`go build`) or container; run with `ENV=production`. |
| **Database & Storage** | ⚠️ | Postgres works but runs in a **local Docker volume — not durable**. Move to a managed Postgres (or a properly backed-up server). Migrations 0001–0003 auto-apply on boot. Image uploads need Cloudinary keys (currently blank → uploads disabled). |
| **Auth & Permissions** | ⚠️ | JWT access/refresh + RBAC roles + outlet scoping work. ⚠️ JWT secrets and the admin password currently live in `backend/.env` (dev values). Generate fresh strong secrets, store in the host secret manager, rotate the admin password. Migrated/old users have no password by design — re-invite staff. |
| **Hosting & Deployment** | ❌ | Nothing is deployed. Pick a host (Fly.io / Render / a VPS). Backend behind a reverse proxy with TLS. Backoffice as static hosting. Write a one-page deploy runbook. |
| **Cloud & Compute** | ❌ | No cloud yet. Decide: container (Dockerfile for the Go app) vs. managed runtime. Redis: a managed instance or a co-located container with persistence. |
| **CI/CD & Version Control** | ⚠️ | `.github/workflows/backend.yml` exists (backend only). Add: frontend typecheck/build, Android build, and a deploy step (or at least a tagged-release pipeline). Branch is `phase-b-read-apis` with uncommitted work — commit + open a PR. |
| **Security & RLS** | ⚠️ | Outlet isolation is enforced in application SQL (every query is outlet-scoped), **not** Postgres Row-Level Security — acceptable but document it. Before ship: lock `CORS_ORIGINS` to the real domains only (remove the localhost entries added for dev), HTTPS only, run `gosec ./...`, ensure no secrets in git (`export.json`/dump script already deleted; keep it that way). |
| **Rate Limiting** | ❌ | No rate limiting middleware. Add per-IP throttling (e.g. `chi`'s `httprate`) on auth and write endpoints to stop brute force / abuse. |
| **Caching & CDN** | ⚠️ | Redis caching is wired server-side. Frontend assets should be served via a CDN (static host). POS already caches its snapshot locally for offline. |
| **Load Balancing & Scaling** | ❌ | Single backend instance. For one or few outlets this is fine; document the ceiling. If scaling: make the backend stateless (it mostly is), put it behind a load balancer, ensure Redis/Postgres are shared managed services. |
| **Error Tracking & Logs** | ⚠️ | `chi` Recoverer + RealIP only; logs go to stdout. Add structured request logging and an error tracker (e.g. Sentry) so a failed sale in the field is visible. |
| **Availability & Recovery** | ❌ | No backups, no restore drill, no restart policy. Before ship: automated daily DB backup, a **tested** restore, `/healthz` wired to the host's health check, auto-restart on crash. |

---

## PART D — Pre-ship blocking checklist (do not skip)

These are the must-fix items. Everything else in Part C can follow.

- [ ] Real HTTPS domain for the API; valid TLS certificate.
- [ ] `CORS_ORIGINS` set to the real frontend + native origins **only**
      (delete the `localhost`/`http://localhost` dev entries).
- [ ] `apps/pos/capacitor.config.ts` → `allowMixedContent: false`; POS rebuilt
      against the HTTPS prod URL; **release APK signed** (not debug).
- [ ] Fresh strong `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET`; new admin
      password — all from a secret manager, not `.env` in the repo tree.
- [ ] Managed/persistent Postgres; automated daily backup; **restore tested
      once**.
- [ ] Rate limiting on auth + write endpoints.
- [ ] Error tracking + structured logs shipping somewhere you can read them.
- [ ] `/healthz` connected to the host's health monitor; auto-restart on crash.
- [ ] Cloudinary keys set if product images are needed (else uploads stay off).
- [ ] Loyalty: `loyalty_settings.enabled` + `redemption_rate` configured in
      Backoffice (sample seed ships it disabled).
- [ ] Work committed off `phase-b-read-apis` via PR; CI green.
- [ ] Staff briefed: old accounts have no password — they get re-invited.

When every box in Part D is checked, you are production-ready.
