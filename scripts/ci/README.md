# Mandatory PostgreSQL integration gate

Run from the repository root:

```sh
python3 -B -m unittest discover -s scripts/ci -p 'test_*.py' -v
python3 -B scripts/ci/postgres_gate.py --output artifacts/postgres/result.json
```

The default runner requires a working Docker engine and Go. It pulls
`postgres:18.3` (official image pinned by content digest `IMAGE_DIGEST`, pulled by digest from the first mirror in `IMAGE_MIRRORS` that serves it — `mirror.gcr.io`, then AWS ECR Public — so quota errors or hung pulls fall through and no mirror can substitute different bytes), records the resolved image ID/digest, and creates each container
using that immutable ID. Eight fixtures run sequentially, one fresh tmpfs cluster
per named Go integration test. Ports 26439–26479 (below the Linux ephemeral range 32768–60999, so outgoing client sockets never take them as local ports; the workflow also reserves the block via ip_local_reserved_ports) must be unused. Only
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

`.github/workflows/postgres.yml` runs on push (only `prod-hardening` and `gate/**`), PR and reusable workflow calls.
Android build/signing needs JS/TS quality, this database workflow, the existing
backend gen/vet/fmt/build/race workflow, and the synthetic Chromium browser gate
at the caller commit (see `tests/browser/README.md`). No signing secrets
are forwarded to quality jobs. Hosted execution, branch protection and business
concurrency scenarios remain separate qualifications: the six current fixtures
exercise sequential transactions/replays, not A13/A42 overlapping operations.

# CI runners: self-hosted GCP VM (primary) with GitHub-hosted fallback

Why: GitHub-hosted minutes for the private repos ran out (2026-11-05) and the owner declined GitHub Team.

## How a workflow picks its runner

The five gates (`quality`, `backend`, `postgres`, `browser`, `dependency-security`) and `react-doctor` use
`runs-on: ${{ fromJSON(vars.CI_RUNS_ON || '"ubuntu-latest"') }}`. The repository variable `CI_RUNS_ON` is a JSON value:

| `CI_RUNS_ON` | Runs on |
|---|---|
| unset / empty | GitHub-hosted `ubuntu-latest` (fallback; needs minutes) |
| `["self-hosted","linux","mandalika"]` | the GCP VM below |
| `"ubuntu-latest"` (a JSON string, quotes included) | GitHub-hosted, explicitly |

Set on both repos: `gh variable set CI_RUNS_ON -R <owner/repo> --body '["self-hosted","linux","mandalika"]'`.
**Fall back** with `gh variable delete CI_RUNS_ON -R <owner/repo>` (per repo, takes effect on the next run).
Branches cut before this change still say `runs-on: ubuntu-latest`: rebase them onto `prod-hardening` to use the VM.
`android-release.yml` calls the gate workflows too, so it follows the variable; its own `build` job stays GitHub-hosted
(it needs the signing secrets, which must never reach the VM).

## The VM (`mandalika-ci-runner`, project `mandalika-pos`, `asia-southeast2-a`)

- e2-standard-4 (4 vCPU / 16 GB), 100 GB pd-balanced, on-demand, Ubuntu 24.04, shielded VM, own VPC `ci-runner-net`.
- No external ingress: the only firewall rule is IAP SSH. Own service account `ci-runner@` with **no roles and no scopes**;
  jobs are also blocked from the metadata server. No workflow in the gate path uses a secret (only `android-release.yml`'s
  `build` job does, and it is not on the VM), so the VM holds no production credential.
- Four runner processes (2 per repo: `origin-1/2` for `Epheyy/mandalika-pos`, `mirror-1/2` for `mandalika-ci/mandalika-pos-ci`),
  labels `self-hosted, linux, mandalika`, systemd `mandalika-runner@<instance>`. They are persistent (not ephemeral) so no
  GitHub credential needs to live on the VM; a job hook wipes the workspace before and after every job.
- Host-wide locks: the Postgres gate (`flock /tmp/mandalika-ci-postgres.lock`, fixed ports 26439-26479) and the browser gate
  (`/tmp/mandalika-ci-browser.lock`, ports 5183/5184) serialise across all four runners and both repos; the other gates run in
  parallel. Job timeouts include the lock wait.
- A systemd timer powers the VM off after 30 minutes with no running job (a stopped VM costs only its disk).

## Operating it

```sh
scripts/ci/runner-up.sh            # start the VM and wait until runners are online in both repos (run before pushing gate/<name>)
scripts/ci/runner-up.sh --status   # report only
```

One-time setup / rebuild (needs project owner): `scripts/ci/runner-create-vm.sh`, wait ~5 min for first boot,
`scripts/ci/runner-register.sh` (registration tokens via `gh api`, sent over IAP SSH on stdin, never stored or printed),
`scripts/ci/runner-budget.sh <billing-account-id>`. The mirror is switched exactly like origin: set/delete `CI_RUNS_ON` on
`mandalika-ci/mandalika-pos-ci`. Auto-start from a webhook is NOT built (follow-up: Cloud Function + `workflow_job` webhook).

## Dedupe rules

`push` triggers only on `prod-hardening` and `gate/**`; PR pushes run once via `pull_request`. PR runs cancel the superseded
run of the same PR (`cancel-in-progress`); push and gate runs never cancel. Docs-only PRs (`**/*.md`) skip the gates, push runs
never skip, so `require-green-ci.sh` (newest PUSH run per workflow for the sha) is unchanged: a release sha must have been pushed
to `prod-hardening` or a `gate/<name>` branch. Branch protection is unavailable on these private free-plan repos (API 403), so
no check is "required" and skipping docs-only PRs cannot block a merge.
