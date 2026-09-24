# A34e11 scope — compatible js-yaml remediation

Scope ID: A34E11-JSYAML-20260924-01
Review authority: CG-A34E10-BROWSERSLIST-20260924-01-R1
Programme authority: AUTH-MANDALIKA-20260919-01
Entry reviewed commit: 4f6347346ac738e9ac4c7c295dd26351e1cd9e94

## Outcome

Upgrade the js-yaml version actually resolved by both the existing ESLint and Redocly
consumers, preserving supported configuration/OpenAPI semantics and all accepted gates.
Do not add a root package that leaves the vulnerable parent copy installed.

Candidate: **js-yaml 4.1.1 -> 4.3.2**, within the compatible 4.x line, after current parent
range and official artifact checks. Use the minimum compatible fixed version for the
reviewed records unless new authoritative evidence requires a later compatible patch.
No 5.x migration, general dependency campaign, new risk exception or applicability rule.

## 1. Source-derived inventory and external evidence

The submitted 4f63473 lock/inventory selects js-yaml4.1.1 under:
- @eslint/eslintrc3.3.5 in root ESLint9.39.4;
- @redocly/openapi-core1.34.14 in packages/api openapi-typescript7.13.0.
These are build/tooling paths in the current inventory, not established live cashier YAML
upload endpoints. Trace each actual path and use; do not manufacture runtime exposure.

Current external evidence consulted during this review:
- GHSA-52cp-r559-cp3m: merge-chain work, fixed 4.3.0 on the 4.x line.
- GHSA-5p4m-2wfm-xmqj: ordered-map (!!omap) uniqueness work, fixed 4.3.1.
- GHSA-2883-xcg3-v3hh: empty merge-source work escapes the budget, fixed 4.3.2.
See evidence/EXTERNAL_SOURCES.json for URLs and provenance of those claims.

Important source distinction: the current 4.3.2 omap implementation uses an own-property
membership object with Object.defineProperty, not the suggested Set from the advisory's
example. Do not write a test that rejects the actual fixed implementation just because it
does not contain `new Set`. Confirm the real exact package source.

## 2. Refresh before editing

Inventory all selected js-yaml versions, parent ranges, workspace entry paths, exported
API shapes, Node engines, license/integrity and current raw/assessed advisory records.
Read actual parent source to establish load/loadAll/dump APIs, schemas and options.
Record direct/default calls separately from actual Redocly and ESLint behavior.

The npm package `yaml` used by existing security/lockfile helpers is a different package;
do not upgrade or replace it as part of this js-yaml task. Go YAML libraries are also out
of scope. Do not silently switch parsers to bypass the advisory.

Prefer an ordinary targeted compatible update. If it leaves the indirect lock unchanged,
use the smallest documented parent/version-scoped override for each genuine consumer.
Verify installed resolution from each parent's own module context in a fresh frozen
installation. Explain all support-module movement and reject unrelated upgrades.

## 3. Upstream safety behavior and compatibility

The reviewed 4.3.2 loader defaults include maxTotalMergeKeys=10000 and maxDepth=100.
Its merge-work budget charges both each source mapping and each source key; even an empty
source must consume work. `-1` can disable the budget upstream. Do not use that escape
hatch, Infinity or huge limits to make a previously supported config pass unnoticed.

Audit actual repository configs and the OpenAPI generation input for compatibility with
new limits. If a legitimate existing file is rejected, preserve the evidence and return
that precise dependency, instead of silently expanding limits or altering business schema.
Allow routine fixture corrections that reflect the real old/new API, but keep them distinct
from security fixes and replay the final assertions on both versions.

The advisory illustrations may show YAML11_SCHEMA from a different major line. Use the
actual 4.x exported schema/API and each parent's real options. Do not require a nonexistent
export or force DEFAULT_SCHEMA on a consumer that intentionally uses another schema.

## 4. Actual consumer qualification

