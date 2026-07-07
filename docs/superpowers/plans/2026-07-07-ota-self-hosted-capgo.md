# OTA Self-Hosted Capgo Live Updates — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Ship POS web-layer updates to the Android fleet without a per-tablet APK reinstall, via self-hosted `@capgo/capacitor-updater` — bundles on a public GCS bucket, an update-check endpoint on the Go backend, published by a local script.

**Architecture:** One bootstrap APK adds the plugin. On app-open the POS POSTs to a PUBLIC `/api/v1/ota/check`; the backend returns the latest `ota_releases` row's `{version,url,checksum}` (or a no-url "up-to-date"); the plugin downloads the zip from GCS and swaps it on next cold start, with `notifyAppReady()` auto-rollback. `make ota-release VERSION=x.y.z` builds → Capgo-CLI-zips → uploads to GCS → registers via an authed endpoint.

**Tech Stack:** Go (pgx, chi), TypeScript/Capacitor 8 (`@capgo/capacitor-updater@^8`), bash + gcloud + Capgo CLI.

**Spec:** `docs/superpowers/specs/2026-07-07-ota-self-hosted-capgo-design.md`

## Global Constraints
- **Capgo self-hosted contract (exact):** plugin POSTs `AppInfos` (we read only `platform`, `version_name`); server responds **bare JSON** (NOT a `{data}` envelope) — update → `{version,url,checksum}`, no-update → `{version,message}` (omit `url`). `version` is semver. HTTPS only.
- **Bundle zips MUST be made with the Capgo CLI** (`npx @capgo/cli bundle zip --path apps/pos/dist --json`) — standard zip tools produce incompatible archives; the CLI emits `{version,checksum,size}`.
- **`/ota/check` is PUBLIC** (plugin sends no auth); **`/ota/publish` is authed `manage_settings`**.
- **Latest `ota_releases` row per platform (by `created_at`) = current.** Rollback = publish a new row for an older bundle. No unique constraint.
- **Endpoints are HAND-WIRED** (like `/readyz`) — NOT in `openapi.yaml`/codegen (not part of the typed TS client). `make gen-check` must stay clean (don't touch openapi.yaml).
- **Plugin `@capgo/capacitor-updater@^8`** (peer `@capacitor/core ^8.0.0` — the repo is on 8.3.4 ✓). Config `plugins.CapacitorUpdater.updateUrl = ${VITE_API_URL}/api/v1/ota/check`, `autoUpdate: true`. `notifyAppReady()` on boot, native-guarded.
- **⚠️ Regenerate + commit `pnpm-lock.yaml`** after adding the POS dep — a stale lockfile silently breaks the Cloudflare backoffice deploy ([[cloudflare-frozen-lockfile-gotcha]]).
- Migration **0044**. Android only, single channel. Deploy backend + one bootstrap APK.
- Model routing: decision-fn + handlers/routing + release-script (secret/auth) → **Opus**; migration/repo + client wiring → Sonnet.

## File Structure
- `backend/internal/ota/decide.go` (+ `decide_test.go`) — pure types + `Decide`.
- `backend/internal/db/migrations/0044_ota_releases.sql` — CREATE.
- `backend/internal/read/repo.go` — `LatestOtaRelease`.
- `backend/internal/write/repo.go` — `PublishOtaRelease`.
- `backend/internal/handlers/ota.go` — `OtaCheck`, `OtaPublish`.
- `backend/internal/server/server.go` — 2 routes.
- `scripts/ota-release.sh` + `Makefile` (`ota-release` target).
- `apps/pos/package.json` + `pnpm-lock.yaml` — the plugin dep.
- `apps/pos/capacitor.config.ts` — plugin config.
- `apps/pos/src/native.ts` + `apps/pos/src/cashier/SyncProvider.tsx` — `otaNotifyReady()` + its call.
- `backend/cmd/otae2e/main.go` — throwaway (Task 6).

---

## Task 1: Pure decision function + types

**Files:** Create `backend/internal/ota/decide.go`, `backend/internal/ota/decide_test.go`.

**Interfaces:**
- Produces: `type Release struct { Platform, Version, URL, Checksum string; Size int64 }` (json tags `platform/version/url/checksum/size`); `type CheckResponse struct { Version, URL, Checksum, Message string }` (all `json:",omitempty"`); `func Decide(latest *Release, reqVersionName string) CheckResponse`.

- [ ] **Step 1: Write the failing test** (`decide_test.go`)
```go
package ota

import "testing"

func TestDecide(t *testing.T) {
	rel := &Release{Platform: "android", Version: "1.2.0", URL: "https://x/1.2.0.zip", Checksum: "abc"}
	tests := []struct {
		name       string
		latest     *Release
		reqVersion string
		wantURL    string // "" means no-url (up-to-date / no release)
		wantVer    string
	}{
		{"no release", nil, "builtin", "", ""},
		{"builtin gets update", rel, "builtin", "https://x/1.2.0.zip", "1.2.0"},
		{"older gets update", rel, "1.1.0", "https://x/1.2.0.zip", "1.2.0"},
		{"same version no update", rel, "1.2.0", "", "1.2.0"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := Decide(tt.latest, tt.reqVersion)
			if got.URL != tt.wantURL {
				t.Errorf("URL got %q want %q", got.URL, tt.wantURL)
			}
			if got.Version != tt.wantVer {
				t.Errorf("Version got %q want %q", got.Version, tt.wantVer)
			}
			if tt.wantURL != "" && got.Checksum != "abc" {
				t.Errorf("expected checksum on update")
			}
		})
	}
}
```

- [ ] **Step 2: Run — fails to compile**
Run: `cd backend && go test ./internal/ota/`
Expected: build error (undefined `Release`/`CheckResponse`/`Decide`).

- [ ] **Step 3: Implement** (`decide.go`)
```go
// Package ota implements the self-hosted Capgo update-check decision (pure,
// DB-free) and the release types shared by the read/write repos + handlers.
package ota

type Release struct {
	Platform string `json:"platform"`
	Version  string `json:"version"`
	URL      string `json:"url"`
	Checksum string `json:"checksum"`
	Size     int64  `json:"size"`
}

// CheckResponse is the BARE JSON body returned to the Capgo plugin (no {data}
// envelope). Update → {version,url,checksum}; no-update → {version,message}.
type CheckResponse struct {
	Version  string `json:"version,omitempty"`
	URL      string `json:"url,omitempty"`
	Checksum string `json:"checksum,omitempty"`
	Message  string `json:"message,omitempty"`
}

// Decide returns the Capgo response for a check. latest==nil → no release;
// req version == latest → up-to-date (no url); otherwise → download (url set).
func Decide(latest *Release, reqVersionName string) CheckResponse {
	if latest == nil {
		return CheckResponse{Message: "no release"}
	}
	if reqVersionName == latest.Version {
		return CheckResponse{Version: latest.Version, Message: "up-to-date"}
	}
	return CheckResponse{Version: latest.Version, URL: latest.URL, Checksum: latest.Checksum}
}
```

- [ ] **Step 4: Run — passes**
Run: `cd backend && go test ./internal/ota/ && go build ./...`
Expected: PASS + clean.

- [ ] **Step 5: Commit**
```bash
git add backend/internal/ota/
git commit -m "feat(ota): pure Capgo update-check decision fn + release types"
```

---

## Task 2: Migration 0044 + read/write repo

**Files:** Create `backend/internal/db/migrations/0044_ota_releases.sql`; modify `backend/internal/read/repo.go`, `backend/internal/write/repo.go`.

**Interfaces:**
- Consumes: `ota.Release` (Task 1).
- Produces: `func (r *Repo) LatestOtaRelease(ctx context.Context, platform string) (*ota.Release, error)` (read); `func (r *Repo) PublishOtaRelease(ctx context.Context, in ota.Release, createdBy string) (string, error)` (write).

- [ ] **Step 1: Migration** — `backend/internal/db/migrations/0044_ota_releases.sql`:
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

- [ ] **Step 2: Read repo** — add to `read/repo.go` (import `".../internal/ota"` if not already):
```go
func (r *Repo) LatestOtaRelease(ctx context.Context, platform string) (*ota.Release, error) {
	var rel ota.Release
	err := r.Pool.QueryRow(ctx,
		`SELECT platform, version, url, checksum, size
		   FROM ota_releases WHERE platform=$1 ORDER BY created_at DESC LIMIT 1`, platform).
		Scan(&rel.Platform, &rel.Version, &rel.URL, &rel.Checksum, &rel.Size)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &rel, nil
}
```

- [ ] **Step 3: Write repo** — add to `write/repo.go` (import `ota` + `nullUUID` already present):
```go
func (r *Repo) PublishOtaRelease(ctx context.Context, in ota.Release, createdBy string) (string, error) {
	var id string
	err := r.tx(ctx, "otaReleases", func(t pgx.Tx) error {
		return t.QueryRow(ctx,
			`INSERT INTO ota_releases (platform, version, url, checksum, size, created_by)
			 VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
			in.Platform, in.Version, in.URL, in.Checksum, in.Size, nullUUID(createdBy)).Scan(&id)
	})
	return id, err
}
```

- [ ] **Step 4: Build**
Run: `cd backend && go build ./... && go vet ./internal/read/ ./internal/write/`
Expected: clean.

- [ ] **Step 5: Commit**
```bash
git add backend/internal/db/migrations/0044_ota_releases.sql backend/internal/read/repo.go backend/internal/write/repo.go
git commit -m "feat(ota): migration 0044 ota_releases + Latest/Publish repo"
```

---

## Task 3: Handlers + routes

**Files:** Create `backend/internal/handlers/ota.go`; modify `backend/internal/server/server.go`.

**Interfaces:** Consumes `h.Repo.LatestOtaRelease`, `h.Write.PublishOtaRelease`, `ota.Decide`, `writeJSON`, `writeErr`, `decodeWrite`. Produces `(*Handlers).OtaCheck`, `(*Handlers).OtaPublish`.

- [ ] **Step 1: Handlers** (`handlers/ota.go`)
```go
package handlers

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/mandalika/pos-backend/internal/ota"
)

