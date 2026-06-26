# SP-Promo-3b Reward Fulfillment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a separate-set `buy_x_get_y` promo a reward giveaway — when the cart's paid buy-set units meet the criteria, applying the promo auto-adds the configured Y reward line(s) (free or reduced price), with a picker modal for multiple choices; server re-derives entitlement and hard-rejects bogus lines; honored rewards are recorded in a `promo_reward_grants` audit table.

**Architecture:** Reuse the SP-CRM-9 reward-line machinery (request-only `isReward` line, server validation, stock, refund) but keyed to a promotion via a new request-only `rewardPromotionId`. Pricing for separate-set `buy_x_get_y` moves from `calcBXGY` discount to the reward line's reduced price (so `calcPromoDiscount` returns 0 for separate-set; same-set keeps `calcBXGY`). Server is authoritative: it recomputes entitlement from paid lines and writes one immutable grant row per honored reward line.

**Tech Stack:** Go (service + pgx), Postgres (migration 0039), TypeScript (POS reducer/PromoPanel/modal + vitest), React (backoffice), OpenAPI (oapi-codegen + openapi-typescript).

## Global Constraints

- Branch `prod-hardening`. Conventional commits; **no attribution trailer**.
- Behavior forks on `bxgyConfig.getProductIds`: empty → **same-set** (unchanged `calcBXGY` in-place discount); non-empty → **separate-set** (reward fulfillment).
- Eligibility (separate-set) = paid buy-set units ≥ `buyQuantity`; `nApp = min(floor(buyUnits/buyQuantity), maxApplications||∞)`; reward units due `D = nApp × getQuantity`.
- Reward net price: `percentage` → `fullPrice − round(fullPrice × value/100)` (100 ⇒ 0); `fixed` → `max(0, fullPrice − value)`.
- One reward line per due unit (qty 1 each). Reward line is request-only flagged (`isReward:true`, new `rewardPromotionId`), priced at net; never a buy unit (buy∩get overlap is rejected by `validateBXGY`).
- Server hard-reject hybrid: online invalid/over-quota/price-mismatch reward line → 422 `ViolationRewardInvalid`; offline → drop the line + `orders.discount_warning` + reason + `slog.Warn`.
- Honored reward line → one immutable `promo_reward_grants` row (full/reward/value). Refund restocks but never deletes grants.
- `calcPromoDiscount` for `buy_x_get_y`: same-set → `calcBXGY`; separate-set → 0.
- Composite keys `pid` / `pid|size` via existing `variantKey`/`keyMatchesLine`.
- Codegen: `make gen-check` gates api.gen.go; `schema.d.ts` regen via `corepack pnpm@10.11.1 --filter @mandalika/api gen`. APK: push BEFORE `gh workflow run`.
- Model routing: Sonnet implement; Opus review Tasks 1/2/3/4/5/6 (engine/grant/server/type-gen/POS money+stock+reducer); Haiku for Task 7 (copy).

---

### Task 1: Reward entitlement pure helpers (Go)

**Files:**
- Modify: `backend/internal/service/pricing.go` (add helpers near `calcBXGY`)
- Test: `backend/internal/service/pricing_test.go`

**Interfaces:**
- Consumes: `BXGYConfig`, `DiscountKind`, `LineItem`, `contains`, `variantKey`, `keyMatchesLine` (all exist).
- Produces:
  - `func bxgyBuyUnits(c *BXGYConfig, items []LineItem) int` — qty-expanded paid units matching `BuyProductIDs` (empty ⇒ any unit NOT matching `GetProductIDs`).
  - `func bxgyRewardDue(c *BXGYConfig, items []LineItem) int` — `D = nApp*GetQuantity` (0 if nil/same-set/buyUnits short).
  - `func bxgyRewardNet(c *BXGYConfig, fullPrice float64) float64` — net price per kind.

- [ ] **Step 1: Write failing tests** — append to `pricing_test.go`:

```go
func TestBXGYRewardDue(t *testing.T) {
	c := &BXGYConfig{BuyQuantity: 2, GetQuantity: 1, BuyProductIDs: []string{"a"}, GetProductIDs: []string{"b"}}
	// 4 buy units -> 2 applications -> 2 due
	items := []LineItem{bxgyItem("a", "M", 10000, 4)}
	if got := bxgyRewardDue(c, items); got != 2 {
		t.Fatalf("due=%d want 2", got)
	}
	// 3 buy units, buyQty 2 -> 1 application -> 1 due
	if got := bxgyRewardDue(c, []LineItem{bxgyItem("a", "M", 10000, 3)}); got != 1 {
		t.Fatalf("due=%d want 1", got)
	}
	// under criteria -> 0
	if got := bxgyRewardDue(c, []LineItem{bxgyItem("a", "M", 10000, 1)}); got != 0 {
		t.Fatalf("due=%d want 0", got)
	}
	// cap
	c.MaxApplications = 1
	if got := bxgyRewardDue(c, []LineItem{bxgyItem("a", "M", 10000, 4)}); got != 1 {
		t.Fatalf("capped due=%d want 1", got)
	}
	// same-set (empty get) -> 0 (not a fulfillment promo)
	if got := bxgyRewardDue(&BXGYConfig{BuyQuantity: 2, GetQuantity: 1}, items); got != 0 {
		t.Fatalf("sameset due=%d want 0", got)
	}
}

func TestBXGYRewardDueExcludesGetSetFromBuyUnits(t *testing.T) {
	// empty buyProductIds => any unit NOT in get set counts as buy
	c := &BXGYConfig{BuyQuantity: 2, GetQuantity: 1, GetProductIDs: []string{"b"}}
	items := []LineItem{bxgyItem("a", "M", 10000, 2), bxgyItem("b", "M", 8000, 5)}
	if got := bxgyRewardDue(c, items); got != 1 { // only the 2 'a' count as buy -> 1 app
		t.Fatalf("due=%d want 1", got)
	}
}

func TestBXGYRewardNet(t *testing.T) {
	free := &BXGYConfig{GetDiscountKind: DiscountPercentage, GetDiscountValue: 100}
	if got := bxgyRewardNet(free, 50000); got != 0 {
		t.Fatalf("free net=%v want 0", got)
	}
	half := &BXGYConfig{GetDiscountKind: DiscountPercentage, GetDiscountValue: 50}
	if got := bxgyRewardNet(half, 50000); got != 25000 {
		t.Fatalf("half net=%v want 25000", got)
	}
	fixed := &BXGYConfig{GetDiscountKind: DiscountFixed, GetDiscountValue: 99999}
	if got := bxgyRewardNet(fixed, 5000); got != 0 { // capped: max(0, 5000-99999)
		t.Fatalf("fixed net=%v want 0", got)
	}
}
```

- [ ] **Step 2: Run to verify FAIL** — `cd backend && go test ./internal/service/ -run 'TestBXGYReward' -v` → FAIL (undefined).

- [ ] **Step 3: Implement** in `pricing.go`:

```go
// bxgyBuyUnits counts qty-expanded paid units that satisfy the buy set. Empty
// BuyProductIDs => any unit NOT in the get set (buy∩get overlap is rejected at save).
func bxgyBuyUnits(c *BXGYConfig, items []LineItem) int {
	n := 0
	for _, i := range items {
		var isBuy bool
		if len(c.BuyProductIDs) > 0 {
			isBuy = keyMatchesLine(c.BuyProductIDs, i.ProductID, i.VariantSize)
		} else {
			isBuy = !keyMatchesLine(c.GetProductIDs, i.ProductID, i.VariantSize)
		}
		if isBuy {
			n += i.Quantity
		}
	}
	return n
}

// bxgyRewardDue is the number of reward units the cart earns (separate-set only).
func bxgyRewardDue(c *BXGYConfig, items []LineItem) int {
	if c == nil || len(c.GetProductIDs) == 0 || c.BuyQuantity < 1 || c.GetQuantity < 1 {
		return 0
	}
	nApp := bxgyBuyUnits(c, items) / c.BuyQuantity
	if c.MaxApplications > 0 && nApp > c.MaxApplications {
		nApp = c.MaxApplications
	}
	if nApp < 0 {
		nApp = 0
	}
	return nApp * c.GetQuantity
}

// bxgyRewardNet is the per-unit price charged for a reward (0 for free).
func bxgyRewardNet(c *BXGYConfig, fullPrice float64) float64 {
	switch c.GetDiscountKind {
	case DiscountPercentage:
		return fullPrice - math.Round(fullPrice*(c.GetDiscountValue/100))
	case DiscountFixed:
		if n := fullPrice - c.GetDiscountValue; n > 0 {
			return n
		}
		return 0
	}
	return fullPrice
}
```
> Note: when validating reward lines for separate-set, the buy-units count must use **paid** lines only — callers pass the non-reward items (Task 3 filters `!IsReward`).

- [ ] **Step 4: Run to verify PASS** — `cd backend && go test ./internal/service/ -v` (new + all existing pass).
- [ ] **Step 5: Commit**

