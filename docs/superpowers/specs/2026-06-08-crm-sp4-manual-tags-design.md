# SP-CRM-4 — Manual Tags (Design)

Date: 2026-06-08 · Branch: `prod-hardening` · Module: Customers (Pelanggan) / CRM

## Context

CRM module progress in [[crm-customers-module]]. SP-CRM-1 (hub), SP-CRM-2 (scale foundation),
SP-CRM-3 (POS on-demand attach + bounded per-outlet sync) are DONE & deployed (rev `00051-qgs`,
migrations →0027). The Customer Detail hub (`apps/backoffice/src/screens/customers/CustomerDetail.tsx`)
has carried a reserved **"Tag & Segmen — segera"** placeholder (line 104) since SP-CRM-1, waiting for
this sprint.

SP-CRM-4 adds **manual customer tags**: a managed, colored label set staff apply to customers
(reseller, wholesale, VIP, complainer, influencer, …) to organize and filter the customer base.
Backoffice-only this sprint; tags are NOT exposed to the POS (a future SP-CRM-POS concern).

Repo precedent for a managed label set is a normalized table (`categories`, `ingredient_categories`:
`id, name, sort_order, created_at`, FK `ON DELETE SET NULL`), but those are 1-to-many. Tags are
many-to-many → a `customer_tags` join. The ingredient `CategoryManager`
(`apps/backoffice/src/screens/ingredients/CategoryManager.tsx`) is the UI precedent (an inline
delete-only panel); the tag manager is richer (create + rename + recolor + delete).

## Goals

1. A **managed tag set** (name + color) with full CRUD via a tag manager.
2. **Assign/unassign** tags to a customer on the detail hub (colored chips + picker + inline create).
3. Tags visible as **colored chips on the customer list rows**, and a **single-tag server-side
   filter** on the list (composes with the existing `q` search + `sort` + pagination).

## Non-goals (later sprints)

- **POS tag exposure** (cashier seeing tags at checkout) → future SP-CRM-POS.
- **Multi-tag AND/OR filtering** (single-tag filter only this sprint — YAGNI).
- Configurable segment engine (SP-CRM-5); lifecycle/interaction log (SP-CRM-6); points ledger
  (SP-CRM-7); the dup-merge tool (SP-CRM-Merge).
- Free-form hex color picker (preset palette only).

## Key decisions (locked with the user)

| Decision | Choice | Rationale |
|---|---|---|
| Tag model | Managed `tags` table + `customer_tags` join (many-to-many) | Typo-resistant, recolor/rename, consistent filtering; repo precedent for managed label sets. |
| Color | Small **preset palette** (~8 theme tokens), stored as a token string | Consistent chips; no free hex. |
| Tag hydration | **Backoffice-only** — a `customerObjWithTags` read used solely by the backoffice list + detail; shared `customerObj` (POS sync / lookup / by-phone) stays tag-free | Keeps the bounded POS sync lean; tags aren't used by the POS yet. `tags` is an OPTIONAL field on `Customer`. |
| Assignment API | `PUT /customers/{id}/tags {tagIds:[…]}` (set-the-whole-set) | Idempotent; matches editing the chip set in one save. |
| List filter | **Single-tag**, server-side, composes with `q`+`sort`+pagination | YAGNI; pagination stays correct. |
| List display | Colored tag chips on each row + a tag filter dropdown | At-a-glance scanning + filtering. |
| Surface | Backoffice-only, gated `manage_customers` | Consistent with the module. |

## Data model — migration `0028`

Next migration slot is **0028** (backend at →0027).

```sql
-- 0028_customer_tags.sql
CREATE TABLE tags (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL UNIQUE,
  color      text NOT NULL,          -- preset palette token (see below)
  sort_order integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE customer_tags (
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  tag_id      uuid NOT NULL REFERENCES tags(id)      ON DELETE CASCADE,
  PRIMARY KEY (customer_id, tag_id)
);
CREATE INDEX idx_customer_tags_tag ON customer_tags(tag_id);
```