// OtaCheck is the PUBLIC Capgo self-hosted update endpoint. The plugin POSTs
// AppInfos; we read only platform + version_name and reply with the BARE Capgo
// JSON (no {data} envelope). Lenient decode — a malformed body defaults to
// android/empty so a bad request just yields "no update".
func (h *Handlers) OtaCheck(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Platform    string `json:"platform"`
		VersionName string `json:"version_name"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	platform := strings.ToLower(strings.TrimSpace(body.Platform))
	if platform == "" {
		platform = "android"
	}
	latest, err := h.Repo.LatestOtaRelease(r.Context(), platform)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, ota.Decide(latest, body.VersionName))
}

// OtaPublish (authed manage_settings) records a new bundle. Called by the
// ota-release script after uploading the zip to GCS.
func (h *Handlers) OtaPublish(w http.ResponseWriter, r *http.Request) {
	in, err := decodeWrite[ota.Release](r)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	if in.Platform == "" {
		in.Platform = "android"
	}
	if in.Version == "" || in.URL == "" || in.Checksum == "" {
		writeErr(w, http.StatusBadRequest, errOtaMissingFields)
		return
	}
	id, err := h.Write.PublishOtaRelease(r.Context(), in, currentUserID(r))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"id": id})
}
```
NOTE: `errOtaMissingFields` — define `var errOtaMissingFields = errors.New("version, url, and checksum are required")` at the top of the file (add `"errors"` import). `currentUserID(r)` — grep the handlers pkg for how existing authed handlers read the token user id (e.g. a claims helper / context value used for `created_by`/audit elsewhere — search `UserID`/`Claims`/`ctxUser`). Use that; if it returns a value+ok, pass the id (or "" when absent — `nullUUID("")` → NULL). Confirm `decodeWrite[T]` exists (used by the discount-code handlers) + `h.Write` is the write repo field.

- [ ] **Step 2: Routes** (`server.go`)
- In the PUBLIC group (the one with `/auth/login`, ~line 82-87, NO `RequireAuth`): add `r.Post("/ota/check", h.OtaCheck)`.
- In the `manage_settings` group (~line 251-252, `r.Use(mw.RequirePermission("manage_settings"))`): add `r.Post("/ota/publish", h.OtaPublish)`.
Confirm `h` is the `*Handlers` in scope at those sites (the same one exposing `h.Products` etc.).

- [ ] **Step 3: Build + vet**
Run: `cd backend && go build ./... && go vet ./internal/handlers/ ./internal/server/`
Expected: clean.

- [ ] **Step 4: Commit**
```bash
git add backend/internal/handlers/ota.go backend/internal/server/server.go
git commit -m "feat(ota): public /ota/check + authed /ota/publish (bare Capgo JSON)"
```

---

## Task 4: Release script + Makefile

**Files:** Create `scripts/ota-release.sh`; modify (or create) the root `Makefile`.

**Interfaces:** Produces `make ota-release VERSION=x.y.z`. Consumes `POST /api/v1/ota/check` + `POST /api/v1/ota/publish` (Task 3), the GCS bucket (Task 6 setup).

- [ ] **Step 1: Verify the Capgo CLI output shape FIRST** (so the script parses the right keys):
```bash
cd "$(git rev-parse --show-toplevel)" && npx @capgo/cli@latest bundle zip --help 2>&1 | head -40
```
Confirm the flags (`--path`, `--json`) and note where the zip is written (the CLI prints the path / a default like `.capgo/<appId>/bundle.zip`). Adjust the script's `ZIP=...` extraction to the CLI's actual `--json` keys (documented output includes `version`/`checksum`/`size`; capture the zip path from the JSON or the known output location).

- [ ] **Step 2: Write `scripts/ota-release.sh`**
```bash
#!/usr/bin/env bash
# Build the POS web bundle, Capgo-zip it, upload to GCS, register via /ota/publish.
# Usage: make ota-release VERSION=1.0.1   (never commit secrets; never echo the token)
set -euo pipefail

VERSION="${VERSION:?set VERSION=x.y.z}"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "VERSION must be semver x.y.z"; exit 1; }
BASE="${OTA_API_URL:-https://mandalika-pos-538849926142.asia-southeast2.run.app}"
BUCKET="gs://mandalika-pos-ota"
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

# 1. Refuse a duplicate of the current published version.
CUR=$(curl -s -X POST "$BASE/api/v1/ota/check" -H 'Content-Type: application/json' \
  -d '{"platform":"android","version_name":"__none__"}' \
  | python -c "import sys,json;print(json.load(sys.stdin).get('version',''))")
[ "$CUR" = "$VERSION" ] && { echo "version $VERSION is already the current release"; exit 1; }

# 2. Build the POS web bundle against prod API.
VITE_API_URL="$BASE" corepack pnpm --filter @mandalika/pos build

# 3. Capgo-format zip (+ checksum/size) — MUST use the Capgo CLI.
ZIPJSON=$(npx @capgo/cli bundle zip --path apps/pos/dist --json)
CHECKSUM=$(echo "$ZIPJSON" | python -c "import sys,json;print(json.load(sys.stdin)['checksum'])")
SIZE=$(echo "$ZIPJSON" | python -c "import sys,json;print(json.load(sys.stdin).get('size',0))")
ZIP=$(echo "$ZIPJSON" | python -c "import sys,json;d=json.load(sys.stdin);print(d.get('path') or d.get('bundle') or '')")
[ -f "$ZIP" ] || { echo "capgo zip not found at '$ZIP' — check the CLI --json output keys"; exit 1; }

# 4. Upload to the public bucket.
DEST="$BUCKET/pos/android/$VERSION.zip"
gcloud storage cp "$ZIP" "$DEST"
URL="https://storage.googleapis.com/mandalika-pos-ota/pos/android/$VERSION.zip"

# 5. Register (authed). Secret injected, never printed.
PW="$(gcloud secrets versions access latest --secret=SEED_ADMIN_PASSWORD)"
TOK=$(curl -s -X POST "$BASE/api/v1/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"admin@mandalika.test\",\"password\":\"$PW\"}" \
  | python -c "import sys,json;print(json.load(sys.stdin)['data']['access'])")
[ -n "$TOK" ] || { echo "login failed"; exit 1; }
curl -s -X POST "$BASE/api/v1/ota/publish" -H "Authorization: Bearer $TOK" \
  -H 'Content-Type: application/json' \
  -d "{\"platform\":\"android\",\"version\":\"$VERSION\",\"url\":\"$URL\",\"checksum\":\"$CHECKSUM\",\"size\":$SIZE}" \
  | python -c "import sys,json;print('published id',json.load(sys.stdin).get('id'))"
echo "OTA $VERSION published -> $URL"
```
NOTE: the admin email default `admin@mandalika.test` matches the deployed `SEED_ADMIN_EMAIL` (per [[neon-e2e-verification]]). `chmod +x scripts/ota-release.sh`.

- [ ] **Step 3: Makefile target** — add to the root `Makefile` (create it if absent; if a root Makefile exists, append):
```make
.PHONY: ota-release
ota-release: ## Publish a POS OTA bundle: make ota-release VERSION=x.y.z
	@bash scripts/ota-release.sh
```

- [ ] **Step 4: Static check** (no deploy yet — the live run is Task 6)
Run: `bash -n scripts/ota-release.sh && echo "syntax ok"`
Expected: `syntax ok`. (If `shellcheck` is available, run it and fix warnings.)

- [ ] **Step 5: Commit**
```bash
git add scripts/ota-release.sh Makefile
git commit -m "feat(ota): make ota-release script (build+Capgo-zip+GCS+publish)"
```

---

## Task 5: POS client — plugin + config + notifyAppReady

**Files:** Modify `apps/pos/package.json` + `pnpm-lock.yaml`, `apps/pos/capacitor.config.ts`, `apps/pos/src/native.ts`, `apps/pos/src/cashier/SyncProvider.tsx`.

**Interfaces:** Produces `otaNotifyReady()` (native-guarded) in `native.ts`, called once from `SyncProvider` when sync is ready.

- [ ] **Step 1: Add the dependency + regenerate the lockfile**
```bash
cd "$(git rev-parse --show-toplevel)"
corepack pnpm --filter @mandalika/pos add @capgo/capacitor-updater@^8
corepack pnpm@10.11.1 install --lockfile-only   # ensure pnpm-lock.yaml is regenerated
```
Expected: `@capgo/capacitor-updater` in `apps/pos/package.json` dependencies; `pnpm-lock.yaml` updated. **⚠️ The lockfile MUST be committed** — a stale one breaks the Cloudflare backoffice deploy ([[cloudflare-frozen-lockfile-gotcha]]).

- [ ] **Step 2: capacitor.config.ts** — add the `CapacitorUpdater` block INSIDE the existing `plugins: { ... }` object (alongside `SplashScreen`/`CapacitorBluetoothLe`, do not remove them):
```ts
    CapacitorUpdater: {
      // The config runs in Node at `cap sync`, so it reads the same build-time
      // VITE_API_URL the APK workflow injects (falls back to the prod URL).
      updateUrl: `${process.env.VITE_API_URL ?? 'https://mandalika-pos-538849926142.asia-southeast2.run.app'}/api/v1/ota/check`,
      autoUpdate: true,
    },
```

- [ ] **Step 3: `otaNotifyReady()` in `native.ts`** — add (reuse the file's existing `isNativePlatform()`):
```ts
/**
 * Confirm to the Capgo updater that this bundle booted OK. If we never call
 * this, the plugin auto-rolls-back to the last good bundle after a timeout.
 * Web/no-op off-device. Dynamically imported so the web build never hard-depends
 * on the native plugin.
 */
export async function otaNotifyReady(): Promise<void> {
  if (!isNativePlatform()) return
  try {
    const { CapacitorUpdater } = await import('@capgo/capacitor-updater')
    await CapacitorUpdater.notifyAppReady()
  } catch {
    // plugin absent (e.g. older shell) — ignore
  }
}
```

- [ ] **Step 4: Call it when the app is confirmed working** — in `apps/pos/src/cashier/SyncProvider.tsx`, at the point sync is ready and the splash is hidden (~line 108, `void hideSplash()`), add right after:
```ts
        void otaNotifyReady()
```
Import it: add `otaNotifyReady` to the existing `import { hideSplash } from '../native'` → `import { hideSplash, otaNotifyReady } from '../native'`.

- [ ] **Step 5: Verify the web build isn't broken by the native plugin**
```bash
cd apps/pos && corepack pnpm tsc --noEmit && corepack pnpm vite build
```
Expected: clean (the dynamic `import()` keeps the plugin out of the eager web graph).

- [ ] **Step 6: Commit** (INCLUDE the lockfile)
```bash
git add apps/pos/package.json pnpm-lock.yaml apps/pos/capacitor.config.ts apps/pos/src/native.ts apps/pos/src/cashier/SyncProvider.tsx
git commit -m "feat(ota): add @capgo/capacitor-updater + updateUrl config + notifyAppReady"
```

---

## Task 6: Verify — GCS bucket, deploy, smoke, bootstrap APK, handoff

**Files:** Create throwaway `backend/cmd/otae2e/main.go` (never commit).

- [ ] **Step 1: Local gate**
```bash
cd backend && go build ./... && go test ./... && make gen-check
cd ../apps/pos && corepack pnpm tsc --noEmit && corepack pnpm vite build
```
All green.

- [ ] **Step 2: Create the GCS bucket** (one-time, agent runs)
```bash
gcloud storage buckets create gs://mandalika-pos-ota --project=mandalika-pos --location=asia-southeast2 --uniform-bucket-level-access
gcloud storage buckets add-iam-policy-binding gs://mandalika-pos-ota --member=allUsers --role=roles/storage.objectViewer
printf '[{"origin":["*"],"method":["GET"],"responseHeader":["*"],"maxAgeSeconds":3600}]' > /tmp/ota-cors.json
gcloud storage buckets update gs://mandalika-pos-ota --cors-file=/tmp/ota-cors.json
```
Expected: bucket exists, publicly readable. (If it already exists, skip create.)

- [ ] **Step 3: Push + deploy (migration 0044 applies on boot)**
```bash
git push origin prod-hardening
gcloud run deploy mandalika-pos --source backend --region asia-southeast2 --quiet
```
Confirm `latestReadyRevisionName` CHANGED (a stalled gcloud deploy can exit without a new revision — [[neon-e2e-verification]]) and `/readyz` 200.

- [ ] **Step 4: Throwaway repo e2e** (`cmd/otae2e`, real repo, Neon via injected `DATABASE_URL`, zero-residue). Connect via `config.Load()`→`db.Connect`→`read.New`/`write.New`. Seed a release (version `0.0.0-e2e`, url/checksum dummy). Assert: `LatestOtaRelease("android")` returns it; `ota.Decide(latest,"builtin").URL != ""`; `ota.Decide(latest,"0.0.0-e2e").URL == ""`. Cleanup (defer): `DELETE FROM ota_releases WHERE version='0.0.0-e2e'`; residue self-check. Run: `DATABASE_URL="$(gcloud secrets versions access latest --secret=DATABASE_URL --project=mandalika-pos)" go run ./cmd/otae2e`. Then `rm -rf backend/cmd/otae2e`.

- [ ] **Step 5: Authed HTTP smoke** (routing proof, per [[neon-e2e-verification]]): login admin → `POST /api/v1/ota/publish {platform:android,version:"0.0.0-smoke",url:"https://x/s.zip",checksum:"deadbeef",size:1}` → 200 `{id}`; **public** `POST /api/v1/ota/check {platform:android,version_name:"builtin"}` (NO auth header) → 200 `{version:"0.0.0-smoke",url,checksum}`; `POST /ota/check {version_name:"0.0.0-smoke"}` → 200 no `url`. Cleanup: `DATABASE_URL=... psql`-equivalent OR a one-off `go run` — `DELETE FROM ota_releases WHERE version LIKE '0.0.0-%'`; confirm zero residue.

- [ ] **Step 6: Bootstrap APK** (native plugin added → mandatory one-time rebuild):
```bash
git push origin prod-hardening   # ensure pushed
gh workflow run android-release.yml --ref prod-hardening -f api_url=https://mandalika-pos-538849926142.asia-southeast2.run.app
```
Record the run id ([[apk-builds-from-origin-gotcha]]). This APK carries the Capgo plugin — the LAST mandatory per-tablet install for web-layer changes.

- [ ] **Step 7: Handoff + memory** — update `SESSION_HANDOFF.md` + `MEMORY.md` + the [[ota-capgo-self-hosted]] memory (OTA now BUILT — endpoints/bucket/script live; USER-PENDING = install the bootstrap APK, run `make ota-release VERSION=1.0.1`, confirm a web change lands on cold-start without a reinstall). Commit + push.

---

## Notes for the implementer
- **The bare-JSON response is critical** — `writeJSON(w, 200, ota.Decide(...))` returns the object directly; do NOT wrap it in `{data}` (Capgo parses the raw body). Task 1's `CheckResponse` omitempty tags produce the exact shape.
- `/ota/check` is PUBLIC (no `RequireAuth`); `/ota/publish` is `manage_settings`. Getting the route groups wrong is the main risk (T3).
- The **Capgo CLI zip is mandatory** — a plain `zip` produces an archive the plugin rejects. Verify the CLI's `--json` output keys before finalizing the script (T4 Step 1).
- **Commit `pnpm-lock.yaml`** with the dep add or the Cloudflare backoffice deploy breaks (T5).
- On-device OTA behavior can't be unit-tested — the real proof is the USER-PENDING bootstrap-APK + `make ota-release` walkthrough.
