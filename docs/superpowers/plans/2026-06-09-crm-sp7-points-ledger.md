# SP-CRM-7 — Points Ledger + Manual Adjustment + Refund Reversal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the loyalty points balance an append-only audit ledger, an admin manual-adjustment tool, and fix the refund-doesn't-reverse-points bug — backend + backoffice only, POS keeps reading the cached balance.

**Architecture:** A new `point_transactions` table is the audit spine; `customers.points` stays the cached authoritative balance (POS reads it), updated in the SAME transaction as every ledger write. `CreateOrder` and `Refund` (the high-risk hot paths) gain ledger writes with no change to the points math itself. Manual adjustment is a new backoffice action gated on `manage_settings`. Ledger-forward-only (no backfill); balance floored at 0.

**Tech Stack:** Go (pgx, chi, oapi-codegen), Postgres (Neon), React + TypeScript (Vite), `@mandalika/api` client.

**Spec:** `docs/superpowers/specs/2026-06-09-crm-sp7-points-ledger-design.md`

**Conventions reused (read once before starting):**
- Write layer: `backend/internal/write/segment.go` (validate → `r.Pool`/`r.tx`, `ErrNotFound`); `nullStr` at `write/repo.go:770`; `r.tx(ctx,"name",func(pgx.Tx) error)` (see `ReorderSegments`).
- Read layer: `backend/internal/read/repo.go` — `listJSON[T]` (1st col = JSON object + `count(*) OVER() AS total`), `off(page,limit)`.
- Handlers: `backend/internal/handlers/writes.go` — `decodeWrite[T]`, `h.created`, `h.mutated`, `h.caller(r)` (→ `callerID{userID,name}`), `pageLimit(r)`, `meta(total,page,limit)`; reads return `{data, meta}` (httpx.JSON envelope — login token at `resp.data.access`).
- Routes: `backend/internal/server/server.go` — `manage_customers` group (~L152-170), `manage_settings` group (~L245).
- Order/earning path: `backend/internal/service/order.go` — `CreateOrder` (redemption block ~L125-147, order INSERT ~L212-236, customer loyalty UPDATE ~L249-257), `Refund` (~L282-338), `loadLoyalty` (~L390). `service` does NOT import `write` and `write` does NOT import `service` today (so `service`→`write` is cycle-free).
- Backoffice: `apps/backoffice/src/screens/customers/CustomerDetail.tsx`; permissions via `useAuth()` → `user.permissions` (string[]); admin role implies all (`App.tsx:107-111`). Chip colors pattern: `screens/customers/tagColors.ts`. Shared `<Pagination/>` from `../ui` (props `page`/`totalPages`/`total`/`onChange`/`pageSize`/`onPageSizeChange`).
- Client: `packages/api/src/client.ts` — `list<T>`, `data<T>`, `request<T>`, types aliased `S['Name']` from `./schema`.

**Backend codegen loop:** `cd backend && go tool oapi-codegen -config api/oapi-codegen.yaml api/openapi.yaml` then `corepack pnpm --filter @mandalika/api gen`; then `go build ./...`, `go test ./...`, `make gen-check`.

**Verification identity:** admin `admin@mandalika.test`; `SEED_ADMIN_PASSWORD` + `DATABASE_URL` via `gcloud secrets versions access latest --secret=NAME` in command-substitution (never print). DB checks via a pgx throwaway in a tx that ROLLS BACK.

⚠️ **This slice touches live money/points.** The points math on create is UNCHANGED — we only RECORD it and add the refund reversal. Keep every ledger write inside the existing transaction so idempotency is inherited.

---

## Task 1: Migration 0031 — ledger table + orders.points_earned

**Files:**
- Create: `backend/internal/db/migrations/0031_points_ledger.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 0031_points_ledger.sql
-- SP-CRM-7: append-only points ledger + per-order earned-points record.
-- customers.points stays the cached authoritative balance; this table is the audit
-- spine (ledger-forward-only, no backfill). Balance never goes negative.

CREATE TABLE point_transactions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id     uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  type            text NOT NULL CHECK (type IN ('earn','redeem','adjust','refund')),
  points          integer NOT NULL,            -- signed delta (+earn, -redeem, ± adjust/refund)
  balance_after   integer NOT NULL,            -- cached balance immediately after this entry
  reason          text,
  order_id        uuid REFERENCES orders(id) ON DELETE SET NULL,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by_name text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_point_transactions_customer
  ON point_transactions (customer_id, created_at DESC, id DESC);

-- Earned points recorded per order from now on, so refund can claw back the exact
-- amount. Pre-existing orders keep 0 (no clawback; redeemed still restorable).
ALTER TABLE orders ADD COLUMN points_earned integer NOT NULL DEFAULT 0;
```

- [ ] **Step 2: Commit**

```bash
git add backend/internal/db/migrations/0031_points_ledger.sql
git commit -m "feat(crm): migration 0031 — point_transactions ledger + orders.points_earned"
```

---

## Task 2: Pure balance helpers (TDD)

