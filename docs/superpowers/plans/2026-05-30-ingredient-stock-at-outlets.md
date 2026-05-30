# Ingredient Stock at Outlets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Outlets can store ingredients (not just warehouses). Ingredient transfers go mesh (any↔any). Bahan→Stok becomes location-first like Stok Produk. Mirrors the previous "Inventory Stock Consolidation" pattern applied to ingredients.

**Architecture:** Generalize the ingredient stock-op write path to a location target `{kind:"outlet"|"warehouse", id}` (mirrors SP2/SP-Recipe-1 patterns and the recent `migration 0022` for products). Outlet ingredient stock lives in a NEW `ingredient_outlet_stock` table. **No POS exposure** (ingredients remain backoffice-only). **No production tracking** (still deferred per the SP-Recipe-1 module-wide locks).

**Tech Stack:** Go (chi, pgx/pgxpool, oapi-codegen) · Postgres (Neon) · React + TypeScript (Vite, Cloudflare Pages).

## The 6 working rules (follow throughout)
1. Ask, don't assume · 2. Don't touch unrelated · 3. Flag uncertainty · 4. Verify on failure · 5. Show changes · 6. Admit gaps.

## Locked decisions (user-approved 2026-05-30)
- **Outlets store ingredients** — new `ingredient_outlet_stock(outlet_id, ingredient_id, qty numeric(14,3))` table.
- **Mesh transfers** — `ingredient_transfers` becomes location-polymorphic (mirrors regular `transfers`); any↔any incl. self-block.
- **Bahan→Stok** becomes location-first (Outlet + Gudang sections, drill into either) — mirrors Stok Produk's Lokasi UI.
- **Goods-in + Koreksi + Opname at outlets too** (otherwise outlets can't be stocked except by transfer; users couldn't correct counting errors).
- **No production tracking** (deferred — same as today).
- **No POS exposure** (still backoffice-only; ingredients never sync to POS).
- **Permissions unchanged** — `manage_inventory` + `recipes_enabled` flag.
- **No content_version bump on ingredient writes** — ingredients aren't POS-synced, so no resync trigger needed. (Different from the product inventory work where outlet stock writes bump.)

## Key facts (verified against current code, 2026-05-30)
- Highest migration: `0022_polymorphic_stock_logs.sql`. New migration = **`0023`**.
- Ingredient schema lives in `0019_ingredients.sql`. All ingredient tables are warehouse-only today: `ingredient_warehouse_stock`, `ingredient_goods_receipts`, `ingredient_stock_adjustments`, `ingredient_transfers (source_warehouse_id, dest_warehouse_id, CHECK distinct)`, `ingredient_stock_counts (warehouse_id NOT NULL)`.
- Write funcs are in `backend/internal/write/ingredient.go` (`CreateIngredientGoodsReceipt`, `AdjustIngredientStock`), `ingredient_transfer.go` (`SendIngredientTransfer`, `ReceiveIngredientTransfer`, etc.), `ingredient_stockcount.go`.
- Reads in `backend/internal/read/repo.go` (`IngredientStock(warehouseID)`, `IngredientTransfers`, `IngredientStockCounts`).
- Bahan tab UI: `Bahan` shell in `apps/backoffice/src/screens/ingredients/Ingredients.tsx` with sub-tabs Daftar/Stok/Stok Masuk/Penyesuaian/Transfer (the Opname sub-tab was removed earlier this session and folded into the main Inventori→Opname→Bahan sub-tab).
- Bahan→Stok view: `apps/backoffice/src/screens/ingredients/StokTab.tsx` (currently warehouse-picker → table).
- Transfer form: `IngredientTransferForm.tsx` (currently source/dest = warehouse only).
- Modals: `IngredientGoodsInModal.tsx`, `IngredientAdjustModal.tsx`.

