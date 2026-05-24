# Stable Variant Identity (Preserve-ID + Server-Side Rename) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use `- [ ]`. Update + commit checkboxes as you go (durable resume point). Operating rules: ask don't assume; don't touch unrelated; flag uncertainty; on failure show real output + verify; show changes; admit gaps.

**Goal:** Make a variant's per-outlet stock/price/availability survive a rename of its **Ukuran (size)** through BOTH the Edit modal and CSV import, without re-touching the live sale path.

**Approach (chosen):** *Preserve-ID + server-side rename.* `product_variants` already has a permanent `id`. Stop deleting+reinserting variants on update; instead upsert them, matching an incoming variant by **id** (modal) or **SKU** (CSV). When a matched variant's size changes, `UpdateProduct` moves its `outlet_variant_stock` / `outlet_variant_price` rows old→new size **in the same transaction**. Per-outlet tables stay keyed by `(outlet_id, product_id, variant_size)`, so the order decrement / refund / stock-count paths are UNCHANGED.

**Identity rules:**
- Modal: variant carries its `id`; matched by id (rename of size and/or SKU both safe).
- CSV: no id; matched by **SKU** within the product (keep SKU, change Ukuran = rename). New/blank SKU = new variant. Changing BOTH size and SKU in CSV = treated as new (documented limitation).
- **SKU becomes required + unique per product** (the CSV handle): migration backfills blanks + adds a unique index; create/update validate it.

**Tech:** Go (pgx), Postgres (Neon), React/Vite backoffice, `@mandalika/api` generated client. CI gates: `make gen-check`, `go vet`, `gofmt -l`, `go build`, `go test`. No DB test harness → verify on deploy. Cloudflare auto-deploys backoffice on push; backend via `gcloud run deploy`.

**Re-affirmation:** Renames preserve stock via Modal (id-matched) AND CSV (SKU-matched). Live sale path untouched. Historical `order_items` stays a name/size snapshot (sales history not rewritten).

---

## File map
- Create: `backend/internal/db/migrations/0012_variant_sku_unique.sql`
- Modify: `backend/api/openapi.yaml` (ProductVariant gets `id`; +regen `internal/api/api.gen.go`)
- Modify: `backend/internal/read/repo.go` (`productObjScoped` both branches emit `'id',v.id`)
- Modify: `backend/internal/write/repo.go` (`Variant.ID`; rewrite `UpdateProduct` to upsert+rename; SKU validation; `CreateProduct` validation)
- Modify: `packages/api/src/client.ts` regen (`schema.d.ts`) — ProductVariant.id
- Modify: `apps/backoffice/src/screens/Products.tsx` (carry variant `id` in form + send it; require SKU; CSV importer upsert)

---

## Task 1: Migration — SKU required + unique per product

**File:** Create `backend/internal/db/migrations/0012_variant_sku_unique.sql`

- [ ] **Step 1: Write it.** Backfill blank SKUs deterministically, then enforce uniqueness. (Current data has distinct non-blank SKUs except one blank; assumes no pre-existing duplicate non-blank SKUs — verify with the query in Step 2 before deploy.)

```sql
-- 0012: SKU is the stable CSV-correlation handle → required + unique per product.
UPDATE product_variants
   SET sku = 'SKU-' || left(replace(id::text,'-',''), 8)
 WHERE sku IS NULL OR sku = '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_variant_product_sku
  ON product_variants (product_id, sku);
```

- [ ] **Step 2: Before deploy, verify no duplicate non-blank SKUs** (would block the index). Run read-only:
```sql
SELECT product_id, sku, count(*) FROM product_variants
WHERE sku <> '' GROUP BY product_id, sku HAVING count(*) > 1;
```
Expected: 0 rows. If any, de-dup (suffix) before creating the index — STOP and report.

- [ ] **Step 3: Commit** (applies on next backend boot).
```bash
git add backend/internal/db/migrations/0012_variant_sku_unique.sql
git commit -m "feat(backend): migration 0012 — backfill blank SKUs + unique (product_id, sku)"
```

---

## Task 2: Expose variant `id` in the API

**Files:** `backend/api/openapi.yaml`, regen; `backend/internal/read/repo.go`

- [ ] **Step 1: openapi.yaml** — add `id` to `ProductVariant`:
```yaml
    ProductVariant:
      type: object
      required: [size, price, stock, sku]
      properties:
        id: { type: string, format: uuid, nullable: true }   # permanent variant id (absent = new)
        size: { type: string }
        price: { type: number }
        stock: { type: integer }
        sku: { type: string }
```

