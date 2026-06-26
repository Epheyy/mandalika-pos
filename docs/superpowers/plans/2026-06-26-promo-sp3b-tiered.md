# SP-Promo-3b-tiered Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `tiered` promotion type — "spend more, save more": the cart gets the single highest tier it qualifies for (by subtotal), each tier carrying its own percentage/fixed discount; plus a POS "spend Rp X more for the next tier" hint.

**Architecture:** A new `DiscountKind` `tiered` whose ordered tiers live in one `promotions.tiered_config jsonb` blob (Approach 2, same as `bxgy_config`). The pricing engine (`pricing.go`, mirrored 1:1 in `pricing.ts`) gains a branch that picks the highest qualifying tier and returns its discount — a plain discount summed into the existing additive stack (no reward lines, no modal, no fulfillment, no grant). Inherits 3a stacking + 3c code-linkage for free.

**Tech Stack:** Go (service + pgx + oapi-codegen), Postgres (migration 0040), TypeScript (POS pricing/PromoPanel + vitest, backoffice React), OpenAPI.

## Global Constraints
- Branch `prod-hardening`. Conventional commits; **no attribution trailer**.
- Behavior: highest qualifying tier wins (the tier with the largest `minSubtotal ≤ subtotal`); whole-cart; below the lowest tier → 0; `percentage → round(sub × value/100)`, `fixed → min(value, sub)`.
- For a `tiered` promo, top-level `value`/`applicable_product_ids` are unused (the blob is the source of truth).
- Tiered is a PLAIN discount → `calcPromotionDiscount`/`calcPromoDiscount` return the tier amount (NOT 0; contrast bxgy separate-set).
- Nil/invalid `tiered_config` on a tiered promo → 0 + `slog.Warn` (never panic/422). Gating violations keep hybrid-by-origin.
- `validateTieredConfig` (save-time): ≥1 tier; each `minSubtotal ≥ 0`, `kind ∈ {percentage,fixed}`, percentage ⇒ `0 < value ≤ 100`, fixed ⇒ `value > 0`; reject duplicate `minSubtotal`.
- Gap-class: trace `tiered_config` through read json + BOTH write INSERT/UPDATE + the backoffice edit-populate (openEditPromo/dupPromo/togglePromo). The nullable-$ref codegen gotcha: clear in TS by omitting.
- Codegen: `make gen-check` gates api.gen.go; `schema.d.ts` via `corepack pnpm@10.11.1 --filter @mandalika/api gen`. APK: push BEFORE `gh workflow run`.
- Model routing: Sonnet implement; Opus review T1/T2/T3/T4/T5 (engine/resolution/type-gen/POS money); Haiku for T6 form/copy.

---

### Task 1: Engine — tiered type, pickTier, calcPromotionDiscount branch (Go)

**Files:**
- Modify: `backend/internal/service/pricing.go` (const, `Tier`/`TieredConfig`, `PromoSpec.Tiered`, `pickTier`, the branch)
- Test: `backend/internal/service/pricing_test.go`

**Interfaces:**
- Consumes: `DiscountKind`, `DiscountPercentage`, `DiscountFixed`, `math`.
- Produces: `const DiscountTiered DiscountKind = "tiered"`; `type Tier struct{ MinSubtotal float64; Kind DiscountKind; Value float64 }` (json `minSubtotal,kind,value`); `type TieredConfig struct{ Tiers []Tier }` (json `tiers`); `PromoSpec.Tiered *TieredConfig`; `func pickTier(c *TieredConfig, sub float64) *Tier`.

- [ ] **Step 1: Write the failing tests** — append to `pricing_test.go`:

```go
func TestPickTier(t *testing.T) {
	c := &TieredConfig{Tiers: []Tier{
		{MinSubtotal: 100000, Kind: DiscountFixed, Value: 10000},
		{MinSubtotal: 250000, Kind: DiscountPercentage, Value: 15},
		{MinSubtotal: 500000, Kind: DiscountPercentage, Value: 20},
	}}
	if pickTier(c, 50000) != nil {
		t.Fatal("below lowest tier should be nil")
	}
	if got := pickTier(c, 100000); got == nil || got.Value != 10000 {
		t.Fatalf("at 100k want tier1 got %+v", got)
	}
	if got := pickTier(c, 300000); got == nil || got.MinSubtotal != 250000 {
		t.Fatalf("at 300k want tier2 got %+v", got)
	}
	if got := pickTier(c, 999999); got == nil || got.MinSubtotal != 500000 {
		t.Fatalf("at 999k want tier3 got %+v", got)
	}
	// unsorted input still picks the highest qualifying
	u := &TieredConfig{Tiers: []Tier{{MinSubtotal: 500000, Kind: DiscountPercentage, Value: 20}, {MinSubtotal: 100000, Kind: DiscountFixed, Value: 10000}}}
	if got := pickTier(u, 600000); got == nil || got.MinSubtotal != 500000 {
		t.Fatalf("unsorted: want 500k tier got %+v", got)
	}
	if pickTier(nil, 100000) != nil {
		t.Fatal("nil config should be nil")
	}
}

func TestComputeTiered(t *testing.T) {
	cfg := &TieredConfig{Tiers: []Tier{
		{MinSubtotal: 100000, Kind: DiscountFixed, Value: 10000},
		{MinSubtotal: 250000, Kind: DiscountPercentage, Value: 15},
	}}
	// 300k subtotal -> tier2 15% = 45000
	r := Compute(PricingInput{Items: []LineItem{bxgyItem("a", "M", 300000, 1)},
		Promos: []PromoSpec{{Kind: DiscountTiered, Tiered: cfg}}})
	if r.PromoDiscount != 45000 {
		t.Fatalf("tiered discount = %v want 45000", r.PromoDiscount)
	}
	// 120k -> tier1 fixed 10000
	r2 := Compute(PricingInput{Items: []LineItem{bxgyItem("a", "M", 120000, 1)},
		Promos: []PromoSpec{{Kind: DiscountTiered, Tiered: cfg}}})
	if r2.PromoDiscount != 10000 {
		t.Fatalf("tier1 = %v want 10000", r2.PromoDiscount)
	}
	// 50k -> below lowest -> 0
	r3 := Compute(PricingInput{Items: []LineItem{bxgyItem("a", "M", 50000, 1)},
		Promos: []PromoSpec{{Kind: DiscountTiered, Tiered: cfg}}})
	if r3.PromoDiscount != 0 {
		t.Fatalf("below lowest = %v want 0", r3.PromoDiscount)
	}
	// nil config -> 0
	r4 := Compute(PricingInput{Items: []LineItem{bxgyItem("a", "M", 300000, 1)},
		Promos: []PromoSpec{{Kind: DiscountTiered, Tiered: nil}}})
	if r4.PromoDiscount != 0 {
		t.Fatalf("nil tiered = %v want 0", r4.PromoDiscount)
	}
}
```

- [ ] **Step 2: Run to verify FAIL** — `cd backend && go test ./internal/service/ -run 'TestPickTier|TestComputeTiered' -v` → FAIL (undefined).

- [ ] **Step 3: Implement** in `pricing.go`. Add the const next to `DiscountBuyXGetY` (line ~22), the types near `BXGYConfig`, and `Tiered *TieredConfig` to `PromoSpec` (after `BXGY`):

```go
const DiscountTiered DiscountKind = "tiered"

type Tier struct {
	MinSubtotal float64      `json:"minSubtotal"`
	Kind        DiscountKind `json:"kind"`
	Value       float64      `json:"value"`
}
type TieredConfig struct {
	Tiers []Tier `json:"tiers"`
}

// pickTier returns the highest tier whose MinSubtotal <= sub, or nil if none.
func pickTier(c *TieredConfig, sub float64) *Tier {
	if c == nil {
		return nil
	}
	var best *Tier
	for i := range c.Tiers {
		t := &c.Tiers[i]
		if sub >= t.MinSubtotal && (best == nil || t.MinSubtotal > best.MinSubtotal) {
			best = t
		}
	}
	return best
}
```