```bash
git add backend/internal/service/pricing.go backend/internal/service/pricing_test.go
git commit -m "feat(promo-sp3b-reward): reward entitlement helpers (due count + net price)"
```

---

### Task 2: Migration 0039 + grant write/read repo (Go)

**Files:**
- Create: `backend/internal/db/migrations/0039_promo_reward_grants.sql`
- Modify: `backend/internal/write/repo.go` (add `RewardGrantRow` + `InsertRewardGrant`)
- Modify: `backend/internal/read/repo.go` (add `RewardGrantsByOrder` for tests/reporting)
- Test: `backend/internal/write/repo_test.go` (struct-shape compile test only — DB writes are exercised live in Task 8)

**Interfaces:**
- Produces: `write.RewardGrantRow{OrderID, PromotionID, ProductID, ProductName, VariantSize string; FullPrice, RewardPrice, RewardValue float64}` and `func InsertRewardGrant(ctx, tx pgx.Tx, r RewardGrantRow) error`.

- [ ] **Step 1: Write the migration** `0039_promo_reward_grants.sql`:

```sql
-- 0039_promo_reward_grants.sql — SP-Promo-3b reward fulfillment audit.
CREATE TABLE promo_reward_grants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      uuid NOT NULL REFERENCES orders(id),
  promotion_id  uuid NOT NULL REFERENCES promotions(id),
  product_id    uuid NOT NULL,
  product_name  text NOT NULL,
  variant_size  text NOT NULL DEFAULT '',
  full_price    numeric(14,2) NOT NULL,
  reward_price  numeric(14,2) NOT NULL,
  reward_value  numeric(14,2) NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_promo_reward_grants_order ON promo_reward_grants(order_id);
CREATE INDEX idx_promo_reward_grants_promo ON promo_reward_grants(promotion_id);
```
> Confirm `gen_random_uuid()` is available (pgcrypto/pg13+) — the existing migrations use it (check `0001_init.sql`); if they use `uuid_generate_v4()` instead, match that.

- [ ] **Step 2: Add the write helper** in `write/repo.go` (near `InsertConditionApplication`):

```go
type RewardGrantRow struct {
	OrderID, PromotionID, ProductID, ProductName, VariantSize string
	FullPrice, RewardPrice, RewardValue                       float64
}

func InsertRewardGrant(ctx context.Context, tx pgx.Tx, r RewardGrantRow) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO promo_reward_grants
		  (order_id, promotion_id, product_id, product_name, variant_size,
		   full_price, reward_price, reward_value)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
		r.OrderID, r.PromotionID, r.ProductID, r.ProductName, r.VariantSize,
		r.FullPrice, r.RewardPrice, r.RewardValue)
	return err
}
```

- [ ] **Step 3: Add the read helper** in `read/repo.go`:

```go
func (r *Repo) RewardGrantsByOrder(ctx context.Context, orderID string) ([]api.RewardGrant, int, error) {
	return listJSON[api.RewardGrant](ctx, r.Pool,
		`SELECT json_build_object('id',id,'orderId',order_id,'promotionId',promotion_id,
		   'productId',product_id,'productName',product_name,'variantSize',variant_size,
		   'fullPrice',full_price,'rewardPrice',reward_price,'rewardValue',reward_value,
		   'createdAt',created_at) FROM promo_reward_grants WHERE order_id=$1`, orderID)
}
```
> `api.RewardGrant` is generated in Task 4 (add the read schema there). If Task 4 is not yet done when this compiles, temporarily return `([]any, ...)` — BUT order tasks so Task 4 lands the type first, OR define a local struct. Plan order runs Task 4 after; to avoid a compile gap, this read helper + its `api.RewardGrant` schema are added in **Task 4** (move Step 3 there). Keep Steps 1–2 here.

- [ ] **Step 4: Build** — `cd backend && go build ./...` (migration file is inert; write helper compiles).
- [ ] **Step 5: Commit**

```bash
git add backend/internal/db/migrations/0039_promo_reward_grants.sql backend/internal/write/repo.go
git commit -m "feat(promo-sp3b-reward): migration 0039 promo_reward_grants + InsertRewardGrant"
```

---

### Task 3: Server entitlement + grant recording in CreateOrder (Go) — Opus

**Files:**
- Modify: `backend/internal/service/order.go` (`OrderItem` +`RewardPromotionID`; reward-line validation loop; hybrid hard-reject; grant write)
- Modify: `backend/internal/service/promo_validate.go` (add `ViolationRewardInvalid`)
- Modify: `backend/internal/handlers/writes.go` (map `ViolationRewardInvalid` → Indonesian message)
- Test: `backend/internal/service/order_reward_test.go` (pure entitlement helper) + `handlers/promo_message_test.go` (message)

