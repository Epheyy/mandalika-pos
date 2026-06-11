# SP-CRM-9c — Stock Awareness at the POS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show per-variant stock in the POS reward picker, add a backoffice "allow negative stock" setting (default allow) that warns-with-override at checkout, and optimistically decrement displayed stock after a sale so the product card updates immediately.

**Architecture:** One source of truth — the local sync snapshot's `ProductVariant.stock`. A new `SyncEngine.pendingStockDeltas()` sums unsynced outbox order quantities; `CashierScreen` derives `displayProducts` (snapshot stock − pending) and feeds the grid, reward picker, and a setting-gated checkout warning. Backend just adds one boolean to `app_settings`; the server stays lenient (offline-first can't reject an already-made sale).

**Tech Stack:** Go (pgx, oapi-codegen), React/TS (vitest), `@mandalika/sync` package, `@mandalika/api` types.

**Spec:** `docs/superpowers/specs/2026-06-11-crm-sp9c-stock-awareness-design.md`

**Branch:** `prod-hardening` directly (no worktree).

**Gotchas for every implementer:**
- Windows: NO `-race` (no cgo). `go test ./...` plain.
- Commit protocol: `git add <files>` and `git commit -m "..."` as SEPARATE tool calls.
- Money is float32 (generated TS) / float64 (service) — don't "fix" it.
- `make gen-check` must be green; A1 DOES change OpenAPI so A1 regenerates `api.gen.go` + `packages/api/src/schema.d.ts` and commits them.
- Admin login for smoke: email `admin@mandalika.test`, password via `gcloud secrets versions access latest --secret=SEED_ADMIN_PASSWORD` (command-substitution, NEVER print). Cloud Run URL: `https://mandalika-pos-538849926142.asia-southeast2.run.app`. Login response shape: `.data.access`.
- Tethered network resets pushes ("Connection was reset") — retry loop.

---

## Batch A — Backend: the `allowNegativeStock` setting

### Task A1: Add `allowNegativeStock` to app_settings end-to-end (migration + value layer + OpenAPI)

**Files:**
- Create: `backend/internal/db/migrations/0033_allow_negative_stock.sql`
- Modify: `backend/api/openapi.yaml` (the `AppSettings` schema)
- Modify: `backend/internal/read/repo.go` (`AppSettings` query, ~line 868-883)
- Modify: `backend/internal/write/repo.go` (`UpdateAppSettings`, ~line 638-674)
- Regenerate: `backend/internal/api/api.gen.go` + `packages/api/src/schema.d.ts` (via `make gen`)
- Test: `backend/internal/write/repo_settings_test.go` (create) OR an existing settings test file if one exists — check first.

- [ ] **Step 1: Migration**

Create `backend/internal/db/migrations/0033_allow_negative_stock.sql`:
```sql
-- SP-CRM-9c: per-deployment control over whether the POS may oversell.
-- Default true preserves the existing offline-first behavior (sell + flag for
-- reconciliation); set false to make the POS warn the cashier at checkout.
ALTER TABLE app_settings
  ADD COLUMN IF NOT EXISTS allow_negative_stock boolean NOT NULL DEFAULT true;
```

- [ ] **Step 2: OpenAPI schema**

In `backend/api/openapi.yaml`, find the `AppSettings` schema (it has `autoOpenShift`, `taxEnabled`, etc.). Add a property alongside `autoOpenShift`:
```yaml
        allowNegativeStock:
          type: boolean
```
Add `allowNegativeStock` to that schema's `required:` list if (and only if) `autoOpenShift` is in `required` — match `autoOpenShift`'s required-ness exactly so the generated Go type is a plain `bool`, not a pointer.

- [ ] **Step 3: Read mapping**

In `backend/internal/read/repo.go` `AppSettings(...)`, add to the `json_build_object` (next to `'autoOpenShift',auto_open_shift`):
```go
		   'allowNegativeStock',allow_negative_stock,
```

- [ ] **Step 4: Write mapping**

