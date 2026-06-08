# SP-CRM-4 — Manual Tags Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a managed, colored customer-tag system (CRUD + assign on the detail hub + colored chips on list rows + single-tag server-side filter), backoffice-only, without leaking tags into the lean POS sync.

**Architecture:** A `tags` table + `customer_tags` join (migration 0028). Tags hydrate ONLY on the backoffice list + detail reads via a new `customerObjWithTags` builder; the shared `customerObj` (POS sync / lookup / by-phone) stays tag-free, so `tags` is an optional field on `Customer`. Tag CRUD mirrors the existing ingredient-category pattern; assignment is set-the-whole-set via `PUT /customers/{id}/tags`.

**Tech Stack:** Go (pgx, chi, oapi-codegen), Postgres (Neon), React + TS (Vite) backoffice, shared `@mandalika/api`.

**Spec:** `docs/superpowers/specs/2026-06-08-crm-sp4-manual-tags-design.md`

---

## Testing posture (read first)
- **Backend:** DB-bound reads/writes verified by `go build`/`go vet`/`go test ./...` then an **authed live check** (Phase D) — repo norm.
- **Frontend:** no test runner — `tsc -b` + `vite build` + live + visual.
- **Commits:** `git add <paths>` then `git commit` as SEPARATE commands (chained `&&` trips the hook). Never `--no-verify`. Conventional commits, no attribution footer.
- **gen-check:** after any `openapi.yaml` edit, regen + commit `api.gen.go`.
- Deployed admin login email = `admin@mandalika.test`.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `backend/internal/db/migrations/0028_customer_tags.sql` | `tags` + `customer_tags` | Create |
| `backend/internal/read/repo.go` | `customerObjWithTags`; `Customers` (+tagId, uses with-tags); `Customer` detail (uses with-tags); `Tags()` list | Modify |
| `backend/internal/write/tag.go` | `Tag` struct + CRUD + color validation + `SetCustomerTags` | Create |
| `backend/internal/handlers/writes.go` | tag CRUD handlers + `SetCustomerTags` handler; `Customers` reads `tagId` (in handlers.go) | Modify |
| `backend/internal/handlers/handlers.go` | `Customers` handler reads `tagId` | Modify |
| `backend/internal/server/server.go` | tag routes | Modify |
| `backend/api/openapi.yaml` + `internal/api/api.gen.go` | Tag schemas, `tags?` on Customer, `tagId` param, setCustomerTags op; regen | Modify |
| `packages/api/src/client.ts` | tag methods + `listCustomers(...,tagId)` | Modify |
| `apps/backoffice/src/screens/customers/tagColors.ts` | palette token → chip classes | Create |
| `apps/backoffice/src/screens/customers/TagManager.tsx` | tag CRUD panel | Create |
| `apps/backoffice/src/screens/customers/CustomerDetail.tsx` | tag section (chips + picker + manager) | Modify |
| `apps/backoffice/src/screens/Customers.tsx` | tag filter + row chips + export column | Modify |

---

## Phase A — Backend

### Task A1: Migration 0028

**Files:** Create `backend/internal/db/migrations/0028_customer_tags.sql`

- [ ] **Step 1: Confirm next slot**

Run: `git ls-files "backend/internal/db/migrations/" | sort | tail -3`
Expected: highest is `0027_*.sql`.

- [ ] **Step 2: Create the migration**

```sql
-- 0028_customer_tags.sql
-- SP-CRM-4: managed customer tags (many-to-many).
CREATE TABLE tags (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL UNIQUE,
  color      text NOT NULL,
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

- [ ] **Step 3: Build + commit**

Run: `cd backend && go build ./...` (Expected: builds)
```bash
git add backend/internal/db/migrations/0028_customer_tags.sql
git commit -m "feat(backend): migration 0028 customer tags + customer_tags join"
```

---

### Task A2: Read layer — tag-aware builder, Customers(+tagId), Customer detail, Tags list

**Files:** Modify `backend/internal/read/repo.go` (`customerObj` ~639; `Customers` 644-656; `Customer` 708-711)

- [ ] **Step 1: Add the tag-aware builder after `customerObj`**

After the `customerObj` const (`backend/internal/read/repo.go:642`), add:
```go
// customerObjWithTags = customerObj + the customer's tags. Used ONLY by the
// backoffice list + detail reads; the shared customerObj stays tag-free so the
// POS sync / lookup / by-phone payloads don't carry tags. Correlates via the
// unaliased `customers.id` (callers keep `FROM customers` unaliased).
const customerObjWithTags = `json_build_object('id',id,'name',name,'phone',phone,
  'email',email,'points',points,'totalSpent',total_spent,'visitCount',visit_count,
  'lastVisit',last_visit,'birthday',birthday,'anniversary',anniversary,
  'notes',notes,'createdAt',created_at,
  'tags', COALESCE((SELECT json_agg(json_build_object('id',t.id,'name',t.name,'color',t.color) ORDER BY t.name)
                    FROM customer_tags ct JOIN tags t ON t.id = ct.tag_id
                    WHERE ct.customer_id = customers.id), '[]'::json))`
