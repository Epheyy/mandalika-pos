# Recipe SP-Recipe-2 — Recipes & Versioning — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **The 6 working rules (user-required, apply to every task):** 1) Ask, don't assume. 2) Don't touch unrelated code. 3) Flag uncertainty. 4) Verify on failure (never fake success). 5) Show changes (diffs). 6) Admit gaps.

**Goal:** Add per-variant recipes to the backoffice — a "Resep" button on each saved variant row in the product edit modal opens a right-side slide-over editor (ingredient lines + fractional qty + auto-filled unit + live cost estimate), every save creates an append-only version, a header dropdown browses version history, and any past version can be restored. Backoffice-only; POS untouched; gated by `manage_inventory` + `recipes_enabled`.

**Architecture:** Three new normalized tables (`recipes` → `recipe_versions` → `recipe_ingredients`) in migration 0021, mirroring the existing `*_items` snapshot pattern. `recipes.current_version_id` is a write-maintained live-version pointer (not a hard FK — avoids a circular create-order dependency in the first-save transaction). Each save snapshots `name_at_save` / `unit_at_save` / `cost_at_save` from today's ingredient. Optimistic concurrency: the save/restore body carries `expectedCurrentVersionId`; a mismatch returns **409**. Reuses the SP-Recipe-1 `manage_inventory` + `RequireRecipesEnabled` gate verbatim.

**Tech Stack:** Go (chi, pgx v5, oapi-codegen) + Postgres (Neon); TypeScript React backoffice (Vite, Tailwind, lucide-react); generated `@mandalika/api` client.

**Spec:** `docs/superpowers/specs/2026-05-28-recipe-sp2-recipes-versioning-design.md`

**Status:** app is test-data-only on free-tier (not real sales) — standard deploy hygiene, no kid-gloves.

---

## Conventions reused from the codebase (read before starting — all verified in SP-Recipe-1)

- **Migration runner:** `cmd/server/main.go` embeds + applies `backend/internal/db/migrations/NNNN_name.sql` on boot, tracked by full filename — never rename. Highest existing = `0020_ingredient_metadata.sql`; this plan adds **0021**.
- **Codegen:** `cd backend && make gen-go` regenerates `internal/api/api.gen.go`; `make gen-ts` regenerates `packages/api/src/schema.d.ts`. CI gate `make gen-check` fails if `api.gen.go` drifts — **always commit the regenerated file**. Run `gofmt -w internal/` before committing Go.
- **Write repo:** methods hang off `*write.Repo` with `r.Pool`. Sentinel `write.ErrNotFound` exists. Helper `ptrStr(*string) string` (nil → ""). pg unique-violation handling via `errors.As(&pgErr)` + `pgErr.Code == "23505"`. Manual tx: `tx, _ := r.Pool.Begin(ctx); defer tx.Rollback(ctx); …; tx.Commit(ctx)`.
- **pgx "conn busy" lesson (SP-Recipe-1 `93c17e6`):** never hold an open `tx.Query` cursor while issuing another `Exec` on the same tx. **Drain every read into Go memory before any write.** `QueryRow` is safe (reads one row fully).
- **Read repo:** `listJSON[T]` (first col = per-row jsonb, optional 2nd col = `count(*) OVER ()`), `oneJSON[T]` (returns `read.ErrNotFound` on `pgx.ErrNoRows`), `off(page,limit)`. Timestamps via `to_char(col AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')`.
- **Handlers:** `decodeWrite[T](w,r)`, `h.caller(r)` → `callerID{userID,outletID,name}`, `h.created(w,r,id,err)` (err → 400, else 201 `{data:{id}}`), `h.mutated(w,r,err)` (`write.ErrNotFound` → 404, other err → 400, else `{ok:true}`), `writeJSON`, `writeErr` (`read.ErrNotFound` → 404), `httpx.Err(w,status,msg)`, `pageLimit(r)`, `meta(total,p,l)`, `chi.URLParam(r,"name")`.
- **Routes:** `backend/internal/server/server.go` — the flag-gated ingredient group already exists: `r.Group(func(r chi.Router){ r.Use(mw.RequireRecipesEnabled(rd)); … })` nested inside `mw.RequirePermission("manage_inventory")` (~lines 186-212). SP-Recipe-2 routes register **inside this same group** (recipe routes reuse `manage_inventory`, even though the path starts `/products/...`). Register static segments before param segments.
- **TS client:** `packages/api/src/client.ts` holds the `Api` interface + impl; types are generated and re-exported from `index.ts` via `export * from './client'` + `export type { … }`. Impl helpers: `list<T>(url, opts)`, `data<T>(method, url, body?)` (unwraps `{data}`), `request(method, url, body?)` (no return). Errors throw `ApiError` with `.status`.
- **OpenAPI `$ref`+`nullable` gotcha (memory):** `openapi-typescript` drops `nullable:true` on `$ref` schemas → TS sees `T | undefined`. Clear nullable fields by omitting / `undefined`; Go pointer-omitempty makes missing == null on the wire.
- **Commit hook:** blocks `--no-verify` and false-positives on chained `git commit && …`. Run `git commit` on its own line; push separately.
- **Deploy (agent self-runs):** `gcloud run deploy mandalika-pos --source backend --region asia-southeast2 --quiet` (Bash with `dangerouslyDisableSandbox: true`; ~4-6 min). Verify `GET /readyz` (NOT `/healthz`). Backoffice auto-deploys on push to `prod-hardening`. **No APK** (backoffice-only).
- **Test creds:** admin `admin@mandalika.test`; password `gcloud secrets versions access latest --secret=SEED_ADMIN_PASSWORD`. The `recipes_enabled` flag is already ON in the test deployment.
- **Base API URL:** `https://mandalika-pos-538849926142.asia-southeast2.run.app`.

---

## File map

**Backend (Go):**
- Create `backend/internal/db/migrations/0021_recipes.sql`
- Modify `backend/api/openapi.yaml` (schemas + paths, two passes: A2 read/save, B1 restore)
- Regen `backend/internal/api/api.gen.go` + `packages/api/src/schema.d.ts`
- Create `backend/internal/write/recipe.go` (save core + restore + pure helpers)
- Create `backend/internal/write/recipe_test.go` (pure-function table tests)
- Modify `backend/internal/read/repo.go` (VariantRecipe + RecipeVersions + RecipeVersion)
- Modify `backend/internal/handlers/writes.go` (5 handler methods)
- Modify `backend/internal/server/server.go` (5 routes in the recipes-enabled group)

**TypeScript:**
- Modify `packages/api/src/client.ts` (5 `Api` methods + impls; re-export new types)
- Create `apps/backoffice/src/screens/recipes/useRecipe.ts` (data hook)
- Create `apps/backoffice/src/screens/recipes/RecipeSlideOver.tsx` (panel)
- Create `apps/backoffice/src/screens/recipes/RecipeIngredientPicker.tsx` (autocomplete add-row)
- Create `apps/backoffice/src/screens/recipes/VersionHistoryDropdown.tsx` (header pill + inline list)
- Modify `apps/backoffice/src/screens/Products.tsx` (Resep button per saved variant row + mount slide-over + `recipesEnabled` gate)

---

## PHASE A — Schema + backend read/save + optimistic lock + tests + deploy/verify

### Task A1: Migration 0021 — recipe tables

**Files:** Create `backend/internal/db/migrations/0021_recipes.sql`

- [ ] **Step 1: Write the migration.**

```sql
-- 0021: per-variant recipes with full version history (SP-Recipe-2).
-- Backoffice-only; gated by app_settings.recipes_enabled. Deletion only via
-- variant cascade (no manual delete). current_version_id is a write-maintained
-- pointer (intentionally NOT a hard FK — avoids a circular create-order
-- dependency inside the first-save transaction).

CREATE TABLE recipes (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  variant_id         uuid NOT NULL UNIQUE REFERENCES product_variants(id) ON DELETE CASCADE,
  current_version_id uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid REFERENCES users(id)
);

CREATE TABLE recipe_versions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipe_id         uuid NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  version_no        int  NOT NULL,
  notes             text,
  total_cost_cached numeric(14,2),
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid REFERENCES users(id),
  UNIQUE (recipe_id, version_no)
);
CREATE INDEX idx_recipe_versions_recipe ON recipe_versions(recipe_id);

CREATE TABLE recipe_ingredients (
  version_id    uuid NOT NULL REFERENCES recipe_versions(id) ON DELETE CASCADE,
  ingredient_id uuid NOT NULL REFERENCES ingredients(id) ON DELETE RESTRICT,
  qty           numeric(14,3) NOT NULL CHECK (qty > 0),
  name_at_save  text NOT NULL,
  unit_at_save  text NOT NULL,
  cost_at_save  numeric(14,2),
  sort_order    int  NOT NULL DEFAULT 0,
  PRIMARY KEY (version_id, ingredient_id)
);
```

- [ ] **Step 2: Sanity-build** (migrations embed via `go:embed`).

Run: `cd backend && go build ./...`
Expected: builds clean (SQL embedded; not applied until the A6 deploy).

- [ ] **Step 3: Commit.**

