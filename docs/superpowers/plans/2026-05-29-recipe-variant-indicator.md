# Recipe Variant Indicator (gold tint) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **The 6 working rules (user-required, apply to every task):** 1) Ask, don't assume. 2) Don't touch unrelated code. 3) Flag uncertainty. 4) Verify on failure (never fake success). 5) Show changes (diffs). 6) Admit gaps.

**Goal:** In the backoffice product edit modal, gold-tint the Resep flask on variant rows that already have a recipe, so you can tell at a glance which variants have one.

**Architecture:** A new read-only endpoint returns the variant ids (under a product) that have a `recipes` row. The Products modal fetches it on open and tints each flask accordingly. No schema change; backoffice + one small backend endpoint.

**Tech Stack:** Go (chi, pgx v5, oapi-codegen) + Postgres; TypeScript React backoffice; generated `@mandalika/api`.

**Spec:** `docs/superpowers/specs/2026-05-29-recipe-variant-indicator-design.md`

**Conventions (verified, same as SP-Recipe-2 plan):** codegen `cd backend && make gen-go && make gen-ts`; CI gate `make gen-check` (commit regenerated `api.gen.go`); `gofmt -w internal/` before committing Go; commit hook rejects chained `git commit && …` (run `git commit` on its own line, no `--no-verify`); typecheck `corepack pnpm --filter @mandalika/backoffice exec tsc --noEmit`; deploy `gcloud run deploy mandalika-pos --source backend --region asia-southeast2 --quiet` (Bash `dangerouslyDisableSandbox:true`), verify `GET /readyz`; backoffice auto-deploys on push to `prod-hardening`. **No APK.** Recipe routes live in the `RequireRecipesEnabled` group inside `manage_inventory` in `server.go`. The recipes flag is currently ON in the test deployment.

---

## Task 1: OpenAPI — recipe-variant-ids path + schema

**Files:** Modify `backend/api/openapi.yaml`; regen `api.gen.go` + `schema.d.ts`.

- [ ] **Step 1: Add schema** (after the `RecipeVersionListResponse` schema):

```yaml
    RecipeVariantIdsResponse:
      type: object
      required: [variantIds]
      properties:
        variantIds:
          type: array
          items: { type: string, format: uuid }
```

- [ ] **Step 2: Add path** (after the existing `/api/v1/products/{productId}/variants/{variantId}/recipe/versions/{versionId}/restore` path):

```yaml
  /api/v1/products/{productId}/recipe-variant-ids:
    get:
      operationId: getRecipeVariantIds
      tags: [catalog]
      summary: Variant ids under a product that have a recipe
      parameters:
        - { name: productId, in: path, required: true, schema: { type: string, format: uuid } }
      responses:
        '200':
          description: variant ids with a recipe
          content:
            application/json:
              schema: { $ref: '#/components/schemas/RecipeVariantIdsResponse' }
```

- [ ] **Step 3: Regen + build.**

```bash
cd backend && make gen-go && make gen-ts && go build ./...
```
Expected: clean; `api.RecipeVariantIdsResponse` appears in `internal/api/api.gen.go` (grep to confirm).

- [ ] **Step 4: Commit.**

```bash
git add backend/api/openapi.yaml backend/internal/api/api.gen.go packages/api/src/schema.d.ts
git commit -m "feat(recipe): openapi — recipe-variant-ids path + schema"
```

---

## Task 2: Read method + handler + route

**Files:** Modify `backend/internal/read/repo.go`, `backend/internal/handlers/writes.go`, `backend/internal/server/server.go`

- [ ] **Step 1: Add the read method** in `read/repo.go` near the other recipe read methods (`VariantRecipe`/`RecipeVersions`). It returns a plain `[]string` (not jsonb), so scan directly:

```go
// RecipeVariantIDs returns the ids of variants under a product that have a recipe.
func (r *Repo) RecipeVariantIDs(ctx context.Context, productID string) ([]string, error) {
	rows, err := r.Pool.Query(ctx,
		`SELECT r.variant_id::text
		   FROM recipes r
		   JOIN product_variants v ON v.id = r.variant_id
		  WHERE v.product_id = $1`, productID)
	if err != nil {
		return nil, fmt.Errorf("recipe variant ids: %w", err)
	}
	defer rows.Close()
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("scan recipe variant id: %w", err)
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}
```
(`fmt` and `context` are already imported in `read/repo.go`.)

- [ ] **Step 2: Add the handler** in `handlers/writes.go` near the recipe handlers (`VariantRecipe` etc.):

```go
func (h *Handlers) RecipeVariantIDs(w http.ResponseWriter, r *http.Request) {
	ids, err := h.Repo.RecipeVariantIDs(r.Context(), chi.URLParam(r, "productId"))
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, http.StatusOK, api.RecipeVariantIdsResponse{VariantIds: ids})
}
```

- [ ] **Step 3: Register the route** in `server.go` inside the existing `RequireRecipesEnabled` group (next to the other recipe routes):

```go
					r.Get("/products/{productId}/recipe-variant-ids", h.RecipeVariantIDs)
```

- [ ] **Step 4: Build.** `cd backend && gofmt -w internal/ && go build ./...` → green.

- [ ] **Step 5: Commit.**

```bash
git add backend/internal/read/repo.go backend/internal/handlers/writes.go backend/internal/server/server.go
git commit -m "feat(recipe): recipe-variant-ids read method + handler + route"
```

