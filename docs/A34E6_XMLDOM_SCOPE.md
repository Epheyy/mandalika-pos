# A34e6 — xmldom through the existing plist/Capacitor chain

Scope: A34E6-XMLDOM-20260923-01
Authority: AUTH-MANDALIKA-20260919-01
Input source:095dcff509efeeab0b23dc48bc94e3caf6d71210.
This is the next bounded implementation contract, not a completed change.

## Outcome

Move the real currently selected @xmldom/xmldom0.9.10 dependency to the minimum
compatible publisher-fixed0.9.x version covering the current records; candidate
0.9.12. Preserve actual plist/Capacitor behavior for supported inputs and prove
normal scanning still sees the package. Do not add an unused root package.

The review input includes11 blocking High advisory records and2 Moderate records.
Their exact IDs/ranges are preserved in evidence/NEXT_FAMILY_BASELINE.json.
No total scan result or improvement count may be hardcoded.

## 1. Parent and provenance preflight

1. Start from the current branch/HEAD/dirty state; preserve final-report local edits.
2. Refresh all xmldom parents and pnpm snapshot paths; distinguish scoped
   @xmldom/xmldom from the retired unscoped xmldom package.
3. Verify the actual plist3.1.1 manifest and its declared range; verify Capacitor's
   plist range. Do not infer ranges from selected0.9.10.
4. Trace the current installed parent's parse/build/XML serializer usage and the
   Capacitor helpers that consume plist. Record actual APIs, options, error
   handling and data flow. Separate possible API reachability from exposure to
   attacker-controlled input; do not claim live POS exploitability from a dev edge.
5. Refresh publisher advisory/release and registry identity/integrity/license/engine
   information for candidate0.9.12. Select the smallest compatible fixed version;
   use a later compatible patch only if new current evidence requires it.
6. Inspect tarball metadata safely without running lifecycle scripts. Prefer the
   existing registry distribution; this is not another vendor-source migration.

## 2. Minimal dependency change

Prefer the smallest reproducible lock resolution consistent with parent ranges.
If a targeted update does not move the indirect lock, document that attempt and
use a narrowly parent-scoped override only for confirmed affected edges. Do not
blanket override every XML package; do not change Capacitor/plist/platform versions
merely to clear the scanner. Preserve the accepted exact tar override.

Enumerate every package/snapshot/importer/integrity movement. Reject unrelated
opportunistic updates. Do not replace the parser with a different library or
introduce a root dependency that leaves the consumed version vulnerable.

If0.9.12 genuinely violates the parent range, or a compatible patch cannot preserve
supported caller behavior, return the exact dependency/API evidence and a bounded
alternative. Do not force a breaking override or invent acceptable behavior.

## 3. Clean install and real consumer compatibility

In an owned disposable source copy, use a frozen-lockfile install and resolve the
parser using createRequire anchored at plist's installed manifest reached through
Capacitor, not a convenient top-level import. Verify actual package/version/entry
and tarball integrity. Account for every old copy in the selected dependency graph.

Use the actual plist parse/build API (after confirming it exists in this version)
and an actual Capacitor plist helper where it can run without native/provider side
effects. No package stubs. Supported tests should cover small representative:

- standard plist XML declaration/doctype;
- dictionaries, arrays, string escaping, Unicode, empty values;
- booleans, integers/reals, dates and binary/base64 values supported by the parent;
- comments, whitespace and round-trip meaning;
- representative synthetic native-project configuration with values preserved.

Use explicit expected typed values, not only same-library self-readback. Preserve
valid output and content. Do not require byte-identical formatting if the current
parent's contract is semantic; characterize any formatting difference precisely.

No Xcode/Android signing, device, platform migration or live project file mutation
is required for this small library/parent-helper qualification. State those limits.

## 4. Version fixes versus option-dependent protection

The maintainer distinguishes parser repairs from strict serializer repairs.

- Several serialization defenses require requireWellFormed:true. Exercise that
  documented fixed path, plus relevant default-path behavior. Do not claim merely
  installing0.9.12 turns every default serializer into a validator.
- A malformed closing tag now produces a parser diagnostic but may recover to a
  DOM. Assert the documented diagnostic and caller handling, not universal throws.
- Refresh whether the actual plist path uses DOMParser, XMLSerializer, a different
  builder, or some subset. A serializer-only library test is not evidence that the
  plist parser invokes that mitigation.
- Do not inject requireWellFormed/onError or another global override by monkeypatch,
  mutate installed dependency source or force all parser errors fatal to satisfy a
  test. If actual use needs semantic hardening, document that residual separately;
  complete a separable safe patch and do not call broader exposure fixed.

## 5. Bounded security regressions

Use tiny synthetic input in child processes with explicit deadline, output cap and
memory limits. Reuse the established bounded-harness pattern, not a new framework.
Never use a multi-MB/OOM fixture or network-delivered attack against an application.

