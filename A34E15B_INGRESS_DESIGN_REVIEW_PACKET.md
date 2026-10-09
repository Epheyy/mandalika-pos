# CURRENT — A34E15B-INGRESS-DESIGN-20260928-01

Responds to **CG-A34E15-CHI-INGRESS-20260928-01-R1** under
AUTH-MANDALIKA-20260919-01. Date: 2026-09-28.

Incoming review resolved and read at:
`C:\Users\MyBook Hype AMD\Downloads\mandalika-pos\review-inbox\CG-A34E15-CHI-INGRESS-20260928-01-R1\CHATGPT_REVIEW_RESPONSE_A34E15-CHI-INGRESS-20260928-01.md`.
READ_FIRST, full named review, full A34E15B scope, decisions and supplied progress
were read in order. No routine authorization request or communication bridge used.

## Disposition and result

A34e15 qualification is recorded **reviewed; non-promotion endorsed**. A34e15b is
design/local qualification, awaiting review. Neither adds an implementation milestone.
Keep **32 accepted milestones across 11 findings**, all 44 parents, A31 alone resolved,
original P0 parents 0/8 resolved and release gates 0. A34/T29,A38/T33 remain open.
Active **6raw /4actionable /23report-only /2reviewed /0exceptions** is retained prior
evidence, not a fresh scan. Detached chi-only4/2 is not adopted. E9/E11 stay closed.

The preferred concrete proposal is a global external Application Load Balancer with
one backend-service header writer and an explicit Jakarta serverless NEG to the
existing service. Its non-applying manifest remains **activation_ready=false**.
The design includes13 route dispositions, coordinated logger/API/auth/OTA/Login identity,
API/native-OTA migration with paired rollback, cost assumptions, and G01–G07 future
commissioning gates. The current middleware/chi graph and application remain unchanged.

Read [the design](docs/A34E15B_INGRESS_DESIGN.md),
[the resource/settings proposal](docs/ingress-design/INGRESS_PROPOSAL.json), and
[IS01–IS18 matrix](docs/ingress-design/IS_MATRIX.json). The ZIP includes exact incremental
patches, before/after bytes, new model source, commands/raw results, supplied operational
observations, public-source provenance, source preservation and payload SHA256 manifest.

## What still prevents activation

The proposed header overwrite is a documented LB feature, not authentication of a
route. Default URLs, mapped/tagged paths, internal callers/LBs and other backend/NEG
references must all be closed or traverse the writer. `internal-and-cloud-load-balancing`
alone is insufficient. Complete route/privilege inventory, feature coverage, source-to-image
equality and installed client versions remain unresolved. No disabled API was retried.

The conditional managed-origin alternative is IAP on the same backend plus Cloud Run
IAM restricted to its service agent and exact backend-audience assertion validation.
**Q-IS-01** is new and precise: public IAP's handling of existing non-Google POS bearer
tokens is not established by the retrieved documentation. Recommend qualification of
that behavior only if the preferred route closure cannot be established. No terminal
Google credentials, secret, new token header or silent auth migration is invented.
The provider question in the design is a draft and was not sent.

The client trace establishes that current native updater configuration does not enable
runtime URL modification. Installed plugin 8.50.2 checks `allowModifyUrl` (default false)
before setUpdateUrl; persistence is separate. A JS bundle API change therefore cannot
be assumed to migrate native OTA. Installed binaries remain unknown. Preserve both
old channels until each supported terminal's API and OTA origin/reboot/rollback are
verified; no logout, storage reset, redirect or queued-fact rewrite is proposed.

The next dependent work is to review this route/identity design and resolve the named
domain/route/fleet/source prerequisites for a bounded non-business commissioning plan.
There is no new generic phase-approval question. Infrastructure/spend/release decisions
remain with the owner; this packet does not apply them.

## Current source and incremental changes

Root: `C:\Users\MyBook Hype AMD\Downloads\mandalika-pos`.
Branch: **audit/hosted-proof-20260922**.
HEAD unchanged: **0478648e6600ce201e0a6e712ac77febdded9782**.
Tree unchanged: **2ac4f0aedd03d18fb07d139ac92de1e691bb92a7**.
Index empty; no commit/push or new hosted result.

At entry, tracked dirty paths were backend/internal/read/repo.go,
docs/A34E14C_CONTRACT_COMPLETION.md, the canonical tracker, plan, draft, progress,
and vendor/sheetjs/xlsx-0.20.3.provenance.json. All unrelated bytes are preserved.
705 entry paths were captured; **698 unchanged**, **7 authorized documentation deltas**,
zero unexpected changes. Existing review-only/untracked material remains in place.

Changes this turn:

- New design, non-applying proposal/schema/checker, IS matrix and public-source register.
- Isolated Go proposal model and Python negative completeness tests under docs/ingress-design;
  no change to application builds/workflows or active module/lock files.
- E74/E75 in current tracker/progress/plan/draft and local handoff/pointer/reconciliation.
  The reconciliation JSON has an actual entry before-image this time. Historical prior
  packets/logs stay untouched; current A34/A38 summary rows were refreshed.

The exact current delta is `diffs/incremental.diff` inside the ZIP; original before-images
and final after-images supply raw Windows-byte identity independently of LF-normalized
patch replay. The bundle does not stage or package unrelated local changes as new work.

## Verification

Only new/changed design/model checks were run. Full programme suites were not repeated.
Exact argv, working directory, exit status, timings and deadlines are in
`evidence/verification.json` and the command records.

| Check | Working directory / command | Actual result |
|---|---|---|
| Qualified Go | Existing Go1.26.8 executable, hash verified before Go work; per-process PATH/GOTOOLCHAIN/local caches | Version 1.26.8 windows/amd64; no global alignment/change |
| Model format | docs/ingress-design/model; qualified gofmt on the two new files | Exit 0 |
| Go model | Same directory; `go test -mod=readonly -count=1 -timeout=45s -json ./...` | Exit 0; **40 named passes**, zero failures/skips, including named parent/subtests |
| Model vet | Same directory; `go vet -mod=readonly ./...` | Exit 0 |
| Proposal CLI | docs/ingress-design; `python -B check_proposal.py INGRESS_PROPOSAL.json` | Exit 0; design_complete=true, activation_ready=false, operational_proof=false |
| Proposal regressions | Same directory; `python -B -m unittest -v test_proposal` | Exit 0; 2 test methods; **16 real-CLI negative cases** correctly return exit 1 |
| Preservation/tracker | Entry versus final SHA256; all detailed A01–A44 headings | 698 unchanged / 7 docs deltas; 44 unique; no active source/dependency change |
| Whitespace | Root; `git diff --check` | Exit 0; existing CRLF normalization warnings retained |

Models cover edge replacement/append counterexample, headers versus observed peers,
raw-peer preservation, IPv4/IPv6/mapped agreement, missing/invalid/duplicate rejection,
modeled bypass, threshold boundaries, actual Cache/Redis failure behavior, and real
RequireAuth/outlet/permission enforcement. No successful DB login or financial mutation
is represented. HTTP monitors use inert handlers; TCP startup is documented, not probed.

One initial **new fixture cleanup** failed because miniredis Addr was read after Close.
The address is now captured before closing, then the closed port is checked. Original
initial source/logs and successful final logs are retained. This is not an application
regression, cloud observation or hidden skipped test. The final additional invalid-Login
guard raises the successful named count from 39 to 40; both successful logs are retained.

Go tests have a 45s internal deadline and 120s supervisor. Python CLI children have 5s
deadlines and the suite 30s. Synthetic Redis binds only 127.0.0.1; successful fixtures
close clients/server and verify refusal on the owned port. No application HTTP server
is started. All command processes exit. New tiny JSON fixtures use an owned temporary
directory; prior denied installation/database cleanup targets are untouched.

Limits: local Windows/non-race models are not cloud topology/native/hosted proof.
The models import actual auth/cache code but the proposed edge/route/identity adapter
is synthetic. No active router edit, current ingress guarantee, external-header probe,
full app/DB/browser run or fresh security assessment is claimed. No API enablement,
provisioning, IAM/DNS/TLS modification, credential change or deployment occurred.

## Cost and preserved controls

Using current official pricing: one global rule at 730h costs about **USD18.25/month**,
plus Jakarta processing **USD0.00981/GiB per direction**. Fixed+processing examples:
10/100/1000 GiB → USD18.35/19.23/28.06; Internet transfer/logging/domain and existing backend
costs are additional. DNS/TLS and conditional IAP assumptions are separated in the design.
The archived official Jakarta row avoids accidentally using the page's default Iowa price.
This is an estimate, not a resource or spending commitment.

SheetJS tarball/provenance, exact assessments and **2026-10-23T00:00:00Z** review deadline,
policy thresholds and empty exceptions are byte-preserved. Accepted codegen/tool scanning,
x/mod/Node families and deployment-skip controls are unchanged. OpenPGP/rgbcolor,
default-local Go alignment, other business work and denied cleanup remain outside scope.

One compact ZIP: **A34E15B-INGRESS-DESIGN-20260928-01.zip**. Its manifest hashes every
payload except itself. Final ZIP/hash/CRC and replay verification are reported alongside
the delivery; no circular self-hash or new hosted verification is implied.
