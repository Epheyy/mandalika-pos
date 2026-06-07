# SP-CRM-2 — Customer Scale Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the customer list index-backed at 100k–500k rows (trigram search + sort toggle), replace SP-CRM-1's 10k-row dup-check with a server-side exact-phone lookup, and add a cashier on-demand customer lookup endpoint as the seam for SP-CRM-3.

**Architecture:** Backend/backoffice only (no APK). Migration 0026 adds `pg_trgm` + trigram GIN indexes (name/phone/email) and two sort indexes. The list read gains a `sort` param (both orderings index-backed). Two new read endpoints (`/customers/by-phone`, `/sync/customers/lookup`) reuse the existing `CustomerListResponse`. The bulk-sync `Customers(1,100000)` payload is intentionally left in place (removed in SP-CRM-3 with a coordinated APK).

**Tech Stack:** Go (chi, pgx, oapi-codegen), Postgres (Neon, pg_trgm), React + TS (Vite) backoffice, shared `@mandalika/api`.

**Spec:** `docs/superpowers/specs/2026-06-07-crm-sp2-customer-scale-foundation-design.md`

---

## Testing posture (read first)
- **Backend:** DB-bound queries are verified by `go build`/`go vet`/`go test ./...` (regression) then an **authed live check** (Phase D) — repo norm. The `Customers` signature change must compile at the handler AND `sync.go` call sites.
- **Frontend:** the backoffice has **no test runner** — verification is `tsc -b` + `vite build` + live + visual.
- **Index caveat:** the live DB is small, so `EXPLAIN` may show seq scans (planner prefers them on tiny tables). Prove indexes **exist** + are **usable** via `SET enable_seqscan=off` — can't demonstrate real at-scale plans.
- **Commits:** `git add <paths>` then `git commit` as SEPARATE commands (chained `&&` trips the hook). Never `--no-verify`. Conventional-commit messages, no attribution footer.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `backend/internal/db/migrations/0026_customer_scale_indexes.sql` | pg_trgm + trigram + sort indexes | Create |
| `backend/internal/read/repo.go` | `Customers()` gains `sort`; new `CustomerByPhone`, `CustomerLookup` | Modify |
| `backend/internal/handlers/handlers.go` | `Customers` reads `sort`; new `CustomersByPhone`, `CustomersLookup` | Modify |
| `backend/internal/server/server.go` | register the 2 new routes | Modify |
| `backend/internal/sync/sync.go` | 1-line: new `Customers(...,"")` arg | Modify |
| `backend/api/openapi.yaml` + `internal/api/api.gen.go` | `sort` param + 2 ops; regen | Modify |
| `packages/api/src/client.ts` | `sort` on listCustomers + 2 new methods | Modify |
| `apps/backoffice/src/screens/Customers.tsx` | sort toggle + server dup-check rewire | Modify |
| `apps/backoffice/src/screens/customers/phone.ts` | retire if unused after rewire | Delete (conditional) |

---

## Phase A — Backend

### Task A1: Migration 0026 (extension + indexes)

**Files:** Create `backend/internal/db/migrations/0026_customer_scale_indexes.sql`

- [ ] **Step 1: Confirm next slot**

Run: `git ls-files "backend/internal/db/migrations/" | sort | tail -3`
Expected: highest is `0025_*.sql`; no `0026_*`.

- [ ] **Step 2: Create the migration**

```sql
-- 0026_customer_scale_indexes.sql
-- SP-CRM-2: make the customer list index-backed at 100k-500k rows.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Substring search (ILIKE '%q%') across the 3 searched fields. Separate GIN
-- trigram indexes preserve the existing OR semantics (planner BitmapOrs them).
CREATE INDEX idx_customers_name_trgm  ON customers USING gin (name  gin_trgm_ops);
CREATE INDEX idx_customers_phone_trgm ON customers USING gin (phone gin_trgm_ops);
CREATE INDEX idx_customers_email_trgm ON customers USING gin (email gin_trgm_ops);

-- Sort-toggle support (belanja = total_spent, terbaru = created_at).
CREATE INDEX idx_customers_spent   ON customers (total_spent DESC, created_at DESC);
CREATE INDEX idx_customers_created ON customers (created_at DESC);
```

