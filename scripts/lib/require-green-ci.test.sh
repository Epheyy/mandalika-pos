#!/usr/bin/env bash
# Unit tests for require-green-ci.sh: the git/gh seams are stubbed with shell functions.
# Run: bash scripts/lib/require-green-ci.test.sh
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=require-green-ci.sh
source "$HERE/require-green-ci.sh"

FAILS=0
SHA40="0123456789abcdef0123456789abcdef01234567"

# Default stubs = everything green; each case overrides one seam.
reset_stubs() {
  _rgc_tree_clean() { return 0; }
  _rgc_head_sha() { echo "$SHA40"; }
  _rgc_branch() { echo "prod-hardening"; }
  _rgc_fetch() { return 0; }
  _rgc_is_pushed() { return 0; }
  _rgc_have_gh() { return 0; }
  _rgc_run_state() { echo "completed success https://example.test/run/1"; }
  unset RELEASE_SHA
}

# expect <name> <0|1>  (0 = require_green_ci should succeed)
expect() {
  local name="$1" want="$2" out rc
  out=$(require_green_ci 2>&1); rc=$?
  if { [ "$want" = 0 ] && [ $rc -eq 0 ]; } || { [ "$want" = 1 ] && [ $rc -ne 0 ]; }; then
    echo "PASS: $name"
  else
    echo "FAIL: $name (rc=$rc, want_success=$want)"; echo "$out" | sed 's/^/    /'; FAILS=$((FAILS + 1))
  fi
  LAST_OUT="$out"
}

reset_stubs; _rgc_tree_clean() { return 1; }
expect "dirty tracked tree fails" 1

reset_stubs; _rgc_is_pushed() { return 1; }
expect "unpushed HEAD fails" 1

reset_stubs; _rgc_have_gh() { return 1; }
expect "missing gh fails" 1

reset_stubs; _rgc_run_state() { [ "$1" = backend.yml ] && echo "completed failure https://example.test/run/2" || echo "completed success https://example.test/run/1"; }
expect "one gate failed fails" 1
case "$LAST_OUT" in *backend.yml*) ;; *) echo "FAIL: failure message names the gate"; FAILS=$((FAILS + 1));; esac

reset_stubs; _rgc_run_state() { [ "$1" = postgres.yml ] && echo "in_progress " || echo "completed success u"; }
expect "one gate in progress fails" 1

reset_stubs; _rgc_run_state() { [ "$1" = browser.yml ] && return 0 || echo "completed success u"; }
expect "one gate missing (no run) fails" 1

reset_stubs; _rgc_run_state() { return 1; }
expect "gh query error fails" 1

reset_stubs
expect "all green succeeds" 0
# require_green_ci must run in the caller's shell for RELEASE_SHA to be exported.
reset_stubs; require_green_ci >/dev/null 2>&1
if [ "${RELEASE_SHA:-}" = "$SHA40" ]; then echo "PASS: RELEASE_SHA set on success"; else echo "FAIL: RELEASE_SHA not set"; FAILS=$((FAILS + 1)); fi
case "$LAST_OUT" in *"CI green on 0123456 (prod-hardening): quality, backend, postgres, browser"*) echo "PASS: success message";; *) echo "FAIL: success message: $LAST_OUT"; FAILS=$((FAILS + 1));; esac

reset_stubs; _rgc_tree_clean() { return 1; }; require_green_ci >/dev/null 2>&1
[ -z "${RELEASE_SHA:-}" ] && echo "PASS: RELEASE_SHA unset on failure" || { echo "FAIL: RELEASE_SHA set on failure"; FAILS=$((FAILS + 1)); }

[ "$FAILS" -eq 0 ] || { echo "$FAILS failure(s)"; exit 1; }
echo "all passed"
