#!/usr/bin/env bash
# Logical backup of the Postgres database to a timestamped custom-format dump.
#
#   DATABASE_URL=postgres://... ./scripts/db-backup.sh [outdir]
#
# Managed Postgres (Neon) already keeps automated daily snapshots + PITR;
# this is the portable, provider-independent second copy. Run it from cron
# or a CI schedule and ship the artifact off-host.
set -euo pipefail

: "${DATABASE_URL:?set DATABASE_URL}"
OUTDIR="${1:-backups}"
mkdir -p "$OUTDIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="$OUTDIR/mandalika_${STAMP}.dump"

# -Fc = custom format (compressed, selective restore). --no-owner/--no-acl
# keep the dump portable across managed roles.
pg_dump --no-owner --no-acl -Fc "$DATABASE_URL" -f "$FILE"

# Integrity check: dump must list a table catalog.
pg_restore -l "$FILE" >/dev/null
echo "backup ok: $FILE ($(wc -c <"$FILE") bytes)"

# Retain last 14 daily dumps.
ls -1t "$OUTDIR"/mandalika_*.dump 2>/dev/null | tail -n +15 | xargs -r rm -f
