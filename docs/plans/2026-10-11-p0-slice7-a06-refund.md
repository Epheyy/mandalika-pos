# P0 slice 7 — A06 refund parity, POS gate, denied-refund review (plan, 2026-10-11)

Opus planner (read-only) against `prod-hardening` @ `9111826` (backend = live 00090-wof / `6dd7baf`).
**No migration.** Owner answers to §9 pending; plan assumes the recommended answers.
Main-session spot-check: `order.go` `RefundTx` confirmed — `refunded` → silent `nil`, no `completed`-only check.

## 0. Already done (do not redo)

- Batch permission gate: `sync.go:352-354` refuses when `!c.CanRefund`; `CanRefund` = `auth.HasPermission(ctx,"process_refund")` (`writes.go:1324`), same predicate as direct `mw.RequirePermission` (`server.go:130-131`, admin bypass `auth/permissions.go:8-10`); guard precedes decode (`TestRefundGuardPrecedesDecodeAndOtherDispatchIsUnchanged`). Tests: `sync/refund_permission_test.go`, `handlers/sync_permission_test.go`, `middleware/permissions_test.go`, `auth/permissions_test.go`.
- Denied batch refund → review, never deleted: `Forbidden` non-retryable (`classify.go:35-44`) → `engine.ts:699-700` parks with op `review` (`KNOWN_ERROR_CODES`, `engine.ts:89-92`); `engine.review-states.test.ts:326-328`; legacy no-code path parks after 5 attempts (`engine.refund-permission.test.ts`). Denial text already says "Jika uang sudah dikembalikan, jangan bayar ulang" (`sync.go:353`). `onDeadLetter` → `/error-logs` (`SyncProvider.tsx:77-88`) → backoffice `ErrorLogs.tsx:189-193`. "Coba lagi" resends same key. Parked enveloped items don't lock the terminal (slice 6 H1).
- Exactly-once refund (A11): `sync.go:362-364` `operation_receipts`; failed refund leaves no receipt (`operation_receipts_integration_test.go:372-387`).
- Capture-time attribution (slice 6): `attribute.go:179-229`; EV cases `capture_envelope_integration_test.go:311,439-441`.
- Refunds have no optimistic stock credit (`pendingStockDeltas` only `order`, `engine.ts:438-441`); `prune()` removes only acked (`outbox.ts:411-415`).

## 1. Parity: direct `POST /orders/{id}/refund` vs `/sync/batch` `refund`

Direct `writes.go:1060-1075`; batch `sync.go:351-369`; both → `OrderService.RefundTx` (`order.go:631-752`).

| # | Aspect | Direct | Batch | Kind | Slice 7 action |
|---|---|---|---|---|---|
| 1 | Permission | middleware → 403 | `CanRefund` → forbidden, non-retryable | Same predicate (token claims ≤15 min stale) | Keep; prove in parity table |
| 2 | Reason missing/`""` | 400 (`:1064`) | accepted, stored `''` | **Diff** | Reject both |
| 3 | Reason whitespace-only | accepted raw | accepted | Shared gap | Reject both |
| 4 | Reason length | unlimited | unlimited | Shared gap | ≤500 runes both; store trimmed |
| 5 | Order state | only `refunded` short-circuits; `cancelled` gets flipped + restocked + reversals | same | Shared gap | Only `completed` refundable |
| 6 | Already refunded | silent 201 | silent ok under new key | Shared gap — second payout invisible | Q1: reject → 409 / `conflict` → review |
| 7 | Outlet scope | `caller()` token / admin `X-Outlet-Id` / `users.outlet_id` (`writes.go:28-40`, `middleware.go:28-38`) | envelope outlet via `attribute()`; legacy = request outlet; none → 403 (`writes.go:1317-1320`) | **Diff** | see 8 |
| 8 | Admin, no outlet | outlet `''` → uuid 22P02 → 400 raw PG text; backoffice "Semua outlet" refund broken (inferred, not run) | 403 | **Diff + bug** | Direct: admin w/o outlet refunds at the order's own outlet (Q4) |
| 9 | Order id | path param unvalidated → raw PG 400 | non-uuid → 22P02 → rejected (sanitised) | Diff | Shared uuid check → Rejected |
| 10 | Error mapping | everything 400 with raw `err.Error()` (`writes.go:1070`, `handlers.go:114-123`) | classified | **Diff** | Rejected 400, Forbidden 403, Conflict 409, Busy 409, else 500 sanitised |
| 11 | Committed refund retried after permission removed | n/a | forbidden before receipt replay → false review item | Diff vs M3 rule (`sync.go:286-295`) | On forbidden probe `alreadyApplied`; applied → replay ok |
| 12 | `refunded_at` | now() | now() at sync | Diff | No change (Q5) |
| 13 | Decode | `DecodeLoose` | `json.Unmarshal` | Same | Keep lenient |
| 14 | Amount/qty | whole-order only | same | Same | No partial refunds |
| 15 | Shift | none | envelope shift other outlet → actor_mismatch | Batch only | No change (§3) |
| 16 | Who refunded | not recorded | not recorded | Shared | Deferred (`refunded_by` migration) |

