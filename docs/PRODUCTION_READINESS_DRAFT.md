# Mandalika production readiness — planning draft

## Current A34e15c readiness evidence — 2026-09-29

E76: CG-A34E15B-INGRESS-DESIGN-20260929-01-R1 accepts A34e15b as a
DESIGN BASELINE ONLY. No implementation milestone, source promotion or activation
approval. Keep 32 accepted milestones across 11 findings, all 44 parents, A31 alone
resolved, original P0 parents 0/8 resolved and release gates 0. A34/T29 and A38/T33
remain open. Retained 6 raw / 4 actionable / 23 report-only / 2 reviewed / 0 exceptions
is not a fresh scan. Detached chi-only4/2 is not adopted. E9/E11 stay closed.

E77: A34E15C-READINESS-20260929-01 completes one bounded evidence pass. Current
Cloud Run traffic still points to 00077-b45. Exact image -> successful Cloud Build
82827d61-cd0f-4814-a00f-524afd1cd7c9 -> immutable source generation1783574962355308
is established; archive SHA256/MD5 match. All108 selected source files match historical
6093c6d4 bytes;14 differ from accepted0478648. Deployed source is KNOWN-DIFFERENT,
not merely unknown and not authority to redeploy the audit branch. Future isolated
commissioning source/target remains unselected.

Latest accessible signed APK8190030052 is hash/signature-qualified; API and native
OTA both use old numbered run.app. Native URL flags are absent, source lock correlates
updater8.50.2; installed fleet remains unknown. Local debug APK has a different signer
and private LAN API. Known OTA object prefix returned empty; this is not a publication
or fleet census. No device/live HTTP/DB probe. Compute disabled evidence reused without
retry. X01–X06 list exact target/domain/budget/access/fleet/rollback/caller acquisitions,
separated into commissioning, migration, trust activation and retirement phases.
Stop dependent ingress work when those external inputs are absent; no more repeated
architecture/model rounds. activation_ready=false. New APK parser14/14 methods pass;
initial path-normalization failures are retained. No full/model/Go/hosted/security rerun,
active source/dependency change, staging, commit/push or operational action. See
[A34E15C_READINESS_EVIDENCE.md](A34E15C_READINESS_EVIDENCE.md) and the current packet.
This evidence task adds no accepted milestone. Historical checkpoints below retain
their original observation dates and scope.

## Current A34e15b ingress design — 2026-09-28

E74: CG-A34E15-CHI-INGRESS-20260928-01-R1 reviews A34e15 qualification and
endorses non-promotion; it does not accept remediation. Keep 32 accepted milestones
across 11 findings, all 44 parents, A31 alone resolved, original P0 parents 0/8
resolved and release gates 0. E9/E11 remain closed. Active 6 raw / 4 actionable /
23 report-only / 2 reviewed / 0 exceptions is retained evidence, not a fresh scan;
detached chi-only 4/2 is not adopted. Full A34/T29 and A38/T33 remain open.

E75: A34E15B-INGRESS-DESIGN-20260928-01 supplies a non-applying global external
ALB/serverless-NEG proposal, single backend-service header writer, 13-route bypass
matrix, coordinated identity/consumer model, API/native-OTA migration and paired
rollback, Jakarta cost assumptions and G01–G07 commissioning prerequisites.
Design/local qualification only; activation_ready=false. Current default URLs,
internal/alternate routes, disabled Compute inventory, source-to-image equality
and installed API/OTA fleet remain unresolved. Conditional IAP origin alternative
has Q-IS-01 custom Authorization compatibility pending; no new secret is proposed.
New Go models pass 40 named checks, zero skips; model vet passes. Offline proposal
checks pass, including 16 real-CLI rejecting counterexamples. Initial fixture
cleanup failure is preserved and corrected. No active source/dependency change,
commit/push, new hosted result, live probe, provisioning or deployment. See
[A34E15B_INGRESS_DESIGN.md](A34E15B_INGRESS_DESIGN.md) and current review packet.
This design adds no implementation milestone. Historical evidence below is retained.

## Current A34e15 trust qualification — 2026-09-28

E72: CG-A34E14C-CONTRACT-COMPLETION-20260925-01-R1 scoped-accepts A34e14c at
0478648e6600ce201e0a6e712ac77febdded9782 (tree 2ac4f0aedd03d18fb07d139ac92de1e691bb92a7).
32 accepted milestones across the same 11 findings; all 44 parents retained; A31 alone
resolved; original P0 parents 0/8 resolved and release gates 0. The earlier e14/e14b
qualifications and closed E9/E11 reporting corrections receive no separate milestone.
Accepted expanded baseline: 6 raw blocking / 4 actionable / 23 report-only /
2 reviewed-not-affected / 0 risk exceptions. A34/T29 and A38/T33 remain open.

E73: A34E15-CHI-INGRESS-20260928-01 completes independent chi/ingress qualification
but does NOT promote a dependency or middleware change. Current selected Cloud Run
reads identify service mandalika-pos, asia-southeast2, revision 00077-b45, ingress all,
public invoker, two default URLs and a TCP8080 startup probe. Regional domain mappings
are empty. Compute API listing is unavailable (SERVICE_DISABLED); other-project or
external proxy paths cannot be excluded. App-visible raw peer, unconditional header
transformation, duplicate handling and exact trusted-hop guarantees remain unqualified.
No application HTTP probe, infrastructure update, deployment or live-data operation ran.

Actual unchanged project consumers reproduce header-controlled logging/API/auth/OTA
buckets and login-attempt identity, including the login IPv6 split discrepancy. The same
required no-spoof invariant fails under both chi5.1.0 and detached chi5.3.2. Final bounded
characterization: old13/new48 named passes, zero skips; each has a separate intentional
no-spoof failure. Synthetic miniredis2.39.0 uses real go-redis TCP/transaction APIs; owned
ports close. Candidate API tests qualify normalization and expose missing-peer and
missing-identity enforcement obligations, not production trust or a consumer migration.

Fresh full app+tool scans retain active6/4/23/2/0. Detached version-only4/2/22/2/0 loses
GO-2026-5775, GO-2026-5777 and report-only GHSA-vrw8-fxc6-2r93, yet spoofing persists:
this is scanner-range evidence, NOT an adopted remediation. No exceptions or thresholds
change. Canonical gen-check, guard28/contract78/binding19, x/mod5 and target-evidence tests
pass; six native PostgreSQL18.3 fixtures pass148 with zero skips and confirmed cleanup
(non-race). Both source graphs pass vet/build/ordinary tests; ordinary opt-in skips do
not substitute for dedicated fixtures. No new hosted, full Node/browser or release claim.
See A34E15_CHI_INGRESS.md and the current packet for exact trust questions and IP01–IP18.

Earlier checkpoints below retain their historical review/verification states.

## Current A34e14c completion checkpoint — 2026-09-25

E70: CG-A34E14B-CODEGEN-20260925-01-R1 reviews A34e14b qualification and endorses
non-promotion. Q-KB-01 resolves the exact five nullable fields, six generated optional-body
adapters and listed generated categories as an explicit migration. This is not equivalence
with old pointer/null or EOF behavior, and adds no acceptance milestone. Keep 31 accepted
milestones across 11 findings, all 44 parents, A31 alone resolved, original eight P0 parents
and every release gate open. E9/E11 remain closed; detached historical6/4 was not adopted.

E71: A34E14C-CONTRACT-COMPLETION-20260925-01 adopts the qualified generator2.7.2 /
kin0.149.0 / runtime1.4.2 tuple after consumer, canonical generation and scanner qualification.
Five-field absent/null/object/invalid and six-adapter dispatch tests pass. Real repository
transfer/ingredient reads and POS/Backoffice document/receipt fallbacks are covered. Actual
handwritten routes/auth/permissions remain unchanged; existing loose optional-handler decoding
is characterized, not silently repaired or reclassified as safe. Spec/options/TS bytes unchanged.
Canonical generation validates and generates one frozen in-memory snapshot, rejects both
KO-OBS-02 forms before publication, uses bounded workers, checks output and input freshness,
and replaces once under a single-writer lock. Original raw-loader12/1 evidence is retained.
Both Make targets and mandatory backend CI use this boundary; failing/skipped required tests fail.

Explicit declared-tool and application govulncheck targets now enter unchanged policy with
completed-process, raw-byte, source and selected-graph evidence. Fresh expanded before scan:
15raw/13actionable/26report-only/2reviewed/0exceptions; after:6/4/23/2/0. The archived old
14/12 canonical result omitted tool calls. GO-2026-6016's18 called traces are ONE advisory;
replay blocks it, and missing/failed/truncated/wrong-target evidence is invalid, never clean.
Graph tidy removes obsolete dependencies; every42 module movement has before/after MVS edges.
Chi/OpenPGP/rgbcolor blockers, provider feed conflicts, policies and SheetJS decisions remain.
Local dedicated PostgreSQL18.3: six fixtures,148 named passes, zero skips, verified identities
and cleanup, explicitly non-race. Final hosted verification is recorded immediately below.
Implementation is review-pending; full A34/T29, A38/T33 and all release gates stay open.

## Hosted A34e14c proof — 2026-09-25

Hosted verification completed on `0478648e6600ce201e0a6e712ac77febdded9782` (tree `2ac4f0aedd03d18fb07d139ac92de1e691bb92a7`).
Quality/backend/PostgreSQL/browser all pass on this same SHA. Backend ran canonical generation,
vet/gofmt/build, the required codegen/contract lane, x/mod5 and full race tests. PostgreSQL used
Docker18.3/race: six fixtures,148 named passes, zero skips, verified identity and cleanup.
Chromium26/26 passes, zero skips, network isolation and process/port cleanup confirmed.
Expanded security completed:6 raw blocking records/4 actionable/23 report-only/2 reviewed/0 exceptions.
Source hashes and both required govulncheck targets match this commit; tool target has no findings.
The first backend run36119865999 failed gofmt on the new fixture; original logs are retained.
Correction0478648 formats that exact fixture and strengthens actual per-adapter value assertions.
No application behavior or guard was weakened. No release is approved; A34e14c awaits ChatGPT review.


## Current A34e14b qualification checkpoint — 2026-09-24

E68: CG-A34E14-KIN-OPENAPI-20260924-01-R1 reviews A34e14 qualification and
endorses non-promotion; remediation is NOT accepted. Keep 31 accepted milestones
across 11 findings, all 44 parents, A31 alone resolved, original eight P0 parents
and every release gate open. E9/E11 stay closed without extra milestone credit.

E69: A34E14B-CODEGEN-20260924-01 qualifies an owned candidate with generator2.7.2,
kin0.149.0 and runtime1.4.2. The real tool now builds and deterministically generates
the current3.1 spec. Whole-document validation passes without suppression; embedded
JSON and TypeScript contracts are unchanged. Five generated public nullable-object
fields now preserve explicit null where old pointer fields omitted it. Six generated
optional-body adapters change empty-body dispatch. These are proven semantic/public
type differences requiring review under the current contract policy; NOT promoted.

Bare generation accepts the unused KO-OBS-02 input and panics on the reachable form.
Explicit Validate rejects both. A canonical atomic validation/output guard is still
required and has not been integrated after the contract stop. Original loader12/1
evidence remains untouched. New candidate repeats12passing/1loader characterization,
with bounded cleanup; isolated generated binding/typed/response fixtures pass19/19
for both old and new. Candidate build/vet/fmt,515 ordinary tests, x/mod5 and six
nativePostgreSQL18.3 fixtures (142passes, zero skips, identities/cleanup) pass.
Local race unavailable; no new full quality/browser, commit/push or hosted claim.

Fresh canonical active baseline14raw/12actionable/27report-only/2reviewed/0exceptions.
Detached candidate6/4/23/2/0 is NOT an adopted reduction. Separate generator scanning
finds active called GO-2026-6016 (18 traces, one called advisory ID); candidate has no
reported generator findings. The canonical collector's ./... reachability pass does
not yet integrate this explicit tool target. Feed gaps remain visible. No policy,
exception, SheetJS, other accepted source or denied cleanup change.
See A34E14B_CODEGEN_QUALIFICATION.md and current packet for exact contract options.

## Current A34e14 qualification checkpoint — 2026-09-24

E66: CG-A34E13-XMOD-20260924-01-R1 accepts A34e13 at
63c74711ecb5f5a26641c748f324d2ff72c8a67d within its supplied limits.
31 accepted milestones across the same 11 findings. All 44 parents remain;
A31 alone is resolved. Original eight P0 parents, A34/T29, A38/T33 and every
release gate stay open. E9/E11 remain closed without extra milestone credit.

E67: A34E14-KIN-OPENAPI-20260924-01 completed bounded qualification but did NOT
promote kin-openapi0.149.0. The actual pinned oapi-codegen2.4.1 fails compilation
at pkg/codegen/schema.go:872 (MappingRef versus string), even for --version.
The candidate application builds using retained generated source; this is not
successful regeneration. An additional unresolved-reference loader probe returns
a partial document; explicit Validate rejects it. Generator handling remains to
be qualified before adoption. No generator patch/upgrade or production change.

Final identical supervised harness: old0.127.0 5 pass/8 fail; candidate0.149.0
12 pass/1 qualification failure (partial loader result), zero skips. Small
lookup/typed/auth/multipart/deepObject/ZIP/cycle vectors; no live endpoint or
large attack probe. Initial fixture/expectation issues remain separately recorded.
Fresh active scan stays 14 raw/12 actionable/27 report-only/2 reviewed/0 exceptions.
Detached candidate scan is 6/4/25/2/0; its eight blocking and two report-only
kin-openapi records disappear, but this reduction is NOT the active baseline.

Existing Go1.26.8 was explicitly verified and selected per process before Go
operations. Default local1.26.2 remains unchanged and a separate follow-up.
Active gen/gofmt/vet/build, 515 ordinary named tests, x/mod5 and quality pass.
Six dedicated nativePostgreSQL18.3 fixtures pass142 named checks with zero skips,
verified identities/cleanup; local race unavailable. Prior hosted Linux/race at
63c7471 remains historical accepted evidence; no candidate hosted run or new push.
The material compatibility blocker activates the scope's no-promotion return path.
All accepted source/contracts/dependency policies and denied cleanup targets remain.
See A34E14_KIN_OPENAPI_QUALIFICATION.md and current packet for Q-KO-01/options.

## Current A34e13 checkpoint — 2026-09-24

E64: CG-A34E12-VITE-20260924-01-R1 accepts A34e12 atbc738ac within its actual
Windows/Linux/pure-editor evidence limits. E11-REPORT-01 is closed as corrected
attribution; original logs preserved, no extra replay/milestone. E9 stays closed.
30accepted milestones across the same11findings. All44parents remain; A31 alone
resolved; original8P0 parents, A34/T29,A38/T33 and all release gates stay open.
E65: A34E13-XMOD-20260924-01 qualifies x/mod0.40.0, requiring x/tools0.49.0,
x/net0.58.0 and telemetry20260811. Real generatorv2.4.1 and generated contracts
preserved. Test-only offline lookup/tile regressions: old3pass/2behavioral failures,
fixed5/5. Fresh scan14raw/12actionable/27report-only/2reviewed/0exceptions; only
GO-2026-6179/6180 records removed. Six local native18.3 PostgreSQL gates pass,
142named tests, zero skips, verified identity/cleanup; local CGO-disabled/no-race.
Default localGo is1.26.2, distinct from scanner/hosted1.26.8. Existing cached1.26.8
was selected per process for this work; no persistent/global toolchain change.
Fresh patched-toolchain downloads in owned cache match preserved initial bytes;
this does not establish historical cache integrity or a POS runtime exploit.
Hosted same-SHA proof verified below; ChatGPT review pending. Earlier checkpoints remain historical.

