# SP-CRM-2 — Customer Scale Foundation (Design)

Date: 2026-06-07 · Branch: `prod-hardening` · Module: Customers (Pelanggan) / CRM

## Context

The CRM module is being built on the Customers screen (see [[crm-customers-module]]). SP-CRM-1
shipped richer fields + a detail hub + server pagination/search. During SP-CRM-2 brainstorming
the user corrected a load-bearing assumption: the production target is a **30+ outlet brand doing
thousands of transactions/day**, so the *identified-customer* table is planned for **hundreds of
thousands (50k–500k)** of rows — not the "few hundred" the earlier work implicitly assumed.

Verifying against the code surfaced concrete scaling gaps:

1. **The POS syncs the entire customer table to every outlet.** `backend/internal/sync/sync.go:103`
   calls `Customers(ctx, 1, 100000, "")` — unscoped, cap 100,000 — so every outlet's POS pulls the
   whole global customer base on bootstrap. Unviable at 100k+ (payload size, memory, mobile-data
   cost). **Pre-existing.**
2. **The customer list isn't indexed for what SP-CRM-1 added.** `customers` has only
   `idx_customers_phone` (btree) + PK (migration 0001). There is **no index for `ORDER BY
   total_spent DESC`** (full-table sort per query) and **no trigram index for the `ILIKE '%…%'`
   substring search** on name/phone/email (btree cannot serve substring ILIKE → sequential scan).
   Introduced by SP-CRM-1 without flagging the index need.
3. **SP-CRM-1's phone dup-check fetches up to 10,000 rows** (`api.listCustomers(1, 10000)`) every
   time the edit modal opens — wrong at scale; the indexed exact-phone lookup is the right tool.

This sprint fixes the **backend/backoffice** scaling foundation and lays the API seam the POS will
consume next. It does **not** change the POS or remove the bulk sync (that needs a coordinated APK
+ an offline-behaviour decision → SP-CRM-3).

## Revised CRM decomposition (agreed this session)

- **SP-CRM-1 — Customer hub foundation** ✅ DONE (2026-06-07, rev 00048-f2p).
- **SP-CRM-2 — Customer scale foundation** *(this spec; backend/backoffice, no APK)*.
- **SP-CRM-3 — POS on-demand customer attach** (POS + APK): cashier attaches via the lookup
  endpoint; remove customers from the sync bootstrap; **offline-behaviour design needed** (the POS
  has a `customer_create` offline outbox today, so pure-online attach is a real decision — its own
  brainstorm).
- **SP-CRM-4 — Manual tags** (already brainstormed: managed `tags` table + `customer_tags` join,
  name+color, assign on the detail hub, chips on rows, single-tag server-side filter, tag manager).
- **SP-CRM-5 — Configurable segment engine** (RFM-style; each segment = optional min/max on
  Recency/Frequency/Monetary, ordered, first-match-wins, catch-all; add/remove/reorder, editable
  names+colors; rules stored + managed; computed read-time; filterable).
- **SP-CRM-6 — Lifecycle + interaction log** · **SP-CRM-7 — Points ledger**.

## Goals (SP-CRM-2)

1. Make the customer list's search + sort **index-backed** at 100k–500k rows.
2. Add a **sort toggle** (Terbaru / Belanja Tertinggi), both index-backed.
3. Replace SP-CRM-1's 10k-row phone dup-check with a **server-side exact-phone lookup**.
4. Add a **cashier-scoped on-demand customer lookup endpoint** — the seam SP-CRM-3's POS attach
   flow will consume.

## Non-goals (later sprints)

