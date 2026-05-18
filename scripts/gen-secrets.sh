#!/usr/bin/env bash
# Generate strong production secrets. Output is for piping into the host
# secret store — never into a committed file.
#
#   ./scripts/gen-secrets.sh                  # print KEY=VALUE lines
#   ./scripts/gen-secrets.sh | while read l; do fly secrets set "$l"; done
set -euo pipefail

rand() { openssl rand -hex 32; }            # 64 hex chars = 256-bit
randpw() { openssl rand -base64 24 | tr -d '/+=' | cut -c1-24; }

ACCESS="$(rand)"
REFRESH="$(rand)"
while [ "$REFRESH" = "$ACCESS" ]; do REFRESH="$(rand)"; done

cat <<EOF
JWT_ACCESS_SECRET=${ACCESS}
JWT_REFRESH_SECRET=${REFRESH}
SEED_ADMIN_PASSWORD=$(randpw)
EOF
