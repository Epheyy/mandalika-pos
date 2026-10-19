# Audit status sweep — 2026-10-14 (HEAD 33557cb)

Read-only re-check of every open Codex finding (A05–A44) against current code, by three Sonnet sweeps;
controller spot-checked A14 (confirmed: `write/stockcount.go` CompleteStockCount has no already-completed guard),
A33 (refresh-token validity lives in Redis) and A36 (no backup workflow). P0s A01–A04/A06/A09/A11/A13 and A31
are done and not repeated here. Statuses: Resolved / Mostly / Partial / Open / Policy-blocked.

Totals: Resolved 1 (A24) · Mostly 11 (A05 A12 A23 A26 A27 A29 A32 A34 A35 A40 A43) · Partial 9 (A07 A10 A18 A25 A28 A30 A37 A38 A42)
· Open 12 (A08 A14 A15 A16 A17 A19 A21 A22 A33 A36 A39 A44) · Policy-blocked 1 (A20) · A41 fixed locally 2026-10-20 (merge `a163d61`, not deployed).


---

# Sweep 1 — A05, A07, A08, A10, A12, A14, A15, A16, A17, A18, A19, A41

Repo HEAD 33557cb (prod-hardening). Read-only; status judged from code, not tracker/HANDOFF text. No tests were run.

### A05 — Authentication startup conflicts with offline shift recovery
- **Update 2026-10-19 (merged locally `8310855`, NOT released)**: **Fixed locally.** 12 h offline cap enforced server-side (signed contact token, `offline_expired` routed to sync review) and POS-side (warn 10 h / locked 12 h); promo/loyalty clock bounded with a clock_skew flag. Plan `docs/plans/2026-10-19-a05-offline-cap.md`.
- **Status (before the update above)**: Mostly
- **Evidence**:
  - The module-load KV capture is gone. `apps/pos/src/authBoot.ts:58-66` resolves `getKV()` at call time, and `auth.tsx:33` comments on it. `apps/pos/src/authBoot.wiring.test.ts` covers this, and `main.tsx:14-25` awaits `bootStorage()` before React mounts.
  - Invalid versus temporary refresh failure is now distinguished. `authBoot.ts:16-18` treats only an HTTP 401 as `rejected`. `bootSession` (`authBoot.ts:107-124`) returns `offline` with the cached user and keeps the token for any other failure. `auth.tsx:128-141` restores the user on `offline`. Tests: `authBoot.test.ts`.
  - The shift header is now trustworthy offline. `hooks/useShift.ts:58,129-133` persists the last server shift per outlet and overlays pending opens/closes. Opening a shift needs the server (`useShift.ts:138`). Commits 911977c, 39b4df7, 300e52f.
  - Terminal binding is fixed at the device (A04).
- **What's left**:
  - There is no shift-bounded, expiring offline capability. The offline-restored session is the cached `User` and has no expiry or lease.
  - A cashier whose account was revoked or demoted keeps selling offline until the next successful refresh, which is when the 401 lands. No scoped "only this shift" validation exists beyond the terminal binding and shift cache.
  - The remaining work is a documented offline authority window (for example, offline session valid for N hours or until shift close). It needs a small client check and a test, and it overlaps A07's policy.
- **Size**: S to M (2-3 days once the policy is decided)
- **Owner decision needed?**: yes. How long may a tablet keep selling offline after a cashier is revoked or demoted, and does the offline window end at shift close or after a fixed time?
- **Go-live blocker?**: no. Boot and offline resume work, and the residual risk is a bounded one: a revoked cashier on a shared terminal account continues until the next online contact.

### A07 — Refresh rotation and revocation lack a durable, atomic authority model
- **Update 2026-10-15**: code complete on branch (mig 0054, `auth/sessions.go`, AU gate); not yet deployed. Evidence below is the pre-fix state. A33 (Redis-optional auth) is delivered by the same change.
- **Status**: Partial
- **Evidence**:
  - Added since September: the admin reset-password marker (`auth/reset.go:26-38,94-101`) and its fail-closed read (`handlers.go:222-232`). The post-issue re-check (`handlers.go:171-176,240-253`) covers password reset only. Refresh TTL is 30 days via env; the marker TTL outlives legacy tokens.
  - `issue()` still ignores the Postgres insert error: `handlers.go:58-60` has `_, _ = h.Store.Pool.Exec(INSERT INTO refresh_tokens …)`. A non-durable session can be handed out.
  - Redis is still the deciding authority. `refreshUsable` (`handlers.go:209-214`) requires `refresh:<jti>` in Redis and never consults the DB `revoked` flag. Redis loss or flush makes every refresh return 401, so tablets must log in again.
  - Rotation is not atomic. `Refresh` (`handlers.go:158-160`) does Redis `Del` and then an unchecked `UPDATE revoked=true`. There is no claim-by-single-statement, so two concurrent refreshes can both pass `refreshUsable`.
  - There is no token version, and role or permission changes do not revoke sessions. `auth/store.go:106-155` (`UpdateUser`) touches no tokens. Access JWTs carry permissions for 15 minutes (`config.go:123`), so stale authority is bounded to that.
  - `RequireAuth` (`middleware.go:13-45`) is stateless, with no per-request revocation check.
- **What's left**:
  - Make `issue()` fail the request if the DB insert fails, and write the DB row before the Redis key.
  - Make the DB the authority: claim rotation with one `UPDATE refresh_tokens SET revoked=true WHERE jti=$1 AND NOT revoked RETURNING`, and use Redis only as a cache.
  - Add session families with reuse detection.
  - Add `token_version` or revoke-on-role-change in `UpdateUser`.
  - Add race, DB-failure and Redis-loss tests.
- **Size**: M (3-5 days)
- **Owner decision needed?**: yes, small. Should a role or permission change force re-login immediately, or is the 15-minute access TTL acceptable? Should reuse of a rotated refresh token revoke the whole family?
- **Go-live blocker?**: no. It is a real durability and consistency gap, but it fails safe (re-login) rather than granting access. Fix the silent insert error before go-live because it is a one-line change.

### A08 — Offline approval distributes reusable PIN verification material
- **Status**: Open
- **Evidence**:
  - `read/repo.go:918-927` still ships `receivePinHash` (argon2id) for every approving user in the sync bundle (`receiveApprovers`).
  - The POS verifies locally: `PinStepUpModal.tsx:59` calls `verifyPin(pin, approver.receivePinHash)`, and `packages/sync/src/pin.ts` is unchanged.
  - The raw PIN still sits in the queued payload: `engine.ts:477-505` stores `pin` in the `transfer_receive` outbox payload until ack. `redactPayload` (`engine.ts:13-20`) only strips it from logs and diagnostics.
  - The client lockout (`packages/sync/src/lockout.ts`) is resettable on the device.
  - HANDOFF lists "Transfer-receive PIN → one-time server approval" as an open follow-up. Slice 3 changed only error handling for receive.
- **What's left**:
  - Stop distributing hashes: replace with a server-issued short-lived, scoped approval token or an online step-up, or an offline-valid signed approval.
  - Remove the PIN from the retained payload, and add revocation and expiry for approvers.
  - Server-side lockout on PIN attempts.
- **Size**: M to L (about 1 week including a design decision)
- **Owner decision needed?**: yes. Must transfer receive be approvable fully offline? If yes, accept a time-bounded signed approval (what expiry?). If no, an online-only step-up is simplest.
- **Go-live blocker?**: no, conditionally. The exposure is argon2id hashes of 4-8 digit PINs on managed shared tablets, which is offline-crackable. Judge it a pre-go-live hardening item if tablets are physically uncontrolled, otherwise it can be scheduled after launch.

### A10 — The original offline quote is not retained independently of recalculation
- **Update 2026-10-19 (merged locally `f925a59`, NOT released): quoted receipt total built.** POS sends `quotedTotal` + `receiptSnapshot` (built once in the sale gate, printed from the same object; no name/phone); server stores both (migration 0058: `receipt_snapshot`, `quote_warning`, `quote_warning_reason`), compares in cents (+-Rp1), FLAGS drift (`quote_mismatch`, `quote_invalid`) on both routes and never rejects; absent quote = NULL no flag (old outbox flushes byte-identical); a real quote always has a snapshot, API `quotedTotal` is null for pre-0058 rows; backoffice "Struk" badge. PG gate QT (port 56461), full gate 22/22, Opus Ship-with-minors. OTA only (no APK). Plan `docs/plans/2026-10-19-a10-quoted-receipt-total.md`. NOT done: promotion version stamp (`promotions.version`) and per-promotion id/version in discountBreakdown (A23 handover, still open); reprint from history (A41); snapshot not exposed in the API. Owner default: reports keep the server total.
- **Status**: Partial (see update above)
- **Evidence**:
  - `quoted_total` is still populated with the recalculated `finalTotal` (`service/order.go:432`, the INSERT column list at `:420`). No client `quotedTotal` is sent or read anywhere (grep over apps, packages and backend).
  - Lines are recomputed server-side (`order.go:~135-300`) with current promotion and loyalty settings. No immutable captured-lines or price/rule-version snapshot exists, and none of migrations 0045-0050 add one.
  - Money actually collected is no longer overwritten. `evaluateTender` (`order.go:314`, `service/tender.go`, mig 0046) keeps the captured `amountPaid`, and the server computes `change` and stores `tender_warning`/`tender_warning_reason`. A promotion mismatch sets `discount_warning` (mig 0035).
  - The slice-8 plan (`docs/plans/2026-10-11-p0-slice8-a09-tender-rules.md:29`) explicitly defers quotedTotal as "out of scope".