Two pure functions: the refund clawback (floor-0 with forgiveness) and the manual-adjust balance check. Both compile standalone — test-first.

**Files:**
- Create: `backend/internal/write/points_math.go`
- Test: `backend/internal/write/points_math_test.go`

- [ ] **Step 1: Write the failing tests**

```go
package write

import "testing"

func TestPointsClawback(t *testing.T) {
	cases := []struct{ balance, earned, want int }{
		{100, 30, 30},   // normal: claw back all earned
		{20, 30, 20},    // over-spent: floor at 0, forgive 10
		{0, 30, 0},      // empty balance: nothing to claw
		{100, 0, 0},     // nothing earned
		{50, 50, 50},    // exact
	}
	for _, c := range cases {
		if got := PointsClawback(c.balance, c.earned); got != c.want {
			t.Errorf("PointsClawback(%d,%d)=%d want %d", c.balance, c.earned, got, c.want)
		}
	}
}

func TestAdjustedBalance(t *testing.T) {
	if _, err := adjustedBalance(100, 0); err == nil {
		t.Error("delta=0 should error")
	}
	if _, err := adjustedBalance(10, -50); err == nil {
		t.Error("subtracting more than balance should error")
	}
	if nb, err := adjustedBalance(10, 25); err != nil || nb != 35 {
		t.Errorf("add: got %d,%v want 35,nil", nb, err)
	}
	if nb, err := adjustedBalance(50, -50); err != nil || nb != 0 {
		t.Errorf("subtract-to-zero: got %d,%v want 0,nil", nb, err)
	}
}
```

- [ ] **Step 2: Run, verify it fails**

Run: `cd backend && go test ./internal/write/ -run 'TestPointsClawback|TestAdjustedBalance' -v`
Expected: FAIL — `undefined: PointsClawback` / `undefined: adjustedBalance`.

- [ ] **Step 3: Implement**

```go
package write

import "fmt"

// PointsClawback returns how many points to remove from balance to claw back up to
// `earned`, never driving the balance below zero (the remainder is forgiven).
// Exported because the order service's Refund path uses it.
func PointsClawback(balance, earned int) int {
	if earned <= 0 || balance <= 0 {
		return 0
	}
	if earned >= balance {
		return balance
	}
	return earned
}

// adjustedBalance applies a signed delta to a balance, rejecting a subtraction that
// would drive the balance below zero or a no-op zero delta.
func adjustedBalance(balance, delta int) (int, error) {
	if delta == 0 {
		return 0, fmt.Errorf("jumlah penyesuaian tidak boleh nol")
	}
	if delta < 0 && -delta > balance {
		return 0, fmt.Errorf("poin tidak cukup untuk pengurangan")
	}
	return balance + delta, nil
}
```

- [ ] **Step 4: Run, verify it passes**

Run: `cd backend && go test ./internal/write/ -run 'TestPointsClawback|TestAdjustedBalance' -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/write/points_math.go backend/internal/write/points_math_test.go
git commit -m "feat(crm): points clawback + adjust-balance pure helpers with tests"
```

---

## Task 3: OpenAPI + codegen + write/read ledger code

Land the schema/paths + the generated types together with the write helper + adjust + the read, so the package compiles (the read/write code references generated `api.*` types).

**Files:**
- Modify: `backend/api/openapi.yaml`
- Create: `backend/internal/write/points.go`
- Modify: `backend/internal/read/repo.go` (append `PointTransactions`)
- Regenerate: `backend/internal/api/api.gen.go`, `packages/api/src/*`

- [ ] **Step 1: Add OpenAPI schemas** (in `components.schemas`)

```yaml
    PointTransaction:
      type: object
      required: [id, type, points, balanceAfter, createdAt]
      properties:
        id: { type: string, format: uuid }
        type: { type: string, enum: [earn, redeem, adjust, refund] }
        points: { type: integer }
        balanceAfter: { type: integer }
        reason: { type: string, nullable: true }
        orderId: { type: string, format: uuid, nullable: true }
        orderNumber: { type: string, nullable: true }
        createdByName: { type: string, nullable: true }
        createdAt: { type: string, format: date-time }
    PointTransactionListResponse:
      type: object
      required: [data, meta]
      properties:
        data: { type: array, items: { $ref: '#/components/schemas/PointTransaction' } }
        meta: { $ref: '#/components/schemas/Meta' }
    AdjustPointsInput:
      type: object
      required: [points, reason]
      properties:
        points: { type: integer }
        reason: { type: string }
    AdjustPointsResponse:
      type: object
      required: [data]
      properties:
        data:
          type: object
          required: [balanceAfter]
          properties:
            balanceAfter: { type: integer }
```

- [ ] **Step 2: Add OpenAPI paths** (mirror the SP-CRM-6 customer sub-paths; note the `/api/v1` prefix used by every path string)

