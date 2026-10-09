# A34e15 chi ingress qualification — adoption blocked

Packet: **A34E15-CHI-INGRESS-20260928-01**. Reply:
**CG-A34E14C-CONTRACT-COMPLETION-20260925-01-R1**.
Authority: AUTH-MANDALIKA-20260919-01. Active source remains
`0478648e6600ce201e0a6e712ac77febdded9782`, branch `audit/hosted-proof-20260922`.

A34e14c is scoped accepted (E72): 32 milestones / 11 findings. All 44 parents remain;
A31 alone resolved, original P0 0/8 resolved, release gates0. E73 adds qualification
without remediation credit. A34/T29 and A38/T33 remain open.

## Decision and exact missing evidence

No client-IP strategy is promoted. Current read-only configuration proves public default
Cloud Run entrypoints, not the app-visible client metadata trust contract. On 2026-09-28
selected v1/v2 service reads identify `mandalika-pos`, `asia-southeast2`, ready revision
`00077-b45` with100% traffic, `all` ingress and `allUsers` run.invoker. Two run.app URLs
are advertised. Regional domain mappings are empty, no tagged traffic is returned.
Compute API listing returns SERVICE_DISABLED; no enablement is attempted. Other-project
load balancers/custom proxies are not disproved. The deployed image was created July9;
its source equivalence to current Git HEAD is unestablished.

The configured startup probe is TCP8080, with no returned HTTP/liveness probe. External
HTTP monitors remain unknown. In source, both /readyz and /healthz traverse the global
Redis limiter; /healthz additionally queries DB/Redis. Neither was probed live.

