# Canonical audit coverage tracker — A01–A44

## Current A34e9 checkpoint — 2026-09-23

E56: CG-A34E8-NANOID-20260923-01-R1 scoped accepts A34e8 at4cd7f89.
26accepted milestones/same11findings;all44retained,A31alone resolved.
E57: A34E9-POSTCSS-20260923-01 updates actual Vite->PostCSS8.5.23, preserving
Nano ID3.3.18 and all16worker assertions through real consumer resolution.
15PostCSS cases pass;3targeted before-fix read/propagation failures. Freshlocal
23->22raw/21->20actionable/30->29report-only;reviewed2/exceptions0. OneHigh and
oneModerate PostCSS record removed,no unrelated change. Hosted/review pending.
FullA34/T29,A38/T33 and every release gate open. Earlier checkpoints are historical.


## Current A34e8 checkpoint — 2026-09-23

E54: CG-A34E7-BRACE-EXPANSION-20260923-01-R1 scoped accepts A34e7 at1e76b42.
25 accepted milestones across the same11findings; all44 remain,A31 alone resolved.
E55: A34E8-NANOID-20260923-01 updates PostCSS's compatible Nano ID edge3.3.12
->3.3.18.16bounded cases pass; corrected before-final6pass/10fail. Fresh local
25->23raw/23->21actionable,reviewed2/exceptions0. Exactly2targeted IDs removed;
no new/changed unrelated records. Hosted4cd7f89 four green plus complete security.
ChatGPT review pending. A34/T29,A38/T33
and all release gates stay open. See A34E8_NANOID_REMEDIATION.md.
Earlier checkpoint sections preserve historical evidence; this section is current.


## Current A34e7 checkpoint — 2026-09-23

E52: CG-A34E6-XMLDOM-20260923-01-R1 accepts A34e6 at36d3d3a.
24 accepted milestones across the same11findings; all44 retained,A31 alone resolved.
E53: A34E7-BRACE-EXPANSION-20260923-01 implements compatible1.1.18/2.1.4/5.0.9
through their actual minimatch parents.20bounded checks pass;5before-fix failures.
Fresh local34->25raw/32->23actionable,reviewed2/exceptions0;9records removed,no new.
Hosted1e76b42:four green and fresh security25raw/23actionable; ChatGPT review pending. A34/T29,A38/T33 and gates remain open.
Prior checkpoint sections retain historical evidence; this section is current.


## Current A34e6 checkpoint — 2026-09-23

E50: CG-A34E5-TAR-20260923-01-R1 scoped accepts A34e5 at095dcff.
23 accepted milestones across the same11 findings; all44 retained,A31 alone resolved.
E51: A34E6-XMLDOM-20260923-01 implements compatible plist3.1.1 -> xmldom0.9.12.
Ten bounded real-parent/parser checks pass; seven old-version failures reproduced.
Fresh local45->34raw/43->32actionable,reviewed2/exceptions0;13IDs removed,no new IDs.
Hosted36d3d3a verified:fourgreen + completed security34raw/32actionable. ChatGPT acceptance pending; A34/T29,A38/T33/release gates remain open.
See A34E6_XMLDOM_REMEDIATION.md and current packet; prior checkpoints below are historical.


Reconciled 2026-09-19; A34e4 scoped acceptance and A34e5 tar remediation added 2026-09-23 in the same Windows/PowerShell worktree.
Root: `C:/Users/MyBook Hype AMD/Downloads/mandalika-pos`.
Current verification branch `audit/hosted-proof-20260922`; A34e5 entry HEAD `31080a4b40515369bd050d1eb13150d04fa21971`.
Original reconciliation base: `prod-hardening`, `4691c781842f0114acaf2e4371e0d11f0076f553`.
A34d/A34e source checkpoints remain historical evidence; current A34e5 verification is recorded below.
Scope: 44 original groups, 8 P0 / 32 P1 / 3 P2 / 1 P3. No priority changes.
This is the **only current finding-status tracker**; findings.json is immutable
historical input, not a competing live tracker. Plan/draft contain requirements;
The local-only SESSION_HANDOFF.md and docs/AUDIT_REVIEW_PACKET.md carry the current review packet.

## Evidence and shared fields (apply to every row)

E48: CG-A34E4-SHEETJS-APPLICABILITY-20260923-01-R1 scoped-accepts E47 exact
SheetJS advisory applicability at 31080a4. Progress:22 accepted milestones across
11 findings. All44 retained; A31 remains the sole resolved parent;0/8 original P0
parents and0 release gates closed. A34/T29,A38/T33 remain open. Review limits and
2026-10-23T00:00:00Z deadline are unchanged; no risk/license exception.

E49: A34E5-TAR-20260923-01 updates only the existing Capacitor CLI8.3.4 -> tar
edge from7.5.15 to7.5.21, within its declared ^7.5.3 range. Exact parent-scoped
pnpm override follows a documented no-op ordinary pnpm9 update trial. No other
locked package/version or tar child changes. Clean frozen install proves the
parent's own resolution and actual extractTemplate behavior. Six bounded archive
checks pass after reproducing the old replacement timeout, long-path stack failure
and ignored ratio threshold. Local quality/vendor22/policy19/applicability16 pass.
Fresh local scan: raw blockers48->45, actionable46->43, reviewed2,exceptions0.
Three targeted blocking IDs and three additional Moderate report-only tar IDs
are removed; no new/changed unrelated finding. No static count enforced.
Final hosted SHA095dcff509efeeab0b23dc48bc94e3caf6d71210: quality35829981276,backend35829981337,
PostgreSQL35829981241,browser35829981258 pass. Six Docker18.3/race fixtures and
26 browser scenarios have zero skips and verified cleanup; hosted six tar cases pass.
Fresh security35829981221 completes RED: raw45/actionable43/reviewed2/exceptions0.
All source hashes match committed inputs. A34e5 review pending; no parent/release
closure. Two disposable Node installation copies remain after policy-blocked cleanup;
archive fixture cleanup succeeds and historical DB cleanup is untouched.
See A34E5_TAR_REMEDIATION.md.

E46: CG-A34E3-SHEETJS-20260923-01-R1 scoped-accepts E45 official SheetJS
vendoring, scanner coverage and supplied XLSX qualification at de7352f. Accepted
milestones:21 across11 findings. All44 remain; A31 sole resolved parent;0/8 P0
parents and0 release gates closed. Full A34/T29,A38/T33,A14 remain open.

E47: A34E4-SHEETJS-APPLICABILITY-20260923-01 implements only the two reviewed
SheetJS advisory assessments for the exact official0.20.3 artifact. Source bytes,
lock,manifest,provenance,material advisory/risk fingerprints and review deadline
2026-10-23T00:00:00Z must match. No risk/license exception or dependency upgrade.
Archived real CLI replay:48 unadjusted/46 actionable/2 reviewed-not-affected/0 risk
exceptions. PR replay:50 raw occurrences ->46 actionable;4 assessed occurrences
represent the same2 identities. Raw findings/OSV/SBOM preserved; other46 unchanged.
Local focused/vendor/policy/quality pass. Final hosted SHA
31080a4b40515369bd050d1eb13150d04fa21971: quality35822121487,backend35822121506,
PostgreSQL35822121575,browser35822121515 pass; six Docker18.3/race fixtures and
26 browser scenarios have zero skips and verified cleanup. Fresh dependency-security
35822121570 completes RED: raw48/actionable46/reviewed2/exceptions0; source hashes
match committed inputs. A34e4 review pending; no parent/release closure.
See A34E4_SHEETJS_APPLICABILITY.md and the current packet.

E44: CG-A34E2-XCRYPTO-20260923-01-R1 scoped-accepts A34e2 x/crypto remediation
at 76cc02b2fec813ee534a998c9a45ff9cde5db9f4. Accepted milestones: 20 across the
same 11 findings. All 44 findings retained; A31 sole resolved parent; 0/8 P0
parents and zero release gates close. Full A34/T29 and A38/T33 stay open.
The stored-hash parser characterization is a separate A07 authentication / A09
input-hardening residual, not a permanent approval of unsupported versions or
zero-parameter panics. Replace characterization assertions when that separately
reviewed rejection contract is implemented; no parser changes in A34e3.

E45: A34E3-SHEETJS-20260923-01 vendors official xlsx 0.20.3, SHA256
8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8, preserving npm
advisory identity and explicit distribution provenance. Local clean frozen
install, exporter compatibility, 26 browser scenarios and quality gate pass.
22 vendor tests cover archive/digest/identity/graph/advisory/license/delta guards.
Both fresh full scans report 48 blocking records: vendor xlsx still matches the
two open-ended OSV records. No suppression or exception; applicability review
is required, with exact publisher/range/hash evidence. Hosted same-SHA proof at
de7352fa5fb0cf877e869b1c65040a2731969ccb: quality35817402212,backend35817402195,
PostgreSQL35817402363,browser35817402181 pass. Dependency-security35817402219
completes with48 blockers and exact vendor input hashes. Docker18.3/race six gates,
142 named passes/0skips;Chromium26/26 with network/cleanup confirmed. A34e3 review
pending. See docs/A34E3_SHEETJS_REMEDIATION.md. No parent or release gate closes.

E42: CG-A34E1-GO-REMEDIATION-20260922-01-R1 scoped-accepts E41 A34e1
pgx/x-text remediation and its exact feb0048 hosted checkpoint. Count: 19 accepted
bounded milestones across 11 findings; A31 remains the only resolved parent,
44 findings retained, 0/8 P0 parents and 0 release gates closed. A34/T29 and
A38/T33 remain open; dependency-security correctly remains blocked. The review
orders A34e2 x/crypto before the separately approved SheetJS vendoring slice.

E43: A34E2-XCRYPTO-20260923-01 starts from feb0048 on the same verification
branch. Exact x/crypto target v0.56.0, supporting graph changes only, pre-upgrade
Argon2id fixture and password/parser compatibility required. OpenPGP GO-2026-5932
is no-fixed and must remain visible; no policy/exception change. Local gen/fmt/vet/build and510 ordinary Go PASS events complete (six opt-in
DB skips separately covered by six mandatory PostgreSQL 18.3/race gates,
142 named PASS/zero skips/verified cleanup).19 password compatibility PASS
events and a failing disposable fixture mutation establish old/new hash parity.
Fresh full scans reduce blockers 69 -> 48, removing21 blocking x/crypto records
and 29 known-fixed advisory records; no new blocker or called finding appears.
OpenPGP remains blocked, no OpenPGP imports.
Final hosted SHA `76cc02b2fec813ee534a998c9a45ff9cde5db9f4` passes quality 35811155308,
backend 35811155301, postgres 35811155452 and browser 35811155310. The default
PostgreSQL 18.3 Docker/race runner passes all six gates, 142 named parent/subtests,
zero skips, verified target identity and cleanup. Chromium passes 26/26, zero
skips/unexpected network requests, confirmed browser/Vite cleanup. Dependency
run 35811155324 completes a fresh committed-input scan and correctly FAILS on 48
blocker records, identical to the local blocking set. No new called finding;
GO-2026-5932 remains visible, module-level and unimported. These hosted outcome
paragraphs are uncommitted reporting after-images of the tested executable source.
A34e2 ChatGPT review is pending; A34/T29, A38/T33 and every release gate stay open.
The existing malformed stored-hash parser does not validate numeric versions and
panics on zero rounds/threads; capture this limitation without fixing it in the
dependency slice. See docs/A34E2_XCRYPTO_SCOPE.md; production parser hardening is
separate from dependency reachability progress.

E40: CG-A34E-DEPENDENCY-SECURITY-20260922-01-R1 scoped-accepts E39 A34e
as an implemented and hosted-exercised dependency-security baseline/gate that
correctly remains BLOCKED by the dependency set. A38 reachability-baseline
progress is scoped accepted. The 76 historical policy records are not a clean
scan or 76 independent exploits. Counts: 18 accepted bounded milestones across
11 findings; 44 tracked, A31 sole resolved parent, 0/8 P0 and 0 release gates closed.
Decisions: chi requires ingress trust evidence, no version-only repair; official
SheetJS 0.20.3 vendoring is approved for a later separate slice; rgbcolor owner/legal
approval remains pending and no exception entry is authorized. See
A34E_REVIEW_DECISIONS.md. Full A34/T29 and A38/T33 remain open.

E41: A34E1-GO-REMEDIATION-20260922-01 updates pgx5.7.1 -> 5.9.2 and
x/text0.32.0 -> 0.39.0 from exact df70dc2. Six support movements are required
by the x/text/x/tools MVS graph; no business source or exception change. Fresh
local policy records fall76 ->69 (Go41 ->34); pgx/x-text called IDs disappear,
chi's two called IDs remain, no new blocker appears. Local gen/fmt/vet/build/full
Go checks pass; six isolated Linux PostgreSQL18.3/race fixtures pass142 named
parent/subtests with zero skips and confirmed cleanup. Windows native and Docker
host-port attempts were blocked by reserved ports; their failures are retained.
Final hosted SHA `feb0048de2a577bf8e5b2d9243944ce115aa3a29`: quality35713982002,
backend35713981992, postgres35713982020 and browser35713981989 PASS. PostgreSQL
Docker/race passes6 gates/142 named parent-subtests/0 skips; Chromium passes26/26
with network and cleanup confirmed. Dependency35713982024 completes a fresh
committed-input scan and correctly FAILS on69 remaining blockers; exact target
ID removal and no new blocker verified. These final outcome paragraphs are
uncommitted report after-images of the tested source checkpoint. A34e1 ChatGPT
review remains pending; full A34/T29, A38/T33 and all release gates remain open.

E39: A34E-DEPENDENCY-SECURITY-20260922-01 implements DEPSEC-INITIAL-20260922.
Hosted final SHA `df70dc2f80c1c89f4155f2a7fd1d5e930ad229cc`: quality/backend/postgres/browser pass;
dependency-security run 35705497360 completes but fails on 76 policy records
(34 npm advisory records, 41 Go records, 1 runtime license). Final inventory:
441 npm, 137 Go modules. Four Go called IDs remain, versus six at baseline.
No all-five-green checkpoint exists. Six PostgreSQL Docker/race gates and all
26 browser scenarios pass with zero skips and confirmed cleanup.
These result paragraphs are post-proof report after-images, not newly tested source.
The exact accepted base was inventoried before dependency changes: 436 npm packages,
7 workspace importers and 137 third-party Go modules, with CycloneDX 1.6 SBOMs,
public advisory snapshots, license files/expressions and parsed govulncheck calls.
Baseline policy blocks 79 records (advisory aliases can describe the same issue),
including one unparseable runtime license. No exception has been added. Narrow JWT
5.2.1 -> 5.2.2 and Redis 9.7.0 -> 9.7.3 patches passed all four established hosted gates. The independent
fail-closed workflow/evaluator and disposable policy proofs proceed; remaining
security/license blockers prevent an all-five-green claim. See DEPENDENCY_SECURITY.md
and the current A34E review packet for actual commands, hosted results and decisions.
A34/T29, A38/T33 and every release gate remain open. No new parent is resolved.

E38: CG-A34D-HOSTED-PROOF-20260922-01-R1 scoped-accepts E37 A34d. The quality,
Docker PostgreSQL/race and Chromium gates are hosted-verified on exact final SHA
`e782c5dfbf3eedefb5d655f6726590dfbea5bf87`. All four run IDs and the prior failed
run remain historical evidence. Counts: 44 findings, 17 scoped accepted milestones
across 10 findings, A31 sole resolved parent, 0/8 P0 parents and 0 release gates closed.

E37: A34D-HOSTED-PROOF-20260922-01 establishes actual Ubuntu hosted proof on complete source
commit `e782c5dfbf3eedefb5d655f6726590dfbea5bf87`, tree `831e7af08fafbb8f1d420d4bac0e94fbe9313e72`.
All four push workflows passed on that same SHA: quality 35699002536, backend
35699002529, postgres 35699002539, browser 35699002524. Node 22/frozen-lockfile
quality passes 347 tests (one existing optional DB-response replay skip), all
source/test typechecks, production bundles and generated TS drift. Backend passes
gen/vet/gofmt/build/go test ./... -race. Default Docker PostgreSQL 18.3 passes all
six named gates, 142 parent/subtest PASS events, zero skips, verified target/data
directory/empty schemas and confirmed cleanup. Pinned Chromium passes 26/26,
zero skips, zero unexpected network requests, confirmed process/port cleanup.
Initial backend run 35698564930 failed gofmt; four formatting-only corrections
were locally tested, explicitly staged and normally committed/pushed. Earlier run
IDs and logs remain evidence. No test/guard/race/network/cleanup weakening.
E36 A34c acceptance remains scoped; A34d hosted proof now awaits ChatGPT review.
Full A34/T29 and every release gate remain open. No deployment/release dispatch.
See A34D_VERIFICATION.json and A34D_HOSTED_SUMMARY.json.

E36: CG-A34C-BROWSER-CI-20260922-01-R1 scoped-accepts E35 A34c as implemented
and locally verified. Review checked144 payloads/18 replayed files and registry
structure, without rerunning Chromium/Actions. A34a/b prior acceptances remain.
Hosted Ubuntu/Node22 proof pending; full A34/T29 and release gates open. Counts:
44 findings,1 resolved parent(A31),0/8 P0 parents,0 gates,16 scoped milestones
across10 findings. A34d now prepares an explicitly staged complete source snapshot
for audit/hosted-proof-20260922 under AUTH-MANDALIKA-20260919-01.

E35: A34C-BROWSER-CI-20260921-01 adds ordinary pinned Playwright tests and a
mandatory reusable browser workflow. Registry26/26 pass, zero skips; seven actual
negative gates reject assertion/missing/skip/browser/readiness/network/only failures.
Both strict-loopback Vite processes and Chromium exit in positive/negative runs.
Synthetic API/auth only; external requests denied. Shared quality passes347 tests,
with one disclosed existing optional DB-page replay skip; all types/builds/schema
checks pass. Android needs quality/database/backend/browser at caller SHA. No
production business edits. See A34C_VERIFICATION.json and required-scenarios.json.
Implemented / locally verified / ChatGPT review and hosted Ubuntu proof pending.