### ESLint configuration path
Trace whether the project's current flat config reaches js-yaml during normal linting.
If it does not, say so and additionally exercise the real legacy YAML loader/API of the
installed @eslint/eslintrc in an isolated fixture. Do not switch the application's lint
configuration merely to create coverage. Never execute arbitrary plugins/config JS from
untrusted YAML; use a small synthetic trusted fixture and existing installed dependencies.
Run a normal repository-config TSX lint smoke as a separate compatibility control.

### Redocly/OpenAPI path
Exercise the real installed openapi-core parsing/loading/bundling operation used by the
repository. Use a tiny valid synthetic OpenAPI YAML fixture and local owned references;
assert structured data and useful diagnostics with independently expected values.
Run the repository's real TypeScript OpenAPI generator/drift check against its current
source and leave the generated contract unchanged. Do not rewrite generated output to
hide a parser/generator discrepancy. Do not fetch remote references or read real secrets.

### Core YAML controls
Cover supported mapping/sequence/scalar values, Unicode/escapes, null/booleans/numbers,
ordinary anchors/aliases and merge precedence, loadAll where consumed, ordinary dump/load
roundtrip, duplicate-key/error handling and schema-specific types where relevant. Preserve
existing 4.x semantics; no implicit YAML1.1/1.2 policy migration. Use independent expected
values, not only a library reading its own output.

## 5. Small meaningful regression proofs

Use per-case supervised child processes and owned tiny fixture trees. Prefer <=16KiB
inputs, <=5-second security deadlines, bounded V8 heap/stack/output; record exact caps.
Keep larger trusted consumer startup allowances separate. Terminate/reap timed-out
children and check tiny-fixture cleanup. No stress-sized alias/merge/omap documents.

- **Non-empty merge chain:** a short chain plus a deliberately small maxTotalMergeKeys
  exercises budget rejection in fixed source while the old version ignores/lacks it.
  Positive below-budget controls preserve the exact expected merged object.
- **Empty-source budget:** a tiny repeated empty-mapping sequence with a small configured
  limit proves that source visits are charged, even when no keys are copied. Compare
  actual old/fixed behavior. No N*K huge workload is needed.
- **!!omap:** use a finite number of unique one-key maps, preserved order and duplicate
  rejection, including reserved property-name cases where supported. Pair behavioral
  controls with exact publisher-source evidence that removes the repeated linear membership
  scan. A source check is not a runtime asymptotic measurement or a distinct exploit proof.
  Do not introduce monkeypatches or timing-ratio thresholds just to produce a red test.
- **Limits and failure atomicity:** ensure an over-budget parse fails rather than returning
  a partial parsed object to a consumer. Keep original fixture bytes unchanged. Independent
  subsequent load calls still work. No universal RSS/disk/alias-safety claim.

Clearly distinguish a new configurable-limit test from proof of default-limit enforcement.
Do not claim exhaustive YAML denial-of-service protection or actual deployed exploitability.

## 6. Supply-chain and security reporting

Preserve official registry URL, retrieval time, artifact size/SHA256, locked SRI, packaged
name/version, license/engine/API and exact relevant source bytes. Compare clean installed
bytes to the authenticated source artifact without executing package lifecycle code during
inspection. Use established installation controls for subsequent normal qualification.

Both genuine parent paths and all selected children must remain visible in inventory,
SBOM, license evidence and exact-version advisory queries. Preserve scanner identity as
npm/js-yaml, not a renamed fork. Refresh full before/after evidence; exact targeted IDs are
more important than a count. Do not call every alias an independent exploit.

The candidate should remove the three fixed reviewed matches if the fresh feeds agree.
Do not hardcode a 20->17 or 18->15 result. New/unrelated feed changes must be recorded, not
hidden. Preserve original severity disagreement, all raw evidence, reviewed SheetJS pair
and zero risk exceptions. Feed conflicts remain a separate review issue; no suppression.

