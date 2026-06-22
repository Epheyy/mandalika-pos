# SP-Promo-3b — Configurable Buy-X-Get-Y Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a configurable `buy_x_get_y` promotion type (variant-level buy/get sets, free/%/fixed reward discount, repeat cap) that inherits SP-Promo-3a stacking and SP-Promo-3c code-linkage for free.

**Architecture:** A new `DiscountKind` `buy_x_get_y` whose entire rule lives in one `promotions.bxgy_config jsonb` blob. The pricing engine (`pricing.go`, ported 1:1 to `pricing.ts`) gains one branch that returns the discount as a single number summed into the existing additive `Promos` stack. `resolvePromos` parses the blob into `PromoSpec.BXGY`. Buy/get sets are composite `pid|size` keys (SP-CRM-9b `variantKey` convention), so the pricing `LineItem` gains a `VariantSize` field.

**Tech Stack:** Go (backend service + pgx + oapi-codegen), TypeScript (POS `pricing.ts` + vitest, backoffice React), Postgres (Neon), OpenAPI (`openapi-typescript` + `oapi-codegen`).

## Global Constraints

- Branch `prod-hardening`. Conventional-commit messages; **no attribution trailer** (disabled globally).
- `bogo`, `percentage`, `fixed` paths are **untouched** — their golden-value tests must still pass byte-identically.
- For a `buy_x_get_y` promotion, top-level `value` and `applicable_product_ids` are **unused**; the blob is the single source of truth.
- Composite key convention: `"pid"` matches any variant; `"pid|size"` matches that variant only; `|` never appears in a size name. Match a line iff `contains(keys, pid)` OR (`size != ""` AND `contains(keys, variantKey(pid,size))`).
- **Engine leniency:** a nil/invalid `bxgy_config` on a `buy_x_get_y` promo yields **0 discount + `slog.Warn`** — never panic, never 422. Gating violations (dates/min/hours/outlet) keep the existing hybrid-by-origin path.
- "Cheapest units discounted" convention (matches existing `bogo`).
- Codegen: `make gen-check` gates `api.gen.go` only; `schema.d.ts` regen needs `corepack pnpm@10.11.1 --filter @mandalika/api gen`; verify `schema.d.ts` drift by hand. `nullable` on `$ref` objects is dropped by `openapi-typescript` ([[openapi-nullable-ref-codegen-gotcha]]) → clear the TS field by omitting/`undefined`.
- Model routing: Sonnet implements; **Opus** reviews Task 1, 2, 4, 5 (engine/resolution/type-gen/POS money path); **Haiku** for Task 6 (form/copy) and spec-conformance.
- APK: `git push` to origin BEFORE `gh workflow run` ([[apk-builds-from-origin-gotcha]]).

---

### Task 1: Engine — `BXGYConfig`, `LineItem.VariantSize`, and the `calcBXGY` branch (Go)

**Files:**
- Modify: `backend/internal/service/pricing.go` (LineItem, PromoSpec, DiscountKind consts, calcPromotionDiscount, add `calcBXGY`/helpers; imports `math` → `math`,`sort`,`log/slog`)
- Modify: `backend/internal/service/order.go:177` (set `VariantSize` when building `[]LineItem`)
- Modify: `backend/internal/service/pricing_test.go:6` (the `item()` helper — keep existing parity tests compiling/passing)
- Test: `backend/internal/service/pricing_test.go` (new `TestCalcBXGY*` cases)

**Interfaces:**
- Produces: `type BXGYConfig struct { BuyQuantity, GetQuantity int; BuyProductIDs, GetProductIDs []string; GetDiscountKind DiscountKind; GetDiscountValue float64; MaxApplications int }` (JSON tags: `buyQuantity,getQuantity,buyProductIds,getProductIds,getDiscountKind,getDiscountValue,maxApplications`); `const DiscountBuyXGetY DiscountKind = "buy_x_get_y"`; `PromoSpec.BXGY *BXGYConfig`; `LineItem.VariantSize string`.
- Consumes: existing `contains`, `variantKey` (both package `service`).

- [ ] **Step 1: Write the failing tests** — append to `pricing_test.go`:

