#!/usr/bin/env bash
# Restore a custom-format dump into a target database. DESTRUCTIVE: --clean
# drops existing objects first. Intended for disaster recovery and for the
# documented restore drill (RUNBOOK.md "DB restore").
#
#   TARGET_DATABASE_URL=postgres://... ./scripts/db-restore.sh path/to.dump
set -euo pipefail

: "${TARGET_DATABASE_URL:?set TARGET_DATABASE_URL (the database to restore INTO)}"
DUMP="${1:?usage: db-restore.sh <dump-file>}"
[ -f "$DUMP" ] || { echo "no such dump: $DUMP" >&2; exit 1; }

echo "Restoring $DUMP -> $TARGET_DATABASE_URL"
pg_restore --clean --if-exists --no-owner --no-acl \
  -d "$TARGET_DATABASE_URL" "$DUMP"

# Prove the restore: row counts for the revenue-critical tables.
psql "$TARGET_DATABASE_URL" -At -c \
  "SELECT 'orders='||count(*) FROM orders
   UNION ALL SELECT 'order_items='||count(*) FROM order_items
   UNION ALL SELECT 'products='||count(*) FROM products
   UNION ALL SELECT 'shifts='||count(*) FROM shifts;"
echo "restore ok"
