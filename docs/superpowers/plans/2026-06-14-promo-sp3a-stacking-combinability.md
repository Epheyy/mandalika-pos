# SP-Promo-3a — Stacking / Combinability — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let multiple combinable discounts (N automatic promotions + M discount codes) apply to one order, gated by a boolean `combinable` flag, computed additively, server-authoritative, with SP-Promo-1's online-strict / offline-lenient behavior.

**Architecture:** The pure pricing engine moves from a single `Promo *PromoSpec` to `Promos []PromoSpec` and sums each discount additively off the original subtotal (a one-element slice is byte-identical to today). Combinability is a *policy* gate enforced in a refactored `resolvePromos` inside `CreateOrder`, never in the pure math. The wire gains plural `promotionIds`/`discountCodes` while keeping the singular fields for old-APK back-compat; a migration adds `discount_codes.combinable` (default false) and `orders.applied_discount_codes` (for multi-code refund). The POS holds promo/code arrays with toggle+exclusivity semantics.

**Tech Stack:** Go (pgx v5, oapi-codegen), TypeScript/React (POS + backoffice), PostgreSQL, vitest, `go test`.

**Spec:** `docs/superpowers/specs/2026-06-14-promo-sp3a-stacking-combinability-design.md`

**Model routing (per [[model-routing-policy]]):** Sonnet implements. **Opus review** on Tasks 1, 4, 5, 6, 7, 9, 11, 12 (engine / resolvePromos / order-money / refund / type-gen / sync / reducer / checkout). Haiku acceptable for Tasks 2, 3, 8, 10, 13 mechanical edits (Opus re-derives any Haiku finding).

**Backend codegen ritual (Task 7):** edit `backend/api/openapi.yaml` → `cd backend && go tool oapi-codegen -config api/oapi-codegen.yaml api/openapi.yaml` → `corepack pnpm --filter @mandalika/api gen` → `go build ./...` → `make gen-check`. OpenAPI paths carry `/api/v1`; Go route registrations are un-prefixed.

---

## Task 1: Engine — additive `Promos []PromoSpec` (Opus review)

**Files:**
- Modify: `backend/internal/service/pricing.go` (`PricingInput` struct ~`:37-51`, `Compute` ~`:151-154`)
- Modify: `backend/internal/service/pricing_test.go` (`:62`, `:72`, `:82` — existing `Promo:` usages)

- [ ] **Step 1: Update the 3 existing tests + add stacking tests (RED)**

In `pricing_test.go`, change the three existing `Promo: &PromoSpec{...}` lines to the slice form:
```go
// was: Promo: &PromoSpec{Kind: DiscountPercentage, Value: 50, ApplicableProductIDs: []string{"a"}},
Promos: []PromoSpec{{Kind: DiscountPercentage, Value: 50, ApplicableProductIDs: []string{"a"}}},
```
```go
// was: Promo: &PromoSpec{IsBOGO: true},
Promos: []PromoSpec{{IsBOGO: true}},
```
```go
// was: Promo: &PromoSpec{Kind: DiscountPercentage, Value: 50, ApplicableProductIDs: []string{"zzz"}},
Promos: []PromoSpec{{Kind: DiscountPercentage, Value: 50, ApplicableProductIDs: []string{"zzz"}}},
```

Append a new stacking test:
```go
func TestComputeStacksAdditively(t *testing.T) {
	items := []LineItem{{ProductID: "a", Price: 100000, Quantity: 1, Subtotal: 100000}}
	res := Compute(PricingInput{
		Items: items,
		Promos: []PromoSpec{
			{Kind: DiscountPercentage, Value: 10}, // 10k off 100k
			{Kind: DiscountPercentage, Value: 5},  // 5k off 100k
			{Kind: DiscountFixed, Value: 20000},   // 20k
		},
	})
	if res.PromoDiscount != 35000 {
		t.Fatalf("PromoDiscount = %v, want 35000", res.PromoDiscount)
	}
	if res.DiscountAmount != 35000 {
		t.Fatalf("DiscountAmount = %v, want 35000", res.DiscountAmount)
	}
	if res.Total != 65000 {
		t.Fatalf("Total = %v, want 65000", res.Total)
	}
}

func TestComputeStackCapsAtSubtotal(t *testing.T) {
	items := []LineItem{{ProductID: "a", Price: 100000, Quantity: 1, Subtotal: 100000}}
	res := Compute(PricingInput{
		Items:  items,
		Promos: []PromoSpec{{Kind: DiscountPercentage, Value: 60}, {Kind: DiscountPercentage, Value: 60}},
	})
	if res.DiscountAmount != 100000 {
		t.Fatalf("DiscountAmount = %v, want 100000 (capped)", res.DiscountAmount)
	}
	if res.Total != 0 {
		t.Fatalf("Total = %v, want 0", res.Total)
	}
}

func TestComputeEmptyPromosSameAsNone(t *testing.T) {
	items := []LineItem{{ProductID: "a", Price: 50000, Quantity: 1, Subtotal: 50000}}
	a := Compute(PricingInput{Items: items})
	b := Compute(PricingInput{Items: items, Promos: nil})
	if a != b {
		t.Fatalf("nil-Promos diverged: %+v vs %+v", a, b)
	}
}
```

- [ ] **Step 2: Run — expect compile failure (RED)**

Run: `cd backend && go test ./internal/service/ -run TestCompute -v`
Expected: FAIL — `unknown field Promos in struct literal` (field not added yet).

- [ ] **Step 3: Change the engine to a slice**

In `pricing.go`, in `PricingInput` replace:
```go
	Promo           *PromoSpec   // applied promotion or promo code, nil if none
```
with:
```go
	Promos          []PromoSpec  // applied promotions/codes; additive, empty = none
```

In `Compute`, replace the single-promo block (`:151-154`):
```go
	promo := 0.0
	if in.Promo != nil {
		promo = calcPromotionDiscount(in.Promo, in.Items, subtotal)
	}
```
with:
```go
	promo := 0.0
	for i := range in.Promos {
		promo += calcPromotionDiscount(&in.Promos[i], in.Items, subtotal)
	}
```
(`calcPromotionDiscount`, BOGO, scoping, the `min(manual+promo, subtotal)` cap, and `PromoDiscount` field are all unchanged.)

- [ ] **Step 4: Run — expect PASS**

