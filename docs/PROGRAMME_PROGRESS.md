# Programme progress — A34e12 accepted; A34e13 qualification

## Current A34e13 checkpoint — 2026-09-24

E64: CG-A34E12-VITE-20260924-01-R1 accepts A34e12 atbc738ac within its actual
Windows/Linux/pure-editor evidence limits. E11-REPORT-01 is closed as corrected
attribution; original logs preserved, no extra replay/milestone. E9 stays closed.
30accepted milestones across the same11findings. All44parents remain; A31 alone
resolved; original8P0 parents, A34/T29,A38/T33 and all release gates stay open.
E65: A34E13-XMOD-20260924-01 qualifies x/mod0.40.0, requiring x/tools0.49.0,
x/net0.58.0 and telemetry20260811. Real generatorv2.4.1 and generated contracts
preserved. Test-only offline lookup/tile regressions: old3pass/2behavioral failures,
fixed5/5. Fresh scan14raw/12actionable/27report-only/2reviewed/0exceptions; only
GO-2026-6179/6180 records removed. Six local native18.3 PostgreSQL gates pass,
142named tests, zero skips, verified identity/cleanup; local CGO-disabled/no-race.
Default localGo is1.26.2, distinct from scanner/hosted1.26.8. Existing cached1.26.8
was selected per process for this work; no persistent/global toolchain change.
Fresh patched-toolchain downloads in owned cache match preserved initial bytes;
this does not establish historical cache integrity or a POS runtime exploit.
Hosted same-SHA proof pending. Earlier checkpoints remain historical.

## Current A34e12 checkpoint — 2026-09-24

E62: CG-A34E11-JSYAML-20260924-01-R1 accepts A34e11 at7d2ab47 within supplied
limits, including EXACT project-qualified Redocly1.34.14 -> js-yaml4.3.2 override.
Not range-satisfied, publisher approved or a blanket pin bypass. Consumer/generator
tests preserved.29accepted milestones across the same11findings; all44 parents
retained; A31 alone resolved; A34/T29,A38/T33 and every release gate open.
E11-REPORT-01 corrected: before-tests18/12; before-final17/13 includes unrelated
missing-flat-config fixture; fixed active/clean30/30. Original logs unchanged.
E9 remains closed; neither evidence correction adds a milestone.
E63: A34E12-VITE-20260924-01 qualifies Vite8.0.16/Rolldown1.0.3 and minimal
support graph. Three supervised groups pass active/clean; real Windows NTFS ADS
and actual8.3 alias vectors are blocked after qualified old-version reproduction.
UNC evidence is exact-source/extracted-pure-predicate only, with no UNC I/O/editor.
Local quality passes; security16raw/14actionable/27report-only/2reviewed/0exceptions.
Only Vite's oneHigh + oneModerate records disappear. Hosted proof verified below; ChatGPT review pending.
Earlier checkpoints are historical; A34e12 is not yet ChatGPT-accepted.

## Current A34e11 checkpoint — 2026-09-24

E60: CG-A34E10-BROWSERSLIST-20260924-01-R1 accepts A34e10 at 4f63473.
28 accepted milestones across the same 11 findings. E9-REPORT-01 is closed as
corrected evidence, not an extra milestone or parent. No new E9 replay required.
All 44 parents retained; A31 alone resolved. A34/T29, A38/T33 and release gates open.
E61: A34E11-JSYAML-20260924-01 locally verifies js-yaml4.3.2 through both
ESLint/eslintrc and Redocly/OpenAPI. Exact Redocly pin override is documented,
not claimed range-satisfied.30/30 active/clean; before-tests18/12, before-final17/13
(extra missing-flat-config fixture; corrected by E11-REPORT-01). Fresh scan17raw/15actionable/
28report-only/2reviewed/0exceptions;3High+1Moderate IDs removed. Hosted proof verified below; ChatGPT review pending.
Earlier checkpoints are historical. The next slice is not yet accepted.

## Current A34e10 checkpoint — 2026-09-24

E58: CG-A34E9-POSTCSS-20260923-01-R1 accepts A34e9 at 79403f2 within its
supplied evidence. 27 accepted milestones across the same 11 findings. All 44
parents remain; A31 alone is resolved. A34/T29, A38/T33 and every release gate open.
E9-REPORT-01 corrects active evidence: before-corrected 12/3; before-final 11/4
includes a separate Vite path fixture failure; after-final and clean 15/15.
A new exact-final-harness replay on the qualified old graph is 12/3; original
logs are retained. See A34E10_BROWSERSLIST_REMEDIATION.md for hashes and limits.
E59: A34E10-BROWSERSLIST-20260924-01 implements compatible Browserslist 4.28.7
and four required minimum data updates. 15 checks pass active and clean; old
qualified graph 8 pass / 7 targeted failures. Fresh local security: 20 raw /
18 actionable / 29 report-only / 2 reviewed / 0 exceptions. Two Browserslist
High IDs disappear; the existing Moderate baseline-browser-mapping record
only changes selected version. Hosted proof verified below; ChatGPT review pending.
Earlier sections are historical checkpoints, not current acceptance counters.

