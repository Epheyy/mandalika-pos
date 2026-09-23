# A34e6 xmldom remediation

Packet A34E6-XMLDOM-20260923-01; AUTH-MANDALIKA-20260919-01.
Entry095dcff509efeeab0b23dc48bc94e3caf6d71210; same audit/hosted-proof-20260922.
CG-A34E5-TAR-20260923-01-R1 accepts A34e5:23 accepted milestones/11 findings.
A34e6 implemented and locally verified; hosted proof and ChatGPT review pending.
All44 findings remain; A31 sole resolved parent. A34/T29,A38/T33/release gates open.

## Minimal resolution and actual consumers

Capacitor CLI8.3.4 declares plist^3.1.0, native-run2.0.3 also declares plist^3.1.0.
Both resolve plist3.1.1, whose xmldom range is ^0.9.10. Candidate0.9.12 satisfies it.
A targeted indirect pnpm update in an owned copy exited0 but changed nothing.
The exact parent override `plist@3.1.1>@xmldom/xmldom:0.9.12` changes only that edge,
package/integrity and snapshot. No unused direct package or parent/native upgrade.
Tar7.5.21 override and every other selected package/importer are preserved.

Plist lib/parse.js invokes new DOMParser().parseFromString(xml,"text/xml") without
onError or strict overrides. lib/build.js uses xmlbuilder15.1.1, not XMLSerializer.
Capacitor util/spm.addInfoPlistDebugIfNeeded reads/parses/builds/writes Info.plist;
cordova reads/parses configuration and emits configuration guidance. Native-run
protocol/lockdown and usbmux build XML; protocol/protocol and client/usbmuxd parse
local device/protocol responses. The same plist/parser edge covers both parents.
These are development/native tool paths, not proof of deployed POS exploitability.
No native communication, platform migration, signing or full native command is run.

Official registry0.9.12 tarball is checked against its SHA512 and installed bytes;
package MIT, Node>=14.6. Publisher release0.9.11/0.9.12 and exact source/changelog are
preserved in evidence. Every published file equals the clean frozen installation.
No selected old parser copy remains there; old disposable baseline stays separate.

## Qualification and limits

Ten cases run in bounded child processes in mandatory quality. Typed values have
independent expected dictionaries, arrays, strings/escaping/Unicode, booleans,
integers/reals, dates, Buffer data and empty values. Real Capacitor helper inserts
CAPACITOR_DEBUG once in a tiny synthetic Info.plist and preserves every value;
a repeated call leaves bytes unchanged. XML declaration/doctype, comments and
compact/pretty parent output are exercised. No formatting rewrite is introduced.

Creation-time newline checks, strict element/attribute/PI/doctype/entity validation,
XML malformed end-tag diagnostics, finite namespaces/attributes/normalize and HTML
raw-text behavior are checked. The exact final harness fails seven cases on0.9.10
and passes all ten on0.9.12. Parent typed/helper tests pass on both versions.
Initial fixture mistakes (unattached doctype, undefined attribute value, missing
newline in recoverable end tag, assumed text retention on missing HTML close) were
corrected from publisher source; initial logs are retained, not counted as fixes.

Strict serialization requires requireWellFormed:true. Default mutated-name output
remains permissive. Plist never calls that serializer. A closing tag with newline
and trailing content now reports an error but returns the same recovered value;
plist's default logger is observed, not replaced with a rejecting parser. Missing
HTML close reports discarded extra content; HTML is not plist's text/xml API.
No monkeypatch, global onError override or dependency-source mutation is applied.

Per child:5s deadline,96MiB V8heap,512KiB stack,64KiB output cap; fixtures <=64KiB.
Namespace depth32/attributes32/adjacent text128. This proves bounded examples and
correctness, not asymptotic timing guarantees or an OS-level disk/RSS sandbox.
Publisher source documents namespace inheritance, indexed attribute dedup and
linear adjacent-text merge; no OOM or multi-MB attack probe was executed.
All tiny fixture cleanup is checked. Prior two policy-blocked installation copies
under mandalika-a34e5-8zsihrbt remain untouched; historical stopped DB cleanup too.

## Security and local verification

Fresh local before:45raw/43actionable/2reviewed/0exceptions; after:34/32/2/0.
Exactly13 xmldom records disappear:11High blockers and2Moderate reports; no added or
changed unrelated normalized findings. Counts are observed, never hardcoded.
Old-version evidence through the unchanged real evaluator still exits1 with11
blockers. Inventory/SBOM retain actual npm scoped identity and both parent paths.
Raw findings and assessed results remain separate. SheetJS vendor bytes,
provenance, two applicability assessments, expiry2026-10-23T00:00:00Z, policy and
empty exception register are byte-identical. Tar checks remain mandatory.

Local quality:ci succeeds, including source/test types, production bundles,
generated contract,349 tests and one existing optional Backoffice replay skip,
22vendor tests,6tar cases and10xmldom cases. Separate policy19/applicability16 pass.
Fresh scan exits1 for genuine remaining blockers; initial two scanner invocations
failed closed because pinned tools were absent from PATH. Existing pinned tools
were found and reused; no install or guard change was needed. No local Go/PG
rerun for this Node-only leaf; required current hosted equivalents remain mandatory.

Residuals: chi trust, rgbcolor license, no-fixed OpenPGP treatment, password parser,
A13/A42 concurrency,A37 history/secret scanning,A35 native provenance and all other
parent/release requirements. No policy exception or new applicability rule.
