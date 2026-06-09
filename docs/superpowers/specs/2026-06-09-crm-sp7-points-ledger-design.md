# SP-CRM-7 — Points Ledger + Manual Adjustment + Refund Reversal (Design)

**Date:** 2026-06-09
**Branch:** `prod-hardening`
**Module:** Customers → CRM, 7th slice (SP-CRM-7) — the riskiest (touches the order/earning path)
**Migration slot:** 0031 (next free)
**Backend baseline:** Cloud Run rev `00054-vql` (migrations →0030)
**Delivery:** backend + backoffice only — **no POS, no APK** (POS keeps reading the cached balance)

---

## 1. Goal & scope

Give the loyalty `points` balance a real audit trail and an admin correction tool, and
fix a latent correctness bug:

1. **Points ledger** — an append-only `point_transactions` log recording every change to a
   customer's balance (earn, redeem, manual adjust, refund reversal), each stamping the
   running `balance_after`.
2. **Manual adjustment** — backoffice admins add/subtract points with a required reason
   (gift, correction, complaint comp), gated on `manage_settings`.
3. **Refund reversal** — refunding an order now reverses its points (claw back earned,
   restore redeemed) instead of leaving the balance wrong.

### Explicitly OUT of scope (deferred to SP-CRM-8)

The **loyalty-conditions trigger engine** (evaluating the configured rules so an order earns
*variable/bonus* points — birthday double, member-day, product rewards, spend thresholds).
That engine is entirely unwired today and changes the earning *amount*, which is upstream of
the ledger. SP-CRM-7 records whatever the **current flat formula** produces
(`floor(total/1000) × pointsPerThousand`); SP-CRM-8 will later make that amount variable and
write the same ledger. Decomposition confirmed with user.

### Decisions locked (with user)

- **`customers.points` stays the cached authoritative balance** — the POS reads it for
  redemption (`FOR UPDATE`); summing a ledger over 50k–500k customers per read is infeasible.
  The ledger is the audit/history spine; every ledger write updates the cached balance in the
  **same transaction**.
- **Ledger-forward-only** — no per-customer backfill of historical balances. The ledger records
  every change *from deploy onward*, each with `balance_after`. The pre-existing balance is an
  implicit opening; the ledger explains all future changes, not the historical origin.
- **Floor at 0 — balance never goes negative.** A manual subtraction larger than the balance is
  **rejected**; a refund clawback that would exceed the balance claws back only down to 0 (the
  over-spent remainder is forgiven and noted in the entry).
- **Permissions:** manual adjust = `manage_settings` (admin-level; it mints value). Ledger
  **view** = `manage_customers` (consistent with the rest of the CRM module).
- Refund produces **two** ledger entries (clawback + restore), not one net — clearer audit.
- Earn/redeem entries carry the order's **cashier name** as `created_by_name` (audit nicety);
  `order_id` is the authoritative link.

### Module-wide invariants honored

- Backoffice now / POS later — ledger data is additive and stays **off** the shared
  `customerObj` (lean-sync). The cached `points` is already on `customerObj` (unchanged).
- Customer detail = full-page in-screen view swap (no router). OFFSET pagination.

---

## 2. Data model — migration 0031

### 2.1 `point_transactions` (append-only)

| column            | type        | notes                                                          |
|-------------------|-------------|----------------------------------------------------------------|
| `id`              | uuid PK     | `gen_random_uuid()`                                            |
| `customer_id`     | uuid NOT NULL | FK→`customers(id)` **ON DELETE CASCADE**                      |
| `type`            | text NOT NULL | CHECK in (`earn`,`redeem`,`adjust`,`refund`)                  |
| `points`          | integer NOT NULL | **signed** delta: +earn, −redeem, ± adjust/refund          |
| `balance_after`   | integer NOT NULL | the customer's cached balance immediately after this entry |
| `reason`          | text        | required for `adjust`; system-generated for earn/redeem/refund |
| `order_id`        | uuid NULL   | FK→`orders(id)` **ON DELETE SET NULL** (earn/redeem/refund link)|
| `created_by`      | uuid NULL   | FK→`users(id)` **ON DELETE SET NULL**                          |
| `created_by_name` | text NULL   | snapshot of the actor (admin for adjust; cashier for earn/redeem)|
| `created_at`      | timestamptz NOT NULL | `now()`                                               |

Index `idx_point_transactions_customer (customer_id, created_at DESC, id DESC)` — serves the
paginated newest-first history with a stable tiebreaker (avoids the OFFSET ghost/skip rows that
bit SP-CRM-1).

### 2.2 `orders` column

`ALTER TABLE orders ADD COLUMN points_earned integer NOT NULL DEFAULT 0;`
Recorded per-order from deploy onward so refund can claw back the exact earned amount.
Pre-existing orders keep `0` → no clawback for them (redeemed is still restorable from the
existing `points_redeemed` column).

### 2.3 `customers.points`

**Unchanged.** Remains the cached authoritative balance; already emitted on `customerObj`
(POS reads it). Every ledger write updates it in the same tx.

---

## 3. Earning path — `service/order.go` `CreateOrder` (the high-risk change)