The `(customer_id, tag_id)` PK gives the customer→tags lookup index; `idx_customer_tags_tag`
supports the `tagId` list filter (find customers with a given tag).

**Color palette** (preset tokens, validated on write): `amber`, `blue`, `green`, `red`, `purple`,
`gray`, `pink`, `teal`. The frontend maps each token to chip bg/text classes. Writes reject unknown
tokens (default to `gray` if validation is lenient — decide at impl; prefer reject for data cleanliness).

## Backend

### Reads (`backend/internal/read/repo.go`)
- New `customerObjWithTags` = the existing `customerObj` fields **plus**
  `'tags', COALESCE((SELECT json_agg(json_build_object('id',t.id,'name',t.name,'color',t.color)
   ORDER BY t.name) FROM customer_tags ct JOIN tags t ON t.id = ct.tag_id
   WHERE ct.customer_id = c.id), '[]')`. Used **only** by the backoffice `Customers()` list and
  `Customer()` detail (alias the customers table as `c`). The shared `customerObj` is unchanged, so
  `CustomerByPhone`, `CustomerLookup`, and `RecentCustomersForOutlet` (POS sync) keep returning
  tag-free customers.
- `Customers(ctx, page, limit, q, sort, tagId)` — add an optional `tagId`: when non-empty, add
  `AND EXISTS (SELECT 1 FROM customer_tags ct WHERE ct.customer_id = c.id AND ct.tag_id = $N)`,
  parameter-bound, composed with the existing `q`/`sort`/pagination.
- New `Tags(ctx)` → list all tags (ordered by `sort_order NULLS LAST, name`).

### Writes (`backend/internal/write/repo.go`)
- `CreateTag(name, color)` / `UpdateTag(id, name, color)` / `DeleteTag(id)` (CASCADE removes
  assignments). Validate `color` is a known palette token; map a duplicate-name unique violation to a
  friendly error.
- `SetCustomerTags(customerID, tagIds []string)` — replace the customer's tag set in one tx:
  `DELETE FROM customer_tags WHERE customer_id=$1` then bulk-insert the new `(customer_id, tag_id)`
  rows (skip if `tagIds` empty). Validates the customer exists.

### Handlers / routes (gated `manage_customers`)
- `GET /api/v1/tags` (list — could sit in the general read group like `/customers`, but keep tag
  writes under `manage_customers`); `POST /api/v1/tags`, `PUT /api/v1/tags/{id}`,
  `DELETE /api/v1/tags/{id}`; `PUT /api/v1/customers/{id}/tags`.
- `listCustomers` handler reads `tagId` from query and passes it through.

### API (`backend/api/openapi.yaml` → regen)
- `Tag` schema `{ id, name, color, sortOrder?, createdAt }`; `TagInput` `{ name, color, sortOrder? }`;
  `TagListResponse`/`TagResponse`. `SetCustomerTagsInput { tagIds: string[] }`.
- `tags` OPTIONAL field on `Customer` (`array<Tag>`, nullable — absent on tag-free reads).
- `tagId` query param on `listCustomers`.
- Regen `api.gen.go` + `@mandalika/api`; `make gen-check`.

### TS client (`packages/api/src/client.ts`)
- `listTags()`, `createTag(input)`, `updateTag(id, input)`, `deleteTag(id)`,
  `setCustomerTags(id, tagIds)`; `listCustomers(page?, limit?, q?, sort?, tagId?)`.

## Frontend

### Tag chip helper
- A small shared map from color token → Tailwind chip classes (bg/text/border), used by chips
  everywhere (detail, list rows, manager, picker). Single source of truth for the palette.

### Tag manager — `screens/customers/TagManager.tsx`
- Inline panel (spirit of `CategoryManager`, but richer): list tags with their color swatch; add a tag
  (name + color picker from the preset palette); rename + recolor an existing tag; delete (inline
  confirm: "Tag akan dilepas dari semua pelanggan"). Calls `createTag`/`updateTag`/`deleteTag` + refetches.

