# SP-CRM-9 — Product-Reward POS Fulfillment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a cashier hand over the free item a `product_reward` loyalty condition grants — picked at checkout, added as a Rp0 cart line, with correct stock, receipt, and an "actually received" audit grant.

**Architecture:** Online-only v1. A new read-only preview endpoint reuses the existing pure Go `EvaluateLoyalty` engine to tell the POS which `product_reward` conditions match (with their eligible product/variant menus). The cashier picks one per condition at the checkout panel; the chosen item becomes a Rp0 cart line tagged with its `rewardConditionId`. At order commit, `CreateOrder` re-runs the engine on paid items only, validates each reward line against the matched conditions, and writes a grant recording the chosen product. No migration — the chosen product reuses `loyalty_condition_applications.reward_product_ids`.

**Tech Stack:** Go (pgx, chi, oapi-codegen), TypeScript/React (POS, Vite, vitest), OpenAPI codegen, Cloud Run + Neon, Android APK via GH Actions.

**Spec:** `docs/superpowers/specs/2026-06-10-crm-sp9-product-reward-fulfillment-design.md`

---

## File Structure

**Backend**
- Modify `backend/internal/service/order.go` — add `IsReward`/`RewardConditionID` to `OrderItem`; refactor `loadActiveConditions` to a `rowQuerier`; build the engine product-set from paid items only; record `product_reward` grants only for validated reward lines (skip the auto-record in the Applied loop).
- Create `backend/internal/service/loyalty_preview.go` — `PreviewRewards(...)` + result structs (loads customer + conditions + product/variant menus via `s.Pool`, reuses `ProductRewards`).
- Modify `backend/internal/service/loyalty.go` — add the pure `ProductRewards(conds, ctx)` helper.
- Modify `backend/internal/service/loyalty_test.go` — tests for `ProductRewards`.
- Create `backend/internal/service/loyalty_preview_test.go` — table tests for the validation helper `contains` + reward-line gating logic (pure parts).
- Modify `backend/internal/handlers/writes.go` — `LoyaltyPreview` handler + `loyaltyPreviewBody`; add `IsReward`/`RewardConditionID` are already on `service.OrderItem` so `createOrderBody` is unchanged.
- Modify `backend/internal/server/server.go` — register `POST /sync/loyalty-preview` in the cashier-authed group.
- Modify `backend/api/openapi.yaml` — `isReward`/`rewardConditionId` on `OrderItemInput` + `CartItem`; `LoyaltyPreview*` schemas; the path. Then regen `api.gen.go` + the TS schema.

**POS / shared**
- Modify `packages/api/src/client.ts` — `loyaltyPreview(...)` method + `LoyaltyPreviewReward` type export.
- Modify `apps/pos/src/cashier/state/cashierReducer.ts` — `CART_ADD_REWARD`/`CART_REMOVE_REWARD` actions; guard paid-line ops against reward lines; drop reward lines on customer change.
- Create `apps/pos/src/cashier/state/cashierReducer.test.ts` — reward-action unit tests.
- Modify `apps/pos/src/cashier/CheckoutPanel.tsx` — "Hadiah Loyalti" section.
- Modify `apps/pos/src/cashier/CashierScreen.tsx` — preview fetch on checkout-open; derive picked rewards; pick/clear handlers; pass props.
- Modify `apps/pos/src/cashier/Cart.tsx` + `apps/pos/src/cashier/ReceiptPreview.tsx` — render reward lines as "GRATIS".

**No migration.**

---

## Conventions (read once)

- Backend regen after any `openapi.yaml` edit:
  ```bash
  cd backend && go tool oapi-codegen -config api/oapi-codegen.yaml api/openapi.yaml
  cd .. && corepack pnpm --filter @mandalika/api gen
  ```
  then `cd backend && make gen-check` must be clean (commit `api.gen.go`).
- OpenAPI paths use the `/api/v1/...` prefix; Go route registration uses the un-prefixed form (the chi group adds `/api/v1`).
- `-race` does NOT run on this Windows box (no cgo). Run `go test ./...` without it; CI runs race on Linux.
- Commit hook false-positives on chained `git commit && ...` — run `git add` then `git commit` as separate calls; never `--no-verify`.
- Deployed admin login email is `admin@mandalika.test`. Secrets via `gcloud secrets versions access latest --secret=<NAME>` in command substitution (never print).

---

## Batch A — Backend engine: paid-only product set + ProductRewards helper

### Task A1: `OrderItem` gains reward fields

**Files:**
- Modify: `backend/internal/service/order.go:26-35`

- [ ] **Step 1: Add the two fields to `OrderItem`**

In the `OrderItem` struct, after `IsBundle`:

```go
// OrderItem is one cart line submitted by the client.
type OrderItem struct {
	ProductID   string  `json:"productId"`
	ProductName string  `json:"productName"`
	VariantSize string  `json:"variantSize"`
	Price       float64 `json:"price"`
	Quantity    int     `json:"quantity"`
	Subtotal    float64 `json:"subtotal"`
	IsBundle    bool    `json:"isBundle"`
	// SP-CRM-9: a free loyalty reward line. IsReward marks a Rp0 giveaway line;
	// RewardConditionID is the product_reward condition it fulfills (validated at
	// commit). Request-only — not persisted to order_items.
	IsReward          bool   `json:"isReward"`
	RewardConditionID string `json:"rewardConditionId"`
}
```

- [ ] **Step 2: Build**

Run: `cd backend && go build ./...`
Expected: builds clean (new fields unused yet).

- [ ] **Step 3: Commit**

```bash
git add backend/internal/service/order.go
git commit -m "feat(crm): SP-CRM-9 add reward fields to OrderItem"
```

### Task A2: `ProductRewards` pure helper + tests

**Files:**
- Modify: `backend/internal/service/loyalty.go` (append helper)
- Modify: `backend/internal/service/loyalty_test.go` (append tests)

- [ ] **Step 1: Write the failing test**

Append to `backend/internal/service/loyalty_test.go`:

```go
func TestProductRewards(t *testing.T) {
	conds := []LoyaltyCondition{
		{ID: "c1", Name: "Ultah", Type: "always_on", Trigger: "birthday",
			RewardType: "product_reward", RewardValue: 1,
			RewardProductIDs: []string{"pA", "pB"}, IsActive: true},
		{ID: "c2", Name: "Set", Type: "always_on", Trigger: "birthday",
			RewardType: "set_points", RewardValue: 100, IsActive: true},
		{ID: "c3", Name: "Beli Kopi", Type: "always_on", Trigger: "product_purchase",
			RewardType: "product_reward", RewardValue: 1,
			ApplicableProductIDs: []string{"pX"}, RewardProductIDs: []string{"pC"}, IsActive: true},
	}
	bday := time.Date(1990, 5, 20, 0, 0, 0, 0, time.UTC)
	ctx := EvalContext{
		Total: 50000, ProductIDs: map[string]bool{"pZ": true}, // no pX → c3 no match
		SaleDate: time.Date(2026, 5, 20, 10, 0, 0, 0, wib),
		Customer: EvalCustomer{Birthday: &bday},
	}
	got := ProductRewards(conds, ctx)
	if len(got) != 1 {
		t.Fatalf("want 1 product_reward match, got %d", len(got))
	}
	if got[0].ConditionID != "c1" {
		t.Fatalf("want c1, got %s", got[0].ConditionID)
	}
	if len(got[0].RewardProductIDs) != 2 {
		t.Fatalf("want 2 menu products, got %d", len(got[0].RewardProductIDs))
	}
}
```

> `wib` is defined in `order.go` (same package). `time` is already imported by the test file's siblings; if not, add it.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/service/ -run TestProductRewards -v`
Expected: FAIL — `undefined: ProductRewards`.

- [ ] **Step 3: Implement the helper**

Append to `backend/internal/service/loyalty.go`:

```go
// ProductRewards returns the product_reward conditions that match this order,
// for the checkout fulfillment preview. Reuses the same matching the commit path
// uses (EvaluateLoyalty), so the preview and the authoritative grant agree.
func ProductRewards(conds []LoyaltyCondition, ctx EvalContext) []AppliedCondition {
	out := EvaluateLoyalty(conds, ctx)
	var rewards []AppliedCondition
	for _, a := range out.Applied {
		if a.RewardType == "product_reward" {
			rewards = append(rewards, a)
		}
	}
	return rewards
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && go test ./internal/service/ -run TestProductRewards -v`
Expected: PASS.

- [ ] **Step 5: Full engine suite still green**

Run: `cd backend && go test ./internal/service/`
Expected: ok (all 16+ existing tests pass).

- [ ] **Step 6: Commit**

```bash
git add backend/internal/service/loyalty.go backend/internal/service/loyalty_test.go
git commit -m "feat(crm): SP-CRM-9 ProductRewards engine helper for checkout preview"
```

### Task A3: Refactor `loadActiveConditions` to a `rowQuerier`

**Files:**
- Modify: `backend/internal/service/order.go:530-559`

- [ ] **Step 1: Introduce the interface and widen the signature**

Replace the `loadActiveConditions` signature + add the interface just above it:

```go
// rowQuerier is satisfied by both *pgxpool.Pool and pgx.Tx, so loadActiveConditions
// can run inside the order tx (commit) or directly on the pool (preview).
type rowQuerier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

// loadActiveConditions reads the active loyalty_conditions into the pure engine
// struct. Ordered (created_at, id) so multiply-tie attribution is deterministic.
func loadActiveConditions(ctx context.Context, q rowQuerier) ([]LoyaltyCondition, error) {
	rows, err := q.Query(ctx, `
		SELECT id, name, type, trigger, reward_type, reward_value,
		       COALESCE(reward_product_ids,'[]'::jsonb),
		       campaign_start_date, campaign_end_date,
		       COALESCE(active_days,'[]'::jsonb),
		       COALESCE(applicable_product_ids,'[]'::jsonb),
		       minimum_spend, is_active
		  FROM loyalty_conditions
		 WHERE is_active = true
		 ORDER BY created_at, id`)
```

Leave the rest of the function body (scan loop) unchanged. The existing call site `loadActiveConditions(ctx, tx)` still compiles (a `pgx.Tx` satisfies `rowQuerier`).

- [ ] **Step 2: Build + test**

Run: `cd backend && go build ./... && go test ./internal/service/`
Expected: builds + tests green (pure refactor).

- [ ] **Step 3: Commit**

```bash
git add backend/internal/service/order.go
git commit -m "refactor(crm): SP-CRM-9 loadActiveConditions accepts pool or tx"
```

### Task A4: Build the engine product-set from PAID items only

**Files:**
- Modify: `backend/internal/service/order.go:174-177`

- [ ] **Step 1: Exclude reward lines from the eval product set**

Replace the `pidSet` build inside the `if hasLoyaltyCustomer` block:

```go
		pidSet := make(map[string]bool, len(in.Items))
		for _, it := range in.Items {
			if it.IsReward {
				continue // a free reward item must not trigger more conditions
			}
			pidSet[it.ProductID] = true
		}
```

> Total/base are already reward-safe: reward lines are Rp0, so `Compute` leaves `res.Total`/`res.EarnedPoints` unchanged. Only the product set needs the guard.

- [ ] **Step 2: Build**