- [ ] **Step 3: Build (embeds the migration)**

Run: `cd backend && go build ./...`
Expected: builds.

- [ ] **Step 4: Commit**

```bash
git add backend/internal/db/migrations/0026_customer_scale_indexes.sql
git commit -m "feat(backend): migration 0026 customer trigram + sort indexes"
```

---

### Task A2: Read layer — sort param + by-phone + lookup

**Files:** Modify `backend/internal/read/repo.go` (`Customers` at lines 644-651)

- [ ] **Step 1: Add `sort` to `Customers()` and add the two new reads**

Replace (`backend/internal/read/repo.go:644-651`):
```go
func (r *Repo) Customers(ctx context.Context, page, limit int, q string) ([]api.Customer, int, error) {
	const sql = `SELECT ` + customerObj + `, count(*) OVER() AS total
		   FROM customers
		  WHERE ($3 = '' OR name ILIKE '%' || $3 || '%' OR phone ILIKE '%' || $3 || '%' OR email ILIKE '%' || $3 || '%')
		  ORDER BY total_spent DESC, created_at DESC
		  OFFSET $1 LIMIT $2`
	return listJSON[api.Customer](ctx, r.Pool, sql, off(page, limit), limit, q)
}
```
with:
```go
func (r *Repo) Customers(ctx context.Context, page, limit int, q, sort string) ([]api.Customer, int, error) {
	// `order` is a fixed internal string (never user input) — safe to concatenate.
	order := `ORDER BY total_spent DESC, created_at DESC`
	if sort == "terbaru" {
		order = `ORDER BY created_at DESC`
	}
	sql := `SELECT ` + customerObj + `, count(*) OVER() AS total
		   FROM customers
		  WHERE ($3 = '' OR name ILIKE '%' || $3 || '%' OR phone ILIKE '%' || $3 || '%' OR email ILIKE '%' || $3 || '%')
		  ` + order + `
		  OFFSET $1 LIMIT $2`
	return listJSON[api.Customer](ctx, r.Pool, sql, off(page, limit), limit, q)
}

// CustomerByPhone returns 0+ customers with this exact (trimmed) phone — backs
// the backoffice soft dup-check via idx_customers_phone.
func (r *Repo) CustomerByPhone(ctx context.Context, phone string) ([]api.Customer, error) {
	rows, _, err := listJSON[api.Customer](ctx, r.Pool,
		`SELECT `+customerObj+`, count(*) OVER() AS total FROM customers WHERE phone = $1`, phone)
	return rows, err
}

// CustomerLookup is the on-demand cashier search (SP-CRM-3 seam): capped,
// exact-phone matches ranked first.
func (r *Repo) CustomerLookup(ctx context.Context, q string, limit int) ([]api.Customer, error) {
	if limit < 1 || limit > 20 {
		limit = 20
	}
	rows, _, err := listJSON[api.Customer](ctx, r.Pool,
		`SELECT `+customerObj+`, count(*) OVER() AS total FROM customers
		  WHERE phone = $1 OR name ILIKE '%' || $1 || '%' OR phone ILIKE '%' || $1 || '%'
		  ORDER BY (phone = $1) DESC, name
		  LIMIT $2`, q, limit)
	return rows, err
}
```

- [ ] **Step 2: Build**

Run: `cd backend && go build ./...`
Expected: FAILS — `Customers` now needs 5 args at its call sites (handler + sync.go). That's fixed in A3. (If you prefer a green build per task, do A3 before re-running.)

---

### Task A3: Handlers, routes, sync call-site

**Files:**
- Modify `backend/internal/handlers/handlers.go` (`Customers` at 247-257)
- Modify `backend/internal/server/server.go` (groups at 89-155)
- Modify `backend/internal/sync/sync.go:103`

- [ ] **Step 1: Update the `Customers` handler + add two handlers**