- **What's left**:
  - The client sends the receipt total and the lines it printed (a `quotedTotal` and quoted-lines blob in the capture envelope).
  - The server persists them immutably (new columns or table) and stores the difference against the recalculated total separately.
  - A surfaced "receipt total differs" warning in the backoffice.
  - Apply the same to line prices and promotion version.
  - Needs an APK and a migration.
- **Size**: M (3-5 days)
- **Owner decision needed?**: no. The standing decision is that offline-captured facts win and mismatches are flagged. The flag-versus-reject policy for a differing total is already decided in slice 8.
- **Go-live blocker?**: no. Cash collected is preserved and flagged, and the receipt total can be reconstructed from the printed receipt. It is an audit-quality gap, not a money-loss gap.

### A12 — Shift ownership, concurrent opening and late-event accounting
- **Status**: Mostly
- **Evidence**:
  - Concurrent open is serialized. `service/shift.go:39-60` takes `SELECT … FROM outlets FOR NO KEY UPDATE`, then count-then-insert. Integration test `handlers/capture_envelope_integration_test.go:373` ("10 concurrent shift_open yields exactly one open shift") covers it.
  - The batch path binds shift to the caller's outlet: `sync/attribute.go:265-282` (`payloadShift`) rejects a shift at another outlet and drops an unknown shift. An envelope shift is stamped on the item.
  - Close is idempotent under a row lock (`shift.go:92-113`). Totals are recomputed from orders (`shift.go:119-157`). The close snapshot is never recomputed, and the server holds `shift_close` behind earlier retryable failures (`sync/sync.go:201-228`).
  - Late events attribute separately. A refund records `refund_shift_id` (mig 0047, `order.go:677-680`) and close nets refunds paid for other shifts (`shift.go:143-155`). Late sales keep their original (closed) shift per the owner decision.
  - Drift: no DB partial unique index on one open shift per outlet (`0001_init.sql:221-222` has plain indexes only).
  - The direct routes are unguarded. `CreateCashFlow` (`handlers/writes.go:1239-1255`) and direct `POST /orders` (`writes.go:989`) pass a client `shiftId` unvalidated against outlet or open status. The direct cash flow also has no idempotency key (A11 covered only `/sync/batch`).
  - HANDOFF notes sales made while a `shift_open` is syncing carry no shift.
- **What's left**:
  - Add a partial unique index `(outlet_id) WHERE status='open'` as defense in depth.
  - Validate `shiftId` belongs to the caller's outlet on the direct order and cash-flow routes, or retire those routes for the POS.
  - Fix the "sale during pending shift_open has no shift" backfill.
  - Operator-per-shift (not just opener).
  - A test for sale-versus-close on direct routes.
- **Size**: S to M (2-3 days)
- **Owner decision needed?**: no (operator-per-shift is a business choice but optional).
- **Go-live blocker?**: no. The races that could corrupt cash accounting are closed on the path tablets use (`/sync/batch`). The direct routes are backoffice or legacy.

### A14 — Completed product stock counts remain mutable and can overwrite later sales
- **Status**: Open
- **Evidence**:
  - Untouched since September: `git log --since=2026-09-15 -- stockcount.go ingredient_stockcount.go warehouse.go` is empty.
  - `write/stockcount.go:155-191` (`UpdateStockCount`) sets `status='in_progress'` or `cancelled` with no state check and replaces items. `scopeCount` takes no lock.
  - `CompleteStockCount` (`stockcount.go:197-287`) has no status guard and no lock. It writes absolute `actual_qty` (`ON CONFLICT … SET stock = EXCLUDED.stock`, ~`:249-270`) and marks completed.
  - Replaying completion after a sale restores the old counted value and erases the sale's stock effect (the audit scenario still holds). `difference` is computed against `frozen_qty`, not live stock.
  - Contrast: the ingredient counts do have `FOR UPDATE` and status guards (`write/ingredient_stockcount.go:56-145`). Product counts were not given the same treatment.
- **What's left**:
  - Lock the count row `FOR UPDATE` and enforce the lifecycle (planned → in_progress → completed/cancelled, terminal states immutable). Return the previous result on a replayed completion.
  - Apply a delta, `counted − frozen`, against current stock (or reject if the baseline moved) instead of an absolute overwrite.
  - Add an integration test for count 10, sell 2, retry completion, expecting 8.
- **Size**: S to M (2-3 days)
- **Owner decision needed?**: yes, small. When stock moved between freeze and completion, should completion apply the delta (count − frozen), or block and ask for a recount?
- **Go-live blocker?**: yes (conditional). If stock counts are run on live outlets, a double-submitted or retried completion silently resets stock, which is stock corruption. Fix it before the first real count, or gate the screen to admin and disable retries.

### A15 — Acknowledgement can make sold stock reappear on the POS
- **Status**: Open
- **Evidence**:
  - `engine.pendingStockDeltas()` (`packages/sync/src/engine.ts:546-558`) subtracts only items still in `outbox.pending()`. `CashierScreen.tsx:215-218` applies it via `applyPendingStock` (`cashier/stock.ts:10-23`).
  - `applyBatch` acks the item (`engine.ts:894-904`), which removes the debit. It does not refresh the snapshot, and there is no resync on ack. `resync()` runs only on mount (`SyncProvider.tsx:185`) or the manual button (`useOfflineData.ts:120-130`).
  - Sales and refunds do not bump `content_version` (`order.go` has no bump call, and `BumpContentVersion` is only in the write repo for catalog edits). The "wall" therefore never raises for sold stock.
  - Result: a cashier sells 2, the card shows 3, the sale syncs and the card goes back to 5 until a manual resync. Parked events also lose their debit.
  - `PendingCredits` (`pendingCredits.ts`) handles only transfer receives (stampAck/retire against version). Sales were not given a provisional movement with versioned retirement.
- **What's left**:
  - Keep sale debits until a snapshot that covers them arrives. Options: add the server's post-sale stock to the ack and apply it, or have the server bump a stock sequence on sale and refund, and retire debits by it.
  - Auto-resync after a batch with acks.
  - Keep a debit for parked events until resolved.
  - Tests for ack-before-pull, pull-before-ack, parking and late retry.
  - Needs an APK (POS web layer plus a backend ack payload).
- **Size**: M (3-5 days)
- **Owner decision needed?**: no
- **Go-live blocker?**: no. It is a display problem only (server stock is correct, and negative stock is allowed). Overselling risk exists, but it is flagged. High operational annoyance, so schedule early after go-live or before.

### A16 — Required offline inventory workflows are not all represented
- **Status**: Open
- **Evidence**:
  - `OutboxType` in `packages/sync/src/outbox.ts:18-25` has only `order, refund, shift_open, shift_close, cash_flow, customer_create, transfer_receive`. The server dispatch (`sync/sync.go:343,394,428,445,458,484,504`) matches.
  - No offline transfer create/send, goods receiving or stock-count capture or complete.
  - The only inventory write is `transfer_receive`, and it is hardened (A13/A03).
- **What's left**:
  - Define the approved inventory-offline scope (the audit says the long draft requires it), then add op types with envelope, journal schema, provisional state, permissions and conflict resolution for each: transfer send, goods receipt, stock count.
  - Each also needs A11-style receipts, A14 count semantics and A17 movements.
- **Size**: L (>2 weeks)
- **Owner decision needed?**: yes. Which inventory workflows must work during an outage at the tablet (transfer send, goods receipt, stock count)? Or is online-only for these acceptable, with sales plus transfer receive being the only offline operations?
- **Go-live blocker?**: no, if the owner accepts online-only inventory operations (done from backoffice or online). It would become a blocker only if outlets really must count or receive goods during outages.

### A17 — Inventory cannot be reconciled from a single movement history
- **Status**: Open
- **Evidence**:
  - No movement or ledger table exists. Migrations through 0050 contain no `stock_movements`, `inventory_movements` or `stock_ledger`.
  - Stock is mutated directly in `service/order.go:361-405` (sale), `:747-760` (refund restock), `write/transfer.go` (send/receive) and `write/stockcount.go` (absolute set). Goods receipts and adjustments have their own tables (`write/warehouse.go`).
  - A13 added locks and guards but no movement records.