In `calcPromotionDiscount` (line ~220), add a branch alongside the buy_x_get_y one (the function receives `sub`):

```go
	if p.Kind == DiscountTiered {
		t := pickTier(p.Tiered, sub)
		if t == nil {
			return 0
		}
		switch t.Kind {
		case DiscountPercentage:
			return math.Round(sub * (t.Value / 100))
		case DiscountFixed:
			return math.Min(t.Value, sub)
		}
		return 0
	}
```

- [ ] **Step 4: Run all service tests** — `cd backend && go test ./internal/service/ -v` → PASS (new + all existing).
- [ ] **Step 5: Commit**

```bash
git add backend/internal/service/pricing.go backend/internal/service/pricing_test.go
git commit -m "feat(promo-tiered): tiered discount engine branch + pickTier"
```

---

### Task 2: Migration 0040 + resolvePromos parsing (Go)

**Files:**
- Create: `backend/internal/db/migrations/0040_promo_tiered.sql`
- Modify: `backend/internal/service/order.go` (`loadPromoSpec`: select `tiered_config`, populate `spec.Tiered` when type is `tiered`; add `parseTieredConfig`)
- Test: `backend/internal/service/order_tiered_test.go`

**Interfaces:**
- Consumes: `TieredConfig`, `DiscountTiered`, `PromoSpec.Tiered` (Task 1).
- Produces: `func parseTieredConfig(raw []byte) (*TieredConfig, error)` (nil/empty/"null" → nil,nil); a resolved `PromoSpec` with `Kind==DiscountTiered` and `Tiered` populated.

- [ ] **Step 1: Write the migration** `0040_promo_tiered.sql`:

```sql
-- 0040_promo_tiered.sql — SP-Promo-3b-tiered: spend-threshold tiered discount.
ALTER TABLE promotions DROP CONSTRAINT promotions_type_check;
ALTER TABLE promotions ADD CONSTRAINT promotions_type_check
  CHECK (type IN ('percentage','fixed','bogo','buy_x_get_y','tiered'));
ALTER TABLE promotions ADD COLUMN tiered_config jsonb;
```
> The current constraint name is `promotions_type_check` (confirmed: 0038 used it). Confirm via `\d promotions`/the prior migration before relying on it.

- [ ] **Step 2: Write the failing parse test** — `order_tiered_test.go`:

```go
package service

import "testing"

func TestParseTieredConfig(t *testing.T) {
	raw := []byte(`{"tiers":[{"minSubtotal":100000,"kind":"fixed","value":10000},{"minSubtotal":250000,"kind":"percentage","value":15}]}`)
	c, err := parseTieredConfig(raw)
	if err != nil || c == nil || len(c.Tiers) != 2 {
		t.Fatalf("parse err=%v c=%v", err, c)
	}
	if c.Tiers[1].Kind != DiscountPercentage || c.Tiers[1].Value != 15 {
		t.Fatalf("bad tier2: %+v", c.Tiers[1])
	}
}
func TestParseTieredConfigNullIsNil(t *testing.T) {
	c, err := parseTieredConfig(nil)
	if err != nil || c != nil {
		t.Fatalf("nil raw → nil,nil; got %v,%v", c, err)
	}
}
```

- [ ] **Step 3: Run to verify FAIL** — `cd backend && go test ./internal/service/ -run TestParseTiered -v` → FAIL.

- [ ] **Step 4: Implement.** Add near `parseBXGYConfig` in order.go:

```go
func parseTieredConfig(raw []byte) (*TieredConfig, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil
	}
	var c TieredConfig
	if err := json.Unmarshal(raw, &c); err != nil {
		return nil, fmt.Errorf("parse tiered_config: %w", err)
	}
	return &c, nil
}
```
In `loadPromoSpec`, add `tiered_config` as the LAST selected column (after `bxgy_config`), scan into a new `var tieredRaw []byte`, and after building `spec` (where the `DiscountBuyXGetY` block populates `spec.BXGY`), add the sibling:

```go
	if spec.Kind == DiscountTiered {
		cfg, perr := parseTieredConfig(tieredRaw)
		if perr != nil {
			return PromoSpec{}, false, false, nil, false, perr
		}
		spec.Tiered = cfg
	}
```
> Mirror exactly how the existing `bxgy_config` is selected/scanned/attached in `loadPromoSpec` (it added `bxgy_config` as the last column + `&bxgyRaw` scan target + the `spec.BXGY` block). Keep the ErrNoRows/error handling unchanged.

- [ ] **Step 5: Run + build** — `cd backend && go test ./internal/service/ -run TestParseTiered -v && go build ./... && go test ./internal/service/` → PASS + clean.
- [ ] **Step 6: Commit**

```bash
git add backend/internal/db/migrations/0040_promo_tiered.sql backend/internal/service/order.go backend/internal/service/order_tiered_test.go
git commit -m "feat(promo-tiered): migration 0040 + resolvePromos parses tiered_config"
```

---

### Task 3: Write/read repo wiring + validateTiered (Go)

**Files:**
- Modify: `backend/internal/write/repo.go` (`TieredConfigInput` + `validateTiered`; `Promotion` struct; `CreatePromotion` INSERT; `UpdatePromotion` UPDATE — mirror the `bxgy_config` wiring at ~472-583)
- Modify: `backend/internal/read/repo.go` (`Promotions` json — add `'tieredConfig', tiered_config` after `'bxgyConfig'` at line 840)
- Test: `backend/internal/write/repo_test.go`

**Interfaces:**
- Produces: `type TieredConfigInput struct{ Tiers []TierInput }` with `TierInput{ MinSubtotal float64 json:"minSubtotal"; Kind string json:"kind"; Value float64 json:"value" }`; `func validateTiered(c *TieredConfigInput) error`; `tiered_config` persisted on INSERT+UPDATE and returned as `tieredConfig`.

- [ ] **Step 1: Write failing validation tests** — `repo_test.go`:

```go
func TestValidateTieredRejectsEmpty(t *testing.T) {
	if validateTiered(&TieredConfigInput{Tiers: nil}) == nil {
		t.Fatal("empty tiers must be rejected")
	}
}
func TestValidateTieredRejectsBadValue(t *testing.T) {
	if validateTiered(&TieredConfigInput{Tiers: []TierInput{{MinSubtotal: 100000, Kind: "percentage", Value: 150}}}) == nil {
		t.Fatal("percentage 150 must be rejected")
	}
	if validateTiered(&TieredConfigInput{Tiers: []TierInput{{MinSubtotal: 0, Kind: "fixed", Value: 0}}}) == nil {
		t.Fatal("fixed 0 must be rejected")
	}
	if validateTiered(&TieredConfigInput{Tiers: []TierInput{{MinSubtotal: -1, Kind: "fixed", Value: 1000}}}) == nil {
		t.Fatal("negative minSubtotal must be rejected")
	}
}
func TestValidateTieredRejectsDuplicateThreshold(t *testing.T) {
	c := &TieredConfigInput{Tiers: []TierInput{
		{MinSubtotal: 100000, Kind: "fixed", Value: 1000},
		{MinSubtotal: 100000, Kind: "percentage", Value: 10},
	}}
	if validateTiered(c) == nil {
		t.Fatal("duplicate minSubtotal must be rejected")
	}
}
func TestValidateTieredAccepts(t *testing.T) {
	c := &TieredConfigInput{Tiers: []TierInput{
		{MinSubtotal: 100000, Kind: "fixed", Value: 10000},
		{MinSubtotal: 250000, Kind: "percentage", Value: 15},
	}}
	if err := validateTiered(c); err != nil {
		t.Fatalf("valid config rejected: %v", err)
	}
}
```

