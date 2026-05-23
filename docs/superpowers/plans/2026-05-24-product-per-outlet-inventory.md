# Product Phase 1 — Per-Outlet Inventory & Pricing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. **Update the checkboxes in this file as you go and commit them** — this file is the durable resume point if the session is compacted or restarted.

**Goal:** Give every outlet its own stock, optional price overrides, and per-outlet availability — without breaking the live order path or offline POS sync.

**Architecture:** Three additive tables keyed on `(outlet_id, product_id, variant_size)` (the natural key the order path, `order_items`, and `stock_count_items` already use). `product_variants.price` stays as the base/default; per-outlet rows are overrides only. The backend resolves outlet-scoped stock/price into reads and the sync bundle, so the POS app is unchanged. Order/refund/stock-count writes move to the per-outlet stock table. Backoffice gets a per-outlet management UI.

**Tech Stack:** Go 1.26 (pgx v5, chi, oapi-codegen strict server), Postgres (Neon), React 19 + Vite + Tailwind v4 (backoffice), `@mandalika/api` generated TS client.

**Spec:** `docs/superpowers/specs/2026-05-23-product-per-outlet-inventory-design.md`

**Testing reality (approved):** No DB test harness; CI runs `go test ./... -race` with NO Postgres. So: pure-logic unit tests only; DB paths verified by deploy + manual checks. Never add a `_test.go` that needs a live DB unless it self-skips on missing `DATABASE_URL`. CI gates that MUST stay green: `make gen-check` (commit regenerated `api.gen.go`), `go vet ./...`, `gofmt -l` (empty), `go build ./...`, `go test ./... -race`.

**Operating rules (user):** Ask don't assume; don't touch unrelated files; flag uncertainty; on failure show real output + verify before claiming fixed; show changes; admit gaps.

---

## Rollout shape
- **Deploy 1 = backend** (Tasks 1–7): migration auto-applies on boot; verify the order path still sells before touching UI.
- **Deploy 2 = backoffice** (Tasks 8–12): Cloudflare auto-deploys on push.
- **POS APK:** not required (server-resolved snapshot). Only rebuild if Task 7 verification shows a client gap.

## File map
- Create: `backend/internal/db/migrations/0010_per_outlet_inventory.sql`
- Modify: `backend/internal/read/repo.go` (productObj + `Products`/`Product` take `Scope`)
- Modify: `backend/internal/handlers/handlers.go` (`Products`/`Product` pass `scope(r)`)
- Modify: `backend/internal/sync/sync.go` (`Pull` passes cashier outlet scope)
- Modify: `backend/internal/service/order.go` (decrement + `Refund` → per-outlet stock)
- Modify: `backend/internal/write/stockcount.go` (`CompleteStockCount` → per-outlet stock)
- Modify: `backend/internal/write/repo.go` (seed per-outlet stock on create; outlet-config write; outlet-scoped bump helper)
- Modify: `backend/internal/read/repo.go` (outlet-config read)
- Modify: `backend/api/openapi.yaml` (+ regen `internal/api/api.gen.go`)
- Modify: `backend/internal/server/server.go` (routes for outlet-config)
- Modify: `backend/internal/handlers/products.go` or `writes.go` (outlet-config handlers) — read current to place them
- Modify: `packages/api/src/client.ts` (+ regen `schema.d.ts`)
- Modify: `apps/backoffice/src/screens/Products.tsx` (per-outlet edit table; create seeding)

---

## Task 1: Migration — tables + backfill