Run: `cd backend && go build ./...`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add backend/internal/service/order.go
git commit -m "feat(crm): SP-CRM-9 exclude reward lines from loyalty product set"
```

---

## Batch B — Backend commit: validated product_reward grants

### Task B1: Record product_reward grants only for validated reward lines

**Files:**
- Modify: `backend/internal/service/order.go:325-335` (the Applied-writing loop)
- Modify: `backend/internal/service/order.go` (add a `contains` helper near the bottom)

- [ ] **Step 1: Replace the Applied-writing loop**

Currently (inside `if hasLoyaltyCustomer {`):

```go
				// Audit: one row per matched condition (set/multiply/product_reward).
				for _, a := range outcome.Applied {
					if e := write.InsertConditionApplication(ctx, tx, write.ConditionApplicationRow{
						OrderID: orderID, CustomerID: in.CustomerID, ConditionID: a.ConditionID,
						ConditionName: a.Name, Trigger: a.Trigger, RewardType: a.RewardType,
						RewardValue: a.RewardValue, PointsContributed: a.PointsContributed,
						RewardProductIDs: a.RewardProductIDs,
					}); e != nil {
						return "", false, false, fmt.Errorf("record condition application: %w", e)
					}
				}
```

Replace with:

```go
				// Audit. set_points / multiply_points record on match (unchanged).
				// product_reward records ONLY when a validated reward line fulfills it
				// (SP-CRM-9 "actually received"); collect the matched menus for that.
				rewardMenu := make(map[string]AppliedCondition) // conditionID -> matched product_reward
				for _, a := range outcome.Applied {
					if a.RewardType == "product_reward" {
						rewardMenu[a.ConditionID] = a
						continue
					}
					if e := write.InsertConditionApplication(ctx, tx, write.ConditionApplicationRow{
						OrderID: orderID, CustomerID: in.CustomerID, ConditionID: a.ConditionID,
						ConditionName: a.Name, Trigger: a.Trigger, RewardType: a.RewardType,
						RewardValue: a.RewardValue, PointsContributed: a.PointsContributed,
						RewardProductIDs: a.RewardProductIDs,
					}); e != nil {
						return "", false, false, fmt.Errorf("record condition application: %w", e)
					}
				}
				// One validated grant per reward line; ≤1 per condition (also enforced
				// by UNIQUE(order_id, condition_id)). Invalid lines are dropped + logged
				// (lenient — the staff POS already trusts client item prices).
				seenReward := make(map[string]bool)
				for _, it := range in.Items {
					if !it.IsReward {
						continue
					}
					a, ok := rewardMenu[it.RewardConditionID]
					if !ok || seenReward[it.RewardConditionID] || !contains(a.RewardProductIDs, it.ProductID) {
						slog.Warn("dropping unfulfillable reward line from audit",
							"order_id", orderID, "condition_id", it.RewardConditionID, "product_id", it.ProductID)
						continue
					}
					seenReward[it.RewardConditionID] = true
					if e := write.InsertConditionApplication(ctx, tx, write.ConditionApplicationRow{
						OrderID: orderID, CustomerID: in.CustomerID, ConditionID: a.ConditionID,
						ConditionName: a.Name, Trigger: a.Trigger, RewardType: "product_reward",
						RewardValue: a.RewardValue, PointsContributed: 0,
						RewardProductIDs: []string{it.ProductID}, // the CHOSEN product
					}); e != nil {
						return "", false, false, fmt.Errorf("record reward fulfillment: %w", e)
					}
				}
```

- [ ] **Step 2: Add the `contains` helper**

Add near the other small helpers at the bottom of `order.go` (after `nullBytes`):

```go
func contains(ids []string, id string) bool {
	for _, v := range ids {
		if v == id {
			return true
		}
	}
	return false
}
```

- [ ] **Step 3: Build + existing tests**

Run: `cd backend && go build ./... && go test ./internal/service/`
Expected: clean + green.

- [ ] **Step 4: Commit**

```bash
git add backend/internal/service/order.go
git commit -m "feat(crm): SP-CRM-9 record product_reward grant only for validated reward line"
```

### Task B2: Pure validation table test

**Files:**
- Create: `backend/internal/service/loyalty_preview_test.go`

- [ ] **Step 1: Write the test for `contains` semantics**

```go
package service

import "testing"

func TestContains(t *testing.T) {
	cases := []struct {
		name string
		ids  []string
		id   string
		want bool
	}{
		{"present", []string{"a", "b"}, "b", true},
		{"absent", []string{"a", "b"}, "c", false},
		{"empty menu", nil, "a", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := contains(c.ids, c.id); got != c.want {
				t.Fatalf("contains(%v,%q)=%v want %v", c.ids, c.id, got, c.want)
			}
		})
	}
}
```

- [ ] **Step 2: Run**

Run: `cd backend && go test ./internal/service/ -run TestContains -v`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add backend/internal/service/loyalty_preview_test.go
git commit -m "test(crm): SP-CRM-9 reward-line validation helper"
```

---

## Batch C — Backend preview endpoint

### Task C1: `PreviewRewards` service method

**Files:**
- Create: `backend/internal/service/loyalty_preview.go`

- [ ] **Step 1: Implement the preview**

```go
package service

import (
	"context"
	"fmt"
	"time"
)

// RewardPreviewVariant is one sellable size of a reward product (price is the
// normal price, shown struck-through; the cashier gives it for Rp0).
type RewardPreviewVariant struct {
	Size  string  `json:"size"`
	Price float64 `json:"price"`
}

// RewardPreviewProduct is one eligible free product with its sizes.
type RewardPreviewProduct struct {
	ID       string                 `json:"id"`
	Name     string                 `json:"name"`
	Variants []RewardPreviewVariant `json:"variants"`
}

// RewardPreview is one matched product_reward condition + its pick menu.
type RewardPreview struct {
	ConditionID   string                 `json:"conditionId"`
	ConditionName string                 `json:"conditionName"`
	Products      []RewardPreviewProduct `json:"products"`
}

// PreviewRewards evaluates the active product_reward conditions for this cart +
// customer and returns the eligible free-item menus. Read-only, online-only,
// advisory: CreateOrder re-evaluates authoritatively at commit. total is the
// client-computed cart total (for the spending_threshold trigger).
func (s *OrderService) PreviewRewards(ctx context.Context, customerID string, items []OrderItem, total float64, clientCreated *time.Time) ([]RewardPreview, error) {
	if customerID == "" {
		return nil, nil
	}
	loyEnabled, pointsPerK, _, err := loadLoyalty(ctx, poolQuerier{s.Pool})
	if err != nil {
		return nil, fmt.Errorf("load loyalty: %w", err)
	}
	if !loyEnabled {
		return nil, nil
	}
	var cust EvalCustomer
	if e := s.Pool.QueryRow(ctx,
		`SELECT birthday, anniversary, visit_count FROM customers WHERE id=$1`,
		customerID).Scan(&cust.Birthday, &cust.Anniversary, &cust.VisitCount); e != nil {
		return nil, fmt.Errorf("load customer: %w", e)
	}
	conds, err := loadActiveConditions(ctx, s.Pool)
	if err != nil {
		return nil, err
	}
	pidSet := make(map[string]bool, len(items))
	for _, it := range items {
		if it.IsReward {
			continue
		}
		pidSet[it.ProductID] = true
	}
	saleTime := time.Now()
	if clientCreated != nil {
		saleTime = *clientCreated
	}
	rewards := ProductRewards(conds, EvalContext{
		Total:      total,
		BasePoints: int(total/1000) * int(pointsPerK),
		ProductIDs: pidSet,
		SaleDate:   saleTime.In(wib),
		Customer:   cust,
	})
	if len(rewards) == 0 {
		return nil, nil
	}
	out := make([]RewardPreview, 0, len(rewards))
	for _, r := range rewards {
		products, e := s.rewardProductMenu(ctx, r.RewardProductIDs)
		if e != nil {
			return nil, e
		}
		if len(products) == 0 {
			continue // every listed product is gone/unsellable — skip the reward
		}
		out = append(out, RewardPreview{
			ConditionID: r.ConditionID, ConditionName: r.Name, Products: products,
		})
	}
	return out, nil
}

// rewardProductMenu resolves product ids → {name, sellable variants}. Drops
// products with no variants (nothing to give) and missing products.
func (s *OrderService) rewardProductMenu(ctx context.Context, ids []string) ([]RewardPreviewProduct, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	rows, err := s.Pool.Query(ctx, `
		SELECT p.id, p.name, v.size, v.price
		  FROM products p
		  JOIN product_variants v ON v.product_id = p.id
		 WHERE p.id = ANY($1)
		 ORDER BY p.name, v.price`, ids)
	if err != nil {
		return nil, fmt.Errorf("load reward products: %w", err)
	}
	defer rows.Close()
	byID := make(map[string]*RewardPreviewProduct)
	var order []string
	for rows.Next() {
		var pid, name, size string
		var price float64
		if e := rows.Scan(&pid, &name, &size, &price); e != nil {
			return nil, fmt.Errorf("scan reward product: %w", e)
		}
		p, ok := byID[pid]
		if !ok {
			p = &RewardPreviewProduct{ID: pid, Name: name}
			byID[pid] = p
			order = append(order, pid)
		}
		p.Variants = append(p.Variants, RewardPreviewVariant{Size: size, Price: price})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := make([]RewardPreviewProduct, 0, len(order))
	for _, id := range order {
		out = append(out, *byID[id])
	}
	return out, nil
}

// poolQuerier adapts *pgxpool.Pool to the QueryRow-based loadLoyalty signature.
type poolQuerier struct{ p interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgxRow
} }
```

