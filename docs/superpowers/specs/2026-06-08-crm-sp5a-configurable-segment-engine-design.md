# SP-CRM-5a — Configurable Segment Engine (Design)

Date: 2026-06-08 · Branch: `prod-hardening` · Module: Customers (Pelanggan) / CRM

## Context

CRM progress in [[crm-customers-module]]. SP-CRM-1..4 are DONE & deployed (rev `00052-8wv`,
migrations →0028). The customer has the RFM inputs already: `totalSpent` (M), `visitCount` (F),
`lastVisit?` (R; nullable for never-ordered customers). The backoffice currently classifies customers
with a **hardcoded tier ladder** — `tier(spent)` in `apps/backoffice/src/screens/Customers.tsx`
(Member/Silver/Gold/Platinum by spend, gated by `loyalty.tierEnabled`) — shown as a list column + a
detail-header badge. The POS cashier picker also shows a tier via `getCustomerTier(totalSpent)`
(`apps/pos/src/cashier/pricing.ts`), gated by `loyaltyEnabled`.

The user wants to **replace the rigid tiers with a user-configurable, RFM-style segment engine**,
shown **everywhere including the POS**. To honor the module-wide lean-sync principle (don't sync rules
or compute on-device), segments are **computed server-side from the stored rules and emitted as a
small `{id,name,color}` field on customer reads** — the POS just displays it.

Because this is cross-cutting (backend + backoffice + POS + APK), it is **phased** like SP-CRM-3:

- **SP-CRM-5a — backend + backoffice** *(this spec; no APK)*: rules table + manager + server-computed
  segment emitted on customer reads (incl. POS-facing reads → POS-ready) + replace the **backoffice**
  tier column/badge with segments + segment filter/export.
- **SP-CRM-5b — POS + APK** *(later spec)*: cashier picker shows `customer.segment` instead of
  `getCustomerTier`; retire `getCustomerTier`; decide the fate of the `tierEnabled` toggle.

## Goals (5a)

1. A **stored, user-configurable** segment rule set (RFM bounds), managed in the backoffice.
2. **Server-computed segment** per customer (rules-driven, always current), emitted on customer reads.
3. Replace the **backoffice** tier column + detail badge with the segment; add a **segment filter** and
   export column.

## Non-goals (later)

- The **POS cashier swap** to segments + retiring `getCustomerTier` + the `tierEnabled` decision → SP-CRM-5b (APK).
- Lifecycle/interaction log (SP-CRM-6); points ledger (SP-CRM-7); dup-merge tool (SP-CRM-Merge).
- Storing the segment on the customer row (segment is **derived**, never stored).
- Multi-factor scoring beyond R/F/M min/max (no quintile RFM scoring — the min/max rule model is the agreed expressiveness).

## Key decisions (locked with the user)

| Decision | Choice | Rationale |
|---|---|---|
| Tiers vs segments | **Segments replace tiers**, everywhere (POS included), phased 5a→5b | User's call. |
| POS segment delivery | **Compute server-side, emit `{id,name,color}` on customer reads** (incl. POS sync/lookup) | Lean: no rules synced, no on-device compute; one small field. |
| Rule model | Each segment = optional inclusive min/max on **R** (days since last visit), **F** (visitCount), **M** (totalSpent); ordered; **first-match-wins**; null bound = no constraint | Tractable, covers the example set. |
| Storage | `customer_segments` table; **seed the 6** (Baru/Juara/Setia/Berisiko/Hilang/Biasa) | Immediate value + editable template. |
| Computation | **Lateral subquery** against the rules table per customer (no dynamic-SQL generation; always current) | Single source of truth = the table; rules edits take effect immediately. |
| Emission | `segment` added to the **shared `customerObj`** (reverses the tags backoffice-only stance) | Makes 5b POS-ready; segment is one tiny field the POS will use. |
| null lastVisit | Recency-bounded rules can't match → falls to a no-recency rule (e.g. Baru `F≤1`) | A never-ordered customer reads as "Baru". |
| No match | `segment = null` → neutral "—"; the seeded Biasa catch-all means everyone gets one by default | Simple. |
| Reorder | up/down (`sort_order`) | No drag infra; priority is load-bearing for first-match. |
| `tierEnabled` | Untouched in 5a (still gates the POS spend-tier); backoffice shows segments always | Defer the toggle decision to 5b. |
| Surface | Backoffice list column + detail badge + filter + export + manager; gated `manage_customers` | Mirrors tags. |

## Data model — migration `0029`

Next slot is **0029** (backend at →0028).

