# A34e12 Vite remediation

Packet A34E12-VITE-20260924-01; AUTH-MANDALIKA-20260919-01.
Entry7d2ab470fa4edfa78c9ee8f3c435587590681e81; audit/hosted-proof-20260922.
E62 accepts A34e11 with exact project-qualified Redocly override;29milestones
across11findings. E63 was hosted verified and is scoped accepted by CG-A34E12-VITE-20260924-01-R1.
E64 records acceptance:30milestones/11findings. E11 reporting correction closed;
no extra replay or milestone; E9 stays closed. Historical evidence limits remain.
All44parents retained; A31 alone resolved; A34/A38 and every release gate open.

## Resolution and provenance

Both app devDependencies now require Vite^8.0.16 and lock8.0.16. Eight actual
consumer contexts (each app, Vitest4.1.7, Tailwind Vite4.3.0, React plugin6.0.2)
resolve that same distribution. Direct/peer ranges admit the selected version.
Vite's PostCSS^8.5.15 admits retained8.5.23; Nano ID3.3.18 remains resolved across
all six preserved PostCSS consumer paths. Neither prior harness was weakened.
Node requirement ^20.19.0 || >=22.12.0 remains compatible with hostedNode22.

Official archive https://registry.npmjs.org/vite/-/vite-8.0.16.tgz, 538260 bytes, SHA256
3af821aa696cac7f3722ba8db24eff8da9d8739ce8279bc318e1549fa9ec5287. Registry metadata, retrieval times, SHA512 SRI, actual MIT/license
notices and old/new published regular-file hashes are retained. Old Vite and fixed
active/clean installs match reviewed archives. Inspection executes no archive content.

Required graph movement: Rolldown1.0.1->1.0.3, its exact OXC types0.130.0->0.133.0,
and all15optional native/WASM bindings1.0.1->1.0.3. tinyglobby0.2.17 is added for
Vite's raised minimum;0.2.16 remains for other consumers. No optional OS is pruned.
All native metadata/SRI match lock; Windowsx64 and Linuxx64GNU archive bytes/SRI
are independently verified. Actual Windows native module loads in the server test
and its SHA256 matches the official binary. Hosted Linux native hash matches below.

A first normal targeted lock update also selected newer compatible helper/CSS
versions. These unnecessary movements were removed using exact-parent scoped,
range-compatible constraints: lightningcss1.32.0, picomatch4.0.4 (Vite/tinyglobby),
pluginutils1.0.1, wasm-runtime1.1.4 and wasm-util0.10.2. This retains the original
versions while accepting only required movement. No integrity edits, broad update,
unused root Vite/support dependency or framework/Node/pnpm upgrade. The original
unselected candidate delta is evidence, not the final graph. Final lock adds19
package records and removes18; all are the explained Vite/Rolldown/OXC/tinyglobby
family. Other changes are importer/peer snapshot rewiring and scoped constraints.

## Real server, Windows and editor boundary

