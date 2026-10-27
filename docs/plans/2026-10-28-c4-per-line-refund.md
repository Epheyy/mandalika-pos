# C4 per-line refund: implementation plan

Date 2026-10-28 · base `prod-hardening` 4d4e4fd2 · planner: Opus (read-only, plan only, no code changed).
Source rows: UX plan `docs/plans/2026-10-27-pos-ux-direction.md` friction 9 (`:91`), pattern P14 (`:160`), wireframe W4 (`:378-411`), Fase C row C4 (`:512`), D-14 (`:576`).
Every claim about current behaviour cites `path:line` on 4d4e4fd2. Owner decisions are collected in section 3 (D-31 onward).

---

## 0. Read this first: two premises in the brief are wrong

1. **There is no refund PIN today.** D-14 says "refund PIN is A06, already live". It is not live.
   - The POS refund dialog has no PIN step. The refund payload has no approval field (`apps/pos/src/cashier/RefundDialog.tsx:10-17`, `apps/pos/src/cashier/refundView.ts:67-80`).
   - The server checks no PIN or grant for refunds. The sync `refund` case checks only `c.CanRefund` (`backend/internal/sync/sync.go:313-326`), and the direct route checks only `process_refund` (`backend/internal/server/server.go:186-187`).
   - A06 fixed refund *permission* through sync, not a PIN (`AUDIT_REPORT.md:196-208`).
   - The only step-up PIN in the codebase is the A08 transfer-receive grant (`backend/internal/write/receive_approval.go:270-367`, plan `docs/plans/2026-10-20-a08-receive-stepup.md`). The owner made that one online-only (2026-10-17 decision 6).
   - A refund PIN is therefore new work: optional slice C4p, decision D-31/D-32.
2. **The ERP contract assumes refunds are always whole-order.**
   - The handover doc says "+ per baris (seluruh order)" (`docs/integration/2026-10-21-serah-terima-erp-pos.md:47`), and Q16 says "tender `refund` = minus total order (refund selalu seluruh order)" (`:402`).
   - The relay sends `-order.Total` as the refund tender (`backend/internal/integration/erp/payload.go:214-215`).
   - Partial refunds therefore change the ERP contract. The ERP developer must answer section 2.10 before C4b ships.

## 0.1 TL;DR (recommendation)

- **Refunds become rows.** Add `order_refunds` (one row per refund) plus `order_refund_items` (refunded quantity per order line).
  - Migration 0077 backfills one row per already-refunded order.
  - Every money reader (shift close, shift read, reports, inventory summary, backoffice totals, POS recap) switches to these rows **before** any tablet can send a partial refund.
- **The sale stores each line's net share.** At sale time, the server stores on `order_items` the line's net share of the order total (`net_amount`), its position in the sale (`line_no`) and its promo group (`refund_group`).
  - The refund amount is the refunded units' share of `net_amount`. The last refund of an order settles the remainder, so all refunds sum exactly to `orders.total`.
  - A TS twin of the allocator (parity-tested like `promoValidate.ts`) gives the same number for an unsynced local sale.
- **Orders refundable per line:** only orders created after C4a is deployed. Older orders keep whole-order refund (D-33).
  - Bundle and BXGY lines refund as one group (D-34).
  - Loyalty reward lines are independent (D-35).
  - The C3 giveaway bag is never refunded (D-41).
- **Order status:** `completed` → `partially_refunded` → `refunded`.
  - The new status keeps OTA 2.2.0 tablets and the APK builtin bundle from offering a second, whole-order refund: they hide the button for any non-`completed` order (`refundView.ts:51`).
- **Payload:** additive `items[]` + `refundAmount` + `reasonCode` on the existing `refund` outbox type.
  - No new `OutboxType`. `syncedRefunds.ts` is untouched (its format is APK-only, `RUNBOOK.md:146-148`).
  - Partial state is derived from the server Order plus a new unguarded store.
- **Release order:** C4a backend + migration + ERP + backoffice money totals (deploy) → ERP developer confirms → C4b POS OTA → optional C4p PIN → C4c backoffice refund UI.

---

## 1. Current behaviour (whole-order refund, end to end)

### 1.1 POS: gate and dialog
- **Entry points.**
  - Riwayat (server history, `OrderHistoryPanel.tsx:68-70`, cached copy offline `:76-86`): `CashierScreen.tsx:1304`.
  - "Struk di Tablet Ini" (local receipts, A41): `CashierScreen.tsx:1318`. It builds a synthetic `Order` from the archived snapshot (`localReceipts.ts:41-55`). That mapping drops `isReward`/`isBundle` (`:51-53`).
- **Gate.** `refundAvailability` (`refundView.ts:50-59`):
  - hidden unless `status === 'completed'` (`:51`);
  - "Sudah direfund" if any id of the order is in the synced set (`:53-54`);
  - "Butuh izin refund" (`:55`);
  - "Refund tersimpan di tablet" if queued (`:56`);
  - "Buka shift dulu" / "Shift masih tersimpan di tablet" when there is no synced open shift (`:57`).
  - `canRefund` = admin or `process_refund` (`packages/types/src/index.ts:76-79`).
- **Dialog.** It lists every `order.items` row read-only, with its `subtotal` (`RefundDialog.tsx:49-59`).
  - Nothing is selectable.
  - Rp0 reward and bundle lines show as plain rows. A local receipt also lists the C3 giveaway bag at Rp0, because the quote includes it (`CashierScreen.tsx:728`; `giveaway.ts:17-24`).
  - Reason is a required textarea, at most 500 runes (`RefundDialog.tsx:62-74`, `refundView.ts:62-65`).
  - Fixed text "Stok akan dipulihkan oleh kantor pusat saat terkirim." (`RefundDialog.tsx:76-78`). There is no restock choice and no PIN.
- **Payload.** `RefundPayload` (`refundView.ts:67-80`) = `orderId`, optional `saleOrderUuid` (A41), `reason`, plus a display snapshot (`orderNumber`, `total`, `paymentMethod`, `saleShiftId`) that the server never reads (`:73-74`).
  - It is built in `prepareRefund` (`:84-112`) and checked again in `planRefundSubmit` (`:130-143`).
  - It has no items and no amount.

### 1.2 Outbox and sync
- `handleRefundConfirm` (`CashierScreen.tsx:871-906`) runs `engine.enqueue('refund', payload)` (`:896`). The outbox type `refund` is declared at `packages/sync/src/outbox.ts:18-26`.
- The idempotency key is `${deviceId}:${orderUuid}` with a fresh uuid per enqueue (`engine.ts:782-784, 877-886`).
  - So a re-tap or a second tablet is **not** deduplicated by the key. Double payout is prevented by the UI gate and by the server's `status == 'refunded'` check (`refund.go:114-116`).
- A refund that names an unsynced sale waits for that sale: `gateLinkedRefunds` (`engine.ts:1431-1461`), parked as `sale_in_review` (`:1451-1457`).
- **Ack.** On ack (`engine.ts:1594-1599`), the order ids go to `SyncedRefunds.addMany`.
  - `SyncedRefunds` (`packages/sync/src/syncedRefunds.ts:1-60`) persists `{orderId, at}[]` under `mandalika.pos.syncedRefunds` (`:4`), capped at 500 entries / 30 days (`:6-7`).
  - Each entry is a whole-order "done" marker read by the gate (`refundView.ts:54`) and the local badge (`localReceipts.ts:16`).
