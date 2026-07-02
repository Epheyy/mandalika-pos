# SP-Promo-3b-bundle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `bundle` promotion type — buy a set of products (slots-with-alternatives) together, priced at a fixed `bundlePrice`, realized by zeroing the cheapest set items to Rp0/GRATIS via reward-line materialization.

**Architecture:** New per-type `bundle_config` jsonb blob on `promotions` (Approach 2, mirrors `bxgy_config`/`tiered_config`). Pure engine helpers (`bundleApplications`, `bundleAllocate`) select which units are freed cheapest-first; `calcPromotionDiscount(bundle)` returns 0 (the saving lives in the freed reward lines). A new server-authoritative `resolveBundleLines` (sibling to `resolveRewardLines`, partitioned by promo type) re-derives/reprices freed lines, conserves stock, writes grants, hybrid-by-origin. POS applies via reward lines (`isReward`, `rewardPromotionId`), with a `BundleSlotPicker` modal only when a slot is ambiguous.

**Tech Stack:** Go (backend), TypeScript/React (POS `apps/pos`, backoffice `apps/backoffice`), Postgres (Neon), oapi-codegen + openapi-typescript for type-gen, vitest (POS), `go test` (backend).

**Spec:** `docs/superpowers/specs/2026-07-02-promo-sp3b-bundle-design.md`

## Global Constraints

- Follow the six working rules (ask-don't-assume / don't-touch-unrelated / flag-uncertainty / verify-on-failure / show-changes / admit-gaps).
- **Money parity:** the Go `pricing.go` and TS `pricing.ts` bundle logic must be byte-identical in behavior (mirror `math.Round`↔`Math.round`, `math.Min`↔`Math.min`). Whole-rupiah (IDR, no minor unit).
- **Hybrid-by-origin:** ONLINE (`in.Offline == false`) invalid → `*ErrDiscountRejected` → HTTP 422 + Indonesian message. OFFLINE → honor the sale as rung + set `discount_warning` + reason; never drop a bundle-freed line (it is a physical unit the customer is taking).
- **Gap-class trace:** any new column must be wired at ALL of: read `json_build_object`, write INSERT, write UPDATE, OpenAPI schema, both generated clients, AND the backoffice edit-populate handlers (`openEditPromo`/`dupPromo`/`togglePromo`) + list labels.
- **Composite keys:** slot `productKeys` use the `pid` (product-level) or `pid|size` (variant-level) convention; match with the existing `keyMatchesLine(keys, productID, size)` helper.
- `bundlePrice` fixed-price only. Cheapest-first freeing keeps the expensive anchor; the last freed unit may be partially discounted (net > 0) — allowed, no guard.
- Overlapping slots (a `productKey` in two slots) rejected at save-time.
- Existing `percentage`/`fixed`/`bogo`/`buy_x_get_y`/`tiered` rows must remain byte-identical in behavior (additive migration + type value).
- **Model routing:** Sonnet implements. **Opus** reviews Tasks 2, 3, 4, 5, 6, 7 (engine/persistence/type-gen/server-resolver/POS-money/reducer). **Haiku** reviews Tasks 1, 9, 10 (migration/form/labels). Task 8 Opus (apply money path). Announce the tier per task.
- **Deploy/APK:** push before `gh workflow run android-release.yml --ref prod-hardening` (builds from origin). Backend deploy pre-authorized via `autoMode.allow`.

---

## File Structure

**Backend (Go):**
- `backend/internal/db/migrations/0041_promo_bundle.sql` — CREATE (migration).
- `backend/internal/service/pricing.go` — MODIFY: `BundleConfig`/`BundleSlot` structs, `DiscountBundle`, `PromoSpec.Bundle`, `bundleApplications`, `bundleAllocate`, `calcPromotionDiscount` bundle branch.
- `backend/internal/service/pricing_test.go` — MODIFY: table tests for the helpers + branch.
- `backend/internal/write/repo.go` — MODIFY: `BundleConfigInput`/`BundleSlotInput`, `validateBundle`, `Promotion.BundleConfig`, INSERT/UPDATE `bundle_config`.
- `backend/internal/read/repo.go` — MODIFY: `'bundleConfig', bundle_config` in `Promotions`.
- `backend/internal/service/order.go` — MODIFY: `loadPromoSpec` bundle branch, `resolveRewardLines` partition-skip, new `resolveBundleLines`, `CreateOrder` wiring, `ViolationBundleInvalid`.
- `backend/internal/service/order_test.go` (or `promo_bundle_test.go`) — CREATE/MODIFY: `resolveBundleLines` tests.
- `backend/api/openapi.yaml` — MODIFY: `BundleSlot`/`BundleConfig` schemas, `bundle` enum, `bundleConfig` on `Promotion`+`PromotionInput`.
- `backend/internal/api/api.gen.go`, `packages/api/src/schema.d.ts` — REGENERATE.
- `backend/internal/service/promo_validate.go` — MODIFY: `ViolationBundleInvalid` constant + message.

**POS (`apps/pos/src/cashier`):**
- `pricing.ts` — MODIFY: `BundleConfig` type, `bundleApplications`/`bundleAllocate` TS ports, `calcPromoDiscount` bundle→0.
- `pricing.test.ts` — MODIFY: parity tests.
- `state/cashierReducer.ts` — MODIFY: bundle apply/remove reward-line wiring (reuse `CART_ADD_REWARD`/`CART_REMOVE_PROMO_REWARDS`, reduce/restore paid qty).
- `BundleSlotPicker.tsx` — CREATE: ambiguous-slot picker modal (sibling to `BxgyRewardModal.tsx`).
- `PromoPanel.tsx` — MODIFY: bundle apply gate + apply → picker-or-apply + savings display.
- `CashierScreen.tsx` — MODIFY: wire the picker modal + apply handler.

**Backoffice (`apps/backoffice/src/screens`):**
- `promotions/PromoFormModal.tsx` — MODIFY: "Paket Bundel" type card + slot editor + `bundlePrice`/`maxApplications` + default seed + client validation.
- `Promotions.tsx` — MODIFY: edit-populate `bundleConfig` in `openEditPromo`/`dupPromo`/`togglePromo`; `promoTypeLabel`/`promoValueLabel` bundle labels.

---

## Task 1: Migration 0041 — `bundle` type + `bundle_config` column

**Files:**
- Create: `backend/internal/db/migrations/0041_promo_bundle.sql`

**Interfaces:**
- Produces: `promotions.bundle_config jsonb` column; `bundle` allowed in the `promotions_type_check` constraint.

- [ ] **Step 1: Write the migration** (mirrors `0040_promo_tiered.sql`)

```sql
-- 0041_promo_bundle.sql — SP-Promo-3b-bundle: multi-product bundle (fixed price).
ALTER TABLE promotions DROP CONSTRAINT promotions_type_check;
ALTER TABLE promotions ADD CONSTRAINT promotions_type_check
  CHECK (type IN ('percentage','fixed','bogo','buy_x_get_y','tiered','bundle'));
ALTER TABLE promotions ADD COLUMN bundle_config jsonb;
```

- [ ] **Step 2: Verify migration loads** (the fsmigrate embed picks up new files automatically)

Run: `cd backend && go build ./...`
Expected: builds clean (migration is embedded, no separate registration).

- [ ] **Step 3: Commit**

```bash
git add backend/internal/db/migrations/0041_promo_bundle.sql
git commit -m "feat(promo-bundle): migration 0041 bundle type + bundle_config column"
```

---

## Task 2: Engine core — bundle types, matching, allocation, discount branch (Go)

**Files:**
- Modify: `backend/internal/service/pricing.go` (near the `TieredConfig`/`pickTier` block ~L36-61 and `calcPromotionDiscount` ~L249)
- Test: `backend/internal/service/pricing_test.go`