## Current A34e12 checkpoint — 2026-09-24

E62: CG-A34E11-JSYAML-20260924-01-R1 accepts A34e11 at7d2ab47 within supplied
limits, including EXACT project-qualified Redocly1.34.14 -> js-yaml4.3.2 override.
Not range-satisfied, publisher approved or a blanket pin bypass. Consumer/generator
tests preserved.29accepted milestones across the same11findings; all44 parents
retained; A31 alone resolved; A34/T29,A38/T33 and every release gate open.
E11-REPORT-01 corrected: before-tests18/12; before-final17/13 includes unrelated
missing-flat-config fixture; fixed active/clean30/30. Original logs unchanged.
E9 remains closed; neither evidence correction adds a milestone.
E63: A34E12-VITE-20260924-01 qualifies Vite8.0.16/Rolldown1.0.3 and minimal
support graph. Three supervised groups pass active/clean; real Windows NTFS ADS
and actual8.3 alias vectors are blocked after qualified old-version reproduction.
UNC evidence is exact-source/extracted-pure-predicate only, with no UNC I/O/editor.
Local quality passes; security16raw/14actionable/27report-only/2reviewed/0exceptions.
Only Vite's oneHigh + oneModerate records disappear. Hosted proof verified below; ChatGPT review pending.
Earlier checkpoints are historical; A34e12 is not yet ChatGPT-accepted.

## Current A34e11 checkpoint — 2026-09-24

E60: CG-A34E10-BROWSERSLIST-20260924-01-R1 accepts A34e10 at 4f63473.
28 accepted milestones across the same 11 findings. E9-REPORT-01 is closed as
corrected evidence, not an extra milestone or parent. No new E9 replay required.
All 44 parents retained; A31 alone resolved. A34/T29, A38/T33 and release gates open.
E61: A34E11-JSYAML-20260924-01 locally verifies js-yaml4.3.2 through both
ESLint/eslintrc and Redocly/OpenAPI. Exact Redocly pin override is documented,
not claimed range-satisfied.30/30 active/clean; before-tests18/12, before-final17/13
(extra missing-flat-config fixture; corrected by E11-REPORT-01). Fresh scan17raw/15actionable/
28report-only/2reviewed/0exceptions;3High+1Moderate IDs removed. Hosted proof verified below; ChatGPT review pending.
Earlier checkpoints are historical. The next slice is not yet accepted.

## Current A34e10 checkpoint — 2026-09-24

E58: CG-A34E9-POSTCSS-20260923-01-R1 accepts A34e9 at 79403f2 within its
supplied evidence. 27 accepted milestones across the same 11 findings. All 44
parents remain; A31 alone is resolved. A34/T29, A38/T33 and every release gate open.
E9-REPORT-01 corrects active evidence: before-corrected 12/3; before-final 11/4
includes a separate Vite path fixture failure; after-final and clean 15/15.
A new exact-final-harness replay on the qualified old graph is 12/3; original
logs are retained. See A34E10_BROWSERSLIST_REMEDIATION.md for hashes and limits.
E59: A34E10-BROWSERSLIST-20260924-01 implements compatible Browserslist 4.28.7
and four required minimum data updates. 15 checks pass active and clean; old
qualified graph 8 pass / 7 targeted failures. Fresh local security: 20 raw /
18 actionable / 29 report-only / 2 reviewed / 0 exceptions. Two Browserslist
High IDs disappear; the existing Moderate baseline-browser-mapping record
only changes selected version. Hosted proof verified below; ChatGPT review pending.
Earlier sections are historical checkpoints, not current acceptance counters.

Policy baseline: 2026-09-15; active review/authority record updated 2026-09-20.
Application baseline: `prod-hardening@4691c78` plus preserved S0a/S0b/S0c and S0d-shift-decode local changes.
Status: execution under [AUTH-MANDALIKA-20260919-01](PROGRAMME_EXECUTION_AUTHORITY.md)
for all A01–A44 phases. Environment, target, budget, recovery and release safeguards
remain required; standing authority does not resolve open business decisions.

Consolidated policy matrix, current code evidence, phased delivery plan and
acceptance scenarios: [PRODUCTION_READINESS_PLAN.md](PRODUCTION_READINESS_PLAN.md).
That companion summarizes this decision history; confirmed later decisions
supersede earlier proposals. Execution authority comes from the standing record above.

## Decision record

### September 21 — A26 acceptance and A27 contained summary contract

CG-A26-PAGINATION-20260921-01-R1 scoped-accepts A26-pagination-completeness (E26),
with parent T23 remaining open. The same review specifies A27's existing status
contract: totalSales/orders and payment/product/daily/average remain completed-only;
totalRefunds remains refunded-only; netSales must not subtract those excluded rows
again. E27 implements exactly netSales=totalSales and verifies isolated database /
handler responses and unchanged financial snapshots. API shape, current created_at
[from,to), parser/default window, scope and cache semantics are preserved.

This is not approval of final gross/net vocabulary or settlement-time accounting.
Q09/A28 cross-day refund posting, exchange/post-close payout projections, tax/discount
basis and outlet calendar remain open. No historical financial records are rewritten.
Full A26/T23, A27/T24 and all release gates stay open; E27 awaits scoped review.

### September 21 — A23/A24 scoped acceptance and A26 pagination contract

CG-A23-QUAL-A24-GUEST-20260921-01-R1 accepts A23 target/browser qualification
within E22 limits (native open), and A24 ordinary guest containment within E23.
A23/T21 and A24/T22 stay open; prior decisions and scoped acceptances stand.

A26 now retrieves complete metadata-bounded pages for the named report/dashboard/
recap consumers. A later-page failure is an error or visibly stale complete cache,
never a successful prefix. Raw financial operations and historical orders are not
rewritten. Unknown legacy recap-cache completeness cannot be inferred; retain bytes
but require one complete online load before certifying that snapshot for fallback.
No A27 refund/net or A28 calendar definition changes, and no A31 global race claim.
E25 evidence supports the bounded local milestone only; all release gates stay open.

### September 21 — semantic-key acceptance and bounded guest-sale containment

CG-A23-SEMANTIC-KEYS-20260921-01-R1 accepts semantic-key validation within supplied
limits (E21). Earlier mapper/envelope/LP05/linked-fulfillment acceptances stand.
A23/T21 remains open despite E22 target/browser qualification; no native clearance.

The same reply reconfirms the already-approved ordinary guest-sale contract: null
customer identity, no fake Guest account, generic benefits allowed, customer-capped
or assigned codes and loyalty still require their applicable customer. E23 removes
the blanket UI gate and requires a clean reconfirmed total after benefit rejection.
Guest capture/receipt/database tests support this bounded implementation. Later
TL/open-shift attachment and historical correction stay separate; no new loyalty
launch policy, quote migration or A29 resource design was decided or implemented.
Full A24/T22 and all parent/release gates remain open. See the canonical tracker.

### September 21 — linked-fulfillment acceptance and Q-LF-01 resolution

The owner relayed ChatGPT scoped acceptance of A23-LINKED-FULFILLMENT-20260920-01
within supplied evidence limits (E19). No separate response file/ID was supplied.
A23/T21 and all parent/release gates remain open.

**Q-LF-01 resolved: enforce the existing disjoint domain, do not implement a general
overlapping-slot allocator.** Original bundle/BXGY specs, write validation, service
first-slot assumptions and ProductVariantPicker confirm the gap is semantic key
coverage. P intersects P and every P|size; P|M intersects itself but not P|L; different
products are disjoint. Comparisons stay exact and case-sensitive. Alternatives
within one slot are a union; only cross-slot coverage conflicts. BXGY empty get
retains same-set mode; empty buy retains the complement of explicit get keys.

E20 implements this same validation class at authoring and execution boundaries,
with read-only legacy diagnostics. No overlapping catalog capability or allocation
redesign. The impossible-move guard, Q08 and physical ownership/usage provenance
remain intact. Offline captured semantic-overlap lines keep their price/quantity
and warning/review evidence; online new requests reject. No queue/promotion-row
rewrites or unearned validated grants. Other invalid/missing configs, A29 resource
compression, versioned quote/receipt and loyalty work remain separate/open.

The earlier Q-LF-01 allocator proposal below is historical and superseded by this
explicit direction; it must not be implemented as the next step.

### September 20 — LP05 acceptance and linked-fulfillment owner contract

CG-A23-LP05-20260920-01-R1 scoped-accepts LP05. The prior mapper/envelope
acceptances remain intact; A23/T21 and all parent/release gates stay open.

**Q-LP05-02 — Option A accepted and locally implemented at E18.** Linked code
remains the single selection/usage owner; promotion ID remains the reward/bundle
physical owner. Do not fake a direct appliedPromotions entry. Retain the linked
mechanics snapshot including bundleConfig. Reuse direct allocators and picker
semantics for code-only bundle/separate-set BXGY. Pending picker state is not a
sale mutation; cancel installs no selection, usage intent or physical effect.
Confirm and direct takeover commit one effect after restoring/removing the old
promotion-ID effect. Removal/restoration uses retained maps exactly once. Cart
edits, reactive invalidation, exclusivity, clear and existing customer cleanup
must remove the corresponding direct/code owner when its physical effect goes.
Preserve raw code provenance, one usage intent and original queued histories.

E18 also contains impossible freed-unit overclaims and stale picker substitutions
before mutation. This enforces cart quantity conservation, not a stock-availability
gate; Q08 warning/override is unchanged. The shared allocator's wider overlapping
slot semantics remain Q-LF-01 for separate analysis; no global allocation algorithm,
resource compression, quote/receipt migration or new business policy is adopted.
Earlier milestone paragraphs below remain historical; their missing-path statements
are superseded only by this bounded implementation/evidence, not parent closure.

### September 20 — scoped envelope/mapper acceptance and LP05 identity contract

CG-S0D-ENVELOPE-A23-20260920-01-R1 accepts the S0d outer-envelope correction
and narrow A23 tieredConfig mapper within their supplied evidence. Parent
A43/T25, post-commit readback, A23/T21 and every release gate remain open.
This later record supersedes the earlier review-pending entries only for those
scoped subtasks; their historical tests/logs are unchanged.

**Q-LP05-01 — accepted technical contract, now locally implemented.** Deduplicate
current selections by stable promotion ID, never name/value/rule shape. Direct
promotion wins over its linked code; remove that code before testing incoming
direct combinability against unrelated selections. Without a direct winner, the
first effective linked code wins with its raw code identity preserved. Same raw
code remains a no-op; different IDs and unlinked codes retain ordinary behavior.
Discard redundant entries rather than keeping hidden alternatives that reappear
after removal. Current pricing and newly captured IDs/codes/labels/breakdown must
represent only effective identities. Do not rewrite historical queued captures.

Removing redundant code metadata must preserve direct-owned reward lines and bundle
stock/bookkeeping. E16 tests verify conservation. This contract does not supply
missing linked bundle/BXGY selection mechanics: current linked handler records code
metadata without the direct pick/allocation flow. Q-LP05-02 records that remaining
A23/T21 design question and recommended next bounded work. No linked mechanics,
resource compression, quote migration or business eligibility change is implied.
Q-S0c-01/02, explicit legacy unknowns, unresolved policies and Q08 are preserved.

### September 20 — outer-envelope review correction and A23 mapper

CG-S0D-SHIFT-DECODE-20260920-01-R1 requests changes to S0d's complete-envelope
claim, preserving positive direct/inner evidence. E13 correction is implemented
and locally verified; no acceptance inferred. Existing empty batch no-op shapes
remain; unusable keys cause whole-envelope rejection. Captured payloads/keys and
per-item independence remain, no new retry or financial policy.

A23 mapper passes single-selection parity tests. Q-LP05-01 remains technical
review work: a reproduced cross-selection duplicate benefit conflicts with the
backend's existing direct-first/first-code deduplication. Recommend alignment with
that contract in a separate bounded correction; no new precedence/usage behavior
is implemented or declared approved here. All parent/gate states remain open;
Q-S0c-01/02, raw assignment/reissue and Q08 decisions below remain unchanged.

### September 20 — S0c review, technical answers and S0d containment

CG-S0C-20260920-01-R1 accepts A09-input-numeric only, within the original
S0c evidence limits. S0d-shift-decode is locally verified and awaiting review.
All parent findings, historical recovery and release gates remain open.

**Q-S0c-01 — accepted technical direction, future implementation.** Separate
immutable, versioned captured financial facts from reconciliation decisions and
settlement events. Preserve original quote/rules, line allocation, tender facts,
producer and business time, and provenance. Explicit legacy unknowns stay unknown;
never invent zero, current catalog prices, historical authority or payment proof.
Use stable registered producer/operation namespaces, original authorized scope and
a canonical body fingerprint. Same key plus changed body is a conflict. Receipt
and effects commit atomically; ingestion receipt is distinct from effect success.
Current clients must not prune pending-review captures based on an ingestion ack.
Fixed-scale deterministic numeric representation must preserve legitimate fractional
allocations and stable rounding/remainder identities. Migration/read compatibility
and captured-event recovery require their own design/tests before rollout.
A09/A10/A11/A29 own the command/receipt/error work; A28 owns business time, not
error taxonomy (correction to the S0c matrix linkage). Q08 warning/override remains.
No new split-tender, partial-payment, redemption, earning or capture-authority policy
is decided here; the recorded provisional loyalty decision is unchanged.

**Q-S0c-02 — accepted technical direction, future implementation.** Replace
quantity-expanded work with count-compressed calculation AND grants/output/DB work.
Preserve stable original line and role identity, tie order and existing deterministic
rounding across paid/reward/bundle shapes. Enforce measured technical work budgets
before expensive calculation/output, propagate cancellation and roll back effects;
retain a no-effect failure under the original operation key. No arbitrary business
quantity cap, automatic basket splitting, partial acknowledgment or fabricated
settlement. Validate with golden/property tests against supported small legacy
shapes, including zero/fractional allocations, large quantities and excess anchors;
measure work, memory, output/grant rows and cancellation. Existing one-row-per-grant
quantity-one consumers require a separately tested compatibility/migration plan.
Runtime owner is A29 promotion-resource-safety, linked A09/A23/A38; A40 only documents.
Neither this nor the quote/receipt redesign was implemented inside S0d.

**Unique slice labels.** S0d-shift-decode is A43 (formerly S0k).
A23-linked-promotion-parity retains its separate task (formerly proposed S0d).
The A23 mapping correction must not grow into either larger redesign above.

### September 20 — standing authority and bounded containment (S0c milestone)

CG-S0B-20260919-01-R2 accepts S0b A06-permission-parity within its evidence limits;
S0a A02-export remains accepted. S0c numeric/structural input containment is locally
verified at that milestone; subsequent scoped acceptance is recorded above. Full A02/A06/A09 and all release gates remain open.
Historical slice-only grants below remain original records, superseded for future
execution by the owner's programme-wide grant. No Q01–Q10 recommendation becomes
business policy through this grant. Q08 stock warning/override and raw assigned-code
identity/reissue decisions remain unchanged. Current scope/evidence: canonical
tracker, S0C_VALIDATION_MATRIX.md and packet S0C-20260920-01.

