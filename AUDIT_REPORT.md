# Mandalika POS — code and readiness-plan audit

**Review date:** 19 September 2026  
**Mode:** read-only; no application implementation, repository write, deployment, live database access or production transaction.  
**Primary snapshot:** uploaded `mandalika-pos.rar`, selectively extracted for analysis.  
**GitHub comparison point:** `Epheyy/mandalika-pos`, `prod-hardening@4691c781842f0114acaf2e4371e0d11f0076f553`; branch head rechecked through the authorized connector. Individual critical source files were also fetched at that commit. This does not claim that every nested local file is identical to GitHub.

## Executive conclusion

**The plan is directionally sound but is not complete enough to serve as the sole implementation or release checklist. The code is not demonstrated ready for the stated multi-outlet, crash-durable, offline financial workflows.**

The strongest part of the documentation is its business policy: cash already paid is a fact, inspection is separate from sellability, a payable is separate from settlement, a closed drawer count is not retrospectively rewritten, and loyalty restoration is separate from future-earning adjustment. The draft also correctly carries forward transactional local journaling, atomic server receipts, broad offline inventory coverage, classified retries and operational qualification. Those are not minor cleanups and should remain requirements.

The main problem is incomplete traceability from those requirements to the code. Concrete gaps include original-actor/outlet binding, product transfer/count lifecycle concurrency, complete reporting, a double-subtracted refund summary, stock projection after acknowledgement, linked promotion parity, sub-point redemption arithmetic, local original-receipt retention, and cross-command locking. Broad phrases such as “idempotency,” “inventory,” “rounding” or “integration tests” do not explicitly close these paths.

This register contains **44 grouped findings/design gaps**: **8 P0**, **32 P1**, **3 P2**, **1 P3**. These are review priorities, not 44 demonstrated exploits or production incidents. Some are confirmed code defects, some are approved features not implemented, and some are risks requiring database/device verification. Related findings can share a root cause; counts are not a measurement of overall defect density.

## Scope and evidence limits

The archive inventory contained 18,403 regular files and 653,179,361 uncompressed bytes. A fresh selective extraction produced 586 files / 7,912,836 bytes after dependency directories, build/cache output, known sensitive filenames and binaries were excluded. The prior conversation’s extraction count was 589; the reproducible inventory for this pass is the fresh 586-file selection.

The review mapped backend routes, services, read/write repositories, migrations, API/client seams, POS checkout and offline state, backoffice workflows, shared sync/printer libraries, Android/OTA configuration and operational scripts. Detailed tracing concentrated on financially consequential paths and their dependencies. Generated API/native assets and every visual component were not exhaustively line-reviewed; no static review proves the absence of further bugs. Printer radio behavior, real Android power loss, provider quotas, actual managed backups, IAM, deployed revisions, production data and all concurrent PostgreSQL executions remain unverified.

The review documents were the full `docs/PRODUCTION_READINESS_PLAN.md` (155 lines), the full `docs/PRODUCTION_READINESS_DRAFT.md` (1,136 lines), relevant onboarding/handoff/runbook material, the older `.claude/plans/so-this-entire-thing-mellow-lake.md` architecture, and the August stabilization handoff fetched from the design branch. Historical baseline claims in those documents are not fresh test results.

Excluded sensitive filenames included the release keystore, backend environment file and local Claude settings. Their values were not inspected. Excluding these filenames is not a complete secret scan and does not sanitize the original uploaded archive.

### Domain coverage

| Area | Review performed | Material residual verification |
|---|---|---|
| Auth, routes, permissions | Direct/batch comparison; caller/outlet resolution; refresh/revocation; local bootstrap and approval material | Deployed identity configuration, offline lease and adversarial route integration |
| Sales, tender, pricing, promotions | Transaction path; line/quote trust boundary; allocations; shared pricing functions; direct/linked promotion parity | Complete property vectors, payment confirmation and database-backed command suite |
| Offline journal/sync | Storage, retry/discard, pending projections, bootstrap, receipts, batch dispatch | Real Android durability, migration interruption, device recovery |
| Refund/exchange/void/finance | Current refund vs approved policy; operation/state/schema coverage | Full new workflow implementation and end-to-end money/goods boundary tests |
| Product/ingredient inventory and recipes | Transfers, receipts, counts, adjustments, lock/version patterns, historical movements | Concurrent database tests; operational inspection and stock-conflict policy |
| CRM, loyalty, customer correction | Merge ownership, guest gate, redemption, earning/restoration, aggregates and expiry requirements | Rule configuration, historical lots, data migration and concurrency |
| Reports and exports | UI API requests, pagination, aggregation, date basis, CSV parsing | Full-data reconciliation, performance and spreadsheet export hardening |
| Native, printer, OTA | Source/configuration and receipt lifecycle; shared printer test inventory | Hardware printing, disconnect/paper-out recovery, signed artifact inspection, safe OTA rollback |
| Operations and CI | Migrations, pools, Redis, workflows, backup/restore scripts, release branches | Current provider telemetry, full CI execution, isolated restore and workload qualification |

## What actually ran

| Check | Result | What it does and does not prove |
|---|---|---|
| Nine custom actual-source Node diagnostics | All nine reproduced the targeted behavior | Uses transpiled source, fake API responses and memory/browser-storage stubs. Not Vitest, browser UI, Android or PostgreSQL integration. |
| Isolated existing pure-Go subset | 60 top-level tests passed; 93 pass records including subtests | Unmodified pricing/loyalty/promotion/bundle-test files copied into a separate Go 1.23 module with two exact shared helper definitions. Not the full backend or required Go 1.26 toolchain. |
| Full backend `go test -json ./...` | Blocked before tests ran | Runtime has Go 1.23.2. Automatic Go 1.26 download failed because package-network/DNS access was unavailable. No full-suite pass or fail conclusion. |
| `gofmt -l backend` | Four files listed | Formatting drift observed. The repository’s backend workflow checks for empty output, but that workflow was not run here. |
| Full TypeScript suites, typechecks, production builds | Not run | No fresh claim about their success, historical lint counts or dependency cleanliness. |
| Database concurrency, real Android crash/power loss, provider/load/restore tests | Not run | Required release evidence, not implicitly covered by unit tests. |

### Reproduced diagnostics

**D01 — Storage quota failure silently acknowledges queued sale.** Observed: `{"beforeRestart": 1, "afterRestart": 0}`.

**D02 — Five transient transport errors park the entire pending sale.** Observed: `{"retryable": 0, "parked": 1}`.

**D03 — Ordinary debug-export path removes failed financial events.** Observed: `{"recoverableQueuedEvents": 0, "exportedTextLength": 257}`.

**D04 — Transient per-item receive error is discarded as received elsewhere.** Observed: `{"message": "Penerimaan dibatalkan — transfer sudah diterima di tempat lain. Stok dikembalikan.", "queued": 0, "parked": 0}`.

**D05 — Acknowledged sale drops local stock debit without refreshing snapshot.** Observed: `{"displayBeforeAck": 3, "displayAfterAck": 5, "wallRaised": false}`.

**D06 — Sub-point total gets paid by zero redeemed points.** Observed: `{"total": 0, "redeemedPoints": 0, "redeemAmount": 50}`.

**D07 — Linked tiered promotion drops tier configuration.** Observed: `{"directTotal": 90000, "linkedCodeTotal": 100000}`.

**D08 — CSV escaped quotes are lost.** Observed: `{"expected": "A \"quoted\" name", "actual": "A quoted name"}`.

**D09 — CSV quoted newline becomes an extra record.** Observed: `{"expectedRecords": 1, "actualRecords": 2, "parsed": [{"name": "Alice", "notes": "first"}, {"name": "second", "notes": ""}]}`.

The diagnostic harness asserts the currently observed defective behavior to make reproduction unambiguous. It is **not** a regression suite that should keep passing after repairs. Convert each case into an assertion of the corrected invariant when implementing the fix.

Formatting paths: `backend/internal/service/loyalty.go`, `backend/internal/service/promo_validate_test.go`, `backend/internal/write/loyalty.go`, and `backend/internal/write/repo_test.go`.

## How to read coverage and severity

**Explicit** means the document names the relevant requirement/failure class and desired behavior. **Partial** means the area is mentioned but this concrete invariant, route or acceptance case is not sufficiently specified. **Missing** means no meaningful coverage of this finding was identified in that document. “Explicit” is not “implemented,” nor proof that the technical design is complete.

The condensed plan explicitly covers 7 of these grouped findings, partially covers 30, and has 7 missing. The longer draft explicitly covers 19, partially covers 21, and has 4 missing. These counts describe **this risk-focused register**, not a percentage of all possible problems. A broad item can be partially covered even when its general topic appears many times.

**P0:** resolve before a real-money pilot of the affected workflow; threatens retained facts, authority, or unique financial/stock effects. **P1:** required for the agreed production workflow or a major correctness/security control. **P2:** important quality/defensive hardening. **P3:** maintenance/documentation. Loyalty-specific release blockers apply when that optional feature is enabled; leaving it genuinely disabled is an acceptable staged boundary.