Run: `cd backend && go test ./internal/service/ -run TestCompute -v`
Expected: PASS (all existing + 3 new). This proves single-element parity and additive stacking.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/service/pricing.go backend/internal/service/pricing_test.go
git commit -m "feat(promo): pricing engine sums Promos []PromoSpec additively (SP-Promo-3a)"
```

> NOTE: `order.go:163-165` still references `Promo: promo` and will not compile until Task 5. That's expected — `go build ./...` stays red between Task 1 and Task 5. The package test above compiles because `order.go` is in the same package; if it blocks, do Tasks 1→5 as one unit before running a full `go build`. (Subagent-driven: implement 1 then jump to 5, then backfill 2,3,4.)

---

## Task 2: `ViolationNotCombinable` + Indonesian message (Haiku ok)

**Files:**
- Modify: `backend/internal/service/promo_validate.go` (`:12-21` const block)
- Modify: `backend/internal/handlers/writes.go` (`discountRejectMessage` `:1392-1411`)
- Modify: `backend/internal/handlers/promo_message_test.go` (add a case)

- [ ] **Step 1: Add the message-mapping test (RED)**

In `promo_message_test.go`, add a case asserting the new violation maps to a message. Match the existing test's table shape; add:
```go
{service.ViolationNotCombinable, "Promo/kode ini tidak bisa digabung"},
```

- [ ] **Step 2: Run — expect FAIL**

Run: `cd backend && go test ./internal/handlers/ -run TestDiscountReject -v`
Expected: FAIL — `undefined: service.ViolationNotCombinable`.

- [ ] **Step 3: Add the constant + message**

In `promo_validate.go` add to the const block (after `ViolationNotFound`):
```go
	ViolationNotCombinable PromoViolation = "not_combinable"
```

In `writes.go` `discountRejectMessage`, add a case before `default`:
```go
	case service.ViolationNotCombinable:
		return "Promo/kode ini tidak bisa digabung"
```

- [ ] **Step 4: Run — expect PASS**

Run: `cd backend && go test ./internal/handlers/ -run TestDiscountReject -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/service/promo_validate.go backend/internal/handlers/writes.go backend/internal/handlers/promo_message_test.go
git commit -m "feat(promo): add ViolationNotCombinable + ID message (SP-Promo-3a)"
```

---

## Task 3: Migration 0036 — `combinable` on codes + `applied_discount_codes` on orders (Haiku ok)

**Files:**
- Create: `backend/internal/db/migrations/0036_promo_stacking.sql`

- [ ] **Step 1: Write the migration**

```sql
-- SP-Promo-3a: discount-code stacking gate + multi-code refund bookkeeping.
-- discount_codes.combinable mirrors promotions.combinable (a code may stack with
-- other combinable discounts only when explicitly flagged; default exclusive).
-- orders.applied_discount_codes records EVERY code applied to an order (array of
-- code strings) so a refund can restore each code's usage_count. Nullable: orders
-- with 0 codes (and pre-feature orders) have none; refund falls back to discount_code.
ALTER TABLE discount_codes ADD COLUMN IF NOT EXISTS combinable boolean NOT NULL DEFAULT false;
ALTER TABLE orders         ADD COLUMN IF NOT EXISTS applied_discount_codes jsonb;
```

- [ ] **Step 2: Verify it parses against the local schema loader**

Run: `cd backend && go build ./...`
Expected: builds (migration files are embedded; this confirms the file is picked up). Note `go build` may still be red from Task 1 until Task 5 — if so, defer this check to Task 5's build.

- [ ] **Step 3: Commit**

```bash
git add backend/internal/db/migrations/0036_promo_stacking.sql
git commit -m "feat(promo): migration 0036 — discount_codes.combinable + orders.applied_discount_codes (SP-Promo-3a)"
```

---

## Task 4: `resolvePromos` — plural resolution + combinability gate (Opus review)

**Files:**
- Modify: `backend/internal/service/promo_validate.go` (`PromoRow`/`CodeRow` structs `:30-43`)
- Modify: `backend/internal/service/order.go` (replace `resolvePromo` `:571-638`)
- Create test: `backend/internal/service/resolve_promos_test.go`

- [ ] **Step 1: Add `Combinable` to the row structs**

In `promo_validate.go`:
```go
type PromoRow struct {
	StartDate, EndDate           *time.Time
	MinPurchase                  *float64
	ActiveFromHour, ActiveToHour string
	ActiveDays                   []int
	OutletIDs                    []string
	Combinable                   bool
}
type CodeRow struct {
	StartDate, EndDate *time.Time
	MinPurchase        *float64
	UsageLimit         *int
	UsageCount         int
	Combinable         bool
}
```

- [ ] **Step 2: Write a unit test for the combinability gate (RED)**

The gate is a pure helper. Create `resolve_promos_test.go`:
```go
package service

import "testing"