### Customer Detail hub — `screens/customers/CustomerDetail.tsx`
- Replace the reserved "Tag & Segmen — segera" block (line 104) with a real **Tag section**: the
  customer's tags as colored chips with a remove (×); an "+ Tag" affordance opening a picker (filter
  existing tags + inline "create new tag" → `createTag` then assign); a "Kelola Tag" link opening the
  TagManager. Edits call `setCustomerTags(id, nextTagIds)` (set-the-whole-set) then refetch the
  customer. (*The "Segmen" half stays "segera" → SP-CRM-5.*)

### Customer list — `screens/Customers.tsx`
- A **tag filter dropdown** (populated from `listTags`) above the list; selecting a tag sets `tagId`,
  resets page to 1, server-filters. "Semua tag" clears it.
- Small colored **tag chips on each customer row** (from `customer.tags ?? []`), truncated/capped
  (e.g. show first 3 + "+N") to keep rows tidy.
- Export gains a **"Tag"** column (joined tag names) using the export-path full fetch.

## Testing & verification

- **Go:** `go build`/`go vet`/`go test ./...`. The `Customers` signature change (`+tagId`) ripples
  only to the **handler** call site — since SP-CRM-3 Phase 2, `sync.go` calls
  `RecentCustomersForOutlet`, NOT `Customers()`, so no sync.go change is needed here.
- **Build gates:** regen + `@mandalika/api` typecheck + backoffice `tsc -b` + `vite build`;
  `make gen-check` clean.
- **Authed live check** (one-time `SEED_ADMIN_PASSWORD`; admin email `admin@mandalika.test`):
  1. tag CRUD (create/rename/recolor/delete); duplicate name → friendly error; bad color rejected.
  2. `setCustomerTags` assigns/replaces; `GET /customers/{id}` returns the customer's `tags`.
  3. `GET /customers?tagId=<id>` narrows to tagged customers; pagination meta correct; composes with `q`.
  4. **Regression:** `GET /sync/customers/lookup` and `/customers/by-phone` return customers with **no
     `tags`** field (tag-free shared builder) — confirm the bounded sync stays lean.
  5. deleting a tag cascades it off customers.
- **Visual (user-pending):** chips on rows + detail; tag filter narrows; tag manager CRUD; assigning
  on the detail hub persists.

## Risks & mitigations

- **Backoffice-only hydration** needs a second read builder (`customerObjWithTags`) — slightly more
  code, but keeps the POS sync/lookup/by-phone lean (the agreed trade-off). Verified by check #4.
- Deleting a tag removes it from all customers (CASCADE — intended; the manager warns).
- The per-customer tag json_agg sub-select runs on the backoffice list (paginated 25–100) + detail —
  fine at those sizes.
- Neon first-write-after-idle transient — retry warm.

## Files touched (anticipated)

- `backend/internal/db/migrations/0028_customer_tags.sql` (new)
- `backend/api/openapi.yaml` + `backend/internal/api/api.gen.go` (regen)
- `backend/internal/read/repo.go` (`customerObjWithTags`, `Customers` +tagId, `Tags`)
- `backend/internal/write/repo.go` (tag CRUD + `SetCustomerTags`)
- `backend/internal/handlers/handlers.go` + `backend/internal/server/server.go` (handlers + routes)
  — note: `sync.go` does NOT change (it calls `RecentCustomersForOutlet`, not `Customers()`, since SP-CRM-3 Phase 2)
- `packages/api/src/client.ts` (+ generated types)
- `apps/backoffice/src/screens/Customers.tsx` (filter + row chips + export column)
- `apps/backoffice/src/screens/customers/CustomerDetail.tsx` (tag section)
- `apps/backoffice/src/screens/customers/TagManager.tsx` (new)
- `apps/backoffice/src/screens/customers/tagColors.ts` (new — palette → classes map)
