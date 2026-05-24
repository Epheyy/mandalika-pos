# Per-Variant Scan Key + Scan-to-Cart — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **The 6 rules (user-required):** ask don't assume · don't touch unrelated · flag uncertainty · verify on failure · show changes · admit gaps.

**Goal:** Replace the parent-product `products.upc` with a per-variant `product_variants.barcode` scan key (defaults to SKU, catalog-wide unique) and add POS scan-to-cart via keyboard-wedge (Enter in search) and device camera (ML Kit), adding 1 of the matched variant and respecting stock.

**Architecture:** Migration adds + backfills + dedupes `barcode` then a partial unique index; backend read/write swap `upc`→per-variant `barcode` (empty defaults to SKU server-side; unique-violation → friendly error). Backoffice modal gets a per-variant Barcode field (blank ⇒ SKU at save) and a CSV `Barcode` column. POS builds a `Map<barcode,{product,variant}>` from the offline snapshot; a pure `resolveScan` resolves a code, and `handleScan` adds 1 respecting stock with toast feedback. Wedge path ships first (zero new deps); camera path is gated on Capacitor-8 plugin compatibility.

**Tech Stack:** Go (pgx v5) backend, Postgres, oapi-codegen + openapi-typescript, React 19 / Vite (backoffice + POS), Capacitor 8 (`@capacitor-mlkit/barcode-scanning` for camera).

**Testing reality (verified, honest):** this repo has **no JS test runner** (no vitest) and **no DB-backed Go test harness** — pure logic is unit-tested (`internal/service/pricing_test.go`), while DB/IO and migrations are verified live (build → deploy → `/readyz` → on-device). This plan follows that established pattern and keeps the POS scan logic in a **pure, isolated function** so it stays testable. If you want real unit tests, adding vitest is a separate, opt-in change (do not assume it).

**Safety note (expand/contract):** `products.upc` is **NOT dropped** in this migration. The live system does a rolling deploy; the still-running old revision selects `p.upc`, so dropping it mid-rollover would break product reads. Column is left in place (dead) and dropped later once no revision references it.

---

## Task 1: Migration 0014 — per-variant barcode

**Files:**
- Create: `backend/internal/db/migrations/0014_variant_barcode.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 0014: per-variant scan key (barcode), replacing the parent products.upc.
-- Defaults to the SKU; catalog-wide unique on non-empty values.
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS barcode text NOT NULL DEFAULT '';

-- existing variants scan immediately: default the scan key to the SKU
UPDATE product_variants SET barcode = sku WHERE barcode = '';

-- prefer any real parent UPC: copy it onto the product's first variant
UPDATE product_variants v SET barcode = p.upc
  FROM products p
 WHERE v.product_id = p.id AND p.upc <> ''
   AND v.id = (SELECT id FROM product_variants v2 WHERE v2.product_id = p.id ORDER BY id LIMIT 1);

-- defensively dedupe before the unique index so the migration cannot fail-to-boot
-- (auto-generated SKUs are uuid-derived and effectively unique; this only fires
--  on a genuine cross-product collision)
WITH d AS (
  SELECT id, row_number() OVER (PARTITION BY barcode ORDER BY id) AS rn
    FROM product_variants WHERE barcode <> ''
)
UPDATE product_variants v
   SET barcode = v.barcode || '-' || left(replace(v.id::text, '-', ''), 4)
  FROM d WHERE d.id = v.id AND d.rn > 1;

-- catalog-wide unique on non-empty scan keys (empty never collides)
CREATE UNIQUE INDEX IF NOT EXISTS idx_variant_barcode
  ON product_variants (barcode) WHERE barcode <> '';

-- NOTE: products.upc is intentionally NOT dropped here (expand/contract — the
-- old revision still reads it during the rolling deploy). Drop in a later
-- migration once no running revision references it.
```

- [ ] **Step 2: Commit**

```bash
git add backend/internal/db/migrations/0014_variant_barcode.sql
git commit -m "feat(backend): migration 0014 — per-variant barcode scan key"
```

---

## Task 2: OpenAPI + codegen

**Files:**
- Modify: `backend/api/openapi.yaml` (`ProductVariant`, `Product`, `ProductInput`)
- Regenerate: `backend/internal/api/api.gen.go`, `packages/api/src/schema.d.ts`

- [ ] **Step 1: Add `barcode` to `ProductVariant`**

In `ProductVariant.properties`, after the `sku` line add:

```yaml
        barcode: { type: string }
```

(Leave `required: [size, price, stock, sku]` unchanged — server defaults barcode to SKU.)

- [ ] **Step 2: Remove `upc` from `Product`**

In the `Product` schema, delete the `upc:` property line (e.g. `upc: { type: string }`).

