# Current review packet — A34E15-CHI-INGRESS-20260928-01

Kind: QUALIFICATION / TRUST-INPUT QUESTION. No source promotion.
Reply **CG-A34E14C-CONTRACT-COMPLETION-20260925-01-R1** was read in full after READ_FIRST,
followed by A34E15_CHI_INGRESS_SCOPE.md and the supplied PROGRAMME_PROGRESS.md.
Resolved response:
`C:/Users/MyBook Hype AMD/Downloads/mandalika-pos/review-inbox/CG-A34E14C-CONTRACT-COMPLETION-20260925-01-R1/CHATGPT_REVIEW_RESPONSE_A34E14C-CONTRACT-COMPLETION-20260925-01.md`.
Standing authority AUTH-MANDALIKA-20260919-01.

## Result

**A34e15 production trust qualification is incomplete; active source is preserved.**
The actual backend control plane is accessible read-only. It proves public default
Cloud Run URLs and all ingress, but does not establish app-visible peer/header trust.
The required no-spoof invariant fails with both active chi5.1.0 and detached chi5.3.2.
A version-only change would remove scanner findings while retaining the demonstrated
behavior; it is not adopted. No guessed hop count, production fallback or risk exception.

E72 records scoped A34e14c acceptance: **32 milestones /11 findings**, all44 parents,
A31 sole resolved, originalP0 parents0/8 resolved, release gates0. E73 is this bounded
qualification, not another accepted remediation. E9/E11 stay closed; e14/e14b receive
no separate credit. A34/T29 and A38/T33 remain open.

## Exact source and delta

Root `C:/Users/MyBook Hype AMD/Downloads/mandalika-pos`.
Branch `audit/hosted-proof-20260922`; unchanged HEAD
`0478648e6600ce201e0a6e712ac77febdded9782`, tree
`2ac4f0aedd03d18fb07d139ac92de1e691bb92a7`.
No staged files, commit, push, workflow dispatch or deployment.

Entry had pre-existing reporting edits plus byte-level dirty
`backend/internal/read/repo.go` and `vendor/sheetjs/xlsx-0.20.3.provenance.json`;
those application/vendor bytes are unchanged. Entry/final statuses and SHA preservation
checks are included. Incremental documentation changes record acceptance, qualification,
Q-IP-01, matrix and current handoff. Historical checkpoint prose/logs is retained.

Detached candidate module delta: ONLY github.com/go-chi/chi/v5 v5.1.0 ->v5.3.2;
go.sum adds its two checksum records without broad tidy. No actual consumer implementation
is promoted. Detached qualification modules pin miniredis2.39.0 and replace the synthetic
parent module with their sibling backend copy. They are not application dependencies.
Exact module/fixture sources, before/after hashes and diffs accompany the ZIP.
The pre-existing ignored reconciliation JSON was not byte-snapshotted at entry; its
historical objects are retained, and it is supplied as an after-image only, with no
claim of a captured pre-turn byte diff for that file. Patch
text uses LF-normalized lines; manifests bind exact after-image bytes, not fictitious
Windows raw-byte equivalence. Raw source remains recoverable from the stated base plus
included relevant after-images and fixture modules.

## Trust evidence and consequential question

Selected control-plane reads on2026-09-28 UTC identify service mandalika-pos in
asia-southeast2, ready revision00077-b45 with100% traffic, public allUsers invoker,
all ingress, and both default run.app URLs. Regional domain mappings are empty; no tagged
traffic is returned. Startup probe is TCP8080; no HTTP/liveness probe returned. No live
application request was made. Compute Engine API is disabled/unavailable; other-project
or external proxy routes are not excluded. Current deployed image/source equivalence
is unknown. Historical frontend providers and post-RealIP logs are not trust evidence.

**Q-IP-01 for ChatGPT:** supply/review the exact Cloud Run-services guarantee or existing
independent sanitized evidence for app-visible peer/route attestation and unconditional
header transformation/duplicate treatment across both default URLs and all other supported
paths. With XFF, identify why the selected position/prefix is trusted and stable despite
client prefixes or alternate routes. Include internal/custom/tagged and HTTP-monitor paths.

**Recommendation:** establish that narrow platform contract first; if it supports an
existing path, implement explicit client-IP mode and migrate logger/API/auth/OTA/Login
consumers together. Otherwise return a separate bounded ingress-standardization design.
Raw RemoteAddr behind a proxy risks collapsed client buckets; unverified headers retain
spoofing. Changing ingress/IAM/URLs/header behavior is outside this slice. No generic
phase approval is requested. Detailed options, exact unknowns and evidence classes are
in docs/A34E15_CHI_INGRESS.md and evidence/trust-ledger.json.

## Actual verification

