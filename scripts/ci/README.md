# Mandatory PostgreSQL integration gate

Run from the repository root:

```sh
python3 -B -m unittest discover -s scripts/ci -p 'test_*.py' -v
python3 -B scripts/ci/postgres_gate.py --output artifacts/postgres/result.json
```

The default runner requires a working Docker engine and Go. It pulls
`postgres:18.3` (official image pinned by content digest `IMAGE_DIGEST`, pulled by digest from the first mirror in `IMAGE_MIRRORS` that serves it — `mirror.gcr.io`, then AWS ECR Public — so quota errors or hung pulls fall through and no mirror can substitute different bytes), records the resolved image ID/digest, and creates each container
using that immutable ID. Eight fixtures run sequentially, one fresh tmpfs cluster
per named Go integration test. Ports 56439–56446 must be unused. Only
`127.0.0.1` is published. Each fixture has its own generated synthetic password,
exact database/user, and explicit unique PGDATA. There is no `.env`, live DSN,
shared database, or provider-secret fallback.

Before migration, the runner and unchanged test guards verify the exact target,
PostgreSQL version 180003, `SHOW data_directory`, and empty public schema. The
runner supplies only that gate's fixture variables and removes inherited libpq
defaults and optional A26/A27 evidence-output paths. Passwords are passed through
the child environment; no passwords or connection strings are logged.

Tests use `-count=1 -json -timeout=180s -race`. Process exit zero is insufficient:
the named test must emit RUN and PASS, the package must PASS, and no test may
FAIL or SKIP. Infrastructure errors fail the gate. Readiness defaults to45s;
commands, process trees and cleanup also have bounded deadlines.

Owned fixtures are stopped/removed in `finally` on success, failure or handled
termination. Cleanup checks ownership and confirms absence plus a closed port.
Uncertain cleanup fails the gate and stops subsequent fixtures. Container data
is in tmpfs; native fixture paths must be the exact newly-created marked child
of the OS temp directory. Historical fixture directories are never selected or
removed. Abrupt host loss/SIGKILL cannot run Python cleanup; the hosted runner is
disposable. A timed-out/cancelled workflow never establishes a passing gate.

An explicit local adapter supports an already-installed PostgreSQL 18.3:

```powershell
python -B scripts/ci/postgres_gate.py --runtime native --pg-bin 'C:\Program Files\PostgreSQL\18\bin' --no-race --output '<new-evidence-directory>\result.json'
```

`--no-race` is a declared local concession for environments without CGO/C compiler.
The hosted workflow never sets it. The native adapter exercises the same six tests,
identity/empty-schema checks, event parser and cleanup decision; local native
success does not establish Docker/Ubuntu/race success. Do not run fixtures concurrently
on the same host because their fixed guarded ports intentionally collide.

`result.json` and adjacent sanitized Go JSONL logs are the evidence. The runner's
unit tests cover parser, environment, redaction, cleanup failure and Docker command
contracts; these mocks do not replace PostgreSQL integration verification.

`.github/workflows/postgres.yml` runs on push, PR and reusable workflow calls.
Android build/signing needs JS/TS quality, this database workflow, the existing
backend gen/vet/fmt/build/race workflow, and the synthetic Chromium browser gate
at the caller commit (see `tests/browser/README.md`). No signing secrets
are forwarded to quality jobs. Hosted execution, branch protection and business
concurrency scenarios remain separate qualifications: the six current fixtures
exercise sequential transactions/replays, not A13/A42 overlapping operations.