## Codegen + deploy commands
```bash
cd backend && go tool oapi-codegen -config api/oapi-codegen.yaml api/openapi.yaml && cd ..
corepack pnpm --filter @mandalika/api gen
cd backend && go build ./... && go test ./... && cd ..
gcloud run deploy mandalika-pos --source backend --region asia-southeast2 --quiet
curl -s https://mandalika-pos-538849926142.asia-southeast2.run.app/readyz
```

---

# Phase A — Backend: migration + polymorphic ingredient stock ops

### Task A1: Migration 0023 — outlet ingredient storage + polymorphic logs

**Files:**
- Create: `backend/internal/db/migrations/0023_ingredient_stock_at_outlets.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 0023: outlets can store ingredients. Mirrors the polymorphic pattern
-- (migrations 0015 + 0022) — exactly one of (outlet_id, warehouse_id) per row.
-- Goal: ingredient_outlet_stock table + location-polymorphic goods_receipts,
-- stock_adjustments, transfers, and stock_counts for ingredients.

-- 1) New outlet ingredient stock table (numeric qty like ingredient_warehouse_stock).
CREATE TABLE ingredient_outlet_stock (
  outlet_id     uuid NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
  ingredient_id uuid NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  qty           numeric(14,3) NOT NULL DEFAULT 0,
  PRIMARY KEY (outlet_id, ingredient_id)
);

-- 2) Polymorphic ingredient_goods_receipts.
ALTER TABLE ingredient_goods_receipts ALTER COLUMN warehouse_id DROP NOT NULL;
ALTER TABLE ingredient_goods_receipts ADD COLUMN IF NOT EXISTS outlet_id uuid
  REFERENCES outlets(id) ON DELETE CASCADE;
ALTER TABLE ingredient_goods_receipts ADD CONSTRAINT ingredient_goods_receipts_one_location
  CHECK (num_nonnulls(outlet_id, warehouse_id) = 1);

-- 3) Polymorphic ingredient_stock_adjustments.
ALTER TABLE ingredient_stock_adjustments ALTER COLUMN warehouse_id DROP NOT NULL;
ALTER TABLE ingredient_stock_adjustments ADD COLUMN IF NOT EXISTS outlet_id uuid
  REFERENCES outlets(id) ON DELETE CASCADE;
ALTER TABLE ingredient_stock_adjustments ADD CONSTRAINT ingredient_stock_adjustments_one_location
  CHECK (num_nonnulls(outlet_id, warehouse_id) = 1);

-- 4) Polymorphic ingredient_transfers (mesh: any source kind ↔ any dest kind).
-- Drop the warehouse-distinct constraint; we'll enforce "no self-transfer" in
-- application code (same as product transfers).
ALTER TABLE ingredient_transfers DROP CONSTRAINT IF EXISTS ingredient_transfers_distinct;
ALTER TABLE ingredient_transfers ALTER COLUMN source_warehouse_id DROP NOT NULL;
ALTER TABLE ingredient_transfers ALTER COLUMN dest_warehouse_id   DROP NOT NULL;
ALTER TABLE ingredient_transfers ADD COLUMN IF NOT EXISTS source_outlet_id uuid
  REFERENCES outlets(id);
ALTER TABLE ingredient_transfers ADD COLUMN IF NOT EXISTS dest_outlet_id uuid
  REFERENCES outlets(id);
ALTER TABLE ingredient_transfers ADD CONSTRAINT ingredient_transfers_one_source
  CHECK (num_nonnulls(source_outlet_id, source_warehouse_id) = 1);
ALTER TABLE ingredient_transfers ADD CONSTRAINT ingredient_transfers_one_dest
  CHECK (num_nonnulls(dest_outlet_id, dest_warehouse_id) = 1);

-- 5) Polymorphic ingredient_stock_counts.
ALTER TABLE ingredient_stock_counts ALTER COLUMN warehouse_id DROP NOT NULL;
ALTER TABLE ingredient_stock_counts ADD COLUMN IF NOT EXISTS outlet_id uuid
  REFERENCES outlets(id) ON DELETE CASCADE;
ALTER TABLE ingredient_stock_counts ADD CONSTRAINT ingredient_stock_counts_one_location
  CHECK (num_nonnulls(outlet_id, warehouse_id) = 1);
```