### September 19 — CG-MA-20260919-01-R1 and owner S0a authorization

Subsequent review CG-S0A-20260919-01-R1 accepts A02-export as implemented and
locally verified within scoped containment, and resolves the missing-document
review limitation for the supplied material. It does not close A02 or any release
gate, grant another slice, or independently rerun runtime checks. Its non-blocking
A04/A30 cleanup clarifies active fixed-terminal wording only; settled policy is
unchanged. See the latest SESSION_HANDOFF prefix for the current relay packet.

The owner explicitly authorized S0a non-destructive diagnostic export and focused
tests after the review reply. This supersedes the earlier documentation-only
boundary for S0a alone. Its local result/evidence is in the canonical tracker and
current SESSION_HANDOFF packet S0A-20260919-01; it does not close A02 or any release gate.
The reply itself is technical review, not owner approval of its policy proposals.
See plan §Review reply disposition for all ten split statuses and dependency gates.

Q08 documentary correction: preserve the July 7 raw assigned-code customer ID plus
reissue decision, and June 11 POS stock warning/override decision. Exact original
repository excerpts and their evidentiary limits are in
[Q08_APPROVAL_EXCERPTS.md](Q08_APPROVAL_EXCERPTS.md). Do not blanket-resolve merged
identity for assigned-code eligibility or add a hard stock-sale denial. Preserve
conservation, original/effective ownership evidence, valid quantities and truthful
stock movements. Cap-subject/reissue-allowance choices are still unresolved.
No Q01–Q10 business recommendation is implemented through S0a.

### September 19 full-audit adoption

The complete A01–A44 programme is retained in the sole current
[coverage tracker](AUDIT_COVERAGE_TRACKER.md), incorporated into this draft's
workstreams. See plan §Full-audit programme for sequence and scoped contracts.
All original P0/P1/P2/P3 findings remain; A04/A14 are narrow refinements only.
U04 confirms fixed device/outlet/account access without normal POS switching or
logout; Backoffice manages recovery. Original attribution, server scope, pending
evidence and authenticated recovery remain required. Existing shift-start and
TL identity policy is preserved; shared-account interaction awaits Q01 review.
U14 confirms live/backdated counts and Backoffice-generated templates/direct
entry. Preserve immutable physical observations and replay receipts; append
reconciliation revisions for late movements and newer-count intervals. No sales
freeze, automatic release of held goods or silent financial-period rewriting.
The plan's A14 contract retains T11a–n/I01–23 and the original replay safeguard.
Technical schema, parser and closed-period policy proposals are not owner approvals.
The project-wide ChatGPT/Codex workflow applies to all findings. That adoption
turn authorized documentation/design/workflow only. The later S0a-only authority
above does not authorize unrelated application or live operations.

### September 15 consolidated policy clarification

These decisions qualify earlier sections where noted; unresolved questions are
not approved exceptions or implementation requirements.

- Use configurable operating schedules per outlet and a separate office calendar.
  Actual opening/working hours, working days and outlet time zones are still
  unspecified. Transfer requests remain "pending office processing"; no processing
  deadline has been promised.
- SPVs are not authorized to inspect or approve inspection outcomes. They give
  instructions to their outlets, whose actions can be recorded for KPI purposes.
  The proposed SPV exception for opened or missing main bottles was rejected.
  Do not treat it as approved. Confirmed clarification: the handling outlet's SPV
  still authorizes late returns and full refunds after exchanges under the earlier
  approval process. This does not grant inspection or seal-condition exceptions. Existing
  inventory-management inspection authority does not arise from SPV status alone.
- Voluntarily returned complimentary testers have no refund value. Record receipt
  and hold them outside sellable stock until inspected.
- Staff must authenticate online before starting a shift; retain approved offline
  permissions for that shift. Detailed session expiry and device recovery mechanics
  remain technical design work.
- Outlets have Rp1,100,000 MODAL, an operational fund also used for refunds. When
  exhausted, staff may request back-office refund by transfer. This is an operating
  fund amount, not a confirmed per-refund ceiling or a guaranteed current balance.
- Apply the original still-open-shift limit to TL corrections of existing customer
  accounts as well as guest-account attachment. After closure, route to authorized
  head-office review; retain existing used/redeemed-point restrictions.
- Loyalty is not in use yet and may be introduced later. Keep earning rates,
  redemption value and limits configurable without launch values. Provisional
  earning basis: use purchase value after discounts, including the portion paid
  with points. The user explicitly considers this subject to a later fixed
  decision; it is the current planning assumption, not a finalized launch policy.
  This qualifies references below to net spending for earning purposes: include
  retained points-funded purchase value while accounting for linked returns and
  exchanges without duplicate earnings. Monetary refund calculations remain
  separate and must not convert redeemed points into cash. Preserve the earning
  basis with the applicable rule version so a future policy change need not
  reinterpret historical transactions. Planned checks should cover mixed tender
  earning on after-discount value and corresponding return adjustments.
- If earning rules have never synchronized, allow the sale with loyalty pending
  calculation. Resolve it online using historical rules effective at purchase
  time; do not guess an award. Missing historical configuration requires resolution.
- A shift may close with pending exchange/recovery items and its recorded cash
  movements listed. Preserve the submitted close record and link later settlements
  or corrections rather than replacing that record. The user accepted this approach
  and requested an explanation; reporting and reconciliation details remain design.

Planned checks include configurable calendars, inspection-held tester receipt,
online shift authentication, original-shift validation for account corrections,
pending calculation without cached rules, and linked post-close settlements.

The August 25 reliability approval is recorded on remote branch
`feat/mandalika-stabilization-design`, in `docs/CONTEXT_HANDOFF_2026-08-25.md`.
That branch adds planning documentation, not application changes.

The current conversation confirms:

- This is a development/polishing deployment, not a live company production system.
- Keep Cloud Run, Neon, Upstash, Cloudflare Pages, and Cloudinary as the current
  development environment while establishing production readiness.
- Free-tier limits are temporary test-budget constraints, not product requirements.
- Google Cloud is the preferred possible consolidation destination. Migration
  scope, costs, timing, and execution remain undecided.
- POS devices operate approximately 12–14 hours daily.
- Cashiers must be able to physically return cash during an outage. This
  supersedes the proposed requirement to wait for server approval. Detailed
  offline verification, limits, and reconciliation controls remain proposals.
- Cashiers explicitly granted refund permission may perform offline cash
  refunds independently; manager approval is not required.
- Offline refunds require the original sale to be stored on the device. A
  customer's receipt alone is insufficient when the local sale record is absent;
  that refund requires connectivity and an online lookup.
- Company policy permits cross-outlet refunds. They require connectivity so the
  server can validate the original sale and refund history. While offline,
  refunds are limited to same-outlet sales stored on the device, even if a
  different outlet's sale happens to be cached locally.
- Refunds cover the entire sale, not selected items. Scent exchanges are a
  distinct workflow and may cover the entire sale or selected items.
- Scent exchanges permit different-priced replacements: customers pay the
  difference for upgrades and receive the difference for downgrades. Same-price
  exchanges have no price difference when the replacement charge equals return
  credit. Settlement follows the confirmed payout and handover policies below;
  selected-item exchange credit
  is not a standalone partial refund.
- Loyalty points earned must reflect the customer's final net spending. Exchanges
  adjust the existing entitlement rather than awarding points twice; upgrades,
  downgrades and refunds must produce corresponding adjustments. If points being
  reversed have already been spent, allow the refund normally and offset the
  outstanding points adjustment against future earnings; do not reduce the cash
  refund. For purchases paid partly with loyalty points, refund the monetary
  portion through cash/transfer and restore the redeemed points separately from
  earned-point reversals; redeemed points are not converted into a cash payout.
- Offline purchases may earn points, but those points become available only after
  successful synchronization and server acceptance. Spending points requires
  connectivity and server balance verification across outlets. Eligible offline
  refunds retain the approved cash payout flow, with point restoration and
  adjustments queued for synchronization.
- Exchange upgrade differences may be paid using any payment method normally
  accepted by the POS, regardless of the original sale's payment method. Customer
  convenience is a guiding preference, not blanket approval of new payment
  integrations, split tenders, credit, or unverified payment completion.
- Returned scents receive exchange credit based on the original amount actually
  paid after discounts, not their current list price. Item-specific discounts
  stay with their item; transaction-wide discounts are allocated proportionally
  across eligible items after item-specific discounts, as approved by the user.
- Replacement scents use today's selling prices and eligible current promotions.
  Original promotion terms are not automatically carried onto replacements.
- Entire-sale refunds and downgrade differences may be returned in cash during outlet opening hours or
  by transfer during office working hours; payout need not use the original
  purchase's payment method. Exact schedules and transfer processing rules are
  not yet fully specified. The user explicitly confirmed the policy applies to both.
- Office staff execute transfers manually through company banking tools. The
  application tracks the payable and settlement status; bank-transfer execution
  through an application/payment-provider integration is outside this scope.
- For refund and exchange-downgrade transfers, the cashier records the amount
  owed and customer-confirmed bank details. Authorized office finance staff make
  the transfer and record its reference, time and proof. The payout remains
  pending until payment is confirmed. Switching a pending transfer to cash
  requires finance confirmation that the transfer has not already been sent.
- Scent exchanges follow the approved refund authority and connectivity rules:
  cashiers with refund permission act independently without manager approval;
  offline exchanges require the original sale stored locally and the same outlet;
  cross-outlet exchanges require connectivity and server validation. This applies
  to full and selected-item exchanges, including upgrades and downgrades.
- Offline exchanges may use the latest successfully synced prices and locally
  verifiable promotions, even if prices have since changed. Preserve the quoted
  amount after reconnect; promotions requiring server checks need connectivity.
- Exchange returns remain outside sellable stock until inspected. Refund returns
  default to sellable because refunds follow a strict return policy; the cashier
  can mark exceptional refund returns for inspection instead.
- Users with inventory-management permission may release inspected returns into
  sellable stock. Refund permission alone does not grant that authority. Offline
  execution of inspection release remains unresolved.
- Returned stock from an offline refund must wait for server acceptance before
  resale. Reconnecting or merely submitting the queued operation is insufficient.
  Returns held for inspection also require authorized inspection release. This
  supersedes the proposed immediate resale of provisional refund stock; offline
  refunds and cash payouts remain allowed under the previously approved rules.
- Both refunds and scent exchanges have a standard five-day return window from
  purchase date. Later requests are allowed with outlet SPV approval; five days
  is not an absolute cutoff. SPV approval may occur by phone/message and be
  recorded by the cashier, without an in-app SPV approval action. This exception
  concerns timing only; the separate main-product seal requirements still apply.
- Late-return approval comes from the SPV of the outlet handling the return,
  including cross-outlet refunds/exchanges, not the original selling outlet.
- The standard window ends at outlet closing time five calendar days after the
  purchase date, not 120 elapsed hours. Approved example: Monday purchase ->
  Saturday closing. Later requests follow the SPV exception path rather than
  automatic rejection.
- Exchanges do not restart the five-day window. Replacement bottles retain the
  original purchase date for subsequent return eligibility, including repeated
  exchanges. Requests after that original window require the handling outlet
  SPV's approval under the existing exception policy.
- Scent exchanges are part of the company's warranty model. A subsequent
  full-sale refund requires SPV review rather than automatic eligibility or an
  absolute prohibition. This is a separate review trigger from exceeding five
  days. Approved calculation: original payment + upgrade payments received -
  downgrade amounts already returned, yielding the remaining net payment.
  Approval comes from the handling outlet's SPV, by phone/message if needed,
  recorded by the cashier, as with late returns.
- Bundle context supplied by the user: `(110/120 ml + 10 ml)` as main, plus a
  `2 ml` tester. Full-sale refunds require both main bottles to remain sealed;
  exchanges require only each selected bottle being exchanged to remain sealed.
  The 2 ml tester may be opened and used for testing;
  that use does not disqualify the return. Customers may keep the tester; its
  absence does not disqualify either workflow.
- The 2 ml tester is complimentary. Keeping it causes no deduction from refund
  or exchange credit. It has no customer-paid value to refund and does not absorb
  transaction-discount allocation from the priced main bottles. Complimentary
  status does not mean the tester has no inventory cost.
- Each main bottle (110/120 ml and 10 ml) has its own selling price. Preserve
  that component's original sale price and discounts for selected-bottle exchange
  credit rather than guessing a split of one undifferentiated set price.
  Transaction-wide discounts use the approved proportional allocation; special
  promotion/bundle reward eligibility rules still require specification.
- Exchanges replace selected main bottles (the 110/120 ml bottle or the 10 ml
  bottle), not automatically the entire bundle, and include no fresh 2 ml tester.
  The earlier allowance for exchanging all selected items is not withdrawn.
  An unexchanged bottle may be opened; its condition does not disqualify the
  selected sealed bottle from exchange. This supersedes the earlier blanket
  both-bottles-sealed wording for exchanges only.
- A physical receipt is not mandatory: staff may verify the original sale in
  system records. Requested POS flow: enter the customer's number, list matching
  registered customers, tap a customer to view details and transaction history,
  then use a specific recorded transaction to verify the refund/exchange.
  Customer number explicitly means phone/WhatsApp number, not a separate
  membership number. The current picker supports name/phone search.
- Phone entry and lookup must accept foreign numbers; do not enforce `08` or
  `+628` prefixes or automatically assign Indonesia as the country. This
  supersedes the earlier Indonesian-format normalization proposal as a default.
- Guest sales without a phone number are allowed. Do not require customer
  registration, a fabricated phone number, or selection of a shared placeholder
  customer to complete a guest sale.

These decisions supersede the older framing of Gate A as necessarily free-tier-safe
at full fleet load. The earlier 60-second polling proposal is NOT approved.

## Requirements carried forward

- 25+ outlets, one operational POS per outlet; 5–10 backoffice users.
- Approximately 400 transactions/day on quiet days and 1,500+ on peak days,
  across the fleet. Peak burst distribution and growth targets remain unmeasured.
- Up to 60 minutes offline for sales, refunds, transfer sending/receiving,
  goods receiving, and stock counts.
- The 60-minute requirement is an outage-tolerance test target, not a guarantee
  that outages cannot last longer or an expiry for queued financial records.
  Cross-outlet refunds are explicitly excluded from offline operation. Behavior
  for extended outages and offline permission expiry still needs definition.
- A locally acknowledged sale survives crash, force-close, reboot, and battery
  loss without cashier re-entry. This does not promise recovery from physical
  destruction or loss of a device before synchronization.
- Sales and cash actually returned are completed local business facts. Refund
  eligibility and inventory effects may remain provisional until server
  validation; that validation must not erase an actual cash disbursement.
- No fixed launch date; advancement depends on verified acceptance criteria.

## Approved reliability direction

Use an awaited native SQLite transaction to journal a complete sale before
acknowledging it. PostgreSQL is the canonical server ledger (currently Neon,
potentially Cloud SQL). Every operation has a stable device-scoped key. Delivery
is at least once; accepted effects, operation receipt, and audit record commit
atomically. Retries return the original outcome without repeating side effects.
Ordinary POS actions cannot discard unsynchronized financial events. Redis holds
no financial truth and must not be required for transactional correctness.

Preserving a sale does not mean allowing anonymous or unverified writes into the
canonical ledger. Expired/revoked credentials require an authenticated recovery
path and an auditable exception process; its detailed policy remains open.

## Workstreams and acceptance evidence

