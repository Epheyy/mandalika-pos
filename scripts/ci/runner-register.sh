#!/usr/bin/env bash
# One-time (and after a runner is deleted): register the VM's runner instances with BOTH repos.
# Registration tokens come from `gh api` at runtime and travel over IAP SSH on stdin: they are never
# written to disk locally, never put on a command line and never printed. Needs `gh` with repo admin
# on both repos and gcloud IAP SSH access. The VM must be running (runner-up.sh starts it).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=runner-config.sh
source "$HERE/runner-config.sh"
for entry in "${RUNNER_REPOS[@]}"; do
  read -r key repo <<<"$entry"
  for n in $(seq 1 "$RUNNER_INSTANCES_PER_REPO"); do
    inst="$key-$n"
    echo "registering $inst -> $repo"
    gh api -X POST "repos/$repo/actions/runners/registration-token" --jq .token \
      | gcloud compute ssh "$RUNNER_VM" --project "$GCP_PROJECT" --zone "$GCP_ZONE" --tunnel-through-iap --quiet \
          --command "sudo /opt/mandalika-ci/register.sh '$inst' 'https://github.com/$repo' '$RUNNER_LABEL'"
  done
done
echo "done; check with scripts/ci/runner-up.sh --status"