**Files:** Create `backend/internal/db/migrations/0010_per_outlet_inventory.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 0010: per-outlet inventory & pricing. product_variants.stock/.price stay as
-- legacy mirror / base default; these tables are the per-outlet source of truth.
-- Natural key (outlet_id, product_id, variant_size) matches order_items and the
-- order stock-decrement path so nothing orphans when variants are re-inserted.

CREATE TABLE IF NOT EXISTS outlet_variant_stock (
  outlet_id    uuid NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
  product_id   uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  variant_size text NOT NULL,
  stock        integer NOT NULL DEFAULT 0,
  par_level    integer,
  PRIMARY KEY (outlet_id, product_id, variant_size)
);

CREATE TABLE IF NOT EXISTS outlet_variant_price (
  outlet_id    uuid NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
  product_id   uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  variant_size text NOT NULL,
  price        numeric(14,2) NOT NULL,
  PRIMARY KEY (outlet_id, product_id, variant_size)
);

CREATE TABLE IF NOT EXISTS outlet_product_availability (
  outlet_id  uuid NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  available  boolean NOT NULL DEFAULT true,
  PRIMARY KEY (outlet_id, product_id)
);

-- Backfill current global stock into the PRIMARY outlet (most completed orders,
-- tie-break oldest active outlet). Other outlets start at 0; no price overrides;
-- everything available. Idempotent via ON CONFLICT (re-run safe).
WITH primary_outlet AS (
  SELECT o.id
  FROM outlets o
  LEFT JOIN (
    SELECT outlet_id, count(*) AS n FROM orders
    WHERE status = 'completed' GROUP BY outlet_id
  ) oc ON oc.outlet_id = o.id
  WHERE o.is_active
  ORDER BY COALESCE(oc.n, 0) DESC, o.created_at ASC
  LIMIT 1
)
INSERT INTO outlet_variant_stock (outlet_id, product_id, variant_size, stock)
SELECT (SELECT id FROM primary_outlet), v.product_id, v.size, v.stock
FROM product_variants v
WHERE (SELECT id FROM primary_outlet) IS NOT NULL
ON CONFLICT (outlet_id, product_id, variant_size) DO NOTHING;
```

- [ ] **Step 2: Confirm the resolved primary outlet with the user BEFORE deploy.** Per Rule 1, do not assume. Run this read-only query against the deployed DB (or ask the user to confirm the outlet name) and report it:

```sql
SELECT o.id, o.name, COALESCE(oc.n,0) AS completed_orders
FROM outlets o
LEFT JOIN (SELECT outlet_id, count(*) n FROM orders WHERE status='completed' GROUP BY outlet_id) oc
  ON oc.outlet_id=o.id
WHERE o.is_active
ORDER BY COALESCE(oc.n,0) DESC, o.created_at ASC;
```
Expected: the top row is the intended main outlet (e.g. "Mandalika"). If it isn't, stop and adjust the migration to target the named outlet.

- [ ] **Step 3: Commit** (migration applies on next backend boot; do not deploy yet)

```bash
git add backend/internal/db/migrations/0010_per_outlet_inventory.sql
git commit -m "feat(backend): migration 0010 per-outlet inventory tables + backfill"
```

---

## Task 2: Read layer — scope-aware product resolution

**Files:** Modify `backend/internal/read/repo.go` (`productObj` const :87-94, `Products` :96-101, `Product` :103-106); `backend/internal/handlers/handlers.go` (`Products` :135-144, `Product` :146-154)

- [ ] **Step 1: Replace the `productObj` const with a scope-aware builder.** `productObj` is a plain const string today. Replace it with a function that takes the scope and returns SQL + arg. Resolution: scoped outlet ⇒ `stock=COALESCE(ovs.stock,0)`, `price=COALESCE(ovp.price, v.price)`, drop products unavailable at that outlet; CrossAll ⇒ `stock=SUM(ovs.stock)`, base price, all products.