| Workstream | Proposed work | Required evidence before completion |
|---|---|---|
| Test baseline | Restore formatting/lint gates; include all TS suites; add isolated PostgreSQL integration tests | CI executes, rather than skips, relevant tests; money-path failures make CI red |
| Device journal | Transactional SQLite; atomic migration of existing pending data; storage failure UI | Crash/force-close/reboot tests at commit boundaries; no acknowledged sale lost; interrupted migration resumes safely |
| Operation delivery | Durable receipts for every write type; bounded batches; dependencies; backoff/jitter; structured error classes | Lost responses, duplicate and concurrent delivery produce one canonical effect; unrelated operations continue past quarantined items |
| Authorization | Enforce permissions on normal and sync routes; replace distributed PIN hashes; define offline authority | Equivalent route authorization tests; rejected authority cannot finalize refunds or inventory movements |
| Reconciliation | Explicit pending, committed, and needs-review states; corrections recorded as new events | Competing receives/counts/refunds resolve once with visible explanations and retained history |
| Offline coverage | Add missing transfer-send, goods-receiving, stock-count capture and dependency handling | Each required workflow survives a 60-minute outage and reconnect without silent loss |
| Capacity | Measure requests, DB work, connections, payloads, storage growth, and Redis commands | Representative peak and reconnect tests; measured saturation points and documented operating headroom |
| Operations | Migration coordination, backups, restore drills, alerts, release gates, OTA compatibility | Recover into an isolated environment; signed APK and OTA update/rollback tests; documented operator actions |

This is sequencing and acceptance scope, not a granular implementation plan.
Contract/security decisions should precede finalizing journal and sync schemas.

## Offline conflict policy — proposed, awaiting review

| Scenario | Proposed behavior |
|---|---|
| Completed sale uses stale prices/promotions or exceeds known stock | Retain the captured sale and its original evidence; flag discrepancies for authorized reconciliation rather than silently rewriting the receipt |
| Network fails after server commit | Retry the same key and retrieve the original result |
| Cash refund during an outage | Permit physical cash return under the offline authority policy; retain a durable linked cash-disbursement record and show reconciliation status separately; validate entitlement and inventory effects on reconnect |
| Two devices receive the same transfer | First valid canonical receipt wins; later request needs review; retain both capture records |
| Offline transfer send/goods receipt | Preserve the physical-operation record; final stock effects remain provisional; show pending quantities separately |
| Stock count overlaps sales or transfers | Preserve count time, baseline/version and movements; do not blindly overwrite current stock; reconcile or request review |
| A required parent operation has not synchronized | Retain dependency and wait/retry; do not substitute an unrelated server ID |
| Invalid or unsupported payload | Preserve evidence in a visible needs-review state; block dependent operations, not the entire unrelated queue |
| Local durable storage cannot commit | Do not acknowledge completion; show a persistent actionable error |

Approved business decision: cashiers must be able to physically return cash
during an outage. This does not approve unrestricted refunds or the controls below.

Proposed implementation contract for review:

- Journal refund intent before instructing the cashier to hand over cash. Record
  payout confirmation as a separate durable transition linked to the original
  sale, refund, outlet, device, cashier/approver, amount, reason, and shift.
- A crash between physical handover and confirmation is inherently ambiguous:
  surface an unfinished payout for human reconciliation; never instruct an
  automatic second cash payment. A SQLite commit cannot atomically prove a
  physical handover.
- Confirmed payouts reduce local expected cash immediately and remain in shift
  history, even if server eligibility checks later identify a conflict.
- Replay of the same operation key produces one canonical cash movement.
  Separate refund keys for the same sale are a business conflict, not transport
  duplicates. Disconnected devices cannot guarantee global refund exclusivity.
- On reconnect, accept authentic cash-movement evidence into reconciliation;
  check original sale, prior refunds, authority, amount, and returned goods.
  Conflicts remain visible to an authorized reviewer. Never silently erase cash
  already returned, restore stock twice, or retrospectively alter the receipt.
- Test lost acknowledgements, repeat submissions, competing device refunds,
  payout-confirmation crash boundaries, and shift close before refund sync.

Approved authority: cashiers with refund permission may perform offline cash
refunds independently, without manager approval. Cashier role alone does not
grant that permission. Both direct and sync routes must enforce the policy.

Approved sale eligibility: the original sale must be available in the device's
local records. Check its amount and locally known prior refunds, including queued
refunds, before permitting payout. A receipt cannot substitute for a missing
local sale record while offline. Local records cannot establish that another
disconnected device has not refunded the same sale; server reconciliation is
still required. Supporting retention and cache completeness must be designed.

Approved outlet scope: cross-outlet refunds are permitted online after server
validation of the original sale and refund history. Offline refunds are
same-outlet only and still require the local original-sale record. A cached
cross-outlet sale does not bypass this restriction. The UI must explain that
cross-outlet processing is waiting for connectivity rather than prohibited by
company policy.

Proposed supporting design: retain both the original selling outlet and the
refunding outlet on the canonical refund; attribute the cash payout to the
refunding outlet's shift. Validate concurrent online refund entitlement
atomically. Returned-stock destination, cross-outlet accounting/reporting, and
handling of a sale with a potentially outstanding offline refund remain design
details to resolve; an online request alone cannot expose unsynchronized refunds
held on a disconnected device.

MODAL is Rp1,100,000 for outlet operations including refunds; insufficient cash
uses the agreed transfer flow, not an invented per-refund ceiling. Staff authenticate
online at shift start and retain offline permissions for that shift. Technical
verification and revocation reconciliation remain design work. No
PIN-hash distribution or cached-permission mechanism is approved by this business
decision. Later revocation/conflicts must not erase an actual recorded payout.

Also unresolved: whether non-return pending incoming stock is sellable; offline
revocation reconciliation; count conflict authority; device replacement
and recovery from an unsynchronized device.

## Scent exchanges — confirmed scope, proposed design

Approved post-exchange refund policy: an entire-sale refund requested after an
exchange requires SPV review, including within the standard five-day window.
The company describes exchanges as warranty service; absence of historical
post-exchange refunds does not establish a prohibition. Do not implement an
automatic refund entitlement or amount from that absence.

Proposed review presentation: original sale, exchange/component lineage,
upgrade payments, downgrade payouts and still-pending obligations, previous
approvals, and current returned-product condition.

Approved full-sale refund calculation after exchanges:

`original payment + upgrade payments received - downgrade amounts already returned`

Use actual settled amounts across the linked exchange history, not list prices,
uncollected upgrade charges, or merely scheduled downgrade transfers. This is
the remaining net payment, not a new partial-refund entitlement. Example:
Rp200,000 original payment + Rp50,000 collected upgrade - Rp30,000 paid downgrade
= Rp220,000 full-sale refund, subject to SPV approval and other return rules.

Approved approval process: the handling outlet's SPV reviews the request;
approval can occur by phone/message and be recorded by the cashier. Capture the
same external-approval audit details as late returns. Ordinary refund permission
alone does not bypass review. This does not waive seal or connectivity rules.

Proposed settlement safeguards: reconcile outstanding downgrade obligations
before final payout. A pending downgrade is not yet subtracted as paid, but must
not also be paid separately after the full refund includes that amount. Cancel
or supersede an unpaid obligation with an audited link only once its payment
status is confirmed; resolve an in-flight/uncertain bank transfer before payout.
Finalization must recheck settlement state and prevent duplicate refund payouts.
Offline requests lacking complete verified exchange/settlement history must wait
for reconciliation rather than guess the net amount; exact offline handling of
such requests remains to be designed.

Acceptance cases: multiple upgrades/downgrades; unpaid upgrade excluded; settled
downgrade deducted; pending downgrade cannot cause two payments; transfer confirmed
during review triggers recalculation; repeated finalization pays once; missing
SPV approval prevents ordinary finalization. The monetary refund calculation
excludes redeemed loyalty points: restore those as points separately. Loyalty
tender allocation across exchange chains, other non-cash tender valuation,
and handling of previously partially settled full-refund payouts remain detailed
settlement design work, not permission to pay the calculated amount repeatedly.

Confirmed business behavior: full-sale refunds; full or selected-item scent
exchanges; upgrades collect the difference and downgrades return the difference.
Approved upgrade collection policy: offer the POS's normally accepted payment
methods for the difference; do not force the original payment method. Record the
upgrade as its own linked payment with actual method, amount and settlement
status. A selected payment method is not confirmation that money was received.
Offline exchange eligibility does not make a network-dependent payment method
available: use that method's supported verification flow, and preserve pending
or uncertain status where confirmation is unavailable. Approved upgrade handover
policy: hand over the replacement only after payment of the extra amount is
confirmed. Cash receipt may be confirmed during an otherwise eligible offline
exchange. A payment requiring online verification must wait for confirmation
before replacement handover. An uncertain payment stays pending and must be
reconciled before collecting again; do not treat a timeout as failed payment.
Exact payment-method verification mechanisms remain design work. Planned checks
include withholding handover for pending/uncertain payment and permitting it
after confirmed cash receipt in an eligible offline exchange.
Acceptance coverage should include
different original/upgrade methods, pending verification and retry without double
collection. Additional payment integrations and split payments are not implied.
Latest clarification: exchange selection operates at main-bottle/component level
(110/120 ml or 10 ml). Do not replace the whole bundle when one bottle is selected;
do not include or decrement inventory for a new tester. All-item exchanges can
still be represented by selecting the eligible main components. Preserve the
unexchanged components and their remaining entitlement.
The user explicitly approved the same authority and connectivity rules for
exchanges: independent execution by cashiers with refund permission; a local
same-outlet original sale for offline exchanges; connectivity for cross-outlet
exchanges. Local checks must include queued refunds and exchanges against the
same item entitlement. This does not eliminate unseen conflicts on other devices.

Proposed design: record an exchange linked to the original sale and eligible
items, preserving original receipts rather than editing completed sale lines.
An exchange links returned quantities, replacement quantities, return credit,
replacement charges, and any payment/payout under one operation identity. Record
each actual money movement durably; retry cannot charge, pay, or move stock twice.
Maintain item lineage through repeated exchanges so a subsequent refund/exchange
cannot reuse already-returned entitlement.

The displayed difference is replacement charge minus return credit. The approved
return-credit basis is the original amount actually paid after discounts.
Replacement scents use today's selling prices and eligible current promotions.
Confirmed pricing basis: each main bottle has its own selling price. Approved
allocation: keep item-specific discounts with their item and allocate
any order-wide discount proportionally across eligible items' values after
item-specific discounts. Proposed implementation: persist the allocation at sale time and distribute
rounding remainders deterministically so later exchange credit conserves the
actual paid total. Promotion-specific eligibility, bundles/rewards, and tender
handling still require specification. Approved example: Rp180,000 large bottle
+ Rp20,000 small bottle with Rp20,000 transaction discount yields Rp162,000 and
Rp18,000 net item values. Acceptance cases should cover partial quantities,
item-specific plus transaction discounts, rounding remainders, and repeated
exchanges without reusing or exceeding original allocated credit.
Preserve original
discount allocations so selected-item exchanges do not credit undiscounted list
prices. Order-level discounts need deterministic per-item allocation; rounding
must conserve the original total across quantities and repeated exchanges. Tax,
fees and remaining bundle/reward allocation details remain to be specified.
Redeemed-point allocation follows the approved proportional policy below.
This decision does not authorize automatically repricing the items
the customer keeps. Record the replacement price/promotion evaluation separately
from original return-credit allocations. The precise exchange basket used for
promotion qualification (including spend thresholds, codes and rewards) still
needs specification; eligibility is not an unconditional promotion grant.
Approved returned-goods defaults differ by workflow: exchange returns are held
for inspection outside sellable stock; refund returns default to sellable with a
cashier-selectable inspection exception. Both refunds and exchanges normally
qualify within five days from purchase date; later requests require approval
from the SPV of the outlet handling the return. This includes cross-outlet
returns; original-selling-outlet SPV approval is not required by this policy.
Approval may be obtained by phone/message and recorded by the cashier.
Do not automatically reject a request solely because the standard window passed.
For a full-sale refund, both the large 110/120 ml bottle and the 10 ml bottle
must remain sealed. For an exchange, only the selected bottle(s) must remain
sealed; an opened bottle the customer keeps does not disqualify the exchange.
Opening and using the 2 ml tester is permitted for either workflow.
Proposed eligibility capture checks seals on the returned main components and identifies
the tester by component role, not merely whether any item was opened. Do not
reject eligible returns solely for an opened tester. Customers may keep the
tester; do not require its physical return or credit its quantity back to stock
when it remains with the customer. The tester is complimentary, as explicitly
confirmed: no monetary deduction for keeping it and no extra refund credit for
its retail or inventory cost. Exchanges include no new tester. Proposed
acceptance checks: retained tester changes neither main-item net credit nor
full-sale refund entitlement, and a refund does not restore a tester that was
not physically returned. Inventory cost reporting remains separate from
customer settlement.
The user explicitly clarified the exchange seal requirement to selected bottles
only. Acceptance cases must include exchanging a sealed large bottle while
keeping an opened 10 ml bottle, and vice versa; selecting an opened bottle for
exchange remains ineligible. Full-sale refund seal requirements are unchanged.
Proposed exception record: handling outlet and its SPV identity, approval channel (phone/message), approval
time, reason, and the recording cashier, linked to the refund/exchange. Identify
it as cashier-recorded external approval, not an authenticated in-app action by
the SPV. Preserve audit history and any later corrections. Evidence attachment
requirements and follow-up verification remain unspecified; do not assume a
screenshot is mandatory. The approval must have occurred before relying on it;
permission to record approval is not permission to invent it or approve on the
SPV's behalf. Existing outlet/connectivity restrictions remain in force.
Preserve original selling outlet separately from handling/approval outlet.
Acceptance cases should verify that a cross-outlet late return uses the handling
outlet's SPV and remains subject to online validation; external approval does not
bypass cross-outlet connectivity, seal, or stock-release rules.

Approved deadline calculation: purchase date plus five calendar days, through
outlet closing time on that day. A Monday purchase qualifies through Saturday
closing regardless of Monday's purchase time. After that boundary, request
handling-outlet SPV approval; do not categorically refuse the return.
An exchange does not reset this deadline. Preserve the original sale's purchase
date through the replacement-item lineage rather than using exchange creation
time as a new purchase date. Example: Monday purchase exchanged Friday still
has a Saturday-closing standard deadline, not the following Wednesday. A late
exchange approved by an SPV does not create a fresh five-day window; further
late requests remain subject to approval. Monetary entitlement follows the
approved remaining-net-payment formula above, separately from the timing rule.
Acceptance cases include repeated exchanges, cross-outlet exchanges, and delayed
sync preserving the original purchase-date deadline.
Proposed implementation: use configured outlet business calendars rather than
UTC date truncation or a 120-hour duration. Exact schedule/timezone ownership for
cross-outlet returns, overnight closing and holiday closures still needs design.
Preserve the policy version and locally captured request time so delayed sync
does not by itself make an on-time offline return late. Device-clock trust and
exception review remain part of the offline authority design.
Voluntarily returned testers have no refund value and remain outside sellable
stock until inspected, as confirmed in the September 15 clarification.
The general sellable-refund default must not automatically restock a used tester
as sellable; its treatment requires a distinct component rule. Inspection does not automatically mean
waste; other inspection outcomes require definition. Release to sellable stock
requires inventory-management permission, as approved by the user.

