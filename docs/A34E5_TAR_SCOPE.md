# A34e5 — bounded tar build-dependency remediation

Scope ID: **A34E5-TAR-20260923-01**
Authority: **AUTH-MANDALIKA-20260919-01**
Expected entry: `31080a4b40515369bd050d1eb13150d04fa21971` on `audit/hosted-proof-20260922`.

## Objective

Remove the three currently identified vulnerable `tar@7.5.15` records by upgrading the dependency actually resolved by the existing Capacitor CLI to a compatible fixed release. Preserve the source graph, application behavior, vendor provenance and all established gates.

Candidate minimum: **tar 7.5.21**. Refresh official advisory/version/package information before editing. Prefer this exact compatible fixed target over a floating latest version. If a new advisory requires a later compatible patch, identify it explicitly; do not silently change the target.

| Advisory | Supplied severity | Publisher's first fixed release |
|---|---|---|
| GHSA-8x88-c5mf-7j5w / CVE-2026-59874 | High | 7.5.18 |
| GHSA-23hp-3jrh-7fpw / CVE-2026-59873 | Critical | 7.5.19 |
| GHSA-r292-9mhp-454m | High in supplied assessment | 7.5.21 |

These are installed/build-path findings. Neither the supplied graph nor this direction proves a live POS exploit. Retain differing upstream severity/alias metadata as evidence rather than modifying it for an expected count.

## 1. Inventory before editing

1. Record current SHA, dirty state and exact package/lock hashes; preserve uncommitted reporting and unrelated local work.
2. Enumerate every locked/installed tar version, every parent range and workspace path. The current supplied graph shows `apps/pos → @capacitor/cli@8.3.4 → tar@7.5.15`, but refresh all paths in the live worktree.
3. Read the installed parent package's actual manifest and archive-consuming code. Record which tar API is used, from which command/helper, and whether this is startup-only, template extraction, listing, replacement or another operation.
4. Verify that 7.5.21 is available from the official npm distribution and compatible with every retained parent's declared range and the existing Node versions. Record registry source, integrity, package manifest/license and release/advisory references.
5. Capture exact raw/actionable tar findings before the change. Preserve the complete baseline and the two SheetJS assessments.

Do not skip this trace because the dependency is labelled build-only. Conversely, do not claim runtime app reachability from an installation path alone.

## 2. Narrow dependency resolution

Use the smallest reproducible pnpm lock resolution that installs the fixed tar for the actual parent. Prefer ordinary resolution inside the existing parent range. If a persistent selector is necessary, use a documented narrowly scoped override for the affected parent/edge, not an unexplained global override.

Do not add a new unused root-level tar dependency and call the transitive dependency repaired. Do not hand-edit integrity hashes or manually replace node_modules. Do not run a blanket update or `audit --fix` campaign.

Retain @capacitor/cli, Capacitor runtime/platform versions, Node/pnpm, Playwright and unrelated dependencies. Enumerate each changed lock entry and explain required tar transitive movement; reject unrelated opportunistic lock churn. If a parent range or actual API cannot support a fixed 7.5.x version, return the precise conflict rather than upgrading the whole native toolchain.

Keep the SheetJS archive/provenance/lock identity and applicability register/evidence/deadline byte-stable. Exceptions and dependency policy remain unchanged.

## 3. Installation and actual-consumer proof

Use a clean disposable frozen-lockfile install with the repository's existing lifecycle-script policy. Verify installed resolution from the **Capacitor CLI's own module context**, not only from the root. Prove no old affected tar copy remains on the relevant path.

Exercise the parent archive-consuming helper with a tiny local synthetic fixture, through the actual installed call path where practical. Preserve expected template/file contents, relative paths and relevant options. Record limitations if the complete parent operation requires unapproved external/native infrastructure; do not represent `cap --version` or an import-only smoke as extraction proof.

A standalone create/list/extract round trip through the tar resolved by the parent is useful supplementary compatibility evidence. It does not, by itself, prove the parent integration. Run only inside owned temporary directories without real project/platform mutation, provider contact or Android signing.

## 4. Small bounded security regressions

Inspect upstream fix code/tests and port only the smallest relevant corrected-invariant tests for the APIs exercised by the parent or directly implicated by the three advisories.

- Malformed negative-size replacement/listing behavior must reject/terminate without an infinite scan.
- Long-path/member-selection processing must terminate without uncontrolled recursive stack failure.
- Parser/extractor resource limits introduced by the fixed release must be verified with a deliberately small configurable threshold or other small safe fixture where supported. Do not assume that a patch version imposes every application-specific byte/entry/ratio limit.

Use external child-process deadlines and conservative memory/output/temp-disk bounds for any malformed input, on both vulnerable-characterization and corrected tests. Never execute a multi-gigabyte gzip-bomb demonstration. A timeout of the vulnerable characterization is recorded as a reproduced defect, not as a passing fixed test.