Today (≈`order.go:250-256`), when `CustomerID != ""`:
```
UPDATE customers SET total_spent=…, visit_count=…, last_visit=now(),
  points = points + EarnedPoints - pointsRedeemed WHERE id=…
```
`points_redeemed` is stored on the order; **earned is not recorded anywhere**.

### 3.1 New behavior (same transaction, same idempotency guard)

When a customer is attached and loyalty is enabled, inside the existing order tx:
1. Read `balance_before` via `SELECT points FROM customers WHERE id=$1 FOR UPDATE`
   (already done in the redeem branch; now done whenever a loyalty customer is present, so the
   ledger entries can stamp `balance_after`).
2. Keep the existing cached-balance update (`points = points + earned − redeemed`).
3. Persist `orders.points_earned = res.EarnedPoints` (new INSERT column).
4. Write ledger entries:
   - if `earned > 0`: `earn` entry, `points = +earned`,
     `balance_after = balance_before + earned`, `order_id`, reason
     `"Poin dari transaksi {orderNumber}"`, `created_by_name = in.CashierName`.
   - if `redeemed > 0`: `redeem` entry, `points = −redeemed`,
     `balance_after = balance_before + earned − redeemed`, `order_id`, reason
     `"Penukaran poin di transaksi {orderNumber}"`, `created_by_name = in.CashierName`.

### 3.2 Invariants (must hold)

- **The points math is unchanged** — only newly *recorded*. The net effect on
  `customers.points` is identical to today.
- **Idempotency preserved** — ledger inserts are inside the `idempotency_key` /
  `processed_keys`-guarded tx, so a replayed or offline-synced order cannot double-log
  (the whole tx is gated; on replay the order isn't re-inserted, so the ledger isn't either).
- **No customer / loyalty disabled** → no ledger writes, exactly as today.

---

## 4. Refund reversal — `service/order.go` `Refund` (≈`order.go:282`)

Today Refund flips status to `refunded` + restocks; it **never touches points** (the latent
bug — a refunded order keeps earned points and permanently loses redeemed points).

### 4.1 New behavior (inside the existing status-guarded refund tx)

After the status flip + restock, load the order's `customer_id`, `points_earned`,
`points_redeemed`. If `customer_id` is present:
1. `SELECT points FROM customers WHERE id=$1 FOR UPDATE` → `balance`.
2. **Clawback earned (floor 0):** `clawback = balance − max(0, balance − points_earned)`
   (i.e. up to `points_earned`, never below 0). If `clawback > 0`, write a `refund` entry
   `points = −clawback`, `balance_after = balance − clawback`, `order_id`, reason
   `"Pembatalan poin dari refund {orderNumber}"` + a note if part was forgiven
   (`points_earned − clawback > 0`).
3. **Restore redeemed:** if `points_redeemed > 0`, write a `refund` entry
   `points = +points_redeemed`, `balance_after = (balance − clawback) + points_redeemed`,
   `order_id`, reason `"Pengembalian poin tukar dari refund {orderNumber}"`.
4. Update `customers.points = (balance − clawback) + points_redeemed`.

### 4.2 Invariants

- **Idempotent** — the existing guard returns early when status is already `refunded`
  (`order.go:299-301`), so a second refund neither re-runs the reversal nor double-writes.
- **Pre-SP-CRM-7 orders** (`points_earned = 0`): clawback is 0; redeemed is still restored
  (known from `points_redeemed`). Honest best-effort, documented.
- Refund with no customer → no points work, exactly as today.

---

## 5. Manual adjustment — backoffice (gated `manage_settings`)

`POST /customers/{id}/points/adjust` body `{ points: <signed non-zero int>, reason: <required> }`:
- `write.AdjustPoints(ctx, customerID, delta, reason, byID, byName)`:
  - tx: `SELECT points FROM customers WHERE id=$1 FOR UPDATE` → `balance`
    (404 / ErrNotFound if the customer row is missing).
  - validate `delta != 0`, `reason` non-empty.
  - if `delta < 0 && -delta > balance` → **reject** with a friendly 400
    *"poin tidak cukup untuk pengurangan"* (explicit subtract is rejected, never silently clamped).
  - `newBalance = balance + delta`.
  - insert `adjust` ledger entry (`points = delta`, `balance_after = newBalance`, `reason`,
    `created_by = byID`, `created_by_name = byName`).
  - `UPDATE customers SET points = newBalance WHERE id=$1`.
  - return `{ id, balanceAfter: newBalance }`.

Adjust is the only new write gated on `manage_settings` (it creates value). Everything else in
the slice (ledger view) stays on `manage_customers`.

---

## 6. Ledger read + backoffice UI

### 6.1 Endpoint (gated `manage_customers`)

`GET /customers/{id}/points?page=&limit=` → paginated, newest-first
(`created_at DESC, id DESC`), standard `{data, meta{total,page,limit}}` envelope. Each row:
`{ id, type, points, balanceAfter, reason, orderId, orderNumber?, createdByName, createdAt }`
(left-join `orders` for `orderNumber` display when `order_id` is set). The **current balance** is
already on the customer object (`customers.points`) — not re-derived here.

