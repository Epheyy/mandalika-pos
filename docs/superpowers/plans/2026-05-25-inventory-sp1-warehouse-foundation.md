# Inventory SP1 — Warehouse Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use `- [ ]` checkboxes.
>
> **The 6 rules (user-required):** ask don't assume · don't touch unrelated · flag uncertainty · verify on failure · show changes · admit gaps.
> **Spec:** `docs/superpowers/specs/2026-05-25-inventory-sp1-warehouse-foundation-design.md` (also has the full SP1–SP4 module decomposition).

**Goal:** Add **warehouses** as a separate stock subsystem — CRUD, a per-warehouse per-variant stock store, **goods-in**, **manual adjust** (set absolute), and **warehouse stock-count** (reusing the existing opname, made location-polymorphic). Backoffice only.

**Architecture:** New `warehouses` + `warehouse_variant_stock` tables, parallel to outlets (never POS-synced, no `content_version` bump). Goods-in/adjust are new write-repo ops; warehouse opname reuses `stock_counts` via a nullable `warehouse_id`. New `manage_inventory` permission gates everything. A new backoffice "Gudang" screen, with client methods added to the hand-written `@mandalika/api` client.

**Tech Stack:** Go (pgx v5) + Postgres; oapi-codegen + openapi-typescript; React 19 / Vite backoffice; chi router.

**Status:** app is test-data-only on free-tier (not real sales) — standard deploy hygiene, no kid-gloves.

---

## File map
- Create: `backend/internal/db/migrations/0015_warehouses.sql`
- Modify: `backend/api/openapi.yaml` (+ regen `backend/internal/api/api.gen.go`, `packages/api/src/schema.d.ts`)
- Create: `backend/internal/write/warehouse.go` (warehouses CRUD, goods-in, adjust)
- Modify: `backend/internal/write/stockcount.go` (location-polymorphic complete/scope)
- Modify: `backend/internal/read/repo.go` (list warehouses, warehouse stock matrix)
- Modify: `backend/internal/handlers/writes.go` (warehouse handlers) + `backend/internal/server/server.go` (routes + `manage_inventory` group)
- Modify: `packages/api/src/client.ts` (Api interface + impls)
- Create: `apps/backoffice/src/screens/Warehouses.tsx`
- Modify: `apps/backoffice/src/App.tsx` (NAV entry), `apps/backoffice/src/screens/Users.tsx` (`manage_inventory` in `PERMS`)

---

## PHASE A — schema + warehouses CRUD + stock read

### Task A1: Migration 0015
**Files:** Create `backend/internal/db/migrations/0015_warehouses.sql`

- [ ] **Step 1: Write the migration.** First verify whether `stock_counts.outlet_id` is already nullable: `grep -n "outlet_id" backend/internal/db/migrations/0001_init.sql`. If it's `NOT NULL`, keep the `ALTER … DROP NOT NULL` line below; if already nullable, delete that one line.

```sql
-- 0015: warehouses (separate stock subsystem) + goods-in, adjust, and
-- location-polymorphic stock-count. Warehouses are never POS-synced.
CREATE TABLE warehouses (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  code       text,
  address    text,
  phone      text,
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE warehouse_variant_stock (
  warehouse_id uuid NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  product_id   uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  variant_size text NOT NULL,
  stock        integer NOT NULL DEFAULT 0,
  PRIMARY KEY (warehouse_id, product_id, variant_size)
);

CREATE TABLE goods_receipts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id uuid NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  supplier     text,
  note         text,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE goods_receipt_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id   uuid NOT NULL REFERENCES goods_receipts(id) ON DELETE CASCADE,
  product_id   uuid NOT NULL REFERENCES products(id),
  variant_size text NOT NULL,
  qty          integer NOT NULL,
  unit_cost    numeric(14,2)
);

CREATE TABLE warehouse_stock_adjustments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id uuid NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  product_id   uuid NOT NULL REFERENCES products(id),
  variant_size text NOT NULL,
  new_qty      integer NOT NULL,
  reason       text NOT NULL,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- location-polymorphic opname (reuse, don't duplicate):
ALTER TABLE stock_counts ALTER COLUMN outlet_id DROP NOT NULL;
ALTER TABLE stock_counts ADD COLUMN warehouse_id uuid REFERENCES warehouses(id) ON DELETE CASCADE;
ALTER TABLE stock_counts ADD CONSTRAINT stock_counts_one_location
  CHECK (num_nonnulls(outlet_id, warehouse_id) = 1);
```