```yaml
  /api/v1/customers/{id}/points:
    get:
      operationId: listPointTransactions
      tags: [customers]
      parameters:
        - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
        - { name: page, in: query, schema: { type: integer } }
        - { name: limit, in: query, schema: { type: integer } }
      responses:
        '200':
          description: points ledger
          content:
            application/json:
              schema: { $ref: '#/components/schemas/PointTransactionListResponse' }
  /api/v1/customers/{id}/points/adjust:
    post:
      operationId: adjustPoints
      tags: [customers]
      parameters:
        - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/AdjustPointsInput' }
      responses:
        '200':
          description: adjusted
          content:
            application/json:
              schema: { $ref: '#/components/schemas/AdjustPointsResponse' }
```

- [ ] **Step 3: Write `write/points.go`** (the shared ledger insert + AdjustPoints)

```go
package write

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// PointTxRow is one ledger entry to insert. Empty OrderID/ByID/ByName → NULL.
type PointTxRow struct {
	CustomerID   string
	Type         string // earn | redeem | adjust | refund
	Points       int    // signed
	BalanceAfter int
	Reason       string
	OrderID      string
	ByID         string
	ByName       string
}

// InsertPointTx appends one ledger row using the given tx. Exported so the order
// service (CreateOrder / Refund) can record earn/redeem/refund entries inside the
// order transaction. The ::uuid casts let empty strings encode as NULL safely.
func InsertPointTx(ctx context.Context, tx pgx.Tx, e PointTxRow) error {
	_, err := tx.Exec(ctx,
		`INSERT INTO point_transactions
		   (customer_id, type, points, balance_after, reason, order_id, created_by, created_by_name)
		 VALUES ($1,$2,$3,$4,$5,$6::uuid,$7::uuid,$8)`,
		e.CustomerID, e.Type, e.Points, e.BalanceAfter,
		nullStr(e.Reason), nullStr(e.OrderID), nullStr(e.ByID), nullStr(e.ByName))
	if err != nil {
		return fmt.Errorf("insert point tx: %w", err)
	}
	return nil
}

// AdjustPoints applies a signed manual adjustment with a required reason, writes an
// `adjust` ledger entry, and updates the cached balance — all in one tx. Rejects a
// subtraction larger than the balance (floor at 0).
func (r *Repo) AdjustPoints(ctx context.Context, customerID string, delta int, reason, byID, byName string) (int, error) {
	if reason == "" {
		return 0, fmt.Errorf("alasan penyesuaian wajib")
	}
	var newBal int
	err := r.tx(ctx, "customers", func(t pgx.Tx) error {
		var bal int
		if e := t.QueryRow(ctx, `SELECT points FROM customers WHERE id=$1 FOR UPDATE`, customerID).Scan(&bal); e != nil {
			if errors.Is(e, pgx.ErrNoRows) {
				return ErrNotFound
			}
			return fmt.Errorf("load points: %w", e)
		}
		nb, e := adjustedBalance(bal, delta)
		if e != nil {
			return e
		}
		newBal = nb
		if e := InsertPointTx(ctx, t, PointTxRow{
			CustomerID: customerID, Type: "adjust", Points: delta, BalanceAfter: nb,
			Reason: reason, ByID: byID, ByName: byName,
		}); e != nil {
			return e
		}
		if _, e := t.Exec(ctx, `UPDATE customers SET points=$2 WHERE id=$1`, customerID, nb); e != nil {
			return fmt.Errorf("update points: %w", e)
		}
		return nil
	})
	return newBal, err
}
```

Note: confirm `r.tx` exists with this signature (`grep -n "func (r \*Repo) tx" backend/internal/write/*.go`; `ReorderSegments` uses it). Confirm `ErrNotFound` and `nullStr` are in the `write` package (they are).

- [ ] **Step 4: Add the read to `read/repo.go`** (after the other customer reads)

```go
// PointTransactions returns a customer's points ledger, newest-first, paginated.
func (r *Repo) PointTransactions(ctx context.Context, customerID string, page, limit int) ([]api.PointTransaction, int, error) {
	const sql = `SELECT json_build_object(
		  'id', pt.id, 'type', pt.type, 'points', pt.points, 'balanceAfter', pt.balance_after,
		  'reason', pt.reason, 'orderId', pt.order_id, 'orderNumber', o.order_number,
		  'createdByName', pt.created_by_name, 'createdAt', pt.created_at), count(*) OVER() AS total
		FROM point_transactions pt
		LEFT JOIN orders o ON o.id = pt.order_id
		WHERE pt.customer_id = $1
		ORDER BY pt.created_at DESC, pt.id DESC
		OFFSET $2 LIMIT $3`
	return listJSON[api.PointTransaction](ctx, r.Pool, sql, customerID, off(page, limit), limit)
}
```

- [ ] **Step 5: Regenerate**

```bash
cd backend && go tool oapi-codegen -config api/oapi-codegen.yaml api/openapi.yaml
corepack pnpm --filter @mandalika/api gen
```
Expected: `api.PointTransaction`, `api.PointTransactionListResponse`, `api.AdjustPointsInput` now exist.

- [ ] **Step 6: Stage (commit lands in Task 6 once the order wiring compiles)**