### 6.2 Endpoints summary (all under `/api/v1`, `customers` tag)

| method | path | permission |
|---|---|---|
| GET | `/customers/{id}/points` | `manage_customers` |
| POST | `/customers/{id}/points/adjust` | `manage_settings` |

(POST `/points/adjust` registered as a static sub-path; earn/redeem/refund entries are written
internally by the order/refund services, **not** via a public endpoint.)

### 6.3 Backoffice — `CustomerDetail.tsx`

Replace the reserved *"Poin (ledger) — segera"* placeholder with a real **Poin** section:
- Header: current balance (from `c.points`) + a **"Sesuaikan Poin"** button shown only when the
  current user holds `manage_settings` (frontend gate; backend enforces regardless). The button
  opens a small inline form: a signed amount (e.g. a +/− toggle or signed number) + a required
  reason → `api.adjustPoints(id, {points, reason})` → refetch ledger + the customer (balance).
- A paginated ledger list (newest-first): a type chip (earn/redeem/adjust/refund, colored),
  the signed `points` (green +, red −), `balanceAfter`, `reason` (+ order # link text when
  present), date, and `createdByName`. Shared `<Pagination/>` (props `page`/`totalPages`/`total`/
  `onChange`/`pageSize`/`onPageSizeChange`, from `../ui` — confirmed in SP-CRM-6). Busy guard +
  error-on-next-load pattern (codebase convention).

How the frontend knows the user's permissions: reuse the existing auth/permission source the
app already uses to gate other admin-only UI (e.g. the `manage_settings`-gated areas). The plan
must locate and reuse that hook/context rather than inventing one. If no clean client-side
permission signal exists, the button is shown to all and the backend 403 is surfaced as the
gate (acceptable fallback; the plan picks based on what exists).

### 6.4 POS / lean-sync

POS is **unchanged** — it reads the cached `customers.points` for redemption. `point_transactions`
is **not** on `customerObj`/`customerObjWithTags`; no new POS exposure. Lean-sync invariant
intact.

---

## 7. TS client additions

- `listPointTransactions(customerId, page?, limit?)` → `ListResult<PointTransaction>`
- `adjustPoints(customerId, { points, reason })` → `{ id, balanceAfter }`

(The earn/redeem/refund entries are produced server-side; no client method.)

---

## 8. Testing & verification

### 8.1 Go unit tests (pure helpers)

- Clawback-with-forgiveness math: `clawback = balance − max(0, balance − earned)` across
  `earned ≤ balance`, `earned > balance` (forgiveness), `earned = 0`.
- Adjust validation: `delta = 0` rejected; `delta < 0 && |delta| > balance` rejected;
  valid +/− accepted.

### 8.2 Authed live verification (deploy → `/readyz` → scripted authed check)

Admin login `admin@mandalika.test`; `SEED_ADMIN_PASSWORD` via gcloud-secrets substitution
(never printed). Using a temp customer (cleaned up):
- **Earn:** create an order with the temp customer (and a cart total that earns ≥1 point) →
  `GET /customers/{id}/points` shows an `earn` entry with the right `balance_after`;
  `orders.points_earned` persisted; `customers.points` matches.
- **Redeem:** an order redeeming points → `redeem` entry (−), balance reduced.
- **Refund:** refund an earning order → a `refund` clawback entry (−) brings the balance down
  (floored at 0 when over-spent → forgiveness noted); refund a redeeming order → a `refund`
  restore entry (+) returns the redeemed points; **double refund does NOT double-reverse**.
- **Adjust:** `POST /points/adjust {points:+50, reason}` → `adjust` entry + balance; `{points:-9999}`
  (over balance) → 400; adjust **without `manage_settings` → 403**; ledger view works with
  `manage_customers`.
- **Idempotency:** replaying an order (same `idempotency_key`) does not double-log.
- **Regression (lean-sync):** `/sync/customers/lookup` + `/customers/by-phone` carry NO
  `point_transactions` / ledger fields (cached `points` only, unchanged).
- Clean up the temp customer + its orders.

### 8.3 Index check (pgx throwaway, tx rolled back, deleted after)

Confirm `idx_point_transactions_customer` exists and a per-customer history query uses it.

---

## 9. Risk notes (this slice touches live money/points)

- The order-create and refund paths are the hot/critical paths. Changes are **additive
  recording + a correctness fix**, with the points math itself unchanged on create.
- All ledger writes are in the same tx as the balance update → no torn state, idempotency
  inherited from the existing order/refund guards.
- Offline-synced orders: ledger entries are written server-side at sync time (in `CreateOrder`),
  so the offline outbox needs no change.
- Build order favors landing the schema + write helpers + unit-tested math first, then the
  order/refund wiring, then the read + UI — so the risky earning-path change is small and
  reviewed in isolation.

## 10. Pre-existing bug noted (likely adjacent, still out of scope)

The backoffice Loyalitas `loyaltyForm` is initialized from `DEFAULT_LOYALTY` and never synced
from `lq.data`, so "Simpan Pengaturan" clobbers untouched fields with defaults. It touches the
same loyalty area; **not fixed here** unless the user asks — flagged for awareness.