> **Note for the implementer:** `loadLoyalty` (order.go:520) currently takes `pgx.Tx`. To call it from the pool, widen it the same way as `loadActiveConditions`: change its parameter to a small interface both satisfy. Do that in the next step instead of the `poolQuerier` shim above — delete the `poolQuerier` type and call `loadLoyalty(ctx, s.Pool)` directly once the signature is widened.

- [ ] **Step 2: Widen `loadLoyalty` to accept pool or tx**

In `order.go`, change `loadLoyalty`:

```go
type rowQueryRower interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

func loadLoyalty(ctx context.Context, q rowQueryRower) (bool, float64, float64, error) {
	var en bool
	var ppk, rate float64
	err := q.QueryRow(ctx,
		`SELECT enabled, points_per_thousand, redemption_rate
		   FROM loyalty_settings WHERE id=1`).
		Scan(&en, &ppk, &rate)
	return en, ppk, rate, err
}
```

Both `*pgxpool.Pool` and `pgx.Tx` satisfy `rowQueryRower`. The existing call `loadLoyalty(ctx, tx)` still compiles. In `loyalty_preview.go`, delete the `poolQuerier` shim and the `pgxRow` reference; call `loadLoyalty(ctx, s.Pool)`.

- [ ] **Step 3: Build**

Run: `cd backend && go build ./...`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add backend/internal/service/loyalty_preview.go backend/internal/service/order.go
git commit -m "feat(crm): SP-CRM-9 PreviewRewards service (eligible free-item menus)"
```

### Task C2: OpenAPI schemas + path + regen

**Files:**
- Modify: `backend/api/openapi.yaml`

- [ ] **Step 1: Add reward fields to `OrderItemInput` and `CartItem`**

In `OrderItemInput` (openapi.yaml:1339) after `isBundle`:

```yaml
        isBundle: { type: boolean }
        isReward: { type: boolean }
        rewardConditionId: { type: string }
```

In `CartItem` (openapi.yaml:963) after `isBundle`:

```yaml
        isBundle: { type: boolean }
        isReward: { type: boolean }
        rewardConditionId: { type: string }
```

- [ ] **Step 2: Add the preview schemas**

Add to `components.schemas` (next to the other Loyalty schemas):

```yaml
    LoyaltyPreviewVariant:
      type: object
      required: [size, price]
      properties:
        size: { type: string }
        price: { type: number }
    LoyaltyPreviewProduct:
      type: object
      required: [id, name, variants]
      properties:
        id: { type: string }
        name: { type: string }
        variants:
          type: array
          items: { $ref: '#/components/schemas/LoyaltyPreviewVariant' }
    LoyaltyPreviewReward:
      type: object
      required: [conditionId, conditionName, products]
      properties:
        conditionId: { type: string }
        conditionName: { type: string }
        products:
          type: array
          items: { $ref: '#/components/schemas/LoyaltyPreviewProduct' }
    LoyaltyPreviewRequest:
      type: object
      required: [customerId, items, total]
      properties:
        customerId: { type: string }
        total: { type: number }
        clientCreatedAt: { type: string, nullable: true }
        items:
          type: array
          items: { $ref: '#/components/schemas/OrderItemInput' }
    LoyaltyPreviewResponse:
      type: object
      required: [data]
      properties:
        data:
          type: array
          items: { $ref: '#/components/schemas/LoyaltyPreviewReward' }
```

- [ ] **Step 3: Add the path**

Under `paths`, next to the other `/sync/...` paths:

```yaml
  /api/v1/sync/loyalty-preview:
    post:
      operationId: loyaltyPreview
      summary: Eligible product_reward free-item menus for a cart + customer (online preview).
      security: [{ bearerAuth: [] }]
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/LoyaltyPreviewRequest' }
      responses:
        '200':
          description: matched rewards (possibly empty)
          content:
            application/json:
              schema: { $ref: '#/components/schemas/LoyaltyPreviewResponse' }