```go
// productObjScoped builds the product JSON with per-outlet stock/price resolved.
// When sc.OutletID != "" the variant stock/price resolve to that outlet (0 / base
// when no row) and unavailable products are excluded by the caller's WHERE. When
// sc.CrossAll, stock is summed across outlets and base price is used.
func productObjScoped(sc Scope) string {
	if sc.CrossAll || sc.OutletID == "" {
		return `json_build_object(
		  'id',p.id,'name',p.name,'brand',p.brand,'categoryId',p.category_id,
		  'description',p.description,'imageUrl',p.image_url,
		  'isFeatured',p.is_featured,'isFavourite',p.is_favourite,'isActive',p.is_active,
		  'createdAt',p.created_at,
		  'variants',COALESCE((SELECT json_agg(json_build_object(
		     'size',v.size,'price',v.price,
		     'stock',COALESCE((SELECT SUM(s.stock)::int FROM outlet_variant_stock s
		        WHERE s.product_id=v.product_id AND s.variant_size=v.size),0),
		     'sku',v.sku) ORDER BY v.size)
		     FROM product_variants v WHERE v.product_id=p.id),'[]'::json))`
	}
	// outlet-scoped: $1 is the outlet id (caller passes it as the FIRST arg).
	return `json_build_object(
	  'id',p.id,'name',p.name,'brand',p.brand,'categoryId',p.category_id,
	  'description',p.description,'imageUrl',p.image_url,
	  'isFeatured',p.is_featured,'isFavourite',p.is_favourite,'isActive',p.is_active,
	  'createdAt',p.created_at,
	  'variants',COALESCE((SELECT json_agg(json_build_object(
	     'size',v.size,
	     'price',COALESCE((SELECT op.price FROM outlet_variant_price op
	        WHERE op.outlet_id=$1 AND op.product_id=v.product_id AND op.variant_size=v.size), v.price),
	     'stock',COALESCE((SELECT os.stock FROM outlet_variant_stock os
	        WHERE os.outlet_id=$1 AND os.product_id=v.product_id AND os.variant_size=v.size),0),
	     'sku',v.sku) ORDER BY v.size)
	     FROM product_variants v WHERE v.product_id=p.id),'[]'::json))`
}

// availabilityWhere excludes products turned off at the scoped outlet.
func availabilityWhere(sc Scope, argPos int) string {
	if sc.CrossAll || sc.OutletID == "" {
		return ""
	}
	return fmt.Sprintf(` AND NOT EXISTS (SELECT 1 FROM outlet_product_availability a
	   WHERE a.product_id=p.id AND a.outlet_id=$%d AND a.available=false)`, argPos)
}
```

- [ ] **Step 2: Update `Products` and `Product` to accept `Scope` and thread the outlet arg.** Note arg order: when scoped, `$1` = outletId (used inside productObjScoped), then paging/id args follow.

```go
func (r *Repo) Products(ctx context.Context, sc Scope, page, limit int) ([]api.Product, int, error) {
	obj := productObjScoped(sc)
	if sc.CrossAll || sc.OutletID == "" {
		return listJSON[api.Product](ctx, r.Pool,
			`SELECT `+obj+`, count(*) OVER() AS total
			   FROM products p ORDER BY p.created_at DESC LIMIT $1 OFFSET $2`,
			limit, off(page, limit))
	}
	return listJSON[api.Product](ctx, r.Pool,
		`SELECT `+obj+`, count(*) OVER() AS total
		   FROM products p WHERE true`+availabilityWhere(sc, 1)+`
		   ORDER BY p.created_at DESC LIMIT $2 OFFSET $3`,
		sc.OutletID, limit, off(page, limit))
}

func (r *Repo) Product(ctx context.Context, sc Scope, id string) (api.Product, error) {
	obj := productObjScoped(sc)
	if sc.CrossAll || sc.OutletID == "" {
		return oneJSON[api.Product](ctx, r.Pool, `SELECT `+obj+` FROM products p WHERE p.id=$1`, id)
	}
	return oneJSON[api.Product](ctx, r.Pool,
		`SELECT `+obj+` FROM products p WHERE p.id=$2`, sc.OutletID, id)
}
```

- [ ] **Step 3: Update the handlers to pass scope.** In `handlers.go`, `Products` build closure: `rows, total, err := h.Repo.Products(r.Context(), scope(r), p, l)`. `Product`: `v, err := h.Repo.Product(r.Context(), scope(r), chi.URLParam(r,"id"))`. (Cache key `ckey` already embeds the scoped outlet — no change.)