- **Rejection.** A rejected refund is non-retryable, so it goes to review (`engine.ts:1651`).
  - The tablet shows it under "Perlu ditinjau" with a `refundDetail` line (`useOfflineData.ts:49-66`, `refundView.ts:116-122`).
  - Head office sees it in Tinjauan Sinkron (`apps/backoffice/src/screens/syncReview/reviewLabels.ts:4-42`), with a whole-order summary (`:84-85`).
- No optimistic stock: `pendingStockDeltas` counts `order` rows only (`engine.ts:1017`).

### 1.3 Server
- **Entry.**
  - Sync `refund` case (`sync.go:312-352`): the permission check, with a committed-key replay allowed (`:313-326`), then an ad-hoc parse of `orderId, reason, saleOrderUuid, deviceId` (`:327-332`), then `e.keyed(...)` with operation receipts (A11, `service/receipts.go`, table `0045_operation_receipts.sql`), then `refundSaleID` (A41).
  - Direct route `POST /orders/{id}/refund` takes `{reason}` only (`handlers/orders.go:166-227`, OpenAPI `RefundRequest` `backend/api/openapi.yaml:2089-2093`). It is used by the backoffice "Proses Refund" button (`apps/backoffice/src/screens/Orders.tsx:331-370`).
- **`RefundTx`** (`backend/internal/service/refund.go:56-265`), in the A42 lock order: codes, then customer, then the order row (`:75-111`).
  - It refuses `refunded` and non-`completed` orders (`:114-118`).
  - It sets `orders.status='refunded'` plus `refund_reason, refunded_at, refund_shift_id, refunded_by(_name)` (`:120-127`). `refund_business_date` is set by a trigger (`0059_outlet_timezone_business_date.sql:87-100`).
  - It restores `discount_codes.usage_count` once per applied code (`:128-151`).
  - It restocks the **full quantity** of every `order_items` row (`:152-211`). Lines the sale skipped are excluded, and gone variants are recorded (`InsertRefundUnresolvedVariant`, `:197`).
  - It claws back all of `points_earned` (floor 0, forgiving the remainder) and restores all of `points_redeemed` (`:213-255`).
  - It bumps the stock seq last (`:261`).
  - **No refund amount is stored:** the refund amount is implicitly `orders.total`, and the method is implicitly `orders.payment_method`.
  - Customer `total_spent` / `visit_count`, which the sale increments, are **not** reversed (`service/order.go:~652-658` vs nothing in `refund.go`). This gap predates C4.
  - The C3 giveaway is not an order item and is never restocked (`ledger_hooks.go:180-189`).
- **Ledger.** `recordRefundMovements` (`backend/internal/service/ledger_hooks.go:28-71`) writes one document per refund:
  - document key `refund:<orderId>` (`:48`);
  - one line per order item, with dedupe key `refund:<orderItemId>` (`:61`) and `RefundOfMovementID = MovementID("sale:"+itemId)` (`:62`);
  - Pergerakan bucket Refund via `ledger.BucketOf` (`backend/internal/ledger/bucket.go:69-70`).
  - `stock_movements.dedupe_key` is UNIQUE (`0064_stock_movements.sql:12`). A second document with the same key fails loudly at `ledger.go:334-340`, and a second line with the same dedupe key is skipped silently.
- **ERP.** The same transaction queues an `erp_outbox` row (`ledger/outbox.go:38-43`). The ERP `document_id` = SHA1 of the key and doubles as the ERP Idempotency-Key (`ledger.go:101-106`).
  - Lines use `unit_price = order_items.price` (`payload.go:197-199`).
  - The tender is `-order.Total` (`payload.go:214-215`).
  - The backoffice labels the kind "Retur" (`erpOutboxFormat.ts:27`).
- **Money readers that assume one refund per order equals `orders.total`:**
  - shift close `total_refunds` and `refunds_paid_by_method` (`backend/internal/service/shift.go:187, 203, 226`);
  - live shift read (`backend/internal/read/shifts.go:27`);
  - report summary (`backend/internal/read/reports.go:30, 48`) and refund-day filter (`read/orderfilter.go:77-78`);
  - the legacy inventory summary `refunded` CTE (`read/inventory.go:317-323`);
  - POS shift recap (`apps/pos/src/cashier/ShiftRecapPanel.tsx:58-61`);
  - backoffice report totals (`apps/backoffice/src/screens/reports/reportTotals.ts:38`, `exportSummary.ts:34-45`) and dashboard (`dashboard/metrics.ts:93-153`).

### 1.4 Invariants the audit fixes rely on (must survive C4)
- **A06** (`AUDIT_REPORT.md:196-208`; plan `docs/plans/2026-10-11-p0-slice7-a06-refund.md`):
  - one authority and validation boundary for both transports (permission, reason 1-500 runes, completed-only);
  - a second refund is a second payout, so it is refused as a non-retryable conflict and goes to review (`refund.go:112-116`);
  - every refusal carries the "jangan bayar ulang" warning (`refund_input.go:17`).
  - **C4 replaces "status != refunded" with "cumulative refunded quantity ≤ sold quantity, per line, under the order row lock".**
- **A09** (`AUDIT_REPORT.md:232-244`): accept a genuine captured cash fact into review instead of rejecting it; never let a malformed command create authority.
  - The tender code stores the captured amount and flags a mismatch (`service/tender.go:30-48`, flags in `0046_order_tender_warning.sql`).
  - C4 applies the same rule to the refund amount (section 2.8).
- **A11** (`AUDIT_REPORT.md:256-268`): one operation receipt per key, committed atomically with the effects; a same-key retry returns the original outcome; an altered body under the same key is a `key_conflict`.
  - The refund fingerprint covers the canonical payload, so `items` are covered automatically. Two genuinely different partial refunds have two keys and both apply.
- **A05/A41/A42/A15:** the offline 12 h cap still applies to refunds (`sync.go:235`); refund by sale uuid (`sync.go:85-107`); the global lock order; the stock seq bumped last. All unchanged.

---

## 2. Design

### 2.1 Refund rows (required, not optional)
Every refund fact lives today in single-valued columns on `orders` (section 1.3), so a second refund has nowhere to go. Migration **0077_order_refunds.sql**:

```sql
CREATE TABLE order_refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id),
  outlet_id uuid NOT NULL REFERENCES outlets(id),
  seq smallint NOT NULL,                       -- 1, 2, ... per order (display "Refund 2")
  scope text NOT NULL CHECK (scope IN ('full','partial','legacy_full')),
  amount numeric(14,2) NOT NULL CHECK (amount >= 0),          -- amount of record (2.8)
  computed_amount numeric(14,2) NOT NULL CHECK (computed_amount >= 0),
  amount_warning text NULL,                    -- set when |claimed - computed| > Rp1
  payment_method text NOT NULL,                -- = orders.payment_method (no re-tender in v1)
  reason text NOT NULL, reason_code text NULL,
  shift_id uuid NULL REFERENCES shifts(id) ON DELETE SET NULL,
  refunded_by uuid NULL, refunded_by_name text NULL,
  approval_grant_id uuid NULL,                 -- C4p only
  device_id text NULL, client_refund_uuid uuid NULL,
  ledger_document_key text NOT NULL UNIQUE,
  points_clawed integer NOT NULL DEFAULT 0, points_restored integer NOT NULL DEFAULT 0,
  refunded_at timestamptz NOT NULL DEFAULT now(),
  refund_business_date date NULL,              -- outlet zone, same rule as 0059
  UNIQUE (order_id, seq),
  UNIQUE (device_id, client_refund_uuid)
);
CREATE TABLE order_refund_items (
  refund_id uuid NOT NULL REFERENCES order_refunds(id),
  order_item_id uuid NOT NULL REFERENCES order_items(id),
  quantity integer NOT NULL CHECK (quantity > 0),
  amount numeric(14,2) NOT NULL CHECK (amount >= 0),
  restocked boolean NOT NULL,
  PRIMARY KEY (refund_id, order_item_id)
);
```

Same migration:
- add columns on `order_items`: `line_no smallint NULL`, `net_amount numeric(14,2) NULL`, `refund_group text NULL`;
- extend the `orders.status` CHECK (`0001_init.sql:248`) with `'partially_refunded'`;
- backfill one `order_refunds` row (`scope='legacy_full'`, `amount = computed_amount = orders.total`, `ledger_document_key = 'refund:'||order_id`, `seq = 1`) plus one `order_refund_items` row per order item (full quantity, `restocked` = the line has a refund movement) for every `status='refunded'` order;
- add indexes on `order_refunds(order_id)`, `(shift_id)`, `(outlet_id, refund_business_date)` and `order_refund_items(order_item_id)`.

The `orders.refund_*` columns stay. They are written by the refund that completes the order (scope `full`, or the last partial), so old readers and old clients keep working. New code reads `order_refunds`.

### 2.2 Order status: two options
| | **A (recommended): new `partially_refunded`** | B: stay `completed` until fully refunded |
|---|---|---|
| Money safety with OTA 2.2.0 and the APK builtin | Fail closed: they hide the Refund button for non-`completed` orders (`refundView.ts:51`), so no whole-order refund of a part-refunded order can be started there | Old tablets show the full total and offer "Refund": cashier pays the full amount, server then refuses it (review). Real double-payout window after any rollback or fresh install |
| Per-customer cap (`promo_resolve.go:262-270`, `status='completed'`) | Must count `IN ('completed','partially_refunded')` | Unchanged |
| Gross / sale-side readers | Every `status='completed'` and `IN ('completed','refunded')` filter adds the new value (list in section 4, C4a) | Unchanged on the sale side |
| Backoffice | New badge "Sebagian refund", new filter chip | Needs a derived "refund state" field anyway |

Recommendation A. Readers have to change for the refund side in any case. The extra cost is a grep-able list, while B leaves a live double-payout path. The transitions:
- `completed` → `partially_refunded` when some units are refunded and some remain;
- `completed`/`partially_refunded` → `refunded` when every refundable unit has been refunded;
- `cancelled` is never refundable.

"Refundable unit": every unit of every order line. The giveaway is not an order line.

### 2.3 Line identity
- Server history rows: the Order read gains additive item fields `id` (order_items.id), `lineNo`, `netAmount`, `refundGroup`, `refundedQty` and order fields `refundedAmount` and `refunds[]` (OpenAPI `CartItem`/`Order`, additive optional).
- Local sales (A41, may be unsynced): the line is named by its index in the sale payload `items` (`CashierScreen.tsx:734`).
  - C4a persists that index as `order_items.line_no`. The INSERT at `service/order.go:600-611` already walks `in.Items` in order.
  - The refund payload names lines by `lineNo` only. The server maps `(order_id, line_no)` to the item. A `lineNo` on an order without `line_no` values is Rejected.
- Orders created before C4a have `line_no IS NULL`, so they are whole-order only (D-33). No identity is needed for them.

### 2.4 Discount allocation (what a returned unit is worth)
**Facts.**
- Neither engine allocates discounts to lines.
  - Go `Compute` sums promo discounts at order level (`backend/internal/service/pricing.go:575-638`). `PricingResult` has order totals only (`:347-357`).
  - TS `computePricing` returns order amounts plus `discountParts {label, amount}` (`apps/pos/src/cashier/pricing.ts:69-90, 383-392`).
- Only bundle and BXGY separate-set savings are already per line, because they reprice lines:
  - bundle: `bundleAllocate`, cheapest unit zeroed first (`pricing.go:133-164`; TS `pricing.ts:51-67`);
  - BXGY separate-set: `bxgyRewardNet` (`pricing.ts:185`), server `resolveBundleLines` (`service/rewards.go:205`).
  - Both engines skip these in the discount stack (`pricing.go:497-504, 519-523`; `pricing.ts:251-254, 263-267`).
- `order_items` has no per-line net, reward flag or promo link. Its columns are `price, quantity, subtotal, is_bundle` only (`0001_init.sql:~262-272`; INSERT `order.go:600-611`). Reward fields are request-only (`order.go:62-67`).

**Recommendation: the server allocates at sale time and stores `order_items.net_amount`. The TS twin reproduces it for local sales.**

Algorithm `AllocateNet`. Integer rupiah, deterministic, one implementation in Go (`service/allocate.go`), with a TS twin in `apps/pos/src/cashier/allocate.ts` and shared golden fixtures:
1. Base: `line.subtotal` as priced. This already includes the bundle and BXGY repricing.
2. For each order-level discount component in `discountParts` order (promo, code, tiered, manual), find its eligible lines.
   - A promo or code with `ApplicableProductIDs` uses the matching lines (the same predicate `calcPromotionDiscount` uses).
   - BXGY same-set uses the lines `calcBXGY` counted.
   - Tiered, manual and whole-cart codes use every line with a base > 0.
   - Spread the component's (capped) amount over its eligible lines in proportion to their current base, with the largest-remainder rule; ties go to the lower `line_no`. Then subtract it.
3. Spread `tax + surcharge + rounding − redeemAmount` over all lines in proportion to their post-discount base (largest remainder; a negative total is spread the same way).
4. Invariants: `Σ net_amount = orders.total` exactly, and `net_amount ≥ 0` (a line at 0 stays 0).

**Refund amount for `k` units of a line with `q` sold.**
- `cum(n) = n == q ? net : floor(net × n / q)`.
- The amount for this refund is `cum(prior + k) − cum(prior)`.
- When a refund brings the order to fully refunded, its amount is `orders.total − Σ previous order_refunds.amount (computed)`. This equals the line formula whenever every earlier amount was computed, and absorbs the drift otherwise.

**Source of truth.**
- The server's stored allocation is canonical.
- The POS uses `netAmount` from the Order read for server history rows. For a local sale it uses its own `AllocateNet`, run at sale time and kept in the receipt archive (2.9).
- If the two disagree, the claimed amount is accepted and flagged (2.8).

