# Recipe SP-Recipe-1 — Ingredient Inventory Subsystem — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **The 6 working rules (user-required, apply to every task):** 1) Ask, don't assume. 2) Don't touch unrelated code. 3) Flag uncertainty. 4) Verify on failure (never fake success). 5) Show changes (diffs). 6) Admit gaps.

**Goal:** Add a parallel ingredient inventory subsystem to the backoffice: ingredients catalog with fractional qty, per-warehouse stock, goods-in, manual adjust, warehouse↔warehouse transfers (with surat jalan + tanda terima PDF/PNG share mirroring SP4), and opname. All backoffice; POS untouched; gated by `manage_inventory` + the new `recipes_enabled` module flag.

**Architecture:** Seven new tables parallel to the existing product warehouse-stock + transfer machinery (no polymorphic extension — zero blast radius on stable SP1–SP4 code). Numeric(14,3) qty everywhere. New `recipes_enabled` boolean on `app_settings` defaulting to `false`; a `RequireRecipesEnabled` middleware 404s every ingredient endpoint when off, and the backoffice hides the Bahan tab via the same flag. Ingredient transfers reuse the SP4 `nextDocNo` / `formatDocNo` helpers with two new kind literals (`"ISJ"`, `"ITT"`) and clone the SP4 `SuratJalanPanel` for the backoffice doc share.

**Tech Stack:** Go (chi, pgx v5, oapi-codegen) + Postgres (Neon); TypeScript React backoffice (Vite, Tailwind, lucide-react); generated `@mandalika/api` client; `html-to-image` + `jspdf` (already in backoffice from SP4).

**Spec:** `docs/superpowers/specs/2026-05-27-recipe-sp1-ingredients-design.md`

**Status:** app is test-data-only on free-tier (not real sales) — standard deploy hygiene, no kid-gloves.

---

## Conventions reused from the codebase (read before starting)