Replace (`backend/internal/handlers/handlers.go:247-257`):
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
with:
```go
func (h *Handlers) Customers(w http.ResponseWriter, r *http.Request) {
	h.cached(w, r, ckey(r), func() (any, int, error) {
		p, l := pageLimit(r)
		q := strings.TrimSpace(r.URL.Query().Get("q"))
		sort := r.URL.Query().Get("sort")
		rows, total, err := h.Repo.Customers(r.Context(), p, l, q, sort)
		if err != nil {
			return nil, 500, err
		}
		return api.CustomerListResponse{Data: rows, Meta: meta(total, p, l)}, 200, nil
	})
}

func (h *Handlers) CustomersByPhone(w http.ResponseWriter, r *http.Request) {
	h.cached(w, r, ckey(r), func() (any, int, error) {
		phone := strings.TrimSpace(r.URL.Query().Get("phone"))
		rows, err := h.Repo.CustomerByPhone(r.Context(), phone)
		if err != nil {
			return nil, 500, err
		}
		return api.CustomerListResponse{Data: rows, Meta: meta(len(rows), 1, len(rows))}, 200, nil
	})
}

func (h *Handlers) CustomersLookup(w http.ResponseWriter, r *http.Request) {
	h.cached(w, r, ckey(r), func() (any, int, error) {
		q := strings.TrimSpace(r.URL.Query().Get("q"))
		limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
		rows, err := h.Repo.CustomerLookup(r.Context(), q, limit)
		if err != nil {
			return nil, 500, err
		}
		return api.CustomerListResponse{Data: rows, Meta: meta(len(rows), 1, len(rows))}, 200, nil
	})
}
```
(`strconv` and `strings` are already imported in `handlers.go` — `pageLimit` uses both.)

- [ ] **Step 2: Register the cashier lookup route**

In `backend/internal/server/server.go`, after the sync reads (`r.Get("/sync/outlet-transfers", h.GetOutletTransfers)`, line 134), add:
```go
			r.Get("/sync/customers/lookup", h.CustomersLookup)
```

- [ ] **Step 3: Register the by-phone route in the manage_customers group**

In the `manage_customers` group (`backend/internal/server/server.go:150-155`), add a GET alongside the writes:
```go
			r.Group(func(r chi.Router) {
				r.Use(mw.RequirePermission("manage_customers"))
				r.Get("/customers/by-phone", h.CustomersByPhone)
				r.Post("/customers", h.CreateCustomer)
				r.Put("/customers/{id}", h.UpdateCustomer)
				r.Delete("/customers/{id}", h.DeleteCustomer)
			})
```
(chi resolves the static `/customers/by-phone` ahead of the `/customers/{id}` param route registered in the read group — no conflict.)

- [ ] **Step 4: Fix the sync call-site**

In `backend/internal/sync/sync.go:103`, change:
```go
	if b.Customers, _, err = e.Read.Customers(ctx, 1, 100000, ""); err != nil {
```
to:
```go
	if b.Customers, _, err = e.Read.Customers(ctx, 1, 100000, "", ""); err != nil {
```
(Bulk payload intentionally unchanged — removal is SP-CRM-3.)

- [ ] **Step 5: Build + vet + test**

Run: `cd backend && go build ./... && go vet ./... && go test ./...`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add backend/internal/read/repo.go backend/internal/handlers/handlers.go backend/internal/server/server.go backend/internal/sync/sync.go
git commit -m "feat(backend): customer sort toggle + by-phone + on-demand lookup endpoints"
```

---

### Task A4: OpenAPI + regen

**Files:** Modify `backend/api/openapi.yaml`; regen `backend/internal/api/api.gen.go`

- [ ] **Step 1: Add `sort` to `listCustomers`**

In `backend/api/openapi.yaml`, the `listCustomers` operation's `parameters:` block (added in SP-CRM-1, has page/limit/q) — add one line:
```yaml
        - { in: query, name: sort, schema: { type: string } }