- [ ] **Step 4: Verify build + vet + fmt**

Run: `cd backend && go build ./... && go vet ./... && gofmt -l internal/read internal/handlers`
Expected: builds clean, vet clean, gofmt prints nothing.

- [ ] **Step 5: Commit**

```bash
cd .. && git add backend/internal/read/repo.go backend/internal/handlers/handlers.go
git commit -m "feat(backend): resolve product stock/price per outlet on read"
```

---

## Task 3: Sync Pull — outlet-scoped product bundle

**Files:** Modify `backend/internal/sync/sync.go` (`Pull`, ~line 68-118; the `e.Read.Products(ctx, 1, 100000)` call ~line 86)

- [ ] **Step 1: Read the current `Pull` to get the exact call + how the cashier outlet is known.** The cashier outlet is the authenticated outlet (handler passes it; confirm whether `Pull` already has an outletID param or reads it from a scope/arg). Then pass `read.Scope{OutletID: <cashierOutlet>}` into `Products`:

```go
// before: rows, _, err := e.Read.Products(ctx, 1, 100000)
rows, _, err := e.Read.Products(ctx, read.Scope{OutletID: outletID}, 1, 100000)
```
If `Pull` does not currently receive the outletID, thread it from the sync handler (the handler has `c.outletID` per writes.go callerID). Flag and wire it; do not guess the variable name — read the file.

- [ ] **Step 2: Verify build/vet/fmt** — `cd backend && go build ./... && go vet ./... && gofmt -l internal/sync`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
cd .. && git add backend/internal/sync/sync.go backend/internal/handlers
git commit -m "feat(backend): POS sync pulls outlet-resolved stock/price"
```

---

## Task 4: Order path — per-outlet decrement + refund (HIGHEST RISK)

**Files:** Modify `backend/internal/service/order.go` (decrement loop :148-173; `Refund` ~:311-317)

- [ ] **Step 1: Replace the decrement loop body** (currently SELECTs/UPDATEs `product_variants` by product_id+size). Move to `outlet_variant_stock` keyed by `in.OutletID`, upsert-then-lock so the row always exists:

```go
// Stock decrement under row lock, per outlet (outlet_variant_stock).
for _, it := range in.Items {
	// Ensure a lockable per-outlet row exists, seeded from the variant's legacy
	// stock the first time this outlet sells the variant.
	if _, e := tx.Exec(ctx, `
		INSERT INTO outlet_variant_stock (outlet_id, product_id, variant_size, stock)
		SELECT $1,$2,$3, COALESCE((SELECT pv.stock FROM product_variants pv
		   WHERE pv.product_id=$2 AND pv.size=$3),0)
		WHERE EXISTS (SELECT 1 FROM product_variants pv WHERE pv.product_id=$2 AND pv.size=$3)
		ON CONFLICT (outlet_id, product_id, variant_size) DO NOTHING`,
		in.OutletID, it.ProductID, it.VariantSize); e != nil {
		return "", false, false, fmt.Errorf("ensure stock row: %w", e)
	}
	var stock int
	e := tx.QueryRow(ctx,
		`SELECT stock FROM outlet_variant_stock
		   WHERE outlet_id=$1 AND product_id=$2 AND variant_size=$3 FOR UPDATE`,
		in.OutletID, it.ProductID, it.VariantSize).Scan(&stock)
	if errors.Is(e, pgx.ErrNoRows) {
		continue // bundle component / variant absent — skip, do not fail the sale
	}
	if e != nil {
		return "", false, false, fmt.Errorf("lock variant stock: %w", e)
	}
	next := stock - it.Quantity
	if next < 0 {
		if in.Offline {
			stockWarning = true
		} else {
			next = 0
		}
	}
	if _, e := tx.Exec(ctx,
		`UPDATE outlet_variant_stock SET stock=$1
		   WHERE outlet_id=$2 AND product_id=$3 AND variant_size=$4`,
		next, in.OutletID, it.ProductID, it.VariantSize); e != nil {
		return "", false, false, fmt.Errorf("decrement stock: %w", e)
	}
}
```
NOTE: the upsert seeds from `product_variants.stock` so an outlet that already had backfilled stock keeps it, and a not-yet-seeded outlet inherits the legacy number once (acceptable — admins set real per-outlet stock via the UI). If you prefer not-yet-seeded outlets to start at 0, change the seed `COALESCE(...,0)` subselect to `0`. **Confirm this seeding choice with the user (Rule 1).**

- [ ] **Step 2: Update `Refund`** restore to the same outlet's row. Read the exact current statement first; replace the `UPDATE product_variants SET stock=stock+$1 WHERE product_id=$2 AND size=$3` with:

```go
`INSERT INTO outlet_variant_stock (outlet_id, product_id, variant_size, stock)
   VALUES ($1,$2,$3,$4)
 ON CONFLICT (outlet_id, product_id, variant_size)
   DO UPDATE SET stock = outlet_variant_stock.stock + EXCLUDED.stock`
