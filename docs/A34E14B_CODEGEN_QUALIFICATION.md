# A34e14b coupled codegen qualification — not promoted

A34E14B-CODEGEN-20260924-01; AUTH-MANDALIKA-20260919-01.
Decision CG-A34E14-KIN-OPENAPI-20260924-01-R1. Active source remains
63c74711ecb5f5a26641c748f324d2ff72c8a67d, audit/hosted-proof-20260922.

## Result and material contract boundary

The owned generator2.7.2 / kin0.149.0 / runtime1.4.2 graph builds, runs the actual
project generator and passes whole-document validation of the unchanged OpenAPI3.1
source. Two generations match exactly. Decoded embedded documents are semantically
equal to accepted output; TypeScript regeneration is byte-identical. The old2.4.1
compiler failure was not repeated against kin0.149.0.

Raw generated diff and Go AST inventory identify 1467 unchanged declarations,
298 changed,54 added and2 removed imports. Common function types remain except
GetSwagger's cosmetic removal of named return values. Other changes are grouped,
not hidden by whitespace filtering:

- Five fields change from pointers to nullable.Nullable: both letterheads in
  Transfer and IngredientTransfer, and SyncItemResult.Transfer. An explicit JSON
  null round trip formerly omitted the property; the new type preserves null.
  Absent and object-valued controls agree. These are public Go type/serialization
  changes, not cosmetic output. Actual read repositories use both transfer types;
  normal detail SQL builds letterhead objects and lists may omit them. No live null
  response defect is claimed. The sync service retains a separate pointer result.
- Six generated strict adapters (OpenShift, CloseShift, CompleteStockCount, Logout,
  RestoreRecipeVersion, SignUpload) now allow EOF on schema-optional bodies and
  dispatch nil Body. The old adapter rejected EOF. A real generated OpenShift
  comparison proves the difference; no handwritten shift route or S0d guard changed.
- StrictHandlerFunc/StrictMiddlewareFunc become named function types instead of
  aliases; BearerAuthScopes gains a private typed key. No uses of those generated
  adapters/keys outside generated source were found in current production wiring.
- Parameter wrappers pass Type/Format options and map required errors explicitly;
  response writers encode to a buffer before publishing status;48 enum Valid methods
  and two spec helpers are added; embedded gzip changes to flate. Benign binding/
  response controls and embedded semantics pass. Error-path equivalence for every
  buffered response and all public Go assignability is not claimed.

The review states that contract-changing differences block promotion. These
differences therefore remain KB-BLOCK-01 despite build/test success. No source
spec rewrite, generated hand patch, global nullable disable, custom backport or
silent2.8.x/runtime1.6 migration was used. Active source and graph remain unchanged.

## Loader boundary and incomplete work

The natural2.7.2 generator accepts the unused KO-OBS-02 unresolved reference and
panics on a reachable endpoint variant. Ordinary missing refs fail explicitly and
a valid recursive schema generates successfully. Supported load+Validate rejects
both unresolved fixtures and accepts the entire current3.1 spec. No suppression,
blanket cycle rejection, NoopAuthenticationFunc or unsafe ZIP decoder was added.

This proves a narrow validation guard is feasible; it does not prove integration
or atomic publication. A canonical guard, preserved output on failure/timeout/
cancellation and a mandatory declared passing lane are NOT implemented after the
material contract stop. KB09/11/14 remain incomplete. Original A34e14 loader-only
12/1 evidence is preserved and remains a failing characterization. The same source
again yields12pass/1loader observation in the coupled graph with zero skips.

Initial generation used CLI -o alongside config.output; this publisher prioritizes
the config, so initial successes wrote only inside the detached source copy. The
result was preserved, accepted source never touched, and repeat generation used
an owned config copy changing output path only. This setup issue is separate from
the contract differences. Initial enum/server injection fixtures did not emit the
target feature; corrected named enum/server-urls fixtures and original records are
kept. No expectations were weakened to declare a non-exercised feature covered.

## Graph and publisher security

Official exact module ZIPs, sumdb h1/go.mod checksums, SHA256, origins, manifests,
licenses and selected archive-matched source are retained for all three candidates.
The linked generator binary confirms2.7.2 + kin0.149.0 on Go1.26.8.31 selected module
movements are enumerated with old/new requiring edges. The generator adds the
Speakeasy openapi/jsonpath and go.yaml.in/yaml graph; kin adds oasdiff YAML/JSON-Schema
and jsonpointer/jsonname; runtime1.4.2 moves its Iris and related module graph.
Those graph/test modules are distinguished from actual production imports.
x/errors' test-graph selected version relaxes when an old parent edge disappears;
accepted x/mod0.40/x/tools0.49/crypto0.56/text0.41 remain. No broad updater/replace.
This is an unpromoted qualification graph, not a claimed final tidied migration;
old explicit indirect requirements remain visible and must be minimized before
eventual adoption, not silently dropped from inventory.

