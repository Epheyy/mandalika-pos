# A34e14 — kin-openapi consumer qualification and bounded remediation

Scope: **A34E14-KIN-OPENAPI-20260924-01**
Input review: **CG-A34E13-XMOD-20260924-01-R1**
Authority: **AUTH-MANDALIKA-20260919-01**

## Objective and decision boundary

Qualify and remediate the selected `github.com/getkin/kin-openapi v0.127.0` without
silently changing generated API contracts, authentication, request validation, supported
schema meaning or business behavior.

Start with candidate **v0.149.0**, the publisher release returned during this review.
Refresh primary advisories and actual module metadata before deciding the exact target.
This is a **0.x API migration qualification**, not an assumed drop-in patch. Do not select
v0.144.0 solely because it clears the original four-family list while ignoring later
loader/schema findings. Conversely, do not assume the latest tag fixes every issue.

Do the bounded compatibility investigation and, when it passes, implementation and hosted
proof **in the same turn**. If a material incompatibility or unverified candidate blocks
safe promotion, preserve the active accepted graph and return the exact failing API/spec,
minimal options and recommendation. No generic permission request and no broad upgrade
campaign merely to make CI green.

## 1. Entry, toolchain and actual consumers

Record the actual entry SHA/worktree, current modules and source hashes. Use the existing
qualified Go 1.26.8 executable per process before Go network/build/tool commands; default
local 1.26.2 is not qualified for this work. Record path, version, GOTOOLCHAIN/workspace
selection and actual project-tool build info. Do not alter global environment/trust.

Inventory separately:
- production package graph and actual calls;
- generated internal/api and its GetSwagger/load helpers, whether invoked or merely linked;
- `go tool oapi-codegen` pinned project executable and its dependencies;
- existing tests and any new test-only openapi3filter imports;
- independent scanners/tool graphs (do not upgrade them incidentally).

The input inventory identifies `openapi3` imports in internal/api and oapi-codegen codegen/
util. It does not establish execution of request/response validation middleware. Trace the
real source rather than assuming all module packages are application-reachable.

## 2. Advisory map

Retain all raw IDs/aliases and distinguish module-present, package-imported, called and
synthetic-test-only evidence. The input eight blocking records are four families:

| Family | Existing ID pair | Input fixed boundary |
|---|---|---:|
| ZIP body amplification | GHSA-wq9g-9vfc-cfq9 / GO-2025-3533 | v0.131.0 |
| Parse-error conversion panic | GHSA-mmfr-pmjx-hw9w / GO-2026-6274 | v0.141.0 |
| Sparse deepObject allocation | GHSA-xhj3-7xw9-vr34 / GO-2026-6275 | v0.142.0 |
| Default Noop authentication | GHSA-r277-6w6q-xmqw / GO-2026-6095 | v0.144.0 |

These boundaries are from the input scan and must be refreshed, not treated as a complete
current advisory inventory. Preserve the existing report-only records too.

Compare publisher security entries, Go advisory records and exact candidate scan output.
The review found additional publisher index entries including GHSA-rj39-cv6w-8wv7,
GHSA-g8cf-rcjf-c8cf, GHSA-vrcc-3ch7-hppw and GHSA-23vg-4cjm-66q5. The index alone does not
prove affected/fixed ranges. Fetch their actual primary records/patches; retain an explicit
unresolved-source record when unavailable. Do not claim they are fixed from a tag number
or from absence in a scanner feed. Any newly applicable High/Critical issue must be reported,
not omitted because it was absent from the archived baseline.

No new applicability annotation, exception, package reclassification or severity downgrade
is authorized by this scope. Remediation must not make a package disappear from scanning.

## 3. Smallest compatible graph

In an owned candidate copy, update only kin-openapi and graph-required dependencies.
Enumerate every selected version/package addition/removal with requiring edges.

The reviewed v0.149.0 manifest includes new oasdiff YAML/YAML3 and jsonschema/v6 paths,
updated jsonpointer and other supporting modules. Account for their schema behavior,
licenses, provenance, advisories and Go requirements. Keep newer accepted x/mod/x/tools/
crypto/text modules selected when MVS requires them; do not downgrade earlier fixes.

