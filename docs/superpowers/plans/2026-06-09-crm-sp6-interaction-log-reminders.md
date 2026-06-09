# SP-CRM-6 — Interaction Log + Birthday/Anniversary Reminders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-customer dated interaction timeline and a birthday/anniversary reminders surface to the backoffice Customers module — backend + backoffice only, no POS/APK/sync changes.

**Architecture:** A new `customer_interactions` table (mig 0030) backs a paginated create/delete timeline on the customer-detail hub. Two stored generated `MMDD` columns on `customers` (+ partial indexes) back an index-friendly "birthday/anniversary in the next N days" reminders query, computed via a pure, unit-tested in-Go window builder. All endpoints gated on `manage_customers`; interaction/reminder data stays OFF the shared `customerObj` (lean-sync preserved). Trigger-firing / auto-awarding is explicitly deferred to SP-CRM-7.

**Tech Stack:** Go (pgx, chi, oapi-codegen), Postgres (Neon), React + TypeScript (Vite), the generated `@mandalika/api` client.

**Spec:** `docs/superpowers/specs/2026-06-09-crm-sp6-interaction-log-reminders-design.md`

**Conventions reused (read these once before starting):**
- Write layer pattern: `backend/internal/write/segment.go` (validate → `r.Pool.QueryRow/Exec`, `ErrNotFound` on 0 rows).
- Read layer pattern: `backend/internal/read/repo.go` — `listJSON[T]` (first col = JSON object, `count(*) OVER() AS total`), `oneJSON[T]`, `off(page,limit)`.
- Handler pattern: `backend/internal/handlers/writes.go` — `decodeWrite[T]`, `h.created`, `h.mutated`, `h.caller(r)` (resolves `callerID{userID,name}`), `pageLimit(r)`, `meta(total,page,limit)`, `h.cached(...)`.
- Route registration: `backend/internal/server/server.go:152-166` (the `manage_customers` group).
- Migration files: `backend/internal/db/migrations/00NN_*.sql` (auto-applied in numeric order).
- Client: `packages/api/src/client.ts` — `list<T>(url,params)→{data,meta}`, `data<T>(method,url,body)`, `request<T>(method,url,body)`.
- Backoffice detail: `apps/backoffice/src/screens/customers/CustomerDetail.tsx`; list/tabs: `apps/backoffice/src/screens/Customers.tsx`; chip colors: `apps/backoffice/src/screens/customers/tagColors.ts`.

**Backend codegen loop (used in Tasks 4/6):**
```bash
cd backend && go tool oapi-codegen -config api/oapi-codegen.yaml api/openapi.yaml
corepack pnpm --filter @mandalika/api gen
```
Then `go build ./...`, `go test ./...`, and `make gen-check` (must be clean; commit `api.gen.go`).

**Verification identity:** deployed admin login email = `admin@mandalika.test`; password from Secret Manager `SEED_ADMIN_PASSWORD` (never print). DB checks via a pgx throwaway in a tx that ROLLS BACK.

---

## Task 1: Migration 0030 — interactions table + MMDD generated columns + indexes

**Files:**
- Create: `backend/internal/db/migrations/0030_crm_interactions_reminders.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 0030_crm_interactions_reminders.sql
-- SP-CRM-6: per-customer interaction log + birthday/anniversary reminder support.

-- ── Interaction log ───────────────────────────────────────
CREATE TABLE customer_interactions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id      uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  type             text NOT NULL CHECK (type IN ('telepon','kunjungan','pesan','catatan')),
  interaction_date date NOT NULL,
  note             text,
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by_name  text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
-- Serves the per-customer newest-first timeline read + stable OFFSET pagination.
CREATE INDEX idx_customer_interactions_customer
  ON customer_interactions (customer_id, interaction_date DESC, created_at DESC);

-- ── Birthday / anniversary reminder support ───────────────
-- MMDD = month*100 + day. Exact + leap-safe (no day-of-year shift after Feb 29).
-- NULL source date ⇒ NULL mmdd (excluded by the partial index).
ALTER TABLE customers
  ADD COLUMN birthday_mmdd smallint
    GENERATED ALWAYS AS ((EXTRACT(MONTH FROM birthday)*100 + EXTRACT(DAY FROM birthday))::smallint) STORED,
  ADD COLUMN anniversary_mmdd smallint
    GENERATED ALWAYS AS ((EXTRACT(MONTH FROM anniversary)*100 + EXTRACT(DAY FROM anniversary))::smallint) STORED;

CREATE INDEX idx_customers_birthday_mmdd
  ON customers (birthday_mmdd) WHERE birthday_mmdd IS NOT NULL;
CREATE INDEX idx_customers_anniversary_mmdd
  ON customers (anniversary_mmdd) WHERE anniversary_mmdd IS NOT NULL;
```

- [ ] **Step 2: Commit**

```bash
git add backend/internal/db/migrations/0030_crm_interactions_reminders.sql
git commit -m "feat(crm): migration 0030 — interactions table + birthday/anniversary MMDD columns"
```

---

## Task 2: MMDD window builder (pure function, TDD)

The reminders query needs the set of MMDD integers for `[today, today+N]` plus each one's days-until offset (for sorting + the "dalam N hari" label). This is pure logic → test-first.

**Files:**
- Create: `backend/internal/read/reminders.go`
- Test: `backend/internal/read/reminders_test.go`

- [ ] **Step 1: Write the failing test**