```bash
git add backend/internal/db/migrations/0021_recipes.sql
git commit -m "feat(recipe): SP-Recipe-2 migration 0021 — recipes + versions + ingredients"
```

---

### Task A2: OpenAPI — recipe schemas + read/save paths

**Files:** Modify `backend/api/openapi.yaml`; regen `api.gen.go` + `schema.d.ts`.

- [ ] **Step 1: Add schemas** (place after the `IngredientStockResponse` block; `Meta` already exists):

```yaml
    RecipeIngredientLine:
      type: object
      required: [ingredientId, nameAtSave, name, qty, unitAtSave, isActive, onHandTotal]
      properties:
        ingredientId: { type: string, format: uuid }
        nameAtSave: { type: string }
        name: { type: string }
        qty: { type: number }
        unitAtSave: { type: string }
        costAtSave: { type: number, nullable: true }
        defaultUnitCost: { type: number, nullable: true }
        isActive: { type: boolean }
        onHandTotal: { type: number }
    Recipe:
      type: object
      required: [variantId, versionNo, versionCount, items]
      properties:
        variantId: { type: string, format: uuid }
        recipeId: { type: string, format: uuid, nullable: true }
        currentVersionId: { type: string, format: uuid, nullable: true }
        versionId: { type: string, format: uuid, nullable: true }
        versionNo: { type: integer }
        notes: { type: string, nullable: true }
        totalCostCached: { type: number, nullable: true }
        versionCount: { type: integer }
        items: { type: array, items: { $ref: '#/components/schemas/RecipeIngredientLine' } }
    RecipeResponse:
      type: object
      required: [data]
      properties:
        data: { $ref: '#/components/schemas/Recipe' }
    RecipeVersionSummary:
      type: object
      required: [id, versionNo, createdAt]
      properties:
        id: { type: string, format: uuid }
        versionNo: { type: integer }
        notes: { type: string, nullable: true }
        totalCostCached: { type: number, nullable: true }
        createdAt: { type: string, format: date-time }
        createdByName: { type: string, nullable: true }
    RecipeVersionListResponse:
      type: object
      required: [data]
      properties:
        data: { type: array, items: { $ref: '#/components/schemas/RecipeVersionSummary' } }
    RecipeSaveItem:
      type: object
      required: [ingredientId, qty, sortOrder]
      properties:
        ingredientId: { type: string, format: uuid }
        qty: { type: number }
        sortOrder: { type: integer }
    RecipeSaveInput:
      type: object
      required: [items]
      properties:
        expectedCurrentVersionId: { type: string, format: uuid, nullable: true }
        notes: { type: string, nullable: true }
        items: { type: array, items: { $ref: '#/components/schemas/RecipeSaveItem' } }
    RecipeRestoreInput:
      type: object
      properties:
        expectedCurrentVersionId: { type: string, format: uuid, nullable: true }
```

- [ ] **Step 2: Add paths** (insert after the ingredient-stock-count paths). The `{productId}` segment is path-RESTful only; the server resolves by the globally-unique `{variantId}`:

```yaml
  /api/v1/products/{productId}/variants/{variantId}/recipe:
    get:
      operationId: getVariantRecipe
      tags: [catalog]
      parameters:
        - { name: productId, in: path, required: true, schema: { type: string, format: uuid } }
        - { name: variantId, in: path, required: true, schema: { type: string, format: uuid } }
      responses:
        '200':
          description: current recipe version
          content:
            application/json:
              schema: { $ref: '#/components/schemas/RecipeResponse' }
        '404': { description: no recipe yet }
    post:
      operationId: saveVariantRecipe
      tags: [catalog]
      parameters:
        - { name: productId, in: path, required: true, schema: { type: string, format: uuid } }
        - { name: variantId, in: path, required: true, schema: { type: string, format: uuid } }
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/RecipeSaveInput' }
      responses:
        '201': { description: created }
        '409': { description: version conflict }
  /api/v1/products/{productId}/variants/{variantId}/recipe/versions:
    get:
      operationId: listRecipeVersions
      tags: [catalog]
      parameters:
        - { name: productId, in: path, required: true, schema: { type: string, format: uuid } }
        - { name: variantId, in: path, required: true, schema: { type: string, format: uuid } }
      responses:
        '200':
          description: version summaries
          content:
            application/json:
              schema: { $ref: '#/components/schemas/RecipeVersionListResponse' }
  /api/v1/products/{productId}/variants/{variantId}/recipe/versions/{versionId}:
    get:
      operationId: getRecipeVersion
      tags: [catalog]
      parameters:
        - { name: productId, in: path, required: true, schema: { type: string, format: uuid } }
        - { name: variantId, in: path, required: true, schema: { type: string, format: uuid } }
        - { name: versionId, in: path, required: true, schema: { type: string, format: uuid } }
      responses:
        '200':
          description: one historical version (read-only)
          content:
            application/json:
              schema: { $ref: '#/components/schemas/RecipeResponse' }
  /api/v1/products/{productId}/variants/{variantId}/recipe/versions/{versionId}/restore:
    post:
      operationId: restoreRecipeVersion
      tags: [catalog]
      parameters:
        - { name: productId, in: path, required: true, schema: { type: string, format: uuid } }
        - { name: variantId, in: path, required: true, schema: { type: string, format: uuid } }
        - { name: versionId, in: path, required: true, schema: { type: string, format: uuid } }
      requestBody:
        required: false
        content:
          application/json:
            schema: { $ref: '#/components/schemas/RecipeRestoreInput' }
      responses:
        '201': { description: restored as a new version }
        '409': { description: version conflict }
```

- [ ] **Step 3: Regen + build.**

```bash
cd backend && make gen-go && make gen-ts && go build ./...
```
Expected: codegen clean; build green; `api.Recipe`, `api.RecipeSaveInput`, `api.RecipeVersionSummary` appear in `internal/api/api.gen.go`.

- [ ] **Step 4: Commit.**

```bash
git add backend/api/openapi.yaml backend/internal/api/api.gen.go packages/api/src/schema.d.ts
git commit -m "feat(recipe): SP-Recipe-2 openapi — recipe schemas + read/save/restore paths"
```

---

### Task A3: Write repo — pure helpers + failing tests

**Files:** Create `backend/internal/write/recipe.go`, `backend/internal/write/recipe_test.go`

- [ ] **Step 1: Write the pure helpers + types** in `recipe.go`:

```go
package write

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// ErrVersionConflict signals an optimistic-lock failure (someone else saved a
// newer version between load and save). Mapped to HTTP 409 by the handler.
var ErrVersionConflict = errors.New("resep sudah diubah orang lain. muat ulang")

// RecipeSaveItem is one ingredient line in a save request.
type RecipeSaveItem struct {
	IngredientID string  `json:"ingredientId"`
	Qty          float64 `json:"qty"`
	SortOrder    int     `json:"sortOrder"`
}

// RecipeSave is the write-model for "save a new version".
type RecipeSave struct {
	ExpectedCurrentVersionID *string          `json:"expectedCurrentVersionId,omitempty"`
	Notes                    string           `json:"notes,omitempty"`
	Items                    []RecipeSaveItem `json:"items"`
}

// ingredientSnap is the resolved ingredient data captured at save time.
type ingredientSnap struct {
	name     string
	unit     string
	cost     *float64
	isActive bool
}

// versionMatches implements the optimistic-lock comparison. Both nil (first
// save, no current version) matches; both non-nil and equal matches; anything
// else is a conflict.
func versionMatches(expected, current *string) bool {
	if expected == nil && current == nil {
		return true
	}
	if expected == nil || current == nil {
		return false
	}
	return *expected == *current
}

// computeTotalCost sums qty*cost across lines. Returns nil if ANY line lacks a
// cost (the cost estimate is all-or-nothing, per the locked decision).
func computeTotalCost(items []RecipeSaveItem, snaps map[string]ingredientSnap) *float64 {
	var total float64
	for _, it := range items {
		s, ok := snaps[it.IngredientID]
		if !ok || s.cost == nil {
			return nil
		}
		total += it.Qty * (*s.cost)
	}
	return &total
}

// newlyAddedInactive reports whether a line introduces an inactive ingredient
// that was NOT in the prior current version (a forbidden fresh add). Lines that
// were already present pass (warn-but-allow).
func newlyAddedInactive(ingredientID string, isActive bool, priorIDs map[string]bool) bool {
	return !isActive && !priorIDs[ingredientID]
}

var _ = pgx.ErrNoRows // keep pgx import used (referenced in the DB methods below)
```

- [ ] **Step 2: Write failing tests** in `recipe_test.go`:

```go
package write

import "testing"

func strp(s string) *string  { return &s }
func f64p(f float64) *float64 { return &f }

func TestVersionMatches(t *testing.T) {
	cases := []struct {
		name             string
		expected, actual *string
		want             bool
	}{
		{"both nil (first save)", nil, nil, true},
		{"expected nil, current set", nil, strp("v1"), false},
		{"expected set, current nil", strp("v1"), nil, false},
		{"equal", strp("v1"), strp("v1"), true},
		{"different", strp("v1"), strp("v2"), false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := versionMatches(c.expected, c.actual); got != c.want {
				t.Fatalf("versionMatches=%v want %v", got, c.want)
			}
		})
	}
}

func TestComputeTotalCost(t *testing.T) {
	snaps := map[string]ingredientSnap{
		"a": {cost: f64p(100)},
		"b": {cost: f64p(50)},
		"c": {cost: nil},
	}
	items := []RecipeSaveItem{{IngredientID: "a", Qty: 2}, {IngredientID: "b", Qty: 3}}
	got := computeTotalCost(items, snaps)
	if got == nil || *got != 350 {
		t.Fatalf("total=%v want 350", got)
	}
	// any nil cost → whole total nil
	withNil := append(items, RecipeSaveItem{IngredientID: "c", Qty: 1})
	if computeTotalCost(withNil, snaps) != nil {
		t.Fatalf("expected nil total when a line lacks cost")
	}
	// unknown ingredient → nil
	if computeTotalCost([]RecipeSaveItem{{IngredientID: "x", Qty: 1}}, snaps) != nil {
		t.Fatalf("expected nil total for unknown ingredient")
	}
}

func TestNewlyAddedInactive(t *testing.T) {
	prior := map[string]bool{"keep": true}
	if newlyAddedInactive("keep", false, prior) {
		t.Fatalf("pre-existing inactive line must be allowed")
	}
	if !newlyAddedInactive("fresh", false, prior) {
		t.Fatalf("freshly added inactive line must be rejected")
	}
	if newlyAddedInactive("fresh", true, prior) {
		t.Fatalf("active ingredient must always be allowed")
	}
}
```

- [ ] **Step 3: Run tests — expect PASS** (these are pure functions defined in Step 1).

Run: `cd backend && go test ./internal/write/ -run 'TestVersionMatches|TestComputeTotalCost|TestNewlyAddedInactive' -v`
Expected: all three PASS. (If a compile error mentions unused imports, remove the `var _ =` guard once the DB methods in A4 use `pgx`.)

- [ ] **Step 4: Commit.**

```bash
git add backend/internal/write/recipe.go backend/internal/write/recipe_test.go
git commit -m "test(recipe): SP-Recipe-2 pure helpers (version match, cost, inactive) + tests"
```

---

### Task A4: Write repo — SaveRecipe (version insert + optimistic lock)

**Files:** Modify `backend/internal/write/recipe.go`

- [ ] **Step 1: Append the save core + public SaveRecipe.** Remove the `var _ = pgx.ErrNoRows` guard from A3 (pgx is now used).

```go
// loadIngredientSnaps fetches name/unit/cost/is_active for the given ingredient
// IDs in one query, fully drained before the caller issues any tx write
// (pgx conn-busy discipline). Returns an error if any ID is unknown.
func loadIngredientSnaps(ctx context.Context, tx pgx.Tx, ids []string) (map[string]ingredientSnap, error) {
	out := make(map[string]ingredientSnap, len(ids))
	rows, err := tx.Query(ctx,
		`SELECT id::text, name, unit, default_unit_cost, is_active
		   FROM ingredients WHERE id = ANY($1)`, ids)
	if err != nil {
		return nil, fmt.Errorf("load ingredients: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var id, name, unit string
		var cost *float64
		var active bool
		if err := rows.Scan(&id, &name, &unit, &cost, &active); err != nil {
			return nil, fmt.Errorf("scan ingredient: %w", err)
		}
		out[id] = ingredientSnap{name: name, unit: unit, cost: cost, isActive: active}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// priorVersionIngredientIDs returns the set of ingredient IDs in a version
// (used for the warn-but-allow inactive check). Empty set when versionID is nil.
func priorVersionIngredientIDs(ctx context.Context, tx pgx.Tx, versionID *string) (map[string]bool, error) {
	set := map[string]bool{}
	if versionID == nil {
		return set, nil
	}
	rows, err := tx.Query(ctx,
		`SELECT ingredient_id::text FROM recipe_ingredients WHERE version_id = $1`, *versionID)
	if err != nil {
		return nil, fmt.Errorf("load prior version: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("scan prior id: %w", err)
		}
		set[id] = true
	}
	return set, rows.Err()
}

// insertRecipeVersion writes a new version + its ingredient snapshot and repoints
// recipes.current_version_id, all inside tx. snaps must already be loaded.
// allowInactive skips the newly-added-inactive guard (used by restore).
func (r *Repo) insertRecipeVersion(
	ctx context.Context, tx pgx.Tx, recipeID, caller, notes string,
	items []RecipeSaveItem, snaps map[string]ingredientSnap, priorIDs map[string]bool, allowInactive bool,
) (string, error) {
	for _, it := range items {
		if it.Qty <= 0 {
			return "", fmt.Errorf("qty harus lebih dari 0")
		}
		s, ok := snaps[it.IngredientID]
		if !ok {
			return "", fmt.Errorf("bahan tidak ditemukan")
		}
		if !allowInactive && newlyAddedInactive(it.IngredientID, s.isActive, priorIDs) {
			return "", fmt.Errorf("bahan nonaktif tidak bisa ditambahkan")
		}
	}

	var nextNo int
	if err := tx.QueryRow(ctx,
		`SELECT COALESCE(MAX(version_no),0)+1 FROM recipe_versions WHERE recipe_id=$1`,
		recipeID,
	).Scan(&nextNo); err != nil {
		return "", fmt.Errorf("next version_no: %w", err)
	}

	total := computeTotalCost(items, snaps)
	var versionID string
	if err := tx.QueryRow(ctx,
		`INSERT INTO recipe_versions (recipe_id, version_no, notes, total_cost_cached, created_by)
		 VALUES ($1, $2, NULLIF($3,''), $4, NULLIF($5,'')::uuid)
		 RETURNING id`,
		recipeID, nextNo, notes, total, caller,
	).Scan(&versionID); err != nil {
		return "", fmt.Errorf("insert version: %w", err)
	}

	for _, it := range items {
		s := snaps[it.IngredientID]
		if _, err := tx.Exec(ctx,
			`INSERT INTO recipe_ingredients
			   (version_id, ingredient_id, qty, name_at_save, unit_at_save, cost_at_save, sort_order)
			 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
			versionID, it.IngredientID, it.Qty, s.name, s.unit, s.cost, it.SortOrder,
		); err != nil {
			return "", fmt.Errorf("insert recipe ingredient: %w", err)
		}
	}

	if _, err := tx.Exec(ctx,
		`UPDATE recipes SET current_version_id=$2 WHERE id=$1`, recipeID, versionID,
	); err != nil {
		return "", fmt.Errorf("repoint current version: %w", err)
	}
	return versionID, nil
}

// resolveRecipe finds or creates the recipe row for a variant (FOR UPDATE) and
// returns its id + current_version_id. Creates the row when missing.
func resolveRecipe(ctx context.Context, tx pgx.Tx, variantID, caller string) (recipeID string, currentVersionID *string, err error) {
	err = tx.QueryRow(ctx,
		`SELECT id::text, current_version_id::text FROM recipes WHERE variant_id=$1 FOR UPDATE`,
		variantID,
	).Scan(&recipeID, &currentVersionID)
	if err == nil {
		return recipeID, currentVersionID, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return "", nil, fmt.Errorf("load recipe: %w", err)
	}
	// First save: ensure the variant exists, then create the recipe row.
	var exists bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM product_variants WHERE id=$1)`, variantID).Scan(&exists); err != nil {
		return "", nil, fmt.Errorf("check variant: %w", err)
	}
	if !exists {
		return "", nil, fmt.Errorf("varian tidak ditemukan")
	}
	if err = tx.QueryRow(ctx,
		`INSERT INTO recipes (variant_id, created_by) VALUES ($1, NULLIF($2,'')::uuid) RETURNING id::text`,
		variantID, caller,
	).Scan(&recipeID); err != nil {
		return "", nil, fmt.Errorf("create recipe: %w", err)
	}
	return recipeID, nil, nil
}

// SaveRecipe creates a new version for a variant's recipe (creating the recipe
// on first save). Enforces optimistic locking via expectedCurrentVersionId.
func (r *Repo) SaveRecipe(ctx context.Context, caller, variantID string, in RecipeSave) (string, error) {
	tx, err := r.Pool.Begin(ctx)
	if err != nil {
		return "", fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	recipeID, currentVersionID, err := resolveRecipe(ctx, tx, variantID, caller)
	if err != nil {
		return "", err
	}
	if !versionMatches(in.ExpectedCurrentVersionID, currentVersionID) {
		return "", ErrVersionConflict
	}

	ids := make([]string, 0, len(in.Items))
	for _, it := range in.Items {
		ids = append(ids, it.IngredientID)
	}
	snaps, err := loadIngredientSnaps(ctx, tx, ids)
	if err != nil {
		return "", err
	}
	priorIDs, err := priorVersionIngredientIDs(ctx, tx, currentVersionID)
	if err != nil {
		return "", err
	}

	versionID, err := r.insertRecipeVersion(ctx, tx, recipeID, caller, in.Notes, in.Items, snaps, priorIDs, false)
	if err != nil {
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", fmt.Errorf("commit tx: %w", err)
	}
	return versionID, nil
}
```