Do not use a broad `go get -u ./...`, incompatible replace, hidden vendor source edit,
module split or removing a dependency just to hide its advisories.

First test existing oapi-codegen **v2.4.1**. Do not automatically upgrade the generator,
rewrite its templates, change the source OpenAPI contract or adopt new request middleware.
A narrowly mechanical adaptation to a changed library API is permissible only when its
behavior is demonstrably equivalent and existing generated/client contract bytes and tests
remain correct. If generator API compatibility or generated serialization requires a
material change, return the precise dependent issue and a minimal versioned plan rather
than undertaking that redesign inside this slice.

## 4. Contract preservation and real consumer checks

Run the actual pinned project tool, not an independently installed latest executable.
Capture the current generated Go and TypeScript contract hashes before touching the graph.

Qualify:
- exact project OpenAPI document load, references and generation;
- no unsolicited HTTP/file reference resolution; allow only owned local fixtures;
- typed synthetic specs exercising scalars, arrays/maps, Unicode, enums, local refs,
  required/optional/nullable fields and supported additionalProperties/composition;
- omitted vs null behavior and stable JSON tags/types/zero-value treatment;
- malformed/unresolved references produce explicit errors, not partial success;
- existing application handlers and generated wrappers still compile and behave the same.

The project uses an OpenAPI contract whose earlier generator has known support limits.
Do not 'repair' it by converting OpenAPI 3.1 to 3.0, removing unsupported keywords, changing
nullability/security declarations, weakening validation or accepting material codegen drift.
Log genuine dependency-induced differences separately. Cosmetic output drift, if any,
must be explained and reviewed; an unchanged-file drift gate is not permission to overwrite
its expected file before comparison.

Do not add kin-openapi validation to production request handling merely to exercise it.
Existing JWT, permissions, direct/batch errors, custom payment IDs and sales semantics must
remain governed by the accepted application code. Never wire NoopAuthenticationFunc as a
workaround for a new default-authentication error.

## 5. Bounded security qualification

Use tiny offline synthetic inputs against authentic old/candidate libraries. Place risky
old-version cases in supervised separate processes; a Go stack overflow is not recoverable
with ordinary panic recovery. External deadlines, output caps and effective memory controls
must be established before a risky case. If a safe old probe cannot be bounded, use primary
patch/source evidence and label the runtime limit instead of executing an OOM/crash demo.

Suggested minimal vectors, tailored to the verified published APIs:
- a tiny signed/typed spec and local-reference positive controls;
- a synthetic protected-operation handler without an authentication callback, alongside an
  explicit rejecting callback and a public-operation control. Test library behavior only;
  never contact a live endpoint or change the app's auth stack;
- finite malformed multipart/parameter conversion reproducing the relevant error path;
- a small sparse/deepObject boundary or configurable small limit where genuinely available,
  plus exact-source proof of upper-bound checking. No huge allocation indices or large arrays;
- removed/disabled unsafe ZIP decoder registration or safe decoding limits as actually fixed
  upstream. Use a tiny finite archive; do not re-register a removed unsafe decoder to get a
  compatibility pass and do not use a decompression bomb;
- any newly verified loader/schema finding that affects the chosen consumer: tiny cycle/
  unsupported-type fixtures in isolated workers with positive acyclic controls.

Do not require a throw where the fixed library returns an error, removes an unsafe default,
or explicitly rejects an unsupported format. Distinguish real behavior checks from source
structure assertions. No fake 'N vulnerabilities fixed' count from N test assertions.

Keep all test artifacts in an owned nonsymlink fixture tree, reject unknown reference paths
with no fallback, and clean only verified owned tiny fixtures/processes. No external proxy,
credentials, remote references, real database mutation or shared-cache changes.

## 6. Verification gates and scanner evidence

Integrate useful deterministic new tests into the existing mandatory backend baseline
without weakening the x/mod runner's exact-five-test/skip checks. New tests should not share
its TestXMod prefix; give them their own exact declared set or an equivalent fail-closed lane.