**Alternatives considered.**
- (a) Recompute the allocation at refund time from stored order data. Rejected: `discount_breakdown` carries no product scope, and promo definitions may have changed since the sale.
- (b) Pro-rata over the whole order with no promo scope. Simple and needs no migration, but wrong for product-scoped promos: returning an undiscounted item would refund less than was paid for it, and a discounted item more. Acceptable only as a fallback if the owner wants per-line refunds on pre-C4a orders (D-33 alternative).
- (c) Refund each unit at its gross unit price. Rejected: it overpays whenever a discount applied.

**Bundle, tiered, BXGY and stacked promos under this rule.**
- Bundle (fixed price, cheapest item GRATIS): the lines already carry the bundle net. Returning part of a bundle is blocked by the group rule (2.5).
- Tiered: the discount is spread over all lines, so each returned unit refunds its discounted share. If the remaining lines fall below the tier, nothing is clawed back (D-36).
- BXGY reward line: it is net-priced, so it carries its own net. The buy and get lines are one group (2.5).
- Stacked combinable promos: each component is spread separately over its own eligible lines (step 2), so stacking needs no special case.

**Migration need.** Yes: `order_items.net_amount` (2.1). There is no backfill; older orders stay whole-order (D-33).

### 2.5 Free lines
| Line | Today | Recommendation |
|---|---|---|
| Bundle lines (paid + GRATIS cheapest) | Plain order items; a whole refund restocks all of them (`refund.go:156-211`) | **One `refund_group`, set at sale from the bundle resolution: the group is refunded whole or not at all.** Returning the paid perfume and keeping the free one is the abuse case. D-34. |
| BXGY buy + get (separate-set reward line, `promo_reward_grants`) | Reward line is a plain item at its net price | Same group rule (buy lines + reward line). The `promo_reward_grants` audit rows are not touched; the reward report counts grants, not refunds (D-34 note). |
| BXGY same-set (discount on a set) | Order-level discount | No group; the allocation spreads it. |
| Loyalty product reward (SP-CRM-9, Rp0 line) | Plain item; the application row is immutable (`refund.go:215-217`) | **Independent**: refundable alone (Rp0, restocked). Paid lines can be refunded without returning it. This matches today's choice not to reverse applications. D-35. |
| C3 giveaway bag | Not an order item, never restocked (`ledger_hooks.go:180-189`); the local dialog lists it at Rp0 | **Never refundable, never listed as selectable.** The dialog shows a note "Tas hadiah tidak ikut direfund". D-41. |

A group's members are written to `order_items.refund_group` at sale time, as `bundle:<promotionId>:<n>` or `bxgy:<promotionId>:<n>` from the server's own resolution (`rewards.go:205`, the BXGY fulfillment path). The TS twin derives the same key for local sales from the cart's `rewardPromotionId` and bundle consumption. If the keys disagree, the server's grouping wins, and a split group is Rejected into review (2.6).

### 2.6 Multiple refunds per order
- **Idempotency.**
  - Each refund is its own outbox item with its own key (`engine.ts:877-886`). Operation receipts make a same-key retry return the same outcome (A11).
  - Defence in depth: `order_refunds UNIQUE (device_id, client_refund_uuid)`. `client_refund_uuid` is the outbox `orderUuid` that `commitOutbox` already adds (`engine.ts:864-868`).
- **Over-refund guard (the double-payout defence now).** Inside the keyed tx, after `SELECT ... FOR UPDATE` on the order (`refund.go:98-102`, which already serializes every refund of an order):
  ```sql
  SELECT oi.id, oi.line_no, oi.quantity, oi.net_amount, oi.refund_group,
         COALESCE((SELECT sum(ri.quantity) FROM order_refund_items ri WHERE ri.order_item_id = oi.id), 0)
    FROM order_items oi WHERE oi.order_id = $1
  ```
  - Each requested quantity must be ≤ `quantity − refunded`. Otherwise Conflict `ErrRefundQtyExceeded`, which goes to review.
  - Groups must be all-or-nothing. Otherwise Rejected `ErrRefundGroupSplit`.
  - Unknown or duplicate `lineNo` → Rejected.
  - Same lock order as today (A42).
- **Ledger and ERP keys** (the collision in 1.3):
  - new refunds use document key `refund:<refundId>` and line dedupe key `refund:<refundId>:<orderItemId>`;
  - `RefundOfMovementID` is unchanged (`sale:<itemId>`);
  - backfilled legacy refunds keep `refund:<orderId>`, and nothing re-records them.
- **Status transitions:** see 2.2. `orders.refund_*` is written only by the refund that completes the order.
- **What the tablet remembers.**
  - `syncedRefunds.ts` keeps its format and meaning, "this order is fully refunded". Its format is APK-only (`RUNBOOK.md:146-148`), and the file is journal-guarded (`ota-journal-guard.sh:28`).
  - The batch ack result gains an additive `refundState: 'partial' | 'full'` (OpenAPI `SyncBatchItemResult`).
  - New engine logic (`engine.ts`, not guarded):
    - `full` → `syncedRefunds.addMany` (as today);
    - `partial` → `partialRefunds.add(orderKey, {lineNo: qty})` in a **new** file `packages/sync/src/partialRefunds.ts`, key `mandalika.pos.partialRefunds`, same bound (500 / 30 days), durable write.
  - It is a convenience cache for the dialog. The server Order read (`refundedQty`) wins whenever it is online.
- **Queue rule (D-44).** While any refund of an order is queued or parked on this tablet, the order stays blocked with "Refund tersimpan di tablet" (`refundView.ts:56`, unchanged). The dialog never has to add up queued partial quantities.
- **Gate text.**
  - "Sudah direfund": fully refunded (synced set, or server `status='refunded'`).
  - New "Sebagian direfund · sisa Rp X": shown as information, with the button **enabled**, for `partially_refunded` orders and for orders in `partialRefunds`.
  - The new bundle shows the button for `completed` and `partially_refunded` orders and hides it for others.

### 2.7 Policy on partial refunds (defaults; owner decides in section 3)
- **Loyalty points** (`refund.go:213-255` today, all or nothing): proportional and cumulative (D-37).
  - `clawTarget = floor(points_earned × Σrefunded_computed / orders.total)`, and the final refund uses `points_earned`. This refund claws `clawTarget − Σpoints_clawed`, still through `write.PointsClawback` (floor 0, forgive the rest).
  - Redeemed points are restored the same way against `points_redeemed`. Redeemed points are already inside `net_amount` (step 3 of 2.4), so cash and points stay consistent.
  - Both amounts are stored per refund (`points_clawed`, `points_restored`).
- **Discount code usage** (`refund.go:128-151`): restored only by the refund that completes the order (D-38).
  - Per-customer cap (`promo_resolve.go:262-270`): counts `status IN ('completed','partially_refunded')`, so a partly returned order still uses its slot.
