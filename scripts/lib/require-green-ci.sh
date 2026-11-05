# Sourced helper (no side effects at source time): refuse to release anything that is
# not a clean, pushed commit whose four CI gates all passed on that exact SHA (A34).
# Usage: source scripts/lib/require-green-ci.sh && require_green_ci || exit 1
# On success exports RELEASE_SHA. There is deliberately no bypass flag.

REQUIRED_CI_WORKFLOWS="quality.yml backend.yml postgres.yml browser.yml"

# --- seams (stubbed by require-green-ci.test.sh) --------------------------
_rgc_tree_clean() { git diff --quiet && git diff --cached --quiet; }  # tracked files only
_rgc_head_sha() { git rev-parse HEAD; }
_rgc_branch() { git rev-parse --abbrev-ref HEAD; }  # display only ("HEAD" when detached)
_rgc_fetch() { git fetch --quiet origin; }
# Pushed = contained in at least one remote-tracking branch (works for detached HEAD / older commits).
_rgc_in_remote() { [ -n "$(git branch -r --contains "$1" 2>/dev/null)" ]; }
_rgc_have_gh() { command -v gh >/dev/null 2>&1; }
# Prints "<status>|<conclusion>|<url>" for the latest PUSH-event run of workflow file $1 on
# commit $2 (PR runs must not mask push runs); nothing when there is no run.
_rgc_run_state() {
  gh run list --commit "$2" --workflow "$1" --event push --limit 1 \
    --json status,conclusion,url --jq '.[] | "\(.status)|\(if (.conclusion // "") == "" then "none" else .conclusion end)|\(.url)"'
}

# Require all four gates green on $1. Prints a refusal and returns 1 otherwise.
_rgc_gates_green() {
  local sha="$1" wf state status conclusion url
  for wf in $REQUIRED_CI_WORKFLOWS; do
    if ! state=$(_rgc_run_state "$wf" "$sha"); then
      echo "release refused: could not query CI for $wf on ${sha:0:7}" >&2
      return 1
    fi
    if [ -z "$state" ]; then
      echo "release refused: no $wf push run for ${sha:0:7} yet (CI not started or the sha was never pushed to prod-hardening or a gate/<name> branch, the only branches that start push runs; push it to gate/<name>, then retry when it is done)" >&2
      return 1
    fi
    IFS='|' read -r status conclusion url <<<"$state"
    if [ "$status" != completed ] || [ "$conclusion" != success ]; then
      echo "release refused: $wf on ${sha:0:7} is status=$status conclusion=${conclusion:-none} $url (retry when CI is green)" >&2
      return 1
    fi
  done
}

require_green_ci() {
  local sha branch
  unset RELEASE_SHA

  if ! _rgc_tree_clean; then
    echo "release refused: tracked files have uncommitted changes (commit or stash first)" >&2
    return 1
  fi
  sha=$(_rgc_head_sha) || { echo "release refused: cannot read HEAD" >&2; return 1; }
  branch=$(_rgc_branch) || branch=HEAD
  if ! _rgc_fetch; then
    echo "release refused: could not fetch origin" >&2
    return 1
  fi
  if ! _rgc_in_remote "$sha"; then
    echo "release refused: HEAD ${sha:0:7} is not on any origin branch (push it and wait for CI)" >&2
    return 1
  fi
  if ! _rgc_have_gh; then
    echo "release refused: the GitHub CLI (gh) is required to verify CI" >&2
    return 1
  fi
  _rgc_gates_green "$sha" || return 1

  RELEASE_SHA="$sha"
  export RELEASE_SHA
  echo "CI green on ${sha:0:7} ($branch): quality, backend, postgres, browser"
}

# Same four gates for an explicit commit (e.g. the sha a deployed revision is labelled with);
# no clean-tree/branch requirement. Does not set RELEASE_SHA.
require_green_ci_for_sha() {
  local sha="${1:-}"
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "release refused: '$sha' is not a 40-char lowercase commit sha" >&2; return 1; }
  _rgc_have_gh || { echo "release refused: the GitHub CLI (gh) is required to verify CI" >&2; return 1; }
  _rgc_gates_green "$sha" || return 1
  echo "CI green on ${sha:0:7}: quality, backend, postgres, browser"
}
