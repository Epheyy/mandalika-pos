#!/usr/bin/env bash
# Deploy the backend to Cloud Run WITHOUT moving traffic, then print the next steps.
#
# Usage: scripts/deploy-backend.sh <tag> [--env KEY=VALUE ...]
#
# Gate (A34): refuses unless HEAD is a clean, pushed commit whose four CI gates passed.
# This script never shifts traffic; promote with scripts/promote-backend.sh <tag> after
# smoking the tag URL.
set -euo pipefail

TAG="${1:-}"
[[ "$TAG" =~ ^[a-z][a-z0-9-]{2,}$ ]] || {
  echo "usage: scripts/deploy-backend.sh <tag> [--env KEY=VALUE ...]  (tag: ^[a-z][a-z0-9-]{2,}$)" >&2
  exit 1
}
shift

ENV_VARS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --env)
      [[ "${2:-}" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] || { echo "--env needs KEY=VALUE" >&2; exit 1; }
      ENV_VARS+=("$2"); shift 2 ;;
    *) echo "unknown argument '$1'" >&2; exit 1 ;;
  esac
done

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
# shellcheck source=lib/require-green-ci.sh
source "$ROOT/scripts/lib/require-green-ci.sh"
# shellcheck source=lib/cloudrun.sh
source "$ROOT/scripts/lib/cloudrun.sh"
require_green_ci || exit 1

PREV=$(cr_field revisionName)
[ -n "$PREV" ] || { echo "could not determine the current 100% revision (rollback target)" >&2; exit 1; }
echo "current 100% revision (rollback target): $PREV"

ARGS=(--source backend --region "$REGION" --project "$PROJECT" --no-traffic --tag "$TAG" --quiet)
if [ ${#ENV_VARS[@]} -gt 0 ]; then
  JOINED=$(IFS=,; echo "${ENV_VARS[*]}")
  ARGS+=(--update-env-vars "$JOINED")
fi
gcloud run deploy "$SERVICE" "${ARGS[@]}"

TAG_URL=$(cr_field url "$TAG")
[ -n "$TAG_URL" ] || { echo "deployed, but could not read the tag URL for '$TAG'" >&2; exit 1; }

cat <<EOT

Deployed ${RELEASE_SHA:0:7} to tag '$TAG' (0% traffic): $TAG_URL

Next (nothing has been promoted):
  smoke:     curl -s $TAG_URL/readyz
  promote:   scripts/promote-backend.sh $TAG
             (= gcloud run services update-traffic $SERVICE --region $REGION --project $PROJECT --to-tags $TAG=100)
  rollback:  gcloud run services update-traffic $SERVICE --region $REGION --project $PROJECT --to-revisions $PREV=100
EOT
