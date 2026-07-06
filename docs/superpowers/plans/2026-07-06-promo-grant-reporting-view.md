# Promo Giveaway Report (grant-reporting-view) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A backoffice report over `promo_reward_grants` — a summary (totals + by-promotion + by-product) plus a grouped, filterable drill-down list of promo giveaways (bundle + buy-X-get-Y), completed orders only.

**Architecture:** One read endpoint `GET /api/v1/promo-reward-grants` returns the summary AND a paginated grouped list in one enveloped response (summary computed server-side over the full filtered set). A new "Hadiah Promo" tab in the Reports hub renders it, reusing the hub's date-range + outlet scope and adding promotion + product dropdowns.

**Tech Stack:** Go (backend: chi router, pgx, `read/repo.go` `listJSON` + `handlers`), TypeScript (hand-written client `packages/api/src/client.ts`; backoffice React `apps/backoffice`), oapi-codegen + openapi-typescript.

**Spec:** `docs/superpowers/specs/2026-07-06-promo-grant-reporting-view-design.md`

## Global Constraints

- **Completed orders only:** every query JOINs `orders o ON o.id=g.order_id AND o.status='completed'` — refunded/cancelled giveaways are excluded.
- **Value metric = `reward_value`** (retail value of the freebie). `totalItems` = count of grant rows (each row = one freed unit). A group's `quantity` = `count(*)` within the group.
- **Summary reflects the FULL filtered set** (not the paginated page) — summary aggregates are their own queries, not derived from the list page.
- **Filters (all optional):** `dateFrom`, `dateTo` (YYYY-MM-DD, inclusive, **WIB day bounds**), `outletId`, `promotionId`, `productId`, `page` (default 1), `limit` (default 50).
- **WIB dates:** `dateFrom`/`dateTo` are WIB calendar days; `g.created_at` is `timestamptz` (UTC). Bound with `AT TIME ZONE 'Asia/Jakarta'` (see Task 2) — do NOT compare `timestamptz >= bareDate` (that uses the server's UTC midnight and is off by 7h). Confirm the approach matches any existing date-bounded report query in `read/repo.go`.
- **Permission:** `view_reports` (the endpoint sits in the existing `view_reports` route group).
- **Read-only. No migration. No POS. No APK.** Deploy = backend redeploy (source-only) + Cloudflare backoffice auto-deploy on push.
- **Money-adjacent aggregation** → the read query + codegen get **Opus** review; the handler/client/backoffice tab are Sonnet; spec-conformance/copy Haiku.
- Do not touch unrelated working-tree files (`package.json` doctor script, the audit/PNG files).

## File Structure

- `backend/api/openapi.yaml` — MODIFY: add `PromoRewardGrantGroup`, `PromoGrantBreakdown`, `PromoGrantSummary`, `PromoRewardGrantReport` schemas + the `GET /promo-reward-grants` path.
- `backend/internal/api/api.gen.go`, `packages/api/src/schema.d.ts` — REGENERATE.
- `backend/internal/read/repo.go` — MODIFY: `GrantReportFilters` struct + `PromoRewardGrantReport(...)` read fn.
- `backend/internal/handlers/handlers.go` — MODIFY: `PromoRewardGrants` handler.
- `backend/internal/server/server.go` — MODIFY: route under the `view_reports` group.
- `packages/api/src/client.ts` — MODIFY: `listPromoRewardGrants` on the `Api` interface + `createClient`.
- `apps/backoffice/src/screens/Reports.tsx` — MODIFY: add the `'grants'` tab.
- `apps/backoffice/src/screens/reports/PromoGrantsTab.tsx` — CREATE: the tab body (summary + breakdowns + list + filters).
- `backend/cmd/grantreport/main.go` — CREATE **throwaway** (Task 6, never committed, deleted after).

---

## Task 1: OpenAPI schemas + path + regenerate clients

**Files:**
- Modify: `backend/api/openapi.yaml` (schemas near the existing `PromoRewardGrant` ~L985; a new path near other GET report paths)
- Regenerate: `backend/internal/api/api.gen.go`, `packages/api/src/schema.d.ts`

**Interfaces:**
- Produces (Go `api.*` + TS `components["schemas"][*]`): `PromoRewardGrantGroup`, `PromoGrantBreakdown`, `PromoGrantSummary`, `PromoRewardGrantReport`; the `GET /promo-reward-grants` operation.

- [ ] **Step 1: Add the schemas** (openapi.yaml, right after the existing `PromoRewardGrant` block ~L995)

```yaml
    PromoRewardGrantGroup:
      type: object
      properties:
        orderId: { type: string }
        orderNumber: { type: string }
        promotionId: { type: string }
        promotionName: { type: string }
        productId: { type: string }
        productName: { type: string }
        variantSize: { type: string }
        quantity: { type: integer }
        fullPrice: { type: number }
        valueGivenAway: { type: number }
        createdAt: { type: string }
    PromoGrantBreakdown:
      type: object
      properties:
        promotionId: { type: string }
        promotionName: { type: string }
        productId: { type: string }
        productName: { type: string }
        variantSize: { type: string }
        value: { type: number }
        items: { type: integer }
    PromoGrantSummary:
      type: object
      properties:
        totalValue: { type: number }
        totalItems: { type: integer }
        totalOrders: { type: integer }
        byPromotion: { type: array, items: { $ref: '#/components/schemas/PromoGrantBreakdown' } }
        byProduct:   { type: array, items: { $ref: '#/components/schemas/PromoGrantBreakdown' } }
    PromoRewardGrantReport:
      type: object
      required: [summary, data, meta]
      properties:
        summary: { $ref: '#/components/schemas/PromoGrantSummary' }
        data: { type: array, items: { $ref: '#/components/schemas/PromoRewardGrantGroup' } }
        meta: { $ref: '#/components/schemas/PageMeta' }
```
NOTE: use the repo's existing pagination-meta schema name — find it via `grep -n "meta:" backend/api/openapi.yaml` on an existing list response (e.g. the ingredient-transfers or orders list response `meta`), and reference that exact schema (likely `PageMeta` or `Meta`). If list responses inline the meta object rather than `$ref` it, inline the same `{ total, page, limit }` shape here.

- [ ] **Step 2: Add the path** (openapi.yaml, near other `GET` report/list paths)

```yaml
  /promo-reward-grants:
    get:
      summary: Promo reward giveaway report (grants)
      operationId: listPromoRewardGrants
      parameters:
        - { name: dateFrom, in: query, schema: { type: string } }
        - { name: dateTo, in: query, schema: { type: string } }
        - { name: outletId, in: query, schema: { type: string } }
        - { name: promotionId, in: query, schema: { type: string } }
        - { name: productId, in: query, schema: { type: string } }
        - { name: page, in: query, schema: { type: integer } }
        - { name: limit, in: query, schema: { type: integer } }
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema: { $ref: '#/components/schemas/PromoRewardGrantReport' }
```
NOTE: match the surrounding paths' exact style (some use `tags`, `security`; copy a neighboring GET path's boilerplate). The path is `/promo-reward-grants` (the server mounts everything under `/api/v1`).

