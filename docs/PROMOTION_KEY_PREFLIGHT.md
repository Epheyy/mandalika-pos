# Read-only promotion key preflight

Introduced by A23-SEMANTIC-KEYS-20260921-01. This diagnoses the existing disjoint
bundle-slot / explicit BXGY buy-get contract; it does not migrate or repair data.

Use installed Go tooling from `backend` to build `./cmd/promotion-key-preflight`.
Set `PROMOTION_PREFLIGHT_DSN` explicitly to the reviewed target through the normal
secret-handling mechanism, preferably using a database role with SELECT access.
Run the compiled executable and retain its JSON output with target/date/HEAD evidence.
Do not put a password in a review packet. No .env, default target, migration or write
path is used. A 30-second context bounds the scan, in a READ ONLY / REPEATABLE READ
transaction. All bundle/BXGY rows are read, including inactive rules.

Exit codes: **0** = no findings in this overlap check; **1** = findings requiring
review; **2** = unavailable/incomplete scan or output failure. In PowerShell, propagate
the native status with `exit $LASTEXITCODE` when recording the command's exit code.
An unsuccessful scan is never evidence of a clean catalog.

Each finding contains promotion ID/type/active state, zero-based group indices and
the two conflicting keys. Bundle groups are slot indices; BXGY group0 is buy and
group1 is get. `uninspectable_config` means the key structure could not be read.
Key comparison is exact and case-sensitive. `P` covers all P variants; `P|M` and
`P|L` are disjoint. Same-slot alternatives form a union. Empty BXGY get means
same-set; empty buy means the complement of get. No normalization or catalog lookup.

This is not a complete schema, money, quantity, catalog-existence or release check.
Zero overlap findings do not close A23/T21. Review flagged configurations explicitly;
do not automatically rewrite old promotion rows, historical sales or outbox payloads.

Current verification used only a fresh isolated synthetic PostgreSQL18.3 fixture:
14 rows inspected; two deliberately seeded overlaps found, one inactive. Actual
CLI output is in SK_PREFLIGHT_SYNTHETIC.json. Read-only before/after database
snapshots were equal. No live/staging legacy-row inventory is claimed. Both new
test clusters are stopped and retained; prior cleanup policy blocks remain untouched.
