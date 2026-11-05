#!/usr/bin/env bash
# Start the self-hosted CI VM (if stopped) and wait until its runners are online in BOTH repos.
# Run it before pushing gate/<name> branches. The VM stops itself ~30 min after its last job.
# Usage: scripts/ci/runner-up.sh [--status]     (--status: report only, start nothing)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=runner-config.sh
source "$HERE/runner-config.sh"
command -v gcloud >/dev/null || { echo "gcloud is required" >&2; exit 1; }
command -v gh >/dev/null || { echo "gh is required" >&2; exit 1; }

vm_status() { gcloud compute instances describe "$RUNNER_VM" --project "$GCP_PROJECT" --zone "$GCP_ZONE" --format='value(status)'; }
online_count() { # $1 = owner/repo
  gh api "repos/$1/actions/runners" --paginate     --jq ".runners[] | select(.status==\"online\" and ([.labels[].name] | index(\"$RUNNER_LABEL\"))) | .id" 2>/dev/null | wc -l | tr -d ' '
}
report() {
  local entry key repo
  for entry in "${RUNNER_REPOS[@]}"; do read -r key repo <<<"$entry"; echo "  $repo: $(online_count "$repo" || echo '?') runner(s) online"; done
}

status="$(vm_status)"
echo "VM $RUNNER_VM: $status"
if [ "${1:-}" = "--status" ]; then report; exit 0; fi
if [ "$status" != RUNNING ]; then
  gcloud compute instances start "$RUNNER_VM" --project "$GCP_PROJECT" --zone "$GCP_ZONE" >/dev/null
  echo "VM started"
fi

deadline=$((SECONDS + 600))
while :; do
  ok=1
  for entry in "${RUNNER_REPOS[@]}"; do
    read -r key repo <<<"$entry"
    n="$(online_count "$repo" || echo 0)"
    [ "${n:-0}" -ge 1 ] || ok=0
  done
  if [ "$ok" = 1 ]; then echo "runners online:"; report; exit 0; fi
  if [ "$SECONDS" -ge "$deadline" ]; then echo "timed out waiting for runners (10 min); current state:" >&2; report >&2; exit 1; fi
  sleep 10
done