func TestCombinabilityGate(t *testing.T) {
	// >1 discount with any non-combinable -> violation.
	if v := combinabilityViolation([]bool{true, false}); v == nil {
		t.Fatal("expected violation for [combinable, non-combinable]")
	}
	// all combinable -> ok.
	if v := combinabilityViolation([]bool{true, true, true}); v != nil {
		t.Fatalf("expected no violation, got %v", *v)
	}
	// single discount is always fine, even if non-combinable.
	if v := combinabilityViolation([]bool{false}); v != nil {
		t.Fatalf("single discount must never gate, got %v", *v)
	}
	// zero discounts -> ok.
	if v := combinabilityViolation(nil); v != nil {
		t.Fatalf("no discounts must not gate, got %v", *v)
	}
}
```

- [ ] **Step 3: Run — expect FAIL**

Run: `cd backend && go test ./internal/service/ -run TestCombinabilityGate -v`
Expected: FAIL — `undefined: combinabilityViolation`.

- [ ] **Step 4: Implement `combinabilityViolation` + replace `resolvePromo` with `resolvePromos`**

In `order.go`, add the pure helper:
```go
// combinabilityViolation enforces the boolean gate: more than one discount may
// only coexist if EVERY one is combinable. A single discount never gates.
func combinabilityViolation(combinable []bool) *PromoViolation {
	if len(combinable) <= 1 {
		return nil
	}
	for _, c := range combinable {
		if !c {
			v := ViolationNotCombinable
			return &v
		}
	}
	return nil
}
```

Replace the entire `resolvePromo` func (`:571-638`) with `resolvePromos`:
```go
// resolvePromos turns the applied promotion ids + discount codes into authoritative
// PromoSpecs, validating each stored gating rule (SP-Promo-1) AND the cross-discount
// combinability gate (SP-Promo-3a). Returns the applied discount_codes row ids (for
// usage++), a non-empty warnReason when an OFFLINE order applied invalid/conflicting
// discounts (recorded + flagged), and *ErrDiscountRejected for an ONLINE conflict
// (caller -> HTTP 422).
func (s *OrderService) resolvePromos(ctx context.Context, tx pgx.Tx, promoIDs, codes []string, ec PromoEvalContext, offline bool) ([]PromoSpec, []string, string, error) {
	var specs []PromoSpec
	var codeIDs []string
	var combinable []bool
	var violations []PromoViolation

	for _, promoID := range promoIDs {
		if promoID == "" {
			continue
		}
		var kind string
		var value float64
		var ids []string
		var row PromoRow
		err := tx.QueryRow(ctx,
			`SELECT type, value,
			   COALESCE(applicable_product_ids,'[]'::jsonb),
			   start_date, end_date, min_purchase,
			   COALESCE(active_from_hour,''), COALESCE(active_to_hour,''),
			   COALESCE(active_days,'[]'::jsonb), COALESCE(outlet_ids,'[]'::jsonb),
			   COALESCE(combinable,false)
			   FROM promotions WHERE id=$1 AND is_active=true`, promoID).
			Scan(&kind, &value, &ids, &row.StartDate, &row.EndDate, &row.MinPurchase,
				&row.ActiveFromHour, &row.ActiveToHour, &row.ActiveDays, &row.OutletIDs, &row.Combinable)
		if errors.Is(err, pgx.ErrNoRows) {
			if !offline {
				return nil, nil, "", &ErrDiscountRejected{Violations: []PromoViolation{ViolationNotFound}}
			}
			violations = append(violations, ViolationNotFound)
			continue // can't reconstruct value offline
		}
		if err != nil {
			return nil, nil, "", fmt.Errorf("load promotion: %w", err)
		}
		spec := PromoSpec{Kind: DiscountKind(kind), Value: value, ApplicableProductIDs: ids, IsBOGO: kind == "bogo"}
		if vio := ValidatePromo(row, ec); len(vio) > 0 {
			if !offline {
				return nil, nil, "", &ErrDiscountRejected{Violations: vio}
			}
			violations = append(violations, vio...)
		}
		specs = append(specs, spec)
		combinable = append(combinable, row.Combinable)
	}

	for _, code := range codes {
		if code == "" {
			continue
		}
		var id, kind string
		var value float64
		var row CodeRow
		// FOR UPDATE: hold the row lock from validation through usage_count++ later
		// in this same tx — makes the usage_limit check race-safe.
		err := tx.QueryRow(ctx,
			`SELECT id, type, value, start_date, end_date, min_purchase, usage_limit, usage_count, combinable
			   FROM discount_codes WHERE code=$1 AND is_active=true FOR UPDATE`, code).
			Scan(&id, &kind, &value, &row.StartDate, &row.EndDate, &row.MinPurchase, &row.UsageLimit, &row.UsageCount, &row.Combinable)
		if errors.Is(err, pgx.ErrNoRows) {
			if !offline {
				return nil, nil, "", &ErrDiscountRejected{Violations: []PromoViolation{ViolationNotFound}}
			}
			violations = append(violations, ViolationNotFound)
			continue
		}
		if err != nil {
			return nil, nil, "", fmt.Errorf("load discount code: %w", err)
		}
		spec := PromoSpec{Kind: DiscountKind(kind), Value: value}
		if vio := ValidateCode(row, ec); len(vio) > 0 {
			if !offline {
				return nil, nil, "", &ErrDiscountRejected{Violations: vio}
			}
			violations = append(violations, vio...)
		}
		specs = append(specs, spec)
		codeIDs = append(codeIDs, id)
		combinable = append(combinable, row.Combinable)
	}

	if v := combinabilityViolation(combinable); v != nil {
		if !offline {
			return nil, nil, "", &ErrDiscountRejected{Violations: []PromoViolation{*v}}
		}
		violations = append(violations, *v)
	}

	warn := ""
	if len(violations) > 0 {
		warn = JoinViolations(violations)
	}
	return specs, codeIDs, warn, nil
}
```

- [ ] **Step 5: Run — expect PASS**

Run: `cd backend && go test ./internal/service/ -run TestCombinabilityGate -v`
Expected: PASS. (Full-package build still red until Task 5 wires the caller.)

- [ ] **Step 6: Commit**

```bash
git add backend/internal/service/promo_validate.go backend/internal/service/order.go backend/internal/service/resolve_promos_test.go
git commit -m "feat(promo): resolvePromos resolves a stack + combinability gate (SP-Promo-3a)"
```

---

## Task 5: Wire `CreateOrder` to the stack (Opus review)

**Files:**
- Modify: `backend/internal/service/order.go` (`CreateOrderInput` `:44-72`, promo call `:143-148`, Compute `:163-170`, insert `:306-331`, usage `:428-435`)

- [ ] **Step 1: Add plural input fields**

In `CreateOrderInput`, after the singular promo fields (`:63-64`) add:
```go
	PromotionIDs      []string // SP-Promo-3a: stacked promotions; falls back to PromotionID
	DiscountCodes     []string // SP-Promo-3a: stacked codes; falls back to DiscountCode
```
(The applied code strings persisted for refund are computed inside `CreateOrder` as a local, not carried on the input.)

- [ ] **Step 2: Resolve effective lists + call `resolvePromos`**

Replace the promo block (`:143-148`):
```go
	// Resolve promo spec server-side (authoritative value, not client-supplied).
	promo, promoCodeID, discountWarnReason, err := s.resolvePromo(ctx, tx, in.PromotionID, in.DiscountCode, promoEvalCtx, in.Offline)
	if err != nil {
		return "", false, false, err
	}
	discountWarning := discountWarnReason != ""
```
with:
```go
	// SP-Promo-3a: prefer the plural lists; fall back to the singular fields so old
	// APKs (which send only promotionId/discountCode) keep working during rollout.
	promoIDs := in.PromotionIDs
	if len(promoIDs) == 0 && in.PromotionID != "" {
		promoIDs = []string{in.PromotionID}
	}
	codes := in.DiscountCodes
	if len(codes) == 0 && in.DiscountCode != "" {
		codes = []string{in.DiscountCode}
	}
	promos, promoCodeIDs, discountWarnReason, err := s.resolvePromos(ctx, tx, promoIDs, codes, promoEvalCtx, in.Offline)
	if err != nil {
		return "", false, false, err
	}
	discountWarning := discountWarnReason != ""
	// The applied code strings (in resolved order) are persisted for refund restore.
	// promoCodeIDs aligns 1:1 with the codes that resolved; re-derive their strings.
	appliedCodes := codes
	if len(appliedCodes) == 0 {
		appliedCodes = nil
	}