**Interfaces:**
- Consumes: `bxgyRewardDue`, `bxgyRewardNet`, `keyMatchesLine`, `variantKey`, `loadPromoSpec`/promo load, `write.InsertRewardGrant` (Task 2).
- Produces: `OrderItem.RewardPromotionID string` (request-only); honored reward lines write grants; invalid → 422 (online) / drop+flag (offline).

- [ ] **Step 1: Add the violation + message (failing test first).** In `promo_message_test.go` add a case `{"reward invalid", []service.PromoViolation{service.ViolationRewardInvalid}, "Hadiah promo tidak valid atau melebihi kuota"}`. Run → FAIL.
- [ ] **Step 2: Implement** the const in `promo_validate.go` (`ViolationRewardInvalid PromoViolation = "reward_invalid"`) and the `case service.ViolationRewardInvalid:` arm in `writes.go` returning `"Hadiah promo tidak valid atau melebihi kuota"`. Run → PASS.
- [ ] **Step 3: Add `RewardPromotionID` to `OrderItem`** (`order.go:28-40`, request-only, after `RewardConditionID`):

```go
	RewardConditionID string `json:"rewardConditionId"`
	RewardPromotionID string `json:"rewardPromotionId"` // SP-Promo-3b reward fulfillment: the buy_x_get_y promo that gave this line
```

- [ ] **Step 4: Write the failing entitlement test** — `order_reward_test.go` (pure helper, no DB):

```go
package service

import "testing"

func li(pid, size string, price float64, qty int) LineItem {
	return LineItem{ProductID: pid, VariantSize: size, Price: price, Quantity: qty, Subtotal: price * float64(qty)}
}

func TestRewardLineEntitlement(t *testing.T) {
	c := &BXGYConfig{BuyQuantity: 2, GetQuantity: 1, BuyProductIDs: []string{"a"},
		GetProductIDs: []string{"b|10ml"}, GetDiscountKind: DiscountPercentage, GetDiscountValue: 100}
	paid := []LineItem{li("a", "M", 10000, 2)} // 1 application -> D=1
	// honored: 1 reward of b|10ml at net 0
	ok, net := rewardLineEntitled(c, paid, 0, "b", "10ml", 8000)
	if !ok || net != 0 {
		t.Fatalf("entitled ok=%v net=%v want true,0", ok, net)
	}
	// over-quota: the 2nd reward (alreadyHonored=1, D=1) is rejected
	if ok, _ := rewardLineEntitled(c, paid, 1, "b", "10ml", 8000); ok {
		t.Fatal("over-quota reward must be rejected")
	}
	// wrong product
	if ok, _ := rewardLineEntitled(c, paid, 0, "zzz", "M", 8000); ok {
		t.Fatal("wrong-product reward must be rejected")
	}
	// wrong variant (b|50ml not in get set)
	if ok, _ := rewardLineEntitled(c, paid, 0, "b", "50ml", 8000); ok {
		t.Fatal("wrong-variant reward must be rejected")
	}
}
```

- [ ] **Step 5: Implement `rewardLineEntitled`** in `order.go`:

```go
// rewardLineEntitled reports whether a reward line (product/size at fullPrice) is
// allowed for this buy_x_get_y promo given the PAID lines and how many reward
// units of this promo were already honored, and returns the net price to charge.
func rewardLineEntitled(c *BXGYConfig, paid []LineItem, alreadyHonored int, productID, size string, fullPrice float64) (bool, float64) {
	if c == nil || len(c.GetProductIDs) == 0 {
		return false, 0
	}
	if !keyMatchesLine(c.GetProductIDs, productID, size) {
		return false, 0
	}
	if alreadyHonored >= bxgyRewardDue(c, paid) {
		return false, 0
	}
	return true, bxgyRewardNet(c, fullPrice)
}
```

- [ ] **Step 6: Run pure tests** — `cd backend && go test ./internal/service/ -run 'TestRewardLine|TestBXGYReward' -v && go test ./internal/handlers/ -run Message -v` → PASS.

