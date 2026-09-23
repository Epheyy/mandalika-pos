# Dependency security baseline and gate

Policy: **DEPSEC-INITIAL-20260922**. Authority: AUTH-MANDALIKA-20260919-01,
CG-A34D-HOSTED-PROOF-20260922-01-R1. A34/A38 remain open.

The reusable `dependency-security.yml` runs on every push, PR and workflow call,
checks out the caller SHA, and receives no provider/signing secrets. A failed or
unavailable scan fails the job. This gate does not deploy or dispatch Android.
Android's existing four prerequisites remain unchanged until the dependency
baseline is clean or exact reviewed exceptions exist, as required by the review.

## Contract

`scripts/ci/dependency-policy.json` records the initial technical policy. High/Critical
runtime/build/CI findings, known malicious/compromised/exploited paths, called Go
symbols and unknown production classifications block. Moderate/Low is report-only
unless exploitation/reachability evidence elevates it. A JSON-mode govulncheck
exit of zero is not evidence of absence: finding/call messages are parsed.

License classification completeness blocks missing, unknown, custom-unreviewed,
unparseable or missing referenced terms for runtime/build dependencies. There is
no invented license-family deny list. Named SPDX expressions are reported for
policy review, not organizational approval. Multiple detected Go terms are
conservatively represented with AND; upstream npm declarations remain unchanged.

The checked-in exceptions register starts empty. Its JSON schema documents the
shape; the Python validator additionally checks exact package/advisory/scope/
reachability, semver range, dates, accountable review and matching evidence.
Expired, unmatched, broad `*`, malformed or duplicate exceptions fail. No scan
automatically creates an exception. Review references are recorded evidence;
enforcement of who may approve repository changes is separate branch policy.

## Evidence and reproducibility

The pnpm 9.15.0 lock graph covers every workspace, direct/transitive component,
optional platform package and root/transitive edge. Production roots are runtime;
build/test/validation roots are build. One witness path per workspace/scope and
all graph edges are retained. This deliberately does not claim JavaScript symbol
reachability. Local workspace packages are represented by importers, separately
from third-party packages. Lifecycle scripts are recorded from exact tarballs;
the dependency workflow installs with `--ignore-scripts`.

Exact npm tarballs must match lock integrity and package name/version. Public
metadata, license-file hashes and advisory data are collected without executing
package contents. Go inventory covers the selected module graph, checksums,
source/test/codegen import evidence and toolchain license. Modules present only
in the graph are development-only; runtime and executed codegen modules retain
their distinct scope. Source scans use Go 1.26.8 and govulncheck v1.8.0. License
text classification uses licenseclassifier v2.0.0, including standard headers.

The custom CycloneDX 1.6 generator is version 1.0.0, checked in with the gate.
Node and Go SBOMs preserve component identities, purls, versions, terms, scope and
graph edges. Graph/hash identities are stable; collection timestamps intentionally
change. The Go graph records minimum requirements; SBOM edges target selected MVS
versions. Scanner versions are recorded; scanner-tool transitive supply-chain
qualification is not represented as complete application-module reachability.

Fresh npm advisory, OSV and CISA KEV responses are retained with payload hashes and
generation time. These are live databases, not immutable advisory snapshots.
Unavailable providers, malformed output, unpinned tools, unresolved graph edges,
incomplete OSV pages or changing dependency inputs fail closed. A scan cannot
establish absence of undisclosed malware. No application `.env` or live DB is used.

PR protection compares exact base/head lock identities, integrity and vendor provenance
hashes and applies the reviewed vulnerability and license delta policy. Registry-to-file
and same-version/different-distribution changes remain visible. It supplements the full baseline.
Go changes always receive the full module/reachability scan; a separate Go PR
delta classifier is not implemented.

## Running and reviewing

Run `python scripts/ci/dependency_vendor.py` before installing the frozen lockfile;
put the two pinned Go scanner binaries on PATH. Run
`python scripts/ci/dependency_security_test.py` and
`python scripts/ci/dependency_vendor_test.py`, then
`python scripts/ci/dependency_security.py scan --sha <40-character-HEAD> --output <new-directory>`.
For a PR add `--delta-base <exact-base-SHA>`. Source must be the specified checkout.
`--evidence` replays already captured evidence for review/testing; hosted CI never
uses it. Exit 0 means policy pass, 1 means retained policy blockers, 2 means an
invalid/incomplete scan. None implies production readiness or legal approval.

All uploadable JSON is checked before any artifact is published. Credential
markers, common tokens, private keys and credential URLs cause rejection without
printing the value. Raw command stderr, environment, caches and source contents
are not uploaded. This narrow artifact safeguard is not A37 continuous/history
secret scanning. Output directories cannot be reused or mixed.

The CLI policy proofs run in disposable copies and check active source hashes.
They cover severity, exploitation, Go called findings, report-only behavior,
licenses, exact/expired/unrelated exceptions, PR deltas and credential rejection.
Full A34/T29, A38, A37, A13/A42 concurrency, A35 provenance and release gates remain
open until their separate acceptance requirements are met.

## Reviewed local distributions (A34e3)

The Backoffice installs `xlsx` / `0.20.3` from the explicitly pinned official
`vendor/sheetjs/xlsx-0.20.3.tgz`. The adjacent provenance records HTTPS source,
retrieval time, bytes, SHA-256, SRI, original manifest and actual license-file
hashes. This is locally pinned evidence, not a publisher signature.

The stdlib pre-install check inspects archive members in memory without extracting
or running them. Repository-vendor path containment, symlinks/junctions, duplicate
paths/manifests, unsafe members, size bounds, manifest/license identity and byte
pins are checked. Frozen pnpm installation independently checks locked integrity.
The collector revalidates all pins against the lock, records actual dependency/
peer metadata and fails unresolved edges. Registry validation remains active.

Inventory and CycloneDX keep `pkg:npm/xlsx@0.20.3`, runtime scope and the ordinary
advisory query, with separate distribution URL/digest/locator properties. Vendor
bytes/provenance, all workspace manifests, lockfile and Go inputs are hashed and
checked for changes during capture. There is no registry fallback for vendor
collection. Missing inputs/provider coverage fail closed. The current package has
no consumer dependency edges; its publisher devDependencies are retained as metadata,
not installed application dependencies. Embedded code is not claimed independently
inventoried by these package-level SBOMs.

The 22 vendor tests supplement the existing policy CLI proofs. Quality and browser
workflows validate vendor bytes before installation; the security job additionally
uses `--ignore-scripts`. Existing advisory overmatches remain blocking under the
unchanged policy until separately reviewed; see A34E3_SHEETJS_REMEDIATION.md.