E34: CG-A34B-POSTGRES-CI-20260921-01-R1 scoped-accepts E33 A34b as implemented
and locally verified. Review checked86 payloads,7 replayed files and CI structure;
it did not rerun PostgreSQL/Docker. Hosted Ubuntu Docker/race remains pending.
Full A34/T29 and all release gates open; A31/T26 resolution preserved. Counts:
44 findings,1 resolved parent,0/8 P0 parents,0 gates,15 accepted milestones across
10 findings. The prior policy-blocked cache cleanup remains local/excluded.

E33: A34B-POSTGRES-CI-20260921-01 adds mandatory reusable PostgreSQL CI:
six fresh PG18.3 fixtures, preserved target guards, named PASS/no-SKIP proof,
finally cleanup, and Android needs quality/database/backend at caller SHA.
Local native six-gate run passes (142 parent/subtest PASS events, zero skips),
five required fail-closed proofs plus data-directory mismatch pass, nine runner
contracts pass. One stale S0c BXGY synthetic fixture and its stock assertion are
corrected to the already-approved disjoint-set contract; no application rule changes.
Docker/hosted/race runtime evidence remains pending; A13/A42 business concurrency
is absent. See A34B_VERIFICATION.json and A34B_GATE_INVENTORY.json. Implemented /
locally verified on native Windows / ChatGPT review and hosted proof pending.

E32: CG-A34A-CI-20260921-01-R1 scoped-accepts E31 A34a deterministic JS/TS CI.
Review independently checks65 manifest payloads,9 replayed source files and
workflow dependencies; it does not rerun runtime checks. Full A34/T29 and all
release gates stay open. A31/T26 remains resolved. Counts:44 findings,1 resolved
parent,0/8 original P0s,0 release gates,14 accepted milestones across10 findings.

E31: A34A-CI-20260921-01 wires one canonical quality:ci command and reusable
GitHub workflow: frozen install, POS/Backoffice/sync/printer tests, six source
checks, excluded app tests/harnesses, both builds and TS API generator drift.
Android signed build needs the same workflow at caller SHA, without signing
secrets. E31 verification/negative outputs and inventory record exact local
coverage and limitations. Implemented/locally verified, review pending; full
A34/T29 and every release gate remain open. Backend workflow is unchanged.

E30: CG-A31-POLLING-20260921-01-R1 accepts and resolves original A31/T26 based
on E29 hook/caller/rendered evidence. Independent review verified59 manifest
payloads,11 replayed source/test files and publication predicates; no runtime
rerun claimed. A31 remains tracked with original evidence. This resolves1/44
parents,0/8 P0s,0 release gates;13 accepted milestones across9 findings. Global
I/O cancellation, POS polling, ad-hoc effects and server snapshots are separate.

E29: A31-POLLING-20260921-01 implements current-generation/latest-started
publication authority in usePolledQuery, including old interval cleanup guards.
63 callers inventoried; five missing outlet dependencies corrected. Real React/
Chromium harness: before 12 failures/1 pass; after 13/13 pass. Actual Reports
success/error outlet-switch races retain B after late 201-row A page completion.
Backoffice 50/50 including retained A26 response replay and app/harness typechecks
pass. See A31_VERIFICATION.json and A31_VALIDATION_MATRIX.md. Locally verified,
ChatGPT review pending; A31/T26 parent and all release gates remain open.

E28: CG-A27-SUMMARY-20260921-01-R1 scoped-accepts E27 double-subtraction
containment within supplied PostgreSQL/handler/no-mutation evidence. Review checks
46 manifest payloads and patch replay, not an independent runtime rerun. Full
A27/T24 and Q09/A28 remain open. Prior A26 and other scoped acceptances stand.

E27: A27-SUMMARY-20260921-01 corrects ReportSummary netSales to completed-only
sales without subtracting already-excluded refunded rows again. All other response
fields, created_at [from,to), scope, handler/cache/parser and API shape unchanged.
Repo-wide consumer trace finds no application screen caller. Same database test
fails six net assertions before and passes all16 scenarios after;15 paired full
orders/items snapshots unchanged; all non-net response fields identical across red
and green. Thirty existing report/pagination tests, affected Go compilation/tests
and app/generated-client types pass. See A27_VERIFICATION.json. Local milestone
review pending; parent A27/T24, Q09/A28 projection and every release gate remain open.

E26: CG-A26-PAGINATION-20260921-01-R1 scoped-accepts E25 pagination completeness
within supplied helper/browser/PostgreSQL/cache evidence. Full A26/T23 remains open
for remaining report/export inventory and qualification. Incoming PROGRAMME_PROGRESS
is owner convenience only, not a competing tracker. Earlier accepted milestones,
all44 priorities and all release gates remain unchanged.

E25: A26-PAGINATION-20260921-01 implements bounded complete pagination across
Reports (CSV and Transactions/XLSX), Dashboard orders/products and POS active/history
recap orders/flows/shifts. Real browser before-fix51/201/1000 all truncated to50.
Shared helper validates metadata, exact page lengths and stable unique IDs; later
failure rejects whole fetch. Recap cohorts cache only when complete; same-storage
failure/reconstruction verified. Existing timestamp order gains stable ID tie-breaks
for four paginated resources. Final POS258/BO50/sync33, types, six Go package checks
and11 fresh isolated PostgreSQL scenarios pass. See A26_VERIFICATION.json and
A26_VALIDATION_MATRIX.md. Local milestone review pending; parent A26/T23 open.
A27/A28 semantics and A31 global race unchanged. No release gate closes.

E24: CG-A23-QUAL-A24-GUEST-20260921-01-R1 scoped-accepts E22 target/browser
qualification within supplied limits (native remains open) and E23 guest containment.
Earlier mapper/envelope/LP05/fulfillment/semantic scoped acceptances remain. No
historical tests relabeled current; full A23/T21, A24/T22 and all release gates open.

E23: A23-QUAL-A24-GUEST-20260921-01 implements A24 ordinary guest capture.
Actual browser entry regression fails before and passes after removing the blanket
customer gate/hint. Customer-specific code validation remains; capture removes an
ineligible code and requires reconfirmation, retaining unrelated generic selection.
Guest identity remains null; no fabricated customer or loyalty entitlement. Existing
customer cleanup removes reward lines/redemption; final capture defensively refuses
stale guest loyalty. Browser cash/QRIS, generic/restricted codes, customer clear,
registered/add-customer, receipt and same-storage reconstruction pass. POS250,
BO19, sync33, printer7, types and seven Go packages pass. Six fresh real PostgreSQL
null-customer/registered cases plus47 prior promotion scenarios pass (53 total).
Parent A24/T22 and release gates remain open; attachment/correction is not implemented.

E22: Actual Chromium authoring/picker qualification passes with synthetic API data;
invalid authoring emits no mutation request, distinct variants save, duplication/
toggle preserve semantic config. Direct/linked bundle and BXGY cancel/confirm,
takeover, individual removal, clear, participant invalidation, legacy refusal and
captured physical/usage metadata pass. Read-only deployed-catalog preflight scans1
row, no semantic findings (A24_PREFLIGHT_TARGET.json); this is not full schema or
catalog validation. Role-capability probe timed out; transaction is enforced READ
ONLY. Binary SHA matches a build of current source. Android tools present but no
connected device or configured AVD; native qualification unavailable. A23/T21 open.

E21: CG-A23-SEMANTIC-KEYS-20260921-01-R1 scoped-accepts E20 semantic-key
validation within supplied authoring/runtime/database evidence. Earlier E15 mapper /
envelope, E17 LP05 and E19 linked-fulfillment acceptances remain. AUTH-MANDALIKA-
20260919-01 applies. All original IDs, priorities, decisions and release gates remain.
E20 and older entries below describe their own historical milestones unchanged.

E20: A23-SEMANTIC-KEYS-20260921-01 implements semantic disjoint-key validation
across shared TS authoring/POS and Go write/runtime/preflight paths. Twelve shared
vectors cover whole/variant overlap, exact overlap, distinct variants/products,
case/prefix distinctions and existing empty-set BXGY modes. Before-fix Go authoring /
runtime and POS regressions failed; final POS241, Backoffice19, sync33, both app
and explicit new-test types, affected Go packages pass. Isolated PostgreSQL18.3:
22 Create/Update authoring vectors, eight online rejections with unchanged business
rows, eight offline captures retaining original quantity/price/warnings and retry
identity, eight prior valid fulfillment cases and one read-only diagnostic pass.
Preflight flags active/inactive legacy overlap; actual CLI reports two intentionally
invalid synthetic rows among14. No live catalog checked. Both new clusters stopped
and retained. Source/results/limits: SK_VALIDATION_MATRIX.md / SK_VERIFICATION.json.
This is local verification pending ChatGPT review, not parent or release closure.

E19: Owner-relayed ChatGPT acceptance on 2026-09-21 scoped-accepts E18 linked
bundle/BXGY fulfillment within its supplied evidence limits. No separate reply file
or reply ID was supplied this turn; do not invent one. The same relay resolves
Q-LF-01: slots and explicit BXGY buy/get sets already must be semantically disjoint.
Original specs, write validators, first-slot service assumptions and picker confirm
this. Reject overlapping coverage; do not build an overlapping-slot allocator.
P means all P variants; P|M means exactly M. Preserve distinct P|M/P|L, old queues,
physical facts, the impossible-move guard and Q08. E20 implements this bounded
validation class. Earlier evidence entries remain historical milestone records;
E19/E20 and the detailed A23 row are current. A23/T21 and all release gates stay open.

E18: A23-LINKED-FULFILLMENT-20260920-01 implements linked bundle/separate-set
BXGY fulfillment with raw code selection/usage ownership and promotion-ID physical
ownership. Six entry regressions fail before and pass after; two additional
stale-choice/overclaim regressions fail then pass with local commit guards. Final
27 focused tests, POS231/231, sync33/33, app/explicit test types and affected Go
packages pass. Real generated client order fixtures pass eight isolated PostgreSQL
18.3 cases: direct/batch requests x direct/code ownership x BXGY/bundle, correct
goods/prices/grants and code-only usage; two same-key/body retries preserve full
business rows and acknowledge the original key. Forty-five existing migrations
applied only to fresh empty synthetic clusters; both stopped/retained. No backend
production edit, live data, historical queue rewrite or A29 compression. Matrix,
exact commands and limitations: LF_VALIDATION_MATRIX.md / LF_VERIFICATION.json.
Pure planner/reducer and source-wired picker cancellation, not browser/native E2E.
Underlying overlapping-slot allocation remains open (Q-LF-01); impossible freed
unit claims are contained before current sale mutation. Full A23/T21 stays open.

E17: CG-A23-LP05-20260920-01-R1 scoped-accepts E16 LP05 identity containment.
READ_FIRST then named review read in full; four incoming payload hashes verified.
Independent review verified 63 prior manifest payloads, packet identity, diff replay
and static wiring, not a rerun of Windows/SQL suites. Q-LP05-02 answered Option A:
linked code owns selection/usage; promotion ID owns physical effects; no fake
direct entry; shared allocation/pickers with atomic confirm/removal/takeover.
E18 implements that bounded contract. A23/T21, all parent findings and release
gates remain open. Earlier evidence entries retain their milestone-specific
results/review-pending wording; E17/E18 and detailed rows are current.

E16: A23-LP05-20260920-01 implements the reviewed direct-first identity contract
in current-draft selection, pricing and new-order metadata. The real selection /
reducer / pricing regression first failed 7 of 10 assertions; all original ten
now pass, with 23 final LP05 tests. Final POS 204/204, sync 33/33, POS app and
explicit LP05 test typechecks pass. Sixteen unchanged shared Go tier goldens pass.
Successful synthetic KV plus actual SyncEngine.enqueue/reconstruction asserts
effective IDs/codes/breakdown/label and preserves an original parked duplicate
sale's identity, body, timestamps, attempts and error. No DB usage-counter, browser,
native durability or full linked bundle/BXGY execution claim. See LP05_VALIDATION_MATRIX.md
and LP05_VERIFICATION.json. LP05 implemented/locally verified; current ChatGPT
review pending. Full A23/T21 remains open.

E15: CG-S0D-ENVELOPE-A23-20260920-01-R1 scoped-accepts E13 outer-envelope
containment and E14's narrow tieredConfig mapper. Named response read in full
after READ_FIRST; all four incoming manifest payloads verified. ChatGPT's independent
artifact/static review is not a rerun of Windows/DB suites. A43/T25 (including
post-commit readback), A23/T21 and all release gates remain open. Q-LP05-01 is
answered by its direct-first stable-ID contract, implemented at E16. Evidence
entries below preserve their historical outcomes and review-pending statements
at that milestone; E15/E16 and the finding rows are the current dispositions.

E14: S0D-ENVELOPE-A23-20260920-01, A23 mapper only. LP01 reproduced through
decideApplyCode -> AppliedPromoCode -> linkedPromoShape -> computePricing: direct
90000, linked 100000; both now 90000. Three production lines carry tieredConfig.
Sixteen shared Go/TS golden cases pass; final POS 181/181 and app plus explicit
new-test typechecks pass. LP05 broader cross-selection probe FAILS: the same
combinable promotion selected directly and by code totals 80000, while source
resolvePromos deduplicates by promotion ID. This is an unresolved A23/T21 gap,
not an accepted stacking policy. Probe source/output retained as review evidence,
separate from the 181 passing tests. See Q-LP05-01 in current packet. Mapper locally
verified/review pending; do not mark LP05 or full A23/T21 passed.

E13: S0D-ENVELOPE-A23-20260920-01, outer-envelope corrective implementation.
Same real-handler raw-body regression: 26 failures / 8 passes before, all 34 pass
after complete structural parsing. Real JWT/caller/ProcessBatch on isolated
PostgreSQL 18.3 with 45 existing migrations: 34 rejected raw envelopes preserve
ten full-row business snapshots; four positive/auth/mixed control groups pass.
Affected Go suites, sync 33/33, pre-mapper POS 160/160 and API/sync/POS types pass.
New whole-request rejection tests retain original keys/payloads through parking,
repeat diagnostics, same-KV reconstruction and manual retry. BE01–11 mapping and
limitations: BE_LP_VALIDATION_MATRIX.md. Fixture stopped/retained, old cleanup
block not retried. Corrective work locally verified; ChatGPT re-review pending.

E12: CG-S0D-SHIFT-DECODE-20260920-01-R1 requests changes to complete S0d.
All 22 incoming manifest payloads match. The independent lab uses copied functions
with stubs, not project replacement code or SQL evidence. Direct/inner shift
results stand; prior SD05/SD07 did not cover complete outer envelope exhaustion
or duplicate command metadata. E13 supplies new tests rather than rewriting E11
logs or historic counts. Full A43/T25, post-commit uncertainty and gates stay open.

E11: S0D-SHIFT-DECODE-20260920-01, same root/branch/HEAD, incremental source
and documentation diffs against the preserved S0c worktree. Four before-fix direct
handler assertions reproduced mutation calls on malformed input; the same
assertions now pass. Shared direct/batch shift decoding, real authenticated
handlers/services/readback on isolated PostgreSQL 18.3 with 45 existing migrations,
full-row no-effect comparisons, optional/zero compatibility and mixed results pass.
Affected Go suites, sync 31/31, POS 160/160 and API/sync/POS type checks pass.
See S0D_SHIFT_VALIDATION_MATRIX.md and S0D_VERIFICATION.json for test layers,
commands and limits. A43 shift-decode subtask is locally verified, review pending;
readback uncertainty, other financial decoders and full A43/T25 remain open.

E10: CG-S0C-20260920-01-R1 accepts A09-input-numeric within S0C-20260920-01's
evidence limits. Current reply and READ_FIRST resolved in review-inbox; all 14
manifest payloads verified. ChatGPT's independent artifact checks and isolated
Go 1.23 validator/pricing tests are not the Windows project suite or PostgreSQL
qualification. Q-S0c-01/02 technical directions are recorded in the decision
draft; neither larger redesign is implemented by this slice. Full A09/T07 and
all release gates remain open. The original S0c bundle is preserved unchanged.

E09: S0C-20260920-01, 2026-09-20, same root/branch/HEAD plus S0C_IMPLEMENTATION.diff.
Fresh shared service input/derived checks, real direct/batch decoding and unchanged
trusted caller mapping. C01 failed before guards (four negative/zero cases reached
the stock write) and passes after; focused affected Go packages, sync 29/29, POS
160/160 and both typechecks pass. Opt-in integration passes on an isolated local
PostgreSQL 18.3 database with all 45 existing migrations and synthetic rows:
rejected direct/batch quantities and direct negative money leave order/item/stock/
customer/code/points/grant/receipt rows unchanged; valid cash/custom noncash/free/
full-discount/static-bundle/BXGY/bundle flows, mixed-batch denial, shortage and
committed same-key retry exercised. See S0C_VALIDATION_MATRIX.md and S0C_VERIFICATION.json
for exact layers and limits. No native durability, payment-provider, Redis replay,
race, deployment or release qualification. A09-input-numeric is implemented and
locally verified at E09; subsequent scoped review acceptance is E10. Full A09/T07 remains open.

E08: CG-S0B-20260919-01-R2 accepts A06-permission-parity only within supplied
S0B-20260919-01 evidence. Read current inbox READ_FIRST, authority companion and
reply in order; all six manifest payloads match. The review's independent checks
cover source/diff/manifest and an isolated Go 1.23 helper test, not the Windows
backend suite or real refund SQL. Full A06/T06, historical recovery and release
gates remain open. AUTH-MANDALIKA-20260919-01 is now the standing authority for
all A01–A44 phases; it supersedes historical routine slice-approval limits, not
business decisions, unresolved Q01–Q10 choices or evidence/release requirements.

