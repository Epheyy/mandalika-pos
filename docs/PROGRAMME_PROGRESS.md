# Programme progress — A34e10 accepted; A34e11 qualification

## Current A34e11 checkpoint — 2026-09-24

E60: CG-A34E10-BROWSERSLIST-20260924-01-R1 accepts A34e10 at 4f63473.
28 accepted milestones across the same 11 findings. E9-REPORT-01 is closed as
corrected evidence, not an extra milestone or parent. No new E9 replay required.
All 44 parents retained; A31 alone resolved. A34/T29, A38/T33 and release gates open.
E61: A34E11-JSYAML-20260924-01 locally verifies js-yaml4.3.2 through both
ESLint/eslintrc and Redocly/OpenAPI. Exact Redocly pin override is documented,
not claimed range-satisfied.30/30 active/clean; old18/12. Fresh scan17raw/15actionable/
28report-only/2reviewed/0exceptions;3High+1Moderate IDs removed. Hosted proof pending.
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
