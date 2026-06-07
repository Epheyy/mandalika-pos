# SP-CRM-3 — POS On-Demand Customer Attach Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the POS cashier attach existing customers via on-demand online lookup (with an offline per-outlet cache) instead of bulk-syncing the whole customer table, rolled out APK-first so no deployed device degrades.

**Architecture:** Two-phase, zero-degradation rollout. Phase 1 (deploy now): POS APK gains on-demand `api.lookupCustomers` merged with the local cache (offline falls back to cache); backend adds duplicate detection on `customer_create` + the bounded per-outlet recent-customer read (built, NOT wired). Phase 2 (user-gated, after fleet updates): one-line flip of the sync bootstrap to the bounded read — where the heavy-load win lands.

**Tech Stack:** Go (pgx), Postgres (Neon), React + TS POS (Vite) on a SyncEngine offline-first model, shared `@mandalika/api`.

**Spec:** `docs/superpowers/specs/2026-06-07-crm-sp3-pos-ondemand-customer-attach-design.md`

---

## Testing posture (read first)
- **Backend:** DB-bound reads/writes verified by `go build`/`go vet`/`go test ./...` then an **authed live check** (Phase C) — repo norm.
- **POS:** no unit-test runner — verified by `tsc -b` + `vite build`, then an **on-device check on the new APK**. The APK release build is **user-gated** (ask before dispatching `android-release.yml`).
- **Phase 2 (Task D1) is GATED:** do NOT deploy the cutover until the user confirms the APK fleet is updated. It can't be fully verified until then; Phase 1 verifies the bounded read in isolation.
- **Commits:** `git add <paths>` then `git commit` as SEPARATE commands (chained `&&` trips the hook). Never `--no-verify`. Conventional commits, no attribution footer.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `backend/internal/db/migrations/0027_customer_dup_candidates.sql` | dup-candidates table + orders composite index | Create |
| `backend/internal/read/repo.go` | `RecentCustomersForOutlet` (built, unwired) | Modify |
| `backend/internal/service/order.go` | dup-candidate detection in `CreateCustomer` | Modify |
| `backend/internal/sync/sync.go` | Phase-2 bootstrap flip (GATED) | Modify (Task D1 only) |
| `apps/pos/src/cashier/CashierScreen.tsx` | on-demand lookup + merge into picker list | Modify |

---

## Phase A — Backend (Phase-1-safe; deploy now)

### Task A1: Migration 0027

**Files:** Create `backend/internal/db/migrations/0027_customer_dup_candidates.sql`

- [ ] **Step 1: Confirm next slot**

Run: `git ls-files "backend/internal/db/migrations/" | sort | tail -3`
Expected: highest is `0026_*.sql`; no `0027_*`.

- [ ] **Step 2: Create the migration**

```sql
-- 0027_customer_dup_candidates.sql
-- SP-CRM-3: flag offline-miss duplicate customers (same phone) for a future
-- backoffice merge tool. Review-queue-ready via `status`.
CREATE TABLE customer_dup_candidates (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  new_customer_id      uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  existing_customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  phone                text NOT NULL,
  status               text NOT NULL DEFAULT 'pending', -- pending | merged | dismissed
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_dup_candidates_status ON customer_dup_candidates(status);

-- Supports RecentCustomersForOutlet on the hot, multi-million-row orders table.
CREATE INDEX idx_orders_outlet_created ON orders (outlet_id, created_at DESC);
```

- [ ] **Step 3: Build (embeds migration)**

Run: `cd backend && go build ./...`
Expected: builds.

- [ ] **Step 4: Commit**

```bash
git add backend/internal/db/migrations/0027_customer_dup_candidates.sql
git commit -m "feat(backend): migration 0027 customer dup-candidates + orders outlet/created index"
```

---

### Task A2: Duplicate detection on customer_create

**Files:** Modify `backend/internal/service/order.go` (`CreateCustomer` at 422-438)

- [ ] **Step 1: Add best-effort dup detection after the upsert**