- [ ] **Step 7: Wire into `CreateOrder`.** Mirror the SP-CRM-9 reward loop (`order.go:416-440`) but for `rewardPromotionId`. After the paid-line stock loop and after promos resolve, BEFORE commit, add a reward-validation pass that builds `paidLines []LineItem` (the `!IsReward` items), groups reward lines by `RewardPromotionID`, looks up the promotion's `bxgyConfig` (via the existing promo load / `loadPromoSpec` returning `spec.BXGY`) and the reward product's catalog `fullPrice` (query `products`/variants like the stock path at `order.go:271-278`), then for each reward line calls `rewardLineEntitled`:
  - **valid** → set the line's effective price to `net` (server-authoritative), increment `honored[promoID]`, and `write.InsertRewardGrant(...)` with `FullPrice`, `RewardPrice=net`, `RewardValue=fullPrice-net`.
  - **invalid**:
    - `if !in.Offline` → `return "", false, false, &ErrDiscountRejected{Violations: []PromoViolation{ViolationRewardInvalid}}` (handler → 422).
    - else (`in.Offline`) → drop the reward line from the persisted items, set `stockWarning`/`discount_warning` + reason, `slog.Warn`.
  > The reward line's price must be the server `net`, not the client value — recompute it; the stock decrement + order_items insert use the server price. Keep the grant insert inside the same `tx`.
  Provide the full loop in the implementation (mirror the structure of `order.go:416-440`, swapping `RewardConditionID`→`RewardPromotionID`, `rewardMenu`→the per-promo bxgyConfig, `rewardLineAllowed`→`rewardLineEntitled`, and the grant insert→`InsertRewardGrant`).

- [ ] **Step 8: Build + full service/handlers tests** — `cd backend && go build ./... && go test ./internal/... ` → green.
- [ ] **Step 9: Commit**

```bash
git add backend/internal/service/order.go backend/internal/service/promo_validate.go backend/internal/handlers/writes.go backend/internal/service/order_reward_test.go backend/internal/handlers/promo_message_test.go
git commit -m "feat(promo-sp3b-reward): CreateOrder entitlement (hybrid 422/offline-drop) + grant recording"
```

---

### Task 4: OpenAPI rewardPromotionId + RewardGrant + read repo + codegen (Go+TS) — Opus

**Files:**
- Modify: `backend/api/openapi.yaml` (`OrderItemInput` + `CartItem`: add `rewardPromotionId`; add `RewardGrant` schema)
- Modify: `backend/internal/read/repo.go` (add `RewardGrantsByOrder` from Task 2 Step 3)
- Regenerate: `backend/internal/api/api.gen.go`, `packages/api/src/schema.d.ts`

- [ ] **Step 1: Add `rewardPromotionId`** (string, optional) next to `rewardConditionId` in BOTH `OrderItemInput` and `CartItem` schemas in `openapi.yaml`.
- [ ] **Step 2: Add the `RewardGrant` read schema** under `components.schemas`:

```yaml
    RewardGrant:
      type: object
      properties:
        id: { type: string }
        orderId: { type: string }
        promotionId: { type: string }
        productId: { type: string }
        productName: { type: string }
        variantSize: { type: string }
        fullPrice: { type: number }
        rewardPrice: { type: number }
        rewardValue: { type: number }
        createdAt: { type: string }
```

- [ ] **Step 3: Add `RewardGrantsByOrder`** to `read/repo.go` (the code from Task 2 Step 3 — `api.RewardGrant` now exists after regen).
- [ ] **Step 4: Regenerate** — `cd backend && make gen && corepack pnpm@10.11.1 --filter @mandalika/api gen`. Confirm `CartItem`/`OrderItemInput` gain `RewardPromotionId *string` (Go) / `rewardPromotionId?` (TS) and `api.RewardGrant` exists.
- [ ] **Step 5: Verify** — `cd backend && make gen-check && go build ./... && cd ../packages/api && corepack pnpm@10.11.1 -w exec tsc -b`.
- [ ] **Step 6: Commit**

```bash
git add backend/api/openapi.yaml backend/internal/api/api.gen.go backend/internal/read/repo.go packages/api/src/schema.d.ts
git commit -m "feat(promo-sp3b-reward): OpenAPI rewardPromotionId + RewardGrant, regen clients + read repo"
```

---

### Task 5: POS pricing + reducer (TS) — Opus

**Files:**
- Modify: `apps/pos/src/cashier/pricing.ts` (separate-set `buy_x_get_y` → 0; export `bxgyRewardDue`/`bxgyRewardOptions`/`bxgyRewardNet` TS mirrors)
- Modify: `apps/pos/src/cashier/state/cashierReducer.ts` (`CART_ADD_REWARD`/`CART_REMOVE_REWARD` carry `rewardPromotionId`; allow multiple reward lines per promo)
- Test: `apps/pos/src/cashier/pricing.test.ts`, `apps/pos/src/cashier/state/cashierReducer.test.ts`