- [ ] **Step 2: Build + run existing tests.**

```bash
cd backend && gofmt -w internal/write && go build ./... && go test ./internal/write/ -run TestVersionMatches -v
```
Expected: build green; test PASS.

- [ ] **Step 3: Commit.**

```bash
git add backend/internal/write/recipe.go
git commit -m "feat(recipe): SP-Recipe-2 SaveRecipe — version insert + optimistic lock + snapshot"
```

---

### Task A5: Read repo — current recipe + version list + one version

**Files:** Modify `backend/internal/read/repo.go`

- [ ] **Step 1: Add three methods** near the ingredient read methods (~line 295). The `_lines` CTE-style subquery hydrates each line with current ingredient data + total on-hand across warehouses.

```go
// recipeLinesSQL is the shared jsonb_agg subquery for a version's ingredient
// lines, hydrated with current name/cost/unit + total on-hand across warehouses.
const recipeLinesSQL = `
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'ingredientId', ri.ingredient_id,
    'nameAtSave',   ri.name_at_save,
    'name',         COALESCE(ing.name, ri.name_at_save),
    'qty',          ri.qty,
    'unitAtSave',   ri.unit_at_save,
    'costAtSave',   ri.cost_at_save,
    'defaultUnitCost', ing.default_unit_cost,
    'isActive',     COALESCE(ing.is_active, false),
    'onHandTotal',  COALESCE((SELECT SUM(qty) FROM ingredient_warehouse_stock WHERE ingredient_id = ri.ingredient_id), 0)
  ) ORDER BY ri.sort_order, ri.name_at_save), '[]'::jsonb)
    FROM recipe_ingredients ri
    LEFT JOIN ingredients ing ON ing.id = ri.ingredient_id
   WHERE ri.version_id = %s`

// VariantRecipe returns the current version of a variant's recipe. Returns
// read.ErrNotFound when the variant has no recipe yet.
func (r *Repo) VariantRecipe(ctx context.Context, variantID string) (api.Recipe, error) {
	sql := `
      WITH rec AS (
        SELECT id, current_version_id FROM recipes WHERE variant_id = $1
      ),
      cv AS (
        SELECT v.* FROM recipe_versions v JOIN rec ON rec.current_version_id = v.id
      )
      SELECT jsonb_build_object(
        'variantId', $1::uuid,
        'recipeId', (SELECT id FROM rec),
        'currentVersionId', (SELECT current_version_id FROM rec),
        'versionId', (SELECT id FROM cv),
        'versionNo', COALESCE((SELECT version_no FROM cv), 0),
        'notes', (SELECT notes FROM cv),
        'totalCostCached', (SELECT total_cost_cached FROM cv),
        'versionCount', (SELECT COUNT(*) FROM recipe_versions WHERE recipe_id = (SELECT id FROM rec)),
        'items', (` + fmt.Sprintf(recipeLinesSQL, "(SELECT id FROM cv)") + `)
      )
      FROM rec`
	return oneJSON[api.Recipe](ctx, r.Pool, sql, variantID)
}

// RecipeVersions lists version summaries (newest first) for a variant's recipe.
// Returns an empty slice when there is no recipe.
func (r *Repo) RecipeVersions(ctx context.Context, variantID string) ([]api.RecipeVersionSummary, error) {
	const sql = `
      SELECT jsonb_build_object(
        'id', v.id, 'versionNo', v.version_no, 'notes', v.notes,
        'totalCostCached', v.total_cost_cached,
        'createdAt', to_char(v.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'createdByName', u.display_name
      )
      FROM recipe_versions v
      JOIN recipes rc ON rc.id = v.recipe_id AND rc.variant_id = $1
      LEFT JOIN users u ON u.id = v.created_by
      ORDER BY v.version_no DESC`
	rows, _, err := listJSON[api.RecipeVersionSummary](ctx, r.Pool, sql, variantID)
	return rows, err
}

// RecipeVersion returns one historical version (read-only) of a variant's recipe.
func (r *Repo) RecipeVersion(ctx context.Context, variantID, versionID string) (api.Recipe, error) {
	sql := `
      WITH cv AS (
        SELECT v.* FROM recipe_versions v
        JOIN recipes rc ON rc.id = v.recipe_id AND rc.variant_id = $1
       WHERE v.id = $2
      )
      SELECT jsonb_build_object(
        'variantId', $1::uuid,
        'recipeId', (SELECT recipe_id FROM cv),
        'currentVersionId', (SELECT current_version_id FROM recipes WHERE variant_id = $1),
        'versionId', (SELECT id FROM cv),
        'versionNo', (SELECT version_no FROM cv),
        'notes', (SELECT notes FROM cv),
        'totalCostCached', (SELECT total_cost_cached FROM cv),
        'versionCount', (SELECT COUNT(*) FROM recipe_versions WHERE recipe_id = (SELECT recipe_id FROM cv)),
        'items', (` + fmt.Sprintf(recipeLinesSQL, "(SELECT id FROM cv)") + `)
      )
      FROM cv`
	return oneJSON[api.Recipe](ctx, r.Pool, sql, variantID, versionID)
}
```

- [ ] **Step 2: Ensure `fmt` is imported** in `read/repo.go` (it already is — used by `listJSON`/`oneJSON`). Build:

```bash
cd backend && gofmt -w internal/read && go build ./...
```
Expected: green.

- [ ] **Step 3: Commit.**

```bash
git add backend/internal/read/repo.go
git commit -m "feat(recipe): SP-Recipe-2 read repo — current recipe + version list + one version"
```

---

### Task A6: Handlers + routes

**Files:** Modify `backend/internal/handlers/writes.go`, `backend/internal/server/server.go`

- [ ] **Step 1: Add 5 handlers** in `writes.go` (group near the ingredient handlers). `errors`, `chi`, `httpx`, `api`, `write` are already imported in this file.

```go
// ── Recipes (SP-Recipe-2) ──────────────────────────────────

func (h *Handlers) VariantRecipe(w http.ResponseWriter, r *http.Request) {
	rec, err := h.Repo.VariantRecipe(r.Context(), chi.URLParam(r, "variantId"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, err) // read.ErrNotFound → 404
		return
	}
	writeJSON(w, http.StatusOK, api.RecipeResponse{Data: rec})
}

func (h *Handlers) RecipeVersions(w http.ResponseWriter, r *http.Request) {
	rows, err := h.Repo.RecipeVersions(r.Context(), chi.URLParam(r, "variantId"))
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, http.StatusOK, api.RecipeVersionListResponse{Data: rows})
}

func (h *Handlers) RecipeVersion(w http.ResponseWriter, r *http.Request) {
	rec, err := h.Repo.RecipeVersion(r.Context(), chi.URLParam(r, "variantId"), chi.URLParam(r, "versionId"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusOK, api.RecipeResponse{Data: rec})
}

func (h *Handlers) SaveVariantRecipe(w http.ResponseWriter, r *http.Request) {
	in, ok := decodeWrite[write.RecipeSave](w, r)
	if !ok {
		return
	}
	c, _ := h.caller(r)
	id, err := h.Write.SaveRecipe(r.Context(), c.userID, chi.URLParam(r, "variantId"), in)
	if errors.Is(err, write.ErrVersionConflict) {
		httpx.Err(w, http.StatusConflict, err.Error())
		return
	}
	h.created(w, r, id, err) // validation / inactive-add → 400; success → 201
}

func (h *Handlers) RestoreRecipeVersion(w http.ResponseWriter, r *http.Request) {
	// Body is optional; default to an empty struct when absent.
	var in write.RecipeRestore
	_ = httpx.DecodeLoose(r, &in) // tolerate empty body
	c, _ := h.caller(r)
	id, err := h.Write.RestoreRecipeVersion(r.Context(), c.userID,
		chi.URLParam(r, "variantId"), chi.URLParam(r, "versionId"), in.ExpectedCurrentVersionID)
	if errors.Is(err, write.ErrVersionConflict) {
		httpx.Err(w, http.StatusConflict, err.Error())
		return
	}
	h.created(w, r, id, err)
}
```

> **Note:** `write.RecipeRestore` + `RestoreRecipeVersion` are added in Task B2. To keep Phase A compiling on its own, temporarily comment out the `RestoreRecipeVersion` handler (and its route in Step 2) until B2, OR implement B2's write method before building. The subagent executing this plan should do A1-A5, then B2's write method, then wire both A6 handlers + routes together. Flag this ordering when you reach it.

- [ ] **Step 2: Register routes** inside the existing `RequireRecipesEnabled` group in `server.go` (after the ingredient-stock-count routes, before the group's closing `})` at ~line 212):

```go
					// recipes (SP-Recipe-2; per-variant, reuse manage_inventory + recipes flag)
					r.Get("/products/{productId}/variants/{variantId}/recipe", h.VariantRecipe)
					r.Post("/products/{productId}/variants/{variantId}/recipe", h.SaveVariantRecipe)
					r.Get("/products/{productId}/variants/{variantId}/recipe/versions", h.RecipeVersions)
					r.Get("/products/{productId}/variants/{variantId}/recipe/versions/{versionId}", h.RecipeVersion)
					r.Post("/products/{productId}/variants/{variantId}/recipe/versions/{versionId}/restore", h.RestoreRecipeVersion)
```

- [ ] **Step 3: Build.** `cd backend && gofmt -w internal/ && go build ./...` → green (after B2's write method exists, or with RestoreRecipeVersion temporarily stubbed).

- [ ] **Step 4: Commit.**

```bash
git add backend/internal/handlers/writes.go backend/internal/server/server.go
git commit -m "feat(recipe): SP-Recipe-2 handlers + flag-gated recipe routes"
```

---

### Task B2 (pulled forward): Write repo — RestoreRecipeVersion

**Files:** Modify `backend/internal/write/recipe.go`

> Implement this **before** building A6 so the `RestoreRecipeVersion` handler compiles.

- [ ] **Step 1: Append restore type + method.**

```go
// RecipeRestore is the (optional) body for a restore call.
type RecipeRestore struct {
	ExpectedCurrentVersionID *string `json:"expectedCurrentVersionId,omitempty"`
}

// RestoreRecipeVersion creates a NEW version from a historical snapshot's items,
// re-snapshotting name/unit/cost at TODAY's prices (locked decision). Same
// optimistic-lock guard as SaveRecipe. Inactive ingredients from the snapshot
// are allowed (the user is deliberately restoring a known formula).
func (r *Repo) RestoreRecipeVersion(ctx context.Context, caller, variantID, versionID string, expected *string) (string, error) {
	tx, err := r.Pool.Begin(ctx)
	if err != nil {
		return "", fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	recipeID, currentVersionID, err := resolveRecipe(ctx, tx, variantID, caller)
	if err != nil {
		return "", err
	}
	if !versionMatches(expected, currentVersionID) {
		return "", ErrVersionConflict
	}

	// Load the snapshot's lines (qty + sort_order), verifying the version belongs
	// to this variant's recipe. Drain fully before any write.
	rows, err := tx.Query(ctx,
		`SELECT ri.ingredient_id::text, ri.qty, ri.sort_order
		   FROM recipe_ingredients ri
		   JOIN recipe_versions v ON v.id = ri.version_id
		  WHERE ri.version_id = $1 AND v.recipe_id = $2`,
		versionID, recipeID)
	if err != nil {
		return "", fmt.Errorf("load snapshot: %w", err)
	}
	var items []RecipeSaveItem
	for rows.Next() {
		var it RecipeSaveItem
		if err := rows.Scan(&it.IngredientID, &it.Qty, &it.SortOrder); err != nil {
			rows.Close()
			return "", fmt.Errorf("scan snapshot line: %w", err)
		}
		items = append(items, it)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return "", err
	}
	if len(items) == 0 {
		// Could be an empty version (valid) or a wrong versionId for this variant.
		var belongs bool
		if err := tx.QueryRow(ctx,
			`SELECT EXISTS(SELECT 1 FROM recipe_versions WHERE id=$1 AND recipe_id=$2)`,
			versionID, recipeID).Scan(&belongs); err != nil {
			return "", fmt.Errorf("verify version: %w", err)
		}
		if !belongs {
			return "", fmt.Errorf("versi tidak ditemukan")
		}
	}

	ids := make([]string, 0, len(items))
	for _, it := range items {
		ids = append(ids, it.IngredientID)
	}
	snaps, err := loadIngredientSnaps(ctx, tx, ids)
	if err != nil {
		return "", err
	}

	// Carry the snapshot's notes onto the restored version for context.
	var notes string
	_ = tx.QueryRow(ctx, `SELECT COALESCE(notes,'') FROM recipe_versions WHERE id=$1`, versionID).Scan(&notes)
	if notes != "" {
		notes = "Pulihkan: " + notes
	} else {
		notes = "Pulihkan dari versi sebelumnya"
	}

	newID, err := r.insertRecipeVersion(ctx, tx, recipeID, caller, notes, items, snaps, nil, true /*allowInactive*/)
	if err != nil {
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", fmt.Errorf("commit tx: %w", err)
	}
	return newID, nil
}
```

- [ ] **Step 2: Build.** `cd backend && gofmt -w internal/write && go build ./...` → green. Now A6 compiles fully.

- [ ] **Step 3: Commit.**

```bash
git add backend/internal/write/recipe.go
git commit -m "feat(recipe): SP-Recipe-2 RestoreRecipeVersion — re-snapshot at today's prices"
```

---

### Task A7: Deploy + live API verification (backend complete)

- [ ] **Step 1: Deploy** (migration 0021 auto-applies on boot).

```bash
gcloud run deploy mandalika-pos --source backend --region asia-southeast2 --quiet
```
Expected: new revision; `GET https://mandalika-pos-538849926142.asia-southeast2.run.app/readyz` → ready.

- [ ] **Step 2: Auth + pick a variant + two ingredients.** The `recipes_enabled` flag is already ON.

```bash
BASE=https://mandalika-pos-538849926142.asia-southeast2.run.app
TOKEN=$(curl -s -X POST $BASE/api/v1/auth/login -H 'content-type: application/json' \
  -d "{\"email\":\"admin@mandalika.test\",\"password\":\"$(gcloud secrets versions access latest --secret=SEED_ADMIN_PASSWORD)\"}" \
  | python -c "import json,sys;print(json.load(sys.stdin)['data']['accessToken'])")
# A product + its variant ids:
curl -s "$BASE/api/v1/products?limit=1" -H "authorization: Bearer $TOKEN" | python -m json.tool | head -60
# Two ingredient ids:
curl -s "$BASE/api/v1/ingredients?limit=5" -H "authorization: Bearer $TOKEN" | python -m json.tool | head -40
```
Record `PRODUCT_ID`, `VARIANT_ID`, `ING_A`, `ING_B`.

- [ ] **Step 3: GET recipe before any save → 404.**

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  "$BASE/api/v1/products/$PRODUCT_ID/variants/$VARIANT_ID/recipe" -H "authorization: Bearer $TOKEN"
```
Expected: `404`.

- [ ] **Step 4: Save v1 (first save → expectedCurrentVersionId null).**

```bash
curl -s -X POST "$BASE/api/v1/products/$PRODUCT_ID/variants/$VARIANT_ID/recipe" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"notes\":\"v1\",\"items\":[{\"ingredientId\":\"$ING_A\",\"qty\":12.5,\"sortOrder\":0},{\"ingredientId\":\"$ING_B\",\"qty\":35,\"sortOrder\":1}]}"
curl -s "$BASE/api/v1/products/$PRODUCT_ID/variants/$VARIANT_ID/recipe" -H "authorization: Bearer $TOKEN" | python -m json.tool
```
Expected: 201; GET shows `versionNo:1`, two items with `qty` 12.5 / 35, `onHandTotal` populated, `totalCostCached` = Σ qty×cost (or null if an ingredient lacks cost). Record `currentVersionId` as `CV1`.

- [ ] **Step 5: Edit → v2 (pass the current version id).**

```bash
curl -s -X POST "$BASE/api/v1/products/$PRODUCT_ID/variants/$VARIANT_ID/recipe" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"expectedCurrentVersionId\":\"$CV1\",\"notes\":\"v2 more rose\",\"items\":[{\"ingredientId\":\"$ING_A\",\"qty\":18,\"sortOrder\":0}]}"
curl -s "$BASE/api/v1/products/$PRODUCT_ID/variants/$VARIANT_ID/recipe/versions" -H "authorization: Bearer $TOKEN" | python -m json.tool
```
Expected: 201; versions list shows v2 (newest) + v1, with `createdByName`. Record `CV2`.

- [ ] **Step 6: Concurrent save with a STALE expected id → 409.**

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$BASE/api/v1/products/$PRODUCT_ID/variants/$VARIANT_ID/recipe" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"expectedCurrentVersionId\":\"$CV1\",\"items\":[{\"ingredientId\":\"$ING_A\",\"qty\":1,\"sortOrder\":0}]}"
```
Expected: `409`.

- [ ] **Step 7: Restore v1 → v3 (cost recomputed at today's prices).** Get v1's version id from the versions list (`V1_ID`), pass the current id `CV2`:

```bash
curl -s -X POST "$BASE/api/v1/products/$PRODUCT_ID/variants/$VARIANT_ID/recipe/versions/$V1_ID/restore" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"expectedCurrentVersionId\":\"$CV2\"}"
curl -s "$BASE/api/v1/products/$PRODUCT_ID/variants/$VARIANT_ID/recipe" -H "authorization: Bearer $TOKEN" | python -m json.tool
```
Expected: 201; current is now `versionNo:3` with v1's two ingredient lines; `totalCostCached` reflects current ingredient costs.

- [ ] **Step 8: Inactive-ingredient add → 400.** Set an UNUSED ingredient inactive, then try to add it fresh:

```bash
# Make ING_B inactive (it is NOT in the current v3, which has only ING_A):
curl -s -X PUT "$BASE/api/v1/ingredients/$ING_B" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"ZZ Inactive Verify","unit":"ml","isActive":false}'
CV3=$(curl -s "$BASE/api/v1/products/$PRODUCT_ID/variants/$VARIANT_ID/recipe" -H "authorization: Bearer $TOKEN" | python -c "import json,sys;print(json.load(sys.stdin)['data']['currentVersionId'])")
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$BASE/api/v1/products/$PRODUCT_ID/variants/$VARIANT_ID/recipe" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"expectedCurrentVersionId\":\"$CV3\",\"items\":[{\"ingredientId\":\"$ING_A\",\"qty\":18,\"sortOrder\":0},{\"ingredientId\":\"$ING_B\",\"qty\":5,\"sortOrder\":1}]}"
```
Expected: `400` ("bahan nonaktif tidak bisa ditambahkan"). (Reactivate ING_B afterward if you want to keep test data tidy.)

- [ ] **Step 9: Zero-line save (clear) → 201.**

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$BASE/api/v1/products/$PRODUCT_ID/variants/$VARIANT_ID/recipe" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"expectedCurrentVersionId\":\"$CV3\",\"items\":[]}"
```
Expected: `201` (empty version allowed = clears the recipe).

- [ ] **Step 10: Run the Go unit tests once more + push.**

```bash
cd backend && go test ./internal/write/ -run 'Recipe|Version|Cost|Inactive' -v
git push origin prod-hardening
```
Expected: PASS; push succeeds. **Flag any verification mismatch to the user — do not proceed to the UI if a check failed.**

---

## PHASE C — TS client methods

### Task C1: `@mandalika/api` — recipe methods + impls

**Files:** Modify `packages/api/src/client.ts` (+ confirm `index.ts` re-exports)

- [ ] **Step 1: Add to the `Api` interface** (near the ingredient methods, ~line 212). Types `Recipe`, `RecipeVersionSummary`, `RecipeSaveInput` are generated by `make gen-ts` (Task A2) — import them alongside the other generated types at the top of `client.ts`.

```ts
  getVariantRecipe: (productId: string, variantId: string) => Promise<Recipe | null>
  listRecipeVersions: (productId: string, variantId: string) => Promise<RecipeVersionSummary[]>
  getRecipeVersion: (productId: string, variantId: string, versionId: string) => Promise<Recipe>
  saveVariantRecipe: (productId: string, variantId: string, input: RecipeSaveInput) => Promise<{ id: string }>
  restoreRecipeVersion: (productId: string, variantId: string, versionId: string, expectedCurrentVersionId: string | null) => Promise<{ id: string }>
```

- [ ] **Step 2: Add the impls** (in the returned object near the ingredient impls). `getVariantRecipe` catches the 404 (no recipe yet) and returns `null`:

```ts
    getVariantRecipe: async (productId, variantId) => {
      try {
        return await data<Recipe>('GET', `${API}/products/${productId}/variants/${variantId}/recipe`)
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null
        throw e
      }
    },
    listRecipeVersions: (productId, variantId) =>
      data<RecipeVersionSummary[]>('GET', `${API}/products/${productId}/variants/${variantId}/recipe/versions`),
    getRecipeVersion: (productId, variantId, versionId) =>
      data<Recipe>('GET', `${API}/products/${productId}/variants/${variantId}/recipe/versions/${versionId}`),
    saveVariantRecipe: (productId, variantId, input) =>
      data<{ id: string }>('POST', `${API}/products/${productId}/variants/${variantId}/recipe`, input),
    restoreRecipeVersion: (productId, variantId, versionId, expectedCurrentVersionId) =>
      data<{ id: string }>('POST', `${API}/products/${productId}/variants/${variantId}/recipe/versions/${versionId}/restore`, { expectedCurrentVersionId }),
```

> **Confirm `data<T>` unwraps `{data}` for both GET and POST.** The ingredient transfer impl uses `data<IngredientTransfer>('GET', …)` and the save endpoints return `{data:{id}}`; `data` returns the inner value. If `data` does not exist for POST in this codebase, fall back to `request<{data:{id}}>('POST', …).then(r => r.data)`. Verify against the existing `createIngredientTransfer`/`getIngredientTransfer` impls before writing.

- [ ] **Step 3: Ensure types are exported.** `packages/api/src/index.ts` re-exports generated types; confirm `Recipe`, `RecipeVersionSummary`, `RecipeSaveInput`, `RecipeIngredientLine` are exported (add to the explicit `export type { … }` list if it enumerates types).

- [ ] **Step 4: Build the api package + typecheck backoffice.**

```bash
corepack pnpm --filter @mandalika/api build
corepack pnpm --filter @mandalika/backoffice exec tsc --noEmit
```
Expected: both clean.

- [ ] **Step 5: Commit.**

```bash
git add packages/api/src/client.ts packages/api/src/index.ts
git commit -m "feat(recipe): SP-Recipe-2 api client — recipe get/list/save/restore methods"
```

---

## PHASE D — Backoffice slide-over editor + version history

### Task D1: `useRecipe` data hook

**Files:** Create `apps/backoffice/src/screens/recipes/useRecipe.ts`

- [ ] **Step 1: Write the hook.** It owns the editor's data: loaded current recipe, version summaries, which version is being viewed (current vs a historical id), and save/restore actions. The editable line shape is local.

```ts
import { useCallback, useEffect, useState } from 'react'
import { ApiError, type Recipe, type RecipeVersionSummary, type RecipeIngredientLine } from '@mandalika/api'
import { api } from '../../api'

export interface EditLine {
  ingredientId: string
  name: string
  unit: string
  qty: string // string for the input; parsed on save
  costAtSave?: number | null
  defaultUnitCost?: number | null
  isActive: boolean
  onHandTotal?: number
}

export function lineFromServer(l: RecipeIngredientLine): EditLine {
  return {
    ingredientId: l.ingredientId,
    name: l.name,
    unit: l.unitAtSave,
    qty: String(l.qty),
    costAtSave: l.costAtSave,
    defaultUnitCost: l.defaultUnitCost,
    isActive: l.isActive,
    onHandTotal: l.onHandTotal,
  }
}

interface UseRecipeArgs { productId: string; variantId: string }

export function useRecipe({ productId, variantId }: UseRecipeArgs) {
  const [recipe, setRecipe] = useState<Recipe | null>(null)
  const [versions, setVersions] = useState<RecipeVersionSummary[]>([])
  const [viewingVersionId, setViewingVersionId] = useState<string | null>(null) // null = current
  const [lines, setLines] = useState<EditLine[]>([])
  const [notes, setNotes] = useState('')
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  const loadCurrent = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const [rec, vers] = await Promise.all([
        api.getVariantRecipe(productId, variantId),
        api.listRecipeVersions(productId, variantId),
      ])
      setRecipe(rec)
      setVersions(vers)
      setViewingVersionId(null)
      setLines((rec?.items ?? []).map(lineFromServer))
      setNotes('')
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Gagal memuat resep.')
    } finally {
      setLoading(false)
    }
  }, [productId, variantId])

  useEffect(() => { void loadCurrent() }, [loadCurrent])

  const viewVersion = useCallback(async (versionId: string) => {
    setLoading(true)
    try {
      const v = await api.getRecipeVersion(productId, variantId, versionId)
      setViewingVersionId(versionId)
      setLines(v.items.map(lineFromServer))
      setNotes(v.notes ?? '')
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Gagal memuat versi.')
    } finally {
      setLoading(false)
    }
  }, [productId, variantId])

  const save = useCallback(async (): Promise<boolean> => {
    setErr(null)
    for (const l of lines) {
      const n = Number(l.qty)
      if (!l.qty.trim() || Number.isNaN(n) || n <= 0) {
        setErr(`Jumlah untuk "${l.name}" harus lebih dari 0.`)
        return false
      }
    }
    try {
      await api.saveVariantRecipe(productId, variantId, {
        expectedCurrentVersionId: recipe?.currentVersionId ?? undefined,
        notes: notes.trim() || undefined,
        items: lines.map((l, i) => ({ ingredientId: l.ingredientId, qty: Number(l.qty), sortOrder: i })),
      })
      await loadCurrent()
      return true
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setErr('Resep sudah diubah orang lain. Memuat ulang…')
        await loadCurrent()
        return false
      }
      setErr(e instanceof Error ? e.message : 'Gagal menyimpan resep.')
      return false
    }
  }, [lines, notes, productId, variantId, recipe, loadCurrent])

  const restore = useCallback(async (versionId: string): Promise<void> => {
    setErr(null)
    try {
      await api.restoreRecipeVersion(productId, variantId, versionId, recipe?.currentVersionId ?? null)
      await loadCurrent()
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setErr('Resep sudah diubah orang lain. Memuat ulang…')
        await loadCurrent()
        return
      }
      setErr(e instanceof Error ? e.message : 'Gagal memulihkan versi.')
    }
  }, [productId, variantId, recipe, loadCurrent])

  const isViewingHistory = viewingVersionId !== null
  return {
    recipe, versions, lines, setLines, notes, setNotes, loading, err, setErr,
    isViewingHistory, viewingVersionId, viewVersion, loadCurrent, save, restore,
  }
}
```

- [ ] **Step 2: Typecheck.** `corepack pnpm --filter @mandalika/backoffice exec tsc --noEmit` → clean.

- [ ] **Step 3: Commit.**

```bash
git add apps/backoffice/src/screens/recipes/useRecipe.ts
git commit -m "feat(recipe): SP-Recipe-2 useRecipe hook (load/view/save/restore + optimistic 409)"
```

---

### Task D2: Ingredient picker (autocomplete add-row)

**Files:** Create `apps/backoffice/src/screens/recipes/RecipeIngredientPicker.tsx`

- [ ] **Step 1: Write the component.** Searches ACTIVE ingredients by name/SKU (the API already filters list order; we filter active client-side), optional Kategori filter, and calls `onPick` with the chosen ingredient. Excludes ingredients already on the recipe.

```tsx
import { useEffect, useMemo, useState } from 'react'
import type { Ingredient, IngredientCategory } from '@mandalika/api'
import { api } from '../../api'
import { fieldClass } from '../../ui'

