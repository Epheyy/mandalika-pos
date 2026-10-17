#!/usr/bin/env bash
# dsn_label <dsn>: a log-safe label for a PostgreSQL connection string. FAIL CLOSED.
# A host:port/db label is printed ONLY when the string
#   - starts with postgres:// or postgresql:// (scheme case-insensitive),
#   - has exactly one '@' (the userinfo separator) and no newline or carriage return,
#   - and its userinfo (the text between :// and '@') holds no '?', '/' or '#'.
# The '?query' and '#fragment' are stripped only from the part AFTER the '@'.
# Everything else (keyword/value DSNs with password=..., a URL embedded in a value, a URL
# without '@', several '@') prints a fixed placeholder.
dsn_label() {
  local dsn="$1" lower rest ats userinfo after
  local placeholder="<connection string not shown>"
  case "$dsn" in
    *$'\n'*|*$'\r'*) printf '%s\n' "$placeholder"; return 0 ;;
  esac
  lower="$(printf '%s' "$dsn" | tr 'A-Z' 'a-z')"
  case "$lower" in
    postgres://*|postgresql://*) ;;
    *) printf '%s\n' "$placeholder"; return 0 ;;
  esac
  ats="${dsn//[^@]/}"
  if [ "${#ats}" -ne 1 ]; then printf '%s\n' "$placeholder"; return 0; fi
  rest="${dsn#*://}"
  userinfo="${rest%%@*}"
  case "$userinfo" in
    *\?*|*/*|*\#*) printf '%s\n' "$placeholder"; return 0 ;;
  esac
  after="${rest#*@}"
  after="${after%%\?*}"
  after="${after%%\#*}"
  printf '%s\n' "$after"
}