- **Tiered threshold:** no clawback (D-36). Each returned unit refunds its allocated net share; the remaining lines keep their discount.
- **Tax:** PPN is inside `net_amount` (step 3), so refunds are tax-inclusive. No separate PPN refund line or report (D-48).
- **Customer aggregates** (`total_spent`, `visit_count`) are not reversed by any refund today (1.3). Recommend that C4a subtracts each refund's amount from `total_spent` and leaves `visit_count` alone (D-42).
- **Restock choice:** v1 always restocks (as today, `refund.go:203-209`). The W4 "Stok: Tidak" row is dropped; damaged returns go through Penyesuaian Stok (D-40).
  - Alternative: "Tidak" writes the refund movement plus an automatic Penyesuaian −qty with reason "Rusak (refund)". The ERP keeps a coherent stock and tender, but this interacts with the inventory-controls approval switch. Defer it.

### 2.8 The refund amount is a captured fact
Cash leaves the drawer before the server sees the refund (offline queue). Following A09 (`service/tender.go:30-48`), the server never rejects a refund for its amount:
- The payload carries `refundAmount`, the number the tablet showed and paid out. The server computes `computed_amount` (2.4).
- `amount` (the amount of record, used by shift, reports, ERP tender and points share) = `refundAmount` when present, otherwise `computed_amount`. Old payloads have no `refundAmount`, so their amount = `orders.total`, as today.
- If `|refundAmount − computed_amount| > Rp1`, set `amount_warning`, record the claimed value, and show it in the backoffice. The refund still commits.
- If `refundAmount` would make `Σ amount > orders.total + Rp1`, the refund still commits (the money is gone), flagged `over_total`. The backoffice lists these for follow-up (D-39).
- Quantities are the authority for stock. The amount never changes stock.

### 2.9 Back-compat and rollback
- **Server accepts both payload shapes (C4a).**
  - **No `items` (OTA ≤ 2.2.0, APK builtin, the backoffice direct route):** a whole-order refund, exactly as today, **only** on a `completed` order with no refund rows. Every unit is refunded, amount = `orders.total`, and the refund writes an `order_refunds` row (`scope='full'`).
  - On a `partially_refunded` order it is a Conflict, `ErrRefundPartialNeedsNewApp`: "Sebagian transaksi ini sudah direfund dari tablet lain. Perbarui aplikasi lalu refund sisa barang." + `refundWarning`. It goes to review. It must **never** mean "refund the remainder": the old dialog showed the full total, and that may already be paid out.
  - On a `refunded` order the response is `ErrAlreadyRefunded`, as today.
  - **With `items`:** the per-line path. It requires `line_no` on the order; otherwise Rejected "Transaksi lama hanya bisa direfund seluruhnya".
- **Release order (RUNBOOK rule 3, `RUNBOOK.md:155-158`, new payload key):** the server ships first. The C4b bundle must not reach any tablet before C4a is at 100% on Cloud Run.
- **Bundle rollback (C4b → 2.2.0) with an item-level refund still in the outbox.**
  - The old bundle resends `payload` verbatim (`type`, `idempotencyKey`, `payload`, `envelope`, `RUNBOOK.md:151-154`), so the server still sees `items` and applies the partial refund correctly.
  - The old ack handler then puts the order into `syncedRefunds` (`engine.ts:1594-1599`), so that tablet shows "Sudah direfund" for a part-refunded order. This is conservative (no second payout from that tablet). **Accepted.** The remainder can be refunded from another tablet or the backoffice.
  - The old views tolerate the item: `refundDetail` reads only the snapshot keys (`refundView.ts:116-122`), and the recap reads the payload `total` snapshot (`refundRecap.ts:15-16, 52-56`).
  - **C4b must set the display snapshot `total` = the partial `refundAmount`,** so a rolled-back recap shows the partial amount and not the order total.
- **Journal guard.**
  - Stay out of `outbox.ts` (no new `OutboxType`), `outboxStore.ts`, `storage.ts`, `syncedRefunds.ts` and `journal*.ts`. The payload change lives in `refundView.ts`, `RefundDialog.tsx`, `CashierScreen.tsx`, `engine.ts` (ack branch), the new `partialRefunds.ts` and `receiptArchive.ts`, none of which is guarded.
  - Recommend adding `packages/sync/src/partialRefunds.ts` to `OTA_JOURNAL_PATHSPECS` in C4b, so its format is protected from then on. The first OTA after that needs one `OTA_JOURNAL_CHANGE_ACK=1`, with the reason "new file, additive".
- **Local-sale net amounts.**
  - Do **not** bump the receipt snapshot to v3: that repeats C1's "pre-C1 bundle fails closed" rollback cost.
  - Add an optional sibling field `lineNets?: number[]` (and `lineGroups?: (string|null)[]`) to `ReceiptEntry` (`packages/sync/src/receiptArchive.ts:15-31`). It is filled from additive sale payload keys `items[i].netAmount` / `items[i].refundGroup`, which the server ignores for pricing and may compare in its logs.
  - Older bundles ignore the fields.
  - Local sales archived before C4b have no `lineNets`. Their refund dialog offers whole-order only, and if the sale has synced it falls back to the server Order read.

### 2.10 ERP mapping
- **One refund row = one stock document**, `kind: "refund"`:
  - document key `refund:<refundId>` (legacy `refund:<orderId>` for backfilled rows);
  - `ref` unchanged (`order`, order id, order number);
  - one line per refunded order item with `qty` = refunded quantity, `unit_price` = `order_items.price` (gross, unchanged), and `refund_of_movement_id` = that sale line's movement;
  - `tenders = [{method, amount: -order_refunds.amount}]` on part 1. The relay looks the refund row up by `ledger_document_key`, replacing `-order.Total` at `payload.go:214-215`.
- **Questions for the ERP developer (send before C4b; C4a is safe either way because no partial refunds exist yet):**
  - E-1: Does the ERP accept several `refund` documents with the same `ref.id` (order)? Today it never sees two.
  - E-2: Does it accept a refund tender that is not equal to Σ(`unit_price` × `qty`), because the tender is net of discounts? Or does it want the net unit price (`net_amount / quantity`) on refund lines?
  - E-3: Does it check cumulative refunded qty ≤ sold qty per `refund_of_movement_id`? If it does, the order of arrival matters (Q12, refund before sale, `serah-terima:398`).
  - E-4: Is a refund document with zero lines and a tender acceptable? This is only needed if D-40 later allows "Tidak dikembalikan ke stok".
  - E-5: The contract text needs updating: "refund selalu seluruh order" (`:47`, Q16 `:402`) becomes "satu dokumen per refund; bisa sebagian". Update `docs/integration/stock-documents.v1.yaml` (refund lines `:53, :331-334`) to match.

### 2.11 Backoffice
- **Money totals (mandatory, part of C4a).** Every reader in 1.3 switches its refund side to `order_refunds.amount` by `order_refunds.refund_business_date`, `shift_id` and `payment_method`. The gross side adds `partially_refunded`.
  - Client totals that sum `o.total` for refunded rows (`reportTotals.ts`, `exportSummary.ts`, `metrics.ts`, POS `ShiftRecapPanel.tsx:58-61` / `refundRecap.ts`) switch to the new `refundedAmount` field. They fall back to `total` when it is absent, so the backoffice can deploy before the backend.