The mandatory harness uses three externally supervised worker groups. The real
Vite server owns tiny fixtures; loopback127.0.0.1, strict port, configFile:false,
envFile:false/envDir:false, no proxy, fs.strict:true, default deny and fixture-only
allow (plus Vite's own internal client directory) are asserted after startup.
Allowed text, TS/TSX, CSS and SVG return expected content. Legitimate transform
maps and an actual HMR WebSocket connection work. Synthetic TSX uses classic JSX
to avoid importing React from the dependency-free fixture; real application React/
Tailwind plugin pipelines are separately covered by unchanged builds/browser gates.

Windows tests query the actual owned file's filesystem (NTFS) and existing short
alias using Win32 APIs. Reading its own default ADS stream and verified8.3 alias
proves each vector exists before HTTP tests. No volume/OS policy is changed.
Both .env.audit and dummy PEM use clearly synthetic marker bytes. Ordinary, raw,
import, raw+import, encoded ADS and /@fs routes check bodies; transform caches are
also checked. No real repository environment/certificate/customer file is used.
Final exact harness on authentic old8.0.13 produces14 response/cache violations;
fixed active/clean each produce0. All five normal controls, HMR and port cleanup
succeed on old and fixed. These are14 observations, not14 separate vulnerabilities.
Actual aliases: ENV~1.AUD and DENIED~1.PEM. Local WindowsNode24 is distinct from
hosted LinuxNode22; Linux tests explicitly report Windows platform-not-applicable.

The installed Vite bundle identifies launch-editor and middleware2.14.1; its manifest
build dependency and bundled license/source support this attribution. The extracted
UNC guard precedes the first filesystem call. A pure predicate runs against three
UNC-looking strings and one local control under a bounded VM with path.win32.
No full launchEditor invocation, UNC filesystem operation, remote share, SMB/NTLM
or editor process occurs. This is source/pure-validation evidence, not end-to-end
credential leakage testing. The old bundle lacks that guard; it fails safely at the
source assertion before any UNC input is evaluated. No standalone helper added.

Children45s, startup10s, request3s, heap256MiB, stack1024KiB, output128KiB,
response/fixture256KiB; guardVM1s. Each owned process is reaped, port checked closed
inside and outside the child, and only its tiny verified nonsymlink fixture removed.
No huge/OOM probe, exposure change, unsafeMap or weakened application security setting.
Source-only checks additionally confirm alternate-path guards precede allow/cache.

## Evidence attribution and validation

Final before-exact.json:3groups fail for reproduced response/cache leaks and absent
upstream guards. after-final.json and clean-final.json:3/3 pass. Harness source is
identical for this final comparison; source and installed artifact hashes recorded.
Earlier attempts remain: an unexported package manifest path, synthetic JSX runtime
fixture and Windows short TEMP ancestor caused harness issues. These were corrected
before final comparison; none is counted as an additional Vite vulnerability.
Canonical long temporary paths are required because the fixed Windows guard rejects
all tilde-containing paths. No rollback of active dependencies was used.

Local full quality passes:349app/package tests, one existing optional Backoffice
replay skipped; all established source/test typechecks, both production builds and
API regeneration drift pass. YAML30, Browserslist15, PostCSS15, NanoID16, brace20,
XML10, tar6, vendor22 remain. Policy19/applicability16 pass independently. Build
chunk-size warnings remain advisory; no byte-identical bundler output claim.
Hosted browser, Go/race and six PostgreSQL fixtures pass on the final source SHA below.

E11-REPORT-01 is corrected in active documents without replay: before-tests18/12;
before-final17/13 includes one unrelated missing flat ESLint config fixture;
fixed active/clean30/30. Original JSON/logs copied byte-identically and hashed.
Exact Redocly1.34.14->js-yaml4.3.2 project qualification is accepted; not a published
range match, publisher approval or blanket pin override. E9 remains closed.

## Security and remaining limits

Fresh scans:17raw/15actionable/28report-only ->16raw/14actionable/27report-only.
Reviewed2/exception0 unchanged. Removed High GHSA-fx2h-pf6j-xcff and Moderate
GHSA-v6wh-96g9-6wx3 only. Complete Vite/support/native identities, parent/peer edges,
licenses, CycloneDX and exact-version OSV queries remain visible. No new or changed
unrelated normalized finding. Raw advisory evidence preserved; no applicability rule,
severity reinterpretation, ignored package or exception. SheetJS bytes/provenance/
assessments/2026-10-23 expiry and all policy thresholds are byte-preserved.

No live exposed-server exploit or historical credential loss is established. Current
app configs set ports, not broad host/proxy/fs allowances; synthetic browser launcher
uses strict loopback and controlled data. Existing external deployment configuration
is not independently reconfigured or claimed audited. No full Windows CI lane added.
No broader symlink/filesystem containment, exhaustive native-platform execution,
editor-launch compatibility or credential leak claim. Non-Windows native platforms
have metadata/integrity/graph coverage, not execution coverage.

Four previously denied install-copy deletions and stopped DB cleanup remain untouched.
Prior copies plus new old/candidate install copies retained without deletion. Owned
tiny test fixtures are separately cleaned. No Go/chi/legal/OpenPGP/password/A14/business,
signing/deployment/OTA/live-data change. Unrelated local bytes remain preserved.

## VT01-VT18

| ID | Evidence/status |
|---|---|
| VT01 | Entry SHA and source classification, full direct/peer/optional Vite graph for both apps/test/plugin consumers. — verified within documented evidence limits |
| VT02 | Official current advisories and exact candidate artifact/engines/parent range compatibility. — verified within documented evidence limits |
| VT03 | Minimal Vite8.0.x update plus explained rolldown/tinyglobby/platform dependencies and peer rewiring. — verified within documented evidence limits |
| VT04 | Clean frozen install and actual parent-context Vite/PostCSS/NanoID versions; no stale or unused copies counted. — verified within documented evidence limits |
| VT05 | Preserve PostCSS15/NanoID16, all prior family checks, generated contracts and app behavior. — verified within documented evidence limits |
| VT06 | Actual loopback-only synthetic Vite startup, no env/config/live API escape, bounded teardown/process/port checks. — verified within documented evidence limits |
| VT07 | Allowed files/modules/CSS/assets still work; ordinary denied files return no synthetic protected content. — verified within documented evidence limits |
| VT08 | Real Windows/NTFS ADS rejection old-versus-fixed where available; explicit platform evidence and no real secrets. — verified within documented evidence limits |
| VT09 | Real8.3 alias coverage if generated on existing volume; otherwise unavailable with source evidence, not false pass. — verified within documented evidence limits |
| VT10 | Raw/import/HTTP route coverage supported by actual API; reject markers across responses, not status-only success. — verified within documented evidence limits |
| VT11 | Bundled editor-helper version/fix provenance; safe source/pure/instrumented rejection evidence without UNC I/O, SMB or credentials. — verified within documented evidence limits |
| VT12 | Real POS/Backoffice Vite builds, plugin/Vitest/browser behavior, legitimate maps, no weakened policy. — verified within documented evidence limits |
| VT13 | Each security case has external time/resource bounds, owned fixtures and honest OS/coverage limits. — verified within documented evidence limits |
| VT14 | Inventory/SBOM/advisory/native graph remains complete; exact High/Moderate ID delta distinguished. — verified within documented evidence limits |
| VT15 | E11 attribution corrected, original logs unchanged; E9 remains closed; no extra milestone. — verified within documented evidence limits |
| VT16 | Quality/backend/race/six PostgreSQL/browser pass on same final SHA, fresh completed security assessment. — verified within documented evidence limits |
| VT17 | Prior dependency fixes, SheetJS review validity, zero exceptions, denied cleanup targets and unrelated work preserved. — verified within documented evidence limits |
| VT18 | Explicit staged allowlist, no-deployment safeguards, exact diffs/tests/source hashes, limits and compact current ZIP. — verified within documented evidence limits |

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

Build comparison (historical old log versus current, not a fresh old rebuild):
119/3445 modules transformed and CSS asset names/sizes retained; POS main515.74kB
rounded unchanged; Backoffice main1352.63->1352.54kB. JS asset hashes change with
the bundler patch; same dynamic-import/chunk warnings remain. No material size
regression observed; browser behavior, not binary equality, is the acceptance check.