- [ ] **Step 2: Commit.**
```bash
git add backend/internal/db/migrations/0015_warehouses.sql
git commit -m "feat(backend): migration 0015 — warehouses + goods-in/adjust + polymorphic opname"
```

### Task A2: OpenAPI — warehouse + stock types
**Files:** Modify `backend/api/openapi.yaml`; regen.

- [ ] **Step 1: Add schemas** (place near `Outlet`). Mirror the `Outlet`/`OutletListResponse` shape exactly:
```yaml
    Warehouse:
      type: object
      required: [id, name, isActive, createdAt]
      properties:
        id: { type: string, format: uuid }
        name: { type: string }
        code: { type: string, nullable: true }
        address: { type: string, nullable: true }
        phone: { type: string, nullable: true }
        isActive: { type: boolean }
        createdAt: { type: string, format: date-time }
    WarehouseInput:
      type: object
      required: [name, isActive]
      properties:
        name: { type: string }
        code: { type: string, nullable: true }
        address: { type: string, nullable: true }
        phone: { type: string, nullable: true }
        isActive: { type: boolean }
    WarehouseListResponse:
      type: object
      required: [data]
      properties:
        data: { type: array, items: { $ref: '#/components/schemas/Warehouse' } }
    WarehouseStockRow:
      type: object
      required: [productId, productName, variantSize, stock]
      properties:
        productId: { type: string, format: uuid }
        productName: { type: string }
        variantSize: { type: string }
        sku: { type: string }
        stock: { type: integer }
    WarehouseStockResponse:
      type: object
      required: [data]
      properties:
        data: { type: array, items: { $ref: '#/components/schemas/WarehouseStockRow' } }
    GoodsReceiptItemInput:
      type: object
      required: [productId, variantSize, qty]
      properties:
        productId: { type: string, format: uuid }
        variantSize: { type: string }
        qty: { type: integer }
        unitCost: { type: number, nullable: true }
    GoodsReceiptInput:
      type: object
      required: [items]
      properties:
        supplier: { type: string, nullable: true }
        note: { type: string, nullable: true }
        items: { type: array, items: { $ref: '#/components/schemas/GoodsReceiptItemInput' } }
    WarehouseAdjustInput:
      type: object
      required: [productId, variantSize, newQty, reason]
      properties:
        productId: { type: string, format: uuid }
        variantSize: { type: string }
        newQty: { type: integer }
        reason: { type: string }
```