- **Refund report (C4c).**
  - The Ekspor "Export Refund CSV" (`ExportTab.tsx:112-116`) gets one row per refund (No. struk, Refund ke-, Waktu, Hari refund, Item, Qty, Jumlah, Metode, Shift, Oleh, Alasan, Peringatan jumlah).
  - Optional: a "Refund" tab in Laporan.
  - The order detail (`Orders.tsx:316-330`) lists every refund, with the "Sebagian refund" badge (`:33-36`) and filter (`:172-178`).
  - The admin "Proses Refund" (`Orders.tsx:331-370`) gains line selection (D-47).
- **Pergerakan Refund bucket:** no change. It sums `kind=refund` ledger rows (`read/movements_buckets.go:30-70`), which now carry refunded quantities.
  - The legacy summary `refunded` CTE (`read/inventory.go:317-323`) switches to `order_refund_items` in C4a.
- **Kartu Stok:** refund rows already show Jenis "Refund" and link to the order (`StockCard.tsx:352-357`).
  - C4c adds "Refund ke-N" to the document cell, and the refund reason to "Alasan", which is empty for refunds today (`StockCard.tsx:122`).
- **Tinjauan Sinkron:** the new server refusals reuse the existing codes `conflict` / `rejected` (`reviewLabels.ts:4-13`), so no new code is needed:
  - `ErrRefundQtyExceeded`, `ErrRefundPartialNeedsNewApp`, `ErrRefundGroupSplit`, `ErrRefundLegacyWholeOnly`, `ErrRefundLineUnknown`;
  - all carry `refundWarning`;
  - the payload summary (`reviewLabels.ts:84-85`) gains the item list (`items[].name × qty`) and the claimed amount.

### 2.12 UX: W4 becomes item-level
W4 (`pos-ux-direction.md:378-411`) changes as follows:
```
┌───────────────────────────────────────────────┐
│ ‹ Kembali        Refund #BSD-00398 · kemarin   │
│ Dibayar Tunai Rp 1.251.000 · Sebagian direfund │  (state chip)
│ [Pilih semua]                                  │
│ ☑ Rehearsal Alpha 50 ml    [−] 1 [+] / 1  Rp 350.000 │ 56 dp rows, stepper max = sold − refunded
│ ☐ Rehearsal Bravo 110 ml   [−] 0 [+] / 2         Rp 0 │
│ ┌ Paket Duo (refund bersama) ───────────────┐ │ group = one checkbox, no stepper
│ │ ☐ Bravo 50 ml · GRATIS Delta 30 ml        │ │
│ └───────────────────────────────────────────┘ │
│ ✓ 1 sudah direfund (Charlie 30 ml)  (greyed)  │
│ Tas hadiah tidak ikut direfund                │
│ Alasan (Rusak)(Salah varian)(Berubah pikiran)(Tidak cocok)(Lainnya…) │ 44 dp chips; Lainnya opens text
│ Dikembalikan ke pelanggan   Rp 350.000 (Tunai) │ live, from net amounts
│ 🔒 PIN penyetuju (only if D-31 = yes; online) │
│ ┏ REFUND Rp 350.000 ┓ (disabled until ≥1 unit + reason) │
└───────────────────────────────────────────────┘
```
- Lines show the **net** amount per unit, not the gross subtotal. A row with a discount shows the gross price struck through.
- Orders created before C4a, and local receipts without `lineNets`, show every line locked ☑ with the note "Transaksi lama: refund seluruhnya".
- Gate reasons appear as the full-width amber line W4 already specifies. "Sebagian direfund · sisa Rp X" is an info chip, not a block.
- The success toast reads "Refund Rp X tersimpan — stok dipulihkan saat terkirim".
- `reasonCode` goes into the payload. `reason` is the chip label, or the free text for Lainnya, and is still required with at most 500 runes. The server rule is unchanged (`refund_input.go:59-73`).

### 2.13 Refund PIN (optional slice C4p, only if D-31 = yes)
This reuses the A08 machinery, generalized:
- grant table (or a new `refund_approvals` table): fingerprint = sha256(order id, sorted `lineNo:qty`, `refundAmount`, reason code), bound to the requester, outlet and refund key; TTL 12 h; consumed once inside the refund tx;
- the same Postgres lockout tables and policy (`receive_approval.go:98-125`);
- approver roles: new setting `refund_approver_roles`, admins always (D-32);
- `POST /api/v1/sync/refund-approvals` (own rate bucket);
- POS modal reuses `PinStepUpModal`, online-only: offline it shows "Refund butuh internet untuk PIN penyetuju", and no outbox item is created;
- a refund item without a valid grant gets Forbidden and goes to review, while a committed key still replays ok (same rule as `sync.go:313-326`);
- the backoffice admin refund needs no PIN (the admin is the approver).

Consequence to state plainly: with a PIN, **no refund can be made offline**. Today refunds work offline.

---

## 3. D-register (owner decisions, continues the UX plan's D-1..D-30)

**Owner decisions, 2026-10-28:** D-31 = **no PIN** (keep `process_refund` permission only, as today; refunds stay offline-capable; slice C4p is dropped). D-32 is moot. **D-33 to D-48 = the recommended defaults below.** **D-49 (2026-10-28):** the refund amount of record is capped at what the order still has left to refund (`orders.total` minus earlier refunds); the tablet's claimed amount and the `amount_mismatch`/`over_total` flags stay as information; built in C4c before the C4b OTA. The ERP questions E-1..E-5 (section 2.10) are still open and gate the C4b OTA, not C4a.

| ID | Question | Recommended default |
|---|---|---|
| D-31 | Refund PIN (D-14 assumed it exists; it does not). Require an online approver PIN for every refund, only above an amount, or none? | **PIN for every refund, online step-up (A08 pattern); offline refunds blocked** ("Refund butuh internet"). Build as slice C4p. Alternative: no PIN, keep `process_refund` permission only (today's behaviour, offline-capable). |
| D-32 | Who can approve a refund PIN? | Admins + roles in a new setting `refund_approver_roles` (default empty), same outlet rule as A08 |
| D-33 | Orders created before the C4a deploy (no stored line net): per-line or whole-order only? | **Whole-order only** (they age out; no guesswork on scoped promos). Alternative: pro-rata fallback (2.4 b). |
| D-34 | Bundle and BXGY (buy + get) lines: must be refunded together? | **Yes, all-or-nothing per promo group** |
| D-35 | Loyalty reward line (Rp0, SP-CRM-9): refundable alone; may paid lines be returned while the customer keeps the reward? | **Yes / yes** (applications stay immutable, as today) |
| D-36 | A returned unit refunds its allocated net (discounts, tax, surcharge, rounding, redeemed points spread over lines); no clawback when remaining lines no longer meet a tier or promo threshold | **Yes, no clawback** |
| D-37 | Points on partial refund | **Proportional to the refunded share, cumulative rounding, final refund settles exactly** (earned clawed, redeemed restored) |
| D-38 | Discount code usage and per-customer cap slot on partial refund | **Restored only when the whole order is refunded**; a partly refunded order still counts for the cap |
| D-39 | Refund amount of record when the tablet's amount differs from the server's | **The amount paid out at the till; flag differences > Rp1 (and Σ > total) for head office, never reject** |
| D-40 | "Stok: Kembalikan / Tidak" choice in W4 | **v1 always restocks; damaged goods via Penyesuaian Stok**; per-line "Tidak" later (needs E-4 and the approval switch) |
| D-41 | C3 giveaway bag on refund | **Never refunded or restocked; not selectable; note shown** |
| D-42 | Customer `total_spent` / `visit_count` are never reversed on refund today | **C4a subtracts the refund's COMPUTED amount from `total_spent` (implementation note 2026-10-28: not the claimed amount of record, so a bad tablet claim flagged `over_total` cannot erase other orders' spend or the tier; Σ computed = the order total, so a full refund restores the pre-order value). Trade-off: an under-claim leaves the customer with a little less net spend than cash kept. Owner may switch to the amount of record.** `visit_count` unchanged |
| D-43 | Reason presets | **Rusak/cacat · Salah varian · Berubah pikiran · Tidak cocok/alergi · Lainnya (teks)** |
| D-44 | Several partial refunds per order | **Allowed up to the sold quantity; while one is queued on this tablet the order is blocked until it is sent** |
| D-45 | New order state shown in the backoffice | **"Sebagian refund" badge + filter; reports count it as a sale with refunds on their own days** |
| D-46 | Refund time window (none today) | **Keep none** (owner may set, e.g., 30 days, later) |
| D-47 | Backoffice admin per-line refund | **Yes, C4c** (until then the backoffice refunds whole orders with no prior refund) |
| D-48 | Tax in refunds | **Refunds are tax-inclusive (PPN inside the net); no separate PPN refund line** |

