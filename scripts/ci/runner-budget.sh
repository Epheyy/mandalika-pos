#!/usr/bin/env bash
# Budget + email alert on Compute Engine spend in the project.
# Usage: runner-budget.sh <BILLING_ACCOUNT_ID> [amount]   (amount is in the billing account's own currency)
set -euo pipefail
acct="${1:?billing account id, e.g. 012345-ABCDEF-678901}"; amount="${2:-60}"
cur="$(gcloud billing accounts describe "$acct" --format='value(currencyCode)')"
gcloud billing budgets create --billing-account "$acct" --display-name "ci-runner compute" \
  --budget-amount "${amount}${cur}" --filter-projects "projects/${GCP_PROJECT:-mandalika-pos}" \
  --filter-services "services/6F81-5844-456A" \
  --threshold-rule percent=0.5 --threshold-rule percent=0.9 --threshold-rule percent=1.0
