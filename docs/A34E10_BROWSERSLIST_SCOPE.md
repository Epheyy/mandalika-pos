# A34e10 — Browserslist compatible remediation

Scope: **A34E10-BROWSERSLIST**. Reply: **CG-A34E9-POSTCSS-20260923-01-R1**.
Authority: **AUTH-MANDALIKA-20260919-01**. Recommended executor: existing GPT-6 Astra,
**Medium** effort. Resolve routine engineering independently; report evidence if a
consequential target-support change cannot be separated.

## Outcome

Upgrade the actual selected Browserslist 4.28.2 through its existing compatible consumers,
qualify normal target/configuration behavior and the two recorded security fixes, and keep
complete dependency/advisory evidence. Candidate minimum is **4.28.7**, subject to a fresh
publisher/range check. Do not introduce a broad update or an unused root dependency.

This is a build-tool dependency task, not an application browser-support-policy redesign.
No end-user-controlled production query/stats path is established by the dependency graph.

## 1. Starting graph and exact sources

Entry SHA expected from this review: 79403f23e63a3560a43a4c8845b91ff9102cfe96. Refresh the
actual worktree/branch before editing; preserve later independent work.

Supplied graph:

- root -> eslint-plugin-react-hooks 7.1.1 -> @babel/core 7.29.0 ->
  @babel/helper-compilation-targets 7.28.6 -> browserslist 4.28.2;
- update-browserslist-db 1.2.3 has a Browserslist peer-resolution edge;
- the upstream Babel tag declares Browserslist ^4.24.0; confirm the installed/published
  distribution and every other actual parent/peer before relying on that range.

Recorded blockers:

- GHSA-73wf-gq98-2v4g / CVE-2026-73088: untrusted custom stats can hit inherited names,
  crash or cause prototype-adjacent writes; publisher fixed 4.28.7.
- GHSA-c83g-rgw3-j3cx / CVE-2026-73089: result/parse caches grow without eviction;
  publisher fixed 4.28.7.

Publisher material is linked in evidence/EXTERNAL_SOURCE_NOTES.md. Recheck exact metadata,
archive integrity, license/engine/exports and fixes at implementation time. A later patch
is acceptable only with a stated compatibility/security reason, not a floating latest tag.

## 2. Minimal resolution and required data movement

Try an ordinary targeted lock update first. If pnpm leaves the relevant transitive unchanged,
use the smallest justified parent-scoped compatible override. Do not force a range-incompatible
library, update Babel/React/Vite major versions, or add a root library unused by the actual caller.

The following current data packages are below the 4.28.7 manifest's minimum ranges:

| Child | Current selected | Published 4.28.7 minimum range |
|---|---|---|
| baseline-browser-mapping | 2.10.29 | ^2.10.44 |
| caniuse-lite | 1.0.30001792 | ^1.0.30001806 |
| electron-to-chromium | 1.5.357 | ^1.5.393 |
| node-releases | 2.0.44 | ^2.0.51 |
| update-browserslist-db | 1.2.3 | ^1.2.3 |

Confirm these against fresh official manifests. Allow only the graph-required supporting
movement, record each changed version and reason, and preserve compatible already-selected
versions where allowed. Peer-context/snapshot keys may legitimately change when the resolved
Browserslist version changes; do not confuse those rekeys with additional source upgrades.
Do not run update-browserslist-db --latest or an equivalent broad dataset update as a shortcut.

Capture complete before/after lock graph and every actual parent/peer resolution. A clean
frozen install must load the intended version from the actual Babel helper context, not a
root import or stale hardcoded node_modules directory.

## 3. Preserve consumer behavior without freezing incorrect outputs

Inventory actual project Browserslist configuration and the Babel/helper calls reaching it.
Distinguish shipped/runtime exposure from build/lint execution and conditional paths.

Use the real installed @babel/helper-compilation-targets API with explicit benign targets
and actual project-relevant options. Run the relevant existing build/lint/quality entry
paths without redesigning their configuration. Merely printing a package version is not
consumer-compatibility evidence.

Test stable explicit queries, arrays/composition, exclusions, ordering/deduplication,
normal unknown-query errors and supported production/development environment selection.
Use owned synthetic config and stats files; never read real credentials/customer exports.

Browser-support datasets change answers to queries such as defaults, usage thresholds,
last-n-versions, baseline dates and maintained Node versions. Capture actual configured target
sets and Babel resolved-target outputs before/after. Explain differences using child-data
movement or documented upstream bug fixes. Do not silently edit application queries or targets
to recover byte equality. Prefer stable explicit targets for deterministic regression fixtures.
A same-data old/new comparison may be used when both manifests permit the selected data,
but label it as a controlled comparison separate from the real installed-graph change.

Full bundle byte equality is not required where legitimate source/tool/data changes explain
the difference. Existing functional builds and browser checks must still pass. Any material
unexplained browser-support removal is a dependent review question, not an automatic approval.

## 4. Custom-stats security regression

Use small JSON-created literal own keys such as __proto__, constructor or toString (not an
object literal that accidentally invokes special __proto__ syntax). Exercise actual public
Browserslist calls with opts.stats and, where supported, safe synthetic file discovery.

Demonstrate that the old version's inherited-name crash/writes are reproduced and that the
fixed version follows the publisher's safe behavior. Verify sentinel objects/prototypes are
unchanged; preserve a valid normal custom-usage control. Respect the real fixed semantics:
this task does not invent a new reject-all-unknown-stats policy.

