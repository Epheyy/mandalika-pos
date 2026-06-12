# SP-CRM-Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **THE 6 WORKING RULES (honor every task):** 1. Ask, don't assume · 2. Don't touch unrelated · 3. Flag uncertainty · 4. Verify on failure · 5. Show changes · 6. Admit gaps

**Goal:** Build a backoffice human-in-the-loop review queue that lets staff merge or dismiss the same-phone duplicate customers flagged into `customer_dup_candidates`, where a confirmed merge re-points the dup's orders, moves its points (with append-only ledger reconciliation), unions tags, recomputes aggregates additively, resolves profile conflicts, and soft-tombstones the dup.

**Architecture:** Backend + backoffice only (NO POS, NO APK). One `Pool.Begin` transaction performs the merge (mirroring `write.AdjustPoints`, deliberately NOT `r.tx` so it doesn't trigger an all-outlet resync). The dup is soft-tombstoned via a new `customers.merged_into` column; all active-customer reads filter `WHERE merged_into IS NULL`; `CreateOrder` resolves a stale dup id to its terminal keeper at the write boundary so the POS needs no changes. A `customer_merges` audit table makes a mistaken merge recoverable by hand.

**Tech Stack:** Go (chi, pgx, oapi-codegen) backend; React + TypeScript backoffice; OpenAPI codegen (`api.gen.go` + `schema.d.ts`); Postgres (Neon). Backend deploys via `gcloud run deploy`; migrations run on boot.

**Source spec:** `docs/superpowers/specs/2026-06-12-crm-sp-merge-design.md`

---

## Conventions (read once before starting)

- **Backend gate after each backend task:** `cd backend && go build ./... && go test ./... && go vet ./...`. (`-race` does NOT run on this Windows box — no cgo; CI runs race on Linux. Do not attempt local race.)
- **DB-coupled correctness is proven by the live e2e (Task 14), NOT by local DB tests** — the repo's `go test` suite is pure (no test DB). Follow that norm; do not stand up a local Postgres.
- **Codegen loop (Task 9 only):** edit `backend/api/openapi.yaml` → `cd backend && make gen-go` (reg-gens `internal/api/api.gen.go`) → `make gen-ts` (regens `packages/api/src/schema.d.ts`) → `go build ./...` → `make gen-check` (must show no drift; commit the generated files).
- **Commit style:** `feat(crm): ...` / `refactor(crm): ...` / `test(crm): ...`. Run `git add <paths>` then `git commit -m "..."` as **separate** commands (the commit hook false-positives on chained `git commit && ...`). Never `--no-verify`.
- **Envelope rule:** handlers use `writeJSON(w, status, api.XxxResponse{Data: ...})` (the struct already carries `Data`). NEVER `httpx.JSON` on an already-enveloped struct (that double-wraps — the SP-CRM-9 bug).
- **Frontend gate after each FE task:** `cd apps/backoffice && pnpm tsc -b && pnpm vite build`; for client/types: `cd packages/api && pnpm tsc -b` (or the repo's `pnpm --filter` equivalent).
- **Model routing (announce per task):** Sonnet implements. Review tier = **Opus across the board** here (migration, merge tx, order re-pointing, ledger, aggregates, type-gen are all correctness-critical). Mechanical spec-conformance checks may be Haiku, but Opus re-derives any Haiku finding from source before accept/dismiss.

---

## Task 1: Migration 0034 — tombstone columns + audit table

**Files:**
- Create: `backend/internal/db/migrations/0034_customer_merges.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 0034_customer_merges.sql
-- SP-CRM-Merge: soft-tombstone + redirect for merged duplicate customers,
-- plus an audit spine that makes a mistaken merge recoverable by hand.

ALTER TABLE customers ADD COLUMN merged_into uuid REFERENCES customers(id) ON DELETE SET NULL;
ALTER TABLE customers ADD COLUMN merged_at   timestamptz;

-- Only tombstoned rows are indexed (rare), so redirect lookups stay cheap
-- without bloating the big customer indexes.
CREATE INDEX idx_customers_merged_into ON customers(merged_into) WHERE merged_into IS NOT NULL;

CREATE TABLE customer_merges (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  keeper_id         uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  dup_id            uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  field_choices     jsonb NOT NULL,
  dup_snapshot      jsonb NOT NULL,
  moved_order_ids   uuid[] NOT NULL DEFAULT '{}',
  points_moved      integer NOT NULL DEFAULT 0,
  performed_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  performed_by_name text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_customer_merges_keeper ON customer_merges (keeper_id, created_at DESC);
```

- [ ] **Step 2: Verify it parses**

Run: `cd backend && go build ./...`
Expected: builds (migrations are embedded; a syntax error would not fail build, so also eyeball the SQL against migration 0031/0032 style). The migration runs on next boot/deploy — it is NOT applied locally now.

- [ ] **Step 3: Commit**

```bash
git add backend/internal/db/migrations/0034_customer_merges.sql
git commit -m "feat(crm): SP-CRM-Merge migration 0034 — merged_into tombstone + customer_merges audit"
```

---

## Task 2: Filter merged rows from all active-customer reads

**Files:**
- Modify: `backend/internal/read/repo.go` — the 5 customer-listing/selecting queries

The 5 queries that must exclude tombstoned rows (verbatim anchors from exploration):

| Method | ~Line | Current FROM/WHERE | Add |
|--------|------|--------------------|-----|
| `Customers` | 699 | `FROM customers WHERE ($3 = '' OR ...)` | ` AND merged_into IS NULL` (append to the existing WHERE, before the tag/seg filters concatenation point) |
| `CustomerByPhone` | 711 | `FROM customers WHERE phone = $1` | ` AND merged_into IS NULL` |
| `CustomerLookup` | 722 | `FROM customers WHERE name ILIKE ... OR phone ILIKE ...` | wrap the OR in parens then ` AND merged_into IS NULL` |
| `RecentCustomersForOutlet` | 741 | `FROM customers c JOIN ...` | ` AND c.merged_into IS NULL` (ALIASED — use `c.`) |
| `Customer` (by id) | 759 | `FROM customers WHERE id=$1` | ` AND merged_into IS NULL` |

- [ ] **Step 1: Read each query and apply the predicate**

For each method above, add the predicate to its WHERE clause. **Critical details:**
- `Customers`: its WHERE is `WHERE ($3 = '' OR name ILIKE ... OR phone ILIKE ... OR email ILIKE ...)` followed by `tagFilter + segFilter`. Insert `AND merged_into IS NULL` immediately after the closing `)` of the `($3 = '' OR ...)` group and before `tagFilter`. Example result:
```go
sql := `SELECT ` + customerObjWithTags + `, count(*) OVER() AS total
       FROM customers
      WHERE ($3 = '' OR name ILIKE '%' || $3 || '%' OR phone ILIKE '%' || $3 || '%' OR email ILIKE '%' || $3 || '%')
        AND merged_into IS NULL` +
    tagFilter + segFilter + `
      ` + order + `
      OFFSET $1 LIMIT $2`
```
- `CustomerLookup`: if its WHERE is `WHERE name ILIKE $1 OR phone ILIKE $1` (no parens), change to `WHERE (name ILIKE $1 OR phone ILIKE $1) AND merged_into IS NULL` so the AND binds correctly.
- `RecentCustomersForOutlet`: **must** use the alias: `AND c.merged_into IS NULL`.

> **FLAG (verify on failure):** read each query's exact current text before editing — the `$N` placeholder numbers and any existing parens differ per query. A misplaced `AND` relative to an unparenthesized `OR` is a silent correctness bug. After editing, re-read each modified query and confirm operator precedence.

- [ ] **Step 2: Build + existing tests stay green**

Run: `cd backend && go build ./... && go test ./...`
Expected: PASS (no behavior change for non-merged rows; no merged rows exist yet).

- [ ] **Step 3: Commit**

```bash
git add backend/internal/read/repo.go
git commit -m "feat(crm): SP-CRM-Merge — exclude tombstoned customers from all active reads"
```

---

## Task 3: Write-boundary redirect in CreateOrder (POS awareness)

**Files:**
- Modify: `backend/internal/service/order.go` — add a terminal-resolver helper + call it before the customer `FOR UPDATE` load (~line 145)

- [ ] **Step 1: Add the terminal resolver helper**

Add this unexported function in `order.go` (near the other helpers, e.g. just above `CreateOrder`):

```go
// resolveMergedCustomer follows customers.merged_into to the terminal (non-merged)
// keeper id, so an order placed against a stale/tombstoned dup id (e.g. from an
// offline POS cache that synced late) lands on the live keeper. Capped + cycle-safe.
func resolveMergedCustomer(ctx context.Context, tx pgx.Tx, id string) (string, error) {
	cur := id
	for i := 0; i < 10; i++ {
		var mi *string
		err := tx.QueryRow(ctx, `SELECT merged_into FROM customers WHERE id=$1`, cur).Scan(&mi)
		if errors.Is(err, pgx.ErrNoRows) {
			return cur, nil // unknown id: leave as-is, downstream load handles it
		}
		if err != nil {
			return "", fmt.Errorf("resolve merged customer: %w", err)
		}
		if mi == nil || *mi == "" {
			return cur, nil // terminal: not merged
		}
		cur = *mi
	}
	return cur, nil // hop cap reached (defensive); use the furthest resolved id
}
```

> **FLAG:** confirm `order.go` already imports `errors` and `github.com/jackc/pgx/v5` (it scans `pgx.ErrNoRows` elsewhere — it does per the FOR UPDATE load). If `pgx` is imported under a different alias, match it.

- [ ] **Step 2: Call it before the customer load**

Immediately before the existing `SELECT points, birthday, anniversary, visit_count ... FOR UPDATE` block (~line 145), insert:

```go
	if in.CustomerID != "" {
		keeperID, e := resolveMergedCustomer(ctx, tx, in.CustomerID)
		if e != nil {
			return "", false, false, e
		}
		in.CustomerID = keeperID // all downstream order/points/aggregate writes target the keeper
	}
```

> **FLAG (verify):** confirm `in.CustomerID` is used (not a separate local) for the subsequent FOR UPDATE load, the aggregate UPDATE (~line 304), and points/ledger writes. The exploration shows the load and aggregate UPDATE both use `in.CustomerID` — reassigning it here redirects all of them. Re-read the function start-to-aggregate-update and confirm no earlier copy of the customer id was taken before this insertion point. If one was, move the resolve above that copy.

- [ ] **Step 3: Build + tests green**

Run: `cd backend && go build ./... && go test ./...`
Expected: PASS (no merged rows yet → resolver returns the id unchanged → byte-identical behavior).

- [ ] **Step 4: Commit**

```bash
git add backend/internal/service/order.go
git commit -m "feat(crm): SP-CRM-Merge — CreateOrder redirects merged customer id to terminal keeper"
```

---

## Task 4: Read layer — dup-candidate list + detail queries

**Files:**
- Create: `backend/internal/read/dupcandidates.go`

These reads JOIN both customers regardless of `merged_into` (a pending candidate's customers are active; using scalar subqueries isolates `customerObj` to a single-table context so its bare columns resolve).

- [ ] **Step 1: Write the list + detail read methods**

```go
package read

import (
	"context"

	"github.com/<module>/backend/internal/api" // FLAG: match the real module path used by repo.go's api import
)

// DupCandidates lists duplicate-customer candidates by status, newest first,
// each with both customers' full objects for side-by-side review.
func (r *Repo) DupCandidates(ctx context.Context, status string, page, limit int) ([]api.DupCandidate, int, error) {
	sql := `SELECT json_build_object(
	  'id', dc.id,
	  'phone', dc.phone,
	  'status', dc.status,
	  'createdAt', dc.created_at,
	  'newCustomer',      (SELECT ` + customerObj + ` FROM customers WHERE id = dc.new_customer_id),
	  'existingCustomer', (SELECT ` + customerObj + ` FROM customers WHERE id = dc.existing_customer_id)
	), count(*) OVER() AS total
	FROM customer_dup_candidates dc
	WHERE dc.status = $3
	ORDER BY dc.created_at DESC, dc.id DESC
	OFFSET $1 LIMIT $2`
	return listJSON[api.DupCandidate](ctx, r.Pool, sql, off(page, limit), limit, status)
}

// DupCandidate fetches one candidate by id with both customers' full objects.
func (r *Repo) DupCandidate(ctx context.Context, id string) (api.DupCandidate, error) {
	sql := `SELECT json_build_object(
	  'id', dc.id,
	  'phone', dc.phone,
	  'status', dc.status,
	  'createdAt', dc.created_at,
	  'newCustomer',      (SELECT ` + customerObj + ` FROM customers WHERE id = dc.new_customer_id),
	  'existingCustomer', (SELECT ` + customerObj + ` FROM customers WHERE id = dc.existing_customer_id)
	)
	FROM customer_dup_candidates dc
	WHERE dc.id = $1`
	return oneJSON[api.DupCandidate](ctx, r.Pool, sql, id)
}
```

> **FLAG (verify):** `customerObj` (read/repo.go:658) embeds `segmentSel`. Confirm `segmentSel` references only the customer row's own columns (so it resolves inside the scalar subquery `FROM customers WHERE id = ...`). If `segmentSel` correlates to an outer alias and fails here, fall back to selecting raw columns (`id,name,phone,email,points,total_spent AS "totalSpent",...`) in the json_build_object instead of `customerObj`, and drop `segment` from the side-by-side (segment isn't needed to decide a merge). Decide this at build time by running the query shape against the test DB read-only.
> **FLAG:** `api.DupCandidate` does not exist until Task 9 (codegen). This file will NOT compile until Task 9 adds the schema. That's expected — implement Tasks 4–8 against the to-be-generated types, then Task 9 generates them, then everything builds. If you prefer compile-green-per-task, do Task 9 BEFORE Tasks 4–8.

- [ ] **Step 2: Commit (will build after Task 9)**

```bash
git add backend/internal/read/dupcandidates.go
git commit -m "feat(crm): SP-CRM-Merge — dup-candidate list + detail reads"
```

---

## Task 5: Write layer — the merge transaction

**Files:**
- Create: `backend/internal/write/merge.go`

This is the heart. Mirrors `AdjustPoints`'s `Pool.Begin` model exactly (NOT `r.tx`).

- [ ] **Step 1: Write sentinel errors + the merge function**

```go
package write

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

var (
	ErrAlreadyMerged      = errors.New("customer already merged")
	ErrCandidateNotPending = errors.New("candidate is not pending")
	ErrSelfMerge          = errors.New("keeper and duplicate are the same customer")
	ErrKeeperNotInPair    = errors.New("keeper is not part of this candidate pair")
)

// editableFields are the profile fields a merge may pull from the dup.
var editableFields = map[string]bool{
	"name": true, "phone": true, "email": true,
	"birthday": true, "anniversary": true, "notes": true,
}

// MergeCustomers merges the duplicate into the keeper in a single Pool.Begin tx
// (NOT r.tx — must not bump content_versions / trigger an all-outlet resync).
// fieldChoices maps an editable field -> "keeper" | "dup"; absent/"keeper" keeps
// the keeper's value. Idempotent: re-running after success returns ErrCandidateNotPending.
func (r *Repo) MergeCustomers(ctx context.Context, candidateID, keeperID string, fieldChoices map[string]string, byID, byName string) error {
	t, err := r.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer t.Rollback(ctx)

	// 1. Load + lock the candidate.
	var status, newID, existingID string
	if e := t.QueryRow(ctx,
		`SELECT status, new_customer_id, existing_customer_id
		   FROM customer_dup_candidates WHERE id=$1 FOR UPDATE`, candidateID,
	).Scan(&status, &newID, &existingID); e != nil {
		if errors.Is(e, pgx.ErrNoRows) {
			return ErrNotFound
		}
		return fmt.Errorf("load candidate: %w", e)
	}
	if status != "pending" {
		return ErrCandidateNotPending
	}

	// keeper must be one member of the pair; dup is the other.
	var dupID string
	switch keeperID {
	case newID:
		dupID = existingID
	case existingID:
		dupID = newID
	default:
		return ErrKeeperNotInPair
	}
	if keeperID == dupID {
		return ErrSelfMerge
	}

	// 2. Lock both customer rows FOR UPDATE in a deterministic order (by id) to
	//    avoid deadlocks, then read their state.
	lo, hi := keeperID, dupID
	if lo > hi {
		lo, hi = hi, lo
	}
	type cust struct {
		id          string
		name, phone string
		email, notes, birthday, anniversary *string
		points      int
		totalSpent  float64
		visitCount  int
		lastVisit   *string
		mergedInto  *string
	}
	load := func(id string) (cust, error) {
		var c cust
		e := t.QueryRow(ctx, `SELECT id,name,phone,email,notes,birthday::text,anniversary::text,
		    points,total_spent,visit_count,last_visit::text,merged_into::text
		    FROM customers WHERE id=$1 FOR UPDATE`, id).
			Scan(&c.id, &c.name, &c.phone, &c.email, &c.notes, &c.birthday, &c.anniversary,
				&c.points, &c.totalSpent, &c.visitCount, &c.lastVisit, &c.mergedInto)
		return c, e
	}
	// lock low then high
	if _, e := load(lo); e != nil {
		if errors.Is(e, pgx.ErrNoRows) {
			return ErrNotFound
		}
		return fmt.Errorf("lock low: %w", e)
	}
	if _, e := load(hi); e != nil {
		if errors.Is(e, pgx.ErrNoRows) {
			return ErrNotFound
		}
		return fmt.Errorf("lock high: %w", e)
	}
	keeper, e := load(keeperID)
	if e != nil {
		return fmt.Errorf("load keeper: %w", e)
	}
	dup, e := load(dupID)
	if e != nil {
		return fmt.Errorf("load dup: %w", e)
	}
	if keeper.mergedInto != nil || dup.mergedInto != nil {
		return ErrAlreadyMerged
	}

	// 3. Apply field choices to the keeper (only editable fields chosen as "dup").
	set := []string{}
	args := []any{}
	n := 1
	pick := func(col string, dupVal any) {
		if fieldChoices[col] == "dup" {
			set = append(set, fmt.Sprintf("%s=$%d", col, n))
			args = append(args, dupVal)
			n++
		}
	}
	for col := range fieldChoices {
		if !editableFields[col] {
			return fmt.Errorf("invalid merge field: %q", col)
		}
	}
	pick("name", dup.name)
	pick("phone", dup.phone)
	pick("email", dup.email)
	pick("notes", dup.notes)
	pick("birthday", dup.birthday)       // date as text; cast below if needed
	pick("anniversary", dup.anniversary)
	if len(set) > 0 {
		args = append(args, keeperID)
		// birthday/anniversary are passed as text; rely on implicit cast or NULLIF::date.
		q := "UPDATE customers SET " + join(set, ", ") + fmt.Sprintf(" WHERE id=$%d", n)
		if _, e := t.Exec(ctx, q, args...); e != nil {
			return fmt.Errorf("apply field choices: %w", e)
		}
	}

	// 4. Tags — union (insert dup's tags onto keeper where not present).
	if _, e := t.Exec(ctx,
		`INSERT INTO customer_tags (customer_id, tag_id)
		   SELECT $1, tag_id FROM customer_tags WHERE customer_id=$2
		 ON CONFLICT DO NOTHING`, keeperID, dupID); e != nil {
		return fmt.Errorf("union tags: %w", e)
	}

	// 5. Re-point orders; capture moved ids for audit.
	rows, e := t.Query(ctx,
		`UPDATE orders SET customer_id=$1 WHERE customer_id=$2 RETURNING id`, keeperID, dupID)
	if e != nil {
		return fmt.Errorf("repoint orders: %w", e)
	}
	movedOrderIDs := []string{}
	for rows.Next() {
		var oid string
		if e := rows.Scan(&oid); e != nil {
			rows.Close()
			return fmt.Errorf("scan moved order: %w", e)
		}
		movedOrderIDs = append(movedOrderIDs, oid)
	}
	rows.Close()
	if e := rows.Err(); e != nil {
		return fmt.Errorf("moved orders: %w", e)
	}

	// 6. Re-point interactions + loyalty applications (NOT point_transactions).
	if _, e := t.Exec(ctx, `UPDATE customer_interactions SET customer_id=$1 WHERE customer_id=$2`, keeperID, dupID); e != nil {
		return fmt.Errorf("repoint interactions: %w", e)
	}
	if _, e := t.Exec(ctx, `UPDATE loyalty_condition_applications SET customer_id=$1 WHERE customer_id=$2`, keeperID, dupID); e != nil {
		return fmt.Errorf("repoint loyalty applications: %w", e)
	}

	// 7. Points reconciliation (skip if dup has 0 — ledger CHECK forbids points=0).
	pointsMoved := dup.points
	if pointsMoved != 0 {
		keeperNew := keeper.points + pointsMoved
		if e := InsertPointTx(ctx, t, PointTxRow{
			CustomerID: keeperID, Type: "adjust", Points: pointsMoved, BalanceAfter: keeperNew,
			Reason: fmt.Sprintf("Gabung dari %s (%s)", dup.phone, dup.name), ByID: byID, ByName: byName,
		}); e != nil {
			return fmt.Errorf("keeper reconciling entry: %w", e)
		}
		if e := InsertPointTx(ctx, t, PointTxRow{
			CustomerID: dupID, Type: "adjust", Points: -pointsMoved, BalanceAfter: 0,
			Reason: fmt.Sprintf("Dipindah ke %s (%s)", keeper.phone, keeper.name), ByID: byID, ByName: byName,
		}); e != nil {
			return fmt.Errorf("dup mirror entry: %w", e)
		}
	}

	// 8. Aggregates — additive (faithful: refund never decrements these). Plus zero dup points.
	if _, e := t.Exec(ctx, `
		UPDATE customers SET
		  total_spent = total_spent + $2,
		  visit_count = visit_count + $3,
		  last_visit  = GREATEST(last_visit, $4::timestamptz),
		  points      = points + $5
		WHERE id=$1`,
		keeperID, dup.totalSpent, dup.visitCount, dup.lastVisit, pointsMoved); e != nil {
		return fmt.Errorf("merge aggregates: %w", e)
	}
	if _, e := t.Exec(ctx, `UPDATE customers SET points=0 WHERE id=$1`, dupID); e != nil {
		return fmt.Errorf("zero dup points: %w", e)
	}

	// 9. Tombstone the dup.
	if _, e := t.Exec(ctx, `UPDATE customers SET merged_into=$1, merged_at=now() WHERE id=$2`, keeperID, dupID); e != nil {
		return fmt.Errorf("tombstone dup: %w", e)
	}

	// 10. Resolve this candidate + any sibling pending candidate referencing the dup.
	if _, e := t.Exec(ctx, `UPDATE customer_dup_candidates SET status='merged' WHERE id=$1`, candidateID); e != nil {
		return fmt.Errorf("mark candidate merged: %w", e)
	}
	if _, e := t.Exec(ctx,
		`UPDATE customer_dup_candidates SET status='merged'
		   WHERE status='pending' AND (new_customer_id=$1 OR existing_customer_id=$1)`, dupID); e != nil {
		return fmt.Errorf("resolve sibling candidates: %w", e)
	}

	// 11. Audit row.
	snapshot, _ := json.Marshal(dup)
	choices, _ := json.Marshal(fieldChoices)
	if _, e := t.Exec(ctx, `
		INSERT INTO customer_merges
		  (keeper_id, dup_id, field_choices, dup_snapshot, moved_order_ids, points_moved, performed_by, performed_by_name)
		VALUES ($1,$2,$3,$4,$5,$6,NULLIF($7,'')::uuid,NULLIF($8,''))`,
		keeperID, dupID, choices, snapshot, movedOrderIDs, pointsMoved, byID, byName); e != nil {
		return fmt.Errorf("audit row: %w", e)
	}

	return t.Commit(ctx)
}

// DismissDupCandidate marks a pending candidate dismissed.
func (r *Repo) DismissDupCandidate(ctx context.Context, id string) error {
	ct, err := r.Pool.Exec(ctx,
		`UPDATE customer_dup_candidates SET status='dismissed' WHERE id=$1 AND status='pending'`, id)
	if err != nil {
		return fmt.Errorf("dismiss candidate: %w", err)
	}
	if ct.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}
```

> **FLAG (verify before relying):**
> - Confirm `ErrNotFound` exists in package `write` (it does — used by interaction.go). Do NOT redeclare it.
> - Confirm a `join(...)` string helper exists in package `write`; if not, use `strings.Join` (import `strings`) instead of `join`.
> - `birthday`/`anniversary` are loaded as `::text` and written back as text into a `date` column — verify Postgres implicit-casts the text date back; if it errors, change the `pick("birthday", ...)` SET fragment to `birthday=$N::date` and pass `nullDate(...)`-style values. The keeper-default path (no "dup" choice) avoids this entirely.
> - `dup_snapshot` marshals the unexported `cust` struct — JSON will be empty for unexported fields. **FIX:** marshal a `map[string]any{"id":dup.id,"name":dup.name,"phone":dup.phone,"email":dup.email,"points":dup.points,"totalSpent":dup.totalSpent,"visitCount":dup.visitCount,...}` instead, so the snapshot has real content. Do this in Step 1 (don't ship the empty-struct version).

- [ ] **Step 2: Fix the snapshot marshal per the flag** (build the explicit map, not the unexported struct).

- [ ] **Step 3: Commit (builds after Task 9)**

```bash
git add backend/internal/write/merge.go
git commit -m "feat(crm): SP-CRM-Merge — merge transaction (Pool.Begin, ledger reconciliation, tombstone, audit) + dismiss"
```

---

## Task 6: Handlers — list, detail, merge, dismiss

**Files:**
- Create: `backend/internal/handlers/merge.go`

- [ ] **Step 1: Write the four handlers**

```go
package handlers

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/<module>/backend/internal/api"   // FLAG: match real import paths used by handlers.go
	"github.com/<module>/backend/internal/httpx"
	"github.com/<module>/backend/internal/write"
)

// DupCandidates GET /customers/dup-candidates?status=&page=&limit= (manage_customers)
func (h *Handlers) DupCandidates(w http.ResponseWriter, r *http.Request) {
	p, l := pageLimit(r)
	status := r.URL.Query().Get("status")
	switch status {
	case "", "pending":
		status = "pending"
	case "merged", "dismissed":
		// ok
	default:
		writeErr(w, http.StatusBadRequest, errors.New("status tidak valid"))
		return
	}
	rows, total, err := h.Repo.DupCandidates(r.Context(), status, p, l)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, api.DupCandidateListResponse{Data: rows, Meta: *meta(total, p, l)})
}

// DupCandidate GET /customers/dup-candidates/{id} (manage_customers)
func (h *Handlers) DupCandidate(w http.ResponseWriter, r *http.Request) {
	v, err := h.Repo.DupCandidate(r.Context(), chi.URLParam(r, "id"))
	if errors.Is(err, read.ErrNotFound) { // FLAG: confirm read.ErrNotFound name/import
		httpx.Err(w, http.StatusNotFound, "kandidat tidak ditemukan")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, api.DupCandidateResponse{Data: v})
}

// MergeDupCandidate POST /customers/dup-candidates/{id}/merge (manage_settings)
func (h *Handlers) MergeDupCandidate(w http.ResponseWriter, r *http.Request) {
	in, ok := decodeWrite[api.MergeCustomersInput](w, r)
	if !ok {
		return
	}
	c, _ := h.caller(r)
	choices := map[string]string{}
	if in.FieldChoices != nil {
		choices = *in.FieldChoices // FLAG: codegen may type this as map[string]string or a struct; adapt
	}
	err := h.Write.MergeCustomers(r.Context(), chi.URLParam(r, "id"), in.KeeperId, choices, c.userID, c.name)
	switch {
	case errors.Is(err, write.ErrNotFound):
		httpx.Err(w, http.StatusNotFound, "tidak ditemukan")
		return
	case errors.Is(err, write.ErrCandidateNotPending),
		errors.Is(err, write.ErrAlreadyMerged),
		errors.Is(err, write.ErrSelfMerge),
		errors.Is(err, write.ErrKeeperNotInPair):
		httpx.Err(w, http.StatusConflict, err.Error())
		return
	case err != nil:
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	h.invalidate(r)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// DismissDupCandidate POST /customers/dup-candidates/{id}/dismiss (manage_customers)
func (h *Handlers) DismissDupCandidate(w http.ResponseWriter, r *http.Request) {
	err := h.Write.DismissDupCandidate(r.Context(), chi.URLParam(r, "id"))
	if errors.Is(err, write.ErrNotFound) {
		httpx.Err(w, http.StatusNotFound, "kandidat tidak ditemukan")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	h.invalidate(r)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
```

> **FLAG:** confirm helper names against handlers.go: `pageLimit`, `meta` (returns `*Meta`? exploration shows `meta(total,p,l)` used as `*meta(...)` in reminders and `meta(...)` in Customers — match the exact form per call site), `writeErr`, `writeJSON`, `decodeWrite`, `h.caller`, `h.invalidate`, `h.Repo`, `h.Write`. Adjust to the real signatures. `read.ErrNotFound`: confirm the read package exposes `ErrNotFound` (oneJSON maps `pgx.ErrNoRows`→it). If it's unexported or named differently, match it.

- [ ] **Step 2: Commit (builds after Task 9)**

```bash
git add backend/internal/handlers/merge.go
git commit -m "feat(crm): SP-CRM-Merge — dup-candidate handlers (list/detail/merge/dismiss)"
```

---

## Task 7: Register routes

**Files:**
- Modify: `backend/internal/server/server.go`

- [ ] **Step 1: Add the read+dismiss routes to the `manage_customers` group**

In the `manage_customers` group (lines 152–174), add (place the static `dup-candidates` paths so they don't collide with `/customers/{id}` — they're literal segments, safe within the group):

```go
		r.Get("/customers/dup-candidates", h.DupCandidates)
		r.Get("/customers/dup-candidates/{id}", h.DupCandidate)
		r.Post("/customers/dup-candidates/{id}/dismiss", h.DismissDupCandidate)
```

- [ ] **Step 2: Add the merge route to the `manage_settings` group**

In the `manage_settings` group (lines 247–255), add:

```go
		r.Post("/customers/dup-candidates/{id}/merge", h.MergeDupCandidate)
```

> **FLAG:** `/customers/dup-candidates` is a static path; chi matches it fine alongside `/customers/{id}` because `{id}` won't capture a path with a further `/segment`. But to be safe, ensure `dup-candidates` literal routes are registered (any order within chi is fine for distinct patterns; chi prioritizes static over param). Verify with the route test in Step 3.

- [ ] **Step 3: Build**

Run: `cd backend && go build ./...`
Expected: builds (after Task 9 types exist). If run before Task 9, expect undefined `api.*` types — that's the codegen dependency.

- [ ] **Step 4: Commit**

```bash
git add backend/internal/server/server.go
git commit -m "feat(crm): SP-CRM-Merge — register dup-candidate routes"
```

---

## Task 8: (reserved — folded into Task 9)

_No-op placeholder removed; codegen is Task 9._

---

## Task 9: OpenAPI schemas + paths + regenerate

**Files:**
- Modify: `backend/api/openapi.yaml` (schemas + paths)
- Regenerate: `backend/internal/api/api.gen.go`, `packages/api/src/schema.d.ts`

- [ ] **Step 1: Add schemas** (in `components/schemas`, near the other Customer schemas ~line 760)

```yaml
    DupCandidate:
      type: object
      required: [id, phone, status, createdAt, newCustomer, existingCustomer]
      properties:
        id: { type: string, format: uuid }
        phone: { type: string }
        status: { type: string, enum: [pending, merged, dismissed] }
        createdAt: { type: string, format: date-time }
        newCustomer: { $ref: '#/components/schemas/Customer' }
        existingCustomer: { $ref: '#/components/schemas/Customer' }
    DupCandidateListResponse:
      type: object
      required: [data, meta]
      properties:
        data: { type: array, items: { $ref: '#/components/schemas/DupCandidate' } }
        meta: { $ref: '#/components/schemas/Meta' }
    DupCandidateResponse:
      type: object
      required: [data]
      properties:
        data: { $ref: '#/components/schemas/DupCandidate' }
    MergeCustomersInput:
      type: object
      required: [keeperId]
      properties:
        keeperId: { type: string, format: uuid }
        fieldChoices:
          type: object
          additionalProperties: { type: string, enum: [keeper, dup] }
          nullable: true
```

> **FLAG:** `additionalProperties` map → oapi-codegen typically generates `map[string]MergeCustomersInputFieldChoices` or `*map[string]string`. After regen, open `api.gen.go`, find the generated `MergeCustomersInput` type, and adjust the handler (Task 6) to the actual generated shape of `FieldChoices` (pointer vs value, string vs typed enum). Same for TS — check `schema.d.ts`.

- [ ] **Step 2: Add paths** (in `paths`, near `/api/v1/customers/{id}/points/adjust` ~line 2246). Note the static `dup-candidates` paths:

```yaml
  /api/v1/customers/dup-candidates:
    get:
      operationId: listDupCandidates
      tags: [customers]
      summary: Duplicate-customer review queue (Backoffice, manage_customers)
      parameters:
        - { name: status, in: query, schema: { type: string, enum: [pending, merged, dismissed] } }
        - { name: page, in: query, schema: { type: integer, default: 1 } }
        - { name: limit, in: query, schema: { type: integer, default: 25 } }
      responses:
        '200':
          description: candidates
          content:
            application/json:
              schema: { $ref: '#/components/schemas/DupCandidateListResponse' }
  /api/v1/customers/dup-candidates/{id}:
    get:
      operationId: getDupCandidate
      tags: [customers]
      summary: One duplicate-customer candidate (Backoffice, manage_customers)
      parameters:
        - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
      responses:
        '200':
          description: candidate
          content:
            application/json:
              schema: { $ref: '#/components/schemas/DupCandidateResponse' }
  /api/v1/customers/dup-candidates/{id}/merge:
    post:
      operationId: mergeDupCandidate
      tags: [customers]
      summary: Confirm a duplicate merge (Backoffice, manage_settings)
      parameters:
        - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/MergeCustomersInput' }
      responses:
        '200':
          description: merged
          content:
            application/json:
              schema: { $ref: '#/components/schemas/OkResponse' }
  /api/v1/customers/dup-candidates/{id}/dismiss:
    post:
      operationId: dismissDupCandidate
      tags: [customers]
      summary: Dismiss a duplicate candidate (Backoffice, manage_customers)
      parameters:
        - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
      responses:
        '200':
          description: dismissed
          content:
            application/json:
              schema: { $ref: '#/components/schemas/OkResponse' }
```

> **FLAG:** confirm a generic `OkResponse` schema exists (the merge/dismiss handlers return `{"ok":true}`). If not, either add `OkResponse: {type: object, properties: {ok: {type: boolean}}}` or reuse whatever the existing `{ok:true}` handlers reference in their OpenAPI (grep for `"ok"` responses; e.g. tag/interaction deletes). Match the existing convention rather than inventing one.

- [ ] **Step 3: Regenerate + verify no drift**

Run:
```
cd backend && make gen-go && make gen-ts && go build ./... && make gen-check
```
Expected: `gen-check` reports no drift; `go build` passes (now `api.DupCandidate` etc. exist, so Tasks 4–7 compile). Fix any handler/read type mismatches surfaced here (the `FieldChoices` shape per the flag).

- [ ] **Step 4: Full backend gate**

Run: `cd backend && go test ./... && go vet ./...`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/api/openapi.yaml backend/internal/api/api.gen.go packages/api/src/schema.d.ts
git commit -m "feat(crm): SP-CRM-Merge — OpenAPI schemas + paths + regen (api.gen.go, schema.d.ts)"
```

---

## Task 10: TS API client methods

**Files:**
- Modify: `packages/api/src/client.ts` (add to the `Api` interface + the returned object)

- [ ] **Step 1: Add the type aliases** (near line 1–68, the `S['...']` aliases)

```ts
export type DupCandidate = S['DupCandidate']
export type MergeCustomersInput = S['MergeCustomersInput']
```

- [ ] **Step 2: Add the four methods** (mirror `listReminders`/`adjustPoints`)

```ts
  listDupCandidates: (status = 'pending', page = 1, limit = 25) =>
    list<DupCandidate>(`${API}/customers/dup-candidates`, { status, page, limit }),

  getDupCandidate: (id: string) =>
    data<DupCandidate>('GET', `${API}/customers/dup-candidates/${id}`),

  mergeDupCandidate: (id: string, input: MergeCustomersInput) =>
    data<{ ok: boolean }>('POST', `${API}/customers/dup-candidates/${id}/merge`, input),

  dismissDupCandidate: (id: string) =>
    data<{ ok: boolean }>('POST', `${API}/customers/dup-candidates/${id}/dismiss`, {}),
```

> **FLAG:** add matching signatures to the `Api` interface (exploration says methods are declared there too). Match the exact `data`/`list`/`request` helper usage and the `${API}` base-path constant. `getDupCandidate` returns a single object → `data<T>`. List → `list<T>`.

- [ ] **Step 3: Gate**

Run: `cd packages/api && pnpm tsc -b` (or the repo's typecheck for the api package).
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/client.ts
git commit -m "feat(crm): SP-CRM-Merge — TS client methods for dup-candidate review"
```

---

## Task 11: Frontend helper — conflict diff (pure, TDD)

**Files:**
- Create: `apps/backoffice/src/screens/customers/mergeTypes.ts`
- Create: `apps/backoffice/src/screens/customers/mergeTypes.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { computeConflicts, MERGE_FIELDS } from './mergeTypes'

const base = {
  id: 'k', name: 'Budi', phone: '0812', email: null, birthday: null,
  anniversary: null, notes: null, points: 0, totalSpent: 0, visitCount: 0,
  lastVisit: null, createdAt: '', segment: null, tags: null,
} as any

describe('computeConflicts', () => {
  it('returns no conflicts when editable fields match', () => {
    expect(computeConflicts(base, { ...base, id: 'd' })).toEqual([])
  })

  it('flags a differing name with keeper default', () => {
    const c = computeConflicts(base, { ...base, id: 'd', name: 'Budi S' })
    expect(c).toEqual([{ field: 'name', keeper: 'Budi', dup: 'Budi S', default: 'keeper' }])
  })

  it('defaults to dup when keeper value is empty and dup is set', () => {
    const c = computeConflicts({ ...base, email: null }, { ...base, id: 'd', email: 'x@y.id' })
    expect(c).toEqual([{ field: 'email', keeper: null, dup: 'x@y.id', default: 'dup' }])
  })

  it('does not flag when only a non-editable field differs (points)', () => {
    expect(computeConflicts(base, { ...base, id: 'd', points: 99 })).toEqual([])
  })
})
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `cd apps/backoffice && pnpm vitest run src/screens/customers/mergeTypes.test.ts`
Expected: FAIL (module/exports not defined).

- [ ] **Step 3: Implement**

```ts
import type { Customer } from '@mandalika/api' // FLAG: match the real Customer type import path used elsewhere in backoffice

export const MERGE_FIELDS = ['name', 'phone', 'email', 'birthday', 'anniversary', 'notes'] as const
export type MergeField = (typeof MERGE_FIELDS)[number]

export const MERGE_FIELD_LABELS: Record<MergeField, string> = {
  name: 'Nama', phone: 'Telepon', email: 'Email',
  birthday: 'Ulang Tahun', anniversary: 'Hari Jadi', notes: 'Catatan',
}

export interface Conflict {
  field: MergeField
  keeper: string | null
  dup: string | null
  default: 'keeper' | 'dup'
}

const norm = (v: unknown): string | null => {
  if (v === undefined || v === null || v === '') return null
  return String(v)
}

// computeConflicts returns only the editable fields that differ between keeper and dup.
// Default = keeper, except when keeper is empty and dup is set (prefer the non-null value).
export function computeConflicts(keeper: Customer, dup: Customer): Conflict[] {
  const out: Conflict[] = []
  for (const field of MERGE_FIELDS) {
    const k = norm((keeper as Record<string, unknown>)[field])
    const d = norm((dup as Record<string, unknown>)[field])
    if (k === d) continue
    out.push({ field, keeper: k, dup: d, default: k === null && d !== null ? 'dup' : 'keeper' })
  }
  return out
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `cd apps/backoffice && pnpm vitest run src/screens/customers/mergeTypes.test.ts`
Expected: PASS (4/4).

- [ ] **Step 5: Commit**

```bash
git add apps/backoffice/src/screens/customers/mergeTypes.ts apps/backoffice/src/screens/customers/mergeTypes.test.ts
git commit -m "feat(crm): SP-CRM-Merge — conflict-diff helper (pure, tested)"
```

---

## Task 12: Frontend — MergeReview component (side-by-side + confirm)

**Files:**
- Create: `apps/backoffice/src/screens/customers/MergeReview.tsx`

- [ ] **Step 1: Implement the review/merge component**

A component that takes a `candidateId`, fetches the pair via `api.getDupCandidate`, lets the user pick the keeper (default = `existingCustomer`, the older one), renders the conflicts-only radio panel (via `computeConflicts`), shows a tags-union preview, and confirms the merge.

```tsx
import { useEffect, useMemo, useState } from 'react'
import { api } from '../../api' // FLAG: match the backoffice api singleton import used by CustomerDetail.tsx
import type { DupCandidate } from '@mandalika/api'
import { Button, Card } from '../../ui' // FLAG: match real UI imports used in this folder
import { computeConflicts, MERGE_FIELD_LABELS, type MergeField } from './mergeTypes'

interface Props {
  candidateId: string
  onBack: () => void   // call after merge/dismiss/cancel; parent refetches the list + badge
}

export default function MergeReview({ candidateId, onBack }: Props) {
  const [cand, setCand] = useState<DupCandidate | null>(null)
  const [keeperIsExisting, setKeeperIsExisting] = useState(true)
  const [choices, setChoices] = useState<Record<string, 'keeper' | 'dup'>>({})
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let ignore = false
    setCand(null)
    api.getDupCandidate(candidateId).then((c) => { if (!ignore) setCand(c) }).catch((e) => { if (!ignore) setErr(String(e)) })
    return () => { ignore = true }
  }, [candidateId])

  const keeper = cand ? (keeperIsExisting ? cand.existingCustomer : cand.newCustomer) : null
  const dup = cand ? (keeperIsExisting ? cand.newCustomer : cand.existingCustomer) : null

  const conflicts = useMemo(() => (keeper && dup ? computeConflicts(keeper, dup) : []), [keeper, dup])

  // Default each conflict to its computed default whenever the pair/keeper flips.
  useEffect(() => {
    const next: Record<string, 'keeper' | 'dup'> = {}
    for (const c of conflicts) next[c.field] = c.default
    setChoices(next)
  }, [conflicts])

  if (err) return <Card className="p-6 text-red-600">{err} <Button onClick={onBack}>Kembali</Button></Card>
  if (!cand || !keeper || !dup) return <Card className="p-6">Memuat…</Card>

  const doMerge = async () => {
    setBusy(true); setErr(null)
    try {
      await api.mergeDupCandidate(candidateId, { keeperId: keeper.id, fieldChoices: choices })
      onBack()
    } catch (e) { setErr(String(e)); setConfirming(false) } finally { setBusy(false) }
  }
  const doDismiss = async () => {
    setBusy(true); setErr(null)
    try { await api.dismissDupCandidate(candidateId); onBack() }
    catch (e) { setErr(String(e)) } finally { setBusy(false) }
  }

  const tagUnion = dedupeTags([...(keeper.tags ?? []), ...(dup.tags ?? [])])

  return (
    <div className="p-6 space-y-4">
      <button className="text-sm text-gray-500" onClick={onBack}>← Kembali</button>
      <h2 className="text-lg font-semibold">Tinjau Duplikat · {cand.phone}</h2>

      {/* keeper toggle */}
      <div className="flex gap-3 text-sm">
        <span>Simpan sebagai utama:</span>
        <label><input type="radio" checked={keeperIsExisting} onChange={() => setKeeperIsExisting(true)} /> {cand.existingCustomer.name} (lama)</label>
        <label><input type="radio" checked={!keeperIsExisting} onChange={() => setKeeperIsExisting(false)} /> {cand.newCustomer.name} (baru)</label>
      </div>

      {/* side-by-side summary */}
      <div className="grid grid-cols-2 gap-4">
        <CustomerCard title="Utama (disimpan)" c={keeper} />
        <CustomerCard title="Duplikat (digabung)" c={dup} />
      </div>

      {/* conflicts-only radio panel */}
      {conflicts.length > 0 && (
        <Card className="p-4 space-y-2">
          <div className="font-medium text-sm">Pilih nilai untuk field yang berbeda</div>
          {conflicts.map((c) => (
            <div key={c.field} className="grid grid-cols-[120px_1fr_1fr] items-center gap-2 text-sm">
              <span>{MERGE_FIELD_LABELS[c.field as MergeField]}</span>
              <label className={choices[c.field] === 'keeper' ? 'font-medium' : ''}>
                <input type="radio" checked={choices[c.field] === 'keeper'} onChange={() => setChoices((p) => ({ ...p, [c.field]: 'keeper' }))} /> {c.keeper ?? '—'}
              </label>
              <label className={choices[c.field] === 'dup' ? 'font-medium' : ''}>
                <input type="radio" checked={choices[c.field] === 'dup'} onChange={() => setChoices((p) => ({ ...p, [c.field]: 'dup' }))} /> {c.dup ?? '—'}
              </label>
            </div>
          ))}
        </Card>
      )}

      {/* tags union preview */}
      <div className="text-sm">Tag setelah gabung: {tagUnion.length ? tagUnion.map((t) => t.name).join(', ') : '—'}</div>

      {err && <div className="text-red-600 text-sm">{err}</div>}

      <div className="flex gap-3">
        <Button variant="danger" disabled={busy} onClick={() => setConfirming(true)}>Gabungkan</Button>
        <Button variant="ghost" disabled={busy} onClick={doDismiss}>Bukan Duplikat</Button>
      </div>

      {confirming && (
        <Card className="p-4 border-red-300 space-y-3">
          <div className="text-sm">Gabungkan <b>{dup.name}</b> ke <b>{keeper.name}</b> permanen? Pesanan & poin pindah; tindakan ini <b>tidak bisa dibatalkan otomatis</b>.</div>
          <div className="flex gap-2">
            <Button variant="danger" loading={busy} onClick={doMerge}>Ya, Gabungkan</Button>
            <Button variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>Batal</Button>
          </div>
        </Card>
      )}
    </div>
  )
}

function CustomerCard({ title, c }: { title: string; c: DupCandidate['newCustomer'] }) {
  return (
    <Card className="p-4 text-sm space-y-1">
      <div className="font-medium">{title}</div>
      <div>Nama: {c.name}</div>
      <div>Telepon: {c.phone}</div>
      <div>Email: {c.email ?? '—'}</div>
      <div>Poin: {c.points}</div>
      <div>Total belanja: {c.totalSpent}</div>
      <div>Kunjungan: {c.visitCount}</div>
    </Card>
  )
}

function dedupeTags(tags: { id: string; name: string }[]): { id: string; name: string }[] {
  const seen = new Set<string>()
  return tags.filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)))
}
```

> **FLAG:** match the real `Button`/`Card`/`Tabs` component imports + prop APIs from `../../ui` (exploration: `Button` has `loading`, `variant`, `disabled`; verify `variant="danger"`/`"ghost"` exist — if not, use the project's actual variants). Match the `api` singleton import (`../../api`) used by `CustomerDetail.tsx`. Match the `Customer`/`DupCandidate` type import path (`@mandalika/api`). Use the formatting helper the repo uses for IDR/numbers if one exists (e.g. `totalSpent` is likely formatted elsewhere — reuse it instead of raw render).

- [ ] **Step 2: Gate**

Run: `cd apps/backoffice && pnpm tsc -b`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/backoffice/src/screens/customers/MergeReview.tsx
git commit -m "feat(crm): SP-CRM-Merge — MergeReview side-by-side component"
```

---

## Task 13: Frontend — DupCandidates list + Duplikat sub-tab wiring

**Files:**
- Create: `apps/backoffice/src/screens/customers/DupCandidates.tsx`
- Modify: `apps/backoffice/src/screens/Customers.tsx`

- [ ] **Step 1: Implement the list view**

```tsx
import { useEffect, useState } from 'react'
import { api } from '../../api'
import type { DupCandidate } from '@mandalika/api'
import { Button, Card } from '../../ui'

interface Props {
  onReview: (candidateId: string) => void
  refreshKey: number   // bump to refetch after a merge/dismiss
}

export default function DupCandidates({ onReview, refreshKey }: Props) {
  const [rows, setRows] = useState<DupCandidate[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let ignore = false
    setLoading(true)
    api.listDupCandidates('pending', 1, 50)
      .then((r) => { if (!ignore) setRows(r.data) })
      .finally(() => { if (!ignore) setLoading(false) })
    return () => { ignore = true }
  }, [refreshKey])

  if (loading) return <Card className="p-6">Memuat…</Card>
  if (!rows.length) return <Card className="p-6 text-gray-500">Tidak ada duplikat untuk ditinjau.</Card>

  return (
    <Card className="overflow-hidden divide-y">
      {rows.map((c) => (
        <div key={c.id} className="flex items-center justify-between p-4 text-sm">
          <div>
            <div className="font-medium">{c.existingCustomer.name} ↔ {c.newCustomer.name}</div>
            <div className="text-gray-500">{c.phone} · ditandai {new Date(c.createdAt).toLocaleDateString('id-ID')}</div>
          </div>
          <Button variant="ghost" onClick={() => onReview(c.id)}>Tinjau</Button>
        </div>
      ))}
    </Card>
  )
}
```

- [ ] **Step 2: Wire the `Duplikat` sub-tab into Customers.tsx**

In `apps/backoffice/src/screens/Customers.tsx`:
1. Extend the sub-view type: `const [custView, setCustView] = useState<'daftar' | 'pengingat' | 'duplikat'>('daftar')`.
2. Add a `selectedDupId` state mirroring `selectedId`: `const [selectedDupId, setSelectedDupId] = useState<string | null>(null)` and `const [dupRefresh, setDupRefresh] = useState(0)`.
3. Add a pending-count badge: fetch the count once (`api.listDupCandidates('pending', 1, 1)` → `r.meta?.total`) into a `dupCount` state, refetched on `dupRefresh`.
4. Add the tab to the `Tabs` array: `{ id: 'duplikat', label: dupCount ? \`Duplikat (\${dupCount})\` : 'Duplikat' }`.
5. Add the render branch (before the `daftar` fallback), with the list→review view-swap:

```tsx
) : custView === 'duplikat' ? (
  selectedDupId ? (
    <MergeReview
      candidateId={selectedDupId}
      onBack={() => { setSelectedDupId(null); setDupRefresh((n) => n + 1) }}
    />
  ) : (
    <DupCandidates refreshKey={dupRefresh} onReview={setSelectedDupId} />
  )
) : (
```

6. Add imports at top: `import DupCandidates from './customers/DupCandidates'` and `import MergeReview from './customers/MergeReview'`.

> **FLAG:** match the exact `Tabs` component prop API and the existing `custView` switch structure (exploration shows `custView === 'pengingat' ? (...) : (...)`). Insert the `duplikat` branch consistently. Verify `r.meta?.total` is the list-result shape (`ListResult<T>` has `meta`). If the count fetch is awkward, derive `dupCount` from the loaded list length when on the tab and skip the separate count fetch (simpler; badge then only updates when the tab is opened — acceptable).

- [ ] **Step 3: Gate**

Run: `cd apps/backoffice && pnpm tsc -b && pnpm vite build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/backoffice/src/screens/customers/DupCandidates.tsx apps/backoffice/src/screens/Customers.tsx
git commit -m "feat(crm): SP-CRM-Merge — Duplikat sub-tab (list + review view swap + badge)"
```

---

## Task 14: Live e2e + deploy verification

**Files:**
- Create (throwaway, deleted after): `backend/cmd/spmergee2e/main.go`

This proves the DB-coupled merge correctness against the test DB (the repo norm — same protocol as SP-CRM-7/8/9: real services, all artifacts deleted, state restored).

- [ ] **Step 1: Deploy the backend (runs migration 0034)**

Run: `gcloud run deploy mandalika-pos --source backend --region asia-southeast2 --quiet`
Then: `curl -s https://<cloud-run-url>/readyz` → expect `ok`. Capture the new revision.

> Pre-authorized via `autoMode.allow` in `.claude/settings.local.json` (migration-bearing deploy).

- [ ] **Step 2: Write the throwaway e2e**

A `main.go` that (DATABASE_URL via `gcloud secrets versions access latest --secret=DATABASE_URL` command-substitution, never printed):
1. Creates customer A (keeper) + B (dup) with the same phone; gives each an order via the **real** `service.OrderService.CreateOrder` (so points/aggregates/ledger are real); manually inserts a `customer_dup_candidates` row (A,B,pending).
2. Calls `write.Repo.MergeCustomers(candidateID, A.id, {"email":"dup"}, ...)`.
3. Asserts: all of B's orders now have `customer_id = A`; `A.points == A0 + B0` with a keeper `adjust` ledger entry + a dup mirror `-B0 → 0` entry; `A.total_spent == A0+B0`, `visit_count` summed; B has `merged_into = A`, `points = 0`; candidate `status='merged'`; a `customer_merges` row with `moved_order_ids` + `dup_snapshot`; A's email took B's (field choice).
4. Asserts **redirect**: `CreateOrder` with `customerID = B.id` (the dead id) lands the order + points on A.
5. Asserts **idempotency**: a second `MergeCustomers` call returns `ErrCandidateNotPending` (no double-move).
6. Asserts **lookup filtering**: `read.CustomerByPhone(phone)` / `CustomerLookup` returns A, not B.
7. **Cleanup:** delete point_transactions, customer_merges, order_items, processed_keys, orders, customer_dup_candidates, then the two customers; restore loyalty settings if toggled. Verify stock net-zero / no leftovers.

> Follow `backend/cmd/sp9e2e/main.go` as the template for wiring the real services + the cleanup/restore protocol. Build it, run it, read the asserts, then **delete the throwaway** (never commit it).

- [ ] **Step 3: Run it**

Run: `cd backend && go run ./cmd/spmergee2e` (with DATABASE_URL exported via the secret substitution).
Expected: all asserts pass; cleanup OK; zero leftovers.

- [ ] **Step 4: Authed smoke (deployed)**

With the deployed admin (`admin@mandalika.test`, password via `gcloud secrets versions access latest --secret=SEED_ADMIN_PASSWORD` substitution, never printed): `GET /api/v1/customers/dup-candidates` → 200 enveloped `{data:[...],meta}`; no-token → 401; bad `status` → 400.

- [ ] **Step 5: Delete the throwaway + final gate**

```bash
rm -rf backend/cmd/spmergee2e
cd backend && go build ./... && go test ./... && go vet ./...
```

- [ ] **Step 6: Push**

```bash
git push origin prod-hardening
```

---

## Self-Review (completed during planning)

**Spec coverage:** migration 0034 (Task 1) ✓; read filter on all 5 active reads (Task 2) ✓; write-boundary redirect + chain/cycle (Task 3) ✓; dup-candidate reads (Task 4) ✓; merge tx with ledger reconciliation both sides + additive aggregates + tombstone + sibling resolution + audit (Task 5) ✓; dismiss (Task 5) ✓; 4 endpoints + permission gates (Tasks 6–7, 9) ✓; OpenAPI/type-gen (Task 9) ✓; TS client (Task 10) ✓; Duplikat sub-tab + side-by-side + conflicts-only + keeper toggle + confirm dialog (Tasks 11–13) ✓; test plan: pure conflict helper unit-tested (Task 11), DB correctness via live e2e (Task 14) ✓.

**Deliberate deviation from spec (flag to user):** the GET detail endpoint returns the **pair (both full Customer objects)**; the **conflicts array is computed in the frontend** (`computeConflicts`, Task 11) rather than server-side as §5 of the spec worded it. Rationale: the merge contract is explicit `fieldChoices` either way, the diff is trivial/pure in TS and unit-testable, and it removes a redundant backend concept (YAGNI). Net behavior is identical. Raised at handoff.

**Placeholder scan:** no TBD/TODO; every code step has concrete code. The `<module>` import-path tokens are explicit FLAGs to match the real module path (not silent placeholders) — the executor reads one existing file to fill them.

**Type consistency:** `MergeCustomers(candidateID, keeperID, map[string]string, byID, byName) error` used identically in Task 5 (def), Task 6 (handler call). `computeConflicts(keeper, dup)` def (Task 11) ↔ use (Task 12). `DupCandidate.newCustomer/existingCustomer` consistent across reads (Task 4), schema (Task 9), client (Task 10), UI (Tasks 12–13). Sentinel errors declared once (Task 5), mapped once (Task 6).

**Known build-order note:** Tasks 4–8 reference `api.*` types created in Task 9; either implement Task 9 right after Task 1–3 and before 4–8, or accept that 4–8 compile only once 9 runs. The subagent executor should be told this ordering.