interface Props {
  excludeIds: string[]
  onPick: (ing: Ingredient) => void
}

export function RecipeIngredientPicker({ excludeIds, onPick }: Props) {
  const [all, setAll] = useState<Ingredient[]>([])
  const [cats, setCats] = useState<IngredientCategory[]>([])
  const [q, setQ] = useState('')
  const [cat, setCat] = useState('')
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let alive = true
    api.listIngredients({ limit: 200 }).then((r) => { if (alive) setAll(r.data) }).catch(() => {})
    api.listIngredientCategories().then((c) => { if (alive) setCats(c) }).catch(() => {})
    return () => { alive = false }
  }, [])

  const results = useMemo(() => {
    const term = q.trim().toLowerCase()
    return all.filter((i) =>
      i.isActive &&
      !excludeIds.includes(i.id) &&
      (cat === '' || i.categoryId === cat) &&
      (term === '' || i.name.toLowerCase().includes(term) || (i.sku ?? '').toLowerCase().includes(term)),
    ).slice(0, 8)
  }, [all, q, cat, excludeIds])

  return (
    <div className="relative">
      <div className="flex gap-2">
        <input
          className={`${fieldClass} flex-1`}
          placeholder="+ Tambah bahan (cari nama / SKU)"
          value={q}
          onChange={(e) => { setQ(e.target.value); setOpen(true) }}
          onFocus={() => setOpen(true)}
        />
        <select className={`${fieldClass} w-32`} value={cat} onChange={(e) => setCat(e.target.value)}>
          <option value="">Semua</option>
          {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>
      {open && results.length > 0 && (
        <div className="absolute z-10 mt-1 w-full bg-white border border-gray-200 rounded-xl shadow-lg max-h-56 overflow-auto">
          {results.map((i) => (
            <button
              key={i.id}
              type="button"
              onClick={() => { onPick(i); setQ(''); setOpen(false) }}
              className="w-full text-left px-3 py-2 text-sm hover:bg-gold-50 flex justify-between"
            >
              <span className="font-medium text-gray-800">{i.name}</span>
              <span className="text-gray-400 text-xs">{i.sku || ''} · {i.unit}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Typecheck + commit.**

```bash
corepack pnpm --filter @mandalika/backoffice exec tsc --noEmit
git add apps/backoffice/src/screens/recipes/RecipeIngredientPicker.tsx
git commit -m "feat(recipe): SP-Recipe-2 ingredient picker (active-only autocomplete + kategori)"
```

---

### Task D3: Version history dropdown

**Files:** Create `apps/backoffice/src/screens/recipes/VersionHistoryDropdown.tsx`

- [ ] **Step 1: Write the component.** The header pill; clicking toggles an inline list of versions. Selecting a row views it; the current row is marked "(kini)".

```tsx
import { useState } from 'react'
import type { RecipeVersionSummary } from '@mandalika/api'
import { ChevronDown } from 'lucide-react'

interface Props {
  versions: RecipeVersionSummary[]
  currentVersionId: string | null
  viewingVersionId: string | null
  onSelect: (versionId: string) => void
  onBackToCurrent: () => void
}

function fmtDate(iso: string): string {
  try { return new Date(iso).toLocaleDateString('id-ID', { day: 'numeric', month: 'short' }) } catch { return iso }
}

export function VersionHistoryDropdown({ versions, currentVersionId, viewingVersionId, onSelect, onBackToCurrent }: Props) {
  const [open, setOpen] = useState(false)
  const activeId = viewingVersionId ?? currentVersionId
  const activeNo = versions.find((v) => v.id === activeId)?.versionNo ?? 0
  const isCurrent = viewingVersionId === null

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 bg-amber-50 border border-amber-200 text-amber-700 rounded-full px-3 py-1.5 text-xs font-bold"
      >
        {versions.length === 0 ? 'Belum ada versi' : `Versi ${activeNo}${isCurrent ? ' (kini)' : ''}`}
        <ChevronDown className="w-3 h-3" />
      </button>
      {open && versions.length > 0 && (
        <div className="absolute z-20 mt-1 w-64 bg-white border border-gray-200 rounded-xl shadow-lg overflow-hidden">
          {versions.map((v) => (
            <button
              key={v.id}
              type="button"
              onClick={() => {
                setOpen(false)
                if (v.id === currentVersionId) onBackToCurrent()
                else onSelect(v.id)
              }}
              className={`w-full text-left px-3 py-2 text-xs border-b border-gray-50 last:border-0 hover:bg-gray-50 ${v.id === activeId ? 'bg-amber-50' : ''}`}
            >
              <div className="font-bold text-gray-800">
                Versi {v.versionNo}{v.id === currentVersionId ? ' (kini)' : ''}
              </div>
              <div className="text-gray-400">{fmtDate(v.createdAt)} · {v.createdByName ?? '—'}</div>
              {v.notes && <div className="text-gray-500 truncate">{v.notes}</div>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Typecheck + commit.**

```bash
corepack pnpm --filter @mandalika/backoffice exec tsc --noEmit
git add apps/backoffice/src/screens/recipes/VersionHistoryDropdown.tsx
git commit -m "feat(recipe): SP-Recipe-2 version history dropdown"
```

---

### Task D4: Recipe slide-over panel

**Files:** Create `apps/backoffice/src/screens/recipes/RecipeSlideOver.tsx`

- [ ] **Step 1: Write the panel.** A fixed right-side overlay (sits above the product modal). Wires the hook + picker + version dropdown; footer shows the live cost estimate, notes field, and save. Read-only when viewing history, with Pulihkan / Kembali.

```tsx
import { X } from 'lucide-react'
import { Button } from '../../ui'
import { useRecipe, type EditLine } from './useRecipe'
import { RecipeIngredientPicker } from './RecipeIngredientPicker'
import { VersionHistoryDropdown } from './VersionHistoryDropdown'

interface Props {
  productId: string
  variantId: string
  variantLabel: string // e.g. "Parfum Aurora — 50ml"
  onClose: () => void
}

const idr = (n: number) => n.toLocaleString('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 })

export function RecipeSlideOver({ productId, variantId, variantLabel, onClose }: Props) {
  const r = useRecipe({ productId, variantId })
  const readOnly = r.isViewingHistory

  const costEstimate = (() => {
    let total = 0
    for (const l of r.lines) {
      if (l.defaultUnitCost == null) return null
      const q = Number(l.qty)
      if (Number.isNaN(q)) return null
      total += q * l.defaultUnitCost
    }
    return total
  })()

  const setQty = (idx: number, qty: string) =>
    r.setLines((ls) => ls.map((l, i) => (i === idx ? { ...l, qty } : l)))
  const removeLine = (idx: number) =>
    r.setLines((ls) => ls.filter((_, i) => i !== idx))
  const addLine = (ing: { id: string; name: string; unit: string; defaultUnitCost?: number | null; isActive: boolean }) =>
    r.setLines((ls) => [...ls, {
      ingredientId: ing.id, name: ing.name, unit: ing.unit, qty: '',
      defaultUnitCost: ing.defaultUnitCost ?? null, isActive: ing.isActive,
    } as EditLine])

  return (
    <div className="fixed inset-0 z-[60] flex justify-end" role="dialog" aria-label="Editor resep">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative w-full max-w-md bg-white h-full shadow-2xl flex flex-col">
        {/* header */}
        <div className="px-5 py-4 border-b border-gray-100">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-[10px] font-black tracking-widest text-gray-400 uppercase">Resep</div>
              <div className="font-black text-gray-900">{variantLabel}</div>
            </div>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-700"><X className="w-5 h-5" /></button>
          </div>
          <div className="mt-3">
            <VersionHistoryDropdown
              versions={r.versions}
              currentVersionId={r.recipe?.currentVersionId ?? null}
              viewingVersionId={r.viewingVersionId}
              onSelect={(id) => void r.viewVersion(id)}
              onBackToCurrent={() => void r.loadCurrent()}
            />
          </div>
        </div>

        {/* body */}
        <div className="flex-1 overflow-auto px-5 py-4 space-y-3">
          {readOnly && (
            <div className="flex items-center justify-between bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-700">
              <span>Versi {r.versions.find((v) => v.id === r.viewingVersionId)?.versionNo} — hanya-baca</span>
              <div className="flex gap-2">
                <button className="font-bold underline" onClick={() => r.viewingVersionId && void r.restore(r.viewingVersionId)}>Pulihkan ke versi ini</button>
                <button className="text-amber-600" onClick={() => void r.loadCurrent()}>Kembali ke versi kini</button>
              </div>
            </div>
          )}
          {r.loading ? (
            <p className="text-sm text-gray-400">Memuat…</p>
          ) : (
            <>
              {r.lines.length === 0 && <p className="text-sm text-gray-400">Belum ada bahan.</p>}
              {r.lines.map((l, i) => {
                const lowStock = l.onHandTotal != null && Number(l.qty) > l.onHandTotal
                return (
                  <div key={l.ingredientId} className="grid grid-cols-12 gap-2 items-center">
                    <div className="col-span-6 text-sm text-gray-800">
                      {l.name}
                      {!l.isActive && <span className="text-red-600 text-xs ml-1">⚠ nonaktif</span>}
                      {l.isActive && lowStock && <span className="text-red-500 text-xs ml-1">⚠ stok {l.onHandTotal}</span>}
                    </div>
                    <input
                      type="number" inputMode="decimal" value={l.qty} disabled={readOnly}
                      onChange={(e) => setQty(i, e.target.value)}
                      className="col-span-3 border border-gray-200 rounded-lg px-2 py-1.5 text-sm text-right disabled:bg-gray-50"
                    />
                    <span className="col-span-2 text-xs text-gray-500">{l.unit}</span>
                    {!readOnly && (
                      <button className="col-span-1 text-gray-300 hover:text-red-500" onClick={() => removeLine(i)}><X className="w-4 h-4" /></button>
                    )}
                  </div>
                )
              })}
              {!readOnly && (
                <RecipeIngredientPicker excludeIds={r.lines.map((l) => l.ingredientId)} onPick={addLine} />
              )}
            </>
          )}
          {r.err && <p className="text-sm text-red-600">{r.err}</p>}
        </div>

        {/* footer */}
        {!readOnly && (
          <div className="border-t border-gray-100 px-5 py-4 bg-gray-50 space-y-3">
            {costEstimate != null && (
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">Estimasi biaya bahan</span>
                <span className="font-black text-gray-900">{idr(costEstimate)}</span>
              </div>
            )}
            <textarea
              value={r.notes} onChange={(e) => r.setNotes(e.target.value)} rows={2}
              placeholder="Catatan versi…"
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
            />
            <Button className="w-full" onClick={() => void r.save()}>Simpan versi baru</Button>
          </div>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Typecheck + commit.**

```bash
corepack pnpm --filter @mandalika/backoffice exec tsc --noEmit
git add apps/backoffice/src/screens/recipes/RecipeSlideOver.tsx
git commit -m "feat(recipe): SP-Recipe-2 slide-over editor panel"
```

---

### Task D5: Wire the Resep button into the product modal

**Files:** Modify `apps/backoffice/src/screens/Products.tsx`

- [ ] **Step 1: Add imports + state.** Near the top imports add the slide-over and a flask icon:

```tsx
import { FlaskConical } from 'lucide-react'
import { RecipeSlideOver } from './recipes/RecipeSlideOver'
```

Inside the component, add state for the recipes flag and the open recipe target:

```tsx
  const [recipesEnabled, setRecipesEnabled] = useState(false)
  const [recipeFor, setRecipeFor] = useState<{ variantId: string; label: string } | null>(null)
```

Fetch the flag on mount (mirror the Bahan-tab gate):

```tsx
  useEffect(() => {
    let alive = true
    api.getAppSettings().then((s) => { if (alive) setRecipesEnabled(!!s.recipesEnabled) }).catch(() => {})
    return () => { alive = false }
  }, [])
```

> Confirm `api.getAppSettings()` exists and exposes `recipesEnabled` (it was added in SP-Recipe-1). If the method name differs, match the call used by the Bahan tab / SettingsScreen.

- [ ] **Step 2: Add a Resep button to each variant row.** The variant grid is at `Products.tsx` ~lines 660-679 and is `grid-cols-12` (`col-span-3` size / `col-span-3` price / `col-span-3` sku / `col-span-2` barcode / `col-span-1` remove = 12). To keep the grid at 12 columns regardless of the flag, **replace the existing standalone remove `<button>` (the final element in each variant row) with a single `col-span-1` cell that holds both the Resep button and the remove button**:

```tsx
                  <div className="col-span-1 flex items-center justify-center gap-1">
                    {recipesEnabled && (
                      <button type="button" title={v.id ? 'Edit resep' : 'Simpan produk dulu'} disabled={!v.id}
                        onClick={() => v.id && setRecipeFor({ variantId: v.id, label: `${form.name || 'Produk'} — ${v.size}` })}
                        className="text-gray-400 hover:text-gold-600 disabled:opacity-30">
                        <FlaskConical className="w-4 h-4" />
                      </button>
                    )}
                    <button onClick={() => setForm((f) => ({ ...f, variants: f.variants.filter((_, x) => x !== i) }))}
                      disabled={form.variants.length === 1} className="text-gray-300 hover:text-red-500 disabled:opacity-0">
                      <X className="w-4 h-4" />
                    </button>
                  </div>
```
Use this single-cell wrapper (replaces the existing standalone remove `<button>`), so the grid stays 12 columns regardless of the flag.

- [ ] **Step 3: Mount the slide-over** just before the closing `</div>` of the component's return (after the delete-confirm Modal):

```tsx
      {recipeFor && (
        <RecipeSlideOver
          productId={editing?.id ?? ''}
          variantId={recipeFor.variantId}
          variantLabel={recipeFor.label}
          onClose={() => setRecipeFor(null)}
        />
      )}
```

> `editing?.id` is the product id (recipes only open for saved variants, which only exist when editing an existing product, so `editing` is always set here). Flag if `editing` can ever be null when a variant has an id.

- [ ] **Step 4: Typecheck.** `corepack pnpm --filter @mandalika/backoffice exec tsc --noEmit` → clean.

- [ ] **Step 5: Commit.**

```bash
git add apps/backoffice/src/screens/Products.tsx
git commit -m "feat(recipe): SP-Recipe-2 Resep button per saved variant + slide-over mount (flag-gated)"
```

---

## PHASE E — Verify, polish, push

### Task E1: Local build + Playwright UI smoke

- [ ] **Step 1: Full backoffice typecheck + build.**

```bash
corepack pnpm --filter @mandalika/backoffice exec tsc --noEmit
corepack pnpm --filter @mandalika/backoffice build
```
Expected: both clean.

- [ ] **Step 2: Playwright smoke against the live backoffice** (`https://mandalika-pos.pages.dev`, admin login). Drive: Produk → edit a product → click the flask on a saved variant → slide-over opens → add an ingredient via the picker → set qty → "Simpan versi baru" → reopen → confirm the version pill shows "Versi N (kini)" and the line persisted → open the version dropdown → select an older version (read-only banner) → "Pulihkan ke versi ini" → confirm a new current version. Capture screenshots at: slide-over open, after save, version dropdown open, after restore.

> Use the playwright MCP tools. If the picker dropdown is flaky to target, assert on the persisted line text after reload rather than on the transient dropdown.

- [ ] **Step 3: Record results.** Note any console errors. **If the golden path fails, fix before pushing — do not claim success (working rule 4).**

- [ ] **Step 4: Push.**

```bash
git push origin prod-hardening
```
Backoffice auto-deploys via Cloudflare from `prod-hardening`.

- [ ] **Step 5: Hand back to the user** for their own hands-on test (they flagged they'll test before finalizing). Summarize what shipped, the live URLs, and the test artifacts left in the DB.

---

## Self-review notes (gaps flagged for the executor)

- **Resep button filled/● indicator** (mockup showed it) is **dropped for MVP** — there's no bulk "which variants have recipes" endpoint (deferred in the spec). The button looks the same whether or not a recipe exists; existence is discovered on open. Revisit if the user wants the indicator.
- **Stock hint on freshly-added lines:** `onHandTotal` is only present on lines loaded from the server. A line added via the picker shows no low-stock ⚠ until the version is saved and reloaded (the picker's `listIngredients` doesn't carry per-ingredient stock). Inactive ingredients never appear in the picker, so the only ⚠ that can't show pre-save is low-stock on a new line. Acceptable for MVP; flagged.
- **Restore allows inactive ingredients** from the snapshot (it bypasses the newly-added-inactive guard) — restoring a known historical formula shouldn't be blocked. The ⚠ badge still shows. This is a deliberate refinement of decision 5; confirm with the user if undesired.
- **`getAppSettings`/`recipesEnabled` method name** in the TS client must be confirmed against SP-Recipe-1 (Step D5.1).
- **`data<T>` POST unwrap** must be confirmed against existing impls (Step C1.2).
- The user intends a hands-on test before finalizing — expect refinements after E1.
```
