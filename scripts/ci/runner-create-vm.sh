#!/usr/bin/env bash
# One-time GCP setup for the self-hosted CI runner VM. Every create is skipped if the resource exists.
# Network: dedicated VPC; the only ingress rule is IAP SSH (35.235.240.0/20 -> tcp:22). Outbound only otherwise.
# Identity: its own service account with NO roles and no API scopes (no Secret Manager / Cloud Run / Artifact Registry).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=runner-config.sh
source "$HERE/runner-config.sh"
g() { gcloud --project "$GCP_PROJECT" "$@"; }
SA="$RUNNER_SA_NAME@$GCP_PROJECT.iam.gserviceaccount.com"

g services enable compute.googleapis.com iap.googleapis.com billingbudgets.googleapis.com
g iam service-accounts describe "$SA" >/dev/null 2>&1 || g iam service-accounts create "$RUNNER_SA_NAME" --display-name "CI runner (no roles)"
g compute networks describe "$RUNNER_NETWORK" >/dev/null 2>&1 || g compute networks create "$RUNNER_NETWORK" --subnet-mode=custom
g compute networks subnets describe "$RUNNER_NETWORK-$GCP_REGION" --region "$GCP_REGION" >/dev/null 2>&1 \
  || g compute networks subnets create "$RUNNER_NETWORK-$GCP_REGION" --network "$RUNNER_NETWORK" --region "$GCP_REGION" --range 10.20.0.0/24
g compute firewall-rules describe "$RUNNER_NETWORK-allow-iap-ssh" >/dev/null 2>&1 \
  || g compute firewall-rules create "$RUNNER_NETWORK-allow-iap-ssh" --network "$RUNNER_NETWORK" --direction INGRESS \
       --allow tcp:22 --source-ranges 35.235.240.0/20
g compute instances describe "$RUNNER_VM" --zone "$GCP_ZONE" >/dev/null 2>&1 || \
  g compute instances create "$RUNNER_VM" --zone "$GCP_ZONE" --machine-type "$RUNNER_MACHINE" \
    --provisioning-model=STANDARD --image-family ubuntu-2404-lts-amd64 --image-project ubuntu-os-cloud \
    --boot-disk-size "${RUNNER_DISK_GB}GB" --boot-disk-type pd-balanced \
    --network-interface "network=$RUNNER_NETWORK,subnet=$RUNNER_NETWORK-$GCP_REGION" \
    --service-account "$SA" --no-scopes --shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring \
    --metadata "enable-oslogin=TRUE,block-project-ssh-keys=TRUE" \
    --metadata-from-file "startup-script=$HERE/runner-provision.sh"
echo "VM created. Wait ~5 min for the first-boot provisioning, then run scripts/ci/runner-register.sh."
echo "Budget alert: scripts/ci/runner-budget.sh <billing-account-id>."