- **What's left**:
  - Design and add an append-only `stock_movements` table (source operation, location, qty, disposition, occurred-at, reversal link).
  - Write it in the same transaction as each stock effect: sale, refund, transfer send/receive/cancel, receipt, adjustment, count.
  - Backfill or a cutover opening-balance movement.
  - Add a rebuild-and-compare reconciliation job and a report.
- **Size**: L (1-2 weeks)
- **Owner decision needed?**: no (design choice). Owner input is limited to whether the cutover starts from an opening balance and whether to reconcile on a schedule.
- **Go-live blocker?**: no, but it is the main audit-trail weakness for stock at three brands. Without it, stock discrepancies cannot be explained. It should land before inventory shrinkage becomes an issue (soon after launch).

### A18 — Refund does not represent the accepted return and payout policy
- **Status**: Partial
- **Evidence**:
  - Refund controls hardened by A06: permission via sync and direct, a 1-500 character reason (`service/refund_input.go:9-77`), already-refunded and not-completed refusal (`order.go:~668-676`), the refunding shift recorded (`refund_shift_id`, `refunded_by`, mig 0047), refund paid back in the original method, a POS gate for open shift and no queued refund, and a durable synced-refund memory.
  - Still blanket: `RefundTx` marks the whole order refunded, restocks every line into outlet sellable stock (`order.go:~720-760`), and reverses points and discount usage.
  - Not present: return entitlement or time window (the 5-day and supervisor exception), original-receipt verification, inspection hold, tester disposition, cross-outlet return, payable or settlement records, partial refunds, and cash versus transfer method switch.
  - `OrderHistoryPanel`/`RefundDialog` offer a full refund only.
- **What's left**:
  - Everything beyond the safety gates. At minimum for go-live: decide whether blanket restock into sellable stock is acceptable (tester and opened-bottle returns would inflate sellable stock).
  - Then build the entitlement and disposition model: partial or line refunds, a restock-or-hold choice per line, and a cross-outlet online authorization. Settlement and payable records come after.
- **Size**: L (>2 weeks for the full policy). An interim "refund with disposition = restock or hold, supervisor note" slice is M.
- **Owner decision needed?**: yes. What the go-live return policy is: return window, which items may be restocked (sealed only?), whether testers or opened items go to a hold bucket, whether cross-outlet returns are allowed, and whether partial refunds are required at launch.
- **Go-live blocker?**: no for launch if the owner accepts a manual policy (cashier judgment, supervisor-only permission, `process_refund` held by few accounts, per the HANDOFF "audit which accounts hold process_refund"). It becomes a blocker only if opened-product returns must not return to sellable stock.

### A19 — Exchange, paid-void and recovery need new domain commands
- **Status**: Open
- **Evidence**:
  - No exchange, upgrade, downgrade, paid-void or payable command exists. A file-name and content search across backend, apps and packages (sql, go, ts, tsx) found no exchange, void or payable domain code (only unrelated auth hits).
  - Sync item types (`sync/sync.go:343-504`) contain no exchange, void or recovery command.
  - A refund is the only reversal, and it is a status flip on the order.
- **What's left**:
  - The whole workstream: linked immutable entities (original allocation, replacement quote, handover, payment confirmation, payable settlement, compensating recovery) and guarded transitions.
  - It depends on A11 (receipts), A12, A18, A30 and A42.
- **Size**: L (several weeks)
- **Owner decision needed?**: yes. Are exchanges, upgrades or downgrades and paid-voids a go-live requirement, or may they be handled as refund plus new sale initially? What is the approved procedure for cancelling after goods or money moved?
- **Go-live blocker?**: no, assuming the owner accepts "refund then re-sell" as the interim procedure for exchanges. It is a business-process gap, not a data-integrity risk, provided staff use the refund path.

### A41 — An outbox is not a durable local receipt and return-history ledger
- **Status**: Fixed locally 2026-10-20 (merge `a163d61`, NOT pushed or deployed; no migration). Plan `docs/plans/2026-10-20-a41-local-receipts.md`. The evidence below is the 2026-10-14 snapshot.
- **Evidence**:
  - The latest receipt is still only in a ref: `CashierScreen.tsx:176` (`lastReceipt = useRef`), set at `:699` and reprinted from `:716-726`. It is lost on restart.
  - Order history reads `GET /api/v1/orders` with an online-snapshot cache (`OrderHistoryPanel.tsx:68-88`, `lib/offlineCache`). It has no tie to the durable journal; queued sales are not shown.
  - A01 made the outbox durable (SQLite journal), so captured sales survive reboot. But the acked entries are pruned (`outbox.ts`), and no local receipt or return-history store exists. After reboot a sale made offline cannot be reprinted or looked up for a return before reconnecting.
  - The printer-failure path does not hide capture (`:704-712` reports the print error separately), which is the one required property that holds.
- **What's left**:
  - Persist the receipt (number, lines, allocations, tender, accepted or review status) in the journal or a sibling table at capture.
  - Retain it after ack for N days.
  - Build a local "recent sales" view merging pending outbox, journal receipts and the cached server orders, with reprint from the stored receipt.
  - Eligibility check for an offline return lookup.
  - Needs native journal schema work and an APK.
- **Size**: M (3-5 days)
- **Owner decision needed?**: yes, small. How long must a tablet keep receipts locally (days or count), and must offline returns be possible for sales made on that tablet before reconnecting?
- **Go-live blocker?**: no. The sale itself is durable and printed. The gap hits reprint after restart and offline return lookup, which can wait for connectivity (the shared receipt number exists on the printed copy).

## Summary (group A05, A07, A08, A10, A12, A14, A15, A16, A17, A18, A19, A41)
1. Resolved 0, Mostly 2 (A05, A12), Partial 3 (A07, A10, A18), Open 7 (A08, A14, A15, A16, A17, A19, A41), Policy-blocked 0 (though A16, A18 and A19 need owner scope decisions before sizing).
2. Only A14 is a conditional go-live blocker: product stock-count completion can overwrite later sales on replay, and it is an S to M fix. Do it before the first real stock count. Fix the A07 silent refresh-token insert error (one line) at the same time.
3. The auth and shift items (A05, A07, A12) are in decent shape for launch. Residual gaps are an offline-authority policy and durable, DB-authoritative refresh handling (M).
4. The inventory cluster (A14, A15, A16, A17) is where the remaining stock-integrity work sits. A14 is the urgent piece, A15 (stock reappearing after sync) is the most visible to cashiers, and A17 (movement ledger) is the structural fix.
5. A18, A19, A16 and A41 are mostly business-scope decisions. If the owner accepts manual return and exchange handling plus online-only inventory ops at launch, none of them blocks go-live. A08 (PIN hashes on tablets) is a hardening item that should be decided before rollout to uncontrolled tablets.

---

# Sweep 2 — A20–A30, A42 (status vs code at HEAD 33557cb, read-only)

Note on loyalty: `loyalty_settings.enabled` defaults to false (`backend/internal/db/migrations/0001_init.sql:131`); project memory says it is enabled in the Neon TEST env. I did not read the live DB. A20/A21/A22 only bite where loyalty is enabled.

### A20 — Aggregate points cannot express restoration, expiry and adjustment rules
- **Status**: Policy-blocked (code: Open).
- **Evidence**: Balance is still one cached `customers.points` plus a flat `point_transactions` ledger. There are no lots, no expiry and no separate adjustment balance. `backend/internal/write/points.go:48-81` (AdjustPoints) only floors at 0. `backend/internal/service/order.go:731-775` (refund) claws back earned points via `write.PointsClawback`, forgives the remainder ("poin dimaafkan", lines 746-751), and adds redeemed points straight back into the same aggregate. There is no future-earnings offset. No commit since 2026-09-15 touches this design.
- **What's left**: Design and build lots (earn_lot, consumed/restored allocation, expiry), a separate adjustment balance, deterministic item allocation, and retry that does not re-award. Needs a data migration of the existing balances into lots, plus a parity gate. Alternative: keep loyalty off for the first release.
- **Size**: L
- **Owner decision needed?**: Yes. Approve the loyalty policy first (audit packet Q07): does it expire, and how long; are restored points spendable; does a refund shortfall become a negative offset; and do corrections offset only future earnings.
- **Go-live blocker?**: No if loyalty stays disabled in production (the audit itself says to keep it off until approved). Yes if you want to launch with points live.

### A21 — Online-only redemption cannot be enforced with the existing Offline flag
- **Status**: Open.
- **Evidence**: Every POS sale goes through `/sync/batch` and is built with `Offline: true` (`backend/internal/sync/sync.go:381`). `createOrder` redeems points whenever `in.PointsRedeemed > 0 && hasLoyaltyCustomer` (`service/order.go:292-306`) and never looks at `in.Offline` or any online proof. `POST /sync/loyalty-preview` is online-only but is advisory; nothing binds a preview or reservation to the sale. Offline redemption therefore works from cached points. The server does clamp to its own balance (lines 294-296), so overspend of the balance is not possible, but the policy is not enforced.
- **What's left**: Design an online reservation or finalization token bound to the sale and point lots (depends on A20's lots). Server rejects or flags redemption without it. POS only offers redemption when online and holding a reservation. Retry and refund of a reserved redemption must not lose or double-spend points.
- **Size**: M if built on the current aggregate balance. L if combined with A20 lots.
- **Owner decision needed?**: Yes (small). Confirm "redemption online only" is still the policy. If offline redemption should instead be allowed and flagged, this finding changes.
- **Go-live blocker?**: No with loyalty off. Yes if loyalty is on, because the offline path bypasses the intended control.

