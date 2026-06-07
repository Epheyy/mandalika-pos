# SP-CRM-1 — Customer Hub Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Customers list scale (server pagination + search), add birthday/anniversary/notes fields, and replace the purchase-history modal with a full-page Customer Detail hub that later CRM sprints extend.

**Architecture:** Backoffice-only this sprint; the data model is additive/nullable so the existing POS sync (`customers` array + `customer_create` outbox) keeps working and a later POS sprint layers on. The detail "page" is an in-screen view swap inside `Customers.tsx` (the app has no router), mirroring the existing Inventori drill-in pattern. Backend follows the established `openapi.yaml → oapi-codegen → @mandalika/api gen → gen-check` flow; DB-bound queries are verified by an authed live check (repo norm), not unit tests.

**Tech Stack:** Go (chi handlers, pgx, oapi-codegen), Postgres (Neon), React + TypeScript (Vite) backoffice, shared `@mandalika/api` client.

**Spec:** `docs/superpowers/specs/2026-06-07-crm-sp1-customer-hub-foundation-design.md`

---

## Testing posture (read first)

- **Backend:** no per-query unit tests exist in this repo (queries need a DB); they are verified by `go build`, `go test ./...` (regression), `go vet`, then an **authed live check** (Phase F). This matches every prior SP.
- **Frontend:** the backoffice has **no test runner** (no Vitest; `package.json` has only `dev`/`build`/`preview`). Verification is `tsc -b` + `vite build` + the live API check + a visual walkthrough. The phone-dupe check is written as a small pure function for clarity, but **no test harness is added** (out of scope). If you want FE unit tests, that's a separate decision to add a runner first.
- **Commits:** stage with `git add <paths>` then `git commit` **as separate commands** (chained `git commit && …` trips the commit hook false-positive). Never `--no-verify`.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `backend/internal/db/migrations/0025_customer_crm_fields.sql` | Add `birthday`, `anniversary`, `notes` columns | Create |
| `backend/api/openapi.yaml` | `Customer` + `CustomerInput` fields; `listCustomers` `q` param | Modify |
| `backend/internal/api/api.gen.go` | Regenerated from openapi | Regen (commit) |
| `backend/internal/read/repo.go` | `customerObj` emits new fields; `Customers()` gains `q` + sort | Modify |
| `backend/internal/handlers/handlers.go` | `Customers` handler reads `q`, passes through | Modify |
| `backend/internal/write/repo.go` | `Customer` struct + Create/Update SQL gain new fields | Modify |
| `packages/api/src/client.ts` | `listCustomers(page,limit,q)` + `getCustomer(id)` | Modify |
| `apps/backoffice/src/screens/Customers.tsx` | Server pagination+search; row→detail; extended edit modal; phone-dupe warn | Modify |
| `apps/backoffice/src/screens/customers/CustomerDetail.tsx` | Full-page detail hub (profile, stats, history, reserved sections) | Create |
| `apps/backoffice/src/screens/customers/phone.ts` | Pure `isDuplicatePhone` helper | Create |

---

## Phase A — Backend data model + API

### Task A1: Migration 0025 (additive columns)

**Files:**
- Create: `backend/internal/db/migrations/0025_customer_crm_fields.sql`

- [ ] **Step 1: Confirm 0025 is the next free slot**

Run: `git ls-files "backend/internal/db/migrations/" | sort | tail -5`
Expected: highest existing is `0024_*.sql`; no `0025_*` present.

- [ ] **Step 2: Create the migration**

```sql
-- 0025_customer_crm_fields.sql
-- SP-CRM-1: richer customer fields. Additive + nullable: safe for POS sync
-- (customers array) and the offline customer_create outbox path.
ALTER TABLE customers ADD COLUMN birthday    DATE;
ALTER TABLE customers ADD COLUMN anniversary DATE;
ALTER TABLE customers ADD COLUMN notes       TEXT;
```

- [ ] **Step 3: Sanity-check SQL syntax compiles into the binary**

Run: `cd backend && go build ./...`
Expected: builds (migrations are embedded via `embed`; a malformed filename or embed mismatch fails the build).

- [ ] **Step 4: Commit**

```bash
git add backend/internal/db/migrations/0025_customer_crm_fields.sql
git commit -m "feat(backend): migration 0025 add customer birthday/anniversary/notes"
```

> Migration is applied at deploy/startup by the migration runner; live application is verified in Phase F.

---

### Task A2: OpenAPI schema + regen

**Files:**
- Modify: `backend/api/openapi.yaml` (Customer ~671-683, CustomerInput ~1364-1370, listCustomers ~1865-1876)
- Regen: `backend/internal/api/api.gen.go`

- [ ] **Step 1: Add the three fields to the `Customer` schema**

In `backend/api/openapi.yaml`, the `Customer` schema currently ends:
```yaml
        lastVisit: { type: string, format: date-time, nullable: true }
        createdAt: { type: string, format: date-time }
```
Add three properties immediately after `lastVisit` (before `createdAt` is fine too):
```yaml
        birthday: { type: string, format: date, nullable: true }
        anniversary: { type: string, format: date, nullable: true }
        notes: { type: string, nullable: true }
```
Do **not** add them to the `required` list (they are optional).

