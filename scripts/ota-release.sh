#!/usr/bin/env bash
# Build the POS web bundle, Capgo-zip it, upload to GCS, register via /ota/publish.
#
# Usage: make ota-release VERSION=1.0.1
#        (or: VERSION=1.0.1 bash scripts/ota-release.sh)
#
# Secrets are injected from GCP Secret Manager and are NEVER echoed: the admin
# password is passed to curl via stdin (never argv), and the bearer token only
# ever lives in a shell variable / request header. Nothing sensitive is printed.
#
# Each bundle targets exactly ONE APK build (native versionCode): /ota/check only
# offers it to devices on that build (min-version guard, backend mig 0049).
#
# Gate: refuses unless HEAD is a clean, pushed commit whose four CI gates passed; the
# release is bound to that commit (commitSha). OTA_RELEASE_TYPE=test (default) |
# production (production also runs scripts/ci/release_debug_gate_cli.mjs).
#
# Optional overrides: OTA_API_URL, OTA_ADMIN_EMAIL, NATIVE_VERSION_CODE, OTA_RELEASE_TYPE.
set -euo pipefail

# --- Inputs & validation -------------------------------------------------
VERSION="${VERSION:?set VERSION=x.y.z}"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  echo "VERSION must be semver x.y.z (got '$VERSION')" >&2
  exit 1
}

BASE="${OTA_API_URL:-https://mandalika-pos-538849926142.asia-southeast2.run.app}"
BUCKET="gs://mandalika-pos-ota"
APP_ID="com.mandalika.pos"                        # matches apps/pos/capacitor.config.ts
ADMIN_EMAIL="${OTA_ADMIN_EMAIL:-admin@mandalika.test}"
REPO_ROOT="$(git rev-parse --show-toplevel)"
ROOT="$REPO_ROOT"
cd "$ROOT"

# --- Release gate (A34): clean, pushed commit with all four CI gates green ---
# shellcheck source=lib/require-green-ci.sh
source "$REPO_ROOT/scripts/lib/require-green-ci.sh"
require_green_ci || exit 1

# Build from a clean checkout of exactly the tested commit, never the working tree.
WT="$(mktemp -d)"
cleanup() { cd "$REPO_ROOT" && { git worktree remove --force "$WT" >/dev/null 2>&1 || rm -rf "$WT"; git worktree prune; }; }
trap cleanup EXIT
git worktree add --detach "$WT" "$RELEASE_SHA" 2>/dev/null || { echo "could not create worktree for ${RELEASE_SHA:0:7}" >&2; exit 1; }
ROOT="$WT"
cd "$ROOT"
echo "building from a clean checkout of ${RELEASE_SHA:0:7}"
corepack pnpm install --frozen-lockfile

OTA_RELEASE_TYPE="${OTA_RELEASE_TYPE:-test}"
case "$OTA_RELEASE_TYPE" in
  test) echo "OTA release type: test (debug settings allowed)" ;;
  production)
    # The web bundle carries SyncProvider's debug flag; refuse a production bundle that enables it.
    node "$ROOT/scripts/ci/release_debug_gate_cli.mjs" || {
      echo "production OTA refused: debug gate failed" >&2
      exit 1
    }
    echo "OTA release type: production (debug gate passed)"
    ;;
  *) echo "OTA_RELEASE_TYPE must be test or production (got '$OTA_RELEASE_TYPE')" >&2; exit 1 ;;
esac

# When overriding NATIVE_VERSION_CODE, build from the commit that matches the target APK.
NATIVE_CODE="${NATIVE_VERSION_CODE:-$(sed -n 's/^[[:space:]]*versionCode[[:space:]]\+\([0-9]\+\).*/\1/p' apps/pos/android/app/build.gradle | head -1)}"
[[ "$NATIVE_CODE" =~ ^[1-9][0-9]*$ ]] || {
  echo "could not determine the APK versionCode (got '$NATIVE_CODE'); set NATIVE_VERSION_CODE=<n>" >&2
  exit 1
}
echo "targets APK versionCode $NATIVE_CODE (apps/pos/android/app/build.gradle; override with NATIVE_VERSION_CODE)"

