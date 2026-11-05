# Sourced by the runner-*.sh scripts. No side effects. Override any value via the environment.
GCP_PROJECT="${GCP_PROJECT:-mandalika-pos}"
GCP_ZONE="${GCP_ZONE:-asia-southeast2-a}"
GCP_REGION="${GCP_REGION:-asia-southeast2}"
RUNNER_VM="${RUNNER_VM:-mandalika-ci-runner}"
RUNNER_SA_NAME="${RUNNER_SA_NAME:-ci-runner}"            # service account with NO roles
RUNNER_NETWORK="${RUNNER_NETWORK:-ci-runner-net}"
RUNNER_MACHINE="${RUNNER_MACHINE:-e2-standard-4}"
RUNNER_DISK_GB="${RUNNER_DISK_GB:-100}"
RUNNER_LABEL="${RUNNER_LABEL:-mandalika}"                # extra label; GitHub adds self-hosted, Linux, X64
RUNNER_INSTANCES_PER_REPO="${RUNNER_INSTANCES_PER_REPO:-2}"
# "<key> <owner/repo>": key names the runner directory/service instance (origin-1, mirror-2, ...).
RUNNER_REPOS=("origin Epheyy/mandalika-pos" "mirror mandalika-ci/mandalika-pos-ci")
