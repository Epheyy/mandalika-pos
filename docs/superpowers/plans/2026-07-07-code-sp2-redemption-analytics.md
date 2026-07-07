# SP-Code-2 Discount-Code Redemption Analytics — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A backoffice report of discount-code performance (redemptions, value given, remaining quota, status) — a new "Kode Diskon" tab in the Reports hub.

**Architecture:** One read endpoint `GET /api/v1/discount-code-report` unnests `orders.discount_breakdown`, joins each component `label → discount_codes.code` (isolating code components), and aggregates per-code redemptions + value (completed orders, date/outlet-scoped). It mirrors the grant-reporting-view slice end-to-end.

**Tech Stack:** Go (pgx, `read/repo.go` `listJSON`), TypeScript (hand-written `@mandalika/api` client; backoffice React), oapi-codegen + openapi-typescript.

**Spec:** `docs/superpowers/specs/2026-07-07-code-sp2-redemption-analytics-design.md`
**Mirror template:** the grant-reporting-view slice — `read.PromoRewardGrantReport` (repo.go:1830), `h.PromoRewardGrants` (handlers.go:440, uses `scope(r)`), `listPromoRewardGrants` (client.ts:689), `PromoGrantsTab.tsx`, and the `'grants'` tab in `Reports.tsx`. Copy their shapes.

## Global Constraints
- **Per-code VALUE = `SUM((b->>'amount')::numeric)`** over breakdown components whose `label` matches a real `discount_codes.code` — NOT `orders.discount_amount` (the combined total).
- **Completed orders only** (`o.status = 'completed'`); **outlet via `scope(r)`** (the IDOR lesson — the handler passes `scope(r).OutletID`, NOT a raw query param); **WIB day bounds** via `AT TIME ZONE 'Asia/Jakarta'` (mirror `PromoRewardGrantReport`).
- **Status** derived in SQL: `nonaktif` if `NOT is_active`; else `kedaluwarsa` if `end_date < today(WIB)`; else `kuota habis` if `usage_limit IS NOT NULL AND usage_count >= usage_limit`; else `aktif`.
- Guard `jsonb_array_elements` with `COALESCE(o.discount_breakdown,'[]'::jsonb)` (null-safe).
- Permission **`view_reports`** (the endpoint sits in that route group).
- Summary computed over the FULL filtered set (separate aggregate query); `meta.total` = # code rows.
- **No migration, no POS, no APK.** Deploy = backend redeploy + Cloudflare backoffice.
- Read query + type-gen → **Opus** review; handler/client/tab → Sonnet.
- Don't touch unrelated working-tree files (`package.json` doctor script, PNGs, audit doc).

## File Structure
- `backend/api/openapi.yaml` + regen `api.gen.go`, `packages/api/src/schema.d.ts` — the report schemas + path.
- `backend/internal/read/repo.go` — `CodeReportFilters` + `DiscountCodeReport(...)`.
- `backend/internal/handlers/handlers.go` — `DiscountCodeReport` handler.
- `backend/internal/server/server.go` — route in the `view_reports` group.
- `packages/api/src/client.ts` — `listDiscountCodeReport`.
- `apps/backoffice/src/screens/reports/DiscountCodeReportTab.tsx` — CREATE.
- `apps/backoffice/src/screens/Reports.tsx` — add the `'codeReport'` tab.
- `backend/cmd/codereport/main.go` — throwaway (Task 6).

---

## Task 1: OpenAPI schemas + path + regen

**Files:** Modify `backend/api/openapi.yaml`; regenerate `api.gen.go`, `schema.d.ts`.

**Interfaces:** Produces `DiscountCodeReportRow`, `DiscountCodeReportSummary`, `DiscountCodeReport`; `GET /api/v1/discount-code-report`.

- [ ] **Step 1: Add the schemas** (openapi.yaml, near the other report schemas — e.g. after `PromoRewardGrantReport`)

```yaml
    DiscountCodeReportRow:
      type: object
      properties:
        code: { type: string }
        promotionName: { type: string, nullable: true }
        redemptions: { type: integer }
        valueGiven: { type: number }
        usageLimit: { type: integer, nullable: true }
        usageCount: { type: integer }
        remaining: { type: integer, nullable: true }
        status: { type: string }
    DiscountCodeReportSummary:
      type: object
      properties:
        totalRedemptions: { type: integer }
        totalValue: { type: number }
        distinctCodes: { type: integer }
    DiscountCodeReport:
      type: object
      required: [summary, data, meta]
      properties:
        summary: { $ref: '#/components/schemas/DiscountCodeReportSummary' }
        data: { type: array, items: { $ref: '#/components/schemas/DiscountCodeReportRow' } }
        meta: { $ref: '#/components/schemas/Meta' }
```

