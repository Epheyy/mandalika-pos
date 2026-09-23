# A34e4 — exact SheetJS advisory applicability

Packet A34E4-SHEETJS-APPLICABILITY-20260923-01. Authority AUTH-MANDALIKA-20260919-01.
Current review CG-A34E3-SHEETJS-20260923-01-R1 accepts A34e3 and answers Q-A34e3-01.
21 accepted milestones/11 findings;44 retained,A31 alone resolved,no P0/release
closure. A34e4 is implemented and hosted-verified; ChatGPT review is pending.

## Bounded implementation

Two records only: GHSA-4r6h-8v6p-xvw6/CVE-2023-30533 and
GHSA-5pgg-2g8v-p4x9/CVE-2024-22363. Subject npm/xlsx/0.20.3, official source
https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz, SHA256
8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8.
Provenance digest ffa08a4114b33b8f73250ffef615445566aca07678e7a918b304cebfd0c4bc6f.
Full subject/SRI/bytes, reviewer/source/retrieval/review dates and evidence digests
are in dependency-applicability.json. Review expires2026-10-23T00:00:00Z.

The register is not a risk exception. Actual vendor/lock/manifest/provenance checks
precede exact matching. Material OSV evidence and classification fingerprints must
match frozen reviewed snapshots. No repinning, global range reinterpretation,
severity change, package ignore, new alias inheritance or caller safe flag.
Publisher evidence uses the approved reviewed snapshots and bounded freshness,
not a fragile live HTML scraper. No independent exploit test or standard VEX claim.

The initial decision-seed seven-field semantic digests were independently reproduced.
Implementation also fingerprints summary/references and normalizes unordered arrays;
its resulting hashes differ by documented encoding/coverage, not altered evidence.
Raw approved snapshots and raw provider responses are preserved. Runtime source
and rule inputs are hashed and guarded. Strict LF provenance checkout restores
exact reviewed committed bytes previously converted to CRLF on Windows; archive
and logical provenance are unchanged. `.gitattributes` prevents recurrence.

The historical48-blocker CI fixture extracts exact blocking/suppressed arrays with
original artifact hash/source commit; nonblocking/complete license-result arrays
are omitted only from this focused fixture. Full historical reports are in the
review bundle. Runtime does not read that test fixture.

## Verification

16 applicability tests and actual CLI proofs pass, covering AP01–18; vendor22 and
policy19 regressions pass unchanged. Canonical local quality:ci passes349 app/package
tests plus the pre-existing optional replay skip, typechecks, builds and API drift.
No local Go/PG rerun for Python-only assessment changes; fresh hosted equivalents
are required. No dependency/toolchain upgrade or business-source edit.

Before-code real CLI archived replay:48 blockers. Same source/evidence through new
CLI:48 raw/46 actionable/2 reviewed-not-affected/0 risk exceptions. Actual --delta-base
76cc02b replay:50 raw occurrences/46 actionable/4 reviewed occurrences (2 identities).
The retained46 match original records exactly. Raw findings/OSV/SBOM identities
remain unchanged. No static count is imposed on future fresh scans.

Replay uses the real unchanged-dependency inventory collection with archived A34e3
OSV/pnpm/KEV/govulncheck snapshots, not mocks. Its reconstructed inputs and command
results are labeled separately from fresh collection. Missing/malformed input
remains invalid-scan. Fresh hosted source/fixture/browser proof is recorded below.

## Residuals and next bounded recommendation

A34/T29,A38/T33,A14 and every release gate remain open. chi trust,rgbcolor legal
approval,OpenPGP,password parsing,financial concurrency,native/OTA provenance and
historical stopped cleanup remain separate and unchanged.

Recommend next investigating the remaining tar7.5.x build-dependency patch: current
inventory has7.5.15 and three blocking records, including Critical. Trace exact
parents and current publisher fixes before a minimum compatible patch; do not
mix native/provider changes or broad npm upgrades. This is a recommendation only;
no next-family implementation is begun here. Source references and path evidence
are attached in remaining-blockers.json/next-recommendation.json.

## Final hosted verification

Final commit 31080a4b40515369bd050d1eb13150d04fa21971, tree
7caf7d434e0653f1cf5a9fd37f726f7a709a6a6d on audit/hosted-proof-20260922.
Normal explicit 19-path commit/push retained the deployment-skip controls.
Quality35822121487, backend35822121506, PostgreSQL35822121575 and browser35822121515
passed. Database: six mandatory Docker18.3 fixtures with race, 142 pass events,
zero skips, identities and cleanup verified. Browser:26/26, zero skips, no blocked
network requests or owned-process/port residue. Dependency-security35822121570
completed fresh collection:48 raw /46 actionable /2 reviewed-not-affected /0 risk
exceptions. Its red outcome is expected for the unrelated blockers. Every source
input hash in the hosted scanner matches the commit. No failed intermediate run.

AP01–20 matrix, actual disposable CLI negatives, replay inputs, raw/assessed reports,
source hashes and full hosted logs are in the current review ZIP. The exact 11-path
implementation diff reproduces committed bytes in a disposable copy. No local Go/PG
rerun; current hosted evidence covers them. No hosted PR event; real --delta-base
CLI replay establishes that path. General Go opt-in tests and the optional local/CI
Backoffice replay are distinguished from zero-skip mandatory gates.

Conventional git whitespace checking reports retained raw OSV CRLF and two Markdown
hard breaks in the copied scope. These are documented evidence formatting, not a
source defect; raw reviewed bytes were not altered to hide the warning. The index
secret/path checks passed. This is not full A37 secret/history scanning.

Post-proof progress/tracker/report after-images are local documentation changes.
Executable files remain exactly the hosted commit. A34e4 still awaits review and the
accepted milestone count remains21. All44 findings and all release gates are retained.

## Scoped review acceptance — 2026-09-23

CG-A34E4-SHEETJS-APPLICABILITY-20260923-01-R1 accepts the bounded exact-artifact
matcher and baseline/PR integration at31080a4, within its supplied evidence limits.
Earlier review-pending text describes the submitted checkpoint. Acceptance adds
one milestone:22 across11 findings. All44 remain; A31 alone resolved; A34/A38 and
release gates stay open. Register, evidence, policy, exceptions and review deadline
remain unchanged by the next tar-only remediation.
