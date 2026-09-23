# A34e7 brace-expansion compatible patches

Packet A34E7-BRACE-EXPANSION-20260923-01; AUTH-MANDALIKA-20260919-01.
Entry 36d3d3abd146949c922d7bd6a32312ff50eca4e6 on audit/hosted-proof-20260922.
A34e6 scoped accepted by CG-A34E6-XMLDOM-20260923-01-R1: 24 milestones across
11 findings. All 44 parents retained; A31 alone resolved. A34/A38 and gates open.
A34e7 is implemented and locally verified; hosted proof and ChatGPT review pending.

## Resolution and real consumers

| Parent | Range | Before | After | API |
|---|---|---|---|---|
| minimatch 3.1.5 | ^1.1.7 | 1.1.14 | 1.1.18 | callable CommonJS |
| minimatch 5.1.9 | ^2.0.1 | 2.1.0 | 2.1.4 | callable CommonJS |
| minimatch 10.2.5 | ^5.0.5 | 5.0.6 | 5.0.9 | named expand, CJS/ESM |

All actual upstream edges: @eslint/config-array0.21.2, @eslint/eslintrc3.3.5 and
eslint9.39.4 consume minimatch3.1.5; Redocly/openapi-core1.34.14 requires5.1.9;
typescript-estree8.59.3 and glob13.0.6 consume10.2.5. Rimraf6.1.3 consumes glob.
Capacitor's existing rimraf path reaches that glob. No rimraf operation is executed.
Both active and clean frozen parent-context manifests/ranges/entries are recorded.

Minimatch3/5 call expand(pattern) with defaults; minimatch10 forwards braceExpandMax
as max. Parent brace expansion returns duplicates/order; matching may deduplicate
internally. Direct and parent results are tested, as are actual ESM exported entries.
Redocly URL-pattern matching and TypeScript/ESLint file selection remain build paths;
this is not proof of a deployed POS exploit. The real schema generator is preserved
and passes its drift check. Normal checked-in **/*.{ts,tsx} selection also agrees
before/after for all three parents. Complete call-site inventory is bundled.

A targeted pnpm9 indirect update in a copy exits0 without moving the lock. Three
exact-parent overrides therefore select the compatible versions. Only those
package/integrity/snapshot/parent entries move. Importers and children stay equal:
legacy balanced-match1.0.2/concat-map0.0.1, modern balanced-match4.0.4 unchanged.
No root brace dependency or parent/platform upgrade. V5 engine changes from
18||20||>=22 to20||>=22, compatible with canonical Node22 and existing Capacitor
Node>=22. No Node18 support is claimed. Legacy releases declare no engine floor.
All three artifacts are official npm registry releases, MIT; exact bytes/SHA256,
SHA512, identity and safe archive-member inspection are recorded. Clean installed
published files all match the official tarballs; no old selected copies remain.

## Twenty bounded checks and source-supported limits

Six cases for each parent plus real glob and ESM: benign alternatives/nested braces,
numeric/alphabetic/negative/padded ranges, escapes/literals/empty alternatives,
dollar-prefix, order/duplicates; matching and nobrace; count budget; length budget;
a finite intermediate combination; tiny repeated non-expanding groups. Real glob
through Capacitor -> rimraf selects paths in a five-file synthetic tree, synchronously
and asynchronously. No deletion/native commands or provider access is exercised.

Before: 15 pass / 5 fail on the same final harness. All three old versions exceed
the explicit small length budget; old2.1.0/5.0.6 hit the five-second deadline on
an84-byte repeated-group input. Old1.1.14 finishes that example; no timeout claimed
for it. After/clean: all20 pass. Initial glob fixture expected slash paths on Windows;
test expectations now normalize the platform separator. That harness error is logged,
not counted as a dependency defect, and final before/after were rerun unchanged.

Fixed max/maxLength return bounded prefixes; throwing is not required. Tests assert
that truncation is not a complete over-budget filesystem selection. Normal patterns
retain exact meaning. Small product has at most256 alternatives even before the fix;
namespace/XML/tar tests remain separate. Internal arrays are not instrumented:
intermediate-array repair is supported by exact publisher source (iterative prefix
accumulator, bounded sequence/alternative/combine paths) and small public-budget
checks. No full-scale OOM or universal resource-safety claim.

Each child: 5s external deadline,96MiB V8 heap,512KiB stack,64KiB output. Tiny fixture
bytes <=64KiB; five files total45bytes. These are not OS-wide RSS/disk quotas.
Timed-out old children are killed; every tiny fixture is removed and absence checked.
Four prior policy-blocked install copies remain untouched. New install-copy cleanup
is reported separately from tiny fixture cleanup; no denied operation is retried.

## Security and verification

Fresh before34raw/32actionable/2reviewed/0exceptions; after25/23/2/0. Exactly9
version/advisory matches disappear: GHSA-3jxr-9vmj-r5cp,GHSA-mh99-v99m-4gvg,
GHSA-rgw5-rvv9-x895 for each old version. Unchanged normalization marks all9High;
no new/changed unrelated finding. Counts observed, not hardcoded. Old evidence
through unchanged policy CLI still exits1 with9blockers. Package identity, each
selected version, parent paths, SBOM and OSV queries remain visible.

Feed note: rendered maintainer GHSA-3jxr page says Moderate5.3; current advisory API
labels High while retaining5.3 vector/score. Both source records are retained;
no downgrade or range reinterpretation. Fixed versions are not matched by fresh feeds.
This non-blocking feed-quality discrepancy is available for separate review.

Tar7.5.21, xmldom0.9.12, SheetJS artifact/provenance/two exact assessments and expiry
2026-10-23T00:00:00Z, policy thresholds and empty exceptions remain byte-identical.
Chi/OpenPGP/rgbcolor and other blockers remain. No applicability rule or suppression.

Local quality:ci passes:349app/package tests,one existing optional Backoffice replay
skip,22vendor,6tar,10XML,20brace cases; source/test typechecks,production bundles,
real Redocly/openapi-typescript schema drift. Policy19/applicability16 pass.
Local Go/DB not repeated for this Node-only leaf; mandatory unchanged hosted gates
must pass on the final SHA. No native/device qualification, signing/deploy/OTA,
live data, password parser, Go/chi/rgbcolor/OpenPGP policy or A14 changes.
