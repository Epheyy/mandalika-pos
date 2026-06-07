# SP-CRM-1 — Customer Hub Foundation (Design)

Date: 2026-06-07 · Branch: `prod-hardening` · Module: Customers (Pelanggan) / CRM

## Context

The Customers module today (`apps/backoffice/src/screens/Customers.tsx`) has customer
CRUD, the loyalty subsystem (settings + conditions), CSV/XLSX export, and a basic
purchase-history **modal** (the "Riwayat" button → `api.listOrders({ customerId })`).
Known limitations: the list loads up to 500 customers and filters **client-side** (no
UI pagination), search is client-side, and the customer record stores only
`{ name, phone, email }` — no notes, birthday, or anniversary (even though the loyalty
`birthday` / `anniversary` triggers already exist with nothing to fire on).

The user wants to grow this into a full **CRM** (segments/tags, notes/interaction log,
lifecycle & retention, points ledger). That is too large for one spec, so it is
**decomposed** into sequenced sub-projects, each with its own spec→plan→build cycle:

- **SP-CRM-1 — Customer hub foundation** *(this spec; build first)*
- **SP-CRM-2 — Segments & tags**
- **SP-CRM-3 — Lifecycle, retention & interaction log**
- **SP-CRM-4 — Points ledger & manual adjustment** *(riskiest; touches the order/earning path; last)*
- *(Later)* **SP-CRM-POS** — expose chosen CRM bits to the cashier device.

**Surface decision (applies module-wide):** *backoffice now, POS later as an explicit
phase.* The data model is designed POS-ready (additive, nullable) so a later POS sprint
layers on without rework. SP-CRM-1 ships **backoffice-only** — no APK, no sync changes.

## Goals (SP-CRM-1)

1. Make the customer list scale: server-side **pagination** (rows-per-page dropdown
   25/50/100) + server-side **search**.
2. Add richer customer fields: **birthday**, **anniversary**, **notes**.
3. Replace the basic Riwayat modal with a full-page **Customer Detail hub** that becomes
   the home for all later CRM features (tags, points ledger, interaction timeline).

## Non-goals (deferred to later sprints)

- Tags / segments (SP-CRM-2).
- Lifecycle status, at-risk surfacing, interaction-log timeline, birthday/anniversary
  reminders, wiring the loyalty birthday/anniversary triggers (SP-CRM-3).
- Points ledger / manual points adjustment (SP-CRM-4).
- POS / cashier exposure of any CRM data; sync changes; APK build.
- Bulk customer **import** (export already exists; import not requested for this round).
- `react-router` / real URL routes.
- **Hard** phone-uniqueness constraint or a dedupe pass (soft warning only — see below).

## Key decisions (locked with the user)