```

- [ ] **Step 2: Rewrite `Customers` to use the tag-aware builder + a `tagId` filter**

Replace (`backend/internal/read/repo.go:644-656`):
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
```
with:
```go
func (r *Repo) Customers(ctx context.Context, page, limit int, q, sort, tagId string) ([]api.Customer, int, error) {
	// `order` is a fixed internal string (never user input) — safe to concatenate.
	order := `ORDER BY total_spent DESC, created_at DESC`
	if sort == "terbaru" {
		order = `ORDER BY created_at DESC`
	}
	args := []any{off(page, limit), limit, q} // $1 offset, $2 limit, $3 q
	tagFilter := ""
	if tagId != "" {
		args = append(args, tagId) // $4
		tagFilter = ` AND EXISTS (SELECT 1 FROM customer_tags ct
			WHERE ct.customer_id = customers.id AND ct.tag_id = $4::uuid)`
	}
	sql := `SELECT ` + customerObjWithTags + `, count(*) OVER() AS total
		   FROM customers
		  WHERE ($3 = '' OR name ILIKE '%' || $3 || '%' OR phone ILIKE '%' || $3 || '%' OR email ILIKE '%' || $3 || '%')` +
		tagFilter + `
		  ` + order + `
		  OFFSET $1 LIMIT $2`
	return listJSON[api.Customer](ctx, r.Pool, sql, args...)
}
```

- [ ] **Step 3: Make the `Customer` detail read tag-aware**

Replace (`backend/internal/read/repo.go:708-711`):
```go
func (r *Repo) Customer(ctx context.Context, id string) (api.Customer, error) {
	return oneJSON[api.Customer](ctx, r.Pool,
		`SELECT `+customerObj+` FROM customers WHERE id=$1`, id)
}
```
with:
```go
func (r *Repo) Customer(ctx context.Context, id string) (api.Customer, error) {
	return oneJSON[api.Customer](ctx, r.Pool,
		`SELECT `+customerObjWithTags+` FROM customers WHERE id=$1`, id)
}
```

- [ ] **Step 4: Add the `Tags` list read**