Cover these bug classes using small publisher-inspired valid/invalid examples:
- creation-time embedded-newline Name/QName checks;
- attribute/element name and processing-instruction/doctype/entity-reference strict
  serialization where the appropriate option is documented;
- malformed end-tag trailing content diagnostic;
- small namespace/attribute collections and DOM.normalize adjacent-text correctness;
- bounded HTML raw-text close-tag handling, relevant only to that API path.

Meaningful before/after failures should demonstrate at least one parser and one
validation/serialization fix. For asymptotic performance fixes, use code/maintainer
patch evidence plus capped workloads. Do not force flaky elapsed-time ratios or
claim a small timeout proves all worst-case resource safety. A limit termination is
not a passing fixed-path result; record it as failed/unverified and diagnose.

Clean owned processes/tiny fixtures. Respect any automatic-review block; keep it
recorded and never reroute the same denied deletion. Existing retained directories
must not be reused as uncontrolled fixtures.

## 6. Advisory and inventory proof

Capture before/after inventories, findings, SBOMs, raw-policy, assessed-policy and
input hashes using the unchanged real scanner/evaluator.
- Retain npm/@xmldom/xmldom identity, fixed version, scopes and actual parent edges.
- Map all11 input blocking IDs and the2 report-only IDs; classify disappeared,
  retained, changed and new records. Do not rely solely on aggregate count.
- A disappearing package, unclassified edge or failed feed is not remediation.
- Test the old-version findings through the policy CLI in a disposable input or
  equivalent guard proof; leave active dependency versions intact.
- Preserve risk exceptions empty and SheetJS assessments/artifact/provenance/expiry
  byte-for-byte. No new applicability annotation, whitelist or threshold change.
- Changed current feeds can change counts. Report any mismatch; do not force a
  predetermined total or assume that every upstream issue is app-reachable.

## 7. CI and publication

Add focused deterministic consumer/regression checks to the existing mandatory
quality command so they run on hosted Node22. Keep all prior tar/vendor/policy/
applicability/client checks. Use existing explicit staging and no-deployment branch
safeguards; inspect the diff before ordinary commit/push.

Require on one final SHA:
quality success, backend success, postgres success, browser success, plus a completed
fresh dependency scan. Dependency-security may remain red for unrelated findings.
Require zero skips for mandatory fixtures/browser tests. State the existing optional
Backoffice replay separately. Do not rerun local Go/PG needlessly for a Node-only
leaf change; fresh required hosted gates provide that evidence as in A34e5.

If the parent range/API issue makes this a material redesign, pause only the
dependent change and return evidence/options. Do not ask for generic authorization.

## Acceptance matrix (XM01–XM16)

| ID | Evidence required |
|---|---|
|XM01|Exact entry SHA, preserved local work and refreshed all-parent graph.|
|XM02|Verified actual parent ranges and candidate satisfies them.|
|XM03|Publisher-fixed target, exact artifact/integrity/license/engine evidence.|
|XM04|Minimal reproducible package/lock diff; old tar override and other versions retained.|
|XM05|Clean frozen install; parser resolved from actual plist/Capacitor context.|
|XM06|Actual parent typed plist round-trip and benign native-config fixture.|
|XM07|Actual helper evidence where separable, or explicit native/helper limit.|
|XM08|Bounded before/after parser/strict-validation regressions; correct error-vs-throw contract.|
|XM09|Document strict opt-in/default paths and actual caller reachability; no fake hardening claim.|
|XM10|Capped resource-related checks and owned-process/fixture cleanup.|
|XM11|Old-version evaluator negative remains blocking; no suppression.|
|XM12|Exact advisory-ID delta, complete inventory/SBOM parent edge and raw/assessed separation.|
|XM13|All accepted tar, SheetJS, policy, exception and expiry bytes/behavior preserved.|
|XM14|Focused tests integrated into quality; application types/build/generator checks pass.|
|XM15|Four green hosted application workflows + valid fresh security scan on same SHA.|
|XM16|Explicit staging, no release/live-data changes, tracker updates and complete return manifest.|

## Exclusions and return

No Go/chi/ingress, rgbcolor approval, OpenPGP applicability, password-parser changes,
A14 importer, policy/exception edits, unrelated dependency campaign, broad native
upgrade, deployment, release/OTA, live database or customer-data operations.

Return one packet and compact ZIP with exact diff, parent/source/integrity evidence,
XM matrix, capped tests and before/after results, raw/assessed/SBOM delta, required
same-SHA hosted results, cleanup limitations and current tracker/progress. Do not
include full node_modules/install trees or old evidence archives.

On success record A34e6 implemented/locally+hosted verified, ChatGPT review pending.
Do not self-increment accepted milestones or close A34/A38/release gates.