- [ ] **Step 2: Add the three fields to `CustomerInput`**

`CustomerInput` currently:
```yaml
    CustomerInput:
      type: object
      required: [name, phone]
      properties:
        name: { type: string }
        phone: { type: string }
        email: { type: string }
```
Add after `email`:
```yaml
        birthday: { type: string }
        anniversary: { type: string }
        notes: { type: string }
```
(Plain strings — empty string means "clear"; the write layer maps `""`→NULL via `nullDate`/`nullStr`.)

- [ ] **Step 3: Add the `q` query param to `listCustomers`**

Find the `get:` operation with `operationId: listCustomers` (~line 1865). It currently has no `parameters:`. Add a `parameters:` block referencing the shared page/limit params if the file uses them, plus `q`. Match the style used by `listOrders` (search the file for `operationId: listOrders` to copy its `parameters:` shape). Minimum addition:
```yaml
      parameters:
        - { in: query, name: page, schema: { type: integer } }
        - { in: query, name: limit, schema: { type: integer } }
        - { in: query, name: q, schema: { type: string } }
```
If `listCustomers` already inherits page/limit elsewhere, only add the `q` line — check how `listOrders` declares its params and mirror it exactly to avoid duplicate-param codegen errors.

- [ ] **Step 4: Regenerate Go + TS types**

Run:
```bash
cd backend && go tool oapi-codegen -config api/oapi-codegen.yaml api/openapi.yaml
cd .. && corepack pnpm --filter @mandalika/api gen
```
Expected: `backend/internal/api/api.gen.go` now has `Birthday`, `Anniversary`, `Notes` on `Customer` and `CustomerInput`, and `ListCustomersParams` has a `Q *string`. The TS `S['Customer']` / `S['CustomerInput']` include the new fields.

- [ ] **Step 5: Verify no codegen drift**

Run: `cd backend && make gen-check`
Expected: PASS (no diff). If it fails, you forgot to commit the regenerated `api.gen.go`.

- [ ] **Step 6: Build**

Run: `cd backend && go build ./...`
Expected: builds.

- [ ] **Step 7: Commit**

```bash
git add backend/api/openapi.yaml backend/internal/api/api.gen.go
git commit -m "feat(api): customer birthday/anniversary/notes + listCustomers q param"
```

---

### Task A3: Read layer — emit fields, add search + sort

**Files:**
- Modify: `backend/internal/read/repo.go:639-648` (`customerObj`, `Customers`)
- Modify: `backend/internal/handlers/handlers.go:246-254` (`Customers` handler)

- [ ] **Step 1: Extend `customerObj` to emit the new fields**

Replace (`backend/internal/read/repo.go:639-641`):
```go
const customerObj = `json_build_object('id',id,'name',name,'phone',phone,
  'email',email,'points',points,'totalSpent',total_spent,'visitCount',visit_count,
  'lastVisit',last_visit,'createdAt',created_at)`
```
with:
```go
const customerObj = `json_build_object('id',id,'name',name,'phone',phone,
  'email',email,'points',points,'totalSpent',total_spent,'visitCount',visit_count,
  'lastVisit',last_visit,'birthday',birthday,'anniversary',anniversary,
  'notes',notes,'createdAt',created_at)`
```

- [ ] **Step 2: Add `q` + sort to `Customers()`**