## 2. Design

Shared rules in `OrderService.RefundTx` (direct via `Refund` `order.go:616-626`; batch via `refundFunc` `sync.go:218,363`).

New `service/refund_input.go`: `MaxRefundReasonRunes = 500`; `NormalizeRefund(orderID, reason)`: non-uuid → `ErrRefundOrderInvalid` (Rejected); `TrimSpace`; empty → `ErrRefundReasonRequired`; >500 runes → `ErrRefundReasonTooLong` (Rejected). Indonesian messages ending "Data tetap tersimpan. Jika uang sudah dikembalikan, jangan bayar ulang."

`RefundTx`: `NormalizeRefund` before SQL; after `FOR UPDATE`: `refunded` → `ErrAlreadyRefunded` (Conflict, Q1); status ≠ `completed` → `ErrOrderNotRefundable` (Conflict). Keep `ErrOrderClosed` (shared with `shift.go:107`). Store trimmed reason.

Permission stays at transports (same predicate; parity table proves it).

Batch (`sync.go:352`): `!c.CanRefund` → `e.alreadyApplied(ctx,c,it)`; applied → `ok` with id; else today's forbidden message.

Direct (`writes.go:1060`): invalid JSON → 400; remove `:1064` empty check (service owns it). Outlet: `c.outletID` if set; else admin → order's own `outlet_id` (new `OrderService.OrderOutlet`; missing → 409); else 403. Map via `apperr.CodeOf`; log raw errors server-side only.

POS:
- `canRefund(user)` in `packages/types` (next to `PERMISSIONS.PROCESS_REFUND`, `index.ts:48`): `role==='admin' || permissions.includes('process_refund')`. Uses cached `useAuth().user` (`authBoot.ts:8,31-33,121-122`, `auth.tsx:130-133`) → works offline on last-known permissions.
- `OrderHistoryPanel.tsx:278-285` "Refund Transaksi Ini": show only when order `completed`, user can refund, and no queued/parked refund for it; else muted "Butuh izin Proses Refund" / "Refund menunggu sinkronisasi". Props `canRefund`, `refundQueuedIds` from new engine `queuedRefundOrderIds()` (non-acked refund items). Closes the offline double-refund path.
- `CashierScreen.tsx:777`: defensive `!canRefund` guard; payload `{orderId, reason, orderNumber, total, paymentMethod}` (extra keys display-only; server must never read them).
- `RefundDialog.tsx:65-72`: `maxLength` from shared `MAX_REFUND_REASON_CHARS = 500` + counter.
- Review row: `ReviewItem` (`outbox.ts:78-88,305-315`) gains read-only `payload`; `useOfflineData.ts:47-55` builds refund detail "BSD-G0007 · Rp 225.000 · Tunai"; rendered in `SyncStatus.tsx:152-170`. Old items render as today.

## 3. Shift expected cash (deferred) — today