```sql
-- 0029_customer_segments.sql
CREATE TABLE customer_segments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  color      text NOT NULL,
  sort_order integer NOT NULL,
  r_min      integer,   -- days since last visit, inclusive lower bound
  r_max      integer,
  f_min      integer,   -- visit count
  f_max      integer,
  m_min      numeric,   -- total spent
  m_max      numeric,
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_customer_segments_order ON customer_segments(sort_order);

-- Seed the 6 starter segments (editable). Colors from the tag palette tokens.
INSERT INTO customer_segments (name, color, sort_order, r_min, r_max, f_min, f_max, m_min, m_max) VALUES
  ('Baru',     'blue',   1, NULL, NULL, NULL, 1,    NULL, NULL),       -- F <= 1
  ('Juara',    'purple', 2, NULL, 30,   5,    NULL, 2000000, NULL),    -- R<=30 & F>=5 & M>=2jt
  ('Setia',    'green',  3, NULL, 60,   3,    NULL, NULL, NULL),       -- R<=60 & F>=3
  ('Berisiko', 'amber',  4, 60,   120,  2,    NULL, NULL, NULL),       -- R 60..120 & F>=2
  ('Hilang',   'red',    5, 120,  NULL, NULL, NULL, NULL, NULL),       -- R > 120 (>=120)
  ('Biasa',    'gray',   6, NULL, NULL, NULL, NULL, NULL, NULL);       -- catch-all
```
(Note the example "R≤30" maps to `r_max=30`; "F≥5" → `f_min=5`; "R 60–120" → `r_min=60, r_max=120`;
"R>120" approximated as `r_min=120` inclusive — acceptable for a starter the user can tune.)

## Segment computation

`R` (recency) = whole days since `last_visit`: `(now()::date - last_visit::date)` (integer; NULL when
`last_visit` is NULL). `F` = `visit_count`. `M` = `total_spent`.

The computed segment is the first active rule (by `sort_order`) whose bounds all hold. Expressed as a
correlated/lateral sub-select reused by a shared SQL fragment (e.g. `segmentObj`):

```sql
(SELECT json_build_object('id', s.id, 'name', s.name, 'color', s.color)
   FROM customer_segments s
  WHERE s.is_active
    AND (s.r_min IS NULL OR (customers.last_visit IS NOT NULL AND (now()::date - customers.last_visit::date) >= s.r_min))
    AND (s.r_max IS NULL OR (customers.last_visit IS NOT NULL AND (now()::date - customers.last_visit::date) <= s.r_max))
    AND (s.f_min IS NULL OR customers.visit_count >= s.f_min)
    AND (s.f_max IS NULL OR customers.visit_count <= s.f_max)
    AND (s.m_min IS NULL OR customers.total_spent >= s.m_min)
    AND (s.m_max IS NULL OR customers.total_spent <= s.m_max)
  ORDER BY s.sort_order
  LIMIT 1)
```
Correlates via unaliased `customers.<col>` (same convention as `customerObjWithTags` — callers keep
`FROM customers` unaliased). Returns `null` when no rule matches.

## Backend

### Reads (`backend/internal/read/repo.go`)
- Add `segmentObj` (the sub-select above) and fold `'segment', <segmentObj>` into the **shared
  `customerObj`** so EVERY customer read emits it (backoffice list/detail + POS sync/lookup/by-phone).
  `customerObjWithTags` continues to be `customerObj` (now incl. segment) + the tags agg.
- `Customers(ctx, page, limit, q, sort, tagId, segmentId)` — add a `segmentId` filter: when non-empty,
  `AND (<segmentObj-id-only sub-select>) = $N::uuid` (the first-match segment id equals the requested
  id). Parameter-bound; composes with q+sort+tagId+pagination.
- New `Segments(ctx)` list read (ordered by `sort_order`).

### Writes (`backend/internal/write/segment.go`)
- `Segment` struct (name, color, sort_order, r/f/m min/max, is_active). `validateSegment`: valid color
  token (reuse the tag palette set), and for each metric `min <= max` when both set.
- `CreateSegment` / `UpdateSegment` / `DeleteSegment`. `ReorderSegments(orderedIds []string)` — in a
  tx, set each segment's `sort_order` to its index in the list (the up/down UI sends the full reordered
  id list). Validates the id set matches the existing segments.

### Handlers / routes (gated `manage_customers`)
- `GET /api/v1/segments`, `POST /api/v1/segments`, `PUT /api/v1/segments/{id}`,
  `DELETE /api/v1/segments/{id}`, and `PUT /api/v1/segments/reorder` (`{orderedIds: string[]}`).
