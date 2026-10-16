#!/usr/bin/env bash
# Tests for ota-journal-guard.sh against a throwaway git repo. Run: bash scripts/lib/ota-journal-guard.test.sh
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=ota-journal-guard.sh
source "$HERE/ota-journal-guard.sh"
FAILS=0
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
cd "$T" && git init -q . && git config user.email t@t.test && git config user.name t
mkdir -p apps/pos/android/app packages/sync/src apps/pos/src
printf 'versionCode 12\n' > apps/pos/android/app/build.gradle
echo a > packages/sync/src/journalBoot.ts; echo a > apps/pos/src/App.tsx
git add -A && git commit -q -m apk && APK=$(git rev-parse HEAD)
echo b > apps/pos/src/App.tsx && git commit -q -a -m ui && UI=$(git rev-parse HEAD)
echo b > packages/sync/src/journalBoot.ts && git commit -q -a -m journal && JR=$(git rev-parse HEAD)
git checkout -q "$APK" && git checkout -q -b side && echo c > apps/pos/src/App.tsx && git commit -q -a -m side && SIDE=$(git rev-parse HEAD)

expect() { # name want_rc cmd...
  local name="$1" want="$2"; shift 2
  local out rc; out=$("$@" 2>&1); rc=$?
  if { [ "$want" = 0 ] && [ $rc -eq 0 ]; } || { [ "$want" = 1 ] && [ $rc -ne 0 ]; }; then echo "PASS: $name"
  else echo "FAIL: $name (rc=$rc)"; echo "$out" | sed 's/^/    /'; FAILS=$((FAILS + 1)); fi
}
unset APK_BUILD_SHA NATIVE_VERSION_CODE OTA_JOURNAL_CHANGE_ACK
expect "UI-only change since the APK passes (default base)" 0 ota_journal_guard "$UI"
expect "journal file change since the APK is refused" 1 ota_journal_guard "$JR"
OTA_JOURNAL_CHANGE_ACK=1 expect "journal change passes when acknowledged" 0 ota_journal_guard "$JR"
APK_BUILD_SHA="$JR" expect "explicit base after the journal change passes" 0 ota_journal_guard "$JR"
APK_BUILD_SHA="$UI" expect "non-ancestor base is refused" 1 ota_journal_guard "$SIDE"
NATIVE_VERSION_CODE=11 expect "NATIVE_VERSION_CODE without APK_BUILD_SHA is refused" 1 ota_journal_guard "$UI"
APK_BUILD_SHA=deadbeef expect "unknown base is refused" 1 ota_journal_guard "$UI"
echo "failures: $FAILS"; [ $FAILS -eq 0 ]
