# SP-CRM-6 — Interaction Log + Birthday/Anniversary Reminders (Design)

**Date:** 2026-06-09
**Branch:** `prod-hardening`
**Module:** Customers → CRM, 6th slice (SP-CRM-6)
**Migration slot:** 0030 (next free)
**Backend baseline:** Cloud Run rev `00053-ckl` (migrations →0029)
**Delivery:** backend + backoffice only — **no POS, no APK, no sync changes** (mirrors SP-CRM-1/2/4/5a)

---

## 1. Goal & scope

Grow the Customers detail hub with the two CRM affordances reserved by the
*"Poin (ledger) & Timeline interaksi — segera"* placeholder:

1. **Interaction log** — a per-customer dated timeline where staff record calls,
   visits, messages, and notes (beyond the single freeform `notes` field).
2. **Birthday/anniversary reminders** — a surface that shows which customers have a
   birthday or anniversary coming up, so staff can act on it.

### Explicitly OUT of scope (deferred to SP-CRM-7)

Firing loyalty triggers / auto-awarding points is **not** part of SP-CRM-6.

**Finding that shaped this scope:** the loyalty-conditions engine is *entirely*
unwired today. `backend/internal/service/pricing.go:174-177` computes earned points
as a flat `floor(total/1000) × pointsPerThousand`, gated only on
`loyaltyEnabled && hasCustomer`. The `loyalty_conditions` table — with its 7 trigger
types (`first_registration`, `birthday`, `anniversary`, `double_date`, `member_day`,
`product_purchase`, `spending_threshold`) and 3 reward types — is CRUD'd in the
backoffice and listed via the read API, but **never evaluated anywhere**. "Firing the
birthday/anniversary triggers" therefore means building a loyalty-condition evaluation
engine into the earning path (`pricing.go` / `order.go`) — which the roadmap reserves
for SP-CRM-7 (the riskiest slice, deliberately last).

Decision (confirmed with user): **defer all trigger-firing to SP-CRM-7.** SP-CRM-6's
reminders are the **manual bridge** until then — staff see "today is X's birthday" and
award/act by hand.

### Module-wide invariants honored

- Backoffice now / POS later — interaction + reminder data is **additive** and stays
  **off** the shared `customerObj` (lean-sync preserved; the POS reads are byte-unchanged).
- Customer detail = full-page **in-screen view swap** (no router).
- Reminders sub-view = an in-screen **tab toggle** inside `Customers.tsx` (no router).
- **OFFSET pagination** (consistent with the existing customers list).
- All new endpoints gated on the `manage_customers` permission.

---

## 2. Interaction log

### 2.1 Table — `customer_interactions` (migration 0030)

| column            | type        | notes                                                              |
|-------------------|-------------|-------------------------------------------------------------------|
| `id`              | uuid PK     | `gen_random_uuid()`                                               |
| `customer_id`     | uuid NOT NULL | FK → `customers(id)` **ON DELETE CASCADE**                       |
| `type`            | text NOT NULL | CHECK in (`telepon`, `kunjungan`, `pesan`, `catatan`)            |
| `interaction_date`| date NOT NULL | staff-editable; client defaults to today                        |
| `note`            | text        | free text, nullable                                              |
| `created_by`      | uuid        | FK → `users(id)` **ON DELETE SET NULL**, nullable                |
| `created_by_name` | text        | **snapshot** of the staff display name at log time              |
| `created_at`      | timestamptz NOT NULL | `now()`                                                 |

Index: `idx_customer_interactions_customer (customer_id, interaction_date DESC, created_at DESC)`
— serves the per-customer newest-first timeline read and gives a **stable pagination
order** (the `created_at DESC` tiebreaker prevents the LIMIT/OFFSET ghost/skip rows that
bit SP-CRM-1).

**Why snapshot `created_by_name`:** an interaction log is an audit trail; the author
shown should not change when a staff user is later renamed or deleted. This mirrors the
recipe `name_at_save` snapshot pattern already in the codebase. `created_by` (the FK)
is retained for traceability and goes NULL if the user is deleted; display falls back to
the snapshot.

### 2.2 Fixed interaction types

A built-in enum, validated server-side, no management UI:

| value       | label (id-ID) |
|-------------|---------------|
| `telepon`   | Telepon       |
| `kunjungan` | Kunjungan     |
| `pesan`     | Pesan         |
| `catatan`   | Catatan       |

(Can grow later; a staff-managed type list was considered and rejected as overbuild.)

### 2.3 Endpoints (all `manage_customers`)

- `GET /customers/{id}/interactions?page=&limit=`
  → **paginated**, newest-first (`interaction_date DESC, created_at DESC`), standard
  `{data, meta{total,page,limit}}` envelope. Default limit 25 (shared `<Pagination/>`
  25/50/100). Pagination included from the start (per user request — defensive even
  though per-customer counts are normally small).
- `POST /customers/{id}/interactions`
  body `{ type, interactionDate, note }` → server stamps `created_by` / `created_by_name`
  from the authed user; validates `type` ∈ enum, `interactionDate` parseable, customer exists.
  Returns `{id}`.
- `DELETE /customers/{id}/interactions/{iid}`
  → delete (create+delete model, **no in-place edit**). 404 if not found / not that
  customer's entry.

### 2.4 Mutability

**Create + delete only** (no edit). Delete gated on `manage_customers`. An accidental
entry is removed and re-added.

### 2.5 Backoffice UI — `CustomerDetail.tsx`

Replace the reserved *"Poin (ledger) & Timeline interaksi — segera"* card with a
**Timeline Interaksi** section:

- An "+ Tambah Interaksi" inline form: type dropdown · date input (defaults today) ·
  note textarea · Simpan.
- A vertical dated timeline, newest first: each row = type chip (colored per type) ·
  formatted `interaction_date` · note · author (`created_by_name`) · a delete icon with
  an inline confirm.
- Paginated via the shared `<Pagination/>` when the customer has many entries.
- An in-flight guard on create/delete to avoid double-submit (lesson from SP-CRM-4's
  rapid-toggle race).