E07: S0B-20260919-01, 2026-09-19, same root/branch/HEAD plus
S0B_IMPLEMENTATION.diff. Owner's explicit S0b-only authorization supersedes the
approval-pending statements in CG-S0B-20260919-01-R1. The exact authenticated
request/token permission predicate is shared by direct middleware and trusted
batch mapping; each denied refund returns an error under its original key before
refund service invocation. No claim of immediate revocation or capture authority.
Before-fix regression reproduced direct denial versus one batch refund seam call;
the same assertion passes after containment. Focused Go suites, sync 28/28 and
POS 160/160 pass with installed tooling; type checks pass. Synthetic UI verifies
five denials, two exports, panel close/reopen, same-KV reconstruction and original-key
manual retry. Full commands, limitations and 14-scenario mapping are in
S0B_VERIFICATION.json and the current AUDIT_REVIEW_PACKET.md. Fake mutation guards
are not PostgreSQL effect tests; successful KV is not native power-loss evidence.
At the E07 milestone A06-permission-parity was implemented/locally verified and pending review; E08 records subsequent acceptance;
A06/T06 overall, historical recovery and every release gate remain open.

E06: CG-S0A-20260919-01-R1, responding to S0A-20260919-01, accepts A02-export
for scoped containment and resolves the prior missing-document-artifact limitation.
Resolved inbox: `review-inbox/CG-S0A-20260919-01-R1/`. It initially had a space
in its name; the folder was externally renamed during this documentation turn.
The reply and all four inbox files still match their original manifest hashes.
Current reply was read in full before documentation edits; dependencies exist.
All ten reviewed source/test/harness files still match the accepted bundle hashes.
That documentation-integration turn changed documents only and reran no application tests. ChatGPT's checks
were transfer/diff/source review; its acceptance is not independent runtime,
native-device or release qualification. See S0A_REVIEW_INTEGRATION_EVIDENCE.json.

E01–E04 below describe documentation milestone MA-20260919-01, before S0a.
E05 records the later owner-authorized S0a diff and fresh checks. Original source
anchors remain baseline anchors where edited files have shifted; see E05/diff
for current export locations. No historical runtime result is relabelled current.

E01: `git branch --show-current`, `git rev-parse HEAD`, `git status --short`,
`git diff --stat`: same HEAD; no tracked application changes on entry. Packet,
evidence archives and two readiness documents were untracked; preserved.
E02: Python hashlib SHA-256 comparison against source_fingerprints.json for every
non-readiness-document source cited below: **all matched exactly** before edits.
Current fingerprint comparison is fresh; audit diagnostics and behavior are not.
E03: current focused reads of engine.ts:252–363, transfer.go:225–304,
stockcount.go:133–287, writes.go:1056–1098 and sync/package.json. Source-confirmed
observations below do not mean runtime reproduction. All other rows explicitly
require behavioral/source-path revalidation before implementation/closure.
E04: document structural/coverage checks recorded in the handoff. No application
suite, D01–D09, database race, Android, dependency advisory, provider, restore or
release check run for that documentation milestone. Tests below are requirements,
not passes; only the explicit S0a/S0b subsets under E05/E07 have execution evidence.

E05: S0A-20260919-01, 2026-09-19, same root/branch/HEAD plus S0A_IMPLEMENTATION.diff.
Caller trace completed before edits. Corrected D03 regression failed on old source
(4 failures / 1 pass), then 5 focused sync and 7 focused POS cases passed.
Full relevant suites: sync 25/25, POS 160/160; package typechecks, explicit POS
test/harness typecheck and Vite build pass. A new test mock caused one intermediate
typecheck failure, corrected and rechecked. Browser synthetic SyncStatus panel:
5 exports, 2 retained/unchanged/reconstructed failures, close/reopen verified.
See S0A_VERIFICATION.json for commands, cwd, exit statuses, warnings and limitations.
No native durability, live API/device, real OS sharing, DB or release verification.

Historical evidence class and required acceptance are preserved per row from
AUDIT_REPORT.md/findings.json. Original line references were checked for file
identity by E02; they are valid source anchors, not new runtime verification.
At MA-20260919-01 entry no source-level fix newer than the packet was found among cited files.
S0a changed the export path; S0b adds bounded refund-permission containment; S0c adds numeric/structural sale containment; S0d adds shift-input containment.
Shared source files no longer all hash-match the original audit. Original reconciliation
hashes in AUDIT_RECONCILIATION_EVIDENCE.json remain historical; subsequent artifacts
are keyed to E05/E07/E09/E11 and must not be represented as a full-audit retest. Historical
feature completions remain preserved in SESSION_HANDOFF.md/PHASE_HANDOFF.md;
none is reset merely because audit acceptance is broader.

Every slice owner is Codex for execution under standing
[AUTH-MANDALIKA-20260919-01](PROGRAMME_EXECUTION_AUTHORITY.md), ChatGPT for review,
and the owner for genuinely unresolved business/scope/risk/release decisions.
No routine phase/slice reapproval is required. S0a/S0b scoped containment is reviewed
accepted, including S0c A09-input-numeric under E10. S0d-shift-decode is locally
verified and review pending under E11.
Other designs retain their proposed/implemented/evidence states; broad authority
does not establish their correctness. S0docs remains a historical documentation milestone.
Original P0s gate the affected real-money pilot. P1s gate affected production
workflows; P2s require resolution or explicit justified exception; P3 gates a
trustworthy handoff. Optional loyalty deferral requires an enforced disabled
release scope; current deployed flag is unknown, not claimed disabled.

Coverage after reconciliation: each row is explicitly included by reference in
plan §Full-audit programme and draft §September 19 full-audit adoption. The
section mappings below identify the narrower existing text; where only broad
workstream text exists, that is **partial detail**, not a complete design.
No finding is closed by adding documentation. Acceptance inherits the entire
original audit paragraph plus the refined A04/A14 contracts, not just test IDs.

## Index and original P0 dispositions

| ID | Original priority | Slice | Disposition | Tests |
|---|---|---|---|---|
| A01 | P0 | S1 | Needs current behavioral revalidation; source matches audit | T01 |
| A02 | P0 | S0a | Open; A02-export scoped review accepted; retry/retention gaps remain | T02 (export subset only verified) |
| A03 | P0 | S1 | Source-confirmed open; runtime unverified | T03 |
| A04 | P0 | S1 | Needs current behavioral revalidation; source matches audit; clarified design / owner decisions pending | T04a–T04e |
| A05 | P1 | S1 | Needs current behavioral revalidation; source matches audit | T05 |
| A06 | P0 | S0b | Open; permission-parity subtask reviewed/accepted within E08 limits | T06 (containment subset only) |
| A07 | P1 | S1 | Needs current behavioral revalidation; source matches audit | T05 |
| A08 | P1 | S1 | Needs current behavioral revalidation; source matches audit | T06 |
| A09 | P0 | S0c | Open; input/numeric containment scoped review accepted | T07 (C01–C12 bounded evidence) |
| A10 | P1 | S1 | Needs current behavioral revalidation; source matches audit | T07 |
| A11 | P0 | S1 | Needs current behavioral revalidation; source matches audit | T08 |
| A12 | P1 | S3 | Needs current behavioral revalidation; source matches audit | T09 |
| A13 | P0 | S3 | Source-confirmed open; runtime unverified | T10 |
| A14 | P1 | S3 | Source-confirmed open; runtime unverified; clarified design / owner decisions pending | T11a–T11n; I01–I23 (including original T11 replay) |
| A15 | P1 | S2 | Needs current behavioral revalidation; source matches audit | T12 |
| A16 | P1 | S3 | Needs current behavioral revalidation; source matches audit | T13 |
| A17 | P1 | S3 | Needs current behavioral revalidation; source matches audit | T12 |
| A18 | P1 | S4 | Needs current behavioral revalidation; source matches audit | T14,T15 |
| A19 | P1 | S4 | Needs current behavioral revalidation; source matches audit | T15,T16,T17 |
| A20 | P1 | S5 | Needs current behavioral revalidation; source matches audit | T18 |
| A21 | P1 | S5 | Needs current behavioral revalidation; source matches audit | T19 |
| A22 | P1 | S5 | Needs current behavioral revalidation; source matches audit | T20 |
| A23 | P1 | A23 promotion parity and qualification | Open; mapper/LP05/fulfillment/semantic validation scoped accepted; E24 target/browser scoped accepted; native residual | T21 |
| A24 | P1 | A24 guest-sale containment (S0e) | Locally verified; scoped accepted E24; parent/attachment/release open | T22 |
| A25 | P1 | S5 | Needs current behavioral revalidation; source matches audit | T22 |
| A26 | P1 | A26-pagination-completeness | Open; E26 scoped ChatGPT acceptance; remaining inventory/qualification | T23 |
| A27 | P1 | A27-summary-double-subtraction | Open; E28 scoped ChatGPT acceptance of E27; Q09/A28 separate | T24 |
| A28 | P1 | S1 | Needs current behavioral revalidation; source matches audit | T24 |
| A29 | P1 | S1 / promotion-resource-safety | Open; resource/error direction recorded, implementation unverified | T25 |
| A30 | P1 | S1 | Needs current behavioral revalidation; source matches audit | T04a–T04e,T06 |
| A31 | P2 | A31-polling containment (S0g) | Resolved; E30 ChatGPT acceptance of original stale-scope race | T26 |
| A32 | P1 | S6 | Needs current behavioral revalidation; source matches audit | T27 |
| A33 | P1 | S6 | Needs current behavioral revalidation; source matches audit | T28 |
| A34 | P1 | A34a–e8 accepted; A34e9 PostCSS patch | Open; E56 accepts Nano ID; E57 PostCSS locally verified, hosted/review pending; other gates remain | T29 |
| A35 | P1 | S6 | Needs current behavioral revalidation; source matches audit | T29,T30 |
| A36 | P1 | S6 | Needs current behavioral revalidation; source matches audit | T31 |
| A37 | P1 | S0i | Needs current behavioral revalidation; source matches audit | T32 |
| A38 | P2 | A34e–e7 / S6 | Open; E56 Nano ID accepted; E57 PostCSS removes1blocker/1report locally; unrelated blockers remain | T33 |
| A39 | P2 | S0j | Needs current behavioral revalidation; source matches audit | T32 |
| A40 | P3 | S0docs | Documentation improved; broader documentation acceptance not closed | A40 audit acceptance (no dedicated T ID) |
| A41 | P1 | S2 | Needs current behavioral revalidation; source matches audit | T30 |
| A42 | P1 | S1 | Needs current behavioral revalidation; source matches audit | T34 |
| A43 | P1 | S0d-shift-decode / batch-envelope | Open; outer-envelope correction scoped accepted; readback/broader intake remain | T25 |
| A44 | P1 | S1 | Needs current behavioral revalidation; source matches audit | T07 |

The original P0 set is **A01 A02 A03 A04 A06 A09 A11 A13**. A02-export is contained
and locally verified; the parent A02 retry/retention requirements remain open.
A03 remains a source-confirmed destructive path; A13 remains a source-confirmed concurrency
risk. A06-permission-parity is reviewed under E08, and A09-input-numeric under E10;
full A06/T06 and A09/T07 remain open. A01/A04/A11 and the remaining A09 requirements
still require their own current behavioral verification. No original P0 group is fully verified fixed, demoted or excepted. A04's
routine switching scenario is superseded, **not its P0 safeguards**.

## Per-finding traceability

### A01 — A successful local capture is not a durable commit

- **Original priority / evidence:** P0; historical class: Reproduced; native path also confirmed statically.
- **Current disposition:** Needs current behavioral revalidation; source matches audit. E02 establishes file continuity only; historical diagnostics were not rerun.
- **Current evidence:** E01/E02 (2026-09-19, local HEAD above); `packages/sync/src/storage.ts:5-48`; `packages/sync/src/storage.ts:65-129`; `packages/sync/src/outbox.ts:50-64`. No relevant uncommitted application changes at entry. See E03 for selectively re-read paths.
- **Authority / decision:** AUDIT_REPORT A01 and PLAN_ADDENDUM are analysis/proposed mechanisms; existing user-approved draft policies remain authoritative. Review packet: no additional owner question identified; technical review under the shared workflow.
- **Plan coverage:** explicit programme inclusion in plan §Full-audit programme → this row; workstream Device journal. **Draft mapping:** §Approved reliability direction (broad text alone remains partial design detail). Original source coverage labels are historical, not reused as current completeness scores.
- **Dependencies / slice:** A04,A11,A35,A41; proposed S1. Owner: Codex implementation / ChatGPT review / owner consequential approvals. Migration/compatibility: journal schema and old queue migration.
- **Required result:** Implement the approved transactional SQLite journal, with awaited commit and explicit failure before a successful capture indication. Migrate old queues non-destructively with resumable verification. Separate secrets from business-journal storage; do not relabel app-sandbox Preferences as a transactional or encrypted database.
- **Acceptance:** T01. Kill the app before commit, after commit, before acknowledgement, and during migration; inject full disk and malformed stored data. No successful capture may vanish; failures must not silently create a new empty ledger.
- **Execution / residual risk:** E04; application tests not run, no implementation commit/PR or release artifact. Behavior/concurrency/device applicability must be verified in its actual environment. Original priority release rule above applies; no approved exception recorded.

### A02 — Transport failures can park financial events; destructive export now contained

- **Original priority / evidence:** P0; historical class: Reproduced.
- **Current disposition:** Parent open. A02-export implemented, locally verified by Codex (E05), reviewed/accepted by ChatGPT for scoped containment (E06); no release closure. Transport catch still fails each batch item and MAX_ATTEMPTS remains five.
- **Current evidence:** E05 and S0A_IMPLEMENTATION.diff; `packages/sync/src/engine.ts` buildFailedSyncDiagnostics copies JSON data before redaction, writes only the separate support log, returns diagnostic text; bulk export discard removed from `outbox.ts`. `useOfflineData.ts`, `CashierScreen.tsx`, `SyncStatus.tsx`, new `lib/failedSyncDiagnostics.ts` preserve unresolved state. E01–E03 retain the pre-fix evidence; current hashes in reconciliation JSON.
- **Authority / decision:** Owner message "OWNER AUTHORIZATION — S0a ONLY", after CG-MA-20260919-01-R1 §5. No Q01–Q10 policy implementation or broader A02/A37 approval.
- **Plan coverage:** explicit programme inclusion in plan §Full-audit programme → this row; workstream Operation delivery. **Draft mapping:** §Approved reliability direction (broad text alone remains partial design detail). Original source coverage labels are historical, not reused as current completeness scores.
- **Dependencies / slice:** A01,A29,A37 remain parent dependencies, not prerequisites to authorized export containment. S0a implemented and scoped review accepted; existing queue/storage format preserved, no migration. Owner retains further scope/release decisions.
- **Required result:** Retry transient transport/infrastructure failures without permanently abandoning the event. Use explicit pending/review/accepted states. Export diagnostics without deleting the underlying event. Permit only audited resolutions that retain original evidence.
- **Acceptance:** T02. After a long outage, malformed gateway response, support-log export and device restart, every captured sale/refund still has a recoverable journal entry and visible state.
- **Execution / residual risk:** E05; original T02 is only partially satisfied. No commit/PR/deployment. A01 native durability, A02 retry classification/retention model, A03 receive discard and A37 broader secret handling remain unresolved. Support log alone is capped at 200; returned text includes all failed entries and has no new size cap. Original P0 gate remains.

#### A02-export — S0a acceptance record

Accepted under CG-S0A-20260919-01-R1 for this subtask only. Parent A02, full T02,
A01/A03/A37, all other findings and all release gates remain open.

| Requirement | Evidence / boundary |
|---|---|
| S0a-01/02: repeated export and reconstruction | Five-attempt synthetic sale/refund; exact IDs/payloads/status/attempt/error/sequence/time and persisted outbox bytes unchanged; reconstructed Outbox and engine use the same successful KV. |
| S0a-03: delivery and close | Share success/cancel/reject, clipboard success/failure, unsupported delivery and formatter failure covered. Actual panel close/reopen checked in browser harness. No standalone download control exists; no new one added. OS sharing targets themselves were not exercised. |
| S0a-04/08: detached redaction | Deep-frozen nested synthetic queue remains unchanged; top-level PIN redaction preserved; returned JSON/log modifications cannot alias it. Ack/fail/prune/discard/retry/add spies silent during export. Not a complete A37 redaction audit. |
| S0a-05: truncation | Three exports of 205 operations keep all operations/output entries; only existing support log is capped to 200. |
| S0a-06: unresolved visibility | Rendered online/offline badge counts preserved; browser details retained before/after export and close/reopen; no false all-synced state. |
| S0a-07: deliberate retry | Post-export manual retry submits original keys and full original payloads; normal successful ack/prune remains unchanged. |

Background delivery is disabled in isolation fixtures. Legitimate independent
acknowledgement can still change queue state in the real app; export cannot.

### A03 — Every per-item transfer-receive error is treated as a permanent competing receipt

- **Original priority / evidence:** P0; historical class: Reproduced.
- **Current disposition:** Source-confirmed open; runtime unverified. engine.ts transfer_receive non-success branch unconditionally discards receipt.
- **Current evidence:** E01/E02 (2026-09-19, local HEAD above); `packages/sync/src/engine.ts:306-335`. No relevant uncommitted application changes at entry. See E03 for selectively re-read paths.
- **Authority / decision:** AUDIT_REPORT A03 and PLAN_ADDENDUM are analysis/proposed mechanisms; existing user-approved draft policies remain authoritative. Review packet: no additional owner question identified; technical review under the shared workflow.
- **Plan coverage:** explicit programme inclusion in plan §Full-audit programme → this row; workstream Reconciliation. **Draft mapping:** §Offline conflict policy (broad text alone remains partial design detail). Original source coverage labels are historical, not reused as current completeness scores.
- **Dependencies / slice:** A02,A11,A29; proposed S1. Owner: Codex implementation / ChatGPT review / owner consequential approvals. Migration/compatibility: versioned error contract and legacy client handling.
- **Required result:** Use stable error codes and separate retryable transport failure, authorization review, competing receipt and accepted outcome. Keep the captured receipt and any physical-goods evidence independently of its provisional inventory credit.
- **Acceptance:** T03. A temporary database failure stays retryable; a competing receive enters review with the correct reason; neither disappears from the journal.
- **Execution / residual risk:** E04; application tests not run, no implementation commit/PR or release artifact. Behavior/concurrency/device applicability must be verified in its actual environment. Original priority release rule above applies; no approved exception recorded.