- [ ] **Step 2: Add the path** (match a sibling report path's tags/security — e.g. `/api/v1/promo-reward-grants`)

```yaml
  /api/v1/discount-code-report:
    get:
      summary: Discount-code redemption report
      operationId: listDiscountCodeReport
      parameters:
        - { name: dateFrom, in: query, schema: { type: string } }
        - { name: dateTo, in: query, schema: { type: string } }
        - { name: page, in: query, schema: { type: integer } }
        - { name: limit, in: query, schema: { type: integer } }
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema: { $ref: '#/components/schemas/DiscountCodeReport' }
```
NOTE: NO `outletId` query param — outlet comes from `scope(r)` (the header), like the grants report. Copy the exact tags/security of `/api/v1/promo-reward-grants`.

- [ ] **Step 3: Regenerate + verify**

```bash
cd backend && make gen-go
corepack pnpm@10.11.1 --filter @mandalika/api gen
cd backend && make gen-check && go build ./...
```
Expected: gen-check clean; `grep -n "DiscountCodeReport" backend/internal/api/api.gen.go packages/api/src/schema.d.ts` shows the Go structs + TS types + the operation.

- [ ] **Step 4: Commit**

```bash
git add backend/api/openapi.yaml backend/internal/api/api.gen.go packages/api/src/schema.d.ts
git commit -m "feat(code-sp2): OpenAPI DiscountCodeReport + /discount-code-report, regen clients"
```

---

## Task 2: Read repo — `DiscountCodeReport`

**Files:** Modify `backend/internal/read/repo.go` (near `PromoRewardGrantReport` ~L1830).

**Interfaces:**
- Produces: `type CodeReportFilters struct { DateFrom, DateTo, OutletID string }`; `func (r *Repo) DiscountCodeReport(ctx, f CodeReportFilters, page, limit int) (api.DiscountCodeReportSummary, []api.DiscountCodeReportRow, int, error)`.
- Consumes: `listJSON`, `off(page,limit)`, `r.Pool`.

- [ ] **Step 1: Add the filters struct + read fn** (mirror `PromoRewardGrantReport`)

Shared base (params `$1=DateFrom, $2=DateTo, $3=OutletID`):
```sql
FROM orders o
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(o.discount_breakdown, '[]'::jsonb)) b
JOIN discount_codes dc ON dc.code = (b->>'label')
LEFT JOIN promotions p ON p.id = dc.promotion_id
WHERE o.status = 'completed'
  AND ($3 = '' OR o.outlet_id::text = $3)
  AND ($1 = '' OR o.created_at >= ($1::date)::timestamp AT TIME ZONE 'Asia/Jakarta')
  AND ($2 = '' OR o.created_at <  (($2::date + 1)::timestamp AT TIME ZONE 'Asia/Jakarta'))
```

```go
type CodeReportFilters struct{ DateFrom, DateTo, OutletID string }

func (r *Repo) DiscountCodeReport(ctx context.Context, f CodeReportFilters, page, limit int) (api.DiscountCodeReportSummary, []api.DiscountCodeReportRow, int, error) {
	var sum api.DiscountCodeReportSummary
	where := `FROM orders o
		CROSS JOIN LATERAL jsonb_array_elements(COALESCE(o.discount_breakdown, '[]'::jsonb)) b
		JOIN discount_codes dc ON dc.code = (b->>'label')
		LEFT JOIN promotions p ON p.id = dc.promotion_id
		WHERE o.status = 'completed'
		  AND ($3 = '' OR o.outlet_id::text = $3)
		  AND ($1 = '' OR o.created_at >= ($1::date)::timestamp AT TIME ZONE 'Asia/Jakarta')
		  AND ($2 = '' OR o.created_at <  (($2::date + 1)::timestamp AT TIME ZONE 'Asia/Jakarta'))`
	args := []any{f.DateFrom, f.DateTo, f.OutletID}

	// Summary over the full filtered set.
	var tr, dc int
	var tv float64
	if err := r.Pool.QueryRow(ctx,
		`SELECT COUNT(DISTINCT o.id), COALESCE(SUM((b->>'amount')::numeric),0), COUNT(DISTINCT b->>'label') `+where, args...,
	).Scan(&tr, &tv, &dc); err != nil {
		return sum, nil, 0, err
	}
	trv, tvv, dcv := tr, float32(tv), dc
	sum.TotalRedemptions = &trv
	sum.TotalValue = &tvv
	sum.DistinctCodes = &dcv

	// Total group count.
	var total int
	if err := r.Pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM (SELECT 1 `+where+` GROUP BY dc.id, b->>'label') t`, args...,
	).Scan(&total); err != nil {
		return sum, nil, 0, err
	}

	// Per-code page.
	rows, _, err := listJSON[api.DiscountCodeReportRow](ctx, r.Pool,
		`SELECT json_build_object(
		   'code', b->>'label',
		   'promotionName', p.name,
		   'redemptions', COUNT(DISTINCT o.id),
		   'valueGiven', SUM((b->>'amount')::numeric),
		   'usageLimit', dc.usage_limit,
		   'usageCount', dc.usage_count,
		   'remaining', CASE WHEN dc.usage_limit IS NULL THEN NULL ELSE dc.usage_limit - dc.usage_count END,
		   'status', CASE
		     WHEN NOT dc.is_active THEN 'nonaktif'
		     WHEN dc.end_date IS NOT NULL AND dc.end_date < (now() AT TIME ZONE 'Asia/Jakarta')::date THEN 'kedaluwarsa'
		     WHEN dc.usage_limit IS NOT NULL AND dc.usage_count >= dc.usage_limit THEN 'kuota habis'
		     ELSE 'aktif' END) `+where+`
		 GROUP BY dc.id, b->>'label', p.name, dc.usage_limit, dc.usage_count, dc.is_active, dc.end_date
		 ORDER BY SUM((b->>'amount')::numeric) DESC LIMIT $4 OFFSET $5`,
		append(args, limit, off(page, limit))...)
	if err != nil {
		return sum, nil, 0, err
	}
	return sum, rows, total, nil
}
```
NOTE: match the generated `api.DiscountCodeReportSummary` field types (likely `*int`/`*float32` pointers — the plan scans into locals then assigns pointers, as `PromoRewardGrantReport` does; adjust `&`/`*` and numeric types to what `api.gen.go` actually generated). `listJSON` returns `([]T, int, error)`.

- [ ] **Step 2: Build**

Run: `cd backend && go build ./... && go vet ./internal/read/`
Expected: clean. (No DB unit harness — the query is proven by the Task-6 e2e.)

- [ ] **Step 3: Commit**

```bash
git add backend/internal/read/repo.go
git commit -m "feat(code-sp2): read DiscountCodeReport (breakdown-unnest per-code value, completed-only, WIB, SQL status)"
```

---

## Task 3: Handler + route

**Files:** Modify `backend/internal/handlers/handlers.go` (near `PromoRewardGrants` ~L440); `server.go` (view_reports group).

**Interfaces:** Consumes `read.DiscountCodeReport`, `read.CodeReportFilters`, `scope(r)`, `pageLimit`, `writeJSON`, `meta`, `api.DiscountCodeReport`.

- [ ] **Step 1: Add the handler** (mirror `PromoRewardGrants` — uses `scope(r)` for the outlet)

```go
func (h *Handlers) DiscountCodeReport(w http.ResponseWriter, r *http.Request) {
	p, l := pageLimit(r)
	q := r.URL.Query()
	sc := scope(r)
	f := read.CodeReportFilters{
		DateFrom: q.Get("dateFrom"),
		DateTo:   q.Get("dateTo"),
		OutletID: sc.OutletID, // scope-clamped (non-admin → their outlet; admin → ?outletId/all/header); "" = all
	}
	summary, rows, total, err := h.Repo.DiscountCodeReport(r.Context(), f, p, l)
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, http.StatusOK, api.DiscountCodeReport{Summary: summary, Data: rows, Meta: *meta(total, p, l)})
}
```
NOTE: confirm `api.DiscountCodeReport.Meta` type matches `*meta(...)` deref (it's `api.Meta`, like the grants report). If `Data` comes back nil on empty, `listJSON` already returns `[]T{}` (non-null) — confirmed in the grants slice.

- [ ] **Step 2: Register the route** (server.go, in the `view_reports` group with `/promo-reward-grants` ~L272)

```go
				r.Get("/discount-code-report", h.DiscountCodeReport)