In `backend/internal/write/repo.go` `UpdateAppSettings`, add the field to the anonymous struct (next to `AutoOpenShift bool`):
```go
		AllowNegativeStock   bool                  `json:"allowNegativeStock"`
```
Then extend the main `UPDATE app_settings SET ...` — add `allow_negative_stock=$12` to the column list (renumber nothing else; it becomes the next param after `receive_approver_roles=$11`), and append `s.AllowNegativeStock` to that Exec's args in the matching position. Read the exact current statement first; the current last column is `receive_approver_roles=$11`, so the new tail is `... receive_approver_roles=$11, allow_negative_stock=$12 WHERE id=1` with `s.AllowNegativeStock` added as the 12th arg.

- [ ] **Step 5: Regenerate + build**

From `backend/`: `make gen` (regenerates `internal/api/api.gen.go` and `packages/api/src/schema.d.ts`). Confirm `AppSettings` in `api.gen.go` now has `AllowNegativeStock bool json:"allowNegativeStock"`. Then `go build ./...`.

- [ ] **Step 6: Round-trip test**

First check whether a settings write test already exists (`grep -ril UpdateAppSettings backend/internal/write`). If a suitable test exists, add a case; otherwise create `backend/internal/write/repo_settings_test.go`. The test must require a DB, so follow the EXACT pattern of the nearest existing DB-backed test in `backend/internal/write` (same setup/teardown helper). The assertion: after `UpdateAppSettings` with `allowNegativeStock:false`, `read.AppSettings` returns `AllowNegativeStock == false`; and a fresh row (migration default) reads `true`. If the write package has NO DB test harness, SKIP the automated test and instead note it — the live smoke in D1 covers the round-trip. Do not invent a harness.

- [ ] **Step 7: Gate + commit**

From `backend/`: `go build ./...`, `go test ./...`, `make gen-check` (must be clean now that generated files are committed). Then commit (separate calls):
`git add backend/internal/db/migrations/0033_allow_negative_stock.sql backend/api/openapi.yaml backend/internal/read/repo.go backend/internal/write/repo.go backend/internal/api/api.gen.go packages/api/src/schema.d.ts` (+ the test file if created)
`git commit -m "feat(crm): SP-CRM-9c add allowNegativeStock app setting (migration 0033, default true)"`

---

## Batch B — Backoffice: the toggle

### Task B1: "Izinkan stok minus" toggle in SettingsScreen

**Files:**
- Modify: `apps/backoffice/src/screens/SettingsScreen.tsx` (DEFAULT object ~line 10-38; add a Toggle row near the `autoOpenShift` toggle ~line 302)

- [ ] **Step 1: Default**