Approved payout policy for entire-sale refunds and exchange downgrades: cash is available during outlet opening hours;
transfer is available during office working hours. It is not restricted to the
original payment method. Do not assume office and outlet schedules coincide.

Proposed supporting design: retain the amount owed and selected payout method
separately from actual settlement. A requested or scheduled transfer is pending,
not money returned. Record confirmed settlement with its reference, amount,
operator and timestamp. Any method change must account for an in-flight or
uncertain transfer before permitting cash payout, to avoid paying twice.
Office staff execute transfers manually through company banking tools. The
application does not initiate bank payments. Exact application permission mapping,
proof validation and schedule configuration remain unresolved.
Manual execution is not proof of payment:
an unconfirmed or uncertain transfer must remain visibly unresolved.

Approved transfer workflow, applying to both refunds and exchange downgrades:
transfer requests may be recorded outside office working hours and queued with
the customer-facing status "pending office processing". Do not promise immediate
payment or mark a queued request paid. Manual processing follows the approved
office-hours policy; exact schedules, holidays and any processing-time commitment
remain to be defined. Planned checks include out-of-hours request capture,
visible pending status and no automatic paid status when office hours begin.

Confirmed existing business practice: when the outlet lacks sufficient cash for
a refund, staff offer a pending bank transfer with the customer's agreement.
Record the monetary obligation as unpaid until transfer confirmation; choosing
transfer does not mean the customer has received payment. Outside office hours,
the request follows the "pending office processing" flow above. This confirms
the company's operating practice, not that the application already implements it.
Planned checks include insufficient outlet cash, customer agreement to transfer,
and no cash-disbursement or paid status recorded merely from selecting transfer.
Partial cash plus transfer settlement is not implied by this decision.

Approved downgrade handover policy: once the exchange is accepted under the
applicable exchange eligibility and connectivity rules, the replacement may be
handed over while the customer-agreed bank-transfer difference remains pending.
Document that outstanding amount on the return receipt. Record replacement
handover separately from payout confirmation; handing over goods must not mark
the transfer paid or remove the monetary obligation. Existing offline eligibility
and returned-stock restrictions still apply. Planned checks include accepted
downgrade handover with pending transfer, an accurate receipt, and later payment
confirmation without duplicate payout or duplicate handover processing.

Approved customer receipt requirement: the return receipt must show the amount
still owed, payout method and pending payout status, providing the customer proof
of the outstanding obligation. Apply this to pending refunds and exchange
downgrade payouts. Use "pending office processing" where applicable; issuing a
receipt must not mark the payout paid. Planned checks should verify receipt
values match the linked return's settlement record, including an out-of-hours
transfer and a transfer chosen because the outlet lacks cash. This is a planned
requirement, not an existing application capability confirmed by this decision.

For each request, the cashier records the amount owed and the customer's confirmed bank details.
Authorized office finance staff execute the transfer manually and record its
reference, time and proof. The payout remains pending until payment is confirmed;
an uncertain result must remain unresolved rather than be marked paid.
Switching a pending transfer to cash requires finance to confirm that the transfer
has not already been sent. Preserve the confirming finance identity and audit
trail alongside the payment record.

Proposed implementation must coordinate that method change with the transfer
workflow so a transfer cannot subsequently be sent against the same payable
while the outlet pays cash. Finance confirmation and a completed cash payout are
separate events. Planned checks include unauthorized confirmation rejection,
missing transfer evidence, uncertain transfer blocking cash substitution,
confirmed-unsent transfer switching to cash, and concurrent/retried actions
without duplicate payout. These are planning requirements and proposed checks,
not an implemented workflow or authorization to execute an actual payment.

Approved offline exchange pricing: use the latest successfully synced catalog
and locally verifiable promotion rules, accepting that prices may have changed
since synchronization. Retain the quoted amount after reconnect. Proposed
supporting design: show snapshot age, retain price/rule evidence with the exchange,
and flag discrepancies without silently changing money already collected/paid.
Promotions requiring unavailable server checks (such as global usage limits)
require connectivity rather than being asserted eligible offline. This is
an approved offline exception to the current-pricing policy, not proof
that a cached price is today's price. Maximum snapshot age and clock handling
still require design.
Approved disposition policy: exchange returns always await inspection before
becoming sellable. Refund returns default to sellable; the cashier may mark an
exception to hold for inspection. Proposed supporting design: record condition
and disposition per returned line, preserve actor/reason/time for changes, and
prevent retry/reconciliation from adding returned quantities twice. Physical
classification and server acceptance are separate: the sellable default describes
condition, not immediate availability. An offline return awaiting acceptance
contributes no sellable quantity.

Approved inspection-release authority: users with inventory-management permission
may release inspected exchange returns and exceptional refund returns into
sellable stock. Refund permission alone is insufficient. Enforce this on the
server and any eventual offline command path, and record who performed release.
Offline release itself has not been approved.

Approved restriction: do not permit resale of offline returned stock until the
server accepts the return and its inventory effects. This replaces the earlier
immediate-resale proposal. Offline cash payouts remain supported; payout status,
return acceptance, and product condition are separate states.

Proposed implementation invariant: sellable returned quantity requires both
server acceptance and sellable disposition. Ordinary refund returns already
default to that disposition; exchange returns and flagged refund exceptions need
authorized inspection release as well. Reconnect, request submission, and a
transport acknowledgement without business acceptance do not release stock.
Rejected/conflicting returns remain unavailable pending resolution while actual
cash payouts remain in the audit/cash ledger. Lost responses and retries must
neither release quantities early nor add them twice. Reconcile accepted quantities
without double-counting local records and refreshed server snapshots.

Acceptance tests: refund offline -> no added sellable quantity; reconnect with
unresolved/rejected return -> still unavailable; accepted sellable return -> one
stock credit; repeated acknowledgement/snapshot refresh -> no extra credit;
accepted inspection-held return -> unavailable until authorized release. Existing
sellable inventory may still be sold; this restriction does not freeze the SKU.
No immediate resale policy for other pending inventory is implied.
Approved exchange connectivity restriction: exchanges involving previously
redeemed points require connectivity to verify the shared loyalty record before
carrying or restoring those points. Exchanges originally paid entirely with money
retain the previously approved offline flow, subject to its existing eligibility
and payment-confirmation rules. Merely earning points on a money-paid purchase
does not trigger this restriction. Eligible offline full refunds may still pay
the monetary portion and queue point restoration/adjustments as agreed; this
exchange restriction does not remove that refund capability.
Planned checks include blocking offline exchanges involving redeemed points,
allowing otherwise eligible money-paid offline exchanges, and preserving offline
refund cash payout with pending point restoration. These are planned requirements,
not verified current application behavior.

Approved offline loyalty policy: capture earnings from offline purchases as
pending; make them spendable only after successful synchronization and server
acceptance. Point redemption requires connectivity and server verification of
the available balance across outlets. A cached balance does not authorize offline
redemption. Proposed implementation must atomically validate and consume points
so concurrent online requests cannot spend the same balance twice.

Approved offline earning-rule selection: use the earning rules last successfully
synchronized to the device when the offline purchase occurs. Preserve those rules
with the sale; a head-office change during the outage must not reprice its point
earnings when it synchronizes. Proposed implementation should retain the rule
version and calculation inputs for server verification and repeatable processing.
Planned checks include a rule change during an outage, unchanged earnings when
the recorded sale synchronizes, and retries without duplicate awards. Behavior
when no earning rules have ever synchronized follows the September 15 pending
calculation policy above.

Eligible offline refunds may still pay the approved monetary amount in cash.
Queue redeemed-point restoration and earned-point adjustments for synchronization
with the linked refund; pending restoration is not spendable. Existing same-outlet,
locally verified sale and refund eligibility restrictions continue to apply.
Preserve actual cash payout evidence independently of pending loyalty processing.
Planned checks: offline sale earns pending points, acceptance makes them available
once, offline redemption is unavailable, concurrent online redemption cannot
overspend, and offline refund retries neither duplicate cash payouts nor point
restoration/adjustments. Approved queued-restoration expiry: points restored from
an offline refund begin their fresh validity when successful synchronization
makes them available, not when the offline refund was captured. Use the expiry
setting active at that restoration time, consistent with the restoration policy
below. Persist the first successful restoration time and expiry; retries must
not restart the validity period. Planned verification includes delayed
synchronization and a setting change during the outage, without losing usable
validity to the outage or extending it through retries.

Approved customer redemption policy: do not require a one-time code or proof of
ownership of the registered phone number before spending points. Customers may
use a relative's registered number. This supersedes the proposed one-time-code
verification requirement. Phone lookup selects the loyalty account; it is not
evidence that the person present owns the number. Keep redemption linked to that
selected account, sale and cashier for traceability. Existing online balance
verification and atomic redemption requirements remain in effect; they do not
require customer phone verification. Planned checks include redemption using a
relative's account without an OTP step and enforcement of available-point limits.

Approved return-account policy: restore redeemed points and apply earned-point
adjustments to the same loyalty account used for the original purchase, even if
a different person handles the return or the purchase used a relative's account.
Resolve that account from the linked original sale and any approved account
correction described below; selecting another customer during the return must
not redirect these entries. Planned checks include a
relative handling the return, another customer selected in the POS, and queued
restoration/adjustments retaining the original account after synchronization
when no approved correction exists.

Approved guest-sale loyalty attachment: a TL may attach a loyalty account to a
verified guest sale online within the sale's same still-open shift, with a
recorded reason. Award points once using the sale's original earning rules.
Requests after that shift closes require authorized head-office review; do not
silently reopen the shift or apply current earning rules to the earlier sale.
Preserve the original guest-sale record and the attachment's account, authorizing
identity, reason and time. Proposed implementation should atomically check shift
state and prior attachment/award before applying the change. Planned checks
include eligible attachment, missing reason, offline rejection, shift closing
before submission, head-office routing after closure, and retries/concurrent
requests without duplicate awards. This permission does not require registration
for ordinary guest checkout. Handling unavailable historical earning rules remains
design work rather than permission to invent an award.
Approved attachment after returns: calculate the award from remaining net
spending using the original earning rules and linked refund/exchange history.
A fully refunded sale earns no points. For an exchanged sale, account for
confirmed upgrade payments and downgrade payouts rather than awarding against
the original sale amount alone. Existing attachment authority and shift rules
still apply. Planned checks include a fully refunded guest sale with zero award,
an exchanged guest sale with confirmed upgrade/downgrade settlements, and retry
without duplicate earnings.
Approved attachment with unresolved payout: an otherwise authorized guest-sale
account attachment may proceed when a refund or downgrade transfer is unpaid,
but its points award remains pending and unspendable until the payout is resolved.
Resolve the settlement and calculate the final entitlement from the linked history
before releasing any award; resolution does not guarantee a positive award.
In particular, a fully refunded sale still earns zero points. Keep account
attachment, payout confirmation and points availability as distinct states.
Planned checks include successful attachment with pending transfer, blocked use
of the pending award, final net-spending calculation after resolution, and retry
without duplicate release. This policy does not mark an uncertain transfer paid.

Approved paid-sale customer correction policy: a TL may correct the linked
customer account online during the original sale's still-open shift, with a
recorded reason, when no points were redeemed
on the sale and any points earned from it remain unused. Corrections involving
redeemed points or already-used earned points require review by authorized
head-office staff; TL authority alone is insufficient. This is a customer-link
correction, not automatic permission to void or reprice the paid sale.
Proposed implementation should preserve the original and corrected account links,
authorizing identity, reason and time, and atomically recheck point usage before
applying a correction. Planned checks include eligible TL correction, required
reason, offline rejection, head-office routing for used/redeemed points, and a
concurrent redemption preventing an otherwise eligible correction.
Approved correction allocation: move the sale's unused earned points to the
corrected customer account without resetting their recorded expiry. Preserve the
correction history rather than treating the move as new earnings or a refund
restoration with fresh validity. Proposed implementation should link both sides
of the move and apply them atomically. Planned checks include removal from the
previous account, credit to the corrected account with unchanged expiry, and
retry without duplicate credit or expiry extension.
Approved subsequent-return policy: after an approved customer-account correction,
later refunds and exchanges use the corrected account for loyalty adjustments.
Retain the original account and correction history in the audit trail. This is
an explicit exception to the original-account rule, not permission for ordinary
customer selection to redirect return entries. Planned checks include a refund
and an exchange after correction using the corrected account without duplicate
adjustments to the original account. Reconciliation of a pending offline return
that overlaps an account correction remains technical design work; preserve its
capture history rather than silently rewriting historical loyalty entries.

Approved redemption order: consume available, unexpired points with the earliest
recorded expiry first. Preserve which earning/restoration records supplied each
redemption so later returns can be traced without changing unrelated points.
Proposed implementation should use a deterministic tie-breaker for equal expiry
times. Planned checks include different expiry dates, partial consumption of a
points record, exclusion of expired/pending points, and retry without consuming
points twice. The precise tie-breaker remains an implementation detail.

Confirmed loyalty expiry: the points-expiry period is configurable. This
supersedes the earlier fixed one-year statement; no default period is confirmed.
Approved change policy: expiry-setting changes apply to newly earned points;
existing points retain their recorded expiry. Preserve the applicable expiry
with each earning record rather than recalculating existing expiry from the latest
setting. Planned verification should cover both shortening and extending the
configured period without altering existing points. Only authorized head-office
administrators may change loyalty settings. Outlet cashier, TL or SPV authority
alone does not grant this access. Exact application role/permission mapping remains
implementation design work. Proposed controls: enforce the permission on the
server and audit the actor, time, and previous/new setting values. Planned checks
should cover authorized changes and rejection of unauthorized changes.
Approved earned-points expiry anchor: start the validity period when successful
synchronization and server acceptance make the points available. Use the expiry
duration captured with the purchase, including the last synchronized expiry
duration for an offline purchase; do not substitute a later head-office setting
when the sale synchronizes. Preserve the first availability time, captured
duration and resulting expiry. Retries must not restart the validity period.
Planned checks include delayed synchronization, a settings change between purchase
and acceptance, and replay without duplicate earnings or expiry extension.
Exact calendar-boundary handling remains to be specified.
Approved restoration expiry: redeemed points restored after a refund receive a
fresh validity period starting at restoration, using the expiry setting active
on that date. For an offline refund, restoration occurs when successful
synchronization makes the restored points available. Preserve that setting and resulting expiry with the restoration
record. Later setting changes must not alter that recorded expiry, and retries
must not restart the validity period. Planned verification includes restoration
after a setting change and retry without duplicate restoration or expiry extension.

Approved earned-loyalty policy: calculate the entitlement from final net spending
across the linked purchase/exchange/refund history and record the difference from
points already awarded or reversed. Do not award the replacement sale's points
again as an independent purchase. Preserve auditable adjustments and ensure retry
does not duplicate them. If earned points to reverse have already been spent,
the refund proceeds normally without reducing its cash amount. Record the
outstanding points adjustment and offset it against future point earnings.
Balance presentation and the adjustment's storage mechanics remain design work;
this policy does not authorize collecting a cash debt from the customer.
Approved redeemed-loyalty refund policy: for a purchase paid partly with points,
return the monetary portion through the approved cash/manual-transfer flow and
restore the points used as payment. Record restoration separately from reversal
of points earned on that purchase and from any outstanding earned-point
adjustment. Do not convert redeemed points into cash or restore them twice on
retry. Restoration expiry follows the approved rule above.
Approved outstanding-adjustment policy: restored redeemed points remain available
for use once restoration is accepted, even when the customer has an outstanding
earned-point adjustment. Only future newly earned points offset that adjustment;
do not consume restored points to settle it. Keep restored available points and
the outstanding adjustment distinct in the ledger so a net balance does not
incorrectly block redemption. Existing expiry and online-redemption rules still
apply. Planned checks include accepted restoration remaining redeemable despite
an outstanding adjustment, new earnings offsetting that adjustment, any remaining
new earnings becoming available, and retry without duplicate offsets.