- **Migration runner:** `cmd/server/main.go` boot embeds + applies migrations on startup. Files are `backend/internal/db/migrations/NNNN_name.sql`. The runner tracks by full filename — never rename.
- **Codegen:** `cd backend && make gen-go` regenerates `internal/api/api.gen.go`; `make gen-ts` regenerates `packages/api/src/schema.d.ts`. CI gate `make gen-check` fails if `api.gen.go` drifts — **always commit the regenerated file**. Run `gofmt -w internal/` before committing Go.
- **Doc sequences (SP4):** `backend/internal/write/doc_sequences.go` exposes pure `formatDocNo(kind, year, n)` and `nextDocNo(ctx, tx, kind, year)`. Existing kind literals = `"SJ"` (product surat jalan) and `"TT"` (product tanda terima). SP-Recipe-1 adds `"ISJ"` and `"ITT"` — formatted as `ISJ-2026-NNNNN` / `ITT-2026-NNNNN`. **No schema change needed** — the helper inserts new (kind, year) rows on first use via `INSERT … ON CONFLICT`.
- **Letterhead resolution (SP4):** `transferObj` in `backend/internal/read/repo.go` already COALESCE-resolves sender/receiver letterheads from outlet/warehouse `address` + `phone` + `logo_url`, falling back to `app_settings.documents_*`. Ingredient transfers reuse this exact pattern via a new SQL view/query (both legs are warehouses).
- **Permission gate:** `mw.RequirePermission("manage_inventory")` already exists (`backend/internal/middleware/middleware.go`). All ingredient routes register inside this group. Add a new `mw.RequireSetting("recipes_enabled")` middleware that fetches the singleton `app_settings` row and 404s when the column is false.
- **Polymorphic-leg pattern (SP2):** `backend/internal/write/transfer.go` shows the manual-tx + `bumpVersionOutlets` discipline. Ingredient transfers are warehouse↔warehouse only, so **never** bump `content_version` (mirrors the warehouse legs of SP2).
- **Null helpers:** `nullStr`, `nullUUID` in `write/repo.go`. `nullUUID("")` → NULL.
- **Read helpers:** `listJSON[T]`, `oneJSON[T]`, `off(page,limit)` in `read/repo.go`. Handlers helpers `pageLimit(r)`, `meta(total,p,l)`, `writeJSON`, `writeErr`, `decodeWrite[T]`, `h.caller(r)`, `h.created`, `h.mutated` in `handlers/`.
- **TS client:** types + `Api` interface + impl all live in `packages/api/src/client.ts`; `index.ts` re-exports types.
- **SuratJalanPanel pattern (SP4):** `apps/backoffice/src/screens/transfers/SuratJalanPanel.tsx` + `docs/SuratJalanDoc.tsx` + `docs/render.ts`. Clone the panel as `SuratJalanIngredientPanel.tsx` + `IngredientSuratJalanDoc.tsx`; **reuse `render.ts` unchanged** (it's pure HTML→PNG→PDF).
- **Commit hook:** blocks `--no-verify` and false-positives on chained `git commit && …`. Run `git commit` on its own line; push separately.
- **Deploy (agent can self-run):** `gcloud run deploy mandalika-pos --source backend --region asia-southeast2 --quiet` (use Bash with `dangerouslyDisableSandbox: true`; ~4–6 min). Verify `GET /readyz` (NOT `/healthz`). Backoffice auto-deploys on push to `prod-hardening`.
- **Test creds:** admin `admin@mandalika.test`; password in Secret Manager: `gcloud secrets versions access latest --secret=SEED_ADMIN_PASSWORD`.

---

## File map

**Backend (Go):**
- Create `backend/internal/db/migrations/0019_ingredients.sql`
- Modify `backend/api/openapi.yaml` (schemas + paths in five passes — A2 / B1 / C1 / D1 / A2's `AppSettings.recipesEnabled` patch)
- Regen `backend/internal/api/api.gen.go` + `packages/api/src/schema.d.ts`
- Create `backend/internal/write/ingredient.go` (CRUD + goods-in + adjust)
- Create `backend/internal/write/ingredient_transfer.go` (create/send/receive/cancel + doc stamping)
- Create `backend/internal/write/ingredient_transfer_test.go` (pure validation tests)
- Create `backend/internal/write/ingredient_stockcount.go` (create/start/save/complete)
- Modify `backend/internal/write/doc_sequences_test.go` (add ISJ/ITT cases)
- Modify `backend/internal/read/repo.go` (ingredient list + stock matrix + transfer detail w/ letterheads + stock-count list/detail + AppSettings.recipesEnabled passthrough)
- Modify `backend/internal/handlers/handlers.go` (`Handlers` struct unchanged) + `handlers/writes.go` (new handler methods) + new file `handlers/ingredients.go` if writes.go grows past 800 lines
- Modify `backend/internal/middleware/middleware.go` (new `RequireRecipesEnabled` middleware)
- Modify `backend/internal/server/server.go` (new ingredient route group inside `manage_inventory`)

**TypeScript (backoffice):**
- Modify `packages/api/src/client.ts` (export new types + `Api` interface methods + impls)
- Modify `packages/api/src/index.ts` (re-export new types if needed; index.ts already uses `export * from './client'`)
- Modify `apps/backoffice/src/screens/Warehouses.tsx` (add `Bahan` third tab, gated by `recipesEnabled`)
- Create `apps/backoffice/src/screens/ingredients/Ingredients.tsx` (the Bahan tab container with inner tab strip)
- Create `apps/backoffice/src/screens/ingredients/DaftarTab.tsx` (ingredients catalog CRUD)
- Create `apps/backoffice/src/screens/ingredients/IngredientFormModal.tsx`
- Create `apps/backoffice/src/screens/ingredients/StokTab.tsx` (per-warehouse stock matrix)
- Create `apps/backoffice/src/screens/ingredients/StokMasukTab.tsx` (goods-in form + history)
- Create `apps/backoffice/src/screens/ingredients/IngredientGoodsInModal.tsx`
- Create `apps/backoffice/src/screens/ingredients/PenyesuaianTab.tsx` (adjust form + history)
- Create `apps/backoffice/src/screens/ingredients/IngredientAdjustModal.tsx`
- Create `apps/backoffice/src/screens/ingredients/TransferTab.tsx` (mesh-style list + detail)
- Create `apps/backoffice/src/screens/ingredients/IngredientTransferForm.tsx`
- Create `apps/backoffice/src/screens/ingredients/IngredientReceiveModal.tsx`
- Create `apps/backoffice/src/screens/ingredients/SuratJalanIngredientPanel.tsx` (clone of SP4 panel)
- Create `apps/backoffice/src/screens/ingredients/docs/IngredientSuratJalanDoc.tsx` (clone of SP4 doc)
- Create `apps/backoffice/src/screens/ingredients/OpnameTab.tsx`
- Modify `apps/backoffice/src/screens/SettingsScreen.tsx` (new "Resep & Bahan" toggle)

---

## PHASE A — Schema + module flag + ingredients CRUD + stock read

### Task A1: Migration 0019 — ingredients core

**Files:** Create `backend/internal/db/migrations/0019_ingredients.sql`

- [ ] **Step 1: Write the migration.** The recipes tables (`recipes`, `recipe_versions`, `recipe_ingredients`) are out of scope here — they belong to SP-Recipe-2's later migration (e.g. 0020).

```sql
-- 0019: ingredient inventory subsystem (parallel to products/warehouses).
-- Numeric qty everywhere; warehouse-only; backoffice-only (never POS-synced).
-- Module-gated by app_settings.recipes_enabled (default false).

-- Module gate (singleton settings row gets one extra column)
ALTER TABLE app_settings ADD COLUMN recipes_enabled boolean NOT NULL DEFAULT false;

-- Ingredients catalog (flat — no variants)
CREATE TABLE ingredients (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text NOT NULL,
  unit                text NOT NULL,
  default_unit_cost   numeric(14,2),
  notes               text,
  is_active           boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_ingredients_active_name ON ingredients(is_active, name);

-- Per-warehouse stock (fractional)
CREATE TABLE ingredient_warehouse_stock (
  warehouse_id  uuid NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  ingredient_id uuid NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  qty           numeric(14,3) NOT NULL DEFAULT 0,
  PRIMARY KEY (warehouse_id, ingredient_id)
);

-- Goods-in for ingredients (additive)
CREATE TABLE ingredient_goods_receipts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id uuid NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  supplier     text,
  note         text,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ingredient_goods_receipt_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id    uuid NOT NULL REFERENCES ingredient_goods_receipts(id) ON DELETE CASCADE,
  ingredient_id uuid NOT NULL REFERENCES ingredients(id),
  qty           numeric(14,3) NOT NULL,
  unit_cost     numeric(14,2)
);

-- Manual adjust (absolute set + reason)
CREATE TABLE ingredient_stock_adjustments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id  uuid NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  ingredient_id uuid NOT NULL REFERENCES ingredients(id),
  new_qty       numeric(14,3) NOT NULL,
  reason        text NOT NULL,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Warehouse-to-warehouse transfers (Postgres SEQUENCE for the short id,
-- mirroring SP2 `transfers.transfer_no`).
CREATE SEQUENCE IF NOT EXISTS ingredient_transfer_no_seq;

CREATE TABLE ingredient_transfers (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_no              text NOT NULL DEFAULT ('ITRF-' || lpad(nextval('ingredient_transfer_no_seq')::text, 5, '0')),
  source_warehouse_id      uuid NOT NULL REFERENCES warehouses(id),
  dest_warehouse_id        uuid NOT NULL REFERENCES warehouses(id),
  status                   text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','in_transit','completed','cancelled')),
  surat_jalan_no           text UNIQUE,
  tanda_terima_no          text UNIQUE,
  note                     text,
  discrepancy_reason       text,
  created_by               uuid,
  created_at               timestamptz NOT NULL DEFAULT now(),
  sent_at                  timestamptz,
  sent_by                  uuid,
  received_at              timestamptz,
  received_by              uuid,
  cancelled_at             timestamptz,
  cancel_reason            text,
  CONSTRAINT ingredient_transfers_distinct CHECK (source_warehouse_id <> dest_warehouse_id)
);
CREATE INDEX idx_ingredient_transfers_status ON ingredient_transfers(status);

CREATE TABLE ingredient_transfer_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id   uuid NOT NULL REFERENCES ingredient_transfers(id) ON DELETE CASCADE,
  ingredient_id uuid NOT NULL REFERENCES ingredients(id),
  sent_qty      numeric(14,3) NOT NULL,
  received_qty  numeric(14,3),
  difference    numeric(14,3)
);
CREATE INDEX idx_ingredient_transfer_items_transfer ON ingredient_transfer_items(transfer_id);

-- Opname / stock-count for ingredients (warehouse-only)
CREATE TABLE ingredient_stock_counts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  status        text NOT NULL CHECK (status IN ('planned','in_progress','completed','cancelled')),
  warehouse_id  uuid NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  planned_date  date,
  notes         text,
  created_by    uuid,
  started_at    timestamptz,
  completed_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ingredient_stock_count_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stock_count_id  uuid NOT NULL REFERENCES ingredient_stock_counts(id) ON DELETE CASCADE,
  ingredient_id   uuid NOT NULL REFERENCES ingredients(id),
  ingredient_name text NOT NULL,
  ingredient_unit text NOT NULL,
  counted         numeric(14,3),
  difference      numeric(14,3)
);
```

- [ ] **Step 2: Sanity-build (migrations are embedded via `go:embed`).**

Run: `cd backend && go build ./...`
Expected: builds with no error (the SQL is embedded; not yet applied to any DB until the next deploy in Task A7).

- [ ] **Step 3: Commit.**

```bash
git add backend/internal/db/migrations/0019_ingredients.sql
git commit -m "feat(recipe): SP-Recipe-1 migration 0019 — ingredients + transfer + opname schema"
```

---

### Task A2: OpenAPI — `AppSettings.recipesEnabled` + ingredient schemas + CRUD paths

**Files:**
- Modify `backend/api/openapi.yaml` (one schema patch + new schemas + new paths)
- Regenerate `backend/internal/api/api.gen.go`, `packages/api/src/schema.d.ts`

- [ ] **Step 1: Patch `AppSettings` schema** — add `recipesEnabled` next to the existing `documents*` properties. Locate the `AppSettings:` block (~line 729) and insert a new property:

```yaml
        recipesEnabled: { type: boolean }
```
Add `recipesEnabled` to the `required` list of `AppSettings` only if every other field on it is already required — match the existing pattern; if other optional fields are present, leave it out of `required`.

- [ ] **Step 2: Add ingredient schemas** (place near the `WarehouseAdjustInput` block ~line 196):

```yaml
    Ingredient:
      type: object
      required: [id, name, unit, isActive, createdAt]
      properties:
        id: { type: string, format: uuid }
        name: { type: string }
        unit: { type: string }
        defaultUnitCost: { type: number, nullable: true }
        notes: { type: string, nullable: true }
        isActive: { type: boolean }
        createdAt: { type: string, format: date-time }
    IngredientInput:
      type: object
      required: [name, unit, isActive]
      properties:
        name: { type: string }
        unit: { type: string }
        defaultUnitCost: { type: number, nullable: true }
        notes: { type: string, nullable: true }
        isActive: { type: boolean }
    IngredientListResponse:
      type: object
      required: [data, meta]
      properties:
        data: { type: array, items: { $ref: '#/components/schemas/Ingredient' } }
        meta: { $ref: '#/components/schemas/Meta' }
    IngredientStockRow:
      type: object
      required: [ingredientId, name, unit, qty]
      properties:
        ingredientId: { type: string, format: uuid }
        name: { type: string }
        unit: { type: string }
        defaultUnitCost: { type: number, nullable: true }
        qty: { type: number }
    IngredientStockResponse:
      type: object
      required: [data]
      properties:
        data: { type: array, items: { $ref: '#/components/schemas/IngredientStockRow' } }
```

- [ ] **Step 3: Add ingredient paths** (insert immediately after the warehouse path block ~line 1606, before `/api/v1/transfers`):

```yaml
  /api/v1/ingredients:
    get:
      operationId: listIngredients
      tags: [catalog]
      summary: List ingredients
      parameters:
        - { name: page, in: query, required: false, schema: { type: integer } }
        - { name: limit, in: query, required: false, schema: { type: integer } }
        - { name: q, in: query, required: false, schema: { type: string } }
      responses:
        '200':
          description: ingredients
          content:
            application/json:
              schema: { $ref: '#/components/schemas/IngredientListResponse' }
    post:
      operationId: createIngredient
      tags: [catalog]
      summary: Create ingredient
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/IngredientInput' }
      responses:
        '201': { description: created }
  /api/v1/ingredients/{id}:
    put:
      operationId: updateIngredient
      tags: [catalog]
      parameters:
        - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/IngredientInput' }
      responses: { '200': { description: ok } }
    delete:
      operationId: deleteIngredient
      tags: [catalog]
      parameters:
        - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
      responses: { '200': { description: ok } }
  /api/v1/ingredients/stock:
    get:
      operationId: getIngredientStock
      tags: [catalog]
      summary: Per-warehouse ingredient stock
      parameters:
        - { name: warehouseId, in: query, required: true, schema: { type: string, format: uuid } }
      responses:
        '200':
          description: stock matrix
          content:
            application/json:
              schema: { $ref: '#/components/schemas/IngredientStockResponse' }
```

- [ ] **Step 4: Regenerate Go + TS bindings.**

```bash
cd backend && make gen-go
cd backend && make gen-ts
cd backend && go build ./...
```
Expected: codegen clean; build green; new `api.IngredientListResponse`, `api.IngredientInput` types appear in `internal/api/api.gen.go`.

- [ ] **Step 5: Commit.**

```bash
git add backend/api/openapi.yaml backend/internal/api/api.gen.go packages/api/src/schema.d.ts
git commit -m "feat(recipe): SP-Recipe-1 openapi — AppSettings.recipesEnabled + Ingredient schemas + CRUD paths"
```

---

### Task A3: `RequireRecipesEnabled` middleware

**Files:**
- Modify `backend/internal/middleware/middleware.go` (add new factory)
- Modify `backend/internal/read/repo.go` (small `RecipesEnabled(ctx)` helper if one doesn't exist)

- [ ] **Step 1: Add a read helper for the flag.** Inspect `read/repo.go` first for an existing `AppSettings` reader; if it already exposes the full row, reuse it. Otherwise add:

```go
// RecipesEnabled returns true when the Recipe / Formula module is turned on
// for this deployment. Reads the singleton app_settings row.
func (r *Repo) RecipesEnabled(ctx context.Context) (bool, error) {
    var enabled bool
    err := r.Pool.QueryRow(ctx,
        `SELECT COALESCE(recipes_enabled, false) FROM app_settings LIMIT 1`,
    ).Scan(&enabled)
    if errors.Is(err, pgx.ErrNoRows) {
        return false, nil
    }
    if err != nil {
        return false, fmt.Errorf("read recipes_enabled: %w", err)
    }
    return enabled, nil
}
```

- [ ] **Step 2: Add the middleware factory** in `middleware.go`:

```go
// RequireRecipesEnabled returns 404 when the Recipe/Formula module is
// turned off in app_settings. We return 404 (not 403) so deployments
// without the module look like the routes don't exist.
func RequireRecipesEnabled(rd interface {
    RecipesEnabled(ctx context.Context) (bool, error)
}) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            on, err := rd.RecipesEnabled(r.Context())
            if err != nil {
                httpx.Err(w, http.StatusInternalServerError, "settings read failed")
                return
            }
            if !on {
                httpx.Err(w, http.StatusNotFound, "not found")
                return
            }
            next.ServeHTTP(w, r)
        })
    }
}
```
Make sure the `http`, `context`, and `httpx` imports are present at the top of `middleware.go`.

- [ ] **Step 3: Sanity-build.** `cd backend && go build ./...` → green.

- [ ] **Step 4: Commit.**

```bash
git add backend/internal/middleware/middleware.go backend/internal/read/repo.go
git commit -m "feat(recipe): SP-Recipe-1 RequireRecipesEnabled middleware + RecipesEnabled read helper"
```

---

### Task A4: Write repo — ingredients CRUD

**Files:** Create `backend/internal/write/ingredient.go`

- [ ] **Step 1: Write the file.** Mirror the shape of `write/warehouse.go` (CRUD style).

```go
package write

import (
    "context"
    "errors"
    "fmt"

    "github.com/jackc/pgx/v5"
)

type Ingredient struct {
    Name            string   `json:"name"`
    Unit            string   `json:"unit"`
    DefaultUnitCost *float64 `json:"defaultUnitCost,omitempty"`
    Notes           string   `json:"notes,omitempty"`
    IsActive        bool     `json:"isActive"`
}

func validateIngredient(i Ingredient) error {
    if i.Name == "" {
        return fmt.Errorf("nama bahan wajib")
    }
    if i.Unit == "" {
        return fmt.Errorf("satuan bahan wajib")
    }
    return nil
}

func (r *Repo) CreateIngredient(ctx context.Context, in Ingredient) (string, error) {
    if err := validateIngredient(in); err != nil {
        return "", err
    }
    var id string
    err := r.Pool.QueryRow(ctx,
        `INSERT INTO ingredients (name, unit, default_unit_cost, notes, is_active)
         VALUES ($1, $2, $3, NULLIF($4,''), $5)
         RETURNING id`,
        in.Name, in.Unit, in.DefaultUnitCost, in.Notes, in.IsActive,
    ).Scan(&id)
    if err != nil {
        return "", fmt.Errorf("create ingredient: %w", err)
    }
    return id, nil
}

func (r *Repo) UpdateIngredient(ctx context.Context, id string, in Ingredient) error {
    if err := validateIngredient(in); err != nil {
        return err
    }
    tag, err := r.Pool.Exec(ctx,
        `UPDATE ingredients
            SET name=$2, unit=$3, default_unit_cost=$4, notes=NULLIF($5,''), is_active=$6
          WHERE id=$1`,
        id, in.Name, in.Unit, in.DefaultUnitCost, in.Notes, in.IsActive)
    if err != nil {
        return fmt.Errorf("update ingredient: %w", err)
    }
    if tag.RowsAffected() == 0 {
        return ErrNotFound
    }
    return nil
}

func (r *Repo) DeleteIngredient(ctx context.Context, id string) error {
    // Block if the ingredient is currently referenced by an in-transit transfer.
    var inTransit int
    if err := r.Pool.QueryRow(ctx,
        `SELECT COUNT(*) FROM ingredient_transfer_items i
          JOIN ingredient_transfers t ON t.id = i.transfer_id
         WHERE i.ingredient_id = $1 AND t.status = 'in_transit'`,
        id,
    ).Scan(&inTransit); err != nil {
        return fmt.Errorf("check ingredient transfers: %w", err)
    }
    if inTransit > 0 {
        return fmt.Errorf("bahan sedang dalam transfer berjalan (%d)", inTransit)
    }
    tag, err := r.Pool.Exec(ctx, `DELETE FROM ingredients WHERE id=$1`, id)
    if err != nil {
        return fmt.Errorf("delete ingredient: %w", err)
    }
    if tag.RowsAffected() == 0 {
        return ErrNotFound
    }
    return nil
}

// errors.Is sentinel — reuse the package's existing ErrNotFound if present;
// otherwise add it once in repo.go: var ErrNotFound = errors.New("not found").
var _ = errors.Is // keep the import used
var _ pgx.Tx       // keep the import used
```

- [ ] **Step 2: Check for an existing `ErrNotFound` sentinel.** Search: `grep -n "ErrNotFound" backend/internal/write/*.go`. If absent, add it to `repo.go`:

```go
var ErrNotFound = errors.New("not found")
```
Make sure `import "errors"` is present.

- [ ] **Step 3: Build.** `cd backend && gofmt -w internal/write && go build ./...` → green.

- [ ] **Step 4: Commit.**

```bash
git add backend/internal/write/ingredient.go backend/internal/write/repo.go
git commit -m "feat(recipe): SP-Recipe-1 ingredients CRUD write-repo"
```

---

### Task A5: Read repo — ingredients list + stock matrix

**Files:** Modify `backend/internal/read/repo.go`

- [ ] **Step 1: Add `Ingredients` + `IngredientStock` methods.** Place them near the existing `Warehouses` / `WarehouseStock` methods so the layout stays grouped.

```go
// Ingredients lists ingredients with simple name filter + pagination.
func (r *Repo) Ingredients(ctx context.Context, page, limit int, q string) ([]api.Ingredient, int, error) {
    const sql = `
      SELECT jsonb_build_object(
        'id', id, 'name', name, 'unit', unit,
        'defaultUnitCost', default_unit_cost,
        'notes', notes, 'isActive', is_active,
        'createdAt', to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')
      ),
      count(*) OVER ()
      FROM ingredients
      WHERE ($3 = '' OR name ILIKE '%' || $3 || '%')
      ORDER BY is_active DESC, name ASC
      OFFSET $1 LIMIT $2`
    return listJSON[api.Ingredient](ctx, r.Pool, sql, off(page, limit), limit, q)
}

// IngredientStock returns per-warehouse on-hand qty for every ingredient (left join
// so 0-qty rows are present), filtered to active ingredients.
func (r *Repo) IngredientStock(ctx context.Context, warehouseID string) ([]api.IngredientStockRow, error) {
    const sql = `
      SELECT jsonb_build_object(
        'ingredientId', i.id, 'name', i.name, 'unit', i.unit,
        'defaultUnitCost', i.default_unit_cost,
        'qty', COALESCE(s.qty, 0)
      )
      FROM ingredients i
      LEFT JOIN ingredient_warehouse_stock s
             ON s.ingredient_id = i.id AND s.warehouse_id = $1
     WHERE i.is_active
     ORDER BY i.name ASC`
    rows, _, err := listJSON[api.IngredientStockRow](ctx, r.Pool, sql, warehouseID)
    return rows, err
}
```

- [ ] **Step 2: Build.** `cd backend && gofmt -w internal/read && go build ./...` → green.

- [ ] **Step 3: Commit.**

```bash
git add backend/internal/read/repo.go
git commit -m "feat(recipe): SP-Recipe-1 ingredients list + stock read repo"
```

---

### Task A6: Handlers + routes

**Files:**
- Modify `backend/internal/handlers/writes.go` (new handler methods grouped together near the warehouse handlers)
- Modify `backend/internal/server/server.go` (new route group)

- [ ] **Step 1: Add ingredient handlers** in `handlers/writes.go`:

```go
// ── Ingredients ────────────────────────────────────────────

func (h *Handlers) Ingredients(w http.ResponseWriter, r *http.Request) {
    p, l := pageLimit(r)
    q := r.URL.Query().Get("q")
    rows, total, err := h.Repo.Ingredients(r.Context(), p, l, q)
    if err != nil {
        writeErr(w, 500, err)
        return
    }
    writeJSON(w, http.StatusOK, api.IngredientListResponse{Data: rows, Meta: meta(total, p, l)})
}

func (h *Handlers) CreateIngredient(w http.ResponseWriter, r *http.Request) {
    in, ok := decodeWrite[write.Ingredient](w, r)
    if !ok {
        return
    }
    id, err := h.Write.CreateIngredient(r.Context(), in)
    h.created(w, r, id, err)
}

func (h *Handlers) UpdateIngredient(w http.ResponseWriter, r *http.Request) {
    in, ok := decodeWrite[write.Ingredient](w, r)
    if !ok {
        return
    }
    h.mutated(w, r, h.Write.UpdateIngredient(r.Context(), chi.URLParam(r, "id"), in))
}

func (h *Handlers) DeleteIngredient(w http.ResponseWriter, r *http.Request) {
    h.mutated(w, r, h.Write.DeleteIngredient(r.Context(), chi.URLParam(r, "id")))
}

func (h *Handlers) IngredientStock(w http.ResponseWriter, r *http.Request) {
    whID := r.URL.Query().Get("warehouseId")
    if whID == "" {
        httpx.Err(w, http.StatusBadRequest, "warehouseId wajib")
        return
    }
    rows, err := h.Repo.IngredientStock(r.Context(), whID)
    if err != nil {
        writeErr(w, 500, err)
        return
    }
    writeJSON(w, http.StatusOK, api.IngredientStockResponse{Data: rows})
}
```

- [ ] **Step 2: Register routes** inside the existing `manage_inventory` group in `server.go` (after the existing transfer routes ~line 184). Wrap them with the new flag middleware:

```go
r.Group(func(r chi.Router) {
    r.Use(mw.RequireRecipesEnabled(rd))
    r.Get("/ingredients", h.Ingredients)
    r.Post("/ingredients", h.CreateIngredient)
    r.Put("/ingredients/{id}", h.UpdateIngredient)
    r.Delete("/ingredients/{id}", h.DeleteIngredient)
    r.Get("/ingredients/stock", h.IngredientStock)
})
```
Keep this group separate so we can also gate transfer + opname routes (added in C/D) the same way without rebuilding the group.

- [ ] **Step 3: Build.** `cd backend && gofmt -w internal/ && go build ./...` → green.

- [ ] **Step 4: Commit.**

```bash
git add backend/internal/handlers/writes.go backend/internal/server/server.go
git commit -m "feat(recipe): SP-Recipe-1 ingredient handlers + flag-gated routes"
```

---

### Task A7: Deploy + live verification (Phase A)

- [ ] **Step 1: Deploy backend** (migrations auto-apply on boot).

```bash
gcloud run deploy mandalika-pos --source backend --region asia-southeast2 --quiet
```
Expected: revision deploys; `GET https://mandalika-pos-538849926142.asia-southeast2.run.app/readyz` → `{"status":"ready"}`.

- [ ] **Step 2: Verify the flag-gate.** Without setting the flag, an admin call to `/api/v1/ingredients` must return 404.

```bash
TOKEN=$(curl -s -X POST https://mandalika-pos-538849926142.asia-southeast2.run.app/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d "{\"email\":\"admin@mandalika.test\",\"password\":\"$(gcloud secrets versions access latest --secret=SEED_ADMIN_PASSWORD)\"}" \
  | python -c "import json,sys;print(json.load(sys.stdin)['data']['accessToken'])")
curl -s -o /dev/null -w '%{http_code}\n' \
  https://mandalika-pos-538849926142.asia-southeast2.run.app/api/v1/ingredients \
  -H "authorization: Bearer $TOKEN"
```
Expected: `404`.

- [ ] **Step 3: Turn the flag on.**

```bash
curl -s -X PUT https://mandalika-pos-538849926142.asia-southeast2.run.app/api/v1/settings/app \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"recipesEnabled":true}'
```
Expected: 200 with the settings echoed back (`"recipesEnabled":true`).

- [ ] **Step 4: Smoke-test ingredients CRUD.**

```bash
# create
curl -s -X POST https://mandalika-pos-538849926142.asia-southeast2.run.app/api/v1/ingredients \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"Rose Oil","unit":"g","defaultUnitCost":15000,"notes":"SP-Recipe-1 verify","isActive":true}'
# list (expect the new row)
curl -s https://mandalika-pos-538849926142.asia-southeast2.run.app/api/v1/ingredients \
  -H "authorization: Bearer $TOKEN" | python -m json.tool | head -30
```
Expected: `data` contains a Rose Oil row with `unit:"g"`, `defaultUnitCost:15000`. Note its `id` for Phase B.

- [ ] **Step 5: Commit & push.**

```bash
git status -s   # should be clean
git push origin prod-hardening
```

---

## PHASE B — Goods-in + Adjust

### Task B1: OpenAPI — goods-in + adjust schemas + paths

**Files:** Modify `backend/api/openapi.yaml` + regen.

- [ ] **Step 1: Add schemas** (near the existing `IngredientStockResponse`):

```yaml
    IngredientGoodsReceiptItemInput:
      type: object
      required: [ingredientId, qty]
      properties:
        ingredientId: { type: string, format: uuid }
        qty: { type: number }
        unitCost: { type: number, nullable: true }
    IngredientGoodsReceiptInput:
      type: object
      required: [warehouseId, items]
      properties:
        warehouseId: { type: string, format: uuid }
        supplier: { type: string, nullable: true }
        note: { type: string, nullable: true }
        items: { type: array, items: { $ref: '#/components/schemas/IngredientGoodsReceiptItemInput' } }
    IngredientAdjustInput:
      type: object
      required: [warehouseId, ingredientId, newQty, reason]
      properties:
        warehouseId: { type: string, format: uuid }
        ingredientId: { type: string, format: uuid }
        newQty: { type: number }
        reason: { type: string }
```

- [ ] **Step 2: Add paths** (under the ingredient paths):

```yaml
  /api/v1/ingredients/goods-receipt:
    post:
      operationId: createIngredientGoodsReceipt
      tags: [catalog]
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/IngredientGoodsReceiptInput' }
      responses: { '201': { description: created } }
  /api/v1/ingredients/adjust:
    post:
      operationId: adjustIngredientStock
      tags: [catalog]
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/IngredientAdjustInput' }
      responses: { '200': { description: ok } }
```

- [ ] **Step 3: Regen + build.** `cd backend && make gen-go && make gen-ts && go build ./...` → green.

- [ ] **Step 4: Commit.**

```bash
git add backend/api/openapi.yaml backend/internal/api/api.gen.go packages/api/src/schema.d.ts
git commit -m "feat(recipe): SP-Recipe-1 openapi — ingredient goods-in + adjust"
```

---

### Task B2: Write repo — goods-in + adjust

**Files:** Modify `backend/internal/write/ingredient.go`

- [ ] **Step 1: Append goods-in + adjust methods** to `ingredient.go`:

```go
type IngredientGoodsReceiptItem struct {
    IngredientID string   `json:"ingredientId"`
    Qty          float64  `json:"qty"`
    UnitCost     *float64 `json:"unitCost,omitempty"`
}
type IngredientGoodsReceipt struct {
    WarehouseID string                       `json:"warehouseId"`
    Supplier    string                       `json:"supplier,omitempty"`
    Note        string                       `json:"note,omitempty"`
    Items       []IngredientGoodsReceiptItem `json:"items"`
}

func (r *Repo) CreateIngredientGoodsReceipt(ctx context.Context, caller string, in IngredientGoodsReceipt) (string, error) {
    if in.WarehouseID == "" {
        return "", fmt.Errorf("gudang wajib")
    }
    if len(in.Items) == 0 {
        return "", fmt.Errorf("minimal satu bahan")
    }
    for _, it := range in.Items {
        if it.Qty <= 0 {
            return "", fmt.Errorf("qty harus lebih dari 0")
        }
    }
    tx, err := r.Pool.Begin(ctx)
    if err != nil {
        return "", fmt.Errorf("begin tx: %w", err)
    }
    defer tx.Rollback(ctx)

    var rid string
    if err := tx.QueryRow(ctx,
        `INSERT INTO ingredient_goods_receipts (warehouse_id, supplier, note, created_by)
         VALUES ($1, NULLIF($2,''), NULLIF($3,''), NULLIF($4,'')::uuid)
         RETURNING id`,
        in.WarehouseID, in.Supplier, in.Note, caller,
    ).Scan(&rid); err != nil {
        return "", fmt.Errorf("insert receipt: %w", err)
    }
    for _, it := range in.Items {
        if _, err := tx.Exec(ctx,
            `INSERT INTO ingredient_goods_receipt_items (receipt_id, ingredient_id, qty, unit_cost)
             VALUES ($1, $2, $3, $4)`,
            rid, it.IngredientID, it.Qty, it.UnitCost,
        ); err != nil {
            return "", fmt.Errorf("insert receipt item: %w", err)
        }
        if _, err := tx.Exec(ctx,
            `INSERT INTO ingredient_warehouse_stock (warehouse_id, ingredient_id, qty)
                  VALUES ($1, $2, $3)
             ON CONFLICT (warehouse_id, ingredient_id)
             DO UPDATE SET qty = ingredient_warehouse_stock.qty + EXCLUDED.qty`,
            in.WarehouseID, it.IngredientID, it.Qty,
        ); err != nil {
            return "", fmt.Errorf("upsert stock: %w", err)
        }
    }
    if err := tx.Commit(ctx); err != nil {
        return "", fmt.Errorf("commit tx: %w", err)
    }
    return rid, nil
}

type IngredientAdjust struct {
    WarehouseID  string  `json:"warehouseId"`
    IngredientID string  `json:"ingredientId"`
    NewQty       float64 `json:"newQty"`
    Reason       string  `json:"reason"`
}

func (r *Repo) AdjustIngredientStock(ctx context.Context, caller string, in IngredientAdjust) error {
    if in.WarehouseID == "" || in.IngredientID == "" {
        return fmt.Errorf("gudang dan bahan wajib")
    }
    if in.NewQty < 0 {
        return fmt.Errorf("qty tidak boleh negatif")
    }
    if in.Reason == "" {
        return fmt.Errorf("alasan wajib")
    }
    tx, err := r.Pool.Begin(ctx)
    if err != nil {
        return fmt.Errorf("begin tx: %w", err)
    }
    defer tx.Rollback(ctx)
    if _, err := tx.Exec(ctx,
        `INSERT INTO ingredient_warehouse_stock (warehouse_id, ingredient_id, qty)
              VALUES ($1, $2, $3)
         ON CONFLICT (warehouse_id, ingredient_id)
         DO UPDATE SET qty = EXCLUDED.qty`,
        in.WarehouseID, in.IngredientID, in.NewQty,
    ); err != nil {
        return fmt.Errorf("upsert stock: %w", err)
    }
    if _, err := tx.Exec(ctx,
        `INSERT INTO ingredient_stock_adjustments (warehouse_id, ingredient_id, new_qty, reason, created_by)
         VALUES ($1, $2, $3, $4, NULLIF($5,'')::uuid)`,
        in.WarehouseID, in.IngredientID, in.NewQty, in.Reason, caller,
    ); err != nil {
        return fmt.Errorf("insert adjustment: %w", err)
    }
    return tx.Commit(ctx)
}
```

- [ ] **Step 2: Build.** `cd backend && gofmt -w internal/write && go build ./...` → green.

- [ ] **Step 3: Commit.**

```bash
git add backend/internal/write/ingredient.go
git commit -m "feat(recipe): SP-Recipe-1 ingredient goods-in + adjust write-repo"
```

---

### Task B3: Handlers + routes + deploy + verify

**Files:** Modify `backend/internal/handlers/writes.go`, `backend/internal/server/server.go`

- [ ] **Step 1: Add handlers** in `writes.go`:

```go
func (h *Handlers) CreateIngredientGoodsReceipt(w http.ResponseWriter, r *http.Request) {
    in, ok := decodeWrite[write.IngredientGoodsReceipt](w, r)
    if !ok {
        return
    }
    c, _ := h.caller(r)
    id, err := h.Write.CreateIngredientGoodsReceipt(r.Context(), c.userID, in)
    h.created(w, r, id, err)
}

func (h *Handlers) AdjustIngredientStock(w http.ResponseWriter, r *http.Request) {
    in, ok := decodeWrite[write.IngredientAdjust](w, r)
    if !ok {
        return
    }
    c, _ := h.caller(r)
    h.mutated(w, r, h.Write.AdjustIngredientStock(r.Context(), c.userID, in))
}
```

- [ ] **Step 2: Register routes** in the existing recipes-enabled group in `server.go`:

```go
    r.Post("/ingredients/goods-receipt", h.CreateIngredientGoodsReceipt)
    r.Post("/ingredients/adjust", h.AdjustIngredientStock)
```

- [ ] **Step 3: Build + deploy.**

```bash
cd backend && gofmt -w internal/ && go build ./...
gcloud run deploy mandalika-pos --source backend --region asia-southeast2 --quiet
```

- [ ] **Step 4: Verify live.** Reuse the TOKEN + ingredient id + an existing warehouse id (`gcloud secrets versions access latest --secret=SEED_ADMIN_PASSWORD` for login if the token expired).

```bash
INGREDIENT_ID="<from-A7>"; WAREHOUSE_ID="<from-warehouses-list>"
# Goods-in 1000 g
curl -s -X POST https://mandalika-pos-538849926142.asia-southeast2.run.app/api/v1/ingredients/goods-receipt \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"warehouseId\":\"$WAREHOUSE_ID\",\"supplier\":\"Verify B\",\"items\":[{\"ingredientId\":\"$INGREDIENT_ID\",\"qty\":1000,\"unitCost\":15000}]}"
# Verify stock = 1000
curl -s "https://mandalika-pos-538849926142.asia-southeast2.run.app/api/v1/ingredients/stock?warehouseId=$WAREHOUSE_ID" \
  -H "authorization: Bearer $TOKEN"
# Adjust to 945.5 with reason
curl -s -X POST https://mandalika-pos-538849926142.asia-southeast2.run.app/api/v1/ingredients/adjust \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"warehouseId\":\"$WAREHOUSE_ID\",\"ingredientId\":\"$INGREDIENT_ID\",\"newQty\":945.5,\"reason\":\"susut\"}"
# Verify stock = 945.5
curl -s "https://mandalika-pos-538849926142.asia-southeast2.run.app/api/v1/ingredients/stock?warehouseId=$WAREHOUSE_ID" \
  -H "authorization: Bearer $TOKEN"
# Adjust with no reason → 400
curl -s -o /dev/null -w '%{http_code}\n' \
  -X POST https://mandalika-pos-538849926142.asia-southeast2.run.app/api/v1/ingredients/adjust \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"warehouseId\":\"$WAREHOUSE_ID\",\"ingredientId\":\"$INGREDIENT_ID\",\"newQty\":900,\"reason\":\"\"}"
```
Expected: stock 1000 → 945.5; no-reason call returns `400`.

- [ ] **Step 5: Commit + push.**

```bash
git add backend/internal/handlers/writes.go backend/internal/server/server.go
git commit -m "feat(recipe): SP-Recipe-1 ingredient goods-in + adjust handlers"
git push origin prod-hardening
```

---

## PHASE C — Ingredient transfers (send / receive / cancel) + doc numbering

### Task C1: OpenAPI — IngredientTransfer schemas + paths

**Files:** Modify `backend/api/openapi.yaml` + regen.

- [ ] **Step 1: Add schemas** (mirror SP2 `Transfer` shape but warehouse-only + numeric qty):

```yaml
    IngredientTransferItem:
      type: object
      required: [id, ingredientId, ingredientName, ingredientUnit, sentQty]
      properties:
        id: { type: string, format: uuid }
        ingredientId: { type: string, format: uuid }
        ingredientName: { type: string }
        ingredientUnit: { type: string }
        sentQty: { type: number }
        receivedQty: { type: number, nullable: true }
        difference: { type: number, nullable: true }
    IngredientTransfer:
      type: object
      required: [id, transferNo, status, sourceWarehouseId, destWarehouseId, createdAt, items]
      properties:
        id: { type: string, format: uuid }
        transferNo: { type: string }
        status: { type: string, enum: [draft, in_transit, completed, cancelled] }
        sourceWarehouseId: { type: string, format: uuid }
        sourceWarehouseName: { type: string }
        destWarehouseId: { type: string, format: uuid }
        destWarehouseName: { type: string }
        suratJalanNo: { type: string, nullable: true }
        tandaTerimaNo: { type: string, nullable: true }
        note: { type: string, nullable: true }
        discrepancyReason: { type: string, nullable: true }
        createdAt: { type: string, format: date-time }
        sentAt: { type: string, format: date-time, nullable: true }
        receivedAt: { type: string, format: date-time, nullable: true }
        cancelledAt: { type: string, format: date-time, nullable: true }
        cancelReason: { type: string, nullable: true }
        senderLetterhead: { $ref: '#/components/schemas/Letterhead', nullable: true }
        receiverLetterhead: { $ref: '#/components/schemas/Letterhead', nullable: true }
        items: { type: array, items: { $ref: '#/components/schemas/IngredientTransferItem' } }
    IngredientTransferListResponse:
      type: object
      required: [data, meta]
      properties:
        data: { type: array, items: { $ref: '#/components/schemas/IngredientTransfer' } }
        meta: { $ref: '#/components/schemas/Meta' }
    IngredientTransferResponse:
      type: object
      required: [data]
      properties:
        data: { $ref: '#/components/schemas/IngredientTransfer' }
    IngredientTransferItemInput:
      type: object
      required: [ingredientId, qty]
      properties:
        ingredientId: { type: string, format: uuid }
        qty: { type: number }
    IngredientTransferCreateInput:
      type: object
      required: [sourceWarehouseId, destWarehouseId, items]
      properties:
        sourceWarehouseId: { type: string, format: uuid }
        destWarehouseId: { type: string, format: uuid }
        note: { type: string, nullable: true }
        items: { type: array, items: { $ref: '#/components/schemas/IngredientTransferItemInput' } }
    IngredientTransferReceiveItemInput:
      type: object
      required: [itemId, receivedQty]
      properties:
        itemId: { type: string, format: uuid }
        receivedQty: { type: number }
    IngredientTransferReceiveInput:
      type: object
      required: [items]
      properties:
        items: { type: array, items: { $ref: '#/components/schemas/IngredientTransferReceiveItemInput' } }
        discrepancyReason: { type: string, nullable: true }
    IngredientTransferCancelInput:
      type: object
      required: [reason]
      properties:
        reason: { type: string }
```
**Note:** `Letterhead` schema already exists in `openapi.yaml` from SP4 — reuse it as-is.

- [ ] **Step 2: Add paths** (under the existing ingredient paths):

```yaml
  /api/v1/ingredient-transfers:
    get:
      operationId: listIngredientTransfers
      tags: [catalog]
      parameters:
        - { name: status, in: query, required: false, schema: { type: string } }
        - { name: page, in: query, required: false, schema: { type: integer } }
        - { name: limit, in: query, required: false, schema: { type: integer } }
      responses:
        '200':
          description: ingredient transfers
          content:
            application/json:
              schema: { $ref: '#/components/schemas/IngredientTransferListResponse' }
    post:
      operationId: createIngredientTransfer
      tags: [catalog]
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/IngredientTransferCreateInput' }
      responses: { '201': { description: created } }
  /api/v1/ingredient-transfers/{id}:
    get:
      operationId: getIngredientTransfer
      tags: [catalog]
      parameters:
        - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
      responses:
        '200':
          description: ingredient transfer
          content:
            application/json:
              schema: { $ref: '#/components/schemas/IngredientTransferResponse' }
  /api/v1/ingredient-transfers/{id}/send:
    post:
      operationId: sendIngredientTransfer
      tags: [catalog]
      parameters:
        - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
      responses: { '200': { description: ok } }
  /api/v1/ingredient-transfers/{id}/receive:
    post:
      operationId: receiveIngredientTransfer
      tags: [catalog]
      parameters:
        - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/IngredientTransferReceiveInput' }
      responses: { '200': { description: ok } }
  /api/v1/ingredient-transfers/{id}/cancel:
    post:
      operationId: cancelIngredientTransfer
      tags: [catalog]
      parameters:
        - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/IngredientTransferCancelInput' }
      responses: { '200': { description: ok } }
```

- [ ] **Step 3: Regen + build + commit.**

```bash
cd backend && make gen-go && make gen-ts && go build ./...
git add backend/api/openapi.yaml backend/internal/api/api.gen.go packages/api/src/schema.d.ts
git commit -m "feat(recipe): SP-Recipe-1 openapi — ingredient transfers (mesh wh<->wh)"
```

---

### Task C2: Extend `nextDocNo` tests — `ISJ` + `ITT` kinds

**Files:** Modify `backend/internal/write/doc_sequences_test.go`

- [ ] **Step 1: Add table rows for the new kinds.** Open the file and locate the existing `TestFormatDocNo` table; append:

```go
        {kind: "ISJ", year: 2026, n: 1, want: "ISJ-2026-00001"},
        {kind: "ITT", year: 2026, n: 42, want: "ITT-2026-00042"},
        {kind: "ISJ", year: 2027, n: 1, want: "ISJ-2027-00001"},
```

- [ ] **Step 2: Run.** `cd backend && go test ./internal/write/ -run TestFormatDocNo -race -v` → all pass.

- [ ] **Step 3: Commit.**

```bash
git add backend/internal/write/doc_sequences_test.go
git commit -m "test(recipe): SP-Recipe-1 formatDocNo — ISJ/ITT cases"
```

---

### Task C3: Write repo — ingredient transfers (create / send / receive / cancel)

**Files:**
- Create `backend/internal/write/ingredient_transfer.go`
- Create `backend/internal/write/ingredient_transfer_test.go`

- [ ] **Step 1: Write `ingredient_transfer.go`.** Mirror SP2's `transfer.go` shape — manual tx for send/receive/cancel, no `bumpVersionOutlets` (no POS sync).

```go
package write

import (
    "context"
    "errors"
    "fmt"
    "time"

    "github.com/jackc/pgx/v5"
)

type IngredientTransferItemInput struct {
    IngredientID string  `json:"ingredientId"`
    Qty          float64 `json:"qty"`
}
type IngredientTransferCreate struct {
    SourceWarehouseID string                        `json:"sourceWarehouseId"`
    DestWarehouseID   string                        `json:"destWarehouseId"`
    Note              string                        `json:"note"`
    Items             []IngredientTransferItemInput `json:"items"`
}

type IngredientTransferReceiveItem struct {
    ItemID      string  `json:"itemId"`
    ReceivedQty float64 `json:"receivedQty"`
}
type IngredientTransferReceive struct {
    Items             []IngredientTransferReceiveItem `json:"items"`
    DiscrepancyReason string                          `json:"discrepancyReason"`
}

func validateIngTransfer(c IngredientTransferCreate) error {
    if c.SourceWarehouseID == "" || c.DestWarehouseID == "" {
        return fmt.Errorf("gudang sumber dan tujuan wajib")
    }
    if c.SourceWarehouseID == c.DestWarehouseID {
        return fmt.Errorf("sumber dan tujuan tidak boleh sama")
    }
    if len(c.Items) == 0 {
        return fmt.Errorf("minimal satu bahan")
    }
    for _, it := range c.Items {
        if it.IngredientID == "" || it.Qty <= 0 {
            return fmt.Errorf("qty harus lebih dari 0")
        }
    }
    return nil
}

func (r *Repo) CreateIngredientTransfer(ctx context.Context, caller string, in IngredientTransferCreate) (string, error) {
    if err := validateIngTransfer(in); err != nil {
        return "", err
    }
    tx, err := r.Pool.Begin(ctx)
    if err != nil {
        return "", fmt.Errorf("begin tx: %w", err)
    }
    defer tx.Rollback(ctx)
    var id string
    if err := tx.QueryRow(ctx,
        `INSERT INTO ingredient_transfers
             (source_warehouse_id, dest_warehouse_id, note, created_by)
         VALUES ($1, $2, NULLIF($3,''), NULLIF($4,'')::uuid)
         RETURNING id`,
        in.SourceWarehouseID, in.DestWarehouseID, in.Note, caller,
    ).Scan(&id); err != nil {
        return "", fmt.Errorf("insert transfer: %w", err)
    }
    for _, it := range in.Items {
        if _, err := tx.Exec(ctx,
            `INSERT INTO ingredient_transfer_items (transfer_id, ingredient_id, sent_qty)
             VALUES ($1, $2, $3)`,
            id, it.IngredientID, it.Qty,
        ); err != nil {
            return "", fmt.Errorf("insert transfer item: %w", err)
        }
    }
    if err := tx.Commit(ctx); err != nil {
        return "", fmt.Errorf("commit tx: %w", err)
    }
    return id, nil
}

func (r *Repo) SendIngredientTransfer(ctx context.Context, caller, id string) error {
    tx, err := r.Pool.Begin(ctx)
    if err != nil {
        return fmt.Errorf("begin tx: %w", err)
    }
    defer tx.Rollback(ctx)

    var status, src string
    if err := tx.QueryRow(ctx,
        `SELECT status, source_warehouse_id FROM ingredient_transfers WHERE id=$1 FOR UPDATE`,
        id,
    ).Scan(&status, &src); err != nil {
        if errors.Is(err, pgx.ErrNoRows) {
            return ErrNotFound
        }
        return fmt.Errorf("load transfer: %w", err)
    }
    if status != "draft" {
        return fmt.Errorf("transfer tidak dalam status draft")
    }

    // Validate source on-hand ≥ each sent_qty; deduct in tx.
    rows, err := tx.Query(ctx,
        `SELECT ingredient_id, sent_qty FROM ingredient_transfer_items WHERE transfer_id=$1`, id,
    )
    if err != nil {
        return fmt.Errorf("load items: %w", err)
    }
    type line struct {
        ingID string
        qty   float64
    }
    var items []line
    for rows.Next() {
        var l line
        if err := rows.Scan(&l.ingID, &l.qty); err != nil {
            rows.Close()
            return fmt.Errorf("scan item: %w", err)
        }
        items = append(items, l)
    }
    rows.Close()
    if err := rows.Err(); err != nil {
        return fmt.Errorf("iterate items: %w", err)
    }

    for _, l := range items {
        var have float64
        err := tx.QueryRow(ctx,
            `SELECT COALESCE(qty,0) FROM ingredient_warehouse_stock
              WHERE warehouse_id=$1 AND ingredient_id=$2 FOR UPDATE`,
            src, l.ingID,
        ).Scan(&have)
        if errors.Is(err, pgx.ErrNoRows) {
            have = 0
        } else if err != nil {
            return fmt.Errorf("lock stock: %w", err)
        }
        if have < l.qty {
            return fmt.Errorf("stok kurang untuk bahan %s (tersedia %.3f, butuh %.3f)", l.ingID, have, l.qty)
        }
        if _, err := tx.Exec(ctx,
            `UPDATE ingredient_warehouse_stock SET qty = qty - $3
              WHERE warehouse_id=$1 AND ingredient_id=$2`,
            src, l.ingID, l.qty,
        ); err != nil {
            return fmt.Errorf("deduct stock: %w", err)
        }
    }

    // Stamp surat jalan (per-year ISJ counter) + mark in_transit.
    sj, err := nextDocNo(ctx, tx, "ISJ", time.Now().Year())
    if err != nil {
        return err
    }
    if _, err := tx.Exec(ctx,
        `UPDATE ingredient_transfers
            SET status='in_transit', sent_at=now(), sent_by=NULLIF($2,'')::uuid, surat_jalan_no=$3
          WHERE id=$1`,
        id, caller, sj,
    ); err != nil {
        return fmt.Errorf("stamp send: %w", err)
    }
    return tx.Commit(ctx)
}

func (r *Repo) ReceiveIngredientTransfer(ctx context.Context, caller, id string, in IngredientTransferReceive) error {
    tx, err := r.Pool.Begin(ctx)
    if err != nil {
        return fmt.Errorf("begin tx: %w", err)
    }
    defer tx.Rollback(ctx)

    var status, dst string
    if err := tx.QueryRow(ctx,
        `SELECT status, dest_warehouse_id FROM ingredient_transfers WHERE id=$1 FOR UPDATE`,
        id,
    ).Scan(&status, &dst); err != nil {
        if errors.Is(err, pgx.ErrNoRows) {
            return ErrNotFound
        }
        return fmt.Errorf("load transfer: %w", err)
    }
    if status == "completed" {
        // Idempotent replay: already done; treat as success.
        return tx.Commit(ctx)
    }
    if status != "in_transit" {
        return fmt.Errorf("transfer tidak dalam status in_transit")
    }

    // Per-item: compute difference, credit dest with actual received_qty.
    hasDiff := false
    for _, it := range in.Items {
        if it.ReceivedQty < 0 {
            return fmt.Errorf("qty tidak boleh negatif")
        }
        var ingID string
        var sent float64
        if err := tx.QueryRow(ctx,
            `SELECT ingredient_id, sent_qty FROM ingredient_transfer_items
              WHERE id=$1 AND transfer_id=$2 FOR UPDATE`,
            it.ItemID, id,
        ).Scan(&ingID, &sent); err != nil {
            return fmt.Errorf("load item %s: %w", it.ItemID, err)
        }
        diff := it.ReceivedQty - sent
        if diff != 0 {
            hasDiff = true
        }
        if _, err := tx.Exec(ctx,
            `UPDATE ingredient_transfer_items
                SET received_qty=$2, difference=$3 WHERE id=$1`,
            it.ItemID, it.ReceivedQty, diff,
        ); err != nil {
            return fmt.Errorf("update item: %w", err)
        }
        if _, err := tx.Exec(ctx,
            `INSERT INTO ingredient_warehouse_stock (warehouse_id, ingredient_id, qty)
                  VALUES ($1, $2, $3)
             ON CONFLICT (warehouse_id, ingredient_id)
             DO UPDATE SET qty = ingredient_warehouse_stock.qty + EXCLUDED.qty`,
            dst, ingID, it.ReceivedQty,
        ); err != nil {
            return fmt.Errorf("credit dest: %w", err)
        }
    }
    if hasDiff && in.DiscrepancyReason == "" {
        return fmt.Errorf("alasan selisih wajib")
    }

    tt, err := nextDocNo(ctx, tx, "ITT", time.Now().Year())
    if err != nil {
        return err
    }
    if _, err := tx.Exec(ctx,
        `UPDATE ingredient_transfers
            SET status='completed', received_at=now(),
                received_by=NULLIF($2,'')::uuid,
                tanda_terima_no=$3,
                discrepancy_reason=NULLIF($4,'')
          WHERE id=$1`,
        id, caller, tt, in.DiscrepancyReason,
    ); err != nil {
        return fmt.Errorf("stamp receive: %w", err)
    }
    return tx.Commit(ctx)
}

func (r *Repo) CancelIngredientTransfer(ctx context.Context, caller, id, reason string) error {
    if reason == "" {
        return fmt.Errorf("alasan wajib")
    }
    tx, err := r.Pool.Begin(ctx)
    if err != nil {
        return fmt.Errorf("begin tx: %w", err)
    }
    defer tx.Rollback(ctx)

    var status, src string
    if err := tx.QueryRow(ctx,
        `SELECT status, source_warehouse_id FROM ingredient_transfers WHERE id=$1 FOR UPDATE`,
        id,
    ).Scan(&status, &src); err != nil {
        if errors.Is(err, pgx.ErrNoRows) {
            return ErrNotFound
        }
        return fmt.Errorf("load transfer: %w", err)
    }
    switch status {
    case "draft":
        // pure void
    case "in_transit":
        // restore source stock
        rows, err := tx.Query(ctx,
            `SELECT ingredient_id, sent_qty FROM ingredient_transfer_items WHERE transfer_id=$1`, id,
        )
        if err != nil {
            return fmt.Errorf("load items: %w", err)
        }
        for rows.Next() {
            var ing string
            var qty float64
            if err := rows.Scan(&ing, &qty); err != nil {
                rows.Close()
                return fmt.Errorf("scan item: %w", err)
            }
            if _, err := tx.Exec(ctx,
                `INSERT INTO ingredient_warehouse_stock (warehouse_id, ingredient_id, qty)
                      VALUES ($1, $2, $3)
                 ON CONFLICT (warehouse_id, ingredient_id)
                 DO UPDATE SET qty = ingredient_warehouse_stock.qty + EXCLUDED.qty`,
                src, ing, qty,
            ); err != nil {
                rows.Close()
                return fmt.Errorf("restore stock: %w", err)
            }
        }
        rows.Close()
    default:
        return fmt.Errorf("status %q tidak bisa dibatalkan", status)
    }
    if _, err := tx.Exec(ctx,
        `UPDATE ingredient_transfers
            SET status='cancelled', cancelled_at=now(), cancel_reason=$2
          WHERE id=$1`,
        id, reason,
    ); err != nil {
        return fmt.Errorf("mark cancelled: %w", err)
    }
    return tx.Commit(ctx)
}
```

- [ ] **Step 2: Write pure-validation tests** in `ingredient_transfer_test.go`:

```go
package write

import "testing"

func TestValidateIngTransfer(t *testing.T) {
    t.Parallel()
    cases := []struct {
        name string
        in   IngredientTransferCreate
        ok   bool
    }{
        {
            "happy",
            IngredientTransferCreate{
                SourceWarehouseID: "src", DestWarehouseID: "dst",
                Items: []IngredientTransferItemInput{{IngredientID: "i1", Qty: 1.5}},
            },
            true,
        },
        {
            "same src/dst",
            IngredientTransferCreate{
                SourceWarehouseID: "a", DestWarehouseID: "a",
                Items: []IngredientTransferItemInput{{IngredientID: "i1", Qty: 1}},
            },
            false,
        },
        {
            "empty items",
            IngredientTransferCreate{
                SourceWarehouseID: "src", DestWarehouseID: "dst",
            },
            false,
        },
        {
            "zero qty",
            IngredientTransferCreate{
                SourceWarehouseID: "src", DestWarehouseID: "dst",
                Items: []IngredientTransferItemInput{{IngredientID: "i1", Qty: 0}},
            },
            false,
        },
    }
    for _, tc := range cases {
        t.Run(tc.name, func(t *testing.T) {
            err := validateIngTransfer(tc.in)
            if tc.ok && err != nil {
                t.Fatalf("want ok, got %v", err)
            }
            if !tc.ok && err == nil {
                t.Fatal("want error, got nil")
            }
        })
    }
}
```

- [ ] **Step 3: Run + build.** `cd backend && gofmt -w internal/write && go test ./internal/write/ -run TestValidateIngTransfer -race -v && go build ./...`

- [ ] **Step 4: Commit.**

```bash
git add backend/internal/write/ingredient_transfer.go backend/internal/write/ingredient_transfer_test.go
git commit -m "feat(recipe): SP-Recipe-1 ingredient transfer write-repo (send/receive/cancel)"
```

---

### Task C4: Read repo — transfer list + detail (with letterheads)

**Files:** Modify `backend/internal/read/repo.go`

- [ ] **Step 1: Add list + detail methods.** Look at the existing SP2 `transferObj` query for the letterhead-COALESCE pattern and replicate it for ingredient transfers, but with both legs as warehouses.

```go
// IngredientTransfers — list with optional status filter + pagination.
func (r *Repo) IngredientTransfers(ctx context.Context, page, limit int, status string) ([]api.IngredientTransfer, int, error) {
    const sql = `
      WITH t AS (
        SELECT it.*,
               ws.name AS src_name,
               wd.name AS dst_name
          FROM ingredient_transfers it
          JOIN warehouses ws ON ws.id = it.source_warehouse_id
          JOIN warehouses wd ON wd.id = it.dest_warehouse_id
         WHERE ($3 = '' OR it.status = $3)
      )
      SELECT jsonb_build_object(
        'id', t.id, 'transferNo', t.transfer_no, 'status', t.status,
        'sourceWarehouseId', t.source_warehouse_id, 'sourceWarehouseName', t.src_name,
        'destWarehouseId',   t.dest_warehouse_id,   'destWarehouseName',   t.dst_name,
        'suratJalanNo', t.surat_jalan_no, 'tandaTerimaNo', t.tanda_terima_no,
        'note', t.note, 'discrepancyReason', t.discrepancy_reason,
        'createdAt', to_char(t.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'sentAt',     CASE WHEN t.sent_at      IS NULL THEN NULL ELSE to_char(t.sent_at      AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') END,
        'receivedAt', CASE WHEN t.received_at  IS NULL THEN NULL ELSE to_char(t.received_at  AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') END,
        'cancelledAt',CASE WHEN t.cancelled_at IS NULL THEN NULL ELSE to_char(t.cancelled_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') END,
        'cancelReason', t.cancel_reason,
        'items', (
          SELECT COALESCE(jsonb_agg(jsonb_build_object(
            'id', i.id, 'ingredientId', i.ingredient_id,
            'ingredientName', ing.name, 'ingredientUnit', ing.unit,
            'sentQty', i.sent_qty, 'receivedQty', i.received_qty, 'difference', i.difference
          ) ORDER BY ing.name), '[]'::jsonb)
            FROM ingredient_transfer_items i JOIN ingredients ing ON ing.id = i.ingredient_id
           WHERE i.transfer_id = t.id
        )
      ),
      count(*) OVER ()
      FROM t
      ORDER BY t.created_at DESC
      OFFSET $1 LIMIT $2`
    return listJSON[api.IngredientTransfer](ctx, r.Pool, sql, off(page, limit), limit, status)
}

// IngredientTransfer — single transfer with sender/receiver letterheads resolved
// from warehouse address/phone/logo_url with app_settings.documents_* fallback.
func (r *Repo) IngredientTransfer(ctx context.Context, id string) (api.IngredientTransfer, error) {
    const sql = `
      WITH s AS (SELECT * FROM app_settings LIMIT 1),
           t AS (
             SELECT it.*,
                    ws.name AS src_name, ws.address AS src_addr, ws.phone AS src_phone, ws.logo_url AS src_logo,
                    wd.name AS dst_name, wd.address AS dst_addr, wd.phone AS dst_phone, wd.logo_url AS dst_logo
               FROM ingredient_transfers it
               JOIN warehouses ws ON ws.id = it.source_warehouse_id
               JOIN warehouses wd ON wd.id = it.dest_warehouse_id
              WHERE it.id = $1
           )
      SELECT jsonb_build_object(
        'id', t.id, 'transferNo', t.transfer_no, 'status', t.status,
        'sourceWarehouseId', t.source_warehouse_id, 'sourceWarehouseName', t.src_name,
        'destWarehouseId',   t.dest_warehouse_id,   'destWarehouseName',   t.dst_name,
        'suratJalanNo', t.surat_jalan_no, 'tandaTerimaNo', t.tanda_terima_no,
        'note', t.note, 'discrepancyReason', t.discrepancy_reason,
        'createdAt', to_char(t.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'sentAt',     CASE WHEN t.sent_at      IS NULL THEN NULL ELSE to_char(t.sent_at      AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') END,
        'receivedAt', CASE WHEN t.received_at  IS NULL THEN NULL ELSE to_char(t.received_at  AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') END,
        'cancelledAt',CASE WHEN t.cancelled_at IS NULL THEN NULL ELSE to_char(t.cancelled_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') END,
        'cancelReason', t.cancel_reason,
        'senderLetterhead', jsonb_build_object(
          'locationName', t.src_name,
          'brandName',    s.documents_brand_name,
          'logoUrl',      COALESCE(NULLIF(t.src_logo,''), s.documents_logo_url),
          'addressLines', string_to_array(
                            COALESCE(NULLIF(t.src_addr,''), s.documents_address_lines, ''), E'\n'),
          'phone',        COALESCE(NULLIF(t.src_phone,''), s.documents_phone),
          'npwp',         s.documents_npwp
        ),
        'receiverLetterhead', jsonb_build_object(
          'locationName', t.dst_name,
          'brandName',    s.documents_brand_name,
          'logoUrl',      COALESCE(NULLIF(t.dst_logo,''), s.documents_logo_url),
          'addressLines', string_to_array(
                            COALESCE(NULLIF(t.dst_addr,''), s.documents_address_lines, ''), E'\n'),
          'phone',        COALESCE(NULLIF(t.dst_phone,''), s.documents_phone),
          'npwp',         s.documents_npwp
        ),
        'items', (
          SELECT COALESCE(jsonb_agg(jsonb_build_object(
            'id', i.id, 'ingredientId', i.ingredient_id,
            'ingredientName', ing.name, 'ingredientUnit', ing.unit,
            'sentQty', i.sent_qty, 'receivedQty', i.received_qty, 'difference', i.difference
          ) ORDER BY ing.name), '[]'::jsonb)
            FROM ingredient_transfer_items i JOIN ingredients ing ON ing.id = i.ingredient_id
           WHERE i.transfer_id = t.id
        )
      )
      FROM t, s`
    return oneJSON[api.IngredientTransfer](ctx, r.Pool, sql, id)
}
```
**Note:** column names like `documents_address_lines` / `documents_phone` / `documents_npwp` / `documents_logo_url` already exist on `app_settings` from SP4 migration 0018 — verify by grepping `0018_transfer_documents.sql` if any name is uncertain.

- [ ] **Step 2: Build + commit.**

```bash
cd backend && gofmt -w internal/read && go build ./...
git add backend/internal/read/repo.go
git commit -m "feat(recipe): SP-Recipe-1 ingredient transfer list + detail w/ letterheads"
```

---

### Task C5: Handlers + routes for ingredient transfers

**Files:** Modify `backend/internal/handlers/writes.go`, `backend/internal/server/server.go`

- [ ] **Step 1: Add handlers.**

```go
func (h *Handlers) IngredientTransfers(w http.ResponseWriter, r *http.Request) {
    p, l := pageLimit(r)
    status := r.URL.Query().Get("status")
    rows, total, err := h.Repo.IngredientTransfers(r.Context(), p, l, status)
    if err != nil {
        writeErr(w, 500, err)
        return
    }
    writeJSON(w, http.StatusOK, api.IngredientTransferListResponse{Data: rows, Meta: meta(total, p, l)})
}

func (h *Handlers) IngredientTransfer(w http.ResponseWriter, r *http.Request) {
    t, err := h.Repo.IngredientTransfer(r.Context(), chi.URLParam(r, "id"))
    if err != nil {
        writeErr(w, http.StatusBadRequest, err)
        return
    }
    writeJSON(w, http.StatusOK, api.IngredientTransferResponse{Data: t})
}

func (h *Handlers) CreateIngredientTransfer(w http.ResponseWriter, r *http.Request) {
    in, ok := decodeWrite[write.IngredientTransferCreate](w, r)
    if !ok {
        return
    }
    c, _ := h.caller(r)
    id, err := h.Write.CreateIngredientTransfer(r.Context(), c.userID, in)
    h.created(w, r, id, err)
}

func (h *Handlers) SendIngredientTransfer(w http.ResponseWriter, r *http.Request) {
    c, _ := h.caller(r)
    h.mutated(w, r, h.Write.SendIngredientTransfer(r.Context(), c.userID, chi.URLParam(r, "id")))
}

func (h *Handlers) ReceiveIngredientTransfer(w http.ResponseWriter, r *http.Request) {
    in, ok := decodeWrite[write.IngredientTransferReceive](w, r)
    if !ok {
        return
    }
    c, _ := h.caller(r)
    h.mutated(w, r, h.Write.ReceiveIngredientTransfer(r.Context(), c.userID, chi.URLParam(r, "id"), in))
}

type ingredientTransferCancelBody struct {
    Reason string `json:"reason"`
}

func (h *Handlers) CancelIngredientTransfer(w http.ResponseWriter, r *http.Request) {
    in, ok := decodeWrite[ingredientTransferCancelBody](w, r)
    if !ok {
        return
    }
    c, _ := h.caller(r)
    h.mutated(w, r, h.Write.CancelIngredientTransfer(r.Context(), c.userID, chi.URLParam(r, "id"), in.Reason))
}
```

- [ ] **Step 2: Register routes** inside the existing recipes-enabled group (`server.go`):

```go
    r.Get("/ingredient-transfers", h.IngredientTransfers)
    r.Get("/ingredient-transfers/{id}", h.IngredientTransfer)
    r.Post("/ingredient-transfers", h.CreateIngredientTransfer)
    r.Post("/ingredient-transfers/{id}/send", h.SendIngredientTransfer)
    r.Post("/ingredient-transfers/{id}/receive", h.ReceiveIngredientTransfer)
    r.Post("/ingredient-transfers/{id}/cancel", h.CancelIngredientTransfer)
```
**Order matters** — register `/ingredient-transfers` (the static list path) before `/ingredient-transfers/{id}` so chi doesn't shadow the list (mirrors how SP2 registered `/transfers` before `/transfers/{id}`).

- [ ] **Step 3: Build + deploy + verify.**

```bash
cd backend && gofmt -w internal/ && go build ./...
gcloud run deploy mandalika-pos --source backend --region asia-southeast2 --quiet
# Verify (refresh TOKEN if needed)
SRC="<warehouse-1-id>"; DST="<warehouse-2-id>"; ING="<ingredient-id>"
# Create draft
T=$(curl -s -X POST https://mandalika-pos-538849926142.asia-southeast2.run.app/api/v1/ingredient-transfers \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"sourceWarehouseId\":\"$SRC\",\"destWarehouseId\":\"$DST\",\"items\":[{\"ingredientId\":\"$ING\",\"qty\":200}]}" \
  | python -c "import json,sys;print(json.load(sys.stdin)['data']['id'])")
echo "transfer=$T"
# Send → expect surat_jalan_no = ISJ-2026-00001
curl -s -X POST https://mandalika-pos-538849926142.asia-southeast2.run.app/api/v1/ingredient-transfers/$T/send \
  -H "authorization: Bearer $TOKEN"
curl -s https://mandalika-pos-538849926142.asia-southeast2.run.app/api/v1/ingredient-transfers/$T \
  -H "authorization: Bearer $TOKEN" | python -m json.tool | head -40
# Get the item id from the detail
IT="<itemId-from-above>"
# Receive with discrepancy (received 190 of 200, reason required)
curl -s -X POST https://mandalika-pos-538849926142.asia-southeast2.run.app/api/v1/ingredient-transfers/$T/receive \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"items\":[{\"itemId\":\"$IT\",\"receivedQty\":190}],\"discrepancyReason\":\"susut perjalanan\"}"
# Verify tanda_terima_no = ITT-2026-00001 + dest stock = 190
curl -s https://mandalika-pos-538849926142.asia-southeast2.run.app/api/v1/ingredient-transfers/$T \
  -H "authorization: Bearer $TOKEN" | python -m json.tool | head -40
curl -s "https://mandalika-pos-538849926142.asia-southeast2.run.app/api/v1/ingredients/stock?warehouseId=$DST" \
  -H "authorization: Bearer $TOKEN"
# Negative paths: oversend (qty>stock) → 400
curl -s -o /dev/null -w '%{http_code}\n' \
  -X POST https://mandalika-pos-538849926142.asia-southeast2.run.app/api/v1/ingredient-transfers \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"sourceWarehouseId\":\"$SRC\",\"destWarehouseId\":\"$DST\",\"items\":[{\"ingredientId\":\"$ING\",\"qty\":99999}]}"
# Then send it → should 400 on oversend
```
Expected: surat_jalan_no `ISJ-2026-00001`, tanda_terima_no `ITT-2026-00001`, dest stock credited 190, sender/receiver letterheads present, oversend rejected.

- [ ] **Step 4: Commit + push.**

```bash
git add backend/internal/handlers/writes.go backend/internal/server/server.go
git commit -m "feat(recipe): SP-Recipe-1 ingredient transfer handlers + routes"
git push origin prod-hardening
```

---

## PHASE D — Ingredient opname

### Task D1: OpenAPI — IngredientStockCount schemas + paths

**Files:** Modify `backend/api/openapi.yaml` + regen.

- [ ] **Step 1: Add schemas:**

```yaml
    IngredientStockCountItem:
      type: object
      required: [id, ingredientId, ingredientName, ingredientUnit]
      properties:
        id: { type: string, format: uuid }
        ingredientId: { type: string, format: uuid }
        ingredientName: { type: string }
        ingredientUnit: { type: string }
        counted: { type: number, nullable: true }
        difference: { type: number, nullable: true }
    IngredientStockCount:
      type: object
      required: [id, name, status, warehouseId, createdAt]
      properties:
        id: { type: string, format: uuid }
        name: { type: string }
        status: { type: string, enum: [planned, in_progress, completed, cancelled] }
        warehouseId: { type: string, format: uuid }
        warehouseName: { type: string }
        plannedDate: { type: string, format: date, nullable: true }
        notes: { type: string, nullable: true }
        createdAt: { type: string, format: date-time }
        startedAt: { type: string, format: date-time, nullable: true }
        completedAt: { type: string, format: date-time, nullable: true }
        items: { type: array, items: { $ref: '#/components/schemas/IngredientStockCountItem' } }
    IngredientStockCountInput:
      type: object
      required: [name, warehouseId]
      properties:
        name: { type: string }
        warehouseId: { type: string, format: uuid }
        plannedDate: { type: string, format: date, nullable: true }
        notes: { type: string, nullable: true }
    IngredientStockCountSaveItemInput:
      type: object
      required: [itemId, counted]
      properties:
        itemId: { type: string, format: uuid }
        counted: { type: number }
    IngredientStockCountSaveInput:
      type: object
      required: [items]
      properties:
        items: { type: array, items: { $ref: '#/components/schemas/IngredientStockCountSaveItemInput' } }
    IngredientStockCountListResponse:
      type: object
      required: [data, meta]
      properties:
        data: { type: array, items: { $ref: '#/components/schemas/IngredientStockCount' } }
        meta: { $ref: '#/components/schemas/Meta' }
    IngredientStockCountResponse:
      type: object
      required: [data]
      properties:
        data: { $ref: '#/components/schemas/IngredientStockCount' }
```

- [ ] **Step 2: Add paths:**

```yaml
  /api/v1/ingredient-stock-counts:
    get:
      operationId: listIngredientStockCounts
      tags: [catalog]
      parameters:
        - { name: page, in: query, required: false, schema: { type: integer } }
        - { name: limit, in: query, required: false, schema: { type: integer } }
      responses:
        '200':
          description: list
          content:
            application/json:
              schema: { $ref: '#/components/schemas/IngredientStockCountListResponse' }
    post:
      operationId: createIngredientStockCount
      tags: [catalog]
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/IngredientStockCountInput' }
      responses: { '201': { description: created } }
  /api/v1/ingredient-stock-counts/{id}:
    get:
      operationId: getIngredientStockCount
      tags: [catalog]
      parameters:
        - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
      responses:
        '200':
          description: stock count
          content:
            application/json:
              schema: { $ref: '#/components/schemas/IngredientStockCountResponse' }
  /api/v1/ingredient-stock-counts/{id}/start:
    post:
      operationId: startIngredientStockCount
      tags: [catalog]
      parameters:
        - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
      responses: { '200': { description: ok } }
  /api/v1/ingredient-stock-counts/{id}/save:
    put:
      operationId: saveIngredientStockCount
      tags: [catalog]
      parameters:
        - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/IngredientStockCountSaveInput' }
      responses: { '200': { description: ok } }
  /api/v1/ingredient-stock-counts/{id}/complete:
    post:
      operationId: completeIngredientStockCount
      tags: [catalog]
      parameters:
        - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
      responses: { '200': { description: ok } }
```

- [ ] **Step 3: Regen + build + commit.**

```bash
cd backend && make gen-go && make gen-ts && go build ./...
git add backend/api/openapi.yaml backend/internal/api/api.gen.go packages/api/src/schema.d.ts
git commit -m "feat(recipe): SP-Recipe-1 openapi — ingredient stock-counts"
```

---

### Task D2: Write repo — ingredient opname

**Files:** Create `backend/internal/write/ingredient_stockcount.go`

- [ ] **Step 1: Write the file.** Mirror `stockcount.go` but scoped to ingredients and warehouse only.

```go
package write

import (
    "context"
    "errors"
    "fmt"

    "github.com/jackc/pgx/v5"
)

type IngredientStockCount struct {
    Name        string `json:"name"`
    WarehouseID string `json:"warehouseId"`
    PlannedDate string `json:"plannedDate,omitempty"`
    Notes       string `json:"notes,omitempty"`
}

func (r *Repo) CreateIngredientStockCount(ctx context.Context, caller string, in IngredientStockCount) (string, error) {
    if in.Name == "" || in.WarehouseID == "" {
        return "", fmt.Errorf("nama dan gudang wajib")
    }
    var id string
    if err := r.Pool.QueryRow(ctx,
        `INSERT INTO ingredient_stock_counts (name, status, warehouse_id, planned_date, notes, created_by)
         VALUES ($1, 'planned', $2, NULLIF($3,'')::date, NULLIF($4,''), NULLIF($5,'')::uuid)
         RETURNING id`,
        in.Name, in.WarehouseID, in.PlannedDate, in.Notes, caller,
    ).Scan(&id); err != nil {
        return "", fmt.Errorf("insert stock count: %w", err)
    }
    return id, nil
}

// StartIngredientStockCount transitions planned → in_progress and freezes the
// ingredient lines (snapshot name + unit so rename later doesn't corrupt this row).
func (r *Repo) StartIngredientStockCount(ctx context.Context, id string) error {
    tx, err := r.Pool.Begin(ctx)
    if err != nil {
        return fmt.Errorf("begin tx: %w", err)
    }
    defer tx.Rollback(ctx)

    var status, whID string
    if err := tx.QueryRow(ctx,
        `SELECT status, warehouse_id FROM ingredient_stock_counts WHERE id=$1 FOR UPDATE`, id,
    ).Scan(&status, &whID); err != nil {
        if errors.Is(err, pgx.ErrNoRows) {
            return ErrNotFound
        }
        return fmt.Errorf("load: %w", err)
    }
    if status != "planned" {
        return fmt.Errorf("status %q tidak bisa dimulai", status)
    }
    // Snapshot every active ingredient with its current name + unit.
    if _, err := tx.Exec(ctx,
        `INSERT INTO ingredient_stock_count_items
             (stock_count_id, ingredient_id, ingredient_name, ingredient_unit)
         SELECT $1, id, name, unit FROM ingredients WHERE is_active`,
        id,
    ); err != nil {
        return fmt.Errorf("snapshot items: %w", err)
    }
    if _, err := tx.Exec(ctx,
        `UPDATE ingredient_stock_counts SET status='in_progress', started_at=now() WHERE id=$1`,
        id,
    ); err != nil {
        return fmt.Errorf("mark started: %w", err)
    }
    return tx.Commit(ctx)
}

type IngredientStockCountSaveItem struct {
    ItemID  string  `json:"itemId"`
    Counted float64 `json:"counted"`
}

func (r *Repo) SaveIngredientStockCount(ctx context.Context, id string, items []IngredientStockCountSaveItem) error {
    if len(items) == 0 {
        return nil
    }
    tx, err := r.Pool.Begin(ctx)
    if err != nil {
        return fmt.Errorf("begin tx: %w", err)
    }
    defer tx.Rollback(ctx)
    var status string
    if err := tx.QueryRow(ctx,
        `SELECT status FROM ingredient_stock_counts WHERE id=$1 FOR UPDATE`, id,
    ).Scan(&status); err != nil {
        if errors.Is(err, pgx.ErrNoRows) {
            return ErrNotFound
        }
        return fmt.Errorf("load: %w", err)
    }
    if status != "in_progress" {
        return fmt.Errorf("status %q tidak menerima simpan", status)
    }
    for _, it := range items {
        if _, err := tx.Exec(ctx,
            `UPDATE ingredient_stock_count_items SET counted=$2 WHERE id=$1 AND stock_count_id=$3`,
            it.ItemID, it.Counted, id,
        ); err != nil {
            return fmt.Errorf("save item: %w", err)
        }
    }
    return tx.Commit(ctx)
}

// CompleteIngredientStockCount writes counted qty into ingredient_warehouse_stock,
// records each line's `difference` (counted − previous qty), and marks completed.
// Lines with NULL counted are skipped (operator hasn't touched them).
func (r *Repo) CompleteIngredientStockCount(ctx context.Context, id string) error {
    tx, err := r.Pool.Begin(ctx)
    if err != nil {
        return fmt.Errorf("begin tx: %w", err)
    }
    defer tx.Rollback(ctx)
    var status, whID string
    if err := tx.QueryRow(ctx,
        `SELECT status, warehouse_id FROM ingredient_stock_counts WHERE id=$1 FOR UPDATE`, id,
    ).Scan(&status, &whID); err != nil {
        if errors.Is(err, pgx.ErrNoRows) {
            return ErrNotFound
        }
        return fmt.Errorf("load: %w", err)
    }
    if status != "in_progress" {
        return fmt.Errorf("status %q tidak bisa diselesaikan", status)
    }
    // For each line with a counted value: compute difference and upsert the
    // warehouse stock.
    if _, err := tx.Exec(ctx,
        `WITH lines AS (
            SELECT i.id, i.ingredient_id, i.counted,
                   i.counted - COALESCE(s.qty,0) AS diff
              FROM ingredient_stock_count_items i
              LEFT JOIN ingredient_warehouse_stock s
                     ON s.warehouse_id = $2 AND s.ingredient_id = i.ingredient_id
             WHERE i.stock_count_id = $1 AND i.counted IS NOT NULL
         ),
         upd AS (
             UPDATE ingredient_stock_count_items i
                SET difference = l.diff
               FROM lines l WHERE l.id = i.id
         )
         INSERT INTO ingredient_warehouse_stock (warehouse_id, ingredient_id, qty)
              SELECT $2, ingredient_id, counted FROM lines
         ON CONFLICT (warehouse_id, ingredient_id)
         DO UPDATE SET qty = EXCLUDED.qty`,
        id, whID,
    ); err != nil {
        return fmt.Errorf("apply counted: %w", err)
    }
    if _, err := tx.Exec(ctx,
        `UPDATE ingredient_stock_counts SET status='completed', completed_at=now() WHERE id=$1`,
        id,
    ); err != nil {
        return fmt.Errorf("mark completed: %w", err)
    }
    return tx.Commit(ctx)
}
```

- [ ] **Step 2: Build + commit.**

```bash
cd backend && gofmt -w internal/write && go build ./...
git add backend/internal/write/ingredient_stockcount.go
git commit -m "feat(recipe): SP-Recipe-1 ingredient stock-count write-repo"
```

---

### Task D3: Read repo + handlers + routes + deploy + verify

**Files:** Modify `backend/internal/read/repo.go`, `backend/internal/handlers/writes.go`, `backend/internal/server/server.go`

- [ ] **Step 1: Add list + detail read methods** to `read/repo.go`:

```go
func (r *Repo) IngredientStockCounts(ctx context.Context, page, limit int) ([]api.IngredientStockCount, int, error) {
    const sql = `
      SELECT jsonb_build_object(
        'id', sc.id, 'name', sc.name, 'status', sc.status,
        'warehouseId', sc.warehouse_id, 'warehouseName', w.name,
        'plannedDate', sc.planned_date, 'notes', sc.notes,
        'createdAt',   to_char(sc.created_at   AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'startedAt',   CASE WHEN sc.started_at   IS NULL THEN NULL ELSE to_char(sc.started_at   AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') END,
        'completedAt', CASE WHEN sc.completed_at IS NULL THEN NULL ELSE to_char(sc.completed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') END,
        'items', '[]'::jsonb
      ),
      count(*) OVER ()
      FROM ingredient_stock_counts sc
      JOIN warehouses w ON w.id = sc.warehouse_id
      ORDER BY sc.created_at DESC
      OFFSET $1 LIMIT $2`
    return listJSON[api.IngredientStockCount](ctx, r.Pool, sql, off(page, limit), limit)
}

func (r *Repo) IngredientStockCount(ctx context.Context, id string) (api.IngredientStockCount, error) {
    const sql = `
      SELECT jsonb_build_object(
        'id', sc.id, 'name', sc.name, 'status', sc.status,
        'warehouseId', sc.warehouse_id, 'warehouseName', w.name,
        'plannedDate', sc.planned_date, 'notes', sc.notes,
        'createdAt',   to_char(sc.created_at   AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'startedAt',   CASE WHEN sc.started_at   IS NULL THEN NULL ELSE to_char(sc.started_at   AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') END,
        'completedAt', CASE WHEN sc.completed_at IS NULL THEN NULL ELSE to_char(sc.completed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') END,
        'items', (
          SELECT COALESCE(jsonb_agg(jsonb_build_object(
            'id', i.id, 'ingredientId', i.ingredient_id,
            'ingredientName', i.ingredient_name, 'ingredientUnit', i.ingredient_unit,
            'counted', i.counted, 'difference', i.difference
          ) ORDER BY i.ingredient_name), '[]'::jsonb)
            FROM ingredient_stock_count_items i WHERE i.stock_count_id = sc.id
        )
      )
      FROM ingredient_stock_counts sc
      JOIN warehouses w ON w.id = sc.warehouse_id
      WHERE sc.id = $1`
    return oneJSON[api.IngredientStockCount](ctx, r.Pool, sql, id)
}
```

- [ ] **Step 2: Add handlers** in `handlers/writes.go`:

```go
func (h *Handlers) IngredientStockCounts(w http.ResponseWriter, r *http.Request) {
    p, l := pageLimit(r)
    rows, total, err := h.Repo.IngredientStockCounts(r.Context(), p, l)
    if err != nil {
        writeErr(w, 500, err)
        return
    }
    writeJSON(w, http.StatusOK, api.IngredientStockCountListResponse{Data: rows, Meta: meta(total, p, l)})
}

func (h *Handlers) IngredientStockCount(w http.ResponseWriter, r *http.Request) {
    sc, err := h.Repo.IngredientStockCount(r.Context(), chi.URLParam(r, "id"))
    if err != nil {
        writeErr(w, http.StatusBadRequest, err)
        return
    }
    writeJSON(w, http.StatusOK, api.IngredientStockCountResponse{Data: sc})
}

func (h *Handlers) CreateIngredientStockCount(w http.ResponseWriter, r *http.Request) {
    in, ok := decodeWrite[write.IngredientStockCount](w, r)
    if !ok {
        return
    }
    c, _ := h.caller(r)
    id, err := h.Write.CreateIngredientStockCount(r.Context(), c.userID, in)
    h.created(w, r, id, err)
}

func (h *Handlers) StartIngredientStockCount(w http.ResponseWriter, r *http.Request) {
    h.mutated(w, r, h.Write.StartIngredientStockCount(r.Context(), chi.URLParam(r, "id")))
}

type ingredientStockCountSaveBody struct {
    Items []write.IngredientStockCountSaveItem `json:"items"`
}

func (h *Handlers) SaveIngredientStockCount(w http.ResponseWriter, r *http.Request) {
    in, ok := decodeWrite[ingredientStockCountSaveBody](w, r)
    if !ok {
        return
    }
    h.mutated(w, r, h.Write.SaveIngredientStockCount(r.Context(), chi.URLParam(r, "id"), in.Items))
}

func (h *Handlers) CompleteIngredientStockCount(w http.ResponseWriter, r *http.Request) {
    h.mutated(w, r, h.Write.CompleteIngredientStockCount(r.Context(), chi.URLParam(r, "id")))
}
```

- [ ] **Step 3: Register routes** in the existing recipes-enabled group:

```go
    r.Get("/ingredient-stock-counts", h.IngredientStockCounts)
    r.Get("/ingredient-stock-counts/{id}", h.IngredientStockCount)
    r.Post("/ingredient-stock-counts", h.CreateIngredientStockCount)
    r.Post("/ingredient-stock-counts/{id}/start", h.StartIngredientStockCount)
    r.Put("/ingredient-stock-counts/{id}/save", h.SaveIngredientStockCount)
    r.Post("/ingredient-stock-counts/{id}/complete", h.CompleteIngredientStockCount)
```

- [ ] **Step 4: Build + deploy + verify.**

```bash
cd backend && gofmt -w internal/ && go build ./...
gcloud run deploy mandalika-pos --source backend --region asia-southeast2 --quiet
# Verify: create → start → save partial → complete; check stock matches.
SC=$(curl -s -X POST https://mandalika-pos-538849926142.asia-southeast2.run.app/api/v1/ingredient-stock-counts \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"name\":\"SP-Recipe-1 verify\",\"warehouseId\":\"$DST\"}" \
  | python -c "import json,sys;print(json.load(sys.stdin)['data']['id'])")
curl -s -X POST https://mandalika-pos-538849926142.asia-southeast2.run.app/api/v1/ingredient-stock-counts/$SC/start \
  -H "authorization: Bearer $TOKEN"
curl -s https://mandalika-pos-538849926142.asia-southeast2.run.app/api/v1/ingredient-stock-counts/$SC \
  -H "authorization: Bearer $TOKEN" | python -m json.tool | head -40
# Grab the item id, save counted=185
SCI="<item-id-from-detail>"
curl -s -X PUT https://mandalika-pos-538849926142.asia-southeast2.run.app/api/v1/ingredient-stock-counts/$SC/save \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"items\":[{\"itemId\":\"$SCI\",\"counted\":185}]}"
curl -s -X POST https://mandalika-pos-538849926142.asia-southeast2.run.app/api/v1/ingredient-stock-counts/$SC/complete \
  -H "authorization: Bearer $TOKEN"
# Verify stock = 185 + difference recorded
curl -s "https://mandalika-pos-538849926142.asia-southeast2.run.app/api/v1/ingredients/stock?warehouseId=$DST" \
  -H "authorization: Bearer $TOKEN"
```
Expected: warehouse stock for that ingredient is now 185; the saved line's `difference = 185 − 190 = -5` (or whatever the prior value was).

- [ ] **Step 5: Commit + push.**

```bash
git add backend/internal/read/repo.go backend/internal/handlers/writes.go backend/internal/server/server.go
git commit -m "feat(recipe): SP-Recipe-1 ingredient stock-count handlers + routes"
git push origin prod-hardening
```

---

## PHASE E — Backoffice UI

### Task E1: TS client — extend `Api` interface with every new method

**Files:** Modify `packages/api/src/client.ts`, `packages/api/src/index.ts`

- [ ] **Step 1: Add type re-exports** in `index.ts` (top of file, with the others):

```ts
export type Ingredient = S['Ingredient']
export type IngredientInput = S['IngredientInput']
export type IngredientStockRow = S['IngredientStockRow']
export type IngredientGoodsReceiptInput = S['IngredientGoodsReceiptInput']
export type IngredientAdjustInput = S['IngredientAdjustInput']
export type IngredientTransfer = S['IngredientTransfer']
export type IngredientTransferItem = S['IngredientTransferItem']
export type IngredientTransferCreateInput = S['IngredientTransferCreateInput']
export type IngredientTransferReceiveInput = S['IngredientTransferReceiveInput']
export type IngredientStockCount = S['IngredientStockCount']
export type IngredientStockCountItem = S['IngredientStockCountItem']
export type IngredientStockCountInput = S['IngredientStockCountInput']
export type IngredientStockCountSaveInput = S['IngredientStockCountSaveInput']
```
**Note:** if these types already live in `client.ts`, mirror the file's existing pattern instead of duplicating in `index.ts`.

- [ ] **Step 2: Add `Api` interface methods + impls** in `client.ts`. Find the `Api` interface (search for `interface Api`); append the new methods near the existing `getWarehouseStock` block. For each method add the corresponding impl in the factory.

```ts
// In `interface Api {`:
listIngredients(opts?: { page?: number; limit?: number; q?: string }): Promise<{ data: Ingredient[]; meta: Meta }>
createIngredient(input: IngredientInput): Promise<{ id: string }>
updateIngredient(id: string, input: IngredientInput): Promise<void>
deleteIngredient(id: string): Promise<void>
getIngredientStock(warehouseId: string): Promise<IngredientStockRow[]>
createIngredientGoodsReceipt(input: IngredientGoodsReceiptInput): Promise<{ id: string }>
adjustIngredientStock(input: IngredientAdjustInput): Promise<void>
listIngredientTransfers(opts?: { status?: string; page?: number; limit?: number }): Promise<{ data: IngredientTransfer[]; meta: Meta }>
getIngredientTransfer(id: string): Promise<IngredientTransfer>
createIngredientTransfer(input: IngredientTransferCreateInput): Promise<{ id: string }>
sendIngredientTransfer(id: string): Promise<void>
receiveIngredientTransfer(id: string, input: IngredientTransferReceiveInput): Promise<void>
cancelIngredientTransfer(id: string, reason: string): Promise<void>
listIngredientStockCounts(opts?: { page?: number; limit?: number }): Promise<{ data: IngredientStockCount[]; meta: Meta }>
getIngredientStockCount(id: string): Promise<IngredientStockCount>
createIngredientStockCount(input: IngredientStockCountInput): Promise<{ id: string }>
startIngredientStockCount(id: string): Promise<void>
saveIngredientStockCount(id: string, input: IngredientStockCountSaveInput): Promise<void>
completeIngredientStockCount(id: string): Promise<void>
```
For the impls, follow the existing `getWarehouseStock` / `createTransfer` patterns exactly (qs-encode opts, JSON-decode response). Keep this file's `fetch` wrapper unchanged.

- [ ] **Step 3: Build + typecheck.**

```bash
cd packages/api && pnpm tsc --noEmit
cd ../.. && pnpm --filter @mandalika/backoffice tsc -b --pretty false
```
Both green.

- [ ] **Step 4: Commit.**

```bash
git add packages/api/src/client.ts packages/api/src/index.ts
git commit -m "feat(recipe): SP-Recipe-1 @mandalika/api client methods for ingredients"
```

---

### Task E2: Backoffice — `Bahan` tab shell inside Gudang (flag-gated)

**Files:**
- Modify `apps/backoffice/src/screens/Warehouses.tsx` — add a third tab "Bahan", conditionally rendered when `recipesEnabled === true`.
- Create `apps/backoffice/src/screens/ingredients/Ingredients.tsx` — the tab container.

- [ ] **Step 1: Modify `Warehouses.tsx`** — add the new tab. The file currently has `Warehouses | Transfer` tabs (see SP1/SP2). The flag value comes from the existing `useAppSettings()` hook or `api.getAppSettings()` call already used by SettingsScreen — reuse it.

```tsx
// (illustrative diff)
import { Ingredients } from './ingredients/Ingredients'
// inside the tab strip render:
{tab === 'bahan' && recipesEnabled && <Ingredients />}
// in the tab strip header:
{recipesEnabled && (
  <button type="button" onClick={() => setTab('bahan')} className={tabClass('bahan')}>
    Bahan
  </button>
)}
```
If `Warehouses.tsx` doesn't already pull the flag from app-settings, add it (the same way SettingsScreen does — fetch once on mount, store in component state).

- [ ] **Step 2: Create `Ingredients.tsx`** with the inner tab strip skeleton (each inner tab a placeholder div for now; Tasks E3–E8 fill them in):

```tsx
import { useState } from 'react'
import { DaftarTab } from './DaftarTab'
import { StokTab } from './StokTab'
import { StokMasukTab } from './StokMasukTab'
import { PenyesuaianTab } from './PenyesuaianTab'
import { TransferTab } from './TransferTab'
import { OpnameTab } from './OpnameTab'

type Inner = 'daftar' | 'stok' | 'stok-masuk' | 'penyesuaian' | 'transfer' | 'opname'

export function Ingredients() {
  const [inner, setInner] = useState<Inner>('daftar')
  const cls = (k: Inner) =>
    `px-3 py-1.5 text-sm ${inner === k ? 'font-semibold border-b-2 border-amber-700 text-amber-700' : 'text-gray-600 hover:text-gray-900'}`
  return (
    <div>
      <div className="flex gap-2 border-b border-gray-200 mb-4">
        <button type="button" onClick={() => setInner('daftar')} className={cls('daftar')}>Daftar</button>
        <button type="button" onClick={() => setInner('stok')} className={cls('stok')}>Stok</button>
        <button type="button" onClick={() => setInner('stok-masuk')} className={cls('stok-masuk')}>Stok Masuk</button>
        <button type="button" onClick={() => setInner('penyesuaian')} className={cls('penyesuaian')}>Penyesuaian</button>
        <button type="button" onClick={() => setInner('transfer')} className={cls('transfer')}>Transfer</button>
        <button type="button" onClick={() => setInner('opname')} className={cls('opname')}>Opname</button>
      </div>
      {inner === 'daftar' && <DaftarTab />}
      {inner === 'stok' && <StokTab />}
      {inner === 'stok-masuk' && <StokMasukTab />}
      {inner === 'penyesuaian' && <PenyesuaianTab />}
      {inner === 'transfer' && <TransferTab />}
      {inner === 'opname' && <OpnameTab />}
    </div>
  )
}
```
**Stub the inner tabs first** — each Task E3–E8 fills one. Add `export function DaftarTab() { return null }` etc. in placeholder files so the build stays green.

- [ ] **Step 3: Build.** `pnpm --filter @mandalika/backoffice tsc -b --pretty false` → green.

- [ ] **Step 4: Commit.**

```bash
git add apps/backoffice/src/screens/Warehouses.tsx apps/backoffice/src/screens/ingredients/
git commit -m "feat(recipe): SP-Recipe-1 Bahan tab shell (flag-gated)"
```

---

### Task E3: Backoffice — `Daftar` tab (ingredients catalog CRUD)

**Files:** Create `apps/backoffice/src/screens/ingredients/DaftarTab.tsx`, `IngredientFormModal.tsx`

- [ ] **Step 1: Write `DaftarTab.tsx`.** Mirror the catalog table shape of `Customers.tsx` (header + Add button + paginated list + edit modal).

```tsx
import { useEffect, useState } from 'react'
import { api } from '../../api'
import type { Ingredient } from '@mandalika/api'
import { IngredientFormModal } from './IngredientFormModal'

export function DaftarTab() {
  const [rows, setRows] = useState<Ingredient[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<Ingredient | null>(null)
  const [creating, setCreating] = useState(false)
  const [q, setQ] = useState('')

  async function reload() {
    setLoading(true)
    try {
      const r = await api.listIngredients({ q, limit: 100 })
      setRows(r.data)
    } finally { setLoading(false) }
  }
  useEffect(() => { void reload() }, [q])

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Cari bahan…"
          className="border rounded px-3 py-1.5 text-sm w-64"
        />
        <button type="button" onClick={() => setCreating(true)} className="bg-amber-700 text-white px-3 py-1.5 rounded text-sm">
          + Tambah Bahan
        </button>
      </div>
      <table className="w-full text-sm">
        <thead className="text-left text-gray-500"><tr>
          <th className="py-2">Nama</th><th>Satuan</th><th>Biaya Default</th><th>Catatan</th><th>Status</th><th></th>
        </tr></thead>
        <tbody>
          {loading && <tr><td colSpan={6} className="py-6 text-center text-gray-500">Memuat…</td></tr>}
          {!loading && rows.length === 0 && <tr><td colSpan={6} className="py-6 text-center text-gray-500">Belum ada bahan.</td></tr>}
          {rows.map(r => (
            <tr key={r.id} className="border-t">
              <td className="py-2">{r.name}</td>
              <td>{r.unit}</td>
              <td>{r.defaultUnitCost != null ? `Rp ${r.defaultUnitCost.toLocaleString('id-ID')}` : '—'}</td>
              <td className="text-gray-600">{r.notes || '—'}</td>
              <td>{r.isActive ? 'Aktif' : 'Nonaktif'}</td>
              <td><button type="button" onClick={() => setEditing(r)} className="text-amber-700 underline">Edit</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      {creating && <IngredientFormModal onClose={() => { setCreating(false); void reload() }} />}
      {editing && <IngredientFormModal initial={editing} onClose={() => { setEditing(null); void reload() }} />}
    </div>
  )
}
```

- [ ] **Step 2: Write `IngredientFormModal.tsx`** — name + unit + default unit cost + notes + active toggle; on submit calls `api.createIngredient` or `api.updateIngredient`. Mirror the existing `apps/backoffice/src/screens/warehouses/...Modal.tsx` patterns for layout + form state.

- [ ] **Step 3: Build + commit.**

```bash
pnpm --filter @mandalika/backoffice tsc -b --pretty false
git add apps/backoffice/src/screens/ingredients/DaftarTab.tsx apps/backoffice/src/screens/ingredients/IngredientFormModal.tsx
git commit -m "feat(recipe): SP-Recipe-1 backoffice Daftar (ingredients CRUD)"
```

---

### Task E4: Backoffice — `Stok` view

**Files:** Create `apps/backoffice/src/screens/ingredients/StokTab.tsx`

- [ ] **Step 1: Write `StokTab.tsx`** — warehouse picker (top) + table (Nama / Satuan / Stok / Biaya Default). Reuse the existing `Select` style from `WarehouseStockView` in the warehouses folder.

```tsx
import { useEffect, useState } from 'react'
import { api } from '../../api'
import type { Warehouse, IngredientStockRow } from '@mandalika/api'

export function StokTab() {
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [whId, setWhId] = useState<string>('')
  const [rows, setRows] = useState<IngredientStockRow[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => { void api.listWarehouses({ limit: 200 }).then(r => {
    setWarehouses(r.data)
    if (!whId && r.data[0]) setWhId(r.data[0].id)
  }) }, [])

  useEffect(() => {
    if (!whId) return
    setLoading(true)
    api.getIngredientStock(whId).then(setRows).finally(() => setLoading(false))
  }, [whId])

  return (
    <div>
      <div className="mb-3">
        <select value={whId} onChange={e => setWhId(e.target.value)} className="border rounded px-3 py-1.5 text-sm">
          {warehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
      </div>
      <table className="w-full text-sm">
        <thead className="text-left text-gray-500"><tr>
          <th className="py-2">Nama</th><th>Satuan</th><th className="text-right">Stok</th><th className="text-right">Biaya Default</th>
        </tr></thead>
        <tbody>
          {loading && <tr><td colSpan={4} className="py-6 text-center text-gray-500">Memuat…</td></tr>}
          {!loading && rows.length === 0 && <tr><td colSpan={4} className="py-6 text-center text-gray-500">Tidak ada bahan aktif.</td></tr>}
          {rows.map(r => (
            <tr key={r.ingredientId} className="border-t">
              <td className="py-2">{r.name}</td>
              <td>{r.unit}</td>
              <td className="text-right tabular-nums">{r.qty.toLocaleString('id-ID', { maximumFractionDigits: 3 })}</td>
              <td className="text-right tabular-nums">{r.defaultUnitCost != null ? `Rp ${r.defaultUnitCost.toLocaleString('id-ID')}` : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
```
**Note:** if the existing client method is named `listWarehouses({ limit })` confirm by `grep -n "listWarehouses\|getWarehouses" packages/api/src/client.ts`. Use whichever name is present.

- [ ] **Step 2: Build + commit.**

```bash
pnpm --filter @mandalika/backoffice tsc -b --pretty false
git add apps/backoffice/src/screens/ingredients/StokTab.tsx
git commit -m "feat(recipe): SP-Recipe-1 backoffice Stok (per-warehouse ingredient stock)"
```

---

### Task E5: Backoffice — `Stok Masuk` + `Penyesuaian` tabs

**Files:** Create `StokMasukTab.tsx`, `IngredientGoodsInModal.tsx`, `PenyesuaianTab.tsx`, `IngredientAdjustModal.tsx`

- [ ] **Step 1: `StokMasukTab.tsx`.** Reuses `IngredientGoodsInModal` (form with warehouse picker + supplier + note + items grid). Mirrors `GoodsInModal.tsx` from the warehouses folder but uses ingredients + numeric qty + the new `api.createIngredientGoodsReceipt` method.

- [ ] **Step 2: `PenyesuaianTab.tsx` + `IngredientAdjustModal.tsx`.** Mirrors `AdjustModal.tsx` from the warehouses folder — warehouse picker + ingredient picker + new qty + required reason. Calls `api.adjustIngredientStock`.

Each modal validates qty > 0 (goods-in) / qty ≥ 0 (adjust); on submit closes the modal and re-fetches the parent list.

- [ ] **Step 3: Build + commit.**

```bash
pnpm --filter @mandalika/backoffice tsc -b --pretty false
git add apps/backoffice/src/screens/ingredients/{StokMasukTab,IngredientGoodsInModal,PenyesuaianTab,IngredientAdjustModal}.tsx
git commit -m "feat(recipe): SP-Recipe-1 backoffice Stok Masuk + Penyesuaian"
```

---

### Task E6: Backoffice — `Transfer` tab + cloned `SuratJalanIngredientPanel`

**Files:** Create `TransferTab.tsx`, `IngredientTransferForm.tsx`, `IngredientReceiveModal.tsx`, `SuratJalanIngredientPanel.tsx`, `docs/IngredientSuratJalanDoc.tsx`

- [ ] **Step 1: `TransferTab.tsx`** — list (status filter), detail panel, draft creation, send / receive / cancel actions. Mirrors `apps/backoffice/src/screens/transfers/Transfers.tsx` but warehouse↔warehouse only and uses `api.listIngredientTransfers` / etc.

- [ ] **Step 2: `IngredientTransferForm.tsx`** — source/dest warehouse pickers + items grid (ingredient + qty). On submit calls `api.createIngredientTransfer`.

- [ ] **Step 3: `IngredientReceiveModal.tsx`** — mirrors `transfers/ReceiveModal.tsx` but with numeric qty + transfer-level `discrepancyReason` requirement when any line differs.

- [ ] **Step 4: Clone SP4 doc components.**

```bash
cp apps/backoffice/src/screens/transfers/SuratJalanPanel.tsx apps/backoffice/src/screens/ingredients/SuratJalanIngredientPanel.tsx
cp apps/backoffice/src/screens/transfers/docs/SuratJalanDoc.tsx apps/backoffice/src/screens/ingredients/docs/IngredientSuratJalanDoc.tsx
```
Then in `SuratJalanIngredientPanel.tsx`:
1. Change the import from `./docs/SuratJalanDoc` → `./docs/IngredientSuratJalanDoc`.
2. Change the prop type `transfer: Transfer` → `transfer: IngredientTransfer`.
3. Update the title strings: `"Surat Jalan"` stays; `"Tanda Terima"` stays. The doc number columns now read `transfer.suratJalanNo` / `transfer.tandaTerimaNo` (same field names).
4. The `render.ts` import path stays — `../transfers/docs/render` — reuse the SP4 file unchanged.

In `docs/IngredientSuratJalanDoc.tsx`:
1. Change `transfer.items` rendering — each row now shows `ingredientName · ingredientUnit · sentQty` instead of `productName · variantSize · sentQty`.
2. Header copy: "Surat Jalan Bahan" (vs SP4's "Surat Jalan").

- [ ] **Step 5: Mount the panel** under `TransferTab.tsx`'s detail header (mirrors SP4's `TransferDetail` mount). Show it when `transfer.status === 'in_transit' || transfer.status === 'completed'`.

- [ ] **Step 6: Build + commit.**

```bash
pnpm --filter @mandalika/backoffice tsc -b --pretty false
git add apps/backoffice/src/screens/ingredients/TransferTab.tsx \
        apps/backoffice/src/screens/ingredients/IngredientTransferForm.tsx \
        apps/backoffice/src/screens/ingredients/IngredientReceiveModal.tsx \
        apps/backoffice/src/screens/ingredients/SuratJalanIngredientPanel.tsx \
        apps/backoffice/src/screens/ingredients/docs/IngredientSuratJalanDoc.tsx
git commit -m "feat(recipe): SP-Recipe-1 backoffice Transfer + SuratJalan ingredient panel"
```

---

### Task E7: Backoffice — `Opname` tab

**Files:** Create `OpnameTab.tsx` (+ supporting modal/detail if needed)

- [ ] **Step 1: Write `OpnameTab.tsx`** — list ingredient stock-counts; New button creates a planned count; row click opens detail (start / save counted qty per row / complete actions). Mirror `apps/backoffice/src/screens/StockCount.tsx` but scoped to ingredients via the new API methods.

- [ ] **Step 2: Build + commit.**

```bash
pnpm --filter @mandalika/backoffice tsc -b --pretty false
git add apps/backoffice/src/screens/ingredients/OpnameTab.tsx
git commit -m "feat(recipe): SP-Recipe-1 backoffice Opname (ingredient stock-count)"
```

---

### Task E8: Settings → "Resep & Bahan" toggle

**Files:** Modify `apps/backoffice/src/screens/SettingsScreen.tsx`

- [ ] **Step 1: Add a new section.** Place it under the existing "Dokumen" section. The settings shape from `getAppSettings()` already exposes everything — add `recipesEnabled` to the editable state.

```tsx
<section className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
  <h3 className="font-semibold mb-2">Resep & Bahan</h3>
  <p className="text-sm text-gray-600 mb-3">
    Aktifkan modul Resep & Bahan untuk melacak formula per produk + manajemen bahan baku.
    Saat dinonaktifkan, tab Bahan dan menu Resep tidak akan muncul.
  </p>
  <label className="flex items-center gap-2 text-sm">
    <input
      type="checkbox"
      checked={state.recipesEnabled ?? false}
      onChange={e => setState(s => ({ ...s, recipesEnabled: e.target.checked }))}
    />
    Aktifkan modul Resep & Bahan
  </label>
</section>
```
Make sure the existing `Save` button posts `{ ...documents, recipesEnabled }` through the existing `api.updateAppSettings`. Confirm by reading the current SettingsScreen save handler.

- [ ] **Step 2: Build + commit + deploy push.**

```bash
pnpm --filter @mandalika/backoffice tsc -b --pretty false
git add apps/backoffice/src/screens/SettingsScreen.tsx
git commit -m "feat(recipe): SP-Recipe-1 Settings toggle for Resep & Bahan"
git push origin prod-hardening
```
Cloudflare Pages auto-deploys backoffice on push.

---

### Task E9: End-to-end live verification

- [ ] **Step 1: Confirm CF deploy.** Visit `https://mandalika-pos.pages.dev`, login as admin, open **Pengaturan** → confirm the "Resep & Bahan" section appears and is currently ON (from Task A7).

- [ ] **Step 2: Walk the happy path through the UI.** Open **Gudang** → confirm the **Bahan** tab is visible. Step through every inner tab:
   - **Daftar:** create 2 ingredients ("Rose Oil — g — Rp 15.000", "Alkohol 96% — ml — Rp 200/ml"). Verify both list.
   - **Stok Masuk:** add 1000 g Rose Oil + 5000 ml Alkohol into Warehouse 1.
   - **Stok:** confirm Warehouse 1 shows the new on-hand.
   - **Penyesuaian:** drop Rose Oil to 980 g with reason "susut". Verify in Stok.
   - **Transfer:** create draft W1→W2 with 200 g Rose Oil + 1000 ml Alkohol. **Send** → "Surat jalan siap" panel mounts → Lihat opens preview → Unduh PDF + Unduh PNG both work → Bagikan opens OS share-sheet (or downloads PNG on Firefox).
   - **Transfer (continued):** **Terima** with received 195 g / 1000 ml → discrepancy reason required → enter "tumpah" → Selesai. Verify W2 stock: 195 g + 1000 ml; verify the Tanda Terima panel for this completed transfer.
   - **Opname:** create planned count at W2 → Mulai → save 195 g (no change) + 990 ml (recount finds 10 ml short) → Selesai. Verify W2 stock now 195 g + 990 ml; verify the saved row shows `difference: -10` for alkohol.

- [ ] **Step 3: Confirm flag-off behaviour.** Toggle the Settings switch OFF → save → reload. Expected: Bahan tab disappears; backend `/api/v1/ingredients` returns 404 again. Toggle back ON before finishing.

- [ ] **Step 4: Record the verification + push the final state.**

```bash
git status -s    # should be clean
git log --oneline origin/prod-hardening..HEAD || true
git push origin prod-hardening
```
Update `SESSION_HANDOFF.md` "LATEST SESSION" section to note SP-Recipe-1 DONE (mirroring the SP1–SP4 entries). One commit:

```bash
git add SESSION_HANDOFF.md
git commit -m "docs: SP-Recipe-1 (ingredient inventory) DONE & live-verified"
git push origin prod-hardening
```

---

## Out of scope (do NOT add to this plan)

- `recipes`, `recipe_versions`, `recipe_ingredients` tables and the per-variant recipe slide-over editor — that's SP-Recipe-2.
- "Produksi" auto-deduct button — module-wide locked decision; never.
- POS exposure of ingredients or recipes — never.
- Ingredient CSV import/export — defer to a later phase.
- Multi-unit conversions per ingredient (kg ↔ g) — single unit per ingredient.
- POS-side thermal print of a Tanda Terima for ingredient transfers — N/A (POS doesn't see them).
- COGS / inventory valuation, suppliers as entities, purchase orders.

---

## Notes for the implementer

- **Six working rules apply to every task.** When uncertain, stop and ask before guessing.
- **Don't touch SP1–SP4 code.** All new tables + Go files + TS files are parallel.
- **The agent can self-deploy** (`gcloud run deploy`); no human action required between phases. Cloudflare Pages backoffice auto-deploys on push.
- **If a phase verification fails:** root-cause it, fix it, re-deploy, re-verify. Never mark a phase complete on a failing live test.
- **Reuse, don't duplicate.** The `render.ts` from SP4 is unchanged — both `SuratJalanPanel` (products) and `SuratJalanIngredientPanel` (ingredients) call it.
- **Numeric qty precision:** Postgres `numeric(14,3)` round-trips through Go as `float64` in this codebase (existing pattern). Beware: `0.1 + 0.2 != 0.3` in float math — when comparing qty differences in tests, use a small tolerance.