# Parse a value out of a JSON blob on stdin, tolerating leading/trailing noise
# (the Capgo CLI prints progress lines before its JSON object). Prints an empty
# line on any parse error so callers can guard leniently.
json_get() {
  python -c "
import sys, json
s = sys.stdin.read()
try:
    d = json.loads(s[s.index('{'):s.rindex('}') + 1])
    v = d
    for k in '$1'.split('.'):
        v = v[k] if isinstance(v, dict) else ''
    print(v if v is not None else '')
except Exception:
    print('')
"
}

# --- 1. Refuse re-publishing the current version -------------------------
# /ota/check echoes the latest published version in .version (bare JSON). A
# sentinel version_name that can never match forces the "download" branch,
# whose body carries the latest .version. No release yet => empty => proceed.
CUR=$(curl -sS -X POST "$BASE/api/v1/ota/check" \
  -H 'Content-Type: application/json' \
  -d '{"platform":"android","version_name":"__none__","version_code":"'"$NATIVE_CODE"'"}' | json_get version) || true
if [ "$CUR" = "$VERSION" ]; then
  echo "version $VERSION is already the current published release; nothing to do" >&2
  exit 1
fi

# --- 2. Build the POS web bundle against the prod API --------------------
VITE_API_URL="$BASE" corepack pnpm --filter @mandalika/pos build

# --- 3. Capgo-format zip (checksum + zip file) ---------------------------
# `bundle zip --json` prints progress lines then a JSON object with keys
# {bundle, filename, checksum} (NO size, NO path). The zip is written into the
# current directory (== repo root here) as <filename>; size is derived from it.
ZIP_NAME="pos-$VERSION.zip"
ZIPJSON=$(npx @capgo/cli bundle zip "$APP_ID" \
  --path apps/pos/dist --bundle "$VERSION" --name "$ZIP_NAME" --json)
CHECKSUM=$(printf '%s' "$ZIPJSON" | json_get checksum)
ZIP="$ROOT/$(printf '%s' "$ZIPJSON" | json_get filename)"
[ -n "$CHECKSUM" ] || { echo "capgo zip: no checksum in --json output" >&2; exit 1; }
[ -f "$ZIP" ] || { echo "capgo zip not found at '$ZIP' — check the CLI --json output keys" >&2; exit 1; }
SIZE=$(wc -c < "$ZIP" | tr -d '[:space:]')

# --- 4. Upload to the public bucket --------------------------------------
DEST="$BUCKET/pos/android/$VERSION.zip"
gcloud storage cp "$ZIP" "$DEST"
URL="https://storage.googleapis.com/mandalika-pos-ota/pos/android/$VERSION.zip"

# --- 5. Register the release (authed manage_settings) --------------------
# Password never touches argv: piped to curl via stdin, JSON-escaped by python
# (env-passed, not argv). Token stays in a variable; neither is printed.
PW="$(gcloud secrets versions access latest --secret=SEED_ADMIN_PASSWORD)"
LOGIN=$(OTA_AE="$ADMIN_EMAIL" OTA_PW="$PW" python -c \
  "import json,os;print(json.dumps({'email':os.environ['OTA_AE'],'password':os.environ['OTA_PW']}))" \
  | curl -sS -X POST "$BASE/api/v1/auth/login" -H 'Content-Type: application/json' --data @-) || true
unset PW
TOK=$(printf '%s' "$LOGIN" | json_get data.access)
[ -n "$TOK" ] || { echo "login failed (no access token returned)" >&2; exit 1; }

RESP=$(curl -sS -X POST "$BASE/api/v1/ota/publish" \
  -H "Authorization: Bearer $TOK" \
  -H 'Content-Type: application/json' \
  -d "{\"platform\":\"android\",\"version\":\"$VERSION\",\"url\":\"$URL\",\"checksum\":\"$CHECKSUM\",\"size\":$SIZE,\"nativeVersionCode\":$NATIVE_CODE,\"commitSha\":\"$RELEASE_SHA\"}") || true
ID=$(printf '%s' "$RESP" | json_get id)
[ -n "$ID" ] || { echo "publish failed: $RESP" >&2; exit 1; }

echo "OTA $VERSION published (id=$ID, size=${SIZE}B) -> $URL"
