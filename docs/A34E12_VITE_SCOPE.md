# A34e12 — bounded Vite remediation and prior-fix preservation

Scope ID: **A34E12-VITE-20260924-01**
Reply: **CG-A34E11-JSYAML-20260924-01-R1**
Entry reviewed SHA: `7d2ab470fa4edfa78c9ee8f3c435587590681e81`
Standing authority: **AUTH-MANDALIKA-20260919-01**

## Outcome

Update the Vite package actually used by both POS/Backoffice and their test/plugin consumers
from8.0.13 to the minimum qualified fixed8.0.x candidate, **8.0.16**. Preserve existing
build/dev/test behavior and every accepted dependency/security control. Resolve E11-REPORT-01
in the same turn. This is not a broad Vite8.1/9, React, Tailwind, Vitest or browser-support
migration.

## 1. Basis: source-derived versus external evidence

The submitted lock has both apps' direct devDependency `vite:^8.0.1`, currently resolving
8.0.13. Peer instances include @tailwindcss/vite4.3.0, @vitejs/plugin-react6.0.2 and Vitest4.1.7.
The actual normalized scan contains:
- **GHSA-fx2h-pf6j-xcff / CVE-2026-53571**, High blocker: Windows alternate-path file-deny bypass.
- **GHSA-v6wh-96g9-6wx3 / CVE-2026-53632**, Moderate report: bundled editor-helper UNC handling.
These are one blocker and one report-only match, not two blockers.

Official maintainer advisories identify Vite8.0.16 as fixed for both. The second advisory is
published in vitejs/launch-editor, not the vitejs/vite advisory namespace. Source references
are in evidence/EXTERNAL_SOURCES.json. Refresh current source and installed/published ranges;
do not treat a scan from an earlier commit as proof for a new final dependency graph.

The High advisory's exploit conditions include a network-exposed development server and
Windows/NTFS or short-name path behavior. The Moderate issue concerns editor-helper access
that can cause OS-level outbound authentication. Neither establishes a live POS exploit or
past credential loss in this project. Inspect actual config/launchers without accessing
secrets, but do not broaden development-server exposure for testing.

## 2. Required supporting graph changes

The reviewed Vite8.0.16 tagged manifest requires rolldown exactly1.0.3 and tinyglobby^0.2.17;
the submitted graph currently selects1.0.1 and0.2.16 respectively. Confirm actual registry
artifact metadata, then include only required support movement and peer snapshot rewiring.
Rolldown platform-specific optional binaries must be resolved and integrity-checked for
normal Windows and hosted Linux execution; do not install an unverified system fallback.
Preserve optional platform entries according to the package manager rather than pruning
the lock to whichever OS is currently running.

Vite's reviewed Node requirement is ^20.19.0 || >=22.12.0, compatible with the established
Node22 hosted lane. Refresh exact installed versions; do not change Node/pnpm/tooling majors.
Do not hand-edit integrity strings or do a broad update. Prefer targeted normal resolution;
if a scoped override is needed, document actual allowed parent ranges. Any new exact-pin
violation needs its own explicit evidence/decision and is not automatically authorized by
the js-yaml exception to Redocly's published range.

### Preserve PostCSS and Nano ID explicitly

The current root override `vite@8.0.13>postcss:8.5.23` will no longer select the new Vite parent.
Update its bounded parent identity to the selected candidate as necessary. Candidate's
published postcss^8.5.15 range admits the already accepted8.5.23. Keep PostCSS8.5.23 and its
child Nano ID3.3.18 actually resolved throughout POS/Backoffice/Vitest/Tailwind paths.
Refresh resolver/bootstrap assumptions only; do not weaken the15 PostCSS or16 NanoID assertions.
Avoid running old tests against leftover node_modules copies from a different Vite snapshot.

## 3. Safe actual development-server regression

Use Vite's actual published createServer/request path with a new owned synthetic directory,
not the real repository .env/certificate/customer files. Set configFile:false, envFile/envDir
disabled as supported by the selected API, strict loopback127.0.0.1, strict port, server.open:false,
explicit fs.allow of only the fixture, fs.strict:true, default deny policy preserved, and no
proxy or live API URL. Verify these settings took effect; do not invent an API option.
Bound startup/request/output/fixture sizes and server/worker lifetime; terminate only owned
processes and prove ports closed. Do not change firewall, NTLM, short-name policy, Windows
volume settings or global trust configuration.