- [ ] **Step 2: Regen** `cd backend && go tool oapi-codegen -config api/oapi-codegen.yaml api/openapi.yaml`. Confirm `api.ProductVariant` now has `Id`.

- [ ] **Step 3: read/repo.go** — emit `'id',v.id` in BOTH branches of `productObjScoped` (the CrossAll/all branch and the scoped branch), inside the variant `json_build_object`. Example (scoped branch first key):
```
'variants',COALESCE((SELECT json_agg(json_build_object(
   'id',v.id,'size',v.size, ...
```
(Do the same in the CrossAll branch.)

- [ ] **Step 4: Verify** `cd backend && go build ./... && make gen-check && gofmt -l internal/read`. Commit:
```bash
cd .. && git add backend/api/openapi.yaml backend/internal/api/api.gen.go backend/internal/read/repo.go
git commit -m "feat(backend): expose permanent variant id in product reads"
```

---

## Task 3: Rewrite UpdateProduct (upsert by id/SKU + server-side rename)

**File:** `backend/internal/write/repo.go`

- [ ] **Step 1: Add `ID` to the write Variant struct.**
```go
type Variant struct {
	ID    string  `json:"id"`
	Size  string  `json:"size"`
	Price float64 `json:"price"`
	Stock int     `json:"stock"`
	SKU   string  `json:"sku"`
}
```

- [ ] **Step 2: Add SKU validation helper** (required + unique within the payload):
```go
func validateVariants(vs []Variant) error {
	seen := map[string]bool{}
	for _, v := range vs {
		if v.SKU == "" {
			return fmt.Errorf("setiap varian wajib punya SKU")
		}
		if seen[v.SKU] {
			return fmt.Errorf("SKU duplikat dalam produk: %s", v.SKU)
		}
		seen[v.SKU] = true
	}
	return nil
}
```
Call it at the start of `CreateProduct` and `UpdateProduct` (return the error before the tx).

- [ ] **Step 3: Rewrite `UpdateProduct`** to preserve ids + rename per-outlet rows. Replace the delete-all+reinsert body with:
```go
func (r *Repo) UpdateProduct(ctx context.Context, id string, p Product) error {
	if e := validateVariants(p.Variants); e != nil {
		return e
	}
	return r.tx(ctx, "products", func(t pgx.Tx) error {
		ct, e := t.Exec(ctx, `
			UPDATE products SET name=$1, brand=$2, category_id=$3, description=$4,
			  image_url=$5, is_featured=$6, is_favourite=$7, is_active=$8 WHERE id=$9`,
			p.Name, p.Brand, nullUUID(p.CategoryID), nullStr(p.Description),
			nullStr(p.ImageURL), p.IsFeatured, p.IsFavourite, p.IsActive, id)
		if e != nil {
			return e
		}
		if ct.RowsAffected() == 0 {
			return ErrNotFound
		}

		// existing variants: id -> size, and sku -> id (for CSV correlation)
		rows, e := t.Query(ctx, `SELECT id, size, sku FROM product_variants WHERE product_id=$1`, id)
		if e != nil {
			return e
		}
		type ex struct{ size, sku string }
		byID := map[string]ex{}
		bySKU := map[string]string{}
		for rows.Next() {
			var vid, sz, sku string
			if e := rows.Scan(&vid, &sz, &sku); e != nil {
				rows.Close()
				return e
			}
			byID[vid] = ex{sz, sku}
			if sku != "" {
				bySKU[sku] = vid
			}
		}
		rows.Close()

		kept := map[string]bool{}
		for _, v := range p.Variants {
			vid := v.ID
			if vid == "" {
				vid = bySKU[v.SKU] // CSV path: match by SKU
			}
			if cur, ok := byID[vid]; ok {
				if _, e := t.Exec(ctx,
					`UPDATE product_variants SET size=$1, price=$2, stock=$3, sku=$4 WHERE id=$5`,
					v.Size, v.Price, v.Stock, v.SKU, vid); e != nil {
					return e
				}
				if cur.size != v.Size {
					// server-side rename: move per-outlet rows old->new size
					if _, e := t.Exec(ctx,
						`UPDATE outlet_variant_stock SET variant_size=$1 WHERE product_id=$2 AND variant_size=$3`,
						v.Size, id, cur.size); e != nil {
						return e
					}
					if _, e := t.Exec(ctx,
						`UPDATE outlet_variant_price SET variant_size=$1 WHERE product_id=$2 AND variant_size=$3`,
						v.Size, id, cur.size); e != nil {
						return e
					}
				}
				kept[vid] = true
				continue
			}
			// new variant
			if _, e := t.Exec(ctx,
				`INSERT INTO product_variants (product_id, size, price, stock, sku) VALUES ($1,$2,$3,$4,$5)`,
				id, v.Size, v.Price, v.Stock, v.SKU); e != nil {
				return e
			}
		}
		// delete removed variants + their per-outlet rows
		for vid, cur := range byID {
			if kept[vid] {
				continue
			}
			if _, e := t.Exec(ctx, `DELETE FROM product_variants WHERE id=$1`, vid); e != nil {
				return e
			}
			if _, e := t.Exec(ctx, `DELETE FROM outlet_variant_stock WHERE product_id=$1 AND variant_size=$2`, id, cur.size); e != nil {
				return e
			}
			if _, e := t.Exec(ctx, `DELETE FROM outlet_variant_price WHERE product_id=$1 AND variant_size=$2`, id, cur.size); e != nil {
				return e
			}
		}
		return nil
	})
}
```
NOTE: `insertVariants` is still used by `CreateProduct`; leave it. Edge (accepted, document): swapping two variants' sizes in one save can hit the per-outlet PK; extremely rare.