```bash
git add backend/api/openapi.yaml backend/internal/write/points.go backend/internal/read/repo.go backend/internal/api/api.gen.go packages/api
```

---

## Task 4: Earning path — record earn/redeem in CreateOrder (⚠️ high-risk)

**Files:**
- Modify: `backend/internal/service/order.go` (`CreateOrder`)

The points MATH does not change. We (a) read the balance once for any loyalty customer, (b) persist `orders.points_earned`, (c) append earn/redeem ledger entries — all inside the existing tx.

- [ ] **Step 1: Add the `write` import** to `order.go`

Ensure the import block includes `"github.com/mandalika/pos-backend/internal/write"` (confirm the module path matches the others in the file, e.g. `internal/service` siblings — use the same prefix as the existing imports).

- [ ] **Step 2: Hoist the balance read** — replace the redemption block (~L128-146) so the `FOR UPDATE` read happens for ANY loyalty customer (not only when redeeming), giving `balanceBefore` for the ledger

Replace:
```go
	pointsRedeemed := 0
	redeemAmount := 0.0
	if in.PointsRedeemed > 0 && in.CustomerID != "" && loyEnabled && redemptionRate > 0 {
		var avail int
		if e := tx.QueryRow(ctx,
			`SELECT points FROM customers WHERE id=$1 FOR UPDATE`,
			in.CustomerID).Scan(&avail); e != nil {
			return "", false, false, fmt.Errorf("load customer points: %w", e)
		}
		pointsRedeemed = in.PointsRedeemed
		if pointsRedeemed > avail {
			pointsRedeemed = avail
		}
		redeemAmount = float64(pointsRedeemed) * redemptionRate
		if redeemAmount > res.Total {
			redeemAmount = res.Total
			pointsRedeemed = int(res.Total / redemptionRate)
		}
	}
	finalTotal := res.Total - redeemAmount
```
with:
```go
	// Read the cached balance once under row-lock for any loyalty customer — used
	// both for the redemption clamp and as balance_before for the ledger entries.
	hasLoyaltyCustomer := in.CustomerID != "" && loyEnabled
	balanceBefore := 0
	if hasLoyaltyCustomer {
		if e := tx.QueryRow(ctx,
			`SELECT points FROM customers WHERE id=$1 FOR UPDATE`,
			in.CustomerID).Scan(&balanceBefore); e != nil {
			return "", false, false, fmt.Errorf("load customer points: %w", e)
		}
	}
	pointsRedeemed := 0
	redeemAmount := 0.0
	if in.PointsRedeemed > 0 && hasLoyaltyCustomer && redemptionRate > 0 {
		pointsRedeemed = in.PointsRedeemed
		if pointsRedeemed > balanceBefore {
			pointsRedeemed = balanceBefore
		}
		redeemAmount = float64(pointsRedeemed) * redemptionRate
		if redeemAmount > res.Total {
			redeemAmount = res.Total
			pointsRedeemed = int(res.Total / redemptionRate)
		}
	}
	finalTotal := res.Total - redeemAmount
```

- [ ] **Step 3: Persist `points_earned`** — append the column to the order INSERT (avoid renumbering by appending at the END)

In the INSERT statement (~L213-223): add `points_earned` to the end of the column list and a `$33` value:
- Column list: change `… discount_label, discount_breakdown)` → `… discount_label, discount_breakdown, points_earned)`
- VALUES: change `…$31,$32::jsonb)` → `…$31,$32::jsonb,$33)`
- Args: after `nullBytes(in.DiscountBreakdown),` add `res.EarnedPoints,`

- [ ] **Step 4: Append the earn/redeem ledger entries** — right AFTER the existing customer loyalty UPDATE (~L249-257, the `UPDATE customers SET … points=points+$2-$4 …` block), still inside the same tx, using `orderID` (already scanned) and `balanceBefore`