If one fix cannot be safely exercised with bounded fixtures here, retain exact source/fixed-version evidence and report the test limitation. Do not run a resource-exhaustion test on the host merely to complete a checklist, and do not silently claim exploit verification from a scanner result.

Include a disposable negative proof that restoring the old tar resolution restores the targeted scanner/blocker result, or an equivalent exact affected-range/installed-version test through the existing evaluator. No policy downgrades or not-affected entries for tar.

## 5. Scanner and provenance preservation

After updating, regenerate complete inventories, SBOMs, raw findings and assessed policy output. The target package remains npm/tar at its actual installed version. Verify all dependency edges and integrity metadata; no package or relevant path may disappear to create a clean result.

Required targeted outcome: the three advisory IDs above no longer affect the installed tar release according to refreshed raw sources. No new blocker should be introduced by the chosen dependency change. If feeds change during the turn, distinguish environmental/advisory drift from the dependency patch and report exact IDs rather than attributing every count change to remediation.

The SheetJS pair must still be present in raw findings and separately assessed while its exact review remains valid. No new exception or assessment entry. chi, kin-openapi, rgbcolor, OpenPGP and other unrelated records remain visible.

On unchanged prior evidence, removing these three records would mean raw 48 → 45 and actionable 46 → 43, with reviewed-not-affected 2 and exceptions 0. **That is a conditional expectation, never a fixed fresh-scan assertion.** Actual refreshed counts and exact IDs are the result.

## 6. Verification and publication

Run the focused tar/parent tests, vendor/applicability/policy tests, clean frozen install, and canonical JS/TS quality checks locally. No local Go/database repeat is needed solely because a Node build leaf changed, unless fresh evidence creates a direct backend impact; the same-SHA hosted gates still remain required.

Stage only an explicit allowlist. Preserve the current verification branch's Cloudflare skip and Vercel branch exclusions; refresh the actual triggers before pushing. No generic CI-skip markers. Commit/push normally, no force push.

On the same final SHA require:
- JS/TS quality: success;
- backend including ordinary race checks: success;
- six mandatory PostgreSQL fixtures: success with zero skips;
- 26 required browser scenarios: success with zero skips;
- dependency-security: fresh complete scan; it may remain red for unrelated blockers.

The security job must fail only for genuine remaining policy findings, not missing/invalid scan coverage. Preserve the 19 policy, 22 vendor and 16 applicability regressions unless a documented test inventory changes for a legitimate reason. Do not extend SheetJS expiry or weaken evidence invalidation because fresh data changed.

## 7. Acceptance matrix

| ID | Required evidence |
|---|---|
| TA01 | Exact starting SHA, dirty-state preservation and baseline hashes |
| TA02 | All parent paths/ranges and actual parent tar API/call-site inventory |
| TA03 | Official minimum-fixed-release evidence and exact registry/package integrity |
| TA04 | Narrow explained lock/manifest changes; no Capacitor/platform/major upgrades |
| TA05 | Clean frozen install resolves the fixed tar from every affected parent context |
| TA06 | Benign archive behavior through the actual parent or explicit integration limitation |
| TA07 | Small bounded negative-size/long-path/resource regression evidence as applicable |
| TA08 | External time/resource limits and confirmed owned-fixture cleanup |
| TA09 | Old-version/affected-range negative proof is meaningful and restored |
| TA10 | Targeted three advisory IDs removed for the installed version; no silent scope loss |
| TA11 | Raw versus actionable counts and feed drift explained without hardcoding totals |
| TA12 | SheetJS vendor/provenance/assessments/deadline, policy and exceptions unchanged |
| TA13 | Existing quality, policy, vendor and applicability tests remain green |
| TA14 | Four application workflows green plus fresh security scan on one final SHA |
| TA15 | All A01–A44 retained; no parent/release closure from this slice |

## 8. Non-goals and next packet

Do not broaden into chi/ingress, rgbcolor legal approval, OpenPGP applicability, stored-password parser hardening, kin-openapi, other npm upgrade campaigns, A14 imports, A13/A42 business concurrency, A37 history scanning, A35 release provenance, deployment, Android/OTA or live data.

Return one current packet and one compact ZIP with exact incremental source/package/docs diffs, parent/installed-resolution evidence, package provenance, benign/bounded-negative tests, baseline and fresh ID deltas, same-SHA hosted results, preserved-sheetjs checks, acceptance matrix, tracker/progress delta and a size/SHA-256 manifest.

Record successful A34e5 as implemented/verified, **review pending**. Do not count this new slice accepted before ChatGPT review. Normal engineering work is covered by standing authority; escalate only genuine incompatibility, missing external facts or scope-changing decisions.
