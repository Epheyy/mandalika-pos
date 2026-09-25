# A34e14 kin-openapi qualification — candidate not adopted

Reviewed by CG-A34E14-KIN-OPENAPI-20260924-01-R1: qualification and non-promotion
endorsed; remediation remains blocked, no accepted milestone. The historical
compiler failure and loader-only12/1 result below are unchanged. E69 continues
with the separate coupled2.7.2/0.149.0/1.4.2 candidate.

A34E14-KIN-OPENAPI-20260924-01; AUTH-MANDALIKA-20260919-01.
Input CG-A34E13-XMOD-20260924-01-R1. Same worktree and audit/hosted-proof-20260922.
Accepted source remains63c74711ecb5f5a26641c748f324d2ff72c8a67d.

## Outcome and exact blocker

The owned candidate selects kin-openapi0.149.0, but actual `go tool oapi-codegen`
v2.4.1 cannot compile. Its pkg/codegen/schema.go:872 compares discriminator.Mapping's
value directly to element.Ref. The new library's mapping value is MappingRef, not
string. Even `go tool oapi-codegen --version` fails before loading any spec:

```
invalid operation: v == element.Ref (mismatched types openapi3.MappingRef and string)
```

Actual project generation and tiny valid/invalid fixture invocations fail at the
same compile boundary. This is not an invalid input, missing checksum or fixture
setup result. The earlier incomplete candidate's missing go.sum entries were
resolved through the exact openapi3 package requirement; original logs are retained.
The completed graph passes `go mod verify` and application build, but preserved
existing generated files are not proof of successful regeneration.

The active dependency graph is retained byte-for-byte. No generator upgrade,
vendored source patch, replace, module split, changed source spec, regeneration
acceptance, authentication workaround or request middleware was implemented.
No commit/push/hosted candidate run occurs because the scope explicitly requires
qualification before adoption. This turn supplies the exact compatibility blocker.

## Consumer and tool boundaries

The application package graph imports openapi3 through generated internal/api.
Repo-wide source search finds GetSwagger's definition, not an application caller.
Generated GetSwagger loads embedded bytes using a lookup-map URI callback that
rejects unknown paths without a file/HTTP fallback. Its invocation in this packet
is a new isolated test, not proof of production execution. Current middleware
uses the existing handwritten JWT/permission rules; openapi3filter is absent from
the original production/test graph. The new filter imports are qualification-only.

The pinned project generator's util.LoadSwagger uses NewLoader/LoadFromFile for
the current owned contract, with all project refs internal. Its tool graph is
separate from production and from independently installed govulncheck1.8.0 and
licenseclassifier2.0.0. Scanner versions/build info remain unchanged. Candidate
codegen cannot produce a new executable/build-info record; none is fabricated.

Before any Go dependency/tool command, the existing qualified Go1.26.8 executable
was selected and verified through process PATH/GOTOOLCHAIN=local/GOWORK=off.
Its executable hash is recorded. Default local Go1.26.2, global PATH/GOENV and shared
caches are unchanged. Downloads use a new owned cache with normal TLS/public proxy/
sumdb trust. No GOSUMDB disable, checksum deletion, cache wipe or incident clearance.

## Candidate graph, provenance and source coverage

Exact `go get github.com/getkin/kin-openapi@v0.149.0`, then the exact openapi3 package
requirement in the owned copy, selects kin0.149.0 and jsonpointer0.22.5.
Required additions: swag/jsonname v0.25.5, oasdiff/yaml v0.1.1, oasdiff/yaml3 v0.0.14,
jsonschema/v6 v6.0.3, plus graph/test dependencies regexp2 v1.11.0 and
go-openapi/testify/v2 v2.4.0.
The old jsonpointer manifest required kr/pretty0.3.1; removing that edge relaxes
its selected test-only version to0.3.0 (pgx requirement). Old kin's go-internal1.12.0
edge disappears. All requiring edges and old/new module lists are included; these
are transparent candidate changes, not changes to the active graph. Earlier accepted
x/mod0.40/x/tools0.49/crypto0.56/text0.41 remain selected. No broad updater or downgrade
of accepted fixes. A later coupled generator qualification must re-evaluate its graph.

Both official kin archives have h1/go.mod sums, SHA256, VCS origin, exact manifests/
MIT license and archive-matched source witnesses. New support-module identities,
checksums, source paths, declared SPDX evidence and scopes remain in complete scans/
CycloneDX. Standard named licenses are reported, not newly approved by this task.
No exception, ignore rule, feed suppression or hidden package identity.

All14 publisher security records and the four original Go records were retrieved.
The input eight blockers are four GHSA/GO alias families; two additional report-only
records form a fifth alias family. Later NaN/Inf, composition cycles, nil-items and
encoded-path records are retained alongside loader/schema entries. Publisher version
fields have quirks (blank package, open-ended affected intervals plus patched fields,
ZIP boundary discrepancy); raw statements are preserved without a new applicability
rule. Scanner absence alone is not proof that every publisher issue is fixed.

## Bounded tests and remaining loader issue

Final identical harness: old0.127.0 5 pass/8 fail; candidate0.149.0 12 pass/1 fail.
The remaining candidate failure is intentionally retained:

```
components:
  schemas:
    A: {$ref: '#/components/schemas/A/additionalProperties'}
```

LoadFromData returns no error and a SchemaRef with nil Value. A subsequent
`doc.Validate` returns an explicit unresolved-reference error. Old0.127.0 panics
while loading this fixture. The candidate fixes that panic, but the loader alone
still yields a partial result; this does not satisfy the scope's strict no-partial-
success qualification. It is recorded as KO-OBS-02, not declared a new production
vulnerability. Current oapi-codegen's loader path does not itself call Validate;
handling by a prospective successor generator must be qualified before adoption.
The real project document and ordinary missing refs load/fail as expected.

Other groups cover: actual embedded project load; scalars/arrays/maps/Unicode/enums/
local refs/required/optional/nullable/additionalProperties/allOf; malformed and unknown
owned-path refs; public and explicit-denial auth controls plus missing-auth default;
real multipart JSON-part conversion; tiny contiguous/sparse deepObject queries;
a finite ZIP with no automatic unsafe decoder; non-finite values; ordinary recursive
schemas; circular allOf/anyOf/oneOf with unrelated property checks; missing array items;
and in-memory encoded-path auth routing. The old failures do not establish live POS
exploits. In particular, old no-items OAS3.1 behavior is not a support-policy/range ruling.

The multipart final fixture explicitly types its tiny part as application/json,
so old valid input succeeds and malformed input reaches convertParseError's nil-
parameter panic. Initial plain-text integer parsing stopped before that target and
is retained as a fixture mismatch. Initial ZIP expectation confused an opaque binary
fallback with decompression; final nonbinary content distinguishes it. Upstream's
composition visitor may return normally on a cycle; final tests require termination
and retained property validation, not an invented mandatory error. All original
reports/source hashes remain; none of these corrections adds a milestone.

All13 cases run separately in supervised Windows children. An stdin handshake holds
TestMain until the parent attaches a512MiB process-memory JobObject. Timeout15s,
Go test10s, output256KiB, soft Go heap64MiB; cycle cases reduce stack to128KiB.
Old stack failure is bounded at that small limit, not an OOM probe. Fixtures are tiny
and reference callbacks reject unknown paths; no listeners/client network requests,
remote refs, real credentials or cache poisoning. All26 final children are reaped,
owned fixture directories removed, zero timeouts/output overruns/skips. Candidate
and old source hashes agree. Existing x/mod runner remains unmodified.

## Verification and security disposition

Active Go1.26.8 gen-check/gofmt/vet/build pass;515 named ordinary tests pass with six
explicit opt-in integration skips (not counted as DB proof). Six independent native
PostgreSQL18.3 fixtures pass142 named tests withzero skips and strict identity/empty-
schema/datadir/cleanup checks. Local CGO-disabled race remains unavailable; prior
accepted hosted Linux/race at63c7471 is historical evidence, not a new candidate run.
The x/mod exact-five lane and existing JS/TS quality suite pass. Quality uses the
unchanged installed graph (no new frozen reinstall), including accepted family tests,
349 app/package checks, the existing optional Backoffice replay skip, typechecks,
both builds and TS schema drift. Generated Go/TS and source spec hashes stay unchanged.

Fresh active scan:14raw/12actionable/27report-only/2reviewed/0exceptions.
Detached candidate:6raw/4actionable/25report-only/2reviewed/0exceptions. Exactly eight
blocking plus two report-only kin records disappear; unrelated normalized records
are identical. These are measured policy records, not unique exploits or a future
count expectation. The candidate result is NOT an active remediation or clean baseline.
Both scans completed; source-input hashes distinguish committed active inputs from
the detached candidate archive. Full inventories/SBOM/licenses/OSV/govulncheck are kept.
No fresh hosted candidate proof is claimed after the generator blocker.

## Q-KO-01 and smallest next work

Recommend a separate bounded coupled qualification of upstream oapi-codegenv2.7.0
with kin0.149.0. Read-only tagged source shows v2.7.0 uses `v.Ref == element.Ref`;
inspected2.4.1/2.5.0/2.5.1/2.6.0 do not. This is only an identified candidate,
not a compatibility or security certification. Nothing from that generator was
installed or selected. Generated version-header drift is expected; full type/tag/
serialization/OAS3.1 behavior, invalid-reference handling and the resulting graph
must be compared before accepting even cosmetic output changes.

For ChatGPT review: qualify this smallest upstream generator candidate as the next
bounded migration, or require a separately maintained explicit2.4.1 backport if
byte-identical output is essential? Recommend upstream qualification; a backport
adds custom third-party maintenance/provenance burden and is not implemented.
Keep the accepted graph until generated differences and KO-OBS-02 handling are
resolved. Do not substitute an older still-affected kin version to pass compilation.
No generic authorization request; the unresolved issue is the actual generator/API
contract, not standing execution authority.

E66 accepts A34e13:31milestones/11findings, all44 retained, A31 alone resolved.
E67 qualification does not add an acceptance or close A34/A38/release gates.
SheetJS bytes/assessments/2026-10-23 expiry, policy thresholds, empty exception
register, prior work, denied installation-copy targets and stopped DB cleanup remain.
No chi/legal/OpenPGP/password/A14/business/concurrency/signing/deployment/OTA/live work.
