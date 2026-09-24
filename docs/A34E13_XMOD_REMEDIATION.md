# A34e13 x/mod remediation

A34E13-XMOD-20260924-01; AUTH-MANDALIKA-20260919-01.
Entrybc738ace71e2d86f39ff810aa525550d5adabd7d, audit/hosted-proof-20260922.
E64 accepts A34e12 within Windows/Linux/pure-editor limits. E11-REPORT-01 closes
as attribution correction only, original logs preserved; E9 stays closed.30accepted
milestones/11findings. E65 is this implementation, not yet ChatGPT-accepted.
All44parents retained; A31 alone resolved. All8P0 parents/A34/A38/release gates open.

## Module, command, project tool and scanner are separate

Pre-change production and existing test package graphs import no x/mod package.
Actual `go tool oapi-codegen` v2.4.1 -> codegen -> x/tools/imports -> internal/imports
uses x/mod/module and semver (plus internal lazyregexp), with source call witnesses.
No sumdb/tlog import or call is established in those consumers. modfile is an extra
small API control in the new test harness, not a claimed linked generator package.
The new regression package is test-only; no production import manufactures reachability.

The default local Go executable is1.26.2, contrary to extending the prior hosted
1.26.8 observation to this machine's default PATH. The independent pinned govulncheck
v1.8.0 binary is built by1.26.8 and has its own x/mod0.41.0/x/tools0.50.0 graph.
The independent licenseclassifierv2.0.0 binary is built by1.26.8 and does not list
x/mod. Their binary hashes/build info and the project tool's before/after build info
are separate. No scanner was rebuilt or pin changed by this slice.

An existing cached Go1.26.8 executable was selected only through child-process PATH/
GOTOOLCHAIN settings. No toolchain installed, global executable replaced, persistent
Go environment changed or cmd/go-upgrade claim. Initial isolated downloads made by
the default command were preserved. A new separate cache using1.26.8 independently
downloaded the same official versions with normal TLS/proxy/sumdb verification;
module/go.mod checksums and archive SHA256 agree. All subsequent project compilation,
generation and local database checks use that patched executable. The ordinary
default remains1.26.2; the new bounded runner rejects it and requires >=1.26.6.
This local default remains a disclosed environment follow-up, not a silently fixed
executable. Hosted1.26.8 already exceeds the advisories'1.26.6 fixed boundary.

## Required graph and integrity evidence

Exact `go get golang.org/x/mod@v0.40.0` in an owned source copy selects:
- x/mod0.38.0->0.40.0, requested fixed minimum;
- x/tools0.48.0->0.49.0, exact minimum required by x/mod0.40.0;
- x/net0.57.0->0.58.0, x/tools0.49.0 requirement;
- telemetry20260708-49f421fb7959->20260811-a038080d80e5, x/tools requirement.

Only mod/tools requirements move in go.mod. x/mod's indirect marker becomes a
comment explicitly describing test-only direct use plus codegen. Five new go.sum
lines cover the required downloaded versions; historical sums remain intact and
are not treated as selected versions. Complete before/after JSON module lists,
graphs and requiring edges document all four selected movements. No replace/exclude,
broad update, oapi/chi/kin-openapi/x-crypto/x-text version change or policy alteration.
Go directive remains1.26.0; candidate/upstream minimumGo1.25.0 is compatible.

Official Go vulnerability JSON, module info/manifests/retractions, VCS tag commit,
h1 checksums, archive SHA256 and exact source files are recorded. x/mod old/new ZIPs
are included; larger support/tool/cache binaries are represented by provenance and
hashes. Downloads/collection are distinct from the offline regression phase.
Authenticated checksum authority stays sum.golang.org; no GOSUMDB disable, trust
expansion, real proxy poisoning, global cache clear or active checksum/vendor deletion.
`go mod verify` passes in the owned clean cache. It is not historical incident
clearance; no checksum discrepancy was erased or accepted.

## Offline library regressions

Same five-test Go source links the actually selected old/candidate/active library.
Old0.38.0: three positive controls pass; exactly two behavioral failures. The lookup
case returns unauthenticated unrelated hash text as authority; the tile case accepts
a tampered leaf without authenticating its parent. Neither is a compiler/fixture/
version-assertion failure. Fixed0.40.0: all5pass. Both use the same patched compiler.