## Finding index

| ID | Priority | Finding | Plan | Draft |
|---|---|---|---|---|
| A01 | P0 | A successful local capture is not a durable commit | Explicit | Explicit |
| A02 | P0 | Transport failures can park financial events and a support action deletes them | Partial | Explicit |
| A03 | P0 | Every per-item transfer-receive error is treated as a permanent competing receipt | Partial | Partial |
| A04 | P0 | Queued events are not bound to their original actor and outlet | Partial | Partial |
| A05 | P1 | Authentication startup conflicts with offline shift recovery | Partial | Partial |
| A06 | P0 | Refund permission is enforced on one route but bypassed by sync | Explicit | Explicit |
| A07 | P1 | Refresh rotation and revocation do not have a durable, atomic authority model | Partial | Partial |
| A08 | P1 | Offline approval distributes reusable PIN verification material | Partial | Explicit |
| A09 | P0 | Ordinary sale-line and tender invariants are not enforced at the command boundary | Partial | Partial |
| A10 | P1 | The original offline quote is not retained independently of recalculation | Partial | Explicit |
| A11 | P0 | Exactly-once effects are not a shared property of every write | Explicit | Explicit |
| A12 | P1 | Shift ownership, concurrent opening and late-event accounting are incomplete | Partial | Partial |
| A13 | P0 | Product transfers can apply concurrent state transitions more than once | Partial | Partial |
| A14 | P1 | Completed product stock counts remain mutable and can overwrite later sales | Partial | Partial |
| A15 | P1 | Acknowledgement can make sold stock reappear on the POS | Missing | Partial |
| A16 | P1 | Required offline inventory workflows are not all represented | Partial | Explicit |
| A17 | P1 | Inventory cannot yet be fully reconciled from a single movement history | Partial | Explicit |
| A18 | P1 | Refund implementation does not represent the accepted return and payout policy | Explicit | Explicit |
| A19 | P1 | Exchange, paid-void and recovery need new domain commands, not status reuse | Explicit | Explicit |
| A20 | P1 | Aggregate points cannot express the accepted restoration, expiry and adjustment rules | Explicit | Explicit |
| A21 | P1 | Online-only redemption cannot be enforced with the existing Offline flag | Explicit | Explicit |
| A22 | P1 | Redemption rounding can give monetary credit while consuming zero points | Partial | Partial |
| A23 | P1 | A linked tiered promotion loses its tier configuration in POS pricing | Partial | Partial |
| A24 | P1 | Guest sales are blocked despite the accepted policy | Partial | Explicit |
| A25 | P1 | Customer merges and corrections need immutable historical ownership rules | Partial | Partial |
| A26 | P1 | Reports and shift recaps silently aggregate only the first 50 records | Missing | Missing |
| A27 | P1 | The backend summary subtracts refunded sales twice | Missing | Missing |
| A28 | P1 | Business time is inconsistent across pricing, reporting and return deadlines | Partial | Partial |
| A29 | P1 | Network and batch error contracts do not support safe recovery | Partial | Explicit |
| A30 | P1 | The permission model needs an operation-by-scope matrix, not UI assumptions | Partial | Partial |
| A31 | P2 | An old polling response can overwrite a newly selected outlet | Missing | Missing |
| A32 | P1 | Startup migration and connection budgeting are not multi-instance safe by design | Partial | Explicit |
| A33 | P1 | Redis remains a required startup/auth dependency and routine traffic amplifier | Partial | Explicit |
| A34 | P1 | CI does not enforce the full financial and client reliability baseline | Partial | Explicit |
| A35 | P1 | OTA and native release gates do not yet protect a financial-journal migration | Partial | Partial |
| A36 | P1 | Backup scripts are not evidence of recoverability and restore lacks guardrails | Partial | Explicit |
| A37 | P1 | Sensitive evidence and local secrets need a separate handling policy | Partial | Partial |
| A38 | P2 | Dependency review is not a full reachability-verified vulnerability audit | Partial | Partial |
| A39 | P2 | CSV import corrupts escaped quotes and multiline fields | Missing | Missing |
| A40 | P3 | Documentation and baseline labels can cause work on the wrong assumptions | Partial | Partial |
| A41 | P1 | An outbox is not a durable local receipt and return-history ledger | Partial | Partial |
| A42 | P1 | Cross-command lock ordering can deadlock under concurrent business operations | Missing | Partial |
| A43 | P1 | Malformed financial request bodies can be accepted with zero/default values | Missing | Explicit |
| A44 | P1 | Historical/deleted variants and stock shortage handling need explicit exceptions | Partial | Partial |

## Detailed findings

### A01 · P0 — A successful local capture is not a durable commit

**Evidence:** Reproduced; native path also confirmed statically. **Coverage:** consolidated plan — Explicit; long draft — Explicit.

**Source locations:** `packages/sync/src/storage.ts:5-48`; `packages/sync/src/storage.ts:65-129`; `packages/sync/src/outbox.ts:50-64`; `docs/PRODUCTION_READINESS_PLAN.md:53-56`; `docs/PRODUCTION_READINESS_DRAFT.md:229-241`.

**Observed / impact.** The KV interface returns void, browser quota failures are swallowed, and native Preferences writes update memory before an unawaited write. A diagnostic queued one event, simulated a storage failure, then reconstructed the outbox: the event disappeared. The native crash window is visible in source but was not reproduced on Android. Migration writes and JSON parse fallbacks also need evidence-preserving failure handling.

**Required change.** Implement the approved transactional SQLite journal, with awaited commit and explicit failure before a successful capture indication. Migrate old queues non-destructively with resumable verification. Separate secrets from business-journal storage; do not relabel app-sandbox Preferences as a transactional or encrypted database.

**Acceptance evidence.** Kill the app before commit, after commit, before acknowledgement, and during migration; inject full disk and malformed stored data. No successful capture may vanish; failures must not silently create a new empty ledger.

### A02 · P0 — Transport failures can park financial events and a support action deletes them

**Evidence:** Reproduced. **Coverage:** consolidated plan — Partial; long draft — Explicit.

**Source locations:** `packages/sync/src/outbox.ts:33-146`; `packages/sync/src/engine.ts:252-277`; `packages/sync/src/engine.ts:347-363`; `apps/pos/src/cashier/CashierScreen.tsx:976-1002`; `docs/PRODUCTION_READINESS_PLAN.md:56-56`; `docs/PRODUCTION_READINESS_DRAFT.md:229-257`.

**Observed / impact.** Five transient request failures exhaust the retry budget. A normal debug/export action then removes parked events and keeps only a capped diagnostic log, not an operationally recoverable financial journal. Both transitions reproduced. A queue count returning to zero therefore does not prove successful reconciliation.

**Required change.** Retry transient transport/infrastructure failures without permanently abandoning the event. Use explicit pending/review/accepted states. Export diagnostics without deleting the underlying event. Permit only audited resolutions that retain original evidence.

**Acceptance evidence.** After a long outage, malformed gateway response, support-log export and device restart, every captured sale/refund still has a recoverable journal entry and visible state.

### A03 · P0 — Every per-item transfer-receive error is treated as a permanent competing receipt

**Evidence:** Reproduced. **Coverage:** consolidated plan — Partial; long draft — Partial.

**Source locations:** `packages/sync/src/engine.ts:306-335`; `docs/PRODUCTION_READINESS_DRAFT.md:243-257`; `docs/PRODUCTION_READINESS_DRAFT.md:259-332`.

**Observed / impact.** A transfer_receive result with a temporary database error enters the same branch as a genuine competing receipt: it removes optimistic credit, discards the queued operation, and tells the cashier that the transfer was received elsewhere. The diagnostic reproduced this with a temporary-error response. Even a real business rejection must retain what the cashier actually received.

**Required change.** Use stable error codes and separate retryable transport failure, authorization review, competing receipt and accepted outcome. Keep the captured receipt and any physical-goods evidence independently of its provisional inventory credit.

**Acceptance evidence.** A temporary database failure stays retryable; a competing receive enters review with the correct reason; neither disappears from the journal.

### A04 · P0 — Queued events are not bound to their original actor and outlet

**Evidence:** Confirmed static path; end-to-end scenario not executed. **Coverage:** consolidated plan — Partial; long draft — Partial.

**Source locations:** `packages/sync/src/engine.ts:170-185`; `packages/sync/src/outbox.ts:1-64`; `backend/internal/sync/sync.go:158-223`; `apps/pos/src/components/OutletSwitcher.tsx:32-58`; `apps/pos/src/auth.tsx:39-53`.

**Observed / impact.** The queue is device-global. Enqueue stamps device/time but no authenticated original actor/outlet envelope. The server constructs each order from the identity and outlet of the caller flushing now. Logout does not partition the queue; outlet switching changes the API context immediately. A later login or outlet can therefore supply a different actor/context for an older event. Related local caches are not consistently partitioned either.