Existing rows satisfy each new CHECK (warehouse_id set, outlet_id NULL → `num_nonnulls=1`).

- [ ] **Step 2: Commit**

```bash
git add backend/internal/db/migrations/0023_ingredient_stock_at_outlets.sql
git commit -m "feat(db): migration 0023 — ingredient stock at outlets + polymorphic ingredient logs"
```

### Task A2: Pure validators for ingredient location operations

**Files:**
- Create: `backend/internal/write/ingredient_stock_logic.go`
- Test: `backend/internal/write/ingredient_stock_logic_test.go`

- [ ] **Step 1: Write the failing test**

```go
package write

import "testing"

func TestValidateIngredientGoodsReceipt(t *testing.T) {
	cases := []struct {
		name    string
		kind    string
		items   []IngredientGoodsReceiptItem
		wantErr bool
	}{
		{"ok warehouse", "warehouse", []IngredientGoodsReceiptItem{{IngredientID: "i", Qty: 5}}, false},
		{"ok outlet", "outlet", []IngredientGoodsReceiptItem{{IngredientID: "i", Qty: 0.001}}, false},
		{"bad kind", "shelf", []IngredientGoodsReceiptItem{{Qty: 1}}, true},
		{"no items", "outlet", nil, true},
		{"zero qty", "outlet", []IngredientGoodsReceiptItem{{Qty: 0}}, true},
		{"negative qty", "outlet", []IngredientGoodsReceiptItem{{Qty: -3}}, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := validateIngredientGoodsReceipt(c.kind, c.items)
			if (err != nil) != c.wantErr {
				t.Fatalf("validateIngredientGoodsReceipt(%q) err=%v wantErr=%v", c.kind, err, c.wantErr)
			}
		})
	}
}

func TestValidateIngredientLocationAdjust(t *testing.T) {
	cases := []struct {
		name    string
		kind    string
		newQty  float64
		reason  string
		wantErr bool
	}{
		{"ok", "outlet", 10.5, "stok opname", false},
		{"bad kind", "shelf", 10, "x", true},
		{"no reason", "warehouse", 10, "", true},
		{"negative qty", "outlet", -0.001, "x", true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := validateIngredientLocationAdjust(c.kind, c.newQty, c.reason)
			if (err != nil) != c.wantErr {
				t.Fatalf("validateIngredientLocationAdjust err=%v wantErr=%v", err, c.wantErr)
			}
		})
	}
}
```

- [ ] **Step 2: Implement**

```go
package write

import "fmt"

func validateIngredientGoodsReceipt(kind string, items []IngredientGoodsReceiptItem) error {
	if !validLocKind(kind) {
		return fmt.Errorf("lokasi tidak valid")
	}
	if len(items) == 0 {
		return fmt.Errorf("minimal satu bahan")
	}
	for _, it := range items {
		if it.Qty <= 0 {
			return fmt.Errorf("qty harus lebih dari 0")
		}
	}
	return nil
}

func validateIngredientLocationAdjust(kind string, newQty float64, reason string) error {
	if !validLocKind(kind) {
		return fmt.Errorf("lokasi tidak valid")
	}
	if reason == "" {
		return fmt.Errorf("alasan wajib")
	}
	if newQty < 0 {
		return fmt.Errorf("qty tidak boleh negatif")
	}
	return nil
}
```

- [ ] **Step 3: Run tests, commit**

```bash
cd backend && go test ./internal/write/ -run 'TestValidateIngredient' -v && cd ..
git add backend/internal/write/ingredient_stock_logic.go backend/internal/write/ingredient_stock_logic_test.go
git commit -m "test(write): pure validators for ingredient location goods-in & koreksi"
```

### Task A3: Location-polymorphic ingredient goods-in + koreksi

**Files:**
- Modify: `backend/internal/write/ingredient.go`

- [ ] **Step 1: Replace `CreateIngredientGoodsReceipt` and `AdjustIngredientStock` with location-polymorphic versions**