Lookup fixture uses one record, an in-memory signed tree and deterministic synthetic
key generated in memory; no key is persisted/logged. Unrelated hash text sits outside
the authenticated record. Fixed public Client.Lookup returns no unrelated hashes on
first lookup, repeated lookup and reconstructed cache; valid authenticated lookup
succeeds. All ClientOps are maps with locking and fail on unknown paths; no network
or filesystem cache implementation/fallback exists.

Tile fixture uses15leaves/height2 and public tlog APIs. Valid full-tree hashes match
known stored values and tiles are saved. A zeroed leaf in a child tile with unchanged
parent/root must fail as inconsistent, publish no hashes and save no tiles. This
reproduces the upstream subtree-count/unique-tile-count boundary without copying
unexported internals. Module path/major/escape and semver controls reflect tool APIs;
modfile valid/malformed/format controls are additional test-only library coverage.

Fixtures are <64KiB. The checked-in supervisor bounds compilation240s/1MiB output
and execution20s/256KiB output, with Go test10s timeout and soft heap target64MiB.
Windows uses an owned JobObject process-commit limit512MiB, attached immediately
after launch (trusted bootstrap precedes attachment). Linux uses child address-space
4GiB/CPU15s caps. This bounded lane is non-race; full backend race separately runs
the tests without incorrectly constraining TSan shadow mappings. Owned processes
are reaped and only their verified temporary binary directory is removed. No public
proxy/remote share/service, giant/OOM probe, global OS setting or production data.

The backend workflow now also requires this bounded five-case lane. Missing/skipped
or failed expected tests fail it. Existing gen/vet/fmt/build/race steps remain.

## Actual consumer and application compatibility

Real project `make gen-check` invokes `go tool oapi-codegen` v2.4.1 with unchanged
OpenAPI/config; generated Go output is byte-identical. Separate old/fixed project
tool runs on a tiny local-reference/Unicode/typed fixture yield identical Go bytes;
a missing local reference fails both. An initial empty-path fixture was correctly
pruned as unused by oapi-codegen; it is retained as setup evidence, not a dependency
regression. The corrected fixture references the model from an actual endpoint.
No real remote reference or production credential is read by the synthetic tests.

LocalGo1.26.8: gen-check, gofmt, vet, build and ordinary tests pass. Ordinary opt-in
integration skips remain explicit and do not qualify PostgreSQL. All six mandatory
nativePostgreSQL18.3 fixtures independently pass142named tests with0skips, strict
identity/empty-schema/data-directory checks and confirmed owned cleanup. Local
CGO_ENABLED=0/no C compiler means no local race; hosted Linux race is required.
Node quality serial rerun passes349app/package checks, one existing optional replay
skip, all accepted family tests/types/builds/TS schema drift. One initial XML
capacitor-helper5s timeout under
concurrent cold Go compilation is preserved; no harness or timeout was weakened.
The unchanged gate passed serially after concurrent Go work completed. This supports
a transient timeout characterization; no definitive CPU-contention cause is claimed.

## Security delta and preservation

Fresh baseline16raw/14actionable/27report-only becomes14raw/12actionable/27report-only;
reviewed2/exception0 unchanged. Only GO-2026-6179 and GO-2026-6180 records disappear.
Both were module-level OSV matches; neither is present as a finding in before/after
pinned govulncheck symbol streams. No new or changed unrelated normalized finding.
Inventories, licenses, CycloneDX, exact-version OSV queries and selected support edges
remain complete. Raw evidence retained; no suppression, severity change or fixed
future-count assumption. No demonstrated runtime POS exploit is claimed.

All accepted Node versions/harnesses, Vite8.0.16/PostCSS8.5.23/NanoID3.3.18,
SheetJS bytes/provenance/two assessments/2026-10-23 deadline, policy thresholds and
empty exception register are byte-preserved. Password compatibility tests remain
in the ordinary suite; no runtime crypto/text version changes. Native Android,
A13/A42 concurrency, A35 provenance, A37 scanning, chi trust/kin-openapi/legal/
OpenPGP/password/A14/business policy remain separate. All release gates stay open.
Previously denied installation-copy deletions/stopped DB cleanup untouched; new
source/cache copies retained. No signing/deployment/OTA/live-data operation.

## Current validation boundary

Hosted same-SHA quality/backend/race/PostgreSQL/browser and fresh security are
pending. The final packet supplies actual results, exact staged manifest/tree,
no-deployment trigger audit, source/input hashes and all commands/limits. Scoped
A34e13 review remains pending; no parent or release acceptance inferred.