**Interfaces:**
- Produces:
  - `type BundleSlot struct { ProductKeys []string; Quantity int }` (json `productKeys`,`quantity`)
  - `type BundleConfig struct { Slots []BundleSlot; BundlePrice float64; MaxApplications int }` (json `slots`,`bundlePrice`,`maxApplications`)
  - `const DiscountBundle DiscountKind = "bundle"`
  - `PromoSpec.Bundle *BundleConfig`
  - `func bundleApplications(c *BundleConfig, items []LineItem) int` — how many complete sets the item multiset supports, capped by `MaxApplications` (0 = unlimited); 0 if nil/empty/unsatisfied.
  - `func bundleAllocate(prices []float64, bundlePrice float64, nApp int) []float64` — given the `nApp*len(slots)` consumed unit prices, returns each unit's NET after cheapest-first zeroing to reach `D = sum(prices) - bundlePrice*nApp` (never negative); returned slice aligns to the input order.
- Consumes: existing `keyMatchesLine(keys []string, productID, size string) bool` (order.go), `LineItem`.

- [ ] **Step 1: Write failing tests**

```go
func TestBundleApplications(t *testing.T) {
	cfg := &BundleConfig{
		Slots: []BundleSlot{
			{ProductKeys: []string{"p110"}, Quantity: 1},
			{ProductKeys: []string{"atomA", "atomB"}, Quantity: 1},
			{ProductKeys: []string{"p2ml"}, Quantity: 1},
		},
		BundlePrice: 575000, MaxApplications: 0,
	}
	full := []LineItem{
		{ProductID: "p110", Quantity: 1}, {ProductID: "atomA", Quantity: 1}, {ProductID: "p2ml", Quantity: 1},
	}
	if got := bundleApplications(cfg, full); got != 1 {
		t.Fatalf("full set: want 1, got %d", got)
	}
	// two full sets (atom via either alternative)
	two := []LineItem{
		{ProductID: "p110", Quantity: 2}, {ProductID: "atomA", Quantity: 1}, {ProductID: "atomB", Quantity: 1}, {ProductID: "p2ml", Quantity: 2},
	}
	if got := bundleApplications(cfg, two); got != 2 {
		t.Fatalf("two sets: want 2, got %d", got)
	}
	// missing the 2ml slot → 0
	miss := []LineItem{{ProductID: "p110", Quantity: 1}, {ProductID: "atomA", Quantity: 1}}
	if got := bundleApplications(cfg, miss); got != 0 {
		t.Fatalf("missing slot: want 0, got %d", got)
	}
	// cap
	capped := &BundleConfig{Slots: cfg.Slots, BundlePrice: 575000, MaxApplications: 1}
	if got := bundleApplications(capped, two); got != 1 {
		t.Fatalf("capped: want 1, got %d", got)
	}
	if got := bundleApplications(nil, full); got != 0 {
		t.Fatalf("nil cfg: want 0, got %d", got)
	}
}

func TestBundleAllocate(t *testing.T) {
	// owner's clean case: 575000 + 225000 + 1, bundlePrice 575000 → free the two cheapest.
	nets := bundleAllocate([]float64{575000, 225000, 1}, 575000, 1)
	// aligns to input order: 575000 anchor kept, 225000 -> 0, 1 -> 0
	if nets[0] != 575000 || nets[1] != 0 || nets[2] != 0 {
		t.Fatalf("clean: want [575000 0 0], got %v", nets)
	}
	// partial: bundlePrice 500000 → D=300001; free 1 and 225000, then 110ml reduced by 75000 → 500000
	p := bundleAllocate([]float64{575000, 225000, 1}, 500000, 1)
	if p[0] != 500000 || p[1] != 0 || p[2] != 0 {
		t.Fatalf("partial: want [500000 0 0], got %v", p)
	}
	// bundlePrice above set value → D=0, nothing freed
	none := bundleAllocate([]float64{100, 50}, 200, 1)
	if none[0] != 100 || none[1] != 50 {
		t.Fatalf("no-discount: want [100 50], got %v", none)
	}
}

func TestCalcPromotionDiscountBundleIsZero(t *testing.T) {
	cfg := &BundleConfig{Slots: []BundleSlot{{ProductKeys: []string{"p110"}, Quantity: 1}}, BundlePrice: 100}
	p := &PromoSpec{Kind: DiscountBundle, Bundle: cfg}
	if got := calcPromotionDiscount(p, []LineItem{{ProductID: "p110", Price: 200, Quantity: 1, Subtotal: 200}}, 200); got != 0 {
		t.Fatalf("bundle discount must be 0 (saving in freed lines), got %v", got)
	}
}
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `cd backend && go test ./internal/service/ -run 'TestBundle|TestCalcPromotionDiscountBundle' -v`
Expected: FAIL (undefined: `BundleConfig`, `bundleApplications`, `bundleAllocate`, `DiscountBundle`).

- [ ] **Step 3: Add the types + const** (in `pricing.go`, after the `TieredConfig` block ~L46)

```go
const DiscountBundle DiscountKind = "bundle"

// BundleSlot is one slot of a bundle: any one of ProductKeys satisfies it,
// Quantity units per set. Keys are pid or pid|size (keyMatchesLine).
type BundleSlot struct {
	ProductKeys []string `json:"productKeys"`
	Quantity    int      `json:"quantity"`
}

// BundleConfig (promotions.bundle_config jsonb) is a fixed-price bundle: the
// consumed set is priced at BundlePrice; the saving is realized by zeroing the
// cheapest consumed units (materialized as reward lines), not a lump discount.
type BundleConfig struct {
	Slots           []BundleSlot `json:"slots"`
	BundlePrice     float64      `json:"bundlePrice"`
	MaxApplications int          `json:"maxApplications"`
}

// bundleApplications reports how many complete sets `items` supports, capped by
// MaxApplications (0 = unlimited). Save-time validation rejects overlapping
// slots, so per-slot unit counting never double-claims a unit.
func bundleApplications(c *BundleConfig, items []LineItem) int {
	if c == nil || len(c.Slots) == 0 {
		return 0
	}
	n := -1
	for _, slot := range c.Slots {
		if slot.Quantity < 1 || len(slot.ProductKeys) == 0 {
			return 0
		}
		units := 0
		for _, it := range items {
			if keyMatchesLine(slot.ProductKeys, it.ProductID, it.VariantSize) {
				units += it.Quantity
			}
		}
		k := units / slot.Quantity
		if n < 0 || k < n {
			n = k
		}
	}
	if n < 0 {
		n = 0
	}
	if c.MaxApplications > 0 && n > c.MaxApplications {
		n = c.MaxApplications
	}
	return n
}

// bundleAllocate returns the NET price of each consumed unit after zeroing the
// cheapest units first until the discount D = sum(prices) - bundlePrice*nApp is
// spent. D is floored at 0. The returned slice aligns to the input order.
func bundleAllocate(prices []float64, bundlePrice float64, nApp int) []float64 {
	nets := make([]float64, len(prices))
	copy(nets, prices)
	d := 0.0
	for _, p := range prices {
		d += p
	}
	d -= bundlePrice * float64(nApp)
	if d <= 0 {
		return nets
	}
	// indices sorted by price ascending (cheapest first).
	idx := make([]int, len(prices))
	for i := range idx {
		idx[i] = i
	}
	sort.SliceStable(idx, func(a, b int) bool { return prices[idx[a]] < prices[idx[b]] })
	for _, i := range idx {
		if d <= 0 {
			break
		}
		if prices[i] <= d {
			nets[i] = 0
			d -= prices[i]
		} else {
			nets[i] = prices[i] - d
			d = 0
		}
	}
	return nets
}
```

- [ ] **Step 4: Add `Bundle` to `PromoSpec`** (pricing.go ~L81, after `Tiered *TieredConfig`)

```go
	Bundle               *BundleConfig