### A22 — Redemption rounding can give money credit while consuming zero points
- **Status**: Open (the defect is still reproducible in both engines).
- **Evidence**: Server: `service/order.go:297-306`. When `redeemAmount > res.Total` it sets `redeemAmount = res.Total` and `pointsRedeemed = int(res.Total / redemptionRate)` without recomputing the money. With a total of Rp50, rate 100 and 1 point requested, the credit is Rp50 and 0 points are consumed. POS mirror: `apps/pos/src/cashier/pricing.ts:394-404` has the same shape (`redeemAmount = min(round(pts*rate), total)`, then `redeemedPoints = min(pts, floor(redeemAmount/rate))`). No golden vectors exist; the only tests touching redemption are `guestSale.test.ts` and the negative-points input test.
- **What's left**: Pick one rule (for example `credit = pointsConsumed*rate`, consuming ceil(total/rate) points and shaving the credit to match, or allowing a sub-point remainder). Derive money and points from it in integer arithmetic in Go and TS. Add shared golden vectors near the conversion boundaries, covering `cash + credit == payable`.
- **Size**: S
- **Owner decision needed?**: Yes, minor. Choose the rounding direction (does the customer lose or gain the sub-point remainder; or must credit be a whole multiple of the rate).
- **Go-live blocker?**: Only if loyalty is on. It then leaks small value (at most one rate unit per sale). It is a cheap fix, so I would fix it before enabling loyalty.

### A23 — Linked tiered promotion loses its tier configuration in POS pricing
- **Status**: Mostly. **Update 2026-10-19 (merged locally `32049dc`, tests only, no release): the parity leftover is DONE.** Shared Go/TS matrix `backend/internal/service/testdata/promo_parity_golden.json` (21 vectors, hand-verified by an Opus reviewer: scoped pct/fixed, bogo, BXGY same/separate-set, bundle, tiered stacking, manual cap, tax+rounding) passes on both engines with NO drift; PG gate PL `TestPromoLinkedParityPostgres` (port 56460) proves direct == linked for tiered, scoped %, bogo, BXGY same-set, dedupe-once, code_only 422. Full PG gate 21/21. The captured-quote / promotion-version residual moved to A10 (plan `docs/plans/2026-10-19-a10-quoted-receipt-total.md`). Known gap: golden uses a copy of loadPromoSpec; fixed, unscoped %, separate-set BXGY and bundle are not covered by the server-path test. Plan `docs/plans/2026-10-19-a23-promo-parity.md`.
- **Evidence**: The reproduced defect is fixed. `apps/pos/src/cashier/promoValidate.ts:119-121,179-181` and `pricing.ts:315-317` now carry `tieredConfig`, `bxgyConfig` and `bundleConfig` through the linked-code shape. Shared 12-vector Go/TS golden contract: `backend/internal/service/testdata/linked_tier_golden.json` with `linked_tier_golden_test.go`, and `apps/pos/src/cashier/linkedTierParity.test.ts`. `linkedFulfillment.test.ts` covers linked-code BXGY and bundle fulfillment. The server recomputes totals from its own promotion rows (`order.go:177-226`, `resolvePromos`), so a stale client cannot set the price. These shipped in September (tracker E15–E24). I did not rerun the tests.
- **What's left**: The acceptance bullet "preserves the captured business fact if an old client differs" is only partly met. The server stores its own total as `quoted_total` (`order.go:420,433` writes `finalTotal`) and the mismatch surfaces only through `tender_warning`/`discount_warning`. The client's quoted total and promotion version are not captured. There is no versioned promotion snapshot in the order, and no broader parity matrix for stacking, caps and eligible-item allocations beyond tiered. Closing it means storing a captured quote (promotion id plus version, client total) on the order and adding a diff review item.
- **Size**: M
- **Owner decision needed?**: No.
- **Go-live blocker?**: No. The money path is server-authoritative and the original bug is closed. The residual risk is an auditable disagreement between what the cashier showed and what the server charged.

### A24 — Guest sales blocked despite accepted policy
- **Status**: Resolved.
- **Evidence**: The blanket customer gate is gone. `apps/pos/src/cashier/CashierScreen.tsx:368-373` `handleCheckout` dispatches `OPEN_CHECKOUT` with no customer check. The only customer guard left is at lines 537-542, which clears stale loyalty benefits (points or reward lines) for a guest. `guestSale.test.ts` covers restricted-code rejection for guests (`perCustomerLimit` and assigned `customerId`), generic promos surviving, stale points ignored, and receipt bytes without a fabricated identity. Browser scenarios live in `tests/browser/pos-scenarios.ts`. The server accepts a null customer (`order.go:271-275` guards on `in.CustomerID != ""`).
- **What's left**: Nothing required. The optional "later guest attachment by TL/open-shift" workflow is not built (grep finds no attach code). It is a future feature, and the audit only says it must be gated when built.
- **Size**: S (only if the attachment workflow is wanted later: M)
- **Owner decision needed?**: No (only if you later want guest-attachment: who approves it and whether points are awarded retroactively).
- **Go-live blocker?**: No.

### A25 — Customer merges and corrections need immutable historical ownership rules
- **Status**: Partial.
- **Evidence**: Done: merge is a human-reviewed queue (mig 0034). It soft-tombstones the duplicate (`merged_into`) and writes a `customer_merges` audit that records moved order ids (`backend/internal/write/merge.go:203-224`, audit insert later in the same function). Both customer rows are locked in id order (lines 90-115). `createOrder` resolves a stale or merged customer id to the terminal keeper before points and aggregates (`service/order.go:267-275`, `resolveMergedCustomer`), so an old device with pending sales self-heals. Assigned and per-customer code ownership uses the raw id (mig 0042/0043, SP-Code-3/4, validator-shared). Not done: `orders.customer_id` is simply overwritten (`merge.go:204`), with no original-versus-effective columns (provenance lives only in the audit JSON). Refund does not reverse `total_spent` or `visit_count` (the refund path at `order.go:731-775` touches points only, while create updates them at `order.go:468`), and the lifetime-spend versus visit-count meaning is undefined. Merge-time aggregation of per-customer code caps is not defined. Points merge as a flat adjust (so expiry provenance is moot until A20). There is no separate account-correction command.
- **What's left**: (1) Define net-spend versus historical-visit aggregates and make refund adjust spend accordingly (S). (2) Add original/effective customer linkage on orders if audit-grade provenance is wanted (M; migration). (3) Decide cap and reissue behavior on merge and test a pending-offline-sale-during-merge race (S–M).
- **Size**: M
- **Owner decision needed?**: Yes. Meaning of lifetime spend (gross or net of refunds) and visits; how per-customer code caps behave after a merge; whether a merge may rewrite order ownership or must keep the original.
- **Go-live blocker?**: No. Merge is human-gated, never automatic, and loyalty is optional. The stale-spend-after-refund inaccuracy is cosmetic CRM data.

### A26 — Reports and shift recaps silently aggregate only the first 50 records
- **Status**: Mostly.
- **Evidence**: The silent truncation is closed by complete pagination. `packages/api/src/pagination.ts` `fetchAllPages` walks all pages at 200 per page. It fails the whole read on bad metadata, a count change mid-read, short pages or duplicate ids. It is used by `apps/backoffice/src/screens/Reports.tsx:72-73`, `Dashboard.tsx:67,71`, `Orders.tsx`, and POS `apps/pos/src/cashier/recapData.ts:9-51` (shift recap, cash flows, shifts). The server-side `pageLimit` is unchanged (`backend/internal/handlers/handlers.go:71-80`, above 200 gives 50), which is fine because no client relies on a bigger page. Tests: `pagination_integration_test.go` and `apps/backoffice/src/screens/paginationPostgres.test.ts`.
- **Update 2026-10-19 (merged locally `350f2f7`, NOT released)**: the preferred shape is now built. One shared `read.buildOrderWhere` feeds both `/orders` and `/reports/summary`; new WIB-day `dateFrom`/`dateTo`, `status`, `paymentMethod`, `q` filters (legacy POS `from`/`to` untouched); `/shifts` date bounds; Reports Ekspor/Shifts, Dashboard, Transaksi and CustomerDetail use server totals/paging; response money fields are `format: double` (25 fields). Plan `docs/plans/2026-10-19-a26-reports-aggregation.md`. PG gate 20/20 (PG 18.3), Opus review Ship-with-minors. Still open: Dashboard "Semua" period fetch unbounded; payment-method filter lists only configured methods; money flashes while reloading; unmeasured: summary+q over all dates at ~500k orders (polled 12 s); input/loyalty/promotion/price schemas still float32; daily buckets UTC (A28). Owner default taken: Transaksi defaults to last 30 days + "Semua tanggal"; search spans all dates.
- **What's left (superseded by the update above)**: The audit's preferred shape (server-side date, outlet and status filters plus authoritative aggregation endpoints) is not done. Reports and Dashboard still download every order ever and filter by date in the browser (`Reports.tsx:72-96`) and re-poll that every 12 s (HANDOFF known gap). The `/reports/summary` endpoint exists but no UI calls it. Offset pagination is not a snapshot (documented). At the target scale (very large order history) this becomes slow and heavy. The fix is server-filtered list queries plus aggregates for totals and CSV, using the existing summary endpoint.
- **Size**: M
- **Owner decision needed?**: No.
- **Go-live blocker?**: No for correctness (it fails loudly, never truncates silently). It is a scale and performance risk as order volume grows. Do it before volume reaches tens of thousands of orders.