Approved redeemed-loyalty exchange policy: carry the exchanged item's allocated
redeemed-points value into the replacement, then collect any upgrade difference.
For a downgrade, return any excess monetary portion through the approved
cash/manual-transfer flow and restore any excess redeemed points as points.
Do not convert points into cash. Keep this tender carryover/restoration separate
from adjustments to points earned on the purchase, and preserve the linked
exchange history to prevent duplicate credit or restoration on retry.
Approved downgrade calculation: apply the carried redeemed-points value to the
replacement first, then use the carried monetary portion for the remaining price.
Return unused money through cash/manual transfer and restore unused points as
points. Example: an item paid with Rp80,000 plus Rp20,000 worth of points exchanged
for a Rp70,000 replacement carries Rp20,000 in points and Rp50,000 in money into
the replacement, leaving Rp30,000 to return. If the replacement costs less than
the carried points value, restore the excess points and return the unused monetary
portion; do not convert that excess points value into cash.
Approved checkout allocation: allocate redeemed points proportionally across
eligible items using their values after discounts. Preserve each item's allocated
points share with the sale for later selected-item exchanges; do not recalculate
the original shares using current prices or only the items being exchanged.
The complimentary zero-price tester receives no share. Allocation must conserve
the total redeemed points, with deterministic handling of rounding remainders.
Exact indivisible-point rounding and eligibility rules remain design details.
Planned checks include unequal item values, item and order discounts, the
complimentary tester, and a selected-item exchange leaving retained items' shares
unchanged. This calculation does
not approve an exception to online point-redemption verification.
Planned checks include the approved example, a replacement priced below the
carried points value, and selected-item carryover without affecting
retained items, upgrade collection, downgrade with separate money/points returns,
and repeated synchronization without duplicate credits.
Exact earning rates, rounding and settlement timing remain design decisions.
Acceptance cases include equal-value exchange without duplicate points, upgrade
and downgrade adjustments, refund reversal, and repeated synchronization without
duplicate adjustments. Also cover a refund after earned points were spent,
unchanged cash refund, future earnings offsetting the outstanding adjustment,
and retry without applying that offset twice. Cover mixed money/points refunds
with separate monetary payout, redeemed-point restoration and earned-point
reversal, including retries that neither pay nor restore twice. These are planned checks, not
implemented behavior.

Approved unfinished-exchange cancellation policy: before replacement handover,
the cashier may cancel directly if no money, points or goods have moved. Once
any such movement has occurred, use an audited recovery flow that accounts for
those movements before closing the exchange. Receiving the customer's returned
bottle also counts as goods movement; absence of replacement handover alone is
not sufficient for direct cancellation. Preserve captured movement evidence and
linked transaction history rather than deleting or pretending to reverse a
physical payment or handover. An uncertain movement must be reconciled before
treating the exchange as having no movements.
Planned checks include direct cancellation without movements and recovery routing
after payment, points movement, returned-goods receipt or uncertain payment.
Approved recovery authority: require TL authorization inside the application for
this audited exchange recovery. If a bank transfer is uncertain, finance must
confirm its outcome before money is returned. TL authorization does not substitute
for finance's transfer confirmation or itself prove a payment or goods movement.
Preserve the authorizing TL identity and finance confirmation in the recovery
audit trail. Planned checks include rejection without TL authorization, an
uncertain transfer preventing money return until finance confirmation, and
preservation of movement evidence throughout recovery.
Approved recovery connectivity: require connectivity to finalize exchange
recovery so payment, points and stock records can be checked together. During an
outage, keep the exchange pending recovery and preserve all recorded movements.
Reconnection alone does not finalize recovery: TL authorization, any required
finance confirmation and reconciliation must still be satisfied. Planned checks
include offline finalization rejection, durable pending recovery across restart,
and retry after an uncertain server response without duplicate settlement or
inventory/loyalty adjustments. This restriction concerns exchange recovery;
previously approved eligible offline refunds and exchanges retain their rules.
Detailed settlement steps and handling of technical reservations remain to be
designed; this decision does not grant new refund or paid-sale void powers.

Subsequent decisions include remaining bundle/reward rules, upgrade payment verification,
and post-exchange refund review/settlement details. Physical
replacement handover, returned-stock disposition and offline inventory checks
must also be reconciled with the provisional inventory model.

Acceptance coverage to add after policy approval: full and selected-item
exchanges; upgrades, downgrades, and equal-price exchanges; repeated/concurrent
requests; exchange followed by refund; returned-stock disposition; discounts,
taxes, rounding and loyalty; crash/retry around collection and cash payout.

## POS customer verification — requested feature, planning only

User-requested behavior: phone/WhatsApp-number search -> matching registered customers
-> customer details and historical transactions -> original-sale verification.
Receipt-free verification does not waive seal, deadline/approval, permission,
outlet/connectivity or remaining entitlement rules. A matching customer alone is
not a verified sale; the cashier must select the recorded original transaction.

Current-code seams inspected: `apps/pos/src/cashier/CustomerPicker.tsx` already
searches names/phones and selects a customer for checkout, but does not open a
customer history/detail view. `OrderHistoryPanel.tsx` is a separate sale-history
view. Backend `read.Repo.CustomerLookup` supports on-demand lookup; `Orders`
supports customer filtering while retaining outlet scope. Customer-wide history
for cross-outlet verification needs a deliberately authorized server path;
do not remove general outlet isolation or grant cashier admin access.

Proposed details view: customer identity/contact summary, paginated transaction
history with date, original outlet, order reference, purchased components and net
amount paid; prior refunds/exchanges, pending operations and remaining entitlement
on transaction detail. Show eligibility explanations and the late-return approval
path. Offer explicit refund/exchange entry points to permitted staff. Preserve
the current cart and separate opening a profile from attaching it to checkout.

Online: retrieve authorized history on demand, including the cross-outlet sale
verification needed by policy. Offline: use locally stored same-outlet sale
records and visibly identify limited history; no local match is not proof of no
purchase. A cached customer profile without its original sale cannot authorize
an offline refund/exchange. Cache retention/completeness must support the chosen
workflow without syncing all company history onto every POS.

Acceptance coverage: matching customers and explicit selection, missing receipt,
no matches, incomplete offline cache, same-outlet offline eligibility, cross-outlet
online verification and offline restriction, pending/prior returns, pagination,
permission denial, and entering/leaving history without changing the active cart.
Approved phone policy: accept international and local numbers without requiring
Indonesian prefixes. Preserve the supplied number; do not guess a country or
silently prepend/replace a country code. Proposed search handling may ignore
presentation separators where unambiguous; country-aware matching requires
explicit country context. Do not conflate numbers from different countries or
merge customer records solely on a normalized match. Rank exact matches first
and let the cashier select the customer and specific sale. Searching a WhatsApp
number does not require a WhatsApp integration or sending a message.

Approved guest-sale policy: checkout may complete without a phone number or
registered customer. Keep the transaction independently addressable by its order
reference; customer history cannot be its only retrieval path. Approved guest
return flow: search by receipt/order reference, or narrow by date, selling outlet,
items and total when the reference is unavailable, then explicitly verify the
specific recorded sale. The user approved this fallback for guests without a
receipt. No match does not authorize inventing a sale or automatically selecting
a similar one. Multiple plausible matches require cashier verification rather
than automatic selection; a customer phone number is not required for this flow.
Offline guest returns still require the original same-outlet sale stored locally;
cross-outlet returns still require connectivity. Lack of a phone number alone
must not block sale capture. Later customer linking follows the approved guest
attachment and account-correction policies; technical implementation remains design
detail. Existing seal, time-window/SPV approval, refund permission and stock
release policies continue to apply; the lookup fallback creates no new entitlement
exception. Proposed audit evidence includes the selected order and recording
cashier, without collecting unnecessary customer data.

Additional acceptance cases: foreign-number lookup, no forced Indonesian prefix,
ambiguous local numbers not merged, guest checkout without customer/phone, and
guest transaction retrieval independent of the customer picker. Existing code
must be audited for customer-required checkout gates before implementation;
policy approval is not a claim that guest checkout already works end to end.

## Capacity: production requirements first

Current POS explicitly uses a 12-second interval. With an empty queue there are
two background calls per interval; a batch is sent only when pending work exists.
At 25 devices, 12–14 hours/day, and 30 days, uninterrupted foreground polling
projects to 5.4–6.3 million calls/month before business and backoffice requests.
This is a model, not observed billed usage; timer suspension and outages affect it.

Select refresh latency from operational requirements. Then evaluate combined
checks, conditional responses, reference caching, visibility-aware refresh,
batching, and bounded retry schedules. Do not delay transaction delivery to save
background-request allowance. Database connection limits must be coordinated
with API instance limits, pooler mode and database capacity.

Production sizing inputs still needed: short-interval peak volume, largest outlet
share, annual growth, typical order lines and payload bytes, retention, freshness
targets, recovery objectives, and monthly operating budget. Averages alone are
not load-test targets. Measure growth including indexes and audit/ledger rows.

Development can use a smaller fleet and bounded full-scale exercises. If a test
needs paid capacity, decide that explicitly rather than weakening correctness.
The prior 60/70/85-percent budget thresholds remain proposals, not approved policy.

## Possible Google Cloud consolidation — evaluation only

| Current responsibility | Candidate | Evaluation required |
|---|---|---|
| Cloud Run API | Retain Cloud Run | Instance/connection ceilings, burst behavior, warm capacity and regional costs |
| Neon PostgreSQL | Cloud SQL PostgreSQL | Extension/version compatibility, HA and recovery targets, data migration and connection pooling |
| Upstash Redis | Remove if unnecessary, or evaluate managed Redis-compatible service | Session and abuse-control design; measured cache benefit; fixed cost |
| Cloudflare Pages | Google-hosted static frontend | CDN, TLS/domain, build/release workflow and total cost |
| Cloudinary | Cloud Storage plus required image processing/delivery | URL migration, signed uploads, resizing/format conversion, caching; object storage alone is not equivalent |
| OTA on GCS and Cloud Run | Retain existing mechanism | Device compatibility, bundle integrity, rollout/rollback and old-client endpoint continuity |

Migration must preserve IDs, idempotency receipts, device identity, and compatible
API contracts. Quiesce canonical writes, establish a consistent final database
copy, verify counts/ledger totals, and switch one canonical write destination.
Offline devices may have queued operations for the old endpoint, so preserve a
controlled forwarding/compatibility path. Avoid independent dual writes.

Rollback after new writes is not merely switching the connection string back:
it needs reconciliation/replay of all newly accepted operations or a forward fix.
The exact cutover and rollback plan is a later deliverable, not approved here.

## Verification baseline and limits

Verified in this conversation before this document was added:

- Local application matches remote `prod-hardening@4691c78`.
- Go tests/vet and six TypeScript project checks passed.
- TS suites: POS 153, sync 20, backoffice 4, printer 7 passed.
- Lint: 117 errors, 6 warnings. Latest inspected remote backend CI fails at
  formatting and skips later build/race tests; four files reported by gofmt.
- GCP read-only authentication works. Cloud Run latest ready revision is
  `mandalika-pos-00077-b45`; observed revision concurrency 80, maximum instances 20.
- Provider account plans, Neon/Upstash telemetry, billing, image usage and current
  recovery configuration have not been verified. No full-device durability or
  live-database integration testing was performed in this conversation.

## Next review checkpoints

New planning topic raised by the user: void/correction of transactions entered
incorrectly by a cashier. Current inspection found cart clearing and an existing
refund operation, but no dedicated sale-void UI/API/outbox operation. A cancelled
status label/schema value does not establish an executable void workflow. History
search found transfer cancellation, not evidence of implemented sale voiding.

Proposed distinction: editing/clearing an unpaid draft cart; voiding an erroneously
recorded sale; customer refund; warranty exchange. A recorded sale must not be
deleted to correct input. Proposed void design preserves the original, records
reason/actor/authority, reverses recorded effects exactly once where appropriate,
and links a corrected replacement sale as required by the approved policy. Actual payment and physical
stock movement must be distinguished from erroneous recorded effects. A void
must not claim to reverse a settled bank payment or restore goods that left the
outlet.

Approved scope: void/correction must cover transactions already checked out and
paid, when correcting cashier input mistakes. This does not establish permission
to delete sales or automatically reverse actual payments. Void is distinct from
customer refund and warranty exchange; their approval rules are not automatically
inherited.

Proposed paid-sale correction flow: preserve the original sale/payment evidence,
record an audited void and always link a corrected replacement sale.
Reconcile payment allocation so existing collected money is neither collected
again nor represented as returned without an actual payout. A price difference
requires explicit additional collection or a separately recorded amount owed to
the customer. Do not mark recorded QRIS/card funds as bank-reversed solely because
the order was voided. Corrections must account for actual goods handed over,
stock, promotions, points, and shift totals without duplicate reversals on retry.
These mechanics remain proposed pending the operational policy.

Approved paid-sale void authority: TL (Outlet Head) is sufficient to handle
voids; SPV approval is not required. This supersedes the proposed SPV requirement.
Do not infer that ordinary cashier refund permission includes paid-sale void
authority, or equate TL with an existing technical role without mapping it.

Proposed supporting controls: a dedicated void capability assigned to the TL's
role, outlet-scoped enforcement, a required correction reason, and an audit link
to the original and required replacement sale. Exact role mapping and whether other
roles inherit this capability remain design details.

Approved authorization mechanism: the TL must authorize a paid-sale void inside
the application using their own identity. A cashier recording phone/message
approval does not satisfy this requirement. The external-SPV approval mechanism
for returns is separate and unchanged.

Proposed implementation: bind authorization to the specific original sale and
reviewed correction, preserve both initiating cashier and authorizing TL in the
audit record, and reauthorize if the proposed correction materially changes.
Do not implement a plain TL-name selector as authentication or silently replace
the active cashier attribution with the TL. The exact step-up/login mechanism,
and credential handling remain design decisions. Offline TL authorization for
void finalization is outside the approved connectivity policy below.

Approved shift restriction: ordinary paid-sale voids are limited to the original
sale's same still-open shift. A later open shift does not make an older sale
eligible. Once the original shift closes, mistakes require a separate audited
correction process; do not reopen or silently rewrite finalized shift totals.
Authority and settlement/reporting details for that correction process remain
to be defined. The TL in-app authorization requirement remains in force.

Proposed acceptance checks: matching open shift permits an otherwise authorized
void; closed or different shift routes to correction; concurrent shift closure
and void finalization cannot bypass the rule. The server must validate shift
state atomically with acceptance rather than trust a stale client status.
Historical transactions remain intact in either path.

Approved connectivity policy: paid-sale voids wait for connectivity. Validate TL
authority, original shift state and transaction/payment history on the server
before finalization. Offline intent capture, if provided, is not a completed
void and must not reverse stock, cash, loyalty or the sale. If the original shift
closes while waiting, use the separate audited correction path rather than
bypassing the open-shift restriction. A locally pending sale must first have its
canonical synchronization outcome resolved before an online void can target it.