### A04 — Fixed terminal binding, original attribution and authenticated recovery

- **Original priority / evidence:** P0; historical class: Confirmed static path; end-to-end scenario not executed.
- **Current disposition:** Needs current behavioral revalidation; source matches audit; clarified design / owner decisions pending. E02 establishes file continuity only; historical diagnostics were not rerun.
- **Current evidence:** E01/E02 (2026-09-19, local HEAD above); `packages/sync/src/engine.ts:170-185`; `packages/sync/src/outbox.ts:1-64`; `backend/internal/sync/sync.go:158-223`; `apps/pos/src/components/OutletSwitcher.tsx:32-58`; `apps/pos/src/auth.tsx:39-53`. No relevant uncommitted application changes at entry. See E03 for selectively re-read paths.
- **Authority / decision:** AUDIT_REPORT A04 and PLAN_ADDENDUM are analysis/proposed mechanisms; existing user-approved draft policies remain authoritative. U04/U14 and template business intent are user-confirmed via linked clarifications; implementation mechanics remain proposed. Review packet: Q01.
- **Plan coverage:** explicit programme inclusion in plan §Full-audit programme → this row; workstream Authorization. **Draft mapping:** §Requirements carried forward (broad text alone remains partial design detail). Original source coverage labels are historical, not reused as current completeness scores.
- **Dependencies / slice:** A01,A05,A07,A08,A30,A41; proposed S1. Owner: Codex implementation / ChatGPT review / owner consequential approvals. Migration/compatibility: registration generations and envelope compatibility.
- **Required result:** Bind the registered device/account to its fixed outlet, with no ordinary POS logout or outlet switching. Capture original registration generation, outlet, actor, shift, sequence, schema and authorization evidence; enforce compatible scope server-side. Preserve original attribution and pending operations through token refresh and authenticated Backoffice recovery rather than replacing them with the delivery caller. Human/shift/TL identity questions remain explicitly unresolved under Q01/Q03; no new login mechanics are inferred.
- **Acceptance:** T04a: POS UI/direct/batch incompatible scope rejected while legitimate Backoffice scope remains available. T04b: offline capture, reboot, refresh and delivery retain original registration/account/outlet/shift and one receipt/effect. T04c: rotation/revocation preserves pending evidence and separates new authority from historical recovery. T04d: replacement-device recovery retains original event IDs and distinct enrollment generation without a silent operational clone. T04e: existing shift authentication and required TL identity remain enforceable without ordinary logout/switching; unresolved human interaction is not invented.
- **Execution / residual risk:** E04; application tests not run, no implementation commit/PR or release artifact. Behavior/concurrency/device applicability must be verified in its actual environment. Original priority release rule above applies; no approved exception recorded.

**Historical reference only:** AUDIT_REPORT A04 / PLAN_ADDENDUM T04 described
routine POS logout/outlet switching. That scenario is superseded by U04 and
T04a–e above; the original audit inputs remain unchanged. Legitimate Backoffice
selection and A31 remain separate. No underlying P0 attribution/scope/recovery
safeguard is removed, and shared terminal identity is not fresh TL approval.

### A05 — Authentication startup conflicts with offline shift recovery

- **Original priority / evidence:** P1; historical class: Confirmed static.
- **Current disposition:** Needs current behavioral revalidation; source matches audit. E02 establishes file continuity only; historical diagnostics were not rerun.
- **Current evidence:** E01/E02 (2026-09-19, local HEAD above); `apps/pos/src/auth.tsx:14-17`; `apps/pos/src/auth.tsx:55-75`; `apps/pos/src/main.tsx:1-26`; `apps/pos/src/hooks/useShift.ts:1-102`. No relevant uncommitted application changes at entry. See E03 for selectively re-read paths.
- **Authority / decision:** AUDIT_REPORT A05 and PLAN_ADDENDUM are analysis/proposed mechanisms; existing user-approved draft policies remain authoritative. Review packet: Q01,Q03.
- **Plan coverage:** explicit programme inclusion in plan §Full-audit programme → this row; workstream Authorization. **Draft mapping:** §September 15 consolidated policy clarification (broad text alone remains partial design detail). Original source coverage labels are historical, not reused as current completeness scores.
- **Dependencies / slice:** A04,A07; proposed S1. Owner: Codex implementation / ChatGPT review / owner consequential approvals. Migration/compatibility: session bootstrap and offline authority migration.
- **Required result:** Resolve storage only after initialization. Distinguish invalid/revoked credentials from temporary inability to refresh. Persist and validate a shift-bounded offline capability and current shift evidence; a new shift still requires online authentication as approved.
- **Acceptance:** T05. Offline reboot during an already-authorized shift resumes only that permitted scope. New-shift login, revoked credentials and expired authority remain restricted, while recorded facts are retained.
- **Execution / residual risk:** E04; application tests not run, no implementation commit/PR or release artifact. Behavior/concurrency/device applicability must be verified in its actual environment. Original priority release rule above applies; no approved exception recorded.

### A06 — Refund permission is enforced on one route but bypassed by sync

- **Original priority / evidence:** P0; historical class: Confirmed static.
- **Current disposition:** A06-permission-parity implemented, locally verified and reviewed/accepted by CG-S0B-20260919-01-R2 within E08 limits. Full A06/T06 and historical-refund recovery remain open.
- **Current evidence:** E07/E08 and exact S0B_IMPLEMENTATION.diff; `auth/permissions.go:HasPermission`, `middleware/middleware.go:RequirePermission`, `handlers/writes.go:syncBatch`, `sync/sync.go:processOneWithRefund`. Existing `server/server.go` routes and `service/order.go:Refund` scoped transaction are unchanged. Full paths and after-images supplied in S0B-20260919-01 bundle. Baseline E01/E02 is historical, not post-fix verification.
- **Authority / decision:** AUDIT_REPORT A06 and PLAN_ADDENDUM are analysis/proposed mechanisms; existing user-approved draft policies remain authoritative. CG-S0B-20260919-01-R1 answers Q-S0b-01 with bounded Option A. Owner subsequently supplied "OWNER AUTHORIZATION — S0b ONLY" for local implementation/tests; packet S0B-20260919-01 records the exact authority. That slice did not approve Q01–Q10 or production release. Current standing authority is AUTH-MANDALIKA-20260919-01; actual release conditions remain required.
- **Plan coverage:** explicit programme inclusion in plan §Full-audit programme → this row; workstream Authorization. **Draft mapping:** §Offline conflict policy (broad text alone remains partial design detail). Original source coverage labels are historical, not reused as current completeness scores.
- **Dependencies / slice:** A04,A08,A30; S0b permission-containment only implemented under E07, remaining shared-command work remains open under standing authority. Owner: Codex implementation / ChatGPT review / owner consequential approvals. Migration/compatibility: shared command authorization; preserve old captured facts.
- **Required result:** Move operation authorization, scope and material input rules into a shared command boundary used by both transports. Preserve an offline cash fact when authorization reconciliation needs review; do not silently treat an invalid request as an approved entitlement.
- **Acceptance:** T06. For each role, exercise direct and batch variants of every mutation. They must grant/deny the same new authority, with separately tested handling of already-captured offline facts.
- **A06-permission-parity:** Proposed → owner-authorized → implemented → locally verified in S0B-20260919-01; reviewed/accepted within E08 evidence limits. Same token-claim predicate/admin bypass; server-derived capability ignored by JSON decoding; original-key per-item denial before refund mutation; independent batch items preserved. Denied historical operations retain original payload/key/time/sequence and captured fields, through normal attempts/parking/export/reconstruction/manual retry. No new payout or fabricated acknowledgement.
- **Execution / residual risk:** S0b-01–14 coverage and limits remain in historical S0B_VERIFICATION.json and the immutable S0b bundle. Scope/order SQL was read but not exercised against PostgreSQL; handler Store.ByID enrichment and mutation/version dependencies use narrow test seams. No real backend-to-device end-to-end run, native durability, receipt recovery, live revocation or launch evidence. Existing retry lastError may change normally; no complete error journal is added. Reason/body-validation parity (A43), every-role/every-mutation T06, secure capture authority and recovery remain open. No commit/PR/deployment or approved release exception.

### A07 — Refresh rotation and revocation do not have a durable, atomic authority model

Additional bounded residual (E44): harden stored-password parsing with explicit
version/parameter rejection; coordinate with A09. Existing A34e2 characterization
assertions must change with that reviewed contract, not freeze current defects.
No implementation in the SheetJS slice.

- **Original priority / evidence:** P1; historical class: Confirmed static; concurrency/recovery tests pending.
- **Current disposition:** Needs current behavioral revalidation; source matches audit. E02 establishes file continuity only; historical diagnostics were not rerun.
- **Current evidence:** E01/E02 (2026-09-19, local HEAD above); `backend/internal/auth/handlers.go:35-49`; `backend/internal/auth/handlers.go:86-116`; `backend/internal/auth/store.go:105-157`; `backend/internal/middleware/middleware.go:13-59`. No relevant uncommitted application changes at entry. See E03 for selectively re-read paths.
- **Authority / decision:** AUDIT_REPORT A07 and PLAN_ADDENDUM are analysis/proposed mechanisms; existing user-approved draft policies remain authoritative. Review packet: Q03.
- **Plan coverage:** explicit programme inclusion in plan §Full-audit programme → this row; workstream Authorization. **Draft mapping:** §Approved reliability direction (broad text alone remains partial design detail). Original source coverage labels are historical, not reused as current completeness scores.
- **Dependencies / slice:** A04,A05,A33; proposed S1. Owner: Codex implementation / ChatGPT review / owner consequential approvals. Migration/compatibility: durable session families and rotation migration.
- **Required result:** Define durable session families, atomic refresh rotation/reuse handling, token-version or equivalent revocation, and a documented bounded offline authority policy. Redis may accelerate checks but must not be the only authority. Do not solve outages by allowing unauthenticated online writes.
- **Acceptance:** T05. Race refreshes, fail the database write, lose Redis, revoke a role, and reboot offline. Outcomes follow one explicit authority policy without issuing a silently non-durable session.
- **Execution / residual risk:** E04; application tests not run, no implementation commit/PR or release artifact. Behavior/concurrency/device applicability must be verified in its actual environment. Original priority release rule above applies; no approved exception recorded.

### A08 — Offline approval distributes reusable PIN verification material

- **Original priority / evidence:** P1; historical class: Confirmed static.
- **Current disposition:** Needs current behavioral revalidation; source matches audit. E02 establishes file continuity only; historical diagnostics were not rerun.
- **Current evidence:** E01/E02 (2026-09-19, local HEAD above); `packages/sync/src/pin.ts:1-12`; `packages/sync/src/engine.ts:188-204`; `backend/internal/sync/sync.go:125-135`; `backend/internal/read/repo.go:1294-1355`. No relevant uncommitted application changes at entry. See E03 for selectively re-read paths.
- **Authority / decision:** AUDIT_REPORT A08 and PLAN_ADDENDUM are analysis/proposed mechanisms; existing user-approved draft policies remain authoritative. Review packet: Q01,Q03.
- **Plan coverage:** explicit programme inclusion in plan §Full-audit programme → this row; workstream Authorization. **Draft mapping:** §Workstreams and acceptance evidence (broad text alone remains partial design detail). Original source coverage labels are historical, not reused as current completeness scores.
- **Dependencies / slice:** A04,A05,A07,A30,A37; proposed S1. Owner: Codex implementation / ChatGPT review / owner consequential approvals. Migration/compatibility: remove reusable approval material without losing evidence.
- **Required result:** Replace distributed password/PIN verifiers with the approved scoped authorization design; remove raw PINs from retained operation payloads. Define revocation, expiry and step-up evidence appropriate to each approved staff role.
- **Acceptance:** T06. Capture an authorized offline operation without retaining a raw PIN/hash usable for later approvals. Altered scope, stale authority and unauthorized role fail safely without erasing physical-event evidence.
- **Execution / residual risk:** E04; application tests not run, no implementation commit/PR or release artifact. Behavior/concurrency/device applicability must be verified in its actual environment. Original priority release rule above applies; no approved exception recorded.

### A09 — Ordinary sale-line and tender invariants are not enforced at the command boundary

- **Original priority / evidence:** P0; historical class: Confirmed static; no hostile request sent.
- **Current disposition:** A09-input-numeric implemented and locally verified in S0C-20260920-01; scoped review accepted by CG-S0C-20260920-01-R1 (E10). Full A09/T07 remains open, including tender/quote, discretionary permission and legacy recovery.
- **Current evidence:** E09; `service/order_input.go:ValidateSaleInput`, `service/order.go:createOrder`, direct and batch command mappings, focused Go tests and `handlers/sale_input_integration_test.go:TestSaleInputPostgres`; `packages/sync/src/engine.sale-input.test.ts` retains original denied capture. Exact source, before-fix regression, commands/results and limits are supplied in S0C-20260920-01. E01/E02 and original audit line numbers remain historical.
- **Authority / decision:** AUTH-MANDALIKA-20260919-01 and CG-S0B-20260919-01-R2 S0c contract; numeric representation derives from existing integer/numeric schema and producer rounding. Preserve guest/free/reward/bundle/custom-method compatibility and Q08 warning/override. Do not compare historical price to current catalog or invent tender proof. Q-S0c-01/02 technical answers are integrated in the decision draft: captured facts/reconciliation/settlement separation and count-compressed bounded promotion work. Explicit legacy unknowns and unresolved business policy remain; neither redesign implemented here.
- **Plan coverage:** explicit programme inclusion in plan §Full-audit programme → this row; workstream Reconciliation. **Draft mapping:** §Approved reliability direction (broad text alone remains partial design detail). Original source coverage labels are historical, not reused as current completeness scores.
- **Dependencies / slice:** A10,A11,A28,A29,A44; S0c numeric/structural subtask implemented; broader contract and legacy reconciliation remain open. Codex executes under standing authority; ChatGPT reviews consequential design; owner retains unresolved business decisions. No new schema or retry policy in this slice.
- **Required result:** Validate finite/ranged integer quantities, line/tender conservation, supported payment semantics, discretionary permissions and historical quote evidence. Separate accepting a genuine captured fact into review from granting new sale authority to a malformed or forged command.
- **Acceptance:** T07. Exercise negative/zero quantities, altered subtotals, negative/insufficient cash, oversized values, stale legitimate quotes and forged quote references. No malformed ordinary sale can manufacture stock or a silently balanced payment.
- **Execution / residual risk:** E09/C01–C12 support bounded containment, not full acceptance. Legacy noncash amount overwrite, current-setting repricing/quoted_total alias, global un-fingerprinted receipts, quantity-expanded promotion resource risk (runtime subtask under A29, linked A09/A23/A38), entitlement checks, native durability and external settlement remain unresolved. Known receipts return the stored outcome before new validation; this preserves existing replay and does not prove A11. Five-attempt parking/error replacement stay unchanged. No release gate closed; no commit/push/deployment.

### A10 — The original offline quote is not retained independently of recalculation

- **Original priority / evidence:** P1; historical class: Confirmed static.
- **Current disposition:** Needs current behavioral revalidation; source matches audit. E02 establishes file continuity only; historical diagnostics were not rerun.
- **Current evidence:** E01/E02 (2026-09-19, local HEAD above); `backend/internal/service/order.go:135-228`; `backend/internal/service/order.go:254-267`; `backend/internal/service/order.go:361-381`. No relevant uncommitted application changes at entry. See E03 for selectively re-read paths.
- **Authority / decision:** AUDIT_REPORT A10 and PLAN_ADDENDUM are analysis/proposed mechanisms; existing user-approved draft policies remain authoritative. Review packet: no additional owner question identified; technical review under the shared workflow.
- **Plan coverage:** explicit programme inclusion in plan §Full-audit programme → this row; workstream Device journal. **Draft mapping:** §Offline conflict policy (broad text alone remains partial design detail). Original source coverage labels are historical, not reused as current completeness scores.
- **Dependencies / slice:** A09,A11,A23,A28; proposed S1. Owner: Codex implementation / ChatGPT review / owner consequential approvals. Migration/compatibility: immutable captured quote and historical rules.
- **Required result:** Persist immutable captured lines, price/rule versions, allocations, tender collected and receipt total before reconciliation. Keep validation/current-reference differences separately. Never overwrite actual money collected or goods handed over to make a recalculated order look balanced.
- **Acceptance:** T07. Sell offline, change catalog/promotion/tax/loyalty settings, then sync. The original receipt and tender remain reproducible; differences are explicit, actionable and do not trigger a second collection.
- **Execution / residual risk:** E04; application tests not run, no implementation commit/PR or release artifact. Behavior/concurrency/device applicability must be verified in its actual environment. Original priority release rule above applies; no approved exception recorded.

### A11 — Exactly-once effects are not a shared property of every write

