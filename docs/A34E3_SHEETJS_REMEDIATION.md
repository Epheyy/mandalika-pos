# A34e3 — official SheetJS vendoring and scanner coverage

Packet: A34E3-SHEETJS-20260923-01. Authority: AUTH-MANDALIKA-20260919-01.
Incoming review: CG-A34E2-XCRYPTO-20260923-01-R1. Entry SHA:
76cc02b2fec813ee534a998c9a45ff9cde5db9f4 on audit/hosted-proof-20260922.

A34e2 is scoped accepted (20 milestones / same 11 findings). A34e3 is locally and hosted
verified, awaiting ChatGPT review. A34/T29, A38/T33, A14 and every release
gate stay open. All 44 findings remain tracked; A31 alone is resolved.

## Source and installed identity

Official source: https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz
Retrieved: 2026-09-23T03:31:14.842668+00:00. Size: 2,409,319 bytes.
SHA-256: 8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8.
SRI: sha512-oLDq3jw7AcLqKWH2AhCpVTZl8mf6X2YReP+Neh0SJUzV/BdZYjth94tG5toiMB1PPrYtxOCfaoUCkvtuH+3AJA==.

The manifest is xlsx/0.20.3, Apache-2.0, with no consumer dependencies and no
install lifecycle script. Publisher build/test/dev metadata is retained verbatim.
Both package/LICENSE and package/dist/LICENSE contain identical 11,355-byte terms,
SHA-256 4d2a38ac35cda06a555c84074a819d413339cd3691b822cae50f8f322fe01f64.
Copyright is (C) 2012-present SheetJS LLC. No separate NOTICE was found.
The exact terms and attribution accompany Backoffice public/distributed files.
No independent publisher checksum/signature is claimed. Initial inspection did not
extract or execute package contents; approved install/tests subsequently use it.

Backoffice uses file:../../vendor/sheetjs/xlsx-0.20.3.tgz. Frozen installation,
installed CommonJS/ES module hashes, browser import and trusted Node test reader
all resolve 0.20.3. Root/POS have no direct xlsx dependency. Production imports
remain export-only through csvUtils; other exporter callers retain their existing
contract. Tests read synthetic exports, not untrusted uploads. No A14 import added.

The exact lock delta replaces registry 0.18.5 and removes eight exclusively owned
transitive nodes: adler-32, cfb, codepage, crc-32, frac, ssf, wmf, word. No unrelated
version moves. 441 -> 433 npm nodes; 137 Go modules unchanged. Absence of consumer
edges does not prove absence of embedded implementation code or vulnerabilities.

## Security coverage and remaining applicability question

Archive/manifest/lock pins, path safety, graph completeness, component identity,
licenses, OSV query coverage, CycloneDX distribution properties and PR artifact
changes are now checked for file dependencies. All vendor and workspace inputs
are hashed. The policy and exceptions register are unchanged.

Fresh before/after local scans both complete with 48 blockers and no suppressions.
The two SheetJS blockers remain, now correctly attributed to xlsx/0.20.3:
GHSA-4r6h-8v6p-xvw6 (CVE-2023-30533) and GHSA-5pgg-2g8v-p4x9
(CVE-2024-22363). OSV's affected SEMVER events contain introduced:0 without a fixed
boundary. Additional last_known_affected_version_range metadata says <0.19.3 and
<0.20.2 respectively. Raw responses are retained without editing.

The publisher advisories identify fixes at >=0.19.3 and >=0.20.2:
https://cdn.sheetjs.com/advisories/CVE-2023-30533 and
https://cdn.sheetjs.com/advisories/CVE-2024-22363. Its export-only qualification is
separate from the package-level conservative policy; no automatic waiver is made.

Q-A34e3-01 for ChatGPT: review this exact hash/distribution/range discrepancy.
Recommend a separately reviewed exact applicability annotation bound to both IDs,
xlsx/0.20.3 and this artifact hash, retaining raw feeds and their conflicting ranges;
alternative is waiting for corrected upstream feeds. No annotation, exception or
threshold change is implemented here. The current gate continues to block both.
chi ingress, kin-openapi, rgbcolor legal approval and OpenPGP remain visible.

## Verification and limitations

- Fresh disposable frozen/offline/ignore-scripts install succeeds; missing and
  tampered archives fail both the pre-install guard and real pnpm installation.
- 22 vendor safety/graph/advisory/delta tests pass, including unsafe paths, links,
  duplicate manifests, identity/digest mismatch, provider failure and High finding.