```go
func bxgyItem(id, size string, price float64, qty int) LineItem {
	return LineItem{ProductID: id, VariantSize: size, Price: price, Quantity: qty, Subtotal: price * float64(qty)}
}

func TestCalcBXGYSameSetFree(t *testing.T) {
	// buy 2 get 1 free, same set {a}; 3 units of a@10000 -> cheapest 1 free = 10000
	cfg := &BXGYConfig{BuyQuantity: 2, GetQuantity: 1, GetDiscountKind: DiscountPercentage, GetDiscountValue: 100}
	r := Compute(PricingInput{Items: []LineItem{bxgyItem("a", "M", 10000, 3)},
		Promos: []PromoSpec{{Kind: DiscountBuyXGetY, BXGY: cfg}}})
	if r.PromoDiscount != 10000 {
		t.Fatalf("got %v want 10000", r.PromoDiscount)
	}
}

func TestCalcBXGYRepeatAndCap(t *testing.T) {
	// buy 2 get 1; 6 units -> 2 free; cap 1 -> only 1 free
	cfg := &BXGYConfig{BuyQuantity: 2, GetQuantity: 1, GetDiscountKind: DiscountPercentage, GetDiscountValue: 100}
	full := Compute(PricingInput{Items: []LineItem{bxgyItem("a", "M", 10000, 6)},
		Promos: []PromoSpec{{Kind: DiscountBuyXGetY, BXGY: cfg}}})
	if full.PromoDiscount != 20000 {
		t.Fatalf("repeat got %v want 20000", full.PromoDiscount)
	}
	cfg.MaxApplications = 1
	capped := Compute(PricingInput{Items: []LineItem{bxgyItem("a", "M", 10000, 6)},
		Promos: []PromoSpec{{Kind: DiscountBuyXGetY, BXGY: cfg}}})
	if capped.PromoDiscount != 10000 {
		t.Fatalf("capped got %v want 10000", capped.PromoDiscount)
	}
}

func TestCalcBXGYSeparateSetPercentAndScarcity(t *testing.T) {
	// buy 2 of {a}, get 1 of {b} at 50% off. a x2, b x1 -> 1 application, b@8000*50% = 4000.
	cfg := &BXGYConfig{BuyQuantity: 2, GetQuantity: 1, BuyProductIDs: []string{"a"},
		GetProductIDs: []string{"b"}, GetDiscountKind: DiscountPercentage, GetDiscountValue: 50}
	r := Compute(PricingInput{Items: []LineItem{bxgyItem("a", "M", 10000, 2), bxgyItem("b", "M", 8000, 1)},
		Promos: []PromoSpec{{Kind: DiscountBuyXGetY, BXGY: cfg}}})
	if r.PromoDiscount != 4000 {
		t.Fatalf("got %v want 4000", r.PromoDiscount)
	}
	// only 1 b but need buy2/get1 with a x2 -> still 1; with a x1 -> 0 applications
	r0 := Compute(PricingInput{Items: []LineItem{bxgyItem("a", "M", 10000, 1), bxgyItem("b", "M", 8000, 1)},
		Promos: []PromoSpec{{Kind: DiscountBuyXGetY, BXGY: cfg}}})
	if r0.PromoDiscount != 0 {
		t.Fatalf("scarcity got %v want 0", r0.PromoDiscount)
	}
}

func TestCalcBXGYFixedCappedAtUnit(t *testing.T) {
	// fixed 99999 off the get unit, capped at the unit price (5000 free)
	cfg := &BXGYConfig{BuyQuantity: 1, GetQuantity: 1, GetDiscountKind: DiscountFixed, GetDiscountValue: 99999}
	r := Compute(PricingInput{Items: []LineItem{bxgyItem("a", "M", 5000, 2)},
		Promos: []PromoSpec{{Kind: DiscountBuyXGetY, BXGY: cfg}}})
	if r.PromoDiscount != 5000 {
		t.Fatalf("got %v want 5000 (capped)", r.PromoDiscount)
	}
}

func TestCalcBXGYVariantLevelKey(t *testing.T) {
	// buy 1 get 1 of "b|10ml" only; a "b|50ml" line must NOT qualify as a get.
	cfg := &BXGYConfig{BuyQuantity: 1, GetQuantity: 1, BuyProductIDs: []string{"a"},
		GetProductIDs: []string{variantKey("b", "10ml")}, GetDiscountKind: DiscountPercentage, GetDiscountValue: 100}
	r := Compute(PricingInput{Items: []LineItem{bxgyItem("a", "M", 10000, 1), bxgyItem("b", "50ml", 8000, 1)},
		Promos: []PromoSpec{{Kind: DiscountBuyXGetY, BXGY: cfg}}})
	if r.PromoDiscount != 0 {
		t.Fatalf("wrong-variant got %v want 0", r.PromoDiscount)
	}
	r2 := Compute(PricingInput{Items: []LineItem{bxgyItem("a", "M", 10000, 1), bxgyItem("b", "10ml", 8000, 1)},
		Promos: []PromoSpec{{Kind: DiscountBuyXGetY, BXGY: cfg}}})
	if r2.PromoDiscount != 8000 {
		t.Fatalf("right-variant got %v want 8000", r2.PromoDiscount)
	}
}

func TestCalcBXGYNilConfigIsZero(t *testing.T) {
	r := Compute(PricingInput{Items: []LineItem{bxgyItem("a", "M", 10000, 3)},
		Promos: []PromoSpec{{Kind: DiscountBuyXGetY, BXGY: nil}}})
	if r.PromoDiscount != 0 {
		t.Fatalf("nil cfg got %v want 0", r.PromoDiscount)
	}
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && go test ./internal/service/ -run TestCalcBXGY -v`
Expected: FAIL — `BXGYConfig`/`DiscountBuyXGetY` undefined, `LineItem` has no `VariantSize`.

- [ ] **Step 3: Add `VariantSize` to `LineItem`** in `pricing.go`:

```go
type LineItem struct {
	ProductID   string
	VariantSize string // pid|size matching for buy_x_get_y; empty = product-level line
	Price       float64
	Quantity    int
	Subtotal    float64
}
```

- [ ] **Step 4: Populate `VariantSize` at the build site** — `order.go:177`:

```go
		items[i] = LineItem{ProductID: it.ProductID, VariantSize: it.VariantSize, Price: it.Price, Quantity: it.Quantity, Subtotal: it.Subtotal}
```

- [ ] **Step 5: Add the type + config + engine branch** in `pricing.go`. Change the import block to `import ("log/slog"; "math"; "sort")`. Add the const, struct, `BXGY` field, helpers, and the branch:

```go
const DiscountBuyXGetY DiscountKind = "buy_x_get_y"

// BXGYConfig is the buy_x_get_y rule (stored as promotions.bxgy_config jsonb).
type BXGYConfig struct {
	BuyQuantity      int          `json:"buyQuantity"`
	GetQuantity      int          `json:"getQuantity"`
	BuyProductIDs    []string     `json:"buyProductIds"`  // composite pid|size keys; empty = any item
	GetProductIDs    []string     `json:"getProductIds"`  // composite pid|size keys; empty = same-set mode
	GetDiscountKind  DiscountKind `json:"getDiscountKind"`
	GetDiscountValue float64      `json:"getDiscountValue"`
	MaxApplications  int          `json:"maxApplications"` // 0 = unlimited
}
```

Add `BXGY *BXGYConfig` to `PromoSpec` (after `IsBOGO`). Add helpers + the branch:

```go
// keyMatchesLine: a "pid" key matches any variant; a "pid|size" key matches that variant only.
func keyMatchesLine(keys []string, productID, size string) bool {
	if contains(keys, productID) {
		return true
	}
	return size != "" && contains(keys, variantKey(productID, size))
}

// bxgyExpand returns the per-unit price list for matching lines. When keys is
// empty, emptyMatchesAll decides (true = every line, false = none).
func bxgyExpand(items []LineItem, keys []string, emptyMatchesAll bool) []float64 {
	var prices []float64
	for _, i := range items {
		match := emptyMatchesAll
		if len(keys) > 0 {
			match = keyMatchesLine(keys, i.ProductID, i.VariantSize)
		}
		if !match {
			continue
		}
		for n := 0; n < i.Quantity; n++ {
			prices = append(prices, i.Price)
		}
	}
	return prices
}

func calcBXGY(c *BXGYConfig, items []LineItem) float64 {
	if c == nil || c.BuyQuantity < 1 || c.GetQuantity < 1 {
		slog.Warn("buy_x_get_y: invalid config, 0 discount", "config", c)
		return 0
	}
	var getPool []float64
	var nApp int
	if len(c.GetProductIDs) == 0 {
		// same-set: each application consumes (X+Y) units; discount cheapest Y.
		pool := bxgyExpand(items, c.BuyProductIDs, true)
		nApp = len(pool) / (c.BuyQuantity + c.GetQuantity)
		getPool = pool
	} else {
		// separate-set: need X buy units AND Y get units; whichever is scarcer caps.
		var buyPool []float64
		if len(c.BuyProductIDs) == 0 {
			for _, i := range items { // any unit NOT in the get set
				if keyMatchesLine(c.GetProductIDs, i.ProductID, i.VariantSize) {
					continue
				}
				for n := 0; n < i.Quantity; n++ {
					buyPool = append(buyPool, i.Price)
				}
			}
		} else {
			buyPool = bxgyExpand(items, c.BuyProductIDs, false)
		}
		getPool = bxgyExpand(items, c.GetProductIDs, false)
		nApp = len(buyPool) / c.BuyQuantity
		if g := len(getPool) / c.GetQuantity; g < nApp {
			nApp = g
		}
	}
	if c.MaxApplications > 0 && nApp > c.MaxApplications {
		nApp = c.MaxApplications
	}
	if nApp <= 0 {
		return 0
	}
	nDiscount := nApp * c.GetQuantity
	sort.Float64s(getPool) // cheapest first
	if nDiscount > len(getPool) {
		nDiscount = len(getPool)
	}
	var total float64
	for k := 0; k < nDiscount; k++ {
		switch c.GetDiscountKind {
		case DiscountPercentage:
			total += math.Round(getPool[k] * (c.GetDiscountValue / 100))
		case DiscountFixed:
			total += math.Min(c.GetDiscountValue, getPool[k])
		}
	}
	return total
}
```

In `calcPromotionDiscount`, add at the top (before the `scoped` logic) a dispatch so BXGY bypasses the percentage/fixed/bogo path:

```go
func calcPromotionDiscount(p *PromoSpec, items []LineItem, sub float64) float64 {
	if p.Kind == DiscountBuyXGetY {
		return calcBXGY(p.BXGY, items)
	}
	scoped := len(p.ApplicableProductIDs) > 0
	// ... unchanged ...
```

- [ ] **Step 6: Run all service tests (new branch + parity)**