```

- [ ] **Step 3: Build + commit**

Run: `cd backend && go build ./... && go vet ./internal/handlers/ ./internal/server/`
```bash
git add backend/internal/handlers/handlers.go backend/internal/server/server.go
git commit -m "feat(code-sp2): DiscountCodeReport handler + route (view_reports, scope-clamped outlet)"
```

---

## Task 4: Client `listDiscountCodeReport`

**Files:** Modify `packages/api/src/client.ts` (mirror `listPromoRewardGrants` ~L298/L689).

**Interfaces:** Produces `api.listDiscountCodeReport(opts) => Promise<DiscountCodeReport>`.

- [ ] **Step 1: Add the type alias + interface method + impl**

Type alias (near the other `S['...']` aliases): `type DiscountCodeReport = S['DiscountCodeReport']`.
`Api` interface (near `listPromoRewardGrants`):
```ts
  listDiscountCodeReport: (opts?: { dateFrom?: string; dateTo?: string; page?: number; limit?: number }) => Promise<DiscountCodeReport>
```
Impl in `createClient` (mirror `listPromoRewardGrants` — raw `request`, no envelope):
```ts
    listDiscountCodeReport: (opts) => {
      const { dateFrom, dateTo, page = 1, limit = 50 } = opts ?? {}
      const params: Record<string, string | number> = { page, limit }
      if (dateFrom) params.dateFrom = dateFrom
      if (dateTo) params.dateTo = dateTo
      return request<DiscountCodeReport>('GET', `${API}/discount-code-report` + qs(params))
    },