| Check | Working directory / result |
|---|---|
| Actual old consumer characterization | owned legacy/backend/qualification;13 named passes,0 skips |
| Version-only consumer/API characterization | owned version-only/backend/qualification;48 passes,0 skips |
| Required no-spoof invariant | both qualification dirs;expected exit1, actual project attacker-header bucket remains |
| Canonical generation | active backend;actual make gen-check exit0 |
| Canonical guard/contract/bindings | active root codegen_gate;28/78/19 passes,exit0 |
| x/mod bounded tests | active root;5 passes,exit0 |
| Explicit tool-scan evidence tests | active root;8 tests,exit0 |
| Module verify/vet/build/ordinary Go tests | both detached backend dirs;exit0;621 named passes per graph;6 named opt-in DB skips each |
| Dedicated PostgreSQL | active root mandatory runner;6 native18.3 fixtures,148 named passes,0 skips;identity and cleanup verified;explicit non-race |
| Fresh security active | full app+declared-tool capture complete;policy exit1,6raw/4actionable/23report-only/2reviewed/0exceptions |
| Fresh security chi-only copy | full capture complete;policy exit1,4/2/22/2/0;NOT adopted |

commands.json and per-command records give literal commands, absolute working directories,
exit statuses and durations. Go1.26.8 was explicitly selected/verified per process;
default Go1.26.2, global PATH, checksum trust and shared caches were not changed.

Real miniredis loopback TCP exercised the actual go-redis counters, transactions and TTL.
Actual Login is tested at its preloaded10-attempt guard, avoiding any database dispatch.
Actual OTA router scope is tested at its preloaded120 limiter; its normal threshold loop
uses real project limiter middleware and an inert terminal. No successful DB-authentication
or live Upstash proof is claimed. Final ports are closed, owned processes exit.

The strategy table covers IPv4/IPv6/mapped/zone/port/duplicate/comma/invalid/short/extra-hop
cases with real candidate APIs. They preserve raw peer but do NOT authenticate it or reject
missing identity. The invalid-identity400 in the model is test-only. New context alone
leaves actual project logger/limiter/Login on raw peer. These are qualification facts,
not passing production protection. Actual auth-without-token remains401; rate thresholds
and Redis fail-open semantics are characterized unchanged. LoginIPv6 split divergence is
recorded for the eventual coordinated consumer migration.

## Exact security accounting

434 npm components,141 Go modules on each application graph; fixture modules separate.
Both required application and generator scans complete. Active called chi IDs remain
GO-2026-5775 and GO-2026-5777; detached version-only removes those by advisory range plus
report-only GHSA-vrw8-fxc6-2r93. No new advisory/package IDs appear. The same actual RealIP
spoof path still runs, so no remediation clearance follows from that scanner change.
GO-2026-5932 and rgbcolor LICENSE-EVIDENCE remain actionable. Current required generator
scan has no findings. Exact alias/range/source/call evidence, inventories, SBOMs, licenses,
raw and assessed policy results are included; thresholds/SheetJS assessments/expiry and
empty exceptions register remain unchanged. There is no adopted baseline reduction.

## Limits and preserved failures

- No new hosted SHA/workflow evidence because nothing is promoted. Accepted SHA047's
  quality/backend/PostgreSQL/browser and completed-security proof remains historical.
  No full Node/browser rerun; unchanged inputs are hash-verified.
- Current Docker daemon is unavailable. Local PostgreSQL is native/non-race. Dedicated
  fixture passes are separate from ordinary opt-in skips; no fake race claim.
- First fixture OTA malformed-body request reached nil test DB and panicked; corrected
  fixture avoids DB dispatch as explained above. Later cleanup fixture queried Addr after
  Close and panicked; corrected to capture address before shutdown. Original commands,
  source and logs remain; final validated source/results are separately identified.
- gcloud beta domain-mapping command lacked its component and implicit SDK setup errored.
  No installation retry/global configuration change; no beta manifest found afterwards.
  Narrow REST read initially had an unsupported response field (400); corrected selected
  response succeeds and returns no regional mappings. Compute API was not enabled.
- No live HTTP spoof/login/health probe, echo deployment, settings/roles/credentials,
  signing/OTA/deployment or live financial mutation. No incident-clearance claim.
- Previously denied installation-copy deletions and stopped DB cleanup remain untouched.
  Only fresh owned PG fixtures were cleaned by their existing guarded runner.

## Return contents and next work

The compact ZIP contains exact incremental docs and candidate mod/sum diffs, canonical
tracker/progress after-images, IP01–IP18 matrix, trust ledger, source inventories/hashes,
module/publisher provenance, detached synthetic tests, original failures/final results,
full raw/assessed scanner evidence, commands, cleanup evidence and SHA256 manifest.
The only next dependent implementation is the explicitly configured, evidence-backed
client-IP/consumer migration after Q-IP-01 is resolved. No wider trust framework,
version-only adoption or infrastructure change is inferred from this qualification.