### A27 — Backend summary subtracts refunded sales twice
- **Update 2026-10-19 (merged locally `bb75e5a`, NOT released)**: **Mostly.** Owner policy: refunds are recognised on the REFUND date. Summary now = gross (completed+refunded, sale business day) minus refunds (refund business day), with gross/refund payment-method maps and daily rows; `/orders?dateBasis=refund`; migration 0060; Ekspor Kotor/Refund/Bersih cards + refund CSV. Left: Dashboard net (T7, owner Q1), per-product net of returns (F1), grant/code reports basis (F2), customer lifetime totals ignore refunds (A20-A22). Plan `docs/plans/2026-10-19-a27-refund-date-basis.md`.
- **Status**: Mostly.
- **Evidence**: The double subtraction is fixed. `backend/internal/read/reports.go:62` is `'netSales', agg.total_sales`, with the comment at lines 11-14 stating that refunded rows are already excluded. `backend/internal/handlers/report_summary_integration_test.go` covers the cases (refunded-only gives sales 0, refunds 30, net 0; completed 100 plus refunded 30 gives net 100). The Reports screen computes its own client aggregates (`Reports.tsx:90-100`) in the same status-based way, so there is no second subtraction. I did not rerun the tests.
- **What's left**: The audit's "define gross, refunds and net once with an explicit time basis" is not done. All summary figures are by original `orders.created_at` and current status. A refund made on a later day removes the sale from its original day and shows no refund on the refund day. `netSales` is therefore not "net of returns in the period". Exchanges and post-close payouts are not modelled (they do not exist in the product yet). The `dailySales` buckets use `to_char(created_at,...)` in the DB session zone (UTC on Neon), not WIB (`reports.go:52`).
- **Size**: S–M
- **Owner decision needed?**: Yes. Should reports recognize a refund on the sale date or on the refund date (recognized-on-refund-day is standard accounting)? What does "net sales" mean to finance?
- **Go-live blocker?**: No. Numbers are internally consistent, and no UI uses the summary endpoint. Daily-close reconciliation across midnight will differ from a cash view until the basis is chosen.

### A28 — Business time inconsistent across pricing, reporting and return deadlines
- **Update 2026-10-19 (merged locally `0635d4e` + `7ffd6dc`, NOT released)**: **Mostly.** Per-outlet timezone (WIB/WITA/WIT), `business_date` on shifts/orders = shift opening date in the outlet zone (shift-less orders: clamped device time, else server time), `refund_business_date` stamped for A27, all report/list filters on the business day, promo/loyalty/preview evaluated in the outlet's local time (server + POS twin + bundle `outletTimezone`). No return deadline (owner policy). Left: promo clock-skew bound (A05), Jakarta-only code-report 'kedaluwarsa' label and segment recency, owner must set WITA outlets before go-live. Plan `docs/plans/2026-10-19-a28-outlet-timezone.md`.
- **Status (before the update above)**: Partial.
- **Evidence**: Pricing and loyalty triggers evaluate in a fixed WIB zone (`service/order.go:29,161,345`, `time.FixedZone`). Discount-code reports bucket by Asia/Jakarta days (`read/repo.go:1896-1897,1980-1981`). The Backoffice Reports date default was fixed to the local date (commit e1f7455). Still inconsistent: `orders.created_at` is the server acceptance time (the insert at `order.go:419-433` does not set it; the device time goes to `client_created_at`, which is stored but not used for reporting). So an offline sale synced the next day lands in the next day's report. `ReportSummary.dailySales` buckets by UTC (`reports.go:52`). Many UTC-date screens remain (`CustomerDetail.tsx:41`, `OpnameTab.tsx`, `MovementSummary.tsx:25-31`, `Promotions.tsx:253`, `StockCount.tsx:53`, `csvUtils.ts:10,29`, `OrderHistoryPanel.tsx:48`; HANDOFF lists some). There is no per-outlet timezone, no `business_date` column, and no `settled_at`. The promo sale time is taken from the client clock without a skew bound (`order.go:157-160`). No return-deadline code exists (grep finds no refund window), so the "five-calendar-day" rule is not implemented at all.
- **What's left**: Add `outlets.timezone`, store a `business_date` (computed from capture time under that zone) on orders and shifts, and report and filter by it. Replace the UTC date fragments with a shared business-date helper. Bound client clock skew for promo evaluation (or use server time when skew is large). Implement the return window if the policy requires it, on the same calendar.
- **Size**: M–L
- **Owner decision needed?**: Yes. Are all outlets and brands in one timezone (an Indonesian chain can span WIB, WITA and WIT)? What is the business-day cutoff for overnight shifts? Is there a return deadline, and is it counted in calendar days? Which date is authoritative for a late offline sale (capture date or accept date), and how much clock skew to tolerate?
- **Go-live blocker?**: No for a single-timezone launch with a WIB convention (and sales synced the same day). It becomes a blocker if any outlet is outside WIB or if offline gaps spanning midnight are common, because daily totals will shift.