```
with args `(orderOutletID, productID, variantSize, qty)`. The order's outlet_id must be loaded in the refund tx (read it from the order row if not already in scope).

- [ ] **Step 3: Verify build/vet/fmt** — `cd backend && go build ./... && go vet ./... && gofmt -l internal/service`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
cd .. && git add backend/internal/service/order.go
git commit -m "feat(backend): decrement and refund stock per outlet"
```

---

## Task 5: Stock count completion → per-outlet

**Files:** Modify `backend/internal/write/stockcount.go` (`CompleteStockCount` :216-221)

- [ ] **Step 1: Replace the global stock UPDATE** (line ~217) with an upsert into the count's outlet row:

```go
if _, e := t.Exec(ctx, `
	INSERT INTO outlet_variant_stock (outlet_id, product_id, variant_size, stock)
	VALUES ($1,$2,$3,$4)
	ON CONFLICT (outlet_id, product_id, variant_size)
	  DO UPDATE SET stock = EXCLUDED.stock`,
	outletID, a.pid, a.size, a.actual); e != nil {
	return e
}
```
(`outletID` is the `CompleteStockCount` param, already validated by `scopedSC`.)

- [ ] **Step 2: Verify build/vet/fmt** — `cd backend && go build ./... && go vet ./... && gofmt -l internal/write`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
cd .. && git add backend/internal/write/stockcount.go
git commit -m "feat(backend): stock count writes per-outlet stock"
```

---

## Task 6: Outlet-config endpoints + create seeding

**Files:** `backend/api/openapi.yaml` (schemas + 2 paths), regen `backend/internal/api/api.gen.go`; `backend/internal/read/repo.go` (matrix read); `backend/internal/write/repo.go` (matrix write + outlet-scoped bump + create seeding); `backend/internal/handlers/products.go` (handlers); `backend/internal/server/server.go` (routes)

- [ ] **Step 1: Add OpenAPI schemas + paths.** Add under `components.schemas`:

```yaml
    OutletVariantConfig:
      type: object
      required: [outletId, variantSize, stock, available]
      properties:
        outletId: { type: string, format: uuid }
        variantSize: { type: string }
        stock: { type: integer }
        price: { type: number, nullable: true }   # null = use base price
        available: { type: boolean }
    OutletConfigResponse:
      type: object
      required: [data]
      properties:
        data:
          type: array
          items: { $ref: '#/components/schemas/OutletVariantConfig' }
    OutletConfigInput:
      type: object
      required: [items]
      properties:
        items:
          type: array
          items: { $ref: '#/components/schemas/OutletVariantConfig' }
