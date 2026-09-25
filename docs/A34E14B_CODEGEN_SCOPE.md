# A34e14b — coupled upstream generator/library qualification

Scope ID: **A34E14B-CODEGEN-20260924-01**
Decision: **CG-A34E14-KIN-OPENAPI-20260924-01-R1**

## Objective and allowed scope

Make regeneration compatible with a remediated kin-openapi without losing API correctness,
required-parameter checks, or safe spec handling. Initial detached candidate:

- `github.com/oapi-codegen/oapi-codegen/v2 v2.7.2`
- `github.com/getkin/kin-openapi v0.149.0`
- `github.com/oapi-codegen/runtime v1.4.2`

Allowed supporting changes are MVS-required dependencies, minimal canonical codegen/CI
wiring, a narrowly justified build-time validation/output guard, generated code that passes
the contract policy, and focused tests/docs. No custom library/generator backport, arbitrary
`replace`, broad upgrade, spec rewrite, or production middleware redesign.

## Phase1 — qualify outside the accepted graph

Select and verify the existing Go1.26.8 executable before downloads/builds. Record its path,
version and hash plus the independent scanner versions. Preserve global PATH, go env,
checksum/proxy trust, shared caches, and default Go1.26.2 as a disclosed separate follow-up.

Use a fresh owned detached copy and controlled cache. Reuse the valid A34e14 compiler failure
evidence; do not repeat every known-broken old generator/spec combination. Verify the new
candidate binary's actual module build info, not only the version requested in go.mod.

Inventory all MVS changes, licenses, module origins/checksums and retained fixed modules.
The generator's overlay-library migration is real supporting work, not grounds to silently
upgrade unrelated business modules. Tools, runtime and test-only graphs stay separate.

## Phase2 — generation and contract comparison

Run the existing project config/spec through the candidate tool to an owned staging output,
not directly over `internal/api/api.gen.go`. Record raw old/new outputs and deterministic
repeat-generation hashes. Compare generated declarations/AST/types/tags and behavior.

Required axes:
- exported type/interface/function names and consumers;
- JSON names, required/optional fields, absent/null/zero and nullable wrapper semantics;
- arrays/maps, additionalProperties, enum values, discriminator and composition behavior;
- path/query/header/cookie binding and missing/malformed required input;
- status/content-type/response writer behavior;
- strict/chi generated adapters and embedded spec;
- security-context constants/usage without modifying actual authorization;
- real application compile and unchanged TypeScript contract generation.

Cosmetic comments/version strings/formatting are not automatic blockers. Semantic changes
are not cosmetic because tests compile. Preserve all raw diffs; allow only individually
explained equivalent changes with targeted proof. No `git diff -w` as sole contract check.

If the candidate needs a runtime API newer than1.4.2, identify the exact symbol/graph and
return evidence before a broader runtime migration. Do not assume generator dependencies
automatically establish the minimum runtime used by the application.

## Phase3 — loader safety and atomic publication

Preserve the exact KO-OBS-02 fixture and historical12/1 result. Add an integration test of
the ACTUAL canonical generation boundary. A successful load alone is not success. Either
natural generator rejection or an integrated, narrowly justified preflight must reject
unresolved input without output publication, panic, silent field pruning or invalid success.

Include the same reference both unused and reachable from an endpoint, a regular missing
reference, and a valid recursive model. Never use blanket cycle rejection.

A build-time guard may call the supported document validation API with the intended
spec-version semantics after loading only owned local refs. Verify it against the full
current source spec. If that conflicts with existing nullable/OAS3.1 semantics, preserve the
failure and return exact options rather than changing the spec or globally suppressing errors.

Generation should stage output and replace the accepted file only after all stages succeed.
Validate source/spec/config bytes do not change between checking and generation. A rejected
fixture, generator failure, timeout or cancellation must leave the prior output hash intact.
No CI script should truncate the accepted file before validation. The ordinary Makefile/
canonical generator and hosted drift gate must use the guarded path, not a test-only bypass.

## Phase4 — generator injection and required-input evidence

The2.7.0/2.7.1 source inspection is historical compatibility evidence, not permission to
adopt vulnerable output generation. Refresh these primary IDs and the exact2.7.2 patches:
GHSA-rjwr-m7qx-3fjr, GHSA-jwgf-6xff-4hvp, GHSA-xrqw-w576-xgj2.

Use tiny OWNED specs containing inert quote/newline/sentinel text in server descriptions,
paths and enum values. Inspect generated text/AST to prove those strings stay data or cause
controlled rejection. DO NOT execute malicious generated code, imported init functions,
shell commands, network calls or file-write payloads. Review benign generated source before
compiling/executing compatibility fixtures. AST parser success alone does not prove absence
of injected declarations; inspect expected declarations/imports and sentinel locations.

