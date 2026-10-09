# A34e15b — ingress design; activation remains blocked

Packet: **A34E15B-INGRESS-DESIGN-20260928-01**. Reply:
**CG-A34E15-CHI-INGRESS-20260928-01-R1**. Authority:
AUTH-MANDALIKA-20260919-01. This is non-applying review data and local models.
No infrastructure, active middleware, dependency, client, credential or deployment
change is made. No commit/push or new hosted result is claimed.

## Decision and precise prerequisites

Select for design the **global external Application Load Balancer**, Premium tier,
one global HTTPS frontend, one writing backend service and one explicit regional
serverless NEG targeting the existing Cloud Run service in **asia-southeast2**.
The backend service replaces `X-Mandalika-Client-IP` with `{client_ip_address}`.
The application may trust that value only after every path to its trusting revision
either traverses that writer or is independently authenticated under a reviewed
contract. The present deployment does not satisfy that condition.

The concrete preferred end state disables both default service URLs, has no Cloud
Run domain mappings or revision-tag access, and excludes every other internal or
external backend/NEG route. Internal callers and supported proxies must use the
canonical edge. `internal-and-cloud-load-balancing` is defense in depth; it does
not alone exclude internal traffic. Header presence, Host, public IP ranges and
guessed hop counts are never route credentials.

**Do not activate this design yet.** The blocking facts are G01–G07 in
[INGRESS_PROPOSAL.json](ingress-design/INGRESS_PROPOSAL.json): complete route and
privilege inventory, support/coverage of default-URI disabling, named domain and
resource owners, deployed-source identity, installed API/OTA client versions, and
real commissioning evidence. Compute inventory is unavailable because its API was
disabled in the supplied observation. No repeat query or API enablement ran here.

If network exclusivity cannot be demonstrated, the smallest managed-origin candidate
to qualify is **IAP on this same LB backend**, Cloud Run invocation restricted to the
Google-managed IAP service agent, and validation of the exact backend-service IAP
assertion audience. This adds no custom shared secret or separate proxy service.
It is conditional, not an approved substitute: public IAP and the existing POS
`Authorization: Bearer` contract must first be shown compatible. The detailed
alternative and an unsent question appear below. Do not invent Google credentials
for terminals or silently move their application bearer tokens to another header.

## Entry state and reused operational evidence

Root: `C:\Users\MyBook Hype AMD\Downloads\mandalika-pos`; branch
`audit/hosted-proof-20260922`; HEAD
`0478648e6600ce201e0a6e712ac77febdded9782`; tree
`2ac4f0aedd03d18fb07d139ac92de1e691bb92a7`.
Entry evidence captures 705 paths, including the ignored reconciliation JSON and
local handoff before-images. Relevant prior dirty paths are `backend/internal/read/repo.go`,
the SheetJS provenance JSON and five programme documents. Raw bytes, rather than Git
normalization alone, determine preservation. Existing untracked review material remains.

These are **reused 2026-09-28 selected control-plane observations**, not new reads:

| Fact | Supplied observation | Limit |
|---|---|---|
| Service | `mandalika-pos`, project `mandalika-pos`, Jakarta | No other project/account enumeration |
| Traffic | `mandalika-pos-00077-b45`, 100%; created 2026-07-09 | Source equality with accepted HEAD unknown |
| Image | `.../cloud-run-source-deploy/mandalika-pos@sha256:fefb83941060a17d65a032b4e0ab7f3e4196f21a1562ba20e3e5fe30692c5e1e` | Digest is identity, not source provenance |
| Ingress/IAM | `all`; `allUsers` has `run.invoker` | Does not authenticate any header writer |
| Numbered URL | `https://mandalika-pos-538849926142.asia-southeast2.run.app` | Configured URL; not probed |
| Hashed URL | `https://mandalika-pos-rqbgovtm2a-et.a.run.app` | Configured URL; not probed |
| Domains/tags | Selected regional mapping result empty; no tag in selected traffic response | Not an exhaustive alternate-route inventory |
| Compute | `SERVICE_DISABLED` | Unknown resources, not zero resources |
| Probe | TCP 8080, failure threshold 1, timeout/period 240s | No HTTP/liveness probe returned in selected data |