```

- [ ] **Step 5: Add the `calcPromotionDiscount` bundle branch** (pricing.go, after the `DiscountTiered` block ~L271, before the `scoped :=` line)

```go
	if p.Kind == DiscountBundle {
		// The saving is realized as zeroed reward lines (server resolveBundleLines),
		// so the promo itself contributes 0 to the additive discount stack — same
		// rationale as buy_x_get_y separate-set. Prevents double-discount.
		return 0
	}
```

- [ ] **Step 6: Run tests, verify they pass**

Run: `cd backend && go test ./internal/service/ -run 'TestBundle|TestCalcPromotionDiscountBundle' -v`
Expected: PASS.

- [ ] **Step 7: Full package test + build**

Run: `cd backend && go build ./... && go test ./internal/service/`
Expected: PASS (existing tests unaffected).

- [ ] **Step 8: Commit**

```bash
git add backend/internal/service/pricing.go backend/internal/service/pricing_test.go
git commit -m "feat(promo-bundle): engine — BundleConfig, bundleApplications, bundleAllocate, discount=0 branch"
```

---

## Task 3: Persist + validate `bundle_config` (write/read repo) + `loadPromoSpec`

**Files:**
- Modify: `backend/internal/write/repo.go` (the `TieredConfigInput`/`validateTiered`/`Promotion`/`CreatePromotion`/`UpdatePromotion` block, L487-662)
- Modify: `backend/internal/read/repo.go` (`Promotions`, ~L841)
- Modify: `backend/internal/service/order.go` (`loadPromoSpec`, ~L734-740)
- Test: `backend/internal/write/repo_test.go` (if present; else a `validateBundle` unit test in `write`)

**Interfaces:**
- Produces: `write.BundleConfigInput`/`BundleSlotInput`; `write.Promotion.BundleConfig *BundleConfigInput`; `bundle_config` persisted (INSERT $21 + UPDATE $21) and read as `bundleConfig`; `loadPromoSpec` parses `bundle_config` into `spec.Bundle` for `bundle`-type promos.
- Consumes: existing `jsonb()` helper, `validateTiered` pattern.

- [ ] **Step 1: Write a failing `validateBundle` test** (`backend/internal/write/repo_test.go`, or create it)

```go
func TestValidateBundle(t *testing.T) {
	ok := &BundleConfigInput{
		Slots: []BundleSlotInput{
			{ProductKeys: []string{"p110"}, Quantity: 1},
			{ProductKeys: []string{"atomA", "atomB"}, Quantity: 1},
		},
		BundlePrice: 575000, MaxApplications: 0,
	}
	if err := validateBundle(ok); err != nil {
		t.Fatalf("valid config rejected: %v", err)
	}
	cases := []*BundleConfigInput{
		nil,
		{Slots: nil, BundlePrice: 1},                                              // empty slots
		{Slots: []BundleSlotInput{{ProductKeys: nil, Quantity: 1}}, BundlePrice: 1}, // empty keys
		{Slots: []BundleSlotInput{{ProductKeys: []string{"p"}, Quantity: 0}}, BundlePrice: 1}, // qty<1
		{Slots: []BundleSlotInput{{ProductKeys: []string{"p"}, Quantity: 1}}, BundlePrice: 0}, // price<=0
		{Slots: []BundleSlotInput{ // overlapping key across slots
			{ProductKeys: []string{"p", "q"}, Quantity: 1},
			{ProductKeys: []string{"q"}, Quantity: 1},
		}, BundlePrice: 1},
	}
	for i, c := range cases {
		if err := validateBundle(c); err == nil {
			t.Fatalf("case %d: expected error, got nil", i)
		}
	}
}
```

- [ ] **Step 2: Run test, verify it fails**

Run: `cd backend && go test ./internal/write/ -run TestValidateBundle -v`
Expected: FAIL (undefined `BundleConfigInput`, `validateBundle`).

- [ ] **Step 3: Add the input types + validator** (write/repo.go, after `validateTiered` ~L518)

```go
type BundleSlotInput struct {
	ProductKeys []string `json:"productKeys"`
	Quantity    int      `json:"quantity"`
}
type BundleConfigInput struct {
	Slots           []BundleSlotInput `json:"slots"`
	BundlePrice     float64           `json:"bundlePrice"`
	MaxApplications int               `json:"maxApplications"`
}

func validateBundle(c *BundleConfigInput) error {
	if c == nil || len(c.Slots) == 0 {
		return fmt.Errorf("bundleConfig requires at least one slot")
	}
	if c.BundlePrice <= 0 {
		return fmt.Errorf("bundle bundlePrice must be > 0")
	}
	if c.MaxApplications < 0 {
		return fmt.Errorf("bundle maxApplications must be >= 0")
	}
	seen := map[string]bool{}
	for _, s := range c.Slots {
		if len(s.ProductKeys) == 0 {
			return fmt.Errorf("bundle slot requires at least one productKey")
		}
		if s.Quantity < 1 {
			return fmt.Errorf("bundle slot quantity must be >= 1")
		}
		for _, k := range s.ProductKeys {
			if seen[k] {
				return fmt.Errorf("bundle slots must not overlap on key %q", k)
			}
			seen[k] = true
		}
	}
	return nil
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `cd backend && go test ./internal/write/ -run TestValidateBundle -v`
Expected: PASS.

- [ ] **Step 5: Wire `BundleConfig` into `write.Promotion` + INSERT + UPDATE** (write/repo.go)

Add to the `Promotion` struct (after `TieredConfig` L569):
```go
	BundleConfig           *BundleConfigInput `json:"bundleConfig"`
```

In `CreatePromotion`, after the `tiered` validate block (~L582) add:
```go
	if p.Type == "bundle" {
		if err := validateBundle(p.BundleConfig); err != nil {
			return "", err
		}
	}
```
After the `var tiered any {...}` block (~L600) add:
```go
		var bundle any
		if p.Type == "bundle" && p.BundleConfig != nil {
			b, _ := jsonb(p.BundleConfig)
			bundle = b
		}
```
In the INSERT: add `bundle_config` to the column list (after `tiered_config`), add `$21` to VALUES, and pass `bundle` as the final arg (before `.Scan(&id)`):
```go
			INSERT INTO promotions (name, description, type, value, min_purchase,
			  applicable_product_ids, applicable_variant_keys,
			  applicable_variant_sizes, outlet_ids, combinable, combinable_with,
			  active_from_hour, active_to_hour, active_days, is_active,
			  start_date, end_date, code_only, bxgy_config, tiered_config, bundle_config)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
			RETURNING id`,
			p.Name, nullStr(p.Description), p.Type, p.Value, p.MinPurchase,
			apid, avk, avs, oid, p.Combinable, cw,
			nullStr(p.ActiveFromHour), nullStr(p.ActiveToHour), ad, p.IsActive,
			nullDate(p.StartDate), nullDate(p.EndDate), p.CodeOnly, bxgy, tiered, bundle).Scan(&id)
```

In `UpdatePromotion`, mirror: add the `validateBundle` block after the tiered one (~L627), the `var bundle any {...}` block after tiered (~L644), and in the UPDATE SQL add `bundle_config=$21`, shift the `WHERE id=$21`→`$22`, and pass `bundle` before `id`:
```go
			UPDATE promotions SET name=$1, description=$2, type=$3, value=$4,
			  min_purchase=$5, applicable_product_ids=$6, applicable_variant_keys=$7,
			  applicable_variant_sizes=$8, outlet_ids=$9, combinable=$10,
			  combinable_with=$11, active_from_hour=$12, active_to_hour=$13,
			  active_days=$14, is_active=$15, start_date=$16, end_date=$17, code_only=$18,
			  bxgy_config=$19, tiered_config=$20, bundle_config=$21
			WHERE id=$22`,
			p.Name, nullStr(p.Description), p.Type, p.Value, p.MinPurchase,
			apid, avk, avs, oid, p.Combinable, cw,
			nullStr(p.ActiveFromHour), nullStr(p.ActiveToHour), ad, p.IsActive,
			nullDate(p.StartDate), nullDate(p.EndDate), p.CodeOnly, bxgy, tiered, bundle, id)
```