```go
package read

import (
	"testing"
	"time"
)

func keyByMMDD(keys []dayKey, mmdd int) (dayKey, bool) {
	for _, k := range keys {
		if k.mmdd == mmdd {
			return k, true
		}
	}
	return dayKey{}, false
}

func TestMMDDWindow_BasicWeek(t *testing.T) {
	// 2026-06-09 + 7 days → 0609..0616, soonest-first, du 0..7.
	keys := mmddWindow(time.Date(2026, 6, 9, 0, 0, 0, 0, time.UTC), 7)
	if len(keys) != 8 {
		t.Fatalf("len = %d want 8", len(keys))
	}
	if keys[0].mmdd != 609 || keys[0].daysUntil != 0 {
		t.Fatalf("first = %+v want {609,0}", keys[0])
	}
	if keys[7].mmdd != 616 || keys[7].daysUntil != 7 {
		t.Fatalf("last = %+v want {616,7}", keys[7])
	}
}

func TestMMDDWindow_MonthRollover(t *testing.T) {
	// Jan 28 + 7 → crosses into February.
	keys := mmddWindow(time.Date(2026, 1, 28, 0, 0, 0, 0, time.UTC), 7)
	if _, ok := keyByMMDD(keys, 201); !ok {
		t.Fatalf("expected 0201 (Feb 1) in window")
	}
}

func TestMMDDWindow_YearEndWrap(t *testing.T) {
	// Dec 28 + 7 → wraps into January.
	keys := mmddWindow(time.Date(2026, 12, 28, 0, 0, 0, 0, time.UTC), 7)
	if _, ok := keyByMMDD(keys, 1228); !ok {
		t.Fatalf("expected 1228 in window")
	}
	if _, ok := keyByMMDD(keys, 101); !ok {
		t.Fatalf("expected 0101 (Jan 1) in wrapped window")
	}
}

func TestMMDDWindow_LeapDayFoldedInNonLeapYear(t *testing.T) {
	// 2027 is NOT a leap year. A window spanning Mar 1 must also include 0229
	// so Feb-29 birthdays still get a reminder (celebrated Mar 1).
	keys := mmddWindow(time.Date(2027, 2, 26, 0, 0, 0, 0, time.UTC), 7)
	if _, ok := keyByMMDD(keys, 229); !ok {
		t.Fatalf("expected 0229 folded into non-leap-year window")
	}
}

func TestMMDDWindow_LeapDayNaturalInLeapYear(t *testing.T) {
	// 2028 IS a leap year — Feb 29 occurs naturally.
	keys := mmddWindow(time.Date(2028, 2, 26, 0, 0, 0, 0, time.UTC), 7)
	k, ok := keyByMMDD(keys, 229)
	if !ok || k.daysUntil != 3 {
		t.Fatalf("expected natural 0229 at du=3, got %+v ok=%v", k, ok)
	}
}
```

- [ ] **Step 2: Run the test, verify it fails to compile**

Run: `cd backend && go test ./internal/read/ -run TestMMDDWindow -v`
Expected: FAIL — `undefined: mmddWindow` / `undefined: dayKey`.

- [ ] **Step 3: Write the minimal implementation**

```go
package read

import "time"

// dayKey pairs an MMDD value (month*100+day) with how many days from "today"
// it is — used by Reminders to sort soonest-first and label "dalam N hari".
type dayKey struct {
	mmdd      int
	daysUntil int
}

func isLeap(y int) bool {
	return y%4 == 0 && (y%100 != 0 || y%400 == 0)
}

// mmddWindow returns the MMDD keys for the (days+1) calendar days starting at
// today (inclusive), soonest-first. AddDate handles month rollover and year-end
// wrap. In a non-leap year a window spanning Mar 1 also emits 0229 so Feb-29
// dates still get a reminder. days is clamped to [0, 366].
func mmddWindow(today time.Time, days int) []dayKey {
	if days < 0 {
		days = 0
	}
	if days > 366 {
		days = 366
	}
	out := make([]dayKey, 0, days+2)
	for i := 0; i <= days; i++ {
		d := today.AddDate(0, 0, i)
		out = append(out, dayKey{mmdd: int(d.Month())*100 + d.Day(), daysUntil: i})
		if d.Month() == time.March && d.Day() == 1 && !isLeap(d.Year()) {
			out = append(out, dayKey{mmdd: 229, daysUntil: i})
		}
	}
	return out
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `cd backend && go test ./internal/read/ -run TestMMDDWindow -v`
Expected: PASS (all 5).

- [ ] **Step 5: Commit**

```bash
git add backend/internal/read/reminders.go backend/internal/read/reminders_test.go
git commit -m "feat(crm): MMDD reminder-window builder (month/year-wrap + leap-day fold) with tests"
```

---

## Task 3: Read layer — interactions list + reminders query

**Files:**
- Modify: `backend/internal/read/reminders.go` (append the `Reminders` repo method)
- Modify: `backend/internal/read/repo.go` (append the `Interactions` repo method near the other customer reads, after `Customer`, ~line 761)

Note: `api.Interaction` and `api.Reminder` don't exist yet (Task 4 generates them). This task writes the SQL/Go; it will compile only after Task 4's codegen. That's expected — Tasks 3→6 land together. (Subagent: write Task 3 and Task 4 before attempting `go build`.)

- [ ] **Step 1: Add the `Interactions` read to `repo.go`**

```go
// Interactions returns a customer's interaction log, newest-first, paginated.
func (r *Repo) Interactions(ctx context.Context, customerID string, page, limit int) ([]api.Interaction, int, error) {
	const sql = `SELECT json_build_object(
		  'id', id, 'type', type, 'interactionDate', interaction_date,
		  'note', note, 'createdBy', created_by, 'createdByName', created_by_name,
		  'createdAt', created_at), count(*) OVER() AS total
		FROM customer_interactions
		WHERE customer_id = $3
		ORDER BY interaction_date DESC, created_at DESC
		OFFSET $1 LIMIT $2`
	return listJSON[api.Interaction](ctx, r.Pool, sql, off(page, limit), limit, customerID)
}
```

- [ ] **Step 2: Add the `Reminders` read to `reminders.go`**

```go
import (
	"context"
	"time"

	"github.com/mandalika/pos-backend/internal/api"
)

