# A34e4 — exact SheetJS advisory applicability

Scope ID: **A34E4-SHEETJS-APPLICABILITY-20260923-01**  
Decision source: **CG-A34E3-SHEETJS-20260923-01-R1**, Q-A34e3-01.  
Current base: `de7352fa5fb0cf877e869b1c65040a2731969ccb`. Standing authority applies.

## A. Two narrow decisions, separate from exceptions

Introduce a small checked-in reviewed-applicability register and strict schema/validator,
plus a matcher integrated with the existing dependency scanner. Naming may follow current
repository conventions. The supplied JSON is a decision seed, not assumed runtime schema.

Exactly two initial records are approved. Each must bind:
- ecosystem, package, exact version, official distribution kind/source URL;
- actual artifact SHA-256 and SRI verified from bytes, not just a claimed string;
- expected component provenance digest and input integrity/manifest validation;
- one advisory ID and its explicitly listed CVE alias (no alias-prefix glob);
- publisher fixed-version basis, captured raw conflicting OSV evidence, source URLs,
  retrieval/review dates and evidence digests;
- technical reviewer `ChatGPT review CG-A34E3-SHEETJS-20260923-01-R1`; do not invent a human/legal reviewer;
- explicit assessment state/rationale and a re-review deadline.

For the initial implementation use reviewed_at 2026-09-23 and review_by
2026-10-23T00:00:00Z. This is a conservative technical freshness check for conflicting
advisory evidence, not a new owner-approved risk-exception lifetime. Expiry must prevent an
assessment from relaxing a matching raw blocker. Do not silently renew it in code.

No version range `>=0.20.3`, package-wide ignore, caller-provided `safe=true`, blanket CVE
alias matching, exception auto-population or global parsing override is permitted.
The existing vulnerability/license exception register stays byte-unchanged and empty.

## B. Evidence pipeline and review invalidation

1. Keep fresh baseline collection complete. Normal vendor/lock/path/manifest/source-input
   validation occurs BEFORE any assessment is applied.
2. Preserve original findings and source responses. Produce a separate assessed projection
   and a human-readable explanation for every record no longer actionable.
3. Match validated component identity AND artifact bytes; exact version alone is insufficient.
4. Check a normalized evidence fingerprint for material source fields: advisory/alias and
   package identity, affected range, details/fixed-version rationale, withdrawn state and
   risk-relevant classification. Retain raw bytes/hashes too. Mere JSON ordering is not a
   material change. Do not trust `modified` alone or silently recalculate the reviewed
   fingerprint from new evidence on every run.
5. A changed artifact, affected range, newly contradictory publisher statement, fix
   regression/reintroduction or new material risk evidence requires re-review. Do not
   continue using the old assessment. Preserve the raw policy behavior while unresolved.
6. New xlsx advisories do not inherit the decision. Old registry 0.18.5, other 0.20.3
   distributions, future versions, forks and nonmatching digests receive normal enforcement.
7. If the upstream feed stops matching after a correction, report that as upstream-resolved
   with no assessment applied; do not manufacture two matches or require stale orphan records
   to match a nonexistent raw finding. A new assessment is not needed just to keep a clean
   provider result clean, but retained stale records must not relax different future data.
8. Keep source-unavailable/malformed evidence fail-closed. A cached decision is not a
   substitute for a completed required advisory scan. Frozen source snapshots are review
   evidence, not a live feed replacement. Do not add a fragile live HTML scrape as the sole
   proof of a fix; retain the reviewed publisher rationale with a bounded re-review date.
9. Hash the register, schema, relevant policy and provenance/evidence inputs in scan metadata
   alongside existing lock/vendor hashes so results are attributable to reviewed rules.
10. No rewrite of upstream raw ranges, severity, names, package purls, SBOM components or
    source findings. Third-party SBOM consumers may still flag them; carry the assessment as
    a clearly separate report linked by component/advisory/hash, without claiming standard
    VEX conformance unless that format is actually implemented and validated.

## C. Baseline and PR consistency

Evaluate both full baseline and dependency delta through the same narrow assessment logic.
Report at least:
- raw advisory matches and unadjusted blocking records;
- reviewed-not-affected records, each with exact decision ID and artifact reference;
- remaining actionable blockers;
- actual risk exceptions/suppressions (unchanged; zero here).