Proposed failure handling: a lost response after submission means outcome unknown,
not permission to issue another reversal. Recover the operation result using the
same stable key on reconnect; do not show success without confirmed acceptance.
Test offline denial, closure while waiting, and accepted-but-response-lost replay.

Approved replacement requirement: every paid-sale void must link to a corrected
replacement sale. Standalone cancellation without replacement is outside this
ordinary void workflow. Preserve both transaction references and the correction
relationship; do not delete the original or silently edit it in place.

Proposed implementation: prepare the replacement before TL authorization, then
atomically accept the original's reversal, replacement, link and recorded effects
under a stable correction key. Failed validation leaves the original intact;
retries return the same linked outcome rather than generating another sale.
Physical money transfers remain separately evidenced, not made atomic by a
database transaction. Reconcile existing payment into the corrected sale without
double collection, and make any additional collection or payout explicit.
Test missing replacement, changed correction after authorization, validation
failure, lost-response retry, concurrent correction and shift closure.

Duplicate-sale remediation involving an existing legitimate sale still needs a
defined path; do not fabricate a new paid sale merely to satisfy a required link.
Whether a replacement must be newly created or can reference an existing valid
sale in that case remains unresolved. Dependent implementation awaits that specific
decision; independent programme work continues under standing authority.

1. Remaining refund/exchange details: missing main-component handling,
   inspection outcomes after a voluntarily returned tester is held,
   closing-calendar edge cases,
   manual-transfer permission mapping and proof validation, amount limits,
   offline permission validity, upgrade payment verification,
   bundle/reward allocation, and outstanding/uncertain settlement reconciliation
   for post-exchange refunds (net-payment formula and handling-SPV approval are approved). Authority,
   outlet/connectivity scope, exchange pricing, payout options, inspection-release
   permission, and the restriction on resale of pending returns are approved above.
2. Operational freshness, peak load, recovery objectives and spending range.
3. Security, release and recovery design; measured provider inventory.
4. Complete design review, followed by a separate granular implementation plan.
5. Execute bounded, dependency-aware milestones under standing programme authority;
   rehearse migrations in isolated environments and satisfy actual release safeguards.


### Current continuation — A31-POLLING-20260921-01

E28 records scoped ChatGPT acceptance of A27-summary-double-subtraction. Full
A27/T24 and Q09/A28 vocabulary/cross-day refund posting remain unresolved/open.
Prior bounded acceptances stand; all44 findings and all release gates remain.

E29 contains Backoffice polling publication: only the latest-started request of
an active dependency generation may write data, error or terminal loading state.
Scope change clears data/error and loads anew; unchanged scope keeps prior data
while refreshing. Cleanup invalidates both in-flight completion and old interval
callbacks. Manual refetch remains supported. Five outlet-dependent product/order
callers now declare that dependency; 63 call sites are inventoried. This changes
no permission, report arithmetic/calendar, pagination completeness or POS policy.

13 real React/Chromium deterministic checks, rendered Reports success/error races
with a late201-row A cohort, existing BO50 and app/harness types pass. A31 parent
remains open pending scoped review. No global cancellation, database snapshot
isolation, other ad-hoc polling, native or production qualification claim.

Next: review E29 and its T26 evidence. Separately inspect A34's existing CI checks
and map missing financial/client regressions before proposing bounded wiring;
keep Q09/A28 accounting decisions separate. No generic execution approval needed.
Prior stopped test fixtures remain retained; policy-blocked cleanup was not retried.


### Current continuation — A34A-CI-20260921-01

E30 accepts/resolves A31/T26 for the original stale-scope polling race, preserving
its historical evidence and separate I/O cancellation/POS/snapshot qualifications.
This is the first resolved parent:1/44,0/8 original P0s,0 release gates. Prior scoped
acceptances stand. The canonical tracker retains all44 IDs and priorities.

E31 adds a deterministic blocking JS/TS baseline under standing authority:
`corepack pnpm quality:ci` installs the frozen lockfile; tests POS, Backoffice,
sync and printer; checks six source packages and excluded app tests/TS browser
harnesses; builds both apps; regenerates/checks the TypeScript OpenAPI artifact.
Node22/pnpm9.15.0 setup follows the existing release convention. Root Node types
are explicit for reproducible test checking; lockfile versions are preserved.
Vitest transpilation is not substituted for TypeScript checking. A deliberate
legacy-null transfer test cast is clarified without changing business source.

One reusable workflow handles PR/push and Android release. Both quality and the
needs-blocked signing job check out caller github.sha. No signing secrets are
forwarded to quality. Backend and advisory React Doctor workflows are unchanged.
Local clean and isolated negative proofs are in A34A_CLEAN_RUNS.json and
A34A_NEGATIVE_GATES.json; machine inventories disclose default versus opt-in/manual
coverage. No hosted Actions run, signed artifact, push or deployment occurred.

A34a is locally verified/review pending, not full A34/T29 closure. Next bounded
work should define safe mandatory PostgreSQL financial fixtures/CI entrypoints,
then wire hosted browser regressions separately. Preserve fixture target checks;
never use live DSNs as a CI shortcut. Database concurrency, dependencies/SBOM/
licenses/advisories, secret scanning, native APK/OTA provenance/debug checks and
required-status/hosted-run evidence stay open. Prior database cleanup remains
stopped; its policy block was not retried or bypassed.


### Current continuation — A34B-POSTGRES-CI-20260921-01

E32 records scoped ChatGPT acceptance of A34a from CG-A34A-CI-20260921-01-R1.
A31/T26 remains resolved; all44 findings remain tracked,0/8 P0 parents and0
release gates close. Full A34/T29 is open. Standing AUTH-MANDALIKA-20260919-01
covers this bounded continuation without another routine authorization request.

E33 makes the six existing PostgreSQL entrypoints mandatory through a reusable
fail-closed workflow and checked-in runner. Each uses a fresh PG18.3 fixture,
exact loopback/port/database/user and SHOW data_directory/empty-schema checks,
synthetic credentials, bounded startup/test timeouts, named PASS/no-SKIP proof,
and owned finally teardown. Guard prefixes are unchanged. A stale S0c test-only
BXGY fixture now uses disjoint products, with its original allocation assertions
and a product-scoped stock assertion. No production business source changed.

Android signing now needs quality, database and the reusable existing backend
baseline at the same caller SHA; signing secrets are not forwarded. All six
native local PG18.3 gates passed; five required negative proofs plus wrong data
directory failed correctly and cleaned their fixtures. Nine runner contracts pass.
The dirty HEAD-relative gen-check failure is disclosed; identical regeneration
passes in a disposable current-tree index. No active generated source changed.

Docker engine, local CGO/race and hosted Actions execution are unavailable here;
CI remains configured for Ubuntu/Docker and race. Local proof does not close
hosted qualification. Genuine A13/A42 concurrent DB scenarios are not implemented;
sequential replay and race instrumentation do not substitute for them. A34B
verification/inventory/matrix retain all limits. No release gate closes.

Next bounded work: A34c hosted browser CI for existing synthetic browser harnesses,
with named-scenario completion and negative fail-closed proof, then obtain hosted
JS/TS+DB+backend results on a reviewed complete source snapshot. Keep A13/A42
business concurrency separate; do not add superficial coverage. No policy decision
blocks this slice. Prior stopped DB cleanup policy block remains untouched. New
Python cache deletion was also policy-blocked; retained cache is excluded from
review artifacts. Only fresh owned DB fixtures from this slice were cleaned.


### Current continuation — A34C-BROWSER-CI-20260921-01

E34 records CG-A34B-POSTGRES-CI-20260921-01-R1 scoped acceptance of A34b
as implemented/locally verified. Hosted Docker/race remains pending. Counts are
44 findings,1 resolved parent(A31),0 P0 parents/gates and15 accepted milestones
across10 findings. Standing AUTH-MANDALIKA-20260919-01 remains in effect.

E35 implements the A34c mandatory Chromium browser gate: pinned Playwright1.63.0,
26 required ordinary tests, discovery/completion checks for missing/skipped/failed
cases, strict loopback Vite servers, synthetic APIs/auth and default external
network denial. Existing accepted A23/A24/A26/A31 journeys and S0a/S0b rendered
retention harnesses are covered. Real hook harness gains a case selector; business
source stays unchanged. Manual native/provider residuals are explicitly inventoried.

Final local26/26 zero skips and seven actual negative probes pass with confirmed
process/port cleanup. JS quality347 pass plus one existing optional DB-page replay
skip; source/test types, both builds and TS schema regeneration pass. Evidence is
in A34C_VERIFICATION.json, A34C_VALIDATION_MATRIX.md and the scenario registry.
Android signing now needs quality/database/backend/browser at the same caller SHA;
none receives signing/provider secrets. A34a/b workflows are preserved.

A34c is implemented/locally verified, ChatGPT and hosted proof pending. Full
A34/T29 and all release gates stay open. Local Windows Node24 Chromium does not
qualify hosted Ubuntu Node22, native storage, providers or DB business concurrency.
No genuine A13/A42 concurrency tests were added. Dependency/SBOM/license/advisory,
secret scanning, required-status configuration and full APK/OTA provenance remain.
Historical stopped DB and Python-cache cleanup remain untouched/excluded.

Next bounded work: prepare one reviewed complete source snapshot for hosted
quality/backend/PostgreSQL/browser proof. Inventory all currently untracked
programme implementation/fixtures, separate review-only archives, inspect actual
push/deployment triggers and preserve local decisions before publishing. Use
standing authority with release safeguards; do not push an incomplete HEAD-only
subset or interpret a green synthetic gate as release approval. Genuine A13/A42
business-concurrency design/verification stays a separate bounded task.


### Current continuation — A34D-HOSTED-PROOF-20260922-01

E36 records scoped acceptance of A34c by CG-A34C-BROWSER-CI-20260922-01-R1:
16 accepted bounded milestones across10 findings, A31 alone resolved, all44
findings and original8 P0 parents retained; all release gates remain open.
A34a/b/c hosted proof is pending until all four workflows pass on one final SHA.
A34d prepares audit/hosted-proof-20260922 using an explicit reviewed allowlist,
staged SHA256/tree manifest and staged-text scan. Sensitive/local settings and
review relay/evidence are excluded and retained locally; no history rewrite.
Known external integrations receive branch-scoped deployment safeguards while
quality/backend/PostgreSQL/browser remain mandatory. No release dispatch/OTA,
live data or credential operations belong to this checkpoint. A13/A42 actual
business concurrency, dependency/security/status/provenance gates remain open.

## A34d hosted proof — A34D-HOSTED-PROOF-20260922-01

The explicitly staged complete programme snapshot is published on
`audit/hosted-proof-20260922`. Final source commit `e782c5dfbf3eedefb5d655f6726590dfbea5bf87` passes quality,
backend, postgres and browser on the same SHA. The initial gofmt failure is
preserved; its correction changes formatting only. Hosted proof covers the
accepted Node 22/frozen-lockfile quality definition, the backend gen/vet/fmt/build/
race baseline, six Docker PostgreSQL 18.3 fixtures (142 PASS events, zero skips),
and pinned Chromium (26/26, zero skips, clean network and cleanup).

A34c scoped ChatGPT acceptance is recorded in canonical tracker E36. A34d E37
awaits review; it does not close A34/T29 or any release gate. A13/A42 true business
concurrency, dependencies/SBOM/license/advisories, A37 secret scanning, required
statuses and A35 APK/OTA provenance remain separate work. No signing, deployment,
live-data or credential operation occurred. The historical stopped DB/cache
cleanup remains untouched. Post-proof documentation is a local review after-image,
not another source revision claimed tested by these runs.

Next bounded proposal: A34e dependency/security baseline inventory and a pinned
SBOM/license/advisory gate design using this complete source SHA. Keep A37 secret
scanning and A13/A42 concurrency as explicit workstreams; do not silently treat
generic Go race mode as business concurrency coverage. Consequential policy to
review: advisory severity/reachability thresholds, acceptable licence policy and
exception ownership/expiry; investigate the current evidence before enforcement.

## A34e dependency security — current continuation

CG-A34D-HOSTED-PROOF-20260922-01-R1 scoped-accepts A34d's exact e782c5d hosted
checkpoint. Canonical tracker E38 records 17 scoped acceptances across 10 findings;
A31 remains the sole resolved parent, all 44 findings and all eight P0 parents stay
tracked, and no release gate closes.

A34e/A38 applies DEPSEC-INITIAL-20260922. Exact-base inventory precedes dependency
edits. Node/Go graph, CycloneDX SBOMs, licenses, public advisories and Go called
symbols are retained. A reusable full-baseline gate, supplemental npm PR delta,
empty reviewed-exception register and disposable negative proofs are implemented.
JWT/Redis receive narrow patch fixes. Remaining policy blockers are not waived:
proxy trust, SheetJS distribution/remediation and rgbcolor license evidence need
precise follow-up. No broad license-family policy is invented. Android dependency
wiring waits for a clean/exactly-excepted baseline, as the review requires.

The current packet carries final scan/hosted results and residual decisions.
A34/T29, A38/T33, A37, A13/A42 business concurrency, A35 provenance, branch status
rules and all release gates remain open. Stopped DB/cache cleanup is untouched.

## A34e review accepted; A34e1 Go remediation

CG-A34E-DEPENDENCY-SECURITY-20260922-01-R1 accepts A34e as implemented and
hosted-exercised while correctly BLOCKED by current dependencies. A38 receives
scoped reachability-baseline progress; full A34/T29, A38/T33 and every release
gate remain open. There are18 accepted bounded milestones across11 findings;
all44 findings remain, A31 alone resolved and0/8 original P0 parents closed.

Apply docs/A34E_REVIEW_DECISIONS.md: no chi version-only repair before ingress
trust evidence; vendor exact official SheetJS0.20.3 in a later separate slice;
rgbcolor approval is pending and no license exception is added.

A34e1 targets minimum fixed pgx5.9.2 and x/text0.39.0 with graph-proven MVS support
only. Capture exact module/sum/graph and govulncheck/policy ID deltas before/after;
require generated drift, fmt/vet/build/unit checks, all six safe local PostgreSQL
fixtures and same-SHA hosted quality/backend/postgres/browser success plus a
completed dependency scan. Unrelated dependency blockers must remain visible.
No business-source, migration, auth/client-IP, deployment, OTA or live-data change.


## A34e1 scoped acceptance; A34e2 x/crypto continuation

E42 accepts A34e1 under CG-A34E1-GO-REMEDIATION-20260922-01-R1 (19 bounded
milestones, 11 findings; parents/release gates open). Execute A34e2 before the
already-approved SheetJS slice, per docs/A34E2_XCRYPTO_SCOPE.md. Target x/crypto
v0.56.0 plus proven MVS support only. Keep actual pre-upgrade synthetic Argon2id
fixture, encoded parameters, verification/rejection and malformed-hash behavior.
No credential migration, policy exception or business change. Preserve no-fixed
OpenPGP GO-2026-5932 and demonstrate actual imports/calls. Require fresh module/
advisory delta, local Go/password tests, six real PostgreSQL/race gates and four
same-SHA hosted application passes plus a completed dependency scan. Record
existing stored-hash parser limitations separately; do not expand this update
into parser hardening. Return to SheetJS only after the A34e2 ChatGPT review.