- [ ] **Step 3: Regenerate**

Run:
```bash
cd backend && make gen-go
corepack pnpm@10.11.1 --filter @mandalika/api gen
cd backend && make gen-check && go build ./...
```
Expected: `make gen-check` clean; `go build` clean.

- [ ] **Step 4: Verify symbols exist**

Run: `grep -n "PromoRewardGrantReport\|PromoGrantSummary\|PromoRewardGrantGroup" backend/internal/api/api.gen.go packages/api/src/schema.d.ts | head`
Expected: Go structs `PromoRewardGrantReport`/`PromoGrantSummary`/`PromoRewardGrantGroup`/`PromoGrantBreakdown` present; TS `components["schemas"]["PromoRewardGrantReport"]` present. (Referencing them from the path un-prunes them.)

- [ ] **Step 5: Commit**

```bash
git add backend/api/openapi.yaml backend/internal/api/api.gen.go packages/api/src/schema.d.ts
git commit -m "feat(promo-grants): OpenAPI PromoRewardGrantReport + /promo-reward-grants, regen clients"
```

---

## Task 2: Read repo — `PromoRewardGrantReport` (query + summary)

**Files:**
- Modify: `backend/internal/read/repo.go` (near the existing promo-reward-grants read code ~L1771)

**Interfaces:**
- Consumes: `api.PromoRewardGrantReport`/`PromoGrantSummary`/`PromoGrantBreakdown`/`PromoRewardGrantGroup` (Task 1); existing helpers `listJSON[T]`, `off(page,limit)`, `r.Pool`.
- Produces:
  - `type GrantReportFilters struct { DateFrom, DateTo, OutletID, PromotionID, ProductID string }`
  - `func (r *Repo) PromoRewardGrantReport(ctx context.Context, f GrantReportFilters, page, limit int) (api.PromoGrantSummary, []api.PromoRewardGrantGroup, int, error)` — returns (summary, grouped page, total group count).