AUTH-MANDALIKA-20260919-01. Canonical tracker: docs/AUDIT_COVERAGE_TRACKER.md.

## Current A34e9 checkpoint — 2026-09-23

E56: CG-A34E8-NANOID-20260923-01-R1 scoped accepts A34e8 at4cd7f89.
26accepted milestones/same11findings;all44retained,A31alone resolved.
E57: A34E9-POSTCSS-20260923-01 updates actual Vite->PostCSS8.5.23, preserving
Nano ID3.3.18 and all16worker assertions through real consumer resolution.
15PostCSS cases pass;3targeted before-fix read/propagation failures. Freshlocal
23->22raw/21->20actionable/30->29report-only;reviewed2/exceptions0. OneHigh and
oneModerate PostCSS record removed,no unrelated change. Hosted verified;review pending.
FullA34/T29,A38/T33 and every release gate open. Earlier checkpoints are historical.

0/8 original P0 parents and0release gates closed; counters are not readiness percentages.
Chi trust,rgbcolor legal,OpenPGP,password,A13/A42,A37,A35 and native qualification
remain separate. Denied cleanup targets untouched.

## Final hosted proof — 2026-09-23

Source `79403f23e63a3560a43a4c8845b91ff9102cfe96`, tree `c12e2c2228819ed126f90304c41b84b4d16461f8`. Quality35848841958,
backend35848841933,PostgreSQL35848841864,browser35848841866 all succeed
on this exact SHA. Hosted Node22 passes15PostCSS+16Nano ID+20brace+10XML+6tar.
Backendgenerateddrift/vet/gofmt/build/race passes. Docker18.3/race:6fixtures,
142namedpasses,zero skips,identity and cleanup verified. Chromium26/26,zero skips,
clean network/owned-process/port state. Fresh security35848842086 completes RED:
22raw/20actionable/29report-only/2reviewed/0exceptions. Committed input hashes match;
hosted normalized findings equal local after-scan. Exactly1High blocker and1Moderate
report-only PostCSS record removed; no other record changes. Nano ID3.3.18 covered.
A34e9 implemented/locally+hosted verified; ChatGPT review pending.26accepted milestones
across11findings; all44 remain,A31alone resolved,A34/A38 and every release gate open.
Post-proof docs are local reporting after-images, separate from tested executables.
Four denied installation copies untouched; prior/new retained copies not deleted.
Owned tiny fixtures/processes cleaned. No signing/deployment/OTA/live operation.

## Final A34e10 hosted proof — 2026-09-24

Commit `4f6347346ac738e9ac4c7c295dd26351e1cd9e94`, tree `a1f437a7433dee752d9acdeef89ca72fa462544d`, branch audit/hosted-proof-20260922.
All four application workflows succeed on this exact SHA. Node22 quality passes
15 Browserslist + 15 PostCSS + 16 Nano ID and prior dependency/application checks.
Backend gen/vet/fmt/build/race passes. Docker PostgreSQL18.3/race: six fixtures,
142 named passes, zero skips, verified identities and cleanup.
Chromium26/26, zero skips, no unexpected external requests, clean owned processes/ports.
Fresh security completes RED for remaining blockers: 20 raw / 18 actionable /
2 reviewed / 0 exceptions. Hosted normalized findings equal local; source hashes match.
Two Browserslist High IDs removed. Existing Moderate baseline-browser-mapping finding
remains with only its selected version changed. Publisher severity disagreement retained.
A34e10 implemented and locally/hosted verified, ChatGPT review pending. A34e9 accepted;
27 accepted milestones / 11 findings. All44 retained; A31 alone resolved. A34/A38 and
all release gates remain open. Post-proof documentation is a local reporting after-image.
Denied cleanup targets untouched; new installation copies retained without deletion.
No signing, deployment, OTA or live operation.