- [ ] **Step 2: Run to verify FAIL** — `cd backend && go test ./internal/write/ -run TestValidateTiered -v` → FAIL.

- [ ] **Step 3: Add the input types + validator** in `write/repo.go` (near `BXGYConfigInput`):

```go
type TierInput struct {
	MinSubtotal float64 `json:"minSubtotal"`
	Kind        string  `json:"kind"`
	Value       float64 `json:"value"`
}
type TieredConfigInput struct {
	Tiers []TierInput `json:"tiers"`
}

func validateTiered(c *TieredConfigInput) error {
	if c == nil || len(c.Tiers) == 0 {
		return fmt.Errorf("tieredConfig requires at least one tier")
	}
	seen := map[float64]bool{}
	for _, t := range c.Tiers {
		if t.MinSubtotal < 0 {
			return fmt.Errorf("tier minSubtotal must be >= 0")
		}
		if seen[t.MinSubtotal] {
			return fmt.Errorf("duplicate tier minSubtotal %v", t.MinSubtotal)
		}
		seen[t.MinSubtotal] = true
		switch t.Kind {
		case "percentage":
			if t.Value <= 0 || t.Value > 100 {
				return fmt.Errorf("tier percentage must be 0<v<=100")
			}
		case "fixed":
			if t.Value <= 0 {
				return fmt.Errorf("tier fixed value must be >0")
			}
		default:
			return fmt.Errorf("tier kind must be percentage|fixed")
		}
	}
	return nil
}
```

- [ ] **Step 4: Add the field + wire INSERT/UPDATE.** Add to the `Promotion` struct (after `BXGYConfig`): `TieredConfig *TieredConfigInput \`json:"tieredConfig"\``. In BOTH `CreatePromotion` and `UpdatePromotion`, mirror the existing `bxgy_config` block — gate + marshal:
```go
		if p.Type == "tiered" {
			if err := validateTiered(p.TieredConfig); err != nil {
				return err // Create returns "", err
			}
		}
		var tiered any
		if p.Type == "tiered" && p.TieredConfig != nil {
			b, _ := jsonb(p.TieredConfig)
			tiered = b
		}
```
Add `tiered_config` as the next column after `bxgy_config` in the INSERT column list + its `$N` placeholder + the `tiered` arg; in UPDATE add `tiered_config=$N` to the SET and shift the `WHERE id` placeholder by one, passing `tiered` before `id`. (Read the CURRENT INSERT/UPDATE — `bxgy_config` is already the last data column from SP-Promo-3b — and append `tiered_config` after it.)

- [ ] **Step 5: Wire the read side** — `read/repo.go` `Promotions`, after the `'bxgyConfig',bxgy_config,` line (840):
```go
		   'tieredConfig',tiered_config,
```

- [ ] **Step 6: Run validation tests + build** — `cd backend && go test ./internal/write/ -run TestValidateTiered -v && go build ./...` → PASS + clean.
- [ ] **Step 7: Commit**

```bash
git add backend/internal/write/repo.go backend/internal/read/repo.go backend/internal/write/repo_test.go
git commit -m "feat(promo-tiered): persist+read tiered_config (INSERT+UPDATE+json) with validation"
```

---

### Task 4: OpenAPI tieredConfig + codegen (Go + TS)

**Files:**
- Modify: `backend/api/openapi.yaml` (`Tier` + `TieredConfig` schemas; `tieredConfig` on `Promotion` + `PromotionInput`; `tiered` in both `type` enums)
- Regenerate: `backend/internal/api/api.gen.go`, `packages/api/src/schema.d.ts`