Keep configuration discovery within controlled fixture/environment boundaries. Clear or
replace inherited BROWSERSLIST_*/NODE_ENV variables only inside the test child, without
altering the user's environment. Do not set dangerousExtend, load arbitrary remote configs,
or turn real home-directory discovery into a security test.

## 5. Cache-bound regression without an OOM attack

The reviewed publisher source has a 500-entry bound for both result and parse caches.
Verify this in the installed package rather than treating the number as a global contract.

Use at most a small bounded sequence (for example <=650 distinct short valid queries),
compact result sets and an external timeout/heap/output cap. Prove cache reuse while an
entry is present and eviction/recomputation after the documented bound through observable
public behavior where possible. The source shows returned cached-result references; test
that only if it is still true of the actual installed version.

Pair result-cache behavioral evidence with exact-source checks for both cache bounds. If
parse-cache state is not publicly observable, label that part source-supported rather than
claiming runtime size instrumentation. Do not patch upstream internals to fabricate an
observable pass, lower upstream cache bounds solely for a test, or disable caching as the
production fix. Check existing cache-disable/clear semantics separately only as controls.

Do not reproduce the publisher's 20,000/40,000-query memory demonstrations, claim a universal
RSS cap, or assert a flaky timing/heap ratio. Every child must be bounded and reaped; fixtures
must be tiny, owned, non-symlink and cleaned only through permitted normal lifecycle actions.
Never retry a denied deletion through another mechanism.

## 6. Security accounting and preservation

Preserve the exact actual package identity, child and peer edges in inventory/SBOM/license
and OSV queries. Do not allow data packages to disappear. Record all raw advisory matches,
policy decisions and exact removed/added/changed IDs, including other data-package findings
if a required child update changes them.

Current scan classifies both targeted records High. Publisher rates the cache issue
Moderate. Preserve that source disagreement and the current conservative policy. Do not
add applicability rules, downgrade severity or count the discrepancy as a new vulnerability.
No exception or approval is granted here. A fresh scan may change counts; never hardcode
an expected total or remove a match solely because a version was intended to fix it.

Preserve PostCSS 8.5.23, Nano ID 3.3.18 and all accepted assertions/resolution guarantees;
preserve tar, xmldom, brace-expansion and the exact SheetJS archive/provenance/two assessments/
2026-10-23 expiry. Thresholds and the empty exception register stay unchanged.

## 7. Acceptance matrix — BL01–BL16

| ID | Required evidence |
|---|---|
| BL01 | Entry SHA, preserved dirty-worktree classification and all current parents/peers/config consumers |
| BL02 | Official artifact identity, SRI/SHA256, license/engine/API, two advisory fixed ranges |
| BL03 | Smallest compatible resolution; every child-data version movement explained; no broad update |
| BL04 | Clean frozen actual-parent/peer resolution; no stale selected old copy or unused root substitute |
| BL05 | Real Babel helper target-resolution API and appropriate existing consumer path succeed |
| BL06 | Stable explicit-query/config/env/ordering/errors/custom-stats normal controls |
| BL07 | Actual project target-set differences attributed to data or upstream changes; no silent policy edit |
| BL08 | Small reserved-name stats regression, old failure and fixed behavior/prototype controls |
| BL09 | File-based stats path tested safely where relevant, or exact untested boundary disclosed |
| BL10 | Finite cache reuse/eviction check plus both cache bounds source evidence; no OOM claim |
| BL11 | Bounded process/fixture cleanup with denied/retained housekeeping clearly distinguished |
| BL12 | Target-ID delta, full child/peer inventory/SBOM/advisory coverage and unchanged security policy |
| BL13 | PostCSS15/NanoID16 and prior accepted checks preserved; E9-REPORT-01 attribution corrected |
| BL14 | Mandatory quality, typechecks, builds, schema drift and focused checks pass |
| BL15 | Four application workflows pass on one SHA; fresh security completes even if unrelated blockers remain |
| BL16 | Exact diff, provenance, all real results/limits, same-SHA evidence, progress/tracker delta and manifest |

Before-fix regressions may be expected failures, but must identify the failed assertion and
exact harness/library bytes; fixture corrections are not vulnerability fixes. If a required
comparison is unavailable, record that limit rather than treating a skip as success.

## 8. Execution and return

First integrate the A34e9 scoped acceptance and E9-REPORT-01 correction/replay. Then implement
this bounded family in the same turn; no documentation-only or authorization round is needed.

Integrate focused deterministic checks into existing mandatory quality. No new business
implementation, toolchain migration, CI-framework rewrite or unsupported private test hook.
Commit/push with an explicit allowlist on audit/hosted-proof-20260922; refresh existing
no-deployment trigger safeguards and retain the approved commit prefix/branch exclusions.

Require quality/backend/PostgreSQL/browser success and a completed fresh dependency assessment
on the same final SHA. Security can remain red for unrelated blockers. Do not dispatch
Android signing, OTA, deployment or live-data operations.

Do not include js-yaml, Vite, kin-openapi, chi/client-IP, rgbcolor licensing, OpenPGP
applicability, password-parser hardening, A14 imports, application IDs, financial semantics,
branch protection or other original workstreams in this slice.

Return one current review packet and compact ZIP containing BL01–16, exact executable and
reporting diffs, parent/data/target comparison, official provenance, bounded red/green tests,
security ID delta, source hashes, hosted runs, correction outcome and tracker/progress update.
A34e10 remains review-pending until reviewed; no parent/release gate closes automatically.
