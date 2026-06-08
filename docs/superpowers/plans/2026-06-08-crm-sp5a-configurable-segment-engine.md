# SP-CRM-5a — Configurable Segment Engine (backend + backoffice) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hardcoded backoffice tier ladder with a user-configurable RFM segment engine — segments stored as editable rules, computed server-side per customer, shown in the backoffice list/detail/filter, and emitted on customer reads so the POS can display them in 5b.

**Architecture:** A `customer_segments` rules table (R/F/M min/max, ordered, first-match-wins, seeded with 6 starters). The segment is computed by a correlated sub-select against the rules table, folded into the SHARED `customerObj` (so it reaches the POS-facing reads too — POS-ready for 5b). The correlation uses BARE column names because `customerObj` is also used by the aliased `RecentCustomersForOutlet` query. Backoffice swaps its tier column/badge for the segment; POS `getCustomerTier` is untouched (that's 5b).

**Tech Stack:** Go (pgx, chi, oapi-codegen), Postgres (Neon), React + TS (Vite) backoffice, shared `@mandalika/api`.

**Spec:** `docs/superpowers/specs/2026-06-08-crm-sp5a-configurable-segment-engine-design.md`

---

## Testing posture (read first)
- **Backend:** DB-bound reads/writes verified by `go build`/`go vet`/`go test ./...` then an **authed live check** (Phase D). The segment computation is exercised live against seeded rules.
- **Frontend:** no test runner — `tsc -b` + `vite build` + live + visual.
- **Commits:** `git add <paths>` then `git commit` SEPARATELY (chained `&&` trips the hook). Never `--no-verify`. Conventional commits.
- **gen-check:** regen + commit `api.gen.go` after any `openapi.yaml` edit.
- Admin login email = `admin@mandalika.test`.
- **CRITICAL SQL invariant:** the segment sub-select correlates via BARE columns (`last_visit`, `visit_count`, `total_spent`) — NOT `customers.`-qualified — because `customerObj` is used by `RecentCustomersForOutlet` (which aliases `customers c`). Bare columns resolve to whatever the outer customers alias is.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `backend/internal/db/migrations/0029_customer_segments.sql` | rules table + seed 6 | Create |
| `backend/internal/read/repo.go` | `segmentMatch`/`segmentSel`/`segmentIdSel`; fold segment into `customerObj` + `customerObjWithTags`; `Customers(+segmentId)`; `Segments()` | Modify |
| `backend/internal/write/segment.go` | `Segment` struct + validate + CRUD + `ReorderSegments` | Create |
| `backend/internal/handlers/writes.go` | segment handlers (+ reorder) | Modify |
| `backend/internal/handlers/handlers.go` | `Customers` reads `segmentId` | Modify |
| `backend/internal/server/server.go` | segment routes | Modify |
| `backend/api/openapi.yaml` + `internal/api/api.gen.go` | Segment schemas, `segment?` on Customer, `segmentId` param, reorder op; regen | Modify |
| `packages/api/src/client.ts` | segment methods + `listCustomers(...,segmentId)` | Modify |
| `apps/backoffice/src/screens/customers/SegmentManager.tsx` | rule manager (CRUD + up/down reorder) | Create |
| `apps/backoffice/src/screens/Customers.tsx` | tier→segment column, filter, Kelola button, export; drop `tier()` + tier props | Modify |
| `apps/backoffice/src/screens/customers/CustomerDetail.tsx` | tier→segment badge; drop tier props | Modify |

---

## Phase A — Backend

### Task A1: Migration 0029 (table + seed)

**Files:** Create `backend/internal/db/migrations/0029_customer_segments.sql`

- [ ] **Step 1: Confirm next slot**

Run: `git ls-files "backend/internal/db/migrations/" | sort | tail -3`
Expected: highest is `0028_*.sql`.

- [ ] **Step 2: Create the migration**

```sql
-- 0029_customer_segments.sql
-- SP-CRM-5a: configurable RFM segment rules. Segment is DERIVED (never stored on
-- customers); these rows are the editable rule set. First-match by sort_order.
CREATE TABLE customer_segments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  color      text NOT NULL,
  sort_order integer NOT NULL,
  r_min      integer,   -- days since last visit, inclusive
  r_max      integer,
  f_min      integer,   -- visit count, inclusive
  f_max      integer,
  m_min      numeric,   -- total spent, inclusive
  m_max      numeric,
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_customer_segments_order ON customer_segments(sort_order);

INSERT INTO customer_segments (name, color, sort_order, r_min, r_max, f_min, f_max, m_min, m_max) VALUES
  ('Baru',     'blue',   1, NULL, NULL, NULL, 1,    NULL,    NULL),
  ('Juara',    'purple', 2, NULL, 30,   5,    NULL, 2000000, NULL),
  ('Setia',    'green',  3, NULL, 60,   3,    NULL, NULL,    NULL),
  ('Berisiko', 'amber',  4, 60,   120,  2,    NULL, NULL,    NULL),
  ('Hilang',   'red',    5, 120,  NULL, NULL, NULL, NULL,    NULL),
  ('Biasa',    'gray',   6, NULL, NULL, NULL, NULL, NULL,    NULL);
```

- [ ] **Step 3: Build + commit**

Run: `cd backend && go build ./...` (Expected: builds)
```bash
git add backend/internal/db/migrations/0029_customer_segments.sql
git commit -m "feat(backend): migration 0029 customer_segments + seed 6 starter rules"
```

---

### Task A2: Read layer — segment computation + filter + list

**Files:** Modify `backend/internal/read/repo.go` (`customerObj` 639-642; `customerObjWithTags` 652-658; `Customers` 660-…; add `Segments`)

- [ ] **Step 1: Add the segment sub-select constants** (immediately ABOVE `const customerObj`, ~line 638)

```go
// segmentMatch: the RFM rule predicate. Correlates via BARE columns (last_visit,
// visit_count, total_spent) NOT customers.<col> — because customerObj is also used
// by RecentCustomersForOutlet which aliases `customers c`. Bare cols resolve to the
// outer customers row whatever its alias.
const segmentMatch = `s.is_active
  AND (s.r_min IS NULL OR (last_visit IS NOT NULL AND (now()::date - last_visit::date) >= s.r_min))
  AND (s.r_max IS NULL OR (last_visit IS NOT NULL AND (now()::date - last_visit::date) <= s.r_max))
  AND (s.f_min IS NULL OR visit_count >= s.f_min)
  AND (s.f_max IS NULL OR visit_count <= s.f_max)
  AND (s.m_min IS NULL OR total_spent >= s.m_min)
  AND (s.m_max IS NULL OR total_spent <= s.m_max)`

// segmentSel: the computed segment object (or NULL when no rule matches).
const segmentSel = `(SELECT json_build_object('id',s.id,'name',s.name,'color',s.color)
  FROM customer_segments s WHERE ` + segmentMatch + ` ORDER BY s.sort_order LIMIT 1)`

// segmentIdSel: just the matched segment id (for the list filter).
const segmentIdSel = `(SELECT s.id FROM customer_segments s WHERE ` + segmentMatch + ` ORDER BY s.sort_order LIMIT 1)`
```

- [ ] **Step 2: Fold `segment` into BOTH builders**

Replace `customerObj` (`read/repo.go:639-642`):
```go
const customerObj = `json_build_object('id',id,'name',name,'phone',phone,
  'email',email,'points',points,'totalSpent',total_spent,'visitCount',visit_count,
  'lastVisit',last_visit,'birthday',birthday,'anniversary',anniversary,
  'notes',notes,'createdAt',created_at)`
```
with:
```go
const customerObj = `json_build_object('id',id,'name',name,'phone',phone,
  'email',email,'points',points,'totalSpent',total_spent,'visitCount',visit_count,
  'lastVisit',last_visit,'birthday',birthday,'anniversary',anniversary,
  'notes',notes,'createdAt',created_at,
  'segment', ` + segmentSel + `)`
```
And in `customerObjWithTags` (`read/repo.go:652-658`), add the same `segment` entry alongside `tags` (it builds the same fields). Change its trailing lines so the object includes both `'segment', `+segmentSel and the existing `'tags', COALESCE(...)`:
```go
const customerObjWithTags = `json_build_object('id',id,'name',name,'phone',phone,
  'email',email,'points',points,'totalSpent',total_spent,'visitCount',visit_count,
  'lastVisit',last_visit,'birthday',birthday,'anniversary',anniversary,
  'notes',notes,'createdAt',created_at,
  'segment', ` + segmentSel + `,
  'tags', COALESCE((SELECT json_agg(json_build_object('id',t.id,'name',t.name,'color',t.color) ORDER BY t.name)
                    FROM customer_tags ct JOIN tags t ON t.id = ct.tag_id
                    WHERE ct.customer_id = customers.id), '[]'::json))`
```

- [ ] **Step 3: Add `segmentId` to `Customers`**

In `Customers(...)` (`read/repo.go:660`), change the signature to add `segmentId string` and add a segment filter fragment next to the existing `tagFilter`. The function currently builds `args` ($1 offset, $2 limit, $3 q) and conditionally appends tagId. Replace the signature + add the segment filter:
```go
func (r *Repo) Customers(ctx context.Context, page, limit int, q, sort, tagId, segmentId string) ([]api.Customer, int, error) {
	order := `ORDER BY total_spent DESC, created_at DESC`
	if sort == "terbaru" {
		order = `ORDER BY created_at DESC`
	}
	args := []any{off(page, limit), limit, q} // $1 offset, $2 limit, $3 q
	tagFilter := ""
	if tagId != "" {
		args = append(args, tagId)
		tagFilter = fmt.Sprintf(` AND EXISTS (SELECT 1 FROM customer_tags ct
			WHERE ct.customer_id = customers.id AND ct.tag_id = $%d::uuid)`, len(args))
	}
	segFilter := ""
	if segmentId != "" {
		args = append(args, segmentId)
		segFilter = fmt.Sprintf(` AND `+segmentIdSel+` = $%d::uuid`, len(args))
	}
	sql := `SELECT ` + customerObjWithTags + `, count(*) OVER() AS total
		   FROM customers
		  WHERE ($3 = '' OR name ILIKE '%' || $3 || '%' OR phone ILIKE '%' || $3 || '%' OR email ILIKE '%' || $3 || '%')` +
		tagFilter + segFilter + `
		  ` + order + `
		  OFFSET $1 LIMIT $2`
	return listJSON[api.Customer](ctx, r.Pool, sql, args...)
}
```
(Keep whatever the current body's exact tag-filter block looks like; just add the `segFilter` block + append `segFilter` to the WHERE and `segmentId` to the signature.)

- [ ] **Step 4: Add the `Segments` list read** (near the customer reads)

```go
// Segments lists all segment rules ordered by priority.
func (r *Repo) Segments(ctx context.Context) ([]api.Segment, error) {
	const sql = `SELECT json_build_object('id',id,'name',name,'color',color,
		'sortOrder',sort_order,'rMin',r_min,'rMax',r_max,'fMin',f_min,'fMax',f_max,
		'mMin',m_min,'mMax',m_max,'isActive',is_active,'createdAt',created_at)
		FROM customer_segments ORDER BY sort_order`
	rows, _, err := listJSON[api.Segment](ctx, r.Pool, sql)
	return rows, err
}
```
(`api.Segment` exists after A5's regen — this file compiles at A5 Step 5.)

---

### Task A3: Write layer — segment CRUD + reorder

**Files:** Create `backend/internal/write/segment.go`

- [ ] **Step 1: Create the file**

```go
package write

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// validSegmentColors mirrors the tag palette.
var validSegmentColors = map[string]bool{
	"amber": true, "blue": true, "green": true, "red": true,
	"purple": true, "gray": true, "pink": true, "teal": true,
}

type Segment struct {
	Name     string   `json:"name"`
	Color    string   `json:"color"`
	RMin     *int     `json:"rMin,omitempty"`
	RMax     *int     `json:"rMax,omitempty"`
	FMin     *int     `json:"fMin,omitempty"`
	FMax     *int     `json:"fMax,omitempty"`
	MMin     *float64 `json:"mMin,omitempty"`
	MMax     *float64 `json:"mMax,omitempty"`
	IsActive *bool    `json:"isActive,omitempty"`
}

func validateSegment(in Segment) error {
	if in.Name == "" {
		return fmt.Errorf("nama segmen wajib")
	}
	if !validSegmentColors[in.Color] {
		return fmt.Errorf("warna segmen tidak valid")
	}
	if in.RMin != nil && in.RMax != nil && *in.RMin > *in.RMax {
		return fmt.Errorf("R: minimum melebihi maksimum")
	}
	if in.FMin != nil && in.FMax != nil && *in.FMin > *in.FMax {
		return fmt.Errorf("F: minimum melebihi maksimum")
	}
	if in.MMin != nil && in.MMax != nil && *in.MMin > *in.MMax {
		return fmt.Errorf("M: minimum melebihi maksimum")
	}
	return nil
}

func active(in Segment) bool {
	if in.IsActive == nil {
		return true
	}
	return *in.IsActive
}

func (r *Repo) CreateSegment(ctx context.Context, in Segment) (string, error) {
	if err := validateSegment(in); err != nil {
		return "", err
	}
	var id string
	// New rules go last in priority.
	err := r.Pool.QueryRow(ctx,
		`INSERT INTO customer_segments (name, color, sort_order, r_min, r_max, f_min, f_max, m_min, m_max, is_active)
		 VALUES ($1,$2,(SELECT COALESCE(MAX(sort_order),0)+1 FROM customer_segments),$3,$4,$5,$6,$7,$8,$9)
		 RETURNING id`,
		in.Name, in.Color, in.RMin, in.RMax, in.FMin, in.FMax, in.MMin, in.MMax, active(in)).Scan(&id)
	if err != nil {
		return "", fmt.Errorf("create segment: %w", err)
	}
	return id, nil
}

func (r *Repo) UpdateSegment(ctx context.Context, id string, in Segment) error {
	if err := validateSegment(in); err != nil {
		return err
	}
	tag, err := r.Pool.Exec(ctx,
		`UPDATE customer_segments SET name=$2, color=$3, r_min=$4, r_max=$5,
		   f_min=$6, f_max=$7, m_min=$8, m_max=$9, is_active=$10 WHERE id=$1`,
		id, in.Name, in.Color, in.RMin, in.RMax, in.FMin, in.FMax, in.MMin, in.MMax, active(in))
	if err != nil {
		return fmt.Errorf("update segment: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (r *Repo) DeleteSegment(ctx context.Context, id string) error {
	tag, err := r.Pool.Exec(ctx, `DELETE FROM customer_segments WHERE id=$1`, id)
	if err != nil {
		return fmt.Errorf("delete segment: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// ReorderSegments sets each segment's sort_order to its index in orderedIds.
func (r *Repo) ReorderSegments(ctx context.Context, orderedIds []string) error {
	return r.tx(ctx, "customer_segments", func(t pgx.Tx) error {
		for i, id := range orderedIds {
			ct, err := t.Exec(ctx, `UPDATE customer_segments SET sort_order=$2 WHERE id=$1`, id, i+1)
			if err != nil {
				return err
			}
			if ct.RowsAffected() == 0 {
				return ErrNotFound
			}
		}
		return nil
	})
}
```
(Verify `r.Pool`, `r.tx(ctx, label, fn)`, `ErrNotFound` against `write/repo.go`/`write/tag.go` and match exactly. The `r.tx` label string is the cache-namespace tag — `"customer_segments"` is fine; the handler's `h.mutated` flushes the read cache regardless.)

- [ ] **Step 2: (build deferred to A5 — handlers reference `api.Segment*`)**

---

### Task A4: Handlers + routes

**Files:** Modify `backend/internal/handlers/writes.go`, `handlers.go`, `server/server.go`

- [ ] **Step 1: Segment handlers** (in `writes.go`, near the tag handlers)

```go
func (h *Handlers) Segments(w http.ResponseWriter, r *http.Request) {
	rows, err := h.Repo.Segments(r.Context())
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, http.StatusOK, api.SegmentListResponse{Data: rows})
}

func (h *Handlers) CreateSegment(w http.ResponseWriter, r *http.Request) {
	in, ok := decodeWrite[write.Segment](w, r)
	if !ok {
		return
	}
	id, err := h.Write.CreateSegment(r.Context(), in)
	h.created(w, r, id, err)
}

func (h *Handlers) UpdateSegment(w http.ResponseWriter, r *http.Request) {
	in, ok := decodeWrite[write.Segment](w, r)
	if !ok {
		return
	}
	h.mutated(w, r, h.Write.UpdateSegment(r.Context(), chi.URLParam(r, "id"), in))
}

func (h *Handlers) DeleteSegment(w http.ResponseWriter, r *http.Request) {
	h.mutated(w, r, h.Write.DeleteSegment(r.Context(), chi.URLParam(r, "id")))
}

func (h *Handlers) ReorderSegments(w http.ResponseWriter, r *http.Request) {
	in, ok := decodeWrite[api.ReorderSegmentsInput](w, r)
	if !ok {
		return
	}
	h.mutated(w, r, h.Write.ReorderSegments(r.Context(), in.OrderedIds))
}
```

- [ ] **Step 2: `segmentId` into the `Customers` handler** (`handlers.go`, the Customers handler — currently reads q/sort/tagId)

Add `segmentId := r.URL.Query().Get("segmentId")` and pass it as the new last arg:
```go
		q := strings.TrimSpace(r.URL.Query().Get("q"))
		sort := r.URL.Query().Get("sort")
		tagId := r.URL.Query().Get("tagId")
		segmentId := r.URL.Query().Get("segmentId")
		rows, total, err := h.Repo.Customers(r.Context(), p, l, q, sort, tagId, segmentId)
```

- [ ] **Step 3: Routes** (`server.go`, inside the `manage_customers` group with the tag routes)

```go
				r.Get("/segments", h.Segments)
				r.Post("/segments", h.CreateSegment)
				r.Put("/segments/reorder", h.ReorderSegments)
				r.Put("/segments/{id}", h.UpdateSegment)
				r.Delete("/segments/{id}", h.DeleteSegment)
```
(Register `/segments/reorder` BEFORE `/segments/{id}` so chi matches the static path first.)

---

### Task A5: OpenAPI + regen

**Files:** Modify `backend/api/openapi.yaml`; regen

- [ ] **Step 1: Schemas**

```yaml
    Segment:
      type: object
      required: [id, name, color, sortOrder, isActive, createdAt]
      properties:
        id: { type: string, format: uuid }
        name: { type: string }
        color: { type: string }
        sortOrder: { type: integer }
        rMin: { type: integer, nullable: true }
        rMax: { type: integer, nullable: true }
        fMin: { type: integer, nullable: true }
        fMax: { type: integer, nullable: true }
        mMin: { type: number, nullable: true }
        mMax: { type: number, nullable: true }
        isActive: { type: boolean }
        createdAt: { type: string, format: date-time }
    SegmentInput:
      type: object
      required: [name, color]
      properties:
        name: { type: string }
        color: { type: string }
        rMin: { type: integer, nullable: true }
        rMax: { type: integer, nullable: true }
        fMin: { type: integer, nullable: true }
        fMax: { type: integer, nullable: true }
        mMin: { type: number, nullable: true }
        mMax: { type: number, nullable: true }
        isActive: { type: boolean, nullable: true }
    SegmentListResponse:
      type: object
      required: [data]
      properties:
        data: { type: array, items: { $ref: '#/components/schemas/Segment' } }
    ReorderSegmentsInput:
      type: object
      required: [orderedIds]
      properties:
        orderedIds: { type: array, items: { type: string } }
    CustomerSegment:
      type: object
      required: [id, name, color]
      properties:
        id: { type: string, format: uuid }
        name: { type: string }
        color: { type: string }
```

- [ ] **Step 2: `segment` on `Customer`** (optional/nullable — null when no rule matches): in the `Customer` schema properties add:
```yaml
        segment: { allOf: [ { $ref: '#/components/schemas/CustomerSegment' } ], nullable: true }
```
(Use the `allOf`+`nullable` wrapper so a `$ref` can be nullable; if the file already uses a simpler `{ $ref, nullable: true }` convention elsewhere, match that.)

- [ ] **Step 3: `segmentId` param on `listCustomers`**:
```yaml
        - { in: query, name: segmentId, schema: { type: string } }
```

- [ ] **Step 4: Operations** — `/api/v1/segments` GET+POST, `/api/v1/segments/{id}` PUT+DELETE, `/api/v1/segments/reorder` PUT. Mirror the `tags` ops' YAML shape (operationIds `listSegments`, `createSegment`, `updateSegment`, `deleteSegment`, `reorderSegments`; createSegment request `SegmentInput`; reorder request `ReorderSegmentsInput`; reuse the tag ops' response blocks; `listSegments` → `SegmentListResponse`).

- [ ] **Step 5: Regen + build + gen-check**

```bash
cd backend && go tool oapi-codegen -config api/oapi-codegen.yaml api/openapi.yaml
cd .. && corepack pnpm --filter @mandalika/api gen
cd backend && go build ./... && go vet ./... && go test ./... && make gen-check
```
Expected: `api.Segment`/`SegmentInput`/`SegmentListResponse`/`ReorderSegmentsInput`/`CustomerSegment` exist; `ListCustomersParams.SegmentId`; `Customer.Segment`; whole backend compiles; tests green; gen-check clean.

- [ ] **Step 6: Commit the backend**

```bash
git add backend/internal/read/repo.go backend/internal/write/segment.go backend/internal/handlers/writes.go backend/internal/handlers/handlers.go backend/internal/server/server.go backend/api/openapi.yaml backend/internal/api/api.gen.go
git commit -m "feat(backend): configurable segment engine — rules, CRUD, reorder, computed segment on reads + segmentId filter"
```

---

## Phase B — TS client

### Task B1: segment methods + listCustomers segmentId

**Files:** Modify `packages/api/src/client.ts`

- [ ] **Step 1: Regen the TS schema** (so `S['Segment']` etc. exist — backend regen may have left `schema.d.ts` uncommitted/reverted):
```
corepack pnpm --filter @mandalika/api gen
```
Confirm `schema.d.ts` has `Segment`, `SegmentInput`, `SegmentListResponse`, `ReorderSegmentsInput`, `CustomerSegment`, `Customer.segment`, and the `segmentId` param.

- [ ] **Step 2: Types + interface**

Export near the other types:
```ts
export type Segment = S['Segment']
export type SegmentInput = S['SegmentInput']
```
Interface: change `listCustomers` to add `segmentId?: string` and add (after the tag methods):
```ts
  listCustomers: (page?: number, limit?: number, q?: string, sort?: string, tagId?: string, segmentId?: string) => Promise<ListResult<Customer>>
  listSegments: () => Promise<Segment[]>
  createSegment: (input: SegmentInput) => Promise<{ id: string }>
  updateSegment: (id: string, input: SegmentInput) => Promise<void>
  deleteSegment: (id: string) => Promise<void>
  reorderSegments: (orderedIds: string[]) => Promise<void>
```

- [ ] **Step 3: Implementation**
```ts
    listCustomers: (page = 1, limit = 50, q = '', sort = '', tagId = '', segmentId = '') =>
      list<Customer>(`${API}/customers`, {
        page, limit,
        ...(q ? { q } : {}),
        ...(sort ? { sort } : {}),
        ...(tagId ? { tagId } : {}),
        ...(segmentId ? { segmentId } : {}),
      }),
    listSegments: () => list<Segment>(`${API}/segments`).then((r) => r.data),
    createSegment: (input) => data<{ id: string }>('POST', `${API}/segments`, input),
    updateSegment: (id, input) => request<void>('PUT', `${API}/segments/${id}`, input),
    deleteSegment: (id) => request<void>('DELETE', `${API}/segments/${id}`),
    reorderSegments: (orderedIds) => request<void>('PUT', `${API}/segments/reorder`, { orderedIds }),
```
(Mirror the tag client style: `createSegment` returns `{id}` via `data<{id:string}>`; updates/reorder are `request<void>`. Confirm `list`/`data`/`request` helper names.)

- [ ] **Step 4: Typecheck + commit**

Run: `npx tsc -p packages/api --noEmit` (Expected: exit 0)
```bash
git add packages/api/src/client.ts packages/api/src/schema.d.ts
git commit -m "feat(api-client): segment CRUD + reorder + listCustomers segmentId"
```

---

## Phase C — Frontend

### Task C1: SegmentManager component

**Files:** Create `apps/backoffice/src/screens/customers/SegmentManager.tsx`

- [ ] **Step 1: Create it** — ordered rule list with up/down reorder, add/edit (name, color, R/F/M min/max, active toggle), delete with confirm. Mirrors `TagManager` structure; uses `tagChipClasses`/`TAG_COLORS` from `./tagColors` for the color picker + chips.

```tsx
import { useState } from 'react'
import type { Segment, SegmentInput } from '@mandalika/api'
import { Trash2, Plus, ChevronUp, ChevronDown } from 'lucide-react'
import { api } from '../../api'
import { Button, Input } from '../../ui'
import { TAG_COLORS, tagChipClasses } from './tagColors'

interface SegmentManagerProps {
  segments: Segment[]
  onChange: () => void // refetch after any mutation
}

const EMPTY: SegmentInput = { name: '', color: 'blue' }

function ColorPicker({ value, onPick }: { value: string; onPick: (c: string) => void }) {
  return (
    <div className="flex gap-1 flex-wrap">
      {TAG_COLORS.map((c) => (
        <button key={c} type="button" onClick={() => onPick(c)} aria-label={`Warna ${c}`}
          className={`w-6 h-6 rounded-full border-2 ${tagChipClasses(c)} ${value === c ? 'ring-2 ring-offset-1 ring-gray-500' : ''}`} />
      ))}
    </div>
  )
}

// Bounds editor: six optional number inputs (R/F/M min/max).
function Bounds({ form, set }: { form: SegmentInput; set: (patch: Partial<SegmentInput>) => void }) {
  const num = (v: string): number | null => (v === '' ? null : Number(v))
  const row = (label: string, minKey: keyof SegmentInput, maxKey: keyof SegmentInput) => (
    <div className="flex items-center gap-2">
      <span className="text-xs font-bold text-gray-500 w-28">{label}</span>
      <Input type="number" placeholder="min" value={(form[minKey] as number | null) ?? ''} onChange={(e) => set({ [minKey]: num(e.target.value) } as Partial<SegmentInput>)} />
      <Input type="number" placeholder="max" value={(form[maxKey] as number | null) ?? ''} onChange={(e) => set({ [maxKey]: num(e.target.value) } as Partial<SegmentInput>)} />
    </div>
  )
  return (
    <div className="space-y-1.5">
      {row('Recency (hari)', 'rMin', 'rMax')}
      {row('Frequency (kunjungan)', 'fMin', 'fMax')}
      {row('Monetary (belanja)', 'mMin', 'mMax')}
    </div>
  )
}

export function SegmentManager({ segments, onChange }: SegmentManagerProps) {
  const [form, setForm] = useState<SegmentInput>(EMPTY)
  const [editId, setEditId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<Segment | null>(null)
  const set = (patch: Partial<SegmentInput>) => setForm((f) => ({ ...f, ...patch }))

  const save = async () => {
    if (!form.name.trim()) { setErr('Nama segmen wajib'); return }
    setBusy(true); setErr(null)
    try {
      if (editId) await api.updateSegment(editId, form)
      else await api.createSegment(form)
      setForm(EMPTY); setEditId(null); onChange()
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : 'Gagal menyimpan segmen.') }
    finally { setBusy(false) }
  }
  const startEdit = (s: Segment) => {
    setEditId(s.id)
    setForm({ name: s.name, color: s.color, rMin: s.rMin, rMax: s.rMax, fMin: s.fMin, fMax: s.fMax, mMin: s.mMin, mMax: s.mMax, isActive: s.isActive })
  }
  const del = async (id: string) => {
    setBusy(true)
    try { await api.deleteSegment(id); setConfirmDelete(null); onChange() }
    catch (e: unknown) { setErr(e instanceof Error ? e.message : 'Gagal menghapus.') }
    finally { setBusy(false) }
  }
  const move = async (idx: number, dir: -1 | 1) => {
    const next = [...segments]
    const j = idx + dir
    if (j < 0 || j >= next.length) return
    ;[next[idx], next[j]] = [next[j], next[idx]]
    setBusy(true)
    try { await api.reorderSegments(next.map((s) => s.id)); onChange() }
    finally { setBusy(false) }
  }

  return (
    <div className="space-y-3">
      <div className="space-y-2 p-3 rounded-xl border border-gray-100">
        <p className="text-xs font-bold text-gray-700">{editId ? 'Edit Segmen' : 'Segmen Baru'}</p>
        <Input label="Nama" value={form.name} onChange={(e) => set({ name: e.target.value })} />
        <ColorPicker value={form.color} onPick={(c) => set({ color: c })} />
        <Bounds form={form} set={set} />
        <label className="flex items-center gap-2 text-xs font-bold text-gray-600">
          <input type="checkbox" checked={form.isActive ?? true} onChange={(e) => set({ isActive: e.target.checked })} className="accent-gold-600" /> Aktif
        </label>
        {err && <p className="text-xs text-red-600">{err}</p>}
        <div className="flex gap-2">
          <Button size="sm" icon={<Plus className="w-4 h-4" />} loading={busy} onClick={() => void save()}>{editId ? 'Simpan' : 'Tambah'}</Button>
          {editId && <Button size="sm" variant="secondary" onClick={() => { setEditId(null); setForm(EMPTY) }}>Batal</Button>}
        </div>
      </div>
      <p className="text-[11px] text-gray-400">Urutan = prioritas (cocok pertama menang).</p>
      <ul className="space-y-1">
        {segments.map((s, i) => (
          <li key={s.id} className="flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg bg-gray-50">
            <span className={`px-2 py-0.5 rounded-full text-xs font-bold border ${tagChipClasses(s.color)} ${s.isActive ? '' : 'opacity-40'}`}>{s.name}</span>
            <div className="flex items-center gap-1">
              <button type="button" aria-label="Naik" disabled={busy || i === 0} onClick={() => void move(i, -1)} className="p-1 text-gray-400 hover:text-gray-700 disabled:opacity-30"><ChevronUp className="w-3.5 h-3.5" /></button>
              <button type="button" aria-label="Turun" disabled={busy || i === segments.length - 1} onClick={() => void move(i, 1)} className="p-1 text-gray-400 hover:text-gray-700 disabled:opacity-30"><ChevronDown className="w-3.5 h-3.5" /></button>
              <button type="button" className="text-xs text-gray-500 hover:text-gray-900" onClick={() => startEdit(s)}>Edit</button>
              <button type="button" aria-label={`Hapus ${s.name}`} className="p-1 text-gray-400 hover:text-red-500" onClick={() => setConfirmDelete(s)}><Trash2 className="w-3.5 h-3.5" /></button>
            </div>
          </li>
        ))}
      </ul>
      {confirmDelete && (
        <div className="p-3 rounded-xl border border-red-200 bg-red-50 space-y-2">
          <p className="text-xs text-gray-700">Hapus segmen <strong>&ldquo;{confirmDelete.name}&rdquo;</strong>? Pelanggan akan dihitung ulang ke segmen lain.</p>
          <div className="flex gap-2">
            <Button variant="secondary" className="flex-1 text-xs py-1.5" onClick={() => setConfirmDelete(null)} disabled={busy}>Batal</Button>
            <Button variant="danger" className="flex-1 text-xs py-1.5" loading={busy} onClick={() => void del(confirmDelete.id)}>Hapus</Button>
          </div>
        </div>
      )}
    </div>
  )
}
```
(Verify shared `ui` `Button`/`Input` prop names — `size`/`icon`/`loading`/`variant`/`label`/`type` — against existing usage and adjust. The `[minKey]: ...` computed-key writes may need a small cast; keep `SegmentInput` typing intact.)

- [ ] **Step 2: Typecheck + commit**

Run: `cd apps/backoffice && npx tsc -b` (Expected: passes)
```bash
git add apps/backoffice/src/screens/customers/SegmentManager.tsx
git commit -m "feat(backoffice): segment rule manager (CRUD + up/down reorder)"
```

---

### Task C2: List — tier→segment column, filter, Kelola button, export

**Files:** Modify `apps/backoffice/src/screens/Customers.tsx`

- [ ] **Step 1: Add segment state + segments query**

After the `tagId` state/query, add:
```tsx
  const [segmentId, setSegmentId] = useState('')
  const segmentsQ = usePolledQuery<Segment[]>(() => api.listSegments(), [])
  const allSegments = segmentsQ.data ?? []
  const [segModalOpen, setSegModalOpen] = useState(false)
```
Add imports: `import type { Segment } from '@mandalika/api'`, `import { SegmentManager } from './customers/SegmentManager'`. (`tagChipClasses` is already imported.)

- [ ] **Step 2: Thread `segmentId` into the list query**

Add `segmentId` as the 6th arg to `api.listCustomers(...)` and to the deps array.

- [ ] **Step 3: Remove the `tier()` helper**

Delete the `const tier = (spent) => {...}` definition (~line 216) and the `const t = tier(c.totalSpent)` line (~412). (It's being replaced by `c.segment`.)

- [ ] **Step 4: Replace the Tier column header** (line 406)

Replace:
```tsx
                      {loyalty.tierEnabled && <th className="text-left px-5 py-3 text-xs font-black text-gray-400 uppercase tracking-wider hidden sm:table-cell">Tier</th>}
```
with (always shown — segments aren't gated by tierEnabled):
```tsx
                      <th className="text-left px-5 py-3 text-xs font-black text-gray-400 uppercase tracking-wider hidden sm:table-cell">Segmen</th>
```

- [ ] **Step 5: Replace the Tier cell** (lines 450-454)

Replace:
```tsx
                          {loyalty.tierEnabled && (
                            <td className="px-5 py-3 hidden sm:table-cell">
                              <span className={`px-2.5 py-1 text-xs font-bold rounded-lg ${t.color}`}>{t.label}</span>
                            </td>
                          )}
```
with:
```tsx
                          <td className="px-5 py-3 hidden sm:table-cell">
                            {c.segment
                              ? <span className={`px-2.5 py-1 text-xs font-bold rounded-full border ${tagChipClasses(c.segment.color)}`}>{c.segment.name}</span>
                              : <span className="text-xs text-gray-300">—</span>}
                          </td>
```

- [ ] **Step 6: Add the segment filter dropdown + Kelola button** (next to the tag filter / sort row)
```tsx
          <select value={segmentId} onChange={(e) => { setSegmentId(e.target.value); setPage(1) }}
            className="text-xs font-bold rounded-lg border border-gray-200 px-2 py-1.5 bg-white text-gray-700">
            <option value="">Semua segmen</option>
            {allSegments.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <Button variant="secondary" size="sm" onClick={() => setSegModalOpen(true)}>Kelola Segmen</Button>
```

- [ ] **Step 7: Add the manager modal** (near the other modals in the returned tree)
```tsx
      <Modal open={segModalOpen} onClose={() => setSegModalOpen(false)} title="Kelola Segmen">
        <SegmentManager segments={allSegments} onChange={() => void segmentsQ.refetch()} />
      </Modal>
```

- [ ] **Step 8: Export column** — in `exportCustomers` row mapping add:
```tsx
      Segmen: c.segment?.name ?? '',
```

- [ ] **Step 9: Build + commit**

Run: `cd apps/backoffice && npx tsc -b && npx vite build` (Expected: both succeed; fix any leftover `tier`/`loyalty.tierEnabled`-column references)
```bash
git add apps/backoffice/src/screens/Customers.tsx
git commit -m "feat(backoffice): customer list segment column + filter + manager + export (replaces tier)"
```

---

### Task C3: Detail — tier→segment badge

**Files:** Modify `apps/backoffice/src/screens/customers/CustomerDetail.tsx`

- [ ] **Step 1: Drop the tier props + helper usage**

Remove `tierEnabled` and `tier` from `CustomerDetailProps` (lines 21-22) and from the destructured params (line 32); remove `const t = tier(c.totalSpent)` (line 83).

- [ ] **Step 2: Replace the tier badge** (lines 100-102)

Replace:
```tsx
            {tierEnabled && (
              <span className={`inline-block mt-1 px-2.5 py-1 text-xs font-bold rounded-lg ${t.color}`}>{t.label}</span>
            )}
```
with:
```tsx
            {c.segment && (
              <span className={`inline-block mt-1 px-2.5 py-1 text-xs font-bold rounded-full border ${tagChipClasses(c.segment.color)}`}>{c.segment.name}</span>
            )}
```

- [ ] **Step 3: Update the caller in `Customers.tsx`**

Where `<CustomerDetail ... tier={tier} tierEnabled={loyalty.tierEnabled} ... />` is rendered, remove the `tier` and `tierEnabled` props (the component no longer accepts them). (`loyaltyEnabled` stays.)

- [ ] **Step 4: Build + commit**

Run: `cd apps/backoffice && npx tsc -b && npx vite build` (Expected: both succeed)
```bash
git add apps/backoffice/src/screens/customers/CustomerDetail.tsx apps/backoffice/src/screens/Customers.tsx
git commit -m "feat(backoffice): customer detail segment badge (replaces tier)"
```

---

## Phase D — Verification

### Task D1: Gates + deploy + authed live check

**Files:** none

- [ ] **Step 1: Full local gate**
```bash
cd backend && go build ./... && go vet ./... && go test ./... && make gen-check
cd .. && npx tsc -p packages/api --noEmit
cd apps/backoffice && npx tsc -b && npx vite build
```
Expected: all green.

- [ ] **Step 2: Deploy + readiness**

`gcloud run deploy mandalika-pos --source backend --region asia-southeast2 --quiet`
then `curl -fsS https://mandalika-pos-538849926142.asia-southeast2.run.app/readyz` → ready (migration 0029 applies + seeds).

- [ ] **Step 3: Authed live check (one-time SEED_ADMIN_PASSWORD; admin `admin@mandalika.test`)**

Throwaway `_verify_crm5a.mjs` (login → bearer `data.access`). Assert:
1. `GET /segments` returns the 6 seeded, ordered by sortOrder.
2. computed `segment` on `GET /customers?limit=...`: each customer's `segment` is non-null (Biasa catch-all) and matches the expected first-match for its R/F/M; create a temp customer with no orders (visitCount 0, lastVisit null) → segment "Baru".
3. `GET /customers?segmentId=<Biasa id>` returns only customers whose computed segment is Biasa; composes with `&q=`; pagination meta ok.
4. segment CRUD: create a segment (sort_order = max+1); update; `PUT /segments/reorder` with a reordered id list changes priority (re-fetch shows new order); delete; invalid color + `rMin>rMax` rejected.
5. `segment` IS present on `/sync/customers/lookup` + `/customers/by-phone` (POS-ready for 5b).
Clean up the temp customer + any created segment. Delete the script.

- [ ] **Step 4: Push + report**

`git push origin prod-hardening`. Document results + USER-PENDING visual (Segmen column/chips, filter, manager CRUD + reorder, detail badge). Backoffice auto-deploys via Cloudflare; no APK.

---

## Self-Review (completed)

- **Spec coverage:** rules table + seed 6 (A1) ✓; lateral first-match computation, bare-column correlation, null-lastVisit→Baru, no-match→null (A2 `segmentMatch`/`segmentSel`) ✓; segment on SHARED customerObj → POS-ready + also in customerObjWithTags (A2) ✓; segmentId filter composing with q/sort/tag/pagination (A2/A4/B1/C2) ✓; segment CRUD + reorder, color + min≤max validation (A3/A4/A5) ✓; backoffice tier→segment column+badge, filter, manager, export (C2/C3) ✓; POS getCustomerTier + tierEnabled untouched (no apps/pos, no sync.go in scope) ✓; verification incl. POS-read-has-segment check (D1 #5) ✓.
- **Placeholder scan:** none — real code in every step; "verify ui prop names" notes are accuracy guards.
- **Type consistency:** `Customers(ctx,page,limit,q,sort,tagId,segmentId)` (A2) matches the handler (A4 Step 2) — and `sync.go` does NOT call `Customers()` (uses `RecentCustomersForOutlet` since SP-CRM-3 P2), so no sync ripple; `write.Segment` fields (A3) ↔ `SegmentInput` (A5) ↔ client `SegmentInput` (B1); `ReorderSegmentsInput.OrderedIds`/`orderedIds` consistent A3/A4/A5/B1/C1; `c.segment` ({id,name,color}) used in C2/C3 matches `CustomerSegment` (A5); `segmentMatch` reused by both `segmentSel` and `segmentIdSel`.
- **Cross-task note:** A2–A5 are interdependent (`api.Segment*` from A5 regen) — implement Phase A as one unit; first green build at A5 Step 5. C3 edits the same `Customers.tsx` caller line as C2's CustomerDetail render — do C2 then C3 (or commit together).
