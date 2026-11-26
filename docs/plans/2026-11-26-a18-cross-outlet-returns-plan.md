# A18 cross-outlet returns: implementation plan (Opus, 2026-11-26)

Contract: `docs/plans/2026-11-26-a18-cross-outlet-returns-spec.md` (owner answers are final). Background: C4 per-line refund
plan `docs/plans/2026-10-28-c4-per-line-refund.md`. Words: **X** = sale outlet, **Y** = returning outlet (the caller's
active outlet). Line numbers are from `origin/prod-hardening` at `53eaa8f6`; re-check before editing.

Branch `claude/a18-cross-outlet-returns-ebb4ab` -> PR into `prod-hardening`, gates on `gate/a18-cross-outlet-returns`.
No migration is needed (see 4.4). Release = backend deploy + POS OTA (web layer only, no APK).

## 1. Shape in one paragraph

A new online-only endpoint runs the SAME `RefundLinesTx` as the batch and direct paths, with one new input field
`SaleOutletID` (X) used only to find and lock the order. Everything else in the refund (stock restore, ledger,
`erp_outbox` location, `order_refunds.outlet_id`, stock seq, shift) uses `OutletID` = Y, exactly as today. The batch
path never sets `SaleOutletID`, so it stays pinned to the envelope outlet and refuses another outlet's order as it does
today. Shift close and the POS live recap stop subtracting refunds paid at another outlet from the sale shift; Y's shift
already counts them as "refunds paid for other shifts". `order_refunds.outlet_id` keeps meaning "the outlet that paid
the refund" (today that is always also the sale outlet, so every existing row reads the same after the change).

## 2. Backend: service

### 2.1 `RefundInput.SaleOutletID` (`backend/internal/service/refund_input.go:86-113`)

- Add `SaleOutletID string` with a comment: "where the order lives; empty = OutletID. Only RefundCrossOutlet sets it.
  OutletID is the RETURNING outlet: stock, ledger, ERP location, order_refunds.outlet_id, stock seq, shift."
- Add `func (in RefundInput) saleOutlet() string` returning `SaleOutletID` or `OutletID`.

### 2.2 `RefundLinesTx` (`backend/internal/service/refund.go:82`): minimal diff

- L83: `outletID, orderID := in.OutletID, in.OrderID` stays; add `saleOutletID := in.saleOutlet()`.
- L102 pre-read and L127 `FOR UPDATE` read: bind `saleOutletID` instead of `outletID`. Nothing else changes.
- L197 `VariantLive` check keeps `$2 = outletID` (Y): it must look at the outlet the L350 upsert writes to.
- L261 insert, L350 restock, L402 `recordRefundMovements` (`ledger_hooks.go:29`, `LocationID: in.OutletID`), L409
  `BumpStockSeq`: unchanged, all Y. `ledger.RecordDeltas` reads current stock at `doc.LocationID`
  (`ledger.go:357-386`) and never compares with the sale movement's location; `refund_of_movement_id` is only an FK
  (`0064_stock_movements.sql:28`). Confirmed, no ledger change.
- Doc comment above L82: add one paragraph on X vs Y. Keep the A42 lock-order paragraph and the WRITE ORDER paragraph
  word for word.
- `Channel` for the new path is `"direct"`: `0055_sale_stock_exceptions.sql:20` only allows `sync|direct`.

### 2.3 New `RefundCrossOutlet` (new file `backend/internal/service/refund_cross_outlet.go`, about 90 lines)

```go
// RefundCrossOutlet is the online-only A18 return: a sale made at another outlet, refunded and paid out at
// in.OutletID (Y) from Y's open shift in.ShiftID. One transaction; the same RefundLinesTx guards apply.
func (s *OrderService) RefundCrossOutlet(ctx context.Context, in RefundInput) (CrossOutletOutcome, error)
```
`CrossOutletOutcome` holds `RefundResult` plus `SaleOutletID`. Steps inside one tx:

1. Validate: `in.DeviceID` (1-128 runes) and `in.ClientRefundUUID` (canonical uuid) are both required
   (`ErrCrossRefundKeyRequired`, Rejected). `NormalizeRefund` and `ValidateRefundExtras` run inside RefundLinesTx.
2. **Replay probe:** `SELECT order_id FROM order_refunds WHERE device_id=$1 AND client_refund_uuid=$2`. Found for another
   order: `ErrRefundOrderMismatch` (400). Found for this order: set a `replay` flag. The flag ONLY skips step 4 (the
   open-shift check); steps 3 and 5 ALWAYS run, because without `SaleOutletID` the L102 pre-read would look for the
   order at Y and answer 409 not-found for a refund that is already committed. RefundLinesTx's own `replayedRefund`
   (L143-151) then returns the original outcome with `Replayed=true`. So a retry after Y's shift closed still answers
   2xx with the original refund instead of "no open shift".
3. `SELECT outlet_id FROM orders WHERE id=$1`: none = `ErrRefundOrderNotFound`. Equal to `in.OutletID` =
   `ErrCrossRefundSameOutlet` (Conflict, "Transaksi ini dari outlet ini. Refund lewat Riwayat biasa.") so a same-outlet
   refund keeps one path (outbox).
4. Shift: `SELECT 1 FROM shifts WHERE id=$1 AND outlet_id=$2 AND status='open' FOR SHARE`. No row =
   `ErrCrossRefundShift` (Conflict, "Shift di outlet ini belum dibuka atau sudah berganti. Buka/segarkan shift lalu coba
   lagi."). The FOR SHARE closes the race with Y's close (`shift.go:310-312` takes the row FOR UPDATE, then aggregates):
   either the close waits and sees the refund, or the refund sees `closed` and is refused before any money moves. Lock
   order note (verified: the only `UPDATE shifts` / shift `FOR UPDATE` in `internal/` is close, `shift.go:310,330`;
   other writers only take FK `KEY SHARE`, which does not conflict with `FOR SHARE`): close takes no A42 lock
   (codes/customer/order/stock), so taking the shift row first cannot form a cycle. Write that as a comment.
5. Set `in.SaleOutletID`, `in.Channel = "direct"`.
6. `RefundLinesTx(ctx, tx, in)`, commit. Wrap the whole function in `write.RetryBusy` at the handler (as `RefundOrder`
   does, `handlers/orders.go:241`).

New errors next to the others in `refund_input.go:22-50` (all end with `refundWarning`): `ErrCrossRefundKeyRequired`
(Rejected), `ErrCrossRefundSameOutlet` (Conflict), `ErrCrossRefundShift` (Conflict).

### 2.4 Batch path: no code change, tests only

`sync.go:389-421` passes `c.OutletID` into `refundSaleID` (`resolveSaleTx` L150-170: `order_uuid=$1 AND outlet_id=$2`)
and `p.input()` (L95-125) never sets `SaleOutletID`. A queued refund naming X's order from Y's tablet fails at
`refund.go:102` with `ErrRefundOrderNotFound` (Conflict, non-retryable = review item in Tinjauan Sinkron). **Decision:
keep that existing error**, do not add a cross-outlet-specific one: the comment at `refund_input.go:28` makes "unknown"
and "other outlet" indistinguishable on purpose, its text already says "di outlet ini" and carries the do-not-repay
warning, and the POS never queues a cross-outlet refund (5.4), so this is a defence-in-depth path only.

## 3. Backend: HTTP

### 3.1 Refund endpoint

`POST /api/v1/orders/{id}/cross-outlet-refund`, route-gated `mw.RequirePermission("process_refund")`, registered next to
`server.go:204-205`. Handler in new file `backend/internal/handlers/cross_outlet_refund.go` (do not grow `orders.go`).

Request `CrossOutletRefundRequest` (OpenAPI, required marked *):

| field | rule |
|---|---|
| `clientRefundUuid`* | canonical uuid; generated and persisted by the tablet before the first send |
| `deviceId`* | 1-128 chars; the tablet's device id (same value the outbox puts in refund payloads) |
| `shiftId`* | uuid; must be Y's open shift |
| `reason`* | 1-500 (same rule as `RefundRequest`) |
| `reasonCode` | as `RefundRequest` |
| `items` | per-line `[{lineNo, quantity}]`, absent = whole order (legacy order without line numbers) |
| `refundAmount` | number >= 0, what the tablet showed (D-39 captured fact; same rounding as `sync.go:118-124`) |
| `payoutMethod`, `payoutPicked` | as the sync payload (C6a) |

Handler steps: decode (`httpx.DecodeLoose`, body-too-large as `RefundOrder` L192-198); `c := h.caller(r)`; **active
outlet required**: `c.outletID == ""` -> 403 "Outlet aktif belum dipilih untuk akun ini." (no admin fallback, unlike
`RefundOrder` L226-239: Y must be explicit). Coverage needs no new check: the auth middleware (`middleware.go:76-90`)
already refuses an `X-Outlet-Id` the user does not cover, so a Kasir can only act at the home outlet. Build
`RefundInput{OutletID: c.outletID, OrderID, ShiftID, UserID, UserName, Items, RefundAmount, ReasonCode, PayoutMethod,
PayoutPicked, DeviceID, ClientRefundUUID}` and call `RefundCrossOutlet` inside `write.RetryBusy`.

Response `CrossOutletRefundResponse` `{data: {refundId, refundState: full|partial, amount, replayed, refund:
OrderRefund, order: CrossOutletOrder}}`; 201 when applied, 200 when `replayed`. `refund` is the row actually stored (read
back by `refundId` from the order's `refunds` array), so the tablet prints from what the server kept, never from its own
selection (a replay returns the earlier refund whatever items the retry sent). Read-back uses the lookup's stripped
projection (3.2) by order id with no outlet scope (the order is at X), so the response never shows more than the lookup. A read-back failure after commit: 500 with the `RefundOrder` L258 wording ("Refund
tersimpan ... jangan refund ulang").

Errors (own mapper, not `refundHTTPError`, because the tablet must tell "try again with the same uuid" from "refused"):

| case | HTTP | tablet |
|---|---|---|
| malformed body/ids/uuid/deviceId/reason, `ErrRefundOrderMismatch`, line errors | 400 | refused, clear attempt |
| no `process_refund` / no active outlet / uncovered outlet | 403 | refused, clear attempt |
| not found, same outlet, no/stale shift, already refunded, not refundable, qty exceeded, partial-needs-new-app | 409 | refused, clear attempt |
| `apperr.Busy` or pg 40P01/40001/55P03 after RetryBusy | 503 + `Retry-After: 2` | retryable, keep attempt |
| anything else | 500 sanitised | retryable, keep attempt |

### 3.2 Lookup endpoint

`GET /api/v1/cross-outlet-returns/lookup?orderNumber=...` or `?phone=...` (exactly one, else 400), same permission
gate. Handler in the same new file; query in new `backend/internal/read/cross_outlet.go`.

- Active outlet required (403 as above). Online only by nature; never cached by the tablet.
- `orderNumber`: exact match on the globally unique `orders.order_number` (`0001_init.sql:227`), trimmed; the
  implementer confirms the stored case and upper-cases the input only if every generated number is upper-case.
- `phone`: `phone.Normalize`; empty = 400 "Nomor HP tidak valid". Exact `customers.phone_norm = $1 AND merged_into IS
  NULL` (index `idx_customers_phone_norm`, `0080`), then that customer's orders. Never ILIKE, never a partial phone (A30).
- Filters: `o.outlet_id <> $active` (own-outlet sales stay in normal Riwayat), `o.status IN
  ('completed','partially_refunded','refunded')` (refunded ones are shown so the cashier sees "sudah direfund"),
  newest first, `LIMIT 20`. No date window (owner: no return deadline).
- Row = `CrossOutletOrder {outletName, order: Order}`: reuse `orderObj` (`read/orders.go:62`) so RefundDialog and
  `buildRefundBasis` get every field they read today (items with `lineNo`, `netAmount`, `refundGroup`, `refundedQty`,
  `tenders`, `refunds`, `refundedAmount`, `shiftId`). Strip `customerId`, `customerName`, `deviceId` with
  `orderObj::jsonb - 'customerId' - 'customerName' - 'deviceId'` so an order-number search cannot be used to read
  another outlet's customer names (A30). The phone is never in `orderObj`. None of the three is in `Order.required`
  (`openapi.yaml:1921`), so the generated type stays honest.
- Response `{data: CrossOutletOrder[]}`.

### 3.3 Per-refund outlet on order reads

`read/orders.go:38-49` `refunds` array: add `'outletId',r.outlet_id`. OpenAPI `OrderRefund` (`openapi.yaml:1795`): add
`outletId: {type: string, format: uuid}` OPTIONAL and NOT nullable (avoids the `$ref`+nullable codegen gotcha and the
`TestApprovedNullableFields` list; old tablets ignore it). Regenerate `internal/api/api.gen.go` (read decodes into it, so
a field missing from the spec is silently dropped) and `packages/api` `schema.d.ts`.

### 3.4 OpenAPI + clients

Add both operations and the four schemas to `backend/api/openapi.yaml` (tag `sales`, `OutletHeader` param). Run backend
codegen and `corepack pnpm gen:check`. Add `packages/api/src/client.ts` methods `crossOutletLookup(q: {orderNumber} |
{phone})` and `refundCrossOutlet(orderId, body)`, typed from the schema, next to `refundOrder` (L474, L1044). No new
top-level test in `internal/api` or `internal/codegen` is planned, so `scripts/ci/codegen_gate.py` is untouched; if one
is added, list it in CONTRACT/GUARD in the same commit.

## 4. Shift math and reports

### 4.1 Rule

A refund is "cross-outlet" iff `r.outlet_id <> o.outlet_id`. Sales views (net sales, sales by product, customer spend)
key on `o.outlet_id` = X. Cash, shift and payout views key on `r.outlet_id` / `r.shift_id` = Y. Every existing row has
`r.outlet_id = o.outlet_id` (both came from the same `in.OutletID`), so every change below is a no-op on today's data;
gate XO asserts `SELECT count(*) FROM order_refunds r JOIN orders o ON o.id=r.order_id WHERE r.outlet_id<>o.outlet_id`
is 0 before the first cross refund.

### 4.2 Query table

| query (file:line) | keys on | change |
|---|---|---|
| shift close block (a) lateral, `service/shift.go:363-364` | sale shift `o.shift_id` | **add `AND r.outlet_id = o.outlet_id`**: X's `total_sales`/`total_refunds` ignore Y-paid refunds (X's drawer never paid them), consistent with its buckets |
| shift close block (b) refund arm, `shift.go:386-388` | sale shift | **add `AND r.outlet_id = o.outlet_id`**: X's cash/card/transfer/qris buckets keep the sale money (owner answer 1) |
| shift close block r, `shift.go:395-404` | paying shift `r.shift_id` | none: `o.shift_id` is X's shift, so Y counts it in `refunds_paid_by_method` / `cash_refunds_paid` |
| `shiftCashMethodIDs` third arm, `shift.go:434-435` | sale shift | **add the same predicate** (keeps method classification aligned with block b) |
| live `refundsPaidByMethod`, `read/shifts.go:26-31` | paying shift | none: Y's open shift shows the payout live |
| dashboard refund set, `read/dashboard.go:56-60` | `r.outlet_id` AND `o.outlet_id` | **remove the extra `r.outlet_id` clause**: with both, X's dashboard drops Y-paid refunds and Y never sees them, so X's net would not drop. `appendOrderWhere` already adds `o.outlet_id` (`orderfilter.go:80-81`). Loses the `idx_order_refunds_outlet_day` hint; refund volume is tiny (about 600 sales a day), confirm with `EXPLAIN` in gate DB/XO, no new index unless it degrades |
| report summary refund set, `read/reports.go:41-46` | `o.outlet_id` (appendOrderWhere) | none: refunds net at X |
| orders list refund basis, `orderfilter.go:96-114` | `o.outlet_id` | none: X lists it by refund date |
| refund report, `read/refund_report.go:42-46` | `r.outlet_id`, outlet name `ou` = Y | none: Y's manager sees what Y paid (owner answer 2). Optional extra fields in 7 (T9) |
| restocked qty, `read/inventory.go:326-331` | `r.outlet_id` | none: units landed at Y (stock view) |
| movements refund join, `read/movements.go:125-129` | order + ledger key | none |
| order JSON `refunds`, `read/orders.go:37-49` | order | add `outletId` (3.3) |
| ERP `refundAmountSQL`, `integration/erp/payload.go:390-392` | outbox doc key + order id | none: location comes from the outbox row (Y, `payload.go:400-411`), amount/method from the refund row by doc key; works when the order is at X |
| void refund count, `service/void.go:268` | order | none: a void at X of an order Y refunded is refused as today |
| `order_refunds` business date trigger (`0077:51-60`) | Y's shift date | none (see 8, WIB/WITA note) |

### 4.3 POS live recap (X's tablet while its shift is open)

`apps/pos/src/cashier/recapAggregate.ts` `aggregate()` (L49-) and `keptByMethod()` (L30-47) subtract
`o.refundedAmount` and every `o.refunds` entry, so X's tablet would show its drawer short. Add a helper
`drawerRefunds(o)` = refunds whose `outletId` is absent or equals `o.outletId`; compute the drawer's refunded amount from
it when `o.refunds` is present (fall back to `refundedAmount` only for an older server without the array). An order fully
refunded at Y keeps its whole sale money in X's buckets. Leave Backoffice `reportTotals.ts`/`metrics.ts` alone: they
are sales views at X and should drop. Y's tablet needs no math change: `refundRecap.ts` reads the server's live
`refundsPaidByMethod`; the cross flow refetches the current shift after a 2xx (5.4).

### 4.4 Migration

None. `order_refunds.outlet_id` (NOT NULL FK) already stores the paying outlet; `shift_id` FK; business-date trigger and
UNIQUE `(device_id, client_refund_uuid)` already exist (`0077_order_refunds.sql`). If a later need appears, use 0102+.

## 5. POS tablet

Same-outlet refunds (outbox, A41 local receipts, offline) are unchanged. New code goes in
`apps/pos/src/cashier/crossOutlet/` so `CashierScreen.tsx` (1852 lines) and `OrderHistoryPanel.tsx` (463) grow by
wiring only.

### 5.1 Lookup UI

- `OrderHistoryPanel.tsx`: a two-way switch above the search box, "Outlet ini" / "Outlet lain". "Outlet lain" renders
  `CrossOutletSearch.tsx` instead of the day list. New props: `isOnline`, `onRefundCrossOutlet`.
- `CrossOutletSearch.tsx`: one input, "No. order atau nomor HP". `crossOutletLookup.ts` decides the kind: only digits,
  spaces, `+`, `-`, `(`, `)` = phone, anything else = order number; it sends the explicit param. Offline: input disabled
  with "Butuh internet" (pattern `CheckoutPanel.tsx:249`, `lib/queueGuard.ts:19`). Nothing is cached or written to
  storage (A30, same rule as `orderHistoryQuery.ts:66-70`). GET timeout copy is the A29 default.
- Result card: outlet name badge, date, order number, items with refunded qty, total, status. "Refund di outlet ini"
  button opens the existing `RefundDialog` with the result's `order`; hidden without `process_refund`, without a synced
  open shift, or while offline.

### 5.2 Dialog

`RefundDialog.tsx` gets an optional `crossOutlet?: {outletName}` prop: shows "Penjualan di outlet {X}. Refund dibayar
dari shift outlet ini." and changes the confirm copy to "Kirim refund (butuh internet)". While sending: "Mengirim ke
server, jangan bayar dulu".

### 5.3 Pending attempt store (`crossOutletAttempt.ts`)

One record in `localStorage` (try/catch, like the other per-tablet stores): `{uuid, orderId, body, createdAt}` where
`body` is the exact request body. Written BEFORE the first send; if the write fails, do not send ("Tablet tidak dapat
menyimpan data refund. Coba lagi."). Cleared on 2xx or on a 400/403/409. Kept on timeout, network error, 503, 500.
While a record exists for an order, a new submit for that order re-sends the stored body unchanged (same uuid). If the
cashier's new selection differs from it, show the A29 copy ("Server tidak menjawab tepat waktu. Cek dulu apakah
perubahan sudah tersimpan sebelum mengulang.") plus "Kirim ulang refund sebelumnya" and "Cek transaksi" (re-runs the
lookup by order number so the refunded quantities show); never mint a new uuid silently. A record for another order
blocks a new cross refund until it is resolved (one in flight per tablet).

### 5.4 Submit flow (`useCrossOutletRefund.ts` + pure `crossOutletRefundFlow.ts`)

`CashierScreen.handleRefundConfirm` (L1194): after the existing guards and `planRefundSubmit` (which already enforces
permission, synced shift, reason, items, payout), branch when `refundOrder.outletId !== activeOutletId` into the hook
instead of `engine.enqueue('refund')` (L1229). The hook, inside the same `refundGate` single-flight:

1. Offline (`offlineData.isOnline` false, `hooks/useOfflineData.ts`) = refuse with "Butuh internet. Refund outlet lain
   hanya bisa online." Nothing stored or sent.
2. Build the body from `plan.payload` (+ `clientRefundUuid`, `deviceId`, `shiftId`), persist (5.3), call
   `api.refundCrossOutlet`.
3. 2xx: clear the attempt; 201 toast "Refund {no} berhasil. Bayar {amount} ke pelanggan." (pay-out instruction ONLY
   on a 2xx); 200 `replayed` dialog "Refund ini sudah tersimpan sebelumnya ({amount}). Bayar hanya jika belum dibayar."
   (the cashier may have paid after an earlier 2xx whose attempt record was not cleared);
   refetch the current shift so the recap shows the payout; print the slip from the response's `refund` row and order.
   The slip header is already outlet Y (`receiptOutlet(snapshot)`); add "Transaksi asal: {X}" if the slip builder
   (`refundSlipData.ts`) takes an extra optional line cheaply, else leave it (T9).
4. Timeout/network/5xx/503: keep the attempt, show the A29 "cek dulu" copy, "Kirim ulang" re-sends the stored body.
5. 400/403/409: clear the attempt, show the server message (it already ends with "jangan bayar ulang").

## 6. Tests

### 6.1 New PostgreSQL gate XO

`backend/internal/handlers/cross_outlet_refund_integration_test.go`, `TestCrossOutletRefundPostgres`, `gatePool(t,
"XO", 26486)`; register `("XO", "TestCrossOutletRefundPostgres", 26486, "xo")` in `scripts/ci/postgres_gate.py:50-80`
(port below 32768, unique; `scripts/ci/test_*` checks uniqueness). Fixture pattern: copy the router/issue/nextID setup
of `refund_lines_integration_test.go:96-125` (sales via real `/sync/batch` so line data is real). Two outlets X, Y with
stock rows and ERP codes, open shifts at both, cash sale (2 lines) at X, a split QRIS+cash sale at X, a customer with a
phone. Cases:

1. Pre-check: no `order_refunds` row with `r.outlet_id <> o.outlet_id`.
2. Lookup: by order number and by exact phone at Y returns X's orders with `outletName`, no `customerName`; partial
   phone returns nothing; Y's own sale is excluded; no `process_refund` = 403; admin with no active outlet = 403.
3. Success (Kasir at Y, 1 unit of line 0): 201; `order_refunds` `outlet_id=Y`, `shift_id=Y's`; Y stock +1, X stock
   unchanged; `stock_movements` row `location_id=Y`, `refund_of_movement_id` = sale movement; `erp_outbox` row
   `location_id=Y`, doc key `refund:<id>`; Y stock seq bumped, X not; order `partially_refunded`; `GET /orders/{id}` as
   X shows the refund with `outletId=Y`. ERP: `erp.LoadBuildInput` for that outbox row gives Y's `LocationCode` and the
   refund amount/method.
4. Replay: same uuid + device again = 200 `replayed`, same `refundId`, one row, stock unchanged. Same uuid with
   different items = 200 replay of the original row. Close Y's shift, replay again = still 200: the replay must fail
   neither on the shift check nor on the order lookup (it must find the order at X). Same uuid on another order = 400.
5. Shift: no open shift at Y = 409; `shiftId` of X's shift or a closed Y shift = 409; nothing written.
6. Same outlet (Y's own sale via the cross endpoint) = 409.
7. Coverage: Kasir of Y sending `X-Outlet-Id: X` = 403 (middleware); Manajer covering X+Y with active Y = 201; missing
   `deviceId` or `clientRefundUuid` = 400.
8. Batch refusal: `/sync/batch` refund item from Y's envelope naming X's `orderId`, and one naming X's sale by
   `saleOrderUuid`: item `error`, code conflict, `retryable=false`, nothing written.
9. Clash: after Y refunded line 0 fully, X's queued batch refund of line 0 = conflict `ErrRefundQtyExceeded`, nothing
   written (review item).
10. Shift math: close X's shift = `cash_sales`/`total_sales` equal the sale (Y's refund not subtracted),
    `total_refunds` 0; live `GET /shifts/current` at Y shows `refundsPaidByMethod.cash`; close Y = `cash_refunds_paid` =
    amount. Split sale refunded at Y in cash: X's qris and cash buckets untouched.
11. Reports: `/reports/summary` scope X counts the refund (net drops at X), scope Y does not; `/refund-report` scope Y
    lists it with Y's outlet name, scope X does not; dashboard aggregate scope X counts it (fails before the
    `dashboard.go` fix), scope Y does not.
12. Concurrency: a cross refund at Y and X's batch refund of the last unit in parallel = exactly one applied, the other
    conflict.

Also run existing gates RL, RF, SP, SL, DB, VD, SA unchanged (regression of the shift and dashboard edits).

### 6.2 Go unit tests (no DB)

- `handlers`: request validation table (missing/invalid uuid, deviceId length, empty reason, `items: []`) -> 400 before
  any SQL; error mapper (Busy -> 503 + Retry-After, Conflict -> 409).
- `sync`: a refund payload carrying a stray `saleOutletId` key decodes to an input with empty `SaleOutletID`.
- `service`: `RefundInput.saleOutlet()` fallback.

### 6.3 POS (vitest)

- `crossOutletRefundFlow.test.ts`: offline = refusal without storage write or request; online 201 = attempt cleared,
  pay-out message, slip data from the response row; timeout = attempt kept, message contains "Cek dulu"; retry sends
  the byte-identical body (same uuid); 409 = attempt cleared and server message shown; storage write failure = nothing
  sent; changed selection with a pending attempt = no new uuid.
- `crossOutletLookup.test.ts`: phone vs order-number detection; never writes a cache key.
- `recapAggregate.test.ts`: an order refunded at another outlet (partial and full, single and split tender) leaves X's
  `byMethod`/`totalSales` equal to the unrefunded sale; a same-outlet refund still subtracts.
- Component test for the "Outlet lain" switch: disabled offline with "Butuh internet".

## 7. Ordered tasks (implementer = Sonnet medium; review = Opus high)

Write each task's tests first (red), then the code.

- **T1 backend service** (backend): `refund_input.go` (field, helper, 3 errors), `refund.go` L83/L102/L127 + doc comment,
  new `refund_cross_outlet.go`, service unit test. XO cases 3-6 drafted first (they compile against T3's route; T1 and
  T3 can be one session).
- **T2 backend reads** (backend): new `read/cross_outlet.go` (lookup), `read/orders.go` refund `outletId`.
- **T3 backend HTTP + contract** (backend): new `handlers/cross_outlet_refund.go`, `server/server.go` routes,
  `api/openapi.yaml` (2 operations, 4 schemas, `OrderRefund.outletId`), regenerate `api.gen.go` + `schema.d.ts`,
  `packages/api/src/client.ts` methods, handler unit tests.
- **T4 shift + dashboard** (backend): `service/shift.go` three predicates, `read/dashboard.go` clause removal.
- **T5 gate XO** (backend): finish all 12 cases, `scripts/ci/postgres_gate.py` row; run XO + RL/RF/SP/SL/DB/VD/SA.
- **T6 POS recap** (POS): `recapAggregate.ts` + tests.
- **T7 POS cross flow** (POS): `crossOutlet/` (lookup, attempt store, flow, hook, `CrossOutletSearch.tsx`), wiring in
  `OrderHistoryPanel.tsx`, `RefundDialog.tsx`, `CashierScreen.tsx`; tests; `corepack pnpm quality:ci`.
- **T8 review + release prep**: Opus review of the whole diff (touches refund, stock, outbox-adjacent, generated types,
  payments); HANDOFF entry; PR; five gates on `gate/a18-cross-outlet-returns`.
- **T9 optional, owner may drop**: refund report `saleOutletId`/`saleOutletName` (+ Backoffice column label "Penjualan
  di"), slip line "Transaksi asal", Backoffice order detail "Dikembalikan di {Y}".

Release order: backend first (old tablets never call the new routes; the shift/dashboard edits are no-ops on old data),
then POS OTA. Old tablets on X keep the old recap math until the OTA, so a cross refund before the OTA shows X's live
recap short on X's tablet; the server close snapshot is right. Ship both in one wave.

## 8. Risks and open questions

- **Owner, business-day edge:** the refund's business date is Y's shift date (`0077` trigger). With X in WITA and Y in
  WIB near midnight, X's refund-date reports may bucket it on a different day than the cashier expects. Accept?
- **Owner, refund report at X:** X's manager does not see Y-paid refunds of X's sales in the refund list (only in the
  order detail and in X's net sales). Add T9's sale-outlet columns, or also list them at X?
- **Owner, shift counts:** an order fully refunded at Y drops out of X's shift `total_orders` (status `refunded`) while
  its money stays in X's `total_sales`. Same as a same-outlet full refund of a closed shift's sale today; flagging only.
- **Owner/ERP developer (from the spec, non-blocking):** Y's books carry the refund tender for a sale booked at X.
- **Stock row at Y for a product Y never carried:** the restock upsert (`refund.go:350`) creates Y's stock row, so the
  product appears in Y's stock list and stock pulls. Physically correct; confirm that is wanted.
- **Clash with X's offline refund (accepted by owner):** X may have paid cash; the review item text is the existing
  `ErrRefundQtyExceeded` message. A clearer "sudah direfund di outlet lain" text would need the order's refund outlets
  in `planRefund`; left out.
- **Dashboard index hint removed:** check `EXPLAIN` on gate data; add an index (mig 0102) only if needed.
- **Device id is self-declared** (same as the sync payload). It only scopes the replay key; a wrong value only weakens
  the caller's own replay protection. The order lock + over-refund guard still stop a second payout of the same units.
- **Tablet killed between 2xx and storage clear:** the stored attempt re-sends on the next submit and gets a 200
  replay; the cashier sees the "sudah tersimpan, bayar hanya jika belum" copy, never a plain pay-out prompt.
- **Lookup abuse:** exact phone/number only, 20 rows, process_refund only, standard rate limit; no extra audit log.

## 9. Reviewer decisions on section 8 (Opus, 2026-11-26; owner may override)

- Business-day edge across WIB/WITA: accepted (refund date = the paying shift's day, same rule as A28).
- Refund report at X: **T9 is IN scope, trimmed**: the refund report rows gain `saleOutletId`/`saleOutletName`
  (Backoffice column "Penjualan di"), the refund slip gains "Transaksi asal: {X}". The refund list stays a payout view
  keyed on `r.outlet_id`; X's manager sees the refund in the order detail (refund row `outletId`) and in X's net sales.
  The Backoffice order-detail note is optional (only if cheap).
- Shift `total_orders` drop for an order fully refunded at Y: accepted as flagged (same as today's late refund).
- Stock row created at Y for a product Y never carried: accepted (physically correct).