// Reminders returns customers whose birthday or anniversary falls within the
// [today, today+days] window, soonest-first, paginated. typ ∈ {all,birthday,
// anniversary}. A customer with both dates in-window yields two rows (one per
// kind). The MMDD lists drive index-eligible equality lookups on the partial
// idx_customers_*_mmdd indexes.
func (r *Repo) Reminders(ctx context.Context, today time.Time, days int, typ string, page, limit int) ([]api.Reminder, int, error) {
	keys := mmddWindow(today, days)
	mmdds := make([]int, len(keys))
	dus := make([]int, len(keys))
	for i, k := range keys {
		mmdds[i] = k.mmdd
		dus[i] = k.daysUntil
	}
	const sql = `
		WITH win AS (SELECT * FROM unnest($1::int[], $2::int[]) AS w(mmdd, du)),
		rem AS (
		  SELECT c.id, c.name, c.phone, 'birthday'::text AS kind, c.birthday AS dt, w.du
		    FROM customers c JOIN win w ON c.birthday_mmdd = w.mmdd
		   WHERE $3 IN ('all','birthday')
		  UNION ALL
		  SELECT c.id, c.name, c.phone, 'anniversary'::text, c.anniversary, w.du
		    FROM customers c JOIN win w ON c.anniversary_mmdd = w.mmdd
		   WHERE $3 IN ('all','anniversary')
		)
		SELECT json_build_object(
		  'id', id, 'name', name, 'phone', phone,
		  'kind', kind, 'date', dt, 'daysUntil', du), count(*) OVER() AS total
		FROM rem
		ORDER BY du, name
		OFFSET $4 LIMIT $5`
	return listJSON[api.Reminder](ctx, r.Pool, sql, mmdds, dus, typ, off(page, limit), limit)
}
```

- [ ] **Step 3: Commit (after Task 4 makes it compile — see Task 6). For now, stage only:**

```bash
git add backend/internal/read/repo.go backend/internal/read/reminders.go
```
(The commit happens in Task 6 once the package builds.)

---

## Task 4: Write layer — create/delete interaction + OpenAPI + codegen

**Files:**
- Create: `backend/internal/write/interaction.go`
- Modify: `backend/api/openapi.yaml` (schemas + paths)
- Regenerate: `backend/internal/api/api.gen.go`, `packages/api/src/*` (via codegen)

- [ ] **Step 1: Write `interaction.go`**

```go
package write

import (
	"context"
	"fmt"
	"time"
)

var validInteractionTypes = map[string]bool{
	"telepon": true, "kunjungan": true, "pesan": true, "catatan": true,
}

type Interaction struct {
	Type            string `json:"type"`
	InteractionDate string `json:"interactionDate"`
	Note            string `json:"note"`
}

// CreateInteraction appends a log entry for a customer. The author (byID/byName)
// is resolved by the handler from the authed identity, never the request body.
// An empty interactionDate defaults to today; a non-empty one must be YYYY-MM-DD.
func (r *Repo) CreateInteraction(ctx context.Context, customerID string, in Interaction, byID, byName string) (string, error) {
	if !validInteractionTypes[in.Type] {
		return "", fmt.Errorf("jenis interaksi tidak valid")
	}
	date := in.InteractionDate
	if date == "" {
		date = time.Now().Format("2006-01-02")
	} else if _, err := time.Parse("2006-01-02", date); err != nil {
		return "", fmt.Errorf("tanggal interaksi tidak valid")
	}
	var id string
	err := r.Pool.QueryRow(ctx,
		`INSERT INTO customer_interactions
		   (customer_id, type, interaction_date, note, created_by, created_by_name)
		 VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
		customerID, in.Type, date, nullStr(in.Note), nullStr(byID), nullStr(byName)).Scan(&id)
	if err != nil {
		return "", fmt.Errorf("create interaction: %w", err)
	}
	return id, nil
}

// DeleteInteraction removes one entry, scoped to its customer (so a mismatched
// pair 404s rather than deleting another customer's row).
func (r *Repo) DeleteInteraction(ctx context.Context, customerID, interactionID string) error {
	tag, err := r.Pool.Exec(ctx,
		`DELETE FROM customer_interactions WHERE id=$1 AND customer_id=$2`,
		interactionID, customerID)
	if err != nil {
		return fmt.Errorf("delete interaction: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}
```

Note: confirm `nullStr` exists in the `write` package (it's used by the customer writes). If it is unexported and in another file of the same package, it's directly callable. If not found, add:
```go
func nullStr(s string) any { if s == "" { return nil }; return s }
```
(Only add if `grep -rn "func nullStr" backend/internal/write` returns nothing.)

- [ ] **Step 2: Add OpenAPI schemas** (`backend/api/openapi.yaml`, in `components.schemas`, near `Customer`)

```yaml
    Interaction:
      type: object
      required: [id, type, interactionDate, createdAt]
      properties:
        id: { type: string, format: uuid }
        type: { type: string, enum: [telepon, kunjungan, pesan, catatan] }
        interactionDate: { type: string, format: date }
        note: { type: string, nullable: true }
        createdBy: { type: string, format: uuid, nullable: true }
        createdByName: { type: string, nullable: true }
        createdAt: { type: string, format: date-time }
    InteractionInput:
      type: object
      required: [type]
      properties:
        type: { type: string, enum: [telepon, kunjungan, pesan, catatan] }
        interactionDate: { type: string }
        note: { type: string }
    InteractionListResponse:
      type: object
      required: [data, meta]
      properties:
        data: { type: array, items: { $ref: '#/components/schemas/Interaction' } }
        meta: { $ref: '#/components/schemas/Meta' }
    Reminder:
      type: object
      required: [id, name, phone, kind, date, daysUntil]
      properties:
        id: { type: string, format: uuid }
        name: { type: string }
        phone: { type: string }
        kind: { type: string, enum: [birthday, anniversary] }
        date: { type: string, format: date, nullable: true }
        daysUntil: { type: integer }
    ReminderListResponse:
      type: object
      required: [data, meta]
      properties:
        data: { type: array, items: { $ref: '#/components/schemas/Reminder' } }
        meta: { $ref: '#/components/schemas/Meta' }
```

- [ ] **Step 3: Add OpenAPI paths** (in `paths`; mirror the existing `/customers/{id}` and `/segments` entries — all sit behind `manage_customers`)

```yaml
  /customers/{id}/interactions:
    get:
      operationId: listInteractions
      tags: [customers]
      parameters:
        - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
        - { name: page, in: query, schema: { type: integer } }
        - { name: limit, in: query, schema: { type: integer } }
      responses:
        '200':
          description: interaction log
          content:
            application/json:
              schema: { $ref: '#/components/schemas/InteractionListResponse' }
    post:
      operationId: createInteraction
      tags: [customers]
      parameters:
        - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/InteractionInput' }
      responses:
        '201':
          description: created
          content:
            application/json:
              schema: { $ref: '#/components/schemas/IdResponse' }
  /customers/{id}/interactions/{iid}:
    delete:
      operationId: deleteInteraction
      tags: [customers]
      parameters:
        - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
        - { name: iid, in: path, required: true, schema: { type: string, format: uuid } }
      responses:
        '200': { description: deleted }
  /customers/reminders:
    get:
      operationId: listReminders
      tags: [customers]
      parameters:
        - { name: window, in: query, schema: { type: integer } }
        - { name: type, in: query, schema: { type: string } }
        - { name: page, in: query, schema: { type: integer } }
        - { name: limit, in: query, schema: { type: integer } }
      responses:
        '200':
          description: upcoming birthdays/anniversaries
          content:
            application/json:
              schema: { $ref: '#/components/schemas/ReminderListResponse' }
```

Note: confirm an `IdResponse` schema exists (the segment/tag POSTs return `{data:{id}}`). Run `grep -n "IdResponse" backend/api/openapi.yaml`. If the convention is a different name (e.g. the create handlers use `h.created` which writes `{data:{id}}`), reuse whatever schema `createSegment` references for its `201`. Match that exact name instead of `IdResponse`.

- [ ] **Step 4: Regenerate**

```bash
cd backend && go tool oapi-codegen -config api/oapi-codegen.yaml api/openapi.yaml
corepack pnpm --filter @mandalika/api gen
```
Expected: `api.gen.go` now defines `api.Interaction`, `api.InteractionInput`, `api.InteractionListResponse`, `api.Reminder`, `api.ReminderListResponse`.

- [ ] **Step 5: Commit (with Task 6, once it builds). Stage now:**

```bash
git add backend/internal/write/interaction.go backend/api/openapi.yaml backend/internal/api/api.gen.go packages/api
```

---

## Task 5: Handlers + route registration

**Files:**
- Modify: `backend/internal/handlers/writes.go` (append a "Customer interactions" section after the segments handlers, ~line 560)
- Create: `backend/internal/handlers/reminders.go` (the reminders read handler) — or append to `handlers.go`; a small new file keeps it focused.
- Modify: `backend/internal/server/server.go` (register routes in the `manage_customers` group, ~line 161)

- [ ] **Step 1: Add interaction handlers to `writes.go`**

```go
// ── Customer interactions (SP-CRM-6) ───────────────────────

func (h *Handlers) Interactions(w http.ResponseWriter, r *http.Request) {
	p, l := pageLimit(r)
	rows, total, err := h.Repo.Interactions(r.Context(), chi.URLParam(r, "id"), p, l)
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, http.StatusOK, api.InteractionListResponse{Data: rows, Meta: *meta(total, p, l)})
}

func (h *Handlers) CreateInteraction(w http.ResponseWriter, r *http.Request) {
	in, ok := decodeWrite[write.Interaction](w, r)
	if !ok {
		return
	}
	c, _ := h.caller(r)
	id, err := h.Write.CreateInteraction(r.Context(), chi.URLParam(r, "id"), in, c.userID, c.name)
	h.created(w, r, id, err)
}

func (h *Handlers) DeleteInteraction(w http.ResponseWriter, r *http.Request) {
	h.mutated(w, r, h.Write.DeleteInteraction(r.Context(), chi.URLParam(r, "id"), chi.URLParam(r, "iid")))
}
```

Note: `api.InteractionListResponse.Meta` — match the generated field's type. The transfer handler uses `Meta: *meta(...)` (value) and others use `Meta: meta(...)` (pointer). Check the generated struct: if `Meta Meta` use `*meta(...)`; if `Meta *Meta` use `meta(...)`. The `required: [data, meta]` in the schema makes it a value `Meta`, so `*meta(total,p,l)` is correct.

- [ ] **Step 2: Add the reminders handler (`backend/internal/handlers/reminders.go`)**

```go
package handlers

import (
	"net/http"
	"time"

	"github.com/mandalika/pos-backend/internal/api"
)

// Reminders lists customers with a birthday/anniversary in the next window days.
func (h *Handlers) Reminders(w http.ResponseWriter, r *http.Request) {
	p, l := pageLimit(r)
	window := 7
	if r.URL.Query().Get("window") == "30" {
		window = 30
	}
	typ := r.URL.Query().Get("type")
	switch typ {
	case "", "all":
		typ = "all"
	case "birthday", "anniversary":
		// ok
	default:
		writeErr(w, http.StatusBadRequest, errReminderType)
		return
	}
	rows, total, err := h.Repo.Reminders(r.Context(), time.Now(), window, typ, p, l)
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, http.StatusOK, api.ReminderListResponse{Data: rows, Meta: *meta(total, p, l)})
}
```

Add near the top of the file (or reuse an existing error helper):
```go
import "errors"
var errReminderType = errors.New("type harus birthday, anniversary, atau all")
```
(If `writeErr` expects a specific shape, mirror how other handlers build a 400 — e.g. `httpx.Err(w, http.StatusBadRequest, "type tidak valid")`. Prefer `httpx.Err` if that's the local idiom, and drop `errReminderType`.)

- [ ] **Step 3: Register routes** (`server.go`, inside the `r.Group` that does `mw.RequirePermission("manage_customers")`, alongside the existing customer routes ~line 161)

```go
				r.Get("/customers/reminders", h.Reminders)
				r.Get("/customers/{id}/interactions", h.Interactions)
				r.Post("/customers/{id}/interactions", h.CreateInteraction)
				r.Delete("/customers/{id}/interactions/{iid}", h.DeleteInteraction)
```

**Routing order matters:** chi matches `/customers/reminders` vs `/customers/{id}`. Register `/customers/reminders` (static) — chi prioritizes static segments over `{id}`, but to be safe place it adjacent to the other `/customers/...` GETs in the same group. Verify in Task 6's live check that `GET /customers/reminders` is not swallowed by `/customers/{id}`.

- [ ] **Step 4: Commit (with Task 6).**

---

## Task 6: Backend build, test, gen-check, commit

- [ ] **Step 1: Build**

Run: `cd backend && go build ./...`
Expected: success. Fix any type mismatches (most likely: `Meta` value-vs-pointer in the two handlers, or the `IdResponse` schema name in Task 4 Step 3).

- [ ] **Step 2: Test (incl. the window builder + race)**

Run: `cd backend && go test -race ./...`
Expected: PASS, including `internal/read` (the MMDD tests) and the existing suite.

- [ ] **Step 3: gen-check**

Run: `cd backend && make gen-check`
Expected: clean (no drift). If it fails, re-run the Task 4 Step 4 codegen and stage `api.gen.go`.

- [ ] **Step 4: Commit the whole backend slice**

```bash
git add backend/internal/read/repo.go backend/internal/read/reminders.go \
        backend/internal/write/interaction.go backend/internal/handlers/writes.go \
        backend/internal/handlers/reminders.go backend/internal/server/server.go \
        backend/api/openapi.yaml backend/internal/api/api.gen.go packages/api
git commit -m "feat(crm): SP-CRM-6 backend — interaction log CRUD + birthday/anniversary reminders endpoints"
```

---

## Task 7: TS client methods

**Files:**
- Modify: `packages/api/src/client.ts` (interface block ~line 151-171, impl block ~line 409-440)

- [ ] **Step 1: Add to the client interface** (after the segments block, ~line 171)

```typescript
  // interactions + reminders (SP-CRM-6)
  listInteractions: (customerId: string, page?: number, limit?: number) => Promise<ListResult<Interaction>>
  createInteraction: (customerId: string, input: InteractionInput) => Promise<{ id: string }>
  deleteInteraction: (customerId: string, interactionId: string) => Promise<void>
  listReminders: (opts?: { window?: number; type?: string; page?: number; limit?: number }) => Promise<ListResult<Reminder>>
```

Ensure `Interaction`, `InteractionInput`, `Reminder` are imported from the generated types at the top of the file (add them to the existing `import type { ... }` from the generated module, matching how `Segment`/`SegmentInput` are imported).

- [ ] **Step 2: Add the implementations** (after the segments impl, ~line 440)

```typescript
    listInteractions: (customerId, page = 1, limit = 25) =>
      list<Interaction>(`${API}/customers/${customerId}/interactions`, { page, limit }),
    createInteraction: (customerId, input) =>
      data<{ id: string }>('POST', `${API}/customers/${customerId}/interactions`, input),
    deleteInteraction: (customerId, interactionId) =>
      request<void>('DELETE', `${API}/customers/${customerId}/interactions/${interactionId}`),
    listReminders: (opts = {}) =>
      list<Reminder>(`${API}/customers/reminders`, {
        ...(opts.window ? { window: opts.window } : {}),
        ...(opts.type ? { type: opts.type } : {}),
        page: opts.page ?? 1,
        limit: opts.limit ?? 25,
      }),
```

- [ ] **Step 3: Typecheck the package**

Run: `corepack pnpm --filter @mandalika/api build` (or the package's `tsc` script)
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/client.ts
git commit -m "feat(crm): TS client — interactions + reminders methods"
```

---

## Task 8: Backoffice — interaction type colors + Timeline Interaksi section + detail reminder badge

**Files:**
- Create: `apps/backoffice/src/screens/customers/interactionTypes.ts`
- Modify: `apps/backoffice/src/screens/customers/CustomerDetail.tsx`

- [ ] **Step 1: Create the type metadata helper**

```typescript
// apps/backoffice/src/screens/customers/interactionTypes.ts
// Fixed interaction types (must match the backend CHECK constraint).
import { tagChipClasses } from './tagColors'

export const INTERACTION_TYPES = ['telepon', 'kunjungan', 'pesan', 'catatan'] as const
export type InteractionType = (typeof INTERACTION_TYPES)[number]

const META: Record<InteractionType, { label: string; color: string }> = {
  telepon: { label: 'Telepon', color: 'blue' },
  kunjungan: { label: 'Kunjungan', color: 'green' },
  pesan: { label: 'Pesan', color: 'purple' },
  catatan: { label: 'Catatan', color: 'gray' },
}

export const interactionLabel = (t: string): string =>
  META[t as InteractionType]?.label ?? t

export const interactionChipClasses = (t: string): string =>
  tagChipClasses(META[t as InteractionType]?.color ?? 'gray')

/** Whole days from today until a MM-DD recurrence of `dateISO`, or null. */
export function daysUntilRecurrence(dateISO?: string | null): number | null {
  if (!dateISO) return null
  const src = new Date(dateISO)
  if (Number.isNaN(src.getTime())) return null
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  let next = new Date(today.getFullYear(), src.getMonth(), src.getDate())
  if (next < today) next = new Date(today.getFullYear() + 1, src.getMonth(), src.getDate())
  return Math.round((next.getTime() - today.getTime()) / 86400000)
}
```

- [ ] **Step 2: Wire the interaction timeline + badge into `CustomerDetail.tsx`**

Add imports near the existing ones:
```typescript
import { useState } from 'react'
import { Plus, Cake as CakeIcon } from 'lucide-react' // CakeIcon optional; Cake already imported
import type { Interaction } from '@mandalika/api'
import { Pagination } from '../../components/Pagination' // confirm the shared Pagination path/export
import {
  INTERACTION_TYPES, interactionLabel, interactionChipClasses, daysUntilRecurrence,
} from './interactionTypes'
```

Inside the component, add state + query (near the other `usePolledQuery` calls):
```typescript
  const [iPage, setIPage] = useState(1)
  const [iLimit, setILimit] = useState(25)
  const iq = usePolledQuery(
    () => api.listInteractions(customerId, iPage, iLimit),
    [customerId, iPage, iLimit],
  )
  const interactions = iq.data?.data ?? []
  const iTotal = iq.data?.meta?.total ?? 0

  const [iType, setIType] = useState<string>('catatan')
  const [iDate, setIDate] = useState('')
  const [iNote, setINote] = useState('')
  const [iBusy, setIBusy] = useState(false)

  const addInteraction = async () => {
    if (iBusy) return
    setIBusy(true)
    try {
      await api.createInteraction(customerId, { type: iType, interactionDate: iDate, note: iNote })
      setIType('catatan'); setIDate(''); setINote(''); setIPage(1)
      await iq.refetch()
    } catch { /* surfaced on next load */ } finally {
      setIBusy(false)
    }
  }
  const removeInteraction = async (iid: string) => {
    if (iBusy) return
    setIBusy(true)
    try { await api.deleteInteraction(customerId, iid); await iq.refetch() }
    catch { /* non-blocking */ } finally { setIBusy(false) }
  }