```
> NOTE: `appliedCodes` should be exactly the codes that produced a `codeID`. The simplest faithful source is the input `codes` minus any that hit `ErrNoRows` offline. Since an ONLINE not-found already 422s, and OFFLINE not-found codes have no usage to restore, persisting the full `codes` list is safe (refund's `GREATEST(-1,0)` + unique-code match is idempotent and a no-op for a code that was never incremented). Keep `appliedCodes = codes`.

- [ ] **Step 3: Pass the slice to Compute**

Replace `Promo: promo,` (`:165`) with:
```go
		Promos: promos,
```

- [ ] **Step 4: Persist `applied_discount_codes` + increment each code**

In the INSERT (`:306-328`), add the column and value. Change the column list `... discount_warning, discount_warning_reason)` to `... discount_warning, discount_warning_reason, applied_discount_codes)`, add one positional param `$36::jsonb` to the VALUES list (after `$35`), and append the arg. Concretely, change the final args line:
```go
		finalEarned, discountWarning, nullStr(discountWarnReason),
```
to:
```go
		finalEarned, discountWarning, nullStr(discountWarnReason), nullCodes(appliedCodes),
```
And add a helper near the other null* helpers in this file:
```go
// nullCodes marshals applied code strings to a jsonb array, or NULL when empty.
func nullCodes(codes []string) any {
	if len(codes) == 0 {
		return nil
	}
	b, err := json.Marshal(codes)
	if err != nil {
		return nil
	}
	return b
}
```
(Ensure `encoding/json` is imported in order.go; it already is via DiscountBreakdown handling — verify.)

Replace the usage-increment block (`:428-435`):
```go
	// Promo usage increment (plan §9 :776-784).
	if promoCodeID != "" {
		if _, e := tx.Exec(ctx,
			`UPDATE discount_codes SET usage_count=usage_count+1 WHERE id=$1`,
			promoCodeID); e != nil {
			return "", false, false, fmt.Errorf("promo usage: %w", e)
		}
	}
```
with:
```go
	// Promo usage increment — one per applied code (each row was locked FOR UPDATE
	// in resolvePromos, so this is race-safe). SP-Promo-3a: a stack increments each.
	for _, codeID := range promoCodeIDs {
		if _, e := tx.Exec(ctx,
			`UPDATE discount_codes SET usage_count=usage_count+1 WHERE id=$1`,
			codeID); e != nil {
			return "", false, false, fmt.Errorf("promo usage: %w", e)
		}
	}
```

- [ ] **Step 5: Build + full service tests**

Run: `cd backend && go build ./... && go test ./internal/service/ ./internal/handlers/ -v`
Expected: builds green; all tests PASS (Task 1/2/4 tests included).

- [ ] **Step 6: Commit**

```bash
git add backend/internal/service/order.go
git commit -m "feat(promo): CreateOrder applies a discount stack + persists applied codes (SP-Promo-3a)"
```

---

## Task 6: Refund restores each applied code (Opus review)

**Files:**
- Modify: `backend/internal/service/order.go` (`Refund` `:458-490`)

- [ ] **Step 1: Read `applied_discount_codes` and restore each (with singular fallback)**

In `Refund`, extend the SELECT (`:462-465`) to also read the jsonb array. Change:
```go
	var discountCode *string
	var oEarned, oRedeemed int
	err = tx.QueryRow(ctx,
		`SELECT status, order_number, customer_id, points_earned, points_redeemed, discount_code
		   FROM orders WHERE id=$1 AND outlet_id=$2 FOR UPDATE`,
		orderID, outletID).Scan(&status, &orderNumber, &custID, &oEarned, &oRedeemed, &discountCode)
```
to:
```go
	var discountCode *string
	var appliedCodes []string
	var oEarned, oRedeemed int
	err = tx.QueryRow(ctx,
		`SELECT status, order_number, customer_id, points_earned, points_redeemed, discount_code,
		        COALESCE(applied_discount_codes,'[]'::jsonb)
		   FROM orders WHERE id=$1 AND outlet_id=$2 FOR UPDATE`,
		orderID, outletID).Scan(&status, &orderNumber, &custID, &oEarned, &oRedeemed, &discountCode, &appliedCodes)
```

Replace the single-code restore block (`:484-490`):
```go
	if discountCode != nil && *discountCode != "" {
		if _, err = tx.Exec(ctx,
			`UPDATE discount_codes SET usage_count = GREATEST(usage_count - 1, 0) WHERE code=$1`,
			*discountCode); err != nil {
			return fmt.Errorf("restore discount usage: %w", err)
		}
	}
```
with:
```go
	// SP-Promo-3a: restore usage for EVERY applied code. Fall back to the singular
	// discount_code for pre-feature orders (applied_discount_codes is NULL there).
	// GREATEST(-1,0) + the already-refunded short-circuit keep this idempotent.
	restore := appliedCodes
	if len(restore) == 0 && discountCode != nil && *discountCode != "" {
		restore = []string{*discountCode}
	}
	for _, code := range restore {
		if code == "" {
			continue
		}
		if _, err = tx.Exec(ctx,
			`UPDATE discount_codes SET usage_count = GREATEST(usage_count - 1, 0) WHERE code=$1`,
			code); err != nil {
			return fmt.Errorf("restore discount usage: %w", err)
		}
	}
```

- [ ] **Step 2: Build**

Run: `cd backend && go build ./... && go test ./internal/service/ -v`
Expected: green.

- [ ] **Step 3: Commit**

```bash
git add backend/internal/service/order.go
git commit -m "feat(promo): refund restores usage for each applied code (SP-Promo-3a)"
```

---

## Task 7: OpenAPI — plural input fields + `DiscountCode.combinable`; regen (Opus review on codegen)

**Files:**
- Modify: `backend/api/openapi.yaml` (order-create input ~`:1019/1448-1449`, `CartItem` ~`:1064-1065`, `DiscountCode` schema + its input)
- Regen: `backend/internal/api/api.gen.go`, `packages/api/src/schema.d.ts`

- [ ] **Step 1: Add the schema fields**

In the order-create request body schema (the one carrying `promotionId`/`discountCode`, ~`:1448-1449`) add:
```yaml
        promotionIds: { type: array, items: { type: string }, nullable: true }
        discountCodes: { type: array, items: { type: string }, nullable: true }
```
In `CartItem` (~`:1064-1065`, alongside its `discountCode`) add the same two array fields (nullable).
In the `DiscountCode` output schema add:
```yaml
        combinable: { type: boolean, nullable: true }
```
In the `DiscountCode` **input** schema (create/update body) add:
```yaml
        combinable: { type: boolean, nullable: true }
