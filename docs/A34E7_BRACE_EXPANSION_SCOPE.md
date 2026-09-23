# A34e7 — brace-expansion compatible dependency patch

Scope: **A34E7-BRACE-EXPANSION-20260923-01**. This is implementation direction,
not a claim that any candidate is already installed or qualified.

## 1. Current evidence and candidate targets

The current exact lock/inventory contains:

| Existing line | Candidate same-line minimum | Known witness parent |
|---|---|---|
| brace-expansion 1.1.14 | **1.1.18** | minimatch3.1.5 under ESLint |
| brace-expansion 2.1.0 | **2.1.4** | minimatch5.1.9 under Redocly/openapi-typescript |
| brace-expansion 5.0.6 | **5.0.9** | minimatch10.2.5 under TypeScript lint tooling and glob13/Capacitor |

These are witness paths, not a certified complete caller inventory. Enumerate every actual
parent/edge and declared range before editing. The candidates are the maintainer's published
fixed lines for the latest of the three recorded findings; refresh source/registry/advisory
evidence rather than assuming they cover newly published issues.

Recorded IDs (nine version/advisory matches across three installed versions):
- GHSA-3jxr-9vmj-r5cp;
- GHSA-mh99-v99m-4gvg;
- GHSA-rgw5-rvv9-x895.

The bundled raw OSV records already include branch-specific backport boundaries. Cached
web summaries can still show an obsolete broad <=5.0.7 range for one advisory. Preserve
current raw source evidence; do not replace it with a stale search snippet or reinterpret
ranges globally.

## 2. Compatible resolution, not a forced major migration

First inspect installed parent source/manifests, exported API forms, CJS/ESM resolution,
Node requirements, and how each parent calls brace expansion. Older consumers can expect a
callable CommonJS export while a newer line exposes a named function. Do NOT point all
parents at v5 merely because that makes an audit report shorter.

Prefer the smallest reproducible update supported by pnpm9 and existing ranges. If a
normal indirect update does not move the intended lock entries, narrowly scoped overrides
for exact parent versions are permitted after proving compatibility. No unused root
brace-expansion package, broad update, unrelated eslint/minimatch/glob/Capacitor major
migration, or lockfile hand-spoofing.

Record all selected version/edge/integrity changes. Retain unrelated packages and existing
tar/xmldom overrides. Changes required by the patched package's own declared child ranges
must be enumerated and verified, not silently assumed harmless.

## 3. Benign caller behavior

Use actual installed parent module resolution for all three lines in a clean frozen install.
Run real parent brace expansion/matching APIs with independent expected arrays/path sets:
- comma alternatives and nested braces;
- numeric/alphabetic ranges, negative and padded ranges where supported;
- literal/escaped braces, commas, empty alternatives and dollar-prefixed text;
- output ordering and duplicate treatment where the existing parent contract uses them;
- normal matching/glob outcomes over a finite synthetic fixture tree.

For the Redocly/openapi-typescript chain preserve the real generated TypeScript schema
check, not only a direct library import. For glob/Capacitor paths use nondestructive pattern
selection; do not execute a broad rimraf or native project deletion to test a dependency.

Verify API form at every parent. Do not substitute a test-only newer direct import for the
older package a parent actually resolves.

## 4. Small bounded regressions and truncation semantics

The recorded advisories concern unnecessary repeated expansion work, unbounded output
length and unbounded intermediate arrays. The maintainer patches impose bounds and can
truncate over-budget output rather than always throwing.

Respect that published behavior. Do not assert that a patched call must throw for every
malformed/oversized pattern, and do not claim bounded/truncated expansion is a complete
filesystem selection in every conceivable caller. Normal project patterns should remain
equivalent. Any real project pattern truncated by defaults is a concrete compatibility
issue to report, not something to hide by disabling bounds.

