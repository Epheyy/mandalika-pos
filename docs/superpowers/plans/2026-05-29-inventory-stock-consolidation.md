# Inventory Stock Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the renamed **Inventori** module the single home for all product stock across every outlet and warehouse, with outlets gaining the same auditable goods-in/koreksi operations warehouses have, and remove stock management from the Product module.

**Architecture:** Generalize the warehouse goods-in/adjust write path to a location target `{kind:"outlet"|"warehouse", id}` (mirrors the SP1 `stock_counts` polymorphic pattern). Outlet stock writes bump that outlet's `content_version` so the POS re-syncs; warehouse writes don't. The backoffice "Gudang" module becomes "Inventori" (tabs: Stok Produk · Transfer · Bahan · Opname), where Stok Produk has a location-first drill-down + a read-only Overview matrix. The product modal keeps only Harga + Jual; stock/PAR move to Inventori.

**Tech Stack:** Go (chi, pgx/pgxpool, oapi-codegen) · Postgres (Neon) · React + TypeScript (Vite, Cloudflare Pages) · OpenAPI codegen for `@mandalika/api`.

**Spec:** `docs/superpowers/specs/2026-05-29-inventory-stock-consolidation-design.md`

## The 6 working rules (follow throughout)
1. Ask, don't assume · 2. Don't touch unrelated · 3. Flag uncertainty · 4. Verify on failure · 5. Show changes · 6. Admit gaps.