| Workflow | Run | Result |
|---|---|---|
| backend | [35950742331](https://github.com/Epheyy/mandalika-pos/actions/runs/35950742331) | success |
| dependency-security | [35950742289](https://github.com/Epheyy/mandalika-pos/actions/runs/35950742289) | failure |
| Mandatory PostgreSQL integration | [35950742279](https://github.com/Epheyy/mandalika-pos/actions/runs/35950742279) | success |
| JS/TS Quality | [35950742254](https://github.com/Epheyy/mandalika-pos/actions/runs/35950742254) | success |
| Mandatory Chromium browser gate | [35950742274](https://github.com/Epheyy/mandalika-pos/actions/runs/35950742274) | success |

## Final A34e11 hosted proof — 2026-09-24

Source `7d2ab470fa4edfa78c9ee8f3c435587590681e81`, tree `72682d1e8f74a14891e93360b8dfab762e961bda`, audit/hosted-proof-20260922.
Quality/backend/PostgreSQL/browser succeed on this exact SHA. HostedNode22 passes
30 js-yaml +15 Browserslist +15 PostCSS +16 NanoID and prior accepted checks.
Backend generated drift/vet/gofmt/build/race passes. DockerPostgreSQL18.3/race:
6 fixtures, 142 named passes, zero skips, verified identity/cleanup.
Chromium26/26, zero skips, clean network/owned processes/ports. Fresh security
completes RED: 17 raw / 15 actionable /28report-only/2reviewed/0exceptions.
Source input hashes match commit; hosted normalized findings equal local. Removed
three High and one Moderate js-yaml IDs; no new/changed unrelated record.
A34e11 locally/hosted verified, ChatGPT review pending. A34e10 accepted; E9-REPORT-01
closed as corrected evidence only.28accepted milestones/same11findings;all44parents
retained,A31alone resolved. A34/T29,A38/T33 and every release gate stay open.
Post-proof docs are local reporting after-images, not another executable revision.
Previously denied cleanup targets untouched; two new install copies retained.
No signing, deployment, OTA, live data or business policy change.

| Workflow | Run | Result |
|---|---|---|
| backend | [35953693676](https://github.com/Epheyy/mandalika-pos/actions/runs/35953693676) | success |
| Mandatory PostgreSQL integration | [35953693549](https://github.com/Epheyy/mandalika-pos/actions/runs/35953693549) | success |
| dependency-security | [35953693547](https://github.com/Epheyy/mandalika-pos/actions/runs/35953693547) | failure |
| JS/TS Quality | [35953693570](https://github.com/Epheyy/mandalika-pos/actions/runs/35953693570) | success |
| Mandatory Chromium browser gate | [35953693545](https://github.com/Epheyy/mandalika-pos/actions/runs/35953693545) | success |

## Final A34e12 hosted proof — 2026-09-24

Source `bc738ace71e2d86f39ff810aa525550d5adabd7d`, tree `a0636fc3f73d6eceddcf3f848917fc2488fe218b`, audit/hosted-proof-20260922.
Quality/backend/PostgreSQL/browser succeed on this exact SHA. HostedNode22 passes
three Vite groups plus YAML30, Browserslist15, PostCSS15, NanoID16 and prior checks.
Hosted Linux executes normal server/transforms/HMR/denial/source guards; Windows
ADS/8.3 is explicitly platform-not-applicable there. Separate local WindowsNTFS
old/fixed proof supplies that qualification. The actually loaded LinuxRolldown
binary hash matches the independently verified official1.0.3 archive.
Backend generated drift/vet/gofmt/build/race passes. DockerPostgreSQL18.3/race:
6fixtures, 142 named passes, zero skips, verified identities/cleanup.
Chromium26/26, zero skips, clean network/owned processes/ports. Fresh security
completes RED: 16raw/14actionable/27report-only/2reviewed/0exceptions.
Source input hashes match commit; hosted normalized findings equal local. Removed
oneHigh and oneModerate Vite record only. All unrelated records remain unchanged.
A34e12 locally/hosted verified, ChatGPT review pending. A34e11 scoped accepted:
29milestones/same11findings; all44parents retained; A31 alone resolved.
A34/T29,A38/T33 and every release gate remain open. E11-REPORT-01 corrected;
E9 stays closed. Post-proof docs are local reporting after-images; implementation
matches hosted SHA. No intermediate failed application workflow for this slice.
Denied cleanup targets untouched; new install copies retained. No deployment,
signing, OTA, live data or business-policy change.

| Workflow | Run | Result |
|---|---|---|
| backend | [35957157697](https://github.com/Epheyy/mandalika-pos/actions/runs/35957157697) | success |
| Mandatory PostgreSQL integration | [35957157788](https://github.com/Epheyy/mandalika-pos/actions/runs/35957157788) | success |
| dependency-security | [35957157726](https://github.com/Epheyy/mandalika-pos/actions/runs/35957157726) | failure |
| JS/TS Quality | [35957157736](https://github.com/Epheyy/mandalika-pos/actions/runs/35957157736) | success |
| Mandatory Chromium browser gate | [35957157951](https://github.com/Epheyy/mandalika-pos/actions/runs/35957157951) | success |