On the archived baseline, 48 unadjusted records become 46 actionable +2 reviewed-not-affected.
On the archived --delta-base replay, 50 combined enforcement occurrences contain those
same two identities twice (baseline+delta). Show occurrences separately; do not call them
four vulnerabilities. Both baseline and delta occurrences receive the same assessment,
leaving no extra actionable SheetJS delta blocker. Keep all other 46 baseline records.

Do not force fresh counts to match a static target. New advisories remain actionable under
the unchanged policy. Raw `findings.json`/OSV evidence remains in the output and xlsx stays
in the SBOM/advisory queries.

## D. Focused acceptance tests (deterministic replay plus real CLI)

AP01 Exact two IDs + reviewed version/source/hash/provenance: both assessments apply.
AP02 Supplied baseline replay: raw48, assessed2, actionable46, risk exceptions0.
AP03 Old registry0.18.5 still blocks; no fixed-version decision transfers to it.
AP04 Same name/version but changed bytes/hash, file path or source/provenance: never relax.
AP05 Missing archive, mismatched lock/SRI, unsafe archive or unresolved graph: invalid scan;
     adjudication never rescues failed source validation.
AP06 Other/future version or fork: no inherited assessment.
AP07 New xlsx High/Critical advisory: still blocks, even beside the two reviewed matches.
AP08 Unrelated chi, OpenPGP, kin-openapi, rgbcolor etc. remain byte/ID-identical under replay.
AP09 Expired/not-yet-valid/malformed/duplicate/overbroad review record: reject or restore
     matching raw enforcement; never report clean.
AP10 Tampered evidence or materially changed affected details/aliases/ranges: re-review,
     preserving raw blocker. Mere JSON key ordering does not authorize or invalidate by itself.
AP11 A corrected/withdrawn upstream record no longer returned as a match: no fabricated
     match; clearly retire/not-apply historical assessment.
AP12 Record with someone else's artifact hash/ID, or forged `safe` field in findings:
     cannot bypass verified source matching.
AP13 Baseline and actual scanner --delta-base path apply the same decision; occurrence
     counts are separated from unique finding counts; zero duplicate actionable SheetJS.
AP14 Missing/malformed provider response still returns invalid-scan, not clean or waived.
AP15 No register or inactive record means the unmodified 48-blocker replay still fails.
AP16 Existing policy 19-regression and vendor22-regression suites remain green; changed
     test counts must be explicit, not achieved by skipping scenarios.
AP17 Canonical scanner CLI writes raw + assessed reports, decision/input hashes and guarded
     artifacts; unexpected credentials are still rejected; risk exception file unchanged.
AP18 Controlled mutation of exact record/digest/expiry produces actual nonzero enforcement;
     use disposable copies, preserve active source, no production CVE exploit required.
AP19 Existing quality/types/builds, Go/PG and browser tests remain unchanged and pass on the
     same final hosted SHA; browser remains26/26 and PostgreSQL six named gates without skips.
AP20 Fresh hosted dependency scan completes, both decisions visible, unrelated blockers
     retained. Expected dependency job remains RED while those blockers remain; no target
     of an all-five-green result for this slice.

Use archived input replays to isolate code effects from changing advisory feeds, then a
fresh hosted scan to establish current status. Do not call historical replay fresh scanning.

## E. Implementation and return boundary

No dependency upgrades, runtime/business code, A14 workbook imports, chi ingress change,
rgbcolor license approval, OpenPGP applicability, password-parser changes, migrations,
Android/OTA/deployment/live-data operations in this slice.

Implement the smallest reviewed change to existing scanner/evaluator/schema/tests/docs.
Stage explicit paths only. Continue the existing verification branch; preserve
[CF-Pages-Skip] and exact Vercel branch controls after checking they still apply. A normal
commit/push for hosted tests is covered by standing authority. No blanket git add/force.

Require hosted quality/backend/postgres/browser success and a completed security scan on
one final SHA. Do not rerun costly local Go/PG suites merely for a Python assessment edit
if there is no affected input; say accurately which proof is local, replay or hosted.

Return one packet + one ZIP with exact incremental diff, decision register/schema/matcher,
raw-vs-assessed replay evidence, live source hashes, AP matrix, negative CLI results,
unchanged exception/register and four-gate evidence, final SHA/run IDs, progress/tracker
updates and manifest. A34e4 remains review-pending until its implementation is reviewed.
