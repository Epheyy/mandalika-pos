# Sourced helper (no side effects at source time): refuse to release anything that is
# not a clean, pushed commit whose four CI gates all passed on that exact SHA (A34).
# Usage: source scripts/lib/require-green-ci.sh && require_green_ci || exit 1
# On success exports RELEASE_SHA. There is deliberately no bypass flag.

REQUIRED_CI_WORKFLOWS="quality.yml backend.yml postgres.yml browser.yml"

# --- seams (stubbed by require-green-ci.test.sh) --------------------------
_rgc_tree_clean() { git diff --quiet && git diff --cached --quiet; }  # tracked files only
_rgc_head_sha() { git rev-parse HEAD; }
_rgc_branch() { git rev-parse --abbrev-ref HEAD; }
_rgc_fetch() { git fetch --quiet origin "$1"; }
_rgc_is_pushed() { git merge-base --is-ancestor "$1" "origin/$2"; }
_rgc_have_gh() { command -v gh >/dev/null 2>&1; }
# Prints "<status> <conclusion> <url>" for the latest run of workflow file $1 on commit $2;
# prints nothing when there is no run.
_rgc_run_state() {
  gh run list --commit "$2" --workflow "$1" --limit 1 \
    --json status,conclusion,url --jq '.[] | "\(.status) \(.conclusion) \(.url)"'
}

require_green_ci() {
  local sha branch wf state status conclusion url
  unset RELEASE_SHA

  if ! _rgc_tree_clean; then
    echo "release refused: tracked files have uncommitted changes (commit or stash first)" >&2
    return 1
  fi
  sha=$(_rgc_head_sha) || { echo "release refused: cannot read HEAD" >&2; return 1; }
  branch=$(_rgc_branch) || { echo "release refused: cannot read current branch" >&2; return 1; }
  if [ -z "$branch" ] || [ "$branch" = HEAD ]; then
    echo "release refused: detached HEAD (check out the branch that carries the tested commit)" >&2
    return 1
  fi
  if ! _rgc_fetch "$branch"; then
    echo "release refused: could not fetch origin/$branch" >&2
    return 1
  fi
  if ! _rgc_is_pushed "$sha" "$branch"; then
    echo "release refused: HEAD ${sha:0:7} is not pushed to origin/$branch (push it and wait for CI)" >&2
    return 1
  fi
  if ! _rgc_have_gh; then
    echo "release refused: the GitHub CLI (gh) is required to verify CI" >&2
    return 1
  fi

  for wf in $REQUIRED_CI_WORKFLOWS; do
    if ! state=$(_rgc_run_state "$wf" "$sha"); then
      echo "release refused: could not query CI for $wf on ${sha:0:7}" >&2
      return 1
    fi
    if [ -z "$state" ]; then
      echo "release refused: no $wf run for ${sha:0:7} yet (CI not started; retry when it is done)" >&2
      return 1
    fi
    read -r status conclusion url <<<"$state"
    if [ "$status" != completed ] || [ "$conclusion" != success ]; then
      echo "release refused: $wf on ${sha:0:7} is status=$status conclusion=${conclusion:-none} $url (retry when CI is green)" >&2
      return 1
    fi
  done

  RELEASE_SHA="$sha"
  export RELEASE_SHA
  echo "CI green on ${sha:0:7} ($branch): quality, backend, postgres, browser"
}
