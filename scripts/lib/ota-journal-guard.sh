#!/usr/bin/env bash
# A35: refuse an OTA release that could break journal rollback-compatibility (RUNBOOK
# "Journal rollback-compatibility rule"). Sourced by scripts/ota-release.sh.
#
# ota_journal_guard <release_sha>   (reads APK_BUILD_SHA, NATIVE_VERSION_CODE, OTA_JOURNAL_CHANGE_ACK)
#   - base = APK_BUILD_SHA, default = the last commit that changed versionCode in build.gradle.
#     That default is only right for the CURRENT apk: with NATIVE_VERSION_CODE set, APK_BUILD_SHA
#     is required. The default is also weaker than the real rule (the exact APK build commit lives
#     in the APK manifest, not the repo); pass APK_BUILD_SHA from the manifest when you can.
#   - refuses unless base is an ancestor of the release commit;
#   - refuses if journal-adjacent files changed since base, unless OTA_JOURNAL_CHANGE_ACK=1.

# Files whose changes can break reading/writing the journal across an OTA rollback.
OTA_JOURNAL_PATHSPECS=(
  'packages/sync/src/journal*.ts'
  'packages/sync/src/outbox.ts'
  'packages/sync/src/storage.ts'
  'packages/sync/src/syncedRefunds.ts'
  'apps/pos/android'
)

_ojg_default_base() {
  git log -1 --format=%H -G'^[[:space:]]*versionCode[[:space:]]' -- apps/pos/android/app/build.gradle
}
_ojg_is_ancestor() { git merge-base --is-ancestor "$1" "$2"; }
_ojg_changed_files() { git diff --name-only "$1" "$2" -- "${OTA_JOURNAL_PATHSPECS[@]}"; }

ota_journal_guard() {
  local release_sha="$1" base="${APK_BUILD_SHA:-}"
  if [ -z "$base" ]; then
    if [ -n "${NATIVE_VERSION_CODE:-}" ]; then
      echo "NATIVE_VERSION_CODE is set: also set APK_BUILD_SHA=<commit that APK was built from> (see the APK manifest)" >&2
      return 1
    fi
    base="$(_ojg_default_base)"
    [ -n "$base" ] || { echo "could not find the APK build commit; set APK_BUILD_SHA" >&2; return 1; }
  fi
  git cat-file -e "$base^{commit}" 2>/dev/null || { echo "APK_BUILD_SHA '$base' is not a known commit" >&2; return 1; }
  if ! _ojg_is_ancestor "$base" "$release_sha"; then
    echo "refused: ${base:0:7} (APK build) is not an ancestor of ${release_sha:0:7}; build the bundle from a descendant of the APK's commit" >&2
    return 1
  fi
  local changed
  changed="$(_ojg_changed_files "$base" "$release_sha")"
  if [ -n "$changed" ]; then
    echo "journal-adjacent files changed since the APK build ${base:0:7}:" >&2
    printf '  %s\n' $changed >&2
    if [ "${OTA_JOURNAL_CHANGE_ACK:-}" != "1" ]; then
      echo "refused: these may be APK-only (RUNBOOK journal rollback rule). Review, then re-run with OTA_JOURNAL_CHANGE_ACK=1 to acknowledge." >&2
      return 1
    fi
    echo "OTA_JOURNAL_CHANGE_ACK=1: acknowledged" >&2
  fi
  echo "journal guard ok (base ${base:0:7})"
}