**Required change.** Capture a stable event envelope binding device, original outlet, actor, shift, sequence, schema and authorization evidence. Authenticate reconciliation of that envelope rather than trusting arbitrary client IDs or blindly replacing them with the current user. Define safe account/outlet switching and recovery of old queues.

**Acceptance evidence.** Cashier A captures offline in outlet X, logs out, cashier B logs in or an admin selects Y, and sync resumes: the event remains attributed to A/X and cannot silently mutate Y stock.

### A05 · P1 — Authentication startup conflicts with offline shift recovery

**Evidence:** Confirmed static. **Coverage:** consolidated plan — Partial; long draft — Partial.

**Source locations:** `apps/pos/src/auth.tsx:14-17`; `apps/pos/src/auth.tsx:55-75`; `apps/pos/src/main.tsx:1-26`; `apps/pos/src/hooks/useShift.ts:1-102`; `docs/PRODUCTION_READINESS_PLAN.md:39-39`.

**Observed / impact.** auth.tsx captures getKV() at module evaluation, before main.boot awaits native storage initialization. Startup also clears the saved session on any refresh error, including an outage. Existing shift state is not a durable offline authorization lease. An already-authorized cashier cannot reliably resume the approved shift after an offline reboot.

**Required change.** Resolve storage only after initialization. Distinguish invalid/revoked credentials from temporary inability to refresh. Persist and validate a shift-bounded offline capability and current shift evidence; a new shift still requires online authentication as approved.

**Acceptance evidence.** Offline reboot during an already-authorized shift resumes only that permitted scope. New-shift login, revoked credentials and expired authority remain restricted, while recorded facts are retained.

### A06 · P0 — Refund permission is enforced on one route but bypassed by sync

**Evidence:** Confirmed static. **Coverage:** consolidated plan — Explicit; long draft — Explicit.

**Source locations:** `backend/internal/server/server.go:125-143`; `backend/internal/sync/sync.go:158-162`; `backend/internal/sync/sync.go:236-248`; `docs/PRODUCTION_READINESS_PLAN.md:54-54`.

**Observed / impact.** The direct refund route requires process_refund. The authenticated batch route dispatches refund to the same service without equivalent operation authorization; Caller contains no permissions. The batch path also does not apply the direct route’s nonempty-reason validation. A UI permission gate is not equivalent server enforcement.

**Required change.** Move operation authorization, scope and material input rules into a shared command boundary used by both transports. Preserve an offline cash fact when authorization reconciliation needs review; do not silently treat an invalid request as an approved entitlement.

**Acceptance evidence.** For each role, exercise direct and batch variants of every mutation. They must grant/deny the same new authority, with separately tested handling of already-captured offline facts.

### A07 · P1 — Refresh rotation and revocation do not have a durable, atomic authority model

**Evidence:** Confirmed static; concurrency/recovery tests pending. **Coverage:** consolidated plan — Partial; long draft — Partial.

**Source locations:** `backend/internal/auth/handlers.go:35-49`; `backend/internal/auth/handlers.go:86-116`; `backend/internal/auth/store.go:105-157`; `backend/internal/middleware/middleware.go:13-59`.

**Observed / impact.** Issuance ignores the PostgreSQL refresh-token insert error. Refresh membership is checked in Redis, then removed separately, and the durable revoked flag is not the deciding lookup. Cache loss can invalidate otherwise legitimate sessions; concurrent reuse is not atomically claimed. Role/password changes do not explicitly revoke existing access claims in the inspected update path.

**Required change.** Define durable session families, atomic refresh rotation/reuse handling, token-version or equivalent revocation, and a documented bounded offline authority policy. Redis may accelerate checks but must not be the only authority. Do not solve outages by allowing unauthenticated online writes.

**Acceptance evidence.** Race refreshes, fail the database write, lose Redis, revoke a role, and reboot offline. Outcomes follow one explicit authority policy without issuing a silently non-durable session.

### A08 · P1 — Offline approval distributes reusable PIN verification material

**Evidence:** Confirmed static. **Coverage:** consolidated plan — Partial; long draft — Explicit.

**Source locations:** `packages/sync/src/pin.ts:1-12`; `packages/sync/src/engine.ts:188-204`; `backend/internal/sync/sync.go:125-135`; `backend/internal/read/repo.go:1294-1355`; `docs/PRODUCTION_READINESS_DRAFT.md:243-257`.

**Observed / impact.** Approver PIN hashes are sent to the device and checked locally. Client-side lockout is locally resettable, and a raw approval PIN rides in the queued receive payload until acknowledgement. The design exposes reusable approval material and does not establish durable, bounded offline approval evidence.

**Required change.** Replace distributed password/PIN verifiers with the approved scoped authorization design; remove raw PINs from retained operation payloads. Define revocation, expiry and step-up evidence appropriate to each approved staff role.

**Acceptance evidence.** Capture an authorized offline operation without retaining a raw PIN/hash usable for later approvals. Altered scope, stale authority and unauthorized role fail safely without erasing physical-event evidence.

### A09 · P0 — Ordinary sale-line and tender invariants are not enforced at the command boundary

**Evidence:** Confirmed static; no hostile request sent. **Coverage:** consolidated plan — Partial; long draft — Partial.

**Source locations:** `backend/internal/service/order.go:109-146`; `backend/internal/service/order.go:298-381`; `backend/internal/service/pricing.go:15-70`; `backend/internal/handlers/writes.go:866-965`.

**Observed / impact.** CreateOrder checks for items and outlet but ordinary line quantity, price/subtotal consistency and payment sufficiency do not receive equivalent semantic validation. Stock uses stock - quantity, so a negative quantity increases stock. Cash shortfall merely floors change to zero; noncash amountPaid is replaced with finalTotal. This is not a request to reprice old offline sales using today’s catalog: historical quote preservation is intentional and needs its own trust model.

**Required change.** Validate finite/ranged integer quantities, line/tender conservation, supported payment semantics, discretionary permissions and historical quote evidence. Separate accepting a genuine captured fact into review from granting new sale authority to a malformed or forged command.

**Acceptance evidence.** Exercise negative/zero quantities, altered subtotals, negative/insufficient cash, oversized values, stale legitimate quotes and forged quote references. No malformed ordinary sale can manufacture stock or a silently balanced payment.

### A10 · P1 — The original offline quote is not retained independently of recalculation

**Evidence:** Confirmed static. **Coverage:** consolidated plan — Partial; long draft — Explicit.

**Source locations:** `backend/internal/service/order.go:135-228`; `backend/internal/service/order.go:254-267`; `backend/internal/service/order.go:361-381`; `docs/PRODUCTION_READINESS_DRAFT.md:259-277`.

**Observed / impact.** The server reloads current promotion/loyalty settings and can transform reward lines. quoted_total is populated with the same finalTotal as the recalculated canonical order, rather than a separate captured total. An audit cannot reconstruct a changed offline receipt simply from a field named quoted_total.

**Required change.** Persist immutable captured lines, price/rule versions, allocations, tender collected and receipt total before reconciliation. Keep validation/current-reference differences separately. Never overwrite actual money collected or goods handed over to make a recalculated order look balanced.

**Acceptance evidence.** Sell offline, change catalog/promotion/tax/loyalty settings, then sync. The original receipt and tender remain reproducible; differences are explicit, actionable and do not trigger a second collection.

### A11 · P0 — Exactly-once effects are not a shared property of every write

**Evidence:** Confirmed static. **Coverage:** consolidated plan — Explicit; long draft — Explicit.

**Source locations:** `backend/internal/service/shift.go:24-50`; `backend/internal/service/shift.go:127-136`; `backend/internal/sync/sync.go:249-300`; `backend/internal/service/order.go:123-133`; `backend/internal/write/warehouse.go:113-164`; `docs/PRODUCTION_READINESS_PLAN.md:55-55`.

**Observed / impact.** Cash-flow insertion has no stable command key, and sync shift/cash-flow dispatch does not pass its outer key into an operation receipt. Goods-receipt writes likewise insert effects without the same receipt contract. Existing order uniqueness is useful but does not bind a replay key to operation type, original scope and payload hash, or guarantee an original-result response after a concurrent unique conflict.

**Required change.** Introduce a shared immutable operation receipt committed atomically with effects and audit. Scope keys, verify a request fingerprint, and return the original outcome for same-key retries. Different keys for genuinely separate identical baskets must remain separate sales.

**Acceptance evidence.** Commit then lose the response for each mutation, retry serially and concurrently, and submit an altered body under the same key. There is one logical effect, a stable outcome, and a visible key/body conflict.

### A12 · P1 — Shift ownership, concurrent opening and late-event accounting are incomplete

**Evidence:** Confirmed static; database races not executed. **Coverage:** consolidated plan — Partial; long draft — Partial.