- Changing the POS or removing the bulk-sync `Customers(1,100000)` payload (SP-CRM-3, APK).
- Offline customer-attach design (SP-CRM-3).
- Tags (SP-CRM-4), segments (SP-CRM-5), lifecycle/interaction log (SP-CRM-6), points ledger (SP-CRM-7).
- Phone **normalization** (08xx vs +62xx) — dup-check stays exact trimmed-string match (same
  semantics as SP-CRM-1's `isDuplicatePhone`); normalization is a future item.
- **Keyset pagination / estimated counts** — staying with OFFSET + page numbers + exact
  `count(*) OVER()` (fine at 50k–500k with the new indexes for typical filtered/shallow browsing;
  deep offset stays slow — accepted). Revisit only if the table heads toward millions.

## Key decisions (locked with the user)

| Decision | Choice | Rationale |
|---|---|---|
| Planning scale | 50k–500k identified customers | Sets engineering depth: indexes + on-demand POS, not keyset/millions-grade. |
| Search index | 3 GIN **trigram** indexes (name, phone, email) | Makes `ILIKE '%q%'` substring search index-backed; preserves the 3-field OR semantics (Postgres BitmapOrs them). |
| Sort | **Toggle**: `belanja` = `(total_spent DESC, created_at DESC)` (default) / `terbaru` = `created_at DESC`; index both | User wants both views. `total_spent` index causes minor per-order non-HOT write amplification — negligible at ~thousands orders/day. |
| Pagination | Keep OFFSET + page numbers + exact count | YAGNI keyset at this scale; admins filter rather than deep-page. |
| Dup-check | Server-side `GET /customers/by-phone` (exact, indexed) | Replaces the 10k fetch; uses `idx_customers_phone`. Exact trimmed match (normalization deferred). |
| On-demand lookup | Build `GET /sync/customers/lookup` now | The contract SP-CRM-3's POS attach needs; cheaply live-verifiable; no consumer yet (intentional seam). |
| Surface | Backend + backoffice only, no APK | The POS switch + bulk-sync removal is SP-CRM-3 (coordinated APK). |

## Write-cost / storage note (for the record)

- **Storage:** 3 trigram GIN indexes ≈ 1–2× the indexed text size → ~15–30 MB at 100k, ~75–150 MB
  at 500k. Negligible for Neon.
- **Writes:** trigram indexes are only touched when name/phone/email change (rare; GIN `fastupdate`
  batches them). Indexing `total_spent` makes the per-order customer-stat update (total_spent/
  visit_count/last_visit bumped on every sale) **non-HOT**, adding an entry to all indexes incl. the
  GINs — but at ~0.02–0.1 customer-updates/sec it is immaterial; autovacuum handles the bloat. The
  mechanism only bites at tens of thousands of writes/sec.

## Data model — migration `0026`

Next migration slot is **0026** (backend at →0025). No new tables; indexes only:

```sql
-- 0026_customer_scale_indexes.sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Substring search (ILIKE '%q%') across the 3 searched fields. Separate GIN
-- trigram indexes preserve the existing OR semantics (planner BitmapOrs them).
CREATE INDEX idx_customers_name_trgm  ON customers USING gin (name  gin_trgm_ops);
CREATE INDEX idx_customers_phone_trgm ON customers USING gin (phone gin_trgm_ops);
CREATE INDEX idx_customers_email_trgm ON customers USING gin (email gin_trgm_ops);

-- Sort-toggle support.
CREATE INDEX idx_customers_spent   ON customers (total_spent DESC, created_at DESC);
CREATE INDEX idx_customers_created ON customers (created_at DESC);
```

`idx_customers_phone` (exact-phone btree, migration 0001) is kept for the dup-check + exact lookup.

> **Neon note:** `CREATE EXTENSION pg_trgm` is supported on Neon. Index builds here are plain
> (non-`CONCURRENTLY`) — fine because they run inside the migration runner at deploy on a table that
> isn't under heavy concurrent write during a deploy; at true scale a future op could rebuild
> `CONCURRENTLY` out of band, but that's not needed now.

## Backend

### Read (`backend/internal/read/repo.go`)
- `Customers(ctx, page, limit, q, sort string)` — add a `sort` parameter:
  - `sort == "terbaru"` → `ORDER BY created_at DESC`
  - else (default, incl. `"belanja"`/empty) → `ORDER BY total_spent DESC, created_at DESC`
  Keep the existing `WHERE ($N = '' OR name ILIKE '%'||$N||'%' OR phone ILIKE … OR email ILIKE …)`
  predicate (now trigram-backed) and `count(*) OVER()` + OFFSET/LIMIT. `q` stays parameter-bound.
  Implement as two query constants selected by `sort` (mirrors the existing branch-free style) — do
  NOT interpolate `sort` into SQL.
- New `CustomerByPhone(ctx, phone string) ([]api.Customer, error)` — `SELECT customerObj FROM
  customers WHERE phone = $1` (trimmed; exact), returns 0+ matches.
- New `CustomerLookup(ctx, q string, limit int) ([]api.Customer, error)` — capped (`limit` clamped
  ≤ 20), matches exact phone first then trigram name/phone; e.g. `WHERE phone = $1 OR name ILIKE
  '%'||$1||'%' OR phone ILIKE '%'||$1||'%' ORDER BY (phone = $1) DESC, name LIMIT $2`.

### Handlers / routes
- `Customers` handler reads `sort := r.URL.Query().Get("sort")` and passes it through. `ckey`
  already includes `RawQuery`, so sort/q/page cache separately.
- New `GET /api/v1/customers/by-phone?phone=<>` (gated `manage_customers`) → `{data: Customer[]}`.
- New `GET /api/v1/sync/customers/lookup?q=<>&limit=<>` in the cashier `sync` route group (JWT
  cashier scope, mirrors `sync/outlet-transfers`) → `{data: Customer[]}` (capped).

### Sync — explicitly unchanged this sprint
`sync.go:103` `Customers(ctx, 1, 100000, "")` becomes `Customers(ctx, 1, 100000, "", "")` (new
`sort` arg = default). **The bulk payload is intentionally left in place** — removing it is SP-CRM-3
(coordinated with the POS/APK so deployed devices don't lose customer-attach). Flagged so the win
timing is clear: SP-CRM-2 lays groundwork; the heavy-load fix lands in SP-CRM-3.

### API (`backend/api/openapi.yaml` → regen)
- `listCustomers`: add optional `sort` query param (string; `terbaru` | `belanja`).
- New ops: `getCustomersByPhone` (`/customers/by-phone`), `lookupCustomers` (`/sync/customers/lookup`),
  both responding `CustomerListResponse`.
- Regen `api.gen.go` + `@mandalika/api`; `make gen-check` clean.

### TS client (`packages/api/src/client.ts`)
- `listCustomers(page?, limit?, q?, sort?)` — thread `sort`.
- `getCustomersByPhone(phone): Promise<Customer[]>`.
- `lookupCustomers(q, limit?): Promise<Customer[]>` (added for completeness / SP-CRM-3; backoffice
  won't call it yet).

## Frontend (`apps/backoffice/src/screens/Customers.tsx`)

- **Sort toggle** above the list: `[Belanja Tertinggi | Terbaru]` → sets the `sort` param, resets
  page to 1. Default `belanja`.
- **Phone dup-check rewire:** remove the `allForDupe = api.listCustomers(1, 10000)` query and the
  `isDuplicatePhone`-over-full-list derivation. Replace with a debounced call to
  `api.getCustomersByPhone(form.phone)` when the modal is open; `phoneDupe = matches.some(m => m.id
  !== editing?.id)`. (The pure `screens/customers/phone.ts` helper can be retired or kept for the
  pure compare; prefer deleting it if it becomes unused — verify references first.)
- No detail-hub changes this sprint (tags land in SP-CRM-4).

## Testing & verification

- **Go:** `go build` / `go vet` / `go test ./...` (regression). The `Customers` signature change
  must compile at all call sites (handler + `sync.go`).
- **Build gates:** regen + `@mandalika/api` typecheck + backoffice `tsc -b` + `vite build`;
  `make gen-check` clean.
- **Authed live check** (one-time `SEED_ADMIN_PASSWORD`; admin email is **`admin@mandalika.test`**):
  1. `?sort=terbaru` vs `?sort=belanja` return correctly different orderings; both paginate.
  2. `/customers/by-phone?phone=<exact>` finds an existing customer; a non-existent phone → empty.
  3. `/sync/customers/lookup?q=<>` (cashier token) returns ≤ limit, exact-phone match ranked first;
     bad/oversized limit clamped; auth gate (no token → 401).
  4. search still returns correct results across name/phone/email.
- **Index verification (honest caveat, rule 6):** the live DB holds small test data, so `EXPLAIN`
  may legitimately show seq scans (planner prefers them on tiny tables). Verify the indexes **exist**
  (`\d customers` / `pg_indexes`) and are **usable** via `EXPLAIN (… ) ` with `SET enable_seqscan =
  off` (should show bitmap/index scans on the trigram + sort indexes). Real at-scale plans can't be
  demonstrated without a seeded large dataset — state plainly what was and wasn't proven.
- **Visual (user-pending):** sort toggle flips ordering; search still works; saving a customer whose
  phone matches another still shows the amber warning (now server-backed).

## Risks & mitigations

- **Heavy-load win is deferred to SP-CRM-3** — SP-CRM-2 only indexes + adds the endpoint; the POS
  still bulk-syncs until SP-CRM-3. Explicitly flagged.
- **`total_spent` sort index → per-order non-HOT writes** — negligible at this write rate (see note).
- **EXPLAIN on tiny test DB can't prove at-scale plans** — verify index existence + `enable_seqscan
  off` usability instead.
- **Migration adds an extension + 5 indexes** — index builds on an existing (small, test) table are
  fast now; flagged that at true scale a rebuild might warrant `CONCURRENTLY` out of band.
- Neon free-tier first-write-after-idle transient — retry warm.

## Files touched (anticipated)

- `backend/internal/db/migrations/0026_customer_scale_indexes.sql` (new)
- `backend/api/openapi.yaml` · `backend/internal/api/api.gen.go` (regen)
- `backend/internal/read/repo.go` · `backend/internal/handlers/handlers.go` (+ routes in
  `backend/internal/server/server.go`) · `backend/internal/sync/sync.go` (1-line signature update)
- `packages/api/src/client.ts` (+ generated types)
- `apps/backoffice/src/screens/Customers.tsx` (sort toggle + dup-check rewire)
- possibly remove `apps/backoffice/src/screens/customers/phone.ts` if unused after the rewire