```

> Match the exact `security` scheme name used by the other authed paths in this file (grep for `bearerAuth` / `security:` and copy the existing form).

- [ ] **Step 4: Regen + gen-check**

```bash
cd backend && go tool oapi-codegen -config api/oapi-codegen.yaml api/openapi.yaml
cd .. && corepack pnpm --filter @mandalika/api gen
cd backend && go build ./... && make gen-check
```
Expected: regenerates `api.gen.go` + the TS schema; `make gen-check` clean.

- [ ] **Step 5: Commit**

```bash
git add backend/api/openapi.yaml backend/internal/api/api.gen.go packages/api/src/schema.d.ts
git commit -m "feat(crm): SP-CRM-9 OpenAPI — reward item fields + loyalty-preview"
```

### Task C3: Handler + route

**Files:**
- Modify: `backend/internal/handlers/writes.go` (add handler near `CreateOrder`)
- Modify: `backend/internal/server/server.go:135` (register route)

- [ ] **Step 1: Add the handler**

In `writes.go`, after `CreateOrder` (and its `createOrderBody`), add:

```go
type loyaltyPreviewBody struct {
	CustomerID      string              `json:"customerId"`
	Total           float64             `json:"total"`
	ClientCreatedAt *time.Time          `json:"clientCreatedAt"`
	Items           []service.OrderItem `json:"items"`
}

