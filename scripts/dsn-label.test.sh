#!/usr/bin/env bash
# Dry-run test for dsn-label.sh with FAKE connection strings only.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=dsn-label.sh
. "$here/dsn-label.sh"

P="<connection string not shown>"
fail=0
check() { # name dsn expected
  local got
  got="$(dsn_label "$2")"
  if [ "$got" != "$3" ]; then echo "FAIL $1: got '$got' want '$3'"; fail=1; else echo "ok   $1"; fi
  case "$got" in *FAKESECRET*|*FAKE*) echo "FAIL $1: secret leaked in '$got'"; fail=1;; esac
}
check "url with creds and query"      'postgres://u:FAKESECRET@db.example:5432/mydb?sslmode=require&password=FAKESECRET' 'db.example:5432/mydb'
check "upper-case scheme"             'POSTGRES://u:p@h/db' 'h/db'
check "postgresql scheme"             'postgresql://u:p@h:5432/db#frag' 'h:5432/db'
check "password containing @"         'postgres://u:p@FAKESECRET@h/db' "$P"
check "no userinfo (no @)"            'postgresql://h:5432/db' "$P"
check "password without @"            'postgres://u:FAKESECRET' "$P"
check "keyword form"                  'host=h user=u password=FAKESECRET dbname=d' "$P"
check "url embedded in a keyword value" 'application_name=http://x host=h password=FAKESECRET dbname=d' "$P"
check "url-looking password value"    'password=ab://FAKESECRET host=h' "$P"
check "@ inside the query"            'postgres://u:p@h/db?options=-c%20x@FAKESECRET' "$P"
check "@ only in the query"           'postgres://h/db?options=-c%20x@FAKESECRET' "$P"
check "? ends the userinfo early (1)" 'postgres://u:FAKESECRET?@h/db' "$P"
check "? ends the userinfo early (2)" 'postgres://u:FAKE?SECRET@h/db' "$P"
check "/ in the userinfo"             'postgres://u:FAKE/SECRET@h/db' "$P"
check "# in the userinfo"             'postgres://u:FAKE#SECRET@h/db' "$P"
check "embedded newline"              $'postgres://u:p@h/db\nFAKESECRET' "$P"
check "embedded carriage return"      $'postgres://u:p@h/db\rFAKESECRET' "$P"
exit "$fail"