- [ ] **Step 3: Remove `upc` from `ProductInput`**

In `ProductInput.properties`, delete the line:

```yaml
        upc: { type: string, nullable: true }
```

- [ ] **Step 4: Regenerate Go + TS**

Run:
```bash
cd backend && make gen-go && cd ..
corepack pnpm --filter @mandalika/api gen
```
Expected: `backend/internal/api/api.gen.go` and `packages/api/src/schema.d.ts` update — `Product`/`ProductInput` lose `upc`, `ProductVariant` gains `barcode`.

- [ ] **Step 5: Verify no drift**

Run: `cd backend && make gen-check && cd ..`
Expected: no "DRIFT" output, exit 0.

- [ ] **Step 6: Commit**

```bash
git add backend/api/openapi.yaml backend/internal/api/api.gen.go packages/api/src/schema.d.ts
git commit -m "feat(api): variant barcode; drop product upc"
```

---

## Task 3: Backend write — persist barcode, drop UPC, enforce uniqueness

**Files:**
- Modify: `backend/internal/write/repo.go`

- [ ] **Step 1: Add `Barcode` to the `Variant` struct**

Replace the `Variant` struct (currently lines ~85-91) with:

```go
type Variant struct {
	ID      string  `json:"id"` // permanent id; empty = new (modal sends it; CSV omits it)
	Size    string  `json:"size"`
	Price   float64 `json:"price"`
	Stock   int     `json:"stock"`
	SKU     string  `json:"sku"`
	Barcode string  `json:"barcode"` // scan key; empty ⇒ defaults to SKU
}
```

- [ ] **Step 2: Add the barcode-default + within-product dup check**

Add this helper right after the `Variant` struct:

```go
// variantBarcode resolves the scan key: explicit barcode, else the SKU.
func variantBarcode(v Variant) string {
	if v.Barcode != "" {
		return v.Barcode
	}
	return v.SKU
}
```

Then in `validateVariants`, extend the loop to also reject duplicate effective barcodes within the product. Replace the whole function with:

```go
// validateVariants enforces SKU (required + unique per product) and rejects
// duplicate effective scan keys (barcode ⇒ SKU) within the product.
func validateVariants(vs []Variant) error {
	seen := map[string]bool{}
	seenBC := map[string]bool{}
	for _, v := range vs {
		if v.SKU == "" {
			return fmt.Errorf("setiap varian wajib punya SKU")
		}
		if seen[v.SKU] {
			return fmt.Errorf("SKU duplikat dalam produk: %s", v.SKU)
		}
		seen[v.SKU] = true
		bc := variantBarcode(v)
		if seenBC[bc] {
			return fmt.Errorf("barcode duplikat dalam produk: %s", bc)
		}
		seenBC[bc] = true
	}
	return nil
}
```

- [ ] **Step 3: Remove `UPC` from the `Product` struct**

In the `Product` struct delete the line `UPC         string    `json:"upc"`` (currently line ~115).

- [ ] **Step 4: Drop `upc` from the INSERT in `CreateProduct`**

In `CreateProduct`, change the INSERT so it no longer writes `upc`. Replace the `t.QueryRow(...)` insert block with:

```go
		if e := t.QueryRow(ctx, `
			INSERT INTO products (name, brand, category_id, description, image_url,
			  images, sellable, is_featured, is_favourite, is_active)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
			p.Name, p.Brand, nullUUID(p.CategoryID), nullStr(p.Description),
			nullStr(main), imgs, p.Sellable, p.IsFeatured, p.IsFavourite, p.IsActive).
			Scan(&id); e != nil {
			return e
		}
```

- [ ] **Step 5: Translate the barcode unique-violation in `CreateProduct`**

Change the final return of `CreateProduct` from `return id, err` to:

```go
	return id, barcodeConflict(err)
```

- [ ] **Step 6: Drop `upc` from the UPDATE in `UpdateProduct`**

In `UpdateProduct`, replace the `products` UPDATE block with (note: no `upc`, renumbered params):

```go
		ct, e := t.Exec(ctx, `
			UPDATE products SET name=$1, brand=$2, category_id=$3, description=$4,
			  image_url=$5, images=$6, sellable=$7,
			  is_featured=$8, is_favourite=$9, is_active=$10
			WHERE id=$11`,
			p.Name, p.Brand, nullUUID(p.CategoryID), nullStr(p.Description),
			nullStr(main), imgs, p.Sellable, p.IsFeatured, p.IsFavourite, p.IsActive, id)