- [ ] **Step 2: Add paths** with operationIds (the client generator + hand client mirror these). Add admin/`manage_inventory` paths:
```yaml
  /warehouses:
    get:
      operationId: listWarehouses
      responses: { '200': { description: ok, content: { application/json: { schema: { $ref: '#/components/schemas/WarehouseListResponse' } } } } }
    post:
      operationId: createWarehouse
      requestBody: { required: true, content: { application/json: { schema: { $ref: '#/components/schemas/WarehouseInput' } } } }
      responses: { '201': { description: created } }
  /warehouses/{id}:
    put:
      operationId: updateWarehouse
      parameters: [ { name: id, in: path, required: true, schema: { type: string } } ]
      requestBody: { required: true, content: { application/json: { schema: { $ref: '#/components/schemas/WarehouseInput' } } } }
      responses: { '200': { description: ok } }
    delete:
      operationId: deleteWarehouse
      parameters: [ { name: id, in: path, required: true, schema: { type: string } } ]
      responses: { '200': { description: ok } }
  /warehouses/{id}/stock:
    get:
      operationId: getWarehouseStock
      parameters: [ { name: id, in: path, required: true, schema: { type: string } } ]
      responses: { '200': { description: ok, content: { application/json: { schema: { $ref: '#/components/schemas/WarehouseStockResponse' } } } } }
  /warehouses/{id}/goods-receipt:
    post:
      operationId: createGoodsReceipt
      parameters: [ { name: id, in: path, required: true, schema: { type: string } } ]
      requestBody: { required: true, content: { application/json: { schema: { $ref: '#/components/schemas/GoodsReceiptInput' } } } }
      responses: { '200': { description: ok } }
  /warehouses/{id}/adjust:
    post:
      operationId: adjustWarehouseStock
      parameters: [ { name: id, in: path, required: true, schema: { type: string } } ]
      requestBody: { required: true, content: { application/json: { schema: { $ref: '#/components/schemas/WarehouseAdjustInput' } } } }
      responses: { '200': { description: ok } }
```
(Match the existing file's exact path style — check a current path block and mirror its formatting/response envelope.)

- [ ] **Step 2b: Regen + drift check.**
```bash
cd backend && make gen-go && make gen-check && cd ..
corepack pnpm --filter @mandalika/api gen
```
Expected: `api.gen.go` gains `Warehouse`, `WarehouseInput`, etc.; no DRIFT.

- [ ] **Step 3: Commit.**
```bash
git add backend/api/openapi.yaml backend/internal/api/api.gen.go packages/api/src/schema.d.ts
git commit -m "feat(api): warehouse + warehouse-stock schemas and paths"
```

### Task A3: Backend write — warehouses CRUD
**Files:** Create `backend/internal/write/warehouse.go`. Mirror the `Outlet` CRUD in `write/repo.go:575-612` (`Outlet` struct, `CreateOutlet`, `UpdateOutlet`) but WITHOUT the `content_versions` seeding/bump (warehouses aren't synced). Use the existing `r.tx`? No — `r.tx` bumps content_version; warehouses must NOT. Use a plain tx like `SetProductOutletConfig` does (manual `Begin`/`Commit`, no bump).

- [ ] **Step 1: Write the file.**
```go
package write

import (
	"context"

	"github.com/jackc/pgx/v5"
)

type Warehouse struct {
	Name     string `json:"name"`
	Code     string `json:"code"`
	Address  string `json:"address"`
	Phone    string `json:"phone"`
	IsActive bool   `json:"isActive"`
}

// noBumpTx runs fn in a tx WITHOUT bumping content_version (warehouses are not
// POS-synced, so no cashier resync is needed).
func (r *Repo) noBumpTx(ctx context.Context, fn func(pgx.Tx) error) error {
	t, err := r.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer t.Rollback(ctx)
	if err := fn(t); err != nil {
		return err
	}
	return t.Commit(ctx)
}

func (r *Repo) CreateWarehouse(ctx context.Context, w Warehouse) (string, error) {
	var id string
	err := r.noBumpTx(ctx, func(t pgx.Tx) error {
		return t.QueryRow(ctx,
			`INSERT INTO warehouses (name, code, address, phone, is_active)
			 VALUES ($1,$2,$3,$4,$5) RETURNING id`,
			w.Name, nullStr(w.Code), nullStr(w.Address), nullStr(w.Phone), w.IsActive).Scan(&id)
	})
	return id, err
}

func (r *Repo) UpdateWarehouse(ctx context.Context, id string, w Warehouse) error {
	return r.noBumpTx(ctx, func(t pgx.Tx) error {
		ct, e := t.Exec(ctx,
			`UPDATE warehouses SET name=$1, code=$2, address=$3, phone=$4, is_active=$5 WHERE id=$6`,
			w.Name, nullStr(w.Code), nullStr(w.Address), nullStr(w.Phone), w.IsActive, id)
		if e == nil && ct.RowsAffected() == 0 {
			return ErrNotFound
		}
		return e
	})
}

func (r *Repo) DeleteWarehouse(ctx context.Context, id string) error {
	return r.noBumpTx(ctx, func(t pgx.Tx) error {
		ct, e := t.Exec(ctx, `DELETE FROM warehouses WHERE id=$1`, id)
		if e == nil && ct.RowsAffected() == 0 {
			return ErrNotFound
		}
		return e
	})
}
```
(`nullStr`, `ErrNotFound`, `Repo` are already in `write/repo.go`.) Goods-in + adjust are added to this file in Phase B.

- [ ] **Step 2: Format + build.**
```bash
cd backend && gofmt -w internal/write/warehouse.go && go build ./... && cd ..
```
Expected: exit 0.

- [ ] **Step 3: Commit.**
```bash
git add backend/internal/write/warehouse.go
git commit -m "feat(backend): warehouse CRUD (no content_version bump)"
```

### Task A4: Backend read — warehouses list + stock matrix
**Files:** Modify `backend/internal/read/repo.go` (add two functions; mirror the `Outlets`/`ProductOutletConfig` JSON-agg style using `listJSON`).

- [ ] **Step 1: Add functions** (append near the other read methods):
```go
func (r *Repo) Warehouses(ctx context.Context) ([]api.Warehouse, error) {
	rows, _, err := listJSON[api.Warehouse](ctx, r.Pool, `
		SELECT json_build_object(
		  'id', w.id, 'name', w.name, 'code', w.code, 'address', w.address,
		  'phone', w.phone, 'isActive', w.is_active, 'createdAt', w.created_at)
		FROM warehouses w ORDER BY w.name`)
	return rows, err
}

// WarehouseStock lists every product variant with the warehouse's on-hand qty
// (0 when no row), so the UI can show/seed all variants.
func (r *Repo) WarehouseStock(ctx context.Context, warehouseID string) ([]api.WarehouseStockRow, error) {
	rows, _, err := listJSON[api.WarehouseStockRow](ctx, r.Pool, `
		SELECT json_build_object(
		  'productId', v.product_id, 'productName', p.name, 'variantSize', v.size,
		  'sku', v.sku,
		  'stock', COALESCE((SELECT s.stock FROM warehouse_variant_stock s
		     WHERE s.warehouse_id=$1 AND s.product_id=v.product_id AND s.variant_size=v.size),0))
		FROM product_variants v JOIN products p ON p.id=v.product_id
		ORDER BY p.name, v.size`, warehouseID)
	return rows, err
}
```

- [ ] **Step 2: Build.** `cd backend && go build ./... && cd ..` → exit 0.
- [ ] **Step 3: Commit.** `git add backend/internal/read/repo.go` then commit `"feat(backend): read warehouses + warehouse stock matrix"`.

### Task A5: Handlers + routes (`manage_inventory`)
**Files:** Modify `backend/internal/handlers/writes.go` + `backend/internal/server/server.go`.

- [ ] **Step 1: Handlers** in `writes.go` (mirror `CreateOutlet`/`UpdateOutlet` + the read handlers; the `caller` helper gives `created_by`):
```go
func (h *Handlers) Warehouses(w http.ResponseWriter, r *http.Request) {
	rows, err := h.Repo.Warehouses(r.Context())
	if err != nil { writeErr(w, 500, err); return }
	writeJSON(w, http.StatusOK, map[string]any{"data": rows})
}
func (h *Handlers) CreateWarehouse(w http.ResponseWriter, r *http.Request) {
	wh, ok := decodeWrite[write.Warehouse](w, r); if !ok { return }
	id, err := h.Write.CreateWarehouse(r.Context(), wh)
	h.created(w, r, id, err)
}
func (h *Handlers) UpdateWarehouse(w http.ResponseWriter, r *http.Request) {
	wh, ok := decodeWrite[write.Warehouse](w, r); if !ok { return }
	h.mutated(w, r, h.Write.UpdateWarehouse(r.Context(), chi.URLParam(r, "id"), wh))
}
func (h *Handlers) DeleteWarehouse(w http.ResponseWriter, r *http.Request) {
	h.mutated(w, r, h.Write.DeleteWarehouse(r.Context(), chi.URLParam(r, "id")))
}
func (h *Handlers) WarehouseStock(w http.ResponseWriter, r *http.Request) {
	rows, err := h.Repo.WarehouseStock(r.Context(), chi.URLParam(r, "id"))
	if err != nil { writeErr(w, 500, err); return }
	writeJSON(w, http.StatusOK, map[string]any{"data": rows})
}
```
Note: `h.created`/`h.mutated` call `h.invalidate(r)` — fine (cache bust). `created_by` for warehouses themselves isn't stored; goods-in/adjust (Phase B) use `h.caller(r)`.

- [ ] **Step 2: Routes** in `server.go`. Add a `GET` for warehouses/stock in the authed read area (near line 98 outlets `GET`), and a new permission group mirroring the `manage_outlets` group (around line 162):
```go
// reads (any authed) — near the other GETs:
r.Get("/warehouses", h.Warehouses)
r.Get("/warehouses/{id}/stock", h.WarehouseStock)

// writes — new permission group:
r.Group(func(r chi.Router) {
	r.Use(mw.RequirePermission("manage_inventory"))
	r.Post("/warehouses", h.CreateWarehouse)
	r.Put("/warehouses/{id}", h.UpdateWarehouse)
	r.Delete("/warehouses/{id}", h.DeleteWarehouse)
	// goods-receipt + adjust routes added in Phase B
})
```
Verify `RequirePermission` exists (grep `func RequirePermission` in middleware). If the project uses a different gate name, match it.

- [ ] **Step 3: Format + build.** `cd backend && gofmt -w internal/handlers/writes.go internal/server/server.go && go build ./... && go vet ./... && cd ..` → exit 0.
- [ ] **Step 4: Commit.** add both files, commit `"feat(backend): warehouse routes + manage_inventory gate"`.

### Task A6: Deploy + verify Phase A
- [ ] **Step 1:** Deploy: `gcloud run deploy mandalika-pos --source backend --region asia-southeast2 --quiet` (background). Then `curl …/readyz` → 200 (migration 0015 applied).
- [ ] **Step 2:** With an admin token (login flow: `POST /api/v1/auth/login`, token at `data.access`): `POST /warehouses` create one; `GET /warehouses` shows it; `GET /warehouses/{id}/stock` returns a row per product variant with stock 0.

---

## PHASE B — goods-in + adjust

### Task B1: Write repo — goods-in + adjust
**Files:** Modify `backend/internal/write/warehouse.go`.

- [ ] **Step 1: Add types + methods.**
```go
type GoodsReceiptItem struct {
	ProductID   string   `json:"productId"`
	VariantSize string   `json:"variantSize"`
	Qty         int      `json:"qty"`
	UnitCost    *float64 `json:"unitCost"`
}
type GoodsReceipt struct {
	Supplier string             `json:"supplier"`
	Note     string             `json:"note"`
	Items    []GoodsReceiptItem `json:"items"`
}

// CreateGoodsReceipt records a goods-in and INCREMENTS warehouse stock per line.
func (r *Repo) CreateGoodsReceipt(ctx context.Context, warehouseID, createdBy string, g GoodsReceipt) error {
	if len(g.Items) == 0 {
		return fmt.Errorf("minimal satu item")
	}
	for _, it := range g.Items {
		if it.Qty <= 0 {
			return fmt.Errorf("qty harus lebih dari 0")
		}
	}
	return r.noBumpTx(ctx, func(t pgx.Tx) error {
		var rid string
		if e := t.QueryRow(ctx,
			`INSERT INTO goods_receipts (warehouse_id, supplier, note, created_by)
			 VALUES ($1,$2,$3,$4) RETURNING id`,
			warehouseID, nullStr(g.Supplier), nullStr(g.Note), nullUUID(createdBy)).Scan(&rid); e != nil {
			return e
		}
		for _, it := range g.Items {
			if _, e := t.Exec(ctx,
				`INSERT INTO goods_receipt_items (receipt_id, product_id, variant_size, qty, unit_cost)
				 VALUES ($1,$2,$3,$4,$5)`,
				rid, it.ProductID, it.VariantSize, it.Qty, it.UnitCost); e != nil {
				return e
			}
			if _, e := t.Exec(ctx,
				`INSERT INTO warehouse_variant_stock (warehouse_id, product_id, variant_size, stock)
				 VALUES ($1,$2,$3,$4)
				 ON CONFLICT (warehouse_id, product_id, variant_size)
				   DO UPDATE SET stock = warehouse_variant_stock.stock + EXCLUDED.stock`,
				warehouseID, it.ProductID, it.VariantSize, it.Qty); e != nil {
				return e
			}
		}
		return nil
	})
}

type WarehouseAdjust struct {
	ProductID   string `json:"productId"`
	VariantSize string `json:"variantSize"`
	NewQty      int    `json:"newQty"`
	Reason      string `json:"reason"`
}

// AdjustWarehouseStock SETS the absolute on-hand qty + logs the correction.
func (r *Repo) AdjustWarehouseStock(ctx context.Context, warehouseID, createdBy string, a WarehouseAdjust) error {
	if a.Reason == "" {
		return fmt.Errorf("alasan wajib diisi")
	}
	if a.NewQty < 0 {
		return fmt.Errorf("stok tidak boleh negatif")
	}
	return r.noBumpTx(ctx, func(t pgx.Tx) error {
		if _, e := t.Exec(ctx,
			`INSERT INTO warehouse_variant_stock (warehouse_id, product_id, variant_size, stock)
			 VALUES ($1,$2,$3,$4)
			 ON CONFLICT (warehouse_id, product_id, variant_size) DO UPDATE SET stock=EXCLUDED.stock`,
			warehouseID, a.ProductID, a.VariantSize, a.NewQty); e != nil {
			return e
		}
		_, e := t.Exec(ctx,
			`INSERT INTO warehouse_stock_adjustments (warehouse_id, product_id, variant_size, new_qty, reason, created_by)
			 VALUES ($1,$2,$3,$4,$5,$6)`,
			warehouseID, a.ProductID, a.VariantSize, a.NewQty, a.Reason, nullUUID(createdBy))
		return e
	})
}
```
Add `"fmt"` to the imports of `warehouse.go`. (`nullUUID` is in `write/repo.go`.)

- [ ] **Step 2:** `cd backend && gofmt -w internal/write/warehouse.go && go build ./... && cd ..` → exit 0.
- [ ] **Step 3: Commit.** `"feat(backend): warehouse goods-in + adjust"`.

### Task B2: Handlers + routes for goods-in + adjust
**Files:** `backend/internal/handlers/writes.go`, `backend/internal/server/server.go`.

- [ ] **Step 1: Handlers** (use `h.caller(r)` for created_by):
```go
func (h *Handlers) CreateGoodsReceipt(w http.ResponseWriter, r *http.Request) {
	g, ok := decodeWrite[write.GoodsReceipt](w, r); if !ok { return }
	c, _ := h.caller(r)
	h.mutated(w, r, h.Write.CreateGoodsReceipt(r.Context(), chi.URLParam(r, "id"), c.userID, g))
}
func (h *Handlers) AdjustWarehouseStock(w http.ResponseWriter, r *http.Request) {
	a, ok := decodeWrite[write.WarehouseAdjust](w, r); if !ok { return }
	c, _ := h.caller(r)
	h.mutated(w, r, h.Write.AdjustWarehouseStock(r.Context(), chi.URLParam(r, "id"), c.userID, a))
}
```
- [ ] **Step 2: Routes** — add inside the `manage_inventory` group from Task A5:
```go
r.Post("/warehouses/{id}/goods-receipt", h.CreateGoodsReceipt)
r.Post("/warehouses/{id}/adjust", h.AdjustWarehouseStock)
```
- [ ] **Step 3:** gofmt + `go build ./...` + `go vet ./...` → exit 0. Commit `"feat(backend): goods-in + adjust routes"`.

### Task B3: Deploy + verify Phase B
- [ ] Deploy + `/readyz`. With admin token: `POST /warehouses/{id}/goods-receipt` with 2 items → `GET /warehouses/{id}/stock` shows the summed qty; post again → qty increases (additive). `POST /warehouses/{id}/adjust` newQty=3 reason="koreksi" → stock becomes 3; adjust without reason → 400 "alasan wajib diisi".

---

## PHASE C — warehouse stock-count (polymorphic opname)

### Task C1: Make stockcount.go location-polymorphic
**Files:** Modify `backend/internal/write/stockcount.go`. Read it fully first.

- [ ] **Step 1:** `CreateStockCount` currently takes `outletID`. Add an optional warehouse scope. Change the signature/usage so a stock count is created for EITHER an outlet or a warehouse. Concretely: add a `WarehouseID string` to `StockCountCreate` (json `warehouseId`), and in the INSERT write `outlet_id` OR `warehouse_id` (whichever is set), leaving the other NULL:
```go
// in CreateStockCount, replace the INSERT's outlet_id binding:
//   use nullUUID(outletID) for outlet_id and nullUUID(s.WarehouseID) for warehouse_id
INSERT INTO stock_counts (name, status, outlet_id, warehouse_id, planned_date, notes, created_by)
VALUES ($1,$2,$3,$4,$5,$6,$7)
```
Pass `nullUUID(outletID)` and `nullUUID(s.WarehouseID)`; exactly one must be non-empty (validate: if both empty or both set → `fmt.Errorf("pilih outlet atau gudang")`).

- [ ] **Step 2:** `CompleteStockCount` currently writes counted qty to `outlet_variant_stock`. Branch on the count's location: read which of `outlet_id`/`warehouse_id` the row has, then write to the matching stock table. Add a helper:
```go
// locationOfCount returns ("outlet", outletID) or ("warehouse", warehouseID).
func locationOfCount(ctx context.Context, t pgx.Tx, scID string) (kind, id string, err error) {
	var oid, wid *string
	err = t.QueryRow(ctx, `SELECT outlet_id, warehouse_id FROM stock_counts WHERE id=$1`, scID).Scan(&oid, &wid)
	if err != nil { return "", "", err }
	if wid != nil { return "warehouse", *wid, nil }
	if oid != nil { return "outlet", *oid, nil }
	return "", "", fmt.Errorf("stock count has no location")
}
```
In `CompleteStockCount`, after determining `kind, locID`, write counted qty to the right table:
```go
if kind == "warehouse" {
	_, e = t.Exec(ctx,
		`INSERT INTO warehouse_variant_stock (warehouse_id, product_id, variant_size, stock)
		 VALUES ($1,$2,$3,$4)
		 ON CONFLICT (warehouse_id, product_id, variant_size) DO UPDATE SET stock = EXCLUDED.stock`,
		locID, it.ProductID, it.VariantSize, it.Counted)   // match existing item field names
} else {
	// existing outlet_variant_stock upsert, unchanged, using locID as outlet_id
}
```
Also: the existing `CompleteStockCount`/`UpdateStockCount`/`scopedSC` take `outletID` for scoping. For warehouse counts the caller passes `outletID=""`; relax `scopedSC` so admin/`manage_inventory` callers aren't blocked (or scope by id only). **Read the current `scopedSC` and preserve its outlet-scoping for outlet counts; for warehouse counts, scope by count id alone.** Flag any ambiguity rather than guess.

- [ ] **Step 3:** gofmt + `go build ./...` + `go test ./...` → exit 0 (existing stockcount behavior unchanged for outlets).
- [ ] **Step 4: Commit.** `"feat(backend): location-polymorphic stock-count (outlet|warehouse)"`.

### Task C2: OpenAPI + handlers/routes for warehouse opname
**Files:** `backend/api/openapi.yaml` (+regen), `handlers`, `server.go`.

- [ ] **Step 1:** Add `warehouseId` (nullable) to the existing `StockCountCreate`/create request schema in openapi; regen (`make gen-go && make gen-check`; pnpm api gen). If stock-count create isn't yet in openapi (it may be hand-typed), instead add `WarehouseID` to the hand `write.StockCountCreate` struct only — verify which. 
- [ ] **Step 2:** Stock-count create/update/complete handlers currently pass `scope(r).OutletID`. For a warehouse-scoped count the body carries `warehouseId` and outlet scope is empty. Ensure the create handler passes the body through. Gate warehouse counts under `manage_inventory` OR keep the existing `manage_stock_count` group and allow both — **decision: reuse `manage_stock_count`** (it's the opname permission) so one permission governs all counts; note this in the PR. Confirm the handler reads `warehouseId` from the decoded body.
- [ ] **Step 3:** gofmt + build + vet. Commit `"feat(api): warehouse-scoped stock-count"`.

### Task C3: Deploy + verify Phase C
- [ ] Deploy + `/readyz`. Create a warehouse-scoped stock count → start → complete with counted qty → `GET /warehouses/{id}/stock` reflects the counted numbers; differences recorded. Confirm an OUTLET stock count still works unchanged (regression).

---

## PHASE D — backoffice "Gudang" UI + permission

### Task D1: API client methods
**Files:** Modify `packages/api/src/client.ts` (Api interface ~line 85 + impls ~line 246, using the `data<T>('METHOD', url, body?)` helper and `API` base).

- [ ] **Step 1:** Add to the `Api` interface:
```ts
  listWarehouses: () => Promise<Warehouse[]>
  createWarehouse: (input: WarehouseInput) => Promise<{ id: string }>
  updateWarehouse: (id: string, input: WarehouseInput) => Promise<void>
  deleteWarehouse: (id: string) => Promise<void>
  getWarehouseStock: (id: string) => Promise<WarehouseStockRow[]>
  createGoodsReceipt: (id: string, input: GoodsReceiptInput) => Promise<void>
  adjustWarehouseStock: (id: string, input: WarehouseAdjustInput) => Promise<void>
```
Add impls in the returned object (mirror `createOutlet`/`listProducts`; unwrap `{data}` like other list methods do):
```ts
  listWarehouses: async () => (await data<{ data: Warehouse[] }>('GET', `${API}/warehouses`)).data,
  createWarehouse: (input) => data<{ id: string }>('POST', `${API}/warehouses`, input),
  updateWarehouse: async (id, input) => { await data('PUT', `${API}/warehouses/${id}`, input) },
  deleteWarehouse: async (id) => { await data('DELETE', `${API}/warehouses/${id}`) },
  getWarehouseStock: async (id) => (await data<{ data: WarehouseStockRow[] }>('GET', `${API}/warehouses/${id}/stock`)).data,
  createGoodsReceipt: async (id, input) => { await data('POST', `${API}/warehouses/${id}/goods-receipt`, input) },
  adjustWarehouseStock: async (id, input) => { await data('POST', `${API}/warehouses/${id}/adjust`, input) },
```
Import the new types (`Warehouse`, `WarehouseInput`, `WarehouseStockRow`, `GoodsReceiptInput`, `WarehouseAdjustInput`) from the generated schema, matching how `Outlet`/`Product` are imported at the top of `client.ts`. Verify the exact `data`/`API` names by reading `client.ts:240-270`.

- [ ] **Step 2:** `corepack pnpm --filter @mandalika/api exec tsc --noEmit` (or build the package) → clean. Commit `"feat(api-client): warehouse methods"`.

### Task D2: `manage_inventory` permission in the UI
**Files:** Modify `apps/backoffice/src/screens/Users.tsx` (`PERMS` map ~line 12).

- [ ] **Step 1:** Add to `PERMS`:
```ts
  manage_inventory: { label: 'Kelola Gudang', desc: 'Gudang, barang masuk & transfer stok' },
```
- [ ] **Step 2:** tsc check; commit `"feat(backoffice): manage_inventory permission"`.

### Task D3: Warehouses screen + nav
**Files:** Create `apps/backoffice/src/screens/Warehouses.tsx`; modify `apps/backoffice/src/App.tsx` (NAV array ~line 35, and the route/render switch).

- [ ] **Step 1: Build `Warehouses.tsx`.** Follow the structure of `screens/Outlets.tsx` (list + add/edit modal CRUD using `ui/` primitives: `PageHeader`, `Card`, `Button`, `Modal`, `Field`, `Input`, `Table`/list, `EmptyState`) and the per-product table pattern from `Products.tsx`. Three areas in one screen:
  1. **Warehouse list/CRUD** — `usePolledQuery(() => api.listWarehouses())`; add/edit modal with name/code/address/phone/isActive (mirror Outlets).
  2. **Stock view** — when a warehouse is selected, `api.getWarehouseStock(id)` → searchable table of productName/variantSize/sku/stock.
  3. **Goods-in modal** — pick lines (product+variant from the stock list) with qty + optional supplier/note/cost → `api.createGoodsReceipt(id, {supplier, note, items})`; refetch stock.
  4. **Adjust inline/modal** — per stock row, set newQty + reason → `api.adjustWarehouseStock(id, {productId, variantSize, newQty, reason})`; refetch.
  Keep it ≤ ~400 lines; if it grows, extract a `warehouses/` folder (GoodsInModal.tsx, StockTable.tsx). Reuse formatting helpers; no new color semantics (gold = primary, red = destructive).
  Surface API error messages inline (the `data` helper throws `Error(message)` from the `{error}` envelope — mirror how Products.tsx shows `e.message`).

- [ ] **Step 2: NAV + route.** In `App.tsx`, add to `NAV`:
```tsx
{ to: '/warehouses', label: 'Gudang', icon: <Warehouse className="w-5 h-5" />, perm: 'manage_inventory' },
```
(import `Warehouse` from `lucide-react`; match the exact NAV item shape already used — check an existing entry). Register the screen in the same place other screens are routed/rendered.

- [ ] **Step 3:** `corepack pnpm --filter @mandalika/backoffice exec tsc --noEmit` → clean; `corepack pnpm --filter @mandalika/backoffice build` → ok.
- [ ] **Step 4: Commit.** `"feat(backoffice): Gudang screen — warehouses, stock, goods-in, adjust"`.

### Task D4: Warehouse stock-count UI (reuse opname screen)
**Files:** the existing stock-count screen (find it: `grep -rl "stock-count\|StockCount\|opname\|stock_count" apps/backoffice/src`).

- [ ] **Step 1:** Let the existing opname screen target a **warehouse** as well as an outlet (a location-type toggle / location picker that lists outlets + warehouses). On create, pass `warehouseId` instead of relying on the outlet switcher when a warehouse is chosen. Reuse all the start/save/complete UI. If the opname screen is tightly outlet-coupled, flag it and scope this task to the minimal change that lets a warehouse count be created/completed.
- [ ] **Step 2:** tsc + build. Commit `"feat(backoffice): warehouse-scoped stock-count UI"`.

### Task D5: Push + verify SP1 end-to-end
- [ ] **Step 1:** `git push origin prod-hardening` (backoffice auto-deploys; backend already deployed in A6/B3/C3).
- [ ] **Step 2:** On the live backoffice: create a warehouse → it appears; stock view lists all variants at 0; goods-in adds qty; adjust sets qty with reason; run a warehouse stock-count end-to-end; confirm an outlet stock-count still works (regression).
- [ ] **Step 3:** Update memory + this plan's resume notes with the deployed rev + results.

---

## Progress / resume notes
- (fill in as you execute — deployed rev, verification results, any flagged stockcount-refactor ambiguity)