```

- [ ] **Step 2: Regenerate**

Run:
```bash
cd backend && go tool oapi-codegen -config api/oapi-codegen.yaml api/openapi.yaml
corepack pnpm --filter @mandalika/api gen
```
Expected: `api.gen.go` and `schema.d.ts` updated with `PromotionIds`/`DiscountCodes`/`Combinable`.

- [ ] **Step 3: Build + gen-check**

Run: `cd backend && go build ./... && make gen-check`
Expected: builds; `make gen-check` reports no drift (the regenerated files match).

- [ ] **Step 4: Commit**

```bash
git add backend/api/openapi.yaml backend/internal/api/api.gen.go packages/api/src/schema.d.ts
git commit -m "feat(promo): OpenAPI plural promo fields + DiscountCode.combinable (SP-Promo-3a)"
```

---

## Task 8: Handler — thread plural fields into the order input (Haiku ok)

**Files:**
- Modify: `backend/internal/handlers/writes.go` (`createOrderBody` `:884-901`, `CreateOrder` mapping `:925-938`)

- [ ] **Step 1: Add request fields + map them**

In `createOrderBody` add (after `DiscountCode`/`PromotionID`):
```go
	PromotionIDs      []string            `json:"promotionIds"`
	DiscountCodes     []string            `json:"discountCodes"`
```
In the `service.CreateOrderInput{...}` literal (`:934`) add:
```go
		PromotionIDs:  body.PromotionIDs, DiscountCodes: body.DiscountCodes,
```

- [ ] **Step 2: Build**

Run: `cd backend && go build ./...`
Expected: green.

- [ ] **Step 3: Commit**

```bash
git add backend/internal/handlers/writes.go
git commit -m "feat(promo): online order handler accepts plural promo fields (SP-Promo-3a)"
```

---

## Task 9: Sync — thread plural fields through the offline envelope (Opus review)

**Files:**
- Modify: `backend/internal/sync/sync.go` (order payload struct `:419-441`, input mapping `:195-222`)

- [ ] **Step 1: Add payload fields + map them**

In the order payload struct (`p`, `:419-441`) add (after `DiscountCode`/`PromotionID`):
```go
	PromotionIDs      []string            `json:"promotionIds"`
	DiscountCodes     []string            `json:"discountCodes"`
```
In the `service.CreateOrderInput{...}` literal (`:213-214`) add:
```go
			PromotionIDs:  p.PromotionIDs,
			DiscountCodes: p.DiscountCodes,
```

- [ ] **Step 2: Build + sync tests**

Run: `cd backend && go build ./... && go test ./internal/sync/ -v`
Expected: green.

- [ ] **Step 3: Commit**

```bash
git add backend/internal/sync/sync.go
git commit -m "feat(promo): offline sync carries plural promo fields (SP-Promo-3a)"
```

---

## Task 10: Backoffice — code `combinable` checkbox + badge (Haiku ok)

**Files:**
- Modify: `apps/backoffice/src/screens/Promotions.tsx` (Kode Diskon form + list)
- Modify: `packages/types/src/index.ts` if a hand-written `DiscountCode` type needs `combinable` (check; the schema.d.ts already has it after Task 7)

- [ ] **Step 1: Add the checkbox to the discount-code form**

In the Kode Diskon (discount code) form section, add a checkbox bound to the code form's `combinable`, mirroring the promotion form's combinable control (Promotions.tsx:337). Initialize the code form default to `combinable: false`. Ensure the create/update payload includes `combinable`.
```tsx
<label className="flex items-start gap-2 text-sm">
  <input
    type="checkbox"
    checked={codeForm.combinable ?? false}
    onChange={(e) => setCodeForm((f) => ({ ...f, combinable: e.target.checked }))}
    className="w-4 h-4 accent-gold-600 mt-0.5"
  />
  <span>Bisa digabung dengan promo/kode lain (combinable)</span>
</label>
```

- [ ] **Step 2: Show the badge in the code list**

Where each discount code row renders, add (mirroring the promo badge at :234):
```tsx
{c.combinable && <Badge tone="gold" className="inline-block mt-0.5">Bisa Kombinasi</Badge>}
```

- [ ] **Step 3: Typecheck + build**

Run: `corepack pnpm --filter @mandalika/backoffice exec tsc -b && corepack pnpm --filter @mandalika/backoffice build`
Expected: green. (No package.json change → no lockfile regen needed; see [[cloudflare-frozen-lockfile-gotcha]] — confirm `git status` shows no package.json diff.)

- [ ] **Step 4: Commit**

```bash
git add apps/backoffice/src/screens/Promotions.tsx packages/types/src/index.ts
git commit -m "feat(promo): backoffice discount-code combinable toggle + badge (SP-Promo-3a)"
```

---

## Task 11: POS reducer — promo/code arrays + toggle/exclusivity (Opus review)

**Files:**
- Modify: `apps/pos/src/cashier/state/cashierReducer.ts` (state `:39-42`, actions `:73-75`, initial `:100-102`, cases `:278-301`, RESET/customer-clear sites `:212-213`)
- Modify: `apps/pos/src/cashier/state/cashierReducer.test.ts` (add toggle cases)

- [ ] **Step 1: Write reducer tests (RED)**

Add to `cashierReducer.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { cashierReducer, CASHIER_INITIAL_STATE } from './cashierReducer'

const promo = (id: string, combinable: boolean) =>
  ({ id, name: id, type: 'percentage', value: 10, combinable }) as any

describe('promo stacking reducer', () => {
  it('appends combinable promotions', () => {
    let s = cashierReducer(CASHIER_INITIAL_STATE, { type: 'APPLY_PROMOTION', promotion: promo('a', true) })
    s = cashierReducer(s, { type: 'APPLY_PROMOTION', promotion: promo('b', true) })
    expect(s.appliedPromotions.map((p) => p.id)).toEqual(['a', 'b'])
  })

  it('a non-combinable promotion replaces the set', () => {
    let s = cashierReducer(CASHIER_INITIAL_STATE, { type: 'APPLY_PROMOTION', promotion: promo('a', true) })
    s = cashierReducer(s, { type: 'APPLY_PROMOTION', promotion: promo('x', false) })
    expect(s.appliedPromotions.map((p) => p.id)).toEqual(['x'])
    expect(s.appliedPromoCodes).toEqual([])
  })

  it('applying when a non-combinable is active replaces the set', () => {
    let s = cashierReducer(CASHIER_INITIAL_STATE, { type: 'APPLY_PROMOTION', promotion: promo('x', false) })
    s = cashierReducer(s, { type: 'APPLY_PROMOTION', promotion: promo('a', true) })
    expect(s.appliedPromotions.map((p) => p.id)).toEqual(['a'])
  })

  it('re-applying the same promotion id toggles it off', () => {
    let s = cashierReducer(CASHIER_INITIAL_STATE, { type: 'APPLY_PROMOTION', promotion: promo('a', true) })
    s = cashierReducer(s, { type: 'APPLY_PROMOTION', promotion: promo('a', true) })
    expect(s.appliedPromotions).toEqual([])
  })

  it('REMOVE_PROMOTION removes by id', () => {
    let s = cashierReducer(CASHIER_INITIAL_STATE, { type: 'APPLY_PROMOTION', promotion: promo('a', true) })
    s = cashierReducer(s, { type: 'REMOVE_PROMOTION', id: 'a' })
    expect(s.appliedPromotions).toEqual([])
  })
})
```

- [ ] **Step 2: Run — expect FAIL**

Run: `corepack pnpm --filter @mandalika/pos exec vitest run src/cashier/state/cashierReducer.test.ts`
Expected: FAIL — `appliedPromotions` undefined / action types unknown.

- [ ] **Step 3: Convert state to arrays**

In `cashierReducer.ts`:
- State (`:40-41`):
```ts
  appliedPromotions: Promotion[]
  appliedPromoCodes: AppliedPromoCode[]
