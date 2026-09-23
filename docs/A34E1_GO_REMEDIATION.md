# A34e1 — pgx and x/text remediation

Packet: `A34E1-GO-REMEDIATION-20260922-01`.
Authority: `AUTH-MANDALIKA-20260919-01`.
Review input: `CG-A34E-DEPENDENCY-SECURITY-20260922-01-R1`.
Entry source: `df70dc2f80c1c89f4155f2a7fd1d5e930ad229cc` on
`audit/hosted-proof-20260922`.

## Exact scope and module selection

Only `backend/go.mod` and `backend/go.sum` change executable inputs. No business
source, migrations, generated contracts, workflows, npm lockfile, security policy
or exceptions change. The Go 1.26 directive and code-generator tool declaration
are preserved.

| Module | Before | After | Required by |
| --- | --- | --- | --- |
| github.com/jackc/pgx/v5 | v5.7.1 | v5.9.2 | Explicit minimum fixed target |
| golang.org/x/text | v0.32.0 | v0.39.0 | Explicit minimum fixed target |
| golang.org/x/tools | v0.39.0 | v0.47.0 | x/text v0.39.0 |
| golang.org/x/mod | v0.30.0 | v0.37.0 | x/text and x/tools |
| golang.org/x/sync | v0.19.0 | v0.21.0 | x/text and x/tools |
| golang.org/x/sys | v0.39.0 | v0.46.0 | x/tools v0.47.0 |
| golang.org/x/net | v0.48.0 | v0.56.0 | x/tools v0.47.0; selected graph module |
| golang.org/x/telemetry | v0.0.0-20251111182119-bc8e575c7b54 | v0.0.0-20260625142307-59b4966ccb57 | x/tools v0.47.0; selected graph module |

The graph contains 137 third-party modules before and after. Six requirements in
go.mod change; x/net and x/telemetry are selected transitively without new root
requirements. All 13 added checksum lines refer to selected target/support
versions. No checksum is removed. Read-only `go mod tidy -diff` is retained in
the packet: it proposes pruning old target checksums plus pre-existing JWT/Redis
checksums and adding x/net's module checksum. That broader cleanup is not applied.
The selected graph, generated contract, vet, build and tests work with
`-mod=readonly`; old checksum entries do not select older module versions.

## Dependency policy delta

Fresh local full scans use pinned govulncheck v1.8.0 under Go 1.26.8 and the
unchanged DEPSEC-INITIAL-20260922 policy. govulncheck JSON exits zero even with
findings; actual finding messages, traces and normalized policy records determine
the result.

Called IDs decrease from four to two. `GO-2026-5004` (pgx) and `GO-2026-5970`
(x/text) disappear. Only chi `GO-2026-5775` and `GO-2026-5777` remain called.
No new called finding or policy blocker appears.

All six normalized pgx IDs disappear: `GHSA-9jj7-4m8r-rfcm`,
`GHSA-j88v-2chj-qfwx`, `GHSA-xgrm-4fwx-7qm8`, `GO-2026-4771`,
`GO-2026-4772`, `GO-2026-5004`. The x/text ID also disappears.
The required x/sys movement additionally removes `GO-2026-5024`.
Blocking policy records decrease from 76 to 69; five pgx records, one x/text
record and one x/sys record clear. Advisory aliases are not separate exploit counts.

chi/RealIP, kin-openapi, xlsx and the rgbcolor license blocker remain visible.
The exceptions register remains empty and byte-identical. x/crypto remains at
v0.46.0; no Argon2 password implementation or encoded hash format changes.
The optional x/crypto follow-up is deferred. OpenPGP `GO-2026-5932` remains
module-level evidence, not an application Argon2 call-path finding.

## Verification and limits

Local generated drift, gofmt, vet, build and full Go tests pass under Go 1.26.8.
The ordinary Go run skips the six opt-in database entrypoints; the mandatory
fixture runner must establish their actual named PASS results separately.

Six isolated local PostgreSQL gates PASS with race enabled, 142 named
parent/subtest PASS events, zero skips, and verified fixture/container cleanup.
Final hosted commit `feb0048de2a577bf8e5b2d9243944ce115aa3a29` passes quality, backend,
PostgreSQL and browser. The fresh hosted dependency job completes and correctly
fails on the same 69 records. PostgreSQL Docker/race passes all six gates and 142
named parent/subtests; Chromium passes26/26 with zero skips, zero unexpected
network requests and confirmed cleanup. The current packet lists run URLs.
This result paragraph is an uncommitted report after-image, not an additional
untested executable change. The Windows native fixture attempt failed before tests:
the OS reserves ports 56419–56518, including all six expected fixture ports.
PostgreSQL reports bind permission denied; cleanup verifies removal and closed
port. The test guards and OS reservations are preserved. The default local Docker
published-port attempt encounters the same OS restriction and also cleans up.
A disposable Linux container with no network and no published ports runs the
unchanged native fixture runner, fixed loopback ports, identity checks and race
mode. Its public Go modules come from a local `go mod verify`-checked cache after
the container could not trust the proxy TLS certificate; TLS and checksum
verification are not disabled. Evidence retains each failed attempt.

The current review packet supplies actual commands, exits, raw sanitized results,
module graphs, scanner traces, lifecycle evidence and final same-SHA hosted status.
No A34/T29, A38/T33, P0 parent or release gate closes. ChatGPT review of A34e1
remains pending. See the canonical coverage tracker for all 44 findings.

## Subsequent review disposition — 2026-09-23

CG-A34E1-GO-REMEDIATION-20260922-01-R1 scoped-accepts the above A34e1
checkpoint. This supersedes the earlier review-pending disposition without
changing historical evidence. Full A34/T29, A38/T33 and release gates remain open.
The immediate next slice is A34e2, followed by SheetJS after its review.
