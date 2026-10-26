#!/usr/bin/env bash
# Local run of the ERP stand-in demo rehearsal (backend/cmd/erp-rehearsal).
#
# Builds the backend, the erpstub, seed and the harness, creates a throwaway Postgres
# database, starts stub + backend on loopback ports (the stub assigns only the rehearsal
# outlet to the client, like the ERP's client dialog), creates one outlet and one warehouse
# through the admin API, maps the warehouse to the stub's `gudang-pusat` (the only SQL
# step: warehouses.erp_slug has no API writer; the relay must hold warehouse documents even
# when mapped), runs the harness and tears everything down.
#
# Optional env:  LOCAL_PG_URL   admin DSN of an existing local Postgres, e.g.
#                               postgres://user:pass@localhost:5432/postgres?sslmode=disable
#                               (a throwaway database is created next to it and dropped at the end).
#                               Unset: a private throwaway cluster is initdb-ed in a temp dir (trust auth, loopback).
#                PG_BIN         dir with psql (default: /c/Program Files/PostgreSQL/18/bin)
#                RUN_ID         rehearsal run id (default: timestamp)
#                FROM_SEED=1    start the stub from `erp-rehearsal -print-seed` output instead of the embedded seed
#                FAULT_WAIT     harness -fault-wait (default 4m)
#                FIRST_PULL     harness -first-pull (full|incremental; default full, the live default is incremental)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PG_BIN="${PG_BIN:-/c/Program Files/PostgreSQL/18/bin}"
RUN_ID="${RUN_ID:-$(date -u +%y%m%dt%H%M%S)}"
FAULT_WAIT="${FAULT_WAIT:-4m}"
FIRST_PULL="${FIRST_PULL:-full}"
OUTLET_CODE="RHL"

EXT=""
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) EXT=".exe" ;; esac
PSQL="$PG_BIN/psql$EXT"
[ -x "$PSQL" ] || PSQL="$(command -v psql || true)"
[ -n "$PSQL" ] || { echo "psql not found; set PG_BIN" >&2; exit 2; }

