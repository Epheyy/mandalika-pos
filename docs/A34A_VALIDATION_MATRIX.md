# A34a deterministic CI baseline — validation matrix

Packet A34A-CI-20260921-01. Authority AUTH-MANDALIKA-20260919-01.
Current worktree inventory, including untracked programme source, precedes edits.
Canonical local/CI entry point: `corepack pnpm quality:ci` from repository root.

| Review case | Evidence / disposition |
|---|---|
|01 every workspace/package|A34A_INVENTORY_BEFORE/AFTER.json: root plus6 workspaces, scripts,32 test files,3 TS browser harnesses, actual parsed tsconfig root files|
|02 canonical command passes|A34A_CLEAN_RUNS.json final exit0, frozen install through generated schema check|
|03 POS tests|258 pass,15 files|
|04 Backoffice tests|49 pass,1 optional stored-PostgreSQL-response test skipped,5 files|
|05 sync tests|33 pass,10 files; new package test script|
|06 printer tests|7 pass,2 files; pure print-format behavior, not native printer qualification|
|07 app source/types/builds|Both source configs pass; both production bundles built|
|08 shared package types|sync/printer/API/types configs pass explicitly|
|09 excluded tests/harnesses|app tsconfig.tests.json includes src+tests, excludes nothing;20 app test files and3 TS browser harnesses;12 package test files already included in normal configs|
|10 TS generation clean|openapi-typescript7.13.0 from lockfile; schema equals regeneration after newline normalization, original bytes restored|
|11 negative sync|Disposable full quality:ci nonzero; deliberate assertion fails|
|12 negative schema drift|Disposable full quality:ci nonzero with DRIFT diagnostic|
|13 negative source types|Disposable full quality:ci nonzero on source assignment type error|
|14 negative test-only types|Ordinary POS source config passes; full quality:ci fails dedicated test check|
|15 negative app build|Disposable index.html missing entry makes actual Backoffice production build/full gate fail|
|16 signing dependency|Parsed Android build.needs=quality; relative reusable workflow selects caller commit; both checkout github.sha|
|17 secret separation|Reusable workflow declares no secret inputs; Android caller passes none; contents read only; signing secrets remain in dependent build|
|18 React Doctor|Unchanged advisory workflow, not a substitute/check inside quality|
|19 backend baseline|backend.yml byte-preserved; Go gen/vet/fmt/build/race steps inspected, not rerun for this JS wiring slice|
|20 uncovered qualification|Machine inventory and residual list below explicitly retain missing DB/browser/security/native/hosted coverage|

## Actual environment and run limits

Windows, local Node24.14.1, pnpm9.15.0. Workflow preserves existing Node22 setup;
no hosted Ubuntu/Node22 run is claimed. Frozen install succeeds and the only lock
change adds the already-resolved @types/node26.1.1 as a root dev dependency.
No dependency version upgrade or new toolchain. Root packageManager pins pnpm.

Initial canonical run failed at a newly exposed test type assertion: the printer
mapping regression deliberately passes legacy null while generated Transfer marks
receiverLetterhead optional-only. One test-local unknown cast and explanatory
comment retain that exact negative input. No production contract changed, no test
was removed, and no compiler diagnostic was globally suppressed. Test configs keep
strict checking but leave unused-variable lint out; production configs retain
existing unused-variable checks and run separately. The next canonical run passed.

The final default total is347 passed/1 skipped. The skipped Backoffice test is
an optional replay of previously captured PostgreSQL pages, not live DB execution.
It is intentionally not counted as covered. TS browser harnesses are checked, not
browser-executed. Plain JS browser-driver scripts remain manual. The A31 resolved
runtime evidence is preserved; not rerun or relabeled as hosted CI here.

Vite emits existing large-chunk/dynamic-import/performance warnings; those are not
build failures or A29 resource work. pnpm on local Node24 emits a url.parse
deprecation warning. Logs retain them. React Doctor is not run by the blocking gate.

## Negative proofs and safeguards

A34A_NEGATIVE_INITIAL.json retains the first negative runs. Their Windows text
writer could translate existing CRLF a second time; all probes were restored, then
repeated with byte-preserving mutation writes. Only the corrected final
A34A_NEGATIVE_GATES.json is relied on for the exact negative proofs. It records
root/cwd/commands, mutation fingerprints,
full stdout/stderr, nonzero exit statuses, expected failure markers and restoration.
A fresh temporary source copy has independent node_modules installed from the same
frozen lockfile. It contains no env files/keystores/live target. Probes run sequentially
and restore original bytes after each, then verify all copied source and active
source hashes. Active business source is never mutated for a probe. This is the
actual full quality:ci command, not a mocked runner or substitute assertion.

## Existing Go coverage versus opt-in/manual gaps

Existing backend CI normally executes non-opt-in tests including refund permission
middleware/handler/sync parity, sale/shift input unit checks, raw envelope/decoder
checks, semantic-key service/write units, linked tier goldens and read/preflight units.
A34A_INVENTORY_AFTER.json lists every Go test file and actual Test names.

Six explicit synthetic PostgreSQL fixture entrypoints remain opt-in:
S0c sale input, S0d shift decode, outer batch envelope, linked fulfillment, A26
pagination and A27 summary. Semantic/guest cases are additionally nested
inside linked fulfillment rather than independent default tests. There are six
distinct MANDALIKA_*_TEST_DSN gates; semantic and guest helper files
share the LF gate. Their loopback/database/user/data-directory/empty-schema safeguards
must survive future CI fixture work. Go's -race flag does not turn skipped database
cases into concurrency coverage. Earlier cleanup policy block remains untouched.

Existing browser scripts for A23/A24/A26/A31 and POS diagnostic/refund harnesses
remain manual. CI browser installation/execution, PostgreSQL concurrency, dependency/
SBOM/license/advisory gates, secret scanning, full APK/OTA provenance and debug gates,
branch-protection required statuses and hosted-run evidence remain open.

## Workflow structure / same commit

A34A_WORKFLOW_ANALYSIS.json records installed js-yaml parsing and assertions. PR/push
have no path or branch filters, so apps, packages, fixtures, lockfile, OpenAPI and
workflow changes are covered. Android quality uses ./.github/workflows/quality.yml,
then build needs quality with no always/condition bypass. Both checkout github.sha.
GitHub documents same-repository relative reusable workflows as using the caller
commit: [GitHub reusable workflow documentation](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows).
This is structural proof, not hosted-run or branch-protection evidence. No signing
secrets are forwarded; GITHUB_TOKEN is limited to contents read. No release was run.

Local source review traced failure propagation through every && stage, generator
exit handling/restoration, lockfile/version setup, test inclusion and dependency
ordering. New A34a work awaits ChatGPT review; no independent agent review claimed.