- [ ] **Step 1: Add the filters struct + read fn** (read/repo.go, after `RewardGrantsByOrder`)

The base filter (shared, fixed params `$1..$5`) — every query below embeds this WHERE. **WIB bounds** via `AT TIME ZONE`:
```sql
FROM promo_reward_grants g
JOIN orders o     ON o.id = g.order_id AND o.status = 'completed'
JOIN promotions p ON p.id = g.promotion_id
WHERE ($1 = '' OR g.created_at >= ($1::date)::timestamp AT TIME ZONE 'Asia/Jakarta')
  AND ($2 = '' OR g.created_at <  (($2::date + 1)::timestamp AT TIME ZONE 'Asia/Jakarta'))
  AND ($3 = '' OR o.outlet_id::text = $3)
  AND ($4 = '' OR g.promotion_id::text = $4)
  AND ($5 = '' OR g.product_id::text = $5)
```

Implementation (adapt param indices exactly; the list query adds `$6=limit,$7=offset`):
```go
type GrantReportFilters struct {
	DateFrom, DateTo, OutletID, PromotionID, ProductID string
}

func (r *Repo) PromoRewardGrantReport(ctx context.Context, f GrantReportFilters, page, limit int) (api.PromoGrantSummary, []api.PromoRewardGrantGroup, int, error) {
	var sum api.PromoGrantSummary
	where := `FROM promo_reward_grants g
		JOIN orders o     ON o.id = g.order_id AND o.status = 'completed'
		JOIN promotions p ON p.id = g.promotion_id
		WHERE ($1 = '' OR g.created_at >= ($1::date)::timestamp AT TIME ZONE 'Asia/Jakarta')
		  AND ($2 = '' OR g.created_at <  (($2::date + 1)::timestamp AT TIME ZONE 'Asia/Jakarta'))
		  AND ($3 = '' OR o.outlet_id::text = $3)
		  AND ($4 = '' OR g.promotion_id::text = $4)
		  AND ($5 = '' OR g.product_id::text = $5)`
	args := []any{f.DateFrom, f.DateTo, f.OutletID, f.PromotionID, f.ProductID}

	// Summary scalars.
	if err := r.Pool.QueryRow(ctx,
		`SELECT COALESCE(SUM(g.reward_value),0), COUNT(*), COUNT(DISTINCT g.order_id) `+where, args...,
	).Scan(&sum.TotalValue, &sum.TotalItems, &sum.TotalOrders); err != nil {
		return sum, nil, 0, err
	}

	// Breakdown by promotion.
	byPromo, _, err := listJSON[api.PromoGrantBreakdown](ctx, r.Pool,
		`SELECT json_build_object('promotionId',g.promotion_id,'promotionName',p.name,
		   'value',SUM(g.reward_value),'items',COUNT(*)) `+where+
			` GROUP BY g.promotion_id, p.name ORDER BY SUM(g.reward_value) DESC`, args...)
	if err != nil {
		return sum, nil, 0, err
	}
	sum.ByPromotion = &byPromo

	// Breakdown by product.
	byProduct, _, err := listJSON[api.PromoGrantBreakdown](ctx, r.Pool,
		`SELECT json_build_object('productId',g.product_id,'productName',g.product_name,
		   'variantSize',g.variant_size,'value',SUM(g.reward_value),'items',COUNT(*)) `+where+
			` GROUP BY g.product_id, g.product_name, g.variant_size ORDER BY SUM(g.reward_value) DESC`, args...)
	if err != nil {
		return sum, nil, 0, err
	}
	sum.ByProduct = &byProduct

	// Total group count.
	var total int
	if err := r.Pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM (SELECT 1 `+where+
			` GROUP BY g.order_id, g.promotion_id, g.product_id, g.variant_size) t`, args...,
	).Scan(&total); err != nil {
		return sum, nil, 0, err
	}

	// Grouped page.
	rows, _, err := listJSON[api.PromoRewardGrantGroup](ctx, r.Pool,
		`SELECT json_build_object('orderId',g.order_id,'orderNumber',o.order_number,
		   'promotionId',g.promotion_id,'promotionName',p.name,
		   'productId',g.product_id,'productName',g.product_name,'variantSize',g.variant_size,
		   'quantity',COUNT(*),'fullPrice',MAX(g.full_price),
		   'valueGivenAway',SUM(g.reward_value),'createdAt',o.created_at) `+where+
			` GROUP BY g.order_id, o.order_number, g.promotion_id, p.name, g.product_id, g.product_name, g.variant_size, o.created_at
			  ORDER BY o.created_at DESC LIMIT $6 OFFSET $7`,
		append(args, limit, off(page, limit))...)
	if err != nil {
		return sum, nil, 0, err
	}
	return sum, rows, total, nil
}
```
NOTE for the implementer: the generated `api.PromoGrantSummary` field types for `ByPromotion`/`ByProduct` may be `*[]api.PromoGrantBreakdown` or `[]api.PromoGrantBreakdown` (oapi-codegen array-field convention). Match whatever `make gen` produced — if the field is a plain slice, assign `sum.ByPromotion = byPromo` (no `&`). Same for the scalar field types (`TotalValue` may be `float32`, `TotalItems`/`TotalOrders` `int`) — align the `Scan` targets. If `listJSON`'s signature differs (it returns `([]T, int, error)`), keep the `_` for the count as shown.

- [ ] **Step 2: Build**

Run: `cd backend && go build ./...`
Expected: clean. (There is no DB-backed unit-test harness for read queries — `read/*_test.go` are pure. This query is verified by the throwaway e2e in Task 6.)

- [ ] **Step 3: Commit**

```bash
git add backend/internal/read/repo.go
git commit -m "feat(promo-grants): read repo PromoRewardGrantReport (grouped list + summary, completed-only, WIB bounds)"
```

---

## Task 3: Handler + route

**Files:**
- Modify: `backend/internal/handlers/handlers.go` (add `PromoRewardGrants`, near the other promo/report handlers)
- Modify: `backend/internal/server/server.go` (route in the `view_reports` group ~L268)

**Interfaces:**
- Consumes: `h.Repo.PromoRewardGrantReport` (Task 2); helpers `pageLimit(r)`, `writeJSON`, `writeErr`, `meta(total,page,limit)`, `api.PromoRewardGrantReport`.
- Produces: `func (h *Handlers) PromoRewardGrants(w http.ResponseWriter, r *http.Request)`; route `GET /api/v1/promo-reward-grants`.

- [ ] **Step 1: Add the handler** (handlers.go — mirror `IngredientTransfers` in `writes.go:661`)

```go
func (h *Handlers) PromoRewardGrants(w http.ResponseWriter, r *http.Request) {
	p, l := pageLimit(r)
	q := r.URL.Query()
	f := read.GrantReportFilters{
		DateFrom:    q.Get("dateFrom"),
		DateTo:      q.Get("dateTo"),
		OutletID:    q.Get("outletId"),
		PromotionID: q.Get("promotionId"),
		ProductID:   q.Get("productId"),
	}
	summary, rows, total, err := h.Repo.PromoRewardGrantReport(r.Context(), f, p, l)
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, http.StatusOK, api.PromoRewardGrantReport{
		Summary: summary,
		Data:    rows,
		Meta:    *meta(total, p, l),
	})
}
```
NOTE: confirm the `read` package import alias in handlers.go (it may already import `read`; if not, add it). Confirm `meta(...)` returns `*api.PageMeta` (or whatever the generated meta type is) and that `api.PromoRewardGrantReport.Meta` is that same type (Task 1). If `Meta` is a value not pointer, drop the `*`.

- [ ] **Step 2: Register the route** (server.go, in the `view_reports` group ~L268)

Change:
```go
			r.With(mw.RequirePermission("view_reports")).
				Get("/reports/summary", h.ReportSummary)
```
to add a sibling line (a `view_reports`-gated group with both routes):
```go
			r.Group(func(r chi.Router) {
				r.Use(mw.RequirePermission("view_reports"))
				r.Get("/reports/summary", h.ReportSummary)
				r.Get("/promo-reward-grants", h.PromoRewardGrants)
			})
```

- [ ] **Step 3: Build**

Run: `cd backend && go build ./... && go vet ./internal/handlers/ ./internal/server/`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add backend/internal/handlers/handlers.go backend/internal/server/server.go
git commit -m "feat(promo-grants): PromoRewardGrants handler + /promo-reward-grants route (view_reports)"
```

---

## Task 4: API client method

**Files:**
- Modify: `packages/api/src/client.ts` (the `Api` interface ~L281 area + the `createClient` impl ~L640 area)

**Interfaces:**
- Consumes: `components["schemas"]["PromoRewardGrantReport"]` (Task 1); the existing `request<T>` + `qs` helpers in `createClient`.
- Produces: `api.listPromoRewardGrants(opts?)` returning `Promise<PromoRewardGrantReport>`.

- [ ] **Step 1: Add the type alias + interface method**

At the top type-aliases area of `client.ts` (where `Order`, `IngredientTransfer` etc. are aliased from `components["schemas"]`), add:
```ts
type PromoRewardGrantReport = components['schemas']['PromoRewardGrantReport']
```
In the `Api` interface (near `listIngredientTransfers` ~L281), add:
```ts
  listPromoRewardGrants: (opts?: { dateFrom?: string; dateTo?: string; outletId?: string; promotionId?: string; productId?: string; page?: number; limit?: number }) => Promise<PromoRewardGrantReport>
```

- [ ] **Step 2: Add the implementation** (in `createClient`, near `listIngredientTransfers` ~L640 — mirror it, but the response is the custom report shape, so use `request<PromoRewardGrantReport>` not `list<T>`)

```ts
    listPromoRewardGrants: (opts) => {
      const { dateFrom, dateTo, outletId, promotionId, productId, page = 1, limit = 50 } = opts ?? {}
      const params: Record<string, string | number> = { page, limit }
      if (dateFrom) params.dateFrom = dateFrom
      if (dateTo) params.dateTo = dateTo
      if (outletId) params.outletId = outletId
      if (promotionId) params.promotionId = promotionId
      if (productId) params.productId = productId
      return request<PromoRewardGrantReport>('GET', `${API}/promo-reward-grants` + qs(params))
    },
```
NOTE: confirm `request` and `qs` are in scope inside `createClient` (they are — `list` uses `request<ListResult<T>>('GET', path + qs(params))`). Confirm the `API` base-path const name (used by `list<Order>(`${API}/orders`…)`).

- [ ] **Step 3: Verify types**

Run: `cd apps/backoffice && corepack pnpm tsc --noEmit`
Expected: clean (the client is consumed by the backoffice; tsc validates the whole graph).

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/client.ts
git commit -m "feat(promo-grants): client listPromoRewardGrants"
```

---

## Task 5: Backoffice "Hadiah Promo" tab

**Files:**
- Create: `apps/backoffice/src/screens/reports/PromoGrantsTab.tsx`
- Modify: `apps/backoffice/src/screens/Reports.tsx` (add the `'grants'` tab)

**Interfaces:**
- Consumes: `api.listPromoRewardGrants` (Task 4); `api.listPromotions()` / `api.listProducts(...)` for the dropdowns; the hub's `dateFrom`/`dateTo`/`outletId` + `usePolledQuery` + `BRAND.currency.format`.
- Produces: a `<PromoGrantsTab dateFrom dateTo outletId />` component + a new tab entry.

- [ ] **Step 1: Wire the tab into `Reports.tsx`**

- Extend the tab union: `type ReportTab = 'orders' | 'export' | 'shifts' | 'grants'`.
- In `visibleTabs` (guarded by `canViewReports`), push `{ id: 'grants', label: 'Hadiah Promo' }` (add it after `shifts`).
- In the tab-body render (where `tab === 'orders'` etc. render their content), add: `{tab === 'grants' && <PromoGrantsTab dateFrom={dateFrom} dateTo={dateTo} outletId={outletId} />}`.
- Import it: `import { PromoGrantsTab } from './reports/PromoGrantsTab'`.

- [ ] **Step 2: Build `PromoGrantsTab.tsx`**

A focused component (keep it out of the already-351-line Reports.tsx). Structure:
```tsx
import { useMemo, useState } from 'react'
import { api } from '../../api'
import { usePolledQuery } from '../../hooks/usePolledQuery' // match the hook path Reports.tsx uses
import { BRAND } from '../../brand'                          // match the currency helper import in the codebase
import { Select } from '../../ui/Select'                     // match existing Select import
import type { components } from '@mandalika/api'

type Report = components['schemas']['PromoRewardGrantReport']
type Promotion = components['schemas']['Promotion']
type Product = components['schemas']['Product']

export function PromoGrantsTab({ dateFrom, dateTo, outletId }: { dateFrom: string; dateTo: string; outletId: string }) {
  const [promotionId, setPromotionId] = useState('')
  const [productId, setProductId] = useState('')
  const [page, setPage] = useState(1)

  const pq = usePolledQuery<Promotion[]>(() => api.listPromotions().then((r) => r.data), [])
  const prq = usePolledQuery<Product[]>(() => api.listProducts(1, 500).then((r) => r.data), [])
  const rq = usePolledQuery<Report>(
    () => api.listPromoRewardGrants({ dateFrom, dateTo, outletId, promotionId, productId, page, limit: 50 }),
    [dateFrom, dateTo, outletId, promotionId, productId, page],
  )
  const rep = rq.data
  const rows = rep?.data ?? []
  const s = rep?.summary

  return (
    <div>
      {/* filter row: promotion + product dropdowns */}
      <div className="flex gap-3 mb-4">
        <Select value={promotionId} onChange={(v) => { setPromotionId(v); setPage(1) }}>
          <option value="">Semua promosi</option>
          {(pq.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select>
        <Select value={productId} onChange={(v) => { setProductId(v); setPage(1) }}>
          <option value="">Semua produk</option>
          {(prq.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select>
      </div>

      {/* summary cards */}
      <div className="grid grid-cols-3 gap-3 mb-4">
        <Card label="Total nilai hadiah" value={BRAND.currency.format(s?.totalValue ?? 0)} />
        <Card label="Jumlah item" value={String(s?.totalItems ?? 0)} />
        <Card label="Jumlah transaksi" value={String(s?.totalOrders ?? 0)} />
      </div>

      {/* two breakdown tables: Per Promosi, Per Produk */}
      <Breakdown title="Per Promosi" rows={(s?.byPromotion ?? []).map((b) => ({ name: b.promotionName ?? '—', value: b.value, items: b.items }))} />
      <Breakdown title="Per Produk" rows={(s?.byProduct ?? []).map((b) => ({ name: `${b.productName ?? '—'}${b.variantSize ? ' · ' + b.variantSize : ''}`, value: b.value, items: b.items }))} />

      {/* detail table */}
      {rows.length === 0 ? (
        <div className="text-gray-500 py-8 text-center">Belum ada hadiah promo pada rentang ini.</div>
      ) : (
        <table className="w-full text-sm">
          <thead><tr className="text-left text-gray-500">
            <th>Tanggal</th><th>No. Order</th><th>Promosi</th><th>Produk</th><th className="text-right">Qty</th><th className="text-right">Nilai</th>
          </tr></thead>
          <tbody>
            {rows.map((g, i) => (
              <tr key={`${g.orderId}-${g.productId}-${g.variantSize}-${i}`} className="border-t">
                <td>{new Date(g.createdAt ?? '').toLocaleDateString('id-ID')}</td>
                <td>{g.orderNumber}</td>
                <td>{g.promotionName}</td>
                <td>{g.productName}{g.variantSize ? ` · ${g.variantSize}` : ''}</td>
                <td className="text-right">{g.quantity}</td>
                <td className="text-right">{BRAND.currency.format(g.valueGivenAway ?? 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {/* simple pager if meta.total > limit */}
    </div>
  )
}
```
NOTE for the implementer: this is a STRUCTURAL sketch — align every import path (`usePolledQuery`, `BRAND`/currency formatter, `Select`, any `Card`/table primitives) to what `Reports.tsx` and its siblings actually use; reuse existing UI primitives rather than inventing `Card`/`Breakdown` if the codebase has them (check `apps/backoffice/src/ui/`). Match the visual style (Tailwind classes) of the existing report tabs. Add a minimal pager only if `rep.meta.total > 50`. Do not add features beyond the spec (no CSV, no charts).

- [ ] **Step 3: Verify**

Run: `cd apps/backoffice && corepack pnpm tsc --noEmit && corepack pnpm vite build`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/backoffice/src/screens/reports/PromoGrantsTab.tsx apps/backoffice/src/screens/Reports.tsx
git commit -m "feat(promo-grants): backoffice Hadiah Promo report tab (summary + breakdowns + grouped list + filters)"
```

---

## Task 6: Verification — throwaway e2e, deploy, smoke

**Files:**
- Create (throwaway, NEVER commit): `backend/cmd/grantreport/main.go`

- [ ] **Step 1: Local gate**

Run:
```bash
cd backend && go build ./... && go test ./... && make gen-check
cd apps/backoffice && corepack pnpm tsc --noEmit && corepack pnpm vite build
```
Expected: all green.

- [ ] **Step 2: Throwaway e2e** (`cmd/grantreport`, real DB via `backend/.env`, never committed, deleted after, zero residue)

Mirror the connect pattern from `backend/cmd/seed/main.go` (`config.Load()` → `db.Connect(ctx, cfg.DatabaseURL)` → `database.Migrate(ctx)` → `read.New(database.Pool)` or the repo constructor). Seed with a unique prefix (`E2E-GRANT-`):
- 1 outlet (reuse an existing `SELECT id FROM outlets LIMIT 1`), 2 promotions, 2 products.
- Insert `orders` rows: **one `status='completed'`** and **one `status='refunded'`**, plus `promo_reward_grants` rows for each (e.g. completed order: promoA/productX ×2 units reward_value 225000 each + promoA/productY ×1 reward_value 1; refunded order: promoB/productX ×1 reward_value 300000).
Assert via `r.PromoRewardGrantReport(ctx, filters, 1, 50)`:
1. **Completed-only:** the refunded order's grant is EXCLUDED — `summary.totalValue` = 225000×2 + 1 = 450001 (not including the 300000), `totalOrders` = 1.
2. **Grouping + quantity:** the productX×2 group appears as ONE row with `quantity=2`, `valueGivenAway=450000`.
3. **byPromotion / byProduct:** promoA value 450001; productX value 450000 / productY value 1.
4. **Filters:** `promotionId=promoB` → empty (its only order is refunded); `productId=productX` → totalValue 450000; a `dateFrom`/`dateTo` outside the seeded day → empty.
Print PASS/FAIL per assert. **Cleanup via defer** (delete grants, orders, promotions, products you inserted; NOT the reused outlet) + a self-check that no `E2E-GRANT-*` rows remain. Then `rm -rf backend/cmd/grantreport`.

Run: `cd backend && go run ./cmd/grantreport`, then delete the dir.
Expected: all asserts PASS; zero residue.

- [ ] **Step 3: Push + deploy** (no migration)

```bash
git push origin prod-hardening   # retry on the connection-reset gotcha
gcloud run deploy mandalika-pos --source backend --region asia-southeast2
```
Confirm `/readyz` 200 on the new rev.

- [ ] **Step 4: Live authed smoke**

With an admin token (user `!`-login if local `.env` creds differ from the deployed admin), `GET /api/v1/promo-reward-grants` → 200 with `{summary,data,meta}`. If the test DB has real giveaway data, spot-check `summary.totalValue`; else confirm an empty-but-well-formed envelope (`data: []`, zero summary). Note the result.

- [ ] **Step 5: Handoff + memory**

Update `promotion-module-sp-promo` + `MEMORY.md` + `SESSION_HANDOFF.md`: grant-reporting-view DONE + deployed (rev, commits, e2e result); the promotion module now has only **SP-Promo-4** open. Commit the handoff:
```bash
git add SESSION_HANDOFF.md docs/superpowers
git commit -m "docs(promo-grants): handoff — grant-reporting-view deployed"
git push origin prod-hardening
```

---

## Notes for the implementer

- **The read query is the risk** (Task 2): completed-only JOIN, WIB day bounds, grouping/quantity, summary over the full filtered set. It has no unit-test harness → the Task-6 throwaway e2e is its real proof. Do it carefully and TDD the e2e assertions (write the expected numbers first).
- **Codegen field shapes** (Task 2/3): oapi-codegen decides pointer-vs-value + float32-vs-float64 for the generated structs — always match what `make gen` actually produced (the plan's Go snippets may need `&`/`*` and numeric-type adjustments).
- **No migration, no POS, no APK.** Backend redeploy + Cloudflare backoffice (auto on push).
- **Don't touch** the pre-existing unrelated working-tree files (`package.json` doctor script, audit/PNG).