**Source locations:** `backend/internal/service/shift.go:24-136`; `backend/internal/service/order.go:361-381`; `docs/PRODUCTION_READINESS_PLAN.md:39-39`; `docs/PRODUCTION_READINESS_PLAN.md:60-60`; `docs/PRODUCTION_READINESS_PLAN.md:119-119`.

**Observed / impact.** OpenShift checks then inserts without a database-level one-active-shift guard identified in the migrations. Sale and cash-flow commands do not establish the required outlet/actor/open-shift binding beyond a supplied shift reference. Close uses a row lock but writers do not share a closing protocol; current order status rollups are not an immutable close submission plus later settlements.

**Required change.** Define shift lifecycle constraints and a shared write/close protocol. Preserve original capture shift and the later actual cash-moving shift separately. Do not reject already-captured offline cash simply because the original shift is now closed.

**Acceptance evidence.** Race two opens and a sale/cash movement against close; replay close; settle an old return in a new shift. Original drawer count remains immutable and all later effects are correctly attributed.

### A13 · P0 — Product transfers can apply concurrent state transitions more than once

**Evidence:** Confirmed static race; PostgreSQL reproduction pending. **Coverage:** consolidated plan — Partial; long draft — Partial.

**Source locations:** `backend/internal/write/transfer.go:98-107`; `backend/internal/write/transfer.go:224-310`; `backend/internal/write/ingredient_transfer.go:65-83`; `docs/PRODUCTION_READINESS_DRAFT.md:210-257`.

**Observed / impact.** Product transfer state is read without the row lock used by ingredient transfers. Send performs a read-then-write stock guard and the source explicitly accepts a single-admin assumption. Receive’s key/status check is also read before a serialized transfer-state claim. A surrounding transaction alone does not prevent two callers reading the same allowed state. The intended 5–10 backoffice users invalidate the old assumption.

**Required change.** Lock/claim the transfer transition and relevant stock rows deterministically, use guarded updates, and commit the operation receipt with effects. Handle same-event replay separately from genuinely competing physical receipts.

**Acceptance evidence.** Concurrent send/send, receive/receive, send/cancel and different transfers drawing from the same source produce one permitted transition and conserved stock, with durable review evidence for competitors.

### A14 · P1 — Completed product stock counts remain mutable and can overwrite later sales

**Evidence:** Confirmed static. **Coverage:** consolidated plan — Partial; long draft — Partial.

**Source locations:** `backend/internal/write/stockcount.go:133-194`; `backend/internal/write/stockcount.go:197-287`; `backend/internal/write/ingredient_stockcount.go:1-209`; `docs/PRODUCTION_READINESS_DRAFT.md:259-332`.

**Observed / impact.** UpdateStockCount can set a count back to in_progress and replace its lines without checking the existing terminal state. CompleteStockCount writes actual quantities absolutely and marks completed without validating/locking the count state. Repeating completion after a sale can restore the old counted quantity and erase that sale’s stock effect. The draft mentions count baselines/conflicts, but not this terminal-state replay path.

**Required change.** Enforce an immutable terminal lifecycle, lock/claim completion, and return a previous receipt on replay. Reconcile a count against its frozen baseline and intervening movements rather than replaying an old absolute value.

**Acceptance evidence.** Count to ten, sell two, then retry the same completion: stock stays eight. Completed/cancelled counts cannot be reopened or edited through generic update commands.

### A15 · P1 — Acknowledgement can make sold stock reappear on the POS

**Evidence:** Reproduced in isolated engine. **Coverage:** consolidated plan — Missing; long draft — Partial.

**Source locations:** `packages/sync/src/engine.ts:217-232`; `packages/sync/src/engine.ts:306-345`; `backend/internal/service/order.go:298-338`; `apps/pos/src/cashier/SyncProvider.tsx:59-113`.

**Observed / impact.** Pending sales reduce displayed stock only while in outbox.pending(). Acknowledgement removes the debit, but the snapshot is unchanged. Sales/refunds do not update the reference content version in the inspected service path, and the provider does not apply a reconciliation snapshot. Diagnostic: stock five, sell two, display three before acknowledgement, five afterwards, no wall raised. Parked events also stop contributing the pending debit.

**Required change.** Maintain provisional movements until a canonical stock projection covering their receipt/version replaces them. Separate catalog versions from inventory sequence, or otherwise prove projection coverage; avoid double subtraction during refresh.

**Acceptance evidence.** For ack-before-pull, pull-before-ack, late retry, parking and partial refresh, displayed stock includes each physical movement exactly once.

### A16 · P1 — Required offline inventory workflows are not all represented

**Evidence:** Confirmed feature gap. **Coverage:** consolidated plan — Partial; long draft — Explicit.

**Source locations:** `packages/sync/src/outbox.ts:1-33`; `backend/internal/sync/sync.go:184-380`; `docs/PRODUCTION_READINESS_DRAFT.md:210-257`; `docs/PRODUCTION_READINESS_PLAN.md:83-86`.

**Observed / impact.** The current operation set supports transfer_receive but not the required offline transfer creation/sending, goods receiving or stock-count capture/completion workflows. The long draft explicitly retains these requirements. The condensed plan’s refund/finance/inspection phase does not make all of them an unambiguous deliverable.

**Required change.** Add a named inventory-offline workstream covering each agreed workflow, journal schema, provisional state, permission scope, conflict resolution and projection. Do not quietly reduce scope to transfer receiving.

**Acceptance evidence.** During a 60-minute outage, exercise all approved inventory workflows, restart, then reconcile conflicts and dependencies without lost evidence or premature sellable stock.

### A17 · P1 — Inventory cannot yet be fully reconciled from a single movement history

**Evidence:** Confirmed design gap. **Coverage:** consolidated plan — Partial; long draft — Explicit.

**Source locations:** `backend/internal/service/order.go:298-338`; `backend/internal/service/order.go:526-605`; `backend/internal/write/transfer.go:224-420`; `backend/internal/write/warehouse.go:113-215`; `backend/internal/write/stockcount.go:249-280`; `docs/PRODUCTION_READINESS_DRAFT.md:229-257`.

**Observed / impact.** Sales, refunds and transfers update stock balances directly; goods receipts/adjustments/counts carry separate records. There is no unified immutable movement trail covering every mutation in the inspected paths. A current balance alone cannot explain a late sale, retry, count correction, tester hold and return release together.

**Required change.** Give every stock effect a source operation, location, quantity, disposition, original occurrence time and reversal/correction link. Make projections rebuildable and reconcile transfer source/destination/in-transit quantities. Keep physical inspection separate from sellability.

**Acceptance evidence.** Rebuild balances from movements and match all locations. Explain every stock delta through a business event, including cancelled/reversed/provisional operations.

### A18 · P1 — Refund implementation does not represent the accepted return and payout policy

**Evidence:** Confirmed policy/feature gap. **Coverage:** consolidated plan — Explicit; long draft — Explicit.

**Source locations:** `backend/internal/service/order.go:526-651`; `apps/pos/src/cashier/OrderHistoryPanel.tsx:1-300`; `docs/PRODUCTION_READINESS_PLAN.md:28-36`; `docs/PRODUCTION_READINESS_PLAN.md:57-57`.

**Observed / impact.** Refund currently short-circuits repeated refunded status and performs stock/points changes in a transaction, which is useful. But it is not the required entitlement, original-receipt verification, sealed-main inspection, tester disposition, cross-outlet return, five-day/SPV exception, payable and actual cash/transfer settlement system. Blanket restocking conflicts with retained testers and inspection holds.

**Required change.** Implement explicit return entitlement, physical receipt, disposition, payable and settlement records. Preserve permitted offline cash payout facts and cross-outlet online authorization. No automatic cash repayment just because a previous reconciliation response is unknown.

**Acceptance evidence.** Run every consolidated refund scenario, including tester retained, late authorization, cross-outlet race, manual transfer, cash/transfer method switch and full refund after an exchange chain.

### A19 · P1 — Exchange, paid-void and recovery need new domain commands, not status reuse

**Evidence:** Confirmed policy/feature gap. **Coverage:** consolidated plan — Explicit; long draft — Explicit.

**Source locations:** `backend/internal/sync/sync.go:184-380`; `backend/internal/service/order.go:526-651`; `docs/PRODUCTION_READINESS_PLAN.md:33-38`; `docs/PRODUCTION_READINESS_DRAFT.md:334-895`; `docs/PRODUCTION_READINESS_DRAFT.md:1022-1136`.

**Observed / impact.** No inspected command/state machine implements the approved component-level exchange chain, confirmed upgrade handover, downgrade payable, original-open-shift TL void/correction, or audited recovery after money/goods movement. The documents describe these unusually well, but descriptions are not database transitions or implemented cashier/finance workflows.

**Required change.** Introduce linked immutable entities and guarded transitions for original allocations, replacement quote, physical handover, payment confirmation, payable settlement and compensating recovery. Attach authority and uncertainty evidence at each irreversible step.

