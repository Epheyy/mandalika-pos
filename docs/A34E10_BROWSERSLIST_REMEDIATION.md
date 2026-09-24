# A34e10 Browserslist remediation

Packet A34E10-BROWSERSLIST-20260924-01. AUTH-MANDALIKA-20260919-01.
Entry SHA 79403f23e63a3560a43a4c8845b91ff9102cfe96; audit/hosted-proof-20260922.
A34e9 accepted: 27 milestones / 11 findings. All 44 retained; A31 alone resolved.
A34/T29, A38/T33 and release gates open. A34e10 hosted-verified below; ChatGPT review pending.

## Minimal graph and publisher evidence

Actual root eslint-plugin-react-hooks 7.1.1 -> @babel/core 7.29.0 ->
@babel/helper-compilation-targets 7.28.6 declares Browserslist ^4.24.0.
update-browserslist-db 1.2.3 peer >=4.21.0 resolves the identical selected copy.
Ordinary targeted transitive update in isolation left the lock hash unchanged.
Compatible exact parent overrides select 4.28.7 and its minimum child data:

| Package | Before | After | Reason |
|---|---|---|---|
| browserslist | 4.28.2 | 4.28.7 | Two published security fixes |
| baseline-browser-mapping | 2.10.29 | 2.10.44 | Required ^2.10.44 |
| caniuse-lite | 1.0.30001792 | 1.0.30001806 | Required ^1.0.30001806 |
| electron-to-chromium | 1.5.357 | 1.5.393 | Required ^1.5.393 |
| node-releases | 2.0.44 | 2.0.51 | Required ^2.0.51 |

No other selected version changes. update-db peer context rekeys only. No root
Browserslist substitute or broad updater. node-releases now requires Node >=18;
the accepted Node22 CI setup satisfies this. Full manifests/licenses/engines,
retrieval timestamps, safe archive paths, SHA512/SRI and SHA256 are bundled.
Official Browserslist archive: 18245 bytes, SHA256 66daf576e768fd818214b29a82eb6f8f81e2737c612c320e9afa328871ab0997.
All published files match actual old/active/clean installations, including all
new data children and Babel helper. Lock integrity matches official archives.

## Behavior, data and limits

No checked-in Browserslist config exists in workspace package manifests or
configuration files. Actual helper targets remain {} for root/POS/Backoffice;
Babel's no-config fallback is empty, distinct from Browserslist default queries.
Actual ESLint config and Babel transform/helper APIs pass with synthetic TSX/CSS-
independent JS. Full quality builds both apps. No deployed user-controlled stats
path was established; graph presence does not prove a live application exploit.

Default, usage, last-version, maintained-node and baseline-date answers change
with the required datasets. Complete before/after outputs are bundled. A separate
controlled old 4.28.2 graph using these same four permitted datasets produces
exactly the fixed graph's outputs, including Babel targets. Thus observed sample
differences are data-driven; no application support configuration was edited.
This finite comparison is not proof about every possible query or future date.

15 isolated cases cover real helper/Babel/ESLint, explicit composition/order/errors,
config/env, normal stats and file stats, three reserved own keys, file discovery,
result and parse cache reuse/eviction, cache controls, exact bound source and targets.
Final old graph: 8 pass / 7 targeted failures. Fixed and clean: 15/15. Both public
result and parse references demonstrate eviction after 502 distinct short queries;
installed source independently checks the 500-entry bound and both setters.
No internal cache-size instrumentation, RSS limit or OOM resistance claim.

Security children: 5s, 128 MiB heap, 512 KiB stack, 64 KiB output, <=16 KiB owned
fixtures. Full Babel/ESLint compatibility children: bounded 60s (initial 5/15s
runs timed out; retained separately from regressions). Children reaped, fixtures
verified removed. Environment changes are child-local. Production caching remains
unchanged. No upstream monkeypatch, dangerousExtend or arbitrary external config.

## E9-REPORT-01

Original before-corrected.json: 12/3. Original before-final.json: 11/4 with Vite
path fixture failure. Final fixed/clean: 15/15. Original logs unchanged. New exact
committed final harness (LF-equivalent checkout; raw hashes recorded) against
55 authenticated old PostCSS files: 12/3. First new replay was 11/4 due to Vite
10s timeout during cold install/scan; second unchanged-bound replay succeeded.
No active rollback and no historical result relabelled as a new execution.

## Security accounting

Fresh local: 22 -> 20 raw, 20 -> 18 actionable, 29 report-only, 2 reviewed and
0 exceptions. Removed GHSA-73wf-gq98-2v4g and GHSA-c83g-rgw3-j3cx, both normalized
High. Publisher rates cache issue Moderate: raw publisher/global/OSV evidence
retained without downgrade. Existing Moderate GHSA-w5vr-8v7q-w6rv remains on
baseline-browser-mapping, now 2.10.44 instead of 2.10.29; not a new advisory and
not fixed by this slice. No other finding change. Inventory, CycloneDX, license
and OSV queries retain Browserslist, every data child and peer edge.
PostCSS 8.5.23 / Nano ID 3.3.18, all 15/16 checks, tar/XML/brace, exact SheetJS
artifact/assessments/expiry, policy and empty exception register preserved.

## Acceptance matrix

| ID | Evidence / result |
|---|---|
| BL01 | entry.json, consumer-inventory.json, explicit staging classification |
| BL02 | official/provenance.json, installed-provenance.json, raw advisories |
| BL03 | targeted-resolution unchanged lock; exact five-version dependency diff |
| BL04 | clean frozen install and real helper/peer context; 15/15 |
| BL05 | helper + actual repository ESLint + full quality builds pass |
| BL06 | explicit/config-env/stats controls pass |
| BL07 | target-delta.json; same-data controlled graph equals fixed outputs |
| BL08 | three reserved-key old failures; fixed passes, prototypes/input unchanged |
| BL09 | real owned stats file normal + reserved discovery paths tested |
| BL10 | result/parse identity eviction plus exact source, no size instrumentation |
| BL11 | all child/fixture cleanup; retained/denied installs untouched |
| BL12 | finding-delta.json, coverage-proof.json; two IDs gone, data record retained |
| BL13 | prior checks remain green; preserved-inputs.json |
| BL14 | mandatory quality integration; full quality + policy/applicability pass |
| BL15 | hosted same-SHA proof verified below; explicit staging and trigger audit pass |
| BL16 | current packet/manifest, E9 correction and residuals retained |

Full repository lint is not claimed: the relevant real-config synthetic ESLint
path is tested; quality remains the established mandatory definition. Windows
Node24 local proof is distinct from hosted Node22. No release readiness claim.
Four previously denied installation copies and stopped database cleanup remain
untouched. Prior/new isolated installation copies retained without deletion;
only this harness's tiny owned fixtures use normal cleanup. No deployment,
Android/OTA/live data, chi/rgbcolor/OpenPGP/password/A14 or policy changes.

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

## Scoped review acceptance — E60

CG-A34E10-BROWSERSLIST-20260924-01-R1 accepts this slice at 4f63473.
E9-REPORT-01 closed as corrected evidence; no extra milestone or parent closure.
28 milestones across 11 findings; all44 retained, A31 alone resolved; gates open.