```
- Actions (`:73-75`):
```ts
  | { type: 'APPLY_PROMO_CODE'; code: AppliedPromoCode; combinable: boolean }
  | { type: 'APPLY_PROMOTION'; promotion: Promotion }
  | { type: 'REMOVE_PROMOTION'; id: string }
  | { type: 'REMOVE_PROMO_CODE'; code: string }
  | { type: 'CLEAR_PROMOTIONS' }
```
- Initial (`:100-101`):
```ts
  appliedPromotions: [],
  appliedPromoCodes: [],
```
- `AppliedPromoCode` needs a `combinable` flag for the gate. In `promoValidate.ts`, add `combinable?: boolean` to the `AppliedPromoCode` interface (`:97`).

- [ ] **Step 4: Implement the toggle cases**

Add a helper at the top of the reducer module:
```ts
// A non-combinable discount is exclusive: its presence (existing or incoming)
// forces the set to a single member.
function hasNonCombinablePromotion(promotions: Promotion[]): boolean {
  return promotions.some((p) => !p.combinable)
}
```
Replace the `APPLY_PROMO_CODE` / `APPLY_PROMOTION` / `CLEAR_PROMOTIONS` cases (`:278-301`):
```ts
    case 'SET_PROMO_CODE_INPUT':
      return { ...state, promoCodeInput: action.value }

    case 'APPLY_PROMOTION': {
      const exists = state.appliedPromotions.some((p) => p.id === action.promotion.id)
      if (exists) {
        // toggle off
        return {
          ...state,
          appliedPromotions: state.appliedPromotions.filter((p) => p.id !== action.promotion.id),
          activeAdjustment: null,
        }
      }
      const incomingExclusive = !action.promotion.combinable
      const currentExclusive =
        hasNonCombinablePromotion(state.appliedPromotions) ||
        state.appliedPromoCodes.some((c) => !c.combinable)
      if (incomingExclusive || currentExclusive) {
        return {
          ...state,
          appliedPromotions: [action.promotion],
          appliedPromoCodes: [],
          activeAdjustment: null,
        }
      }
      return {
        ...state,
        appliedPromotions: [...state.appliedPromotions, action.promotion],
        activeAdjustment: null,
      }
    }

    case 'APPLY_PROMO_CODE': {
      const exists = state.appliedPromoCodes.some((c) => c.code === action.code.code)
      if (exists) {
        return { ...state, promoCodeInput: '', activeAdjustment: null }
      }
      const incomingExclusive = !action.combinable
      const currentExclusive =
        hasNonCombinablePromotion(state.appliedPromotions) ||
        state.appliedPromoCodes.some((c) => !c.combinable)
      const code: AppliedPromoCode = { ...action.code, combinable: action.combinable }
      if (incomingExclusive || currentExclusive) {
        return {
          ...state,
          appliedPromotions: [],
          appliedPromoCodes: [code],
          promoCodeInput: '',
          activeAdjustment: null,
        }
      }
      return {
        ...state,
        appliedPromoCodes: [...state.appliedPromoCodes, code],
        promoCodeInput: '',
        activeAdjustment: null,
      }
    }

    case 'REMOVE_PROMOTION':
      return { ...state, appliedPromotions: state.appliedPromotions.filter((p) => p.id !== action.id) }

    case 'REMOVE_PROMO_CODE':
      return { ...state, appliedPromoCodes: state.appliedPromoCodes.filter((c) => c.code !== action.code) }

    case 'CLEAR_PROMOTIONS':
      return {
        ...state,
        appliedPromotions: [],
        appliedPromoCodes: [],
        promoCodeInput: '',
      }
```
Update the customer-change / RESET clears (`:212-213` and any `RESET_SALE`): replace `appliedPromoCode: null, appliedPromotion: null,` with `appliedPromoCodes: [], appliedPromotions: [],`.

- [ ] **Step 5: Run — expect PASS**

Run: `corepack pnpm --filter @mandalika/pos exec vitest run src/cashier/state/cashierReducer.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/pos/src/cashier/state/cashierReducer.ts apps/pos/src/cashier/state/cashierReducer.test.ts apps/pos/src/cashier/promoValidate.ts
git commit -m "feat(promo): POS reducer holds promo/code arrays with toggle+exclusivity (SP-Promo-3a)"
```

---

## Task 12: POS pricing + checkout re-guard for the stack (Opus review)

The entry point is `computePricing(input: PricingInput)` in `pricing.ts` (its only callers are `useCart.ts` and `pricing.ts` itself; `computePricing` has **no existing test** — create one). The input today carries singular `appliedPromotion` / `appliedPromoCode`; both become arrays.

**Files:**
- Create: `apps/pos/src/cashier/pricing.test.ts`
- Modify: `apps/pos/src/cashier/pricing.ts` (`PricingInput` `:65-66`, destructure `:81-82`, `promoDiscountAmount` `:106-112`)
- Modify: `apps/pos/src/hooks/useCart.ts` (the call site that builds `PricingInput` — passes `appliedPromotion`/`appliedPromoCode`)
- Modify: `apps/pos/src/cashier/CashierScreen.tsx` (checkout re-guard in `handleConfirmPayment`)

- [ ] **Step 1: Create `pricing.test.ts` with a stacking case (RED)**

```ts
import { describe, it, expect } from 'vitest'
import { computePricing, type PricingInput } from './pricing'