Keep the existing struct types but rename/replace the call signature to take a `{kind, id}` target. Approach: keep existing function names but change the request struct to carry `LocKind` + `LocID` (back-compat is not required — the TS client + handler will be regenerated to match).

```go
// IngredientGoodsReceipt — the write-model now carries a polymorphic location.
type IngredientGoodsReceipt struct {
	LocKind  string                       `json:"locKind"`  // "outlet" | "warehouse"
	LocID    string                       `json:"locId"`
	Supplier string                       `json:"supplier,omitempty"`
	Note     string                       `json:"note,omitempty"`
	Items    []IngredientGoodsReceiptItem `json:"items"`
}

// CreateIngredientGoodsReceipt records goods-in for an outlet OR warehouse.
// Increments that location's ingredient stock per line. NO content_version bump
// (ingredients are not POS-synced).
func (r *Repo) CreateIngredientGoodsReceipt(ctx context.Context, caller string, in IngredientGoodsReceipt) (string, error) {
	if err := validateIngredientGoodsReceipt(in.LocKind, in.Items); err != nil {
		return "", err
	}
	if in.LocID == "" {
		return "", fmt.Errorf("lokasi wajib")
	}
	var whID, outID any
	if in.LocKind == "warehouse" {
		whID = in.LocID
	} else {
		outID = in.LocID
	}
	tx, err := r.Pool.Begin(ctx)
	if err != nil {
		return "", fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	var rid string
	if err := tx.QueryRow(ctx,
		`INSERT INTO ingredient_goods_receipts (warehouse_id, outlet_id, supplier, note, created_by)
		 VALUES ($1, $2, NULLIF($3,''), NULLIF($4,''), NULLIF($5,'')::uuid)
		 RETURNING id`,
		whID, outID, in.Supplier, in.Note, caller).Scan(&rid); err != nil {
		return "", fmt.Errorf("insert receipt: %w", err)
	}
	for _, it := range in.Items {
		if _, err := tx.Exec(ctx,
			`INSERT INTO ingredient_goods_receipt_items (receipt_id, ingredient_id, qty, unit_cost)
			 VALUES ($1, $2, $3, $4)`,
			rid, it.IngredientID, it.Qty, it.UnitCost); err != nil {
			return "", fmt.Errorf("insert receipt item: %w", err)
		}
		if in.LocKind == "warehouse" {
			if _, err := tx.Exec(ctx,
				`INSERT INTO ingredient_warehouse_stock (warehouse_id, ingredient_id, qty)
				 VALUES ($1, $2, $3)
				 ON CONFLICT (warehouse_id, ingredient_id)
				 DO UPDATE SET qty = ingredient_warehouse_stock.qty + EXCLUDED.qty`,
				in.LocID, it.IngredientID, it.Qty); err != nil {
				return "", fmt.Errorf("upsert warehouse stock: %w", err)
			}
		} else {
			if _, err := tx.Exec(ctx,
				`INSERT INTO ingredient_outlet_stock (outlet_id, ingredient_id, qty)
				 VALUES ($1, $2, $3)
				 ON CONFLICT (outlet_id, ingredient_id)
				 DO UPDATE SET qty = ingredient_outlet_stock.qty + EXCLUDED.qty`,
				in.LocID, it.IngredientID, it.Qty); err != nil {
				return "", fmt.Errorf("upsert outlet stock: %w", err)
			}
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return "", fmt.Errorf("commit tx: %w", err)
	}
	return rid, nil
}

// IngredientAdjust — write-model now carries a polymorphic location.
type IngredientAdjust struct {
	LocKind      string  `json:"locKind"`
	LocID        string  `json:"locId"`
	IngredientID string  `json:"ingredientId"`
	NewQty       float64 `json:"newQty"`
	Reason       string  `json:"reason"`
}

func (r *Repo) AdjustIngredientStock(ctx context.Context, caller string, in IngredientAdjust) error {
	if err := validateIngredientLocationAdjust(in.LocKind, in.NewQty, in.Reason); err != nil {
		return err
	}
	if in.LocID == "" || in.IngredientID == "" {
		return fmt.Errorf("lokasi dan bahan wajib")
	}
	var whID, outID any
	if in.LocKind == "warehouse" {
		whID = in.LocID
	} else {
		outID = in.LocID
	}
	tx, err := r.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)
	if in.LocKind == "warehouse" {
		if _, err := tx.Exec(ctx,
			`INSERT INTO ingredient_warehouse_stock (warehouse_id, ingredient_id, qty)
			 VALUES ($1, $2, $3)
			 ON CONFLICT (warehouse_id, ingredient_id) DO UPDATE SET qty = EXCLUDED.qty`,
			in.LocID, in.IngredientID, in.NewQty); err != nil {
			return fmt.Errorf("upsert warehouse stock: %w", err)
		}
	} else {
		if _, err := tx.Exec(ctx,
			`INSERT INTO ingredient_outlet_stock (outlet_id, ingredient_id, qty)
			 VALUES ($1, $2, $3)
			 ON CONFLICT (outlet_id, ingredient_id) DO UPDATE SET qty = EXCLUDED.qty`,
			in.LocID, in.IngredientID, in.NewQty); err != nil {
			return fmt.Errorf("upsert outlet stock: %w", err)
		}
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO ingredient_stock_adjustments (warehouse_id, outlet_id, ingredient_id, new_qty, reason, created_by)
		 VALUES ($1, $2, $3, $4, $5, NULLIF($6,'')::uuid)`,
		whID, outID, in.IngredientID, in.NewQty, in.Reason, caller); err != nil {
		return fmt.Errorf("insert adjustment: %w", err)
	}
	return tx.Commit(ctx)
}
```

Delete the old `WarehouseID` field from the input structs (it's replaced by LocKind+LocID). Callers (handlers + tests) will be updated in subsequent tasks.

- [ ] **Step 2: gofmt + go build (don't commit yet — handlers/OpenAPI need to catch up; commit in Task A4 with all backend write/handler updates together OR commit and stage as a WIP if needed)**

Run `cd backend && gofmt -w internal/write/ && go build ./...` — likely fails until handlers update. That's expected — the next tasks fix it. Leave uncommitted.

### Task A4: Location-polymorphic ingredient transfers

**Files:**
- Modify: `backend/internal/write/ingredient_transfer.go`

This refactor mirrors what was done for product `transfers` in SP2 (and the existing `transfer.go` in the same package is the reference pattern — read it for the polymorphic `Kind`/`ID` source/dest field handling).

- [ ] **Step 1: Read both the current `ingredient_transfer.go` and `transfer.go` (the product transfers, which are already mesh-polymorphic)** so the new ingredient logic matches the same shape.

- [ ] **Step 2: Update the transfer create payload** to carry source/dest as `{kind, id}` instead of `sourceWarehouseId`/`destWarehouseId`. Mirror the product `TransferLocation` shape (which has `kind` + `outletId`/`warehouseId`).

- [ ] **Step 3: Update SEND** (`SendIngredientTransfer`):
  - When source kind = warehouse: deduct from `ingredient_warehouse_stock` (existing behavior).
  - When source kind = outlet: deduct from `ingredient_outlet_stock`.
  - Validate "stock available at source" against the right table.
  - Self-transfer check: reject if (source kind==dest kind AND source id==dest id).

- [ ] **Step 4: Update RECEIVE** (`ReceiveIngredientTransfer`):
  - When dest kind = warehouse: credit `ingredient_warehouse_stock`.
  - When dest kind = outlet: credit `ingredient_outlet_stock`.
  - Discrepancy recording unchanged (per-item `received_qty` + computed `difference`).

- [ ] **Step 5: Update CANCEL-IN-TRANSIT restore**:
  - Restore stock to the source's correct table (warehouse_stock or outlet_stock) based on `source_warehouse_id` vs `source_outlet_id`.

- [ ] **Step 6: Update READ — `IngredientTransfer` / `IngredientTransfers` DTO hydration** in `read/repo.go`: emit `source: {kind, id, name}` / `dest: {kind, id, name}` (mirroring product `Transfer` shape).

- [ ] **Step 7: Build, run existing ingredient transfer tests** (`go test ./internal/write/ -run TestValidateIngTransfer` and any others). Update tests to use the new polymorphic shape.

Commit after A5+A6 land green together.

### Task A5: Location-polymorphic ingredient stock counts (opname)

**Files:**
- Modify: `backend/internal/write/ingredient_stockcount.go`
- Modify: `backend/internal/read/repo.go` — `IngredientStockCount` / `IngredientStockCounts` DTO

- [ ] **Step 1: Reference the product `stockcount.go`** — it was already extended to be location-polymorphic for migration 0015. Mirror that pattern: input struct carries `LocKind`+`LocID`; create-tx writes the right column; snapshot logic stays the same.

- [ ] **Step 2: Update the start logic** (snapshot at start time) so the "list all ingredients with current qty at this location" query reads from `ingredient_warehouse_stock` OR `ingredient_outlet_stock` based on the count's location.

- [ ] **Step 3: Update the complete logic** (apply counted qty as the new stock) — write to the right table.

- [ ] **Step 4: Read DTOs** — `IngredientStockCount.location` becomes a `{kind, id, name}` object.

### Task A6: Location-polymorphic ingredient stock read + handlers + routes + OpenAPI + TS client

**Files:**
- Modify: `backend/internal/read/repo.go` — add `IngredientLocationStock(ctx, kind, id) → []api.IngredientStockRow`
- Modify: `backend/api/openapi.yaml`
- Modify: `backend/internal/handlers/writes.go`
- Modify: `backend/internal/server/server.go`
- Modify: `packages/api/src/client.ts`

This is the big integration task. Roll the OpenAPI + Go handlers + TS client into one commit.

- [ ] **Step 1: Add `IngredientLocationStock` to `read/repo.go`** — same shape as `LocationStock` for products but for ingredients. Returns rows joining `ingredients v` LEFT with `ingredient_warehouse_stock` OR `ingredient_outlet_stock` based on `kind`. Emit per-ingredient `{ingredientId, ingredientName, sku, unit, defaultUnitCost, qty}`.

- [ ] **Step 2: OpenAPI edits**:
  - Replace warehouse-only ingredient endpoints with polymorphic ones:
    - `POST /api/v1/inventory/ingredient-goods-receipt?kind=&id=` (new schema `IngredientGoodsReceiptInput` no longer carries `warehouseId`).
    - `POST /api/v1/inventory/ingredient-adjust?kind=&id=` (new `IngredientAdjustInput` likewise).
    - `GET /api/v1/inventory/ingredient-location-stock?kind=&id=` returning `IngredientStockResponse`.
  - Update `IngredientTransfer` schema: source/dest become `IngredientTransferLocation { kind: 'outlet'|'warehouse', id, name }` (matching the product `TransferLocation` schema).
  - Update `IngredientTransferCreateInput`: source/dest become the same `IngredientTransferLocation` shape.
  - Update `IngredientStockCount.location` to the same polymorphic location object.
  - Remove the old `POST /api/v1/ingredients/{id}/goods-receipt`, `POST /api/v1/ingredient-adjust` (or wherever the warehouse-only ones live) — confirm with a grep first.

- [ ] **Step 3: Regen**: `oapi-codegen` + `pnpm --filter @mandalika/api gen`.

- [ ] **Step 4: Handlers** in `writes.go` — mirror the existing `CreateLocationGoodsReceipt` / `AdjustLocationStock` handlers but for ingredients (`CreateIngredientLocationGoodsReceipt`, `AdjustIngredientLocationStock`, `IngredientLocationStock`). Reuse `locTarget(r)` helper.

- [ ] **Step 5: Routes** in `server.go`, in the `manage_inventory` group:
  ```go
  r.Post("/inventory/ingredient-goods-receipt", h.CreateIngredientLocationGoodsReceipt)
  r.Post("/inventory/ingredient-adjust", h.AdjustIngredientLocationStock)
  r.Get("/inventory/ingredient-location-stock", h.IngredientLocationStock)
  ```
  Remove the old `/ingredients/{id}/goods-receipt` and `/ingredient-adjust` route lines.

- [ ] **Step 6: TS client** in `client.ts`: add methods `createIngredientLocationGoodsReceipt`, `adjustIngredientLocationStock`, `getIngredientLocationStock` (mirror the product `createLocationGoodsReceipt` etc. patterns). Remove the old `createIngredientGoodsReceipt(warehouseId, ...)` and `adjustIngredientStock(...)` if their signatures changed (they likely have).

- [ ] **Step 7: Backend build + test + gen-check + tsc** all clean. Commit:

```bash
git add backend/api/openapi.yaml backend/internal/api/api.gen.go \
        backend/internal/write/ingredient.go \
        backend/internal/write/ingredient_transfer.go \
        backend/internal/write/ingredient_stockcount.go \
        backend/internal/write/ingredient_stock_logic.go \
        backend/internal/write/ingredient_stock_logic_test.go \
        backend/internal/read/repo.go \
        backend/internal/handlers/writes.go \
        backend/internal/server/server.go \
        packages/api/src/client.ts packages/api/src/schema.d.ts