- **Original priority / evidence:** P0; historical class: Confirmed static.
- **Current disposition:** Needs current behavioral revalidation; source matches audit. E02 establishes file continuity only; historical diagnostics were not rerun.
- **Current evidence:** E01/E02 (2026-09-19, local HEAD above); `backend/internal/service/shift.go:24-50`; `backend/internal/service/shift.go:127-136`; `backend/internal/sync/sync.go:249-300`; `backend/internal/service/order.go:123-133`; `backend/internal/write/warehouse.go:113-164`. No relevant uncommitted application changes at entry. See E03 for selectively re-read paths.
- **Authority / decision:** AUDIT_REPORT A11 and PLAN_ADDENDUM are analysis/proposed mechanisms; existing user-approved draft policies remain authoritative. Review packet: no additional owner question identified; technical review under the shared workflow.
- **Plan coverage:** explicit programme inclusion in plan §Full-audit programme → this row; workstream Operation delivery. **Draft mapping:** §Approved reliability direction (broad text alone remains partial design detail). Original source coverage labels are historical, not reused as current completeness scores.
- **Dependencies / slice:** A04,A09,A29,A42; proposed S1. Owner: Codex implementation / ChatGPT review / owner consequential approvals. Migration/compatibility: receipts and fingerprint schema for every mutation.
- **Required result:** Introduce a shared immutable operation receipt committed atomically with effects and audit. Scope keys, verify a request fingerprint, and return the original outcome for same-key retries. Different keys for genuinely separate identical baskets must remain separate sales.
- **Acceptance:** T08. Commit then lose the response for each mutation, retry serially and concurrently, and submit an altered body under the same key. There is one logical effect, a stable outcome, and a visible key/body conflict.
- **Execution / residual risk:** E04; application tests not run, no implementation commit/PR or release artifact. Behavior/concurrency/device applicability must be verified in its actual environment. Original priority release rule above applies; no approved exception recorded.

### A12 — Shift ownership, concurrent opening and late-event accounting are incomplete

- **Original priority / evidence:** P1; historical class: Confirmed static; database races not executed.
- **Current disposition:** Needs current behavioral revalidation; source matches audit. E02 establishes file continuity only; historical diagnostics were not rerun.
- **Current evidence:** E01/E02 (2026-09-19, local HEAD above); `backend/internal/service/shift.go:24-136`; `backend/internal/service/order.go:361-381`. No relevant uncommitted application changes at entry. See E03 for selectively re-read paths.
- **Authority / decision:** AUDIT_REPORT A12 and PLAN_ADDENDUM are analysis/proposed mechanisms; existing user-approved draft policies remain authoritative. Review packet: no additional owner question identified; technical review under the shared workflow.
- **Plan coverage:** explicit programme inclusion in plan §Full-audit programme → this row; workstream Reconciliation. **Draft mapping:** §September 15 consolidated policy clarification (broad text alone remains partial design detail). Original source coverage labels are historical, not reused as current completeness scores.
- **Dependencies / slice:** A04,A11,A28,A42; proposed S3. Owner: Codex implementation / ChatGPT review / owner consequential approvals. Migration/compatibility: shift uniqueness/write-close protocol and late-event links.
- **Required result:** Define shift lifecycle constraints and a shared write/close protocol. Preserve original capture shift and the later actual cash-moving shift separately. Do not reject already-captured offline cash simply because the original shift is now closed.
- **Acceptance:** T09. Race two opens and a sale/cash movement against close; replay close; settle an old return in a new shift. Original drawer count remains immutable and all later effects are correctly attributed.
- **Execution / residual risk:** E04; application tests not run, no implementation commit/PR or release artifact. Behavior/concurrency/device applicability must be verified in its actual environment. Original priority release rule above applies; no approved exception recorded.

### A13 — Product transfers can apply concurrent state transitions more than once

- **Original priority / evidence:** P0; historical class: Confirmed static race; PostgreSQL reproduction pending.
- **Current disposition:** Source-confirmed open; runtime unverified. transfer.go SendTransfer explicitly uses read-then-write guard; transition race still requires PostgreSQL reproduction.
- **Current evidence:** E01/E02 (2026-09-19, local HEAD above); `backend/internal/write/transfer.go:98-107`; `backend/internal/write/transfer.go:224-310`; `backend/internal/write/ingredient_transfer.go:65-83`. No relevant uncommitted application changes at entry. See E03 for selectively re-read paths.
- **Authority / decision:** AUDIT_REPORT A13 and PLAN_ADDENDUM are analysis/proposed mechanisms; existing user-approved draft policies remain authoritative. Review packet: no additional owner question identified; technical review under the shared workflow.
- **Plan coverage:** explicit programme inclusion in plan §Full-audit programme → this row; workstream Reconciliation. **Draft mapping:** §Workstreams and acceptance evidence (broad text alone remains partial design detail). Original source coverage labels are historical, not reused as current completeness scores.
- **Dependencies / slice:** A11,A17,A42; proposed S3. Owner: Codex implementation / ChatGPT review / owner consequential approvals. Migration/compatibility: transfer transition receipts and stock locking.
- **Required result:** Lock/claim the transfer transition and relevant stock rows deterministically, use guarded updates, and commit the operation receipt with effects. Handle same-event replay separately from genuinely competing physical receipts.
- **Acceptance:** T10. Concurrent send/send, receive/receive, send/cancel and different transfers drawing from the same source produce one permitted transition and conserved stock, with durable review evidence for competitors.
- **Execution / residual risk:** E04; application tests not run, no implementation commit/PR or release artifact. Behavior/concurrency/device applicability must be verified in its actual environment. Original priority release rule above applies; no approved exception recorded.

### A14 — Immutable live/backdated count observations, templates and chronological reconciliation

- **Original priority / evidence:** P1; historical class: Confirmed static.
- **Current disposition:** Source-confirmed open; runtime unverified; clarified design / owner decisions pending. stockcount.go generic update replaces lines/reopens state and completion writes absolute stock; no new reconciliation observed.
- **Current evidence:** E01/E02 (2026-09-19, local HEAD above); `backend/internal/write/stockcount.go:133-194`; `backend/internal/write/stockcount.go:197-287`; `backend/internal/write/ingredient_stockcount.go:1-209`. No relevant uncommitted application changes at entry. See E03 for selectively re-read paths.
- **Authority / decision:** AUDIT_REPORT A14 and PLAN_ADDENDUM are analysis/proposed mechanisms; existing user-approved draft policies remain authoritative. U04/U14 and template business intent are user-confirmed via linked clarifications; implementation mechanics remain proposed. Review packet: Q02,Q04.
- **Plan coverage:** explicit programme inclusion in plan §Full-audit programme → this row; workstream Reconciliation. **Draft mapping:** §Offline conflict policy (broad text alone remains partial design detail). Original source coverage labels are historical, not reused as current completeness scores.
- **Dependencies / slice:** A11,A15,A16,A17,A28,A38,A39,A42; proposed S3. Owner: Codex implementation / ChatGPT review / owner consequential approvals. Migration/compatibility: immutable observations, revisions and registered template schema.
- **Required result:** Enforce an immutable terminal lifecycle, lock/claim completion, and return a previous receipt on replay. Reconcile a count against its frozen baseline and intervening movements rather than replaying an old absolute value.
- **Acceptance:** T11a–T11n; I01–I23 (including original T11 replay). Count to ten, sell two, then retry the same completion: stock stays eight. Completed/cancelled counts cannot be reopened or edited through generic update commands.
- **Execution / residual risk:** E04; application tests not run, no implementation commit/PR or release artifact. Behavior/concurrency/device applicability must be verified in its actual environment. Original priority release rule above applies; no approved exception recorded.

**Expanded contract:** direct entry and Backoffice-generated template normalize
into one observation contract. XLSX is proposed, not mandated by approval.
Preserve per-line cutoff, timezone/precision, scope/unit/disposition, immutable
observation, original receipt and separately versioned reconciliation. No sales
freeze, export-time cutoff, absolute overwrite or generic reopening. Late pre-count
movements revise discrepancy without charging stock twice; late post-count
movements apply once; older counts never replace newer anchors. Unknown history
stays pending/review; sufficient evidence reconciles automatically.
Template staging performs no stock writes; blank differs from zero; IDs remain
text; literal cells only; malformed/incomplete/duplicate rows visible. Fingerprint
normalized logical submission, not ZIP bytes/filename. Proposed selected-submission
atomic acceptance is separate from row reconciliation; shared stock-writer locking
and projection coverage remain required. All T11a–n and I01–23 apply, including
closed-period limits, uncertain cutoff and parser safety. A31/A38/A39 are not closed
by template adoption. Separate bounded slices: S3a registered template/staging;
S3b movement intervals/revisions/receipts; S3c concurrency, POS projection and E2E.

### A15 — Acknowledgement can make sold stock reappear on the POS

- **Original priority / evidence:** P1; historical class: Reproduced in isolated engine.
- **Current disposition:** Needs current behavioral revalidation; source matches audit. E02 establishes file continuity only; historical diagnostics were not rerun.
- **Current evidence:** E01/E02 (2026-09-19, local HEAD above); `packages/sync/src/engine.ts:217-232`; `packages/sync/src/engine.ts:306-345`; `backend/internal/service/order.go:298-338`; `apps/pos/src/cashier/SyncProvider.tsx:59-113`. No relevant uncommitted application changes at entry. See E03 for selectively re-read paths.
- **Authority / decision:** AUDIT_REPORT A15 and PLAN_ADDENDUM are analysis/proposed mechanisms; existing user-approved draft policies remain authoritative. Review packet: no additional owner question identified; technical review under the shared workflow.
- **Plan coverage:** explicit programme inclusion in plan §Full-audit programme → this row; workstream Reconciliation. **Draft mapping:** §Workstreams and acceptance evidence (broad text alone remains partial design detail). Original source coverage labels are historical, not reused as current completeness scores.
- **Dependencies / slice:** A01,A11,A17; proposed S2. Owner: Codex implementation / ChatGPT review / owner consequential approvals. Migration/compatibility: canonical inventory coverage/version contract.
- **Required result:** Maintain provisional movements until a canonical stock projection covering their receipt/version replaces them. Separate catalog versions from inventory sequence, or otherwise prove projection coverage; avoid double subtraction during refresh.
- **Acceptance:** T12. For ack-before-pull, pull-before-ack, late retry, parking and partial refresh, displayed stock includes each physical movement exactly once.
- **Execution / residual risk:** E04; application tests not run, no implementation commit/PR or release artifact. Behavior/concurrency/device applicability must be verified in its actual environment. Original priority release rule above applies; no approved exception recorded.

### A16 — Required offline inventory workflows are not all represented

- **Original priority / evidence:** P1; historical class: Confirmed feature gap.
- **Current disposition:** Needs current behavioral revalidation; source matches audit. E02 establishes file continuity only; historical diagnostics were not rerun.
- **Current evidence:** E01/E02 (2026-09-19, local HEAD above); `packages/sync/src/outbox.ts:1-33`; `backend/internal/sync/sync.go:184-380`. No relevant uncommitted application changes at entry. See E03 for selectively re-read paths.
- **Authority / decision:** AUDIT_REPORT A16 and PLAN_ADDENDUM are analysis/proposed mechanisms; existing user-approved draft policies remain authoritative. Review packet: Q04.
- **Plan coverage:** explicit programme inclusion in plan §Full-audit programme → this row; workstream Offline coverage. **Draft mapping:** §Requirements carried forward (broad text alone remains partial design detail). Original source coverage labels are historical, not reused as current completeness scores.
- **Dependencies / slice:** A01,A04,A11,A14,A17; proposed S3. Owner: Codex implementation / ChatGPT review / owner consequential approvals. Migration/compatibility: new offline operation schemas and dependency replay.
- **Required result:** Add a named inventory-offline workstream covering each agreed workflow, journal schema, provisional state, permission scope, conflict resolution and projection. Do not quietly reduce scope to transfer receiving.
- **Acceptance:** T13. During a 60-minute outage, exercise all approved inventory workflows, restart, then reconcile conflicts and dependencies without lost evidence or premature sellable stock.
- **Execution / residual risk:** E04; application tests not run, no implementation commit/PR or release artifact. Behavior/concurrency/device applicability must be verified in its actual environment. Original priority release rule above applies; no approved exception recorded.

### A17 — Inventory cannot yet be fully reconciled from a single movement history

- **Original priority / evidence:** P1; historical class: Confirmed design gap.
- **Current disposition:** Needs current behavioral revalidation; source matches audit. E02 establishes file continuity only; historical diagnostics were not rerun.
- **Current evidence:** E01/E02 (2026-09-19, local HEAD above); `backend/internal/service/order.go:298-338`; `backend/internal/service/order.go:526-605`; `backend/internal/write/transfer.go:224-420`; `backend/internal/write/warehouse.go:113-215`; `backend/internal/write/stockcount.go:249-280`. No relevant uncommitted application changes at entry. See E03 for selectively re-read paths.
- **Authority / decision:** AUDIT_REPORT A17 and PLAN_ADDENDUM are analysis/proposed mechanisms; existing user-approved draft policies remain authoritative. Review packet: no additional owner question identified; technical review under the shared workflow.
- **Plan coverage:** explicit programme inclusion in plan §Full-audit programme → this row; workstream Reconciliation. **Draft mapping:** §Workstreams and acceptance evidence (broad text alone remains partial design detail). Original source coverage labels are historical, not reused as current completeness scores.
- **Dependencies / slice:** A11,A28,A42; proposed S3. Owner: Codex implementation / ChatGPT review / owner consequential approvals. Migration/compatibility: unified movement history and trustworthy opening baseline.
- **Required result:** Give every stock effect a source operation, location, quantity, disposition, original occurrence time and reversal/correction link. Make projections rebuildable and reconcile transfer source/destination/in-transit quantities. Keep physical inspection separate from sellability.
- **Acceptance:** T12. Rebuild balances from movements and match all locations. Explain every stock delta through a business event, including cancelled/reversed/provisional operations.
- **Execution / residual risk:** E04; application tests not run, no implementation commit/PR or release artifact. Behavior/concurrency/device applicability must be verified in its actual environment. Original priority release rule above applies; no approved exception recorded.

### A18 — Refund implementation does not represent the accepted return and payout policy

- **Original priority / evidence:** P1; historical class: Confirmed policy/feature gap.
- **Current disposition:** Needs current behavioral revalidation; source matches audit. E02 establishes file continuity only; historical diagnostics were not rerun.
- **Current evidence:** E01/E02 (2026-09-19, local HEAD above); `backend/internal/service/order.go:526-651`; `apps/pos/src/cashier/OrderHistoryPanel.tsx:1-300`. No relevant uncommitted application changes at entry. See E03 for selectively re-read paths.
- **Authority / decision:** AUDIT_REPORT A18 and PLAN_ADDENDUM are analysis/proposed mechanisms; existing user-approved draft policies remain authoritative. Review packet: Q05,Q06.
- **Plan coverage:** explicit programme inclusion in plan §Full-audit programme → this row; workstream Refund finance inventory. **Draft mapping:** §Offline conflict policy; Scent exchanges (broad text alone remains partial design detail). Original source coverage labels are historical, not reused as current completeness scores.
- **Dependencies / slice:** A01,A06,A11,A12,A17,A28,A41; proposed S4. Owner: Codex implementation / ChatGPT review / owner consequential approvals. Migration/compatibility: entitlement, physical receipt, payable and settlement schema.
- **Required result:** Implement explicit return entitlement, physical receipt, disposition, payable and settlement records. Preserve permitted offline cash payout facts and cross-outlet online authorization. No automatic cash repayment just because a previous reconciliation response is unknown.
- **Acceptance:** T14,T15. Run every consolidated refund scenario, including tester retained, late authorization, cross-outlet race, manual transfer, cash/transfer method switch and full refund after an exchange chain.
- **Execution / residual risk:** E04; application tests not run, no implementation commit/PR or release artifact. Behavior/concurrency/device applicability must be verified in its actual environment. Original priority release rule above applies; no approved exception recorded.

### A19 — Exchange, paid-void and recovery need new domain commands, not status reuse

- **Original priority / evidence:** P1; historical class: Confirmed policy/feature gap.
- **Current disposition:** Needs current behavioral revalidation; source matches audit. E02 establishes file continuity only; historical diagnostics were not rerun.
- **Current evidence:** E01/E02 (2026-09-19, local HEAD above); `backend/internal/sync/sync.go:184-380`; `backend/internal/service/order.go:526-651`. No relevant uncommitted application changes at entry. See E03 for selectively re-read paths.
- **Authority / decision:** AUDIT_REPORT A19 and PLAN_ADDENDUM are analysis/proposed mechanisms; existing user-approved draft policies remain authoritative. Review packet: Q05,Q06.
- **Plan coverage:** explicit programme inclusion in plan §Full-audit programme → this row; workstream Exchange void recovery. **Draft mapping:** §Scent exchanges; Next review checkpoints (broad text alone remains partial design detail). Original source coverage labels are historical, not reused as current completeness scores.
- **Dependencies / slice:** A11,A12,A18,A30,A42; proposed S4. Owner: Codex implementation / ChatGPT review / owner consequential approvals. Migration/compatibility: linked commands and compensating history.
- **Required result:** Introduce linked immutable entities and guarded transitions for original allocations, replacement quote, physical handover, payment confirmation, payable settlement and compensating recovery. Attach authority and uncertainty evidence at each irreversible step.
- **Acceptance:** T15,T16,T17. Crash or lose response at every money/goods boundary. Retrying never collects/pays twice; a pending downgrade remains owed; cancellation after movement requires the approved recovery, not a status flip.
- **Execution / residual risk:** E04; application tests not run, no implementation commit/PR or release artifact. Behavior/concurrency/device applicability must be verified in its actual environment. Original priority release rule above applies; no approved exception recorded.

### A20 — Aggregate points cannot express the accepted restoration, expiry and adjustment rules