Add near the customer reads (after `Customer`, before the Promotions section at line 713):
```go
// Tags lists all customer tags ordered by sort_order then name.
func (r *Repo) Tags(ctx context.Context) ([]api.Tag, error) {
	const sql = `SELECT json_build_object('id',id,'name',name,'color',color,
		'sortOrder',sort_order,'createdAt',created_at)
		FROM tags ORDER BY sort_order NULLS LAST, name ASC`
	rows, _, err := listJSON[api.Tag](ctx, r.Pool, sql)
	return rows, err
}
```
(`api.Tag` doesn't exist until A5's regen — this file won't compile until A5. Implement A2–A5 together; build at the end of A5.)

---

### Task A3: Write layer — tag CRUD + SetCustomerTags

**Files:** Create `backend/internal/write/tag.go`

- [ ] **Step 1: Create the file**

```go
package write

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// validTagColors is the preset palette; writes reject anything else.
var validTagColors = map[string]bool{
	"amber": true, "blue": true, "green": true, "red": true,
	"purple": true, "gray": true, "pink": true, "teal": true,
}

type Tag struct {
	Name      string `json:"name"`
	Color     string `json:"color"`
	SortOrder *int   `json:"sortOrder,omitempty"`
}

func validateTag(in Tag) error {
	if in.Name == "" {
		return fmt.Errorf("nama tag wajib")
	}
	if !validTagColors[in.Color] {
		return fmt.Errorf("warna tag tidak valid")
	}
	return nil
}

func (r *Repo) CreateTag(ctx context.Context, in Tag) (string, error) {
	if err := validateTag(in); err != nil {
		return "", err
	}
	var id string
	err := r.Pool.QueryRow(ctx,
		`INSERT INTO tags (name, color, sort_order) VALUES ($1,$2,$3) RETURNING id`,
		in.Name, in.Color, in.SortOrder).Scan(&id)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return "", fmt.Errorf("nama tag sudah dipakai")
		}
		return "", fmt.Errorf("create tag: %w", err)
	}
	return id, nil
}

func (r *Repo) UpdateTag(ctx context.Context, id string, in Tag) error {
	if err := validateTag(in); err != nil {
		return err
	}
	tag, err := r.Pool.Exec(ctx,
		`UPDATE tags SET name=$2, color=$3, sort_order=$4 WHERE id=$1`,
		id, in.Name, in.Color, in.SortOrder)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return fmt.Errorf("nama tag sudah dipakai")
		}
		return fmt.Errorf("update tag: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (r *Repo) DeleteTag(ctx context.Context, id string) error {
	// customer_tags FK is ON DELETE CASCADE — assignments are removed with the tag.
	tag, err := r.Pool.Exec(ctx, `DELETE FROM tags WHERE id=$1`, id)
	if err != nil {
		return fmt.Errorf("delete tag: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// SetCustomerTags replaces a customer's entire tag set in one transaction.
func (r *Repo) SetCustomerTags(ctx context.Context, customerID string, tagIDs []string) error {
	return r.tx(ctx, "customers", func(t pgx.Tx) error {
		var exists bool
		if err := t.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM customers WHERE id=$1)`, customerID).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return ErrNotFound
		}
		if _, err := t.Exec(ctx, `DELETE FROM customer_tags WHERE customer_id=$1`, customerID); err != nil {
			return err
		}
		for _, tagID := range tagIDs {
			if _, err := t.Exec(ctx,
				`INSERT INTO customer_tags (customer_id, tag_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
				customerID, tagID); err != nil {
				return err
			}
		}
		return nil
	})
}
```
(Verify against the file's actual helpers: `r.Pool`, `r.tx(ctx, label, fn)`, and `ErrNotFound` are all used by `write/ingredient.go` / `write/repo.go` — mirror their exact usage. `pgconn` import path matches `write/ingredient.go`.)

- [ ] **Step 2: (deferred build — compiles after A5 regen adds `api.Tag`)**

Tag CRUD here uses `write.Tag` (local), no `api.Tag` — but the handlers (A4) reference `api.Tag*` types, so build at the end of A5.

---

### Task A4: Handlers + routes

**Files:** Modify `backend/internal/handlers/writes.go`, `backend/internal/handlers/handlers.go`, `backend/internal/server/server.go`

- [ ] **Step 1: Add tag handlers** (in `writes.go`, near the ingredient-category handlers ~452-479)

```go
func (h *Handlers) Tags(w http.ResponseWriter, r *http.Request) {
	rows, err := h.Repo.Tags(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, api.TagListResponse{Data: rows})
}

func (h *Handlers) CreateTag(w http.ResponseWriter, r *http.Request) {
	in, ok := decodeWrite[write.Tag](w, r)
	if !ok {
		return
	}
	id, err := h.Write.CreateTag(r.Context(), in)
	h.created(w, r, id, err)
}

func (h *Handlers) UpdateTag(w http.ResponseWriter, r *http.Request) {
	in, ok := decodeWrite[write.Tag](w, r)
	if !ok {
		return
	}
	h.mutated(w, r, h.Write.UpdateTag(r.Context(), chi.URLParam(r, "id"), in))
}

func (h *Handlers) DeleteTag(w http.ResponseWriter, r *http.Request) {
	h.mutated(w, r, h.Write.DeleteTag(r.Context(), chi.URLParam(r, "id")))
}

func (h *Handlers) SetCustomerTags(w http.ResponseWriter, r *http.Request) {
	in, ok := decodeWrite[struct {
		TagIds []string `json:"tagIds"`
	}](w, r)
	if !ok {
		return
	}
	h.mutated(w, r, h.Write.SetCustomerTags(r.Context(), chi.URLParam(r, "id"), in.TagIds))
}
```
(Confirm the helper names by reading `writes.go`: `writeJSON`, `writeErr`, `decodeWrite[T]`, `h.created`, `h.mutated` are all used there. If `decodeWrite` can't take an anonymous struct cleanly, define a small named `setCustomerTagsBody` struct above the handler instead.)

- [ ] **Step 2: Thread `tagId` into the `Customers` handler** (in `handlers.go:247-258`)

Replace the handler body's read + call:
```go
		q := strings.TrimSpace(r.URL.Query().Get("q"))
		sort := r.URL.Query().Get("sort")
		rows, total, err := h.Repo.Customers(r.Context(), p, l, q, sort)
```
with:
```go
		q := strings.TrimSpace(r.URL.Query().Get("q"))
		sort := r.URL.Query().Get("sort")
		tagId := r.URL.Query().Get("tagId")
		rows, total, err := h.Repo.Customers(r.Context(), p, l, q, sort, tagId)
```

- [ ] **Step 3: Register routes** (in `server.go`, inside the `manage_customers` group — the one at ~150-155 that already holds `/customers/by-phone` + the customer writes)

```go
				r.Get("/tags", h.Tags)
				r.Post("/tags", h.CreateTag)
				r.Put("/tags/{id}", h.UpdateTag)
				r.Delete("/tags/{id}", h.DeleteTag)
				r.Put("/customers/{id}/tags", h.SetCustomerTags)
```

---

### Task A5: OpenAPI + regen

**Files:** Modify `backend/api/openapi.yaml`; regen `backend/internal/api/api.gen.go`

- [ ] **Step 1: Add schemas** (mirror `IngredientCategory*`)

```yaml
    Tag:
      type: object
      required: [id, name, color, createdAt]
      properties:
        id: { type: string, format: uuid }
        name: { type: string }
        color: { type: string }
        sortOrder: { type: integer, nullable: true }
        createdAt: { type: string, format: date-time }
    TagInput:
      type: object
      required: [name, color]
      properties:
        name: { type: string }
        color: { type: string }
        sortOrder: { type: integer, nullable: true }
    TagListResponse:
      type: object
      required: [data]
      properties:
        data: { type: array, items: { $ref: '#/components/schemas/Tag' } }
    SetCustomerTagsInput:
      type: object
      required: [tagIds]
      properties:
        tagIds: { type: array, items: { type: string } }
```

- [ ] **Step 2: Add `tags` to the `Customer` schema** (optional/nullable — absent on tag-free reads)

In the `Customer` schema properties add:
```yaml
        tags: { type: array, items: { $ref: '#/components/schemas/Tag' }, nullable: true }
```

- [ ] **Step 3: Add `tagId` to `listCustomers`** parameters:
```yaml
        - { in: query, name: tagId, schema: { type: string } }
```

- [ ] **Step 4: Add the operations** (`/api/v1/tags` GET+POST, `/api/v1/tags/{id}` PUT+DELETE, `/api/v1/customers/{id}/tags` PUT). Mirror the `ingredient-categories` operations' YAML shape exactly (operationIds: `listTags`, `createTag`, `updateTag`, `deleteTag`, `setCustomerTags`; tag-writes/PUT return `MutationResponse`/`CreatedResponse` or whatever the ingredient-category ops use — copy their `responses:` blocks). `listTags` → `TagListResponse`; `createTag` request `TagInput`; `setCustomerTags` request `SetCustomerTagsInput`.

- [ ] **Step 5: Regen + gen-check + build**

```bash
cd backend && go tool oapi-codegen -config api/oapi-codegen.yaml api/openapi.yaml
cd .. && corepack pnpm --filter @mandalika/api gen
cd backend && go build ./... && go vet ./... && go test ./... && make gen-check
```
Expected: `api.Tag`/`api.TagInput`/`api.TagListResponse` exist; the whole backend (A2 reads, A3 writes, A4 handlers) now compiles; tests green; gen-check clean.

- [ ] **Step 6: Commit the backend**

```bash
git add backend/internal/db/migrations/0028_customer_tags.sql backend/internal/read/repo.go backend/internal/write/tag.go backend/internal/handlers/writes.go backend/internal/handlers/handlers.go backend/internal/server/server.go backend/api/openapi.yaml backend/internal/api/api.gen.go
git commit -m "feat(backend): customer tags — table, CRUD, set-assignment, tag-aware reads + tagId filter"
```
(A1's migration was already committed in Task A1; this commits the rest. If A1 wasn't committed separately, include it.)

---

## Phase B — TS client

### Task B1: Tag methods + listCustomers tagId

**Files:** Modify `packages/api/src/client.ts`

- [ ] **Step 1: Export the `Tag` types** (near the other `S[...]` type exports ~line 60)
```ts
export type Tag = S['Tag']
export type TagInput = S['TagInput']
```

- [ ] **Step 2: Interface** — change `listCustomers` and add tag methods (after `getCustomersByPhone`/`lookupCustomers`):
```ts
  listCustomers: (page?: number, limit?: number, q?: string, sort?: string, tagId?: string) => Promise<ListResult<Customer>>
  listTags: () => Promise<Tag[]>
  createTag: (input: TagInput) => Promise<Tag>
  updateTag: (id: string, input: TagInput) => Promise<Tag>
  deleteTag: (id: string) => Promise<void>
  setCustomerTags: (id: string, tagIds: string[]) => Promise<void>
```

- [ ] **Step 3: Implementation**
```ts
    listCustomers: (page = 1, limit = 50, q = '', sort = '', tagId = '') =>
      list<Customer>(`${API}/customers`, {
        page,
        limit,
        ...(q ? { q } : {}),
        ...(sort ? { sort } : {}),
        ...(tagId ? { tagId } : {}),
      }),
    listTags: () => list<Tag>(`${API}/tags`).then((r) => r.data),
    createTag: (input) => data<Tag>('POST', `${API}/tags`, input),
    updateTag: (id, input) => data<Tag>('PUT', `${API}/tags/${id}`, input),
    deleteTag: (id) => request<void>('DELETE', `${API}/tags/${id}`),
    setCustomerTags: (id, tagIds) => request<void>('PUT', `${API}/customers/${id}/tags`, { tagIds }),
```
(Confirm `list`/`data`/`request` helper names from the surrounding code; `listTags` uses `list<Tag>` because `TagListResponse` is `{data: Tag[]}`. `createTag`/`updateTag` use `data<Tag>` if those ops return `{data: Tag}` — if the ingredient-category create returns a bare id/`{data:{id}}`, match that shape instead. Verify against how `createCategory`/`createIngredientCategory` are implemented and mirror.)

- [ ] **Step 4: Typecheck + commit**

Run: `npx tsc -p packages/api --noEmit` (Expected: exit 0)
```bash
git add packages/api/src/client.ts packages/api/src/schema.d.ts
git commit -m "feat(api-client): tag CRUD + setCustomerTags + listCustomers tagId"
```

---

## Phase C — Frontend

### Task C1: Color palette helper

**Files:** Create `apps/backoffice/src/screens/customers/tagColors.ts`

- [ ] **Step 1: Create it**
```ts
// Preset tag palette — single source of truth for chip styling. Must match the
// backend's validTagColors tokens (amber/blue/green/red/purple/gray/pink/teal).
export const TAG_COLORS = ['amber', 'blue', 'green', 'red', 'purple', 'gray', 'pink', 'teal'] as const
export type TagColor = (typeof TAG_COLORS)[number]

const CLASSES: Record<string, string> = {
  amber: 'bg-amber-100 text-amber-800 border-amber-200',
  blue: 'bg-blue-100 text-blue-800 border-blue-200',
  green: 'bg-green-100 text-green-800 border-green-200',
  red: 'bg-red-100 text-red-800 border-red-200',
  purple: 'bg-purple-100 text-purple-800 border-purple-200',
  gray: 'bg-gray-100 text-gray-700 border-gray-200',
  pink: 'bg-pink-100 text-pink-800 border-pink-200',
  teal: 'bg-teal-100 text-teal-800 border-teal-200',
}

/** Chip classes for a color token; falls back to gray for unknown tokens. */
export function tagChipClasses(color: string): string {
  return CLASSES[color] ?? CLASSES.gray
}
```

- [ ] **Step 2: Typecheck + commit**

Run: `cd apps/backoffice && npx tsc -b` (Expected: passes)
```bash
git add apps/backoffice/src/screens/customers/tagColors.ts
git commit -m "feat(backoffice): tag color palette helper"
```

---

### Task C2: TagManager component

**Files:** Create `apps/backoffice/src/screens/customers/TagManager.tsx`

- [ ] **Step 1: Create it** (create/rename/recolor/delete; mirrors CategoryManager's inline-confirm spirit)
```tsx
import { useState } from 'react'
import type { Tag } from '@mandalika/api'
import { Trash2, Plus, Check, X } from 'lucide-react'
import { api } from '../../api'
import { Button, Input } from '../../ui'
import { TAG_COLORS, tagChipClasses } from './tagColors'

interface TagManagerProps {
  tags: Tag[]
  onChange: () => void // refetch tags after any mutation
}

export function TagManager({ tags, onChange }: TagManagerProps) {
  const [name, setName] = useState('')
  const [color, setColor] = useState<string>('amber')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [editId, setEditId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editColor, setEditColor] = useState('amber')
  const [confirmDelete, setConfirmDelete] = useState<Tag | null>(null)

  const ColorPicker = ({ value, onPick }: { value: string; onPick: (c: string) => void }) => (
    <div className="flex gap-1 flex-wrap">
      {TAG_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => onPick(c)}
          aria-label={`Warna ${c}`}
          className={`w-6 h-6 rounded-full border-2 ${tagChipClasses(c)} ${value === c ? 'ring-2 ring-offset-1 ring-gray-500' : ''}`}
        />
      ))}
    </div>
  )

  const create = async () => {
    if (!name.trim()) { setErr('Nama tag wajib'); return }
    setBusy(true); setErr(null)
    try {
      await api.createTag({ name: name.trim(), color })
      setName(''); setColor('amber'); onChange()
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Gagal membuat tag.')
    } finally { setBusy(false) }
  }

  const saveEdit = async (id: string) => {
    if (!editName.trim()) return
    setBusy(true); setErr(null)
    try {
      await api.updateTag(id, { name: editName.trim(), color: editColor })
      setEditId(null); onChange()
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Gagal menyimpan tag.')
    } finally { setBusy(false) }
  }

  const del = async (id: string) => {
    setBusy(true); setErr(null)
    try { await api.deleteTag(id); setConfirmDelete(null); onChange() }
    catch (e: unknown) { setErr(e instanceof Error ? e.message : 'Gagal menghapus tag.') }
    finally { setBusy(false) }
  }

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Input label="Tag baru" value={name} onChange={(e) => setName(e.target.value)} placeholder="Nama tag" />
        <ColorPicker value={color} onPick={setColor} />
        <Button size="sm" icon={<Plus className="w-4 h-4" />} loading={busy} onClick={() => void create()}>Tambah Tag</Button>
      </div>
      {err && <p className="text-xs text-red-600">{err}</p>}
      <ul className="space-y-1">
        {tags.map((t) => (
          <li key={t.id} className="flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg bg-gray-50">
            {editId === t.id ? (
              <div className="flex-1 space-y-1.5">
                <Input value={editName} onChange={(e) => setEditName(e.target.value)} />
                <ColorPicker value={editColor} onPick={setEditColor} />
                <div className="flex gap-1">
                  <Button size="sm" icon={<Check className="w-3.5 h-3.5" />} loading={busy} onClick={() => void saveEdit(t.id)}>Simpan</Button>
                  <Button size="sm" variant="secondary" icon={<X className="w-3.5 h-3.5" />} onClick={() => setEditId(null)}>Batal</Button>
                </div>
              </div>
            ) : (
              <>
                <span className={`px-2 py-0.5 rounded-full text-xs font-bold border ${tagChipClasses(t.color)}`}>{t.name}</span>
                <div className="flex items-center gap-1">
                  <button type="button" className="text-xs text-gray-500 hover:text-gray-900" onClick={() => { setEditId(t.id); setEditName(t.name); setEditColor(t.color) }}>Edit</button>
                  <button type="button" aria-label={`Hapus tag ${t.name}`} className="p-1 text-gray-400 hover:text-red-500" onClick={() => setConfirmDelete(t)}><Trash2 className="w-3.5 h-3.5" /></button>
                </div>
              </>
            )}
          </li>
        ))}
      </ul>
      {confirmDelete && (
        <div className="p-3 rounded-xl border border-red-200 bg-red-50 space-y-2">
          <p className="text-xs text-gray-700">Hapus tag <strong>&ldquo;{confirmDelete.name}&rdquo;</strong>? Tag akan dilepas dari semua pelanggan.</p>
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
(Adjust `Button`/`Input` prop names — `size`, `icon`, `loading`, `variant`, `label` — to match the shared `ui` components actually used elsewhere in `apps/backoffice/src/screens/customers/`. Verify against an existing usage before finalizing.)

- [ ] **Step 2: Typecheck + commit**

Run: `cd apps/backoffice && npx tsc -b` (Expected: passes)
```bash
git add apps/backoffice/src/screens/customers/TagManager.tsx
git commit -m "feat(backoffice): tag manager (create/rename/recolor/delete)"
```

---

### Task C3: Tag section on the Customer Detail hub

**Files:** Modify `apps/backoffice/src/screens/customers/CustomerDetail.tsx`

- [ ] **Step 1: Load tags + the customer's current tag ids**

In `CustomerDetail`, add (near the existing data loads): a tags query and local selection state.
```tsx
  const tagsQ = usePolledQuery<Tag[]>(() => api.listTags(), [])
  const allTags = tagsQ.data ?? []
  const [tagModalOpen, setTagModalOpen] = useState(false)
```
Add imports: `import type { Tag } from '@mandalika/api'`, `import { tagChipClasses } from './tagColors'`, `import { TagManager } from './TagManager'`. (`usePolledQuery`, `useState`, `api` are already imported.)

- [ ] **Step 2: Replace the reserved placeholder (line ~104) with the real tag section**

Replace:
```tsx
          {/* Reserved for SP-CRM-2 */}
          <div className="pt-2 border-t border-gray-100">
            <p className="flex items-center gap-1.5 text-xs font-bold text-gray-300"><Tag className="w-3.5 h-3.5" /> Tag &amp; Segmen — segera</p>
          </div>
```
with:
```tsx
          {/* Tags (SP-CRM-4) */}
          <div className="pt-2 border-t border-gray-100 space-y-2">
            <div className="flex items-center justify-between">
              <p className="flex items-center gap-1.5 text-xs font-bold text-gray-400"><Tag className="w-3.5 h-3.5" /> Tag</p>
              <button type="button" className="text-xs font-bold text-gold-600 hover:text-gold-700" onClick={() => setTagModalOpen(true)}>Kelola</button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {(c.tags ?? []).map((t) => (
                <span key={t.id} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold border ${tagChipClasses(t.color)}`}>
                  {t.name}
                  <button type="button" aria-label={`Lepas ${t.name}`} onClick={() => void toggleTag(t.id)} className="hover:opacity-70">×</button>
                </span>
              ))}
              {allTags.filter((t) => !(c.tags ?? []).some((ct) => ct.id === t.id)).map((t) => (
                <button key={t.id} type="button" onClick={() => void toggleTag(t.id)}
                  className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border border-dashed ${tagChipClasses(t.color)} opacity-50 hover:opacity-100`}>
                  + {t.name}
                </button>
              ))}
              {allTags.length === 0 && <span className="text-xs text-gray-300 italic">Belum ada tag — klik Kelola</span>}
            </div>
          </div>
```

- [ ] **Step 3: Add `toggleTag` + the manager modal**

Add the handler (uses `setCustomerTags` set-the-whole-set; `cq` is the customer query — match the actual query var name in this file, likely `cq`):
```tsx
  const toggleTag = async (tagId: string) => {
    const current = (c.tags ?? []).map((t) => t.id)
    const next = current.includes(tagId) ? current.filter((x) => x !== tagId) : [...current, tagId]
    try {
      await api.setCustomerTags(c.id, next)
      await cq.refetch()
    } catch { /* surfaced on next load; non-blocking */ }
  }
```
Add a `Modal` (the shared `ui` Modal) rendering `<TagManager tags={allTags} onChange={() => void tagsQ.refetch()} />`, opened by `tagModalOpen`. Place it near the component's other modals / at the end of the returned tree.

- [ ] **Step 4: Build + commit**

Run: `cd apps/backoffice && npx tsc -b && npx vite build` (Expected: both succeed)
```bash
git add apps/backoffice/src/screens/customers/CustomerDetail.tsx
git commit -m "feat(backoffice): customer detail tag section (assign + manage)"
```

---

### Task C4: List tag filter + row chips + export column

**Files:** Modify `apps/backoffice/src/screens/Customers.tsx`

- [ ] **Step 1: Add tag filter state + tags query**

After the `sort` state, add:
```tsx
  const [tagId, setTagId] = useState('')
  const tagsQ = usePolledQuery<Tag[]>(() => api.listTags(), [])
  const allTags = tagsQ.data ?? []
```
Add `import type { Tag } from '@mandalika/api'` and `import { tagChipClasses } from './customers/tagColors'`.

- [ ] **Step 2: Thread `tagId` into the list query**

Change the `cq` query to pass `tagId` and add it to deps:
```tsx
  const cq = usePolledQuery(
    () => api.listCustomers(page, pageSize, debouncedSearch, sort, tagId),
    [page, pageSize, debouncedSearch, sort, tagId],
  )
```

- [ ] **Step 3: Add the tag filter dropdown** (next to the search box / sort toggle row)
```tsx
          <select
            value={tagId}
            onChange={(e) => { setTagId(e.target.value); setPage(1) }}
            className="text-xs font-bold rounded-lg border border-gray-200 px-2 py-1.5 bg-white text-gray-700"
          >
            <option value="">Semua tag</option>
            {allTags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
```

- [ ] **Step 4: Render row chips** (in the customer name cell, after the name/visit lines)
```tsx
                                {(c.tags ?? []).length > 0 && (
                                  <div className="flex flex-wrap gap-1 mt-1">
                                    {(c.tags ?? []).slice(0, 3).map((t) => (
                                      <span key={t.id} className={`px-1.5 py-0.5 rounded-full text-[10px] font-bold border ${tagChipClasses(t.color)}`}>{t.name}</span>
                                    ))}
                                    {(c.tags ?? []).length > 3 && <span className="text-[10px] text-gray-400">+{(c.tags ?? []).length - 3}</span>}
                                  </div>
                                )}
```
(Place inside the existing name `<td>` block; match the surrounding JSX/indentation.)

- [ ] **Step 5: Add a Tag column to the export**

In the export builder (the `exportCustomers` fn that maps rows), add a `Tag` field:
```tsx
      Tag: (c.tags ?? []).map((t) => t.name).join(', '),
```
(The export fetches the full filtered set via the list endpoint — which now hydrates `tags` on the backoffice read — so `c.tags` is populated.)

- [ ] **Step 6: Build + commit**

Run: `cd apps/backoffice && npx tsc -b && npx vite build` (Expected: both succeed)
```bash
git add apps/backoffice/src/screens/Customers.tsx
git commit -m "feat(backoffice): customer list tag filter + row chips + export column"
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
Expected: all green; gen-check clean.

- [ ] **Step 2: Deploy + readiness**

`gcloud run deploy mandalika-pos --source backend --region asia-southeast2 --quiet`
then `curl -fsS https://mandalika-pos-538849926142.asia-southeast2.run.app/readyz` → `{"data":{"status":"ready"}}` (migration 0028 applies on startup).

- [ ] **Step 3: Authed live check (one-time SEED_ADMIN_PASSWORD; admin email `admin@mandalika.test`)**

Throwaway `_verify_crm4.mjs` (login → bearer `data.access`). Assert:
1. `POST /tags` create (name+color) → 201; duplicate name → error; invalid color (`"chartreuse"`) → error.
2. `PUT /tags/{id}` rename+recolor → persists via `GET /tags`.
3. `PUT /customers/{id}/tags {tagIds:[tag1]}` then `GET /customers/{id}` → `tags` contains tag1; set `{tagIds:[]}` → empty.
4. `GET /customers?tagId=<tag1>` → only customers with tag1; composes with `&q=`; pagination meta correct.
5. **Regression:** `GET /sync/customers/lookup?q=...` and `GET /customers/by-phone?phone=...` responses have **no `tags`** field (tag-free shared builder).
6. `DELETE /tags/{id}` → gone; a customer that had it no longer lists it (CASCADE).
Clean up created tags. Delete the script after.

- [ ] **Step 4: Push + report**

`git push origin prod-hardening`. Document results + USER-PENDING visual (chips on rows + detail, tag filter, manager CRUD, assign on detail). Backoffice auto-deploys via Cloudflare; no APK (backoffice-only).

---

## Self-Review (completed)

- **Spec coverage:** tags+customer_tags (A1) ✓; managed CRUD + color validation (A3/A5) ✓; backoffice-only hydration via `customerObjWithTags`, shared `customerObj` untouched (A2) ✓; `tags?` optional on Customer (A5) ✓; tagId filter composing with q+sort+pagination (A2/A4/B1/C4) ✓; set-the-whole-set assignment (A3/A4/B1/C3) ✓; tag manager (C2), detail assign (C3), row chips + filter + export (C4) ✓; regression check that POS reads stay tag-free (D1 #5) ✓; gated `manage_customers` (A4 routes) ✓.
- **Placeholder scan:** none — code in every step; the "verify helper/prop names against the file" notes are accuracy guards, not deferred work.
- **Type consistency:** `Customers(ctx,page,limit,q,sort,tagId)` (A2) matches the handler (A4 Step 2) — and per the spec `sync.go` does NOT call `Customers()` (it uses `RecentCustomersForOutlet` since SP-CRM-3 P2), so no sync ripple; `write.Tag{Name,Color,SortOrder}` (A3) matches `TagInput` (A5) + the client `TagInput` (B1); `setCustomerTags(id, tagIds)`/`{tagIds}` consistent across A3/A4/A5/B1/C3; `tagChipClasses`/`TAG_COLORS` (C1) used by C2/C3/C4; `customerObjWithTags` (A2) used only by `Customers`+`Customer`, leaving `CustomerByPhone`/`CustomerLookup`/`RecentCustomersForOutlet` on `customerObj`.
- **Note:** A2–A5 are interdependent (A2/A3 reference `api.Tag*` from A5's regen) — implement Phase A as one unit; first green build is at A5 Step 5.