- Existing policy negative suite passes with active sources unchanged.
- Two workbook contract tests pass before and after the dependency replacement.
- Canonical local quality:ci passes tests, app/package/harness types, both production
  builds and regenerated API drift. Local Node is 24.14.1; hosted uses Node 22.
- All 26 required Chromium scenarios pass with zero skips, unexpected external
  requests or surviving owned browser/Vite processes. Real Backoffice XLSX downloads
  cover 51/201/1000 rows, qris and single-row search filters, expected totals, exact
  column order, typed/leading-zero IDs, date strings, Unicode, empty fields, numeric
  amounts and formula-like literal text. Empty/page-failure exports stay disabled.
  Nine workbooks are downloaded and parsed; independent expected cell values/types
  are asserted as well as same-library readback. No Excel desktop qualification.
- Both CycloneDX 1.6 SBOMs pass installed Ajv structural schema validation. This
  validation ignores unsupported iri-reference/idn-email formats; it is not a full
  format conformance certification. The actual vendor source is fixed HTTPS.
- The first baseline scan hit a transient connection reset; a fresh full retry
  completed. An initial vendor unit exposed Windows short-path root normalization;
  corrected locally, final quality green. Failed logs remain in the packet.
- No Go, database, auth or financial source changes. Fresh hosted backend/race and
  all six Docker PostgreSQL fixtures are required on the committed source; local
  PostgreSQL fixtures were not repeated for this JavaScript/scanner-only slice.

No deployment, Android/OTA, live-data changes, historical rewrites, exception,
provider/credential changes or stopped-cleanup bypass. Full concurrency, secret
history scanning, branch protection and release provenance remain separate.

## Hosted proof and reporting boundary

Final pushed SHA: de7352fa5fb0cf877e869b1c65040a2731969ccb; tree 4ff434471aa18829de471f59b1cdd17b0d991ade.

| Workflow | Run | Result |
|---|---:|---|
| JS/TS Quality | [35817402212](https://github.com/Epheyy/mandalika-pos/actions/runs/35817402212) | success |
| Mandatory Chromium browser gate | [35817402181](https://github.com/Epheyy/mandalika-pos/actions/runs/35817402181) | success |
| Mandatory PostgreSQL integration | [35817402363](https://github.com/Epheyy/mandalika-pos/actions/runs/35817402363) | success |
| backend | [35817402195](https://github.com/Epheyy/mandalika-pos/actions/runs/35817402195) | success |
| dependency-security | [35817402219](https://github.com/Epheyy/mandalika-pos/actions/runs/35817402219) | failure |

All five runs use the same final SHA. The dependency scan completes (not unavailable):
433 npm/137 Go modules,82 advisory records,48 blocking records,zero suppressions.
All12 source-input hashes, including vendor/provenance, match committed blobs.
PostgreSQL uses Docker18.3/race, six gates/142 named passes/zero skips and verified
identity/cleanup. Hosted browser26/26,zero skips,unexpected network requests or
surviving processes. BO-PAGES-XLSX confirms nine real workbook downloads. Backend
passes generated drift/vet/gofmt/build/race; quality uses Node22/frozen lockfile.
No intermediate hosted correction was needed. This expected dependency-policy red
run is retained; it is not an all-five-green result.

Post-proof report/tracker/progress after-images remain local documentation changes;
executable files match the hosted commit. Review inbox/raw history/ZIPs and the
append-only session handoff are excluded from Git. Twenty accepted milestones stay
unchanged until ChatGPT reviews A34e3. No GitHub deployment records found for SHA;
external provider configuration was not changed or asserted exhaustively known.

## Executed PR-delta proof

The actual fresh scanner CLI with --delta-base76cc02b also completes and identifies
only the xlsx0.20.3 vendor distribution as changed, retaining both advisory IDs.
Its combined policy result contains50 enforcement records:48 baseline plus the
same two PR-delta records, not50 distinct blockers or two new vulnerabilities.
This is separate from the hosted push baseline of48. See pr-policy/delta-result.json
and pr-scan-command.json; no PR was opened or release workflow dispatched.

## Scoped acceptance — CG-A34E3-SHEETJS-20260923-01-R1

A34e3 is accepted within the supplied vendoring/scanner/export/hosted limits.
21 milestones across11 findings; all44 retained,A31 alone resolved,no P0/release
closure. Q-A34e3-01 is answered: two exact-artifact applicability decisions may
proceed in A34e4. The preceding48-blocker results remain their historical results;
new raw-versus-assessed reporting belongs to A34E4_SHEETJS_APPLICABILITY.md.