Replace (`backend/internal/read/repo.go:643-648`):
```go
func (r *Repo) Customers(ctx context.Context, page, limit int) ([]api.Customer, int, error) {
	return listJSON[api.Customer](ctx, r.Pool,
		`SELECT `+customerObj+`, count(*) OVER() AS total
		   FROM customers ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
		limit, off(page, limit))
}
```
with:
```go
func (r *Repo) Customers(ctx context.Context, page, limit int, q string) ([]api.Customer, int, error) {
	if q != "" {
		like := "%" + q + "%"
		return listJSON[api.Customer](ctx, r.Pool,
			`SELECT `+customerObj+`, count(*) OVER() AS total
			   FROM customers
			  WHERE name ILIKE $1 OR phone ILIKE $1 OR email ILIKE $1
			  ORDER BY total_spent DESC LIMIT $2 OFFSET $3`,
			like, limit, off(page, limit))
	}
	return listJSON[api.Customer](ctx, r.Pool,
		`SELECT `+customerObj+`, count(*) OVER() AS total
		   FROM customers ORDER BY total_spent DESC LIMIT $1 OFFSET $2`,
		limit, off(page, limit))
}
```
(`q` is bound as a parameter — never concatenated into SQL.)

- [ ] **Step 3: Pass `q` from the handler**

Replace (`backend/internal/handlers/handlers.go:246-254`):
```go
func (h *Handlers) Customers(w http.ResponseWriter, r *http.Request) {
	h.cached(w, r, ckey(r), func() (any, int, error) {
		p, l := pageLimit(r)
		rows, total, err := h.Repo.Customers(r.Context(), p, l)
		if err != nil {
			return nil, 500, err
		}
		return api.CustomerListResponse{Data: rows, Meta: meta(total, p, l)}, 200, nil
	})
}
```
with:
```go
func (h *Handlers) Customers(w http.ResponseWriter, r *http.Request) {
	h.cached(w, r, ckey(r), func() (any, int, error) {
		p, l := pageLimit(r)
		q := strings.TrimSpace(r.URL.Query().Get("q"))
		rows, total, err := h.Repo.Customers(r.Context(), p, l, q)
		if err != nil {
			return nil, 500, err
		}
		return api.CustomerListResponse{Data: rows, Meta: meta(total, p, l)}, 200, nil
	})
}
```
(`ckey` already includes `r.URL.RawQuery`, so different `q`/`page` cache separately.)

- [ ] **Step 4: Ensure `strings` is imported**

Run: `grep -n '"strings"' backend/internal/handlers/handlers.go`
Expected: present. If absent, add `"strings"` to the import block.

- [ ] **Step 5: Build + vet + regression tests**

Run:
```bash
cd backend && go build ./... && go vet ./... && go test ./...
```
Expected: builds; vet clean; tests pass (the `Customers` signature change must compile everywhere — only the handler calls it).

- [ ] **Step 6: Commit**

```bash
git add backend/internal/read/repo.go backend/internal/handlers/handlers.go
git commit -m "feat(backend): customer list server-side search + emit crm fields"
```

---

### Task A4: Write layer — persist new fields

**Files:**
- Modify: `backend/internal/write/repo.go:431-457` (`Customer` struct + Create/Update)

- [ ] **Step 1: Extend the write `Customer` struct**

Replace (`backend/internal/write/repo.go:431-435`):
```go
type Customer struct {
	Name  string `json:"name"`
	Phone string `json:"phone"`
	Email string `json:"email"`
}
```
with:
```go
type Customer struct {
	Name        string `json:"name"`
	Phone       string `json:"phone"`
	Email       string `json:"email"`
	Birthday    string `json:"birthday"`
	Anniversary string `json:"anniversary"`
	Notes       string `json:"notes"`
}
```

- [ ] **Step 2: Update `CreateCustomer` INSERT**

Replace the INSERT (`backend/internal/write/repo.go:440-442`):
```go
		return t.QueryRow(ctx,
			`INSERT INTO customers (name, phone, email) VALUES ($1,$2,$3) RETURNING id`,
			c.Name, c.Phone, nullStr(c.Email)).Scan(&id)