- **Original priority / evidence:** P1; historical class: Confirmed policy gap; feature can remain disabled.
- **Current disposition:** Needs current behavioral revalidation; source matches audit. E02 establishes file continuity only; historical diagnostics were not rerun.
- **Current evidence:** E01/E02 (2026-09-19, local HEAD above); `backend/internal/service/order.go:230-295`; `backend/internal/service/order.go:605-647`; `backend/internal/write/points.go:1-81`. No relevant uncommitted application changes at entry. See E03 for selectively re-read paths.
- **Authority / decision:** AUDIT_REPORT A20 and PLAN_ADDENDUM are analysis/proposed mechanisms; existing user-approved draft policies remain authoritative. Review packet: Q07.
- **Plan coverage:** explicit programme inclusion in plan §Full-audit programme → this row; workstream Customer optional loyalty. **Draft mapping:** §Scent exchanges (broad text alone remains partial design detail). Original source coverage labels are historical, not reused as current completeness scores.
- **Dependencies / slice:** A10,A11,A25,A28; proposed S5. Owner: Codex implementation / ChatGPT review / owner consequential approvals. Migration/compatibility: point lots, adjustments, historical migration; optional gate.
- **Required result:** Keep loyalty disabled until policy/settings are approved. When enabled, implement lots, original earning/conversion evidence, deterministic item allocations, consumed/restored points and a separate adjustment balance. Retry must not extend expiry or award again.
- **Acceptance:** T18. Use points before refund, restore previously redeemed points, change expiry settings during an outage and correct the account. Cash is unaffected, points conserve, restoration remains spendable and adjustments offset only future new earnings.
- **Execution / residual risk:** E04; application tests not run, no implementation commit/PR or release artifact. Behavior/concurrency/device applicability must be verified in its actual environment. Original priority release rule above applies; no approved exception recorded.

### A21 — Online-only redemption cannot be enforced with the existing Offline flag

- **Original priority / evidence:** P1; historical class: Confirmed static.
- **Current disposition:** Needs current behavioral revalidation; source matches audit. E02 establishes file continuity only; historical diagnostics were not rerun.
- **Current evidence:** E01/E02 (2026-09-19, local HEAD above); `backend/internal/sync/sync.go:195-223`; `backend/internal/service/order.go:254-267`; `apps/pos/src/cashier/CheckoutPanel.tsx:302-341`. No relevant uncommitted application changes at entry. See E03 for selectively re-read paths.
- **Authority / decision:** AUDIT_REPORT A21 and PLAN_ADDENDUM are analysis/proposed mechanisms; existing user-approved draft policies remain authoritative. Review packet: no additional owner question identified; technical review under the shared workflow.
- **Plan coverage:** explicit programme inclusion in plan §Full-audit programme → this row; workstream Customer optional loyalty. **Draft mapping:** §Scent exchanges (broad text alone remains partial design detail). Original source coverage labels are historical, not reused as current completeness scores.
- **Dependencies / slice:** A04,A07,A11,A20,A29; proposed S5. Owner: Codex implementation / ChatGPT review / owner consequential approvals. Migration/compatibility: online reservation/finalization contract; batch compatibility.
- **Required result:** Design an online authorization/reservation or finalization proof for redemption, bound to the sale and point lots; do not use a coarse transport flag as proof of connectivity or authority. Retain pending offline earnings and eligible offline full-refund restoration as approved.
- **Acceptance:** T19. Online redemption succeeds exactly once; disconnected redemption cannot create new entitlement; losing a response or returning the sale does not lose/respend reserved points.
- **Execution / residual risk:** E04; application tests not run, no implementation commit/PR or release artifact. Behavior/concurrency/device applicability must be verified in its actual environment. Original priority release rule above applies; no approved exception recorded.

### A22 — Redemption rounding can give monetary credit while consuming zero points

- **Original priority / evidence:** P1; historical class: Reproduced in POS; equivalent backend arithmetic confirmed.
- **Current disposition:** Needs current behavioral revalidation; source matches audit. E02 establishes file continuity only; historical diagnostics were not rerun.
- **Current evidence:** E01/E02 (2026-09-19, local HEAD above); `apps/pos/src/cashier/pricing.ts:391-400`; `backend/internal/service/order.go:254-267`. No relevant uncommitted application changes at entry. See E03 for selectively re-read paths.
- **Authority / decision:** AUDIT_REPORT A22 and PLAN_ADDENDUM are analysis/proposed mechanisms; existing user-approved draft policies remain authoritative. Review packet: Q07.
- **Plan coverage:** explicit programme inclusion in plan §Full-audit programme → this row; workstream Customer optional loyalty. **Draft mapping:** §Scent exchanges (broad text alone remains partial design detail). Original source coverage labels are historical, not reused as current completeness scores.
- **Dependencies / slice:** A09,A20; proposed S5. Owner: Codex implementation / ChatGPT review / owner consequential approvals. Migration/compatibility: integer money/points conversion compatibility.
- **Required result:** Approve one deterministic rounding/allocation rule and derive both quantities from it using integer money. Handle sub-point remainders explicitly; share golden vectors across Go and TypeScript.
- **Acceptance:** T20. For every total near a conversion boundary, the value credited equals the value of points actually consumed under the approved rule, and cash plus points equals the payable.
- **Execution / residual risk:** E04; application tests not run, no implementation commit/PR or release artifact. Behavior/concurrency/device applicability must be verified in its actual environment. Original priority release rule above applies; no approved exception recorded.

### A23 — A linked tiered promotion loses its tier configuration in POS pricing

- **Original priority / evidence:** P1; historical class: Reproduced.
- **Current disposition:** E15 mapper, E17 LP05 identity containment and E19 linked-fulfillment scoped accepted. E21 scoped-accepts E20 semantic promotion-key validation. E24 scoped-accepts E22 target/browser qualification within supplied limits; native remains open. Full A23/T21 open.
- **Current evidence:** Shared 12-vector Go/TS contract; Backoffice real Save-button render and callback guard; independent Repo.CreatePromotion/UpdatePromotion; POS direct/code planner plus legacy reducer actions; backend bundle/BXGY quota resolution; read-only all-row diagnostic. E20 isolated DB checks 22 authoring vectors, eight online no-effect rejections, eight captured-offline retained-price/quantity/warning/retry cases, eight prior valid cases and preflight. Existing LF fixture, tiered goldens and LP05 tests preserved. See SK_VALIDATION_MATRIX.md and SK_COMPATIBILITY.json.
- **Authority / decision:** AUTH-MANDALIKA-20260919-01 and owner-relayed ChatGPT direction 2026-09-21 resolve Q-LF-01 as semantic validation of the existing disjoint domain. No general overlapping-slot allocator. Earlier Q-LP05-01/02, raw code ownership and Q08 stock warning/override unchanged. Offline semantic-overlap facts retain original lines/prices with review warnings; no fabricated validated grant.
- **Plan coverage:** explicit programme inclusion in plan §Full-audit programme → this row; workstream Contracts evidence model. **Draft mapping:** §Scent exchanges (broad text alone remains partial design detail). Original source coverage labels are historical, not reused as current completeness scores.
- **Dependencies / slice:** A10,A09,A29; mapper/LP05/linked fulfillment accepted within evidence. E20 contains this semantic-key class only; broader versioned-quote parity remains open. Owner: Codex execution / ChatGPT review / owner consequential decisions. No historical promotion/outbox rewrite.
- **Required result:** Carry the full versioned promotion shape through selection, validation, pricing and captured quote. Build parity vectors for direct vs linked tiered, bundles, rewards, stacking, caps and eligible-item allocations.
- **Acceptance:** T21. The same rule/version/cart has the same allocation and total through direct and code-linked paths; server reconciliation preserves the captured business fact if an old client differs.
- **Execution / residual risk:** E20 POS241/BO19/sync33, types, Go and47 isolated database leaf scenarios pass. E22 adds an explicit deployed-catalog read-only scan (1 row/no semantic findings), real synthetic browser authoring/pickers and queue metadata. No native interaction, concurrency/Redis, complete malformed-config/schema validation or release qualification. New CLI reports overlaps/uninspectable key shapes using READ ONLY/REPEATABLE READ; no automatic repair. Repository structured fixture scan found no unexpected positive overlap; intentional negative tests retained. Same-slot alternatives remain union semantics and previous exact-duplicate write rejection remains. Broader malformed/missing BXGY offline drop behavior is unchanged outside the newly retained semantic-overlap branch; residual captured-fact work stays open. A29 resource compression, quote migration and loyalty are separate. Existing impossible-move guard remains.


### A24 — Guest sales are blocked despite the accepted policy

- **Original priority / evidence:** P1; historical class: Confirmed static.
- **Current disposition:** E23 guest-sale containment implemented and locally verified; E24 ChatGPT scoped accepted within supplied evidence. Full A24/T22 open.
- **Current evidence:** Entry CashierScreen guest gate reproduced in real Chromium. Current CashierScreen/CustomerPicker remove blanket requirement; existing null queue/receipt projection and service customer guards retained. A24_VERIFICATION.json, A24_VALIDATION_MATRIX.md and browser JSON show actual final checks; six new database cases use real browser-captured financial/customer fields.
- **Authority / decision:** AUTH-MANDALIKA-20260919-01; CG-A23-SEMANTIC-KEYS-20260921-01-R1 sections4–5 and current owner instruction. Ordinary sale does not require customer identity. Per-customer/assigned code restrictions and loyalty authority remain; no fake Guest record.
- **Plan coverage:** Explicit A24 guest-sale containment continuation in PRODUCTION_READINESS_PLAN.md. **Draft mapping:** September21 semantic acceptance/guest containment and existing POS customer verification/guest attachment policy. Later TL/open-shift attachment remains separate.
- **Dependencies / slice:** A09,A30; bounded A24 guest-sale containment (prior S0e). Codex executes/verifies, ChatGPT reviews. No migration, server production logic change or old outbox rewrite.
- **Required result:** Ordinary guest capture with null customer identity, safe generic benefits and no customer points/reward entitlement. Conditional customer-specific benefits cannot survive capture as guest.
- **Acceptance:** T22 bounded ordinary-sale scenarios1–17 mapped in A24_VALIDATION_MATRIX.md. Direct/batch null-customer storage, unchanged customer/points snapshots, stock once and same-key retry evidenced. Later attachment must not award twice and is still unimplemented.
- **Execution / residual risk:** POS250/BO19/sync33/printer7, app/new-test types, seven Go packages and53 isolated DB leaf scenarios pass. Real browser successful guest cash/QRIS, generic/restricted code, clear-benefit reconfirmation, registered/add-customer, receipt and reconstruction. Native/physical printer/device durability/settlement unavailable or not tested. Existing SET_CUSTOMER conservatively removes physical bundle/BXGY effects as well as loyalty; generic percentage/fixed selections survive when not removed by existing exclusivity. Missing/expired promotion branches may still clear the full selection. No guest attachment/merge, historical quote or loyalty redesign; full finding and release gates remain open.

### A25 — Customer merges and corrections need immutable historical ownership rules

- **Original priority / evidence:** P1; historical class: Confirmed static; some aggregate definitions remain policy decisions.
- **Current disposition:** Needs current behavioral revalidation; source matches audit. E02 establishes file continuity only; historical diagnostics were not rerun.
- **Current evidence:** E01/E02 (2026-09-19, local HEAD above); `backend/internal/write/merge.go:170-250`; `backend/internal/service/order.go:135-146`; `backend/internal/service/order.go:230-240`; `backend/internal/service/order.go:400-430`; `backend/internal/service/order.go:605-647`. No relevant uncommitted application changes at entry. See E03 for selectively re-read paths.
- **Authority / decision:** AUDIT_REPORT A25 and PLAN_ADDENDUM are analysis/proposed mechanisms; existing user-approved draft policies remain authoritative. Review packet: Q08.
- **Plan coverage:** explicit programme inclusion in plan §Full-audit programme → this row; workstream Customer optional loyalty. **Draft mapping:** §POS customer verification; Scent exchanges (broad text alone remains partial design detail). Original source coverage labels are historical, not reused as current completeness scores.
- **Dependencies / slice:** A11,A20,A30,A42; proposed S5. Owner: Codex implementation / ChatGPT review / owner consequential approvals. Migration/compatibility: original/effective ownership and merge/correction audit schema.
- **Required result:** Preserve original and effective account linkage separately. Q08/CG-MA-20260919-01-R1 narrowly supersedes blanket merge-before-eligibility wording: preserve approved raw assigned-code identity plus reissue. Define each rule's subject explicitly; retain usage history and atomic caps against that subject. Merge-related cap aggregation and reissue allowance/provenance remain unresolved. Separate net-spend metrics from deliberately historical visit counts. See Q08_APPROVAL_EXCERPTS.md for original repository decisions and evidence limits.
- **Acceptance:** T22. Merge/correct with pending sales and a customer-limited code; preserve raw assignment, policy-defined caps, expiry provenance, exactly-once usage and audited ownership. Reissue must not silently activate duplicate fresh allowances; do not infer an unapproved cap subject.
- **Execution / residual risk:** E04; application tests not run, no implementation commit/PR or release artifact. Behavior/concurrency/device applicability must be verified in its actual environment. Original priority release rule above applies; no approved exception recorded.

### A26 — Reports and shift recaps silently aggregate only the first 50 records

- **Original priority / evidence:** P1; historical class: Confirmed static request/response path.
- **Current disposition:** E25 pagination-completeness implemented and locally verified; E26 scoped ChatGPT accepted within supplied evidence. Parent A26/T23 and release gates remain open.
- **Current evidence:** E25 (2026-09-21, same root/HEAD plus incremental diff). `packages/api/src/pagination.ts`; Backoffice `Reports.tsx`, `Orders.tsx`, `Dashboard.tsx`; POS `recapData.ts`, `ShiftRecapPanel.tsx`; `backend/internal/read/repo.go`; `pagination_integration_test.go`. A26_IMPLEMENTATION.diff identifies exact current lines; A26_VERIFICATION.json records actual checks.
- **Authority / decision:** AUTH-MANDALIKA-20260919-01 and CG-A23-QUAL-A24-GUEST-20260921-01-R1. Complete bounded client retrieval; no summary-endpoint shortcut while A27 remains open. Existing date/status/payment/outlet semantics retained.
- **Plan coverage:** explicit programme inclusion and current continuation A26; draft September21 pagination decision. Canonical status remains here.
- **Dependencies / slice:** A27/A28 arithmetic/calendar and A31 global race remain separate/open. Codex implementation, ChatGPT review, owner consequential decisions. No migration. Version-marked recap caches avoid certifying old truncated snapshots; legacy bytes retained until successful fresh replacement.
- **Required result:** Every named consumer receives all metadata-declared pages or visible failure, never successful prefix totals/export. Stable IDs, exact lengths, bounded requests, no partial cache writes. Server maximum200 unchanged; same-time rows have ID tie-breakers without changing primary timestamp order.
- **Acceptance:** T23 and reply scenarios1–25; A26_VALIDATION_MATRIX.md maps all. Browser CSV/XLSX51/201/1000, Dashboard inputs, POS401 orders/flows and251 history, same-storage fallback; real DB metadata/scoping and TS reconstruction verified.
- **Execution / residual risk:** E25 final POS258/BO50/sync33, types and affected Go checks pass;11 isolated DB scenarios pass. No Redis/concurrent-writer/native/printer/performance/release qualification. Offset pages are not a transaction snapshot; unchanged-count replacement can escape detection. First offline use with only legacy unmarked cache fails visibly until full fetch succeeds. Other report/export consumers outside the named slice still require T23 inventory. Stopped S0c cleanup policy block remains; no bypass. Full parent/gates open.

### A27 — The backend summary subtracts refunded sales twice

- **Original priority / evidence:** P1; historical class: Confirmed SQL arithmetic; not executed against PostgreSQL at original audit.
- **Current disposition:** E27 A27-summary-double-subtraction implemented and locally verified; E28 scoped ChatGPT accepted within supplied evidence. Full A27/T24 remains open.
- **Current evidence:** E27,2026-09-21 same root/HEAD plus incremental diff. `backend/internal/read/reports.go` netSales expression; `backend/internal/handlers/report_summary_integration_test.go`; A27_CONSUMER_SEARCH.json; A27_BEFORE_FIX_POSTGRES.json / A27_POSTGRES.json / A27_RESPONSE_PARITY.json.
- **Authority / decision:** AUTH-MANDALIKA-20260919-01; CG-A26-PAGINATION-20260921-01-R1. Existing status-based model: totalSales/totalOrders/payment/product/daily/average completed-only; totalRefunds refunded-only; netSales equals totalSales because refunded rows are already excluded. Not a new gross-sales definition.
- **Plan coverage:** explicit current A27 continuation; draft September21 contained summary contract. Q09 broader report definitions remain unresolved and separate.
- **Dependencies / slice:** A18/A19/A28 for final financial projections; independent narrow arithmetic required none of their redesigns. Codex implementation/ChatGPT review/owner consequential policy. No migration/API shape or UI arithmetic change.
- **Required result:** Remove second refund subtraction in current summary while preserving orders.created_at [from,to), RFC3339/default parser, outlet/admin scope and cache keys. Broader gross/recognized/net vocabulary and occurrence/settlement accounting remain separate Q09 work.
- **Acceptance:** T24 bounded subset and review scenarios1–14 mapped in A27_VALIDATION_MATRIX.md. Critical refunded-only30 => sales0/refunds30/net0 and completed100+refunded30 => sales100/refunds30/net100; unchanged other aggregates/API fields and no-mutation snapshots.
- **Execution / residual risk:**16 isolated PostgreSQL/authenticated handler scenarios pass;15 before/after snapshots unchanged; all non-net fields match red/green. Thirty existing report/pagination tests, affected Go and typechecks pass. UTC is pinned in synthetic fixture only, no production timezone change. Q09/A28 gross/net vocabulary, cross-day refund posting, exchange adjustments, post-close payouts, tax/discount basis and outlet calendar remain open. Redis/native/live/release/performance and precision redesign not qualified. Earlier stopped S0c cleanup block preserved; no retry/bypass. Full parent/gates open.

### A28 — Business time is inconsistent across pricing, reporting and return deadlines