Use finite synthetic inputs and separate child processes, preferably the established
5-second external deadline / 96MiB V8 heap / 512KiB stack / 64KiB output caps. These are
process-test controls, not a universal OS RSS/disk guarantee.

No multi-hundred-MB allocations, huge Cartesian products or long-running publisher OOM
demonstrations are required. Where the installed API supports explicit max/maxLength,
exercise low finite budgets and assert bounded output. Where an older public API does not
expose an option, do not invent a supported option in tests. Use a safe maintained
regression and version-bound patch/source evidence, disclosing any resource-limit branch
not dynamically exercised.

Run the same corrected-invariant test source on before/after packages where practical.
An old library exceeding the external deadline is recorded as a negative result and its
child terminated; do not wait indefinitely or use fragile relative timing ratios.

## 5. Security evidence

Keep every selected package/version and parent path in inventory, SBOM and advisory queries.
Capture before/after exact advisory IDs, aliases, source timestamps, affected ranges,
raw-blocking, actionable, reviewed-not-affected and exception counts.

Target remediation is the nine current version/advisory matches, not nine independent
exploit claims. Fresh feeds can change: never hardcode a final count. If a feed still
incorrectly matches a documented backport, retain the finding and return source/range/hash
evidence for separate applicability review. Add no applicability rule, exception, severity
change or package ignore in this patch.

Keep both exact SheetJS assessments, their evidence and 2026-10-23T00:00:00Z deadline
unchanged. Keep raw and actionable findings separate. Chi, OpenPGP, rgbcolor and other
unrelated records must stay visible. No change to legal approval or security thresholds.

## 6. Acceptance matrix BE7-01 through BE7-16

1. Exact entry commit/worktree recorded; all three versions and actual parent ranges found.
2. Official candidate metadata/tarball integrity/license/runtime requirements recorded.
3. Existing major/API lines preserved; no incompatible global override or unused root copy.
4. Lock/importer/parent/child diff is limited and explained.
5. Clean frozen install resolves each candidate from every relevant installed parent.
6. Direct API form and real minimatch consumer behavior are tested for each line.
7. Benign alternatives/ranges/nesting/escaping/order agree with independent expectations.
8. Finite glob/path fixture selection is correct and performs no destructive operation.
9. Corrected-invariant before/after evidence or accurately bounded source-supported limits
   cover the three defect families; no fabricated full-exploit claim.
10. Child deadline/resource/output and owned-fixture cleanup are verified.
11. Tests recognize documented bounded/truncated behavior rather than requiring universal
    throwing or claiming every over-budget selection is complete.
12. All exact package/advisory deltas are explained; coverage is preserved; no exceptions.
13. Tar, xmldom, SheetJS artifact/assessments and existing policy inputs remain intact.
14. Canonical quality (including focused tests), typechecks, builds and generated schema pass.
15. Quality/backend/PostgreSQL/browser pass on one final SHA; a fresh dependency scan
    completes, with unrelated/conflicting blockers allowed to keep it red.
16. Explicit staging/no-deployment safeguards, old retained-copy limits, current tracker,
    progress and exact evidence manifest are returned.

## 7. Execution and return

Integrate focused checks into the established mandatory quality command. No local Go/DB
rerun solely for a Node leaf is required when unchanged hosted equivalents provide the
specified same-SHA proof; preserve their mandatory workflow behavior.

Use the current verification branch and explicit staging. Preserve CF-Pages-Skip/Vercel
safeguards; refresh trigger evidence before push. No force push, signing, deployment,
Android/OTA, credential or live-data work.

Leave previously policy-blocked installation directories intact. Do not route denied
deletions through a different mechanism. Newly owned fixtures may use ordinary approved
cleanup; accurately report any new block without stopping independent safe work.

Return one current packet and one compact ZIP with diffs, complete parent/version evidence,
provenance, BE7 matrix, benign/bounded negative tests, security-ID delta, hosted same-SHA
results, tracker/progress delta and manifest. Do not close A34/T29, A38/T33 or release gates.