```go
		// Ledger: record what the loyalty UPDATE just applied (SP-CRM-7). Same tx →
		// inherits the order's idempotency guard (a replayed order won't double-log).
		earned := res.EarnedPoints
		if earned > 0 {
			if e := write.InsertPointTx(ctx, tx, write.PointTxRow{
				CustomerID: in.CustomerID, Type: "earn", Points: earned,
				BalanceAfter: balanceBefore + earned,
				Reason:       fmt.Sprintf("Poin dari transaksi %s", orderNumber),
				OrderID:      orderID, ByID: in.CashierID, ByName: in.CashierName,
			}); e != nil {
				return "", false, false, e
			}
		}
		if pointsRedeemed > 0 {
			if e := write.InsertPointTx(ctx, tx, write.PointTxRow{
				CustomerID: in.CustomerID, Type: "redeem", Points: -pointsRedeemed,
				BalanceAfter: balanceBefore + earned - pointsRedeemed,
				Reason:       fmt.Sprintf("Penukaran poin di transaksi %s", orderNumber),
				OrderID:      orderID, ByID: in.CashierID, ByName: in.CashierName,
			}); e != nil {
				return "", false, false, e
			}
		}
```
Place this block INSIDE the existing `if in.CustomerID != "" {` that wraps the customer UPDATE (so it only runs when there's a customer). `earned`/`pointsRedeemed` are 0 when loyalty is off → no entries. Confirm `orderID` is in scope here (it is — scanned from the INSERT RETURNING above).

- [ ] **Step 5: Build (the whole backend compiles after Task 5; for now just vet this file)**

Run: `cd backend && go vet ./internal/service/` — expect it to compile once `write.InsertPointTx` exists (Task 3). If `write` import causes a cycle, STOP and report (the plan asserts no cycle; verify with `go build ./internal/service/`).

(Commit lands in Task 6.)

---

## Task 5: Refund reversal — claw back earned + restore redeemed (⚠️ high-risk)

**Files:**
- Modify: `backend/internal/service/order.go` (`Refund`)

- [ ] **Step 1: Extend the status SELECT** to also load the customer + points fields (~L290-292)

Replace:
```go
	var status string
	err = tx.QueryRow(ctx,
		`SELECT status FROM orders WHERE id=$1 AND outlet_id=$2 FOR UPDATE`,
		orderID, outletID).Scan(&status)
```
with:
```go
	var status, orderNumber string
	var custID *string
	var oEarned, oRedeemed int
	err = tx.QueryRow(ctx,
		`SELECT status, order_number, customer_id, points_earned, points_redeemed
		   FROM orders WHERE id=$1 AND outlet_id=$2 FOR UPDATE`,
		orderID, outletID).Scan(&status, &orderNumber, &custID, &oEarned, &oRedeemed)
```

- [ ] **Step 2: Reverse points** — after the restock loop, BEFORE `return tx.Commit(ctx)` (~L336)

```go
	// Points reversal (SP-CRM-7): claw back earned (floor 0, forgive remainder) and
	// restore redeemed. Idempotent: the already-refunded short-circuit above means
	// this runs at most once per order.
	if custID != nil && *custID != "" {
		var bal int
		if e := tx.QueryRow(ctx, `SELECT points FROM customers WHERE id=$1 FOR UPDATE`, *custID).Scan(&bal); e != nil {
			return fmt.Errorf("load points for refund: %w", e)
		}
		clawback := write.PointsClawback(bal, oEarned)
		afterClaw := bal - clawback
		if clawback > 0 {
			reason := fmt.Sprintf("Pembatalan poin dari refund %s", orderNumber)
			if oEarned > clawback {
				reason += fmt.Sprintf(" (%d poin dimaafkan)", oEarned-clawback)
			}
			if e := write.InsertPointTx(ctx, tx, write.PointTxRow{
				CustomerID: *custID, Type: "refund", Points: -clawback,
				BalanceAfter: afterClaw, Reason: reason, OrderID: orderID,
			}); e != nil {
				return e
			}
		}
		newBal := afterClaw + oRedeemed
		if oRedeemed > 0 {
			if e := write.InsertPointTx(ctx, tx, write.PointTxRow{
				CustomerID: *custID, Type: "refund", Points: oRedeemed,
				BalanceAfter: newBal,
				Reason:       fmt.Sprintf("Pengembalian poin tukar dari refund %s", orderNumber),
				OrderID:      orderID,
			}); e != nil {
				return e
			}
		}
		if clawback > 0 || oRedeemed > 0 {
			if _, e := tx.Exec(ctx, `UPDATE customers SET points=$2 WHERE id=$1`, *custID, newBal); e != nil {
				return fmt.Errorf("update points on refund: %w", e)
			}
		}
	}
```

Confirm the `write` import is present (added in Task 4). `orderID` is the function param (uuid string), valid for `OrderID`.

- [ ] **Step 3: Build**

Run: `cd backend && go build ./...`
Expected: clean. (Full test/commit in Task 6.)

---

## Task 6: Handlers + routes + build/test/gen-check + commit

**Files:**
- Modify: `backend/internal/handlers/writes.go` (append a "Customer points" section)
- Modify: `backend/internal/server/server.go` (register routes)

- [ ] **Step 1: Add handlers** to `writes.go`

```go
// ── Customer points ledger (SP-CRM-7) ──────────────────────

func (h *Handlers) PointTransactions(w http.ResponseWriter, r *http.Request) {
	p, l := pageLimit(r)
	rows, total, err := h.Repo.PointTransactions(r.Context(), chi.URLParam(r, "id"), p, l)
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, http.StatusOK, api.PointTransactionListResponse{Data: rows, Meta: *meta(total, p, l)})
}

func (h *Handlers) AdjustPoints(w http.ResponseWriter, r *http.Request) {
	in, ok := decodeWrite[api.AdjustPointsInput](w, r)
	if !ok {
		return
	}
	c, _ := h.caller(r)
	bal, err := h.Write.AdjustPoints(r.Context(), chi.URLParam(r, "id"), in.Points, in.Reason, c.userID, c.name)
	if errors.Is(err, write.ErrNotFound) {
		httpx.Err(w, http.StatusNotFound, "pelanggan tidak ditemukan")
		return
	}
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	h.invalidate(r)
	writeJSON(w, http.StatusOK, api.AdjustPointsResponse{Data: struct {
		BalanceAfter int `json:"balanceAfter"`
	}{BalanceAfter: bal}})
}
```
Note: match the generated `AdjustPointsResponse.Data` shape exactly — if oapi-codegen names the inline data struct a type (e.g. `AdjustPointsResponseData`), use that named type instead of the anonymous struct literal. Check `api.gen.go` and adapt. Confirm `errors`, `httpx`, `write`, `api`, `chi` are imported in `writes.go` (they are). Confirm `h.invalidate(r)` is the cache-bust used by other writes (it is, via `h.created`/`h.mutated`).

- [ ] **Step 2: Register routes** in `server.go`

In the `manage_customers` group (alongside the SP-CRM-6 interaction routes):
```go
				r.Get("/customers/{id}/points", h.PointTransactions)
```
In the `manage_settings` group (~L245, `r.Use(mw.RequirePermission("manage_settings"))`):
```go
				r.Post("/customers/{id}/points/adjust", h.AdjustPoints)
```

- [ ] **Step 3: Build + test + gen-check**

```bash
cd backend && go build ./... && go test ./... && make gen-check
```
Expected: build clean; tests PASS (incl. Task 2 helpers); gen-check clean. (`-race` can't run locally — no cgo on this Windows box; CI runs it.) Fix the most likely issue: the `AdjustPointsResponse` data struct shape (Step 1 note).

- [ ] **Step 4: Commit the backend slice**

```bash
git add backend/api/openapi.yaml backend/internal/api/api.gen.go packages/api \
        backend/internal/write/points.go backend/internal/read/repo.go \
        backend/internal/service/order.go backend/internal/handlers/writes.go \
        backend/internal/server/server.go
git commit -m "feat(crm): SP-CRM-7 backend — points ledger, manual adjust, refund reversal; record earn/redeem on orders"
```

---

## Task 7: TS client

**Files:**
- Modify: `packages/api/src/client.ts`

- [ ] **Step 1: Add type aliases** (with the other `S['...']` aliases)

```typescript
export type PointTransaction = S['PointTransaction']
export type AdjustPointsInput = S['AdjustPointsInput']
```

- [ ] **Step 2: Add interface signatures** (after the interactions/reminders block from SP-CRM-6)

```typescript
  // points ledger (SP-CRM-7)
  listPointTransactions: (customerId: string, page?: number, limit?: number) => Promise<ListResult<PointTransaction>>
  adjustPoints: (customerId: string, input: AdjustPointsInput) => Promise<{ balanceAfter: number }>
```

- [ ] **Step 3: Add implementations** (after the interactions/reminders impl)

```typescript
    listPointTransactions: (customerId, page = 1, limit = 25) =>
      list<PointTransaction>(`${API}/customers/${customerId}/points`, { page, limit }),
    adjustPoints: (customerId, input) =>
      data<{ balanceAfter: number }>('POST', `${API}/customers/${customerId}/points/adjust`, input),
```
(`data<T>` unwraps the `{data:T}` envelope → returns `{balanceAfter}`. Confirm `S['PointTransaction']`/`S['AdjustPointsInput']` exist in `packages/api/src/schema.d.ts` after Task 3's codegen, matching how `Interaction`/`Segment` are aliased.)

- [ ] **Step 4: Typecheck + commit**

```bash
corepack pnpm --filter @mandalika/api exec tsc --noEmit -p tsconfig.json
```
Expected: clean.
```bash
git add packages/api/src/client.ts
git commit -m "feat(crm): TS client — points ledger + adjust methods"
```

---

## Task 8: Backoffice — Poin (ledger) section + manual adjust

**Files:**
- Create: `apps/backoffice/src/screens/customers/pointTypes.ts`
- Modify: `apps/backoffice/src/screens/customers/CustomerDetail.tsx`

- [ ] **Step 1: Create the ledger-type metadata helper**

```typescript
// apps/backoffice/src/screens/customers/pointTypes.ts
import { tagChipClasses } from './tagColors'

const META: Record<string, { label: string; color: string }> = {
  earn: { label: 'Perolehan', color: 'green' },
  redeem: { label: 'Penukaran', color: 'amber' },
  adjust: { label: 'Penyesuaian', color: 'blue' },
  refund: { label: 'Refund', color: 'red' },
}

export const pointTypeLabel = (t: string): string => META[t]?.label ?? t
export const pointTypeChipClasses = (t: string): string => tagChipClasses(META[t]?.color ?? 'gray')
```

- [ ] **Step 2: Wire the Poin section into `CustomerDetail.tsx`**

Imports to add:
```typescript
import type { PointTransaction } from '@mandalika/api'
import { useAuth } from '../../auth'
import { Pagination } from '../../ui'
import { pointTypeLabel, pointTypeChipClasses } from './pointTypes'
```
(Confirm `Pagination` is exported from `../../ui` and `useAuth` from `../../auth` — both confirmed in the codebase. `Star` is already imported in this file.)

Inside the component (near the other queries), add ledger state + the permission gate:
```typescript
  const { user } = useAuth()
  const canAdjust = user?.role === 'admin' || (user?.permissions ?? []).includes('manage_settings')
  const [ptPage, setPtPage] = useState(1)
  const ptLimit = 25
  const ptq = usePolledQuery(
    () => api.listPointTransactions(customerId, ptPage, ptLimit),
    [customerId, ptPage],
  )
  const ptx = ptq.data?.data ?? []
  const ptTotal = ptq.data?.meta?.total ?? 0

  const [adjOpen, setAdjOpen] = useState(false)
  const [adjAmount, setAdjAmount] = useState('')   // signed integer string
  const [adjReason, setAdjReason] = useState('')
  const [adjBusy, setAdjBusy] = useState(false)
  const [adjErr, setAdjErr] = useState<string | null>(null)

  const submitAdjust = async () => {
    const n = parseInt(adjAmount, 10)
    if (!Number.isFinite(n) || n === 0) { setAdjErr('Jumlah harus angka bukan nol'); return }
    if (!adjReason.trim()) { setAdjErr('Alasan wajib diisi'); return }
    if (adjBusy) return
    setAdjBusy(true); setAdjErr(null)
    try {
      await api.adjustPoints(customerId, { points: n, reason: adjReason.trim() })
      setAdjOpen(false); setAdjAmount(''); setAdjReason(''); setPtPage(1)
      await Promise.all([ptq.refetch(), cq.refetch()])  // refresh ledger + balance
    } catch (e) {
      setAdjErr(e instanceof Error ? e.message : 'Gagal menyesuaikan poin')
    } finally {
      setAdjBusy(false)
    }
  }
```

Replace the reserved `"Poin (ledger) — segera"` placeholder card with the real section:
```tsx
          {/* Poin ledger (SP-CRM-7) */}
          <Card className="overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Star className="w-4 h-4 text-gold-500" />
                <h3 className="font-black text-gray-900 text-sm">Poin</h3>
                <span className="text-sm font-bold text-gold-600">{c.points.toLocaleString('id-ID')}</span>
              </div>
              {canAdjust && (
                <Button variant="secondary" onClick={() => { setAdjOpen(true); setAdjErr(null) }}>Sesuaikan Poin</Button>
              )}
            </div>
            {adjOpen && (
              <div className="p-4 space-y-2 border-b border-gray-100 bg-gray-50">
                <div className="flex flex-wrap gap-2">
                  <input type="number" value={adjAmount} onChange={(e) => setAdjAmount(e.target.value)}
                    placeholder="+50 atau -20" className="w-32 px-2 py-1.5 text-sm rounded-lg border border-gray-200 bg-white" />
                  <input value={adjReason} onChange={(e) => setAdjReason(e.target.value)}
                    placeholder="Alasan (mis. hadiah, koreksi)" className="flex-1 min-w-[12rem] px-2 py-1.5 text-sm rounded-lg border border-gray-200 bg-white" />
                </div>
                {adjErr && <p className="text-xs text-red-600">{adjErr}</p>}
                <div className="flex gap-2">
                  <Button loading={adjBusy} disabled={adjBusy} onClick={() => void submitAdjust()}>Simpan</Button>
                  <Button variant="secondary" onClick={() => { setAdjOpen(false); setAdjErr(null) }}>Batal</Button>
                </div>
              </div>
            )}
            {ptq.loading && ptx.length === 0 ? (
              <TableSkeleton />
            ) : ptx.length === 0 ? (
              <EmptyState icon={<Star />} title="Belum ada transaksi poin" />
            ) : (
              <div className="divide-y divide-gray-50">
                {ptx.map((t: PointTransaction) => (
                  <div key={t.id} className="px-5 py-3 flex items-center gap-3">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-bold border flex-shrink-0 ${pointTypeChipClasses(t.type)}`}>
                      {pointTypeLabel(t.type)}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-gray-400">{fmtDate(t.createdAt)}{t.orderNumber ? ` · ${t.orderNumber}` : ''}{t.createdByName ? ` · ${t.createdByName}` : ''}</p>
                      {t.reason && <p className="text-sm text-gray-700">{t.reason}</p>}
                    </div>
                    <div className="text-right flex-shrink-0">
                      <p className={`text-sm font-black ${t.points >= 0 ? 'text-green-600' : 'text-red-600'}`}>{t.points >= 0 ? '+' : ''}{t.points.toLocaleString('id-ID')}</p>
                      <p className="text-xs text-gray-400">{t.balanceAfter.toLocaleString('id-ID')}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {ptTotal > ptLimit && (
              <div className="px-4 py-2 border-t border-gray-100">
                <Pagination page={ptPage} total={ptTotal} totalPages={Math.ceil(ptTotal / ptLimit)} pageSize={ptLimit}
                  onChange={setPtPage} onPageSizeChange={() => { /* fixed 25 */ }} />
              </div>
            )}
          </Card>
```
Note: match the real `<Pagination/>` prop API exactly (verified in SP-CRM-6: `page`/`total`/`totalPages`/`pageSize`/`onChange`/`onPageSizeChange`). Confirm `Button` supports `loading`/`variant` and `fmtDate` exists in this file (both used already).

- [ ] **Step 3: Build**

```bash
corepack pnpm --filter @mandalika/backoffice build
```
Expected: `tsc -b` + `vite build` clean. Fix any prop/type mismatches.

- [ ] **Step 4: Commit**

```bash
git add apps/backoffice/src/screens/customers/pointTypes.ts apps/backoffice/src/screens/customers/CustomerDetail.tsx
git commit -m "feat(crm): customer detail — points ledger + manual adjustment (manage_settings)"
```

---

## Task 9: Deploy + live verification + index check

- [ ] **Step 1: Deploy + readyz**

```bash
gcloud run deploy mandalika-pos --source backend --region asia-southeast2 --quiet
curl -s -o /dev/null -w "%{http_code}\n" https://mandalika-pos-rqbgovtm2a-et.a.run.app/readyz
```
Expected: deploy success (mig 0031 auto-applies); `/readyz` → 200. Note the new revision.

- [ ] **Step 2: Authed live checks** (Node script reading `SEED_ADMIN_PASSWORD` from env via gcloud-secrets substitution; login `admin@mandalika.test`; token at `resp.data.access`; never print the secret). Use a temp customer (cleaned up). Verify:
  - **Earn:** create an order for the temp customer with a total that earns ≥1 point (ensure `enabled` loyalty + `points_per_thousand>0` — read `/loyalty`/settings, or set a known total) → `GET /customers/{id}/points` shows an `earn` entry, correct `balanceAfter`, `orderNumber` set; `customers.points` matches.
  - **Redeem:** an order redeeming N points → a `redeem` entry (−N), balance reduced.
  - **Refund:** refund the earning order → a `refund` clawback (−) lowers balance (floored at 0 when over-spent → "dimaafkan" note); refund a redeeming order → a `refund` restore (+) returns the points. **Double refund → no second reversal** (ledger unchanged on the 2nd call).
  - **Adjust:** `POST /customers/{id}/points/adjust {points:+50, reason:"test"}` → 200 `{data:{balanceAfter}}` + an `adjust` ledger entry; `{points:-999999}` → 400; `{points:0}` → 400; **adjust with a token lacking `manage_settings` → 403** (the seed admin has it — to prove the gate, assert the route is under the manage_settings group, or skip if no low-priv token is available and note it).
  - **Idempotency:** re-POST the same order (same `idempotency_key`) → the ledger does NOT gain duplicate earn/redeem rows.
  - **Regression (lean-sync):** `/sync/customers/lookup` + `/customers/by-phone` carry NO ledger fields (cached `points` only).
  - Clean up the temp customer + its orders.
- [ ] **Step 3: Index check** (pgx throwaway in `backend/cmd/<name>`, tx rolled back, deleted after): confirm `idx_point_transactions_customer` + the `points_earned` column + the `point_transactions` table exist; `EXPLAIN` a `WHERE customer_id=$1 ORDER BY created_at DESC` query (seqscan off) → Index Scan on `idx_point_transactions_customer`.
- [ ] **Step 4: Record outcome** — new ⭐ LATEST SESSION block in `SESSION_HANDOFF.md` (rev, mig 0031, commits, what shipped, USER-PENDING = backoffice visual walkthrough of the Poin section + a real refund-reverses-points check) and update the `crm-customers-module` memory. Next = SP-CRM-8 (loyalty-conditions trigger engine). No APK.

---

## Self-review notes (author)

- **Spec coverage:** ledger table → T1; pure floor/adjust math → T2; write helper + AdjustPoints + read → T3; earn/redeem recording + points_earned → T4; refund reversal → T5; endpoints/routes/perms (`manage_customers` view, `manage_settings` adjust) → T6; client → T7; CustomerDetail Poin section + gated adjust → T8; deploy + idempotency/lean-sync/index verify → T9.
- **Points math unchanged on create** — Task 4 only hoists a read, persists `points_earned`, and appends ledger rows; the `points=points+earned-redeemed` UPDATE is untouched.
- **Deferred (SP-CRM-8):** no loyalty_conditions evaluation anywhere — earning stays the flat formula.
- **Verify-don't-assume flags the implementer must resolve:** the generated `AdjustPointsResponse.Data` struct shape (T6), `r.tx` signature + `ErrNotFound`/`nullStr` in `write` (T3), no `service`→`write` import cycle (T4), the `<Pagination/>` props + `Button loading`/`variant` (T8), and that `useAuth().user.permissions` is the right gate (T8). Each step says how to confirm.
- **Idempotency** is the load-bearing safety property — verified live in T9 (replayed order no double-log; double refund no double-reverse).
