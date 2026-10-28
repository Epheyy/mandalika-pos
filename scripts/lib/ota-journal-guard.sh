#!/usr/bin/env bash
# A35: refuse an OTA release that could break journal rollback-compatibility (RUNBOOK
# "Journal rollback-compatibility rule"). Sourced by scripts/ota-release.sh.
#
# ota_journal_guard <release_sha>   (reads APK_BUILD_SHA, NATIVE_VERSION_CODE, OTA_JOURNAL_CHANGE_ACK)
#   - base = APK_BUILD_SHA, default = the last commit that changed versionCode in build.gradle.
#     That default is only right for the CURRENT apk: with NATIVE_VERSION_CODE set, APK_BUILD_SHA
#     is required. The default is also weaker than the real rule (the exact APK build commit lives
#     in the APK manifest, not the repo); pass APK_BUILD_SHA from the manifest when you can.
#   - refuses unless base is an ancestor of the release commit. NOTE: with the default base this
#     always passes (the base is found from the release history); the check only bites when
#     APK_BUILD_SHA is supplied, e.g. from the APK manifest;
#   - refuses if build.gradle's versionCode at base differs from the one being targeted
#     (NATIVE_VERSION_CODE, else the release commit's own versionCode);
#   - refuses if journal-adjacent files changed since base, unless OTA_JOURNAL_CHANGE_ACK=1. Once
#     such a change exists since the APK base, EVERY later OTA on that versionCode needs the ack
#     again (ack fatigue is accepted: the file list is re-printed each time);
#   - fails closed: any git error is a refusal, never a pass.

# Files whose changes can break reading/writing the journal across an OTA rollback.
# engine.ts is deliberately NOT listed: it changes too often (ack fatigue) and the RUNBOOK rule
# text covers it. Test files are excluded (they never ship in the bundle).
OTA_JOURNAL_PATHSPECS=(
  'packages/sync/src/journal*.ts'
  'packages/sync/src/outbox.ts'
  'packages/sync/src/outboxStore.ts'   # KVOutboxStore reads/writes OUTBOX_KEY, which the builtin's classify() reads
  'packages/sync/src/storage.ts'
  'packages/sync/src/syncedRefunds.ts'
  'packages/sync/src/partialRefunds.ts'  # C4b: per-line refund memory; its stored format is read by every later bundle
  'apps/pos/src/bootStorage.ts'        # whether and in what order initJournal runs
  'apps/pos/src/terminalBinding.ts'    # reads OUTBOX_KEY raw for the release/login gate
  'apps/pos/android'
  ':(exclude)packages/sync/src/*.test.ts'
)

_ojg_default_base() {
  git log -1 --format=%H -G'^[[:space:]]*versionCode[[:space:]]' -- apps/pos/android/app/build.gradle
}
_ojg_version_code_at() {
  git show "$1:apps/pos/android/app/build.gradle" 2>/dev/null \
    | sed -n 's/^[[:space:]]*versionCode[[:space:]]\{1,\}\([0-9]\{1,\}\).*/\1/p' | head -1
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
    base="$(_ojg_default_base)" || { echo "refused: git log failed finding the APK build commit" >&2; return 1; }
    [ -n "$base" ] || { echo "could not find the APK build commit; set APK_BUILD_SHA" >&2; return 1; }
  fi
  git cat-file -e "$base^{commit}" 2>/dev/null || { echo "APK_BUILD_SHA '$base' is not a known commit" >&2; return 1; }
  if ! _ojg_is_ancestor "$base" "$release_sha"; then
    echo "refused: ${base:0:7} (APK build) is not an ancestor of ${release_sha:0:7}; build the bundle from a descendant of the APK's commit" >&2
    return 1
  fi
  local want have
  want="${NATIVE_VERSION_CODE:-$(_ojg_version_code_at "$release_sha")}"
  have="$(_ojg_version_code_at "$base")"
  if [ -z "$have" ] || [ "$have" != "$want" ]; then
    echo "refused: versionCode at APK build ${base:0:7} is '${have:-unknown}' but this release targets '${want:-unknown}'" >&2
    return 1
  fi
  local changed
  changed="$(_ojg_changed_files "$base" "$release_sha")" || { echo "refused: could not diff ${base:0:7}..${release_sha:0:7}" >&2; return 1; }
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
