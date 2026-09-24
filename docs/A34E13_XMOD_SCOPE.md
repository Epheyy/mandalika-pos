# A34e13 — x/mod build-tool dependency remediation

Scope ID: **A34E13-XMOD-20260924-01**
Review authority: **CG-A34E12-VITE-20260924-01-R1**
Standing authority: **AUTH-MANDALIKA-20260919-01**

## Outcome

Remove the two selected x/mod advisory matches through an actual qualified module
upgrade. Preserve production behavior, generated API contracts, existing security
controls and all accepted tests. No generic permission or planning-only round.

Start from reviewed SHA `bc738ace71e2d86f39ff810aa525550d5adabd7d` on
`audit/hosted-proof-20260922`, reconciling newer local reporting without losing work.

## 1. Evidence and candidate

Supplied baseline: x/mod v0.38.0 is indirect and classified build_executed from
source/test/codegen imports. It has two OSV module-level records:
- GO-2026-6179 / CVE-2026-56865: sumdb/tlog tile verification.
- GO-2026-6180 / CVE-2026-56864: sumdb Client.Lookup hash authentication.

The supplied govulncheck stream does not contain findings for these two IDs. Module
presence/build classification is not proof that their vulnerable symbols are called.

Official Go reports identify **v0.40.0** as fixed. Start with this minimum candidate;
refresh the official affected ranges, module metadata/checksums and retractions before
editing. v0.x does not provide a general compatibility guarantee, so test real consumers.

The same reports separately list vulnerable cmd/go releases. The current recorded
Go 1.26.8 is already beyond the 1.26.6 fixed boundary. Verify the actual local and CI
executables rather than inferring the executable from the root `go 1.26.0` directive.

## 2. Map the actual graph and executables

Before modification record:
- go version and relevant non-secret environment characteristics;
- go list -m -json all; go mod graph; go mod why -m golang.org/x/mod;
- production, test, code-generator and tooling import witnesses for each used x/mod
  package; distinguish modfile/module/semver from sumdb/tlog;
- actual oapi-codegen resolution via the checked-in `go tool` mechanism, not an
  unrelated global executable; build information where available;
- go.mod/go.sum, generated Go and TypeScript contract hashes;
- scanner-tool binary/version evidence separately where available.

A tool installed using `go install tool@version` can have its own module graph.
Do not assume a root x/mod change rebuilds or patches all scanners or the Go command.
Report uncovered independent-tool findings without hiding them or changing scanner pins
in this slice. Rebuild the actual project tool through its normal project invocation.

## 3. Minimum compatible graph change

Target `golang.org/x/mod v0.38.0 -> v0.40.0` using an exact update. No broad `go get -u`.

The upstream v0.40.0 go.mod declares Go 1.25.0 and x/tools v0.49.0. The current
project selects x/tools v0.48.0; v0.49.0's manifest includes x/net v0.58.0 and
telemetry revision v0.0.0-20260811182544-a038080d80e5. Verify the complete resulting
MVS graph; enumerate each moved version and its requiring edge.

Allow only required support movement and small mechanical compatibility edits. Do not
use replace/exclude tricks to force incompatible versions, remove the tool declaration,
or skip generator execution. Keep oapi-codegen v2.4.1 unless a material incompatibility
requires a separately evidenced decision. Do not silently upgrade kin-openapi or chi.

Do not assume every checksum line represents a selected installed version. Preserve
selected-version evidence separately from historical dependency edges/checksums.

## 4. Integrity and historical-cache boundary

Keep authenticated TLS, the normal reviewed module proxy/checksum authority and their
verification checks effective. Do not use GOSUMDB=off, broaden GONOSUMDB/GOPRIVATE,
accept checksum mismatches or make persistent `go env -w` changes to obtain green output.
Do not log credentials embedded in proxy URLs or private paths.

**Do not copy the advisory's blanket deletion recipe into the active project.**
Do not delete active go.sum, go.work.sum, the repository vendor directory, the SheetJS
artifact, or global/shared caches. No `go clean -modcache` over shared caches. Previously
policy-denied cleanup targets remain untouched.

Use a newly owned isolated cache/source copy where clean-download evidence is needed.
Any from-scratch checksum reconciliation occurs only in that disposable copy, with old
reference bytes preserved and a read-only diff returned. Keep real advisory collection
and controlled offline regression phases explicitly distinct.

`go mod verify` is a useful cache-integrity check, not certification that an earlier
vulnerable downloader never accepted poisoned content. This remediation is not incident
forensics. A suspicious checksum discrepancy is a blocker to investigate, not a reason
to overwrite expected hashes or erase history.

## 5. Bounded library/security regression evidence

Use the official fixes/regressions as the basis. Prefer a small checked-in harness linking
the actual selected library, plus identical old-v0.38.0 comparison in a disposable module.
Do not add a production sumdb import merely to manufacture application reachability.
Clearly label test-only exposure.

Required evidence addresses:
1. Valid synthetic signed-log/lookup or tile controls succeed.
2. Unauthenticated/unrelated hash material is not returned as authority for a requested
   module by the fixed Client.Lookup path.
