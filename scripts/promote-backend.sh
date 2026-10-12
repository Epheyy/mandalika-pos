#!/usr/bin/env bash
# Promote a tagged Cloud Run revision (from scripts/deploy-backend.sh) to 100% traffic,
# but only if its commit-sha label names a commit whose four CI gates are green and its
# /readyz answers 200.
#
# Usage: scripts/promote-backend.sh <tag>
set -euo pipefail

TAG="${1:-}"
[[ "$TAG" =~ ^[a-z][a-z0-9-]{1,38}[a-z0-9]$ ]] || { echo "usage: scripts/promote-backend.sh <tag>" >&2; exit 1; }

ROOT="$(git rev-parse --show-toplevel)"
# shellcheck source=lib/cloudrun.sh
source "$ROOT/scripts/lib/cloudrun.sh"
# shellcheck source=lib/require-green-ci.sh
source "$ROOT/scripts/lib/require-green-ci.sh"

TAG_URL=$(cr_field url "$TAG")
[ -n "$TAG_URL" ] || { echo "no revision is tagged '$TAG'" >&2; exit 1; }
PREV=$(cr_field revisionName)

SHA=$(cr_revision_label "$TAG" commit-sha) || { echo "promotion refused: could not read labels of the revision tagged '$TAG'" >&2; exit 1; }
LABEL_TAG=$(cr_revision_label "$TAG" deploy-tag) || { echo "promotion refused: could not read labels of the revision tagged '$TAG'" >&2; exit 1; }
[ "$LABEL_TAG" = "$TAG" ] || { echo "promotion refused: revision tagged '$TAG' has deploy-tag label '$LABEL_TAG'; it was not created by deploy-backend.sh for this tag" >&2; exit 1; }
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "promotion refused: revision tagged '$TAG' has no valid commit-sha label (got '$SHA')" >&2; exit 1; }
require_green_ci_for_sha "$SHA" || exit 1

CODE=$(curl -s --max-time 15 -o /dev/null -w '%{http_code}' "$TAG_URL/readyz" || true)
[ "$CODE" = 200 ] || { echo "promotion refused: $TAG_URL/readyz returned '$CODE' (want 200)" >&2; exit 1; }

gcloud run services update-traffic "$SERVICE" --region "$REGION" --project "$PROJECT" --to-tags "$TAG=100"
echo "now serving 100%: $(cr_field revisionName)"
[ -z "$PREV" ] || echo "rollback: gcloud run services update-traffic $SERVICE --region $REGION --project $PROJECT --to-revisions $PREV=100"