Use source-supported tests for emitted features the current config does not enable, clearly
labelled non-production-surface qualification. No new application feature to manufacture
reachability. A fresh scan must include the generator itself; absence from a feed does not
supersede explicit publisher findings. Retain feed/release inconsistencies without creating
exceptions/applicability rules in this slice.

For runtime1.4.2, add real generated request-binding controls: present, absent, empty,
malformed and valid-zero values where the schema permits them. The publisher's required-
parameter fix is part of this qualification. Use isolated generated adapters; do not reroute
production requests or change authentication/permission semantics.

## Phase5 — preserved regression lane and promotion

Carry forward the13kin test observations. Keep the original loader-only failed assertion as
historical characterization; add the new successful safe-consumer-boundary test separately.
Register the declared mandatory passing set with no missing/skip masking. Retain bounded
subprocess supervision, fixture size ceilings, output/time caps and verified teardown. A
source assertion, behavioral rejection, expected old panic and compilation error must be
labelled distinctly, not combined into an inflated vulnerability count.

Before promotion run candidate actual generation and contracts, backend build/vet/fmt/unit
and supported race checks, x/mod5, all six PostgreSQL fixtures, quality, and browser. Native
local non-race may be reported as such; hosted Linux must supply required race proof.

If safe, apply only the exact qualified candidate changes, stage explicit paths, preserve
branch deployment exclusions and `[CF-Pages-Skip]`, then commit/push normally. All four
application workflows must pass on one final SHA. Security must complete a fresh full scan
on that SHA, retaining unrelated blockers and source/advisory provenance. The current
6/4detached projection is NOT a hardcoded target for the larger candidate graph.

No force-push, blanket stage, new permission request, Android/signing/deployment/OTA/live
data, default-toolchain mutation, denied-cleanup retry or unrequested legal/policy waiver.

## Acceptance matrix KB01–KB20

| ID | Required evidence |
|---|---|
| KB01 | Entry accepted SHA/tree, preservation/dirty-path classification, qualified per-process compiler |
| KB02 | Exact official generator2.7.2, kin0.149.0 and runtime1.4.2 provenance; fresh security metadata |
| KB03 | Candidate linked binary graph and every MVS movement; retained prior fixes and scanner separation |
| KB04 | Actual project generator version and real spec/config generation compile/run successfully |
| KB05 | Full raw generated diff plus structural/type/serialization comparison; only explained permitted changes |
| KB06 | Deterministic repeated generation, unchanged source OpenAPI/TS contract, embedded semantic comparison |
| KB07 | Typed nullable/absent/null/zero/enum/union/local-reference positive controls and existing consumers |
| KB08 | Required path/query/header/cookie binding controls tied to runtime1.4.2; no silent acceptance regression |
| KB09 | Exact KO-OBS-02 at canonical generation boundary, unused+used invalid refs rejected before output |
| KB10 | Valid recursive schemas preserved; no blanket cycle/reference rejection |
| KB11 | Atomic output/unchanged previous artifact on invalid input, generator failure, timeout or cancellation |
| KB12 | Inert injection fixtures + exact code/AST evidence; no malicious generated code execution |
| KB13 | Actual3.1 source and current options qualified; no source-spec downgrade/error-class suppression |
| KB14 | All kin observations retained and integrated mandatory safe-boundary checks fail closed on missing/skip |
| KB15 | No auth/noop/ZIP decoder/remote-ref workaround; synthetic safety and cleanup evidence |
| KB16 | Backend/xmod5/six PG/application/quality/browser verification with correct local/race/platform limits |
| KB17 | Complete generator/runtime/library SBOM/license/advisory scan and exact ID delta; no policy/exception changes |
| KB18 | Explicit allowlist, no-deployment safeguards, final same-SHA four-green+completed security assessment |
| KB19 | Historical blocked evidence preserved; active versus detached counts and old/new output identity explicit |
| KB20 | Canonical tracker/progress/packet plus compact manifest; review-pending if promoted, precise blocker if not |

## Stop conditions and output

If the2.7.2 candidate cannot preserve contract or a safe loader boundary without a larger
change, leave the accepted graph active and return the exact failing diff/fixture and minimal
alternatives. A2.8.x/runtime1.6.x or custom backport is not pre-authorized as an automatic
fallback. The reason must be a demonstrated incompatibility, not routine phase approval.

Return one current packet and one compact ZIP with candidate identity, qualified graph,
KB01–KB20, generated raw/structural/behavioral comparisons, safe generation/injection evidence,
actual gate results, source hashes, advisory/scan delta, same-SHA hosted results only if
promoted, residuals and manifest. Include no caches, credentials, prior ZIPs or raw live data.