**Interfaces:**
- Produces (TS, parity with Go Task 1): `bxgyRewardDue(cfg, items)`, `bxgyRewardNet(cfg, fullPrice)`, `bxgyRewardOptions(cfg, products) -> {productId,productName,variantSize,fullPrice,net}[]`.

- [ ] **Step 1: Failing pricing test** — separate-set buy_x_get_y contributes 0 to `calcPromoDiscount`; same-set still discounts. Add to `pricing.test.ts`:

```ts
it('separate-set buy_x_get_y contributes 0 promo discount (reward is a priced line)', () => {
  const cfg: BXGYConfig = { buyQuantity: 2, getQuantity: 1, buyProductIds: ['a'], getProductIds: ['b'], getDiscountKind: 'percentage', getDiscountValue: 100 }
  const items = [ci('a', 'M', 10000, 2), ci('b', 'M', 8000, 1)]
  expect(calcPromoDiscount(bxgy(cfg), items, sub(items))).toBe(0)
})
it('same-set buy_x_get_y still discounts in place', () => {
  const items = [ci('a', 'M', 10000, 3)]
  expect(calcPromoDiscount(bxgy({ buyQuantity: 2, getQuantity: 1, getDiscountKind: 'percentage', getDiscountValue: 100 }), items, sub(items))).toBe(10000)
})
```

- [ ] **Step 2: Run → FAIL** (separate-set currently returns the calcBXGY discount).
- [ ] **Step 3: Implement** — in `pricing.ts` `calcPromoDiscount`, change the buy_x_get_y branch to:

```ts
  if (promo.type === 'buy_x_get_y') {
    const cfg = promo.bxgyConfig
    // separate-set is a reward giveaway: the saving lives in the reward line's
    // reduced price, so it contributes 0 here. same-set discounts in place.
    if (cfg && cfg.getProductIds && cfg.getProductIds.length > 0) return 0
    return calcBXGY(cfg, items)
  }
```
  Add the exported TS mirrors `bxgyRewardDue`, `bxgyRewardNet`, `bxgyRewardOptions` (port Task 1 Go logic 1:1; `bxgyRewardOptions` expands `getProductIds` against the products list to `{productId, productName, variantSize, fullPrice, net}`).

