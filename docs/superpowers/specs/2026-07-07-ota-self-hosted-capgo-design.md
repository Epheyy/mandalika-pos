# OTA Slice — Self-Hosted Capgo Live Updates (Design)

**Date:** 2026-07-07
**Branch:** `prod-hardening`
**Status:** Design approved — build
**Slice:** ship POS **web-layer** updates to the tablet fleet without a per-tablet APK reinstall, via self-hosted `@capgo/capacitor-updater`. One bootstrap APK adds the plugin; thereafter web changes go over-the-air.

---

## Context
The POS is a Capacitor 8 app (`@capacitor/core 8.3.4`, `webDir: 'dist'`, no `server.url` — the built web bundle is served locally from the app). Today every web change (bug fix, promo UI, etc.) requires a full signed APK rebuild + manual reinstall on each tablet (the recurring pain the user wants gone). `@capgo/capacitor-updater@8.50.2` (peer `@capacitor/core ^8.0.0` ✓) lets the app download a new web bundle at runtime and swap it on next launch. The user chose **self-hosted** (free) over Capgo Cloud. CI has **no cloud credentials** (backend.yml is test-only; backoffice deploys via Cloudflare Pages dashboard git-integration; the APK builds via `android-release.yml` workflow_dispatch). The repo is **private** (so GitHub Release assets — auth-gated — can't host bundles). The stack is GCP-native (Cloud Run + Neon + GCS), and the agent has `gcloud` + deploy authorization.

## Capgo self-hosted contract (from the official docs — the spec is built on this)
- The plugin does a **POST** to `updateUrl` on every app open, body `AppInfos` = `{platform, device_id, app_id, custom_id, plugin_version, version_build, version_code, version_name, version_os, is_emulator, is_prod}`. Only `platform` + `version_name` matter to us (`version_name` = the currently-running bundle version, or `"builtin"` for the baked-in APK bundle).
- The server responds JSON: **update** → `{version, url, checksum}` (`version` semver, `url` HTTPS zip, `checksum` sha256); **no update** → include a `message` key and omit `url` (the plugin no-ops). In auto-update mode the plugin downloads when `url` is present.
- **HTTPS only** (Android security policy — the prod API is HTTPS ✓).
- **Bundle zips MUST be created with the Capgo CLI** (`npx @capgo/cli bundle zip --path apps/pos/dist --json`) — standard zip utilities produce incompatible archives. The CLI emits `{version, checksum, size}`. Zip must have `index.html` at root (or a single root folder containing it).
- `CapacitorUpdater.notifyAppReady()` must be called on boot, or the plugin auto-rolls-back to the previous good bundle after a timeout (the crash-safety net).

## Decisions (locked during brainstorm)
1. **Bundle host = a public GCS bucket** (`mandalika-pos-ota`, public-read + CORS GET). GCP-native, free tier, agent has gcloud. (GitHub Releases ruled out — private repo; Cloudflare R2 ruled out — parallel stack + no CI creds.)
2. **Update-check endpoint = the Go backend** (`POST /api/v1/ota/check`, **public** — the plugin sends no auth; the response only exposes the already-public bundle URL). Same Cloud Run origin the APK already targets via `VITE_API_URL`.
3. **Publishing = a local script** (`make ota-release VERSION=x.y.z`) the agent/user runs — no CI secrets. A CI workflow is a later add.
4. **Explicit semver** per release (`VERSION=x.y.z`); the script validates semver + that it differs from the current published version.
5. **Apply on next cold start, silently** (`autoUpdate: true`) — never mid-sale. `notifyAppReady()` for rollback.
6. **Single channel** (all tablets get `latest`). Per-outlet/staged deferred.
7. **Android only** (the fleet is Android). iOS deferred.
8. The two endpoints are **hand-wired** (like `/readyz`) — NOT added to `openapi.yaml`/codegen, because neither is consumed by the typed `@mandalika/api` TS client (consumers are the Capgo native plugin + a curl script). `make gen-check` stays untouched.

---

## 1. Backend — migration `0044_ota_releases.sql`
```sql
CREATE TABLE ota_releases (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform   text NOT NULL,
  version    text NOT NULL,
  url        text NOT NULL,
  checksum   text NOT NULL,
  size       bigint NOT NULL DEFAULT 0,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_ota_releases_platform_created ON ota_releases (platform, created_at DESC);
```
The **latest row per platform (by `created_at`) is the current release**. Rollback = publish a new row carrying an older bundle's version/url/checksum. No unique constraint (a rollback re-uses an old version string, and the plugin's own version-compare handles skips).

## 2. Backend — the pure decision function (unit-tested)
`func DecideOtaResponse(latest *OtaRelease, reqVersionName string) OtaCheckResponse` in `internal/service` (or a small `internal/ota` pkg):
- `latest == nil` → `{Message: "no release"}` (no version/url).
- `reqVersionName == latest.Version` → `{Version: latest.Version, Message: "up-to-date"}` (no url).
- else → `{Version, URL, Checksum: latest.*}` (triggers download).
`OtaCheckResponse` marshals with `omitempty` on `url`/`checksum`/`message` so the shape matches Capgo exactly.