- [ ] **Step 6: Wire the read json** (read/repo.go `Promotions`, after `'tieredConfig',tiered_config,` L841)

```go
		   'bundleConfig',bundle_config,
```

- [ ] **Step 7: Wire `loadPromoSpec`** (order.go, after the `DiscountTiered` block ~L739)

```go
	if spec.Kind == DiscountBundle {
		var cfg *BundleConfig
		if len(bundleConfigJSON) > 0 {
			if e := json.Unmarshal(bundleConfigJSON, &cfg); e != nil {
				slog.Warn("bad bundle_config", "promo", promoID, "err", e)
			}
		}
		spec.Bundle = cfg
	}
```
NOTE for implementer: `loadPromoSpec` selects `bxgy_config`/`tiered_config` into local `[]byte` vars (see how `spec.BXGY`/`spec.Tiered` are populated ~L727-739). Add `bundle_config` to that same SELECT + a `bundleConfigJSON []byte` scan target, following the exact existing pattern. Verify the column order in the SELECT matches the Scan.

- [ ] **Step 8: Build + test**

Run: `cd backend && go build ./... && go test ./internal/write/ ./internal/service/`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add backend/internal/write/repo.go backend/internal/read/repo.go backend/internal/service/order.go backend/internal/write/repo_test.go
git commit -m "feat(promo-bundle): persist+read bundle_config (INSERT+UPDATE+json) + validateBundle + loadPromoSpec"
```

---

## Task 4: OpenAPI schema + regenerate clients

**Files:**
- Modify: `backend/api/openapi.yaml` (schemas ~L998-1052 Promotion, ~L1690-1715 PromotionInput)
- Regenerate: `backend/internal/api/api.gen.go`, `packages/api/src/schema.d.ts`

**Interfaces:**
- Produces: `BundleSlot`/`BundleConfig` OpenAPI schemas; `bundle` in both `type` enums; `bundleConfig` (nullable allOf-$ref) on `Promotion` + `PromotionInput`; generated Go `BundleConfig`/`BundleSlot` structs + TS `Promotion['bundleConfig']`.

- [ ] **Step 1: Add the schemas** (openapi.yaml, after `TieredConfig` ~L1020)

```yaml
    BundleSlot:
      type: object
      required: [productKeys, quantity]
      properties:
        productKeys: { type: array, items: { type: string } }
        quantity: { type: integer }
    BundleConfig:
      type: object
      required: [slots, bundlePrice]
      properties:
        slots: { type: array, items: { $ref: '#/components/schemas/BundleSlot' } }
        bundlePrice: { type: number }
        maxApplications: { type: integer }
```

- [ ] **Step 2: Add `bundle` to both `type` enums + `bundleConfig` to both schemas**

`Promotion` (L1028) and `PromotionInput` (L1693): change
`enum: [percentage, fixed, bogo, buy_x_get_y, tiered]` → `enum: [percentage, fixed, bogo, buy_x_get_y, tiered, bundle]`.

`Promotion` (after `tieredConfig` L1051) and `PromotionInput` (after its `tieredConfig` ~L1715): add
```yaml
        bundleConfig:
          allOf: [{ $ref: '#/components/schemas/BundleConfig' }]
          nullable: true
```

- [ ] **Step 3: Regenerate Go + TS clients**

Run:
```bash
cd backend && make gen-check 2>&1 | head -5 || true
cd backend && go generate ./... 2>/dev/null || true   # if generation is wired via go:generate
# Go regen (oapi-codegen) — use the repo's existing command:
make -C backend gen
# TS regen (openapi-typescript needs corepack pnpm — not on subagent PATH):
corepack pnpm@10.11.1 --filter @mandalika/api gen
```
NOTE for implementer: use the EXACT commands the prior slices used (see the tiered commit `f849bdb` and the SP-Promo-3c note: `corepack pnpm@10.11.1 --filter @mandalika/api gen`). If `make gen` names differ, inspect `backend/Makefile`.

- [ ] **Step 4: Verify generation + the nullable-$ref gotcha**

Run: `grep -n "BundleConfig\|bundleConfig" backend/internal/api/api.gen.go packages/api/src/schema.d.ts | head`
Expected: Go `BundleConfig`/`BundleSlot` structs present; TS `bundleConfig?: components["schemas"]["BundleConfig"] | null`. If openapi-typescript dropped `| null` (the known `$ref`+nullable codegen gotcha — see memory `openapi-nullable-ref-codegen-gotcha`), that's acceptable: clearing the field in TS uses `undefined`/omit, not `null`. Confirm it matched `tieredConfig`'s treatment (it kept `| null` for tiered/bxgy).

- [ ] **Step 5: Build + gen-check**

Run: `cd backend && make gen-check && go build ./...`
Expected: gen-check clean (api.gen.go matches spec), build clean.

- [ ] **Step 6: Commit**

```bash
git add backend/api/openapi.yaml backend/internal/api/api.gen.go packages/api/src/schema.d.ts
git commit -m "feat(promo-bundle): OpenAPI BundleConfig + bundle enum, regen Go+TS clients"
```

---

## Task 5: Server `resolveBundleLines` — materialization, stock conservation, hybrid, grants

**Files:**
- Modify: `backend/internal/service/order.go` (add `resolveBundleLines`; wire into `CreateOrder` after `resolveRewardLines` ~L182-195; partition-skip in `resolveRewardLines` ~L1058-1062; write bundle grants alongside reward grants ~L382)
- Modify: `backend/internal/service/promo_validate.go` (add `ViolationBundleInvalid`)
- Test: `backend/internal/service/promo_bundle_test.go` (create)

**Interfaces:**
- Consumes: `bundleApplications`, `bundleAllocate` (Task 2); `loadPromoSpec` (Task 3); existing `loadRewardCatalog`, `write.RewardGrantRow`, `keyMatchesLine`, `variantKey`, `*ErrDiscountRejected`, `PromoViolation`, `JoinViolations`.
- Produces: `func (s *OrderService) resolveBundleLines(ctx, tx, in *CreateOrderInput) ([]write.RewardGrantRow, string, error)`; `ViolationBundleInvalid PromoViolation`.

**Contract (from spec §4):**
- A bundle-freed line is a `CartItem` with `IsReward == true` and `RewardPromotionID` pointing at a `bundle`-type promo. (Reuses existing fields; no schema change.)
- `resolveRewardLines` MUST skip (keep untouched) reward lines whose promo is not `buy_x_get_y`, so bundle lines survive to `resolveBundleLines`.
- `resolveBundleLines` re-derives from OWNED units (paid lines + bundle reward lines of that promo) that a valid set is present (`bundleApplications >= 1`), that the client's freed selection is legal (each freed unit eligible for a slot; freed count ≤ what a complete consumed set allows), reprices each freed line to its `bundleAllocate` net (server-authoritative), and writes one grant per freed unit.
- **Stock conservation:** the server does NOT add or remove physical units; it only reprices the freed reward lines. The POS is responsible for reducing the paid line qty when it adds a reward line; the server validates `owned units == expected` and rejects (online) / flags (offline) inflation.
- Hybrid: online invalid → `*ErrDiscountRejected{[]PromoViolation{ViolationBundleInvalid}}`; offline invalid → keep the line at the client price + append `ViolationBundleInvalid` to warns (never drop).

- [ ] **Step 1: Add the violation constant** (promo_validate.go, alongside `ViolationRewardInvalid`)

```go
	ViolationBundleInvalid PromoViolation = "bundle_invalid"
