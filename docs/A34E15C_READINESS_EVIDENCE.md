# A34e15c — commissioning-readiness evidence

Packet **A34E15C-READINESS-20260929-01**, 2026-09-29 (Asia/Jakarta).
Reply **CG-A34E15B-INGRESS-DESIGN-20260929-01-R1**; authority
**AUTH-MANDALIKA-20260919-01**. The canonical tracker remains AUDIT_COVERAGE_TRACKER.md.

## Result and stop boundary

**External inputs are required.** The bounded pass resolved the deployed build/source
and available signed-client artifact facts. It did not establish a non-business target,
owned hostname, operator/budget, route exclusivity or installed fleet. Stop dependent
ingress work here until the exact inputs below arrive. Do not repeat the design/models,
re-query disabled Compute, infer a deployment mandate, or ask for programme reauthorization.
`activation_ready=false`; A34e15b is accepted **DESIGN BASELINE ONLY**.

Keep 32 accepted milestones across 11 findings, all 44 parents, A31 alone resolved,
original P0 parents 0/8 resolved, release gates 0. A34/T29 and A38/T33 remain open.
Retained security evidence is 6 raw / 4 actionable / 23 report-only / 2 reviewed /
0 exceptions, not a fresh scan. Detached chi-only 4/2 remains non-adopted. E9/E11 stay closed.

## Source identity: three separate columns

| Role | Evidence on 2026-09-29 | Conclusion and limit |
|---|---|---|
| Currently deployed | Selected Cloud Run traffic: mandalika-pos-00077-b45 at 100%; image sha256:fefb83941060a17d65a032b4e0ab7f3e4196f21a1562ba20e3e5fe30692c5e1e | Same immutable revision as the dated 2026-09-28 snapshot. No service request or deployment occurred. |
| Original build/source | Cloud Build 82827d61-cd0f-4814-a00f-524afd1cd7c9, SUCCESS, 2026-07-09; exact image output and resolved GCS source generation 1783574962355308 | Source-mapped to immutable build archive. Downloaded archive SHA256 and MD5 both match build sourceProvenance. No image layers executed. |
| Accepted source | Local/accepted HEAD 0478648e6600ce201e0a6e712ac77febdded9782; tree 2ac4f0aedd03d18fb07d139ac92de1e691bb92a7 | Known-different from deployed source. No new accepted image/APK built in this turn. Historical hosted source checks are not artifact identity. |
| Future commissioning source | Not selected; isolated project/service boundary and artifact also not identified | External input X01. No implicit deployment of the audit branch or historical artifact. |

Exact archive:
`gs://run-sources-mandalika-pos-asia-southeast2/services/mandalika-pos/1783574861.845163-8ecda157f6f24168bdd2a1c3044d37b9.zip#1783574962355308`.
53,280,021 bytes; SHA256 `de77f1399dbdf2dee01eb59baf8c2a6ead31acb790b1c40ef3d24b661e175efc`.
108/108 selected Go/SQL/spec/build inputs are byte-identical to repository commit
6093c6d4db1a66c4e8b902826449f627a857d4dd. Fourteen differ from accepted HEAD, including
module files, generated contracts, handler/sync and order/pricing/read/write code.
The archive has 147 members; this comparison is not an attestation of an entire original
Git checkout or reproducible dependency build. It establishes known-different source
without treating the older deployment as an instruction to replace it.

## Available client artifacts versus actual installations

| Evidence | Available signed release | Local debug artifact |
|---|---|---|
| Artifact | GitHub run 28996622264 / artifact 8190030052, built 2026-07-09 from 6093c6d4 | Repository Android debug build output; source build identity unavailable |
| Archive / APK digest | Archive 60b53370eb18969c4b8f4ed99bba86ac9e66ba4732f079e5232f71e953516f22; APK 0b3526baa71d1f1037310f2e1751253dc1169151431d51804055926d832d9a99 | APK 890b016c115b3fecab904ee8f5eaf83810cd5afa21a3c0d3be39b267dfd1ca5b |
| APK bytes | 28,316,334 | 5,169,859 |
| Manifest | com.mandalika.pos, versionName 1.0, versionCode 1 | Same package/version labels, different artifact |
| Verified signer SHA256 | b045cb4d1f43e569842b8087e0fe42b03ac305b68ac2843586843d48e41413cf | adb1d8199624926ccc078eddd362f5caea8314e34f8c0aeda02c5b3545d804c3 |
| Compiled API caller | Numbered run.app origin, confirmed at bundled client baseUrl | Private LAN origin on port8080, withheld from bundle |
| Native updater config | updateUrl uses numbered run.app `/api/v1/ota/check`; autoUpdate=true; allowModifyUrl/persistModifyUrl omitted | CapacitorUpdater configuration absent |
| Updater version | Run-source frozen lock declares 8.50.2; binary version not independently measured | Unknown |
| Installed cohort/count | Unknown | Unknown |
| Rollback status | Exact signed bytes retained locally; queue/storage/upgrade/downgrade compatibility not qualified | Different signer: not an interchangeable release rollback |