Server close (`shift.go:119-138`) and POS recap (`recapData.ts:10,38` → `ShiftRecapPanel.tsx:42-67`) group by the **sale's** shift + current status: refund of an open-shift sale moves it to `total_refunds`; refund of a closed-shift sale changes nothing; pending/denied refund still counts as cash. Refund cash is never recorded against the refunding shift → "Selisih" unexplained. Slice does not change the math; review row shows amount. Rest = Q2.

## 4. Wire / contracts

No migration. Extra display keys allowed (`openapi.yaml:1668`); A11 fingerprint covers new items only. No new error code (`rejected`/`conflict`/`forbidden` in enum `openapi.yaml:1704` + `KNOWN_ERROR_CODES`). OpenAPI: `RefundRequest.reason` `minLength 1, maxLength 500` (`:1600-1604`); `refundOrder` adds 409, drop "(idempotent)" (`:4025-4049`); embedded spec → `make gen-go` + TS regen + `pnpm gen:check`. Old APKs always send trimmed non-empty reason; only already-refunded/cancelled rules bite; refused → review (1.2+) or park after 5. Precondition: tablets at 0 pending.

## 5. Tests (failing first)

A. PG gate **RF**: `handlers/refund_parity_integration_test.go` `TestRefundParityPostgres`; env `MANDALIKA_RF_TEST_DSN`/`_DATA_DIR`; guard `127.0.0.1:56449`, db `mandalika_rf_synthetic`, user `rf_test` (copy `capture_envelope_integration_test.go:33-65`); register `("RF","TestRefundParityPostgres",56449,"rf")` in `scripts/ci/postgres_gate.py:27-38`. Direct via `RequireAuth`→`RequirePermission("process_refund")`→`h.RefundOrder`; batch via `RequireAuth`→`h.SyncBatch` with envelope. Fresh order per path with customer points + discount code. On every reject assert zero effect (status, refund_reason, refunded_at, stock, points + ledger, usage_count, receipt count).

| # | Case | Direct | Batch | Fails today |
|---|---|---|---|---|
| 1 | permitted cashier, "rusak", own completed order | 201 | ok; effects once | no |
| 2 | no `process_refund` | 403 | forbidden, retryable=false | no |
| 3 | admin role, no explicit perm | 201 | ok | no |
| 4 | reason `""`/missing | 400 | rejected | batch |
| 5 | reason `"   "` | 400 | rejected | both |
| 6 | 501 multibyte runes / exactly 500 | 400 / 201 | rejected / ok | both |
| 7 | `"  rusak  "` | 201 stored "rusak" | same | both |
| 8 | other outlet's order | 409 | conflict | direct |
| 9 | unknown uuid | 409 | conflict | direct |
| 10 | id `"abc"` | 400 sanitised | rejected | direct |
| 11 | already refunded (Q1) | 409 | conflict | both |
| 12 | `cancelled` order | 409 | conflict | both |
| 13 | batch same-key replay of 1 | — | ok same id, no 2nd restock | no |
| 14 | committed refund, same key, perm now removed | — | ok replay, zero effects | yes |
| 15 | admin direct, no `X-Outlet-Id` | 201 at order's outlet | n/a | yes |

B. Go unit: `service/refund_input_test.go`; handler error mapping (fake service); `sync/refund_permission_test.go` forbidden + applied → replay / not applied → `permissionMessage`.

C. TS: `canRefund`; OrderHistoryPanel gating + queued hide; CashierScreen guard; `queuedRefundOrderIds`; review payload/detail; `engine.review-states.test.ts` refund refused `rejected`/`conflict` → review, payload kept, never discarded, retry same key.

D. Regression: all 10 PG gates + RF; never loosen an existing case — justify.

## 6. Tasks

| # | Task | Reviewer |
|---|---|---|
| T1 | RF gate + registration, failing on today's code | Opus |
| T2 | Go unit tests, failing first | Opus |
| T3 | `refund_input.go` + `RefundTx` rules | Opus |
| T4 | Direct handler outlet + error mapping | Opus |
| T5 | Batch forbidden → `alreadyApplied` replay | Opus |
| T6 | OpenAPI + regen + gen:check | Opus |
| T7a | `canRefund` + POS gate | Opus |
| T7b | `MAX_REFUND_REASON_CHARS` + dialog maxLength/counter | Haiku |
| T8 | `queuedRefundOrderIds`, `ReviewItem.payload`, snapshot, review detail, hide button | Opus |
| T9 | (Q2=a) close-screen line "Refund belum tersinkron / perlu ditinjau: n · Rp X" | Opus |
| T10 | HANDOFF + plan with owner answers | Haiku |
| T11 | Deploy backend, then APK (owner go-ahead each) | Opus |