rand() { openssl rand -hex "$1"; }
free_port() {
  local p
  while :; do
    p=$((20000 + RANDOM % 20000))
    (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null || { echo "$p"; return; }
  done
}

TMP="$(mktemp -d)"
DB="erp_rehearsal_$(date -u +%s)"
PIDS=()
PG_CTL="$PG_BIN/pg_ctl$EXT"; PRIVATE_PG=0
if [ -z "${LOCAL_PG_URL:-}" ]; then
  # No DSN given: run a private cluster (no credentials involved, loopback only).
  PG_PORT="$(free_port)"
  "$PG_BIN/initdb$EXT" -D "$TMP/pg" -U rehearsal -A trust -E UTF8 >"$TMP/initdb.log" 2>&1 || { cat "$TMP/initdb.log" >&2; exit 1; }
  "$PG_CTL" -D "$TMP/pg" -l "$TMP/pg.log" -o "-p $PG_PORT -c listen_addresses=127.0.0.1" -w start >/dev/null
  PRIVATE_PG=1
  LOCAL_PG_URL="postgres://rehearsal@127.0.0.1:$PG_PORT/postgres?sslmode=disable"
  echo "== private Postgres cluster on 127.0.0.1:$PG_PORT"
fi
BASE="${LOCAL_PG_URL%%\?*}"
QUERY=""; [ "$BASE" != "$LOCAL_PG_URL" ] && QUERY="?${LOCAL_PG_URL#*\?}"
DB_URL="${BASE%/*}/$DB$QUERY"
DB_CREATED=0

cleanup() {
  local code=$?
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done
  sleep 1
  if [ "$DB_CREATED" = 1 ]; then
    "$PSQL" "$LOCAL_PG_URL" -q -c "DROP DATABASE IF EXISTS \"$DB\" WITH (FORCE)" >/dev/null 2>&1 \
      && echo "dropped throwaway database $DB" || echo "WARNING: could not drop $DB; drop it by hand" >&2
  fi
  if [ "$PRIVATE_PG" = 1 ]; then "$PG_CTL" -D "$TMP/pg" -m immediate stop >/dev/null 2>&1 || true; sleep 1; fi
  rm -rf "$TMP" 2>/dev/null || true
  exit "$code"
}
trap cleanup EXIT INT TERM

STUB_KEY="$(rand 40)"; SCHED_TOKEN="$(rand 48)"; ADMIN_PASS="$(rand 24)"
JWT_A="$(rand 48)"; JWT_R="$(rand 48)"; ADMIN_EMAIL="rehearsal-admin@example.invalid"
STUB_PORT="$(free_port)"; API_PORT="$(free_port)"

echo "== building"
mkdir -p "$TMP/bin" "$TMP/run"
(cd "$ROOT/backend" && for c in server erpstub seed erp-rehearsal; do go build -o "$TMP/bin/$c$EXT" "./cmd/$c"; done)

echo "== creating throwaway database $DB"
"$PSQL" "$LOCAL_PG_URL" -q -c "CREATE DATABASE \"$DB\""
DB_CREATED=1

STUB_ARGS=(-addr "127.0.0.1:$STUB_PORT" -key "$STUB_KEY" -assigned-outlets "$OUTLET_CODE")
if [ "${FROM_SEED:-0}" = 1 ]; then
  "$TMP/bin/erp-rehearsal$EXT" -print-seed -run-id "$RUN_ID" -outlet-code "$OUTLET_CODE" >"$TMP/seed.json"
  STUB_ARGS+=(-seed "$TMP/seed.json")
  echo "== stub starts from the printed seed"
fi
"$TMP/bin/erpstub$EXT" "${STUB_ARGS[@]}" >"$TMP/stub.log" 2>&1 &
PIDS+=($!)

export DATABASE_URL="$DB_URL" SEED_ADMIN_EMAIL="$ADMIN_EMAIL" SEED_ADMIN_PASSWORD="$ADMIN_PASS" SEED_ADMIN_NAME="Rehearsal Admin"
(cd "$TMP/run" && "$TMP/bin/seed$EXT" >"$TMP/seed.log" 2>&1) || { cat "$TMP/seed.log" >&2; exit 1; }

# cwd is an empty dir so config.Load cannot pick up backend/.env (it reads ./.env only).
(cd "$TMP/run" && ENV=development PORT="$API_PORT" DATABASE_URL="$DB_URL" REDIS_URL="" \
  JWT_ACCESS_SECRET="$JWT_A" JWT_REFRESH_SECRET="$JWT_R" CORS_ORIGINS="http://localhost:5173" \
  ERP_INTEGRATION_ENABLED=true ERP_RELAY_ENABLED=true ERP_BRAND=mandalika \
  ERP_BASE_URL="http://127.0.0.1:$STUB_PORT/api/integration/v1" ERP_API_KEY="$STUB_KEY" \
  ERP_SCHEDULER_TOKEN="$SCHED_TOKEN" "$TMP/bin/server$EXT" >"$TMP/server.log" 2>&1) &
PIDS+=($!)

API="http://127.0.0.1:$API_PORT"
echo "== waiting for the backend and the stub"
for i in $(seq 1 60); do
  curl -fs "$API/livez" >/dev/null 2>&1 && curl -s -o /dev/null "http://127.0.0.1:$STUB_PORT/_stub/documents" && break
  sleep 1
  [ "$i" = 60 ] && { echo "backend did not come up; log tail:" >&2; tail -n 20 "$TMP/server.log" >&2; exit 1; }
done

field() { sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p" | head -n1; }
TOKEN="$(curl -fs -X POST "$API/api/v1/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASS\"}" | field access)"
[ -n "$TOKEN" ] || { echo "admin login failed" >&2; exit 1; }
post() { curl -fs -X POST "$API/api/v1/$1" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$2"; }

echo "== creating outlet $OUTLET_CODE and warehouse through the admin API"
OUTLET_ID="$(post outlets "{\"name\":\"Rehearsal Outlet\",\"code\":\"$OUTLET_CODE\",\"isActive\":true}" | field id)"
WH_ID="$(post warehouses '{"name":"Rehearsal Gudang","code":"RHG","isActive":true}' | field id)"
[ -n "$OUTLET_ID" ] && [ -n "$WH_ID" ] || { echo "could not create outlet/warehouse" >&2; exit 1; }
"$PSQL" "$DB_URL" -q -c "UPDATE warehouses SET erp_slug='gudang-pusat' WHERE id='$WH_ID'"
echo "   outlet $OUTLET_ID, warehouse $WH_ID mapped to gudang-pusat (psql; its documents must still be held)"

echo "== running the rehearsal (run id $RUN_ID)"
set +e
REHEARSAL_BACKEND_URL="$API" REHEARSAL_ADMIN_EMAIL="$ADMIN_EMAIL" REHEARSAL_ADMIN_PASSWORD="$ADMIN_PASS" \
REHEARSAL_STUB_URL="http://127.0.0.1:$STUB_PORT" REHEARSAL_STUB_KEY="$STUB_KEY" \
REHEARSAL_SCHEDULER_TOKEN="$SCHED_TOKEN" REHEARSAL_DATABASE_URL="$DB_URL" \
  "$TMP/bin/erp-rehearsal$EXT" -outlet-code "$OUTLET_CODE" -warehouse-id "$WH_ID" -run-id "$RUN_ID" -fault-wait "$FAULT_WAIT" -first-pull "$FIRST_PULL"
RC=$?
set -e
[ "$RC" = 0 ] || { echo "== backend log tail" >&2; tail -n 15 "$TMP/server.log" >&2; }
exit "$RC"