---

## 4. Slices

Model routing (memory `model-routing-policy`, `AGENTS.md`): Opus plans and reviews anything touching sync, stock and payments; Sonnet implements; Haiku does chores and spec checks. Each slice runs in its own session, worktree and PR, and pushes to `origin` and `ci` (the mirror supplies CI evidence until origin billing unlocks).

### C4a: backend + migration + ERP + money readers (deploy before any OTA)
**Implement: Sonnet, high effort. Review: Opus, high** (money, stock, sync, migration). The owner may ask for the guardian on the migration.
- **Files**
  - migration `backend/internal/db/migrations/0077_order_refunds.sql` (2.1, backfill, CHECK, indexes);
  - `service/allocate.go` (new, `AllocateNet`) called from `createOrderCore` (writes `line_no`, `net_amount`, `refund_group`; INSERT `service/order.go:600-611`);
  - `service/refund_input.go` (items, amount, reasonCode, new errors);
  - `service/refund.go` → a new `RefundLinesTx` used by both shapes; the old `RefundTx` becomes "all items" through it (update the D11 comment at `refund.go:42-45`);
  - `service/ledger_hooks.go` `recordRefundMovements` (per-refund keys, refunded qty);
  - `ledger/ledger_guard_test.go:163-167` `ledgerHookFiles` gets any new stock-writing file;
  - `sync/sync.go:327-352` (payload, `refundState` in the result);
  - `handlers/orders.go` direct route (legacy shape only);
  - `service/shift.go:176-232`, `read/shifts.go:18-27`, `read/reports.go`, `read/orderfilter.go`, `read/inventory.go:317-323`, `read/orders.go` (items `id/lineNo/netAmount/refundGroup/refundedQty`, `refundedAmount`, `refunds[]`), `handlers/order_filter.go:13`, `service/promo_resolve.go:262-270`;
  - customer `total_spent` (D-42);
  - `integration/erp/payload.go:207-218` (tender from the refund row);
  - OpenAPI (`Order`, `CartItem`, `SyncBatchItemResult.refundState`, a typed `SyncRefundPayload` documented under `SyncBatchItem`) + codegen;
  - backoffice money totals `reportTotals.ts`, `exportSummary.ts`, `dashboard/metrics.ts`, `Orders.tsx` badge/filter (read `refundedAmount ?? total`);
  - ERP docs `docs/integration/*` (E-5 text).
- **Tests**
  - Go unit: `AllocateNet` table tests (bundle, tiered, BXGY same/separate set, stacked codes, manual %, rounding on, redeem, zero lines; Σ = total, ≥ 0); `cum()` remainder; error mapping.
  - Golden fixture file `backend/internal/service/testdata/allocate_golden.json`, shared with C4b.
  - New Postgres gate **RF** (next port 56476) in `scripts/ci/postgres_gate.py`:
    - two partial refunds then a full one: Σ amount = total, status transitions, points cumulative;
    - concurrent partial refunds of the same line from two keys: exactly one passes the qty guard;
    - legacy payload on a `partially_refunded` order → conflict;
    - same-key replay → same outcome; altered body → key_conflict;
    - ledger keys distinct, ERP outbox one row per refund;
    - the backfill keeps report/shift totals identical (snapshot before = after on fixture data);
    - shift close with a partial refund of another shift's sale.
  - Keep green: `refund_parity_integration_test.go`, `stock_ledger_refund_integration_test.go`, `report_refund_date_integration_test.go`, `offline_return_integration_test.go`, `report_summary_integration_test.go`, `erp_e2e_integration_test.go`, `giveaway_integration_test.go`.
  - Any new top-level test in `internal/api` or `internal/codegen` is listed in `scripts/ci/codegen_gate.py` (memory `codegen-gate-exact-test-set`).
  - Backoffice vitest for the totals fallback.
- **OTA journal guard:** not touched (backend + backoffice only).
- **Release:** merge → `scripts/deploy-backend.sh <tag>` → smoke → promote 100%. The backoffice deploys on push (Cloudflare); its fallback makes the order safe. Regenerate `pnpm-lock.yaml` only if a `package.json` changes (memory `cloudflare-frozen-lockfile-gotcha`).
- **Rollback:**
  - Cloud Run back to the previous revision. Migration 0077 is additive. An old binary ignores the new tables but would not write `order_refunds` rows for refunds made during the rollback.
  - The runbook therefore adds a re-sync query for refunded orders with no refund row.
  - **Do not roll back after any partial refund exists:** the old binary would treat a `partially_refunded` order as not refundable (correct) but would also compute shifts and reports without the partial amounts.
  - Gate C4b on "C4a stable for 24 h".

### C4b: POS + sync payload (OTA, after C4a is at 100% and the ERP answers E-1..E-3)
**Implement: Sonnet, medium-high. Review: Opus, high** (sync engine, outbox payload, money shown to the cashier).
- **Files**
  - `apps/pos/src/cashier/allocate.ts` (TS twin, reads the golden fixtures);
  - `refundView.ts` (payload `items`, `refundAmount`, `reasonCode`, snapshot `total` = refund amount, gate text);
  - `RefundDialog.tsx` → item-level W4 (likely split into `RefundLineList.tsx` + `refundSelection.ts` pure reducer);
  - `RefundAction.tsx`;
  - `CashierScreen.tsx:871-906` (sale payload `items[i].netAmount/refundGroup`, enqueue);
  - `localReceipts.ts:41-55` (keep `isReward/isBundle`, `lineNets`, drop the giveaway from the selectable list);
  - `packages/sync/src/receiptArchive.ts` (`lineNets`, `lineGroups`);
  - `packages/sync/src/engine.ts:1594-1599` (ack branch on `refundState`);
  - new `packages/sync/src/partialRefunds.ts`;
  - `scripts/lib/ota-journal-guard.sh` (add the new file);
  - `refundRecap.ts` / `ShiftRecapPanel.tsx` (partial amounts).