The release API and native OTA origin is
`https://mandalika-pos-538849926142.asia-southeast2.run.app`.
The artifact's omitted flags remain **absent/unknown**, rather than manufactured measured
false values. The source-correlated 8.50.2 implementation defaults allowModifyUrl to false;
therefore plan native-release qualification unless a measured supported cohort proves an
existing safe capability. A JS API replacement cannot by itself establish OTA URL migration.
No APK was executed or installed; no device, token, localStorage or financial queue was read.

Available artifact scopes: latest 20 Android runs only, latest successful run 1/1 artifact;
GitHub Releases listing returned empty; source-declared GCS prefix
`gs://mandalika-pos-ota/pos/android/` returned zero objects in one complete page. That is
not a release-publication database or fleet inventory. Existing device bundles, other
locations, manual builds and offline terminals remain possible. GitHub's signed archive
expires 2026-10-07T05:36:29Z; verified bytes are now retained in the private local evidence
folder. This is preservation, not new publication or rollback qualification.

## Route and access evidence

The exact thirteen route IDs and original future dispositions are retained in
[READINESS_EVIDENCE.json](ingress-readiness/READINESS_EVIDENCE.json). No new architecture.

| Existing route(s) | Current evidence class and limit | Gate |
|---|---|---|
| default-numbered, default-hashed | Current selected service metadata still lists both URLs and ingress all; public invoker evidence reused from 2026-09-28. No effective HTTP test. | G01 |
| canonical-edge | Proposed; no owned custom hostname or selected resource IDs. pages.dev in an artifact is not dedicated API-domain control. | G02 |
| domain-mapping | Historical selected regional response empty; does not exclude other-project/internal routes. | G03 |
| revision-tag | Current traffic contains one untagged 100% revision; not an exhaustive historical route inventory. | G03 |
| neg-url-mask, alternate-external-lb, internal-lb | Compute SERVICE_DISABLED from 2026-09-28 reused; no retry or enablement. Inventory unavailable, not empty. | G04 |
| internal-direct | Unknown effective bypass; current all ingress is not exclusion. | G01 |
| external-proxy, async-platform | Supported caller/owner inventory unavailable; no unrelated provider enumeration. | G05 |
| http-monitor | Source-declared handlers; actual monitor contract unknown. | G06 |
| tcp-startup | Historical same revision TCP8080, threshold1, period/timeout240. Separate from application HTTP readiness. | G06 |

X03 requests the narrow reference/grant export needed from an operator. No header spelling,
Host, public range, guessed hop count or ingress setting is promoted to route authentication.
Q-IS-01 remains a conditional, unqualified IAP alternative. The supplied review did not
settle public allUsers/custom bearer precedence. No new research, support submission,
credential/header migration or bearer probe was performed.

## Four readiness boundaries, mapped to G01–G07 and M0–M6

| Phase | Inputs needed before that phase | Later evidence to collect, not assumed now |
|---|---|---|
| Isolated non-business commissioning — M0/M1 | X01 target/source/isolation; X02 hostname/operators/budget; X03 access to applicable target route controls. A complete production fleet is not required to prepare this isolated test. | Selected resource/source/image readback; tiny synthetic header/protocol/bypass tests and TCP/HTTP distinction; bounded abort/cleanup. Passing those future tests is not a circular prerequisite to drafting their plan. |
| Client migration — M2/M3 | X04 actual cohorts/callers; X05 signed artifacts and old-channel ownership; X06 operational callers. | API migration separately from native OTA/reboot; same storage and signer continuity, refresh/token survival, retained queued keys/payloads, uncertain-write handling and qualified rollback. |
| Trust activation — M4/M5 | G01/G03/G04 effective exclusivity or separately qualified authenticated origin; X03/X06; exact source/image; coordinated consumer change and G07 gates. | Protocol/duplicate/internal/alternate-path proof, unified logger/API/auth/OTA/Login identity, current same-SHA checks and expanded scan. No inferred closure from documents. |
| Old-endpoint retirement — M4/M6 | Every supported/offline cohort and caller accounted for; X04/X05/X06; old OTA and native rollback no longer require retired channels. | Migration/rollback across reboot and downtime; explicit operational sign-off/window. First withdraw trusting source while closure holds, then reopen any bypass if rollback requires it. |