| Decision | Choice | Rationale |
|---|---|---|
| Surface | Backoffice now, POS later (explicit phase) | Lowest risk; design data model POS-ready. |
| Detail form factor | **Full page**, delivered as an **in-screen view swap** (not a URL route) | App has **no router**; adding one is a cross-app change (out of scope). Matches the existing Inventori drill-in pattern (`selectedCustomerId` → render detail in place of list). Trade-off: not a shareable URL, browser-Back won't return to the list; an in-UI "← Kembali" button does. |
| Birthday storage | Full `DATE` (nullable) | Keeps year for age/segments; reminders later match on month+day. |
| Anniversary | Staff-entered `DATE` (nullable), separate column | Matches "richer data" intent; feeds the existing "Hari Jadi Member" loyalty trigger. |
| Notes | `TEXT` (nullable) freeform | Simple column now; dated interaction **timeline** is SP-CRM-3. |
| Phone uniqueness | **Soft warn, no DB constraint** | Existing data may have dupes; POS can create offline. A hard unique index would fail the migration on existing dupes and could reject valid offline creates. |
| List sort | Server-side `ORDER BY total_spent DESC` (default) | Server must own the sort once paginating (client can't sort across pages); `total_spent DESC` preserves the current "top spenders first" UX. |

## Data model — migration `0025`

Next migration slot is **0025** (backend currently at migrations →0024). Additive only:

```sql
-- 0025_customer_crm_fields.sql
ALTER TABLE customers ADD COLUMN birthday    DATE;
ALTER TABLE customers ADD COLUMN anniversary DATE;
ALTER TABLE customers ADD COLUMN notes       TEXT;
```

All nullable, no constraints, no backfill. Safe for the POS sync payload (`customers`
array) and the offline `customer_create` outbox path — these are additive fields older
clients simply ignore.

## Backend

### Read (`backend/internal/read/repo.go`)
- Extend the `customerObj` JSON builder to emit `birthday`, `anniversary`, `notes`
  (dates as `YYYY-MM-DD` strings or null).
- Extend `Customers(ctx, page, limit, q)`:
  - When `q` is non-empty: `WHERE name ILIKE $q OR phone ILIKE $q OR email ILIKE $q`
    with `$q = '%' || q || '%'` (parameterized — no string concatenation into SQL).
  - `ORDER BY total_spent DESC` (was `created_at DESC`), keep `count(*) OVER()` +
    `LIMIT/OFFSET`.
- `Customer(ctx, id)` (used by `GetCustomer`) automatically returns the new fields via
  the shared `customerObj`.

### Write (`backend/internal/write/repo.go`)
- `CreateCustomer`: `INSERT ... (name, phone, email, birthday, anniversary, notes)`
  using `nullStr`/null-date helpers for the optional fields.
- `UpdateCustomer`: `UPDATE ... SET ..., birthday=, anniversary=, notes=`.

### API (`backend/api/openapi.yaml` → regen)
- `Customer` schema: add `birthday` (string, date, nullable), `anniversary`
  (string, date, nullable), `notes` (string, nullable).
- `CustomerInput` schema: add `birthday`, `anniversary`, `notes` (all optional).
- `listCustomers`: add optional `q` query param (string).
- `getCustomer` already exists — no change.
- Regen: `cd backend && go tool oapi-codegen -config api/oapi-codegen.yaml api/openapi.yaml`
  then `corepack pnpm --filter @mandalika/api gen`; verify `make gen-check`; commit
  `api.gen.go`.

### TS client (`packages/api/src/client.ts`)
- `listCustomers(page?, limit?, q?)` — thread `q` into the query string.
- Add `getCustomer(id): Promise<Customer>` (the endpoint exists; just expose it).

## Frontend

### List (`apps/backoffice/src/screens/Customers.tsx`)
- Replace the client-side `.filter()` + full-list load with **debounced server search**
  (`q`) via the existing `usePolledQuery`/list call; reset to page 1 on query change.
- Wire the shared `<Pagination/>` (25/50/100 dropdown) to the existing `page`/`limit`
  server params; show `meta.total`.
- Row **click → open detail** (`setSelectedCustomerId`). Keep quick **edit** + **delete**
  icon buttons on the row. Remove the now-redundant per-row "Riwayat" icon (history lives
  in the detail page).
- Export bar unchanged (still fetches the full filtered dataset with `limit:10000`).

### Detail page (new `apps/backoffice/src/screens/customers/CustomerDetail.tsx`)
- Rendered full-width by `Customers.tsx` when `selectedCustomerId` is set (in place of the
  list), with a "← Kembali" back button — mirrors the Inventori drill-in pattern.
- Loads via the new `api.getCustomer(id)` (fresh data) + `api.listOrders({ customerId })`
  for history.
- Two-column layout:
  - **Left — Profil:** name, phone, email, Ulang Tahun, Hari Jadi, Catatan; tier badge in
    the header; `[Edit]` (opens the shared modal) + `[Hapus]`.
  - **Right — Statistik + Riwayat Pembelian:** total spent / visit count / points / last
    visit; the purchase-history list relocated out of the old modal (expandable order rows
    with line items, same as today).
- **Reserved placeholders** (visually present, clearly "coming soon" or empty sections) for
  **Tag/Segmen**, **Poin (ledger)**, and **Timeline/Interaksi** so later sprints slot in
  without re-layout.

### Edit modal (in `Customers.tsx`)
- Extend the existing Tambah/Edit modal with: **Ulang Tahun** (date input), **Hari Jadi**
  (date input), **Catatan** (textarea).
- **Soft phone-dupe warning:** on create/edit, if the typed phone matches an existing
  customer (other than the one being edited), show a non-blocking warning line; saving is
  still allowed.

## Testing & verification

- **Go unit tests:** table-test any pure query-building / predicate helper extracted for
  the search param; existing customer write/read tests stay green.
- **Build gates:** backend `go build`/`go test`; `corepack pnpm --filter @mandalika/api gen`;
  `tsc` on the backoffice; `make gen-check` (no `api.gen.go` drift).
- **Authed live check** (needs one-time user OK to read `SEED_ADMIN_PASSWORD` from Secret
  Manager; never printed): after deploy + `/readyz`,
  1. create a customer with birthday/anniversary/notes → fields round-trip on `getCustomer`;
  2. update those fields → persists;
  3. `listCustomers?q=` narrows by name/phone/email;
  4. pagination `meta.total` + `page`/`limit` correct;
  5. export still produces the expected columns.
- **Visual (user-pending):** hard-refresh the live backoffice; confirm pagination dropdown,
  server search, row-click → full-page detail with back button, the new fields in the
  edit modal, the relocated purchase history, and the soft phone-dupe warning.

## Risks & mitigations

- **List sort change** (`created_at DESC` → `total_spent DESC`): intended, preserves current
  UX; called out for sign-off.
- **Migration**: purely additive/nullable → low risk. Neon free-tier first-write-after-idle
  transient possible — retry warm.
- **`gen-check` drift**: always regen + commit `api.gen.go` in the same change.
- **Detail view is not a URL**: accepted trade-off; an in-UI back button covers navigation.

## Files touched (anticipated)

- `backend/internal/db/migrations/0025_customer_crm_fields.sql` (new)
- `backend/api/openapi.yaml` · `backend/internal/api/api.gen.go` (regen)
- `backend/internal/read/repo.go` · `backend/internal/write/repo.go`
- `packages/api/src/client.ts` (+ generated types)
- `apps/backoffice/src/screens/Customers.tsx`
- `apps/backoffice/src/screens/customers/CustomerDetail.tsx` (new)