Read-only build provenance or a reviewed source-to-image attestation for the actual
digest could establish deployed-source identity later. Do not redeploy the entire
unreleased audit branch merely to manufacture a matching SHA. Public documentation
retrieval for this design used no project credentials and made no application requests.

## Threat and ownership model

Internet clients, upstream proxies and untrusted same-project/shared-VPC workloads can
choose arbitrary request headers. The trusted writer asserts its observed peer, which
can be a NAT or proxy. It cannot identify a person, fixed terminal or original end user
behind that intermediary. Existing application user/outlet/device/permission rules
remain independent. Shared-IP users share existing thresholds; no rate increase is
assumed to solve NAT availability.

Administrators able to update routes, invocation policy or serving source can defeat
network exclusivity. This design treats them as privileged configuration owners,
not as attackers stopped by an IP header. Named principals are still pending. Review
effective permissions, inherited bindings and impersonation, including:

| Owner role | Relevant authority to restrict and observe |
|---|---|
| Routing owner | `roles/compute.loadBalancerAdmin` or equivalent URL-map/backend/NEG permissions; `backendServices.use` and cross-project service-user grants |
| Service/IAM owner | `roles/run.admin`, service update/setIamPolicy, project IAM administration and deployment identities |
| DNS/TLS owner | Authoritative DNS record control; `roles/dns.admin` / Certificate Manager administration or narrower equivalents |
| Release/fleet owner | Exact reviewed source-to-image mapping; installed client/API/OTA versions; signed rollback artifacts |
| Alternative IAP owner | IAP policy/configuration plus service-agent invocation and impersonation permissions |

Proposed controls: explicit resource allowlist; selected readback before activation;
review of any new route; alerts on writer/URL-map/NEG/tag/default-URL/ingress/IAM/domain
changes; paired rollback before reopening a bypass. Monitoring does not make a bad
configuration safe until detected. The consumer contract is disabled unless its
commissioning configuration is complete; there is no automatic permissive mode.

## Proposed resources and the single writer

The JSON is project review data, not a provider API payload or an apply script.
Unknown IDs/hostname remain null. Existing suitable resources may be reused **after**
their identity and controls are verified; unavailable inventory is not a reason to
create duplicates. DNS ownership, budget and operational owners precede provisioning.

| Resource | Proposed setting and responsibility |
|---|---|
| Global forwarding rule / address | `EXTERNAL_MANAGED`, Premium, TCP443 to target HTTPS proxy, assigned global IPv4; no HTTP credential/write redirect. IPv6 frontend deferred until the identical path is qualified. |
| Target HTTPS proxy / certificate | One approved hostname; Certificate Manager global certificate/map, domain-owner DNS authorization; compatible managed RSA-2048/ECDSA certificate; no private CA or client certificate migration. |
| Global URL map | All accepted paths to the one writing backend. No same-name request-header action anywhere in map/rules/weighted backends. No financial request retry/redirect policy added. |
| Global backend service | Sole `customRequestHeaders` entry for `X-Mandalika-Client-IP:{client_ip_address}`. No CDN, no serverless health-check resource. |
| Regional NEG | `SERVERLESS`, Jakarta, exact `cloudRun.service=mandalika-pos`; no tag or URL mask. NEG/service/backend in the same project. |
| Cloud Run service | Later: internal-and-LB ingress, default URI disabled, no direct domain mapping; plain candidate retains public invocation only behind proven route closure. Not an IAM-authenticated origin. |
| DNS | Owned hostname to ALB address only. No direct Cloud Run domain mapping. Existing web/POS UI origins stay unchanged. |