git commit -m "feat: ingredient stock at outlets — polymorphic ingredient goods-in/koreksi/transfers/opname + Inventori endpoints"
```

### Task A7: Deploy + live API smoke

- [ ] Deploy: `gcloud run deploy mandalika-pos --source backend --region asia-southeast2 --quiet`
- [ ] `/readyz` ok (confirms migration 0023 applied).
- [ ] Auth-free routing probes (expect 401 / 405 for new paths, 404 for any removed ones).
- [ ] Authed live verification (mirror the `_verify_inventory.mjs` script from the previous feature; new script tests outlet goods-in/koreksi for ingredients, polymorphic transfer warehouse↔outlet, polymorphic opname start→complete at an outlet, and restores mutations).

---

# Phase B — Backoffice: location-first Bahan + polymorphic transfer + opname

### Task B1: Generalize ingredient modals to location target

**Files:**
- Modify: `apps/backoffice/src/screens/ingredients/IngredientGoodsInModal.tsx`
- Modify: `apps/backoffice/src/screens/ingredients/IngredientAdjustModal.tsx`

Mirror what we did for the product `GoodsInModal`/`AdjustModal` in F1's previous session. Change the prop `warehouse: Warehouse` to `location: { kind: 'outlet'|'warehouse'; id: string; name: string }`. Change the API call to `api.createIngredientLocationGoodsReceipt({ kind, id }, body)` / `api.adjustIngredientLocationStock({ kind, id }, body)`.

### Task B2: Bahan→Stok becomes location-first

**Files:**
- Replace: `apps/backoffice/src/screens/ingredients/StokTab.tsx`
- Possibly create: `apps/backoffice/src/screens/ingredients/IngredientLocationStockView.tsx`

Rewrite `StokTab` to mirror the structure of `StokProduk` (`apps/backoffice/src/screens/inventory/StokProduk.tsx`):
- Top-level: a location list grouped Outlet/Gudang. Cards same visual as Stok Produk.
- Drill into a location → an `IngredientLocationStockView` showing per-ingredient on-hand at that location, with Barang Masuk + Koreksi via the B1 generalized modals.
- Reuse `api.getInventoryOverview` is NOT applicable to ingredients — there's no equivalent yet. For the per-location list summary metrics (ingredient count, total weight/units etc.), you can either (a) skip summary for ingredients, or (b) call `api.getIngredientLocationStock` per-location (N calls = number of locations, acceptable). Recommend (a): just show the location name + icon; details are inside.
- Per-row CRUD for warehouses (Tambah/Edit/Hapus Gudang) — REUSE the existing `WarehouseFormModal`. Outlet CRUD stays in Stok Produk; here just LIST outlets read-only (drill-only). Don't duplicate outlet management UI.

### Task B3: Generalize ingredient transfer form

**Files:**
- Modify: `apps/backoffice/src/screens/ingredients/IngredientTransferForm.tsx`

Today: source/dest pickers list warehouses only. Change: pickers list outlets + warehouses with kind tags (mirror what the product `TransferForm` does — read it for the pattern). Validate "stock at source kind/id" using the new `getIngredientLocationStock(kind, id)` instead of the warehouse-only variant. Submit shape now includes `source: {kind,id}` + `dest: {kind,id}` per the new OpenAPI.

### Task B4: Ingredient opname supports outlets

**Files:**
- Modify: `apps/backoffice/src/screens/ingredients/OpnameTab.tsx` (now mounted under the main Inventori→Opname→Bahan sub-tab).

The component already has a location picker (outlet/warehouse) for products via `StockCount.tsx`'s pattern — but the ingredient opname today picks WAREHOUSES only. Extend its location picker to include outlets (mirror StockCount.tsx's optgroup). On create, pass `{kind, id}` per the new schema.

### Task B5: Update history views (Stok Masuk + Penyesuaian) for polymorphic location

**Files:**
- Modify: `apps/backoffice/src/screens/ingredients/StokMasukTab.tsx`
- Modify: `apps/backoffice/src/screens/ingredients/PenyesuaianTab.tsx`

These list ingredient goods-in / adjustment history. They likely read all entries; ensure the location column/label correctly displays outlet vs warehouse based on which id is set. Source/location lookup goes through both `listOutlets` + `listWarehouses` to map ids → names.

### Task B6: Backoffice tsc + build + commit

- [ ] `corepack pnpm --filter @mandalika/backoffice exec tsc --noEmit` clean.
- [ ] `corepack pnpm --filter @mandalika/backoffice build` succeeds.
- [ ] One commit for the whole backoffice batch (or split by sub-task — your call):

```bash
git commit -m "feat(backoffice): Bahan→Stok location-first; ingredient transfers mesh; outlet opname for ingredients"
```

### Task B7: Push + live UI smoke + authed verify

- [ ] Push branch (Cloudflare auto-deploys).
- [ ] Hard-refresh the live site, walk: Bahan→Stok (outlet & warehouse drill-in, goods-in, koreksi); Bahan→Transfer (warehouse→outlet transfer create/send/receive); Inventori→Opname→Bahan (outlet opname create→start→complete).
- [ ] Extend the authed verification script (or write a new one `_verify_ingredients.mjs`) to test the polymorphic ingredient endpoints end-to-end and restore mutations.

---

## Risks / things to verify during implementation

1. **TS client diff size** — OpenAPI regen will rewrite `IngredientTransfer.source/dest` to a polymorphic location. All current callers (transfer list, transfer detail, surat jalan rendering) must be updated. Expect a wide TS surface change.
2. **Surat jalan / tanda terima for ingredient outlet legs** — the SP-Recipe-1 `SuratJalanIngredientPanel` was built for warehouse↔warehouse. With outlet legs, letterhead resolution must work for outlets too. The existing letterhead resolver (built in SP4 for product transfers) already handles outlets — confirm the ingredient panel reuses it correctly.
3. **POS sync** — confirm during code review that no ingredient write path accidentally calls `bumpVersionOutlets` (ingredients are not POS-synced, so no resync). The new write code uses plain transactions (no `bumpOutletTx`).
4. **Stock count snapshot at outlet** — the existing ingredient stock count "start" logic snapshots ALL active ingredients. With outlets, the snapshot still iterates the full ingredient catalog (because an outlet might have zero stock of an ingredient and the user still needs to count it physically). Confirm the snapshot is per-(count, ingredient) not per-(location, count, ingredient).
5. **Bahan tab UI no longer has Opname** (moved to main Opname earlier this session). Don't add it back accidentally.
