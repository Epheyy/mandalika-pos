# A34e5 — tar build-dependency remediation

Packet A34E5-TAR-20260923-01. Authority AUTH-MANDALIKA-20260919-01.
Entry SHA31080a4b40515369bd050d1eb13150d04fa21971, branch audit/hosted-proof-20260922.
A34e4 accepted by CG-A34E4-SHEETJS-APPLICABILITY-20260923-01-R1:22 milestones across
11 findings. All44 retained; A31 sole resolved parent; no P0/release closure.
This slice is implemented/locally verified; hosted verification and review pending.

## Consumer and exact change

The only locked and installed parent range is @capacitor/cli8.3.4 -> tar^7.5.3,
from apps/pos devDependencies. It consumes tar.extract({file,cwd}) in the shared
extractTemplate helper (Android/iOS add/update and Android migration), and in the
separate SPM extraction helper. No application-runtime tar import or parent use of
replace/member selection was found. Build-path presence is not proof of a live POS
exploit. No full native platform command, signing, external provider or live data used.

Official npm tar7.5.21 is the minimum compatible fixed release for the reviewed
three blocking advisories. It supports Node>=18; unchanged Capacitor requires>=22.
Exact override @capacitor/cli@8.3.4>tar:7.5.21 pins only that edge. An ordinary
pnpm9.15.0 depth-Infinity exact-version update was tried in a disposable copy and
left the lock unchanged. The scoped generated lock changes only override metadata,
tar identity/integrity and the parent edge. All tar children, other package entries,
workspace importers, Capacitor/platforms, Node/pnpm and Playwright stay unchanged.
No unused root tar dependency, global override or manually invented integrity.

Official tarball https://registry.npmjs.org/tar/-/tar-7.5.21.tgz,470965 bytes,
SHA256 bcedf25a21daecd1a18fb5e19ab855b7d79ec8ef1da175e8ba85cfc0ed0069d1.
Registry SRI is retained in the lock and provenance evidence. License BlueOak-1.0.0
is inventoried unchanged; no license approval or exception is added. Archive paths,
manifest, license and relevant fix source were inspected before any package use.

## Focused evidence

A fresh disposable checkout with no node_modules passed the frozen install under
the existing lifecycle policy. Resolution uses createRequire at the installed
Capacitor manifest, not a root import. Its only tar copy is7.5.21. Installed manifest,
exported entry and license bytes match the verified official archive.

Six cases run in individual children: actual extractTemplate of a tiny gzip fixture
with Unicode/binary contents; tar create/list/extract round trip; malformed negative
size replacement; negative size listing; long-path member selection; and extraction
with maxDecompressionRatio2 on finite32KiB data. Before: replacement terminated by
5s deadline, long selection stack failure, and ratio option ignored. After: all pass.
Fixed negative sizes are neutralized by the library and terminate; no claim that
every malformed archive must throw. The long-path depth guard intentionally excludes
excessive descendant searches. Parent extraction uses no member-selection argument.

Bounds:5s external child deadline,96MiB V8 heap,512KiB stack,64KiB captured output,
input<=64KiB, controlled finite32KiB expanded payload,262144-byte fixture ceiling
checked after each child. This is not a general OS disk/RSS quota or arbitrary-input
sandbox. These fixed fixtures cannot request multi-gigabyte output. All owned
fixture directories are removed and verified after each child, including timeout.
No publisher gzip-bomb demonstration is executed. Upstream ratio limit defaults to
1000; this is not proof of absolute archive-byte or entry-count limits. Complete
native add/update/SPM workflows are outside this local helper test.

The same test is added to canonical quality so hosted Node22 exercises the actual
consumer and bounded cases. Local quality passes349 app/package tests (one existing
optional Backoffice replay skip), types, builds and schema drift. Existing vendor22,
policy19 and applicability16 pass. No local Go/PG repeat for a Node build-leaf change;
same-SHA hosted equivalents remain required.

## Security delta and preservation

Fresh before/after scans observe48->45 raw blocking records and46->43 actionable,
with two raw SheetJS identities separately reviewed-not-affected and zero exceptions.
All raw advisory records:82->76. Removed blocking IDs:
GHSA-23hp-3jrh-7fpw,GHSA-8x88-c5mf-7j5w,GHSA-r292-9mhp-454m.
Also removed Moderate report-only IDs:GHSA-gvwx-54wh-qm9j,GHSA-vmf3-w455-68vh,
GHSA-w8wr-v893-vjvp. They are recorded separately, not counted as three more blockers.
No new or materially changed unrelated normalized finding was observed. Paired
fresh OSV version queries show six matches for7.5.15 and none for7.5.21. The real
policy CLI fed the exact installed old-version evidence rejects it with three
blockers and retains three report-only rows. Active dependencies were not rolled back.

Inventory/SBOM retains npm/tar7.5.21 and the Capacitor edge. No count is hardcoded into
the scanner. SheetJS archive/provenance, applicability register/schema/snapshots,
review deadline2026-10-23T00:00:00Z, policy and empty exceptions are byte-preserved.
chi,kin-openapi,OpenPGP,rgbcolor and other unrelated blockers remain visible.

An initial evidence helper incorrectly expected three raw tar rows; inspection
showed six raw rows, three blocking and three Moderate. The helper was corrected to
preserve all evidence. This was not a production/source failure or policy change.

## Residuals

A34/T29,A38/T33 and every release gate remain open. No chi/rgbcolor/OpenPGP/password
changes, unrelated upgrades, business changes, Android/OTA/deployment/live actions
or bypass of the historical stopped database cleanup. A34e5 remains review pending.

Publisher advisory sources:
- https://github.com/isaacs/node-tar/security/advisories/GHSA-8x88-c5mf-7j5w
- https://github.com/isaacs/node-tar/security/advisories/GHSA-23hp-3jrh-7fpw
- https://github.com/isaacs/node-tar/security/advisories/GHSA-r292-9mhp-454m

Version-bound fix/test source, metadata, hashes, command logs and limits are in the
current review bundle. The first three fixes begin at7.5.18,7.5.19 and7.5.21 respectively.
