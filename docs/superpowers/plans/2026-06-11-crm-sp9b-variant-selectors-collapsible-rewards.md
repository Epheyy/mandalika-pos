# SP-CRM-9b — Variant-Level Loyalty Selectors + Collapsible "Hadiah Loyalti" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Loyalty-condition product pickers select whole products OR specific variants (composite `"pid"` / `"pid|size"` entries, zero migration), and the POS checkout "Hadiah Loyalti" section collapses to "(name) — Tersedia!" status rows.

**Architecture:** Composite IDs ride the existing `rewardProductIds`/`applicableProductIds` jsonb string arrays. The pure engine stays parse-free — callers add `pid|size` keys to the eval product set. Preview filters variants in Go after the existing SQL. Backoffice gets one shared `ProductVariantPicker`; POS change is presentation-only in `CheckoutPanel`.

**Tech Stack:** Go (pgx, no new deps; `strings` import in loyalty_preview.go), React/TS (lucide-react icons already in backoffice), vitest/go test.

**Spec:** `docs/superpowers/specs/2026-06-11-crm-sp9b-variant-selectors-collapsible-rewards-design.md`

**Branch:** `prod-hardening` directly (like SP-CRM-1..9, no worktree).

**Gotchas for every implementer:**
- Windows: NO `-race` (no cgo). Run `go test ./...` plain.
- Commit protocol: `git add <files>` and `git commit -m "..."` as SEPARATE tool calls (a chained call false-positives a hook).
- NO OpenAPI change in this slice (the arrays stay `string[]`) → `make gen-check` must stay green with no regen diff.
- Money is float32 in generated TS / float64 in service structs — don't "fix" this.
- The size separator is `|`; size names never contain it (defensive exclusion in the picker only).

---

## Batch A — Backend

### Task A1: Engine semantics tests (no engine code change)

The `product_purchase` matcher is a plain set lookup (`ctx.ProductIDs[entry]`), so composite entries work as soon as CALLERS put `pid|size` keys in the set. Lock the semantics with table tests BEFORE touching callers.

**Files:**
- Modify: `backend/internal/service/loyalty_test.go` (append to the existing table tests; follow the existing case style in that file)

- [ ] **Step 1: Write the new test cases**

Append a new test function (adapt the condition/context builder helpers to whatever the existing tests in the file use — read the file first; the cases below are the required semantics):

```go
func TestProductPurchaseVariantEntries(t *testing.T) {
	mk := func(entries ...string) []LoyaltyCondition {
		return []LoyaltyCondition{{
			ID: "c1", Name: "V", Type: "always_on", Trigger: "product_purchase",
			RewardType: "product_reward", RewardProductIDs: []string{"rp1"},
			ApplicableProductIDs: entries, IsActive: true,
		}}
	}
	ctx := func(keys ...string) EvalContext {
		set := make(map[string]bool, len(keys))
		for _, k := range keys {
			set[k] = true
		}
		return EvalContext{Total: 100000, BasePoints: 100, ProductIDs: set,
			SaleDate: time.Date(2026, 6, 11, 10, 0, 0, 0, wib)}
	}
	cases := []struct {
		name    string
		conds   []LoyaltyCondition
		ctx     EvalContext
		matched bool
	}{
		{"whole-product entry matches product key", mk("p1"), ctx("p1", "p1|10ml"), true},
		{"variant entry matches exact variant key", mk("p1|10ml"), ctx("p1", "p1|10ml"), true},
		{"variant entry does NOT match a different size", mk("p1|110ml"), ctx("p1", "p1|10ml"), false},
		{"variant entry does NOT match product-only key", mk("p1|10ml"), ctx("p1"), false},
		{"mixed entries: whole product wins for any size", mk("p1|110ml", "p1"), ctx("p1", "p1|10ml"), true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			out := EvaluateLoyalty(tc.conds, tc.ctx)
			if got := len(out.Applied) == 1; got != tc.matched {
				t.Fatalf("matched=%v want %v (applied=%v)", got, tc.matched, out.Applied)
			}
		})
	}
}
```