```
NOTE: no `outletId` param (outlet is the header/scope). Confirm `request`/`qs`/`API` names (used by `listPromoRewardGrants`).

- [ ] **Step 2: Verify + commit**

Run: `cd apps/backoffice && corepack pnpm tsc --noEmit`
```bash
git add packages/api/src/client.ts
git commit -m "feat(code-sp2): client listDiscountCodeReport"
```

---

## Task 5: Backoffice "Kode Diskon" report tab

**Files:** Create `apps/backoffice/src/screens/reports/DiscountCodeReportTab.tsx`; modify `Reports.tsx`.

**Interfaces:** Consumes `api.listDiscountCodeReport`, `usePolledQuery`, `BRAND.currency.format`, the report types. Mirror `PromoGrantsTab.tsx`.

- [ ] **Step 1: Wire the tab into `Reports.tsx`** (mirror the `'grants'` tab)

- `type ReportTab = 'orders' | 'export' | 'shifts' | 'grants' | 'codeReport'`.
- In `visibleTabs`, add `if (canViewReports) t.push({ id: 'codeReport', label: 'Kode Diskon' })` (after `'grants'`).
- In the tab body: `{tab === 'codeReport' && <DiscountCodeReportTab dateFrom={dateFrom} dateTo={dateTo} outletId={outletId} />}`.
- Import: `import { DiscountCodeReportTab } from './reports/DiscountCodeReportTab'`.

- [ ] **Step 2: Build `DiscountCodeReportTab.tsx`** (mirror `PromoGrantsTab.tsx`)

```tsx
import { useEffect, useState } from 'react'
import { api } from '../../api'
import { usePolledQuery } from '../../hooks/usePolledQuery'
import { BRAND } from '../../lib/brand'
import type { components } from '@mandalika/api'

type Report = components['schemas']['DiscountCodeReport']

const STATUS_TONE: Record<string, string> = {
  aktif: 'text-green-700 bg-green-50',
  'kuota habis': 'text-amber-700 bg-amber-50',
  kedaluwarsa: 'text-gray-500 bg-gray-100',
  nonaktif: 'text-gray-500 bg-gray-100',
}