**Acceptance evidence.** Crash or lose response at every money/goods boundary. Retrying never collects/pays twice; a pending downgrade remains owed; cancellation after movement requires the approved recovery, not a status flip.

### A20 · P1 — Aggregate points cannot express the accepted restoration, expiry and adjustment rules

**Evidence:** Confirmed policy gap; feature can remain disabled. **Coverage:** consolidated plan — Explicit; long draft — Explicit.

**Source locations:** `backend/internal/service/order.go:230-295`; `backend/internal/service/order.go:605-647`; `backend/internal/write/points.go:1-81`; `docs/PRODUCTION_READINESS_PLAN.md:43-47`; `docs/PRODUCTION_READINESS_PLAN.md:58-59`.

**Observed / impact.** Current earning/redemption uses a cached aggregate balance and transaction records without the required expiry-lot and historical allocation model. Refund floors earned-point recovery to what is available, forgiving the remainder instead of recording a future-earnings offset. Available restored points must not be consumed by that offset.

**Required change.** Keep loyalty disabled until policy/settings are approved. When enabled, implement lots, original earning/conversion evidence, deterministic item allocations, consumed/restored points and a separate adjustment balance. Retry must not extend expiry or award again.

**Acceptance evidence.** Use points before refund, restore previously redeemed points, change expiry settings during an outage and correct the account. Cash is unaffected, points conserve, restoration remains spendable and adjustments offset only future new earnings.

### A21 · P1 — Online-only redemption cannot be enforced with the existing Offline flag

**Evidence:** Confirmed static. **Coverage:** consolidated plan — Explicit; long draft — Explicit.

**Source locations:** `backend/internal/sync/sync.go:195-223`; `backend/internal/service/order.go:254-267`; `apps/pos/src/cashier/CheckoutPanel.tsx:302-341`; `docs/PRODUCTION_READINESS_PLAN.md:43-45`; `docs/PRODUCTION_READINESS_PLAN.md:59-59`.

**Observed / impact.** No online-only redemption guard exists in the inspected command. Normal POS sales all travel through batch with Offline:true, including when the device is online. Simply rejecting all Offline:true redemptions would break the desired online POS flow, while a UI-only disable is bypassable.

**Required change.** Design an online authorization/reservation or finalization proof for redemption, bound to the sale and point lots; do not use a coarse transport flag as proof of connectivity or authority. Retain pending offline earnings and eligible offline full-refund restoration as approved.

**Acceptance evidence.** Online redemption succeeds exactly once; disconnected redemption cannot create new entitlement; losing a response or returning the sale does not lose/respend reserved points.

### A22 · P1 — Redemption rounding can give monetary credit while consuming zero points

**Evidence:** Reproduced in POS; equivalent backend arithmetic confirmed. **Coverage:** consolidated plan — Partial; long draft — Partial.

**Source locations:** `apps/pos/src/cashier/pricing.ts:391-400`; `backend/internal/service/order.go:254-267`.

**Observed / impact.** When redemption exceeds the total, money is clamped to the total and point consumption is then floored without recomputing the money credit. With a total of Rp50 and Rp100 per point, requesting one point produces Rp50 credit, zero consumed points and zero remaining cash. This is a direct conservation defect, separate from the business choice of loyalty rates.

**Required change.** Approve one deterministic rounding/allocation rule and derive both quantities from it using integer money. Handle sub-point remainders explicitly; share golden vectors across Go and TypeScript.

**Acceptance evidence.** For every total near a conversion boundary, the value credited equals the value of points actually consumed under the approved rule, and cash plus points equals the payable.

### A23 · P1 — A linked tiered promotion loses its tier configuration in POS pricing

**Evidence:** Reproduced. **Coverage:** consolidated plan — Partial; long draft — Partial.

**Source locations:** `apps/pos/src/cashier/promoValidate.ts:113-178`; `apps/pos/src/cashier/pricing.ts:305-362`; `backend/internal/service/order.go:135-166`.

**Observed / impact.** LinkedPromotionInfo/linkedPromoShape omit tieredConfig when a discount code references a tiered promotion. Diagnostic: a direct 10% tier on Rp100,000 totals Rp90,000, while the linked-code route totals Rp100,000. The promotion’s identity is not sufficient if its rule payload is lost.

**Required change.** Carry the full versioned promotion shape through selection, validation, pricing and captured quote. Build parity vectors for direct vs linked tiered, bundles, rewards, stacking, caps and eligible-item allocations.

**Acceptance evidence.** The same rule/version/cart has the same allocation and total through direct and code-linked paths; server reconciliation preserves the captured business fact if an old client differs.

### A24 · P1 — Guest sales are blocked despite the accepted policy

**Evidence:** Confirmed static. **Coverage:** consolidated plan — Partial; long draft — Explicit.

**Source locations:** `apps/pos/src/cashier/CashierScreen.tsx:365-380`; `docs/PRODUCTION_READINESS_PLAN.md:40-41`; `docs/PRODUCTION_READINESS_DRAFT.md:896-962`.

**Observed / impact.** The cashier checkout-opening path returns early when no customer is selected. This resolves the draft’s earlier uncertainty about whether selection is mandatory: the inspected implementation does block a general guest sale. A customer may still be legitimately required for a particular loyalty or customer-assigned promotion.

**Required change.** Remove the blanket customer requirement while preserving conditional feature-specific rules. Support later guest attachment only through the approved TL/open-shift historical-rule workflow.

**Acceptance evidence.** An ordinary guest cash sale completes without inventing a customer. Customer-specific offers still enforce their actual eligibility; later attachment cannot award twice.

### A25 · P1 — Customer merges and corrections need immutable historical ownership rules

**Evidence:** Confirmed static; some aggregate definitions remain policy decisions. **Coverage:** consolidated plan — Partial; long draft — Partial.

**Source locations:** `backend/internal/write/merge.go:170-250`; `backend/internal/service/order.go:135-146`; `backend/internal/service/order.go:230-240`; `backend/internal/service/order.go:400-430`; `backend/internal/service/order.go:605-647`; `docs/PRODUCTION_READINESS_PLAN.md:40-46`.

**Observed / impact.** Duplicate merges rewrite associated order/interaction/points ownership into a keeper; this is not the new constrained account-correction command. Promo evaluation uses a submitted customer ID before later merge resolution. Refund also does not mirror all lifetime spend/visit aggregates updated at sale time. The intended meaning of lifetime visits versus net spending needs definition rather than blindly decrementing everything.

**Required change.** Preserve original and effective account linkage, resolve merges before customer-specific eligibility, and define policy for coupon caps, assigned codes, historical earning rules and offline events racing a merge/correction. Separate net-spend metrics from deliberately historical visit counts.

**Acceptance evidence.** Merge/correct while an old device has pending sales and a customer-limited code. No cap bypass, lost expiry provenance, double award or untraceable ownership rewrite occurs.

### A26 · P1 — Reports and shift recaps silently aggregate only the first 50 records

**Evidence:** Confirmed static request/response path. **Coverage:** consolidated plan — Missing; long draft — Missing.

**Source locations:** `backend/internal/handlers/handlers.go:71-84`; `apps/backoffice/src/screens/Reports.tsx:62-95`; `apps/backoffice/src/screens/Dashboard.tsx:62-75`; `apps/pos/src/cashier/ShiftRecapPanel.tsx:165-219`.

**Observed / impact.** pageLimit resets limits above 200 to 50. Backoffice Reports/Dashboard request 500, and the POS shift recap requests 1,000, then uses r.data without paging. Date/status filters and totals are applied to this limited set. A day or shift with more than 50 records can look complete while omitting transactions; older selected periods can look empty.

**Required change.** Use server-side date/outlet/status filters and authoritative aggregation endpoints for totals. Paginate all detailed exports or show explicit truncation. Do not fix this by simply requesting 200: that moves the silent cutoff rather than removing it.

**Acceptance evidence.** With over 50, 200 and 1,000 orders, compare UI totals, shift recap and CSV exports against the full ledger for the selected period/outlet. Metadata and counts must agree.

### A27 · P1 — The backend summary subtracts refunded sales twice

**Evidence:** Confirmed SQL arithmetic; not executed against PostgreSQL. **Coverage:** consolidated plan — Missing; long draft — Missing.

**Source locations:** `backend/internal/read/reports.go:20-64`.

**Observed / impact.** ReportSummary.total_sales already sums only completed orders, excluding refunded ones. netSales then subtracts total_refunds again. Example derived from the query: two Rp100,000 sales, one fully refunded, yield total_sales=Rp100,000 and total_refunds=Rp100,000, so netSales=0 instead of Rp100,000. The currently inspected Reports screen has a separate client-side aggregation path; this finding is about the backend summary endpoint.

**Required change.** Define gross captured sales, refunds/returns and net sales once, with an explicit occurrence/settlement time basis, then use the same model across endpoints and screens.