```

- [ ] **Step 7: Write `barcode` on variant INSERT/UPDATE**

In `UpdateProduct`, the in-place variant update (currently `UPDATE product_variants SET size=$1, price=$2, stock=$3, sku=$4 WHERE id=$5`) becomes:

```go
				if _, e := t.Exec(ctx,
					`UPDATE product_variants SET size=$1, price=$2, stock=$3, sku=$4, barcode=$5 WHERE id=$6`,
					v.Size, v.Price, v.Stock, v.SKU, variantBarcode(v), vid); e != nil {
					return e
				}
```

And the new-variant INSERT inside `UpdateProduct` (currently `INSERT INTO product_variants (product_id, size, price, stock, sku) VALUES ($1,$2,$3,$4,$5)`) becomes:

```go
			if _, e := t.Exec(ctx,
				`INSERT INTO product_variants (product_id, size, price, stock, sku, barcode) VALUES ($1,$2,$3,$4,$5,$6)`,
				id, v.Size, v.Price, v.Stock, v.SKU, variantBarcode(v)); e != nil {
				return e
			}
```

Change the final return of `UpdateProduct` to wrap the tx error:

```go
	return barcodeConflict(r.tx(ctx, "products", func(t pgx.Tx) error {
		// ... existing body unchanged ...
	}))
```

- [ ] **Step 8: Write `barcode` in `insertVariants`**

Replace `insertVariants` body INSERT with:

```go
func insertVariants(ctx context.Context, t pgx.Tx, productID string, vs []Variant) error {
	for _, v := range vs {
		if _, e := t.Exec(ctx, `
			INSERT INTO product_variants (product_id, size, price, stock, sku, barcode)
			VALUES ($1,$2,$3,$4,$5,$6)`,
			productID, v.Size, v.Price, v.Stock, v.SKU, variantBarcode(v)); e != nil {
			return e
		}
	}
	return nil
}
```

- [ ] **Step 9: Add the `barcodeConflict` helper + imports**

Add to the imports block: `"strings"` and `"github.com/jackc/pgx/v5/pgconn"`. Then add near the other helpers (e.g. above `nullStr`):

```go
// barcodeConflict maps the catalog-wide barcode unique-violation to a friendly,
// non-leaky message naming the offending code (best-effort parse of pg Detail).
func barcodeConflict(err error) error {
	var pg *pgconn.PgError
	if errors.As(err, &pg) && pg.Code == "23505" && pg.ConstraintName == "idx_variant_barcode" {
		code := ""
		if i := strings.Index(pg.Detail, "=("); i >= 0 {
			if j := strings.Index(pg.Detail[i+2:], ")"); j >= 0 {
				code = pg.Detail[i+2 : i+2+j]
			}
		}
		if code != "" {
			return fmt.Errorf("barcode sudah dipakai varian lain: %s", code)
		}
		return fmt.Errorf("barcode sudah dipakai varian lain")
	}
	return err
}
```

- [ ] **Step 10: Format + vet + build**

Run:
```bash
cd backend && gofmt -w internal/write/repo.go && go vet ./... && go build ./... && cd ..
```
Expected: no output, exit 0.

- [ ] **Step 11: Commit**

```bash
git add backend/internal/write/repo.go
git commit -m "feat(backend): persist per-variant barcode; drop product upc; unique-violation message"
```

---

## Task 4: Backend read — emit barcode, drop upc

**Files:**
- Modify: `backend/internal/read/repo.go` (`productObjScoped`, both branches)

- [ ] **Step 1: Cross-all branch**

In `productObjScoped`, the cross-all branch currently has `'images',p.images,'upc',p.upc,'sellable',p.sellable,`. Change to drop `upc`:

```go
	  'images',p.images,'sellable',p.sellable,
```

And in its variant object (currently `'id',v.id,'size',v.size,'price',v.price,` … ending `'sku',v.sku)`), add barcode after sku:

```go
		     'sku',v.sku,'barcode',v.barcode) ORDER BY v.size)
```

- [ ] **Step 2: Scoped branch**

In the scoped branch, change `'images',p.images,'upc',p.upc,'sellable',p.sellable,` to:

```go
	  'images',p.images,'sellable',p.sellable,
```

And in its variant object ending `'sku',v.sku) ORDER BY v.size)`, add barcode:

```go
	     'sku',v.sku,'barcode',v.barcode) ORDER BY v.size)
