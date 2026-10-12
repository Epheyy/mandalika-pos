#!/usr/bin/env bash
# Promote a tagged Cloud Run revision (from scripts/deploy-backend.sh) to 100% traffic,
# but only if its /readyz answers 200.
#
# Usage: scripts/promote-backend.sh <tag>
set -euo pipefail

TAG="${1:-}"
[[ "$TAG" =~ ^[a-z][a-z0-9-]{2,}$ ]] || { echo "usage: scripts/promote-backend.sh <tag>" >&2; exit 1; }

ROOT="$(git rev-parse --show-toplevel)"
# shellcheck source=lib/cloudrun.sh
source "$ROOT/scripts/lib/cloudrun.sh"

TAG_URL=$(cr_field url "$TAG")
[ -n "$TAG_URL" ] || { echo "no revision is tagged '$TAG'" >&2; exit 1; }
PREV=$(cr_field revisionName)

CODE=$(curl -s -o /dev/null -w '%{http_code}' "$TAG_URL/readyz" || true)
[ "$CODE" = 200 ] || { echo "promotion refused: $TAG_URL/readyz returned '$CODE' (want 200)" >&2; exit 1; }

gcloud run services update-traffic "$SERVICE" --region "$REGION" --project "$PROJECT" --to-tags "$TAG=100"
echo "now serving 100%: $(cr_field revisionName)"
[ -z "$PREV" ] || echo "rollback: gcloud run services update-traffic $SERVICE --region $REGION --project $PROJECT --to-revisions $PREV=100"