```

- [ ] **Step 2: Add the two new operations**

Add a `/api/v1/customers/by-phone` path and a `/api/v1/sync/customers/lookup` path. Place `by-phone` near the other `/api/v1/customers*` paths and `lookup` near the sync paths. Use the existing `CustomerListResponse` response schema:
```yaml
  /api/v1/customers/by-phone:
    get:
      operationId: getCustomersByPhone
      tags: [customers]
      summary: Find customers by exact phone (dup-check)
      parameters:
        - { in: query, name: phone, required: true, schema: { type: string } }
      responses:
        '200':
          description: customers
          content:
            application/json:
              schema: { $ref: '#/components/schemas/CustomerListResponse' }
  /api/v1/sync/customers/lookup:
    get:
      operationId: lookupCustomers
      tags: [sync]
      summary: On-demand customer lookup (cashier)
      parameters:
        - { in: query, name: q, schema: { type: string } }
        - { in: query, name: limit, schema: { type: integer } }
      responses:
        '200':
          description: customers
          content:
            application/json:
              schema: { $ref: '#/components/schemas/CustomerListResponse' }
```
(Match the YAML style of neighbouring operations — check an existing GET op like `listCustomers` and mirror its indentation/format exactly.)

- [ ] **Step 3: Regenerate + gen-check**

Run:
```bash
cd backend && go tool oapi-codegen -config api/oapi-codegen.yaml api/openapi.yaml
cd .. && corepack pnpm --filter @mandalika/api gen
cd backend && make gen-check
```
Expected: `ListCustomersParams` gains `Sort *string`; `api.gen.go` builds; `make gen-check` exits 0 (no drift).

- [ ] **Step 4: Build**

Run: `cd backend && go build ./...`
Expected: builds.

- [ ] **Step 5: Commit**

```bash
git add backend/api/openapi.yaml backend/internal/api/api.gen.go
git commit -m "feat(api): listCustomers sort param + by-phone + lookup ops"
```

---

## Phase B — TS client

### Task B1: sort param + by-phone + lookup methods

**Files:** Modify `packages/api/src/client.ts` (interface 147-148; impl 389-391)

- [ ] **Step 1: Update the interface**

Replace (`packages/api/src/client.ts:147-148`):
```ts
  listCustomers: (page?: number, limit?: number, q?: string) => Promise<ListResult<Customer>>
  getCustomer: (id: string) => Promise<Customer>
```
with:
```ts
  listCustomers: (page?: number, limit?: number, q?: string, sort?: string) => Promise<ListResult<Customer>>
  getCustomer: (id: string) => Promise<Customer>
  getCustomersByPhone: (phone: string) => Promise<Customer[]>
  lookupCustomers: (q: string, limit?: number) => Promise<Customer[]>
```

- [ ] **Step 2: Update the implementation**

Replace (`packages/api/src/client.ts:389-391`):
```ts
    listCustomers: (page = 1, limit = 50, q = '') =>
      list<Customer>(`${API}/customers`, q ? { page, limit, q } : { page, limit }),
    getCustomer: (id) => data<Customer>('GET', `${API}/customers/${id}`),
```
with:
```ts
    listCustomers: (page = 1, limit = 50, q = '', sort = '') =>
      list<Customer>(`${API}/customers`, {
        page,
        limit,
        ...(q ? { q } : {}),
        ...(sort ? { sort } : {}),
      }),
    getCustomer: (id) => data<Customer>('GET', `${API}/customers/${id}`),
    getCustomersByPhone: (phone) =>
      list<Customer>(`${API}/customers/by-phone`, { phone }).then((r) => r.data),
    lookupCustomers: (q, limit = 20) =>
      list<Customer>(`${API}/sync/customers/lookup`, { q, limit }).then((r) => r.data),
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc -p packages/api --noEmit`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/client.ts packages/api/src/schema.d.ts
git commit -m "feat(api-client): listCustomers sort + getCustomersByPhone + lookupCustomers"
```
(If `git status` shows `schema.d.ts` was regenerated by A3's `gen` step, include it; if it wasn't modified, drop it from the `git add`.)