Keep old API and native OTA channels until their respective migration/rollback proofs.
No blind cross-origin credential/write redirect, forced logout, re-provisioning, data reset,
queue rewrite or automatic resend of an ambiguous paid operation is allowed.

## Exact external acquisition list

Names of responsible people are not evidenced; roles below are deliberate.
Full fields and requested export scopes are in READINESS_EVIDENCE.json#external_inputs.

| ID | Responsible role | Exact missing input | Phase blocked |
|---|---|---|---|
| X01 | Platform + release owner | Isolated project/service/resource boundary; no-live-secret/dependency boundary; nominated frozen commissioning source/image and responsible operator. Accepted audit HEAD is not implicit deployment selection. | Commissioning |
| X02 | Owner/budget authority + DNS/platform operator | Approved FQDN(s), DNS zone/provider/control, named routing/IAM/release owners, incremental spending ceiling/currency and test duration. | Commissioning |
| X03 | Cloud routing/IAM administrator | Dated selected reference chain, header actions, NEG service/tag/urlMask, relevant resource/use/update/impersonation grants and inherited conditions, applicable internal/Shared VPC paths; complete pages and explicit unavailable scopes. Arrange access separately; do not retry disabled Compute here. | Commissioning access; full closure before trust |
| X04 | Fleet/outlet + web/platform owner | Pseudonymous supported cohort inventory with measured artifact/version/signer/API/native-OTA fields, observation dates and offline/unreported coverage. No credentials or business payloads. | Migration and retirement |
| X05 | Release/signing + fleet owner | Existing publication/rollback ledger with exact APK/OTA digests, channel, compatibility bounds, retained rollback artifacts and old-channel lifetime/owner; identify other locations if the empty known prefix is not authoritative. | Migration and retirement |
| X06 | Service/platform operator | Supported HTTP monitors and proxy/internal/platform callers, origins and credential class, responsible role, later synthetic test window/abort owner. | Migration, trust and retirement |

Prior estimate retained as dated 2026-09-28 design evidence, not a new quote or budget:
one global rule pool about USD18.25/month at730h, Jakarta processing USD0.00981/GiB in+out;
illustrative totals 18.35/19.23/28.06 at10/100/1000GiB before data transfer, backend,
logging, DNS/domain, tax and FX. Actual usage, domain and authorized spend are unavailable.
No new paid commitment is selected by the general programme grant.

## Checks and limits

New bounded APK reader: **14/14 synthetic methods pass**, including actual CLI rejection
without printing a synthetic URL credential marker. It rejects duplicate/malformed JSON,
invalid flags/shapes, duplicate members, unsafe original member paths and bounded-size
violations. Two initial backslash-path test failures are preserved: the fixture and Python's
Windows ZIP normalization initially obscured raw spelling; orig_filename checking now
rejects it (and NUL). This is parser qualification, not a cloud or Android runtime test.
Both actual artifact inspections and installed aapt2/apksigner selected reads exited0.

One APK transfer timed out at90s with13,107,200 bytes; the diagnosed single retry with180s
bound completed in26.68s and matched exact archive SHA256. The incomplete first copy stays
local. An early attempt to inspect that incomplete archive correctly failed as BadZipFile;
no conclusion used it. No disabled/denied API was retried. No application HTTP call occurred.

Only new helper/doc consistency checks run. No Go, forty-model replay, full app/DB/browser
suite, fresh security scan or hosted run is claimed. No staging/commit/push or operational
change. Active source/dependency/generated/config/model/vendor inputs and policy/empty
exceptions are hash-preserved; previously denied cleanup targets remain untouched.
SheetJS review deadline remains **2026-10-23T00:00:00Z**. Raw source archive/APKs and the
private development origin are excluded from the compact review bundle.