Create tiny synthetic denied files (.env.audit, a dummy .pem with clearly non-secret content)
inside the allowed fixture plus ordinary allowed JS/CSS/text controls. A successful denial
requires that no synthetic denied marker or file content reaches any response body/transform
cache. A status code alone is not enough, and returning no data because the server never
started is not a pass. Verify normal allowed file/module transforms in the same server.

### Windows ADS and 8.3 behavior

Use actual Windows/NTFS where already available to test alternate forms against only those
owned files. Keep requests on loopback; remote exposure is unnecessary for local request-
handling reproduction. Use both ordinary request serving and relevant raw/module import
routes as supported by the actual code. Preserve URL encoding at the wire when appropriate.

For8.3 tests, query whether an owned file has a real short alias. Do not guess an alias and
call a404 proof. Do not enable short-name creation or change a volume to get a green test.
If unavailable, report that vector as unavailable and supply exact fixed-source evidence.
Linux or WSL ext4 success is not Windows/NTFS proof. Keep platform-inapplicable cases explicitly
classified, not counted as passing required Windows behavioral coverage.

Maintain mandatory cross-platform compatibility/fail-closed tests in quality. Execute local
Windows regressions where possible. A small Windows hosted job can be proposed if required
for persistent proof, but do not rewrite the whole CI matrix for this slice. If actual Windows
proof is unavailable, return that qualification limit rather than simulating the OS and
claiming a real exploit was fixed in the test.

## 4. Editor-helper boundary without credential exposure

Trace the actual editor helper bundled into the installed Vite artifact and its fixed UNC
rejection path; package-lock absence of standalone launch-editor is not proof it is absent
from Vite's distribution. Record relevant artifact/source hashes and exact dependency/build
provenance. Do not add an unused root launch-editor package.

**Never run the old UNC PoC against the Windows OS. Do not start SMB, contact a share,
collect NTLM material, launch an editor, or send credentials anywhere.** Even a nominal
.invalid hostname can cause OS network resolution; a Node HTTP allowlist is not enough to
prevent filesystem-triggered SMB authentication.

Prefer exact-source inspection plus pure exported path validation where available. If a
runtime rejection test is needed, instrument/stub ONLY the external effect boundary in a
supervised test so every filesystem/proc/network effect is captured and prevented BEFORE
passing an UNC-looking input. Preserve the real upstream validation logic and label this
as an instrumented boundary test, not end-to-end credential-leak verification. Do not invoke
an actual filesystem operation on a UNC string. If safe isolation cannot be established,
retain source-level coverage and its limit instead of forcing a risky runtime demonstration.
Benign editor behavior may be verified through a nonexecuting recorder; no real editor spawn.

## 5. Compatibility, artifacts and new-file checks

Run actual POS and Backoffice builds and rendered browser harness against the candidate,
plus Vitest/module resolution and the plugin pipeline. Verify normal JS/TSX, CSS/Tailwind,
asset imports, legitimate source maps and HMR start/connection semantics as supported by
existing tests. Do not require byte-identical bundles across a bundler patch; inspect and
explain material output differences and retain stable behavior assertions.

Preserve browser host/network isolation and cleanup checks; do not broaden allowedHosts,
CORS, fs.allow, disable fs.deny/fs.strict, set unsafeMap, replace real loaders, remove tests,
or turn failures into skips to achieve green status. Do not reconfigure the live development
workflow simply because test fixtures use a deliberately narrower safe server configuration.

Preserve all accepted family checks: YAML30, Browserslist15, PostCSS15, NanoID16, brace20,
XML10, tar6, vendor22, policy19, applicability16, ordinary349app/package tests and its already
explicit optional replay distinction. Counts are current inventory, not permanent ceilings.

## 6. Evidence correction E11-REPORT-01