```
And in the handler message mapping (where `ViolationRewardInvalid` maps to its Indonesian string), add:
```go
	case ViolationBundleInvalid:
		return "Bundel tidak valid atau syaratnya tidak terpenuhi"
```
NOTE: find the existing message switch (search `ViolationRewardInvalid` in the handler/`violationMessage`).

- [ ] **Step 2: Write failing tests** (`promo_bundle_test.go`)

```go
package service

import "testing"

// buildBundleOrder is a helper: paid lines + freed reward lines for a bundle promo.
// (Implementer: mirror the fixtures used in resolveRewardLines tests — a fake
// OrderService with a stub tx that loadPromoSpec/loadRewardCatalog can read.
// If the existing reward tests use a real test DB, follow that harness instead.)

func TestResolveBundleLines_CleanCombo(t *testing.T) {
	// Cart: 110ml paid (575000), atomizer freed (isReward, net 0), 2ml freed (net 0).
	// Expect: freed lines repriced to server net (0), 2 grants, no error, no warn.
	t.Skip("implement against the reward-test harness; asserts: nets 0, len(grants)==2, warn==\"\"")
}

func TestResolveBundleLines_OnlineTamper(t *testing.T) {
	// Freed line present but the paid set is incomplete (no 110ml) → online → 422.
	t.Skip("asserts: err is *ErrDiscountRejected with ViolationBundleInvalid")
}

func TestResolveBundleLines_OfflineInvalidKept(t *testing.T) {
	// Same as tamper but in.Offline=true → line KEPT at client price, warn set.
	t.Skip("asserts: line retained, warn contains bundle_invalid, no error")
}

func TestResolveBundleLines_PartitionFromReward(t *testing.T) {
	// One bxgy reward line + one bundle reward line in the same order:
	// resolveRewardLines keeps the bundle line; resolveBundleLines keeps the bxgy line.
	t.Skip("asserts: neither resolver drops the other's line")
}
```
NOTE for implementer: the existing `resolveRewardLines` tests establish the harness (real test DB vs stubs). REPLACE these `t.Skip` bodies with concrete assertions using that same harness. Do NOT ship skipped tests — the live e2e (Task 11) is the backstop, but these unit tests must actually run.

- [ ] **Step 3: Implement `resolveBundleLines`** (order.go, after `resolveRewardLines`)

```go
// resolveBundleLines validates each SP-Promo-3b-bundle freed line (IsReward with a
// bundle-type RewardPromotionID) against its promo's slots, repricing valid lines
// to the SERVER net (cheapest-first, bundleAllocate) and emitting one grant per
// unit. Mutates in.Items in place. ONLINE invalid → *ErrDiscountRejected; OFFLINE
// invalid → keep the line at the client price + warn (never drop: a freed line is
// a physical unit the customer is taking). Partitioned from resolveRewardLines by
// promo type (bundle vs buy_x_get_y).
func (s *OrderService) resolveBundleLines(ctx context.Context, tx pgx.Tx, in *CreateOrderInput) ([]write.RewardGrantRow, string, error) {
	// group bundle reward lines by promo id
	byPromo := map[string]bool{}
	for _, it := range in.Items {
		if it.IsReward && it.RewardPromotionID != "" {
			spec, _, _, _, found, err := s.loadPromoSpec(ctx, tx, it.RewardPromotionID, PromoEvalContext{})
			if err != nil {
				return nil, "", err
			}
			if found && spec.Kind == DiscountBundle {
				byPromo[it.RewardPromotionID] = true
			}
		}
	}
	if len(byPromo) == 0 {
		return nil, "", nil
	}

	var grants []write.RewardGrantRow
	var warns []PromoViolation

	for promoID := range byPromo {
		spec, _, _, _, _, err := s.loadPromoSpec(ctx, tx, promoID, PromoEvalContext{})
		if err != nil {
			return nil, "", err
		}
		cfg := spec.Bundle

		// OWNED units for this promo's slots = paid lines + this promo's freed lines.
		var owned []LineItem
		for _, it := range in.Items {
			if it.IsReward && it.RewardPromotionID != promoID {
				continue // another promo's reward line — not part of this bundle's set
			}
			owned = append(owned, LineItem{ProductID: it.ProductID, VariantSize: it.VariantSize, Price: it.Price, Quantity: it.Quantity, Subtotal: it.Subtotal})
		}

		nApp := bundleApplications(cfg, owned)
		valid := cfg != nil && nApp >= 1

		// Collect this promo's freed lines (client's assignment) and their catalog prices.
		type freedRef struct {
			idx       int
			fullPrice float64
			name      string
		}
		var freed []freedRef
		freedUnits := 0
		for i := range in.Items {
			it := &in.Items[i]
			if !it.IsReward || it.RewardPromotionID != promoID {
				continue
			}
			cat, err := loadRewardCatalog(ctx, tx, it.ProductID, it.VariantSize)
			if err != nil {
				return nil, "", err
			}
			// each freed line's unit must be eligible for SOME slot
			eligible := cfg != nil && slotEligible(cfg, it.ProductID, it.VariantSize)
			if !cat.found || !eligible {
				valid = false
			}
			freed = append(freed, freedRef{idx: i, fullPrice: cat.fullPrice, name: cat.name})
			freedUnits += it.Quantity
		}

		// The freed units must be exactly the cheapest of the consumed set. A robust
		// check: the number of freed units per application must not exceed
		// (slotsPerSet-1)*nApp is NOT required (a whole set could be free if
		// bundlePrice is tiny); instead validate via bundleAllocate: reprice the
		// CONSUMED set (freed units + the anchor units) and confirm every freed
		// line's server net is <= its client price and the anchor(s) remain paid.
		// (Implementer: build the consumed prices = freed unit fullPrices + the
		// cheapest eligible paid units needed to complete nApp sets; run
		// bundleAllocate; assign nets back to the freed lines by matching the
		// cheapest allocated slots. See tests for exact expected nets.)

		if !valid {
			if !in.Offline {
				return nil, "", &ErrDiscountRejected{Violations: []PromoViolation{ViolationBundleInvalid}}
			}
			warns = append(warns, ViolationBundleInvalid)
			continue // keep the lines as-rung (offline honor)
		}

		// Reprice each freed line to its server net and emit grants.
		nets := bundleFreedNets(cfg, owned, freed) // implementer helper; returns net per freedRef.idx order
		for j, f := range freed {
			it := &in.Items[f.idx]
			net := nets[j]
			it.Price = net
			it.Subtotal = math.Round(net * float64(it.Quantity))
			for range it.Quantity {
				grants = append(grants, write.RewardGrantRow{
					PromotionID: promoID, ProductID: it.ProductID,
					ProductName: f.name, VariantSize: it.VariantSize,
					FullPrice: f.fullPrice, RewardPrice: net, RewardValue: f.fullPrice - net,
				})
			}
		}
	}

	warn := ""
	if len(warns) > 0 {
		warn = JoinViolations(warns)
	}
	return grants, warn, nil
}

