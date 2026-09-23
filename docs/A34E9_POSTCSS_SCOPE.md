# A34e9 — PostCSS previous-source-map remediation

Scope ID: **A34E9-POSTCSS-20260923-01**
Authority: **AUTH-MANDALIKA-20260919-01**

## A. Goal and exact evidence basis

Update the actual installed PostCSS dependency, currently **8.5.14**, within compatible
8.5.x to remove its recorded previous-source-map path disclosure matches without
breaking the real CSS pipeline or reverting the accepted Nano ID patch.

Current supplied records:

| ID | Current treatment | Publisher fixed release |
|---|---|---:|
| GHSA-r28c-9q8g-f849 | High blocking record | 8.5.18 |
| GHSA-fxqj-rqcc-2cmp | Moderate, report-only | 8.5.23 |

Candidate minimum: **8.5.23**. The follow-up is the same source-map family; do not stop
at 8.5.18 just because the remaining match would be Moderate. Refresh publisher feeds,
tagged implementation, parent ranges and registry integrity before installing. A later
compatible 8.5.x patch is permissible when justified by current support, advisory or
bug-fix evidence, with its extra semantic changes explicitly qualified. No Vite/Tailwind
major upgrade or broad latest campaign is authorized in this slice.

The supplied graph reaches PostCSS via Vite 8.0.13, including app and Vitest/Tailwind paths.
This establishes graph context, not the exact allowed range or all source call options.
Those must be checked against the actual installed parents.

## B. Refresh the real consumer contract

Enumerate all direct and transitive parents, selected PostCSS copies, declared ranges,
peer contexts and module formats. Trace how POS/Backoffice Vite processing supplies
`from`, `to`, `map`, `map.prev`, and `unsafeMap`, and whether external CSS can enter it.
Record actual project configurations/calls; do not infer a live exploitable service from
a build dependency or one library-level proof.

Use the smallest reproducible lock/dependency change. Prefer a working ordinary targeted
resolution update. When the package manager leaves the leaf unchanged, an exact compatible
parent-scoped override is allowed with before/after evidence. No unused root dependency,
force outside a parent's supported range, plugin removal or disabled source maps as a
substitute for remediation. Preserve package/lock integrity and lifecycle policy.

## C. Preserve Nano ID while moving its parent

Current integration has:

- `postcss@8.5.14>nanoid: 3.3.18` in root overrides;
- a hardcoded `.pnpm/postcss@8.5.14/...` path in the 16-case Nano ID harness.

Both are version-bound. Update only the necessary wiring so:

1. Every active PostCSS parent still resolves the accepted Nano ID **3.3.18**.
2. The focused harness resolves PostCSS through an actual Vite/workspace consumer rather
   than reading an obsolete cached package. If several legitimate PostCSS copies remain,
   prove every relevant one; do not silently select the first match.
3. Keep the old parent only if a real consumer still needs it; do not retain a ghost
   installation merely to pass tests.
4. Preserve all 16 Nano ID cases and normal outputs; adapt bootstrap/version selection,
   not assertions or gate inclusion. Name any intentionally changed PostCSS behavior.
5. Do not manufacture an executable change in the Nano ID library itself.

A clean frozen installation must reproduce the final graph with no selected vulnerable
PostCSS/Nano ID copies. Incidental on-disk old caches are not the selected graph.

## D. Publisher semantics — do not replace them with a guessed security model

The checked 8.5.23 source:
- returns early for `map: false`;
- rejects automatic untrusted external map loading without a base CSS file;
- restricts untrusted automatic map paths relative to the CSS directory;
- retains explicitly supplied previous-map and inline-map paths;
- includes an `unsafeMap` escape hatch.

Do not enable `unsafeMap:true` to make compatibility green. Do not silently disable all
source maps. Explicit `map.prev` is a caller-trust boundary, not attacker-provided CSS
metadata; preserve supported trusted use without claiming all arbitrary caller-specified
paths are blocked. If a real existing caller requires an out-of-directory map, establish
whether it is trusted and propose the smallest explicit safe mapping; return consequential
uncertainty rather than globally relaxing the new default.

A declined map may be ignored rather than throw. Require no forbidden synthetic read or
source-content propagation, not an invented universal error. The upstream lexical path
check is not a proof of symlink containment, all filesystem sandboxing, remote URL safety,
CSS sanitization or HTML/XSS safety. Do not claim those without separate evidence.

## E. Small real filesystem fixtures and meaningful before/after proof

Use an owned temporary tree, for example `owned/base` plus `owned/outside`, both under
one test-owned parent. The outside folder is only outside the intended CSS directory,
not outside the test sandbox. Write tiny synthetic valid source maps with distinct
non-secret markers and known source positions. Never use real source/customer/credential
files or `/etc`, home directories, repository secrets or deployed endpoints as targets.

Exercise at least:

- Normal same-directory and nested in-directory previous maps with a real `from`.
- Relative traversal to the sibling synthetic map with `from` set.
- Absolute and parent-traversing automatic annotations when `from` is absent.
- Non-map suffix and missing/invalid-map controls, using actual publisher semantics.
- `map:false` does not load an automatic map.
- Inline data maps and supported explicit trusted `map.prev` retain expected mapping.
- Plain CSS/Unicode/comment/custom-property/at-rule parsing and a real plugin transform.
- Source-map source positions/content and normal parse diagnostics.
- A real minimal Vite transform/build path with synthetic CSS as well as both existing
  application builds. Do not claim a Vite-call-path exploit where Vite options prevent it.

Use the identical final meaningful regression fixture on 8.5.14 and the candidate. At
least one previous-map read/propagation assertion must fail before and pass after.
If the target library refuses rather than throws, record that valid behavior. A test-only
passthrough filesystem observer may log whether the named synthetic map was read; it must
not fake read rejection or replace the parser being tested. Absence of a marker in output
alone is not a broad proof that no filesystem access happened.

Keep small inputs, external child timeout, finite output/heap bounds, and ownership-aware
cleanup. Do not run large decompression or network probes. V8 heap limits are not OS-wide
RSS/disk quotas. Leave all previously denied deletion targets untouched. Report separate
limits for package installation copies, test fixtures and test processes.

## F. Inventory and enforcement invariants

Capture old/new package identity, tarball hash/SRI, license, engines, published-file
integrity, graph and all actual parent resolution contexts. Include PostCSS and retained
Nano ID in inventory, CycloneDX and advisory queries; no omission-based lower count.

Map the exact two PostCSS findings. Under unchanged archived evidence, one is a blocker
and one is report-only: do not count their removal as two blocker patches. Fresh feeds
can change, so do not hardcode target counts. Keep all raw advisory evidence, aliases,
severity/ranges, scan times and assessed result differences.

Preserve Nano ID/tar/xmldom/brace remediation; exact SheetJS archive/provenance; two
reviewed decisions and 2026-10-23T00:00:00Z deadline; thresholds and empty exceptions.
No applicability addition, severity downgrade, blanket ignore or license decision.

## G. PC01–PC16 acceptance matrix

| ID | Required evidence |
|---|---|
| PC01 | Entry SHA/worktree and current parent/range/call-option inventory. |
| PC02 | Official tagged/registry candidate and both advisory boundaries verified; exact patch justified. |
| PC03 | Minimal compatible graph/lock change; no unrelated selected versions or forced parent incompatibility. |
| PC04 | Nano ID 3.3.18 carried to every active PostCSS parent; obsolete override/path addressed without losing tests. |
| PC05 | Clean frozen parent-context resolution, provenance/SRI/license/engine and selected-copy checks. |
| PC06 | Same final before/after fixture reproduces at least one automatic-map escape/read/propagation defect. |
| PC07 | Candidate contains relative escape and no-from absolute/relative synthetic cases. |
| PC08 | In-directory previous maps and normal source positions/content remain correct. |
| PC09 | map:false, inline maps and explicit trusted previous-map controls; no unsafeMap workaround. |
| PC10 | Real CSS parse/plugin/diagnostic and Vite-path compatibility plus both current application builds. |
| PC11 | All 16 accepted Nano ID cases remain mandatory and pass from active contexts; prior dependency tests retained. |
| PC12 | Tiny fixture/child resource and cleanup evidence; previous denied removals untouched. |
| PC13 | Old evidence still triggers unchanged policy; fresh exact blocker/report-only ID delta with complete graph/SBOM/query coverage. |
| PC14 | SheetJS assessments/expiry, earlier dependency fixes, thresholds/exceptions unchanged; no new unexplained blocker. |
| PC15 | Same final SHA: quality/backend/PostgreSQL/browser success and complete fresh security scan, even if policy stays red. |
| PC16 | Exact diff, matrix, hashes, hosted records, limitations and canonical tracker/progress update in one compact packet/ZIP. |

## H. Execution and return boundary

Implement in the existing session/worktree/verification branch under standing authority.
Use explicit staging, preserve current branch/Cloudflare/Vercel no-deployment safeguards,
normal commit/push, no force push, no release workflow dispatch. Do not implement policy,
chi/rgbcolor/OpenPGP/password/A14/business-accounting/native changes.

Integrate focused PostCSS checks into mandatory quality. Backend/PostgreSQL need not be
repeated locally solely for a Node leaf when unchanged mandatory hosted counterparts run
on the final SHA. No required test may be skipped/removed to manufacture green results.

Return one current packet and compact ZIP: exact diffs, PC matrix, actual old/new resolution
and bounded tests, no-read/output evidence, all Nano ID checks, security raw/assessed delta,
provenance and same-SHA hosted results. Keep A34/A38 and release gates open. Escalate only
material dependent uncertainty with evidence/options; no routine approval request.