```

Add the header badge — inside the name block, after the segment chip (`CustomerDetail.tsx:99`):
```tsx
            {(() => {
              const db = daysUntilRecurrence(c.birthday)
              const da = daysUntilRecurrence(c.anniversary)
              const soon: string[] = []
              if (db !== null && db <= 30) soon.push(`🎂 Ulang tahun ${db === 0 ? 'hari ini' : `dalam ${db} hari`}`)
              if (da !== null && da <= 30) soon.push(`💍 Hari jadi ${da === 0 ? 'hari ini' : `dalam ${da} hari`}`)
              return soon.map((s) => (
                <span key={s} className="inline-block mt-1 ml-1 px-2.5 py-1 text-xs font-bold rounded-full border bg-amber-100 text-amber-800 border-amber-200">{s}</span>
              ))
            })()}
```

Replace the reserved card (`CustomerDetail.tsx:212-215`) with the Timeline Interaksi section:
```tsx
          {/* Timeline Interaksi (SP-CRM-6) */}
          <Card className="overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-100 flex items-center gap-2">
              <History className="w-4 h-4 text-gray-400" />
              <h3 className="font-black text-gray-900 text-sm">Timeline Interaksi</h3>
            </div>
            <div className="p-4 space-y-3 border-b border-gray-100 bg-gray-50">
              <div className="flex flex-wrap gap-2">
                <select value={iType} onChange={(e) => setIType(e.target.value)}
                  className="px-2 py-1.5 text-sm rounded-lg border border-gray-200 bg-white">
                  {INTERACTION_TYPES.map((t) => <option key={t} value={t}>{interactionLabel(t)}</option>)}
                </select>
                <input type="date" value={iDate} onChange={(e) => setIDate(e.target.value)}
                  className="px-2 py-1.5 text-sm rounded-lg border border-gray-200 bg-white" />
              </div>
              <textarea value={iNote} onChange={(e) => setINote(e.target.value)} rows={2}
                placeholder="Catatan interaksi…"
                className="w-full px-2 py-1.5 text-sm rounded-lg border border-gray-200 bg-white" />
              <Button icon={<Plus className="w-4 h-4" />} disabled={iBusy} onClick={() => void addInteraction()}>
                Tambah Interaksi
              </Button>
            </div>
            {iq.loading && interactions.length === 0 ? (
              <TableSkeleton />
            ) : interactions.length === 0 ? (
              <EmptyState icon={<History />} title="Belum ada interaksi" />
            ) : (
              <div className="divide-y divide-gray-50">
                {interactions.map((it: Interaction) => (
                  <div key={it.id} className="px-5 py-3 flex items-start gap-3">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-bold border flex-shrink-0 ${interactionChipClasses(it.type)}`}>
                      {interactionLabel(it.type)}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-gray-400">{fmtDate(it.interactionDate)} · {it.createdByName || '—'}</p>
                      {it.note && <p className="text-sm text-gray-700 whitespace-pre-wrap">{it.note}</p>}
                    </div>
                    <IconButton tone="danger" onClick={() => void removeInteraction(it.id)}><Trash2 className="w-4 h-4" /></IconButton>
                  </div>
                ))}
              </div>
            )}
            {iTotal > iLimit && (
              <div className="px-4 py-2 border-t border-gray-100">
                <Pagination
                  page={iPage} total={iTotal} pageSize={iLimit}
                  onPageChange={setIPage} onPageSizeChange={(s) => { setILimit(s); setIPage(1) }}
                />
              </div>
            )}
          </Card>
```

Note: confirm the shared `<Pagination/>` import path + prop names by checking an existing caller (e.g. `grep -rn "Pagination" apps/backoffice/src/screens/Customers.tsx` and open it). Match the exact prop API (`page`/`total`/`pageSize`/`onPageChange`/`onPageSizeChange` per the SP-CRM-1/F4 footer). Adjust if the real props differ.

- [ ] **Step 3: Commit**

```bash
git add apps/backoffice/src/screens/customers/interactionTypes.ts apps/backoffice/src/screens/customers/CustomerDetail.tsx
git commit -m "feat(crm): customer detail — interaction timeline + birthday/anniversary badge"
```

---

## Task 9: Backoffice — Daftar / Pengingat sub-tab + reminders list

**Files:**
- Modify: `apps/backoffice/src/screens/Customers.tsx`

The screen already has a top-level `Tabs` (`Pelanggan` / `Loyalitas`) and renders the list when `tab === 'customers'`. Add a SECOND-level tab inside the customers view: `Daftar` / `Pengingat`.

- [ ] **Step 1: Add reminder state + query** (near the other `useState`/`usePolledQuery` in the component, ~line 56-90)

```typescript
  const [custView, setCustView] = useState<'daftar' | 'pengingat'>('daftar')
  const [remWindow, setRemWindow] = useState<7 | 30>(7)
  const [remType, setRemType] = useState<'all' | 'birthday' | 'anniversary'>('all')
  const [remPage, setRemPage] = useState(1)
  const remQ = usePolledQuery(
    () => api.listReminders({ window: remWindow, type: remType, page: remPage, limit: 25 }),
    [remWindow, remType, remPage],
  )
  const reminders = remQ.data?.data ?? []
  const remTotal = remQ.data?.meta?.total ?? 0
```

Add the import:
```typescript
import type { Reminder } from '@mandalika/api'
```

- [ ] **Step 2: Render the sub-tab toggle + branch the customers body**

Inside the `{tab === 'customers' && (...)}` region (the existing list block starting ~line 248 actions and the table ~line 397), wrap the body so the toggle switches between the existing Daftar list and the new Pengingat list. Add the toggle just below the `PageHeader` when `tab==='customers'`:

```tsx
      {tab === 'customers' && (
        <Tabs
          value={custView}
          onChange={(v) => setCustView(v as 'daftar' | 'pengingat')}
          tabs={[
            { id: 'daftar', label: 'Daftar' },
            { id: 'pengingat', label: 'Pengingat' },
          ]}
          className="self-start"
        />
      )}
```

Then gate the EXISTING list/toolbar/table block on `custView === 'daftar'` (wrap it), and add the Pengingat block for `custView === 'pengingat'`:

```tsx
      {tab === 'customers' && custView === 'pengingat' && (
        <Card className="overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-100 flex flex-wrap items-center gap-2">
            <div className="flex gap-1">
              {([7, 30] as const).map((wdw) => (
                <button key={wdw} type="button" onClick={() => { setRemWindow(wdw); setRemPage(1) }}
                  className={`px-3 py-1.5 text-sm font-bold rounded-lg border ${remWindow === wdw ? 'bg-gold-50 border-gold-200 text-gold-700' : 'bg-white border-gray-200 text-gray-500'}`}>
                  {wdw} hari
                </button>
              ))}
            </div>
            <div className="flex gap-1">
              {(['all', 'birthday', 'anniversary'] as const).map((tp) => (
                <button key={tp} type="button" onClick={() => { setRemType(tp); setRemPage(1) }}
                  className={`px-3 py-1.5 text-sm font-bold rounded-lg border ${remType === tp ? 'bg-gold-50 border-gold-200 text-gold-700' : 'bg-white border-gray-200 text-gray-500'}`}>
                  {tp === 'all' ? 'Semua' : tp === 'birthday' ? 'Ulang Tahun' : 'Hari Jadi'}
                </button>
              ))}
            </div>
          </div>
          {remQ.loading && reminders.length === 0 ? (
            <TableSkeleton />
          ) : reminders.length === 0 ? (
            <EmptyState icon={<Cake />} title="Tidak ada pengingat dalam rentang ini" />
          ) : (
            <div className="divide-y divide-gray-50">
              {reminders.map((rm: Reminder, i: number) => (
                <div key={`${rm.id}-${rm.kind}-${i}`} className="px-5 py-3 flex items-center gap-3 hover:bg-gray-50 cursor-pointer"
                  onClick={() => setSelectedId(rm.id)}>
                  <span className="text-lg flex-shrink-0">{rm.kind === 'birthday' ? '🎂' : '💍'}</span>
                  <div className="flex-1 min-w-0">
                    <p className="font-bold text-gray-900 text-sm">{rm.name}</p>
                    <p className="text-xs text-gray-400">{rm.phone} · {rm.kind === 'birthday' ? 'Ulang Tahun' : 'Hari Jadi'}</p>
                  </div>
                  <span className="text-xs font-bold text-gold-700 flex-shrink-0">
                    {rm.daysUntil === 0 ? 'Hari ini' : `Dalam ${rm.daysUntil} hari`}
                  </span>
                </div>
              ))}
            </div>
          )}
          {remTotal > 25 && (
            <div className="px-4 py-2 border-t border-gray-100">
              <Pagination page={remPage} total={remTotal} pageSize={25}
                onPageChange={setRemPage} onPageSizeChange={() => { /* fixed 25 */ }} />
            </div>
          )}
        </Card>
      )}
```

Confirm `Cake` is imported from `lucide-react` in this file (it is used in CustomerDetail; add to the Customers.tsx import if missing). Confirm the `Tabs` component accepts `className` (the settings sub-tabs already pass `className="self-start"`).

- [ ] **Step 3: Commit**

```bash
git add apps/backoffice/src/screens/Customers.tsx
git commit -m "feat(crm): Pelanggan — Daftar/Pengingat sub-tab + upcoming birthday/anniversary list"
```

---

## Task 10: Frontend build

- [ ] **Step 1: Typecheck + build both apps**

Run:
```bash
corepack pnpm --filter @mandalika/backoffice build
```
Expected: `tsc -b` + `vite build` clean. (POS unchanged this sprint — no `apps/pos` build needed, but `corepack pnpm -r build` is fine if you prefer the full check.)

- [ ] **Step 2: Fix any type errors** (most likely: `Pagination` prop names, a missing lucide import, or `ListResult`/`meta` optional chaining). Re-run until clean.

- [ ] **Step 3: Commit any fixups**

```bash
git add -A
git commit -m "fix(crm): SP-CRM-6 frontend typecheck fixups"
```
(Skip if nothing changed.)

---

## Task 11: Deploy + authed live verification + index check

- [ ] **Step 1: Deploy backend**

```bash
gcloud run deploy mandalika-pos --source backend --region asia-southeast2 --quiet
```
Then confirm: `curl -s https://<service-url>/readyz` → ok. Note the new revision (migration 0030 auto-applies on boot).

- [ ] **Step 2: Authed live checks** (script with a one-time `SEED_ADMIN_PASSWORD`; login `admin@mandalika.test`; never print the secret). Verify:
  - **Interactions:** pick a real customer id → `POST /customers/{id}/interactions {type:"telepon", note:"test"}` (omit date → defaults today) → `GET /customers/{id}/interactions` returns it with `type`, `interactionDate`=today, `createdByName` set, plus `meta.total`/`page`/`limit`; bad type (`{type:"xxx"}`) → 400; `DELETE /customers/{id}/interactions/{iid}` → 200; re-GET → gone; delete with a mismatched customer id → 404.
  - **Reminders:** `GET /customers/reminders?window=7` returns `{data,meta}` with each row carrying `kind`, `date`, `daysUntil` sorted ascending; `window=30` total ≥ `window=7` total; `type=birthday` returns only `kind:"birthday"`; `type=xxx` → 400; pagination `page=2` differs from `page=1` when total > limit.
  - **Routing:** `GET /customers/reminders` is NOT swallowed by `/customers/{id}` (returns the reminder envelope, not a single customer / 404).
  - **Regression (lean-sync):** `GET /sync/customers/lookup?q=…` and `GET /customers/by-phone?phone=…` responses contain NO `interaction`/reminder fields and the customer objects are byte-shape unchanged.
  - Clean up the test interaction.

- [ ] **Step 3: Index check** (throwaway `cmd/` with a one-time `DATABASE_URL`, tx rolled back, as in SP-CRM-2's `explaincheck`):
  - Confirm `idx_customers_birthday_mmdd`, `idx_customers_anniversary_mmdd`, `idx_customer_interactions_customer` exist.
  - With `SET enable_seqscan=off`, `EXPLAIN` a reminder-style query (`SELECT … FROM customers WHERE birthday_mmdd = ANY('{609,610}')`) → **Bitmap/Index Scan on idx_customers_birthday_mmdd** (proves index eligibility; the tiny live table may otherwise prefer a seq scan — that's the documented small-table artifact).
  - Delete the throwaway.

- [ ] **Step 4: Record outcome** — update `SESSION_HANDOFF.md` (new ⭐ LATEST SESSION block: rev, migration 0030, commits, what shipped, what's user-pending = backoffice visual walkthrough) and the `crm-customers-module` memory. No APK (backoffice-only).

---

## Self-review notes (author)

- **Spec coverage:** interaction table/types/mutability/endpoints/UI → Tasks 1,3,4,5,8; reminders MMDD approach/endpoint/UI/scale → Tasks 1,2,3,5,9; detail badge → Task 8; lean-sync regression → Task 11; unit tests for the window builder → Task 2; index check → Task 11. Pagination on the interaction list (user-requested) → Tasks 3,5,8.
- **Deferred (SP-CRM-7):** no `pricing.go`/`order.go` edits anywhere in this plan — trigger-firing untouched, as designed.
- **Known minor (documented):** server-timezone "today"; Feb-29 folded onto Mar 1 in non-leap years (Task 2 test asserts it).
- **Verify-by-construction caveats the implementer must resolve, not assume:** the `IdResponse`/create-response schema name (Task 4), `Meta` value-vs-pointer in the new handlers (Task 5/8), the shared `<Pagination/>` prop API (Tasks 8-9), and `nullStr` presence in the write package (Task 4). Each step flags how to confirm.