## 3. Backend — handlers + routes (hand-wired, `server.go`)
- `POST /api/v1/ota/check` — **PUBLIC group** (alongside `/auth/login`, outside the auth middleware). Leniently decode the Capgo `AppInfos` body (only read `platform` default `"android"`, `version_name`), call `read.LatestOtaRelease(ctx, platform)` → `DecideOtaResponse` → `writeJSON` the **bare** object (NOT the `{data}` envelope — Capgo expects the raw JSON).
- `POST /api/v1/ota/publish` — **authed `manage_settings`**. Decode `{platform, version, url, checksum, size}`, `write.PublishOtaRelease(...)` (INSERT, `created_by` = the token user), return `{id}`.
- Read repo `LatestOtaRelease(ctx, platform) (*OtaRelease, error)` (ORDER BY created_at DESC LIMIT 1; `pgx.ErrNoRows` → nil,nil). Write repo `PublishOtaRelease(ctx, in) (string, error)`.

## 4. Bundle host — GCS bucket (one-time setup, agent runs)
`gs://mandalika-pos-ota`, region `asia-southeast2`, uniform public-read (`allUsers:objectViewer`), CORS `[{origin:["*"], method:["GET"], responseHeader:["*"], maxAgeSeconds:3600}]`. Zips at `pos/android/<version>.zip` → `https://storage.googleapis.com/mandalika-pos-ota/pos/android/<version>.zip`. Documented as a prerequisite step; the release script asserts the bucket exists.

## 5. Release script — `scripts/ota-release.sh` + `make ota-release VERSION=x.y.z`
1. Validate `VERSION` is semver; fetch current published version (`curl POST /ota/check` with `version_name:"__none__"` → read `.version`); refuse if equal.
2. Build: `corepack pnpm --filter @mandalika/pos build` (with the prod `VITE_API_URL`).
3. Zip: `npx @capgo/cli bundle zip --path apps/pos/dist --json` → capture `checksum` + `size`.
4. Upload: `gcloud storage cp <zip> gs://mandalika-pos-ota/pos/android/<VERSION>.zip`.
5. Register: login (admin email + `SEED_ADMIN_PASSWORD` secret) → `curl POST /api/v1/ota/publish` with `{platform:"android", version, url, checksum, size}` (bearer). Never echo secrets.
6. Print the published version + URL. Idempotency: re-running the same VERSION is refused at step 1.

## 6. Client (POS) — the bootstrap APK
- `corepack pnpm --filter @mandalika/pos add @capgo/capacitor-updater@^8` (+ lockfile).
- `apps/pos/capacitor.config.ts`: add
  ```ts
  plugins: {
    CapacitorUpdater: {
      updateUrl: `${process.env.VITE_API_URL ?? 'https://mandalika-pos-538849926142.asia-southeast2.run.app'}/api/v1/ota/check`,
      autoUpdate: true,
    },
    // ...existing SplashScreen / BLE config unchanged
  }
  ```
  (The config is TS and runs in Node at `cap sync` time, so it reads the same build-time `VITE_API_URL` the APK workflow injects.)
- **`notifyAppReady()`**: after the app has rendered and `SyncProvider` is ready, call `CapacitorUpdater.notifyAppReady()` once, guarded by `Capacitor.isNativePlatform()` (no-op/absent on web). Place it where the splash is hidden (the app already hides the splash "once SyncProvider is ready" — same spot).
- `cap sync android` + the existing `android-release.yml` → **one signed bootstrap APK**. This APK is the last mandatory reinstall for web-layer changes.

## 7. Testing & verification
- **Go unit test** (`DecideOtaResponse`, table): nil latest → message/no-url; equal version → message/no-url; different version (incl. `"builtin"`) → url+checksum present.
- **Live authed smoke** (Neon, per [[neon-e2e-verification]] — deploy mig 0044 first): `POST /ota/publish` a dummy release → `POST /ota/check` with `version_name:"builtin"` → 200 `{version,url,checksum}`; `POST /ota/check` with `version_name:<that version>` → 200 no-url + message; clean up the row. (Throwaway `cmd/otae2e` or curl-based; zero-residue.)
- **Bundle-format check:** the release script uses the Capgo CLI (not `zip`); verify the produced zip has `index.html` at root.
- **On-device (USER-PENDING, the real proof):** build+install the bootstrap APK → `make ota-release VERSION=1.0.1` → reopen the app on the tablet → it downloads + applies the new bundle on next cold start (verify a visible change lands without a reinstall); a deliberately-broken bundle auto-rolls-back.
- Local gate: go build+vet+test+gen-check; POS tsc+vite (the plugin's web shim must not break the build).

## 8. Model routing & rollout
Sonnet implements; **Opus** reviews the backend endpoints/decision-fn + the release script (auth/secret handling) + the capacitor.config/notifyAppReady wiring. Deploy backend (mig 0044) + build the bootstrap APK. GCS bucket = one-time agent setup.

## Out of scope / deferred
- Backoffice OTA-releases view (release is a script; visibility can come later).
- Per-outlet / staged channels; iOS OTA; CI-automated release (needs GCP creds in GitHub).
- Delta/differential bundles, forced/immediate apply, in-app "update now" prompt.
