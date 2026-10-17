#!/usr/bin/env bash
# Dry-run test for dsn-label.sh with FAKE connection strings only.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=dsn-label.sh
. "$here/dsn-label.sh"

fail=0
check() { # name dsn expected
  local got
  got="$(dsn_label "$2")"
  if [ "$got" != "$3" ]; then echo "FAIL $1: got '$got' want '$3'"; fail=1; else echo "ok   $1"; fi
  case "$got" in *FAKESECRET*) echo "FAIL $1: secret leaked in '$got'"; fail=1;; esac
}
check "url with creds and query" 'postgres://u:FAKESECRET@db.example:5432/mydb?sslmode=require&password=FAKESECRET' 'db.example:5432/mydb'
check "password containing @"    'postgres://u:p@FAKESECRET@h/db' "<connection string with several '@', not shown>"
check "no userinfo"              'postgresql://h:5432/db' 'h:5432/db'
check "keyword form"             'host=h user=u password=FAKESECRET dbname=d' '<non-URL connection string, not shown>'
check "url embedded in a keyword value" 'application_name=http://x host=h password=FAKESECRET dbname=d' '<non-URL connection string, not shown>'
check "url-looking password value" 'password=ab://FAKESECRET host=h' '<non-URL connection string, not shown>'
check "@ inside the query"       'postgres://u:p@h/db?options=-c%20x@FAKESECRET' "<connection string with several '@', not shown>"
check "@ only in the query"       'postgres://h/db?options=-c%20x@FAKESECRET' 'h/db'
exit "$fail"