[Cloud Run ingress documentation](https://docs.cloud.google.com/run/docs/securing/ingress)
corroborates direct default-URL availability under all ingress. It does not establish
an exact service header/hop contract. Functions/App Engine/LB header guarantees cannot
be imported into this service without matching topology evidence.

## Q-IP-01 — consequential trust input for ChatGPT

What authoritative Cloud Run-services contract or existing sanitized independent evidence
establishes, for BOTH current default URLs and every other supported route:
1. app-visible immediate peer/route attestation;
2. exact overwrite/append/strip and duplicate-field handling for the proposed client header;
3. which client-supplied prefix can survive and why the chosen position cannot be forged;
4. any supported internal/tagged/custom/probe path that changes those premises?

Recommendation: first obtain the narrow platform/service contract and reconcile supported
paths. If existing paths qualify, migrate to that explicit mode and update logger, all
three limiter scopes and actual Login together, preserving raw peer separately. If they
cannot qualify, return a separate bounded ingress-standardization design for review.
Do not invent a count or trust vendor/private ranges. Public default URLs invalidate an
assumption that a separate external CDN alone is an unavoidable trusted edge. Closing
those routes or changing IAM/header policy would be an operational design change outside
this slice. Choosing raw RemoteAddr for proxied production risks grouping all clients by
proxy; choosing a header without guarantees preserves spoofing. No generic approval is
requested, no new risk exception is proposed.

## Source and consumer evidence

`server.New`: RequestID -> RealIP -> RequestLogger -> recovery/CORS -> api limiter;
auth endpoints add10/min; OTA adds120/min. Global default20RPS is multiplied to1200/min.
The configurable burst field is unused; untouched. `middleware.clientIP` splits host/port
or returns raw RemoteAddr. Logger records that same mutable field. Actual Login separately
uses `strings.Split(RemoteAddr, ":")[0]`, producing `2001` for a forged bareIPv6 and `[2001`
for a direct bracketedIPv6; its threshold remains10/5min per IP+email. This inconsistency
is within the eventual identity migration, not an implemented policy change.

POS/Backoffice use VITE_API_URL (localhost fallback). Android release/Capacitor OTA default
to the numbered run.app URL. These source paths identify likely callers, not every deployed
frontend configuration or backend proxy. No other tracked application header/IP reader
was found in the recorded inventory. No active middleware, auth, rate or API source changed.

## Detached qualification and scanner limits

Candidate chi5.3.2 is the maintained official 5.x release retrieved on2026-09-28. Module
sum `h1:5YQkICvTCSZ25hoRsyJazN0scjzKGiu4VAUc7H1o1nY=`; origin
`38939062c5df4d3e8814aad1a488983112627ced`. Only selected chi5.1.0 ->5.3.2 moves;
no replace or broad update. Zip/source hashes, official advisory records and exact
mod/sum diffs are in the packet. Miniredis2.39.0 is only a detached harness dependency,
not an application dependency or part of the promoted inventory.

Actual old graph:13 characterization passes; version-only graph:48, zero skips. The latter
includes28 strategy-boundary vectors, invalid config and missing-context behavior, and
actual project-consumer context-only migration characterization. Separately, the required
no-spoof test FAILS on both versions as intended. New RealIP still trusts unqualified
headers. Merely installing ClientIPFromHeader also leaves existing consumers reading the
raw proxy. No fixed production path is claimed.

The real router and actual logger/api/auth/Login are exercised. Actual OTA route is
verified at its preloaded limiter boundary (no database dispatch); the120/min threshold
loop uses real project limiters with an inert terminal. Actual Login's Redis counter is
preloaded10, so it returns429 before nil database access. Miniredis uses owned127.0.0.1
TCP sockets with the actual go-redis client, INCR/EXPIRE/MULTI/EXEC/TTL checks. This is not
Upstash integration or a successful authenticated database login. Control authentication
remains401. Redis error fail-open behavior is characterized unchanged.

Candidate APIs normalize mappedIPv6 and header zones, preserve direct zones/rawpeer, merge
XFF fields right-to-left and leave invalid/missing identity empty. They still call downstream;
the model's400 guard is test-only. Count2 intentionally selects a proxy when a third hop is
inserted. XFF APIs accept spoofed metadata from an untrusted peer without an external guard.
These passing characterizations expose obligations; they do not prove protection.

Fresh complete active baseline remains6raw/4actionable/23report-only/2reviewed/0exceptions.
Version-only copy reports4/2/22/2/0: GO-2026-5775 and GO-2026-5777 disappear by range,
as does report-only GHSA-vrw8-fxc6-2r93. No new advisory/package IDs appear. Actual spoof
execution remains: this reduction is explicitly rejected as remediation. OpenPGP
GO-2026-5932 and rgbcolor LICENSE-EVIDENCE remain; both required app/tool targets completed,
and generator target reports no findings. Preserve raw source/alias/range differences.

## Checks and limitations

Active make gen-check passes; canonical guard28/contract78/binding19, x/mod5 and explicit
target-evidence tests pass. Both detached old and chi-only source graphs pass mod verify,
vet, build and621 ordinary named tests; six opt-in PostgreSQL tests skip there. Separately,
all six mandatory native PostgreSQL18.3 fixtures pass148 named tests, zero skips, identity
and cleanup confirmed. Local mode is explicitly non-race. No full Node/browser rerun or
new hosted proof; earlier SHA047 hosted qualification stays historical. No commit/push.

Two harness setup mistakes are preserved with original logs: malformed OTA input still
reaches its repository (nil fixture pool panic), corrected by testing actual preloaded
limiter plus isolated limiter terminal; reading miniredis Addr after Close panicked,
corrected by capturing owned address before shutdown. These are fixture errors, not new
business defects or successful exploit assertions. Final source hashes accompany results.
Docker daemon is unavailable. Missing beta CLI command attempted SDK implicit setup and
failed; no installation retry or global configuration change was made, no beta manifest
was found. Narrow corrected REST domain-map read succeeded; its first field-mask400 is
retained. No raw tokens, full provider config, customer logs or real user IPs are included.

All prior denied installation-copy cleanup and stopped database cleanup remain untouched.
Fresh owned PG fixtures were verified/removed by the established runner; the new detached
qualification copies remain as evidence. No infrastructure, deployed service, live database,
Redis provider, signing, OTA, credentials or global Go/checksum settings were changed.

## IP01–IP18

| ID | Status | Evidence / limit |
|---|---|---|
| IP01 | pass | Entry HEAD/branch/dirty bytes captured; active executable/module/vendor inputs remain unchanged. Prior denied cleanup targets untouched. |
| IP02 | pass | Tracked current source inventory: RealIP -> logger -> global api limiter; auth/OTA scoped limiters; Login IPv6 split is a separate affected consumer. |
| IP03 | partial | Current narrow Cloud Run v1/v2, revision, IAM and regional domain-map reads; two default URLs/public invoker/all ingress. Cross-project/external paths and deployed-image/source equivalence not established. |
| IP04 | partial | TCP8080 startup probe and public default route verified in configuration; immediate peer, overwrite/append/duplicate contract unknown. No live probes. |
| IP05 | pass | Maintained chi5.3.2 official source/tag/sums, one selected application-module movement. All five publisher advisory records and both Go records retained; API semantics inspected. |
| IP06 | blocked | No production strategy qualifies: missing service-specific metadata transformation and peer/bypass guarantees. Active middleware preserved. |
| IP07 | pass | Actual real project router/logger/API/auth/OTA/Login spoof and control; required invariant fails on both chi5.1.0 and version-only5.3.2. |
| IP08 | partial | Owned direct/API model paths work; no deployment-selected strategy or conditional consumer implementation. |
| IP09 | partial | Duplicate/prefix and unauthenticated-peer synthetic cases demonstrate APIs do not authenticate peer; actual legacy spoof bypass persists. No production bypass protection claimed. |
| IP10 | pass | Candidate-only bounded IPv4/IPv6/mapped/zone/port/garbage/missing/short/extra-hop table; library behavior rather than production topology. |
| IP11 | blocked | All actual consumers traced/tested, including IPv6 divergence and context-only migration failure. Chosen-identity migration is deferred with trust decision. |
| IP12 | partial | Real go-redis TCP miniredis fixture verifies counters/TTL/transaction, distinct buckets, configured control thresholds and fail-open. Missing identity remains unenforced in active source; no fix claimed. |
| IP13 | blocked | Current TCP probe configuration known; future explicit production trust configuration, invalid startup behavior and permitted HTTP monitor paths not qualified. |
| IP14 | pass | Tiny documentation-IP fixtures, httptest only; Redis loopback/1s IO deadlines, 45/60s Go timeouts, 180s supervisor. Final owned ports closed/processes exited; no app/provider HTTP probe. |
| IP15 | pass | Current active make gen-check; guard28/contract78/binding19; x/mod5; required target-evidence tests; six native PG18.3 fixtures148 no skips. Existing Node/browser bytes preserved, not rerun/claimed fresh; hosted/race remains accepted historical proof. |
| IP16 | pass | Fresh full active and version-only app+declared-tool scans, inventories/SBOM/OSV/license/advisory data. Exact removed IDs; version-only scanner reduction rejected as remediation. |
| IP17 | not-run | No source promotion, commit/push or hosted workflow. Existing047 acceptance remains historical evidence, not new hosted proof. |
| IP18 | pass | One packet/ZIP with exact incremental docs and detached graph/test source, manifest, results, limits and open questions. No deployment. |