```
with:
```go
		return t.QueryRow(ctx,
			`INSERT INTO customers (name, phone, email, birthday, anniversary, notes)
			 VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
			c.Name, c.Phone, nullStr(c.Email),
			nullDate(c.Birthday), nullDate(c.Anniversary), nullStr(c.Notes)).Scan(&id)
```

- [ ] **Step 3: Update `UpdateCustomer` UPDATE**

Replace (`backend/internal/write/repo.go:449-451`):
```go
		ct, e := t.Exec(ctx,
			`UPDATE customers SET name=$1, phone=$2, email=$3 WHERE id=$4`,
			c.Name, c.Phone, nullStr(c.Email), id)
```
with:
```go
		ct, e := t.Exec(ctx,
			`UPDATE customers SET name=$1, phone=$2, email=$3,
			   birthday=$4, anniversary=$5, notes=$6 WHERE id=$7`,
			c.Name, c.Phone, nullStr(c.Email),
			nullDate(c.Birthday), nullDate(c.Anniversary), nullStr(c.Notes), id)
```

- [ ] **Step 4: Build + tests**

Run: `cd backend && go build ./... && go test ./...`
Expected: builds; tests pass.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/write/repo.go
git commit -m "feat(backend): persist customer birthday/anniversary/notes"
```

---

## Phase B — TS API client

### Task B1: `listCustomers(q)` + `getCustomer(id)`

**Files:**
- Modify: `packages/api/src/client.ts` (interface ~147-150; impl ~388-393)

- [ ] **Step 1: Update the `Api` interface**

Replace (`packages/api/src/client.ts:147`):
```ts
  listCustomers: (page?: number, limit?: number) => Promise<ListResult<Customer>>
```
with:
```ts
  listCustomers: (page?: number, limit?: number, q?: string) => Promise<ListResult<Customer>>
  getCustomer: (id: string) => Promise<Customer>
```
(Place `getCustomer` right after `listCustomers` in the interface, before `createCustomer`.)

- [ ] **Step 2: Update the implementation**

Replace (`packages/api/src/client.ts:388-389`):
```ts
    listCustomers: (page = 1, limit = 500) =>
      list<Customer>(`${API}/customers`, { page, limit }),
```
with:
```ts
    listCustomers: (page = 1, limit = 50, q = '') =>
      list<Customer>(`${API}/customers`, q ? { page, limit, q } : { page, limit }),
    getCustomer: (id) => data<Customer>('GET', `${API}/customers/${id}`),
```
(`data<T>` unwraps the `{ data }` envelope — correct for `CustomerResponse`. Default limit lowered to 50 to match the new paginated UI; the export path passes an explicit `limit: 10000`.)

- [ ] **Step 3: Typecheck the package + dependents**

Run: `cd "C:/Users/MyBook Hype AMD/Downloads/mandalika-pos" && corepack pnpm --filter @mandalika/api build` (or the package's typecheck script; if none, `npx tsc -p packages/api`)
Expected: no type errors.

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/client.ts
git commit -m "feat(api-client): listCustomers q param + getCustomer"
```

---

## Phase C — Frontend list: server pagination + search

### Task C1: Wire server pagination, debounced search, row→detail

**Files:**
- Modify: `apps/backoffice/src/screens/Customers.tsx`

- [ ] **Step 1: Add pagination + search + selection state**

Near the existing `useState` block (after `const [search, setSearch] = useState('')`, ~line 66), add:
```tsx
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const [selectedId, setSelectedId] = useState<string | null>(null)
```

- [ ] **Step 2: Debounce the search term**

Add a small debounce so each keystroke doesn't hit the server. At the top of the component body add:
```tsx
  const [debouncedSearch, setDebouncedSearch] = useState('')
  useEffect(() => {
    const t = setTimeout(() => { setDebouncedSearch(search); setPage(1) }, 300)
    return () => clearTimeout(t)
  }, [search])
```
Ensure `useEffect` is imported: change `import { useState } from 'react'` to `import { useState, useEffect } from 'react'`.

- [ ] **Step 3: Switch the customers query to server pagination + search**

Replace (`apps/backoffice/src/screens/Customers.tsx:54`):
```tsx
  const cq = usePolledQuery<Customer[]>(() => api.listCustomers().then((r) => r.data), [])
```
with a query that returns the full `ListResult` and re-runs on page/size/search change:
```tsx
  const cq = usePolledQuery(
    () => api.listCustomers(page, pageSize, debouncedSearch),
    [page, pageSize, debouncedSearch],
  )
  const customers = cq.data?.data ?? []
  const total = cq.data?.meta?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
```

- [ ] **Step 4: Remove the now-dead client-side list derivation + filter**

Delete the old line (`apps/backoffice/src/screens/Customers.tsx:61`):
```tsx
  const customers = [...(cq.data ?? [])].sort((a, b) => b.totalSpent - a.totalSpent)
```
and delete the `filtered` derivation (~108-113):
```tsx
  const filtered = customers.filter(
    (c) =>
      c.name.toLowerCase().includes(search.toLowerCase()) ||
      c.phone.includes(search) ||
      (c.email || '').toLowerCase().includes(search.toLowerCase()),
  )
```
Then change every `filtered.` usage in the table (the `filtered.length === 0` empty-state check and `filtered.map(...)`) to `customers.`.

- [ ] **Step 5: Keep the header customer count honest**

The `PageHeader` subtitle uses `customers.length`. Replace with the server total:
```tsx
        subtitle={`${total} pelanggan terdaftar`}
```
And the export-disabled guard `customers.length === 0` is fine as-is (disables export only when the current page is empty — acceptable; the export fetches its own full set).

- [ ] **Step 6: Make a row open the detail page**

On the table `<tr>` for each customer (~line 344), add a click handler that opens detail, and keep the action buttons from triggering it via `stopPropagation`. Change:
```tsx
                        <tr key={c.id} className="hover:bg-gray-50">
```
to:
```tsx
                        <tr
                          key={c.id}
                          className="hover:bg-gray-50 cursor-pointer"
                          onClick={() => setSelectedId(c.id)}
                        >
```
Then on the actions `<td>`'s inner `<div>` (the `flex items-center justify-end gap-1`), add `onClick={(e) => e.stopPropagation()}` so edit/delete don't also open the detail. Remove the per-row "Riwayat" `IconButton` (the `ShoppingBag` button that calls `setHistCust`) — history now lives in the detail page.

- [ ] **Step 7: Render `<Pagination/>` under the table**

Import it: add `import { Pagination } from '../ui/Pagination'` (verify the export path; `Pagination` lives at `apps/backoffice/src/ui/Pagination.tsx` and may be re-exported from `../ui`). Immediately after the closing `</Card>` of the customers table (still inside the `customers` tab branch), add:
```tsx
          {!cq.loading && total > 0 && (
            <Pagination
              page={page}
              totalPages={totalPages}
              total={total}
              onChange={setPage}
              pageSize={pageSize}
              onPageSizeChange={(s) => { setPageSize(s); setPage(1) }}
            />
          )}
```

- [ ] **Step 8: Render the detail page as a full-screen swap (placeholder until Task D2)**

For now, add a guard near the top of the returned JSX so a selected customer short-circuits to a stub (replaced in D2). Just before `return (`’s main `<div>`, you'll wire the real component in Task D2 — for this task, confirm the state plumbs through by temporarily rendering nothing special. (No code here; D2 owns the swap. This step is a checkpoint: ensure the file still compiles with `selectedId` declared and used by the row click.)

- [ ] **Step 9: Typecheck + build**

Run: `cd apps/backoffice && npx tsc -b`
Expected: passes (an "unused `selectedId`" error is acceptable only until D2; if `tsc` is configured `noUnusedLocals`, temporarily reference it — D2 removes the need).
If `noUnusedLocals` blocks the build, proceed directly into Task D2 before running the build, then build once at the end of D2.

- [ ] **Step 10: Commit**

```bash
git add apps/backoffice/src/screens/Customers.tsx
git commit -m "feat(backoffice): customer list server pagination + debounced search"
```

---

## Phase D — Frontend: Customer Detail hub

### Task D1: Pure phone-dupe helper

**Files:**
- Create: `apps/backoffice/src/screens/customers/phone.ts`

- [ ] **Step 1: Write the helper**

```ts
import type { Customer } from '@mandalika/api'

/**
 * True when another customer (not `excludeId`) already has this phone.
 * Comparison ignores surrounding whitespace; empty phone is never a dupe.
 */
export function isDuplicatePhone(
  customers: ReadonlyArray<Pick<Customer, 'id' | 'phone'>>,
  phone: string,
  excludeId?: string | null,
): boolean {
  const p = phone.trim()
  if (!p) return false
  return customers.some((c) => c.id !== excludeId && c.phone.trim() === p)
}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/backoffice && npx tsc -b`
Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add apps/backoffice/src/screens/customers/phone.ts
git commit -m "feat(backoffice): pure isDuplicatePhone helper"
```

> No unit test: the backoffice has no test runner (see "Testing posture"). The helper is exercised via the live/visual check in Phase F.

---

### Task D2: CustomerDetail component + view swap

**Files:**
- Create: `apps/backoffice/src/screens/customers/CustomerDetail.tsx`
- Modify: `apps/backoffice/src/screens/Customers.tsx`

- [ ] **Step 1: Create the detail component**

Create `apps/backoffice/src/screens/customers/CustomerDetail.tsx`. It loads the fresh customer + their orders, renders a full-width two-column layout with a back button, header actions (Edit/Hapus), profile (incl. new fields), stats, relocated purchase history, and reserved placeholder sections for later sprints.

```tsx
import { useState } from 'react'
import type { Customer, Order } from '@mandalika/api'
import { format, parseISO } from 'date-fns'
import { id as idLocale } from 'date-fns/locale'
import {
  ArrowLeft, Edit2, Trash2, Phone, Mail, Star, ShoppingBag,
  ChevronDown, ChevronUp, Gift, Cake, CalendarHeart, Tag, History,
} from 'lucide-react'
import { api } from '../../api'
import { usePolledQuery } from '../../hooks/usePolledQuery'
import { TableSkeleton } from '../../components/Skeleton'
import { BRAND } from '../../lib/brand'
import { Button, Card, Badge, IconButton, EmptyState } from '../../ui'

interface CustomerDetailProps {
  customerId: string
  loyaltyEnabled: boolean
  tierEnabled: boolean
  tier: (spent: number) => { label: string; color: string }
  onBack: () => void
  onEdit: (c: Customer) => void
  onDelete: (id: string) => void
}

const fmtDate = (d?: string | null) =>
  d ? format(parseISO(d), 'dd MMM yyyy', { locale: idLocale }) : '—'

export default function CustomerDetail({
  customerId, loyaltyEnabled, tierEnabled, tier, onBack, onEdit, onDelete,
}: CustomerDetailProps) {
  const cq = usePolledQuery<Customer | null>(
    () => api.getCustomer(customerId).catch(() => null),
    [customerId],
  )
  const oq = usePolledQuery<Order[]>(
    () => api.listOrders({ customerId, limit: 200 }).then((r) => r.data),
    [customerId],
  )
  const [expanded, setExpanded] = useState<string | null>(null)
  const c = cq.data

  if (cq.loading && !c) {
    return (
      <div className="p-6">
        <button onClick={onBack} className="flex items-center gap-2 text-sm font-bold text-gray-500 hover:text-gray-900 mb-4">
          <ArrowLeft className="w-4 h-4" /> Kembali ke Pelanggan
        </button>
        <TableSkeleton />
      </div>
    )
  }
  if (!c) {
    return (
      <div className="p-6">
        <button onClick={onBack} className="flex items-center gap-2 text-sm font-bold text-gray-500 hover:text-gray-900 mb-4">
          <ArrowLeft className="w-4 h-4" /> Kembali ke Pelanggan
        </button>
        <Card><EmptyState icon={<Gift />} title="Pelanggan tidak ditemukan" /></Card>
      </div>
    )
  }

  const t = tier(c.totalSpent)
  const orders = oq.data ?? []

  return (
    <div className="p-6 space-y-5">
      <button onClick={onBack} className="flex items-center gap-2 text-sm font-bold text-gray-500 hover:text-gray-900">
        <ArrowLeft className="w-4 h-4" /> Kembali ke Pelanggan
      </button>

      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-4">
          <div className="w-14 h-14 rounded-2xl bg-gold-50 flex items-center justify-center flex-shrink-0">
            <span className="text-xl font-black text-gold-600">{c.name.charAt(0).toUpperCase()}</span>
          </div>
          <div>
            <h1 className="text-2xl font-black text-gray-900">{c.name}</h1>
            {tierEnabled && (
              <span className={`inline-block mt-1 px-2.5 py-1 text-xs font-bold rounded-lg ${t.color}`}>{t.label}</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" icon={<Edit2 className="w-4 h-4" />} onClick={() => onEdit(c)}>Edit</Button>
          <IconButton tone="danger" onClick={() => onDelete(c.id)}><Trash2 className="w-4 h-4" /></IconButton>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Left: profile */}
        <Card className="p-5 space-y-3 lg:col-span-1">
          <h3 className="font-black text-gray-900 text-sm">Profil</h3>
          <div className="flex items-center gap-2 text-sm text-gray-600"><Phone className="w-4 h-4 text-gray-400" /> {c.phone}</div>
          <div className="flex items-center gap-2 text-sm text-gray-600"><Mail className="w-4 h-4 text-gray-400" /> {c.email || '—'}</div>
          <div className="flex items-center gap-2 text-sm text-gray-600"><Cake className="w-4 h-4 text-gray-400" /> Ulang Tahun: {fmtDate(c.birthday)}</div>
          <div className="flex items-center gap-2 text-sm text-gray-600"><CalendarHeart className="w-4 h-4 text-gray-400" /> Hari Jadi: {fmtDate(c.anniversary)}</div>
          <div className="pt-2 border-t border-gray-100">
            <p className="text-xs font-bold text-gray-400 mb-1">Catatan</p>
            <p className="text-sm text-gray-600 whitespace-pre-wrap">{c.notes || '—'}</p>
          </div>
          {/* Reserved for SP-CRM-2 */}
          <div className="pt-2 border-t border-gray-100">
            <p className="flex items-center gap-1.5 text-xs font-bold text-gray-300"><Tag className="w-3.5 h-3.5" /> Tag &amp; Segmen — segera</p>
          </div>
        </Card>

        {/* Right: stats + history */}
        <div className="lg:col-span-2 space-y-5">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Card className="p-4">
              <p className="text-xs text-gray-400 font-bold">Total Belanja</p>
              <p className="text-lg font-black text-gray-900">{BRAND.currency.format(c.totalSpent)}</p>
            </Card>
            <Card className="p-4">
              <p className="text-xs text-gray-400 font-bold">Kunjungan</p>
              <p className="text-lg font-black text-gray-900">{c.visitCount}</p>
            </Card>
            {loyaltyEnabled && (
              <Card className="p-4">
                <p className="text-xs text-gray-400 font-bold">Poin</p>
                <p className="flex items-center gap-1 text-lg font-black text-gold-600"><Star className="w-4 h-4" />{c.points.toLocaleString('id-ID')}</p>
              </Card>
            )}
            <Card className="p-4">
              <p className="text-xs text-gray-400 font-bold">Kunjungan Terakhir</p>
              <p className="text-sm font-bold text-gray-900">{fmtDate(c.lastVisit)}</p>
            </Card>
          </div>

          <Card className="overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-100 flex items-center gap-2">
              <ShoppingBag className="w-4 h-4 text-gray-400" />
              <h3 className="font-black text-gray-900 text-sm">Riwayat Pembelian</h3>
            </div>
            {oq.loading ? (
              <TableSkeleton />
            ) : orders.length === 0 ? (
              <EmptyState icon={<ShoppingBag />} title="Belum ada transaksi" />
            ) : (
              <div className="divide-y divide-gray-50">
                {orders.map((o) => (
                  <div key={o.id}>
                    <div className="px-5 py-3 flex items-center gap-3 hover:bg-gray-50 cursor-pointer" onClick={() => setExpanded(expanded === o.id ? null : o.id)}>
                      <div className={`w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0 ${o.status === 'refunded' ? 'bg-red-50' : 'bg-gold-50'}`}>
                        <ShoppingBag className={`w-4 h-4 ${o.status === 'refunded' ? 'text-red-400' : 'text-gold-600'}`} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-bold text-gray-900 text-sm">{o.orderNumber}</p>
                        <p className="text-xs text-gray-400">{format(parseISO(o.createdAt), 'dd MMM yyyy HH:mm', { locale: idLocale })} · <span className="capitalize">{o.paymentMethod}</span></p>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <Badge tone={o.status === 'refunded' ? 'danger' : 'success'}>{o.status === 'refunded' ? 'Refund' : 'Selesai'}</Badge>
                        <p className="font-black text-gray-900 text-sm">{BRAND.currency.format(o.total)}</p>
                        {expanded === o.id ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
                      </div>
                    </div>
                    {expanded === o.id && (
                      <div className="px-5 pb-3 bg-gray-50 border-t border-gray-100">
                        <div className="pt-3 space-y-1">
                          {o.items.map((it, i) => (
                            <div key={i} className="flex justify-between text-sm">
                              <span className="text-gray-600">{it.productName} {it.variantSize} ×{it.quantity}</span>
                              <span className="font-bold text-gray-900">{BRAND.currency.format(it.subtotal)}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Card>

          {/* Reserved for SP-CRM-3 / SP-CRM-4 */}
          <Card className="p-5">
            <p className="flex items-center gap-1.5 text-xs font-bold text-gray-300"><History className="w-3.5 h-3.5" /> Poin (ledger) &amp; Timeline interaksi — segera</p>
          </Card>
        </div>
      </div>
    </div>
  )
}
```

> If any imported icon name (e.g. `Cake`, `CalendarHeart`, `CardHeart`) isn't in the installed `lucide-react`, substitute a present one (`Calendar`, `Heart`) — run the build to catch missing exports.

- [ ] **Step 2: Wire the view swap + actions in `Customers.tsx`**

In `Customers.tsx`, import the component at the top with the other imports:
```tsx
import CustomerDetail from './customers/CustomerDetail'
import { isDuplicatePhone } from './customers/phone'
```
Then, right after `if (!user)`-style early returns aren't used here — instead, just before the main `return (`, add a short-circuit:
```tsx
  if (selectedId) {
    return (
      <CustomerDetail
        customerId={selectedId}
        loyaltyEnabled={loyalty.enabled}
        tierEnabled={loyalty.tierEnabled}
        tier={tier}
        onBack={() => { setSelectedId(null); void cq.refetch() }}
        onEdit={(c) => { setEditing(c); setForm({ name: c.name, phone: c.phone, email: c.email || '', birthday: c.birthday || '', anniversary: c.anniversary || '', notes: c.notes || '' }); setErr(null); setOpen(true) }}
        onDelete={(cid) => setDelId(cid)}
      />
    )
  }
```
(The `form` shape gains `birthday/anniversary/notes` — Task E1 updates the `form` state type and modal accordingly; if doing D before E, temporarily include those keys in the initial `form` state so this compiles.)

- [ ] **Step 3: Remove the old `histCust` purchase-history modal**

Delete the `histCust` / `histExpanded` / `histQ` state (~91-99) and the entire `<Modal open={!!histCust} …>` block (~391-437) — history is now in the detail page. Remove the now-unused `ShoppingBag`, `ChevronDown`, `ChevronUp` imports **only if** no longer referenced elsewhere in the file (check first).

- [ ] **Step 4: Build**

Run: `cd apps/backoffice && npx tsc -b && npx vite build`
Expected: type-checks and builds. Fix any unused-import or missing-icon errors surfaced.

- [ ] **Step 5: Commit**

```bash
git add apps/backoffice/src/screens/customers/CustomerDetail.tsx apps/backoffice/src/screens/Customers.tsx
git commit -m "feat(backoffice): full-page customer detail hub (view swap)"
```

---

## Phase E — Edit modal: new fields + phone-dupe warning

### Task E1: Extend the Tambah/Edit modal

**Files:**
- Modify: `apps/backoffice/src/screens/Customers.tsx`

- [ ] **Step 1: Extend the `form` state shape**

Change the form state (`apps/backoffice/src/screens/Customers.tsx:72`):
```tsx
  const [form, setForm] = useState({ name: '', phone: '', email: '' })
```
to:
```tsx
  const [form, setForm] = useState({ name: '', phone: '', email: '', birthday: '', anniversary: '', notes: '' })
```
Update the "Tambah" button's reset (~line 210) and any other `setForm({ name:'', phone:'', email:'' })` to include the new keys:
```tsx
onClick={() => { setEditing(null); setForm({ name: '', phone: '', email: '', birthday: '', anniversary: '', notes: '' }); setErr(null); setOpen(true) }}
```
And the row edit button's `setForm({ name: c.name, phone: c.phone, email: c.email || '' })` (~376) to:
```tsx
setForm({ name: c.name, phone: c.phone, email: c.email || '', birthday: c.birthday || '', anniversary: c.anniversary || '', notes: c.notes || '' })
```

- [ ] **Step 2: Send the new fields on save**

In `saveCustomer` (~123), replace the body:
```tsx
      const body = { name: form.name.trim(), phone: form.phone.trim(), email: form.email.trim() }
```
with:
```tsx
      const body = {
        name: form.name.trim(),
        phone: form.phone.trim(),
        email: form.email.trim(),
        birthday: form.birthday,
        anniversary: form.anniversary,
        notes: form.notes.trim(),
      }
```

- [ ] **Step 3: Add the new inputs to the modal body**

In the Tambah/Edit `<Modal>` body (the block mapping over name/phone/email, ~451-457), keep the existing three text inputs and add date + textarea fields after them. Replace the `{err && …}` tail of that `<div className="space-y-4">` so it reads:
```tsx
          {[
            { label: 'Nama *', field: 'name' as const, type: 'text' },
            { label: 'No. Telepon *', field: 'phone' as const, type: 'tel' },
            { label: 'Email', field: 'email' as const, type: 'email' },
          ].map(({ label, field, type }) => (
            <Input key={field} label={label} type={type} value={form[field]} onChange={(e) => setForm((f) => ({ ...f, [field]: e.target.value }))} />
          ))}
          {phoneDupe && (
            <p className="text-xs text-amber-600">⚠ Nomor telepon ini sudah dipakai pelanggan lain. Tetap bisa disimpan.</p>
          )}
          <div className="grid grid-cols-2 gap-4">
            <Input label="Ulang Tahun" type="date" value={form.birthday} onChange={(e) => setForm((f) => ({ ...f, birthday: e.target.value }))} />
            <Input label="Hari Jadi" type="date" value={form.anniversary} onChange={(e) => setForm((f) => ({ ...f, anniversary: e.target.value }))} />
          </div>
          <Field label="Catatan">
            <textarea
              className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold-500/40 focus:border-gold-400"
              rows={3}
              value={form.notes}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
            />
          </Field>
          {err && <p className="text-sm text-red-600">{err}</p>}
```
(If the shared `ui` exports a `Textarea`, prefer it over the raw `<textarea>`; check `apps/backoffice/src/ui` exports.)

- [ ] **Step 4: Compute the soft phone-dupe flag**

After the `form` state and the customers query, add a derived flag. Because the list is now paginated, dupe-detection over only the current page is unreliable; fetch a lightweight full set once for the check, or reuse the export-style full fetch. Simplest correct approach: check against a dedicated full-list query used only for dupe detection:
```tsx
  const allForDupe = usePolledQuery<Customer[]>(
    () => api.listCustomers(1, 10000).then((r) => r.data),
    [],
  )
  const phoneDupe = isDuplicatePhone(allForDupe.data ?? [], form.phone, editing?.id ?? null)
```
(This mirrors the export path's `limit: 10000` full fetch. It polls on the default interval; acceptable for a warning. If you prefer to avoid a second full fetch, scope the warning to "best effort over loaded page" and say so in the UI — but the full fetch is the honest, correct choice.)

- [ ] **Step 5: Build**

Run: `cd apps/backoffice && npx tsc -b && npx vite build`
Expected: type-checks and builds.

- [ ] **Step 6: Commit**

```bash
git add apps/backoffice/src/screens/Customers.tsx
git commit -m "feat(backoffice): customer modal birthday/anniversary/notes + phone-dupe warning"
```

---

## Phase F — Verification

### Task F1: Build gates + deploy + authed live check

**Files:** none (verification only)

- [ ] **Step 1: Full local gate**

Run:
```bash
cd backend && go build ./... && go vet ./... && go test ./... && make gen-check
cd .. && corepack pnpm --filter @mandalika/api build
cd apps/backoffice && npx tsc -b && npx vite build
```
Expected: all green; `make gen-check` clean.

- [ ] **Step 2: Deploy backend**

Run: `gcloud run deploy mandalika-pos --source backend --region asia-southeast2 --quiet`
Then check readiness: `curl -fsS https://<cloud-run-url>/readyz` (use the project's known URL).
Expected: `ok`. (Migration 0025 applies on startup. A first-write-after-idle Neon transient is possible — retry warm.)

- [ ] **Step 3: Authed live check (requires one-time user OK to read SEED_ADMIN_PASSWORD)**

Ask the user to authorize reading `SEED_ADMIN_PASSWORD` from Secret Manager (never print it). Write a throwaway `_verify_crm1.mjs` (pattern: prior `_verify_*.mjs` scripts) that logs in and asserts:
1. `POST /customers` with `{name, phone, email, birthday, anniversary, notes}` → `GET /customers/{id}` returns all fields round-tripped.
2. `PUT /customers/{id}` changing birthday/notes → persists.
3. `GET /customers?q=<substring>` narrows by name AND phone AND email; `meta.total` reflects the filtered count.
4. `GET /customers?page=1&limit=1` → `meta` echoes page/limit; second page differs.
5. Cleanup: delete the temp customer.

Run: `node _verify_crm1.mjs`
Expected: all assertions pass. Delete the script after.

- [ ] **Step 4: Commit any verification fixes; report results honestly**

If the live check reveals a bug, fix it (new task), re-run. Report pass/fail with the actual output (rule: verify on failure; admit gaps).

- [ ] **Step 5: USER-PENDING visual walkthrough (document, don't self-claim)**

Record in the handoff that the user should hard-refresh the live backoffice and confirm: pagination dropdown + page nav; typing in search narrows server-side; row click → full-page detail with "← Kembali"; detail shows profile (incl. birthday/anniversary/notes), stats, purchase history, and the reserved "segera" sections; edit modal has the new fields; saving a duplicate phone shows the amber warning but still saves.

---

## Self-Review (completed)

- **Spec coverage:** pagination (C1) ✓; server search (A3+C1) ✓; birthday/anniversary/notes (A1/A2/A3/A4/B1/E1) ✓; full-page detail via view swap (D2) ✓; relocate purchase history (D2) ✓; reserved CRM placeholders (D2) ✓; soft phone-dupe warning (D1/E1) ✓; sort change to total_spent (A3) ✓; getCustomer in client (B1) ✓; backoffice-only / additive POS-safe model (A1) ✓.
- **Placeholders:** none — every code step shows real code; the only deferred bits are explicitly later-sprint placeholders rendered as "segera" labels.
- **Type consistency:** `Customers(ctx,page,limit,q)` (A3) matches the handler call (A3); write `Customer` fields `Birthday/Anniversary/Notes` (A4) match openapi `CustomerInput` keys (A2) and the TS `form` keys/`body` (E1); `isDuplicatePhone(customers, phone, excludeId)` (D1) matches its call (E1); `listCustomers(page,limit,q)` + `getCustomer(id)` (B1) match usages (C1/D2).
- **Cross-task ordering note:** D2 and E1 both touch `form` shape; if executed D2-before-E1, include the new `form` keys when wiring D2's `onEdit` (called out in D2 Step 2).