// LoyaltyPreview returns the product_reward free-item menus a customer qualifies
// for on the current cart (online-only checkout preview; read-only).
func (h *Handlers) LoyaltyPreview(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeWrite[loyaltyPreviewBody](w, r)
	if !ok {
		return
	}
	if body.CustomerID == "" {
		httpx.Err(w, http.StatusBadRequest, "customerId required")
		return
	}
	rewards, err := h.OrderSvc.PreviewRewards(r.Context(), body.CustomerID, body.Items, body.Total, body.ClientCreatedAt)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	out := make([]api.LoyaltyPreviewReward, 0, len(rewards))
	for _, r := range rewards {
		products := make([]api.LoyaltyPreviewProduct, 0, len(r.Products))
		for _, p := range r.Products {
			vs := make([]api.LoyaltyPreviewVariant, 0, len(p.Variants))
			for _, v := range p.Variants {
				vs = append(vs, api.LoyaltyPreviewVariant{Size: v.Size, Price: v.Price})
			}
			products = append(products, api.LoyaltyPreviewProduct{ID: p.ID, Name: p.Name, Variants: vs})
		}
		out = append(out, api.LoyaltyPreviewReward{
			ConditionId: r.ConditionID, ConditionName: r.ConditionName, Products: products,
		})
	}
	httpx.JSON(w, http.StatusOK, api.LoyaltyPreviewResponse{Data: out})
}
```

> Confirm the generated field names (`ConditionId` vs `ConditionID`, `Data`) against `api.gen.go` after C2 regen and adjust. Confirm `httpx.JSON(w, status, payload)` is the helper used elsewhere (grep `httpx.JSON(` in handlers); match its exact signature.

- [ ] **Step 2: Register the route**

In `server.go`, in the authenticated cashier group right after line 135 (`r.Get("/sync/customers/lookup", h.CustomersLookup)`):

```go
			r.Get("/sync/customers/lookup", h.CustomersLookup)
			r.Post("/sync/loyalty-preview", h.LoyaltyPreview)
```

- [ ] **Step 3: Build**

Run: `cd backend && go build ./...`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add backend/internal/handlers/writes.go backend/internal/server/server.go
git commit -m "feat(crm): SP-CRM-9 POST /sync/loyalty-preview handler + route"
```

---

## Batch D — POS

### Task D1: API client `loyaltyPreview`

**Files:**
- Modify: `packages/api/src/client.ts` (type export ~line 66; interface ~line 188; impl ~line 477)

- [ ] **Step 1: Add the type export**

Near the other `S[...]` type exports (e.g. after `RewardGrant`):

```ts
export type LoyaltyPreviewReward = S['LoyaltyPreviewReward']
```

- [ ] **Step 2: Add to the client interface**

Near `listRewardGrants` (~line 188):

```ts
  loyaltyPreview: (
    customerId: string,
    items: CartItem[],
    total: number,
    clientCreatedAt?: string,
  ) => Promise<LoyaltyPreviewReward[]>
```

> If `CartItem` isn't already imported in this file, add `type CartItem = S['CartItem']` with the other type aliases.

- [ ] **Step 3: Add the implementation**

Near the `lookupCustomers` impl (~line 438):

```ts
    loyaltyPreview: (customerId, items, total, clientCreatedAt) =>
      data<LoyaltyPreviewReward[]>('POST', `${API}/sync/loyalty-preview`, {
        customerId,
        items,
        total,
        ...(clientCreatedAt ? { clientCreatedAt } : {}),
      }),
```

- [ ] **Step 4: Typecheck**

Run: `corepack pnpm --filter @mandalika/api build` (or the package's typecheck script; grep `package.json` `scripts`).
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/client.ts
git commit -m "feat(crm): SP-CRM-9 api.loyaltyPreview client method"
```

### Task D2: Cart reducer reward actions + tests

**Files:**
- Modify: `apps/pos/src/cashier/state/cashierReducer.ts`
- Create: `apps/pos/src/cashier/state/cashierReducer.test.ts`

- [ ] **Step 1: Write failing tests**

Create `apps/pos/src/cashier/state/cashierReducer.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { cashierReducer, CASHIER_INITIAL_STATE } from './cashierReducer'
import type { components } from '@mandalika/api'

type CartItem = components['schemas']['CartItem']
type Customer = components['schemas']['Customer']

const paid = (productId: string, variantSize = 'M'): CartItem => ({
  productId, productName: 'P', variantSize, price: 10000, quantity: 1, subtotal: 10000,
})
const reward = (productId: string, conditionId: string): CartItem => ({
  productId, productName: 'Free', variantSize: 'M', price: 0, quantity: 1, subtotal: 0,
  isReward: true, rewardConditionId: conditionId,
})

describe('cashierReducer reward lines', () => {
  it('adds a reward line without merging into a paid line of the same product', () => {
    let s = cashierReducer(CASHIER_INITIAL_STATE, { type: 'CART_ADD_ITEM', item: paid('pA') })
    s = cashierReducer(s, { type: 'CART_ADD_REWARD', item: reward('pA', 'c1') })
    expect(s.cart).toHaveLength(2)
    expect(s.cart.filter((c) => c.isReward)).toHaveLength(1)
  })

  it('replaces the reward line when the same condition is re-picked', () => {
    let s = cashierReducer(CASHIER_INITIAL_STATE, { type: 'CART_ADD_REWARD', item: reward('pA', 'c1') })
    s = cashierReducer(s, { type: 'CART_ADD_REWARD', item: reward('pB', 'c1') })
    const rewards = s.cart.filter((c) => c.isReward)
    expect(rewards).toHaveLength(1)
    expect(rewards[0].productId).toBe('pB')
  })

  it('removes a reward line by condition', () => {
    let s = cashierReducer(CASHIER_INITIAL_STATE, { type: 'CART_ADD_REWARD', item: reward('pA', 'c1') })
    s = cashierReducer(s, { type: 'CART_REMOVE_REWARD', rewardConditionId: 'c1' })
    expect(s.cart.filter((c) => c.isReward)).toHaveLength(0)
  })

  it('adding the same paid product twice still merges (reward guard does not break paid upsert)', () => {
    let s = cashierReducer(CASHIER_INITIAL_STATE, { type: 'CART_ADD_ITEM', item: paid('pA') })
    s = cashierReducer(s, { type: 'CART_ADD_ITEM', item: paid('pA') })
    expect(s.cart.filter((c) => !c.isReward)).toHaveLength(1)
    expect(s.cart[0].quantity).toBe(2)
  })

  it('drops reward lines when the customer changes', () => {
    let s = cashierReducer(CASHIER_INITIAL_STATE, { type: 'CART_ADD_REWARD', item: reward('pA', 'c1') })
    s = cashierReducer(s, { type: 'SET_CUSTOMER', customer: null })
    expect(s.cart.filter((c) => c.isReward)).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `corepack pnpm --filter @mandalika/pos test -- cashierReducer`
Expected: FAIL — `CART_ADD_REWARD` not handled / type errors.

- [ ] **Step 3: Implement**

In `cashierReducer.ts`:

(a) Add to the `CashierAction` union:

```ts
  | { type: 'CART_ADD_REWARD'; item: CartItem }
  | { type: 'CART_REMOVE_REWARD'; rewardConditionId: string }
```

(b) Guard `upsertCartItem` so a paid add never merges into a reward line:

```ts
  const idx = cart.findIndex(
    (c) =>
      c.productId === item.productId &&
      c.variantSize === item.variantSize &&
      !c.isReward,
  )
```

(c) Add the cases (near `CART_ADD_ITEM`):

```ts
    case 'CART_ADD_REWARD': {
      // One free line per condition; re-picking replaces it. Never merges with paid.
      const without = state.cart.filter(
        (c) => !(c.isReward && c.rewardConditionId === action.item.rewardConditionId),
      )
      return { ...state, cart: [...without, action.item] }
    }

    case 'CART_REMOVE_REWARD':
      return {
        ...state,
        cart: state.cart.filter(
          (c) => !(c.isReward && c.rewardConditionId === action.rewardConditionId),
        ),
      }
```

(d) Guard paid `CART_REMOVE_ITEM` and `CART_SET_QTY` filters/maps so they ignore reward lines — append `&& !c.isReward` to the productId/variantSize match in both (e.g. `c.productId === action.productId && c.variantSize === action.variantSize && !c.isReward`).

(e) Drop reward lines on customer change in `SET_CUSTOMER`:

```ts
    case 'SET_CUSTOMER':
      return {
        ...state,
        selectedCustomer: action.customer,
        customerSearch: action.customer ? '' : state.customerSearch,
        pointsToRedeem: 0,
        cart: state.cart.filter((c) => !c.isReward),
      }
```

- [ ] **Step 4: Run to verify pass**

Run: `corepack pnpm --filter @mandalika/pos test -- cashierReducer`
Expected: PASS (all 5).

- [ ] **Step 5: Commit**

```bash
git add apps/pos/src/cashier/state/cashierReducer.ts apps/pos/src/cashier/state/cashierReducer.test.ts
git commit -m "feat(crm): SP-CRM-9 cart reducer reward-line actions + tests"
```

### Task D3: CheckoutPanel "Hadiah Loyalti" section

**Files:**
- Modify: `apps/pos/src/cashier/CheckoutPanel.tsx`

- [ ] **Step 1: Extend props**

Add to `CheckoutPanelProps` (after `customerPoints`):

```ts
  rewards: import('@mandalika/api').components['schemas']['LoyaltyPreviewReward'][]
  rewardsLoading: boolean
  pickedRewards: Record<string, { productId: string; variantSize: string }>
  onPickReward: (
    conditionId: string,
    product: { id: string; name: string },
    variant: { size: string; price: number },
  ) => void
  onClearReward: (conditionId: string) => void
```

> Prefer a top-of-file `type LoyaltyPreviewReward = components['schemas']['LoyaltyPreviewReward']` alias (the file already imports `components`) and use it in the prop type.

Add the new names to the destructured params in the function signature.

- [ ] **Step 2: Render the section**

Immediately above the `{/* Loyalty redemption */}` block, add:

```tsx
          {/* Loyalty product rewards (online-only) */}
          {loyaltyEnabled && selectedCustomer && (rewardsLoading || rewards.length > 0) && (
            <div>
              <p className="text-xs font-semibold text-gray-700 mb-2">
                🎁 Hadiah Loyalti
              </p>
              {rewardsLoading && (
                <p className="text-[11px] text-gray-400">Memeriksa hadiah…</p>
              )}
              <div className="space-y-3">
                {rewards.map((rw) => {
                  const picked = pickedRewards[rw.conditionId]
                  return (
                    <div key={rw.conditionId} className="border border-amber-200 bg-amber-50 rounded-xl p-3">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold text-amber-800">{rw.conditionName}</span>
                        {picked && (
                          <button
                            type="button"
                            onClick={() => onClearReward(rw.conditionId)}
                            className="text-[11px] text-amber-700 underline"
                          >
                            Batalkan
                          </button>
                        )}
                      </div>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {rw.products.flatMap((p) =>
                          p.variants.map((v) => {
                            const isSel = picked?.productId === p.id && picked?.variantSize === v.size
                            return (
                              <button
                                key={`${p.id}-${v.size}`}
                                type="button"
                                onClick={() => onPickReward(rw.conditionId, { id: p.id, name: p.name }, v)}
                                className={`px-2.5 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
                                  isSel
                                    ? 'border-amber-500 bg-amber-600 text-white'
                                    : 'border-amber-200 bg-white text-amber-800 hover:bg-amber-100'
                                }`}
                              >
                                {p.name}
                                {v.size ? ` · ${v.size}` : ''}
                              </button>
                            )
                          }),
                        )}
                      </div>
                      {picked && (
                        <p className="mt-1.5 text-[11px] font-semibold text-green-600">GRATIS ✓</p>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}
```

- [ ] **Step 3: Typecheck/build**

Run: `corepack pnpm --filter @mandalika/pos exec tsc -b`
Expected: fails only at the call site (CashierScreen not yet passing the new props) — that's fixed in D4. If you want a clean gate, do D4 before building.

- [ ] **Step 4: Commit**

```bash
git add apps/pos/src/cashier/CheckoutPanel.tsx
git commit -m "feat(crm): SP-CRM-9 CheckoutPanel Hadiah Loyalti section"
```

### Task D4: CashierScreen wiring (preview fetch + handlers + props)

**Files:**
- Modify: `apps/pos/src/cashier/CashierScreen.tsx`

- [ ] **Step 1: Add reward state + preview fetch**

Near the other `useState`/hooks (after the customer-lookup effect ~line 123), add:

```tsx
  const [rewards, setRewards] = useState<
    import('@mandalika/api').components['schemas']['LoyaltyPreviewReward'][]
  >([])
  const [rewardsLoading, setRewardsLoading] = useState(false)

  useEffect(() => {
    if (
      !state.isCheckoutOpen ||
      !loyalty.enabled ||
      !state.selectedCustomer ||
      !offlineData.isOnline
    ) {
      setRewards([])
      return
    }
    let ignore = false
    setRewardsLoading(true)
    api
      .loyaltyPreview(state.selectedCustomer.id, state.cart, derived.total)
      .then((r) => {
        if (!ignore) setRewards(r)
      })
      .catch(() => {
        if (!ignore) setRewards([])
      })
      .finally(() => {
        if (!ignore) setRewardsLoading(false)
      })
    return () => {
      ignore = true
    }
    // Fetch once when the panel opens; the cart is final at checkout. Re-picking a
    // reward must not refetch, so cart/derived.total are intentionally excluded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.isCheckoutOpen, loyalty.enabled, state.selectedCustomer, offlineData.isOnline])
```

> Use the existing `state.selectedCustomer` object identity; it's stable while the panel is open. Confirm `derived` and `api` are in scope here (they are — `derived` is used in `handleConfirmPayment`, `api` in the lookup effect).

- [ ] **Step 2: Derive picked rewards + pick/clear handlers**

Add near `handleCheckout`:

```tsx
  const pickedRewards = useMemo(() => {
    const m: Record<string, { productId: string; variantSize: string }> = {}
    for (const c of state.cart) {
      if (c.isReward && c.rewardConditionId) {
        m[c.rewardConditionId] = { productId: c.productId, variantSize: c.variantSize }
      }
    }
    return m
  }, [state.cart])

  const handlePickReward = (
    conditionId: string,
    product: { id: string; name: string },
    variant: { size: string; price: number },
  ) => {
    dispatch({
      type: 'CART_ADD_REWARD',
      item: {
        productId: product.id,
        productName: product.name,
        variantSize: variant.size,
        price: 0,
        quantity: 1,
        subtotal: 0,
        isReward: true,
        rewardConditionId: conditionId,
      },
    })
  }

  const handleClearReward = (conditionId: string) =>
    dispatch({ type: 'CART_REMOVE_REWARD', rewardConditionId: conditionId })
```

> `useMemo` — ensure it's in the React import (`import { useState, useEffect, useMemo, ... } from 'react'`).

- [ ] **Step 3: Pass props to CheckoutPanel**

In the `<CheckoutPanel ... />` JSX (~line 752), add:

```tsx
        rewards={rewards}
        rewardsLoading={rewardsLoading}
        pickedRewards={pickedRewards}
        onPickReward={handlePickReward}
        onClearReward={handleClearReward}
```

- [ ] **Step 4: Build both apps**

Run: `corepack pnpm --filter @mandalika/pos exec tsc -b && corepack pnpm --filter @mandalika/pos build`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add apps/pos/src/cashier/CashierScreen.tsx
git commit -m "feat(crm): SP-CRM-9 checkout preview fetch + reward pick/clear wiring"
```

### Task D5: "GRATIS" labels in Cart + Receipt

**Files:**
- Modify: `apps/pos/src/cashier/Cart.tsx`
- Modify: `apps/pos/src/cashier/ReceiptPreview.tsx`

- [ ] **Step 1: Cart — mark reward lines, hide qty stepper**

Read `Cart.tsx`; for each rendered line, when `item.isReward` is true: render a small green "GRATIS" badge instead of the price, and render the line without the quantity +/- controls and without the normal remove (reward lines are cleared from the CheckoutPanel "Batalkan"). Keep it minimal — a conditional branch on `item.isReward`. (Exact JSX depends on the file; match its existing line markup.)

- [ ] **Step 2: Receipt — show GRATIS for reward lines**

In `ReceiptPreview.tsx`, where each line renders its amount, show `GRATIS` when the line is a reward (amount 0 + reward). If the receipt `lines` mapping (CashierScreen `handleConfirmPayment` ~line 437) doesn't carry `isReward`, add `isReward: i.isReward` to the mapped line object and to the `ReceiptData` line type, then branch on it in `ReceiptPreview`.

- [ ] **Step 3: Build**

Run: `corepack pnpm --filter @mandalika/pos exec tsc -b && corepack pnpm --filter @mandalika/pos build`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/pos/src/cashier/Cart.tsx apps/pos/src/cashier/ReceiptPreview.tsx apps/pos/src/cashier/CashierScreen.tsx
git commit -m "feat(crm): SP-CRM-9 GRATIS labels for reward lines (cart + receipt)"
```

---

## Batch E — Verify, deploy, e2e, rollout

### Task E1: Full local gate

- [ ] **Step 1: Backend**

Run: `cd backend && go build ./... && go test ./... && make gen-check`
Expected: build clean, tests green, gen-check clean.

- [ ] **Step 2: Frontend**

Run: `corepack pnpm --filter @mandalika/pos exec tsc -b && corepack pnpm --filter @mandalika/pos build && corepack pnpm --filter @mandalika/pos test`
Expected: typecheck + build + reducer tests clean.

### Task E2: Deploy backend + smoke the preview endpoint

- [ ] **Step 1: Deploy**

```bash
cd backend && gcloud run deploy mandalika-pos --source backend --region asia-southeast2 --quiet
```
Then confirm `/readyz` is ok. Record the new revision.

- [ ] **Step 2: Authed smoke (online preview)**

Using `admin@mandalika.test` + `SEED_ADMIN_PASSWORD` (pull via gcloud secret command-substitution; never print): `POST /api/v1/sync/loyalty-preview` with a cart that should match an active `product_reward` condition for a known customer → expect `{data:[{conditionId, conditionName, products:[{id,name,variants:[...]}]}]}`. Also: missing `customerId` → 400; no token → 401; loyalty disabled → empty `data`.

> If no `product_reward` condition exists in the test env, create one in the backoffice first (or via the conditions CRUD) so the preview returns a non-empty menu.

### Task E3: Live e2e — fulfillment, audit, stock, refund, idempotency

**Files:**
- Create (throwaway): `backend/cmd/sp9e2e/main.go`

- [ ] **Step 1: Write the throwaway e2e**

A `cmd/sp9e2e` that, against the prod DB via `DATABASE_URL` (gcloud secret substitution), using the REAL `service.OrderService`:
1. Briefly toggles `loyalty_settings.enabled=true` (defer-restore to its prior value).
2. Ensures a `product_reward` condition (e.g. `first_registration` or `birthday`) is active with `reward_product_ids=[someRealProductID]`.
3. Creates a customer that triggers it; builds `CreateOrderInput` whose `Items` include a paid line **and** a reward line `{IsReward:true, RewardConditionID:<cond>, ProductID:<reward product>, VariantSize:<real size>, Price:0, Quantity:1, Subtotal:0}`.
4. Calls `CreateOrder` and asserts: order created; the reward line decremented that product/size stock; **one `loyalty_condition_applications` row** for the condition with `reward_product_ids=[<reward product>]`, `reward_type='product_reward'`, `points_contributed=0`; `orders.points_earned` equals the base (free item added 0); a `set_points`/`multiply` grant (if any matched) still recorded.
5. **Invalid-line drop:** repeat with a reward line whose `ProductID` is NOT in the menu → assert NO grant row, sale still succeeds, `slog.Warn` emitted.
6. **Replay:** call `CreateOrder` again with the same `IdempotencyKey` → no duplicate order/grant/stock change.
7. **Refund:** refund the order → the reward product's stock is restored; grant row remains (immutable).
8. Restore `loyalty_settings.enabled` to its prior value; DELETE every artifact created (order_items, processed_keys, loyalty_condition_applications, point_transactions, orders, customer); verify zero SP-CRM-9 leftovers + loyalty back to its prior state.

- [ ] **Step 2: Run it**

Run: `cd backend && go run ./cmd/sp9e2e` (DATABASE_URL via gcloud secret substitution).
Expected: all assertions pass; cleanup confirmed; loyalty restored.

- [ ] **Step 3: Delete the throwaway + commit**

```bash
git rm -r backend/cmd/sp9e2e
git commit -m "test(crm): SP-CRM-9 live e2e (fulfillment/audit/stock/refund/idempotency) — verified, removed"
```

### Task E4: Build APK + roll out

- [ ] **Step 1: Trigger the Android release**

Trigger GH Actions `android-release.yml`; on success note the `mandalika-pos-release-apk` artifact.

- [ ] **Step 2: Record USER-PENDING rollout**

This is USER-PENDING (install + on-device check + fleet rollout). On-device acceptance: online + loyalty customer + a matching `product_reward` condition → checkout shows "Hadiah Loyalti"; picking a product adds a GRATIS line; confirming the sale hands over the free item, decrements its stock, and the backoffice "Reward Produk" shows the chosen product. Offline → no reward section (no degradation).

### Task E5: Update handoff + memory

- [ ] **Step 1: Update `SESSION_HANDOFF.md`** with a new ⭐ LATEST SESSION (SP-CRM-9): what shipped, the new endpoint, the engine-recording change (product_reward now records only on validated fulfillment), no-migration note, the deployed revision + APK run, and the USER-PENDING on-device rollout.

- [ ] **Step 2: Update memory** `crm-customers-module.md` + `MEMORY.md`: SP-CRM-9 DONE (product_reward POS fulfillment, online-only, pick-one, grant=received); remaining = SP-CRM-Merge + the deferred offline reward eval.

- [ ] **Step 3: Commit**

```bash
git add SESSION_HANDOFF.md
git commit -m "docs: SP-CRM-9 done — product_reward POS fulfillment (rev <NEW>, APK <run>)"
```

---

## Self-Review (completed during authoring)

**Spec coverage:** preview endpoint (C1–C3) ✓; checkout "Hadiah Loyalti" + Rp0 line (D2–D4) ✓; commit validation + chosen-product grant replacing auto-record (B1, A4) ✓; paid-only eval safeguard (A4) ✓; lenient drop (B1) ✓; no migration / reuse `reward_product_ids` (B1) ✓; "GRATIS" receipt label (D5) ✓; OpenAPI/types (C2, D1) ✓; e2e same protocol as SP-CRM-7/8 (E3) ✓; APK + rollout (E4) ✓.

**Placeholder scan:** D5 intentionally describes edits against file markup not shown here (Cart/Receipt vary); every code-bearing task has concrete code. The `loadLoyalty`-widening note in C1 is resolved into a concrete step (C1 Step 2). No TBD/TODO.

**Type consistency:** `IsReward`/`RewardConditionID` (Go) ↔ `isReward`/`rewardConditionId` (JSON/TS) consistent; `ProductRewards`, `PreviewRewards`, `RewardPreview*`, `contains`, `rowQuerier`/`rowQueryRower`, `CART_ADD_REWARD`/`CART_REMOVE_REWARD`, `loyaltyPreview`, `LoyaltyPreviewReward` used consistently across tasks. Generated Go field casing (`ConditionId`/`Data`) flagged to verify post-regen in C3.

**Open verification points (flagged inline, not gaps):** exact generated field names after C2 regen; `httpx.JSON` signature; the `bearerAuth` security scheme name in openapi.yaml; Cart/Receipt existing markup.