```
Add paths `GET` and `PUT` `/products/{id}/outlet-config` returning/accepting the above (admin-gated like other product writes). Match the existing path style in the file.

- [ ] **Step 2: Regenerate Go + verify drift gate**

Run: `cd backend && go tool oapi-codegen -config api/oapi-codegen.yaml api/openapi.yaml && make gen-check`
Expected: `api.gen.go` regenerated; `make gen-check` passes (no diff after commit).

- [ ] **Step 3: Read repo — matrix for one product** (`read/repo.go`): returns, for the product, a row per active outlet × variant with resolved stock (0 default), price override (null when none), and availability (true default). Implementation: query active outlets × product_variants LEFT JOIN the three per-outlet tables. Return `[]api.OutletVariantConfig`.

- [ ] **Step 4: Write repo — apply matrix** (`write/repo.go`): in one tx, upsert `outlet_variant_stock` (stock), upsert/delete `outlet_variant_price` (set when price non-null, delete row when null), upsert `outlet_product_availability` (available). Then bump content version for the affected outlets only:

```go
func bumpVersionOutlets(ctx context.Context, q pgx.Tx, resource string, outletIDs []string) error {
	for _, oid := range outletIDs {
		if _, err := q.Exec(ctx, `
			INSERT INTO content_versions (outlet_id, version, data_manifest, updated_at)
			VALUES ($2, 2, jsonb_build_object($1::text,1), now())
			ON CONFLICT (outlet_id) DO UPDATE SET
			  version = content_versions.version + 1,
			  data_manifest = content_versions.data_manifest ||
			    jsonb_build_object($1::text, COALESCE((content_versions.data_manifest->>$1)::int,0)+1),
			  updated_at = now()`, resource, oid); err != nil {
			return err
		}
	}
	return nil
}
```

- [ ] **Step 5: Create seeding** — extend product create so the create form's per-variant stock seeds the chosen outlet. Add an optional `seedOutletID` to the create path (handler passes the request's scoped outlet, or the primary outlet when CrossAll). After `insertVariants`, insert `outlet_variant_stock(seedOutletID, productId, size, stock)` for each variant. **Confirm with the user** whether create-seeding should target the switcher's selected outlet vs always primary (Rule 1).

- [ ] **Step 6: Handlers + routes** — add `GetProductOutletConfig` / `PutProductOutletConfig` handlers (read current `handlers/products.go` for the pattern: decode via `httpx.Decode`, call repo, `writeJSON`, then `h.invalidate(r)` on write). Register both routes in `server.go` inside the admin/manage_products block alongside the other `/products` routes.

- [ ] **Step 7: Verify build/vet/fmt/gen + commit**

Run: `cd backend && make gen-check && go vet ./... && gofmt -l . && go build ./...`
Expected: all clean.
```bash
cd .. && git add backend/api/openapi.yaml backend/internal/api/api.gen.go backend/internal/read/repo.go backend/internal/write/repo.go backend/internal/handlers backend/internal/server/server.go
git commit -m "feat(backend): outlet-config read/write endpoints + create stock seeding"
```

---

## Task 7: Deploy backend + verify (GATE before any UI)

- [ ] **Step 1: Confirm primary outlet** (Task 1 Step 2) with the user, if not already done.
- [ ] **Step 2: Deploy** (background, ~4-6 min; migration auto-applies on boot)

```bash
gcloud run deploy mandalika-pos --source backend --region asia-southeast2 --quiet
```

- [ ] **Step 3: Verify health** — `curl -sf https://mandalika-pos-538849926142.asia-southeast2.run.app/readyz` → expect `ok`/200. (`/healthz` is swallowed by Google edge — use `/readyz`.)
- [ ] **Step 4: Verify read resolution** — as admin, `GET /api/v1/products?outletId=<primary>` shows backfilled stock; `?outletId=<other>` shows 0; `?outletId=all` shows the sum. (Use the deployed API with an admin token.)
- [ ] **Step 5: Verify order path (CRITICAL)** — place one real test sale at the primary outlet (POS or API), confirm only that outlet's `outlet_variant_stock` decremented and `product_variants.stock` is untouched; refund it and confirm restore. **If anything is wrong, STOP, show output, do not proceed to UI (Rule 4).**
- [ ] **Step 6: Mark Task 7 done in this file + commit the checkbox update.**