**Acceptance evidence.** Test no refund, full refund, cross-day refund, exchange upgrade/downgrade and post-close payout. Gross minus the intended returns/adjustments equals net exactly once.

### A28 · P1 — Business time is inconsistent across pricing, reporting and return deadlines

**Evidence:** Confirmed mixed implementation; desired calendars remain open. **Coverage:** consolidated plan — Partial; long draft — Partial.

**Source locations:** `backend/internal/service/order.go:135-146`; `backend/internal/read/reports.go:21-53`; `apps/backoffice/src/screens/Reports.tsx:62-87`; `docs/PRODUCTION_READINESS_PLAN.md:30-30`; `docs/PRODUCTION_READINESS_PLAN.md:137-140`.

**Observed / impact.** Pricing uses a fixed WIB conversion, reports group database created_at, and UI date defaults use UTC ISO date fragments while range filtering uses local day boundaries. Late offline ingestion can land in a different reporting day. Do not assume all outlets use one timezone based on the project description.

**Required change.** Specify outlet business timezone/calendar and distinct captured_at, accepted_at, settled_at and business_date fields. Use versioned calendar rules for original-date return eligibility and policy-approved clock-skew handling.

**Acceptance evidence.** Test midnight, overnight closing, five-calendar-day expiry, changed device clocks and a late offline batch crossing dates. Reports and eligibility follow the same approved business calendar.

### A29 · P1 — Network and batch error contracts do not support safe recovery

**Evidence:** Confirmed static. **Coverage:** consolidated plan — Partial; long draft — Explicit.

**Source locations:** `packages/api/src/client.ts:335-392`; `packages/sync/src/engine.ts:289-363`; `backend/internal/sync/sync.go:167-180`; `backend/internal/handlers/handlers.go:114-123`; `backend/internal/httpx/httpx.go:1-49`.

**Observed / impact.** API and refresh fetches lack client abort deadlines. JSON parsing happens before non-success status classification. Flush sends every pending item as one batch; the server loops the entire batch without an explicit per-operation budget. Many infrastructure failures become generic/raw 400 errors. The server does have HTTP read/write timeouts, but those do not establish bounded, dependency-aware client recovery.

**Required change.** Add bounded batches, request deadlines, structured error codes, retry-after/backoff/jitter, independent versus dependent operation handling, body/array limits and sanitized error responses. Distinguish gateway/transport uncertainty from definitive command rejection.

**Acceptance evidence.** Inject hanging requests, HTML 502, 429, 503, partial results, expired auth and a very large queue. Unrelated operations progress; dependencies retain ordering; no event disappears.

### A30 · P1 — The permission model needs an operation-by-scope matrix, not UI assumptions

**Evidence:** Confirmed inconsistencies; some intended scope is unresolved. **Coverage:** consolidated plan — Partial; long draft — Partial.

**Source locations:** `backend/internal/server/server.go:100-143`; `backend/internal/handlers/handlers.go:53-68`; `apps/pos/src/components/OutletSwitcher.tsx:32-58`; `backend/internal/write/stockcount.go:133-152`; `backend/internal/handlers/writes.go:25-62`; `docs/PRODUCTION_READINESS_PLAN.md:137-146`.

**Observed / impact.** The POS offers outlet switching to managers and admins, but backend outlet override is admin-only. Several read routes are available to any authenticated user, while backoffice UI permissions distinguish reports/transactions. Warehouse counts intentionally use permission-only scope. These are concrete scope differences; whether a manager is meant to have global inventory/customer visibility is a business/security decision, not something to invent.

**Required change.** Publish and enforce a matrix of command/read, role/permission, outlet/warehouse/customer scope, direct/batch route and offline authority. Keep global backoffice permissions where explicitly approved, but stop presenting an outlet switch the server does not honor.

**Acceptance evidence.** Positive and negative authorization tests cover every route and supported role, including cross-outlet return verification, warehouse operations and manager outlet selection.

### A31 · P2 — An old polling response can overwrite a newly selected outlet

**Evidence:** Confirmed static async race; React runtime test pending. **Coverage:** consolidated plan — Missing; long draft — Missing.

**Source locations:** `apps/backoffice/src/hooks/usePolledQuery.ts:25-67`.

**Observed / impact.** The hook uses one alive ref. A dependency change sets it false in cleanup then true for the new effect. An older in-flight request resolving afterwards sees true and can write data for the prior outlet into the new view. Overlapping interval responses can similarly arrive out of order.

**Required change.** Associate each request with a monotonically increasing scope/request generation or AbortController, and apply results only to the matching active generation. Preserve explicit stale/error labels.

**Acceptance evidence.** Start a slow outlet-A query, switch to B, resolve B then A: only B remains visible. An old response cannot clear B’s loading/error state.

### A32 · P1 — Startup migration and connection budgeting are not multi-instance safe by design

**Evidence:** Confirmed static risk; multi-instance test pending. **Coverage:** consolidated plan — Partial; long draft — Explicit.

**Source locations:** `backend/cmd/server/main.go:32-46`; `backend/internal/db/db.go:21-45`; `backend/internal/db/db.go:50-105`; `docs/PRODUCTION_READINESS_DRAFT.md:243-257`.

**Observed / impact.** Every process runs migrations. The migration existence check is outside the application transaction and no migration advisory lock is present. Multiple cold starts can race. Pool idle/lifetime settings exist, but no explicit MaxConns budget is set in source; a deployment URL could override it, which was not inspected.

**Required change.** Use a serialized migration phase or proven advisory-lock protocol. Budget per-instance connections against the chosen maximum instance count, reserve operational capacity and require backward-compatible schema rollout for old APKs.

**Acceptance evidence.** Start several fresh instances together, interrupt migration and roll back app versions. Schema stays consistent and the total connection budget stays within measured limits.

### A33 · P1 — Redis remains a required startup/auth dependency and routine traffic amplifier

**Evidence:** Confirmed source behavior; actual quotas unmeasured. **Coverage:** consolidated plan — Partial; long draft — Explicit.

**Source locations:** `backend/cmd/server/main.go:43-46`; `backend/internal/server/server.go:45-74`; `backend/internal/auth/handlers.go:44-49`; `backend/internal/cache/cache.go:1-80`; `apps/pos/src/cashier/SyncProvider.tsx:111-114`; `docs/PRODUCTION_READINESS_DRAFT.md:963-1006`.

**Observed / impact.** Redis connection failure aborts startup; deep health requires Redis; refresh membership depends on it. Every request traverses Redis-based global limiting, with additional cache and auth/OTA work. POS polling is currently 12 seconds, not the historical handoff’s 20 seconds. No provider telemetry was accessed, so this is not a measured bill or a claim that current quotas are exceeded.

**Required change.** Implement the approved separation of canonical financial truth from optional cache. Measure commands/requests per device/day, authentication and cold starts, retention/storage growth, peak reconnect bursts and backoffice traffic. Set warning/action/upgrade thresholds from actual current provider limits.

**Acceptance evidence.** With Redis unavailable, already-authorized financial processing retains correctness under the approved authority model. At 25+ outlets and 12–14-hour active days, measured resource use stays within agreed budgets.

### A34 · P1 — CI does not enforce the full financial and client reliability baseline

**Evidence:** Confirmed configuration and local formatting evidence. **Coverage:** consolidated plan — Partial; long draft — Explicit.

**Source locations:** `.github/workflows/backend.yml:1-28`; `.github/workflows/react-doctor.yml:1-50`; `.github/workflows/android-release.yml:1-78`; `packages/sync/package.json:1-24`; `docs/PRODUCTION_READINESS_DRAFT.md:243-257`.

**Observed / impact.** Backend CI has useful generation, vet, build and race-test steps, but there is no equivalent mandatory TypeScript test workflow. The sync package has test files but no test script. Current gofmt -l returns four files, conflicting with the workflow’s empty-output gate. The inspected prod-hardening branch reports protection disabled; repository/ruleset-wide enforcement beyond that response was not exhaustively audited.

**Required change.** Wire every package’s tests/typechecks, deterministic builds, backend integration/concurrency and secret/dependency checks into required checks for the actual release path. Distinguish advisory lint from blocking gates and bind a tested commit to the signed APK/OTA artifact.

**Acceptance evidence.** A deliberately failing sync test, financial DB invariant, generated-contract drift or release debug flag blocks promotion. Capture fresh command logs and artifact hashes, not old handoff counts.

### A35 · P1 — OTA and native release gates do not yet protect a financial-journal migration

**Evidence:** Confirmed static; device/supply-chain behavior untested. **Coverage:** consolidated plan — Partial; long draft — Partial.

**Source locations:** `backend/internal/ota/decide.go:5-31`; `apps/pos/src/App.tsx:132-144`; `apps/pos/capacitor.config.ts:1-54`; `scripts/ota-release.sh:1-97`; `apps/pos/android/app/src/main/AndroidManifest.xml:1-15`.