- **Tests**
  - POS vitest: allocator parity on the golden file; selection reducer (stepper bounds, group all-or-nothing, legacy lock, giveaway excluded); amount = Σ cum differences; gate matrix (completed / partially_refunded / refunded / queued / synced partial); payload snapshot.
  - Sync vitest: ack `partial` vs `full`; `partialRefunds` bound/TTL/durable failure keeps the acked row; rollback simulation (old ack handler on an item with `items`).
  - Browser scenario **POS-REFUND-PER-LINE** (refund 1 of 3 lines from Riwayat, then the rest, badges and recap) and **POS-REFUND-LOCAL-PARTIAL** (local receipt, offline queue, ack).
  - `browser:ci` green, including the existing S0A/S0B.
- **OTA journal guard:** one ACK for the new guarded file. No guarded file is otherwise changed. The release note says why.
- **Release:** OTA (web layer). No APK is needed.
- **Rollback:** a previous bundle is safe (2.9). Rolled-back tablets hide refunds for part-refunded orders and may mark them "Sudah direfund" after acking a queued partial.

### C4p: refund PIN (DROPPED: owner chose D-31 = no PIN on 2026-10-28; kept for reference)
**Implement: Sonnet, high. Review: Opus, high** (auth, lockout).
- **Files:** a grant table migration (0078) or a generalized `approval_grants`; `write/refund_approval.go` (mirrors `receive_approval.go`); a `/sync/refund-approvals` handler with its own rate bucket; redemption inside `RefundLinesTx`; POS `PinStepUpModal` reuse; the `refund_approver_roles` setting UI.
- **Tests:** lockout table tests; a Postgres gate (port 56477) covering grant fingerprint mismatch, expiry, single use, and replay after the grant expires; the browser offline-block message.
- **Release:** backend deploy, then the OTA that sends `approvalGrantId`.
- **Rollback:** additive. An old bundle sends no grant, so its refunds go to review (Forbidden) while the PIN is enforced. Ship the enforcement switch as an app setting, default off until the OTA is everywhere.

### C4c: backoffice refund UI (after C4a; independent of C4b)
**Implement: Sonnet, medium. Review: Opus, medium** (money display, no writes except the admin route). Spec check: Haiku.
- **Files:** `Orders.tsx` (refund list, admin line selection via the direct route gaining `items`), `ExportTab.tsx` (per-refund CSV), `reviewLabels.ts` (item list), `StockCard.tsx` ("Refund ke-N", reason), optional Laporan "Refund" tab.
- **Tests:** vitest for the formatters; a browser scenario for the backoffice refund list.
- **Rollback:** Cloudflare redeploy of the previous commit.

**Release order:** C4a deploy → (24 h, ERP E-1..E-3 answered) → C4p if chosen → C4b OTA → C4c any time after C4a.

---

## 5. Risks (ranked) and read-only checks on the Neon test DB

1. **A money reader keeps summing `orders.total`, so partial refunds are double-counted or missing** (shift close, reports, POS recap, backoffice totals). Mitigation: the C4a reader list in section 4, a gate fixture that compares totals before and after the backfill, and an invariant query: `Σ order_refunds.amount ≤ orders.total + 1` per order, except rows flagged `over_total`.
2. **An old bundle or the APK builtin starts a whole-order refund on a part-refunded order.** Mitigated by the `partially_refunded` status (button hidden) plus a server Conflict with the "jangan bayar ulang" warning. Remaining risk: an old bundle queued the refund offline *before* another tablet's partial refund. It goes to review.
3. **Ledger or ERP key collision** (`refund:<orderId>` reused): the second refund's transaction fails (`ledger.go:334-340`), loops as a retryable 500 and gets stuck. Mitigated by per-refund keys plus a gate test.
4. **The ERP rejects the second document or the partial tender**, so relay rows go dead. Mitigated: ask E-1..E-3 before C4b. C4a alone produces only full refunds.
5. **The TS and Go allocators drift**, causing mismatch flags on local-sale refunds. Mitigated by shared golden fixtures run by both test suites. Flags never block.
6. **Concurrent partial refunds from two tablets.** Serialized by the order `FOR UPDATE`, plus the cumulative qty guard and a concurrent gate test.
7. **Backfill migration on Neon:** the size is the number of refunded orders (check first). It runs inside one transaction and takes no long locks on `orders` beyond the CHECK change.
8. **PIN expectation mismatch** (D-14 vs reality). An owner decision before C4b. A PIN makes refunds online-only.
9. **Points rounding drift across many partials.** The cumulative-target formula, with the final refund settling exactly, plus a test.
10. **Rollback after partial refunds exist.** The old binary misreports shifts. Mitigated by the 24 h soak and the runbook rule "no backend rollback below C4a once any `scope='partial'` row exists"; fix forward instead.

**Read-only queries to run on the Neon test DB before the C4a deploy** (memory `neon-e2e-verification`; secrets from Secret Manager, never pasted):
```sql
-- backfill size and shape
SELECT count(*) AS refunded_orders, count(*) FILTER (WHERE refund_business_date IS NULL) AS no_refund_day,
       count(*) FILTER (WHERE refund_shift_id IS NULL) AS no_refund_shift
  FROM orders WHERE status = 'refunded';
SELECT count(*) FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.status = 'refunded';
-- lines that the CHECK (quantity > 0) on order_refund_items would reject
SELECT count(*) FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.status = 'refunded' AND oi.quantity <= 0;
-- largest order (line_no smallint headroom) and legacy negative lines overall
SELECT max(c) FROM (SELECT count(*) c FROM order_items GROUP BY order_id) x;
SELECT count(*) FROM order_items WHERE quantity <= 0;
-- existing refund ledger docs and ERP rows keep their legacy key
SELECT count(DISTINCT document_id) FROM stock_movements WHERE kind = 'refund';
SELECT status, count(*) FROM erp_outbox WHERE kind = 'refund' GROUP BY 1;
-- refunded orders with restocked lines but no ledger movement (backfill 'restocked' flag source)
SELECT count(*) FROM order_items oi JOIN orders o ON o.id = oi.order_id
 WHERE o.status = 'refunded'
   AND NOT EXISTS (SELECT 1 FROM stock_movements m WHERE m.dedupe_key = 'refund:' || oi.id);
-- how often per-line would be limited by groups/promos (sizing D-34/D-36)
SELECT count(*) FILTER (WHERE discount_amount > 0) AS with_discount,
       count(*) FILTER (WHERE jsonb_array_length(COALESCE(applied_discount_codes,'[]')) > 0) AS with_codes,
       count(*) AS all_orders
  FROM orders WHERE created_at > now() - interval '30 days';
-- shift and report snapshot to compare after the deploy (expect identical)
SELECT id, total_refunds, cash_refunds_paid, refunds_paid_by_method FROM shifts ORDER BY opened_at DESC LIMIT 20;
```
After the deploy, run the same shift and report reads plus the invariant query from risk 1. Write smokes (a partial refund on a throwaway order) need their own go-ahead (memory `neon-e2e-verification`: write tests are per-request).