const base: Omit<PricingInput, 'appliedPromotions' | 'appliedPromoCodes'> = {
  cart: [{ productId: 'a', productName: 'A', variantSize: '', price: 100000, quantity: 1, subtotal: 100000 } as any],
  discountType: 'fixed',
  surchargeType: 'fixed',
  discountRunning: 0,
  surchargeRunning: 0,
  settings: { taxEnabled: false, taxRate: 0, roundingEnabled: false, roundingType: 'none' } as any,
  loyalty: { enabled: false, pointsPerThousand: 0, redemptionRate: 0 } as any,
  hasCustomer: false,
  pointsRedeemed: 0,
  customerPoints: 0,
}

describe('computePricing stacking', () => {
  it('sums two combinable promotions additively off subtotal', () => {
    const p = (id: string, value: number) =>
      ({ id, name: id, type: 'percentage', value, combinable: true }) as any
    const res = computePricing({ ...base, appliedPromotions: [p('a', 10), p('b', 5)], appliedPromoCodes: [] })
    expect(res.promoDiscountAmount).toBe(15000) // 10k + 5k off 100k
    expect(res.discountAmount).toBe(15000)
  })

  it('adds promotion + code discounts together', () => {
    const promo = { id: 'a', name: 'A', type: 'percentage', value: 10, combinable: true } as any
    const res = computePricing({
      ...base,
      appliedPromotions: [promo],
      appliedPromoCodes: [{ code: 'X', value: 20000, type: 'fixed' }],
    })
    expect(res.promoDiscountAmount).toBe(30000) // 10k + 20k
  })

  it('empty arrays = no promo discount', () => {
    const res = computePricing({ ...base, appliedPromotions: [], appliedPromoCodes: [] })
    expect(res.promoDiscountAmount).toBe(0)
  })
})
```

- [ ] **Step 2: Run — expect FAIL**

Run: `corepack pnpm --filter @mandalika/pos exec vitest run src/cashier/pricing.test.ts`
Expected: FAIL — `PricingInput` has no `appliedPromotions` (still singular).

- [ ] **Step 3: Sum the stack in pricing.ts**

In `PricingInput` (`:65-66`) replace:
```ts
  appliedPromotion: Promotion | null
  appliedPromoCode: { code: string; value: number; type: 'percentage' | 'fixed' } | null
```
with:
```ts
  appliedPromotions: Promotion[]
  appliedPromoCodes: { code: string; value: number; type: 'percentage' | 'fixed' }[]
```
Update the destructure (`:81-82`) to `appliedPromotions,` / `appliedPromoCodes,`.
Replace the `promoDiscountAmount` computation (`:106-112`):
```ts
  const promoDiscountAmount =
    appliedPromotions.reduce((sum, p) => sum + calcPromoDiscount(p, cart, subtotal), 0) +
    appliedPromoCodes.reduce(
      (sum, c) =>
        sum +
        (c.type === 'percentage'
          ? Math.round(subtotal * (c.value / 100))
          : Math.min(c.value, subtotal)),
      0,
    )
```

- [ ] **Step 4: Update the `useCart.ts` call site**

In `apps/pos/src/hooks/useCart.ts`, find where it builds the `computePricing({...})` input and change `appliedPromotion: state.appliedPromotion` → `appliedPromotions: state.appliedPromotions` and `appliedPromoCode: state.appliedPromoCode` → `appliedPromoCodes: state.appliedPromoCodes` (the reducer now exposes the arrays from Task 11).

- [ ] **Step 5: Checkout re-guard re-validates the whole stack**

In `CashierScreen.tsx` `handleConfirmPayment`, the SP-Promo-2 re-guard currently re-validates the single applied promo/code before completing. Change it to loop:
- for each `p` in `state.appliedPromotions`: run `validatePromo(p, ctx)` (the existing SP-Promo-2 helper) — collect the first violation reason;
- for each `c` in `state.appliedPromoCodes`: re-look-up its `DiscountCode` row and run `validateCode(...)`;
- additionally: if `(state.appliedPromotions.length + state.appliedPromoCodes.length) > 1` and any has `combinable === false` → reason = "tidak bisa digabung".
On the FIRST failure → `showToast('Promo/Kode diskon dibatalkan: ' + reason)` + `dispatch({ type: 'CLEAR_PROMOTIONS' })` + return (block the sale). Mirror the existing single-discount guard's structure; just loop instead of one check.

- [ ] **Step 6: Run — expect PASS**

Run: `corepack pnpm --filter @mandalika/pos exec vitest run`
Expected: PASS (reducer + new pricing test + existing 57).

- [ ] **Step 7: Commit**

```bash
git add apps/pos/src/cashier/pricing.ts apps/pos/src/cashier/pricing.test.ts apps/pos/src/hooks/useCart.ts apps/pos/src/cashier/CashierScreen.tsx
git commit -m "feat(promo): POS sums the discount stack + checkout re-guards each (SP-Promo-3a)"
```

---

## Task 13: POS PromoPanel multi-toggle + submit plural + breakdown (Haiku ok, but verify with tsc)

**Files:**
- Modify: `apps/pos/src/cashier/PromoPanel.tsx`
- Modify: `apps/pos/src/cashier/Cart.tsx` (chips for each applied promo/code)
- Modify: `apps/pos/src/cashier/CashierScreen.tsx` (submit `:515-550`)

- [ ] **Step 1: PromoPanel renders all promos as multi-toggles**

In `PromoPanel.tsx`, for each active promo render a selectable row; "selected" = `state.appliedPromotions.some(p => p.id === promo.id)`. Tapping dispatches `APPLY_PROMOTION` (the reducer toggles). Keep the SP-Promo-2 greying of invalid promos. Code apply dispatches `APPLY_PROMO_CODE` with `combinable` read from the looked-up `DiscountCode.combinable`.

- [ ] **Step 2: Cart shows a removable chip per applied discount**

In `Cart.tsx`, replace the single promo chip with `state.appliedPromotions.map(...)` + `state.appliedPromoCodes.map(...)`, each with a remove control dispatching `REMOVE_PROMOTION`/`REMOVE_PROMO_CODE`.

- [ ] **Step 3: Submit sends plural arrays + an itemized breakdown**

In `CashierScreen.tsx` submit (`:515-550`), replace the 2-slot `discountBreakdown` builder and the singular `discountCode`/`promotionId` with:
```ts
const discountBreakdown = [
  derived.manualDiscountAmount > 0 && {
    label: 'Diskon Manual',
    kind: state.appliedDiscountType,
    value: state.discountRunning,
    amount: derived.manualDiscountAmount,
  },
  ...state.appliedPromotions.map((p) => ({
    label: p.name, kind: p.type, value: p.value,
    amount: calcPromoDiscount(p, state.cart, derived.subtotal),
  })),
  ...state.appliedPromoCodes.map((c) => ({
    label: c.code, kind: c.type, value: c.value,
    amount: c.type === 'percentage'
      ? Math.round(derived.subtotal * (c.value / 100))
      : Math.min(c.value, derived.subtotal),
  })),
].filter(Boolean)
```
And in the `engine.enqueue('order', {...})` payload:
```ts
  promotionIds: state.appliedPromotions.map((p) => p.id),
  discountCodes: state.appliedPromoCodes.map((c) => c.code),
  // back-compat: keep singular = first of each so older read paths still work
  discountCode: state.appliedPromoCodes[0]?.code ?? null,
  promotionId: state.appliedPromotions[0]?.id ?? null,
  discountLabel:
    state.appliedPromotions[0]?.name ??
    state.appliedPromoCodes[0]?.code ??
    (state.discountRunning > 0 ? 'Diskon Manual' : null),
