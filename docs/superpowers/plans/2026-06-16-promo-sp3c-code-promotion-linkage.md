# SP-Promo-3c — Code → Promotion Linkage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **THE 6 WORKING RULES (confirm every session):**
> 1. Ask, don't assume  2. Don't touch unrelated  3. Flag uncertainty  4. Verify on failure  5. Show changes  6. Admit gaps

**Goal:** Let a discount code act as a *key* that unlocks a linked promotion's full mechanics (Model A: code is a key), with the code supplying only its gate; add a `code_only` flag so a promotion can be exclusive to codes.

**Architecture:** Wire the existing-but-dead `discount_codes.promotion_id` FK at resolve time. The promotion is the single source of discount mechanics; the code's own type/value remain the fallback for *unlinked* codes. Effective gating = promotion rules **AND** code rules (intersection). A resolved promotion is deduped so it can't apply twice (code link + direct selection).

**Tech Stack:** Go (pgx, table-driven tests) backend; OpenAPI codegen (`api.gen.go` + `schema.d.ts`, `make gen-check`); React POS (`apps/pos`, vitest) → APK; React backoffice (`apps/backoffice`).

**Spec:** `docs/superpowers/specs/2026-06-16-promo-sp3c-code-promotion-linkage-design.md`

**Model routing ([[model-routing-policy]]):** Sonnet implements. **Opus reviews** Task 5 (resolver/order/dedupe), Task 6 (e2e), Task 2 (type-gen). **Opus reviews** Task 8 (POS validate) + Task 9 (POS pricing/re-guard). **Haiku** reviews Task 1/3/4/10 (mechanical column-add + form) with Opus adjudicating any flag.

---

## File Structure

- `backend/internal/db/migrations/0037_promo_code_only.sql` — **create**: the `code_only` column.
- `backend/api/openapi.yaml` — **modify**: `codeOnly` on the `Promotion` schema + promotion input.
- `backend/internal/read/repo.go:828-840` — **modify**: `Promotions` json adds `codeOnly`.
- `backend/internal/write/repo.go:472-541` — **modify**: `Promotion` struct + INSERT/UPDATE add `code_only`.
- `backend/internal/service/order.go:640-741` — **modify**: `resolvePromos` — extract `loadPromoSpec` helper, wire linked-code path, intersection gating, dedupe, code_only direct-path guard.
- `backend/internal/service/order_promo3c_test.go` — **create**: table-driven resolver tests.
- `backend/cmd/promo3ce2e/main.go` — **create** (throwaway): live e2e against the test DB.
- `apps/pos/src/cashier/promoValidate.ts:97-122` — **modify**: `AppliedPromoCode` + `decideApplyCode` handle linked codes.
- `apps/pos/src/cashier/promoValidate.test.ts` — **modify**: linked-code parity cases.
- `apps/pos/src/cashier/PromoPanel.tsx` — **modify**: hide `code_only` promotions.
- `apps/pos/src/cashier/cashierReducer.ts` + `useCart.ts` — **modify**: apply a linked code's promotion mechanics in `computePricing`; checkout re-guard.
- `apps/backoffice/src/screens/Promotions.tsx` — **modify**: `code_only` toggle on the promo form; promotion picker on the code form.

---

## Task 1: Migration 0037 — `promotions.code_only`

**Files:**
- Create: `backend/internal/db/migrations/0037_promo_code_only.sql`

- [ ] **Step 1: Write the migration**

```sql
-- SP-Promo-3c: a promotion marked code_only is hidden from the POS browse panel
-- and resolves ONLY when unlocked by a linked discount code (discount_codes.promotion_id).
-- Default false = unchanged behavior for every existing promotion.
ALTER TABLE promotions
  ADD COLUMN code_only boolean NOT NULL DEFAULT false;
```

- [ ] **Step 2: Verify it applies locally**