## Key facts (verified against current code, 2026-05-29)
- `outlet_variant_stock(outlet_id, product_id, variant_size, stock int NOT NULL DEFAULT 0, par_level int NULL, available bool NOT NULL DEFAULT true)`. PK `(outlet_id, product_id, variant_size)`. Three independent writers each touch ONLY their column(s): inventory stock-ops → `stock`; product config → `available` (+ `outlet_variant_price.price`); PAR → `par_level`.
- `warehouse_variant_stock(warehouse_id, product_id, variant_size, stock int NOT NULL DEFAULT 0)`. PK `(warehouse_id, product_id, variant_size)`.
- Warehouse writes use `r.noBumpTx` (warehouses aren't POS-synced). Outlet writes must call `bumpVersionOutlets(ctx, tx, "products", []string{outletID})`.
- `validLocKind(kind)` already exists in `backend/internal/write/transfer_logic.go`.
- `LocationStock(ctx, kind, id)` (read/repo.go:958) already returns per-variant on-hand for outlet OR warehouse → `[]api.WarehouseStockRow{productId, productName, variantSize, sku, stock}`.
- Routes live in `backend/internal/server/server.go`. `mw.RequirePermission("manage_inventory")` groups inventory routes; `manage_stock_count` groups stock-count routes; `manage_products` groups product outlet-config routes.
- `stock_counts` is already location-polymorphic (migration 0015) and `StockCount.tsx` already has an outlet/warehouse location picker — folding Opname in is a pure nav/tab move, NO backend change.
- Handler idioms: `decodeWrite[T](w, r) → (T, ok)`; `h.caller(r) → (c,_)` with `c.userID`; `h.mutated(w, r, err)` writes ok / maps errors; `httpx.Err(w, status, msg)`; `writeJSON(w, status, payload)`; `chi.URLParam(r,"id")`; `r.URL.Query().Get("kind")`.
- Highest migration = `0021_recipes.sql` → new migration is `0022`.

## Codegen + deploy commands (used by several tasks)
```bash
# regen Go from openapi.yaml
cd backend && go tool oapi-codegen -config api/oapi-codegen.yaml api/openapi.yaml && cd ..
# regen TS client types
corepack pnpm --filter @mandalika/api gen
# backend build/test
cd backend && go build ./... && go test ./... && cd ..
# deploy backend (background ~4-6 min; migrations auto-apply on boot)
gcloud run deploy mandalika-pos --source backend --region asia-southeast2 --quiet
# verify
curl -s https://mandalika-pos-538849926142.asia-southeast2.run.app/readyz
```
> CI gate `make gen-check` fails if `api.gen.go` drifts — always commit the regenerated file. Run `gofmt -w internal/` before committing Go.

---

# Phase A — Backend: polymorphic goods-in + koreksi

### Task A1: Migration 0022 — location-polymorphic stock logs

**Files:**
- Create: `backend/internal/db/migrations/0022_polymorphic_stock_logs.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 0022: make goods-in + stock-adjustment logs location-polymorphic (outlet OR
-- warehouse) so outlets gain the same auditable goods-in / koreksi operations
-- warehouses have. Mirrors the stock_counts polymorphic pattern (migration 0015).

ALTER TABLE goods_receipts ALTER COLUMN warehouse_id DROP NOT NULL;
ALTER TABLE goods_receipts ADD COLUMN IF NOT EXISTS outlet_id uuid
  REFERENCES outlets(id) ON DELETE CASCADE;
ALTER TABLE goods_receipts ADD CONSTRAINT goods_receipts_one_location
  CHECK (num_nonnulls(outlet_id, warehouse_id) = 1);

ALTER TABLE warehouse_stock_adjustments ALTER COLUMN warehouse_id DROP NOT NULL;
ALTER TABLE warehouse_stock_adjustments ADD COLUMN IF NOT EXISTS outlet_id uuid
  REFERENCES outlets(id) ON DELETE CASCADE;
ALTER TABLE warehouse_stock_adjustments ADD CONSTRAINT warehouse_stock_adjustments_one_location
  CHECK (num_nonnulls(outlet_id, warehouse_id) = 1);
```

- [ ] **Step 2: Verify the migration parses locally (optional, if a local PG is available)**

The runner applies migrations on backend boot; existing rows (warehouse_id set, outlet_id NULL) satisfy `num_nonnulls=1`, so the CHECK is valid against current data.

- [ ] **Step 3: Commit**

```bash
git add backend/internal/db/migrations/0022_polymorphic_stock_logs.sql
git commit -m "feat(db): migration 0022 — location-polymorphic goods-in & stock-adjustment logs"
```

### Task A2: Pure validators + table-driven tests

**Files:**
- Create: `backend/internal/write/stock_logic.go`
- Test: `backend/internal/write/stock_logic_test.go`

- [ ] **Step 1: Write the failing test**

```go
package write

import "testing"

func TestValidateGoodsReceipt(t *testing.T) {
	cases := []struct {
		name    string
		kind    string
		items   []GoodsReceiptItem
		wantErr bool
	}{
		{"ok warehouse", "warehouse", []GoodsReceiptItem{{ProductID: "p", VariantSize: "30ml", Qty: 5}}, false},
		{"ok outlet", "outlet", []GoodsReceiptItem{{ProductID: "p", VariantSize: "30ml", Qty: 1}}, false},
		{"bad kind", "shelf", []GoodsReceiptItem{{Qty: 1}}, true},
		{"no items", "outlet", nil, true},
		{"zero qty", "outlet", []GoodsReceiptItem{{Qty: 0}}, true},
		{"negative qty", "outlet", []GoodsReceiptItem{{Qty: -3}}, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := validateGoodsReceipt(c.kind, c.items)
			if (err != nil) != c.wantErr {
				t.Fatalf("validateGoodsReceipt(%q) err=%v wantErr=%v", c.kind, err, c.wantErr)
			}
		})
	}
}

func TestValidateLocationAdjust(t *testing.T) {
	cases := []struct {
		name    string
		kind    string
		newQty  int
		reason  string
		wantErr bool
	}{
		{"ok", "outlet", 10, "stok opname", false},
		{"bad kind", "shelf", 10, "x", true},
		{"no reason", "warehouse", 10, "", true},
		{"negative qty", "outlet", -1, "x", true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := validateLocationAdjust(c.kind, c.newQty, c.reason)
			if (err != nil) != c.wantErr {
				t.Fatalf("validateLocationAdjust err=%v wantErr=%v", err, c.wantErr)
			}
		})
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/write/ -run 'TestValidate(GoodsReceipt|LocationAdjust)' -v`
Expected: FAIL (`undefined: validateGoodsReceipt`).

- [ ] **Step 3: Write the validators**

```go
package write

import "fmt"

// validateGoodsReceipt checks a location goods-in request before any DB work.
func validateGoodsReceipt(kind string, items []GoodsReceiptItem) error {
	if !validLocKind(kind) {
		return fmt.Errorf("lokasi tidak valid")
	}
	if len(items) == 0 {
		return fmt.Errorf("minimal satu item")
	}
	for _, it := range items {
		if it.Qty <= 0 {
			return fmt.Errorf("qty harus lebih dari 0")
		}
	}
	return nil
}

// validateLocationAdjust checks an absolute stock correction request.
func validateLocationAdjust(kind string, newQty int, reason string) error {
	if !validLocKind(kind) {
		return fmt.Errorf("lokasi tidak valid")
	}
	if reason == "" {
		return fmt.Errorf("alasan wajib diisi")
	}
	if newQty < 0 {
		return fmt.Errorf("stok tidak boleh negatif")
	}
	return nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && go test ./internal/write/ -run 'TestValidate(GoodsReceipt|LocationAdjust)' -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/write/stock_logic.go backend/internal/write/stock_logic_test.go
git commit -m "test(write): pure validators for location goods-in & koreksi"
```

### Task A3: Polymorphic write functions + outlet version-bump helper

**Files:**
- Modify: `backend/internal/write/warehouse.go` (append new funcs)

- [ ] **Step 1: Add the outlet-bump tx helper + polymorphic funcs**

Append to `backend/internal/write/warehouse.go`:

```go
// bumpOutletTx runs fn in a tx and, on success, bumps ONLY the given outlet's
// content_version under "products" so the POS re-syncs the new on-hand.
func (r *Repo) bumpOutletTx(ctx context.Context, outletID string, fn func(pgx.Tx) error) error {
	t, err := r.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer t.Rollback(ctx)
	if err := fn(t); err != nil {
		return err
	}
	if err := bumpVersionOutlets(ctx, t, "products", []string{outletID}); err != nil {
		return fmt.Errorf("bump version: %w", err)
	}
	return t.Commit(ctx)
}

// CreateLocationGoodsReceipt records a goods-in for an outlet OR warehouse and
// INCREMENTS that location's stock per line. Outlet writes bump the outlet's
// content_version; warehouse writes do not.
func (r *Repo) CreateLocationGoodsReceipt(ctx context.Context, kind, locID, createdBy string, g GoodsReceipt) error {
	if err := validateGoodsReceipt(kind, g.Items); err != nil {
		return err
	}
	var whID, outID any
	if kind == "warehouse" {
		whID = locID
	} else {
		outID = locID
	}
	work := func(t pgx.Tx) error {
		var rid string
		if e := t.QueryRow(ctx,
			`INSERT INTO goods_receipts (warehouse_id, outlet_id, supplier, note, created_by)
			 VALUES ($1,$2,$3,$4,$5) RETURNING id`,
			whID, outID, nullStr(g.Supplier), nullStr(g.Note), nullUUID(createdBy)).Scan(&rid); e != nil {
			return e
		}
		for _, it := range g.Items {
			if _, e := t.Exec(ctx,
				`INSERT INTO goods_receipt_items (receipt_id, product_id, variant_size, qty, unit_cost)
				 VALUES ($1,$2,$3,$4,$5)`,
				rid, it.ProductID, it.VariantSize, it.Qty, it.UnitCost); e != nil {
				return e
			}
			if kind == "warehouse" {
				if _, e := t.Exec(ctx,
					`INSERT INTO warehouse_variant_stock (warehouse_id, product_id, variant_size, stock)
					 VALUES ($1,$2,$3,$4)
					 ON CONFLICT (warehouse_id, product_id, variant_size)
					   DO UPDATE SET stock = warehouse_variant_stock.stock + EXCLUDED.stock`,
					locID, it.ProductID, it.VariantSize, it.Qty); e != nil {
					return e
				}
			} else {
				// outlet: touch ONLY stock — preserve available + par_level.
				if _, e := t.Exec(ctx,
					`INSERT INTO outlet_variant_stock (outlet_id, product_id, variant_size, stock)
					 VALUES ($1,$2,$3,$4)
					 ON CONFLICT (outlet_id, product_id, variant_size)
					   DO UPDATE SET stock = outlet_variant_stock.stock + EXCLUDED.stock`,
					locID, it.ProductID, it.VariantSize, it.Qty); e != nil {
					return e
				}
			}
		}
		return nil
	}
	if kind == "warehouse" {
		return r.noBumpTx(ctx, work)
	}
	return r.bumpOutletTx(ctx, locID, work)
}

// AdjustLocationStock SETS the absolute on-hand qty for an outlet OR warehouse +
// logs the correction. Outlet writes touch ONLY stock (preserve available +
// par_level) and bump the outlet's content_version.
func (r *Repo) AdjustLocationStock(ctx context.Context, kind, locID, createdBy string, a WarehouseAdjust) error {
	if err := validateLocationAdjust(kind, a.NewQty, a.Reason); err != nil {
		return err
	}
	var whID, outID any
	if kind == "warehouse" {
		whID = locID
	} else {
		outID = locID
	}
	work := func(t pgx.Tx) error {
		if kind == "warehouse" {
			if _, e := t.Exec(ctx,
				`INSERT INTO warehouse_variant_stock (warehouse_id, product_id, variant_size, stock)
				 VALUES ($1,$2,$3,$4)
				 ON CONFLICT (warehouse_id, product_id, variant_size) DO UPDATE SET stock=EXCLUDED.stock`,
				locID, a.ProductID, a.VariantSize, a.NewQty); e != nil {
				return e
			}
		} else {
			if _, e := t.Exec(ctx,
				`INSERT INTO outlet_variant_stock (outlet_id, product_id, variant_size, stock)
				 VALUES ($1,$2,$3,$4)
				 ON CONFLICT (outlet_id, product_id, variant_size) DO UPDATE SET stock=EXCLUDED.stock`,
				locID, a.ProductID, a.VariantSize, a.NewQty); e != nil {
				return e
			}
		}
		_, e := t.Exec(ctx,
			`INSERT INTO warehouse_stock_adjustments (warehouse_id, outlet_id, product_id, variant_size, new_qty, reason, created_by)
			 VALUES ($1,$2,$3,$4,$5,$6,$7)`,
			whID, outID, a.ProductID, a.VariantSize, a.NewQty, a.Reason, nullUUID(createdBy))
		return e
	}
	if kind == "warehouse" {
		return r.noBumpTx(ctx, work)
	}
	return r.bumpOutletTx(ctx, locID, work)
}

// SetOutletPar upserts ONLY par_level for one (outlet, product, variant),
// preserving stock + available. Bumps the outlet version (cheap; future-proofs
// any POS low-stock consumer). par == nil clears the threshold.
func (r *Repo) SetOutletPar(ctx context.Context, outletID, productID, variantSize string, par *int) error {
	return r.bumpOutletTx(ctx, outletID, func(t pgx.Tx) error {
		_, e := t.Exec(ctx,
			`INSERT INTO outlet_variant_stock (outlet_id, product_id, variant_size, par_level)
			 VALUES ($1,$2,$3,$4)
			 ON CONFLICT (outlet_id, product_id, variant_size) DO UPDATE SET par_level=EXCLUDED.par_level`,
			outletID, productID, variantSize, par)
		return e
	})
}
```

- [ ] **Step 2: Build**

Run: `cd backend && gofmt -w internal/ && go build ./...`
Expected: builds clean.

- [ ] **Step 3: Commit**

```bash
git add backend/internal/write/warehouse.go
git commit -m "feat(write): location-polymorphic goods-in/koreksi + outlet PAR (outlet writes bump version)"
```

### Task A4: Overview matrix read

**Files:**
- Modify: `backend/internal/read/repo.go` (add `InventoryOverview`; add `parLevel` to the outlet branch of `LocationStock`)

- [ ] **Step 1: Add `parLevel` to the outlet branch of `LocationStock`**

In `LocationStock` (repo.go:958), change the outlet-branch query's `json_build_object` to also emit `parLevel`:

```go
	rows, _, err := listJSON[api.WarehouseStockRow](ctx, r.Pool, `
		SELECT json_build_object(
		  'productId', v.product_id, 'productName', p.name, 'variantSize', v.size,
		  'sku', v.sku,
		  'stock', COALESCE((SELECT s.stock FROM outlet_variant_stock s
		     WHERE s.outlet_id=$1 AND s.product_id=v.product_id AND s.variant_size=v.size),0),
		  'parLevel', (SELECT s.par_level FROM outlet_variant_stock s
		     WHERE s.outlet_id=$1 AND s.product_id=v.product_id AND s.variant_size=v.size))
		FROM product_variants v JOIN products p ON p.id=v.product_id
		ORDER BY p.name, v.size`, id)
	return rows, err
```
(The warehouse branch returns no `parLevel`; the field is nullable — see A5.)

- [ ] **Step 2: Add the `InventoryOverview` read**

Append to `backend/internal/read/repo.go`:

```go
// InventoryOverview returns the read-only product-stock matrix: every active
// location (outlets then warehouses) × every active product variant, with a
// per-row total and a per-outlet-cell belowPar flag for low-stock highlighting.
func (r *Repo) InventoryOverview(ctx context.Context) (api.InventoryOverviewResponse, error) {
	var resp api.InventoryOverviewResponse

	// 1) Locations (outlets first, then warehouses), active only.
	lrows, err := r.Pool.Query(ctx, `
		SELECT id::text, 'outlet' AS kind, name FROM outlets WHERE is_active
		UNION ALL
		SELECT id::text, 'warehouse' AS kind, name FROM warehouses WHERE is_active
		ORDER BY kind DESC, name`) // 'outlet' > 'warehouse' so outlets sort first
	if err != nil {
		return resp, err
	}
	defer lrows.Close()
	for lrows.Next() {
		var l api.InventoryOverviewLocation
		if err := lrows.Scan(&l.Id, &l.Kind, &l.Name); err != nil {
			return resp, err
		}
		resp.Locations = append(resp.Locations, l)
	}
	if err := lrows.Err(); err != nil {
		return resp, err
	}

	// 2) Per-(variant, location) stock + outlet par_level, assembled in memory.
	type cellKey struct{ pid, size, loc string }
	stockByCell := map[cellKey]int{}
	parByCell := map[cellKey]*int{}

	orows, err := r.Pool.Query(ctx,
		`SELECT product_id::text, variant_size, outlet_id::text, stock, par_level FROM outlet_variant_stock`)
	if err != nil {
		return resp, err
	}
	for orows.Next() {
		var pid, size, loc string
		var stock int
		var par *int
		if err := orows.Scan(&pid, &size, &loc, &stock, &par); err != nil {
			orows.Close()
			return resp, err
		}
		k := cellKey{pid, size, loc}
		stockByCell[k] = stock
		parByCell[k] = par
	}
	orows.Close()
	if err := orows.Err(); err != nil {
		return resp, err
	}

	wrows, err := r.Pool.Query(ctx,
		`SELECT product_id::text, variant_size, warehouse_id::text, stock FROM warehouse_variant_stock`)
	if err != nil {
		return resp, err
	}
	for wrows.Next() {
		var pid, size, loc string
		var stock int
		if err := wrows.Scan(&pid, &size, &loc, &stock); err != nil {
			wrows.Close()
			return resp, err
		}
		stockByCell[cellKey{pid, size, loc}] = stock
	}
	wrows.Close()
	if err := wrows.Err(); err != nil {
		return resp, err
	}

	// 3) Rows = active product variants (full catalog).
	vrows, err := r.Pool.Query(ctx, `
		SELECT v.product_id::text, p.name, v.size, COALESCE(v.sku,'')
		FROM product_variants v JOIN products p ON p.id=v.product_id
		WHERE p.is_active
		ORDER BY p.name, v.size`)
	if err != nil {
		return resp, err
	}
	defer vrows.Close()
	for vrows.Next() {
		var row api.InventoryOverviewRow
		var pid, name, size, sku string
		if err := vrows.Scan(&pid, &name, &size, &sku); err != nil {
			return resp, err
		}
		row.ProductId = pid
		row.ProductName = name
		row.VariantSize = size
		row.Sku = sku
		total := 0
		for _, l := range resp.Locations {
			k := cellKey{pid, size, l.Id}
			stock := stockByCell[k]
			total += stock
			cell := api.InventoryOverviewCell{LocationId: l.Id, Stock: stock}
			if l.Kind == "outlet" {
				if par := parByCell[k]; par != nil && stock <= *par {
					bp := true
					cell.BelowPar = &bp
				}
			}
			row.Cells = append(row.Cells, cell)
		}
		row.Total = total
		resp.Rows = append(resp.Rows, row)
	}
	if err := vrows.Err(); err != nil {
		return resp, err
	}
	return resp, nil
}
```
> NOTE (flag): field accessors (`l.Id` vs `l.ID`, `.Kind`, `.BelowPar` pointer vs value) are generated by oapi-codegen from the schema in A5. After A5 regen, adjust these names to match the generated structs if codegen differs (oapi-codegen typically maps `id`→`Id`, `belowPar`→`BelowPar *bool`). Build will tell you.

- [ ] **Step 3: Defer build to A5** (the `api.InventoryOverview*` types don't exist until OpenAPI regen). Commit after A5 builds.

### Task A5: OpenAPI — new paths/schemas, regen Go + TS, TS client methods

**Files:**
- Modify: `backend/api/openapi.yaml`
- Modify: `backend/internal/api/api.gen.go` (generated)
- Modify: `packages/api/src/schema.d.ts` (generated)
- Modify: `packages/api/src/client.ts`

- [ ] **Step 1: Add `parLevel` to `WarehouseStockRow` schema**

In `backend/api/openapi.yaml`, the `WarehouseStockRow` schema → add under `properties`:
```yaml
    parLevel: { type: integer, nullable: true }
```

- [ ] **Step 2: Add the new paths** (place near the other `manage_inventory` paths)

```yaml
  /api/v1/inventory/goods-receipt:
    post:
      operationId: createLocationGoodsReceipt
      tags: [catalog]
      summary: Receive goods into an outlet OR warehouse (Backoffice)
      parameters:
        - { name: kind, in: query, required: true, schema: { type: string, enum: [outlet, warehouse] } }
        - { name: id, in: query, required: true, schema: { type: string, format: uuid } }
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/GoodsReceiptInput' }
      responses:
        '200': { description: ok, content: { application/json: { schema: { $ref: '#/components/schemas/OkResponse' } } } }
        '400': { $ref: '#/components/responses/BadRequest' }
  /api/v1/inventory/adjust:
    post:
      operationId: adjustLocationStock
      tags: [catalog]
      summary: Adjust an outlet OR warehouse stock to a new quantity (Backoffice)
      parameters:
        - { name: kind, in: query, required: true, schema: { type: string, enum: [outlet, warehouse] } }
        - { name: id, in: query, required: true, schema: { type: string, format: uuid } }
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/WarehouseAdjustInput' }
      responses:
        '200': { description: ok, content: { application/json: { schema: { $ref: '#/components/schemas/OkResponse' } } } }
        '400': { $ref: '#/components/responses/BadRequest' }
  /api/v1/inventory/outlet-par:
    put:
      operationId: setOutletPar
      tags: [catalog]
      summary: Set the per-variant low-stock (PAR) threshold for an outlet (Backoffice)
      parameters:
        - { name: id, in: query, required: true, schema: { type: string, format: uuid } }
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/OutletParInput' }
      responses:
        '200': { description: ok, content: { application/json: { schema: { $ref: '#/components/schemas/OkResponse' } } } }
        '400': { $ref: '#/components/responses/BadRequest' }
  /api/v1/inventory/overview:
    get:
      operationId: getInventoryOverview
      tags: [catalog]
      summary: Read-only product-stock matrix across all locations (Backoffice)
      responses:
        '200':
          description: overview matrix
          content:
            application/json:
              schema: { $ref: '#/components/schemas/InventoryOverviewResponse' }
```
> If a `BadRequest` response component doesn't exist, reuse the inline `OkResponse` pattern other 400-returning paths use, or check existing `#/components/responses` and match. (Flag: confirm the exact `responses` ref names already in the file.)

- [ ] **Step 3: Add the new schemas** (under `components.schemas`)

```yaml
    OutletParInput:
      type: object
      required: [productId, variantSize]
      properties:
        productId: { type: string, format: uuid }
        variantSize: { type: string }
        parLevel: { type: integer, nullable: true }
    InventoryOverviewLocation:
      type: object
      required: [id, kind, name]
      properties:
        id: { type: string, format: uuid }
        kind: { type: string, enum: [outlet, warehouse] }
        name: { type: string }
    InventoryOverviewCell:
      type: object
      required: [locationId, stock]
      properties:
        locationId: { type: string, format: uuid }
        stock: { type: integer }
        belowPar: { type: boolean, nullable: true }
    InventoryOverviewRow:
      type: object
      required: [productId, productName, variantSize, total, cells]
      properties:
        productId: { type: string, format: uuid }
        productName: { type: string }
        variantSize: { type: string }
        sku: { type: string }
        total: { type: integer }
        cells: { type: array, items: { $ref: '#/components/schemas/InventoryOverviewCell' } }
    InventoryOverviewResponse:
      type: object
      required: [locations, rows]
      properties:
        locations: { type: array, items: { $ref: '#/components/schemas/InventoryOverviewLocation' } }
        rows: { type: array, items: { $ref: '#/components/schemas/InventoryOverviewRow' } }
```

- [ ] **Step 4: Regenerate Go + TS**

Run:
```bash
cd backend && go tool oapi-codegen -config api/oapi-codegen.yaml api/openapi.yaml && cd ..
corepack pnpm --filter @mandalika/api gen
```
Expected: `api.gen.go` + `packages/api/src/schema.d.ts` updated with the new types. Reconcile A4's `InventoryOverview` field names to the generated struct (see A4 flag) and `go build ./...`.

- [ ] **Step 5: Add TS client methods**

In `packages/api/src/client.ts`, add the interface entries + implementations (mirror existing `getWarehouseStock` / `createGoodsReceipt` for the `request`/`data` helpers):

```ts
// interface (near the inventory section)
createLocationGoodsReceipt: (loc: { kind: 'outlet' | 'warehouse'; id: string }, input: GoodsReceiptInput) => Promise<void>
adjustLocationStock: (loc: { kind: 'outlet' | 'warehouse'; id: string }, input: WarehouseAdjustInput) => Promise<void>
setOutletPar: (outletId: string, input: OutletParInput) => Promise<void>
getInventoryOverview: () => Promise<InventoryOverviewResponse>
```
```ts
// impls
createLocationGoodsReceipt: async (loc, input) => {
  await request('POST', `/inventory/goods-receipt?kind=${loc.kind}&id=${loc.id}`, input)
},
adjustLocationStock: async (loc, input) => {
  await request('POST', `/inventory/adjust?kind=${loc.kind}&id=${loc.id}`, input)
},
setOutletPar: async (outletId, input) => {
  await request('PUT', `/inventory/outlet-par?id=${outletId}`, input)
},
getInventoryOverview: () => data<InventoryOverviewResponse>('GET', '/inventory/overview'),
```
Add the type re-exports near the others: `export type OutletParInput = S['OutletParInput']`, `export type InventoryOverviewResponse = S['InventoryOverviewResponse']`, `export type InventoryOverviewRow = S['InventoryOverviewRow']`, `export type InventoryOverviewLocation = S['InventoryOverviewLocation']`.
> Match the existing `request`/`data` helper names exactly (check how `getWarehouseStock` unwraps `{data}` — it uses `data<…>`; `createGoodsReceipt` uses the raw `request`). The overview is `{locations,rows}` (no `data` envelope) → confirm whether to use `data<>` or `request`; the handler in A6 wraps it bare, so use a non-unwrapping fetch. (Flag: align with the gold-tint endpoint precedent in `client.ts` which used raw `request` for a bare body.)

- [ ] **Step 6: Build TS**

Run: `corepack pnpm --filter @mandalika/api exec tsc --noEmit`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add backend/api/openapi.yaml backend/internal/api/api.gen.go backend/internal/read/repo.go packages/api/src/schema.d.ts packages/api/src/client.ts
git commit -m "feat(api): inventory location goods-in/koreksi/PAR + overview matrix (OpenAPI + Go read + TS client)"
```

### Task A6: Handlers + routes

**Files:**
- Modify: `backend/internal/handlers/writes.go` (new handlers)
- Modify: `backend/internal/server/server.go` (new routes)

- [ ] **Step 1: Add handlers**

Append to `backend/internal/handlers/writes.go`:

```go
func locTarget(r *http.Request) (kind, id string, ok bool) {
	kind = r.URL.Query().Get("kind")
	id = r.URL.Query().Get("id")
	return kind, id, (kind == "warehouse" || kind == "outlet") && id != ""
}

func (h *Handlers) CreateLocationGoodsReceipt(w http.ResponseWriter, r *http.Request) {
	kind, id, ok := locTarget(r)
	if !ok {
		httpx.Err(w, http.StatusBadRequest, "kind ('outlet'/'warehouse') dan id wajib")
		return
	}
	g, ok := decodeWrite[write.GoodsReceipt](w, r)
	if !ok {
		return
	}
	c, _ := h.caller(r)
	h.mutated(w, r, h.Write.CreateLocationGoodsReceipt(r.Context(), kind, id, c.userID, g))
}

func (h *Handlers) AdjustLocationStock(w http.ResponseWriter, r *http.Request) {
	kind, id, ok := locTarget(r)
	if !ok {
		httpx.Err(w, http.StatusBadRequest, "kind ('outlet'/'warehouse') dan id wajib")
		return
	}
	a, ok := decodeWrite[write.WarehouseAdjust](w, r)
	if !ok {
		return
	}
	c, _ := h.caller(r)
	h.mutated(w, r, h.Write.AdjustLocationStock(r.Context(), kind, id, c.userID, a))
}

func (h *Handlers) SetOutletPar(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	if id == "" {
		httpx.Err(w, http.StatusBadRequest, "id outlet wajib")
		return
	}
	body, ok := decodeWrite[api.OutletParInput](w, r)
	if !ok {
		return
	}
	var par *int
	if v, e := body.ParLevel.Get(); e == nil {
		vv := v
		par = &vv
	}
	h.mutated(w, r, h.Write.SetOutletPar(r.Context(), id, body.ProductId.String(), body.VariantSize, par))
}

func (h *Handlers) InventoryOverview(w http.ResponseWriter, r *http.Request) {
	resp, err := h.Repo.InventoryOverview(r.Context())
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, http.StatusOK, resp)
}
```
> Flag: confirm the generated `OutletParInput` field types — `ParLevel` may be a nullable wrapper (`.Get()`) or `*int`, and `ProductId` may be `openapi_types.UUID` (`.String()`) or `string`. Adjust the extraction to match the generated struct. If `decodeWrite` expects a `write.*` type rather than an `api.*` type, add a tiny `write.OutletPar` struct mirroring the JSON and decode that instead.

- [ ] **Step 2: Register routes** in the `manage_inventory` group in `backend/internal/server/server.go` (the group at ~line 170):

```go
		r.Post("/inventory/goods-receipt", h.CreateLocationGoodsReceipt)
		r.Post("/inventory/adjust", h.AdjustLocationStock)
		r.Put("/inventory/outlet-par", h.SetOutletPar)
		r.Get("/inventory/overview", h.InventoryOverview)
```

- [ ] **Step 3: Build + test + gen-check**

Run: `cd backend && gofmt -w internal/ && go build ./... && go test ./... && make gen-check && cd ..`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add backend/internal/handlers/writes.go backend/internal/server/server.go
git commit -m "feat(api): wire inventory location stock-op handlers + routes (manage_inventory)"
```

### Task A7: Deploy + live API verification

- [ ] **Step 1: Deploy** (background)

Run: `gcloud run deploy mandalika-pos --source backend --region asia-southeast2 --quiet`
Then: `curl -s https://mandalika-pos-538849926142.asia-southeast2.run.app/readyz` → expect ok.

- [ ] **Step 2: Verify outlet goods-in + koreksi via authed API** (use an admin JWT; pick a real outletId + product/variant)

- Goods-in 0→N to an outlet → 200; `getTransferLocationStock(outlet, id)` shows the new stock.
- Koreksi to M with reason → 200; stock == M; `available` + `par_level` unchanged on that row (query to confirm).
- Koreksi without reason → 400 "alasan wajib diisi"; negative → 400.
- Warehouse goods-in/koreksi via the new `/inventory/*` endpoints → still works, stock correct.
- `getInventoryOverview` → locations include the outlet + warehouse; the row's `total` == sum of cells; a below-PAR outlet cell has `belowPar:true`.

- [ ] **Step 3: Verify POS resync signal** — confirm the affected outlet's `content_versions.version` for `products` incremented after the outlet koreksi (a POS pull would now re-sync). Warehouse koreksi must NOT bump.

- [ ] **Step 4: Record findings** in the session handoff notes (rule 5: show changes). If anything fails, STOP and investigate (rule 4) — do not proceed to Phase B.

---

# Phase B — Backend: decouple stock from the product-config write

### Task B1: New write-input schema (price + availability only)

**Files:**
- Modify: `backend/api/openapi.yaml`
- Modify: generated Go + TS (regen)

- [ ] **Step 1: Add `OutletConfigItemInput` + change `OutletConfigInput.items` to use it**

```yaml
    OutletConfigItemInput:
      type: object
      required: [outletId, variantSize, available]
      properties:
        outletId: { type: string, format: uuid }
        variantSize: { type: string }
        # null = use the variant's base price (no per-outlet override)
        price: { type: number, nullable: true }
        available: { type: boolean }
    OutletConfigInput:
      type: object
      required: [items]
      properties:
        items: { type: array, items: { $ref: '#/components/schemas/OutletConfigItemInput' } }
```
Leave `OutletConfigResponse` + `OutletVariantConfig` (the READ shape with `stock`/`parLevel`) unchanged — the modal still reads price/availability from it and ignores stock/parLevel.

- [ ] **Step 2: Regen Go + TS**

Run: `cd backend && go tool oapi-codegen -config api/oapi-codegen.yaml api/openapi.yaml && cd .. && corepack pnpm --filter @mandalika/api gen`

- [ ] **Step 3: Commit** (build will fail until B2 — commit after B2.)

### Task B2: `SetProductOutletConfig` writes only price + availability

**Files:**
- Modify: `backend/internal/write/repo.go:329-395` (`SetProductOutletConfig`)
- Modify: `backend/internal/handlers/` (the `PutProductOutletConfig` handler signature if the input type name changed)

- [ ] **Step 1: Rewrite the upsert to never touch stock or par_level**

Replace the `outlet_variant_stock` upsert in `SetProductOutletConfig` so it sets ONLY `available` (preserving stock + par_level), and accept the new `OutletConfigItemInput` items:

```go
func (r *Repo) SetProductOutletConfig(ctx context.Context, productID string, items []api.OutletConfigItemInput) error {
	t, err := r.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer t.Rollback(ctx)

	seen := map[string]bool{}
	var outletIDs []string
	for _, it := range items {
		oid := it.OutletId.String()
		if !seen[oid] {
			seen[oid] = true
			outletIDs = append(outletIDs, oid)
		}
		// availability only — stock + par_level are owned by Inventori now.
		if _, e := t.Exec(ctx, `
			INSERT INTO outlet_variant_stock (outlet_id, product_id, variant_size, available)
			VALUES ($1,$2,$3,$4)
			ON CONFLICT (outlet_id, product_id, variant_size)
			  DO UPDATE SET available=EXCLUDED.available`,
			oid, productID, it.VariantSize, it.Available); e != nil {
			return e
		}
		if v, e := it.Price.Get(); e == nil {
			if _, e := t.Exec(ctx, `
				INSERT INTO outlet_variant_price (outlet_id, product_id, variant_size, price)
				VALUES ($1,$2,$3,$4)
				ON CONFLICT (outlet_id, product_id, variant_size) DO UPDATE SET price=EXCLUDED.price`,
				oid, productID, it.VariantSize, v); e != nil {
				return e
			}
		} else if _, e := t.Exec(ctx, `
			DELETE FROM outlet_variant_price
			WHERE outlet_id=$1 AND product_id=$2 AND variant_size=$3`,
			oid, productID, it.VariantSize); e != nil {
			return e
		}
	}
	// Orphan cleanup for removed/renamed variant sizes stays (a removed variant
	// should lose its stock + price rows).
	sizes := make([]string, 0, len(items))
	seenSize := map[string]bool{}
	for _, it := range items {
		if !seenSize[it.VariantSize] {
			seenSize[it.VariantSize] = true
			sizes = append(sizes, it.VariantSize)
		}
	}
	if _, e := t.Exec(ctx,
		`DELETE FROM outlet_variant_stock WHERE product_id=$1 AND variant_size <> ALL($2::text[])`,
		productID, sizes); e != nil {
		return e
	}
	if _, e := t.Exec(ctx,
		`DELETE FROM outlet_variant_price WHERE product_id=$1 AND variant_size <> ALL($2::text[])`,
		productID, sizes); e != nil {
		return e
	}
	if e := bumpVersionOutlets(ctx, t, "products", outletIDs); e != nil {
		return fmt.Errorf("bump version: %w", e)
	}
	return t.Commit(ctx)
}
```

- [ ] **Step 2: Update the `PutProductOutletConfig` handler** to decode the new input type (it likely already passes `body.Items` through — update the type param of `decodeWrite`/the schema reference so it compiles against `api.OutletConfigItemInput`).

- [ ] **Step 3: Build + test + gen-check**

Run: `cd backend && gofmt -w internal/ && go build ./... && go test ./... && make gen-check && cd ..`
Expected: pass. (`go vet` clean.)

- [ ] **Step 4: Commit**

```bash
git add backend/api/openapi.yaml backend/internal/api/api.gen.go backend/internal/write/repo.go backend/internal/handlers packages/api/src/schema.d.ts packages/api/src/client.ts
git commit -m "feat(api): decouple stock/PAR from product outlet-config write (price+availability only)"
```

- [ ] **Step 5: Deploy + verify** — save a product's outlet config (price+availability) via API, then confirm the outlet's `stock` + `par_level` for that variant are UNCHANGED. Then change stock via `/inventory/adjust` and re-save the product config → stock still intact. (rule 4: if stock gets zeroed, stop and fix.)

---

# Phase C — Backoffice: generalize modals + build Stok Produk

### Task C1: Generalize GoodsInModal + AdjustModal to a location target

**Files:**
- Modify: `apps/backoffice/src/screens/warehouses/GoodsInModal.tsx`
- Modify: `apps/backoffice/src/screens/warehouses/AdjustModal.tsx`

- [ ] **Step 1: Change the prop type + API call in `GoodsInModal.tsx`**

Replace `warehouse: Warehouse` with a `location: { kind: 'outlet' | 'warehouse'; id: string; name: string }`. Change the API call from `api.createGoodsReceipt(warehouse.id, body)` to `api.createLocationGoodsReceipt({ kind: location.kind, id: location.id }, body)`. Update any `warehouse.name`/`warehouse.id` references to `location.*`.

- [ ] **Step 2: Same generalization in `AdjustModal.tsx`**

Replace `warehouse: Warehouse` with `location: { kind; id; name }`; change `api.adjustWarehouseStock(warehouse.id, {...})` → `api.adjustLocationStock({ kind: location.kind, id: location.id }, {...})`.

- [ ] **Step 3: Typecheck**

Run: `corepack pnpm --filter @mandalika/backoffice exec tsc --noEmit`
Expected: errors ONLY at the existing call sites in `Warehouses.tsx` (fixed in C2). Note them.

- [ ] **Step 4: Commit** (after C2 so the app compiles — or commit modals + C2 together).

### Task C2: Build the Stok Produk → Lokasi sub-view

**Files:**
- Create: `apps/backoffice/src/screens/inventory/StokProduk.tsx`
- Create: `apps/backoffice/src/screens/inventory/LocationStockView.tsx`
- Reference: existing `apps/backoffice/src/screens/Warehouses.tsx` `WarehouseList` + `StockView` (lines 85-496) — port their structure.

- [ ] **Step 1: `LocationStockView.tsx`** — generalization of the existing `StockView`. Props: `{ location: { kind: 'outlet'|'warehouse'; id: string; name: string }; onBack: () => void }`. It:
  - fetches `api.getTransferLocationStock(location.kind, location.id)` (returns `WarehouseStockRow[]` now incl. nullable `parLevel`).
  - renders the stock table (Produk · Ukuran · SKU · Stok · [PAR for outlets] · Aksi) — copy the table markup from `StockView` (Warehouses.tsx:435-476).
  - "Barang Masuk" → `<GoodsInModal location={location} …/>`; per-row "Koreksi" → `<AdjustModal location={location} …/>` (the C1-generalized modals).
  - **PAR column (outlets only):** show an inline-editable PAR per row. On blur/save call `api.setOutletPar(location.id, { productId: r.productId, variantSize: r.variantSize, parLevel })` then refetch. Low-stock badge when `r.stock <= (r.parLevel ?? 0)` and `r.parLevel != null` (red), matching the existing `r.stock <= 5 ? 'danger'` pattern but PAR-driven.

  Representative PAR cell (inside the row map, only when `location.kind === 'outlet'`):
```tsx
<td className="px-5 py-3">
  <input
    type="number"
    defaultValue={r.parLevel ?? ''}
    placeholder="—"
    title="Batas stok menipis (PAR)"
    onBlur={async (e) => {
      const v = e.target.value === '' ? null : Number(e.target.value)
      await api.setOutletPar(location.id, { productId: r.productId, variantSize: r.variantSize, parLevel: v })
      await sq.refetch()
    }}
    className={`${fieldClass} w-20 py-1.5`}
  />
</td>
```

- [ ] **Step 2: `StokProduk.tsx`** — owns the **Lokasi ⇄ Overview** sub-tabs and the location list. The location list groups Outlet + Gudang (mirror the `StockCount.tsx` optgroup pattern, lines 265-274). Fetch `api.listOutlets()` + `api.listWarehouses()`. Clicking a location sets `selected = { kind, id, name }` → renders `<LocationStockView location={selected} onBack={…}/>`. Default sub-tab = Lokasi. (Overview added in C3.)

  Location list (list view, no selection) — grouped sections, each row `onClick={() => setSelected({kind, id, name})}`:
```tsx
<div>
  <p className="text-xs font-black text-gray-400 uppercase mb-2">Outlet</p>
  {outlets.map((o) => (
    <button key={o.id} onClick={() => setSelected({ kind: 'outlet', id: o.id, name: o.name })}
      className="w-full text-left px-4 py-3 rounded-xl hover:bg-gray-50 flex items-center gap-3">
      <Store className="w-4 h-4 text-gold-600" /> <span className="font-bold text-sm">{o.name}</span>
    </button>
  ))}
  <p className="text-xs font-black text-gray-400 uppercase mt-4 mb-2">Gudang</p>
  {warehouses.map((w) => (
    <button key={w.id} onClick={() => setSelected({ kind: 'warehouse', id: w.id, name: w.name })}
      className="w-full text-left px-4 py-3 rounded-xl hover:bg-gray-50 flex items-center gap-3">
      <Warehouse className="w-4 h-4 text-gold-600" /> <span className="font-bold text-sm">{w.name}</span>
    </button>
  ))}
</div>
```

- [ ] **Step 3: Typecheck + visual smoke**

Run: `corepack pnpm --filter @mandalika/backoffice exec tsc --noEmit` → clean.
Run the dev server (`corepack pnpm --filter @mandalika/backoffice dev`) and confirm the new view renders without console errors (wired into the tab in D1; for now you can temporarily mount `<StokProduk/>` to eyeball).

- [ ] **Step 4: Commit**

```bash
git add apps/backoffice/src/screens/warehouses/GoodsInModal.tsx apps/backoffice/src/screens/warehouses/AdjustModal.tsx apps/backoffice/src/screens/inventory/StokProduk.tsx apps/backoffice/src/screens/inventory/LocationStockView.tsx
git commit -m "feat(backoffice): Stok Produk location-first view (outlets+warehouses) with goods-in/koreksi/PAR"
```

### Task C3: Build the Overview matrix sub-view

**Files:**
- Create: `apps/backoffice/src/screens/inventory/OverviewMatrix.tsx`
- Modify: `apps/backoffice/src/screens/inventory/StokProduk.tsx` (add the Overview sub-tab)

- [ ] **Step 1: `OverviewMatrix.tsx`** — fetch `api.getInventoryOverview()`. Render a table: sticky first column (Varian = `productName variantSize`), one column per `locations[]` (header shows name; outlet vs warehouse icon), a sticky Total column. Each cell = `cells.find(c => c.locationId === loc.id)?.stock ?? 0`; red text when that cell's `belowPar`. Click a column header → call a prop `onPickLocation(loc)` that switches StokProduk to Lokasi with that location selected; click a row → (optional) highlight. Wrap in `overflow-x-auto`.

  Representative cell coloring:
```tsx
<td className={`px-3 py-2 text-center ${cell?.belowPar ? 'text-red-600 font-bold' : ''}`}>{cell?.stock ?? 0}</td>
```

- [ ] **Step 2: Wire the sub-tab** in `StokProduk.tsx` — a small Lokasi/Overview toggle; Overview renders `<OverviewMatrix onPickLocation={(loc) => { setSubTab('lokasi'); setSelected(loc) }} />`.

- [ ] **Step 3: Typecheck + smoke**

Run: `corepack pnpm --filter @mandalika/backoffice exec tsc --noEmit` → clean; eyeball the matrix renders with totals + low-stock coloring.

- [ ] **Step 4: Commit**

```bash
git add apps/backoffice/src/screens/inventory/OverviewMatrix.tsx apps/backoffice/src/screens/inventory/StokProduk.tsx
git commit -m "feat(backoffice): read-only Overview stock matrix (variant × location) with drill-through"
```

---

# Phase D — Backoffice: module restructure + product modal

### Task D1: Rename Gudang → Inventori, fold in Opname, perm gating

**Files:**
- Modify: `apps/backoffice/src/App.tsx`
- Modify: `apps/backoffice/src/screens/Warehouses.tsx` (the `Gudang` shell → tabs)

- [ ] **Step 1: App.tsx nav** — in the `NAV` array: rename the `warehouses` entry `label: 'Gudang'` → `label: 'Inventori'`; **remove** the standalone `{ id: 'stock', label: 'Stock Count', … }` entry. Because Opname now lives inside Inventori (gated `manage_stock_count`), make the Inventori item reachable by either permission. Change the `visible` filter so the `warehouses` (Inventori) item shows when the user has `manage_inventory` OR `manage_stock_count`:

```tsx
const visible = useMemo(() => {
  if (!user) return []
  const isAdmin = user.role === 'admin'
  const perms = user.permissions || []
  return NAV.filter((n) => {
    if (isAdmin) return true
    if (n.id === 'warehouses') return perms.includes('manage_inventory') || perms.includes('manage_stock_count')
    return perms.includes(n.perm)
  })
}, [user])
```
> Flag: confirm no other code references the removed nav id `'stock'` (search). The `StockCount` import moves into `Warehouses.tsx`.

- [ ] **Step 2: Warehouses.tsx shell** — change `GudangTab` to `'stok' | 'transfer' | 'bahan' | 'opname'`; default `'stok'`. `BASE_TABS` → `[{id:'stok',label:'Stok Produk'},{id:'transfer',label:'Transfer'}]`; keep the conditional `bahan` (recipesEnabled); add `{id:'opname',label:'Opname'}`. Render: `tab==='stok' && <StokProduk/>`, `tab==='transfer' && <Transfers/>`, `tab==='bahan' && <Ingredients/>`, `tab==='opname' && <StockCount/>`. Import `StokProduk` from `./inventory/StokProduk` and `StockCount` from `./StockCount`. Remove the old `WarehouseList`/`StockView` from this file (now superseded by `StokProduk`/`LocationStockView`) — or keep `StockView`'s logic only if still referenced (it isn't after C2). Update the page title to "Inventori".
> Per-tab perm gating: the module is reached via the nav gate (Step 1). Within, only show the Opname tab when the user is admin OR has `manage_stock_count`, and Stok Produk/Transfer when admin OR `manage_inventory`. Add a small `useOutlet()`/auth check or pass perms down; if a stock-count-only user opens Inventori, default the active tab to `opname`.