- [ ] **Step 4: Verify** `cd backend && go build ./... && go vet ./... && gofmt -l internal/write`. Commit:
```bash
cd .. && git add backend/internal/write/repo.go
git commit -m "feat(backend): UpdateProduct preserves variant ids + server-side size rename moves stock"
```

---

## Task 4: Deploy backend + verify (GATE)

- [ ] **Step 1:** Task 1 Step 2 dup-SKU check = 0 rows.
- [ ] **Step 2:** `gcloud run deploy mandalika-pos --source backend --region asia-southeast2 --quiet` (bg). `/readyz`=200.
- [ ] **Step 3: Verify modal-style rename (by id):** GET a product (now returns variant `id`s); set an outlet's stock for variant A; `PUT /products/{id}` with A's `id` kept but `size` changed → GET outlet-config → A's new size carries the stock; old size gone. Revert.
- [ ] **Step 4: Verify CSV-style rename (by SKU):** `PUT /products/{id}` with a variant that has **no id** but the **same SKU** and a **changed size** → stock preserved under the new size. Revert.
- [ ] **Step 5: Verify SKU enforcement:** updateProduct with a blank or duplicate SKU → 400. 
- [ ] **Step 6:** mark Task 4 done + commit checkbox.

---

## Task 5: Frontend — carry id, require SKU, CSV upsert

**File:** `apps/backoffice/src/screens/Products.tsx` (+ regen client in Task 2 already gives `ProductVariant.id`)

- [ ] **Step 1: Regen TS client** (if not already): `corepack pnpm --filter @mandalika/api gen`; commit `packages/api/src/schema.d.ts`.
- [ ] **Step 2: Form carries `id`.** `openEdit` already sets `form.variants` from the product read — variants now include `id`, so it's carried automatically. In `save()`, the `body.variants` mapping must include `id`:
```ts
variants: form.variants.map((v) => ({
  id: v.id, size: v.size.trim(), price: Number(v.price),
  stock: Number(v.stock), sku: v.sku.trim(),
})),
```
New variants added in the modal have no `id` (EMPTY_VARIANT has none) → backend treats as new. (Keep the existing ocfgMap rename-remap for live display.)
- [ ] **Step 3: Require SKU in the modal.** In `save()` validation add: `if (form.variants.some((v) => !v.sku.trim())) return setErr('Setiap varian wajib punya SKU')`. (Optionally mark the SKU input required.)
- [ ] **Step 4: CSV importer → upsert.** In `importProducts`, after grouping by Nama|Brand: for each group, find an existing product by name+brand (case-insensitive) in `products`; if found → `api.updateProduct(existing.id, {...})` (variants carry size/price/sku, NO id → backend matches by SKU → rename/update or new); else `api.createProduct({...})`. Validate each row has a SKU; skip + count rows without SKU and report. Keep the existing category lookup.
- [ ] **Step 5: Verify** `corepack pnpm --filter @mandalika/backoffice exec tsc -b --force` (EXIT 0) + build. Commit + push (Cloudflare deploys).
- [ ] **Step 6: Verify on live site:** edit a product, rename a variant's Ukuran (keep SKU) → save → reopen → stock intact. Re-import a CSV with a changed Ukuran but same SKU → stock intact (rename, not duplicate). Adding a brand-new SKU row → new variant.

---

## Task 6: Wrap-up
- [ ] Update memory + this plan's checkboxes. Note remaining Phase 2–4 items (Add/Edit wizard + Type flags, Atur menus, import-template download — the importer upsert here is a step toward the template work).

## Progress / resume notes
- Status: **not started** (plan written 2026-05-24).
- Open confirmation: dup-SKU check (Task 1 Step 2) before deploy.