---

## Task 8: Regenerate TS client

- [ ] **Step 1:** `corepack pnpm --filter @mandalika/api gen` (regenerates `packages/api/src/schema.d.ts` with the outlet-config types).
- [ ] **Step 2:** Add client methods in `packages/api/src/client.ts`: `getProductOutletConfig(id)` → `GET /products/{id}/outlet-config`, `updateProductOutletConfig(id, input)` → `PUT`. Mirror the existing `data<T>()` helper style; add to the `Api` interface too.
- [ ] **Step 3: Verify** — `corepack pnpm --filter @mandalika/api exec tsc --noEmit` (or the workspace typecheck). Commit:
```bash
git add packages/api/src
git commit -m "feat(api): outlet-config client methods + regenerated types"
```

---

## Task 9: Backoffice list — already outlet-scoped (verify)

**Files:** `apps/backoffice/src/screens/Products.tsx`

- [ ] **Step 1:** Confirm the product list shows resolved per-outlet stock when an outlet is picked in the switcher. The API client already sends `X-Outlet-Id` from `authStore.outletId`, and `usePolledQuery(..., [])` — **add `outletId` to its dependency array** so it refetches on outlet switch (read `useOutlet()` like Dashboard does). Currently `Products.tsx` does not depend on outlet — fix that.
- [ ] **Step 2: Verify** typecheck; commit if changed.

---

## Task 10: Backoffice edit modal — per-outlet table

**Files:** `apps/backoffice/src/screens/Products.tsx`

- [ ] **Step 1:** When opening edit, fetch `api.getProductOutletConfig(product.id)` into state (rows per outlet × variant). Also load outlets via `api.listOutlets()`.
- [ ] **Step 2:** Render a per-outlet section in the edit modal: for each active outlet, for each variant — an availability toggle (product-level per outlet), a stock number input, and a price-override input (placeholder = base price; blank = use base). Use the existing `ui/` primitives (Input, Select, Badge, Button) and keep it inside the current Modal.
- [ ] **Step 3:** On save, call `api.updateProductOutletConfig(id, { items })` alongside the existing `api.updateProduct`. Refetch.
- [ ] **Step 4: Verify** `corepack pnpm --filter @mandalika/backoffice exec tsc -b --force` (EXIT=0). Commit.

---

## Task 11: Backoffice create — seed selected outlet

**Files:** `apps/backoffice/src/screens/Products.tsx`

- [ ] **Step 1:** Keep the existing per-variant stock field in the create modal; label it with the active outlet (e.g. "Stok awal di <outlet>"). On create, the backend seeds that outlet (Task 6 Step 5). If "Semua Outlet" is selected, show a note that stock seeds the primary outlet.
- [ ] **Step 2: Verify** typecheck; commit.

---

## Task 12: Build, deploy, verify UI

- [ ] **Step 1:** `corepack pnpm --filter @mandalika/backoffice build` (EXIT=0).
- [ ] **Step 2:** `git push origin prod-hardening` (Cloudflare auto-deploys).
- [ ] **Step 3: Verify on `https://mandalika-pos.pages.dev`**: switch outlets → list stock changes; edit a product → set outlet B stock/price/availability → save → reload shows it; product turned off at an outlet disappears from that outlet's POS after resync. Report results (Rule 5/6).
- [ ] **Step 4:** Update memory + `SESSION_HANDOFF.md`: Phase 1 done; note Phases 2-4 remain.

---

## Progress / resume notes
- Update the checkboxes above and commit as each task completes.
- Current status: **not started** (plan just written).
- Open confirmations needed from user before deploy: (a) resolved primary outlet name (Task 1 Step 2); (b) order-path seeding choice for not-yet-seeded outlets (Task 4 Step 1) — default seeds from legacy stock; (c) create-seeding target (Task 6 Step 5).