**Observed / impact.** The OTA decision compares a version string to the latest release and returns URL/checksum, without app/native/journal/API compatibility bounds in the release model. Readiness is acknowledged at the first App render, before a future journal migration or financial recovery has been demonstrated. Native debug logging/WebView debugging remain enabled; Android backup is enabled without a financial-device-identity policy evident here.

**Required change.** Define supported native/API/journal versions, immutable authenticated release artifacts, staged rollout and a rollback that does not make newer journal data unreadable. Tie readiness to required local recovery without waiting for network. Test backup/restore/reinstallation identity and key handling.

**Acceptance evidence.** Upgrade and roll back with pending sales and an interrupted migration. No duplicate device identity, unreadable journal or silent event loss occurs. Production artifact inspection confirms debug settings and backup policy.

### A36 · P1 — Backup scripts are not evidence of recoverability and restore lacks guardrails

**Evidence:** Confirmed script behavior; external automation unknown. **Coverage:** consolidated plan — Partial; long draft — Explicit.

**Source locations:** `scripts/db-backup.sh:17-26`; `scripts/db-restore.sh:9-23`; `docs/PRODUCTION_READINESS_PLAN.md:96-100`.

**Observed / impact.** Backup validation only lists the dump catalog. Retention keeps the last 14 files, not necessarily 14 daily recovery points. Restore prints the complete target URL, uses a destructive clean operation and does not request a single-transaction restore. No scheduled backup workflow was found in this repository, but external scheduling/managed backups may exist and were not inspected.

**Required change.** Add explicit safe-target verification, secret-free logging, failure-atomic restore procedure, encrypted off-host retention and measured recovery objectives. Prove business balances/receipts/ledger reconciliation after restoration, not just row counts.

**Acceptance evidence.** Restore to an isolated disposable target and reconcile orders, stock, settlements, point lots and command receipts. Replaying post-backup device journals does not duplicate already-restored effects.

### A37 · P1 — Sensitive evidence and local secrets need a separate handling policy

**Evidence:** Confirmed configuration/filenames; no secret values inspected. **Coverage:** consolidated plan — Partial; long draft — Partial.

**Source locations:** `packages/sync/src/engine.ts:252-277`; `apps/pos/src/cashier/SyncProvider.tsx:66-80`; `apps/pos/src/lib/errorReporter.ts:1-93`; `apps/pos/capacitor.config.ts:18-27`; `scripts/db-restore.sh:13-15`.

**Observed / impact.** The upload still contained excluded .env, release-keystore and local settings filenames; they were not opened for this review. Sync/support payloads can contain customer and transaction details, debug logging is enabled, and restore logs the database URL. Top-level PIN redaction is not a complete nested-secret/PII policy.

**Required change.** Inventory secret locations and access without exposing values. Sanitize nested diagnostics, define consent/access/retention for customer and financial evidence, encrypt appropriate local/server data, and produce a sanitized sharing archive. Assess whether exposure requires rotation; do not destroy a release keystore or blindly rotate it without a signing continuity plan.

**Acceptance evidence.** Inject marker secrets and sensitive sample customer data into nested errors. Logs, exports and telemetry retain useful diagnostics without unauthorized disclosure; operational evidence remains accessible only to approved roles.

### A38 · P2 — Dependency review is not a full reachability-verified vulnerability audit

**Evidence:** Verified advisory/version concern; exploitability not established. **Coverage:** consolidated plan — Partial; long draft — Partial.

**Source locations:** `apps/backoffice/package.json:1-34`; `apps/backoffice/src/lib/csvUtils.ts:1-124`; `backend/go.mod:1-46`.

**Observed / impact.** The backoffice declares xlsx ^0.18.5. SheetJS’s CVE-2024-22363 advisory concerns crafted spreadsheet parsing in versions before 0.20.2. The inspected call site uses XLSX export, not untrusted XLSX parsing, so this is not proof of a reachable exploit. No complete live npm/Go advisory scan was possible in the isolated runtime; old version numbers alone are not vulnerability findings.

**Required change.** Run current lockfile-based advisory and license checks in CI, verify reachability, upgrade or replace affected dependencies through the vendor-supported distribution path, and retest generated contracts/native plugins. Record justified exceptions instead of claiming all dependencies clean.

**Acceptance evidence.** Produce a dated dependency/SBOM report tied to the release lockfiles, with reachable findings fixed or an approved risk exception and regression evidence.

### A39 · P2 — CSV import corrupts escaped quotes and multiline fields

**Evidence:** Reproduced; formula-export hardening identified statically. **Coverage:** consolidated plan — Missing; long draft — Missing.

**Source locations:** `apps/backoffice/src/lib/csvUtils.ts:1-124`.

**Observed / impact.** parseCSV splits physical lines and removes quote characters rather than implementing full CSV field escaping. Diagnostics changed A "quoted" name into A quoted name and turned one quoted multiline record into two. CSV export quoting also is not a spreadsheet-formula-neutralization policy for user-entered values.

**Required change.** Use a standards-conformant parser, explicit column/type validation and preview/error reporting. Define safe spreadsheet export treatment for values beginning with formula characters, without corrupting legitimate stored data.

**Acceptance evidence.** Round-trip commas, doubled quotes, CRLF, embedded newlines, Unicode, empty cells and formula-like user strings. A malformed import reports row/column errors rather than silently altering customers/products.

### A40 · P3 — Documentation and baseline labels can cause work on the wrong assumptions

**Evidence:** Confirmed documentary/configuration drift. **Coverage:** consolidated plan — Partial; long draft — Partial.

**Source locations:** `README.md:1-30`; `RUNBOOK.md:1-100`; `ONBOARDING.md:145-170`; `.claude/plans/so-this-entire-thing-mellow-lake.md:117-197`; `docs/PRODUCTION_READINESS_PLAN.md:8-21`; `docs/PRODUCTION_READINESS_DRAFT.md:1007-1021`.

**Observed / impact.** Root README remains starter boilerplate and RUNBOOK leads with an earlier hosting direction. The old blueprint calls offline values provisional/server-recomputed and claims append-only implies conflict-free; later decisions preserve completed offline facts and require conflict review. Earlier tests and polling intervals are historical. Large cashier/service modules and four gofmt findings are maintenance debt, not substitutes for financial blockers.

**Required change.** Make one current entry point, identify superseded decisions explicitly, document the actual branch/release path and maintain a decision–command–test map. Treat source formatting separately from behavior, but make both reproducible.

**Acceptance evidence.** A new developer can identify the approved current policy, target branch, exact verification commands and unresolved decisions without interpreting contradictory historical handoffs.

### A41 · P1 — An outbox is not a durable local receipt and return-history ledger

**Evidence:** Confirmed static gap. **Coverage:** consolidated plan — Partial; long draft — Partial.

**Source locations:** `apps/pos/src/cashier/CashierScreen.tsx:810-874`; `apps/pos/src/cashier/OrderHistoryPanel.tsx:1-300`; `packages/sync/src/outbox.ts:142-146`; `docs/PRODUCTION_READINESS_PLAN.md:28-29`.

**Observed / impact.** The latest receipt is held in a React ref, while acknowledged outbox entries are pruned and order-history caching is a separate online snapshot. Capturing a sale is not the same as adding an immutable, queryable local original receipt that survives reboot and remains usable for approved same-outlet offline verification.

**Required change.** Derive receipts and offline lookup/history from the durable journal plus canonical records, including original number, item allocations, paid tender and accepted/review status. Reprinting must never recapture a sale; a printer failure must not hide successful durable capture.

**Acceptance evidence.** Sell offline, reboot, reprint and locate the original sale for an eligible return before reconnecting. The same receipt is available without re-entry or a second sale.

### A42 · P1 — Cross-command lock ordering can deadlock under concurrent business operations

**Evidence:** Confirmed inconsistent ordering; specific database deadlock not reproduced. **Coverage:** consolidated plan — Missing; long draft — Partial.

**Source locations:** `backend/internal/service/order.go:162-166`; `backend/internal/service/order.go:243-250`; `backend/internal/service/order.go:298-337`; `backend/internal/service/order.go:526-647`; `backend/internal/write/merge.go:51-250`.

**Observed / impact.** Create-order, refund and customer-merge operations acquire different combinations of code/customer/order/stock locks in different orders. Product iteration order is also request-dependent. PostgreSQL will abort a deadlock victim; the current generic retry/parking behavior can then turn a recoverable concurrency error into an operationally abandoned event. This is a credible risk, not an observed production incident.

**Required change.** Define a lock hierarchy and deterministic resource ordering; shorten critical sections. Classify serialization/deadlock failures as retryable with idempotent command receipts. Do not weaken existing useful locks to hide the contention.

**Acceptance evidence.** Run parallel sale/refund/merge/transfer combinations with deliberately reversed product order. Either they serialize or a safe retry completes once; no parked or duplicated financial effect remains.