Run: `cd backend && go test ./internal/service/ -v`
Expected: PASS — new `TestCalcBXGY*` pass AND every pre-existing `TestCompute*`/`TestComputePromo*` still passes (the `LineItem.VariantSize` addition is inert for them).

- [ ] **Step 7: Commit**

```bash
git add backend/internal/service/pricing.go backend/internal/service/order.go backend/internal/service/pricing_test.go
git commit -m "feat(promo-sp3b): buy_x_get_y pricing engine branch + variant-level matching"
```

---

### Task 2: Migration 0038 + `resolvePromos` blob parsing (Go)

**Files:**
- Create: `backend/internal/db/migrations/0038_promo_bxgy.sql`
- Modify: `backend/internal/service/order.go` (`loadPromoSpec`, ~646-669 — load `bxgy_config`, populate `spec.BXGY` when type is `buy_x_get_y`)
- Test: `backend/internal/service/order_promo3b_test.go` (new)

**Interfaces:**
- Consumes: `BXGYConfig`, `DiscountBuyXGetY`, `PromoSpec.BXGY` (Task 1).
- Produces: a resolved `PromoSpec` whose `Kind == DiscountBuyXGetY` and `BXGY` is parsed from the row, reachable directly and (via 3c `loadPromoSpec` reuse) through a linked code with no extra code.

- [ ] **Step 1: Write the migration**

```sql
-- 0038_promo_bxgy.sql — SP-Promo-3b: configurable buy-X-get-Y promotion type.
ALTER TABLE promotions DROP CONSTRAINT promotions_type_check;
ALTER TABLE promotions ADD CONSTRAINT promotions_type_check
  CHECK (type IN ('percentage','fixed','bogo','buy_x_get_y'));
ALTER TABLE promotions ADD COLUMN bxgy_config jsonb;
```

> Confirm the existing constraint name first: `\d promotions` shows it as `promotions_type_check` (Postgres default `<table>_<col>_check`). If it differs, use the real name.

- [ ] **Step 2: Write the failing resolution test** — `order_promo3b_test.go` (pure, no DB; tests the parse helper extracted in Step 3):

```go
package service

import "testing"

func TestParseBXGYConfig(t *testing.T) {
	raw := []byte(`{"buyQuantity":2,"getQuantity":1,"buyProductIds":["a"],"getProductIds":["b|10ml"],"getDiscountKind":"percentage","getDiscountValue":100,"maxApplications":3}`)
	c, err := parseBXGYConfig(raw)
	if err != nil || c == nil {
		t.Fatalf("parse err=%v c=%v", err, c)
	}
	if c.BuyQuantity != 2 || c.GetQuantity != 1 || c.GetDiscountValue != 100 || c.MaxApplications != 3 {
		t.Fatalf("bad parse: %+v", c)
	}
	if len(c.GetProductIDs) != 1 || c.GetProductIDs[0] != "b|10ml" {
		t.Fatalf("bad getProductIds: %+v", c.GetProductIDs)
	}
}

func TestParseBXGYConfigNullIsNil(t *testing.T) {
	c, err := parseBXGYConfig(nil)
	if err != nil || c != nil {
		t.Fatalf("nil raw should give nil,nil got %v,%v", c, err)
	}
}
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd backend && go test ./internal/service/ -run TestParseBXGY -v`
Expected: FAIL — `parseBXGYConfig` undefined.

- [ ] **Step 4: Implement `parseBXGYConfig` + extend `loadPromoSpec`**. In `order.go` add (near `loadPromoSpec`):

```go
// parseBXGYConfig unmarshals the bxgy_config jsonb. nil/empty -> (nil, nil).
func parseBXGYConfig(raw []byte) (*BXGYConfig, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil
	}
	var c BXGYConfig
	if err := json.Unmarshal(raw, &c); err != nil {
		return nil, fmt.Errorf("parse bxgy_config: %w", err)
	}
	return &c, nil
}
```

In `loadPromoSpec`, add `bxgy_config` to the SELECT and scan into a `[]byte`, then attach when the type matches. Updated query + tail:

```go
	var bxgyRaw []byte
	e := tx.QueryRow(ctx,
		`SELECT type, value,
		   COALESCE(applicable_product_ids,'[]'::jsonb),
		   start_date, end_date, min_purchase,
		   COALESCE(active_from_hour,''), COALESCE(active_to_hour,''),
		   COALESCE(active_days,'[]'::jsonb), COALESCE(outlet_ids,'[]'::jsonb),
		   COALESCE(combinable,false), COALESCE(code_only,false), bxgy_config
		   FROM promotions WHERE id=$1 AND is_active=true`, promoID).
		Scan(&kind, &value, &ids, &row.StartDate, &row.EndDate, &row.MinPurchase,
			&row.ActiveFromHour, &row.ActiveToHour, &row.ActiveDays, &row.OutletIDs,
			&row.Combinable, &codeOnly, &bxgyRaw)
	// ... existing ErrNoRows / err handling unchanged ...
	spec = PromoSpec{Kind: DiscountKind(kind), Value: value, ApplicableProductIDs: ids, IsBOGO: kind == "bogo"}
	if spec.Kind == DiscountBuyXGetY {
		cfg, perr := parseBXGYConfig(bxgyRaw)
		if perr != nil {
			return PromoSpec{}, false, false, nil, false, perr
		}
		spec.BXGY = cfg
	}
	return spec, row.Combinable, codeOnly, ValidatePromo(row, ec), true, nil
```