In `SettingsScreen.tsx`, the `DEFAULT: AppSettings` object (~line 10) — add (next to `autoOpenShift: false,`):
```tsx
  allowNegativeStock: true,
```
(If TS errors that the field is missing/extra, it means the regenerated `@mandalika/api` types from A1 aren't built — run `npm run build` in `packages/api` first, or `npm run build` at root, then retry.)

- [ ] **Step 2: Toggle row**

Find the `autoOpenShift` Toggle row (~line 302: `<Toggle checked={s.autoOpenShift} onClick={() => setS((p) => ({ ...p, autoOpenShift: !p.autoOpenShift }))} />`). Add a sibling settings row (match the surrounding label/description markup of the autoOpenShift row — copy its wrapper structure, just change the text and field):
```tsx
              <Toggle checked={s.allowNegativeStock} onClick={() => setS((p) => ({ ...p, allowNegativeStock: !p.allowNegativeStock }))} />
```
with label "Izinkan Stok Minus" and a short description like "Jika nonaktif, kasir diberi peringatan saat menjual melebihi stok (masih bisa dilanjutkan)." Wrap it in the same row container the autoOpenShift toggle uses.

- [ ] **Step 3: Build + commit**

From `apps/backoffice`: `npm run build` (tsc + vite green; pre-existing chunk-size warning OK). Commit (separate calls):
`git add apps/backoffice/src/screens/SettingsScreen.tsx`
`git commit -m "feat(crm): SP-CRM-9c backoffice toggle for allow-negative-stock"`

---

## Batch C — POS: pending deltas, stock display, checkout warning

### Task C1: `SyncEngine.pendingStockDeltas()`

**Files:**
- Modify: `packages/sync/src/engine.ts` (add method near `pendingCount()` ~line 213)
- Test: `packages/sync/src/engine.test.ts` if it exists, else the nearest existing test file in `packages/sync/src` (check; create `engine.stockdeltas.test.ts` only if there is already a test setup to copy).

Context: `this.outbox.pending()` returns the unsynced outbox items (see `engine.ts:273`). Each item has `.type` (a string) and `.payload`. Order entries carry the order body with an `items` array of `{ productId, variantSize, quantity, isReward }`. You MUST first read `packages/sync/src/engine.ts` (the `enqueue` call sites) and `packages/sync/src/outbox.ts` to confirm (a) the exact `type` string used for order creation and (b) the payload item field names. Do not guess — confirm from source.

- [ ] **Step 1: Write the failing test**

Mirror the nearest existing engine test's setup (in-memory KV). The behavior to pin (adapt construction to the real test harness):
```ts
// pendingStockDeltas sums quantities per `${productId}|${size}` across pending
// order outbox entries (paid AND reward lines), and is empty when the outbox is empty.
it('sums pending order quantities per product|size', () => {
  // enqueue two orders touching the same variant + a reward line, via the
  // SAME enqueue API CashierScreen uses (confirm the order type string first)
  // then:
  const d = engine.pendingStockDeltas()
  expect(d['p1|10ml']).toBe(3) // 2 paid + 1 reward
  expect(d['p2|S']).toBe(1)
})
it('is empty with no pending orders', () => {
  expect(Object.keys(engine.pendingStockDeltas())).toHaveLength(0)
})
```

- [ ] **Step 2: Run → fail** (`pendingStockDeltas` undefined). From `packages/sync`: `npx vitest run` (or the repo's test command for this package — check package.json `scripts.test`).

- [ ] **Step 3: Implement** in `engine.ts` near `pendingCount()`:
```ts
  /** SP-CRM-9c: sum unsynced order quantities per `${productId}|${size}` so the
   *  POS can optimistically decrement displayed stock. Includes reward lines
   *  (they decrement stock server-side too). Keyed identically to the backend
   *  variantKey format. */
  pendingStockDeltas(): Record<string, number> {
    const deltas: Record<string, number> = {}
    for (const item of this.outbox.pending()) {
      if (item.type !== ORDER_TYPE) continue // ORDER_TYPE = the confirmed order-create type string
      const payload = item.payload as { items?: Array<{ productId?: string; variantSize?: string; quantity?: number }> }
      for (const line of payload.items ?? []) {
        if (!line.productId) continue
        const key = `${line.productId}|${line.variantSize ?? ''}`
        deltas[key] = (deltas[key] ?? 0) + (line.quantity ?? 0)
      }
    }
    return deltas
  }
```
Replace `ORDER_TYPE` with the literal confirmed in source (e.g. `'order'`). If `OutboxType` is an exported union, compare against the correct member.

- [ ] **Step 4: Run → pass.** Then build the package if it has a build step (`npm run build` in `packages/sync`) so consumers see the new method.

- [ ] **Step 5: Commit** (separate calls):
`git add packages/sync/src/engine.ts` (+ test file)
`git commit -m "feat(sync): SP-CRM-9c pendingStockDeltas() — sum unsynced order quantities per variant"`

### Task C2: `displayProducts` derivation + reward-picker stock

**Files:**
- Modify: `apps/pos/src/cashier/CashierScreen.tsx` (products derivation ~line 192; reward props passed to CheckoutPanel ~line 825-835)
- Modify: `apps/pos/src/cashier/CheckoutPanel.tsx` (reward variant buttons — add stock)
- Test: `apps/pos/src/cashier/*.test.ts` — add a small pure-function test for the delta-applying helper (extract it so it's testable).

- [ ] **Step 1: Extract + test a pure helper**

Create `apps/pos/src/cashier/stock.ts`:
```ts
import type { Product } from '@mandalika/api'

/** SP-CRM-9c: return products with each variant's stock reduced by the pending
 *  (unsynced) sale quantity for that `${productId}|${size}`. Display may go
 *  negative so the cashier sees oversell. */
export function applyPendingStock(
  products: Product[],
  deltas: Record<string, number>,
): Product[] {
  return products.map((p) => ({
    ...p,
    variants: p.variants.map((v) => {
      const key = `${p.id ?? ''}|${v.size}`
      const d = deltas[key] ?? 0
      return d ? { ...v, stock: v.stock - d } : v
    }),
  }))
}

/** Stock for one product+size from a (already pending-adjusted) product list. */
export function stockFor(products: Product[], productId: string, size: string): number | null {
  const p = products.find((x) => x.id === productId)
  if (!p) return null
  const v = p.variants.find((x) => x.size === size)
  return v ? v.stock : null
}
```
Create `apps/pos/src/cashier/stock.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { applyPendingStock, stockFor } from './stock'

const products = [
  { id: 'p1', name: 'A', variants: [{ size: '10ml', price: 1, stock: 5, sku: '' }, { size: '2ml', price: 1, stock: 0, sku: '' }], isActive: true, brand: '', categoryId: '', createdAt: '' },
] as any

describe('applyPendingStock', () => {
  it('subtracts pending deltas, leaving untouched variants as-is', () => {
    const out = applyPendingStock(products, { 'p1|10ml': 2 })
    expect(out[0].variants[0].stock).toBe(3)
    expect(out[0].variants[1].stock).toBe(0)
  })
  it('allows display to go negative', () => {
    const out = applyPendingStock(products, { 'p1|2ml': 3 })
    expect(out[0].variants[1].stock).toBe(-3)
  })
})
describe('stockFor', () => {
  it('reads a variant stock', () => {
    expect(stockFor(products, 'p1', '10ml')).toBe(5)
  })
  it('returns null for an unknown product/size', () => {
    expect(stockFor(products, 'pX', '10ml')).toBeNull()
    expect(stockFor(products, 'p1', '99ml')).toBeNull()
  })
})
```

- [ ] **Step 2: Run → pass.** From `apps/pos`: `npx vitest run stock`.

- [ ] **Step 3: Wire `displayProducts` in CashierScreen**

`CashierScreen.tsx` ~line 192 currently: `const products = (snapshot.products ?? []).filter((p) => p.isActive)`. Keep that as `const products`, and add below it:
```tsx
  const pendingStockDeltas = engine.pendingStockDeltas()
  const displayProducts = useMemo(
    () => applyPendingStock(products, pendingStockDeltas),
    [products, pendingStockDeltas],
  )
```
Add the import: `import { applyPendingStock, stockFor } from './stock'`. Then change the consumers that show stock to use `displayProducts`: the `<ProductGrid products={...}>` prop (find where `products={products}` is passed, ~line 777) → pass `displayProducts`. Leave `scanIndex`/cart-math reads on the raw `products` (scan matching is by id, stock there is checked separately) UNLESS the scan guard at ~line 296 reads stock — if it does, point that read at `displayProducts` too so the existing "Stok habis" guard is pending-aware. (Read line 296's `variant.stock` source; if `variant` comes from the scan match against `products`, switch the match to `displayProducts`.)

- [ ] **Step 4: Reward-picker stock — pass available stock into CheckoutPanel**

Where CheckoutPanel is rendered (~line 825), it already gets `rewards`. Add a prop carrying the stock lookup so the panel can annotate each reward variant. Simplest: pass `displayProducts` as a new prop `stockProducts={displayProducts}` and in CheckoutPanel compute stock per button via `stockFor`. In `CheckoutPanel.tsx`:
- Add to the props interface: `stockProducts: import('@mandalika/api').Product[]` (or import `Product` and use it).
- Add `stockProducts` to the destructure.
- Import `stockFor` from `'../cashier/stock'`? No — CheckoutPanel is already in `apps/pos/src/cashier/`, so `import { stockFor } from './stock'`.
- In the reward variant button label (currently `{p.name}{v.size ? \` · ${v.size}\` : ''}`), append stock:
```tsx
                                    {p.name}
                                    {v.size ? ` · ${v.size}` : ''}
                                    {(() => {
                                      const st = stockFor(stockProducts, p.id, v.size)
                                      return st === null ? null : (
                                        <span className={st > 0 ? 'ml-1 text-amber-600' : 'ml-1 text-red-500 font-bold'}>· Stok {st}</span>
                                      )
                                    })()}
```
(Keep it inside the existing button; the button is not a `<button>` containing a `<span>` problem — spans are fine inside buttons.)

- [ ] **Step 5: Build + test + commit**

From `apps/pos`: `npx tsc -b && npm run build && npx vitest run`. Green. Commit (separate calls):
`git add apps/pos/src/cashier/stock.ts apps/pos/src/cashier/stock.test.ts apps/pos/src/cashier/CashierScreen.tsx apps/pos/src/cashier/CheckoutPanel.tsx`
`git commit -m "feat(crm): SP-CRM-9c optimistic stock display in product grid + reward picker"`

### Task C3: Checkout negative-stock warning (setting-gated, warn + override)

**Files:**
- Modify: `apps/pos/src/cashier/CheckoutPanel.tsx` (compute + render a warning; confirm button STAYS enabled)
- Modify: `apps/pos/src/cashier/CashierScreen.tsx` (pass `allowNegativeStock` from snapshot settings into CheckoutPanel)
- Test: `apps/pos/src/cashier/stock.test.ts` (extend with the warning predicate)

- [ ] **Step 1: Pure predicate + test**

Add to `apps/pos/src/cashier/stock.ts`:
```ts
export interface CartLineLike { productId: string; variantSize: string; quantity: number }

/** SP-CRM-9c: lines whose quantity exceeds the (pending-adjusted) available
 *  stock. Used only to WARN — never to block. Empty when allowNegative is true. */
export function overstockLines(
  cart: CartLineLike[],
  stockProducts: Product[],
  allowNegative: boolean,
): CartLineLike[] {
  if (allowNegative) return []
  return cart.filter((line) => {
    const st = stockFor(stockProducts, line.productId, line.variantSize)
    return st !== null && line.quantity > st
  })
}
```
Extend `stock.test.ts`:
```ts
import { overstockLines } from './stock'

describe('overstockLines', () => {
  const sp = [{ id: 'p1', name: 'A', variants: [{ size: '10ml', price: 1, stock: 1, sku: '' }], isActive: true, brand: '', categoryId: '', createdAt: '' }] as any
  it('returns nothing when negative is allowed', () => {
    expect(overstockLines([{ productId: 'p1', variantSize: '10ml', quantity: 5 }], sp, true)).toHaveLength(0)
  })
  it('flags lines over available stock when not allowed', () => {
    expect(overstockLines([{ productId: 'p1', variantSize: '10ml', quantity: 5 }], sp, false)).toHaveLength(1)
  })
  it('does not flag a line within stock', () => {
    expect(overstockLines([{ productId: 'p1', variantSize: '10ml', quantity: 1 }], sp, false)).toHaveLength(0)
  })
  it('ignores unknown products (no stock row)', () => {
    expect(overstockLines([{ productId: 'pX', variantSize: 'S', quantity: 9 }], sp, false)).toHaveLength(0)
  })
})
```
Run → pass: `npx vitest run stock`.

Note: because `stockProducts` is already pending-adjusted (C2), and the reward line lives in `state.cart` as a Rp0 line, the reward line IS included — closing the oversell hole. The current line's own quantity is part of cart, and stock here is snapshot−pending(of OTHER unsynced orders), so this correctly reflects "will this sale push below zero".

- [ ] **Step 2: Pass the setting + cart into CheckoutPanel**

In `CashierScreen.tsx`, `loyalty`/`settings` come from snapshot (~line 212-213: `const settings = snapshot.appSettings ?? DEFAULT_SETTINGS`). Pass to CheckoutPanel (~line 825): add props `allowNegativeStock={settings.allowNegativeStock ?? true}` and `cartLines={state.cart}` (if the panel doesn't already receive the cart — check; it may already have what it needs via `pickedRewards`/totals, but for the warning it needs the raw lines). Use `?? true` so a pre-9c snapshot defaults to today's behavior.

- [ ] **Step 3: Render the warning in CheckoutPanel**

Add props: `allowNegativeStock: boolean`, `cartLines: CartLineLike[]` (import the type from `./stock`). Near the top of the rendered checkout body (above the confirm button), add:
```tsx
              {(() => {
                const over = overstockLines(cartLines, stockProducts, allowNegativeStock)
                if (over.length === 0) return null
                return (
                  <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-[11px] text-amber-800">
                    <p className="font-bold">⚠️ Stok tidak mencukupi</p>
                    <p className="mt-0.5">Penjualan ini akan membuat stok minus. Anda masih bisa melanjutkan.</p>
                  </div>
                )
              })()}
```
Import `overstockLines` (and `CartLineLike`) from `./stock`. The confirm/submit button MUST remain enabled regardless (warn + override) — do NOT add a `disabled` based on `over`.

- [ ] **Step 4: Build + test + commit**

From `apps/pos`: `npx tsc -b && npm run build && npx vitest run`. Green. Commit (separate calls):
`git add apps/pos/src/cashier/stock.ts apps/pos/src/cashier/stock.test.ts apps/pos/src/cashier/CheckoutPanel.tsx apps/pos/src/cashier/CashierScreen.tsx`
`git commit -m "feat(crm): SP-CRM-9c checkout negative-stock warning (setting-gated, warn + override)"`

---

## Batch D — Gate, deploy, smoke, docs

### Task D1: Full gate, deploy, live smoke, docs

- [ ] **Step 1: Local gate**
  - Backend (`backend/`): `go build ./... && go test ./... && make gen-check` — green, no drift.
  - sync pkg (`packages/sync`): its test command — green.
  - POS (`apps/pos`): `npx tsc -b && npm run build && npx vitest run` — green.
  - Backoffice (`apps/backoffice`): `npm run build` — green.

- [ ] **Step 2: Deploy**

`gcloud run deploy mandalika-pos --source backend --region asia-southeast2 --quiet` — record the new revision. (Migration 0033 runs on boot via fsmigrate.)

- [ ] **Step 3: Live smoke (settings round-trip; restore)**

Login admin (password via the secret, never printed). Then:
1. `GET /api/v1/settings/app` → confirm `allowNegativeStock: true` (migration default on the existing row).
2. `PUT /api/v1/settings/app` with the full current body but `allowNegativeStock:false` → 200.
3. `GET` again → `allowNegativeStock:false`.
4. `PUT` back to `allowNegativeStock:true` (restore). `GET` → true.
(The POS warning + optimistic decrement are on-device — verified after the new APK, USER-PENDING.)

- [ ] **Step 4: Push**

`git push origin prod-hardening` (retry loop on reset).

- [ ] **Step 5: Docs**
  - `SESSION_HANDOFF.md`: new SP-CRM-9c LATEST SESSION section (what shipped, rev, smoke) + USER-PENDING: new APK (covers 9b + 9c POS) + on-device check (reward picker shows stock; toggle off → checkout warns but allows; product card decrements immediately after a sale).
  - `crm-customers-module` memory + `MEMORY.md` index.
  - Commit (`docs: ...`) + push.

---

## Self-review notes (applied)

- **Spec said "no migration if jsonb" — corrected:** `app_settings` is columnar (confirmed in read/write repo), so A1 adds migration 0033 + regenerates OpenAPI. The generated `api.gen.go`/`schema.d.ts` are committed so `gen-check` stays green.
- **Existing add-time guard left alone:** `CashierScreen.tsx:296` already blocks scan-add past stock unconditionally; the new enforcement is the setting-gated CHECKOUT warning covering ALL lines incl. rewards (the reward path had no guard — that's the hole). C2 optionally points line 296's read at `displayProducts` so it's pending-aware, but does not change its block behavior (out of scope to relax it).
- **Engine type string is a discovery step (C1):** the order outbox `type` string + payload item field names must be confirmed from `packages/sync/src/{engine,outbox}.ts` before implementing — flagged explicitly, not guessed.
- **Default-true everywhere:** migration default true; POS reads `settings.allowNegativeStock ?? true`; backoffice DEFAULT true — a pre-9c snapshot/row never accidentally flips to strict.
- **Reward lines covered:** they live in `state.cart` as Rp0 lines, so `overstockLines(cartLines,...)` includes them and `pendingStockDeltas` sums them — closing the −2 hole.