- **Original priority / evidence:** P1; historical class: Confirmed mixed implementation; desired calendars remain open.
- **Current disposition:** Needs current behavioral revalidation; source matches audit. E02 establishes file continuity only; historical diagnostics were not rerun.
- **Current evidence:** E01/E02 (2026-09-19, local HEAD above); `backend/internal/service/order.go:135-146`; `backend/internal/read/reports.go:21-53`; `apps/backoffice/src/screens/Reports.tsx:62-87`. No relevant uncommitted application changes at entry. See E03 for selectively re-read paths.
- **Authority / decision:** AUDIT_REPORT A28 and PLAN_ADDENDUM are analysis/proposed mechanisms; existing user-approved draft policies remain authoritative. Review packet: Q02,Q09.
- **Plan coverage:** explicit programme inclusion in plan §Full-audit programme → this row; workstream Contracts evidence model. **Draft mapping:** §Scent exchanges; September 15 consolidated policy clarification (broad text alone remains partial design detail). Original source coverage labels are historical, not reused as current completeness scores.
- **Dependencies / slice:** A10,A12,A14,A18; proposed S1. Owner: Codex implementation / ChatGPT review / owner consequential approvals. Migration/compatibility: versioned business date and separate occurrence/arrival/settlement.
- **Required result:** Specify outlet business timezone/calendar and distinct captured_at, accepted_at, settled_at and business_date fields. Use versioned calendar rules for original-date return eligibility and policy-approved clock-skew handling.
- **Acceptance:** T24. Test midnight, overnight closing, five-calendar-day expiry, changed device clocks and a late offline batch crossing dates. Reports and eligibility follow the same approved business calendar.
- **Execution / residual risk:** E04; application tests not run, no implementation commit/PR or release artifact. Behavior/concurrency/device applicability must be verified in its actual environment. Original priority release rule above applies; no approved exception recorded.

### A29 — Network and batch error contracts do not support safe recovery

- **Original priority / evidence:** P1; historical class: Confirmed static.
- **Current disposition:** Open. Original network/error requirements remain; promotion-resource-safety is an explicit runtime subtask, with technical direction accepted from Q-S0c-02 and implementation/benchmarks pending.
- **Current evidence:** E01/E02 (2026-09-19, local HEAD above); `packages/api/src/client.ts:335-392`; `packages/sync/src/engine.ts:289-363`; `backend/internal/sync/sync.go:167-180`; `backend/internal/handlers/handlers.go:114-123`; `backend/internal/httpx/httpx.go:1-49`. No relevant uncommitted application changes at entry. See E03 for selectively re-read paths.
- **Envelope intake correction:** E12/E13 complete outer sync/batch structural validation, linked A43. General size/work budgets, error classification/backoff and promotion resource safety remain unimplemented by this repair.
- **Additional current evidence:** E10/Q-S0c-02; S0c source investigation identified quantity-expanded pricing/grant work. No new resource benchmark or bounded algorithm is claimed by S0d.
- **Authority / decision:** AUDIT_REPORT A29 and PLAN_ADDENDUM are analysis/proposed mechanisms; existing user-approved draft policies remain authoritative. Review packet: no additional owner question identified; technical review under the shared workflow.
- **Plan coverage:** explicit programme inclusion in plan §Full-audit programme → this row; workstream Operation delivery. **Draft mapping:** §Workstreams and acceptance evidence (broad text alone remains partial design detail). Original source coverage labels are historical, not reused as current completeness scores.
- **Dependencies / slice:** A11,A09,A23,A38; proposed S1 and promotion-resource-safety. Owner: Codex implementation / ChatGPT review / owner consequential approvals. Migration/compatibility: bounded versioned batch/error contracts.
- **Required result:** Add bounded batches, request deadlines, structured error codes, retry-after/backoff/jitter, independent versus dependent operation handling, body/array limits and sanitized error responses. Distinguish gateway/transport uncertainty from definitive command rejection.
- **Resource subtask requirement:** Count-compressed calculation and grant/output/DB work, stable line/role identity and deterministic tie/rounding behavior; measured budgets before expensive work, cancellation and rollback, retained no-effect error. No arbitrary sale cap, automatic basket split or partial acknowledgment. Golden/property equivalence and large-input work/allocation/row-count evidence required. A40 documents these constraints but does not own runtime safety.
- **Acceptance:** T25. Inject hanging requests, HTML 502, 429, 503, partial results, expired auth and a very large queue. Unrelated operations progress; dependencies retain ordering; no event disappears.
- **Execution / residual risk:** E04; application tests not run, no implementation commit/PR or release artifact. Behavior/concurrency/device applicability must be verified in its actual environment. Original priority release rule above applies; no approved exception recorded.

### A30 — The permission model needs an operation-by-scope matrix, not UI assumptions

- **Original priority / evidence:** P1; historical class: Confirmed inconsistencies; some intended scope is unresolved.
- **Current disposition:** Needs current behavioral revalidation; source matches audit. E02 establishes file continuity only; historical diagnostics were not rerun.
- **Current evidence:** E01/E02 (2026-09-19, local HEAD above); `backend/internal/server/server.go:100-143`; `backend/internal/handlers/handlers.go:53-68`; `apps/pos/src/components/OutletSwitcher.tsx:32-58`; `backend/internal/write/stockcount.go:133-152`; `backend/internal/handlers/writes.go:25-62`. No relevant uncommitted application changes at entry. See E03 for selectively re-read paths.
- **Authority / decision:** AUDIT_REPORT A30 and PLAN_ADDENDUM are analysis/proposed mechanisms; existing user-approved draft policies remain authoritative. Review packet: Q01,Q04.
- **Plan coverage:** explicit programme inclusion in plan §Full-audit programme → this row; workstream Authorization. **Draft mapping:** §Workstreams and acceptance evidence (broad text alone remains partial design detail). Original source coverage labels are historical, not reused as current completeness scores.
- **Dependencies / slice:** A04,A05,A06,A08; proposed S1. Owner: Codex implementation / ChatGPT review / owner consequential approvals. Migration/compatibility: role/scope mapping and route compatibility.
- **Required result:** Publish and enforce a matrix of command/read, role/permission, outlet/warehouse/customer scope, direct/batch route and offline authority. Preserve explicitly approved scoped/global Backoffice access and outlet selection; fixed POS terminals have no routine logout/outlet switch. Server enforcement and authenticated recovery retain original event attribution without inventing human login mechanics.
- **Acceptance:** T04a–T04e,T06. Positive/negative tests cover every route and supported role, cross-outlet return verification and warehouse operations. Authorized Backoffice manager outlet selection works within its granted scope; forbidden Backoffice scopes and incompatible fixed-POS scopes are rejected. Routine POS logout/outlet switching is not a supported workflow; refresh/recovery preserves pending evidence and original identity under T04a–e.
- **Execution / residual risk:** E04; application tests not run, no implementation commit/PR or release artifact. Behavior/concurrency/device applicability must be verified in its actual environment. Original priority release rule above applies; no approved exception recorded.

### A31 — An old polling response can overwrite a newly selected outlet

- **Original priority / evidence:** P2; historical class: Confirmed static async race; runtime pending at original audit.
- **Current disposition:** E29 implementation and local verification accepted by E30. Resolved for original A31/T26 stale-scope polling race; retained in tracker. All release gates remain open.
- **Current evidence:** usePolledQuery.ts; A31_CALLERS_BEFORE/AFTER.json (63 calls); A31_BEFORE_FIX_BROWSER.json, A31_HOOK_BROWSER.json and A31_REPORTS_BROWSER.json. Exact incremental source/test diff and raw before-images accompany A31-POLLING-20260921-01.
- **Authority / decision:** CG-A27-SUMMARY-20260921-01-R1 under AUTH-MANDALIKA-20260919-01. Latest-started request in active dependency generation alone may publish data/error/terminal loading. No new business policy.
- **Plan coverage:** explicit programme inclusion, S0g and current A31 continuation; draft current A31 polling contract.
- **Dependencies / slice:** A30 remains separate; A26 complete-fetch publication integration covered. No migrations, new libraries or API changes. Owner: Codex implementation / ChatGPT review / owner consequential decisions.
- **Required result:** Monotonic generation and request tokens, cleanup invalidation and guarded interval start. Abort is optional optimization, never sole correctness. Scope resets data/error/loading; same-scope polling remains stale-while-revalidate; manual refetch and unmount remain supported.
- **Acceptance:** T26 plus all15 review scenarios mapped in A31_VALIDATION_MATRIX.md. Real hook A/B/C, stale success/error/loading, overlapping polls/refetch, cleanup/unmount, complete A26 multi-page race; rendered Reports success and failure races.
- **Execution / residual risk:** 13/13 deterministic real React/browser cases, two rendered Reports races, 50 existing Backoffice tests and app/harness types pass. Five proven missing outlet dependencies corrected; other independent fetch/effect paths, POS polling, transport cancellation, server snapshot isolation, auth redesign and production qualification are not claimed. Multi-page requests can continue after invalidation; their cohort cannot publish. Retained A26 PostgreSQL JSON replay is not a new database run. Prior stopped/policy-blocked cleanup remains untouched. E30 resolves this parent for the original audited race only; no release gate closes.

### A32 — Startup migration and connection budgeting are not multi-instance safe by design

- **Original priority / evidence:** P1; historical class: Confirmed static risk; multi-instance test pending.
- **Current disposition:** Needs current behavioral revalidation; source matches audit. E02 establishes file continuity only; historical diagnostics were not rerun.
- **Current evidence:** E01/E02 (2026-09-19, local HEAD above); `backend/cmd/server/main.go:32-46`; `backend/internal/db/db.go:21-45`; `backend/internal/db/db.go:50-105`. No relevant uncommitted application changes at entry. See E03 for selectively re-read paths.
- **Authority / decision:** AUDIT_REPORT A32 and PLAN_ADDENDUM are analysis/proposed mechanisms; existing user-approved draft policies remain authoritative. Review packet: no additional owner question identified; technical review under the shared workflow.
- **Plan coverage:** explicit programme inclusion in plan §Full-audit programme → this row; workstream Operations. **Draft mapping:** §Workstreams and acceptance evidence (broad text alone remains partial design detail). Original source coverage labels are historical, not reused as current completeness scores.
- **Dependencies / slice:** A11,A35; proposed S6. Owner: Codex implementation / ChatGPT review / owner consequential approvals. Migration/compatibility: serialized backwards-compatible migrations and pool budget.
- **Required result:** Use a serialized migration phase or proven advisory-lock protocol. Budget per-instance connections against the chosen maximum instance count, reserve operational capacity and require backward-compatible schema rollout for old APKs.
- **Acceptance:** T27. Start several fresh instances together, interrupt migration and roll back app versions. Schema stays consistent and the total connection budget stays within measured limits.
- **Execution / residual risk:** E04; application tests not run, no implementation commit/PR or release artifact. Behavior/concurrency/device applicability must be verified in its actual environment. Original priority release rule above applies; no approved exception recorded.

### A33 — Redis remains a required startup/auth dependency and routine traffic amplifier

- **Original priority / evidence:** P1; historical class: Confirmed source behavior; actual quotas unmeasured.
- **Current disposition:** Needs current behavioral revalidation; source matches audit. E02 establishes file continuity only; historical diagnostics were not rerun.
- **Current evidence:** E01/E02 (2026-09-19, local HEAD above); `backend/cmd/server/main.go:43-46`; `backend/internal/server/server.go:45-74`; `backend/internal/auth/handlers.go:44-49`; `backend/internal/cache/cache.go:1-80`; `apps/pos/src/cashier/SyncProvider.tsx:111-114`. No relevant uncommitted application changes at entry. See E03 for selectively re-read paths.
- **Authority / decision:** AUDIT_REPORT A33 and PLAN_ADDENDUM are analysis/proposed mechanisms; existing user-approved draft policies remain authoritative. Review packet: no additional owner question identified; technical review under the shared workflow.
- **Plan coverage:** explicit programme inclusion in plan §Full-audit programme → this row; workstream Capacity. **Draft mapping:** §Capacity: production requirements first (broad text alone remains partial design detail). Original source coverage labels are historical, not reused as current completeness scores.
- **Dependencies / slice:** A07,A29,A32; proposed S6. Owner: Codex implementation / ChatGPT review / owner consequential approvals. Migration/compatibility: durable auth before optional-cache startup fallback.
- **Required result:** Implement the approved separation of canonical financial truth from optional cache. Measure commands/requests per device/day, authentication and cold starts, retention/storage growth, peak reconnect bursts and backoffice traffic. Set warning/action/upgrade thresholds from actual current provider limits.
- **Acceptance:** T28. With Redis unavailable, already-authorized financial processing retains correctness under the approved authority model. At 25+ outlets and 12â€“14-hour active days, measured resource use stays within agreed budgets.
- **Execution / residual risk:** E04; application tests not run, no implementation commit/PR or release artifact. Behavior/concurrency/device applicability must be verified in its actual environment. Original priority release rule above applies; no approved exception recorded.

### A34 — CI does not enforce the full financial and client reliability baseline

- **Original priority / evidence:** P1; historical class: Confirmed configuration and local formatting evidence.
- **Current disposition:** A34a–e8 scoped accepted through E56 (26 milestones/11 findings). E57 PostCSS locally verified; hosted/review pending. Full A34/T29 remains open.
- **Current evidence:** E47 exact applicability and same-SHA hosted proof at 31080a4 in the current packet. E45 final de7352fa5fb0cf877e869b1c65040a2731969ccb hosted/vendor/workbook evidence in A34E3-SHEETJS-20260923-01; historical checkpoints below retain their original limits. E31–E36 historical local/review evidence preserved. E37 adds reviewed staging/classification, complete SHA256 tree manifests, zero-unresolved staged secret scans, trigger safeguards, two normal commits/pushes, eight hosted run records and sanitized logs, six-fixture lifecycle and 26-scenario browser evidence in A34D_HOSTED_SUMMARY.json / A34D_VERIFICATION.json.
- **Authority / decision:** AUTH-MANDALIKA-20260919-01; owner A34d instruction and CG-A34C-BROWSER-CI-20260922-01-R1. Explicit allowlists only; no deployment/Android dispatch, provider credentials or live data.
- **Plan coverage:** A34a/b/c continuations in plan/draft. Deterministic JS/TS, mandatory disposable PostgreSQL and mandatory synthetic browser gates remain distinct from full release qualification.
- **Dependencies / slice:** A01,A11,A35 remain broader prerequisites. Android signing needs quality/database/backend/browser, all checking caller SHA. Existing quality/PostgreSQL/backend/React Doctor workflows unchanged; JS package gate additionally typechecks browser tests.
- **Required result:** All26 registered browser scenarios discovered/executed/PASS exactly once with no skip/fixme/focused test. Synthetic loopback-only strict servers, default external denial, bounded startup/tests/processes, confirmed owned cleanup and synthetic-only failure artifacts. Existing six named PG guards/mandatory runner preserved.
- **Acceptance:** A34c24 review scenarios mapped in A34C_VALIDATION_MATRIX.md. Final browser26/26 zero skips,7/7 negative proofs, confirmed process/port cleanup and external request interception. JS quality347 PASS,1 existing optional PostgreSQL response-replay SKIP; source/test types, both production builds and TS schema drift pass. No production business change; real hook harness gains optional single-case selector only.
- **Execution / residual risk:** Hosted source proof now supplied by E37; no full A34 or release closure. A13/A42 genuine business DB concurrency, dependency/SBOM/license/advisory gates, A37 secret scanning/history exposure, branch protection/required statuses and A35 APK/OTA provenance remain open. Native Android/hardware/provider qualification remains separate. The optional BO DB-response replay and other opt-in/manual checks retain their disclosed limits. Historical stopped DB/cache cleanup remains local, excluded and not bypassed. Post-proof reporting after-images are uncommitted and do not change the verified executable SHA.

### A35 — OTA and native release gates do not yet protect a financial-journal migration

- **Original priority / evidence:** P1; historical class: Confirmed static; device/supply-chain behavior untested.
- **Current disposition:** Needs current behavioral revalidation; source matches audit. E02 establishes file continuity only; historical diagnostics were not rerun.
- **Current evidence:** E01/E02 (2026-09-19, local HEAD above); `backend/internal/ota/decide.go:5-31`; `apps/pos/src/App.tsx:132-144`; `apps/pos/capacitor.config.ts:1-54`; `scripts/ota-release.sh:1-97`; `apps/pos/android/app/src/main/AndroidManifest.xml:1-15`. No relevant uncommitted application changes at entry. See E03 for selectively re-read paths.
- **Authority / decision:** AUDIT_REPORT A35 and PLAN_ADDENDUM are analysis/proposed mechanisms; existing user-approved draft policies remain authoritative. Review packet: Q10.
- **Plan coverage:** explicit programme inclusion in plan §Full-audit programme → this row; workstream Operations. **Draft mapping:** §Workstreams and acceptance evidence (broad text alone remains partial design detail). Original source coverage labels are historical, not reused as current completeness scores.
- **Dependencies / slice:** A01,A04,A34,A41; proposed S6. Owner: Codex implementation / ChatGPT review / owner consequential approvals. Migration/compatibility: native/API/journal compatibility and rollback migration.
- **Required result:** Define supported native/API/journal versions, immutable authenticated release artifacts, staged rollout and a rollback that does not make newer journal data unreadable. Tie readiness to required local recovery without waiting for network. Test backup/restore/reinstallation identity and key handling.
- **Acceptance:** T29,T30. Upgrade and roll back with pending sales and an interrupted migration. No duplicate device identity, unreadable journal or silent event loss occurs. Production artifact inspection confirms debug settings and backup policy.
- **Execution / residual risk:** E04; application tests not run, no implementation commit/PR or release artifact. Behavior/concurrency/device applicability must be verified in its actual environment. Original priority release rule above applies; no approved exception recorded.

### A36 — Backup scripts are not evidence of recoverability and restore lacks guardrails