3. Tampered/inconsistent synthetic tile ancestry is rejected by the fixed tlog reader.
4. Small module-path/version/go.mod parsing controls used by actual consumers remain correct.

All keys, module names, logs, tiles and hashes must be synthetic. No real module payloads
are poisoned and no fake public GOPROXY/GOSUMDB is configured. No live module-proxy attack,
external malicious service, global trust-key installation or credential use.
Use in-memory ClientOps/readers where possible. A local server is permissible only when
necessary, explicitly loopback-only and separately bounded; no external fallback.

Keep fixtures small (for example <=64 KiB and a small log tree), impose process timeout
and output/memory bounds, verify teardown, and preserve exact harness/library hashes.
A patched compiler alone is not a reproduction of an old x/mod library defect.
An old targeted test failure must arise from the behavioral assertion, not compilation,
missing fixtures, trust setup, or a deliberately broken expected version.

If a required internal upstream regression cannot reasonably be expressed through public
APIs, use the exact reviewed upstream package test in an isolated copy with version/source
provenance, and explicitly state that limitation. Do not use grep alone as exploit proof
or spend a separate turn inventing a replacement checksum service.

## 6. Consumer and API-contract preservation

Run the real repository generator `make gen-check` / `go tool oapi-codegen` against the
current OpenAPI source. Require unchanged generated Go DTO/server output. Run TypeScript
generation/drift as part of existing quality; require unchanged client schema too.
Preserve error handling for tiny invalid generator inputs and valid reference/schema
fixtures where practical without reading remote or sensitive files.

Run gofmt, vet, build and ordinary backend tests. Use -race where supported and retain
hosted Linux race evidence. Run all six mandatory PostgreSQL gates with zero skips;
ordinary opt-in skips do not replace those fixtures. Preserve auth/password compatibility
checks if any runtime x/crypto/x/text support module moves.

Keep all accepted Node dependency versions and harnesses, Vite8.0.16/PostCSS8.5.23/
NanoID3.3.18, the exact SheetJS artifact/provenance/assessments/expiry, policy thresholds,
review freshness rules and empty exception register unchanged.

## 7. Scanner and hosted result

Capture before/after full module graph, package/call evidence, normalized findings, SBOMs,
license evidence and source hashes. Require the exact two targeted IDs to leave the
selected project's x/mod findings after the fixed version is installed and queried.
Do not remove records through suppression, reclassification, scanner omission or count
hardcoding. New findings or changed upstream feeds must remain visible and explained.

Commit only explicit allowed paths, preserve branch-specific no-deployment safeguards,
and push normally. Require on one final SHA:
- quality success;
- backend/race success;
- six mandatory PostgreSQL gates success;
- browser success;
- completed fresh dependency assessment with the targeted delta.

Security may remain red for unrelated blockers. A scan/setup error is not a valid red
policy result. Do not claim every independent toolchain/scanner graph is patched merely
because the application graph is clean for these two IDs.

## 8. Acceptance matrix (MG01–MG16)

| ID | Required evidence |
|---|---|
|MG01|Entry identity and actual project/tool/package/call inventory; no invented runtime reachability.|
|MG02|Fresh official advisory/module provenance; candidate v0.40.0 and compatibility constraints.|
|MG03|Go executable version distinguished from module version; actual 1.26-line fixed boundary verified.|
|MG04|Exact selected module/graph delta with every supporting version justified; no broad upgrade.|
|MG05|Normal authenticated download/checksum controls and safe isolated-cache evidence; no destructive reset.|
|MG06|Meaningful old/fixed lookup-authentication regression with valid control and exact hashes.|
|MG07|Meaningful old/fixed tile-verification regression with valid control and exact hashes.|
|MG08|Finite fixture/process bounds and cleanup; no live proxy/credential/cache poisoning.|
|MG09|Real oapi-codegen invocation and generated Go output unchanged.|
|MG10|Source/test/tool compatibility and TypeScript generated contract unchanged.|
|MG11|Exact scanner/SBOM/selected-version coverage and target-ID delta; unrelated records retained.|
|MG12|Tool binaries installed independently inventoried where available; gaps explicitly bounded.|
|MG13|Local backend checks and six mandatory PostgreSQL gates; no skip-as-proof.|
|MG14|Existing Node/application/browser controls and all approved security state preserved.|
|MG15|Four hosted application gates green on one final SHA; fresh completed dependency assessment.|
|MG16|Explicit staging, no deployment/live changes, preserved denied-cleanup targets, current packet/manifest.|

## 9. Return

One current packet and one compact ZIP: exact diffs; MG matrix; module graph and
consumer/tool provenance; bounded regression source/results; generator drift and
compatibility evidence; exact advisory delta; same-SHA hosted results; declared limits;
tracker/progress delta and manifest. A34e13 review remains pending on return. No parent
or release gate closes automatically.

Non-goals: kin-openapi/chi changes, ingress trust decisions, legal approvals, OpenPGP
applicability, password parsing, A14/business policy, concurrency redesign, deployment,
Android signing/OTA, incident-forensics claims or generic scanner replacement.
