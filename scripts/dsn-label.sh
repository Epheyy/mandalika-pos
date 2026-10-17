#!/usr/bin/env bash
# dsn_label <dsn>: a log-safe label for a PostgreSQL connection string. FAIL CLOSED.
# Only a string that STARTS with postgres:// or postgresql:// and holds AT MOST ONE '@'
# (the userinfo separator) is shown, as host:port/db with any '?query' removed first.
# Anything else prints a fixed placeholder: keyword/value DSNs (password=...), URLs embedded
# in a value, and URLs with several '@' (a password or query option containing '@').
dsn_label() {
  local dsn="$1" rest ats
  case "$dsn" in
    postgres://*|postgresql://*)
      ats="${dsn//[^@]/}"
      if [ "${#ats}" -gt 1 ]; then
        printf '%s\n' "<connection string with several '@', not shown>"
        return 0
      fi
      rest="${dsn#*://}"
      rest="${rest%%\?*}"
      rest="${rest##*@}"
      printf '%s\n' "$rest"
      ;;
    *)
      printf '%s\n' "<non-URL connection string, not shown>"
      ;;
  esac
}