Google documents case-insensitive same-name overwrite for backend custom request
headers. If a URL map sets the same header, its value takes precedence. We deliberately
use **one backend-service writer**, with all conflicting map actions forbidden, because
every permitted frontend reaching that backend then shares the reviewed transform.
This is an explicit choice within the documented feature, not a default run.app claim.
HTTP/1.1, HTTP/2, repeated-field and case-varied behavior still need real qualification.
[Custom headers and precedence](https://docs.cloud.google.com/load-balancing/docs/https/custom-headers-global).

## Route/bypass matrix

Each pending proof blocks activation. “Reject” is a **desired disposition**, not an
observation that the current route is closed. The machine manifest carries the same
13 route IDs. No request-header boolean supplies route proof to production.

| Route ID | Desired enforcement | Future evidence and rollback dependency |
|---|---|---|
| default-numbered | Disable default URI only after migration; no trusting revision accessible there | External and internal controlled tests of numbered URL; restore only after trusting source is withdrawn |
| default-hashed | Same service-level closure | Independently test hashed URL; never infer from numbered alone |
| canonical-edge | Exact frontend → writer backend → explicit NEG → intended service | Readback chain/IDs, protocol/header tests, image identity; keep this edge available during client rollback |
| domain-mapping | No direct mappings to trusting service | Enumerate effective mappings; canonical DNS is an ALB record, not a Run mapping |
| revision-tag | No legacy/tag path into trusting image | Enumerate tags/traffic/revisions; prove default-URI coverage of exact tag forms; otherwise block |
| neg-url-mask | No mask/tag targeting other revisions/services | Inspect all referencing NEGs; no general mask namespace |
| alternate-external-lb | Reject other backends; a supported frontend may use only the sole writer | Complete references and `backendServices.use` grants, including permitted cross-project references |
| internal-lb | No internal backend/NEG bypass | Same-project/shared-VPC/internal LB inventory and synthetic internal tests; ingress flag alone insufficient |
| internal-direct | No default/domain/tag direct route | Inventory internal service callers; route them through canonical writer or return a separate reviewed auth contract |
| external-proxy | Proxy upstream must traverse canonical writer | Supported proxy origin configuration; its observed proxy IP is used, not attacker forwarded prefixes |
| async-platform | Actual Scheduler/Tasks/PubSub/Eventarc/etc callers must migrate to qualified path | Named caller inventory and credential/delivery compatibility; unknown usage blocks closure |
| http-monitor | Canonical edge, same identity/global limiter | Existing `/readyz` and `/healthz` semantics retained, with no business-path exemption |
| tcp-startup | Platform TCP8080 only | Read back intended revision probe; TCP connection is not an HTTP identity exemption |

Default-URI disabling removes a delivery surface but still leaves load balancers and
configured domain mappings; internal ingress includes more than the selected ALB.
The retrieved documentation's Terraform section still mentions Preview, so supported
status and exact tag/internal coverage require confirmation. Do not infer them from a
generic flag. [Cloud Run ingress and URL controls](https://docs.cloud.google.com/run/docs/securing/ingress).

Serverless NEGs do not support ordinary LB health checks. The current TCP startup probe
does not need an HTTP header. Application HTTP monitoring must traverse the writer:
`/readyz` has an inert liveness handler but the global limiter still touches Redis;
`/healthz` checks DB and Redis. Dependency health must not be substituted for liveness
or used to create a broad bypass. [Serverless NEG constraints](https://docs.cloud.google.com/load-balancing/docs/negs/serverless-neg-concepts).

## Authenticated-origin fallback: one conditional alternative

The exact unresolved bypass is an internal/default/tag/mapped/other-LB path admitted
without the designated transform. If G01/G03/G04 cannot close it, plain-header trust
cannot be enabled. Qualify **IAP on the designated LB backend**, not IAP only on Run:

1. Public frontend access would use the documented IAP `allUsers` accessor binding,
   subject to organization policy. The application still authenticates its own users.
   Anonymous IAP assertions need not have `sub`/`email`; those are not POS identities.
2. Remove untrusted Cloud Run invokers and bind only the Google-managed IAP service
   agent, with no attacker impersonation path. IAP's origin invocation uses
   `X-Serverless-Authorization`; a human Google login or terminal service-account key
   is not proposed.
3. The app would additionally verify signature, issuer, time bounds and exact
   `/projects/{number}/global/backendServices/{numeric-ID}` audience on the IAP assertion.
   The service agent is project-wide; another IAP backend is not automatically this
   trusted writer. Pin the backend identity and control its referencing routes.
4. Keep route closure and replay protections. An IAP assertion authenticates a proxy
   assertion; it is **not** a signature over the dedicated IP header or request body.
   A public signed assertion alone, replayed via a separately allowed origin, is not
   sufficient. No model here implements or claims to validate Google's tokens.

Primary support: [public IAP](https://docs.cloud.google.com/iap/docs/managing-access),
[IAP to Cloud Run](https://docs.cloud.google.com/iap/docs/enabling-cloud-run),
[signed assertion checks](https://docs.cloud.google.com/iap/docs/signed-headers-howto).

**New prerequisite Q-IS-01:** Does public-access IAP on this exact global LB path accept
and preserve the existing non-Google POS `Authorization: Bearer` token, including CORS
preflights, without a Google token/challenge? Cloud Run supports separating origin
authentication into X-Serverless-Authorization, but IAP's frontend documentation says
it processes Authorization if no valid Proxy-Authorization ID token is supplied.
Public-access documentation does not establish the necessary exception. That is a
compatibility question, not proof it fails or proof it works.
[IAP programmatic header behavior](https://docs.cloud.google.com/iap/docs/authentication-howto),
[Cloud Run authorization headers](https://docs.cloud.google.com/run/docs/authenticating/service-to-service).

Recommendation: finish the explicit route-closure design first. If closure is not
supportable, obtain a service-specific answer or approved isolated commissioning
evidence for public IAP before choosing that variant. If incompatible, return the
minimal managed authenticated proxy/client-auth options for review; do not silently
add HMAC, change the application's token transport, or use an API gateway whose own
default endpoint still bypasses the writer.

Unsent provider question: “For global external ALB + serverless NEG + Cloud Run, with
IAP public-access allUsers and Run invocation restricted to IAP's service agent, is
an arbitrary application Authorization bearer preserved without Google authentication?
What happens on OPTIONS and absent/invalid Proxy-Authorization? Please identify the
documented contract and which assertion audience binds this backend service.” No
support ticket, credentials or project configuration is sent.

## Coordinated application contract (not adopted)

One selection boundary precedes request logging and all rate consumers. Preserve
original `r.RemoteAddr`; store separate immutable `raw_peer`, normalized `client_ip`,
`source_mode`, `identity_valid`. Proposed edge mode is explicitly configured only after
commissioning. Isolated test/direct mode is never inferred from a missing header.

Strict input: one case-insensitive field with one ASCII value, 1–45 bytes, no trimming,
commas, ports, brackets, zones or controls; parse with `net/netip`; canonicalize IPv6;
unmap IPv4-mapped IPv6. A syntactically valid value is still not route authentication.
No fallback to XFF, X-Real-IP, True-Client-IP or proxy RemoteAddr. If chi's single-header
API is later selected, this strict wrapper must precede it; last-value parsing is not
an approved duplicate policy. The new model uses netip, not an adopted chi upgrade.

| Consumer / source | Coordinated proposed change | Preserved behavior |
|---|---|---|
| Router `backend/internal/server/server.go` | Remove RealIP only with full consumer migration; select identity before logger/limits | Existing routes, CORS allowlist, auth/permission chain |
| Request logger `middleware/logging.go` | Log chosen client and raw peer separately; invalid input logged as invalid, not echoed as chosen identity | Request ID/status/latency; no tokens/raw attacker-header dumps |
| Global/API limiter `middleware/ratelimit.go` | Use selected client string; no RemoteAddr rewrite | Configured `RateLimitRPS*60`/minute (source default1200), `rl:api` key/prefix/window |
| Auth limiter | Same selected identity | 10/minute plus global limiter |
| OTA limiter | Same selected identity | 120/minute plus global limiter; OTA remains public under its current contract |
| Login `auth/handlers.go` | Replace `strings.Split(RemoteAddr, ":")[0]` with selected identity | `rl:login:<ip>:<original email>`; 10 attempts; current sliding five-minute expiry; no email-case policy change |

General limits retain INCR/first EXPIRE and current Redis fail-open behavior; Login
retains actual Cache.Incr/transaction behavior. Missing/invalid identity is rejected
**before** any limiter/business dispatch with proposed **503** infrastructure failure.
This avoids a new 401 triggering refresh/logout. An unqualified route is blocked by
the platform/authenticated-origin control; the local model uses 403 for that denial.
Requests with valid identity still encounter existing 401/403 app checks independently.
No DB authentication success is claimed by the inert-terminal model.

Redis failure for valid identity must remain distinct from identity failure. A miswired
writer will cause an availability failure, not silently relax enforcement. Stop/roll
back the release; keep original queued operations recoverable. Normal client failure
attempts can increase or park operations; do not reset/acknowledge them for migration.
Canonicalization changes old IPv6/mapped buckets; transient old buckets expire under
their existing windows, without clearing Redis or dual identities.

## Client and OTA trace

These are **current local source facts**, not a fleet inventory. Package-source hashes
and line references accompany the packet.

| Client path | Local source contract | Migration requirement |
|---|---|---|
| POS and Backoffice API | `apps/*/src/api.ts`: compiled `VITE_API_URL`, localhost8080 fallback; static createClient baseUrl | Rebuild against approved canonical API; keep UI origin and storage identity unchanged |
| Auth/refresh | `packages/api/src/client.ts`: same base URL, bearer header; refresh POST at that origin; final401 invokes unauthorized callback | Preserve signing keys/TTL/refresh revocation stores; test existing and rotated tokens on same service; do not turn route failure into401 |
| Offline sync | `SyncProvider` supplies same API client; `engine.ts` flushes original outbox idempotencyKey/payload | No endpoint embedded in queued facts; change transport only after in-flight outcome is known; never issue blind parallel/cross-origin retries |
| Storage | `packages/sync/src/storage.ts`: native Preferences mirror, web localStorage; `mandalika.pos.refresh` and `mandalika.pos.outbox` | Preserve app ID/storage origin/keys; no logout/reset/reprovision. Async persistence durability is not newly solved |
| Native API | Capacitor local `dist`, `com.mandalika.pos`, Android HTTPS localhost; no production server.url | Compatible in-place signed native update where required; never repoint WebView to remote UI as an API migration |
| Native OTA | `capacitor.config.ts` builds updateUrl from VITE_API_URL, default numbered run.app `/api/v1/ota/check` | Inventory native configuration independently from bundled JS API origin |
| Installed plugin | CapacitorUpdater8.50.2 offers setUpdateUrl but Android checks allowModifyUrl(default false); persistModifyUrl(default false) controls restart persistence | Neither flag nor setUpdateUrl is used by checked-in app. Do not promise JS-only migration; qualify same-signature native update or separately reviewed existing capability per binary |
| OTA readiness | `native.ts` notifyAppReady; App bootstrap must not wait for network | Preserve readiness/rollback timer and old update channel during staged migration |
| Android release workflow | Manual input has old API default and supplies VITE_API_URL | Future coordinated API/native-OTA target review; no dispatch now |

Access JWTs currently bind user/outlet/permissions and times, not an API hostname.
That supports preserving them while the same auth service moves endpoint; it is not
proof deployed keys/source equal local. No refresh replay is proposed. API fetch
does not specify redirect rejection, so a cross-origin redirect is expressly **not**
the migration mechanism. Keep current frontend origins in CORS; a new API hostname
does not justify allowing `*`, new browser origins, mixed content or arbitrary hosts.

The installed plugin's relevant Android source confirms both configuration checks.
Installed application binary versions, embedded API/OTA origins, signing compatibility,
offline/unreachable terminals and rollback versions remain unknown. A device cannot
be counted migrated just because it contacted the new API once; its native OTA URL
and reboot behavior must also be verified.

## Staged migration with paired rollback

This is a future runbook, not work performed. Every stage requires its specific
commissioning/release conditions. No default URL is disabled in this turn.

| Stage | Entry and completion evidence | Stop condition | Paired rollback |
|---|---|---|---|
| M0 identify | Owned domain, budget, owner principals, intended image provenance; fleet API/OTA/version list and supported callers | Any source/fleet/route unknown relevant to cutover | No infrastructure/client change |
| M1 qualify edge | Approved non-business resource chain; actual writer/duplicate/protocol/bypass tests; native migration rehearsal | Writer or route proof fails; IAP token conflict if variant chosen | Remove test-only candidate later through normal resource lifecycle; active production untouched |
| M2 add canonical endpoint | Reviewed serving source still uses old trust mode; compatible edge/TLS/CORS; both old endpoints remain | App/refresh/OTA incompatibility or no rollback channel | Keep clients on old endpoint; revert added edge/configuration in coordinated change |
| M3 migrate clients | Same UI/app/storage identity; API target changed through qualified build; native OTA separately changed/verified across reboot; original queued keys retained | Unknown in-flight write result, unreadable queue, invalid token, missing/offline terminal, OTA still points old | Restore compatible client build/endpoint using preserved OTA/native rollback channel; don't wipe state or automatically resend ambiguous writes |
| M4 close routes | All supported clients and asynchronous callers proven migrated; G01/G03/G04 closure readback/tests while serving source still not trusting new header | Any direct/tag/internal/alternate path remains; supported client loses service | Restore necessary legacy routing while only non-trusting source serves; review cause |
| M5 activate coordinated source | All route gates hold; deploy reviewed consumer migration to intended image; qualify selected keys/auth/probes; same-SHA application/security gates | Missing/invalid header, key divergence, drift or availability loss | First restore known non-trusting compatible source while closure holds, then reopen legacy route only if necessary |
| M6 stabilize | Explicit monitoring window and fleet sign-off; no missing terminals; retained queues confirmed | Drift/new caller/native rollback incompatibility | Same ordered source-before-route rollback; retain both compatible client artifacts |

M2/M3 deliberately retain the old unqualified trust behavior until route closure.
That is **not remediation or a new risk exception**. Its duration/operational risk
requires owner/reviewer consideration with a concrete rollout, not an indefinite
silent acceptance. A14/A13/A42 and native durability gates stay open; no guaranteed
exactly-once retry assumption is added. A maintenance window alone does not account
for an offline terminal. Unknown clients block M4/M5, even after an arbitrary grace
period. Never mix trusting traffic with reopened default/tag routes.

## Cost estimate (USD; design assumptions, not a purchase)

Official pages retrieved 2026-09-28. Billing/traffic inventory is unknown; this is an
incremental ingress estimate excluding existing Cloud Run/DB/Redis costs. Assume one
new global HTTPS rule, no already-paid global rule allowance, 730h/month, one certificate,
no CDN/Armor/mTLS and processing in Jakarta. Regional data was extracted from the
official page's **Jakarta** row, not the default Iowa table. If processing is billed
elsewhere, use that region's SKU instead.

| Component | Estimate / assumption |
|---|---|
| Global forwarding rules | First five global rules in project collectively $0.025/h → **$18.25/month**; each beyond five $0.01/h. No regional rule charge added. Existing allocation unknown. |
| Assigned global IP | No extra IP charge while assigned to forwarding rule. Unused reserved addresses would incur charges; not proposed. |
| Jakarta LB processing | **$0.00981/GiB inbound and $0.00981/GiB outbound**. Regional forwarding-rule price on that row is not used for this global LB. |
| Internet transfer | Additional region/destination SKU; not folded into processing or claimed free. Supply measured destination/byte mix before approval. |
| NEG/backend | No separate fixed NEG instance cost included; existing Cloud Run compute/requests still billed. Don't double-count LB→serverless transfer. |
| DNS | Reuse authorized DNS when possible. Optional Cloud DNS first-zone rate $0.20/month plus regular $0.40/million queries; registrar/domain price separate and unknown. |
| TLS | Certificate Manager first100/project no certificate charge; proposed RSA2048/ECDSA types have no per-connection certificate charge. Existing certificate count unknown; above tier costs apply. |
| Logs/monitor/security | Incremental retention/ingestion, monitoring and any later Armor/CDN plan excluded and require budget. No new paid security feature assumed. |
| IAP alternative | Google-hosted IAP basic protection has no added IAP charge; LB/network/compute remain. No Chrome Enterprise Premium paid features proposed. Qualification/operations effort remains. |

Examples for **LB fixed + processing only**: 10GiB total processed → **$18.35**;
100GiB → **$19.23**; 1000GiB → **$28.06** per month, rounded to cents. Add optional
DNS $0.60 for one zone/one million queries, actual Internet transfer and logging.
These are not full hosting quotations. Domain, taxes, FX and staff costs are excluded.

For a sizing illustration only, ten terminals polling every 12s for 14h/day over 30 days
would make 1.26 million polls. At assumed 5 KiB combined request/response each that is
6.01 GiB, before sales, catalog pulls, Backoffice and OTA payloads. Terminal count and
bytes are unmeasured; API/Cloud Run costs differ from LB's byte pricing. Budget for
growth instead of treating free-tier credit as capacity design.

[Network pricing](https://cloud.google.com/vpc/network-pricing),
[DNS pricing](https://cloud.google.com/dns/pricing),
[certificate pricing](https://cloud.google.com/certificate-manager/pricing),
[IAP pricing](https://cloud.google.com/iap/pricing).

## Local qualification and its limits

`docs/ingress-design/model` is a separate test module with a local replace to the
unchanged backend. It imports real RequireAuth/RequirePermission, JWT and Cache code.
The edge, route qualification, context selection and migrated key/limiter adapter are
**models**, not a deployed proxy or active router. Synthetic miniredis runs on IPv4
loopback only using actual go-redis operations; no database or live service is used.
The frozen-model clock makes bucket boundaries deterministic. Tests check cleanup by
closing clients/server and verifying the owned listener refuses connections.

Qualified Go1.26.8 is hash-checked and selected per process; normal checksum controls
and global settings stay unchanged. A separate model module reuses the already qualified
miniredis graph. The first run exposed a new fixture-cleanup bug (calling Addr after
Close); it was corrected by retaining the address before Close. Original failing log
and source are preserved. It was not an application or cloud defect.

Final Go model: **40 named passes, zero skips/failures**, plus model vet. Tests cover
replacement versus append, ambiguous input, modeled bypass, normalization/raw peer,
distinct observed peers, unchanged forwarded-header influence, threshold boundaries,
Redis error separation, real missing-token/outlet/permission enforcement, and qualified
HTTP-monitor handling. No assertion that the cloud behaves like the model is made.

The offline schema/checker records design completeness separately from activation.
It rejects deliberate missing-route, open-bypass, append, ambiguous-header, premature
activation and client-reset/closure configurations. Its result is always
`activation_ready:false`. The schema's structural subset is implemented locally;
this is not a general JSON Schema engine or a live cloud validator.

No complete app/DB/browser/security scan was rerun for unchanged active source.
Existing suite evidence retains its original dates/limits. No deployed client/native
test, actual cloud route proof, fresh hosted run or remediation count is added.

## Later activation evidence

The next dependent work is a reviewed commissioning plan resolving G01–G06, not another
chi-only patch. Before any trusting source serves requests, require:

1. Named domain/resource/principal/budget decisions and exact source-to-image mapping
   for the intended, bounded backend change. Inventory current fleet and platform callers.
2. Effective readback of URL maps, header actions, backend/NEG references, default URLs,
   domain mappings, tags, IAM/inherited/impersonation grants and cross-project use.
   Resolve disabled API/access availability explicitly; do not assume an empty result.
3. Approved non-business cloud tests for both URLs, internal callers/LBs, tags, mappings,
   alternative frontends, HTTP1/2 and duplicate/case/header overwrite; ordinary auth,
   preflight, OTA and health behavior. If IAP is needed, resolve Q-IS-01 and test exact
   audience, invalid/expired assertion and unauthorized-origin denial. No real tokens
   or headers in review artifacts.
4. Real fixed-terminal in-place API and native-OTA migration/reboot/rollback with original
   outbox IDs/payloads and tokens retained. Resolve ambiguous in-flight writes under
   existing idempotency/recovery policy; no blind write replay.
5. Coordinate logger/API/auth/OTA/Login changes and strict wrapper in one bounded source
   slice; keep raw peer. Validate rates/Redis behavior and unknown-mode startup failure.
6. Required local application, six isolated DB, browser and codegen/tool-scanner gates;
   same-SHA hosted quality/backend/PostgreSQL/browser and completed expanded security
   assessment after adoption. Exact chi call/advisory changes, no policy exceptions.
7. Stage M4 closure before M5 trust activation, with tested paired rollback and post-change
   readback. No release gate closes from this design packet.

## Programme disposition

E74 records A34e15 qualification reviewed/non-promotion endorsed. E75 is this design
and local-model result, review pending, **no implementation milestone credit**.
32 accepted milestones across 11 findings; all 44 parents retained; A31 alone resolved;
original P0 parents 0/8 resolved and release gates 0. Active6raw/4actionable/23report-only/
2reviewed/0exceptions stays historical active evidence, not a new scan. Detachedchi4/2
is not adopted. A34/T29,A38/T33 remain open; E9/E11 stay closed. SheetJS bytes,
assessments/deadline, policy/exception files and denied cleanup targets are unchanged.