---

## Phase C — Frontend

### Task C1: Sort toggle + server-side dup-check rewire

**Files:** Modify `apps/backoffice/src/screens/Customers.tsx`; conditionally delete `apps/backoffice/src/screens/customers/phone.ts`

- [ ] **Step 1: Add sort state**

After `const [pageSize, setPageSize] = useState(25)` (line 55), add:
```tsx
  const [sort, setSort] = useState<'belanja' | 'terbaru'>('belanja')
```

- [ ] **Step 2: Thread sort into the list query**

Replace (`apps/backoffice/src/screens/Customers.tsx:64-66`):
```tsx
  const cq = usePolledQuery(
    () => api.listCustomers(page, pageSize, debouncedSearch),
    [page, pageSize, debouncedSearch],
  )
```
with:
```tsx
  const cq = usePolledQuery(
    () => api.listCustomers(page, pageSize, debouncedSearch, sort),
    [page, pageSize, debouncedSearch, sort],
  )
```

- [ ] **Step 3: Replace the full-list dup-check with a server-side one**

Remove the import (`apps/backoffice/src/screens/Customers.tsx:22`):
```tsx
import { isDuplicatePhone } from './customers/phone'
```
Replace the `allForDupe` query + `phoneDupe` derivation (lines 92-96):
```tsx
  const allForDupe = usePolledQuery<Customer[]>(
    () => open ? api.listCustomers(1, 10000).then((r) => r.data) : Promise.resolve([]),
    [open],
  )
  const phoneDupe = isDuplicatePhone(allForDupe.data ?? [], form.phone, editing?.id ?? null)
```
with a debounced server check:
```tsx
  const [phoneDupe, setPhoneDupe] = useState(false)
  useEffect(() => {
    if (!open) { setPhoneDupe(false); return }
    const phone = form.phone.trim()
    if (!phone) { setPhoneDupe(false); return }
    const t = setTimeout(async () => {
      try {
        const matches = await api.getCustomersByPhone(phone)
        setPhoneDupe(matches.some((m) => m.id !== (editing?.id ?? null)))
      } catch {
        setPhoneDupe(false)
      }
    }, 300)
    return () => clearTimeout(t)
  }, [open, form.phone, editing?.id])
```
(`Customer` type import may become unused — if `tsc` flags it, remove `Customer` from the import list. `useEffect` is already imported from SP-CRM-1.)

- [ ] **Step 4: Add the sort toggle control**

Find the search-box row (the `relative max-w-sm` search wrapper, ~line 318 region from SP-CRM-1). Wrap the search input and a new toggle in a flex row so they sit together; add, right after the search input's closing element:
```tsx
          <div className="flex items-center gap-1 ml-3">
            {([['belanja', 'Belanja Tertinggi'], ['terbaru', 'Terbaru']] as const).map(([val, label]) => (
              <button
                key={val}
                type="button"
                onClick={() => { setSort(val); setPage(1) }}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold border-2 transition ${
                  sort === val ? 'bg-gold-600 text-white border-gold-600' : 'border-gray-200 text-gray-600 hover:bg-gray-50'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
```
Ensure the search input and this toggle share a flex container (e.g. wrap both in `<div className="flex items-center flex-wrap gap-2">`); match the surrounding markup so layout stays clean. Verify against the file's actual structure when editing.

- [ ] **Step 5: Delete the now-unused phone helper (if unused)**