Replace (`backend/internal/service/order.go:426-437`):
```go
	var id string
	err := s.Pool.QueryRow(ctx, `
		INSERT INTO customers (id, name, phone, email)
		VALUES (COALESCE(NULLIF($1,'')::uuid, gen_random_uuid()), $2, $3, $4)
		ON CONFLICT (id) DO UPDATE
		  SET name = EXCLUDED.name, phone = EXCLUDED.phone, email = EXCLUDED.email
		RETURNING id`,
		in.ID, in.Name, in.Phone, nullStr(in.Email)).Scan(&id)
	if err != nil {
		return "", fmt.Errorf("create customer: %w", err)
	}
	return id, nil
```
with:
```go
	var id string
	err := s.Pool.QueryRow(ctx, `
		INSERT INTO customers (id, name, phone, email)
		VALUES (COALESCE(NULLIF($1,'')::uuid, gen_random_uuid()), $2, $3, $4)
		ON CONFLICT (id) DO UPDATE
		  SET name = EXCLUDED.name, phone = EXCLUDED.phone, email = EXCLUDED.email
		RETURNING id`,
		in.ID, in.Name, in.Phone, nullStr(in.Email)).Scan(&id)
	if err != nil {
		return "", fmt.Errorf("create customer: %w", err)
	}
	// SP-CRM-3: if another customer already has this phone, record a duplicate
	// candidate for the future backoffice merge tool. Best-effort — never blocks
	// the create (the in-flight order depends on it). The customer row is still
	// created with the client id, so the order's customerId stays consistent.
	var existingID string
	if derr := s.Pool.QueryRow(ctx,
		`SELECT id FROM customers WHERE phone = $1 AND id <> $2 ORDER BY created_at LIMIT 1`,
		in.Phone, id).Scan(&existingID); derr == nil && existingID != "" {
		_, _ = s.Pool.Exec(ctx,
			`INSERT INTO customer_dup_candidates (new_customer_id, existing_customer_id, phone)
			 VALUES ($1, $2, $3)`, id, existingID, in.Phone)
	}
	return id, nil
```

- [ ] **Step 2: Build + vet + test**

Run: `cd backend && go build ./... && go vet ./... && go test ./...`
Expected: all green.

- [ ] **Step 3: Commit**

```bash
git add backend/internal/service/order.go
git commit -m "feat(backend): flag duplicate-phone customers on offline customer_create"
```

---

### Task A3: Bounded per-outlet recent-customer read (built, not wired)

**Files:** Modify `backend/internal/read/repo.go` (near the customer reads, ~644-656)

- [ ] **Step 1: Add `RecentCustomersForOutlet`**