## 7. Preserve prior outcomes

Keep all accepted Browserslist15, PostCSS15, NanoID16, brace20, xmldom10, tar6, vendor22,
policy19 and applicability16 checks available and mandatory in their current quality/security
jobs. Do not hide earlier checks by replacing quality commands with only the new family.
Preserve exact SheetJS tarball/provenance/register and 2026-10-23 review deadline, as well as
all established dependency fixes and Go files. Updating test resolver wiring is permitted
only where an actual dependency path changes, with unchanged financial assertions.

E9-REPORT-01 is now closed as an evidence correction; integrate status only. Do not create
a new documentation-only round or repeatedly rerun the old library without material need.

## 8. Acceptance matrix YJ01–YJ16

| ID | Required evidence |
|---|---|
| YJ01 | Entry SHA, current dirty-worktree classification, every installed js-yaml version and immediate/transitive parent path. |
| YJ02 | Exact published parent ranges and real schemas/options/API; distinguish active repository lint from legacy loader exposure. |
| YJ03 | Official archive identity/integrity/license/engine/source and three advisory fixed-version checks. |
| YJ04 | Minimal compatible resolution/lock change; all supporting movements explained; no unused root package or 5.x/parser switch. |
| YJ05 | Fresh frozen-install resolution from BOTH genuine parent contexts; no stale old selected copy. |
| YJ06 | Real @eslint/eslintrc YAML loading qualification and ordinary repository lint compatibility; precise reachability limit. |
| YJ07 | Real Redocly/OpenAPI synthetic parse/reference test and unchanged actual generated TypeScript API drift. |
| YJ08 | Independent normal YAML types, anchors/merges/order/errors/schema controls before and after. |
| YJ09 | Tiny merge-chain budget regression and below-budget positive control; exact final test source on both versions. |
| YJ10 | Tiny empty-source budget regression, proving source visits count without CPU-exhaustion load. |
| YJ11 | Finite !!omap correctness/reserved-key/duplicate controls plus source-supported complexity repair, not an invented Set or OOM assertion. |
| YJ12 | New default limit compatibility; no disabled/raised safety controls or silent partial parse; bounded child and tiny-fixture cleanup. |
| YJ13 | Complete inventory/SBOM/advisory coverage, exact raw/actionable ID delta, no new waiver or policy change. |
| YJ14 | New focused checks in mandatory quality; all accepted checks/types/builds/generator/security tests remain green within established scope. |
| YJ15 | Four hosted application workflows succeed on one final SHA, plus completed fresh policy assessment; unrelated blockers may keep security red. |
| YJ16 | Explicit staging, trigger/secret safeguards, source/evidence hashes, limits, tracker/progress delta and compact verified bundle. |

## 9. Execution and handoff

Continue on `audit/hosted-proof-20260922` under standing authority. Stage only the explicit
source/test/package/config/doc allowlist. Keep the existing Cloudflare/Vercel skip/branch
controls and verify no new deployment trigger. No blanket `git add`, force push, Android
signing, OTA, deployment, live-data operations or credentials access.

Previously policy-denied deletion targets remain untouched. Retain and report installation
copies rather than bypassing deletion controls; don't conflate that housekeeping with
successful tiny-fixture/process cleanup.

On one final commit require quality, backend/race, PostgreSQL/race and browser success, plus
a completed fresh dependency scan. Red security is expected while unrelated blockers remain;
a missing scan is not success. Record run IDs/head SHAs and separate source failures,
fixture corrections, provider failures and genuine before-fix regressions.

After implementation mark A34e11 locally/hosted verified, ChatGPT review pending. Do not
increment accepted milestones for unreviewed implementation or close A34/A38/release gates.
Return one current packet and one compact ZIP with exact incremental diffs, all YJ evidence,
provenance, raw/assessed scan/ID deltas, five-workflow results, preserved state/limits,
tracker/progress delta and manifest. No generic approval round is needed.