Correct active claims: before-tests18/12; before-final17/13 includes unrelated flat ESLint
config-file-missing; after-tests and clean-tests30/0. Preserve historical logs. Do not
reopen E9 or run another documentation-only cycle. No old-version replay is required solely
for prose repair. Audit each new source-identity/fixture assertion before describing the
next old/candidate comparison as identical.

## 7. Scanner and review boundary

Retain npm/vite identity, exact new-version query, parent/peer graph and supporting native
components in inventory/SBOM/license scans. Source-built/dev-bundled code evidence for the
editor helper supplements rather than replaces the normal Vite package advisory record.
Record official registry bytes/SRI/digest/license/engines, pinned installation and package
resolution from actual consumers. No source alias, ignored record or risk exception.

Compare exact IDs before/after. The candidate is expected to remove the one High and one
Moderate recorded Vite match when current feeds agree. Do not hardcode17->16 or15->14, and
retain feed changes/new findings separately. Keep exact SheetJS artifact/provenance/two
assessments/2026-10-23 expiry and zero risk exceptions. All unrelated Go/license issues stay.

On one final SHA require quality/backend/PostgreSQL/browser success plus a completed fresh
security scan; remaining unrelated blockers may keep the fifth workflow red. Failures must
be diagnosed without weakening the gates. Preserve intermediate failed run IDs if any.

## 8. Acceptance matrix VT01–VT18

| ID | Evidence |
|---|---|
| VT01 | Entry SHA and source classification, full direct/peer/optional Vite graph for both apps/test/plugin consumers. |
| VT02 | Official current advisories and exact candidate artifact/engines/parent range compatibility. |
| VT03 | Minimal Vite8.0.x update plus explained rolldown/tinyglobby/platform dependencies and peer rewiring. |
| VT04 | Clean frozen install and actual parent-context Vite/PostCSS/NanoID versions; no stale or unused copies counted. |
| VT05 | Preserve PostCSS15/NanoID16, all prior family checks, generated contracts and app behavior. |
| VT06 | Actual loopback-only synthetic Vite startup, no env/config/live API escape, bounded teardown/process/port checks. |
| VT07 | Allowed files/modules/CSS/assets still work; ordinary denied files return no synthetic protected content. |
| VT08 | Real Windows/NTFS ADS rejection old-versus-fixed where available; explicit platform evidence and no real secrets. |
| VT09 | Real8.3 alias coverage if generated on existing volume; otherwise unavailable with source evidence, not false pass. |
| VT10 | Raw/import/HTTP route coverage supported by actual API; reject markers across responses, not status-only success. |
| VT11 | Bundled editor-helper version/fix provenance; safe source/pure/instrumented rejection evidence without UNC I/O, SMB or credentials. |
| VT12 | Real POS/Backoffice Vite builds, plugin/Vitest/browser behavior, legitimate maps, no weakened policy. |
| VT13 | Each security case has external time/resource bounds, owned fixtures and honest OS/coverage limits. |
| VT14 | Inventory/SBOM/advisory/native graph remains complete; exact High/Moderate ID delta distinguished. |
| VT15 | E11 attribution corrected, original logs unchanged; E9 remains closed; no extra milestone. |
| VT16 | Quality/backend/race/six PostgreSQL/browser pass on same final SHA, fresh completed security assessment. |
| VT17 | Prior dependency fixes, SheetJS review validity, zero exceptions, denied cleanup targets and unrelated work preserved. |
| VT18 | Explicit staged allowlist, no-deployment safeguards, exact diffs/tests/source hashes, limits and compact current ZIP. |

## 9. Non-goals and delivery

No Go/chi/kin-openapi/x-mod/OpenPGP policy, rgbcolor licensing, password-parser, A14,
business identity/calendar/accounting, broader CI/release, Android signing, OTA or live-data
changes. No force push or blanket git add. Continue existing verification branch under
standing authority; preserve CF-Pages-Skip/Vercel branch exclusions and inspect any new
trigger before normal push. Keep previously denied deletion targets untouched.

Return one current packet and one compact ZIP, exact implementation/doc diffs, official
provenance, actual parent resolution, Windows versus cross-platform coverage matrix, all
VT records, correction attribution, raw/actionable ID delta and hosted same-SHA evidence.
Do not claim A34/A38 or any release gate closed. No generic approval question is required.