export function DiscountCodeReportTab({ dateFrom, dateTo, outletId }: { dateFrom: string; dateTo: string; outletId: string }) {
  const [page, setPage] = useState(1)
  useEffect(() => setPage(1), [dateFrom, dateTo, outletId])
  const rq = usePolledQuery<Report>(
    () => api.listDiscountCodeReport({ dateFrom, dateTo, page, limit: 50 }),
    [dateFrom, dateTo, outletId, page],
  )
  const rep = rq.data
  const rows = rep?.data ?? []
  const s = rep?.summary
  return (
    <div>
      {/* summary cards: Total penukaran / Total nilai diskon / Jumlah kode — reuse the hub's Card/stat markup (match PromoGrantsTab) */}
      {/* detail table */}
      {rows.length === 0 ? (
        <div className="text-gray-500 py-8 text-center">Belum ada penukaran kode pada rentang ini.</div>
      ) : (
        <table className="w-full text-sm">
          <thead><tr className="text-left text-gray-500">
            <th>Kode</th><th>Promosi</th><th className="text-right">Penukaran</th><th className="text-right">Nilai</th><th className="text-right">Sisa kuota</th><th>Status</th>
          </tr></thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.code} className="border-t">
                <td className="font-mono">{c.code}</td>
                <td>{c.promotionName ?? '—'}</td>
                <td className="text-right">{c.redemptions ?? 0}</td>
                <td className="text-right">{BRAND.currency.format(c.valueGiven ?? 0)}</td>
                <td className="text-right">{c.remaining ?? '∞'}</td>
                <td><span className={`px-2 py-0.5 rounded-lg text-xs font-bold ${STATUS_TONE[c.status ?? ''] ?? 'text-gray-500 bg-gray-100'}`}>{c.status}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {/* pager if meta.total > 50 — mirror PromoGrantsTab */}
    </div>
  )
}
```
NOTE: STRUCTURAL sketch — align imports (`usePolledQuery`, `BRAND`, any `Card`/stat components) and the summary-card markup to exactly what `PromoGrantsTab.tsx` uses (read it and match). Summary cards: Total penukaran = `s?.totalRedemptions ?? 0`, Total nilai diskon = `BRAND.currency.format(s?.totalValue ?? 0)`, Jumlah kode = `s?.distinctCodes ?? 0`. `outletId` is a query dep only (the header carries outlet scope; the client method doesn't send it).

- [ ] **Step 3: Verify + commit**

Run: `cd apps/backoffice && corepack pnpm tsc --noEmit && corepack pnpm vite build`
```bash
git add apps/backoffice/src/screens/reports/DiscountCodeReportTab.tsx apps/backoffice/src/screens/Reports.tsx
git commit -m "feat(code-sp2): backoffice Kode Diskon report tab"
```

---

## Task 6: Verify — live e2e, deploy, handoff

**Files:** Create throwaway `backend/cmd/codereport/main.go` (never commit).

- [ ] **Step 1: Local gate**

`cd backend && go build ./... && go test ./... && make gen-check` ; `cd apps/backoffice && corepack pnpm tsc --noEmit && corepack pnpm vite build` — all green.

- [ ] **Step 2: Throwaway e2e** (`cmd/codereport`, real `read.Repo`, zero-residue, deleted)

Connect via `config.Load()`→`db.Connect`→`read.New(pool)`. Seed (prefix `E2ECR`): 1 outlet (reuse), 1 discount code `E2ECR1` (usage_limit 100, usage_count 3, is_active true), 1 promotion (optional link). Insert `orders` rows with `discount_breakdown` jsonb:
- ONE `status='completed'` order with breakdown `[{"label":"E2ECR1","amount":50000},{"label":"Diskon Manual","amount":10000}]`.
- ANOTHER `status='completed'` order with breakdown `[{"label":"E2ECR1","amount":30000}]`.
- ONE `status='refunded'` order with breakdown `[{"label":"E2ECR1","amount":99999}]` (must be EXCLUDED).
Assert `r.DiscountCodeReport(...)`:
1. **Value from breakdown, completed-only:** the `E2ECR1` row has `redemptions=2`, `valueGiven=80000` (50000+30000, the refunded 99999 excluded); the `Diskon Manual` line is NOT counted (no matching code).
2. **Summary:** totalRedemptions=2, totalValue=80000, distinctCodes=1.
3. **Status:** `aktif` (active, not expired, 3<100).
4. **Filters:** a dateFrom/dateTo outside the seeded day → empty + zeros.
Cleanup (defer): delete the orders + code + promotion (prefix `E2ECR`); self-check zero residue. Then `rm -rf backend/cmd/codereport`. Run local, or Neon via [[neon-e2e-verification]] if authorized.

- [ ] **Step 3: Push + deploy** (no migration)

`git push origin prod-hardening` → `gcloud run deploy mandalika-pos --source backend --region asia-southeast2` → `/readyz` 200.

- [ ] **Step 4: Live authed smoke** (per [[neon-e2e-verification]]): admin token → `GET /api/v1/discount-code-report` → 200 `{summary,data,meta}` (empty-but-well-formed if no code redemptions on the test DB).

- [ ] **Step 5: Handoff + memory:** update `discount-code-enhancements` + `MEMORY.md` + `SESSION_HANDOFF.md` (SP-Code-2 done; next = SP-Code-3 per-customer cap). Commit + push.

---

## Notes for the implementer
- **Task 2 is the crux** (the breakdown-unnest join + per-code value attribution + completed-only + WIB + SQL status). No DB unit harness → the Task-6 e2e (with a refunded order + a manual-discount line) is its proof. Opus review.
- Match the generated summary field pointer/numeric types (grep `type DiscountCodeReportSummary struct` in api.gen.go).
- No migration, no POS/APK.