> Confirm `encoding/json` is imported in `order.go` (it is used elsewhere; add to the import block if not).

- [ ] **Step 5: Run to verify it passes**

Run: `cd backend && go test ./internal/service/ -run TestParseBXGY -v && cd backend && go build ./...`
Expected: PASS + clean build.

- [ ] **Step 6: Commit**

```bash
git add backend/internal/db/migrations/0038_promo_bxgy.sql backend/internal/service/order.go backend/internal/service/order_promo3b_test.go
git commit -m "feat(promo-sp3b): migration 0038 + resolvePromos parses bxgy_config"
```

---

### Task 3: Write/read repo wiring + save-time validation (Go) — gap-class core

**Files:**
- Modify: `backend/internal/write/repo.go` (`Promotion` struct ~472-491; `CreatePromotion` INSERT ~493-516; `UpdatePromotion` UPDATE ~518-539; add `validateBXGY`)
- Modify: `backend/internal/read/repo.go` (`Promotions` json_build_object ~830-840)
- Test: `backend/internal/write/repo_test.go` (new `TestValidateBXGY*` — pure validation)

**Interfaces:**
- Consumes: `service.BXGYConfig` shape (mirror the JSON field names exactly).
- Produces: `bxgy_config` persisted on INSERT and UPDATE; returned as `bxgyConfig` by the read API; invalid configs rejected at save with a clear error.

- [ ] **Step 1: Write failing validation tests** — `write/repo_test.go`:

```go
package write

import "testing"

func TestValidateBXGYRejectsBadQuantities(t *testing.T) {
	if err := validateBXGY(&BXGYConfigInput{BuyQuantity: 0, GetQuantity: 1, GetDiscountKind: "percentage", GetDiscountValue: 100}); err == nil {
		t.Fatal("buyQuantity 0 must be rejected")
	}
}
func TestValidateBXGYRejectsPercentOver100(t *testing.T) {
	if err := validateBXGY(&BXGYConfigInput{BuyQuantity: 1, GetQuantity: 1, GetDiscountKind: "percentage", GetDiscountValue: 150}); err == nil {
		t.Fatal("percentage 150 must be rejected")
	}
}
func TestValidateBXGYRejectsOverlap(t *testing.T) {
	c := &BXGYConfigInput{BuyQuantity: 1, GetQuantity: 1, GetDiscountKind: "fixed", GetDiscountValue: 1000,
		BuyProductIDs: []string{"a"}, GetProductIDs: []string{"a"}}
	if err := validateBXGY(c); err == nil {
		t.Fatal("overlapping buy/get sets must be rejected")
	}
}
func TestValidateBXGYAcceptsValid(t *testing.T) {
	c := &BXGYConfigInput{BuyQuantity: 2, GetQuantity: 1, GetDiscountKind: "percentage", GetDiscountValue: 100,
		BuyProductIDs: []string{"a"}, GetProductIDs: []string{"b"}}
	if err := validateBXGY(c); err != nil {
		t.Fatalf("valid config rejected: %v", err)
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && go test ./internal/write/ -run TestValidateBXGY -v`
Expected: FAIL — `validateBXGY`/`BXGYConfigInput` undefined.

- [ ] **Step 3: Add the struct field, validation, and wiring**. In `write/repo.go`:

Add to the `Promotion` struct (after `EndDate`):
```go
	BXGYConfig *BXGYConfigInput `json:"bxgyConfig"`
```
Add the input type + validator:
```go
type BXGYConfigInput struct {
	BuyQuantity      int      `json:"buyQuantity"`
	GetQuantity      int      `json:"getQuantity"`
	BuyProductIDs    []string `json:"buyProductIds"`
	GetProductIDs    []string `json:"getProductIds"`
	GetDiscountKind  string   `json:"getDiscountKind"`
	GetDiscountValue float64  `json:"getDiscountValue"`
	MaxApplications  int      `json:"maxApplications"`
}

func validateBXGY(c *BXGYConfigInput) error {
	if c == nil {
		return fmt.Errorf("bxgyConfig required for buy_x_get_y")
	}
	if c.BuyQuantity < 1 || c.GetQuantity < 1 || c.MaxApplications < 0 {
		return fmt.Errorf("invalid bxgy quantities")
	}
	switch c.GetDiscountKind {
	case "percentage":
		if c.GetDiscountValue <= 0 || c.GetDiscountValue > 100 {
			return fmt.Errorf("bxgy percentage must be 0<v<=100")
		}
	case "fixed":
		if c.GetDiscountValue <= 0 {
			return fmt.Errorf("bxgy fixed value must be >0")
		}
	default:
		return fmt.Errorf("bxgy getDiscountKind must be percentage|fixed")
	}
	if len(c.GetProductIDs) > 0 {
		for _, g := range c.GetProductIDs {
			if contains(c.BuyProductIDs, g) {
				return fmt.Errorf("bxgy buy/get sets must not overlap")
			}
		}
	}
	return nil
}
```
> If `contains` is not already in package `write`, inline a tiny local membership check instead.