- **Original priority / evidence:** P1; historical class: Confirmed script behavior; external automation unknown.
- **Current disposition:** Needs current behavioral revalidation; source matches audit. E02 establishes file continuity only; historical diagnostics were not rerun.
- **Current evidence:** E01/E02 (2026-09-19, local HEAD above); `scripts/db-backup.sh:17-26`; `scripts/db-restore.sh:9-23`. No relevant uncommitted application changes at entry. See E03 for selectively re-read paths.
- **Authority / decision:** AUDIT_REPORT A36 and PLAN_ADDENDUM are analysis/proposed mechanisms; existing user-approved draft policies remain authoritative. Review packet: Q10.
- **Plan coverage:** explicit programme inclusion in plan §Full-audit programme → this row; workstream Operations. **Draft mapping:** §Workstreams and acceptance evidence (broad text alone remains partial design detail). Original source coverage labels are historical, not reused as current completeness scores.
- **Dependencies / slice:** A11,A17,A20,A35; proposed S6. Owner: Codex implementation / ChatGPT review / owner consequential approvals. Migration/compatibility: isolated restore and journal replay compatibility.
- **Required result:** Add explicit safe-target verification, secret-free logging, failure-atomic restore procedure, encrypted off-host retention and measured recovery objectives. Prove business balances/receipts/ledger reconciliation after restoration, not just row counts.
- **Acceptance:** T31. Restore to an isolated disposable target and reconcile orders, stock, settlements, point lots and command receipts. Replaying post-backup device journals does not duplicate already-restored effects.
- **Execution / residual risk:** E04; application tests not run, no implementation commit/PR or release artifact. Behavior/concurrency/device applicability must be verified in its actual environment. Original priority release rule above applies; no approved exception recorded.

### A37 — Sensitive evidence and local secrets need a separate handling policy

- **Original priority / evidence:** P1; historical class: Confirmed configuration/filenames; no secret values inspected.
- **Current disposition:** Needs current behavioral revalidation; source matches audit. E02 establishes file continuity only; historical diagnostics were not rerun.
- **Current evidence:** E01/E02 (2026-09-19, local HEAD above); `packages/sync/src/engine.ts:252-277`; `apps/pos/src/cashier/SyncProvider.tsx:66-80`; `apps/pos/src/lib/errorReporter.ts:1-93`; `apps/pos/capacitor.config.ts:18-27`; `scripts/db-restore.sh:13-15`. No relevant uncommitted application changes at entry. See E03 for selectively re-read paths.
- **Authority / decision:** AUDIT_REPORT A37 and PLAN_ADDENDUM are analysis/proposed mechanisms; existing user-approved draft policies remain authoritative. Review packet: Q10.
- **Plan coverage:** explicit programme inclusion in plan §Full-audit programme → this row; workstream Operations. **Draft mapping:** §Workstreams and acceptance evidence (broad text alone remains partial design detail). Original source coverage labels are historical, not reused as current completeness scores.
- **Dependencies / slice:** A01,A08,A35; proposed S0i. Owner: Codex implementation / ChatGPT review / owner consequential approvals. Migration/compatibility: nested evidence redaction and retention/access design.
- **Required result:** Inventory secret locations and access without exposing values. Sanitize nested diagnostics, define consent/access/retention for customer and financial evidence, encrypt appropriate local/server data, and produce a sanitized sharing archive. Assess whether exposure requires rotation; do not destroy a release keystore or blindly rotate it without a signing continuity plan.
- **Acceptance:** T32. Inject marker secrets and sensitive sample customer data into nested errors. Logs, exports and telemetry retain useful diagnostics without unauthorized disclosure; operational evidence remains accessible only to approved roles.
- **Execution / residual risk:** E04; application tests not run, no implementation commit/PR or release artifact. Behavior/concurrency/device applicability must be verified in its actual environment. Original priority release rule above applies; no approved exception recorded.

### A38 — Dependency review is not a full reachability-verified vulnerability audit

- **Original priority / evidence:** P2; historical class: Verified advisory/version concern; exploitability not established.
- **Current disposition:** Open. E56 Nano ID accepted; E57 PostCSS locally verified, hosted/review pending. Fresh local raw22/actionable20 with reviewed2 and zero exceptions. No clean-baseline or full T33 claim.
- **Current evidence:** E47 exact applicability and same-SHA hosted proof at 31080a4 in the current packet. E45 final de7352fa5fb0cf877e869b1c65040a2731969ccb hosted/vendor/workbook evidence in A34E3-SHEETJS-20260923-01; historical checkpoints below retain their original limits. E39 scans e782c5d before changes: 436 npm / 137 Go modules, 56 npm audit advisories, 6 distinct called Go advisories, complete graph/license inventory and CycloneDX SBOMs. Public data snapshots and final remediation scan are supplied in the current A34E packet.
- **Authority / decision:** AUTH-MANDALIKA-20260919-01; CG-A34D-HOSTED-PROOF-20260922-01-R1 and DEPSEC-INITIAL-20260922. No invented license-family deny list or silent exception. Proxy trust / ambiguous license terms require consequential review.
- **Plan coverage:** explicit programme inclusion in plan §Full-audit programme → this row; workstream Operations. **Draft mapping:** §Workstreams and acceptance evidence (broad text alone remains partial design detail). Original source coverage labels are historical, not reused as current completeness scores.
- **Dependencies / slice:** A34; proposed S6. Owner: Codex implementation / ChatGPT review / owner consequential approvals. Migration/compatibility: lockfile/advisory review; XLSX import changes reachability.
- **Required result:** Run current lockfile-based advisory and license checks in CI, verify reachability, upgrade or replace affected dependencies through the vendor-supported distribution path, and retest generated contracts/native plugins. Record justified exceptions instead of claiming all dependencies clean.
- **Acceptance:** T33. Produce a dated dependency/SBOM report tied to the release lockfiles, with reachable findings fixed or an approved risk exception and regression evidence.
- **Execution / residual risk:** E39: safe JWT/Redis patch remediation plus pinned gate tooling; remaining called/high-risk findings and rgbcolor declaration require further work. Final hosted results and exact SHA belong to the current packet. Native/provider/major architectural choices remain separate. No release gate closes; exceptions register remains empty.

### A39 — CSV import corrupts escaped quotes and multiline fields

- **Original priority / evidence:** P2; historical class: Reproduced; formula-export hardening identified statically.
- **Current disposition:** Needs current behavioral revalidation; source matches audit. E02 establishes file continuity only; historical diagnostics were not rerun.
- **Current evidence:** E01/E02 (2026-09-19, local HEAD above); `apps/backoffice/src/lib/csvUtils.ts:1-124`. No relevant uncommitted application changes at entry. See E03 for selectively re-read paths.
- **Authority / decision:** AUDIT_REPORT A39 and PLAN_ADDENDUM are analysis/proposed mechanisms; existing user-approved draft policies remain authoritative. Review packet: no additional owner question identified; technical review under the shared workflow.
- **Plan coverage:** explicit programme inclusion in plan §Full-audit programme → this row; workstream Import contract expansion. **Draft mapping:** §Workstreams and acceptance evidence (broad text alone remains partial design detail). Original source coverage labels are historical, not reused as current completeness scores.
- **Dependencies / slice:** A37,A38; proposed S0j. Owner: Codex implementation / ChatGPT review / owner consequential approvals. Migration/compatibility: lossless CSV and export policy; independent of XLSX counts.
- **Required result:** Use a standards-conformant parser, explicit column/type validation and preview/error reporting. Define safe spreadsheet export treatment for values beginning with formula characters, without corrupting legitimate stored data.
- **Acceptance:** T32. Round-trip commas, doubled quotes, CRLF, embedded newlines, Unicode, empty cells and formula-like user strings. A malformed import reports row/column errors rather than silently altering customers/products.
- **Execution / residual risk:** E04; application tests not run, no implementation commit/PR or release artifact. Behavior/concurrency/device applicability must be verified in its actual environment. Original priority release rule above applies; no approved exception recorded.

### A40 — Documentation and baseline labels can cause work on the wrong assumptions

- **Original priority / evidence:** P3; historical class: Confirmed documentary/configuration drift.
- **Current disposition:** Documentation improved; broader documentation acceptance not closed. E02 establishes file continuity only; historical diagnostics were not rerun.
- **Current evidence:** E01/E02 (2026-09-19, local HEAD above); `README.md:1-30`; `RUNBOOK.md:1-100`; `ONBOARDING.md:145-170`; `.claude/plans/so-this-entire-thing-mellow-lake.md:117-197`. No relevant uncommitted application changes at entry. See E03 for selectively re-read paths.
- **Authority / decision:** AUDIT_REPORT A40 and PLAN_ADDENDUM are analysis/proposed mechanisms; existing user-approved draft policies remain authoritative. Review packet: no additional owner question identified; technical review under the shared workflow.
- **Plan coverage:** explicit programme inclusion in plan §Full-audit programme → this row; workstream Baseline and evidence limits. **Draft mapping:** §Verification baseline and limits (broad text alone remains partial design detail). Original source coverage labels are historical, not reused as current completeness scores.
- **Dependencies / slice:** none; proposed S0docs. Owner: Codex implementation / ChatGPT review / owner consequential approvals. Migration/compatibility: documentation only; historical records retained.
- **Required result:** Make one current entry point, identify superseded decisions explicitly, document the actual branch/release path and maintain a decisionâ€“commandâ€“test map. Treat source formatting separately from behavior, but make both reproducible.
- **Acceptance:** A40 audit acceptance (no dedicated T ID). A new developer can identify the approved current policy, target branch, exact verification commands and unresolved decisions without interpreting contradictory historical handoffs.
- **Execution / residual risk:** E04; application tests not run, no implementation commit/PR or release artifact. Behavior/concurrency/device applicability must be verified in its actual environment. Original priority release rule above applies; no approved exception recorded.

### A41 — An outbox is not a durable local receipt and return-history ledger

- **Original priority / evidence:** P1; historical class: Confirmed static gap.
- **Current disposition:** Needs current behavioral revalidation; source matches audit. E02 establishes file continuity only; historical diagnostics were not rerun.
- **Current evidence:** E01/E02 (2026-09-19, local HEAD above); `apps/pos/src/cashier/CashierScreen.tsx:810-874`; `apps/pos/src/cashier/OrderHistoryPanel.tsx:1-300`; `packages/sync/src/outbox.ts:142-146`. No relevant uncommitted application changes at entry. See E03 for selectively re-read paths.
- **Authority / decision:** AUDIT_REPORT A41 and PLAN_ADDENDUM are analysis/proposed mechanisms; existing user-approved draft policies remain authoritative. Review packet: no additional owner question identified; technical review under the shared workflow.
- **Plan coverage:** explicit programme inclusion in plan §Full-audit programme → this row; workstream Device journal. **Draft mapping:** §POS customer verification (broad text alone remains partial design detail). Original source coverage labels are historical, not reused as current completeness scores.
- **Dependencies / slice:** A01,A04,A10,A11,A35; proposed S2. Owner: Codex implementation / ChatGPT review / owner consequential approvals. Migration/compatibility: local receipt/history schema and retention migration.
- **Required result:** Derive receipts and offline lookup/history from the durable journal plus canonical records, including original number, item allocations, paid tender and accepted/review status. Reprinting must never recapture a sale; a printer failure must not hide successful durable capture.
- **Acceptance:** T30. Sell offline, reboot, reprint and locate the original sale for an eligible return before reconnecting. The same receipt is available without re-entry or a second sale.
- **Execution / residual risk:** E04; application tests not run, no implementation commit/PR or release artifact. Behavior/concurrency/device applicability must be verified in its actual environment. Original priority release rule above applies; no approved exception recorded.

### A42 — Cross-command lock ordering can deadlock under concurrent business operations

- **Original priority / evidence:** P1; historical class: Confirmed inconsistent ordering; specific database deadlock not reproduced.
- **Current disposition:** Needs current behavioral revalidation; source matches audit. E02 establishes file continuity only; historical diagnostics were not rerun.
- **Current evidence:** E01/E02 (2026-09-19, local HEAD above); `backend/internal/service/order.go:162-166`; `backend/internal/service/order.go:243-250`; `backend/internal/service/order.go:298-337`; `backend/internal/service/order.go:526-647`; `backend/internal/write/merge.go:51-250`. No relevant uncommitted application changes at entry. See E03 for selectively re-read paths.
- **Authority / decision:** AUDIT_REPORT A42 and PLAN_ADDENDUM are analysis/proposed mechanisms; existing user-approved draft policies remain authoritative. Review packet: no additional owner question identified; technical review under the shared workflow.
- **Plan coverage:** explicit programme inclusion in plan §Full-audit programme → this row; workstream Reconciliation. **Draft mapping:** §Workstreams and acceptance evidence (broad text alone remains partial design detail). Original source coverage labels are historical, not reused as current completeness scores.
- **Dependencies / slice:** A11,A13,A14,A17,A25; proposed S1. Owner: Codex implementation / ChatGPT review / owner consequential approvals. Migration/compatibility: shared deterministic lock hierarchy and classified retries.
- **Required result:** Define a lock hierarchy and deterministic resource ordering; shorten critical sections. Classify serialization/deadlock failures as retryable with idempotent command receipts. Do not weaken existing useful locks to hide the contention.
- **Acceptance:** T34. Run parallel sale/refund/merge/transfer combinations with deliberately reversed product order. Either they serialize or a safe retry completes once; no parked or duplicated financial effect remains.
- **Execution / residual risk:** E04; application tests not run, no implementation commit/PR or release artifact. Behavior/concurrency/device applicability must be verified in its actual environment. Original priority release rule above applies; no approved exception recorded.

### A43 — Malformed financial request bodies can be accepted with zero/default values

- **Original priority / evidence:** P1; historical class: Confirmed static.
- **Current disposition:** E11 direct/inner shift results preserved; E13 batch-envelope correction scoped-accepted by E15. Direct/batch shift malformed/required-input containment implemented. Full A43/T25 remains open, including post-commit readback uncertainty and other financial-body paths.
- **Current evidence:** E11 plus E13 handlers/batch_envelope.go, raw-handler and real PostgreSQL batch envelope tests, engine.batch-envelope.test.ts; shared service/shift_input.go, handlers/writes.go open/close paths, sync/sync.go shift cases; handler regression, parser and dispatcher tests, real TestShiftDecodePostgres and engine.shift-decode.test.ts. See S0D_SHIFT_VALIDATION_MATRIX.md corrected SD05/SD07 and BE_LP_VALIDATION_MATRIX.md BE01–11. Historical line references are superseded only for this scoped path.
- **Authority / decision:** AUDIT_REPORT A43 and PLAN_ADDENDUM are analysis/proposed mechanisms; existing user-approved draft policies remain authoritative. CG-S0C-20260920-01-R1 supplies the inner contract; CG-S0D-SHIFT-DECODE-20260920-01-R1 supplies the complete-envelope correction; CG-S0D-ENVELOPE-A23-20260920-01-R1 scoped-accepts it under standing authority. No new shift policy or historical-default fabrication.
- **Plan coverage:** explicit programme inclusion in plan §Full-audit programme → this row; workstream Operation delivery. **Draft mapping:** §Workstreams and acceptance evidence (broad text alone remains partial design detail). Original source coverage labels are historical, not reused as current completeness scores.
- **Dependencies / slice:** A09,A11,A29; S0d-shift-decode (formerly S0k), implemented; further receipt/readback containment remains planned. Owner: Codex implementation / ChatGPT review / owner consequential approvals. Migration/compatibility: decode/semantic validation; committed receipt after failed readback.
- **Required result:** Fail malformed requests before new mutations; validate required numeric fields and finite ranges. Return a stable command receipt even if a post-commit projection read fails, rather than inviting a blind duplicate submission.
- **Acceptance:** T25. Malformed/truncated JSON, missing required values and failed read-back yield the correct classified result. No default-zero drawer close or accidental repeated count completion occurs.
- **Execution / residual risk:** Original SD05/SD07 interpretation narrowed: outer trailing content and duplicates were not covered at E11; E13 corrects that gap. SD13 remains unchanged/open; all test fixtures stopped/retained. Direct valid readback passes but failure after commit is not injected or fixed; open-shift universal idempotency/concurrency, current-caller enrichment failures, other decoders, body-size bounds, error taxonomy and native durability remain open. No new retry-triggering post-commit 500, migration, release artifact or gate closure. Missing/null required amounts now fail instead of fabricating zero; all inspected POS producers send explicit values, but unknown external legacy clients were not surveyed.

### A44 — Historical/deleted variants and stock shortage handling need explicit exceptions

- **Original priority / evidence:** P1; historical class: Confirmed static; disposition policy required.
- **Current disposition:** Needs current behavioral revalidation; source matches audit. E02 establishes file continuity only; historical diagnostics were not rerun.
- **Current evidence:** E01/E02 (2026-09-19, local HEAD above); `backend/internal/service/order.go:298-337`. No relevant uncommitted application changes at entry. See E03 for selectively re-read paths.
- **Authority / decision:** AUDIT_REPORT A44 and PLAN_ADDENDUM are analysis/proposed mechanisms; existing user-approved draft policies remain authoritative. Review packet: Q08.
- **Plan coverage:** explicit programme inclusion in plan §Full-audit programme → this row; workstream Reconciliation. **Draft mapping:** §Offline conflict policy (broad text alone remains partial design detail). Original source coverage labels are historical, not reused as current completeness scores.
- **Dependencies / slice:** A09,A10,A17; proposed S1. Owner: Codex implementation / ChatGPT review / owner consequential approvals. Migration/compatibility: historical item identities and unresolved movement ledger.
- **Required result:** Preserve tombstoned/versioned item identities and route unresolved movements into a durable exception ledger. Q08/CG-MA-20260919-01-R1 preserves approved POS warning/override and lenient captured-sale acceptance; no new hard stock-sale denial. Retain truthful physical effects and shortage/override evidence; historical zero-floor behavior is not approval to hide deficits. See Q08_APPROVAL_EXCERPTS.md.
- **Acceptance:** T07. Delete/deactivate a variant after an offline sale and sync it; movement stays explainable. Valid shortage/override sales retain policy behavior and real stock effects; malformed negative quantities cannot manufacture stock. No silent zero floor or unapproved new prohibition.
- **Execution / residual risk:** E04; application tests not run, no implementation commit/PR or release artifact. Behavior/concurrency/device applicability must be verified in its actual environment. Original priority release rule above applies; no approved exception recorded.

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
