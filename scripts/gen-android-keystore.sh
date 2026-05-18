#!/usr/bin/env bash
# Generate the Android release signing keystore (one-time, keep OFF git).
# Store the .jks + passwords in the secret manager / CI secrets. Losing this
# keystore means you can never ship an update to the same app listing.
#
#   ./scripts/gen-android-keystore.sh
set -euo pipefail

OUT="${1:-mandalika-release.jks}"
ALIAS="mandalika"
[ -f "$OUT" ] && { echo "$OUT exists — refusing to overwrite" >&2; exit 1; }

read -r -s -p "Keystore password: " KS_PW; echo
read -r -s -p "Key password: " KEY_PW; echo

keytool -genkeypair -v \
  -keystore "$OUT" -alias "$ALIAS" \
  -keyalg RSA -keysize 4096 -validity 10000 \
  -storepass "$KS_PW" -keypass "$KEY_PW" \
  -dname "CN=Mandalika POS, O=Mandalika, C=ID"

cat <<EOF

Keystore written: $OUT  (alias: $ALIAS)

Set these as CI / local secrets for the signed release build:
  ANDROID_KEYSTORE_FILE=$OUT
  ANDROID_KEYSTORE_PASSWORD=<the keystore password>
  ANDROID_KEY_ALIAS=$ALIAS
  ANDROID_KEY_PASSWORD=<the key password>

Back this file up securely. It is NOT in git (see .gitignore).
EOF