- [ ] **Step 4: Reducer multi-reward** — extend `CART_ADD_REWARD` payload + `CART_REMOVE_REWARD` to carry `rewardPromotionId` (in addition to the existing loyalty `rewardConditionId`); allow MULTIPLE reward lines per promo (drop the one-per-condition replace for the promo path — key reward identity by `(rewardPromotionId, productId, variantSize)` and append). Add `CART_REMOVE_PROMO_REWARDS` (remove all reward lines for a `rewardPromotionId`) for reactive removal. Add a vitest covering: add 2 reward lines for one promo, paid-op isolation (paid add/remove doesn't touch reward lines), remove-all-by-promo.

- [ ] **Step 5: Run POS unit tests + tsc** — `cd apps/pos && corepack pnpm@10.11.1 exec vitest run && corepack pnpm@10.11.1 exec tsc -b` → green.
- [ ] **Step 6: Commit**

```bash
git add apps/pos/src/cashier/pricing.ts apps/pos/src/cashier/pricing.test.ts apps/pos/src/cashier/state/cashierReducer.ts apps/pos/src/cashier/state/cashierReducer.test.ts
git commit -m "feat(promo-sp3b-reward): POS pricing (separate-set=0) + reducer multi reward lines"
```

---

### Task 6: POS apply flow — gate, reward-picker modal, reactive removal (TSX) — Opus

**Files:**
- Modify: `apps/pos/src/cashier/PromoPanel.tsx` (separate-set gate = buy criteria met; apply triggers resolve)
- Create: `apps/pos/src/cashier/BxgyRewardModal.tsx` (picker; mirrors the SP-CRM-9 "Hadiah Loyalti" picker + SP-CRM-9b drill-down + SP-CRM-9c `· Stok N`)
- Modify: `apps/pos/src/cashier/CashierScreen.tsx` (apply handler: auto-add vs modal; reactive-removal effect; checkout local guard already drops unqualified — extend to remove reward lines)
- Test: covered by Task 5 reducer tests + on-device (UI).

**Interfaces:**
- Consumes: `bxgyRewardDue`, `bxgyRewardOptions` (Task 5); `CART_ADD_REWARD`/`CART_REMOVE_PROMO_REWARDS` (Task 5); `displayProducts` (stock-aware, SP-CRM-9c).

- [ ] **Step 1: PromoPanel gate** — for `promo.type === 'buy_x_get_y'` with non-empty `getProductIds`, eligibility = `bxgyRewardDue(promo.bxgyConfig, cart-paid-lines) >= 1` (NOT `calcPromoDiscount>0`). Same-set keeps `calcPromoDiscount>0`. Reason when ineligible: "Syarat beli belum terpenuhi". (Replaces the `bxgyUnmet` logic from the SP-Promo-3b on-device fix for the separate-set case.)
- [ ] **Step 2: Apply handler** (`CashierScreen`) — on selecting an eligible separate-set promo: compute `D = bxgyRewardDue(...)` and `options = bxgyRewardOptions(cfg, displayProducts)`. If `options.length === 1 && D === 1` → dispatch one `CART_ADD_REWARD` line (`isReward:true, rewardPromotionId: promo.id`, product/size/price=net) + add promo to `appliedPromotions`. Else → open `BxgyRewardModal` with `{promo, options, due:D}`.
- [ ] **Step 3: `BxgyRewardModal`** — let the cashier pick `D` reward units from `options` (each pick = one line; same variant can be picked multiple times up to D; show `· Stok N` from `displayProducts`, red ≤0). Confirm → dispatch `D` `CART_ADD_REWARD` lines + add the promo to `appliedPromotions`. Cancel → nothing applied. Build it by mirroring the SP-CRM-9 reward picker (find it in `CheckoutPanel.tsx` "Hadiah Loyalti") + the SP-CRM-9b `ProductVariantPicker` presentation — swap loyalty `rewardConditionId` for `rewardPromotionId` and the menu for `options`.
- [ ] **Step 4: Reactive removal** — add an effect keyed on the paid-buy-unit count per applied buy_x_get_y promo: if `bxgyRewardDue(cfg, paidLines) < currentRewardLineCountForPromo`, dispatch `CART_REMOVE_PROMO_REWARDS` for the surplus (or all) + `REMOVE_PROMOTION` if `D===0`. The existing checkout re-guard (CashierScreen `handleConfirmPayment`) must also `CART_REMOVE_PROMO_REWARDS` when it drops a buy_x_get_y promo.
- [ ] **Step 5: Cart/Receipt** — reward lines already render via the SP-CRM-9 isReward path; confirm the `rewardPromotionId` lines show "Hadiah: {promo}" / GRATIS (net 0) and are non-editable (reuse the isReward treatment in `Cart.tsx`/`ReceiptPreview.tsx`).
- [ ] **Step 6: Build** — `cd apps/pos && corepack pnpm@10.11.1 exec tsc -b && corepack pnpm@10.11.1 exec vitest run && corepack pnpm@10.11.1 exec vite build` → green.
- [ ] **Step 7: Commit**

```bash
git add apps/pos/src/cashier/PromoPanel.tsx apps/pos/src/cashier/BxgyRewardModal.tsx apps/pos/src/cashier/CashierScreen.tsx
git commit -m "feat(promo-sp3b-reward): POS apply gate + reward picker modal + reactive removal"
```

---

### Task 7: Backoffice copy (TSX) — Haiku

**Files:**
- Modify: `apps/backoffice/src/screens/promotions/PromoFormModal.tsx`

- [ ] **Step 1:** Relabel the BXGY get-set picker Field from "Produk Hadiah (kosong = sama dengan produk beli)" to "Produk Hadiah (diberikan gratis/diskon ke pelanggan)" and add a one-line hint that the customer receives these at the POS. No logic change.
- [ ] **Step 2:** `cd apps/backoffice && corepack pnpm@10.11.1 exec tsc -b && corepack pnpm@10.11.1 exec vite build` → green.
- [ ] **Step 3: Commit**

```bash
git add apps/backoffice/src/screens/promotions/PromoFormModal.tsx
git commit -m "docs(promo-sp3b-reward): clarify get-set is the customer reward"
```

---

### Task 8: Live e2e + gap-class guard (Go) — throwaway

**Files:**
- Create: `backend/cmd/promo3breward/main.go` (throwaway; real `OrderService` vs Neon; deleted after; NOT committed)

- [ ] **Step 1: Write the e2e** mirroring `cmd/promo3be2e` (resurrect the pattern: fetch Neon `DATABASE_URL` from `gcloud secrets`, build pool, real `service.NewOrderService(pool)`). Scenarios (assert each, `[sp3breward-e2e]` prefix, zero-residue cleanup):
  1. Create a separate-set `buy_x_get_y` (buy 2 of product A, get 1 of product B free). Order with 2×A paid + 1 reward line B (`rewardPromotionId`, price 0, `Offline:false`) → succeeds; B stock −1; **one `promo_reward_grants` row** with `reward_value = fullPrice(B)`.
  2. **Online over-quota**: same order but 2 reward lines (D=1) → `CreateOrder` returns the 422 discount-rejected error.
  3. **Offline over-quota** (`Offline:true`): the 2nd reward line is dropped (1 grant, 1 stock −1, `discount_warning` set).
  4. **50%-off** reward: net = round(fullPrice/2); grant `reward_value = fullPrice - net`.
  5. **Refund** the order → B restocks +1; grant row still present (immutable).
  6. Cleanup all artifacts (orders, grants, promo, any fixtures) → verify zero `[sp3breward-e2e]` residue + grants gone for the test order.
- [ ] **Step 2: Run** — `cd backend && export DATABASE_URL_E2E="$(gcloud secrets versions access latest --secret=DATABASE_URL)"; go run ./cmd/promo3breward` → all asserts pass + "CLEANUP OK".
- [ ] **Step 3: Local full gate** — `cd backend && go build ./... && go test ./... && make gen-check` → green.
- [ ] **Step 4: Delete the throwaway** (`rm -rf backend/cmd/promo3breward`) and confirm `git status` shows no new committed files. (No commit — the e2e is never committed.)

---

### Task 9: Deploy, APK, handoff

- [ ] **Step 1: Push** all commits to `origin/prod-hardening` (retry on flaky net; confirm `git ls-remote`).
- [ ] **Step 2: Deploy** — `gcloud run deploy mandalika-pos --source backend --region asia-southeast2 --quiet` (migration 0039 applies on boot); confirm `/readyz` ready.
- [ ] **Step 3: Authed live smoke** — with an admin token, POST an order (online) carrying a valid reward line for the live "BELI 2 GRATIS 1" promo → GET the order / grants → confirm the reward line + a `promo_reward_grants` row; POST an over-quota reward line → expect 422. Delete test artifacts.
- [ ] **Step 4: APK** — push first (done), then `"/c/Program Files/GitHub CLI/gh.exe" workflow run android-release.yml --ref prod-hardening -f api_url=https://mandalika-pos-538849926142.asia-southeast2.run.app`; watch to green.
- [ ] **Step 5: Update `SESSION_HANDOFF.md`** (new SP-Promo-3b-reward banner: rev, migration 0039, APK run, hard-reject + grant, USER-PENDING on-device) and the `promotion-module-sp-promo` memory.
- [ ] **Step 6: Commit + push the handoff.**

**USER-PENDING after this plan:** on-device — author/keep a buy_x_get_y reward promo; at POS, with the buy items in cart, apply → reward auto-adds (single) or modal (multiple) → GRATIS/discounted line, stock decrements; remove buy items → reward auto-removed; complete sale → backoffice shows the grant; over-quota tampering rejected.

---

## Self-Review

- **Spec coverage:** §1 eligibility/count → T1; §2 options → T1(Go)/T5(TS); §3 reward line → T3(`RewardPromotionID`)+T5(reducer); §4 POS flow → T6; §5 pricing → T5; §6 server authority (hybrid hard-reject) → T3; §6a grant table → T2(+T4 read); §7 wire/migration → T2+T4; §8 backoffice → T7; §9 testing → T1/T3/T5/T8; §10 routing → header. Covered.
- **Placeholder scan:** pure/engine/server/grant code is complete; T6 modal references the SP-CRM-9 picker by location to reuse (existing code, not a prior task) — acceptable grounding, with exact swaps named. T3 Step 7 describes the loop by mirroring `order.go:416-440` with named substitutions rather than re-pasting 100+ lines — acceptable since the canonical pattern is in-repo and the substitutions are explicit.
- **Type consistency:** Go `bxgyRewardDue`/`bxgyRewardNet`/`rewardLineEntitled` ↔ TS `bxgyRewardDue`/`bxgyRewardNet`/`bxgyRewardOptions`; `RewardPromotionID`(Go OrderItem) ↔ `rewardPromotionId`(OpenAPI/TS); `ViolationRewardInvalid="reward_invalid"`; `write.RewardGrantRow`/`InsertRewardGrant`; `api.RewardGrant`. Consistent.
- **Note (Task 2/4 ordering):** the read helper `RewardGrantsByOrder` + `api.RewardGrant` are created in Task 4 (after codegen) to avoid a compile gap; Task 2 keeps only the migration + write helper.