- [ ] **Step 1: Add component schemas** under `components.schemas`:
```yaml
    Tier:
      type: object
      required: [minSubtotal, kind, value]
      properties:
        minSubtotal: { type: number }
        kind: { type: string, enum: [percentage, fixed] }
        value: { type: number }
    TieredConfig:
      type: object
      required: [tiers]
      properties:
        tiers: { type: array, items: { $ref: '#/components/schemas/Tier' } }
```
- [ ] **Step 2: Extend `Promotion` + `PromotionInput`** — add `tiered` to each `type` enum (currently `[percentage, fixed, bogo, buy_x_get_y]` → add `, tiered`), and add (next to `bxgyConfig`):
```yaml
        tieredConfig:
          allOf: [{ $ref: '#/components/schemas/TieredConfig' }]
          nullable: true
```
- [ ] **Step 3: Regenerate** — `cd backend && make gen && corepack pnpm@10.11.1 --filter @mandalika/api gen`. Confirm `api.Promotion`/`api.PromotionInput` gain `TieredConfig *TieredConfig` and `schema.d.ts` gains `tieredConfig` + a `TieredConfig`/`Tier` type.
- [ ] **Step 4: Verify** — `cd backend && make gen-check && go build ./... && cd ../packages/api && corepack pnpm@10.11.1 -w exec tsc -b` → clean.
- [ ] **Step 5: Commit**

```bash
git add backend/api/openapi.yaml backend/internal/api/api.gen.go packages/api/src/schema.d.ts
git commit -m "feat(promo-tiered): OpenAPI tieredConfig + tiered enum, regen Go+TS clients"
```

---

### Task 5: POS pricing parity + next-tier hint + PromoPanel display (TS) — Opus

**Files:**
- Modify: `apps/pos/src/cashier/pricing.ts` (`calcPromoDiscount` tiered branch; export `pickTier`/`tieredNextTier`)
- Modify: `apps/pos/src/cashier/PromoPanel.tsx` (rule label + greying + next-tier hint for tiered)
- Test: `apps/pos/src/cashier/pricing.test.ts`

**Interfaces:**
- Consumes: `Promotion.tieredConfig` (Task 4 TS type).
- Produces: `calcPromoDiscount` returns the Go-identical tier discount; `tieredNextTier(cfg, subtotal)` → `{ minSubtotal, kind, value, gap } | null` (smallest tier with `minSubtotal > subtotal`, `gap = minSubtotal - subtotal`).

- [ ] **Step 1: Write failing parity + hint tests** in `pricing.test.ts`: tiered discount at 300k (tier2 15% → 45000), 120k (tier1 fixed → 10000), 50k (below → 0); `tieredNextTier` at 50k → first tier with gap 50000, at 300k (2-tier cfg with a 500k tier) → that tier with the right gap, at top tier → null.
- [ ] **Step 2: Run → FAIL** — `cd apps/pos && corepack pnpm@10.11.1 exec vitest run src/cashier/pricing.test.ts`.
- [ ] **Step 3: Implement** in `pricing.ts`. Add a tiered branch to `calcPromoDiscount` (mirror Go: pick highest `minSubtotal ≤ sub`, percentage→`Math.round(sub*v/100)`, fixed→`Math.min(v,sub)`, none→0) and export:
```ts
type TieredConfig = NonNullable<Promotion['tieredConfig']>
export function pickTier(cfg: TieredConfig | null | undefined, sub: number) {
  if (!cfg?.tiers) return null
  let best: TieredConfig['tiers'][number] | null = null
  for (const t of cfg.tiers) if (sub >= t.minSubtotal && (!best || t.minSubtotal > best.minSubtotal)) best = t
  return best
}
export function tieredNextTier(cfg: TieredConfig | null | undefined, sub: number) {
  if (!cfg?.tiers) return null
  let next: TieredConfig['tiers'][number] | null = null
  for (const t of cfg.tiers) if (t.minSubtotal > sub && (!next || t.minSubtotal < next.minSubtotal)) next = t
  return next ? { ...next, gap: next.minSubtotal - sub } : null
}
```
- [ ] **Step 4: PromoPanel** — `promoRuleLabel` for `tiered` → "Bertingkat" (or summarise tier count); the existing greying when `calcPromoDiscount===0` already covers below-lowest-tier (reason "Belum memenuhi minimum belanja"). Add a muted hint line using `tieredNextTier(promo.tieredConfig, subtotal)`: when non-null, render "Belanja {formatRupiah(gap)} lagi untuk {kind==='percentage' ? `hemat ${value}%` : `potongan ${formatRupiah(value)}`}". Show it for tiered promos regardless of applied/greyed state.
- [ ] **Step 5: Run POS tests + tsc** — `cd apps/pos && corepack pnpm@10.11.1 exec vitest run && corepack pnpm@10.11.1 exec tsc -b` → green.
- [ ] **Step 6: Commit**