Fresh primary sources retain the three named generator injection advisories and
the later GHSA-9c2f-gr95-7wqw x-go-type-import record (imprecise HEAD range). Two
named injection records return OSV404; the publisher release says2.7.2 fixes them
while individual patched fields are blank. These conflicts remain unresolved feed
evidence, not exceptions. Current source contains no x-go-type-import extension.
Inert quote/newline/sentinel fixtures are generated then parsed: marker occurrences
remain strings/comments and no init/process import is added. No generated hostile
init/route code was compiled/executed. Server-urls is an isolated template surface,
not a production feature newly enabled by this task.

Full active canonical scan remains14raw/12actionable/27report-only/2reviewed/0exceptions.
Detached coupled scan gives6/4/23/2/0, NOT active remediation. Eight blocking kin
records, two moderate kin records and two moderate generator records disappear;
five graph-only findings remain with changed dependency versions. No new IDs.
Full inventories/SBOM/licenses/OSV/raw/assessed data are included.

Supplementary explicit generator-target govulncheck1.8.0 finds27 trace records
across six IDs in the active tool,18 called traces belonging to ONE ID:
GO-2026-6016 (alias GHSA-rjwr-m7qx-3fjr). Candidate generator target reports none.
Do not label18 traces as18 vulnerabilities. The existing baseline collector's
./... call analysis excludes the tool command even though inventory includes its
module. Thus14/12 remains the current canonical output, not a claim that this new
called-tool evidence is already enforced. Under the existing called-finding policy
it requires containment, not an exception. Integrating this target is a next-slice
gate requirement; no threshold change is proposed.

## Verification and safeguards

Qualified Go1.26.8 selected/verified per process before Go operations. Default1.26.2,
global PATH/Go trust/environment and shared caches unchanged; new owned caches only.
No checksum removal, hidden fallback or historical incident-clearance claim.

Candidate build/vet/gofmt and515 ordinary tests pass; the ordinary six opt-in skips
are explicitly separated from six dedicated nativePostgreSQL18.3 fixtures:
142named passes, zero skips, verified loopback/identity/datadir/empty schema/cleanup.
x/mod5 passes. Real generated binding/typed/response fixtures pass19named cases in
each old/candidate graph, covering absent/empty/malformed/present/zero required
parameters, nullable values, Unicode, maps/arrays/unions and response bodies.
Thirteen bounded kin children retain12pass/1loader observation, all reaped and
owned fixture cleanup verified. The hard memory cap precedes the stdin release;
existing time/output/stack limits remain. Owned copies/caches are retained.

Local race unavailable (CGO disabled/no C compiler). Full Node quality/browser and
hosted gates were not rerun after the semantic stop; earlier accepted passes are
historical. All Node families/SheetJS hashes/policies/expiry/empty exceptions are
byte-preserved. No staging, commit, push or new hosted SHA is claimed. Denied prior
installation-copy cleanup and stopped DB cleanup were not retried.

## Consequential review and next bounded work

Q-KB-01: permit an explicit migration of these five nullable public fields and
six optional-body generated adapters (with current handwritten-route behavior
unchanged), or require exact legacy public-type/null/EOF compatibility? Recommend
reviewing the new semantics as a deliberately bounded generator-contract migration:
they align with the declared nullable/optional shapes, but are not equivalent to
the accepted generated API. Do not approve them merely because tests compile.
Exact legacy preservation would need a separately reviewed compatibility design;
no stock flag was found that preserves only these fields without collateral changes.
Keep2.7.2/0.149.0/1.4.2 as the candidate, not an automatic2.8.x/backport.

If that contract migration is accepted, finish canonical load+Validate and atomic
output with frozen input bytes, invalid/missing/recursive/cancellation/timeout
regressions; integrate the declared passing kin boundary lane and generator-target
scanner coverage; minimize required graph edges; verify all app/DB/browser/race
gates and publish only an explicitly staged same-SHA qualified snapshot. No generic
execution authorization is needed; the unresolved decision is semantic compatibility.

31milestones/11findings; all44parents retained; A31 alone resolved. A34/T29,A38/T33,
all original P0 parents and every release gate remain open. E9/E11 stay closed.


## Review disposition — 2026-09-25

CG-A34E14B-CODEGEN-20260925-01-R1 endorses this historical non-promotion and resolves
Q-KB-01 by approving the explicit bounded migration. No milestone is added for this
qualification. A34e14c completes the consumer/guard/tool-scan work; original logs and
old canonical counts remain coverage-limited historical evidence, not current verification.
