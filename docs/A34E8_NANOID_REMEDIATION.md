# A34e8 Nano ID / PostCSS compatible patch

Packet A34E8-NANOID-20260923-01; AUTH-MANDALIKA-20260919-01.
Entry 1e76b42755bfe6f827905d465ec1e49bc461f8d0, audit/hosted-proof-20260922.
CG-A34E7-BRACE-EXPANSION-20260923-01-R1 scoped accepts A34e7: 25 accepted
milestones across the same 11 findings. All 44 remain; A31 alone resolved.
A34/T29, A38/T33 and every release gate stay open. A34e8 review pending.

## Exact compatible resolution

PostCSS 8.5.14 declares nanoid ^3.3.11; its installed lib/input.js imports
nanoid/non-secure via CommonJS and calls nanoid(6) for anonymous CSS Input IDs.
This caller does not accept attacker-controlled sizes. Vite 8.0.13 consumes
PostCSS ^8.5.14, including Vitest/Tailwind Vite peer paths. The complete parent
inventory is bundled. No application identity/customer/order code is changed.

A targeted pnpm9 indirect update exited0 without lock movement. The permitted
postcss@8.5.14>nanoid override selects3.3.18 instead of3.3.12. Importers, PostCSS,
Vite and every other package version remain unchanged. No unused root dependency,
Nano ID5 migration or broad update. Clean frozen ignore-scripts install resolves
3.3.18 through the actual PostCSS parent; all published files match official bytes.

Official registry source https://registry.npmjs.org/nanoid/3.3.18 and versioned
archive https://registry.npmjs.org/nanoid/-/nanoid-3.3.18.tgz. SHA256:
b9dc81cb403ea2510314dd2d1ad8d71934f325db90c1b43805e781b87e3fb009.
Exact retrieval time, bytes, SHA512/SRI, metadata, MIT license/notice, engines and
exports are bundled. Archive members were inspected without executing contents.
Canonical Node22 is supported; local Node24 is separate evidence.

## Bounded consumer and API qualification

16 cases in mandatory quality: anonymous/explicit Input identity, Unicode parse
and positions/errors, no-op CSS, plugin output, source maps, positive/default
CJS/ESM IDs and custom alphabets; three non-secure negative-size cases; secure
customAlphabet/customRandom zero-default and zero-override; async positive and
zero cases; published browser implementations under Node Web Crypto.
No cryptographic-quality inference or native/browser-device qualification.
Non-secure negative and named custom zero calls must return empty strings,
not throw. Deterministic bytes are used only for finite customRandom test cases.
Malformed alphabets/NaN/fractional inputs/positive overrides on zero-default
factories/hostile randomness callbacks are outside this scope and are not probed.

Each case runs in its own child with5s deadline,96MiB V8 heap,512KiB stack and
64KiB output limit. Inputs are tiny; normal IDs at most21characters here. No disk
fixtures are created, no large-size attack probe is used. Child liveness is
checked after termination. V8 limits are not a total OS RSS quota.
Before-final:6 pass/10 fail. Six old cases hit the bounded heap termination,
three time out, and async zero override returns one character rather than empty.
Fixed and clean-frozen:16/16 pass. Old browser-zero failure depends on the old
random rejection path; no universal timeout timing is claimed. Initial source-map
expectation was corrected: anonymous map source is <no source> while Input keeps
its generated ID. Corrected identical before/after harness distinguishes that
harness error from the library defects; original attempt remains in evidence.

## Security and preserved safeguards

Fresh before25raw/23actionable; after23raw/21actionable; reviewed2/exceptions0.
Exactly GHSA-28wg-ghj8-5hjv and GHSA-2v37-7h3g-55p8 nanoid3.3.12 records removed.
No new/changed unrelated normalized record. Official API ranges fix the3.x line
at3.3.16 and3.3.18 respectively. Package identity, build reachability, parent edges,
MIT evidence, CycloneDX SBOM and OSV nanoid3.3.18 query remain visible. Old records
still fail unchanged policy CLI. Counts are observations, not enforcement targets.
No applicability rule, exception, severity or policy change.

Tar7.5.21, xmldom0.9.12, all three brace patches, exact SheetJS vendor/provenance,
two assessments/deadline2026-10-23T00:00:00Z and empty exceptions are preserved.
Remaining chi/rgbcolor/OpenPGP and unrelated blockers stay visible. No A14,
password-parser, signing/deployment/OTA, live data or business-identity work.

Local full quality passes:349app/package tests plus1existing optional replay skip,
22vendor,6tar,10XML,20brace and16Nano ID cases; source/test types, production builds,
real generated-schema drift. Hosted same-SHA quality/backend/PostgreSQL/browser
and completed fresh dependency assessment are required before the final packet.
Local Go/database suites are not repeated for this Node-only leaf; mandatory
hosted Docker18.3/race evidence will be recorded separately.

Four previously denied installation-copy deletions remain untouched. Prior two
A34e7 copies and new two A34e8 copies are retained without a deletion attempt;
this is distinct from a new policy block. Historical stopped DB cleanup unchanged.

## Final hosted proof — 2026-09-23

Source `4cd7f89d857d64b0ae265605c9a25d39185522ac`, tree `c62232f832865e7954849268f49a2d14e7a3ac76`.
Quality35843981412,backend35843981448,PostgreSQL35843981371,browser35843981343
succeed on this exact SHA. Hosted Node22 passes all16Nano ID cases and prior
20brace/10XML/6tar checks. Backendgen/vet/fmt/build/race passes. Docker18.3/race:
6fixtures,142named passes,zero skips,verified identity and cleanup. Chromium26/26,
zero skips,no unexpected external requests,owned processes/ports cleaned.
Fresh security35843981401 completes RED:23raw/21actionable/2reviewed/0exceptions.
Committed input hashes match; hosted normalized findings equal local after-scan.
Only the two targeted Nano ID IDs disappear; no unrelated finding changes.
A34e8 implemented/locally+hosted verified; ChatGPT review pending. A34e7 accepted;
25accepted milestones/same11findings,all44retained,A31alone resolved. A34/T29,
A38/T33 and every release gate remain open. Post-proof documentation is a local
after-image, distinct from the hosted executable snapshot. No deployment dispatch.
Four denied installation copies untouched;A34e7/A34e8 copies retained without
new deletion attempts. No disk fixtures from Nano ID tests; children reaped.

## Scoped review acceptance — 2026-09-23

CG-A34E8-NANOID-20260923-01-R1 accepts this bounded milestone at4cd7f89.
26accepted milestones/same11findings. Review limits retained; all44parents remain,
A31alone resolved,A34/A38 and release gates open. Historical execution above unchanged.
