#!/usr/bin/env bash
# dsn_label <dsn>: a log-safe label for a PostgreSQL connection string.
# URL form (scheme://user:pass@host:port/db?query): prints host:port/db only,
# cutting at the LAST '@' so a password containing '@' cannot leak its tail.
# Any other form (keyword/value DSN with password=...): prints a fixed placeholder;
# host/port/db are deliberately not parsed out of it.
dsn_label() {
  local dsn="$1" rest
  case "$dsn" in
    *://*)
      rest="${dsn#*://}"
      rest="${rest##*@}"
      rest="${rest%%\?*}"
      printf '%s\n' "$rest"
      ;;
    *)
      printf '%s\n' "<non-URL connection string, not shown>"
      ;;
  esac
}