Implementer: Sonnet.

## 7. Ship

Preconditions: CI green (backend -race, PG 11 gates, JS/TS, browser); tablets at 0 pending; owner go-ahead.

Backend first (APK 1.5 unaffected): `gcloud run deploy mandalika-pos --source backend --region asia-southeast2 --project mandalika-pos --no-traffic --tag rf7 --quiet` → `/readyz`.
Tag smoke (rejects only, no writes): direct `"   "` + random uuid → 400; id `"abc"` → 400 sanitised; unknown uuid → 409; batch empty reason enveloped → rejected, then `BEGIN READ ONLY` check no receipt row. No-permission and positive cases need throwaway writes → ask owner.
Traffic: `gcloud run services update-traffic mandalika-pos --region asia-southeast2 --to-tags rf7=100`.
Rollback: `--to-revisions mandalika-pos-00090-wof=100` (no migration; refunds parked by new rules would pass old rules if retried).
POS: APK 1.6 (versionCode 7) — push, then `gh workflow run android-release.yml ...`. OTA technically enough, but first OTA blocked by `decide.go` follow-up + empty bucket (Q6).

## 8. Risks

- Q1 may create review items for legit double taps (mitigated: submit gate + queued hide; same-key replays).
- Validation inside receipt tx → refusal rolls back the claim (RF asserts receipt count).
- Denied refund with cash paid out lives only in tablet review + ErrorLogs until a resolve screen exists.
- Admin no-outlet fix grants no new authority but turns a backoffice error into success (Q4).
- Token-claim permissions ≤15 min stale; POS gate UI-only.
- "Selisih" stays unexplained for earlier-shift/pending/denied refunds until Q2.

## 9. Owner questions

1. Already-refunded order → refuse + tablet review "sudah direfund"? (rec: yes)
2. Expected cash at close: (a) close-screen line, no migration (rec now) / (b) server records refund cash on refunding shift (migration) / (c) leave.
3. Reason ≥1 non-space char, ≤500 chars? (rec: yes)
4. Admin refund from "Semua outlet" at order's outlet? (rec: yes). Backoffice button stays admin-only (`Orders.tsx:265`)? (rec: yes)
5. `refunded_at` server time at sync? (rec: keep)
6. POS as APK 1.6 or first OTA? (rec: APK)
7. Still open: who resolves review items.
8. Pre-go-live: audit real accounts' `process_refund`.

Not verified: backoffice all-outlet failure not reproduced; new rules not run against existing PG gates; live `cancelled` order count; fleet APK versions.

## Owner answers (2026-10-11)

1. Already refunded → **refuse → review** (Conflict).
2. Shift cash → **(b) server records refund cash against the refunding shift (migration)**. Replaces T9; design in addendum below. Migration needs owner sight before apply.
3. Reason rules → recommended default (≥1 non-space, ≤500).
4. Admin no-outlet → **order's own outlet**; backoffice button stays admin-only.
5. `refunded_at` → recommended default (server time).
6. POS → **APK 1.6**.

## Addendum A — Q2(b): refund cash recorded against the refunding shift (replaces T9)

### A1. Facts
- Migrations: `backend/internal/db/migrations/` (latest `0046_order_tender_warning.sql`), embedded, applied once at boot under advisory lock (`internal/db/db.go:15-16,61-109`, `cmd/server/main.go:43`). Up-only.
- No stored expected cash today: close (`service/shift.go:119-138`) stores per-method sales of the **sale's** shift (completed only) + `total_refunds`. POS recap "Tercatat" vs "Terhitung" per method (`ShiftRecapPanel.tsx:42-67,411-414`, `recapData.ts:10,38`).
- Refunding shift source = envelope `shiftId` (`engine.ts:330` from `authStore.shiftId`, server-known only; `useShift.ts:131`). `attribute()` (`attribute.go:210-225`) refuses other-outlet shift, accepts closed (logged) / unknown (warn); does not return the shift today.
- Shift/Order reads decode into typed `api.Shift`/`api.Order` (`read/repo.go:1033-1040,960-975`) → new fields MUST be in OpenAPI + regen or they're silently stripped (8c gap class).