### A43 · P1 — Malformed financial request bodies can be accepted with zero/default values

**Evidence:** Confirmed static. **Coverage:** consolidated plan — Missing; long draft — Explicit.

**Source locations:** `backend/internal/handlers/writes.go:1056-1090`; `backend/internal/handlers/writes.go:1200-1230`; `backend/internal/httpx/httpx.go:1-49`.

**Observed / impact.** OpenShift, CloseShift and the inspected count-completion handler ignore DecodeLoose errors. A malformed close request can proceed with a default closingCash value. Some post-write reads also ignore errors and return a success envelope with missing data, creating an uncertain outcome for clients.

**Required change.** Fail malformed requests before new mutations; validate required numeric fields and finite ranges. Return a stable command receipt even if a post-commit projection read fails, rather than inviting a blind duplicate submission.

**Acceptance evidence.** Malformed/truncated JSON, missing required values and failed read-back yield the correct classified result. No default-zero drawer close or accidental repeated count completion occurs.

### A44 · P1 — Historical/deleted variants and stock shortage handling need explicit exceptions

**Evidence:** Confirmed static; disposition policy required. **Coverage:** consolidated plan — Partial; long draft — Partial.

**Source locations:** `backend/internal/service/order.go:298-337`; `docs/PRODUCTION_READINESS_DRAFT.md:259-277`.

**Observed / impact.** An ordinary line whose stock row cannot be associated with an existing variant is skipped for inventory mutation. Online shortages are floored to zero, whereas offline shortages can be negative and flagged. Legitimate offline sales of a since-deleted item must survive, but silently skipping their stock effect is not a reconciled historical movement.

**Required change.** Preserve tombstoned/versioned item identities and route unresolved stock movements into a durable exception ledger. Decide new-online-sale shortage authorization separately from acceptance of already-completed offline sales.

**Acceptance evidence.** Delete/deactivate a variant after an offline sale and sync it; its physical movement remains explainable. New online overselling cannot silently disappear into a zero floor.

## Important protections already present

Do not respond to this audit by discarding all existing implementation. The order service wraps major effects in a transaction and uses durable uniqueness; refund locks the original order and short-circuits an already-refunded order; shift close locks and recognizes a closed state. Ingredient transfers/counts demonstrate stronger lifecycle locking than their product counterparts. Recipe versioning/expected-version checks and customer-merge locking provide useful patterns. There are meaningful pure-logic pricing/promotion/loyalty tests and backend generation/race-test CI steps.

These are foundations to preserve and extend. They do not prove end-to-end exactly-once behavior or compliance with new return/finance policies. Likewise, a row-locking fix does not replace a receipt contract, and a new SQLite dependency does not by itself prove awaited, crash-durable capture.

Source examples: `backend/internal/service/order.go:105-133,526-651`; `backend/internal/service/shift.go:58-124`; `backend/internal/write/ingredient_transfer.go:65-83`; `backend/internal/write/recipe.go:184-296`; `.github/workflows/backend.yml`.

## Decisions that must remain explicit

| Decision | Why a developer must not guess | Safe work that can proceed meanwhile |
|---|---|---|
| Competing offline and online returns | Disconnected devices cannot guarantee exclusive global entitlement. Tolerating/reconciling exposure versus restricting availability changes customer treatment and loss exposure. | Preserve original sale, return intent and confirmed cash fact; design atomic online entitlement and review records. |
| Cash-handover uncertainty | A database commit cannot atomically prove a person handed over physical cash. Automatic retry can pay twice. | Implement distinct intent, confirmation and needs-review states; never automatically instruct a second payout after an ambiguous crash. |
| Offline authority expiry/revocation | Online-at-shift-start and 60-minute outage tolerance do not decide what happens after a longer outage or later revocation. | Bind original event authority and retain facts; define authenticated recovery without trusting arbitrary payload actors. |
| Pending incoming inventory | Returned stock has a specified hold policy; other provisional transfer/goods-receipt stock still needs a sellability and conflict-authority decision. | Implement disposition-aware projections and keep received/accepted/sellable states separate. |
| Original receipt/item/tender allocations | Bundles, rewards, order discounts, tax, fees and rounding affect exchange credits and net reporting. | Use immutable versioned allocations and conservation tests; do not cash-refund point value. |
| Calendar and business day | Timezone, overnight closing, office holidays and clock skew determine return deadline, finance availability and report day. | Add explicit captured/accepted/settled timestamps and versioned business-date fields. |
| Duplicate paid-sale correction without replacement | The approved paid-void policy expects a linked replacement; a real duplicate sale may have none. | Keep correction authority and actual-payment facts separate; do not deduplicate separate sales merely because baskets match. |
| Device loss, replacement and restored backups | Crash survival is not the same as recovering an unsynchronized physically lost device. Restoring identity/journal may also cause replay hazards. | Define identity enrollment and replay safeguards; describe the remaining loss risk honestly. |
| Role/scope and evidence ownership | Inventory, finance, return verification, customer lookup and warehouse authority need explicit boundaries and retention rules. | Build an operation/role/scope matrix with positive and negative tests. |
| Optional loyalty launch settings | Rates, caps, expiry units and the provisional points-funded earning basis are not all approved. | Keep the feature off while stabilizing money-only flows and designing historical rule/lots contracts. |

The consolidated plan already acknowledges many of these decisions. The improvement is to give each one an owner, decision ID, status and affected command/test, not to force a new approval for every routine engineering detail.

## Recommended order of work

**Gate 0 — Freeze the baseline and expose failures.** Preserve the snapshot and policies; establish reproducible test/build scripts; add failing regressions for A01–A04, A06, A09, A11, A13–A15 and A26–A27. Fix malformed-body handling, clearly unsafe queue deletion, pagination/net-report arithmetic and obvious parity defects in focused changes, with safe migration awareness. Do not represent such containment as full durability or reconciliation.

**Gate 1 — Command, authority and evidence contracts.** Define event identity, payload fingerprints, original actor/outlet/shift, captured quote/tender, authorization evidence, schema/policy versions, operation receipts, stock/money/points movement links, and error taxonomy. Resolve only the policy decisions that materially affect the next commands.

**Gate 2 — One complete reliable sale path.** Await local transactional capture; survive restart; reconcile through an authenticated, atomic receipt boundary; return the original result after lost responses; retain original receipt locally; keep stock and shift projections correct. Demonstrate both an ordinary online sale and an offline sale across account/shift transitions before expanding features.

**Gate 3 — Inventory and shifts under concurrency.** Product/ingredient transfer parity, count terminal states, receiving and adjustments, approved offline inventory coverage, shared lock ordering, immutable close evidence and correctly attributed later cash movement. Require database-backed race tests, not only helper tests.

**Gate 4 — Return, payout, exchange, void and recovery.** Build the accepted policy on those proven primitives, including physical cash ambiguity, inspection, finance/cash coordination, allocation and cross-outlet entitlement. Keep customer lookup/guest flow available without making loyalty mandatory.

**Gate 5 — Optional loyalty and customer corrections.** Only after configured policy, prove lot/expiry/conversion conservation, online redemption authorization, adjusted/restored point separation, and old queued events racing merges or corrections.

**Gate 6 — Release qualification.** Full CI on the exact commit, Android crash/storage/migration tests, signed artifact and OTA compatibility checks, representative fleet/reconnect load, monitored dependency-failure drills, an isolated restore with ledger reconciliation, and a rollout/rollback procedure that preserves newly accepted writes. Keep provider migration a separately authorized decision.

Reports, source/permission mapping and complete exports must be validated throughout these gates, not postponed until after a pilot. Passing count-based unit tests is not the release criterion; conserved and recoverable business facts are.

## Primary technical references used for interpretation

Capacitor Preferences v8 documentation describes a lightweight key/value store, not a local database, and points database/high-write use cases toward SQLite: `https://capacitorjs.com/docs/apis/preferences` (accessed 2026-09-19).

PostgreSQL explicit-locking documentation explains row-lock lifetime and deadlock handling; it supports the concurrency interpretation, not a claim that a database race was executed here: `https://www.postgresql.org/docs/current/explicit-locking.html` (accessed 2026-09-19).

SheetJS’s own advisory describes the crafted-spreadsheet parsing issue and affected version boundary; observed export-only use is not established exploitation: `https://cdn.sheetjs.com/advisories/CVE-2024-22363` (accessed 2026-09-19).

## Deliverables and next action

`PLAN_ADDENDUM.md` is a proposed insertion/restructuring for the existing plan; the original repository documents have not been edited. `findings.json` contains the same register for tracking. `evidence.zip` contains diagnostic output, test/format logs, a portable reproduction harness, and hashes for the referenced source files, not secrets or the full repository.

The next implementation milestone should be a tested, smallest useful end-to-end sale-capture/reconciliation path with the identified regressions in place, rather than a large simultaneous rewrite of all return and loyalty screens.