// slotEligible reports whether (productID,size) satisfies any slot of the bundle.
func slotEligible(c *BundleConfig, productID, size string) bool {
	for _, slot := range c.Slots {
		if keyMatchesLine(slot.ProductKeys, productID, size) {
			return true
		}
	}
	return false
}
```

NOTE for implementer (Sonnet) + reviewer (Opus): the block computing `nets`/`bundleFreedNets` is the correctness crux. Its job: reconstruct the CONSUMED set (the client's freed units + the anchor units the server picks as the cheapest eligible non-freed owned units needed to complete `nApp` sets), run `bundleAllocate` over the consumed prices, and map the resulting nets back to the freed lines — asserting each freed line's server net ≤ its client price (else online-reject / offline-keep). Implement it TDD against the Task-5 tests (fill in the `t.Skip` bodies first with the exact expected nets from the owner's clean combo + the partial case). Prefer a small pure helper so it is unit-testable without a DB.

- [ ] **Step 4: Partition `resolveRewardLines`** (order.go ~L1058, the loop over reward lines)

In `resolveRewardLines`, after loading `cfg` for a reward line, if the promo is NOT buy_x_get_y (cfg came back nil because `spec.Kind != DiscountBuyXGetY`), the line belongs to another resolver (e.g. bundle) — KEEP it untouched instead of treating it as invalid:
```go
		// Partition: a reward line whose promo isn't buy_x_get_y (e.g. a bundle
		// freed line) is handled by its own resolver — pass it through untouched.
		if cfg == nil {
			// distinguish "promo is bundle/other type" from "bxgy promo missing":
			spec, _, _, _, found, e := s.loadPromoSpec(ctx, tx, it.RewardPromotionID, PromoEvalContext{})
			if e != nil {
				return nil, "", e
			}
			if found && spec.Kind != DiscountBuyXGetY {
				kept = append(kept, it)
				continue
			}
		}
```
NOTE: place this BEFORE the existing `ok, net := ...` entitlement check so bundle lines never hit the bxgy quota path. Verify against the current L1063-1096 flow; the existing `bxgyFor` already returns nil cfg for non-bxgy promos, so the cheapest wire is to branch on `spec.Kind` there.

- [ ] **Step 5: Wire into `CreateOrder`** (order.go, after the `resolveRewardLines` block ~L195)

```go
	// SP-Promo-3b-bundle: validate/reprice bundle-freed lines (server-authoritative),
	// conserve stock, emit grants. Runs after resolveRewardLines (partitioned by promo
	// type) and before pricing/stock/order_items.
	bundleGrants, bundleWarnReason, err := s.resolveBundleLines(ctx, tx, &in)
	if err != nil {
		return "", false, false, err
	}
	if bundleWarnReason != "" {
		discountWarning = true
		if discountWarnReason == "" {
			discountWarnReason = bundleWarnReason
		} else {
			discountWarnReason += "," + bundleWarnReason
		}
	}
	rewardGrants = append(rewardGrants, bundleGrants...)
```
The existing grant-write block (~L382) already iterates `rewardGrants` and stamps `orderID`; appending here means bundle grants are written with no further change. VERIFY that block writes all of `rewardGrants`.

- [ ] **Step 6: Build + run the new tests**

Run: `cd backend && go build ./... && go test ./internal/service/ -run 'TestResolveBundle' -v`
Expected: PASS (with the `t.Skip` bodies replaced by real assertions).

- [ ] **Step 7: Full backend test**

Run: `cd backend && go test ./...`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add backend/internal/service/order.go backend/internal/service/promo_validate.go backend/internal/service/promo_bundle_test.go
git commit -m "feat(promo-bundle): resolveBundleLines — materialize freed lines, stock-conserve, grants, hybrid; partition from reward resolver"
```

---

## Task 6: POS pricing.ts parity — bundle types, helpers, discount=0

**Files:**
- Modify: `apps/pos/src/cashier/pricing.ts` (types ~L15, `calcPromoDiscount` ~L189)
- Test: `apps/pos/src/cashier/pricing.test.ts`

**Interfaces:**
- Produces: `type BundleConfig = NonNullable<Promotion['bundleConfig']>`; `bundleApplications(cfg, items)`; `bundleAllocate(prices, bundlePrice, nApp)`; `calcPromoDiscount` returns 0 for `type === 'bundle'`. TS ports mirror the Go 1:1.

- [ ] **Step 1: Write failing parity tests** (pricing.test.ts)

```ts
import { bundleApplications, bundleAllocate } from './pricing'

const slots = (): NonNullable<Promotion['bundleConfig']>['slots'] => [
  { productKeys: ['p110'], quantity: 1 },
  { productKeys: ['atomA', 'atomB'], quantity: 1 },
  { productKeys: ['p2ml'], quantity: 1 },
]
const item = (productId: string, quantity: number) =>
  ({ productId, variantSize: '', price: 0, quantity, subtotal: 0, productName: '' }) as CartItem

test('bundleApplications counts complete sets, capped', () => {
  const cfg = { slots: slots(), bundlePrice: 575000, maxApplications: 0 }
  expect(bundleApplications(cfg, [item('p110', 1), item('atomA', 1), item('p2ml', 1)])).toBe(1)
  expect(bundleApplications(cfg, [item('p110', 2), item('atomA', 1), item('atomB', 1), item('p2ml', 2)])).toBe(2)
  expect(bundleApplications(cfg, [item('p110', 1), item('atomA', 1)])).toBe(0)
  expect(bundleApplications({ ...cfg, maxApplications: 1 }, [item('p110', 2), item('atomA', 1), item('atomB', 1), item('p2ml', 2)])).toBe(1)
  expect(bundleApplications(null, [item('p110', 1)])).toBe(0)
})

test('bundleAllocate zeros cheapest-first, keeps anchor', () => {
  expect(bundleAllocate([575000, 225000, 1], 575000, 1)).toEqual([575000, 0, 0])
  expect(bundleAllocate([575000, 225000, 1], 500000, 1)).toEqual([500000, 0, 0])
  expect(bundleAllocate([100, 50], 200, 1)).toEqual([100, 50])
})

test('calcPromoDiscount is 0 for a bundle promo', () => {
  const promo = { type: 'bundle', bundleConfig: { slots: slots(), bundlePrice: 100, maxApplications: 0 } } as Promotion
  expect(calcPromoDiscount(promo, [item('p110', 1)], 200)).toBe(0)
})
```

- [ ] **Step 2: Run, verify fail**

Run: `cd apps/pos && pnpm vitest run src/cashier/pricing.test.ts` (or `npx vitest run`)
Expected: FAIL (undefined `bundleApplications`/`bundleAllocate`).

- [ ] **Step 3: Add types + helpers** (pricing.ts, after `type TieredConfig` L16)