```bash
git add apps/pos/src/cashier/pricing.ts apps/pos/src/cashier/pricing.test.ts apps/pos/src/cashier/PromoPanel.tsx
git commit -m "feat(promo-tiered): POS pricing parity + next-tier hint in PromoPanel"
```

---

### Task 6: Backoffice tier editor + edit-populate (TSX) — Haiku

**Files:**
- Modify: `apps/backoffice/src/screens/promotions/PromoFormModal.tsx` (type option + tier editor sub-form)
- Modify: `apps/backoffice/src/screens/Promotions.tsx` (`openEditPromo`/`dupPromo`/`togglePromo` carry `tieredConfig`; `EMPTY_PROMO` unaffected)

- [ ] **Step 1: Type option + seed.** Add `<option value="tiered">Bertingkat — belanja lebih, hemat lebih</option>`. In the type `onChange`, when `tiered` is selected and `form.tieredConfig` is absent, seed `{ tiers: [{ minSubtotal: 100000, kind: 'percentage', value: 10 }] }` (mirror the bxgy default-seed). Hide `value` + the variant/applicable pickers for `tiered` (extend the existing `form.type !== 'bogo' && form.type !== 'buy_x_get_y'` conditions to also exclude `tiered`).
- [ ] **Step 2: Tier editor sub-form** (shown when `form.type === 'tiered'`): a list of tier rows, each `{ Min. belanja (number), Tipe (Select percentage/fixed), Nilai (number) }`, with "+ Tambah tingkat" (append a row) and a remove (×) per row. Edits update `form.tieredConfig.tiers` immutably (a `setTiers` helper like bxgy's `setBxgy`). A "Gratis"-style shortcut is NOT needed. Show the rows sorted by minSubtotal for readability (display only).
- [ ] **Step 3: Client guard** mirroring `validateTiered` (≥1 tier, ranges, no duplicate minSubtotal) — block submit with an inline message.
- [ ] **Step 4: Edit-populate** — in `Promotions.tsx`, add `tieredConfig: p.tieredConfig ?? undefined` to `openEditPromo`, `dupPromo`, and `togglePromo` (alongside the existing `bxgyConfig: p.bxgyConfig ?? undefined`).
- [ ] **Step 5: Build** — `cd apps/backoffice && corepack pnpm@10.11.1 exec tsc -b && corepack pnpm@10.11.1 exec vite build` → green.
- [ ] **Step 6: Commit**

```bash
git add apps/backoffice/src/screens/promotions/PromoFormModal.tsx apps/backoffice/src/screens/Promotions.tsx
git commit -m "feat(promo-tiered): backoffice tier editor + edit-populate tieredConfig"
```

---

### Task 7: Gap-class round-trip + live e2e (Go) — throwaway

**Files:**
- Create: `backend/cmd/promo3tiered/main.go` (throwaway; real `OrderService` vs Neon; deleted after; NOT committed)

- [ ] **Step 1: Round-trip serialization check (gap guard).** Against the test DB (after deploy applies 0040): authed `POST /promotions` a `tiered` promo with a 3-tier `tieredConfig` → `GET /promotions` → assert every tier (minSubtotal/kind/value) + `type` round-trips. Delete the row. (Run live in Task 8; here, write the e2e tool.)
- [ ] **Step 2: Write the e2e** mirroring `cmd/promo3breward`'s harness (fetch Neon `DATABASE_URL` from `gcloud secrets`, build pool, real `service.NewOrderService(pool)`). Scenarios (assert each, `[sp3tiered-e2e]` prefix, zero-residue cleanup): create a `tiered` promo (tiers 100k/fixed 10k, 250k/15%); order subtotal 300k with `PromotionIDs=[promoId]` → discount 45000 (tier2); order 120k → 10000 (tier1); order 50k → 0 (below lowest, promo applies nothing); refund a discounted order succeeds; cleanup verified.
- [ ] **Step 3: Run** — `cd backend && export DATABASE_URL_E2E="$(gcloud secrets versions access latest --secret=DATABASE_URL)"; go run ./cmd/promo3tiered` → all asserts pass + "CLEANUP OK". (Requires Task 8's deploy first — run this AFTER deploy.)
- [ ] **Step 4: Local full gate** — `cd backend && go build ./... && go test ./... && make gen-check` → green.
- [ ] **Step 5: Delete the throwaway** (`rm -rf backend/cmd/promo3tiered`); confirm `git status` shows no new committed files. (No commit.)

---

### Task 8: Deploy, APK, handoff

- [ ] **Step 1: Push** all commits to `origin/prod-hardening` (retry on flaky net; confirm `git ls-remote`).
- [ ] **Step 2: Deploy** — `gcloud run deploy mandalika-pos --source backend --region asia-southeast2 --quiet` (migration 0040 applies on boot); confirm `/readyz` ready.
- [ ] **Step 3: Run the gap-class round-trip smoke** (Task 7 Step 1) live + the **Task 7 e2e** against the migrated Neon → green.
- [ ] **Step 4: APK** — push first (done), then `"/c/Program Files/GitHub CLI/gh.exe" workflow run android-release.yml --ref prod-hardening -f api_url=https://mandalika-pos-538849926142.asia-southeast2.run.app`; watch to green.
- [ ] **Step 5: Update `SESSION_HANDOFF.md`** (new tiered banner: rev, migration 0040, APK run, USER-PENDING on-device) + the `promotion-module-sp-promo` memory.
- [ ] **Step 6: Commit + push the handoff.**

**USER-PENDING after this plan:** on-device — author a tiered promo; at the POS watch the promo grey below the lowest tier with the "spend Rp X more" hint, then discount by the correct tier as the cart grows; stacks (3a) + applies via a linked code (3c).

---

## Self-Review
- **Spec coverage:** §1 data model → T2/T3/T4; §2 engine → T1; §3 validation → T3 (+engine leniency T1); §4 POS pricing+hint+gate → T5; §5 backoffice → T6; §6 wire/edit-populate → T3+T4+T6; §7 testing → T1/T3/T5/T7; §8 routing → header. Covered.
- **Placeholder scan:** engine/migration/validation/parse code complete; T5/T6 reference the bxgy patterns by exact location to mirror (in-repo, named substitutions) rather than re-pasting — acceptable.
- **Type consistency:** Go `Tier{MinSubtotal,Kind,Value}`/`TieredConfig{Tiers}`/`pickTier`/`parseTieredConfig` ↔ `write.TierInput`/`TieredConfigInput`/`validateTiered` ↔ OpenAPI `Tier`/`TieredConfig` ↔ TS `tieredConfig`/`pickTier`/`tieredNextTier`. `DiscountTiered="tiered"` matches DB CHECK + OpenAPI enum + TS literal. JSON keys `minSubtotal/kind/value/tiers` identical across all layers.