The **"Poin (ledger)"** half of the old placeholder remains a greyed *"segera"* card
(that's SP-CRM-7).

---

## 3. Birthday / anniversary reminders

### 3.1 The scale problem

"Birthday in the next N days" matches **month + day, ignoring year**, across a
**year-end wrap** (e.g. today = Dec 28, window reaches early Jan), over **50k–500k**
customer rows. The query must be index-friendly.

### 3.2 Approach (chosen): generated `MMDD` columns + IN-list window

- Migration 0030 adds two **stored generated** columns on `customers`:
  - `birthday_mmdd smallint GENERATED ALWAYS AS (EXTRACT(MONTH FROM birthday)*100 + EXTRACT(DAY FROM birthday)) STORED`
  - `anniversary_mmdd smallint` — same expression over `anniversary`
  - (NULL when the source date is NULL.)
- Btree indexes `idx_customers_birthday_mmdd (birthday_mmdd)` and
  `idx_customers_anniversary_mmdd (anniversary_mmdd)`.
- The server computes the **≤31 discrete MMDD integers** for `[today, today+N]` in Go
  using real date arithmetic (handles month rollover, year-end wrap, and Feb 29 — Feb 29
  birthdays match whenever the window spans Feb 29). Query:
  `WHERE birthday_mmdd = ANY($mmddList) OR anniversary_mmdd = ANY($mmddList)`
  (filtered per `type` to one column when the filter is set).

**Why MMDD over day-of-year:** MMDD is exact and leap-safe — no per-row shift after
Feb 29 the way `EXTRACT(DOY …)` has. Why over compute-at-query-time: that has no usable
index → full seq scan, which fails at 50k–500k. Both alternatives were considered and rejected.

**Sorting by soonest:** the handler maps each matched row's MMDD back to a days-until
offset (using the same in-Go window list, which is already ordered soonest-first) so the
result is sorted by soonest occurrence and paginated deterministically. The exact SQL vs
in-Go ordering mechanism is an implementation detail for the plan; the invariant is
*soonest-first, stable under OFFSET pagination*.

**Known minor (flagged):** today's date is read server-side (server timezone). Acceptable
for a day-granularity reminder; documented, not engineered around.

### 3.3 Endpoint (`manage_customers`)

`GET /customers/reminders?window=7|30&type=birthday|anniversary|all&page=&limit=`
→ paginated `{data, meta}`. Each row = a customer summary (id, name, phone, the relevant
date, and which kind) **plus a computed `daysUntil`**, sorted soonest-first.
`window` defaults to 7; `type` defaults to `all`. Invalid `window`/`type` → 400.

### 3.4 Backoffice UI

- **Pengingat sub-view** in `Customers.tsx`: a `Daftar | Pengingat` **tab toggle** at the
  top of the screen (in-screen swap, no router). The Pengingat tab renders the windowed
  list:
  - 7 / 30 day window toggle (default 7).
  - Type filter chip: Ulang Tahun / Hari Jadi / Semua (default Semua).
  - Rows sorted soonest-first, each with a "🎂 dalam N hari" / "💍 dalam N hari"
    style label; clicking a row opens that customer's detail (existing in-screen swap).
  - Shared `<Pagination/>`.
- **Detail badge** in `CustomerDetail.tsx`: a small inline badge in the header when the
  loaded customer's birthday or anniversary is within 30 days — computed
  **client-side from the already-loaded `c.birthday` / `c.anniversary`**, **zero extra
  query**.

### 3.5 TS client additions

- `listInteractions(customerId, page, limit)` → `{data, meta}`
- `createInteraction(customerId, {type, interactionDate, note})` → `{id}`
- `deleteInteraction(customerId, interactionId)` → void
- `listReminders({window, type, page, limit})` → `{data, meta}`

---

## 4. Testing & verification

### 4.1 Go unit tests

- The **MMDD-window builder**: month rollover (e.g. Jan 28 + 7), **year-end wrap**
  (Dec 28 + 7 → spans Jan), **Feb 29** inclusion, `N=7` vs `N=30`, and soonest-first ordering.
- Interaction validation: `type` enum rejection, unparseable `interactionDate`,
  missing customer.

### 4.2 Authed live verification (deploy → `/readyz` → scripted authed check)

Admin login email = `admin@mandalika.test`; password from Secret Manager
`SEED_ADMIN_PASSWORD` (never printed).

- Interaction: create (type/date/note) → list round-trips all fields + author + pagination
  meta → delete → gone; `type` enum 400; cross-customer delete 404.
- Reminders: returns the correct windowed set with `daysUntil`; `window=30` ⊇ `window=7`;
  `type` filter narrows; pagination meta echoes page/limit; invalid `window`/`type` → 400.
- **Regression (lean-sync invariant):** `/sync/customers/lookup` and `/customers/by-phone`
  responses are **unchanged** — no interaction or reminder fields leak onto the POS-facing
  customer reads.

Temp data cleaned up after.

### 4.3 Index verification (pgx EXPLAIN throwaway, as in SP-CRM-2)

Confirm `idx_customers_birthday_mmdd` / `idx_customers_anniversary_mmdd` and
`idx_customer_interactions_customer` exist, and that a windowed reminder query uses the
MMDD indexes (with `enable_seqscan=off` to prove index eligibility on the small live table).

---

## 5. Build order (for the plan)

1. Migration 0030 (table + generated columns + indexes).
2. Backend reads (interactions list, reminders) + writes (create/delete interaction) +
   the MMDD-window builder (unit-tested).
3. OpenAPI + codegen (`oapi-codegen` → `pnpm gen` → `make gen-check`).
4. TS client methods.
5. Backoffice: `CustomerDetail` Timeline Interaksi section + header badge; `Customers`
   Daftar/Pengingat tab + Pengingat list.
6. Deploy → authed live verification → index check.

Per-batch review: **go-reviewer** (backend) + **typescript-reviewer** (client + backoffice).

---

## 6. Pre-existing bug noted (out of scope)

The backoffice Loyalitas `loyaltyForm` is initialized from `DEFAULT_LOYALTY` and never
synced from the fetched `lq.data`, so "Simpan Pengaturan" clobbers untouched fields with
defaults (SP-CRM-5b worked around it for `tierEnabled` only). Predates the CRM work; **not
fixed here** — flagged for a future convenient moment.