- [ ] **Step 2: Run the tests**

Run: `go test ./internal/service/ -run TestProductPurchaseVariantEntries -v` (from `backend/`)
Expected: PASS — the engine is already a generic set lookup; these tests pin the contract so future engine edits can't break composite entries.

- [ ] **Step 3: Commit**

`git add backend/internal/service/loyalty_test.go` then
`git commit -m "test(crm): SP-CRM-9b pin variant-entry semantics for product_purchase matching"`

### Task A2: CreateOrder — composite eval keys + variant-aware reward validation + precise grant

**Files:**
- Modify: `backend/internal/service/order.go` (pidSet build ~line 179-185; reward-line validation ~line 354-374; add `rewardLineAllowed` helper near `nextOrderNumber`)
- Modify: `backend/internal/service/order_helpers_test.go` (create if absent — pure unit test, no DB)

- [ ] **Step 1: Write the failing test for the validation helper**

Create/append `backend/internal/service/order_helpers_test.go`:

```go
package service

import "testing"

func TestRewardLineAllowed(t *testing.T) {
	menu := []string{"p1", "p2|10ml ATOMIZER"}
	cases := []struct {
		name      string
		pid, size string
		want      bool
	}{
		{"whole-product entry allows any size", "p1", "110ml EXTRAIT DE PARFUM", true},
		{"whole-product entry allows empty size", "p1", "", true},
		{"variant entry allows the exact size", "p2", "10ml ATOMIZER", true},
		{"variant entry rejects another size", "p2", "110ml EXTRAIT DE PARFUM", false},
		{"variant entry rejects empty size", "p2", "", false},
		{"unlisted product rejected", "p3", "10ml ATOMIZER", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := rewardLineAllowed(menu, tc.pid, tc.size); got != tc.want {
				t.Fatalf("rewardLineAllowed(%q,%q)=%v want %v", tc.pid, tc.size, got, tc.want)
			}
		})
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `go test ./internal/service/ -run TestRewardLineAllowed -v`
Expected: FAIL — `undefined: rewardLineAllowed`

- [ ] **Step 3: Implement**

(a) Add the helper in `order.go` (right above `nextOrderNumber`):

```go
// rewardLineAllowed reports whether a reward line's chosen item is on the
// condition's menu: listed as the whole product ("pid") or the exact variant
// ("pid|size"). SP-CRM-9b composite entries.
func rewardLineAllowed(menu []string, productID, size string) bool {
	if contains(menu, productID) {
		return true
	}
	return size != "" && contains(menu, productID+"|"+size)
}
```

(b) pidSet build (the `hasLoyaltyCustomer` block, currently lines 179-185) — add the composite key:

```go
		pidSet := make(map[string]bool, len(in.Items)*2)
		for _, it := range in.Items {
			if it.IsReward {
				continue // a free reward item must not trigger more conditions
			}
			pidSet[it.ProductID] = true
			if it.VariantSize != "" {
				pidSet[it.ProductID+"|"+it.VariantSize] = true // variant-level trigger entries (SP-CRM-9b)
			}
		}
```

(c) Reward-line validation + grant (currently lines 354-374). Replace the `!ok || seenReward[...] || !contains(...)` condition and the grant's chosen value:

```go
			seenReward := make(map[string]bool)
			for _, it := range in.Items {
				if !it.IsReward {
					continue
				}
				a, ok := rewardMenu[it.RewardConditionID]
				if !ok || seenReward[it.RewardConditionID] || !rewardLineAllowed(a.RewardProductIDs, it.ProductID, it.VariantSize) {
					slog.Warn("dropping unfulfillable reward line from audit",
						"order_id", orderID, "condition_id", it.RewardConditionID, "product_id", it.ProductID)
					continue
				}
				seenReward[it.RewardConditionID] = true
				chosen := it.ProductID // grant records the CHOSEN item; "pid|size" when the size is known
				if it.VariantSize != "" {
					chosen += "|" + it.VariantSize
				}
				if e := write.InsertConditionApplication(ctx, tx, write.ConditionApplicationRow{
					OrderID: orderID, CustomerID: in.CustomerID, ConditionID: a.ConditionID,
					ConditionName: a.Name, Trigger: a.Trigger, RewardType: "product_reward",
					RewardValue: a.RewardValue, PointsContributed: 0,
					RewardProductIDs: []string{chosen},
				}); e != nil {
					return "", false, false, fmt.Errorf("record reward fulfillment: %w", e)
				}
			}