In `CreatePromotion` and `UpdatePromotion`, before the SQL, gate + marshal:
```go
		if p.Type == "buy_x_get_y" {
			if err := validateBXGY(p.BXGYConfig); err != nil {
				return err // Create: return "", err
			}
		}
		bxgy, _ := jsonb(p.BXGYConfig) // nil -> SQL NULL
```
Add `bxgy_config` as the next column/placeholder in **both** the INSERT column list+VALUES and the UPDATE SET list, passing `bxgy` as the matching arg. (INSERT: add `, bxgy_config` and `$19`; UPDATE: add `, bxgy_config=$19` and shift the `WHERE id` placeholder to `$20`.)

- [ ] **Step 4: Wire the read side** — `read/repo.go` `Promotions`, add before `'createdAt'`:
```go
		   'bxgyConfig',bxgy_config,
```

- [ ] **Step 5: Run validation tests + build**

Run: `cd backend && go test ./internal/write/ -run TestValidateBXGY -v && go build ./...`
Expected: PASS + clean build.

- [ ] **Step 6: Commit**

```bash
git add backend/internal/write/repo.go backend/internal/read/repo.go backend/internal/write/repo_test.go
git commit -m "feat(promo-sp3b): persist+read bxgy_config (INSERT+UPDATE+json) with save-time validation"
```

---

### Task 4: OpenAPI schema + codegen (Go + TS types)

**Files:**
- Modify: `backend/api/openapi.yaml` (`Promotion` ~985-1010 and `PromotionInput` ~1645-1670: extend `type` enum, add `bxgyConfig`; add a `BXGYConfig` component schema)
- Regenerate: `backend/internal/api/api.gen.go`, `packages/api/src/schema.d.ts`

**Interfaces:**
- Produces: `components['schemas']['Promotion']['bxgyConfig']` (TS) + `Promotion.BxgyConfig` (Go) carrying the 7 fields; `type` enum includes `buy_x_get_y`.

- [ ] **Step 1: Add a reusable component schema** under `components.schemas` in `openapi.yaml`:

```yaml
    BXGYConfig:
      type: object
      properties:
        buyQuantity: { type: integer }
        getQuantity: { type: integer }
        buyProductIds: { type: array, items: { type: string } }
        getProductIds: { type: array, items: { type: string } }
        getDiscountKind: { type: string, enum: [percentage, fixed] }
        getDiscountValue: { type: number }
        maxApplications: { type: integer }
      required: [buyQuantity, getQuantity, getDiscountKind, getDiscountValue]
```

- [ ] **Step 2: Reference it from both Promotion schemas + extend the enum**

In `Promotion` (line ~992) and `PromotionInput` (line ~1649) change:
```yaml
        type: { type: string, enum: [percentage, fixed, bogo, buy_x_get_y] }
```
In both, add a property (alongside `codeOnly`):
```yaml
        bxgyConfig:
          allOf: [{ $ref: '#/components/schemas/BXGYConfig' }]
          nullable: true
```
> The `allOf`-wrapped `$ref` keeps Go pointer generation; `openapi-typescript` will still drop `nullable` on the ref (known gotcha) — TS code must clear the field by omitting it, never by `null`.

- [ ] **Step 3: Regenerate both clients**

Run:
```bash
cd backend && make gen
corepack pnpm@10.11.1 --filter @mandalika/api gen
```
Expected: `api.gen.go` gains `BxgyConfig *BXGYConfig` on `Promotion`/`PromotionInput`; `schema.d.ts` gains `bxgyConfig`.

- [ ] **Step 4: Verify no drift + build both sides**

Run: `cd backend && make gen-check && go build ./... && cd ../packages/api && corepack pnpm@10.11.1 -w exec tsc -b`
Expected: gen-check clean; both build.

- [ ] **Step 5: Commit**

```bash
git add backend/api/openapi.yaml backend/internal/api/api.gen.go packages/api/src/schema.d.ts
git commit -m "feat(promo-sp3b): OpenAPI bxgyConfig + buy_x_get_y enum, regen Go+TS clients"
```

---

### Task 5: POS pricing parity (TypeScript) — money path

**Files:**
- Modify: `apps/pos/src/cashier/pricing.ts` (`calcPromoDiscount` add `buy_x_get_y` branch + helpers; `linkedPromoShape` carry `bxgyConfig`)
- Test: `apps/pos/src/cashier/pricing.test.ts` (mirror the Go `TestCalcBXGY*` cases)

**Interfaces:**
- Consumes: `Promotion.bxgyConfig` (Task 4 TS type); `CartItem.variantSize` (already exists).
- Produces: `calcPromoDiscount` returns the same number as Go `calcBXGY` for identical inputs.