## A34e2 accepted; A34e3 vendor coverage

E44 records scoped A34e2 acceptance (20 milestones / 11 findings), with the
stored-hash parser residual linked to A07/A09 for separate rejection hardening.
A34e3 uses the official versioned xlsx 0.20.3 artifact through a pinned repository
file dependency and preserves scanner identity, licenses, SBOM, advisory queries
and digest-sensitive PR deltas. Archive/install negatives and real workbook
exports are required alongside same-SHA gates. Any feed/publisher applicability
conflict remains blocked pending review; do not rename or suppress the component.
No A14 import or A27/A28 behavior change. See A34E3_SHEETJS_REMEDIATION.md.

## A34e3 accepted; A34e4 exact applicability

E46 records CG-A34E3-SHEETJS-20260923-01-R1 scoped acceptance (21 milestones/11
findings). E47 implements the reviewed two-advisory assessment, binding actual
xlsx0.20.3 bytes/provenance/lock, approved source evidence and a 2026-10-23 re-review
deadline. Preserve raw findings and separate reviewed-not-affected from exceptions;
use identical baseline/PR projection. Evidence changes and nonmatching artifacts
keep normal enforcement. No package-wide ignore or policy/license downgrade.
The canonical tracker and A34E4_SHEETJS_APPLICABILITY.md hold results/residuals;
parent findings and release gates stay open. No broader remediation bundled.

A34e4 final verification (2026-09-23): commit31080a4, four application workflows
pass; fresh security scan completes with48 raw/46 actionable/2 reviewed-not-affected
and zero exceptions. The two exact SheetJS decisions are review-pending implementation;
21 milestones remain accepted. No parent/release gate closure or next-family upgrade.

## A34e5 tar checkpoint — 2026-09-23

E48 accepts A34e4 exact applicability:22 milestones/11 findings. E49 changes only
Capacitor CLI8.3.4's tar edge to7.5.21 with a scoped override, clean installed-parent
proof and six bounded archive regressions in canonical quality. Local raw blocker
48->45/actionable46->43 delta retains SheetJS reviewed2/exceptions0. Hosted proof
and A34e5 review pending. All44 findings, existing business decisions and release
gates remain; no native/platform upgrade or next-family remediation is included.

A34e5 final proof:095dcff, four application workflows pass; completed fresh security
scan raw45/actionable43/reviewed2/exceptions0. Six bounded tar cases, six mandatory
Docker18.3/race fixtures and26 Chromium scenarios pass. A34e5 review pending;22
accepted milestones retained. Two temporary dependency install copies remain after
policy-blocked cleanup; no bypass and no historical DB-cleanup action.

## A34e6 current checkpoint

E50 accepts A34e5:23milestones/11findings. E51 xmldom0.9.12 via existing plist
range is locally verified with10bounded cases and full quality. Fresh scan
34raw/32actionable/2reviewed/0exceptions;13family IDs removed,no new findings.
Hosted proof/review pending. No parent/gate closure; all44 retained,A31 alone resolved.
Prior blocked installation-copy cleanup remains untouched.

## Final hosted verification — 2026-09-23

Final source `36d3d3abd146949c922d7bd6a32312ff50eca4e6`, tree `0806541d8d9c2d3ae9223a897a110c93c8d1d9db`.
Quality35834359162/backend35834359922/PostgreSQL35834359187/browser35834359063
all succeed on this SHA. Hosted Node22 passes10XML+6tar cases. Docker18.3/race:
6gates/142named passes/zero skips/identity+cleanup verified. Chromium26/26passes,
zero skips,no unexpected external access,process/port cleanup confirmed.
Backendgen/vet/fmt/build/race and quality frozen/types/build/schema pass.
Fresh security35834359219 completes RED:34raw/32actionable/2reviewed/0exceptions.
Source-input hashes match committed blobs; normalized findings equal local after.
No new/changed unrelated finding. A34e6 implemented and hosted-verified;ChatGPT
review pending.23accepted milestones;all44 retained,A31 alone resolved.
A34/A38/release gates open. Post-proof documentation is a local reporting after-image;
all executable source matches the hosted commit. New install-copy cleanup was also
policy-blocked; prior A34e5 copies untouched; no deletion retry or bypass.

## A34e7 current checkpoint

E52 accepts A34e6:24milestones/11findings. E53 compatible brace-expansion patches
on3existing lines pass20bounded tests and quality. Fresh local25raw/23actionable/
2reviewed/0exceptions;9matched records removed. Hosted/review pending;no gate closes.
All44 parents remain,A31alone resolved. Existing business policies and denied
installation-copy cleanup restrictions remain. See A34E7_BRACE_EXPANSION_REMEDIATION.md.

## Final hosted checkpoint — 2026-09-23

Source `1e76b42755bfe6f827905d465ec1e49bc461f8d0`, tree `f81f55057670110fd17cdcce97a6d01371d2f9a7`. Quality35839087570,
backend35839087581,PostgreSQL35839087627,browser35839087589 all succeed on this SHA.
Hosted Node22:20brace+10XML+6tar cases pass;349app tests with1existing optional replay
skip. Types/build/schema pass. Backendgen/vet/fmt/build/race passes. Docker18.3/race:
6gates,142named passes,zero skips,identity/cleanup verified. Browser26/26,zero skips,
clean network/owned-process/port state. Fresh security35839087632 completes RED:
25raw/23actionable/2reviewed/0exceptions. Input hashes match committed blobs; hosted
normalized findings equal local after-scan. No new/changed unrelated finding.
A34e7 implemented and hosted-verified;ChatGPT review pending.24accepted milestones,
all44 retained,A31alone resolved,A34/A38/release gates open. Post-proof documentation
is local reporting,distinct from the committed executable snapshot.
Four previously denied install copies untouched;two new install copies retained for
review/reproduction without a deletion attempt. Tiny fixtures/processes cleaned.

## Current A34e8 checkpoint — 2026-09-23

E54: CG-A34E7-BRACE-EXPANSION-20260923-01-R1 scoped accepts A34e7 at1e76b42.
25 accepted milestones across the same11findings; all44 remain,A31 alone resolved.
E55: A34E8-NANOID-20260923-01 updates PostCSS's compatible Nano ID edge3.3.12
->3.3.18.16bounded cases pass; corrected before-final6pass/10fail. Fresh local
25->23raw/23->21actionable,reviewed2/exceptions0. Exactly2targeted IDs removed;
no new/changed unrelated records. Hosted proof verified; ChatGPT review pending. A34/T29,A38/T33
and all release gates stay open. See A34E8_NANOID_REMEDIATION.md.
Earlier checkpoint sections preserve historical evidence; this section is current.

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

## Current A34e9 checkpoint — 2026-09-23

E56: CG-A34E8-NANOID-20260923-01-R1 scoped accepts A34e8 at4cd7f89.
26accepted milestones/same11findings;all44retained,A31alone resolved.
E57: A34E9-POSTCSS-20260923-01 updates actual Vite->PostCSS8.5.23, preserving
Nano ID3.3.18 and all16worker assertions through real consumer resolution.
15PostCSS cases pass;3targeted before-fix read/propagation failures. Freshlocal
23->22raw/21->20actionable/30->29report-only;reviewed2/exceptions0. OneHigh and
oneModerate PostCSS record removed,no unrelated change. Hosted verified;review pending.
FullA34/T29,A38/T33 and every release gate open. Earlier checkpoints are historical.

## Final hosted proof — 2026-09-23

Source `79403f23e63a3560a43a4c8845b91ff9102cfe96`, tree `c12e2c2228819ed126f90304c41b84b4d16461f8`. Quality35848841958,
backend35848841933,PostgreSQL35848841864,browser35848841866 all succeed
on this exact SHA. Hosted Node22 passes15PostCSS+16Nano ID+20brace+10XML+6tar.
Backendgenerateddrift/vet/gofmt/build/race passes. Docker18.3/race:6fixtures,
142namedpasses,zero skips,identity and cleanup verified. Chromium26/26,zero skips,
clean network/owned-process/port state. Fresh security35848842086 completes RED:
22raw/20actionable/29report-only/2reviewed/0exceptions. Committed input hashes match;
hosted normalized findings equal local after-scan. Exactly1High blocker and1Moderate
report-only PostCSS record removed; no other record changes. Nano ID3.3.18 covered.
A34e9 implemented/locally+hosted verified; ChatGPT review pending.26accepted milestones
across11findings; all44 remain,A31alone resolved,A34/A38 and every release gate open.
Post-proof docs are local reporting after-images, separate from tested executables.
Four denied installation copies untouched; prior/new retained copies not deleted.
Owned tiny fixtures/processes cleaned. No signing/deployment/OTA/live operation.

## Final A34e10 hosted proof — 2026-09-24

Commit `4f6347346ac738e9ac4c7c295dd26351e1cd9e94`, tree `a1f437a7433dee752d9acdeef89ca72fa462544d`, branch audit/hosted-proof-20260922.
All four application workflows succeed on this exact SHA. Node22 quality passes
15 Browserslist + 15 PostCSS + 16 Nano ID and prior dependency/application checks.
Backend gen/vet/fmt/build/race passes. Docker PostgreSQL18.3/race: six fixtures,
142 named passes, zero skips, verified identities and cleanup.
Chromium26/26, zero skips, no unexpected external requests, clean owned processes/ports.
Fresh security completes RED for remaining blockers: 20 raw / 18 actionable /
2 reviewed / 0 exceptions. Hosted normalized findings equal local; source hashes match.
Two Browserslist High IDs removed. Existing Moderate baseline-browser-mapping finding
remains with only its selected version changed. Publisher severity disagreement retained.
A34e10 implemented and locally/hosted verified, ChatGPT review pending. A34e9 accepted;
27 accepted milestones / 11 findings. All44 retained; A31 alone resolved. A34/A38 and
all release gates remain open. Post-proof documentation is a local reporting after-image.
Denied cleanup targets untouched; new installation copies retained without deletion.
No signing, deployment, OTA or live operation.

| Workflow | Run | Result |
|---|---|---|
| backend | [35950742331](https://github.com/Epheyy/mandalika-pos/actions/runs/35950742331) | success |
| dependency-security | [35950742289](https://github.com/Epheyy/mandalika-pos/actions/runs/35950742289) | failure |
| Mandatory PostgreSQL integration | [35950742279](https://github.com/Epheyy/mandalika-pos/actions/runs/35950742279) | success |
| JS/TS Quality | [35950742254](https://github.com/Epheyy/mandalika-pos/actions/runs/35950742254) | success |
| Mandatory Chromium browser gate | [35950742274](https://github.com/Epheyy/mandalika-pos/actions/runs/35950742274) | success |

## Final A34e11 hosted proof — 2026-09-24

Source `7d2ab470fa4edfa78c9ee8f3c435587590681e81`, tree `72682d1e8f74a14891e93360b8dfab762e961bda`, audit/hosted-proof-20260922.
Quality/backend/PostgreSQL/browser succeed on this exact SHA. HostedNode22 passes
30 js-yaml +15 Browserslist +15 PostCSS +16 NanoID and prior accepted checks.
Backend generated drift/vet/gofmt/build/race passes. DockerPostgreSQL18.3/race:
6 fixtures, 142 named passes, zero skips, verified identity/cleanup.
Chromium26/26, zero skips, clean network/owned processes/ports. Fresh security
completes RED: 17 raw / 15 actionable /28report-only/2reviewed/0exceptions.
Source input hashes match commit; hosted normalized findings equal local. Removed
three High and one Moderate js-yaml IDs; no new/changed unrelated record.
A34e11 locally/hosted verified, ChatGPT review pending. A34e10 accepted; E9-REPORT-01
closed as corrected evidence only.28accepted milestones/same11findings;all44parents
retained,A31alone resolved. A34/T29,A38/T33 and every release gate stay open.
Post-proof docs are local reporting after-images, not another executable revision.
Previously denied cleanup targets untouched; two new install copies retained.
No signing, deployment, OTA, live data or business policy change.

| Workflow | Run | Result |
|---|---|---|
| backend | [35953693676](https://github.com/Epheyy/mandalika-pos/actions/runs/35953693676) | success |
| Mandatory PostgreSQL integration | [35953693549](https://github.com/Epheyy/mandalika-pos/actions/runs/35953693549) | success |
| dependency-security | [35953693547](https://github.com/Epheyy/mandalika-pos/actions/runs/35953693547) | failure |
| JS/TS Quality | [35953693570](https://github.com/Epheyy/mandalika-pos/actions/runs/35953693570) | success |
| Mandatory Chromium browser gate | [35953693545](https://github.com/Epheyy/mandalika-pos/actions/runs/35953693545) | success |

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

## Final A34e13 hosted proof — 2026-09-24

Source `63c74711ecb5f5a26641c748f324d2ff72c8a67d`, tree `d7cb7d14799e610745458af74c669fee4108e72d`, branch audit/hosted-proof-20260922.
Quality/backend/PostgreSQL/browser pass on this exact SHA. Backend Go1.26.8 passes
generated drift, vet, gofmt, build, bounded offline x/mod5/5 with zero skips and
owned cleanup, and full ordinary race tests. Hosted DockerPostgreSQL18.3/race:
6fixtures, 142 named passes, zero skips, verified identities and cleanup.
Chromium26/26, zero skips, confirmed owned processes/ports closed and no unexpected
network requests. Node22 quality retains all accepted dependency/application gates,
including NanoID16/PostCSS15/Browserslist15/YAML30/Vite3 groups.
Fresh security completes RED: 14raw/12actionable/27report-only/
2reviewed-not-affected/0risk exceptions. Source hashes match this commit;
normalized hosted findings equal local. Exactly GO-2026-6179 and GO-2026-6180 leave
the selected x/mod records; no new/changed unrelated normalized findings.
A34e13 locally/hosted verified, ChatGPT review pending. E64 accepts A34e12 and closes
E11-REPORT-01 as corrected attribution, original logs preserved; E9 stays closed.
30accepted milestones/same11findings. All44parents retained; A31 alone resolved.
A34/T29,A38/T33, original8P0 parents and every release gate remain open.

Default local Go1.26.2 remains distinct from the existing cached1.26.8 executable
selected only per process for this work. No global/persistent Go change, incident
clearance or demonstrated POS exploit claim. The bounded runner rejects Go<1.26.6.
Independent scanner binaries/pins are unchanged. Local PostgreSQL is non-race;
hosted Linux supplies race verification. Initial unchanged XML5s quality timeout
and initial unused-schema generator fixture are preserved; corrected fixture and
serial quality pass. No intermediate failed application hosted run in this slice.
Post-proof documentation is a local after-image; executable source matches hosted
commit. Denied cleanup targets/stopped DB cleanup untouched. No deployment,
signing, OTA, live-data, policy, exception or business-behavior change.

| Workflow | Run | Result |
|---|---|---|
| Mandatory PostgreSQL integration | [35966319941](https://github.com/Epheyy/mandalika-pos/actions/runs/35966319941) | success |
| JS/TS Quality | [35966320066](https://github.com/Epheyy/mandalika-pos/actions/runs/35966320066) | success |
| dependency-security | [35966320002](https://github.com/Epheyy/mandalika-pos/actions/runs/35966320002) | failure |
| backend | [35966319909](https://github.com/Epheyy/mandalika-pos/actions/runs/35966319909) | success |
| Mandatory Chromium browser gate | [35966319918](https://github.com/Epheyy/mandalika-pos/actions/runs/35966319918) | success |