### A2. Migration `0047_refund_shift.sql` (owner confirms right before deploy)
```sql
-- A06/Q2b: who paid a refund out, and from which shift's drawer. Additive: the
-- previous revision never reads or writes these columns (nullable / defaulted).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_shift_id  uuid REFERENCES shifts(id) ON DELETE SET NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refunded_by      uuid;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refunded_by_name text;
CREATE INDEX IF NOT EXISTS idx_orders_refund_shift ON orders(refund_shift_id) WHERE refund_shift_id IS NOT NULL;
-- Close-time snapshot of refunds paid by this shift for sales of OTHER shifts.
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS refunds_paid_by_method jsonb;
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS cash_refunds_paid      numeric(14,2) NOT NULL DEFAULT 0;
```
- `refund_shift_id` mirrors `orders.shift_id` FK (`0001_init.sql:252`); FK takes `FOR KEY SHARE` on the shift row → serialises with close's `FOR UPDATE` (`shift.go:103-104`).
- `refunded_by`/`_name`: no FK + name snapshot, like `cashier_id`/`cashier_name`. Included now (same UPDATE; A06 audit trail). Operator-per-shift stays deferred.
- 00090-wof names columns explicitly in INSERTs and reads → ignores new columns → rollback safe. FK add = brief ACCESS EXCLUSIVE, trivial at test scale.
- Manual reversal (reference only): drop index; drop the 5 columns; `DELETE FROM schema_migrations WHERE name='0047_refund_shift.sql'`.

### A3. Source of `refund_shift_id`
| Path | refund_shift_id | refunded_by |
|---|---|---|
| Batch, envelope shift (open/closed) of attributed outlet | that shift | attributed user |
| Batch, envelope shift unknown / non-uuid | NULL + warn | attributed user |
| Batch, envelope shift other outlet | `actor_mismatch` (existing) | — |
| Batch, legacy no envelope | NULL + warn (never flush-time open shift) | request user |
| Direct (backoffice/API) | NULL (B2) | caller |

Code: `Caller.EnvelopeShiftID` from `attribute()`; `service.RefundInput{OutletID, OrderID, Reason, ShiftID, UserID, UserName}` for `refundFunc`/`RefundTx`; UPDATE (`order.go:652-655`) sets `refund_shift_id=NULLIF($n,'')::uuid, refunded_by, refunded_by_name`. Fakes in `sync/refund_permission_test.go` get a mechanical signature update.

### A4. Close math (server = tablet)
Cross-shift refund paid by S = `refund_shift_id=S AND status='refunded' AND shift_id IS DISTINCT FROM S`. Same-shift refunds are already out of S's sales and in `total_refunds` → excluded (no double subtraction).
- `CloseShiftTx`: same UPDATE adds `refunds_paid_by_method` (jsonb_object_agg per method) and `cash_refunds_paid` (sum where method ∈ cash ids). `shiftCashMethodIDs` (`shift.go:150-170`) widened to `(shift_id=$1 AND status='completed') OR (refund_shift_id=$1 AND status='refunded')`. `cash_sales`/`total_sales`/`total_refunds` unchanged (TD unaffected). Drawer expected = `cash_sales − cash_refunds_paid`, derived by readers.
- `shiftObj`: `cashRefundsPaid`; `refundsPaidByMethod` = snapshot when closed, live subquery when open; pre-0047 closed → NULL = `{}`. `orderObj`: `refundShiftId`, `refundedBy`, `refundedByName`.
- POS (APK 1.6): `ShiftRecapPanel` recorded per method = `byMethod[m] − refundsPaidByMethod[m]` (`:411-414`) + muted "Refund transaksi shift lain −Rp X"; same in Total Tercatat (`:458-460`), `buildCurrentRecap` (`:289-300`), historical/print; `shiftView.ts:62` defaults. APK 1.5 ignores.
- Late refunds (parked+retried after close, or other tablet) keep `refund_shift_id=S`; snapshot never recomputed (owner rule). Findable via `refunded_at > closed_at`; list = follow-up. Normal FIFO flushes refund before `shift_close`.
- Denied/parked refunds never reach the server → only the T8 review row.