- `listCustomers` handler reads `segmentId` and passes it through.

### API (`openapi.yaml` → regen)
- `Segment` `{ id, name, color, sortOrder, rMin?, rMax?, fMin?, fMax?, mMin?, mMax?, isActive, createdAt }`;
  `SegmentInput`; `SegmentListResponse`; reorder request schema. `segment?: {id,name,color}` (nullable)
  on `Customer`. `segmentId` query param on `listCustomers`. Regen + `make gen-check`.

### TS client
- `listSegments`, `createSegment`, `updateSegment`, `deleteSegment`, reorder method;
  `listCustomers(…, segmentId)`.

## Backoffice

- **Segment color/chip:** reuse `screens/customers/tagColors.ts` (`tagChipClasses`) for segment chips.
- **List (`Customers.tsx`):** replace the **"Tier" column with "Segmen"** (colored chip from
  `c.segment`); add a **segment filter dropdown** (from `listSegments`, resets page); a **"Kelola
  Segmen"** button → manager modal; add a **"Segmen"** export column. The old `tier()` helper + its
  column/badge usage in the backoffice are removed (POS `getCustomerTier` is untouched — that's 5b).
- **Detail (`CustomerDetail.tsx`):** replace the header **tier badge with the segment badge**
  (`c.segment`). (The `tier`/`tierEnabled` props the detail receives can be dropped or repurposed; keep
  the change minimal and consistent.)
- **Segment manager (`screens/customers/SegmentManager.tsx`, new):** ordered rule list with up/down
  reorder; add/edit form (name, color picker, R/F/M min/max numeric inputs, active toggle); delete with
  inline confirm. Calls the segment CRUD + reorder, refetches.

## Testing & verification

- **Go:** `go build`/`go vet`/`go test ./...`. The `Customers` signature change (`+segmentId`) ripples
  only to the handler (sync uses `RecentCustomersForOutlet`, not `Customers()`).
- **Build gates:** regen + `@mandalika/api` typecheck + backoffice `tsc -b` + `vite build`;
  `make gen-check`.
- **Authed live check** (one-time `SEED_ADMIN_PASSWORD`; admin `admin@mandalika.test`):
  1. segments seeded (6) + CRUD (create/update/delete) + reorder changes priority.
  2. computed `segment` correct for sample customers across R/F/M, incl. a **null-lastVisit** customer →
     "Baru"; first-match priority respected (a customer matching multiple rules gets the lowest sort_order).
  3. `GET /customers?segmentId=<id>` returns only that segment's customers; composes with `q`; pagination ok.
  4. `segment` IS present on `/sync/customers/lookup` + `/customers/by-phone` now (POS-ready for 5b).
  5. invalid color / `min>max` rejected.
- **Visual (user-pending):** Segmen column + chips, segment filter, manager CRUD/reorder, detail badge.

## Risks & mitigations

- **Per-row lateral on every read** (incl. the bounded sync ≤1000) — fine at these volumes; the rules
  table is tiny. Flagged. (If ever hot, the rule set could be cached, but YAGNI now.)
- **Segment now on the shared `customerObj`** = it's in the POS sync payload (one small field) — the
  deliberate reversal of the tags stance, required for 5b. Verified by check #4.
- **first-match priority is load-bearing** — the manager makes order explicit (up/down).
- **Replacing the backoffice tier** touches `Customers.tsx`/`CustomerDetail.tsx` tier usage — scope the
  edits to the tier column/badge only; do NOT touch the POS `getCustomerTier` (5b) or loyalty settings.
- Neon first-write-after-idle transient — retry warm.

## Files touched (anticipated)

- `backend/internal/db/migrations/0029_customer_segments.sql` (new)
- `backend/api/openapi.yaml` + `internal/api/api.gen.go` (regen)
- `backend/internal/read/repo.go` (`segmentObj` in shared `customerObj`; `Customers` +segmentId; `Segments`)
- `backend/internal/write/segment.go` (new — segment CRUD + reorder)
- `backend/internal/handlers/writes.go` + `handlers.go` + `server/server.go`
- `packages/api/src/client.ts` (+ generated types)
- `apps/backoffice/src/screens/Customers.tsx` (tier→segment column, filter, export, Kelola button)
- `apps/backoffice/src/screens/customers/CustomerDetail.tsx` (tier→segment badge)
- `apps/backoffice/src/screens/customers/SegmentManager.tsx` (new)
- (no `sync.go`, no POS, no `apps/pos` — those are 5b)