Run locally with the qualified compiler:
- actual generator and contract-hash/drift comparison;
- gofmt, vet, build, ordinary Go tests;
- existing bounded x/mod five-test lane;
- new kin-openapi consumer/security checks;
- all six dedicated PostgreSQL gates (ordinary opt-in skips are not their substitute);
- exact candidate full dependency inventory, SBOM, licenses and advisory/reachability scan.

Preserve all Node/application gates, SheetJS bytes/provenance/two assessments and
2026-10-23 deadline, thresholds and the empty exception register. Adding Go modules must
retain license/advisory evidence; unfamiliar terms remain blocked or explicitly reviewed,
not silently approved.

On a qualified candidate, explicitly stage only this implementation and sanitized canonical
docs. Keep [CF-Pages-Skip] and verification-branch exclusions; recheck current triggers.
Commit/push normally on `audit/hosted-proof-20260922`; no force push or release/deploy.
Require quality/backend/PostgreSQL/browser success on one final SHA plus a completed fresh
security assessment. The security job may stay red for unrelated or newly identified
blockers. Do not hardcode a future remaining count or edit expectations to erase a finding.

## 7. KO01–KO18 acceptance matrix

| ID | Required evidence |
|---|---|
| KO01 | Entry SHA, explicit scope, verified process Go/toolchain before downloads/builds; default-local limitation retained. |
| KO02 | Actual production/generated/tool/test/scanner import and call inventory, including whether filter/loader helpers run. |
| KO03 | Official candidate provenance, module hashes/licenses, refreshed primary advisories and explicit source gaps. |
| KO04 | All selected graph movements explained; no unrelated update, downgrade, replace or hidden scanner loss. |
| KO05 | Existing project generator compatibility established before active adoption; exact error evidence if incompatible. |
| KO06 | Actual project Go/TS contract comparison; no silent spec or generated behavior change. |
| KO07 | Independent benign typed/nullable/reference/Unicode fixtures preserve intended output/serialization. |
| KO08 | Invalid/local-reference handling remains explicit and no unplanned network or outside-file access occurs. |
| KO09 | Applicable auth-default behavior qualified synthetically; production auth/permissions untouched. |
| KO10 | Bounded multipart/deepObject/decoder regressions or precisely labelled source-supported limits. |
| KO11 | Later relevant loader/schema issues assessed; no blanket latest-tag or scanner-absence safety claim. |
| KO12 | Same harness old/fixed comparison where feasible; setup/timeout/source assertions distinguished from behavioral regressions. |
| KO13 | Worker/fixture limits and cleanup verified; no risky in-process full-suite crash, live target or cache poisoning. |
| KO14 | Earlier x/mod5, Node families, schemas and application tests remain effective; no skip/guard weakening. |
| KO15 | Full raw/assessed/SBOM/license evidence with exact advisory/alias delta; no exception or new policy annotation. |
| KO16 | Six dedicated PG gates and ordinary backend/race evidence retain actual identities/results and platform limits. |
| KO17 | Four green hosted application gates plus completed fresh security on the same final SHA, or exact candidate blocker before promotion. |
| KO18 | Explicit staging/provenance, all44 tracker preservation, no-deployment controls, historical evidence and denied cleanup retained. |

## 8. Boundaries and return

No chi ingress migration, rgbcolor approval, OpenPGP classification change, password parser
hardening, A14 imports, A13/A42 concurrency redesign, global Go upgrade, signing/OTA,
deployment or live data. Existing authority covers routine engineering; a genuine contract
or publisher-evidence gap is a technical stop condition, not a permission question.

Return one current packet and compact ZIP with exact diff, KO matrix, provenance/graphs,
actual consumer and generated-contract comparison, bounded regression source/results,
raw/assessed exact-ID deltas, hosted same-SHA evidence when qualified, tracker/progress
changes and manifest. A material compatibility failure should include the minimal failing
fixture/API and ranked remediation options. Do not promote an unqualified graph for a
milestone count. Full A34/A38 and release gates remain open.