```ts
type BundleConfig = NonNullable<Promotion['bundleConfig']>

export function bundleApplications(
  cfg: BundleConfig | null | undefined,
  items: CartItem[],
): number {
  if (!cfg || cfg.slots.length === 0) return 0
  let n = -1
  for (const slot of cfg.slots) {
    if (slot.quantity < 1 || slot.productKeys.length === 0) return 0
    let units = 0
    for (const it of items) {
      if (keyMatchesLine(slot.productKeys, it.productId, it.variantSize)) units += it.quantity
    }
    const k = Math.floor(units / slot.quantity)
    if (n < 0 || k < n) n = k
  }
  if (n < 0) n = 0
  if (cfg.maxApplications > 0 && n > cfg.maxApplications) n = cfg.maxApplications
  return n
}

export function bundleAllocate(prices: number[], bundlePrice: number, nApp: number): number[] {
  const nets = [...prices]
  let d = prices.reduce((s, p) => s + p, 0) - bundlePrice * nApp
  if (d <= 0) return nets
  const idx = prices.map((_, i) => i).sort((a, b) => prices[a] - prices[b])
  for (const i of idx) {
    if (d <= 0) break
    if (prices[i] <= d) {
      nets[i] = 0
      d -= prices[i]
    } else {
      nets[i] = prices[i] - d
      d = 0
    }
  }
  return nets
}
```
NOTE: `keyMatchesLine` must exist in pricing.ts or be imported. The bxgy code already uses the `pid`/`pid|size` convention — reuse the SAME matcher (search pricing.ts for how bxgy matches `getProductIds`; if it's an inline helper, factor a shared `keyMatchesLine(keys, productId, variantSize)` and use it in both).

- [ ] **Step 4: Add the `calcPromoDiscount` bundle branch** (pricing.ts, after the `tiered` block L202)

```ts
  if (promo.type === 'bundle') {
    // saving is realized as zeroed reward lines (server resolveBundleLines), so the
    // promo contributes 0 to the additive stack — mirrors buy_x_get_y separate-set.
    return 0
  }
```

- [ ] **Step 5: Run tests, verify pass**

Run: `cd apps/pos && pnpm vitest run src/cashier/pricing.test.ts`
Expected: PASS.

- [ ] **Step 6: tsc + build**

Run: `cd apps/pos && pnpm tsc --noEmit && pnpm vite build`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add apps/pos/src/cashier/pricing.ts apps/pos/src/cashier/pricing.test.ts
git commit -m "feat(promo-bundle): POS pricing parity — bundleApplications/bundleAllocate, calcPromoDiscount bundle=0"
```

---

## Task 7: POS reducer — bundle apply/remove via reward lines (stock-conserving)

**Files:**
- Modify: `apps/pos/src/cashier/state/cashierReducer.ts`
- Test: `apps/pos/src/cashier/state/cashierReducer.test.ts`

**Interfaces:**
- Produces: a reducer path (new action(s) or an enhanced apply) that, given a bundle promo + a chosen consumed assignment, (a) reduces the affected paid line quantities by the freed counts, (b) adds `isReward` reward lines (`rewardPromotionId` = bundle id) at their `bundleAllocate` net, and on removal (c) removes those reward lines AND restores the paid quantities. Invariant: for every `(productId, variantSize)`, `paidQty + rewardQty == ownedQty` before and after (stock-conserving).
- Consumes: `bundleApplications`/`bundleAllocate` (Task 6); existing `CART_ADD_REWARD`, `CART_REMOVE_PROMO_REWARDS`, `CART_SET_QTY` actions.

- [ ] **Step 1: Write failing reducer tests** (cashierReducer.test.ts)

```ts
test('applying a bundle frees the cheapest units and conserves owned quantity', () => {
  // owned: 110ml x1 (575000), atomizer x1 (225000), 2ml x1 (1)
  // after apply(bundle, bundlePrice 575000): 110ml paid x1 @575000,
  // atomizer reward x1 @0, 2ml reward x1 @0. Total owned atomizer = 1 (paid0+reward1).
  // (Implementer: dispatch the bundle-apply action; assert cart lines + isReward flags.)
})

test('removing the bundle restores the freed units to paid', () => {
  // after apply then remove: cart back to 3 paid lines at full price, no reward lines.
})

test('two atomizers: only the chosen one is freed (picker assignment), other stays paid', () => {
  // owned: 110ml, atomA(225000), atomB(300000), 2ml. assignment picks atomA for the slot.
  // after apply: atomA + 2ml freed (reward), atomB stays paid @300000, 110ml paid.
})
```
NOTE for implementer: model the apply as the reducer receiving the fully-resolved freed set (list of `{productId, variantSize, quantity, net}`) computed by the caller (PromoPanel/CashierScreen using `bundleApplications`+`bundleAllocate`+the picker assignment). Keep the reducer pure: it applies the split (reduce paid, add reward) and the inverse on removal. Decide the exact action shape (e.g. `APPLY_BUNDLE`/reuse `CART_ADD_REWARD` per freed unit + `CART_SET_QTY` for the paid reduction) — whichever keeps the invariant testable.

- [ ] **Step 2: Run, verify fail**

Run: `cd apps/pos && pnpm vitest run src/cashier/state/cashierReducer.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the reducer path**

Implement per the chosen action shape so the three tests pass. Reuse `CART_ADD_REWARD` (keyed by `rewardPromotionId,productId,variantSize`) for freed units and reduce the matching paid line via the existing quantity logic; on removal reuse `CART_REMOVE_PROMO_REWARDS` and restore paid quantities. Keep the stock-conservation invariant.

- [ ] **Step 4: Run tests, verify pass**

Run: `cd apps/pos && pnpm vitest run src/cashier/state/cashierReducer.test.ts`
Expected: PASS.

- [ ] **Step 5: tsc**

Run: `cd apps/pos && pnpm tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add apps/pos/src/cashier/state/cashierReducer.ts apps/pos/src/cashier/state/cashierReducer.test.ts
git commit -m "feat(promo-bundle): POS reducer — apply/remove bundle via reward lines, stock-conserving"
```

---

## Task 8: POS PromoPanel gate + BundleSlotPicker modal + apply wiring

**Files:**
- Create: `apps/pos/src/cashier/BundleSlotPicker.tsx` (sibling to `BxgyRewardModal.tsx`)
- Modify: `apps/pos/src/cashier/PromoPanel.tsx` (gate + apply)
- Modify: `apps/pos/src/cashier/CashierScreen.tsx` (wire the modal + apply handler)

**Interfaces:**
- Consumes: `bundleApplications`/`bundleAllocate` (Task 6); the Task-7 reducer path; existing `displayProducts`/stock (`stockFor`) for the picker; `PromoPanel` `cart` prop (already added in 3a).
- Produces: apply-gate (grey until `bundleApplications(cfg, cart) > 0`); on apply, opens `BundleSlotPicker` only if any slot has more eligible cart units than required, else applies directly; computed savings shown on the applied chip.

- [ ] **Step 1: Build the apply-gate** in `PromoPanel.tsx`

Mirror the buy_x_get_y separate-set gate (search `PromoPanel.tsx` for the bxgy gate added on 2026-06-24: greys with "Syarat beli belum terpenuhi" when `calcPromoDiscount === 0`). For `promo.type === 'bundle'`, grey/disable with reason "Syarat bundle belum terpenuhi" when `bundleApplications(promo.bundleConfig, cart) === 0`. Fix any `promoRuleLabel`/type-label to render "Paket Bundel" (not defaulting to BOGO).

- [ ] **Step 2: Build `BundleSlotPicker.tsx`**

A modal (mirror `BxgyRewardModal.tsx` structure/styles). Props: `cfg: BundleConfig`, `cart: CartItem[]`, `stockFor(productId, variantSize) => number`, `onConfirm(assignment) => void`, `onCancel()`. For each AMBIGUOUS slot (eligible cart units > required), render a selector (radio/list) of the eligible units showing name + price + `· Stok N`; the cashier picks which unit(s) fill it. Unambiguous slots are auto-filled (shown read-only). Confirm emits the assignment (which specific units fill each slot).

- [ ] **Step 3: Wire apply in `CashierScreen.tsx`**

On applying a bundle promo: compute ambiguity (`any slot eligible units > required`). If ambiguous, open `BundleSlotPicker`; on confirm, compute the freed set (`bundleAllocate` over the consumed prices from the assignment) and dispatch the Task-7 apply. If unambiguous, compute the freed set directly and dispatch. Add reactive removal (paid units drop below the set → remove reward lines + the applied promo) mirroring the bxgy-reward reactive removal.

- [ ] **Step 4: Add a component/RTL test if the repo has POS component tests; else rely on tsc + vitest + the on-device check**

Run: `cd apps/pos && pnpm tsc --noEmit && pnpm vite build && pnpm vitest run`
Expected: clean; all vitest pass.

- [ ] **Step 5: Commit**

```bash
git add apps/pos/src/cashier/BundleSlotPicker.tsx apps/pos/src/cashier/PromoPanel.tsx apps/pos/src/cashier/CashierScreen.tsx
git commit -m "feat(promo-bundle): POS PromoPanel gate + BundleSlotPicker + apply wiring"
```

---

## Task 9: Backoffice PromoFormModal — bundle type card + slot editor

**Files:**
- Modify: `apps/backoffice/src/screens/promotions/PromoFormModal.tsx`

**Interfaces:**
- Consumes: the descriptive `PromoTypePicker` (commit `2525f46`), the `customers/ProductVariantPicker` (emits `pid`/`pid|size` PIPE keys — the same picker bxgy reuses).
- Produces: a "Paket Bundel" type card that seeds a default `bundleConfig` and renders a slot editor + `bundlePrice` + `maxApplications`; client-side validation mirroring `validateBundle`.

- [ ] **Step 1: Add the type card** to `PromoTypePicker` — label "Paket Bundel", description "Beli satu set produk sekaligus dengan harga paket tetap; item termurah jadi GRATIS." Selecting it seeds:
```ts
bundleConfig: { slots: [{ productKeys: [], quantity: 1 }], bundlePrice: 0, maxApplications: 0 }
```
and hides the `value` + `applicableProductIds`/variant inputs (mirror how bxgy/tiered hide them).

- [ ] **Step 2: Render the slot editor** (mirror the tiered tier-row editor added in `1485f8a`): rows of slots; each slot = a `ProductVariantPicker` multi-select (productKeys) + a quantity number input; add-slot / remove-slot buttons. Plus `bundlePrice` (label "Harga paket") and `maxApplications` (label "Maks. kelipatan (0 = tanpa batas)") number inputs.

- [ ] **Step 3: Client-side validation** before save: ≥1 slot, each slot has ≥1 key and quantity ≥ 1, `bundlePrice > 0`, no key appears in two slots (mirror `validateBundle`). Show inline errors; block save.

- [ ] **Step 4: Verify**

Run: `cd apps/backoffice && pnpm tsc --noEmit && pnpm vite build`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add apps/backoffice/src/screens/promotions/PromoFormModal.tsx
git commit -m "feat(promo-bundle): backoffice type card + slot editor + bundlePrice/maxApplications"
```

---

## Task 10: Backoffice edit-populate + list labels (gap-class frontend)

**Files:**
- Modify: `apps/backoffice/src/screens/Promotions.tsx` (`openEditPromo`/`dupPromo`/`togglePromo`; `promoTypeLabel`/`promoValueLabel`)

**Interfaces:**
- Produces: `bundleConfig` carried through edit/dup/toggle (so edit loads the slot editor populated + re-save preserves it); list Tipe/Nilai labels for `bundle`.

- [ ] **Step 1: Edit-populate** — in `openEditPromo`, `dupPromo`, and `togglePromo`, where the `PromotionInput` is rebuilt field-by-field (these carry `tieredConfig`/`bxgyConfig` — search `tieredConfig`), add `bundleConfig: p.bundleConfig` to all three. (This is the SP-Promo-3b frontend gap-class lesson: the edit-form-populate path must carry every typed field or edit loads blank + re-save wipes it.)

- [ ] **Step 2: List labels** — in `promoTypeLabel` add `case 'bundle': return 'Paket Bundel'`; in `promoValueLabel` add `case 'bundle': return 'Harga paket ' + formatRupiah(p.bundleConfig?.bundlePrice ?? 0)` (mirror the `ff709b4` label pattern; use the file's existing rupiah formatter). Confirm neither defaults `bundle` to "BOGO".

- [ ] **Step 3: Verify**

Run: `cd apps/backoffice && pnpm tsc --noEmit && pnpm vite build`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/backoffice/src/screens/Promotions.tsx
git commit -m "feat(promo-bundle): backoffice edit-populate bundleConfig + list labels"
```

---

## Task 11: Verification — gap-class audit, live e2e, deploy, APK

**Files:**
- Create (throwaway, NEVER commit): `backend/cmd/promo3bundle/main.go`

- [ ] **Step 1: Local gate (all)**

Run:
```bash
cd backend && go build ./... && go test ./... && make gen-check
cd apps/pos && pnpm tsc --noEmit && pnpm vite build && pnpm vitest run
cd apps/backoffice && pnpm tsc --noEmit && pnpm vite build
```
Expected: all green. If lockfile changed (a dependency was added), regenerate `pnpm-lock.yaml` (`corepack pnpm@10.11.1 install --lockfile-only`) and confirm the Cloudflare deploy stays green (see memory `cloudflare-frozen-lockfile-gotcha`). NOTE: no new dep is expected in this slice.

- [ ] **Step 2: Static gap-class audit**

Run: `grep -n "bundle_config\|bundleConfig" backend/internal/read/repo.go backend/internal/write/repo.go`
Expected: read json (1×), INSERT (1×), UPDATE (1×) all present. Confirm `bundleConfig` in `api.gen.go` + `schema.d.ts` (Task 4).

- [ ] **Step 3: Deploy backend (migration 0041)**

Deploy per the repo's Cloud Run deploy (pre-authorized via `autoMode.allow`). Confirm `/readyz` 200 and the new rev applied migration 0041.

- [ ] **Step 4: Live authed round-trip smoke** (the gap-class live check)

POST a bundle promotion (full `bundleConfig`: 2+ slots, bundlePrice, maxApplications) with an admin token → GET `/promotions` → assert `type: 'bundle'` + `bundleConfig.slots`/`bundlePrice`/`maxApplications` round-trip identical → DELETE (zero residue). NOTE: if the deployed admin creds differ from local `.env` (the SP-Promo-3c gotcha), use the user's `!`-login token.

- [ ] **Step 5: Live e2e** (`cmd/promo3bundle`, throwaway, real `OrderService` vs Neon, never committed, deleted after, zero-residue self-check)

Assert, on the deployed rev:
- The owner's combo (110ml paid + atomizer & 2ml as bundle reward lines) → order records 110ml full, atomizer & 2ml at Rp0, total == bundlePrice, `discount_amount` unaffected (bundle contributes 0), `promo_reward_grants` has one row per freed unit, stock decremented ONCE per physical unit (not twice).
- Repeats (two full sets → 2× freed, cap honored).
- Online tamper (a freed line without the complete paid set) → 422 `ViolationBundleInvalid`.
- Refund restocks all lines + grants immutable.
- Partition: an order with a bxgy reward line AND a bundle freed line → both resolved correctly, neither dropped.
- Cleanup deletes all artifacts; self-check confirms zero residue.

Run: `cd backend && go run ./cmd/promo3bundle` then delete the dir.
Expected: all asserts PASS; residue check clean.

- [ ] **Step 6: Build the APK** (POS changed)

```bash
git push   # push BEFORE triggering — gh workflow builds from origin
"/c/Program Files/GitHub CLI/gh.exe" workflow run android-release.yml --ref prod-hardening -f api_url=<cloudrun-url>
```
Watch the run to green; record the run id for the handoff.

- [ ] **Step 7: Update memories + handoff**

Update `promotion-module-sp-promo` + `MEMORY.md` + `SESSION_HANDOFF.md`: SP-Promo-3b-bundle DONE + deployed + live-proven; rev, migration 0041, commits, APK run id; USER-PENDING on-device acceptance. Note the module's remaining OPEN items (grant-reporting-view, SP-Promo-4 authoring UX incl. outlet selector + active-hours).

- [ ] **Step 8: Commit the handoff/memory doc changes**

```bash
git add SESSION_HANDOFF.md docs/superpowers
git commit -m "docs(promo-bundle): handoff — SP-Promo-3b-bundle deployed + live-proven"
git push
```

---

## Notes for the implementer

- **The crux is Task 5** (`resolveBundleLines` — stock conservation + the freed-net re-derivation). Do it strictly TDD: replace the `t.Skip` bodies with concrete expected values FIRST (use the owner's clean combo and the partial case from Task 2's `bundleAllocate` tests), then implement `bundleFreedNets` as a small pure helper so Opus can review it in isolation.
- **Parity:** every change to the Go freeing/allocation logic must land identically in `pricing.ts` (Task 6). The vitest parity cases and the Go table tests share the same numbers on purpose.
- **Do not touch** the legacy `bundles`/`bundle_items` SKU feature, the outlet-selector gap (SP-Promo-4), or unrelated working-tree changes (`package.json` doctor script, the audit PNGs).
- **Flag** anytime a step's reality differs from this plan (e.g. `loadPromoSpec`'s exact SELECT/Scan shape, or the reducer action names) — adapt and note it, don't force the plan.