- [ ] **Step 3: Typecheck + build**

Run: `corepack pnpm --filter @mandalika/backoffice exec tsc --noEmit && corepack pnpm --filter @mandalika/backoffice build`
Expected: clean. Dead-code check: the old `WarehouseList`/`StockView` are removed and not imported anywhere.

- [ ] **Step 4: Commit**

```bash
git add apps/backoffice/src/App.tsx apps/backoffice/src/screens/Warehouses.tsx
git commit -m "feat(backoffice): rename Gudang→Inventori, fold Opname tab in, perm-gate tabs"
```

### Task D2: Slim the product modal + remove create-time Stok

**Files:**
- Modify: `apps/backoffice/src/screens/Products.tsx`

- [ ] **Step 1: Remove Stok + PAR from the per-outlet matrix** — in the "Stok & Harga per Outlet" section (Products.tsx ~715-770): delete the Stok input column (`ocSet(... stock ...)`, line ~763) and the PAR input column (line ~765) and their headers (line ~751). Keep the Harga + Jual (available) inputs. Rename the section heading/label to **"Harga & Ketersediaan per Outlet"**. Update the `OcRow` type to drop `stock`/`parLevel` if no longer read (the read still returns them; just don't render). 

- [ ] **Step 2: Switch the save payload to price+availability only** — where the modal builds the `updateProductOutletConfig` items, send `OutletConfigItemInput` shape `{ outletId, variantSize, price, available }` (drop `stock`, `parLevel`). Confirm `api.updateProductOutletConfig` now types against the new item shape (from B1 regen).

- [ ] **Step 3: Remove the base Stok field at create** — remove `stock` from `EMPTY_VARIANT` (line 31) and from the variant row inputs in the create/edit form; remove the `stock: Number(v.stock)` from the create payload (line ~247) and the `stock: c.stock` mapping if present (line ~263). Remove/repoint the helper note "Stok diatur per outlet…" (lines ~667-668) to "Stok diatur di menu Inventori." Update the CSV import (`stock: parseInt(row['Stok'])`, line ~337) and CSV export (`Stok: v.stock`, line ~295) + template (lines 312-313) to drop the `Stok` column.
> Flag: the product create/update API still has a `stock` on the variant schema (base `product_variants.stock`). Leaving it sent as 0 is harmless; cleanest is to stop sending it. Confirm the backend product write tolerates an omitted/zero variant stock (it does — stock now flows only through Inventori). Note this in the handoff.

- [ ] **Step 4: Typecheck + build + visual**

Run: `corepack pnpm --filter @mandalika/backoffice exec tsc --noEmit && corepack pnpm --filter @mandalika/backoffice build`
Then dev-server: open a product → the matrix shows only Harga + Jual; create form has no Stok field; saving doesn't error.

- [ ] **Step 5: Commit**

```bash
git add apps/backoffice/src/screens/Products.tsx
git commit -m "feat(backoffice): product modal keeps Harga+Jual only; stock/PAR live in Inventori; drop create Stok field + CSV Stok column"
```

---

# Phase E — Cleanup + full verification

### Task E1: Remove the superseded warehouse-only stock endpoints

**Files:**
- Modify: `backend/internal/server/server.go` (remove 2 routes)
- Modify: `backend/internal/handlers/writes.go` (remove `CreateGoodsReceipt`, `AdjustWarehouseStock`)
- Modify: `backend/internal/write/warehouse.go` (remove old `CreateGoodsReceipt`, `AdjustWarehouseStock`)
- Modify: `backend/api/openapi.yaml` (remove the 2 warehouse paths) + regen
- Modify: `packages/api/src/client.ts` (remove `createGoodsReceipt`, `adjustWarehouseStock`)

- [ ] **Step 1: Confirm zero remaining callers** — search the backoffice + POS for `createGoodsReceipt(` and `adjustWarehouseStock(`. Expected: none (C1 migrated them). If any remain, fix first.

- [ ] **Step 2: Remove** the routes, handlers, write funcs, OpenAPI paths (`/warehouses/{id}/goods-receipt`, `/warehouses/{id}/adjust`), and TS client methods. Keep `getWarehouseStock` (still used by `LocationStock`'s warehouse branch via `WarehouseStock`).

- [ ] **Step 3: Build + test + gen-check + tsc**

Run:
```bash
cd backend && gofmt -w internal/ && go build ./... && go test ./... && make gen-check && cd ..
corepack pnpm --filter @mandalika/api exec tsc --noEmit
corepack pnpm --filter @mandalika/backoffice exec tsc --noEmit
```
Expected: all clean.

- [ ] **Step 4: Commit**

```bash
git add backend/ packages/api/src/client.ts
git commit -m "refactor: drop superseded warehouse-only goods-in/adjust endpoints (replaced by /inventory/*)"
```

### Task E2: Deploy + full live + UI verification

- [ ] **Step 1: Deploy backend** + `/readyz` ok. Push branch (Cloudflare auto-deploys backoffice).

- [ ] **Step 2: Backoffice UI walkthrough** (admin login on `mandalika-pos.pages.dev`, hard-refresh):
  - Nav shows **Inventori** (no standalone "Stock Count").
  - Inventori tabs: **Stok Produk · Transfer · Bahan** (if recipesEnabled) **· Opname**.
  - Stok Produk → Lokasi: location list groups Outlet + Gudang; drill into an **outlet** → stock table; **Barang Masuk** adds stock; **Koreksi** sets absolute + reason; **PAR** inline edit persists (outlets only); low-stock row turns red.
  - Drill into a **warehouse** → same ops, no PAR column.
  - Stok Produk → Overview: matrix renders, totals correct, below-PAR cells red, clicking a location header jumps to its Lokasi view.
  - Opname tab works (create→start→count→complete) for both outlet + warehouse.
  - Produk → Edit: matrix shows only **Harga + Jual** (no Stok/PAR); create form has no Stok field; CSV template has no Stok column; saving a product does NOT change stock.

- [ ] **Step 3: POS sync regression (load-bearing)** — change an outlet's stock via Inventori Koreksi, then on the POS (device or a sync pull) confirm the cashier sees the updated on-hand after sync. This proves the `content_version` bump path. (rule 4: if POS doesn't update, stop and debug the bump.)

- [ ] **Step 4: Permission check** — a user with `manage_stock_count` but NOT `manage_inventory` can still reach Inventori and lands on the Opname tab; the Stok Produk/Transfer tabs are hidden for them.

- [ ] **Step 5: Update `SESSION_HANDOFF.md`** with what shipped, backend rev, migration 0022, and any USER-PENDING items (rule 5 + 6).

---

## Self-review notes (author checklist — done)
- **Spec coverage:** A (module/nav)→D1; B (Lokasi)→C2; C (Overview)→C3; D (product modal)→D2; E1 (polymorphic ops)→A1-A6; E2 (overview read)→A4-A5; E3 (decouple write)→B1-B2; E4 (PAR write)→A3/A5/A6; E5 (codegen)→A5/B1; E6 (log table migration)→A1; F (POS sync/version bump)→A3/A7-step3/E2-step3; G (perms)→D1; H (testing)→A2/A7/E2; cleanup of dead endpoints→E1. All spec sections mapped.
- **Placeholder scan:** flags are explicit "confirm/adjust against generated code" notes (oapi-codegen field-name reconciliation, response-ref names, `decodeWrite` type) — not deferred work; each has the concrete action to take.
- **Type consistency:** `CreateLocationGoodsReceipt`/`AdjustLocationStock`/`SetOutletPar`/`InventoryOverview` names consistent across write (A3), handlers (A6), routes (A6); TS `createLocationGoodsReceipt`/`adjustLocationStock`/`setOutletPar`/`getInventoryOverview` consistent across A5 + C1-C3; `OutletConfigItemInput` consistent across B1-B2 + D2; `location:{kind,id,name}` prop consistent across C1-C3.