### A29 — Network and batch error contracts do not support safe recovery
- **Status**: Mostly.
- **Evidence**: Done on the client and contract side. `packages/api/src/client.ts:412-433` supports per-request abort deadlines (`timeoutMs`), applied to `/sync/batch` (`engine.ts:101-103,806`, 30 s) and refresh (`client.ts:374-398`). Body parsing is after status classification and tolerates HTML 502 or truncated bodies (`client.ts:462-482`, typed `invalid_response`). `classifyFailure` (`engine.ts:155-168`) separates offline, transient (5xx, 429, 408, timeout), unauthorized, rejected and account. Transient failures use exponential backoff with jitter (`engine.ts:134-140,615-625`). Batch items carry a machine-readable `code` and `retryable` (`backend/internal/apperr/apperr.go`, `sync/classify.go`) with sanitized messages, and PG deadlock or lock errors map to a retryable `busy` (`classify.go:66`). Operation receipts make retries idempotent (A11), and review check-in is capped at 50 items. Shift close and open are held behind an earlier retryable failure. Not done: there is no batch size cap, as the engine posts the entire queue (`engine.ts:762-806`) and the server accepts any array length or body size (`handlers/batch_envelope.go`, no `MaxBytesReader`; only the review endpoint has one). There is no per-operation or total work budget (server `WriteTimeout` is 30 s, `cmd/server/main.go:58`, same as the client's 30 s). Retry-After is sent by the rate limiter (`middleware/ratelimit.go:34`) but the client does not read it. Non-batch API calls have no default deadline. Many direct handlers still return raw `err.Error()` (`handlers.go:122`) and a generic 400 "invalid body". Items are processed strictly in order, with no independent-versus-dependent grouping beyond the shift holds.
- **Update 2026-10-19 (merged locally, NOT yet released)**: batch cap done. Client `flush()` posts one `pending()` snapshot in chunks of `BATCH_MAX_ITEMS = 25`; after a result-level retryable error it keeps draining but holds shift_close/shift_open out of later chunks, and stops after a thrown/transient failure or the isolation path. Server caps `/sync/batch` at 200 items and 8 MiB (413 "batch too large", OpenAPI `maxItems` + 413). Plan `docs/plans/2026-10-19-a29-batch-cap.md`. Remaining below except the batch cap; the 500+ item test against the 30 s limit was not run (needs owner Neon approval).
- **What's left**: ~~Cap client batch and server body/array length~~ (done 2026-10-19). Make the client honor Retry-After. Give the default client a request deadline. Sanitize and code the direct-handler errors. A large-queue test (500+ items) against the 30 s limit.
- **Size**: M
- **Owner decision needed?**: No.
- **Go-live blocker?**: No. No event is lost (A01/A02/A11 are done). The risk is a very large backlog after a long outage: one slow batch can time out and re-send repeatedly, though progress is retained per committed item. Recommend the batch cap before the fleet rollout if tablets can be offline for days.

### A30 — Permission model needs an operation-by-scope matrix
- **Update 2026-10-19 (merged locally `c093157`, NOT released)**: **Fixed locally.** Customer reads and lookup are scoped by role (cashier phone-only, rate-limited), customer names stripped from sync/orders/reports for phone-only callers. Plan `docs/plans/2026-10-19-a30-customer-privacy.md`.
- **Status (before the update above)**: Partial.
- **Evidence**: The POS outlet switcher is gone (`apps/pos/src/components/` has no OutletSwitcher; commits 4841bd7, 4fe8ba5). Terminal outlet is bound once by an admin, and server-side actor/outlet envelope checks (A04) bind queued writes to the capturing cashier and outlet. Backend outlet override remains admin-only (`handlers/handlers.go:55-68`). Refund requires `process_refund` on both direct and batch routes, with a no-bypass replay rule. The Backoffice write groups use `RequirePermission` (`server/server.go:130-200`). Review resolve uses the new `resolve_sync_review`. Still open: no published matrix document. Several read routes are open to any authenticated user, including `/customers`, `/customers/{id}`, `/warehouses/{id}/stock`, `/settings/*` and `/discount-codes` (`server.go:104-125`), while sales reads are outlet-scoped via `scope(r)`. There is no test that walks all routes asserting role, permission and scope (`chi.Walk` is not used; `permissions_test.go` covers only the middleware). Warehouse count permission-only scope is unchanged. Manager outlet selection in Backoffice relies on the admin-only override, so a manager cannot select another outlet at all (consistent, but unspecified).
- **What's left**: Write the route-by-route matrix (role/permission, scope, direct/batch, offline authority), then encode it as a table-driven positive/negative test over `chi.Walk` plus a handful of cross-outlet cases. Decide and tighten customer-list/PII reads for cashiers (they currently see all customers).
- **Size**: M
- **Owner decision needed?**: Yes. May a cashier at one outlet read all customers (PII) across brands? May managers see other outlets' sales and inventory? Do the three brands share one customer base? This is a business and privacy call.
- **Go-live blocker?**: No for stock and money safety (writes are gated and scoped). Possibly yes for customer-data privacy if the three brands must not share customer visibility. Treat as a pre-go-live review.

### A42 — Cross-command lock ordering can deadlock
- **Status**: Partial.
- **Evidence**: The consequence half is done. Deadlock or serialization or lock-not-available failures are classified as retryable `busy` (`backend/internal/sync/classify.go:66`, `write/tx_busy.go`), the direct route maps them to 409 (`handlers/writes.go:1081`), and operation receipts make retries safe. The tests are `classify_test.go`, `mutated_busy_test.go` and `tx_busy_test.go`. Transfers have a defined lock order, `retryBusy` and a gate (A13). The ordering half is not done for sale, refund and merge. `createOrder` locks the code rows (`order.go:1002`, in request order), then the customer (`:282`), then stock rows in request line order (`:361-398`, no sort). Refund locks the order (`:659`), restores code usage (`:719-724`), restocks in DB read order (`:706-724`), then locks the customer (`:741`). Merge locks both customers by id then updates orders (`write/merge.go:90-115`). Two sales with reversed product order at one outlet, or a sale and a refund on the same customer and stock row, can still deadlock. There is no parallel reversed-order test, and `retryBusy` is not wrapped around create or refund (the batch-level retry is the client's re-send). A direct online `POST /orders` deadlock returns 409 for the cashier to retry.
- **What's left**: Sort stock and code locks (by key) inside create and refund and order the customer lock consistently. Add an in-server `retryBusy` around create and refund for the direct route. Add a parallel reversed-order test (sale/sale, sale/refund, sale/merge) to the PG gate.
- **Size**: S–M
- **Owner decision needed?**: No.
- **Go-live blocker?**: No. A deadlock victim retries to success, so the impact is latency and noise, not loss. It becomes more likely with several tablets per outlet.

---
## Group summary
- 12 findings: 1 Resolved (A24), 4 Mostly (A23, A26, A27, A29), 4 Partial (A25, A28, A30, A42), 2 Open (A21, A22), 1 Policy-blocked (A20).
- The loyalty cluster (A20, A21, A22) is entirely un-fixed in code, but it only matters if loyalty is enabled. A22 is a cheap, real arithmetic bug (zero points consumed for a money credit) still present in both Go and TS. Keep loyalty off in production until A20/A21/A22 are done.
- No finding in this group is a hard money or stock go-live blocker. The risks that scale with use are A26 (client-side full-table reporting), A29 (no batch cap) and A28 (no business-date or outlet timezone).
- Owner decisions that unblock work: loyalty policy (A20/A21/A22), refund recognition basis (A27), outlet timezones/cutoff/return window (A28), customer read scope across brands (A30), merge/aggregate semantics (A25).
- Quick wins (S): A22 rounding fix with golden vectors, A42 lock sorting plus the reversed-order test, A29 batch and body caps, and the A25 refund adjustment of `total_spent`.

---

# Sweep 3 — A32, A33, A34, A35, A36, A37, A38, A39, A40, A43, A44

Verified against HEAD 33557cb (prod-hardening), 2026-10-14. Read-only. CI state checked with `gh run list` (read-only).

### A32 — Startup migration and connection budgeting are not multi-instance safe by design
- **Status**: Mostly
- **Evidence**: The migration race is closed. `backend/internal/db/db.go:51-126` runs each migration file in its own transaction behind a transaction-scoped `pg_advisory_xact_lock` (key 7261950045001) and re-checks `schema_migrations` inside the lock (commit 03bc7e7). Test: `backend/internal/handlers/operation_receipts_integration_test.go:67` ("concurrent-migrate", in the Mandatory PostgreSQL gate). That commit says 3 of 4 concurrent `Migrate` calls failed before the fix. Still open: `db.go:22-47` sets idle/lifetime/health-check but no `MaxConns`. `scripts/deploy-backend.sh` sets no `--max-instances`, concurrency or pool parameter. I found no budget doc (grep of plans, RUNBOOK and HANDOFF for max-instances/MaxConns/pool_max_conns returned nothing). Every instance still migrates at boot (`cmd/server/main.go:43`).
- **What's left**:
  - Decide the Cloud Run max-instances and set pgxpool `MaxConns` explicitly (or `pool_max_conns` in the URL). Check the total against Neon's pooler limit.
  - Write down the expand/contract rule for schema vs. old APKs. Migrations are forward-only (RUNBOOK:118) and the rollback note in HANDOFF relies on an ignored column.
  - Optionally run a multi-revision rollback drill.
  - The interrupted-migration case is covered only by transaction atomicity, with no test.
- **Size**: S
- **Owner decision needed?**: Minor. What is the maximum instance count and the Neon connection ceiling (free tier)?
- **Go-live blocker?**: No. The data-corruption half is closed. An unbounded pool on a small Neon tier degrades under load but fails visibly. Set MaxConns before multi-outlet load.

### A33 — Redis remains a required startup/auth dependency and routine traffic amplifier
- **Update 2026-10-15**: code complete on branch, not yet deployed: Redis is an optional cache (disabled/degraded modes, 1s/500ms timeouts, circuit breaker, in-memory limiter fallback, `/healthz` degraded 200), Postgres is the auth authority (mig 0054, AU gate). Usage measurement and the `DelByPrefix` SCAN amplification remain open follow-ups. Evidence below is the pre-fix state.
- **Status**: Open (the Redis dependency has deepened, not shrunk)
- **Evidence**:
  - `cmd/server/main.go:48-51` still `log.Fatalf`s when Redis cannot be reached, so a Redis outage prevents any instance from starting.
  - `/healthz` returns 503 when Redis is down (`server/server.go:62-72`). `/readyz` is dependency-free.
  - The global rate limiter does one Redis INCR per request (`server.go:46`) but fails open on error (`middleware/ratelimit.go:25-28`).
  - Auth is now more Redis-dependent: `auth/handlers.go:208-226` makes refresh require the Redis jti and fail closed on a Redis error. The revoke marker was added for admin reset (`auth/reset.go:97`).
  - Financial batch idempotency now lives in Postgres (operation_receipts / processed_keys), so already-authorized writes with a valid 15-minute access JWT do not need Redis. But a Redis outage logs every tablet out within about 15 minutes and blocks new logins.
  - POS polls every 12 s (`SyncProvider.tsx:196`). No usage measurement or thresholds exist (no telemetry captured anywhere in repo or docs).
  - No commits touching cache/startup since 2026-09-15 other than the reset/revoke work.
- **What's left**:
  - Make Redis startup non-fatal: degraded mode with a Redis-less limiter and `/healthz` reporting degraded.
  - Move the refresh-token authority to Postgres (the `refresh_tokens` table already exists). Redis becomes an accelerator only.
  - Measure Upstash commands per device/day and set thresholds.
  - Backoffice polling amplification (HANDOFF known gap).
- **Size**: M (auth authority move is the bulk)
- **Owner decision needed?**: Yes. Offline/outage authority policy: how long may a tablet keep working with Redis down (the current 15 min access TTL versus a longer window)? Also Upstash plan and budget.
- **Go-live blocker?**: Moderate, leaning yes. A single free-tier Redis hiccup or quota exhaustion would stop cold starts and log out all outlets in a real trading day. Offline-first sales continue locally and queue, so no money is lost. A minimum fix (startup non-fatal plus refresh fallback to the DB) is worth doing before go-live.

### A34 — CI does not enforce the full financial and client reliability baseline
- **Status**: Mostly
- **Evidence**:
  - Four push-event gates run on every push (no path/branch filters): `quality.yml`, `backend.yml`, `postgres.yml`, `browser.yml`. At HEAD 33557cb all four are green (`gh run list --commit 33557cb`).
  - `quality:ci` (`package.json:12-14`) runs pos/backoffice/sync/printer tests, six-package typechecks plus test/browser tsconfigs, builds, `gen:check`, and the release-debug-gate tests. The sync package now has a `test` script (`packages/sync/package.json:12`).
  - Backend: vet, build, gofmt (`backend.yml:33`; committed tree is gofmt-clean), OpenAPI/codegen drift, `-race`.
  - Release path: `scripts/lib/require-green-ci.sh` (clean tree, HEAD on origin, 4 gates green on that SHA) is used by `scripts/ota-release.sh`, `deploy-backend.sh` and `promote-backend.sh`. Deploys come from a clean export, revisions are labelled commit-sha/deploy-tag, and `promote` re-verifies the label.
  - `android-release.yml` has `needs: [quality, database, backend, browser]`, a production-only debug gate (`release_debug_gate_cli.mjs`, fail-closed, with tests) and a release manifest (commit, version, sha256).
  - Commits: 61d248b, bc30583, fe6784a, b68ee3b, 8718016, 83fe97b. Shell tests: `scripts/lib/require-green-ci.test.sh`.
- **What's left**:
  - Branch protection or rulesets: the GitHub API returns 403 (needs Pro or a public repo), so nothing technically prevents a push or merge without green CI.
  - Backoffice (Cloudflare Pages) auto-deploys on push with no CI gate (owner chose to keep).
  - `dependency-security` is red and is not in the required-gates list (24 blockers, see A38).
  - OTA `release_type` is not stored with the release and defaults to `test`.
  - The debug gate misses a backtick computed key (known).
  - Git Bash rewrites `--env KEY=/path` values.
  - There is no signed-artifact attestation beyond the manifest/sha.
- **Size**: S (the technical items) plus an owner spend decision
- **Owner decision needed?**: Yes. Pay for GitHub Pro (branch protection) or accept solo-dev discipline? Should Cloudflare deploys wait on CI?
- **Go-live blocker?**: No. The release scripts and APK/OTA paths are gated, which was the core risk. The remaining gaps are process hardening. Make sure the go-live APK is built `release_type=production`.

### A35 — OTA and native release gates do not yet protect a financial-journal migration
- **Status**: Mostly
- **Evidence**:
  - OTA is bound to one native build: `ota_releases.native_version_code` (mig 0049). `ota/decide.go:21-43` requires a parseable version code and fails safe. Updates are strictly newer semver only (`decide.go:69-90`). Release is bound to a commit (mig 0050), and `ota-release.sh` is CI-gated, builds from a clean worktree, and has a production debug gate.
  - Backup and identity: `AndroidManifest.xml:4-5` points to `backup_rules.xml` and `data_extraction_rules.xml`. Both exclude the journal DB, CapacitorStorage, WebView and Capgo state, for cloud backup and device-transfer. HANDOFF records bmgr backup/restore verified on an emulator and a restored tablet starting clean.
  - `capacitor.config.ts:27` now has `loggingBehavior: 'debug'` (APK 1.9). `webContentsDebuggingEnabled: true` is still TEMP (`capacitor.config.ts:23`), but production-type builds fail on it.
  - Journal safety: the native journal takes over one way with BootError rather than an empty queue (`OutboxJournalPlugin.java`), and verified upgrade 1.6→1.7 kept the queue.
- **What's left**:
  - `notifyAppReady` still fires at first React render (`App.tsx:163-166`), before journal open/migration (SyncProvider). A bad web bundle that breaks journal recovery would still be "confirmed". Move readiness after journal boot succeeds (without waiting for the network).
  - No staged rollout (all tablets matching the version code get the bundle).
  - No rollback-compatibility rule for web-layer changes to journal payload format (no journal schema/version gate beyond `PRAGMA user_version` readout at `OutboxJournalPlugin.java:202`).
  - There is no release ledger (HANDOFF known gap).
  - Production artifact inspection of debug/backup flags is only checked on source, not on the built APK.
  - Kill-during-first-migration is unit-tested only, not on a device.
- **Size**: M
- **Owner decision needed?**: Minor. Staged rollout policy: pilot outlet first, or all tablets at once? Date to flip to a production-type build.
- **Go-live blocker?**: No, with conditions: ship the production APK type (debug flags off) and keep OTA off until readiness is tied to journal boot. The binding and min-version guard remove the main hazard (bundle on the wrong native build).

### A36 — Backup scripts are not evidence of recoverability and restore lacks guardrails
- **Status**: Open
- **Evidence**:
  - `scripts/db-backup.sh` and `scripts/db-restore.sh` have no commits since the audit (`git log` empty). Backup validation is still `pg_restore -l` (`db-backup.sh:21`). Retention is the last 14 files (`:25`).
  - Restore prints the full target URL including credentials (`db-restore.sh:13`), uses `--clean --if-exists` with no `--single-transaction`, no safe-target check, and only prints four row counts (`:16-21`).
  - No scheduled backup workflow exists in `.github/workflows/`. RUNBOOK:123-138 relies on Neon snapshots/PITR plus a manual script ("drill executed" claim is historical, row counts only).
- **What's left**:
  - Safe-target guard (refuse a prod host unless confirmed, allow only disposable targets).
  - Mask credentials in logs. Add `--single-transaction`/`-1`.
  - Scheduled backup (Cloud Scheduler/GitHub schedule) with encrypted off-host storage and real daily retention.
  - A reconciliation drill that proves orders/stock/settlements/points/operation_receipts, plus a journal-replay-after-restore test (operation_receipts and processed_keys should make it idempotent, untested).
  - Document RPO/RTO and the Neon plan's actual PITR window.
- **Size**: M
- **Owner decision needed?**: Yes. Backup storage location and encryption key owner, retention period, acceptable RPO/RTO, and Neon plan upgrade (free-tier PITR history is short).
- **Go-live blocker?**: Yes. With real money and stock for 3 brands there is no scheduled, tested, off-host recovery, and the free-tier restore window is the only safety net. A mistaken deploy or migration cannot be undone except by restore.

### A37 — Sensitive evidence and local secrets need a separate handling policy
- **Status**: Partial
- **Evidence**:
  - Done: `.claude/settings.local.json` is no longer tracked (deleted in e957154, `.gitignore:57`). `*.jks` and `.env` are ignored. Secrets in earlier history are an owner-accepted risk (memory note, 2026-07-18). Native/console logging is off in release (APK 1.9). Review payloads are NUL/size-sanitized and top-level `pin` stripped server-side (`handlers/sync_review_input.go:115-139`). Client `redactPayload` strips only top-level `pin` (`packages/sync/src/engine.ts:13-20`, used at lines 126, 669, 672, 972, 994).
  - Still open: `errorReporter.ts:43-60` ships the failing payload and breadcrumbs unredacted to `/error-logs`. `CreateErrorLogs` (`writes.go:1195-1230`) stores payload/breadcrumbs as-is, with `_ = DecodeLoose`. `db-restore.sh:13` still prints the DB URL. The transfer-receive PIN still rides in the queued item (follow-up in HANDOFF). `webContentsDebuggingEnabled: true` is still set. No nested-PII policy, retention or access definition.
- **What's left**:
  - Recursive redaction (pin/token/password/phone/email keys) in the shared sync redactor, the error reporter and the server error-log insert.
  - Fix the restore log line (S).
  - Define retention/access for error_logs, which contain customer data.
  - Marker-injection test.
  - Keystore backup and continuity note.
  - Sanitized sharing archive process (the untracked review ZIPs in the repo root are leftovers, never to be committed).
- **Size**: S–M
- **Owner decision needed?**: Yes, light. Retention period and who may read error logs (admin only?). Rotate-or-accept for the secrets in history was already decided (accepted).
- **Go-live blocker?**: No. Real customers' data in error logs is admin-only and low volume. Fix the nested redaction and the restore log before go-live as hygiene.

### A38 — Dependency review is not a full reachability-verified vulnerability audit
- **Status**: Partial
- **Evidence**:
  - SheetJS was moved off the vulnerable range: `apps/backoffice/package.json:22` uses the vendored `xlsx-0.20.3.tgz`, with byte-verified vendor manifests (`scripts/ci/dependency_vendor.py`, tests in `quality`).
  - A real dependency scanner exists as CI: `.github/workflows/dependency-security.yml` with fail-closed policy, exception/applicability/license schemas and tests (`scripts/ci/dependency_security*.py`, `dependency-policy.json`). Latest run on HEAD 33557cb: `{"status":"fail","npm":439,"go":143,"blockers":24}` (from the run log).
  - `dependency-exceptions.json` has zero approved exceptions (security 0, licenses 0). So 24 raw blockers are unresolved and not excepted. Tracker: "active 6/4 retained, OpenPGP/rgbcolor unresolved".
  - The workflow is not one of the four release gates (`require-green-ci.sh:5`).
- **What's left**:
  - Triage the 24 blockers: upgrade, or record dated exceptions with reachability evidence.
  - Decide whether dependency-security joins the required release gates once it is green.
  - Produce the dated SBOM/report tied to the release lockfiles.
- **Size**: M (depends on the blocker set; some may be transitive and need upstream fixes)
- **Owner decision needed?**: Yes, light. The risk policy: which severities and reachabilities may ship with an exception, and who approves.
- **Go-live blocker?**: No. This is a P2 and the exploitable surface is mostly build tooling or non-reachable code. Revisit whether any of the 24 is a runtime/high finding before go-live.

### A39 — CSV import corrupts escaped quotes and multiline fields
- **Status**: Open
- **Evidence**:
  - `apps/backoffice/src/lib/csvUtils.ts` has no commits since 2026-09-15. `parseCSV` (`:51-82`) still splits on physical lines (`:52-57`), toggles `inQuote` on every `"` and drops the character (`:63`). So `A "quoted" name` becomes `A quoted name` and a quoted multiline record splits into two rows. `values[i] || ''` hides short rows. `.trim()` also strips intentional whitespace.
  - `exportToCSV` (`:13-30`) quotes properly but does no formula neutralization (`=`, `+`, `-`, `@`).
  - Importers still call this parser (Customers, Products via `useProductsData`, Users, ingredients).
    - **Correction (2026-10-16 plan):** Customers was export-only; there was no customer import. The plan adds one (`docs/plans/2026-10-16-a39-csv-import.md`).
- **What's left**:
  - Replace with a conformant RFC 4180 parser (a small library such as papaparse, or a ~40-line state machine with `""` and embedded-newline handling).
  - Add row/column validation with error reporting and a preview step.
  - Add export formula neutralization (prefix a quote for cells starting with `=+-@` or tab/CR).
  - Round-trip tests.
- **Size**: S–M
- **Owner decision needed?**: Minor. Formula-neutralization convention (a leading apostrophe changes stored values on re-import).
- **Go-live blocker?**: Conditional. No for daily operation. Yes if the go-live data load (catalog, 30k+ customers) uses CSV import, since it would silently corrupt names with quotes or multiline notes. Fix first, or do the initial load another way.

### A40 — Documentation and baseline labels can cause work on the wrong assumptions
- **Status**: Mostly
- **Evidence**:
  - `README.md` was rewritten (4cef102): current status, points to AGENTS.md, the audit tracker, the readiness plan, and the exact `quality:ci` commands. `AGENTS.md` and `HANDOFF.md` describe the live branch (`prod-hardening`), deploy and APK flow, and commands. Gofmt is clean on the committed tree (CI-enforced, `backend.yml:33`).
  - Still stale: `RUNBOOK.md:3-20` still leads with a Fly.io/Upstash "production" architecture, while the real target is Cloud Run. It has no mention of `deploy-backend.sh`/`promote-backend.sh`, the CI gates or `release_type`. `ONBOARDING.md` (1053 lines) was not updated since e957154. `docs/AUDIT_COVERAGE_TRACKER.md` still carries September dispositions (the brief notes this). Many historical root files (`SESSION_HANDOFF.md`, `PHASE_HANDOFF.md`, `CHATGPT_CODEX_WORKFLOW.md`) remain. No decision/command/test map.
- **What's left**:
  - Update RUNBOOK (Cloud Run first, gated deploy and rollback scripts).
  - Refresh the tracker dispositions (from this sweep).
  - Mark ONBOARDING sections as superseded or trim.
  - Optionally move historical files to `docs/archive/`.
- **Size**: S
- **Owner decision needed?**: No
- **Go-live blocker?**: No. A stale RUNBOOK matters at an incident, so refresh it before go-live.

### A43 — Malformed financial request bodies can be accepted with zero/default values
- **Status**: Mostly
- **Evidence**:
  - OpenShift/CloseShift are fixed: `writes.go:1145-1190` uses the strict decoders `service.DecodeOpenShift` / `DecodeCloseShift(r.Body, false)` (`service/shift_input.go:34-80`, with duplicate/alias/trailing-input rejection and finite-range checks). Tests: `service/shift_input_test.go`, `handlers/shift_decode_test.go`, `shift_decode_integration_test.go`.
  - Sync batch items go through the batch decoder (A04/A11 envelope work). Refund returns a clear "committed but read-back failed, do not refund again" message (`writes.go:1118-1124`), the model behavior.
  - Remaining: `CompleteStockCount` (`writes.go:1312-1316`) still does `_ = httpx.DecodeLoose(r, &body)`. A malformed body completes with `items == nil`, finalizing from stored draft items. `write/stockcount.go:200-282` has no already-completed guard, so a repeated call re-applies `actual_qty` over live stock. Shift open/close read-backs ignore the error (`writes.go:1167, 1187` use `v, _ :=`), so a failed read after commit returns success with a zero-valued shift. `RestoreRecipeVersion` (`:890`) drops `expectedCurrentVersionID` on a malformed body, which bypasses the version guard. `CreateErrorLogs` and `SignUpload` also ignore decode errors but are not financial.
- **What's left**:
  - Strict decode, plus a completed-status guard (409) and transaction-level lock in CompleteStockCount.
  - Make shift read-back failures return the stable receipt (id) rather than a zero shift.
  - Reject malformed RestoreRecipeVersion bodies when a body is present.
  - Add malformed-body tests for these handlers.
- **Size**: S
- **Owner decision needed?**: No
- **Go-live blocker?**: No for POS sales and shifts (the money-critical paths are strict). Stock-count double-completion is a backoffice stock-integrity risk. Fix it before go-live (an S fix).

### A44 — Historical/deleted variants and stock shortage handling need explicit exceptions
- **Status**: Open (half needs a policy decision)
- **Evidence**:
  - `service/order.go:361-402` is unchanged in behavior. A line with no stock row (deleted variant, bundle component) does `continue` (`:381-383`) with no record. Online shortage floors to 0 silently (`:392-394`). Offline shortage goes negative and sets `stockWarning` only (`:388-391`), with no durable per-line exception row. A grep for an exception/unresolved-movement table found none (migrations end at 0050).
  - The only related work is the `allowNegativeStock` setting plus POS warnings (SP-CRM-9c), which is client-side warning/UX. The server stays lenient.
- **What's left**:
  - Decide the policy (see below).
  - Add a `stock_exceptions`/movement-exception ledger table (migration): record skipped lines (unresolvable variant) and shortages (requested vs applied) with the order id and reason.
  - Report/reconcile screen in backoffice.
  - Preserve tombstoned variant identity, or at least name and size, on `order_items` for explanation.
  - Tests: delete a variant after an offline sale then sync; online oversell.
- **Size**: M
- **Owner decision needed?**: Yes. For new ONLINE sales, when stock is short: reject, allow negative with a flag, or keep flooring to zero? Offline completed sales are always accepted, but who reconciles the exceptions, and how are deleted variants handled (soft-delete only)?
- **Go-live blocker?**: Judgement: not a hard blocker, but a real stock-accuracy leak across 3 brands (flooring hides oversell, skipped deleted variants silently lose movement). Resolve the policy before go-live and add the exception ledger soon after.

---

## Summary (group A32, A33, A34, A35, A36, A37, A38, A39, A40, A43, A44)
1. 0 Resolved, 5 Mostly (A32, A34, A35, A40, A43), 2 Partial (A37, A38), 4 Open (A33, A36, A39, A44), 0 Policy-blocked.
2. Biggest closed items: migration advisory lock (A32), gated release/OTA/APK/backend path with commit binding (A34), OTA native-version guard and backup exclusions (A35), strict shift decoders (A43).
3. Likely go-live blockers: A36 (no scheduled, tested, off-host recovery); A33 (Redis outage stops cold starts and logs out all outlets). A39 is a blocker only if the initial data load uses CSV import.
4. Cheap wins (S): A32 MaxConns and max-instances, A43 stock-count guard and read-back receipts, A37 restore log and recursive redaction, A40 RUNBOOK refresh.
5. Owner decisions needed: A44 online-shortage policy, A36 backup storage/retention/RPO and Neon plan, A33 outage authority window, A34 GitHub Pro and Cloudflare gating, A35 staged-rollout policy, A38 exception-approval policy.