### A5. Contracts
OpenAPI `Shift` (`:1300-1326`): `cashRefundsPaid` number; `refundsPaidByMethod` object, `additionalProperties: number`, nullable (plain, not `$ref`). `Order`: `refundShiftId`, `refundedBy`, `refundedByName` (nullable strings). Regen + gen:check (Opus). Backoffice: `Reports.tsx` (`:144-146,356-358`) column + CSV "Refund dibayar (Tunai)"; `Orders.tsx:254-262` "oleh {refundedByName}". Push without `[CF-Pages-Skip]`.

### A6. Tests (RF, failing first)
| # | Case | Expect |
|---|---|---|
| 16 | sale in closed S0; batch cash refund, envelope S open | refund_shift_id=S, refunded_by set; close S → cash_refunds_paid=total, by_method {tunai}; S0 unchanged |
| 17 | sale + refund both in S | cash_sales excludes, total_refunds includes, cash_refunds_paid=0 |
| 18 | cross-shift QRIS refund | by_method {qris}, cash_refunds_paid=0 (per B1) |
| 19 | custom `isCash` method | counted in cash_refunds_paid |
| 20 | GET /shifts/current open, GET /shifts/{S} closed | live then snapshot; fields present (anti-strip) |
| 21 | late: S closed, then refund envelope S | ok, refund_shift_id=S, snapshot unchanged |
| 22 | unknown shift / legacy / direct | refund_shift_id NULL, refunded_by=caller |
| 23 | rejected refund | new columns stay NULL |
| 24 (opt) | refund vs close race | counted in S or late w/ unchanged snapshot, never half |

Re-run unchanged: TD 17/18 (`tender_rules_integration_test.go:426-445,528`), OR replays, EV refund cases (+EnvelopeShiftID), S0D, A27; TS recap subtraction + shiftView defaults.

### A7. Tasks (replace T9)
T9a RF 16–23 failing first (Opus) · T9b migration 0047 (Opus) · T9c EnvelopeShiftID + RefundInput + RefundTx (Opus) · T9d close math + shiftCashMethodIDs + shiftObj/orderObj (Opus) · T9e OpenAPI/regen with T6 (Opus) · T9f POS recap/print/shiftView (Opus) · T9g backoffice column + "oleh" (Haiku) · T9h if B3=block: POS "Buka shift dulu" (Opus).

### A8. Deploy / rollback
`--no-traffic --tag rf7` boot **applies 0047 to shared Neon while 00090-wof serves** — safe (additive). Read-only check `SELECT name FROM schema_migrations WHERE name LIKE '0047%'`. Smoke adds: GET /shifts/current on tag returns new fields; `count(*) WHERE refund_shift_id IS NOT NULL` = 0. Rollback: traffic → 00090-wof; columns stay, ignored.

### A9. Risks
NULL-shift refunds reduce no drawer; late refunds never adjust closed shift (follow-up list); APK 1.5 shows old Tercatat; denied/parked refunds tablet-only; close vs refund serialise via FK lock (no cycle).

### A10. Owner questions
B1 refund tender: original method vs always drawer cash (rec: original). B2 direct/backoffice refunds: NULL shift vs outlet's open shift (rec: NULL). B3 POS refund with no open shift: block vs allow (rec: block). B4 0047 includes refunded_by/_name now (rec: yes).

**Owner answers (2026-10-11): B1 original method · B2 NULL (no drawer) · B3 block ("Buka shift dulu") · B4 yes, 0047 as designed.** Owner will confirm once more right before the deploy that applies 0047.