---

## Task 3: TS client method

**Files:** Modify `packages/api/src/client.ts`

- [ ] **Step 1: Add to the `Api` interface** (near `getVariantRecipe`). `RecipeVariantIdsResponse` is generated — alias it at the top like the other recipe types, or return the inner array:

```ts
  getRecipeVariantIds: (productId: string) => Promise<string[]>
```

- [ ] **Step 2: Add the impl** (near the recipe impls):

```ts
    getRecipeVariantIds: (productId) =>
      data<{ variantIds: string[] }>('GET', `${API}/products/${productId}/recipe-variant-ids`).then((r) => r.variantIds),
```
**Verify** `data<T>('GET', …)` unwraps the `{data}` envelope (it does — used by the other recipe getters). The endpoint returns `{"data":{"variantIds":[...]}}`, so `data<{variantIds}>` yields `{variantIds}`; `.then(r => r.variantIds)` returns the array.

- [ ] **Step 3: Typecheck + commit.**

```bash
corepack pnpm --filter @mandalika/backoffice exec tsc --noEmit
git add packages/api/src/client.ts
git commit -m "feat(recipe): api client getRecipeVariantIds"
```

---

## Task 4: Products.tsx — fetch set + gold-tint the flask

**Files:** Modify `apps/backoffice/src/screens/Products.tsx`

- [ ] **Step 1: Add state** near the existing `recipesEnabled` / `recipeFor` state (around line 88):

```tsx
  const [recipeVariantIds, setRecipeVariantIds] = useState<Set<string>>(new Set())
```

- [ ] **Step 2: Fetch on modal open.** In `openEdit(p)` (the existing function that opens the edit modal for product `p`), after it sets up the form, fetch the set when the flag is on. Add:

```tsx
    if (recipesEnabled) {
      api.getRecipeVariantIds(p.id)
        .then((ids) => setRecipeVariantIds(new Set(ids)))
        .catch(() => setRecipeVariantIds(new Set()))
    } else {
      setRecipeVariantIds(new Set())
    }
```
(If `openEdit` is async and already has a try/block fetching base/config, place this alongside; it must run for the product being edited. `recipesEnabled` is already fetched on mount.)

- [ ] **Step 3: Tint the flask.** Find the Resep button in the variant row (the `recipesEnabled && (<button … FlaskConical …>)` added in SP-Recipe-2, ~line 689). Replace its `className` and `title` so a variant with a recipe is gold-tinted:

```tsx
                      <button type="button"
                        title={!v.id ? 'Simpan produk dulu' : (recipeVariantIds.has(v.id) ? 'Resep tersedia' : 'Belum ada resep')}
                        disabled={!v.id}
                        onClick={() => v.id && setRecipeFor({ variantId: v.id, label: `${form.name || 'Produk'} — ${v.size}` })}
                        className={`${v.id && recipeVariantIds.has(v.id) ? 'text-gold-600 bg-gold-50 rounded' : 'text-gray-400'} hover:text-gold-600 disabled:opacity-30`}>
                        <FlaskConical className="w-4 h-4" />
                      </button>
```
Keep the surrounding single-cell wrapper + the remove button unchanged.

- [ ] **Step 4: Refresh after a recipe is saved.** The slide-over is mounted as `{recipeFor && <RecipeSlideOver … onClose={() => setRecipeFor(null)} />}`. Change `onClose` so closing the slide-over re-fetches the set (a recipe may have been created), keeping `editing` as the product id:

```tsx
          onClose={() => {
            setRecipeFor(null)
            if (editing?.id && recipesEnabled) {
              api.getRecipeVariantIds(editing.id)
                .then((ids) => setRecipeVariantIds(new Set(ids)))
                .catch(() => {})
            }
          }}
```

- [ ] **Step 5: Typecheck + commit.**

```bash
corepack pnpm --filter @mandalika/backoffice exec tsc --noEmit
git add apps/backoffice/src/screens/Products.tsx
git commit -m "feat(recipe): gold-tint Resep flask for variants that have a recipe"
```

---

## Task 5: Deploy + verify + push

- [ ] **Step 1: Deploy backend.** `gcloud run deploy mandalika-pos --source backend --region asia-southeast2 --quiet`; verify `/readyz` 200.

- [ ] **Step 2: Live-verify the endpoint.** Auth as admin (login → `data.access`; recipes flag is ON). Pick a product with a variant that has a recipe (e.g. from earlier SP-Recipe-2 testing) and one without:

```bash
BASE=https://mandalika-pos-538849926142.asia-southeast2.run.app
# TOKEN via login (data.access)
curl -s "$BASE/api/v1/products/<PRODUCT_ID>/recipe-variant-ids" -H "authorization: Bearer $TOKEN"
```
Expected: `{"data":{"variantIds":["<variant-with-recipe>"]}}` — contains the variant(s) with a recipe, excludes those without. Flag-off → 404.

- [ ] **Step 3: Push** (backoffice auto-deploys).

```bash
git push origin prod-hardening
```

- [ ] **Step 4: User-pending visual check.** After Cloudflare deploys: open a product with mixed variants → confirm the flask is gold-tinted only on variants that have a recipe, neutral otherwise, and that creating a recipe then closing the slide-over tints that variant. (Agent can't self-auth the UI; surface this for the user.)