```
(`calcPromoDiscount` is already exported from `pricing.ts`; import it if not already.)

- [ ] **Step 4: Typecheck + build + full vitest**

Run: `corepack pnpm --filter @mandalika/pos exec tsc -b && corepack pnpm --filter @mandalika/pos build && corepack pnpm --filter @mandalika/pos exec vitest run`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add apps/pos/src/cashier/PromoPanel.tsx apps/pos/src/cashier/Cart.tsx apps/pos/src/cashier/CashierScreen.tsx
git commit -m "feat(promo): POS multi-toggle PromoPanel + plural submit + itemized breakdown (SP-Promo-3a)"
```

---

## Task 14: Live proof (throwaway e2e), deploy-with-migration, APK (Opus review of the e2e assertions)

**Files:**
- Create (throwaway, delete after): `backend/cmd/promo3e2e/main.go`

- [ ] **Step 1: Write a real-OrderService e2e (rolls back / cleans up)**

Mirror the SP-Promo-1 `cmd/promo1e2e` protocol: connect with `DATABASE_URL` from gcloud secret, seed two combinable promotions + one combinable code + one non-combinable code, then assert:
1. Online order with [promoA, promoB, codeX] (all combinable) → succeeds; `discount_value` = additive sum; each code `usage_count++`; `applied_discount_codes` persisted.
2. Online order with [promoA, codeNonCombinable] → `*ErrDiscountRejected{ViolationNotCombinable}`.
3. Online order with [promoA, expiredCode] → rejected (existing per-discount validation).
4. Refund of order (1) restores each code's `usage_count`.
5. Single-discount order (one promo, NULL hours) → succeeds (back-compat / SP-Promo-1 regression class).
Clean up every artifact; assert zero residue.

- [ ] **Step 2: Run it**

Run: `cd backend && DATABASE_URL="$(gcloud secrets versions access latest --secret=DATABASE_URL)" go run ./cmd/promo3e2e`
Expected: all assertions pass; cleanup OK.

- [ ] **Step 3: Delete the throwaway + final local gate**

```bash
rm -rf backend/cmd/promo3e2e
cd backend && go build ./... && go test ./... && make gen-check
```
Expected: green, no drift.

- [ ] **Step 4: Deploy backend (migration 0036) + readyz**

Run:
```bash
gcloud run deploy mandalika-pos --source backend --region asia-southeast2 --quiet
curl -fsS "$(gcloud run services describe mandalika-pos --region asia-southeast2 --format='value(status.url)')/readyz"
```
Expected: deploy succeeds; `/readyz` → 200 (migration 0036 applied).

- [ ] **Step 5: Authed live smoke**

Login as `admin@mandalika.test` (password via `gcloud secrets versions access latest --secret=SEED_ADMIN_PASSWORD`), GET a discount code → confirm `combinable` present in the envelope. (Full stacked-order curl is optional/fragile — the e2e already proves the money path; note this gap honestly.)

- [ ] **Step 6: Build the APK**

Run:
```bash
"/c/Program Files/GitHub CLI/gh.exe" workflow run android-release.yml --ref prod-hardening -f api_url="$(gcloud run services describe mandalika-pos --region asia-southeast2 --format='value(status.url)')"
```
Watch to green; the APK lands at `Downloads/mandalika-apk/app-release.apk`.

- [ ] **Step 7: Commit any remaining + update handoff/memory**

```bash
git add -A && git commit -m "chore(promo): SP-Promo-3a verification notes + handoff (SP-Promo-3a)"
```
Update `SESSION_HANDOFF.md` + the [[promotion-module-sp-promo]] memory with the deployed rev, migration 0036, and USER-PENDING on-device checklist (stack two combinable promos + a code → cart shows each chip + summed savings; non-combinable selection clears the set; checkout re-guard; refund restores each code's usage).

---

## On-device acceptance checklist (USER-PENDING after APK)

- Two combinable automatic promotions can both be active; cart shows a chip per promo + the summed savings; receipt itemizes each.
- A combinable code stacks on top of the promotions.
- Selecting a non-combinable promo/code clears the rest (and vice versa) — exclusivity enforced in the UI.
- Removing one chip leaves the others applied and recomputes the total.
- Online: an invalid/conflicting stack is rejected at Bayar with the Indonesian reason; removing the offender lets the rest ring.
- Refunding a stacked order restores each code's remaining quota (backoffice Kode Diskon usage).

---

## Self-review notes

- **Spec coverage:** D1 (Task 5 plural lists), D2 boolean gate (Tasks 2/4/10/11), D3 additive (Task 1), D4 multi-select (Tasks 11/13), D5 online-422/offline-flag (Task 4), D6 code default-false (Task 3), D7 back-compat singular (Tasks 5/13), D8 applied_discount_codes refund (Tasks 3/5/6). Engine parity invariant: Task 1 Step 4 + `TestComputeEmptyPromosSameAsNone`.
- **Type consistency:** `Promos []PromoSpec` (Task 1) used by Task 5; `resolvePromos` signature (Task 4) called by Task 5; `appliedPromotions`/`appliedPromoCodes` (Task 11) consumed by Tasks 12/13; `AppliedPromoCode.combinable` added in Task 11, set by Task 11's `APPLY_PROMO_CODE`, read by the Task 12 re-guard.
- **Build ordering caveat:** `go build ./...` is red between Task 1 and Task 5 (the engine field rename outpaces its caller). Implement Tasks 1→5 as a unit (or 1 then 5, backfilling 2/3/4) before expecting a green full build. Package-scoped `go test ./internal/service/` works throughout because all the code is in one package.
