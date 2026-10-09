# A34b verification matrix

Packet: A34B-POSTGRES-CI-20260921-01. Review: CG-A34A-CI-20260921-01-R1.
All evidence is this turn's current local source unless explicitly historical.

| Review scenario | Actual result / boundary |
|---|---|
| 1 Six-gate inventory | Exact six entrypoints found; guard prefixes identical before/after. A34B_GATE_INVENTORY.json. |
| 2 All run / no skips | Native18.3 six named PASS,142 parent/child PASS events, zero SKIP/FAIL. |
| 3 Fresh PG18.3 | Six different fixture UUIDs/directories; actual server_version_num180003 each. Docker image version pinned but Docker runtime proof unavailable. |
| 4 Exact target | All host127.0.0.1, guarded ports56439–56444, db/user exact. Wrong-target probe fails at unchanged guard before any tables/migrations. |
| 5 Data directory | Expected newly-created path equals actual SHOW on all six; extra wrong-directory probe fails before migrations. Unit rejects unavailable directory. |
| 6 Empty schema | All public_tables_before=0; positive public_tables_after=66. |
| 7 Secrets/environment | No app env read; inherited PG/fixture/output settings removed. Synthetic password generated per fixture, never serialized. Unit environment/redaction contracts pass. |
| 8 Real migrations/assertions | All six execute current45 migrations, authenticated handlers/services/SQL. S0c stale disjoint-BXGY fixture corrected; financial assertions retained. |
| 9 LF helpers | Actual semantic-keys and guest-sales subtest PASS events included in LF57 parent/child passes. |
| 10 A26/A27 optional outputs | TEST_OUTPUT values stripped; only runner-sanitized lifecycle/events written. |
| 11 Success teardown | Six removed-and-port-closed; sequential advancement only after finally cleanup. |
| 12 Failure teardown | All five created negative fixtures plus initial failures removed-and-port-closed. Missing runtime creates none. |
| 13 Missing runtime | Real runner exit1 at preflight; no fixture or tests. |
| 14 Wrong target | Actual Go guard rejects altered port; public_tables_after=0; whole runner exit1. |
| 15 Named SKIP | Actual Go process exits0/packagePASS with namedSKIP; runner exit1. |
| 16 Assertion failure | Disposable test t.Fatal emits FAIL; runner exit1; no active test mutation. |
| 17 Bounded readiness | Disposable SELECT pg_sleep(30) readiness probe with2s deadline fails at readiness and cleans; no Go test dispatch. Command/process/workflow deadlines in source. |
| 18 Android waits | Parsed needs=[quality,database,backend]; no overriding if/continue-on-error; all callerSHA checkout. |
| 19 No signing secrets | No explicit secrets/inherit in reusable callers or quality definitions; only build accesses signing values. |
| 20 Concurrency | No true overlapping DB business operations. Only t.Parallel match is pure TestValidateIngTransfer. A13/A42 remain open/unavailable. |
| 21 Existing baseline | Backend commands unchanged; vet/fmt/build/ordinary tests pass. Local race fails because CGO0/no compiler. HEAD-relative gen fails due pre-existing dirty generated source; same bytes regenerate and gen-check passes in disposable current-tree index. Accepted JS quality byte-preserved, not unnecessarily rerun. |
| 22 No live mutation/release | Only new synthetic local DBs used. No migrations/deployment on live targets, credentials/provider changes, commit/push/signing or release run. |

Nine runner unit tests separately cover named/package proof, skip/absent test,
wrong package, nonzero exit, environment isolation, redaction, cleanup uncertainty
(overrides otherwise-passing test), Docker loopback/tmpfs/image arguments,
container ownership mismatch and missing data-directory identity. Mocked lifecycle
checks are not database-backed or Docker execution evidence.

All five required negative proofs pass; an optional directory-negative classifier
initially expected a different error string. The actual unchanged S0c guard emitted
`test cluster directory mismatch`, left zero public tables and cleaned. Original
classifier failure and raw events are preserved; corrected classification reused
the actual evidence without inventing another run.

Limits: native Windows Go1.26.2/PostgreSQL18.3 and Python3.14, no local race;
hosted configuration Ubuntu/Python3.12/Docker PG18.3/default race remains unrun.
No actionlint installed/executed; installed js-yaml parsed all relevant workflows
and asserted trigger/dependency/secret structure. No A13/A42 coverage invented.

Historical stopped S0c DB cleanup remains untouched. A separate attempted removal
of generated scripts/ci/__pycache__ was rejected by automatic approval review as
blocked by policy; those cache files remain and are excluded from the archive.