Add after the `Customer(...)` function (`backend/internal/read/repo.go`, after line 656):
```go
// RecentCustomersForOutlet returns the bounded set of customers who transacted
// at outletID within the last `days`, most-recent-first, capped at `limit`. This
// replaces the global bulk customer sync (SP-CRM-3 Phase 2). Reuses customerObj.
// (`limit`, not `cap`, to avoid shadowing the Go builtin.)
func (r *Repo) RecentCustomersForOutlet(ctx context.Context, outletID string, days, limit int) ([]api.Customer, error) {
	rows, _, err := listJSON[api.Customer](ctx, r.Pool,
		`SELECT `+customerObj+`, count(*) OVER() AS total
		   FROM customers c
		   JOIN (
		     SELECT customer_id, max(created_at) AS last_seen
		       FROM orders
		      WHERE outlet_id = $1 AND customer_id IS NOT NULL
		        AND created_at >= now() - make_interval(days => $2)
		   GROUP BY customer_id
		   ORDER BY last_seen DESC
		      LIMIT $3
		   ) recent ON recent.customer_id = c.id
		  ORDER BY recent.last_seen DESC`,
		outletID, days, cap)
	return rows, err
}
```
(`customerObj`'s bare column names resolve to `customers c` — the subquery only exposes `customer_id`/`last_seen`, so there's no ambiguity. `count(*) OVER() AS total` satisfies `listJSON`'s second-column expectation and is discarded.)

- [ ] **Step 2: Build**

Run: `cd backend && go build ./...`
Expected: builds (the function is unused for now — Go allows unused methods; only unused locals/imports fail).

- [ ] **Step 3: Commit**

```bash
git add backend/internal/read/repo.go
git commit -m "feat(backend): RecentCustomersForOutlet bounded read (Phase 2 seam, unwired)"
```

---

## Phase B — POS APK (Phase 1; deploy now)

### Task B1: On-demand customer lookup in the cashier picker

**Files:** Modify `apps/pos/src/cashier/CashierScreen.tsx`

- [ ] **Step 1: Ensure the api import + hooks are present**

At the top of `CashierScreen.tsx`, confirm/add `import { api } from '../api'` (the shared POS client; same one `lib/errorReporter.ts` uses). Confirm `useState` and `useEffect` are imported from `'react'` (add `useEffect` if missing).

- [ ] **Step 2: Add a debounced online-lookup effect**

Near the other `useState` declarations (after `const [localCustomers, setLocalCustomers] = useState<Customer[]>([])`, ~line 99), add:
```tsx
  const [lookupResults, setLookupResults] = useState<Customer[]>([])
  useEffect(() => {
    const q = state.customerSearch.trim()
    if (!offlineData.isOnline || q.length < 2) {
      setLookupResults([])
      return
    }
    let ignore = false
    const t = setTimeout(async () => {
      try {
        const res = await api.lookupCustomers(q)
        if (!ignore) setLookupResults(res)
      } catch {
        if (!ignore) setLookupResults([])
      }
    }, 300)
    return () => {
      clearTimeout(t)
      ignore = true
    }
  }, [state.customerSearch, offlineData.isOnline])
```
(`state.customerSearch` is the picker's search term; `offlineData.isOnline` is the connectivity signal. The `ignore` flag guards against stale async overwrites — same idiom as SP-CRM-2.)

- [ ] **Step 3: Merge lookup results into the picker's customer list**

Replace the existing merge (`apps/pos/src/cashier/CashierScreen.tsx:174-180`):
```tsx
  const snapCustomers = snapshot.customers ?? []
  const customers = [
    ...localCustomers.filter(
      (lc) => !snapCustomers.some((sc) => sc.id === lc.id),
    ),
    ...snapCustomers,
  ]
```
with a dedup-by-id merge that includes online lookup hits:
```tsx
  // Local session creates first, then the offline cache, then online lookup
  // hits (online only). Dedup by id; the picker filters/slices this list.
  const snapCustomers = snapshot.customers ?? []
  const seenCustomerIds = new Set<string>()
  const customers: Customer[] = []
  for (const c of [...localCustomers, ...snapCustomers, ...lookupResults]) {
    if (!seenCustomerIds.has(c.id)) {
      seenCustomerIds.add(c.id)
      customers.push(c)
    }
  }
```

- [ ] **Step 4: Typecheck + build**

Run: `cd apps/pos && npx tsc -b && npx vite build`
Expected: both succeed. Fix any unused-import / type errors.

- [ ] **Step 5: Commit**

```bash
git add apps/pos/src/cashier/CashierScreen.tsx
git commit -m "feat(pos): on-demand customer lookup in cashier picker (online), cache fallback offline"
```

---

## Phase C — Verification (Phase 1)

### Task C1: Gates + deploy + authed live check + APK

**Files:** none

- [ ] **Step 1: Full local gate**

Run:
```bash
cd backend && go build ./... && go vet ./... && go test ./... && make gen-check
cd ../apps/pos && npx tsc -b && npx vite build
```
Expected: all green; gen-check clean (no openapi change expected this sprint).

- [ ] **Step 2: Deploy backend + readiness**

Run: `gcloud run deploy mandalika-pos --source backend --region asia-southeast2 --quiet`
Then: `curl -fsS https://mandalika-pos-538849926142.asia-southeast2.run.app/readyz`
Expected: `{"data":{"status":"ready"}}` (migration 0027 applies on startup; retry on a first-write Neon transient).

- [ ] **Step 3: Authed live check (one-time SEED_ADMIN_PASSWORD OK; admin email = `admin@mandalika.test`)**

Write a throwaway `_verify_crm3.mjs` (login → bearer `data.access`, like SP-CRM-2). It can only exercise what's reachable over HTTP (the bounded read is internal, so assert it indirectly):
1. `/sync/customers/lookup?q=<known name/phone>` still returns matches (regression on SP-CRM-2's endpoint the POS now consumes).
2. Create two customers with the SAME phone via the backoffice create path, then confirm (admin-readable, if an endpoint exists) — OR assert the dup path through the POS sync: POST `/sync/batch` with a `customer_create` op carrying a phone that already exists, then verify a `customer_dup_candidates` row was recorded. If no read endpoint exists for dup-candidates, verify via a direct DB check in Step 4 instead.
Delete the script after.

- [ ] **Step 4: Verify the bounded read + dup flag directly (DATABASE_URL; ask first)**

The bounded read isn't a public route and `customer_dup_candidates` has no API yet, so verify via a throwaway pgx program (pattern: SP-CRM-2's `cmd/explaincheck`, deleted after). With one-time `DATABASE_URL` OK:
- Run `RecentCustomersForOutlet`'s SQL for a real outlet id (pick one with recent orders) → returns ≤1000 distinct customers, recent-first; spot-check they each have an order at that outlet in 90 days.
- After Step 3's dup `customer_create`, `SELECT * FROM customer_dup_candidates` shows the expected `(new_customer_id, existing_customer_id, phone, status='pending')` row.
Delete the program after. **Report plainly what was proven.**

- [ ] **Step 5: Push + APK build (USER-GATED)**

Push: `git push origin prod-hardening` (Cloudflare has no POS app; the POS ships as an APK). 
The POS change only reaches devices via an APK. **Ask the user before dispatching** `android-release.yml` (workflow_dispatch). After build + install, on-device check: with connectivity ON, searching a customer NOT in the local list returns online hits; with connectivity OFF, the picker still finds cached customers and new-customer create still works.

- [ ] **Step 6: Report**

Document Phase-1 results + the USER-PENDING on-device check, and that **Phase 2 (Task D1) is pending fleet update**.

---

## Phase D — Phase 2 cutover (GATED — DO NOT DEPLOY UNTIL FLEET UPDATED)

### Task D1: Flip the sync bootstrap to the bounded read

> **GATE:** Execute ONLY after the user confirms the new APK is deployed across the fleet. Until then, leave this untouched — the bulk sync stays (no degradation).

**Files:** Modify `backend/internal/sync/sync.go` (line 103)

- [ ] **Step 1: Replace the bulk customer fetch**

Change (`backend/internal/sync/sync.go:103`):
```go
	if b.Customers, _, err = e.Read.Customers(ctx, 1, 100000, "", ""); err != nil {
		return b, err
	}
```
to:
```go
	if b.Customers, err = e.Read.RecentCustomersForOutlet(ctx, sc.OutletID, 90, 1000); err != nil {
		return b, err
	}
```
(`RecentCustomersForOutlet` returns `([]api.Customer, error)` — note the two-value assignment vs the old three-value. `sc.OutletID` is the bootstrap's resolved outlet scope, already used for products above.)

- [ ] **Step 2: Build + vet + test**

Run: `cd backend && go build ./... && go vet ./... && go test ./...`
Expected: all green.

- [ ] **Step 3: Commit + deploy + verify**

```bash
git add backend/internal/sync/sync.go
git commit -m "feat(backend): SP-CRM-3 Phase 2 — bounded per-outlet customer sync"
```
Deploy; `/readyz`; on an updated device, resync and confirm the picker still attaches recent customers offline and finds others via online lookup. Confirm sync payload size dropped (no more 100k customers).

---

## Self-Review (completed)

- **Spec coverage:** bounded per-outlet cache read (A3) ✓; on-demand lookup + offline fallback in the picker (B1) ✓; dup detect+flag, review-queue-ready table (A1+A2) ✓; orders index for the bounded query (A1) ✓; zero-degradation rollout = Phase 1 (A/B/C) + gated Phase 2 (D1) ✓; merge tool deferred (not in plan) ✓; `customer_create` keeps client-id create (A2 comment) ✓.
- **Placeholder scan:** none — all code steps show real code; the live-check has two concrete verification routes (HTTP + pgx) rather than a vague "verify".
- **Type consistency:** `RecentCustomersForOutlet(ctx, outletID string, days, limit int) ([]api.Customer, error)` (A3) matches the Phase-2 call site (D1, two-value assignment, literal `90, 1000`); `customer_dup_candidates` columns (A1) match the insert (A2); `api.lookupCustomers(q)` (B1) is the SP-CRM-2 client method; `offlineData.isOnline` + `state.customerSearch` + `Customer` type all already exist in `CashierScreen.tsx`.
- **Gate called out:** D1 is explicitly fenced as user-gated; A3 builds the read it depends on so D1 is a one-line swap.