Run: `grep -rn "customers/phone" apps/backoffice/src` (or use the editor's search).
Expected: no remaining imports of `./customers/phone`.
If none remain: `git rm apps/backoffice/src/screens/customers/phone.ts`
If something still imports it, leave the file and note why.

- [ ] **Step 6: Typecheck + build**

Run: `cd apps/backoffice && npx tsc -b && npx vite build`
Expected: both succeed. Fix any unused-import errors surfaced (`isDuplicatePhone`, possibly `Customer`).

- [ ] **Step 7: Commit**

```bash
git add apps/backoffice/src/screens/Customers.tsx
git commit -m "feat(backoffice): customer list sort toggle + server-side phone dup-check"
```
(If you deleted `phone.ts`, it's already staged by `git rm` — include it: `git add -A apps/backoffice/src/screens/customers/`.)

---

## Phase D — Verification

### Task D1: Gates + deploy + authed live check

**Files:** none

- [ ] **Step 1: Full local gate**

Run:
```bash
cd backend && go build ./... && go vet ./... && go test ./... && make gen-check
cd .. && npx tsc -p packages/api --noEmit
cd apps/backoffice && npx tsc -b && npx vite build
```
Expected: all green; gen-check clean.

- [ ] **Step 2: Deploy + readiness**

Run: `gcloud run deploy mandalika-pos --source backend --region asia-southeast2 --quiet`
Then: `curl -fsS https://mandalika-pos-538849926142.asia-southeast2.run.app/readyz`
Expected: `{"data":{"status":"ready"}}` (migration 0026 applies on startup; a first-write-after-idle Neon transient is possible — retry).

- [ ] **Step 3: Authed live check (one-time SEED_ADMIN_PASSWORD OK; admin email = `admin@mandalika.test`)**

Write a throwaway `_verify_crm2.mjs` (mirror the SP-CRM-1 verify pattern: login → bearer `data.access`). Assert:
1. `GET /customers?sort=belanja&limit=5` and `?sort=terbaru&limit=5` both return 200 and **differently ordered** lists (compare first-row ids; if total ≥ 2 they should differ when spend/created order diverges).
2. `GET /customers/by-phone?phone=<an existing exact phone>` returns that customer; `?phone=__none__` → empty `data`.
3. `GET /sync/customers/lookup?q=<name substring>&limit=3` returns ≤ 3, exact-phone match ranked first when `q` is a phone; no-token → 401.
4. `GET /customers?q=<substring>` still returns correct matches across name/phone/email.

Run: `node _verify_crm2.mjs`. Expected: all pass. Delete the script after.

- [ ] **Step 4: Index existence + usability (honest check)**

With the admin DB connection (or a psql via the DATABASE_URL secret — ask before reading it), run:
```sql
SELECT indexname FROM pg_indexes WHERE tablename='customers';
SET enable_seqscan=off;
EXPLAIN SELECT * FROM customers WHERE name ILIKE '%a%' ORDER BY total_spent DESC LIMIT 25;
```
Expected: the 5 new indexes listed; with seqscan off, the plan uses the trigram/sort indexes (proves usability). **Report plainly** that at-scale plans aren't demonstrable on the small test DB.

- [ ] **Step 5: Report + USER-PENDING visual**

Document for the handoff: hard-refresh the backoffice → Pelanggan; confirm the **Belanja Tertinggi / Terbaru** toggle reorders the list, search still works, and the edit modal's phone-dup amber warning still appears (now server-backed) when entering an existing phone.

---

## Self-Review (completed)

- **Spec coverage:** trigram + sort indexes (A1) ✓; index-backed search/sort (A1+A2) ✓; sort toggle (A2/A3/B1/C1) ✓; server-side dup-check replacing 10k fetch (A2/A3/B1/C1) ✓; on-demand lookup endpoint seam (A2/A3/A4/B1) ✓; sync call-site updated, bulk payload left intact (A3) ✓; deferred items untouched ✓.
- **Placeholder scan:** none — all code steps show real code; the EXPLAIN caveat is a stated limitation, not a TODO.
- **Type consistency:** `Customers(ctx,page,limit,q,sort)` (A2) matches handler + sync call-sites (A3); `CustomerByPhone`/`CustomerLookup` (A2) match handlers (A3) + routes (A3) + openapi ops (A4) + client methods (B1: `getCustomersByPhone`/`lookupCustomers`); `sort` values `belanja`/`terbaru` consistent across read (A2), client default `''`→belanja (B1), and the toggle (C1).
- **Note:** A2 alone leaves the build red (signature change) — A3 restores green; called out in A2 Step 2.