Run: `cd backend && go run ./cmd/migrate up` (or the project's migrate entrypoint — check `backend/cmd/` for the exact command; mirror how 0036 was applied)
Expected: migration 0037 applies, no error.

- [ ] **Step 3: Commit**

```bash
git add backend/internal/db/migrations/0037_promo_code_only.sql
git commit -m "feat(promo): migration 0037 — promotions.code_only (SP-Promo-3c)"
```

---

## Task 2: OpenAPI — `codeOnly` on Promotion + regen

**Files:**
- Modify: `backend/api/openapi.yaml` (the `Promotion` schema and its create/update input schema)
- Modify (generated): `backend/internal/api/api.gen.go`, `packages/types` / `schema.d.ts`

- [ ] **Step 1: Add the field to the schema(s)**

In `openapi.yaml`, on the `Promotion` schema and the promotion **input** schema (find them near the existing `combinable` property — added in SP-Promo-3a), add:

```yaml
        codeOnly:
          type: boolean
          description: When true, hidden from the POS panel; reachable only via a linked discount code.
```

Match the exact indentation/placement of the sibling `combinable` property in both schemas. Do NOT mark it `required` (mirror how `combinable` was added — optional boolean).

- [ ] **Step 2: Regenerate**

Run: `cd backend && make gen` (the project's codegen target; same one used in SP-Promo-3a)
Expected: `api.gen.go` and the TS `schema.d.ts` now contain `codeOnly`/`CodeOnly`.

- [ ] **Step 3: Verify codegen is in sync**

Run: `cd backend && make gen-check`
Expected: PASS (no drift). Note: `gen-check` gates `api.gen.go`; verify the TS `schema.d.ts` diff by eye (known `gen-check` limitation from SP-Promo-3a).

- [ ] **Step 4: Commit**

```bash
git add backend/api/openapi.yaml backend/internal/api/api.gen.go packages/types
git commit -m "feat(promo): OpenAPI codeOnly on Promotion + regen (SP-Promo-3c)"
```

---

## Task 3: Read repo — return `codeOnly`

**Files:**
- Modify: `backend/internal/read/repo.go:828-840` (`Promotions`)

- [ ] **Step 1: Add `codeOnly` to the json_build_object**

In the `Promotions` query, add `'codeOnly',code_only,` adjacent to the existing `'combinable',combinable,`:

```go
		   'outletIds',outlet_ids,'combinable',combinable,'codeOnly',code_only,
```

(Keep the rest of the object identical.)

- [ ] **Step 2: Build**

Run: `cd backend && go build ./...`
Expected: compiles.

- [ ] **Step 3: Commit**

```bash
git add backend/internal/read/repo.go
git commit -m "feat(promo): read repo returns promotions.code_only (SP-Promo-3c)"
```

---

## Task 4: Write repo — persist `code_only`

**Files:**
- Modify: `backend/internal/write/repo.go:472-541` (`Promotion` struct, `CreatePromotion`, `UpdatePromotion`)

- [ ] **Step 1: Add the struct field**

In `type Promotion struct` (after `Combinable`):

```go
	Combinable             *bool    `json:"combinable"`
	CodeOnly               bool     `json:"codeOnly"`
	CombinableWith         []string `json:"combinableWith"`
```

- [ ] **Step 2: Add to INSERT** (`CreatePromotion`)

Add `code_only` to the column list and a new `$18` placeholder, shifting `start_date,end_date` to `$19,$20`:

```go
		return t.QueryRow(ctx, `
			INSERT INTO promotions (name, description, type, value, min_purchase,
			  applicable_product_ids, applicable_variant_keys,
			  applicable_variant_sizes, outlet_ids, combinable, combinable_with,
			  active_from_hour, active_to_hour, active_days, is_active,
			  start_date, end_date, code_only)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
			RETURNING id`,
			p.Name, nullStr(p.Description), p.Type, p.Value, p.MinPurchase,
			apid, avk, avs, oid, p.Combinable, cw,
			nullStr(p.ActiveFromHour), nullStr(p.ActiveToHour), ad, p.IsActive,
			nullDate(p.StartDate), nullDate(p.EndDate), p.CodeOnly).Scan(&id)
```

- [ ] **Step 3: Add to UPDATE** (`UpdatePromotion`)

Add `code_only=$18` and shift the WHERE id to `$19`:

```go
		ct, e := t.Exec(ctx, `
			UPDATE promotions SET name=$1, description=$2, type=$3, value=$4,
			  min_purchase=$5, applicable_product_ids=$6, applicable_variant_keys=$7,
			  applicable_variant_sizes=$8, outlet_ids=$9, combinable=$10,
			  combinable_with=$11, active_from_hour=$12, active_to_hour=$13,
			  active_days=$14, is_active=$15, start_date=$16, end_date=$17, code_only=$18
			WHERE id=$19`,
			p.Name, nullStr(p.Description), p.Type, p.Value, p.MinPurchase,
			apid, avk, avs, oid, p.Combinable, cw,
			nullStr(p.ActiveFromHour), nullStr(p.ActiveToHour), ad, p.IsActive,
			nullDate(p.StartDate), nullDate(p.EndDate), p.CodeOnly, id)
```

- [ ] **Step 4: Build**

Run: `cd backend && go build ./...`
Expected: compiles.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/write/repo.go
git commit -m "feat(promo): persist promotions.code_only in write repo (SP-Promo-3c)"
```

---

## Task 5: Resolver — linked-code path, intersection, dedupe (OPUS REVIEW)

**Files:**
- Modify: `backend/internal/service/order.go:640-741` (`resolvePromos`)
- Test: `backend/internal/service/order_promo3c_test.go`

This is the correctness-critical surface. Extract a `loadPromoSpec` helper (DRY — the direct promo loop and the linked-code path both need it), then wire the linked path.

- [ ] **Step 1: Write the failing tests**

Create `backend/internal/service/order_promo3c_test.go`. These test the pure helpers (`ValidatePromo`/`ValidateCode` intersection + a `combinabilityViolation` already exist; here we test the new `combinedViolations` helper and dedupe logic as pure functions). Add this small pure helper to make the merge testable:

```go
package service

import "testing"

// combinedViolations merges code-gate + linked-promo violations without mutating
// either input slice (avoids the append-aliasing trap).
func TestCombinedViolations(t *testing.T) {
	code := []PromoViolation{ViolationUsageLimit}
	promo := []PromoViolation{ViolationExpired}
	got := combinedViolations(code, promo)
	if len(got) != 2 || got[0] != ViolationUsageLimit || got[1] != ViolationExpired {
		t.Fatalf("want [usage_limit_reached expired], got %v", got)
	}
	// inputs must be untouched
	if len(code) != 1 || len(promo) != 1 {
		t.Fatalf("inputs mutated: code=%v promo=%v", code, promo)
	}
}

func TestCombinedViolationsEmpty(t *testing.T) {
	if got := combinedViolations(nil, nil); len(got) != 0 {
		t.Fatalf("want empty, got %v", got)
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && go test ./internal/service/ -run TestCombinedViolations -v`
Expected: FAIL — `undefined: combinedViolations`.

- [ ] **Step 3: Add the helper + `loadPromoSpec` + linked path**

In `order.go`, add the pure helper:

```go
// combinedViolations returns code-gate + linked-promotion violations as a fresh
// slice (Model A intersection: a linked code passes only if BOTH the code's gates
// and the promotion's rules pass). Does not mutate either argument.
func combinedViolations(code, promo []PromoViolation) []PromoViolation {
	out := make([]PromoViolation, 0, len(code)+len(promo))
	out = append(out, code...)
	out = append(out, promo...)
	return out
}
```

Add the promotion-loading helper (extracted from the existing direct loop so behavior stays byte-identical for non-code_only promos):

```go
// loadPromoSpec loads an ACTIVE promotion by id, builds its PromoSpec, and returns
// its combinable + code_only flags and validation violations. found=false on
// ErrNoRows (caller decides reject-vs-flag by origin).
func (s *OrderService) loadPromoSpec(ctx context.Context, tx pgx.Tx, promoID string, ec PromoEvalContext) (spec PromoSpec, combinable, codeOnly bool, vio []PromoViolation, found bool, err error) {
	var kind string
	var value float64
	var ids []string
	var row PromoRow
	e := tx.QueryRow(ctx,
		`SELECT type, value,
		   COALESCE(applicable_product_ids,'[]'::jsonb),
		   start_date, end_date, min_purchase,
		   COALESCE(active_from_hour,''), COALESCE(active_to_hour,''),
		   COALESCE(active_days,'[]'::jsonb), COALESCE(outlet_ids,'[]'::jsonb),
		   COALESCE(combinable,false), COALESCE(code_only,false)
		   FROM promotions WHERE id=$1 AND is_active=true`, promoID).
		Scan(&kind, &value, &ids, &row.StartDate, &row.EndDate, &row.MinPurchase,
			&row.ActiveFromHour, &row.ActiveToHour, &row.ActiveDays, &row.OutletIDs, &row.Combinable, &codeOnly)
	if errors.Is(e, pgx.ErrNoRows) {
		return PromoSpec{}, false, false, nil, false, nil
	}
	if e != nil {
		return PromoSpec{}, false, false, nil, false, fmt.Errorf("load promotion: %w", e)
	}
	spec = PromoSpec{Kind: DiscountKind(kind), Value: value, ApplicableProductIDs: ids, IsBOGO: kind == "bogo"}
	return spec, row.Combinable, codeOnly, ValidatePromo(row, ec), true, nil
}
```

Rewrite `resolvePromos` body. Keep the signature and the dedupe/return contract. Track applied promotion ids in `seen` to dedupe across the direct + linked paths:

```go
func (s *OrderService) resolvePromos(ctx context.Context, tx pgx.Tx, promoIDs, codes []string, ec PromoEvalContext, offline bool) ([]PromoSpec, []string, []string, string, error) {
	promoIDs = dedupeNonEmpty(promoIDs)
	codes = dedupeNonEmpty(codes)

	var specs []PromoSpec
	var codeIDs []string
	var appliedCodes []string
	var combinable []bool
	var violations []PromoViolation
	seen := map[string]bool{} // resolved promotion ids already applied (cross-path dedupe)

	reject := func(v []PromoViolation) ([]PromoSpec, []string, []string, string, error) {
		return nil, nil, nil, "", &ErrDiscountRejected{Violations: v}
	}

	// ── direct promotions ────────────────────────────────────
	for _, promoID := range promoIDs {
		if promoID == "" {
			continue
		}
		spec, comb, codeOnly, vio, found, err := s.loadPromoSpec(ctx, tx, promoID, ec)
		if err != nil {
			return nil, nil, nil, "", err
		}
		if !found {
			if !offline {
				return reject([]PromoViolation{ViolationNotFound})
			}
			violations = append(violations, ViolationNotFound)
			continue
		}
		// code_only promotions can't be applied directly — only via a linked code.
		if codeOnly {
			if !offline {
				return reject([]PromoViolation{ViolationNotFound})
			}
			violations = append(violations, ViolationNotFound)
			continue
		}
		if len(vio) > 0 {
			if !offline {
				return reject(vio)
			}
			violations = append(violations, vio...)
		}
		seen[promoID] = true
		specs = append(specs, spec)
		combinable = append(combinable, comb)
	}

	// ── discount codes ───────────────────────────────────────
	for _, code := range codes {
		if code == "" {
			continue
		}
		var id, kind string
		var value float64
		var promotionID *string
		var row CodeRow
		err := tx.QueryRow(ctx,
			`SELECT id, promotion_id, type, value, start_date, end_date, min_purchase, usage_limit, usage_count, combinable
			   FROM discount_codes WHERE code=$1 AND is_active=true FOR UPDATE`, code).
			Scan(&id, &promotionID, &kind, &value, &row.StartDate, &row.EndDate, &row.MinPurchase, &row.UsageLimit, &row.UsageCount, &row.Combinable)
		if errors.Is(err, pgx.ErrNoRows) {
			if !offline {
				return reject([]PromoViolation{ViolationNotFound})
			}
			violations = append(violations, ViolationNotFound)
			continue
		}
		if err != nil {
			return nil, nil, nil, "", fmt.Errorf("load discount code: %w", err)
		}

		codeVio := ValidateCode(row, ec)

		// ── LINKED CODE (Model A: code is a key) ──────────────
		if promotionID != nil && *promotionID != "" {
			if seen[*promotionID] {
				// the same promotion was already applied (directly or by another code);
				// drop quietly without consuming a redemption (no double discount).
				slog.Warn("linked promotion already applied; skipping redundant code",
					"code", code, "promotionId", *promotionID)
				continue
			}
			pspec, pcomb, _, pvio, found, lerr := s.loadPromoSpec(ctx, tx, *promotionID, ec)
			if lerr != nil {
				return nil, nil, nil, "", lerr
			}
			if !found {
				// linked promotion missing or inactive
				if !offline {
					return reject([]PromoViolation{ViolationNotFound})
				}
				violations = append(violations, ViolationNotFound)
				continue
			}
			if all := combinedViolations(codeVio, pvio); len(all) > 0 {
				if !offline {
					return reject(all)
				}
				violations = append(violations, all...)
			}
			seen[*promotionID] = true
			specs = append(specs, pspec)
			combinable = append(combinable, pcomb) // promotion's combinable governs
			codeIDs = append(codeIDs, id)
			appliedCodes = append(appliedCodes, code)
			continue
		}

		// ── UNLINKED CODE (today's behavior) ──────────────────
		spec := PromoSpec{Kind: DiscountKind(kind), Value: value}
		if len(codeVio) > 0 {
			if !offline {
				return reject(codeVio)
			}
			violations = append(violations, codeVio...)
		}
		specs = append(specs, spec)
		codeIDs = append(codeIDs, id)
		appliedCodes = append(appliedCodes, code)
		combinable = append(combinable, row.Combinable)
	}

	if v := combinabilityViolation(combinable); v != nil {
		if !offline {
			return reject([]PromoViolation{*v})
		}
		violations = append(violations, *v)
	}

	warn := ""
	if len(violations) > 0 {
		warn = JoinViolations(violations)
	}
	return specs, codeIDs, appliedCodes, warn, nil
}
```

Confirm `log/slog` is imported in `order.go` (it is used elsewhere in the service package — add the import if the file doesn't already have it).

- [ ] **Step 4: Run the new tests + full suite + parity**

Run: `cd backend && go test ./internal/service/ -run TestCombinedViolations -v`
Expected: PASS.

Run: `cd backend && go test ./... `
Expected: PASS — especially the existing SP-Promo-3a single-promo parity test (the helper produces a byte-identical spec for non-code_only promos).

- [ ] **Step 5: Commit**

```bash
git add backend/internal/service/order.go backend/internal/service/order_promo3c_test.go
git commit -m "feat(promo): resolvePromos honors discount_codes.promotion_id (Model A linkage, intersection, dedupe, code_only guard) (SP-Promo-3c)"
```

> **Opus review gate** after this task (resolver/order/dedupe — correctness-critical per [[model-routing-policy]]). Reviewer must confirm: (a) non-code_only single-promo path is byte-identical to pre-3c; (b) intersection gating rejects when EITHER side fails; (c) dedupe never double-applies and never consumes a redundant redemption; (d) hybrid-by-origin (online 422 / offline flag) preserved on every new branch.

---

## Task 6: Live e2e — `cmd/promo3ce2e` (OPUS REVIEW)

**Files:**
- Create (throwaway, do NOT commit): `backend/cmd/promo3ce2e/main.go`

Mirror the structure of the prior `cmd/promo3e2e` (real `service.OrderService` against the test DB, all artifacts deleted at the end, zero-residue self-check).

- [ ] **Step 1: Write the e2e harness covering these scenarios**

1. Create a `code_only=true` BOGO promotion scoped to a product + a code linked to it (`promotion_id` set, `usage_limit` 1). Order with the code → assert the BOGO discount applied, `usage_count` → 1, order recorded.
2. Direct-apply the same `code_only` promotion id (online) → assert rejected (ViolationNotFound surfaced as 422-class error).
3. Underlying linked promotion expired → online order rejected; offline order recorded with `discount_warning`.
4. Dedupe: send the linked code AND the promotion id directly (non-code_only variant) → assert the discount applied exactly once.
5. Refund the linked-code order → assert the code's `usage_count` restored (and idempotent on double refund).
6. Unlinked code (no `promotion_id`) → unchanged %/Rp-off behavior (regression guard).

- [ ] **Step 2: Run it against the test DB**

Run: `cd backend && go run ./cmd/promo3ce2e`
Expected: all assertions pass; final cleanup reports zero residue.

- [ ] **Step 3: Remove the throwaway (do not commit it)**

Run: `rm -rf backend/cmd/promo3ce2e`

> **Opus review** of the e2e results + any bug it surfaces. (No commit — the harness is throwaway, like promo1e2e/promo3e2e.)

---

## Task 7: POS validator — linked-code handling (OPUS REVIEW)

**Files:**
- Modify: `apps/pos/src/cashier/promoValidate.ts:97-122`
- Test: `apps/pos/src/cashier/promoValidate.test.ts`

The POS already loads all promotions for the panel. A linked code resolves its promotion from that in-memory list, validates BOTH (intersection), and carries the promotion's pricing fields so `computePricing` can apply BOGO/scoping.

- [ ] **Step 1: Write failing tests**

Add to `promoValidate.test.ts`:

```ts
import { decideApplyCode } from './promoValidate'

const ctx = { now: Date.parse('2026-06-16T05:00:00Z'), outletId: 'o1', subtotal: 150_000 }

test('linked code inherits the promotion mechanics (Model A)', () => {
  const promo = { id: 'p1', type: 'bogo', value: 0, applicableProductIds: ['atm'], isActive: true, codeOnly: true } as any
  const code = { code: 'ATM100', promotionId: 'p1', type: 'fixed', value: 999, usageLimit: 1, usageCount: 0, isActive: true } as any
  const res = decideApplyCode('ATM100', [code], ctx, [promo])
  expect(res.ok).toBe(true)
  if (res.ok) {
    expect(res.code.promotion?.id).toBe('p1')   // mechanics come from the promotion
    expect(res.code.promotion?.isBOGO).toBe(true)
  }
})

test('linked code rejected when the underlying promotion is expired', () => {
  const promo = { id: 'p1', type: 'fixed', value: 10000, endDate: '2020-01-01', isActive: true } as any
  const code = { code: 'OLD', promotionId: 'p1', type: 'fixed', value: 1, isActive: true } as any
  const res = decideApplyCode('OLD', [code], ctx, [promo])
  expect(res.ok).toBe(false)
})

test('unlinked code unchanged', () => {
  const code = { code: 'FLAT', type: 'fixed', value: 5000, isActive: true } as any
  const res = decideApplyCode('FLAT', [code], ctx, [])
  expect(res.ok).toBe(true)
  if (res.ok) expect(res.code.value).toBe(5000)
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/pos && pnpm vitest run src/cashier/promoValidate.test.ts`
Expected: FAIL — `decideApplyCode` takes 3 args / `promotion` missing on `AppliedPromoCode`.

- [ ] **Step 3: Extend the type + decision**

```ts
export interface AppliedPromoCode {
  code: string
  value: number
  type: 'percentage' | 'fixed'
  combinable?: boolean
  // SP-Promo-3c: when the code is linked to a promotion, the promotion supplies
  // the mechanics (BOGO/scoping). Present only for linked codes.
  promotion?: {
    id: string
    type: string
    value: number
    applicableProductIds?: string[]
    isBOGO: boolean
  }
}
```

```ts
export function decideApplyCode(
  typed: string,
  codes: DiscountCode[],
  ctx: PromoEvalContext,
  promotions: Promotion[] = [],
): ApplyCodeDecision {
  const upper = typed.trim().toUpperCase()
  const dc = codes.find((d) => d.code.toUpperCase() === upper && d.isActive)
  if (!dc) return { ok: false, reason: 'Kode tidak ditemukan' }

  const codeVio = validateCode(dc, ctx)

  // Linked code (Model A): mechanics + extra gating come from the promotion.
  if (dc.promotionId) {
    const promo = promotions.find((p) => p.id === dc.promotionId && p.isActive)
    if (!promo) return { ok: false, reason: 'Promo tertaut tidak tersedia' }
    const all = [...codeVio, ...validatePromo(promo, ctx)]
    if (all.length > 0) return { ok: false, reason: violationMessage(all[0]) }
    return {
      ok: true,
      code: {
        code: dc.code,
        value: promo.value,
        type: promo.type as 'percentage' | 'fixed',
        combinable: promo.combinable ?? false, // promotion's flag governs
        promotion: {
          id: promo.id,
          type: promo.type,
          value: promo.value,
          applicableProductIds: promo.applicableProductIds,
          isBOGO: promo.type === 'bogo',
        },
      },
    }
  }

  // Unlinked code: today's behavior.
  if (codeVio.length > 0) return { ok: false, reason: violationMessage(codeVio[0]) }
  return { ok: true, code: { code: dc.code, value: dc.value, type: dc.type, combinable: dc.combinable ?? false } }
}
```

- [ ] **Step 4: Run tests**

Run: `cd apps/pos && pnpm vitest run src/cashier/promoValidate.test.ts`
Expected: PASS (all prior cases still green).

- [ ] **Step 5: Commit**

```bash
git add apps/pos/src/cashier/promoValidate.ts apps/pos/src/cashier/promoValidate.test.ts
git commit -m "feat(promo): POS promoValidate resolves linked codes via promotion (SP-Promo-3c)"
```

> **Opus review** (POS hot-path validator parity with the Go resolver).

---

## Task 8: POS — hide code_only, price linked codes, re-guard (OPUS REVIEW)

**Files:**
- Modify: `apps/pos/src/cashier/PromoPanel.tsx`
- Modify: `apps/pos/src/cashier/cashierReducer.ts` (computePricing) + `apps/pos/src/cashier/useCart.ts`
- Modify: the checkout re-guard in `apps/pos/src/cashier/CashierScreen.tsx` (`handleConfirmPayment`) / `AdjustmentDrawer.tsx` apply path

- [ ] **Step 1: Hide code_only promotions in the panel**

In `PromoPanel.tsx`, where the active promotions list is built for display, filter them out:

```ts
const browsable = promotions.filter((p) => p.isActive && !p.codeOnly)
```

Use `browsable` for the panel's promotion list (leave the code-entry input untouched — code_only promos are reached by typing their linked code).

- [ ] **Step 2: Pass the promotions list into the code-apply call**

Wherever `decideApplyCode(typed, codes, ctx)` is currently called (code-entry handler), pass the loaded promotions as the 4th arg: `decideApplyCode(typed, codes, ctx, promotions)`.

- [ ] **Step 3: Apply a linked code's promotion mechanics in pricing**

In `computePricing` (cashierReducer.ts), the applied-codes branch currently treats each `AppliedPromoCode` as flat `value`/`type`. Extend it: when `appliedCode.promotion` is present, compute its discount with the SAME promotion calculator the panel uses (`calcPromoDiscount` / BOGO helper) instead of the flat value, so BOGO/scoping is honored:

```ts
for (const ac of appliedPromoCodes) {
  const d = ac.promotion
    ? calcPromoDiscount(ac.promotion, cart, originalSubtotal) // promotion mechanics
    : flatCodeDiscount(ac, originalSubtotal)                   // unlinked: today's path
  // ...sum into the stack exactly as 3a does (additive off original subtotal)
}
```

(Reuse the existing `calcPromoDiscount` used for `appliedPromotions`; do not duplicate the BOGO math.)

- [ ] **Step 4: Extend the checkout re-guard**

In `handleConfirmPayment`, the re-guard re-validates each applied promo/code. For an applied code carrying `promotion`, re-run `validatePromo(promotion, ctx)` in addition to `validateCode`, mirroring `decideApplyCode`. On failure: `showToast` cancel + clear, block the sale (unchanged shape).

- [ ] **Step 5: Run the POS gate**

Run: `cd apps/pos && pnpm tsc -b && pnpm vite build && pnpm vitest run`
Expected: typecheck + build + all vitest green.

- [ ] **Step 6: Commit**

```bash
git add apps/pos/src/cashier
git commit -m "feat(promo): POS hides code_only promos, prices linked codes via promotion, re-guards (SP-Promo-3c)"
```

> **Opus review** (POS pricing + checkout re-guard — money path).

---

## Task 9: Backoffice — code_only toggle + promotion picker

**Files:**
- Modify: `apps/backoffice/src/screens/Promotions.tsx`

- [ ] **Step 1: Add the `code_only` toggle to the promo form**

In the Promosi form (near the existing "Bisa Kombinasi" toggle added in SP-Promo-3a), add a toggle bound to the promotion's `codeOnly` field:

```tsx
<label className="flex items-center gap-2">
  <input type="checkbox"
    checked={form.codeOnly ?? false}
    onChange={(e) => setForm({ ...form, codeOnly: e.target.checked })} />
  <span>Hanya via kode (sembunyikan dari panel kasir)</span>
</label>
```

Add a small badge on code_only rows in the promotions list (mirror the "Bisa Kombinasi" badge).

- [ ] **Step 2a: Verify `promotionId` is on the OpenAPI DiscountCode INPUT schema (SP-Promo-3a gap-class check)**

`promotionId` is on the write struct (`write/repo.go:551`) + read json (`read/repo.go:844`), but confirm it is also on the **DiscountCode input** schema in `backend/api/openapi.yaml` (so the generated backoffice client actually sends it). Grep: `grep -n "promotionId" backend/api/openapi.yaml`. If the input schema lacks it, add `promotionId: { type: string, nullable: true }` to that input schema, `make gen` + `make gen-check`, and commit before the UI step. Trace read json AND write INSERT/UPDATE AND OpenAPI input — not just one layer.

- [ ] **Step 2: Add the promotion picker to the Kode Diskon form**

`promotionId` is already on the `DiscountCode` write struct + read json — only the UI (and possibly the OpenAPI input, per 2a) is missing. Add a select bound to `form.promotionId` listing existing promotions (option value = promotion id; include an empty "— Tidak ditautkan —" option). When a promotion is selected, disable the code's own Tipe/Nilai inputs with a note:

```tsx
<select value={form.promotionId ?? ''} onChange={(e) => setForm({ ...form, promotionId: e.target.value || undefined })}>
  <option value="">— Tidak ditautkan —</option>
  {promotions.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
</select>
{form.promotionId && (
  <p className="text-xs text-gray-500">Tipe &amp; nilai diikuti dari promosi tertaut.</p>
)}
```

Gate the Tipe/Nilai inputs with `disabled={!!form.promotionId}`.

- [ ] **Step 3: Build**

Run: `cd apps/backoffice && pnpm tsc -b && pnpm vite build`
Expected: typecheck + build green.

- [ ] **Step 4: Commit**

```bash
git add apps/backoffice/src/screens/Promotions.tsx
git commit -m "feat(promo): backoffice code_only toggle + code→promotion picker (SP-Promo-3c)"
```

> **Haiku review** (form/copy, no new logic) — Opus adjudicates any flag.

---

## Task 10: Local gate, deploy, smoke, APK

- [ ] **Step 1: Pre-deploy data check (rule 3 — flag uncertainty)**

Query the test DB for codes that already carry a link (resolution will now honor it):

```sql
SELECT id, code, promotion_id FROM discount_codes WHERE promotion_id IS NOT NULL;
```

Expected: 0 rows (the old form never set it). If any exist, STOP and review them with the user before deploy — their behavior will change from own-value to promotion-inherited.

- [ ] **Step 2: Full local gate**

Run: `cd backend && go build ./... && go test ./... && make gen-check`
Run: `cd apps/pos && pnpm tsc -b && pnpm vite build && pnpm vitest run`
Run: `cd apps/backoffice && pnpm tsc -b && pnpm vite build`
Expected: all green.

- [ ] **Step 3: Deploy backend (migration 0037)**

Run: `gcloud run deploy mandalika-pos --source backend --region asia-southeast2 --quiet`
Expected: new revision, `/readyz` 200, migration 0037 applied.

- [ ] **Step 4: Authed smoke (the SP-Promo-3a gap-class check)**

Create a promotion with `codeOnly:true` via the authed API; GET promotions → confirm `codeOnly:true` serializes; create a discount code with `promotionId` set → GET codes → confirm `promotionId` persists.
Expected: both round-trip correctly.

- [ ] **Step 5: Build the APK**

Run: `"/c/Program Files/GitHub CLI/gh.exe" workflow run android-release.yml --ref prod-hardening -f api_url=<cloud-run-url>`
Watch to green; install from the run.

- [ ] **Step 6: Update SESSION_HANDOFF.md + memory**

Add the SP-Promo-3c banner (rev, migration 0037, commits, what shipped, USER-PENDING on-device acceptance) and update the [[promotion-module-sp-promo]] memory.

```bash
git add SESSION_HANDOFF.md
git commit -m "docs: SP-Promo-3c handoff (SP-Promo-3c)"
```

---

## On-device acceptance (USER-PENDING after APK)

1. Backoffice: create a `code_only` BOGO promotion → confirm it does NOT appear in the POS panel.
2. Create a discount code linked to it (usage_limit 1) → save → reopen confirms `promotionId` + the disabled Tipe/Nilai note.
3. POS: type the code → the BOGO discount applies; cart savings + chip show the linked promotion's effect.
4. Try to redeem the code a 2nd time → blocked (usage_limit_reached).
5. Online: an order with an expired underlying promotion's code → rejected at Bayar with the Indonesian reason; offline → recorded + ⚠ flag.
6. Refund the linked-code order → the code's usage restored (backoffice Kode Diskon usage).
7. Regression: an unlinked %/Rp-off code still works exactly as before.

---

## Self-review notes (verify before execution)

- **Spec coverage:** §1 data model → Task 1/2/3/4; §2 resolver → Task 5/6; §3 POS → Task 7/8; §4 backoffice → Task 9; §5 wire/type-gen → Task 2/3/4; testing/rollout → Task 6/10. All covered.
- **Type consistency:** `loadPromoSpec` (Go) returns `(spec, combinable, codeOnly, vio, found, err)` — used identically in both the direct and linked paths in Task 5. `AppliedPromoCode.promotion` (TS) defined in Task 7, consumed in Task 8 `computePricing` + re-guard. `combinedViolations` defined + tested in Task 5.
- **No placeholders:** every code step shows the code. The only intentional "match the existing pattern" references (OpenAPI placement, backoffice badge) point at the SP-Promo-3a `combinable` precedent in the same files.