```

- [ ] **Step 3: Format + vet + build**

Run:
```bash
cd backend && gofmt -w internal/read/repo.go && go vet ./... && go build ./... && go test ./... && cd ..
```
Expected: build ok; `go test ./...` passes (config/fsmigrate/pricing).

- [ ] **Step 4: Commit**

```bash
git add backend/internal/read/repo.go
git commit -m "feat(backend): emit per-variant barcode in product reads; drop upc"
```

---

## Task 5: Deploy backend + verify live

**Files:** none (ops). The user has confirmed the agent can deploy (SESSION_HANDOFF.md).

- [ ] **Step 1: Deploy (migrations auto-apply on boot)**

Run (background, ~4-6 min):
```bash
gcloud run deploy mandalika-pos --source backend --region asia-southeast2 --quiet
```

- [ ] **Step 2: Readiness**

Run: `curl -s https://mandalika-pos-538849926142.asia-southeast2.run.app/readyz`
Expected: ready/200 (not `/healthz` — that's edge-swallowed).

- [ ] **Step 3: Verify round-trip (admin token)**

Confirm a product read returns `variants[].barcode` (non-empty, = SKU for existing data) and no top-level `upc`. Use the backoffice list call or an authed `GET /api/v1/products`.
Expected: each variant has `barcode`; backfill set it to the SKU (or migrated parent UPC on the first variant).

- [ ] **Step 4: Verify uniqueness rejection**

Via backoffice (after Task 7) or an authed write: save a product whose variant barcode duplicates another product's barcode.
Expected: 400 with body message `barcode sudah dipakai varian lain: <code>` (no DB internals leaked).

- [ ] **Step 5: Verify POS sync carries barcode**

Trigger a cashier sync pull (or inspect the scoped read).
Expected: variant objects in the sync bundle include `barcode`; `sellable=false` products remain excluded.

> Rule note: a write then an *immediate* pull can read stale (pooled-connection visibility lag) — self-corrects next pull; not a real issue (documented in the prior plan).

---

## Task 6: Backoffice — per-variant Barcode field + CSV

**Files:**
- Modify: `apps/backoffice/src/screens/Products.tsx`

- [ ] **Step 1: EMPTY_VARIANT + Form type lose upc, gain barcode default**

Line 30 — replace:
```ts
const EMPTY_VARIANT: ProductVariant = { size: '', price: 0, stock: 0, sku: '', barcode: '' }
```

Lines 32-36 — replace the `Form` type (drop `upc`):
```ts
type Form = {
  name: string; brand: string; categoryId: string; description: string
  images: string[]; sellable: boolean
  isActive: boolean; isFeatured: boolean; variants: ProductVariant[]
}
```

Lines 37-41 — replace `EMPTY` (drop `upc`):
```ts
const EMPTY: Form = {
  name: '', brand: 'Mandalika', categoryId: '', description: '', images: [],
  sellable: true, isActive: true, isFeatured: false,
  variants: [{ ...EMPTY_VARIANT }],
}
```

- [ ] **Step 2: openEdit drops upc (two places)**

In `openEdit`, the initial `setForm({...})` (lines 95-101) — remove `upc: p.upc ?? '',` from the line `upc: p.upc ?? '', sellable: p.sellable ?? true,` leaving `sellable: p.sellable ?? true,`.

In the post-fetch `setForm((f) => ({...}))` (lines 117-123) — remove the `upc: base.upc ?? f.upc,` line.

- [ ] **Step 3: save() — drop upc, default barcode to SKU**

In `save()` body (lines 217-232), remove `upc: form.upc.trim(),` and add barcode to the variant map:

```ts
      const body: ProductInput = {
        name: form.name.trim(),
        brand: form.brand.trim(),
        categoryId: form.categoryId,
        description: form.description,
        imageUrl: form.images[0] ?? '',
        images: form.images,
        sellable: form.sellable,
        isActive: form.isActive,
        isFeatured: form.isFeatured,
        variants: form.variants.map((v) => ({
          id: v.id, size: v.size.trim(), price: Number(v.price),
          stock: Number(v.stock), sku: v.sku.trim(),
          barcode: (v.barcode ?? '').trim() || v.sku.trim(),
        })),
      }
```

- [ ] **Step 4: CSV export — per-variant Barcode column**

In `exportProducts` (lines 273-282), replace `Stok: v.stock, SKU: v.sku, UPC: p.upc || '',` with:

```ts
        Stok: v.stock, SKU: v.sku, Barcode: v.barcode || v.sku,
```

- [ ] **Step 5: CSV import — per-variant Barcode, drop upc**

In `importProducts`, the variant push (lines 306-309) becomes:

```ts
      grouped[key].variants.push({
        size: row['Ukuran'] || '', price: parseFloat(row['Harga']) || 0,
        stock: parseInt(row['Stok']) || 0, sku: row['SKU'].trim(),
        barcode: (row['Barcode'] || '').trim() || row['SKU'].trim(),
      })
```

And in the import `body` (lines 321-333), remove the `upc: row['UPC'] || existing?.upc || '',` line.

- [ ] **Step 6: Remove the parent UPC input (modal)**

Replace the category+UPC grid (lines 615-621) with the category Select alone:

```tsx
          <Select label="Kategori *" value={form.categoryId} onChange={(e) => setForm((f) => ({ ...f, categoryId: e.target.value }))}>
            <option value="">Pilih kategori...</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
```

- [ ] **Step 7: Add the per-variant Barcode column**

Replace the variant header row (lines 642-647) — re-span and add Barcode:

```tsx
            <div className="grid grid-cols-12 gap-2 px-1 mb-1">
              <span className="col-span-3 text-[11px] font-bold text-gray-400">Ukuran</span>
              <span className="col-span-3 text-[11px] font-bold text-gray-400">Harga Dasar</span>
              <span className="col-span-3 text-[11px] font-bold text-gray-400">SKU</span>
              <span className="col-span-2 text-[11px] font-bold text-gray-400">Barcode</span>
              <span className="col-span-1" />
            </div>
```

Replace the variant row body (lines 649-660) — re-span size/price/sku to col-span-3/2/2-ish and add a Barcode input (placeholder shows the SKU it defaults to):

```tsx
              {form.variants.map((v, i) => (
                <div key={i} className="grid grid-cols-12 gap-2 items-center">
                  {([
                    { k: 'size', span: 'col-span-3', ph: '30ml', num: false },
                    { k: 'price', span: 'col-span-3', ph: '150000', num: true },
                    { k: 'sku', span: 'col-span-3', ph: 'MND-01', num: false },
                  ] as const).map(({ k, span, ph, num }) => (
                    <input key={k} type={num ? 'number' : 'text'} value={num && v[k] === 0 ? '' : v[k]} onChange={(e) => updVariant(i, k, e.target.value)} placeholder={ph} className={`${fieldClass} ${span}`} />
                  ))}
                  <input
                    type="text"
                    value={v.barcode ?? ''}
                    onChange={(e) => updVariant(i, 'barcode', e.target.value)}
                    placeholder={v.sku.trim() || '= SKU'}
                    title="Kosongkan untuk memakai SKU sebagai barcode"
                    className={`${fieldClass} col-span-2`}
                  />
                  <button onClick={() => setForm((f) => ({ ...f, variants: f.variants.filter((_, x) => x !== i) }))} disabled={form.variants.length === 1} className="col-span-1 flex justify-center text-gray-300 hover:text-red-500 disabled:opacity-0"><X className="w-4 h-4" /></button>
                </div>
              ))}
```

(`updVariant(i, k, val)` at line 182 already handles any `keyof ProductVariant`; `barcode` is a string key so the existing `Number(...)` branch is not taken. No change needed there.)

- [ ] **Step 8: Typecheck**

Run: `corepack pnpm --filter @mandalika/backoffice exec tsc --noEmit`
Expected: no errors. (The removed `Product.upc`/`ProductInput.upc` types make any missed `upc` reference a compile error — fix any that surface.)

- [ ] **Step 9: Commit**

```bash
git add apps/backoffice/src/screens/Products.tsx
git commit -m "feat(backoffice): per-variant barcode field (defaults to SKU) + CSV Barcode column"
```

---

## Task 7: Build backoffice + verify

- [ ] **Step 1: Build**

Run: `corepack pnpm --filter @mandalika/backoffice build`
Expected: build succeeds. (Cloudflare Pages auto-deploys on push to `prod-hardening`.)

- [ ] **Step 2: Verify (after push)**

In the backoffice product modal: each variant shows a Barcode input with the SKU as placeholder; leaving it blank saves barcode=SKU; entering a value persists it; a duplicate across products shows the friendly 400 message. CSV export has a `Barcode` column; import reads it (blank ⇒ SKU). Re-run Task 5 Step 4 (uniqueness) through the UI.

---

## Task 8: POS scan-to-cart — pure resolver + keyboard-wedge path

**Files:**
- Create: `apps/pos/src/cashier/scan.ts`
- Modify: `apps/pos/src/cashier/ProductGrid.tsx` (search input: fire on Enter; optional Scan button slot)
- Modify: `apps/pos/src/cashier/CashierScreen.tsx` (scan index + `handleScan` + wire)

- [ ] **Step 1: Pure resolver `scan.ts`**

```ts
import type { components } from '@mandalika/api'

type Product = components['schemas']['Product']
type ProductVariant = components['schemas']['ProductVariant']

export interface ScanMatch {
  product: Product
  variant: ProductVariant
}

/** Build an exact-match index from synced products: barcode → {product,variant}.
 *  First occurrence wins (barcodes are catalog-wide unique server-side). */
export function buildScanIndex(products: Product[]): Map<string, ScanMatch> {
  const index = new Map<string, ScanMatch>()
  for (const product of products) {
    for (const variant of product.variants) {
      const key = (variant.barcode ?? '').trim()
      if (key && !index.has(key)) index.set(key, { product, variant })
    }
  }
  return index
}

/** Resolve a scanned/typed code to a variant via exact (trimmed) match. */
export function resolveScan(
  index: Map<string, ScanMatch>,
  code: string,
): ScanMatch | null {
  return index.get(code.trim()) ?? null
}
```

- [ ] **Step 2: ProductGrid — fire scan on Enter + optional Scan button**

Extend `ProductGridProps` (after `onSearchChange`):
```ts
  onSearchSubmit?: (q: string) => void
  onScanClick?: () => void
```

Add these to the destructured props in the `ProductGrid` function signature: `onSearchSubmit`, `onScanClick`.

Replace the search bar block (the `<div className="px-3 py-2 border-b ...">` wrapping the search `<input>`, lines ~260-268) with:

```tsx
      {/* Search bar — Enter submits (keyboard-wedge scanners append CR) */}
      <div className="px-3 py-2 border-b border-gray-100 flex-shrink-0 flex gap-2">
        <input
          type="search"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && onSearchSubmit) {
              e.preventDefault()
              onSearchSubmit(searchQuery)
            }
          }}
          placeholder="Cari / scan produk…"
          className="flex-1 px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-indigo-400"
        />
        {onScanClick && (
          <button
            type="button"
            onClick={onScanClick}
            className="flex-shrink-0 px-3 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 active:scale-95 transition"
            title="Scan barcode / QR"
            aria-label="Scan barcode atau QR"
          >
            {/* simple scan glyph */}
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M3 12h18"/></svg>
          </button>
        )}
      </div>
```

(`onScanClick` is omitted until Task 10, so the button stays hidden — the wedge path works alone.)

- [ ] **Step 3: CashierScreen — scan index + handleScan + wire**

Add the import near the other cashier imports:
```ts
import { buildScanIndex, resolveScan } from './scan'
```

Add `useMemo` to the React import on line 6:
```ts
import { useContext, useReducer, useRef, useState, useEffect, useMemo } from 'react'
```

After `const products = (snapshot.products ?? []).filter((p) => p.isActive)` (line 121), add:
```ts
  const scanIndex = useMemo(() => buildScanIndex(products), [products])
```

After `handleProductTap` (after line 167), add the scan handler:
```ts
  // Scan-to-cart: resolve the code to a variant, add 1 respecting stock.
  // Shared by the keyboard-wedge (search Enter) and camera paths.
  const handleScan = (code: string) => {
    const trimmed = code.trim()
    if (!trimmed) return
    const match = resolveScan(scanIndex, trimmed)
    if (!match) {
      showToast('Kode tidak dikenal')
      return
    }
    const { product, variant } = match
    const inCart = state.cart
      .filter((i) => i.productId === product.id && i.variantSize === variant.size)
      .reduce((s, i) => s + i.quantity, 0)
    if (inCart + 1 > variant.stock) {
      showToast('Stok habis')
      return
    }
    handleProductTap(product, { [variant.size]: 1 })
    showToast(`Ditambah: ${product.name} ${variant.size}`)
  }

  // Wedge path: Enter in the search box. If it exactly matches a barcode, scan
  // and clear the box; otherwise leave it as a normal name filter.
  const handleSearchSubmit = (q: string) => {
    if (resolveScan(scanIndex, q)) {
      handleScan(q)
      setSearchQuery('')
    }
  }
```

Wire it on the `<ProductGrid .../>` element (add to its props, after `onSearchChange={setSearchQuery}`):
```tsx
            onSearchSubmit={handleSearchSubmit}
```

- [ ] **Step 4: Typecheck**

Run: `corepack pnpm --filter @mandalika/pos exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/pos/src/cashier/scan.ts apps/pos/src/cashier/ProductGrid.tsx apps/pos/src/cashier/CashierScreen.tsx
git commit -m "feat(pos): scan-to-cart resolver + keyboard-wedge path (Enter in search)"
```

---

## Task 9: Build POS + verify wedge in browser

- [ ] **Step 1: Build**

Run: `corepack pnpm --filter @mandalika/pos build`
Expected: build succeeds.

- [ ] **Step 2: Verify in browser (dev)**

Run: `corepack pnpm --filter @mandalika/pos dev`, log in as the test cashier, open a shift. With a known variant barcode (from backoffice — equals the SKU by default): type it into the search box and press Enter.
Expected: 1 of that exact variant is added to the cart, a toast `Ditambah: <name> <size>` shows, the search box clears. Typing an unknown code + Enter → `Kode tidak dikenal`. Scanning a variant already at its stock cap → `Stok habis`. Typing a partial product name + Enter → no scan (stays a filter). Works offline (lookup is against the snapshot).

> A USB/Bluetooth wedge scanner that appends CR behaves exactly like typing + Enter, so this path covers hardware scanners with no further code. If your scanner does NOT send CR, flag it — we'd switch to exact-match-on-input.

---

## Task 10: POS camera path (ML Kit) — GATED on Capacitor 8 compatibility

> **Capacitor here is v8.3.4.** `@capacitor-mlkit/barcode-scanning` must have a Cap-8-compatible release. **Verify first**; if none exists yet, STOP this task and ship the wedge path (Tasks 1-9) — the feature already works. Do not force an incompatible plugin. (Rule: flag uncertainty / verify on failure.)

**Files:**
- Modify: `apps/pos/package.json` (dependency)
- Modify: `apps/pos/android/app/src/main/AndroidManifest.xml` (CAMERA permission)
- Modify: `apps/pos/src/cashier/CashierScreen.tsx` (Scan button handler)

- [ ] **Step 1: Confirm a compatible plugin version**

Run: `npm view @capacitor-mlkit/barcode-scanning peerDependencies`
Expected: identify a version whose `@capacitor/core` peer allows `^8`. Note that exact version. If only `^6`/`^7` exist, STOP (see gate above) and record the gap in Task 12.

- [ ] **Step 2: Install (pin the compatible version)**

Run (replace `<ver>` with the verified version):
```bash
corepack pnpm --filter @mandalika/pos add @capacitor-mlkit/barcode-scanning@<ver>
```

- [ ] **Step 3: Add CAMERA permission**

In `apps/pos/android/app/src/main/AndroidManifest.xml`, add alongside the other `uses-permission` lines (after the INTERNET line ~34):
```xml
    <uses-permission android:name="android.permission.CAMERA" />
```

- [ ] **Step 4: Camera scan handler + wire the button**

In `CashierScreen.tsx`, add the import (after the `scan` import):
```ts
import { BarcodeScanner, BarcodeFormat } from '@capacitor-mlkit/barcode-scanning'
```

Add the handler after `handleSearchSubmit`:
```ts
  // Camera path: ML Kit modal scanner (QR + common 1D). Falls back gracefully
  // when unsupported or permission denied — the wedge path still works.
  const handleCameraScan = async () => {
    try {
      const { supported } = await BarcodeScanner.isSupported()
      if (!supported) { showToast('Kamera scan tidak didukung perangkat ini'); return }
      const perm = await BarcodeScanner.requestPermissions()
      if (perm.camera !== 'granted' && perm.camera !== 'limited') {
        showToast('Izin kamera ditolak'); return
      }
      const { barcodes } = await BarcodeScanner.scan({
        formats: [
          BarcodeFormat.QrCode, BarcodeFormat.Ean13, BarcodeFormat.Ean8,
          BarcodeFormat.UpcA, BarcodeFormat.UpcE, BarcodeFormat.Code128,
          BarcodeFormat.Code39, BarcodeFormat.DataMatrix,
        ],
      })
      const value = barcodes[0]?.rawValue
      if (value) handleScan(value)
    } catch {
      // user cancelled or scanner error — no-op (wedge path remains)
    }
  }
```

Wire it on `<ProductGrid .../>` (after `onSearchSubmit={handleSearchSubmit}`):
```tsx
            onScanClick={() => void handleCameraScan()}
```

- [ ] **Step 5: Capacitor sync + typecheck + build**

Run:
```bash
corepack pnpm --filter @mandalika/pos exec tsc --noEmit
corepack pnpm --filter @mandalika/pos build
cd apps/pos && npx cap sync android && cd ../..
```
Expected: typecheck clean, build ok, `cap sync` copies the plugin into the Android project.

- [ ] **Step 6: Commit**

```bash
git add apps/pos/package.json pnpm-lock.yaml apps/pos/android/app/src/main/AndroidManifest.xml apps/pos/src/cashier/CashierScreen.tsx
git commit -m "feat(pos): camera scan-to-cart via ML Kit (QR + 1D)"
```

---

## Task 11: APK rebuild via CI + on-device verify

> Local APK build is blocked on Windows (space in path breaks the BLE plugin Gradle) — CI only (SESSION_HANDOFF.md).

- [ ] **Step 1: Push branch**

```bash
git push
```

- [ ] **Step 2: Dispatch the signed APK build**

```bash
TOKEN=$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill 2>/dev/null | sed -n 's/^password=//p')
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/Epheyy/mandalika-pos/actions/workflows/android-release.yml/dispatches \
  -d '{"ref":"prod-hardening","inputs":{"api_url":"https://mandalika-pos-538849926142.asia-southeast2.run.app"}}'
```
Then poll the run and fetch the `mandalika-pos-release-apk` artifact.

- [ ] **Step 3: On-device verify**

Install the APK. Open a shift. Tap the Scan button → camera opens → scan a **QR** encoding a known variant barcode and a **1D barcode** (EAN/SKU) → each adds the correct variant with the toast. Deny camera permission once → graceful toast, wedge path still works. Pair a hardware wedge scanner (if available) and scan → adds via the search-Enter path.

---

## Task 12: Docs + memory

**Files:**
- Modify: `docs/superpowers/plans/2026-05-25-per-variant-scan-to-cart.md` (this file — check the boxes + resume notes)
- Modify: memory `prod-cutover-deploy-ready.md` + `MEMORY.md`

- [ ] **Step 1: Record outcome**

Update the plan's resume notes with the deployed backend revision, verification results, and (if Task 10 was gated out) the Capacitor-8 plugin-compatibility gap as a follow-up.

- [ ] **Step 2: Update memory**

Note in `prod-cutover-deploy-ready.md`: UPC redesign done — per-variant `barcode` (defaults to SKU, catalog-wide unique, migration 0014, `products.upc` left dead pending a later drop); POS scan-to-cart (wedge + camera). Update the `MEMORY.md` one-liner.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/plans/2026-05-25-per-variant-scan-to-cart.md
git commit -m "docs: per-variant scan-to-cart done + verified"
```

---

## Progress / resume notes

**2026-05-25 — Tasks 1-10 done (subagent-driven). Backend deployed + live-verified.**

- **T1** migration `0014_variant_barcode.sql` (`2c91395`). **T2** openapi + regen: `barcode` on ProductVariant, `upc` removed from Product/ProductInput (`f2f5f9b`). **T3** write/repo.go: persist `barcode` (empty⇒SKU via `variantBarcode`), drop UPC, within-product dup check, `barcodeConflict` unique-violation→friendly msg (`73a7f05`). **T4** read/repo.go: emit `barcode`, drop `upc` both branches (`d2c0188`).
- **T5 deploy** — Cloud Run rev **`mandalika-pos-00019-q4r`**, `/readyz` 200 (⇒ migration 0014 applied cleanly on boot). Live-verified with admin token: variants carry `barcode` (backfilled = SKU, e.g. `A10M-HOL`), no top-level `upc`; catalog-wide collision rejected → `HTTP 400 {"error":"barcode sudah dipakai varian lain: A10M-HOL"}` (nothing persisted).
- **T6** backoffice Products.tsx: per-variant Barcode field (blank⇒SKU at save), CSV `Barcode` column, parent UPC removed (`e717782`). **T7** backoffice prod build OK (live UI verify pending push).
- **T8** POS scan: pure `scan.ts` (`buildScanIndex`/`resolveScan`) + wedge path (Enter in search → add 1, stock-guarded, toast) (`7d43a22`). **T9** POS prod build OK (interactive verify folded into on-device).
- **T10 camera path** — gate CLEARED: `@capacitor-mlkit/barcode-scanning@8.1.0` peers `@capacitor/core >=8.0.0` (we're on 8.3.4). Installed + CAMERA permission + `handleCameraScan` (QR+1D) wired; `cap sync android` succeeded (`5626a16`). Camera marked optional `uses-feature required=false` so camera-less tablets aren't excluded (`98b99a8`).
- All per-task spec + code-quality reviews passed (minor non-blocking notes only). Accepted-as-is minor: T8 `useMemo([products])` rebuilds each render (negligible — tiny catalog; real fix depends on `engine.getSnapshot()` ref-stability, not worth speculative change).

**T11 DONE (2026-05-25):** pushed `cdbed6a..059cbdf` to prod-hardening → Cloudflare Pages
auto-deploys backoffice; signed APK CI run **26369022325** = SUCCESS, artifact
`mandalika-pos-release-apk` (14.4 MB). **On-device verification = USER-PENDING** (camera
QR+1D, wedge Enter-in-search, backoffice barcode field + dup-reject + CSV round-trip).

**REMAINING:**
- **On-device verify** (user) — then record results here + mark fully done.
- **Follow-up (later migration):** drop the now-dead `products.upc` column once no old revision references it (expand/contract).
- **Pure-function unit tests DONE (`7617c50`):** Go `variantBarcode`/`validateVariants` (`backend/internal/write/repo_test.go`, table-driven, runs in `go test ./...`); TS `buildScanIndex`/`resolveScan` (`apps/pos/src/cashier/scan.test.ts`, 8 tests). Added **Vitest 4.1.7** to apps/pos (`test` script = `vitest run`; `*.test.ts` excluded from prod `tsc -b` so the APK build stays decoupled). This is the repo's first JS test runner.