- [ ] **Step 1: Write failing parity tests** in `pricing.test.ts` (use the existing `CartItem` factory pattern; mirror Task 1 numbers): same-set buy-2-get-1 free → 10000; repeat 6 units → 20000; cap 1 → 10000; separate %-off → 4000; scarcity → 0; fixed capped → 5000; variant-level wrong/right → 0/8000; nil config → 0.

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/pos && corepack pnpm@10.11.1 exec vitest run src/cashier/pricing.test.ts`
Expected: FAIL — branch not implemented.

- [ ] **Step 3: Implement the branch** in `calcPromoDiscount` (mirror Go 1:1). Add a `variantKey`/`keyMatchesLine` helper and a `calcBXGY(cfg, items)` that returns the same algorithm, then dispatch at the top:

```ts
function variantKey(productId: string, size: string): string {
  return `${productId}|${size}`
}
function keyMatchesLine(keys: string[], productId: string, size: string): boolean {
  return keys.includes(productId) || (size !== '' && keys.includes(variantKey(productId, size)))
}
// ... bxgyExpand + calcBXGY mirroring pricing.go (sort ascending, cheapest nApp*Y units,
//     percentage => Math.round(price*v/100), fixed => Math.min(v, price)) ...

export function calcPromoDiscount(promo: Promotion, items: CartItem[], sub: number): number {
  if (promo.type === 'buy_x_get_y') return calcBXGY(promo.bxgyConfig ?? null, items)
  // ... existing percentage/fixed/bogo unchanged ...
```
Add `bxgyConfig: c.promotion.bxgyConfig ?? null` to the object returned by `linkedPromoShape` so a linked `buy_x_get_y` code prices correctly (3c).

- [ ] **Step 4: Run all POS unit tests**

Run: `cd apps/pos && corepack pnpm@10.11.1 exec vitest run && corepack pnpm@10.11.1 exec tsc -b`
Expected: PASS (new parity cases + all existing) + clean tsc.

- [ ] **Step 5: Commit**

```bash
git add apps/pos/src/cashier/pricing.ts apps/pos/src/cashier/pricing.test.ts
git commit -m "feat(promo-sp3b): POS pricing parity for buy_x_get_y (mirrors Go calcBXGY)"
```

---

### Task 6: Backoffice authoring form (TSX) — Haiku-tier

**Files:**
- Modify: `apps/backoffice/src/screens/promotions/PromoFormModal.tsx` (add `buy_x_get_y` to the type selector; render the BXGY sub-form; hide `value`/`applicableProductIds` for this type; client-side mirror of Task 3 invariants)
- Reuse: `apps/backoffice/src/screens/customers/ProductVariantPicker.tsx` (drill-down composite-key picker)

**Interfaces:**
- Consumes: `Promotion['bxgyConfig']` (Task 4); `ProductVariantPicker` props (existing).
- Produces: a `bxgyConfig` object on the saved promotion when type is `buy_x_get_y`.

- [ ] **Step 1: Add the type option** to the promo type `<select>`: `<option value="buy_x_get_y">Beli X, Gratis/Diskon Y</option>`.
- [ ] **Step 2: Add `bxgyConfig` to the form state** (default `{ buyQuantity: 2, getQuantity: 1, buyProductIds: [], getProductIds: [], getDiscountKind: 'percentage', getDiscountValue: 100, maxApplications: 0 }`), included in the submit payload only when `type === 'buy_x_get_y'` (else send `bxgyConfig: undefined` — never `null`, per the codegen gotcha).
- [ ] **Step 3: Render the sub-form** when `type === 'buy_x_get_y'` and hide the `value` + `applicableProductIds` inputs: number inputs for Buy X / Get Y / Max (0 = "tanpa batas"); two `ProductVariantPicker`s (Produk Beli, Produk Hadiah — note "kosongkan = sama dengan produk beli"); a kind `<select>` (percentage/fixed) + value input with a "Gratis" button that sets `getDiscountKind:'percentage', getDiscountValue:100`.
- [ ] **Step 4: Client-side guard before save** mirroring `validateBXGY` (qty ≥ 1, percentage 0<v≤100, fixed v>0, no buy/get overlap) — block submit with an inline message.
- [ ] **Step 5: Build the backoffice**

Run: `cd apps/backoffice && corepack pnpm@10.11.1 exec tsc -b && corepack pnpm@10.11.1 exec vite build`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add apps/backoffice/src/screens/promotions/PromoFormModal.tsx
git commit -m "feat(promo-sp3b): backoffice buy_x_get_y authoring form (variant pickers + guards)"
```

---

### Task 7: Gap-class round-trip guard + bonus gap-audit

**Files:**
- Create: `backend/cmd/promo3bsmoke/main.go` (throwaway authed round-trip; deleted after Task 9) OR a documented `curl` sequence in the plan log.
- Audit (read-only): `backend/internal/read/repo.go`, `backend/internal/write/repo.go`, `backend/api/openapi.yaml`.

- [ ] **Step 1: Round-trip serialization check (required gate).** With the backend running against the test DB, `POST /promotions` a fully-populated `buy_x_get_y` payload (both buy+get sets, one variant-level `pid|size` key, `getDiscountKind:"fixed"`, `maxApplications:3`) → `GET /promotions` → assert **every** `bxgyConfig` sub-field round-trips identical and `type==="buy_x_get_y"`. Delete the test row. A half-wired read/write fails here.
- [ ] **Step 2: Bonus gap-audit (user-requested).** For every field in the OpenAPI `Promotion` and `DiscountCode` schemas, grep that it appears in (a) the read `json_build_object`, (b) the write INSERT column list, (c) the write UPDATE SET list. Produce a 3-column checklist (field × read/INSERT/UPDATE). Expected all ✓ (3a `combinable` fixed in `ef1dced`, 3c `code_only` passed). Fix any genuine half-wiring found; if none, record "gap-audit clean" in the handoff.
- [ ] **Step 3: Commit** (audit notes / smoke tool):

```bash
git add backend/cmd/promo3bsmoke/
git commit -m "test(promo-sp3b): bxgy_config round-trip guard + promo/code field gap-audit"
```

---

### Task 8: Live e2e against the test DB

**Files:**
- Create: `backend/cmd/promo3be2e/main.go` (throwaway; real `service.OrderService`; zero-residue cleanup — same protocol as `promo3e2e`/`promo3ce2e`)

- [ ] **Step 1: Write the e2e** exercising: same-set buy-2-get-1 free order → expected discount + stock; separate-set %-off; cap honored; repeat; variant-level key; refund restores; dedupe with a 3c-linked `buy_x_get_y` code applies once. Assert each, then delete all artifacts and self-check zero residue.
- [ ] **Step 2: Run it**

Run: `cd backend && go run ./cmd/promo3be2e`
Expected: all asserts pass; "CLEANUP OK".

- [ ] **Step 3: Local full gate**

Run: `cd backend && go build ./... && go test ./... && make gen-check`
Expected: all green.

- [ ] **Step 4: Commit** (then the tool is removed in Task 9):

```bash
git add backend/cmd/promo3be2e/
git commit -m "test(promo-sp3b): live e2e proves buy_x_get_y discount/refund/dedupe (zero-residue)"
```

---

### Task 9: Deploy, APK, handoff

- [ ] **Step 1: Push** all commits to `origin/prod-hardening` (retry on flaky network; confirm with `git ls-remote origin prod-hardening`).
- [ ] **Step 2: Deploy backend** (`--source .`) — migration 0038 applies; confirm `/readyz` 200.
- [ ] **Step 3: Live round-trip smoke** (Task 7 Step 1) against the deployed rev — confirm `bxgyConfig` serializes live.
- [ ] **Step 4: Build the APK** — `git push` first (already done), then `"/c/Program Files/GitHub CLI/gh.exe" workflow run android-release.yml --ref prod-hardening` (default `api_url` = Cloud Run URL). Watch to green.
- [ ] **Step 5: Remove throwaway tools** (`promo3be2e`, `promo3bsmoke` if not kept) and commit the removal.
- [ ] **Step 6: Update `SESSION_HANDOFF.md`** (new ✅ SP-Promo-3b banner: rev, migration 0038, APK run id, gap-audit result, USER-PENDING on-device acceptance) and the [[promotion-module-sp-promo]] memory.
- [ ] **Step 7: Commit + push the handoff.**

```bash
git add SESSION_HANDOFF.md
git commit -m "docs(promo-sp3b): handoff — deployed, APK, gap-audit result, user-pending on-device"
```

**USER-PENDING after this plan:** on-device acceptance — author a `buy_x_get_y` promo in backoffice (both same-set and separate-set, a variant-level get), then at the POS confirm the discount rings correctly (free / %, repeat, cap), stacks if combinable (3a), and applies via a linked code (3c).

---

## Self-Review

- **Spec coverage:** §1 data model → T2/T3/T4; §2 engine + LineItem.VariantSize → T1; §3 invariants → T3; §4 resolution → T2; §5 POS → T5; §6 backoffice → T6; §7 type-gen → T4; §8 gap guard + audit → T7; §9 verification → T1/T5/T7/T8; §10 routing → header; §11 rollout → T9. All covered.
- **Placeholder scan:** engine/resolution/validation/migration code is complete; T5/T6 reference the Go originals to mirror 1:1 (numbers given) rather than re-pasting — acceptable since the canonical code is in T1/T3.
- **Type consistency:** `BXGYConfig` (service, Go field names) ↔ `BXGYConfigInput` (write, JSON tags) ↔ `BXGYConfig` OpenAPI schema ↔ `bxgyConfig` TS — field names `buyQuantity/getQuantity/buyProductIds/getProductIds/getDiscountKind/getDiscountValue/maxApplications` are identical across all four. `DiscountBuyXGetY = "buy_x_get_y"` matches the DB CHECK + OpenAPI enum + TS `promo.type` literal.