```

- [ ] **Step 4: Run tests**

Run: `go test ./internal/service/ -v -run "TestRewardLineAllowed|TestProductPurchaseVariantEntries"` then `go build ./... && go test ./...`
Expected: all PASS.

- [ ] **Step 5: Commit**

`git add backend/internal/service/order.go backend/internal/service/order_helpers_test.go` then
`git commit -m "feat(crm): SP-CRM-9b variant-aware eval keys, reward validation, and pid|size grant in CreateOrder"`

### Task A3: Preview — composite eval keys + variant-filtered menu

**Files:**
- Modify: `backend/internal/service/loyalty_preview.go` (pidSet ~line 61-67; `rewardProductMenu` ~line 100-138; add `parseMenu` helper; add `strings` import)
- Modify: `backend/internal/service/order_helpers_test.go` (append `parseMenu` tests)

- [ ] **Step 1: Write the failing test**

Append to `order_helpers_test.go`:

```go
func TestParseMenu(t *testing.T) {
	t.Run("whole product entry → nil size set (all sizes)", func(t *testing.T) {
		ids, allowed := parseMenu([]string{"p1"})
		if len(ids) != 1 || ids[0] != "p1" || allowed["p1"] != nil {
			t.Fatalf("ids=%v allowed=%v", ids, allowed)
		}
	})
	t.Run("variant entries → size set", func(t *testing.T) {
		_, allowed := parseMenu([]string{"p1|10ml", "p1|110ml"})
		if allowed["p1"] == nil || !allowed["p1"]["10ml"] || !allowed["p1"]["110ml"] || allowed["p1"]["2ml"] {
			t.Fatalf("allowed=%v", allowed)
		}
	})
	t.Run("whole-product entry wins over variant entries", func(t *testing.T) {
		_, a1 := parseMenu([]string{"p1|10ml", "p1"})
		_, a2 := parseMenu([]string{"p1", "p1|10ml"})
		if a1["p1"] != nil || a2["p1"] != nil {
			t.Fatalf("whole product must win: %v %v", a1, a2)
		}
	})
	t.Run("distinct products keep entry order, no dup ids", func(t *testing.T) {
		ids, _ := parseMenu([]string{"p2|10ml", "p1", "p2|110ml"})
		if len(ids) != 2 || ids[0] != "p2" || ids[1] != "p1" {
			t.Fatalf("ids=%v", ids)
		}
	})
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `go test ./internal/service/ -run TestParseMenu -v`
Expected: FAIL — `undefined: parseMenu`

- [ ] **Step 3: Implement in `loyalty_preview.go`**

(a) Add `"strings"` to imports.

(b) Add above `rewardProductMenu`:

```go
// parseMenu splits SP-CRM-9b composite menu entries ("pid" or "pid|size") into
// the distinct product ids to query (entry order, deduped) and a per-product
// allowed-size set. A nil set means ALL sizes (whole-product entry; it wins over
// variant entries for the same product).
func parseMenu(entries []string) ([]string, map[string]map[string]bool) {
	allowed := make(map[string]map[string]bool, len(entries))
	var order []string
	for _, e := range entries {
		pid, size := e, ""
		if i := strings.IndexByte(e, '|'); i >= 0 {
			pid, size = e[:i], e[i+1:]
		}
		cur, seen := allowed[pid]
		if !seen {
			order = append(order, pid)
		}
		if size == "" {
			allowed[pid] = nil // whole product — all sizes
			continue
		}
		if seen && cur == nil {
			continue // a whole-product entry is already present; superset wins
		}
		if cur == nil {
			cur = make(map[string]bool)
			allowed[pid] = cur
		}
		cur[size] = true
	}
	return order, allowed
}
```

(c) In `PreviewRewards`, mirror the order.go composite pidSet (lines 61-67):

```go
	pidSet := make(map[string]bool, len(items)*2)
	for _, it := range items {
		if it.IsReward {
			continue
		}
		pidSet[it.ProductID] = true
		if it.VariantSize != "" {
			pidSet[it.ProductID+"|"+it.VariantSize] = true // variant-level trigger entries (SP-CRM-9b)
		}
	}
```

(d) `rewardProductMenu` — parse first, query by product ids, filter sizes after scan. Replace the current body's head and the scan loop:

```go
func (s *OrderService) rewardProductMenu(ctx context.Context, ids []string) ([]RewardPreviewProduct, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	productIDs, allowedSizes := parseMenu(ids)
	rows, err := s.Pool.Query(ctx, `
		SELECT p.id, p.name, v.size, v.price
		  FROM products p
		  JOIN product_variants v ON v.product_id = p.id
		 WHERE p.id = ANY($1) AND p.is_active = true
		 ORDER BY p.name, v.price`, productIDs)
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
		if sz := allowedSizes[pid]; sz != nil && !sz[size] {
			continue // variant-level entry: this size isn't on the menu (SP-CRM-9b)
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
		return nil, fmt.Errorf("reward product rows: %w", err)
	}
	out := make([]RewardPreviewProduct, 0, len(order))
	for _, id := range order {
		out = append(out, *byID[id])
	}
	return out, nil
}
```

(Existing behavior preserved: a product whose every size is filtered out never lands in `byID` → dropped; an all-filtered menu → empty → `PreviewRewards` drops the reward.)

- [ ] **Step 4: Run tests + full backend gate**

Run: `go test ./internal/service/ -run TestParseMenu -v` → PASS, then `go build ./... && go test ./... && make gen-check` (gen-check must show NO diff — no OpenAPI change).

- [ ] **Step 5: Commit**

`git add backend/internal/service/loyalty_preview.go backend/internal/service/order_helpers_test.go` then
`git commit -m "feat(crm): SP-CRM-9b variant-filtered reward menus in loyalty preview"`

---

## Batch B — Backoffice

### Task B1: Shared ProductVariantPicker + wire both pickers + grant summary

**Files:**
- Create: `apps/backoffice/src/screens/customers/ProductVariantPicker.tsx`
- Modify: `apps/backoffice/src/screens/Customers.tsx` (replace the two flat checkbox lists, lines ~646-657 "Produk Pemicu" and the `cf26e9d` "Produk Hadiah" block; no import changes needed in Customers.tsx beyond the new component)
- Modify: `apps/backoffice/src/screens/customers/rewardTypes.ts`

- [ ] **Step 1: Create the picker component**

```tsx
import { useState } from 'react'
import type { Product } from '@mandalika/api'
import { ChevronDown, ChevronRight } from 'lucide-react'

// SP-CRM-9b composite entries: "pid" = whole product (any variant),
// "pid|size" = that variant only. Product and variant selection are mutually
// exclusive per product. Sizes containing '|' are excluded defensively (none exist).
interface ProductVariantPickerProps {
  products: Product[]
  value: string[]
  onChange: (next: string[]) => void
}

export function ProductVariantPicker({ products, value, onChange }: ProductVariantPickerProps) {
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const has = (entry: string) => value.includes(entry)

  const toggleWhole = (pid: string) => {
    if (has(pid)) {
      onChange(value.filter((e) => e !== pid))
    } else {
      // checking the whole product clears its variant entries
      onChange([...value.filter((e) => !e.startsWith(`${pid}|`)), pid])
    }
  }
  const toggleVariant = (pid: string, size: string) => {
    const entry = `${pid}|${size}`
    if (has(entry)) {
      onChange(value.filter((e) => e !== entry))
    } else {
      // checking a variant clears the whole-product entry
      onChange([...value.filter((e) => e !== pid), entry])
    }
  }

  return (
    <div className="max-h-48 overflow-y-auto border border-gray-200 rounded-xl p-2 space-y-1">
      {products.map((p) => {
        const pid = p.id ?? ''
        const variants = (p.variants || []).filter((v) => !v.size.includes('|'))
        const pickedCount = value.filter((e) => e.startsWith(`${pid}|`)).length
        const isOpen = open[pid] ?? false
        return (
          <div key={pid}>
            <div className="flex items-center gap-2 hover:bg-gray-50 rounded-lg px-2 py-1">
              <input
                type="checkbox"
                checked={has(pid)}
                onChange={() => toggleWhole(pid)}
                className="accent-gold-600"
              />
              <button
                type="button"
                onClick={() => setOpen((o) => ({ ...o, [pid]: !isOpen }))}
                className="flex items-center gap-1 flex-1 text-left cursor-pointer"
              >
                {isOpen ? <ChevronDown className="w-3.5 h-3.5 text-gray-400" /> : <ChevronRight className="w-3.5 h-3.5 text-gray-400" />}
                <span className="text-sm text-gray-700">{p.name}</span>
                {has(pid) && <span className="text-[10px] font-bold text-gold-600">semua varian</span>}
                {!has(pid) && pickedCount > 0 && <span className="text-[10px] font-bold text-gold-600">{pickedCount} varian</span>}
              </button>
            </div>
            {isOpen && (
              <div className="ml-7 space-y-0.5">
                {variants.map((v) => (
                  <label key={v.size} className="flex items-center gap-2 cursor-pointer hover:bg-gray-50 rounded-lg px-2 py-0.5">
                    <input
                      type="checkbox"
                      checked={has(pid) || has(`${pid}|${v.size}`)}
                      disabled={has(pid)}
                      onChange={() => toggleVariant(pid, v.size)}
                      className="accent-gold-600"
                    />
                    <span className="text-xs text-gray-600">{v.size}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 2: Wire it into `Customers.tsx`**

Add the import: `import { ProductVariantPicker } from './customers/ProductVariantPicker'`

Replace the "Produk Pemicu" block (the `condForm.trigger === 'product_purchase'` Field with the flat `products.map` checkbox list):

```tsx
          {condForm.trigger === 'product_purchase' && (
            <Field label="Produk Pemicu (produk utuh atau varian tertentu)">
              <ProductVariantPicker
                products={products}
                value={condForm.applicableProductIds || []}
                onChange={(next) => setCondForm((f) => ({ ...f, applicableProductIds: next }))}
              />
            </Field>
          )}
```

Replace the "Produk Hadiah" block (the `condForm.rewardType === 'product_reward'` Field from `cf26e9d`):

```tsx
          {condForm.rewardType === 'product_reward' && (
            <Field label="Produk Hadiah (pilihan item gratis untuk kasir)">
              <ProductVariantPicker
                products={products}
                value={condForm.rewardProductIds || []}
                onChange={(next) => setCondForm((f) => ({ ...f, rewardProductIds: next }))}
              />
            </Field>
          )}
```

(The existing save guards keep working unchanged — composite entries are still non-empty strings in the same arrays.)

- [ ] **Step 3: Update the grant summary for `pid|size` entries**

Replace `apps/backoffice/src/screens/customers/rewardTypes.ts`:

```ts
// SP-CRM-8: render product-reward grants. Product names aren't on the grant (it
// stores product ids); SP-CRM-9b entries may be "pid|size" — show the size.
export function rewardGrantSummary(productIds: string[]): string {
  const n = productIds.length
  if (n === 0) return 'Reward produk'
  const sizes = productIds
    .map((e) => e.split('|')[1])
    .filter((s): s is string => !!s)
  if (sizes.length > 0) return `${n} produk gratis (${sizes.join(', ')})`
  return `${n} produk gratis`
}
```

- [ ] **Step 4: Build**

Run from `apps/backoffice`: `npm run build`
Expected: tsc + vite green (pre-existing chunk-size warning is fine).

- [ ] **Step 5: Commit**

`git add apps/backoffice/src/screens/customers/ProductVariantPicker.tsx apps/backoffice/src/screens/Customers.tsx apps/backoffice/src/screens/customers/rewardTypes.ts` then
`git commit -m "feat(crm): SP-CRM-9b drill-down product/variant picker for loyalty-condition forms"`

---

## Batch C — POS

### Task C1: Collapsible "Hadiah Loyalti" status rows in CheckoutPanel

**Files:**
- Modify: `apps/pos/src/cashier/CheckoutPanel.tsx` (the reward block, currently lines ~171-227; add `useState` import if absent)

Presentation-only: reducer, cart, receipt, submit flow untouched. Props unchanged.

- [ ] **Step 1: Add local expand state**

At the top of the component body (with the other hooks; add `import { useState } from 'react'` if the file doesn't already import it):

```tsx
  // SP-CRM-9b: per-condition expand state; collapsed by default so a generous
  // menu doesn't flood the checkout. Picking auto-collapses.
  const [openRewards, setOpenRewards] = useState<Record<string, boolean>>({})
```

- [ ] **Step 2: Replace the reward rows block**

Replace everything inside `<div className="space-y-3">` … `</div>` of the "Loyalty product rewards" section (the current `rewards.map` from `const picked = …` through the closing `})}`):

```tsx
                {rewards.map((rw) => {
                  const picked = pickedRewards[rw.conditionId]
                  const pickedProduct = picked
                    ? rw.products.find((p) => p.id === picked.productId)
                    : undefined
                  const isOpen = openRewards[rw.conditionId] ?? false
                  return (
                    <div key={rw.conditionId} className="border border-amber-200 bg-amber-50 rounded-xl p-3">
                      <button
                        type="button"
                        onClick={() => setOpenRewards((o) => ({ ...o, [rw.conditionId]: !isOpen }))}
                        className="w-full flex items-center justify-between gap-2"
                      >
                        <span className="text-xs font-semibold text-amber-800 text-left">{rw.conditionName}</span>
                        <span className="flex items-center gap-1.5 shrink-0">
                          {!picked && (
                            <span className="text-[11px] font-bold text-green-600">Tersedia!</span>
                          )}
                          <span className="text-amber-700 text-xs">{isOpen ? '▲' : '▼'}</span>
                        </span>
                      </button>
                      {picked && !isOpen && (
                        <div className="mt-1.5 flex items-center justify-between gap-2">
                          <p className="text-[11px] font-semibold text-green-600">
                            GRATIS: {pickedProduct?.name ?? ''}
                            {picked.variantSize ? ` · ${picked.variantSize}` : ''}
                          </p>
                          <span className="flex gap-2 shrink-0">
                            <button
                              type="button"
                              onClick={() => setOpenRewards((o) => ({ ...o, [rw.conditionId]: true }))}
                              className="text-[11px] text-amber-700 underline"
                            >
                              Ganti
                            </button>
                            <button
                              type="button"
                              onClick={() => onClearReward(rw.conditionId)}
                              className="text-[11px] text-amber-700 underline"
                            >
                              Hapus
                            </button>
                          </span>
                        </div>
                      )}
                      {isOpen && (
                        <>
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {rw.products.flatMap((p) =>
                              p.variants.map((v) => {
                                const isSel = picked?.productId === p.id && picked?.variantSize === v.size
                                return (
                                  <button
                                    key={`${p.id}-${v.size}`}
                                    type="button"
                                    onClick={() => {
                                      onPickReward(rw.conditionId, { id: p.id, name: p.name }, v)
                                      setOpenRewards((o) => ({ ...o, [rw.conditionId]: false }))
                                    }}
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
                            <button
                              type="button"
                              onClick={() => onClearReward(rw.conditionId)}
                              className="mt-1.5 text-[11px] text-amber-700 underline"
                            >
                              Batalkan hadiah
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  )
                })}
```

(The old header row with the conditional "Batalkan" button and the old `GRATIS ✓` footer are fully replaced by the above — make sure neither remains.)

- [ ] **Step 3: Build + tests**

Run from `apps/pos`: `npx tsc -b && npm run build && npx vitest run`
Expected: tsc green, vite build green, all existing vitest pass (reducer untouched).

- [ ] **Step 4: Commit**

`git add apps/pos/src/cashier/CheckoutPanel.tsx` then
`git commit -m "feat(crm): SP-CRM-9b collapsible Hadiah Loyalti rows (Tersedia!/GRATIS status, Ganti/Hapus)"`

---

## Batch D — Gate, deploy, smoke, docs

### Task D1: Full local gate

- [ ] Backend (from `backend/`): `go build ./... && go test ./... && make gen-check` — all green, NO regen diff.
- [ ] POS (from `apps/pos`): `npx tsc -b && npm run build && npx vitest run` — green.
- [ ] Backoffice (from `apps/backoffice`): `npm run build` — green.
- [ ] No commit (nothing should have changed; this is a checkpoint).

### Task D2: Deploy backend + live smoke + push

- [ ] **Step 1: Deploy**

`gcloud run deploy mandalika-pos --source backend --region asia-southeast2 --quiet`
Record the new revision.

- [ ] **Step 2: Live smoke (read-mostly; restore everything)**

Using the admin login (password via `gcloud secrets versions access latest --secret=SEED_ADMIN_PASSWORD`, NEVER printed) against the Cloud Run URL:

1. `GET /api/v1/loyalty-conditions` → capture `#DIJAMINGORGEOUS` (id `89a9b637-2b3e-430d-8a46-4cadde3866ec`) current full body.
2. `PUT` it with `rewardProductIds: ["6560a172-9bff-4144-9de0-02889e7d0d5f|10ml ATOMIZER"]` (GORGEOUS TUBEROSE, one variant), all other fields unchanged.
3. `POST /api/v1/sync/loyalty-preview` with a real customer id + total 1500000 → expect exactly ONE product with exactly ONE variant ("10ml ATOMIZER").
4. `PUT` the condition BACK to its full 3-product whole-product menu (`["6560a172-9bff-4144-9de0-02889e7d0d5f","bf257b12-ea2f-47dd-ad79-3a62c568736f","20e3b16e-4f4b-49fc-a888-34e493f5b57a"]`, end date 2026-12-31) and re-run the preview → expect the full multi-variant menu again (backward compat proof).

- [ ] **Step 3: Push**

`git push origin prod-hardening` (tethered network resets are a known transient — retry loop up to 6 attempts with backoff).

### Task D3: Handoff + memory

- [ ] Update `SESSION_HANDOFF.md`: SP-CRM-9b section (what shipped, revision, smoke results) + USER-PENDING: new APK build (workflow_dispatch) + on-device re-check (collapsed "Tersedia!" rows; variant-level menu).
- [ ] Update the `crm-customers-module` memory + `MEMORY.md` index line.
- [ ] Commit (`docs: ...`) + push.

---

## Self-review notes (already applied)

- Spec §2.4 said grants display "NAME · size" — product names are NOT stored on grants; the plan shows count + sizes instead (spec corrected in the same commit as this plan).
- `make gen-check` stays in the gate even though no OpenAPI change is expected — it proves that.
- Engine needs zero code change (A1 documents why); only callers change.
