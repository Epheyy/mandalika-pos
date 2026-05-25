# Inventory SP2 — Transfers Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **The 6 working rules (user-required, apply to every task):** 1) Ask, don't assume. 2) Don't touch unrelated code. 3) Flag uncertainty. 4) Verify on failure (never fake success). 5) Show changes (diffs). 6) Admit gaps.

**Goal:** Add backoffice product **transfers** — mesh (any warehouse/outlet ↔ any warehouse/outlet), two-step draft → send → in-transit → receive (with discrepancy) → completed, plus cancel — moving stock between the existing per-outlet and per-warehouse stock tables, bumping `content_version` only on outlet legs.

**Architecture:** A new `transfers` + `transfer_items` schema with polymorphic source/dest (separate nullable FK columns, `CHECK num_nonnulls = 1`, mirroring `stock_counts`). Stock is **implicit in-transit**: deducted from source on send, credited to dest on receive. Go write methods use a manual tx that conditionally calls the existing `bumpVersionOutlets(...,"products",...)` for outlet legs only (warehouse legs never bump — they're not POS-synced). Backoffice gets a **Transfer tab** inside the existing Gudang screen. All routes gated by `manage_inventory`.

**Tech Stack:** Go (pgx, chi, oapi-codegen), Postgres (Neon), TypeScript React backoffice (Vite, Tailwind, lucide-react), generated `@mandalika/api` client.

**Spec:** `docs/superpowers/specs/2026-05-25-inventory-sp2-transfers-core-design.md`

---

## Conventions reused from the codebase (read before starting)

- **Polymorphic location precedent:** `backend/internal/write/stockcount.go` (`scopeCount`, `CompleteStockCount` branch on `outlet_id` vs `warehouse_id`; outlet path uses `r.tx(ctx,"products")` to bump, warehouse path uses `r.noBumpTx`).
- **Per-outlet bump helper:** `bumpVersionOutlets(ctx, tx, "products", []string{outletID})` in `backend/internal/write/repo.go`. `noBumpTx` (in `warehouse.go`) = manual tx with no bump.
- **Null helpers:** `nullStr`, `nullUUID` (in `write/repo.go`). `nullUUID("")` → NULL.
- **Read helpers:** `listJSON[T]`, `oneJSON[T]`, `off(page,limit)` in `backend/internal/read/repo.go`. Handlers helpers `pageLimit(r)`, `meta(total,p,l)`, `writeJSON`, `writeErr` (maps `read.ErrNotFound`→404), `decodeWrite[T]`, `h.caller(r)`, `h.created`, `h.mutated` in `backend/internal/handlers/`.
- **Codegen:** `cd backend && make gen-go` (Go DTOs/server → `internal/api/api.gen.go`) and `make gen-ts` (TS types → `packages/api/src/schema.d.ts`). CI gate `make gen-check` fails if `api.gen.go` drifts — always commit the regenerated file. Run `gofmt -w internal/` before committing Go.
- **TS client:** types + `Api` interface + impl all live in `packages/api/src/client.ts`; `index.ts` re-exports via `export * from './client'`.
- **Commit hook:** blocks `--no-verify` and false-positives on chained `git commit && …`. Run `git commit` on its own line; push separately.
- **Deploy (agent can self-run):** `gcloud run deploy mandalika-pos --source backend --region asia-southeast2 --quiet` (use Bash with `dangerouslyDisableSandbox: true`; ~4–6 min; migrations auto-apply on boot). Verify `GET /readyz` (NOT `/healthz` — swallowed by Google edge). Backoffice auto-deploys on push to `prod-hardening`.
- **Test creds:** admin `admin@mandalika.test`; password in Secret Manager: `gcloud secrets versions access latest --secret=SEED_ADMIN_PASSWORD`. (If login 401s, also try `admin@mandalika.local` — confirm with user.)

---

## Phase A — Schema, contract, pure logic, reads

### Task 1: Migration `0016_transfers.sql`

**Files:**
- Create: `backend/internal/db/migrations/0016_transfers.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 0016: product transfers (mesh: any location ↔ any location). Two-step
-- send→receive with IMPLICIT in-transit — stock leaves the source on send and
-- lands at the dest on receive (it is on nobody's on-hand while moving). Source
-- and dest are each polymorphic: exactly one of an outlet OR a warehouse. Only
-- outlet legs bump content_version (done in Go), never here.
CREATE SEQUENCE IF NOT EXISTS transfer_no_seq;

CREATE TABLE transfers (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_no         text NOT NULL DEFAULT ('TRF-' || lpad(nextval('transfer_no_seq')::text, 5, '0')),
  status              text NOT NULL DEFAULT 'draft',
  source_outlet_id    uuid REFERENCES outlets(id),
  source_warehouse_id uuid REFERENCES warehouses(id),
  dest_outlet_id      uuid REFERENCES outlets(id),
  dest_warehouse_id   uuid REFERENCES warehouses(id),
  note                text,
  discrepancy_reason  text,
  created_by          uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  sent_at             timestamptz,
  received_at         timestamptz,
  cancelled_at        timestamptz,
  CONSTRAINT transfers_one_source CHECK (num_nonnulls(source_outlet_id, source_warehouse_id) = 1),
  CONSTRAINT transfers_one_dest   CHECK (num_nonnulls(dest_outlet_id, dest_warehouse_id) = 1)
);

CREATE TABLE transfer_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id  uuid NOT NULL REFERENCES transfers(id) ON DELETE CASCADE,
  product_id   uuid NOT NULL REFERENCES products(id),
  variant_size text NOT NULL,
  sent_qty     integer NOT NULL,
  received_qty integer,
  difference   integer
);

CREATE INDEX idx_transfers_status ON transfers(status);
CREATE INDEX idx_transfer_items_transfer ON transfer_items(transfer_id);
```

- [ ] **Step 2: Sanity-build (migrations are embedded via go:embed)**

Run: `cd backend && go build ./...`
Expected: builds with no error (the new SQL file is embedded; not yet applied to any DB — it applies on the next deploy in Task 10).

- [ ] **Step 3: Commit**

```bash
git add backend/internal/db/migrations/0016_transfers.sql
git commit -m "feat(inventory): SP2 migration 0016 — transfers + transfer_items"
```

---

### Task 2: OpenAPI contract — schemas, paths, regenerate Go + TS

**Files:**
- Modify: `backend/api/openapi.yaml` (schemas after `WarehouseAdjustInput` ~line 196; paths after the `/api/v1/warehouses/{id}/adjust` block ~line 1606)
- Regenerate: `backend/internal/api/api.gen.go`, `packages/api/src/schema.d.ts`

- [ ] **Step 1: Add schemas** (insert immediately after the `WarehouseAdjustInput` schema block)

```yaml
    TransferLocation:
      type: object
      required: [kind, id]
      properties:
        kind: { type: string, enum: [outlet, warehouse] }
        id: { type: string, format: uuid }
        name: { type: string }
    TransferLocationInput:
      type: object
      required: [kind, id]
      properties:
        kind: { type: string, enum: [outlet, warehouse] }
        id: { type: string, format: uuid }
    TransferItem:
      type: object
      required: [productId, productName, variantSize, sentQty]
      properties:
        productId: { type: string, format: uuid }
        productName: { type: string }
        variantSize: { type: string }
        sku: { type: string }
        sentQty: { type: integer }
        receivedQty: { type: integer, nullable: true }
        difference: { type: integer, nullable: true }
    Transfer:
      type: object
      required: [id, transferNo, status, source, dest, createdAt, items]
      properties:
        id: { type: string, format: uuid }
        transferNo: { type: string }
        status: { type: string, enum: [draft, in_transit, completed, cancelled] }
        source: { $ref: '#/components/schemas/TransferLocation' }
        dest: { $ref: '#/components/schemas/TransferLocation' }
        note: { type: string, nullable: true }
        discrepancyReason: { type: string, nullable: true }
        createdAt: { type: string, format: date-time }
        sentAt: { type: string, format: date-time, nullable: true }
        receivedAt: { type: string, format: date-time, nullable: true }
        cancelledAt: { type: string, format: date-time, nullable: true }
        items: { type: array, items: { $ref: '#/components/schemas/TransferItem' } }
    TransferListResponse:
      type: object
      required: [data, meta]
      properties:
        data: { type: array, items: { $ref: '#/components/schemas/Transfer' } }
        meta: { $ref: '#/components/schemas/Meta' }
    TransferResponse:
      type: object
      required: [data]
      properties:
        data: { $ref: '#/components/schemas/Transfer' }
    TransferItemInput:
      type: object
      required: [productId, variantSize, qty]
      properties:
        productId: { type: string, format: uuid }
        variantSize: { type: string }
        qty: { type: integer }
    TransferCreateInput:
      type: object
      required: [source, dest, items]
      properties:
        source: { $ref: '#/components/schemas/TransferLocationInput' }
        dest: { $ref: '#/components/schemas/TransferLocationInput' }
        note: { type: string, nullable: true }
        items: { type: array, items: { $ref: '#/components/schemas/TransferItemInput' } }
    TransferReceiveItemInput:
      type: object
      required: [productId, variantSize, receivedQty]
      properties:
        productId: { type: string, format: uuid }
        variantSize: { type: string }
        receivedQty: { type: integer }
    TransferReceiveInput:
      type: object
      required: [items]
      properties:
        items: { type: array, items: { $ref: '#/components/schemas/TransferReceiveItemInput' } }
        discrepancyReason: { type: string, nullable: true }
```

- [ ] **Step 2: Add paths** (insert immediately after the `/api/v1/warehouses/{id}/adjust` path block, before `/api/v1/custom-roles`)

```yaml
  /api/v1/transfers:
    get:
      operationId: listTransfers
      tags: [catalog]
      summary: List transfers (Backoffice)
      parameters:
        - { name: status, in: query, required: false, schema: { type: string } }
        - { name: page, in: query, required: false, schema: { type: integer } }
        - { name: limit, in: query, required: false, schema: { type: integer } }
      responses:
        '200':
          description: transfers
          content:
            application/json:
              schema: { $ref: '#/components/schemas/TransferListResponse' }
    post:
      operationId: createTransfer
      tags: [catalog]
      summary: Create a draft transfer (Backoffice)
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/TransferCreateInput' }
      responses:
        '201':
          description: created
          content:
            application/json:
              schema: { $ref: '#/components/schemas/IdResponse' }
  /api/v1/transfers/location-stock:
    get:
      operationId: getTransferLocationStock
      tags: [catalog]
      summary: On-hand stock rows for a transfer source/dest location (Backoffice)
      parameters:
        - { name: kind, in: query, required: true, schema: { type: string, enum: [outlet, warehouse] } }
        - { name: id, in: query, required: true, schema: { type: string, format: uuid } }
      responses:
        '200':
          description: stock rows
          content:
            application/json:
              schema: { $ref: '#/components/schemas/WarehouseStockResponse' }
  /api/v1/transfers/{id}:
    parameters:
      - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
    get:
      operationId: getTransfer
      tags: [catalog]
      summary: Transfer detail (Backoffice)
      responses:
        '200':
          description: transfer
          content:
            application/json:
              schema: { $ref: '#/components/schemas/TransferResponse' }
        '404': { $ref: '#/components/responses/NotFound' }
    put:
      operationId: updateTransfer
      tags: [catalog]
      summary: Edit a draft transfer (Backoffice)
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/TransferCreateInput' }
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema: { $ref: '#/components/schemas/OkResponse' }
        '404': { $ref: '#/components/responses/NotFound' }
  /api/v1/transfers/{id}/send:
    parameters:
      - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
    post:
      operationId: sendTransfer
      tags: [catalog]
      summary: Send a transfer (Backoffice)
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema: { $ref: '#/components/schemas/OkResponse' }
        '404': { $ref: '#/components/responses/NotFound' }
  /api/v1/transfers/{id}/receive:
    parameters:
      - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
    post:
      operationId: receiveTransfer
      tags: [catalog]
      summary: Receive a transfer (Backoffice)
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/TransferReceiveInput' }
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema: { $ref: '#/components/schemas/OkResponse' }
        '404': { $ref: '#/components/responses/NotFound' }
  /api/v1/transfers/{id}/cancel:
    parameters:
      - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
    post:
      operationId: cancelTransfer
      tags: [catalog]
      summary: Cancel a transfer (Backoffice)
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema: { $ref: '#/components/schemas/OkResponse' }
        '404': { $ref: '#/components/responses/NotFound' }
```

- [ ] **Step 3: Regenerate Go + TS**

Run: `cd backend && make gen-go && make gen-ts`
Expected: `internal/api/api.gen.go` now contains `Transfer`, `TransferItem`, `TransferLocation`, `TransferCreateInput`, `TransferReceiveInput`, `TransferListResponse` types; `packages/api/src/schema.d.ts` updated. No errors.

- [ ] **Step 4: Verify build + drift gate**

Run: `cd backend && go build ./... && make gen-check`
Expected: builds; `gen-check` prints nothing (no drift).

- [ ] **Step 5: Commit**

```bash
git add backend/api/openapi.yaml backend/internal/api/api.gen.go packages/api/src/schema.d.ts
git commit -m "feat(inventory): SP2 OpenAPI — transfer schemas, paths, regenerated Go+TS"
```

---

### Task 3: Pure helpers + Go table tests (TDD)

**Files:**
- Create: `backend/internal/write/transfer_logic.go`
- Test: `backend/internal/write/transfer_test.go`

- [ ] **Step 1: Write the failing tests**

```go
package write

import "testing"

func TestValidLocKind(t *testing.T) {
	for _, tt := range []struct {
		kind string
		want bool
	}{
		{"outlet", true}, {"warehouse", true}, {"", false}, {"shop", false},
	} {
		if got := validLocKind(tt.kind); got != tt.want {
			t.Fatalf("validLocKind(%q)=%v want %v", tt.kind, got, tt.want)
		}
	}
}

func TestSameLoc(t *testing.T) {
	a := TransferLoc{Kind: "outlet", ID: "1"}
	if !sameLoc(a, TransferLoc{Kind: "outlet", ID: "1"}) {
		t.Fatal("expected same")
	}
	if sameLoc(a, TransferLoc{Kind: "warehouse", ID: "1"}) {
		t.Fatal("different kind must not be same")
	}
	if sameLoc(a, TransferLoc{Kind: "outlet", ID: "2"}) {
		t.Fatal("different id must not be same")
	}
}

func TestTransferTransition(t *testing.T) {
	tests := []struct {
		from, action, want string
		wantErr            bool
	}{
		{"draft", "send", "in_transit", false},
		{"in_transit", "receive", "completed", false},
		{"draft", "cancel", "cancelled", false},
		{"in_transit", "cancel", "cancelled", false},
		{"completed", "cancel", "", true},
		{"cancelled", "send", "", true},
		{"in_transit", "send", "", true},
		{"draft", "receive", "", true},
		{"draft", "bogus", "", true},
	}
	for _, tt := range tests {
		got, err := transferTransition(tt.from, tt.action)
		if (err != nil) != tt.wantErr {
			t.Fatalf("transition(%q,%q) err=%v wantErr=%v", tt.from, tt.action, err, tt.wantErr)
		}
		if got != tt.want {
			t.Fatalf("transition(%q,%q)=%q want %q", tt.from, tt.action, got, tt.want)
		}
	}
}

func TestTransferDiff(t *testing.T) {
	if transferDiff(10, 7) != -3 {
		t.Fatal("shortfall should be negative")
	}
	if transferDiff(10, 12) != 2 {
		t.Fatal("surplus should be positive")
	}
	if transferDiff(5, 5) != 0 {
		t.Fatal("equal should be zero")
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && go test ./internal/write/ -run 'Transfer|ValidLocKind|SameLoc' -v`
Expected: FAIL — `undefined: validLocKind` / `TransferLoc` / `sameLoc` / `transferTransition` / `transferDiff`.

- [ ] **Step 3: Write the implementation**

```go
package write

import "fmt"

// TransferLoc is a polymorphic transfer endpoint (source or destination).
type TransferLoc struct {
	Kind string `json:"kind"` // "outlet" | "warehouse"
	ID   string `json:"id"`
}

func validLocKind(kind string) bool { return kind == "outlet" || kind == "warehouse" }

// sameLoc reports a self-transfer (source and dest are the same place).
func sameLoc(a, b TransferLoc) bool { return a.Kind == b.Kind && a.ID == b.ID }

// transferTransition returns the status a transfer moves to when `action` is
// applied while in `from`, or an error if the action is not allowed there.
// Actions: "send" (draft→in_transit), "receive" (in_transit→completed),
// "cancel" (draft|in_transit→cancelled).
func transferTransition(from, action string) (string, error) {
	switch action {
	case "send":
		if from == "draft" {
			return "in_transit", nil
		}
	case "receive":
		if from == "in_transit" {
			return "completed", nil
		}
	case "cancel":
		if from == "draft" || from == "in_transit" {
			return "cancelled", nil
		}
	}
	return "", fmt.Errorf("aksi tidak diizinkan dari status '%s'", from)
}

// transferDiff is received minus sent (negative = shortfall, positive = surplus).
func transferDiff(sent, received int) int { return received - sent }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && gofmt -w internal/ && go test ./internal/write/ -run 'Transfer|ValidLocKind|SameLoc' -v`
Expected: PASS (all subtests).

- [ ] **Step 5: Commit**

```bash
git add backend/internal/write/transfer_logic.go backend/internal/write/transfer_test.go
git commit -m "test(inventory): SP2 transfer pure helpers (transition/diff/loc) + table tests"
```

---

### Task 4: Read layer — list, detail, location-stock

**Files:**
- Modify: `backend/internal/read/repo.go` (add after the `StockCount` function, ~line 540)

- [ ] **Step 1: Add the transfer readers**

```go
const transferObj = `json_build_object(
  'id', t.id, 'transferNo', t.transfer_no, 'status', t.status,
  'source', json_build_object(
    'kind', CASE WHEN t.source_outlet_id IS NOT NULL THEN 'outlet' ELSE 'warehouse' END,
    'id',   COALESCE(t.source_outlet_id, t.source_warehouse_id),
    'name', COALESCE(so.name, sw.name)),
  'dest', json_build_object(
    'kind', CASE WHEN t.dest_outlet_id IS NOT NULL THEN 'outlet' ELSE 'warehouse' END,
    'id',   COALESCE(t.dest_outlet_id, t.dest_warehouse_id),
    'name', COALESCE(do2.name, dw.name)),
  'note', t.note, 'discrepancyReason', t.discrepancy_reason,
  'createdAt', t.created_at, 'sentAt', t.sent_at,
  'receivedAt', t.received_at, 'cancelledAt', t.cancelled_at,
  'items', COALESCE((SELECT json_agg(json_build_object(
     'productId', ti.product_id, 'productName', p.name,
     'variantSize', ti.variant_size, 'sku', v.sku,
     'sentQty', ti.sent_qty, 'receivedQty', ti.received_qty,
     'difference', ti.difference) ORDER BY p.name, ti.variant_size)
     FROM transfer_items ti
     JOIN products p ON p.id = ti.product_id
     LEFT JOIN product_variants v ON v.product_id = ti.product_id AND v.size = ti.variant_size
     WHERE ti.transfer_id = t.id), '[]'::json))`

// transferFrom resolves both polymorphic endpoints' names. `do2`/`dw` aliases
// avoid the reserved word `do`.
const transferFrom = `FROM transfers t
  LEFT JOIN outlets    so  ON so.id  = t.source_outlet_id
  LEFT JOIN warehouses sw  ON sw.id  = t.source_warehouse_id
  LEFT JOIN outlets    do2 ON do2.id = t.dest_outlet_id
  LEFT JOIN warehouses dw  ON dw.id  = t.dest_warehouse_id`

// Transfers lists transfers newest-first, optionally filtered by status.
func (r *Repo) Transfers(ctx context.Context, status string, page, limit int) ([]api.Transfer, int, error) {
	where := ""
	args := []any{}
	if status != "" {
		args = append(args, status)
		where = "WHERE t.status=$1"
	}
	args = append(args, limit, off(page, limit))
	sql := fmt.Sprintf(`SELECT %s, count(*) OVER() AS total %s %s
	  ORDER BY t.created_at DESC LIMIT $%d OFFSET $%d`,
		transferObj, transferFrom, where, len(args)-1, len(args))
	return listJSON[api.Transfer](ctx, r.Pool, sql, args...)
}

// Transfer returns one transfer with its items.
func (r *Repo) Transfer(ctx context.Context, id string) (api.Transfer, error) {
	return oneJSON[api.Transfer](ctx, r.Pool,
		`SELECT `+transferObj+` `+transferFrom+` WHERE t.id=$1`, id)
}

// LocationStock returns on-hand rows for a polymorphic location, so the
// create-transfer UI can show the source's live stock. Warehouse reuses the
// existing matrix; outlet reads outlet_variant_stock.
func (r *Repo) LocationStock(ctx context.Context, kind, id string) ([]api.WarehouseStockRow, error) {
	if kind == "warehouse" {
		return r.WarehouseStock(ctx, id)
	}
	rows, _, err := listJSON[api.WarehouseStockRow](ctx, r.Pool, `
		SELECT json_build_object(
		  'productId', v.product_id, 'productName', p.name, 'variantSize', v.size,
		  'sku', v.sku,
		  'stock', COALESCE((SELECT s.stock FROM outlet_variant_stock s
		     WHERE s.outlet_id=$1 AND s.product_id=v.product_id AND s.variant_size=v.size),0))
		FROM product_variants v JOIN products p ON p.id=v.product_id
		ORDER BY p.name, v.size`, id)
	return rows, err
}
```

- [ ] **Step 2: Build**

Run: `cd backend && go build ./...`
Expected: builds (uses generated `api.Transfer`, `api.WarehouseStockRow`). If `api.Transfer` is undefined, Task 2 codegen did not run — re-run `make gen-go`.

- [ ] **Step 3: Commit**

```bash
git add backend/internal/read/repo.go
git commit -m "feat(inventory): SP2 read layer — transfers list/detail + polymorphic location-stock"
```

---

## Phase B — Write lifecycle, handlers, routes, live verify

### Task 5: Write repo — types, shared helpers, create + edit draft

**Files:**
- Create: `backend/internal/write/transfer.go`

- [ ] **Step 1: Write the file (types, helpers, create, edit-draft)**

```go
package write

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

type TransferItemInput struct {
	ProductID   string `json:"productId"`
	VariantSize string `json:"variantSize"`
	Qty         int    `json:"qty"`
}

type TransferCreate struct {
	Source TransferLoc         `json:"source"`
	Dest   TransferLoc         `json:"dest"`
	Note   string              `json:"note"`
	Items  []TransferItemInput `json:"items"`
}

type TransferReceiveItem struct {
	ProductID   string `json:"productId"`
	VariantSize string `json:"variantSize"`
	ReceivedQty int    `json:"receivedQty"`
}

type TransferReceive struct {
	Items             []TransferReceiveItem `json:"items"`
	DiscrepancyReason string                `json:"discrepancyReason"`
}

// loaded transfer row (locations are nil for the leg that is the other kind).
type transferRow struct {
	status                                          string
	srcOutlet, srcWarehouse, dstOutlet, dstWarehouse *string
}

type transferLine struct {
	pid, size string
	sent      int
}

func validateLocs(src, dst TransferLoc) error {
	if !validLocKind(src.Kind) || src.ID == "" {
		return fmt.Errorf("sumber tidak valid")
	}
	if !validLocKind(dst.Kind) || dst.ID == "" {
		return fmt.Errorf("tujuan tidak valid")
	}
	if sameLoc(src, dst) {
		return fmt.Errorf("sumber dan tujuan tidak boleh sama")
	}
	return nil
}

// locCols returns ("", id) for a warehouse and (id, "") for an outlet, ready for
// nullUUID() into the (outlet_id, warehouse_id) column pair.
func locCols(loc TransferLoc) (outletID, warehouseID string) {
	if loc.Kind == "outlet" {
		return loc.ID, ""
	}
	return "", loc.ID
}

func validateItems(items []TransferItemInput) error {
	if len(items) == 0 {
		return fmt.Errorf("minimal satu item")
	}
	for _, it := range items {
		if it.Qty <= 0 {
			return fmt.Errorf("qty harus lebih dari 0")
		}
	}
	return nil
}

func insertTransferItems(ctx context.Context, tx pgx.Tx, id string, items []TransferItemInput) error {
	for _, it := range items {
		if _, e := tx.Exec(ctx,
			`INSERT INTO transfer_items (transfer_id, product_id, variant_size, sent_qty)
			 VALUES ($1,$2,$3,$4)`, id, it.ProductID, it.VariantSize, it.Qty); e != nil {
			return e
		}
	}
	return nil
}

func loadTransfer(ctx context.Context, q pgx.Tx, id string) (transferRow, error) {
	var t transferRow
	e := q.QueryRow(ctx,
		`SELECT status, source_outlet_id, source_warehouse_id, dest_outlet_id, dest_warehouse_id
		   FROM transfers WHERE id=$1`, id).Scan(
		&t.status, &t.srcOutlet, &t.srcWarehouse, &t.dstOutlet, &t.dstWarehouse)
	if errors.Is(e, pgx.ErrNoRows) {
		return t, ErrNotFound
	}
	return t, e
}

func transferLines(ctx context.Context, q pgx.Tx, id string) ([]transferLine, error) {
	rows, e := q.Query(ctx,
		`SELECT product_id, variant_size, sent_qty FROM transfer_items WHERE transfer_id=$1`, id)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	var out []transferLine
	for rows.Next() {
		var l transferLine
		if e := rows.Scan(&l.pid, &l.size, &l.sent); e != nil {
			return nil, e
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

// addStockDelta applies a signed delta to the right stock table for one leg.
// Exactly one of outletID/warehouseID is non-nil. The column list mirrors
// stockcount.go so par_level/available keep their defaults.
func addStockDelta(ctx context.Context, q pgx.Tx, outletID, warehouseID *string, productID, size string, delta int) error {
	if outletID != nil {
		_, e := q.Exec(ctx,
			`INSERT INTO outlet_variant_stock (outlet_id, product_id, variant_size, stock)
			 VALUES ($1,$2,$3,$4)
			 ON CONFLICT (outlet_id, product_id, variant_size)
			   DO UPDATE SET stock = outlet_variant_stock.stock + EXCLUDED.stock`,
			*outletID, productID, size, delta)
		return e
	}
	_, e := q.Exec(ctx,
		`INSERT INTO warehouse_variant_stock (warehouse_id, product_id, variant_size, stock)
		 VALUES ($1,$2,$3,$4)
		 ON CONFLICT (warehouse_id, product_id, variant_size)
		   DO UPDATE SET stock = warehouse_variant_stock.stock + EXCLUDED.stock`,
		*warehouseID, productID, size, delta)
	return e
}

// currentStock reads on-hand for one leg (0 when no row yet).
func currentStock(ctx context.Context, q pgx.Tx, outletID, warehouseID *string, productID, size string) (int, error) {
	var n int
	var e error
	if outletID != nil {
		e = q.QueryRow(ctx,
			`SELECT COALESCE(stock,0) FROM outlet_variant_stock
			  WHERE outlet_id=$1 AND product_id=$2 AND variant_size=$3`,
			*outletID, productID, size).Scan(&n)
	} else {
		e = q.QueryRow(ctx,
			`SELECT COALESCE(stock,0) FROM warehouse_variant_stock
			  WHERE warehouse_id=$1 AND product_id=$2 AND variant_size=$3`,
			*warehouseID, productID, size).Scan(&n)
	}
	if errors.Is(e, pgx.ErrNoRows) {
		return 0, nil
	}
	return n, e
}

// CreateTransfer records a draft (no stock movement, no version bump).
func (r *Repo) CreateTransfer(ctx context.Context, createdBy string, t TransferCreate) (string, error) {
	if e := validateLocs(t.Source, t.Dest); e != nil {
		return "", e
	}
	if e := validateItems(t.Items); e != nil {
		return "", e
	}
	so, sw := locCols(t.Source)
	do, dw := locCols(t.Dest)
	var id string
	err := r.noBumpTx(ctx, func(tx pgx.Tx) error {
		if e := tx.QueryRow(ctx,
			`INSERT INTO transfers (status, source_outlet_id, source_warehouse_id,
			   dest_outlet_id, dest_warehouse_id, note, created_by)
			 VALUES ('draft',$1,$2,$3,$4,$5,$6) RETURNING id`,
			nullUUID(so), nullUUID(sw), nullUUID(do), nullUUID(dw),
			nullStr(t.Note), nullUUID(createdBy)).Scan(&id); e != nil {
			return e
		}
		return insertTransferItems(ctx, tx, id, t.Items)
	})
	return id, err
}

// UpdateTransferDraft replaces a draft's note + items. Source/dest are fixed at
// create and ignored here. Only drafts are editable.
func (r *Repo) UpdateTransferDraft(ctx context.Context, id string, t TransferCreate) error {
	if e := validateItems(t.Items); e != nil {
		return e
	}
	return r.noBumpTx(ctx, func(tx pgx.Tx) error {
		var status string
		e := tx.QueryRow(ctx, `SELECT status FROM transfers WHERE id=$1`, id).Scan(&status)
		if errors.Is(e, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if e != nil {
			return e
		}
		if status != "draft" {
			return fmt.Errorf("hanya draft yang bisa diubah")
		}
		if _, e := tx.Exec(ctx, `UPDATE transfers SET note=$1 WHERE id=$2`, nullStr(t.Note), id); e != nil {
			return e
		}
		if _, e := tx.Exec(ctx, `DELETE FROM transfer_items WHERE transfer_id=$1`, id); e != nil {
			return e
		}
		return insertTransferItems(ctx, tx, id, t.Items)
	})
}
```

- [ ] **Step 2: Build + run write tests**

Run: `cd backend && gofmt -w internal/ && go build ./... && go test ./internal/write/ -v`
Expected: builds; Task 3 tests still PASS.

- [ ] **Step 3: Commit**

```bash
git add backend/internal/write/transfer.go
git commit -m "feat(inventory): SP2 write — transfer types, shared stock helpers, create + edit draft"
```

---

### Task 6: Write repo — `SendTransfer`

**Files:**
- Modify: `backend/internal/write/transfer.go` (append)

- [ ] **Step 1: Append `SendTransfer`**

```go
// SendTransfer deducts each line from the source (guarding against oversend),
// marks the transfer in_transit, and bumps the source outlet leg if any.
func (r *Repo) SendTransfer(ctx context.Context, id string) error {
	tx, err := r.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	t, e := loadTransfer(ctx, tx, id)
	if e != nil {
		return e
	}
	if _, e := transferTransition(t.status, "send"); e != nil {
		return e
	}
	lines, e := transferLines(ctx, tx, id)
	if e != nil {
		return e
	}
	for _, l := range lines {
		have, e := currentStock(ctx, tx, t.srcOutlet, t.srcWarehouse, l.pid, l.size)
		if e != nil {
			return e
		}
		if have < l.sent {
			return fmt.Errorf("stok tidak cukup untuk dikirim")
		}
		if e := addStockDelta(ctx, tx, t.srcOutlet, t.srcWarehouse, l.pid, l.size, -l.sent); e != nil {
			return e
		}
	}
	if _, e := tx.Exec(ctx,
		`UPDATE transfers SET status='in_transit', sent_at=now() WHERE id=$1`, id); e != nil {
		return e
	}
	if t.srcOutlet != nil {
		if e := bumpVersionOutlets(ctx, tx, "products", []string{*t.srcOutlet}); e != nil {
			return e
		}
	}
	return tx.Commit(ctx)
}
```

- [ ] **Step 2: Build**

Run: `cd backend && gofmt -w internal/ && go build ./...`
Expected: builds.

- [ ] **Step 3: Commit**

```bash
git add backend/internal/write/transfer.go
git commit -m "feat(inventory): SP2 write — SendTransfer (deduct source, guard oversend, bump outlet leg)"
```

---

### Task 7: Write repo — `ReceiveTransfer`

**Files:**
- Modify: `backend/internal/write/transfer.go` (append)

- [ ] **Step 1: Append `ReceiveTransfer`** (validate reason BEFORE mutating, so a missing reason rejects cleanly)

```go
// ReceiveTransfer credits the dest with the ACTUAL received qty per line, records
// each line's difference (received - sent), requires a discrepancy reason when
// any line differs, completes the transfer, and bumps the dest outlet leg if any.
func (r *Repo) ReceiveTransfer(ctx context.Context, id string, rcv TransferReceive) error {
	tx, err := r.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	t, e := loadTransfer(ctx, tx, id)
	if e != nil {
		return e
	}
	if _, e := transferTransition(t.status, "receive"); e != nil {
		return e
	}
	lines, e := transferLines(ctx, tx, id)
	if e != nil {
		return e
	}

	// Index supplied received quantities; a line not supplied defaults to its
	// sent qty (received in full, no discrepancy).
	recv := map[string]int{}
	for _, it := range rcv.Items {
		if it.ReceivedQty < 0 {
			return fmt.Errorf("jumlah terima tidak boleh negatif")
		}
		recv[it.ProductID+"|"+it.VariantSize] = it.ReceivedQty
	}
	type resolved struct {
		l   transferLine
		got int
	}
	res := make([]resolved, 0, len(lines))
	anyDiff := false
	for _, l := range lines {
		got, ok := recv[l.pid+"|"+l.size]
		if !ok {
			got = l.sent
		}
		if got != l.sent {
			anyDiff = true
		}
		res = append(res, resolved{l, got})
	}
	if anyDiff && rcv.DiscrepancyReason == "" {
		return fmt.Errorf("alasan selisih wajib diisi")
	}

	for _, rr := range res {
		if e := addStockDelta(ctx, tx, t.dstOutlet, t.dstWarehouse, rr.l.pid, rr.l.size, rr.got); e != nil {
			return e
		}
		if _, e := tx.Exec(ctx,
			`UPDATE transfer_items SET received_qty=$1, difference=$2
			   WHERE transfer_id=$3 AND product_id=$4 AND variant_size=$5`,
			rr.got, transferDiff(rr.l.sent, rr.got), id, rr.l.pid, rr.l.size); e != nil {
			return e
		}
	}
	if _, e := tx.Exec(ctx,
		`UPDATE transfers SET status='completed', received_at=now(), discrepancy_reason=$1 WHERE id=$2`,
		nullStr(rcv.DiscrepancyReason), id); e != nil {
		return e
	}
	if t.dstOutlet != nil {
		if e := bumpVersionOutlets(ctx, tx, "products", []string{*t.dstOutlet}); e != nil {
			return e
		}
	}
	return tx.Commit(ctx)
}
```

- [ ] **Step 2: Build**

Run: `cd backend && gofmt -w internal/ && go build ./...`
Expected: builds.

- [ ] **Step 3: Commit**

```bash
git add backend/internal/write/transfer.go
git commit -m "feat(inventory): SP2 write — ReceiveTransfer (credit actual, record discrepancy, bump dest leg)"
```

---

### Task 8: Write repo — `CancelTransfer`

**Files:**
- Modify: `backend/internal/write/transfer.go` (append)

- [ ] **Step 1: Append `CancelTransfer`**

```go
// CancelTransfer voids a draft (no stock effect) or reverses an in_transit
// transfer (restore each line's sent qty to the source, bump source outlet leg).
func (r *Repo) CancelTransfer(ctx context.Context, id string) error {
	tx, err := r.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	t, e := loadTransfer(ctx, tx, id)
	if e != nil {
		return e
	}
	if _, e := transferTransition(t.status, "cancel"); e != nil {
		return e
	}
	if t.status == "in_transit" {
		lines, e := transferLines(ctx, tx, id)
		if e != nil {
			return e
		}
		for _, l := range lines {
			if e := addStockDelta(ctx, tx, t.srcOutlet, t.srcWarehouse, l.pid, l.size, l.sent); e != nil {
				return e
			}
		}
		if t.srcOutlet != nil {
			if e := bumpVersionOutlets(ctx, tx, "products", []string{*t.srcOutlet}); e != nil {
				return e
			}
		}
	}
	if _, e := tx.Exec(ctx,
		`UPDATE transfers SET status='cancelled', cancelled_at=now() WHERE id=$1`, id); e != nil {
		return e
	}
	return tx.Commit(ctx)
}
```

- [ ] **Step 2: Build + full write tests**

Run: `cd backend && gofmt -w internal/ && go build ./... && go test ./internal/write/ -v`
Expected: builds; tests PASS.

- [ ] **Step 3: Commit**

```bash
git add backend/internal/write/transfer.go
git commit -m "feat(inventory): SP2 write — CancelTransfer (draft void / in-transit restore source)"
```

---

### Task 9: Handlers + routes

**Files:**
- Modify: `backend/internal/handlers/writes.go` (add a "Transfers" section, e.g. after the `AdjustWarehouseStock` handler ~line 267)
- Modify: `backend/internal/server/server.go` (add to the `manage_inventory` group ~lines 168–175)

- [ ] **Step 1: Add handlers** (in `writes.go`)

```go
// ── Transfers (Backoffice; mesh warehouse/outlet) ─────────

func (h *Handlers) Transfers(w http.ResponseWriter, r *http.Request) {
	p, l := pageLimit(r)
	rows, total, err := h.Repo.Transfers(r.Context(), r.URL.Query().Get("status"), p, l)
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, http.StatusOK, api.TransferListResponse{Data: rows, Meta: meta(total, p, l)})
}

func (h *Handlers) Transfer(w http.ResponseWriter, r *http.Request) {
	v, err := h.Repo.Transfer(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, 0, err) // writeErr maps read.ErrNotFound → 404
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": v})
}

func (h *Handlers) TransferLocationStock(w http.ResponseWriter, r *http.Request) {
	rows, err := h.Repo.LocationStock(r.Context(),
		r.URL.Query().Get("kind"), r.URL.Query().Get("id"))
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": rows})
}

func (h *Handlers) CreateTransfer(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeWrite[write.TransferCreate](w, r)
	if !ok {
		return
	}
	c, _ := h.caller(r)
	id, err := h.Write.CreateTransfer(r.Context(), c.userID, body)
	h.created(w, r, id, err)
}

func (h *Handlers) UpdateTransfer(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeWrite[write.TransferCreate](w, r)
	if !ok {
		return
	}
	h.mutated(w, r, h.Write.UpdateTransferDraft(r.Context(), chi.URLParam(r, "id"), body))
}

func (h *Handlers) SendTransfer(w http.ResponseWriter, r *http.Request) {
	h.mutated(w, r, h.Write.SendTransfer(r.Context(), chi.URLParam(r, "id")))
}

func (h *Handlers) ReceiveTransfer(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeWrite[write.TransferReceive](w, r)
	if !ok {
		return
	}
	h.mutated(w, r, h.Write.ReceiveTransfer(r.Context(), chi.URLParam(r, "id"), body))
}

func (h *Handlers) CancelTransfer(w http.ResponseWriter, r *http.Request) {
	h.mutated(w, r, h.Write.CancelTransfer(r.Context(), chi.URLParam(r, "id")))
}
```

- [ ] **Step 2: Add routes** (in `server.go`, inside the existing `manage_inventory` group — append after `r.Post("/warehouses/{id}/adjust", h.AdjustWarehouseStock)`)

```go
				// transfers (mesh; static path registered before /{id})
				r.Get("/transfers", h.Transfers)
				r.Get("/transfers/location-stock", h.TransferLocationStock)
				r.Get("/transfers/{id}", h.Transfer)
				r.Post("/transfers", h.CreateTransfer)
				r.Put("/transfers/{id}", h.UpdateTransfer)
				r.Post("/transfers/{id}/send", h.SendTransfer)
				r.Post("/transfers/{id}/receive", h.ReceiveTransfer)
				r.Post("/transfers/{id}/cancel", h.CancelTransfer)
```

- [ ] **Step 3: Build + vet + drift gate**

Run: `cd backend && gofmt -w internal/ && go build ./... && go vet ./... && make gen-check`
Expected: builds, vet clean, no drift.

- [ ] **Step 4: Commit**

```bash
git add backend/internal/handlers/writes.go backend/internal/server/server.go
git commit -m "feat(inventory): SP2 handlers + routes — transfers CRUD/send/receive/cancel (manage_inventory)"
```

---

### Task 10: Deploy + live end-to-end verification

**Files:**
- Create (throwaway, do NOT commit): `backend/verify_transfer.py`

- [ ] **Step 1: Deploy backend (applies migration 0016)**

Run (Bash, `dangerouslyDisableSandbox: true`, background; ~4–6 min):
`gcloud run deploy mandalika-pos --source backend --region asia-southeast2 --quiet`
Then poll: `curl -s https://mandalika-pos-538849926142.asia-southeast2.run.app/readyz`
Expected: `/readyz` returns OK (200). If the boot log shows a migration error on 0016, STOP and fix the SQL (rule 4: verify on failure).

- [ ] **Step 2: Write the verify script**

```python
# backend/verify_transfer.py — throwaway SP2 live check. Do NOT commit.
import json, os, urllib.request, urllib.error

BASE = "https://mandalika-pos-538849926142.asia-southeast2.run.app"
EMAIL = os.environ.get("ADMIN_EMAIL", "admin@mandalika.test")
PWD = os.environ["ADMIN_PASSWORD"]  # export from: gcloud secrets versions access latest --secret=SEED_ADMIN_PASSWORD

def call(method, path, token=None, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read() or "{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or "{}")

st, res = call("POST", "/api/v1/auth/login", body={"email": EMAIL, "password": PWD})
assert st == 200, ("login", st, res)
tok = res["data"]["access"]

# Pick a product variant that exists in the catalog.
st, res = call("GET", "/api/v1/products?page=1&limit=1", tok)
assert st == 200 and res["data"], ("products", st, res)
prod = res["data"][0]
pid = prod["id"]
size = prod["variants"][0]["variantSize"] if "variantSize" in prod["variants"][0] else prod["variants"][0]["size"]
print("using product", pid, "size", size)

# Two fresh warehouses for a clean wh→wh flow.
def mkwh(name):
    st, res = call("POST", "/api/v1/warehouses", tok, {"name": name, "isActive": True})
    assert st == 201, ("mkwh", st, res)
    return res["data"]["id"]
src = mkwh("SP2 Verify Src")
dst = mkwh("SP2 Verify Dst")

# Seed source via goods-in: +20.
st, res = call("POST", f"/api/v1/warehouses/{src}/goods-receipt", tok,
               {"items": [{"productId": pid, "variantSize": size, "qty": 20}]})
assert st == 200, ("goods-in", st, res)

def stock(wh):
    st, res = call("GET", f"/api/v1/warehouses/{wh}/stock", tok)
    assert st == 200, res
    for row in res["data"]:
        if row["productId"] == pid and row["variantSize"] == size:
            return row["stock"]
    return 0

assert stock(src) == 20, stock(src)

# Create draft wh(src) → wh(dst), qty 8.
st, res = call("POST", "/api/v1/transfers", tok, {
    "source": {"kind": "warehouse", "id": src},
    "dest": {"kind": "warehouse", "id": dst},
    "items": [{"productId": pid, "variantSize": size, "qty": 8}],
})
assert st == 201, ("create", st, res)
tid = res["data"]["id"]

# Send → source 20-8=12, dest still 0 (in transit).
st, res = call("POST", f"/api/v1/transfers/{tid}/send", tok)
assert st == 200, ("send", st, res)
assert stock(src) == 12, ("src after send", stock(src))
assert stock(dst) == 0, ("dst after send", stock(dst))

# Receive 6 (discrepancy) WITHOUT reason → must 400.
st, res = call("POST", f"/api/v1/transfers/{tid}/receive", tok,
               {"items": [{"productId": pid, "variantSize": size, "receivedQty": 6}]})
assert st == 400, ("receive-no-reason should 400", st, res)

# Receive 6 WITH reason → dest 0+6=6, source unchanged (12). Discrepancy -2 recorded.
st, res = call("POST", f"/api/v1/transfers/{tid}/receive", tok,
               {"items": [{"productId": pid, "variantSize": size, "receivedQty": 6}],
                "discrepancyReason": "2 unit rusak di perjalanan"})
assert st == 200, ("receive", st, res)
assert stock(dst) == 6, ("dst after receive", stock(dst))
assert stock(src) == 12, ("src after receive", stock(src))

st, res = call("GET", f"/api/v1/transfers/{tid}", tok)
assert res["data"]["status"] == "completed", res["data"]["status"]
assert res["data"]["items"][0]["difference"] == -2, res["data"]["items"][0]

# Cancel-in-transit restores source: new transfer qty 5, send, cancel → src back to 12.
st, res = call("POST", "/api/v1/transfers", tok, {
    "source": {"kind": "warehouse", "id": src},
    "dest": {"kind": "warehouse", "id": dst},
    "items": [{"productId": pid, "variantSize": size, "qty": 5}],
})
tid2 = res["data"]["id"]
call("POST", f"/api/v1/transfers/{tid2}/send", tok)
assert stock(src) == 7, ("src after 2nd send", stock(src))
st, res = call("POST", f"/api/v1/transfers/{tid2}/cancel", tok)
assert st == 200, ("cancel", st, res)
assert stock(src) == 12, ("src after cancel restore", stock(src))

# Oversend guard: qty 999 → send must 400.
st, res = call("POST", "/api/v1/transfers", tok, {
    "source": {"kind": "warehouse", "id": src},
    "dest": {"kind": "warehouse", "id": dst},
    "items": [{"productId": pid, "variantSize": size, "qty": 999}],
})
tid3 = res["data"]["id"]
st, res = call("POST", f"/api/v1/transfers/{tid3}/send", tok)
assert st == 400, ("oversend should 400", st, res)
call("POST", f"/api/v1/transfers/{tid3}/cancel", tok)  # cleanup draft

# Self-transfer rejected at create.
st, res = call("POST", "/api/v1/transfers", tok, {
    "source": {"kind": "warehouse", "id": src},
    "dest": {"kind": "warehouse", "id": src},
    "items": [{"productId": pid, "variantSize": size, "qty": 1}],
})
assert st == 400, ("self-transfer should 400", st, res)

print("SP2 VERIFY OK")
```

- [ ] **Step 3: Run the verify script**

Run (Bash): `cd backend && ADMIN_PASSWORD="$(gcloud secrets versions access latest --secret=SEED_ADMIN_PASSWORD)" python verify_transfer.py`
Expected: prints `SP2 VERIFY OK`. If any assert fails, STOP and fix the implicated method (rule 4). If product JSON field is `size` vs `variantSize`, the script already handles both; if login 401s, retry with `ADMIN_EMAIL=admin@mandalika.local`.

- [ ] **Step 4: Outlet-leg `content_version` bump check (manual)**

The wh→wh flow above never bumps (correct — no outlet leg). Confirm an outlet leg DOES bump by checking `content_versions` for an outlet after an outlet-destination receive. Add to the script (optional) OR verify in SP3 when the POS consumes it. Minimum here: in `psql`/Neon console run before & after an `outlet`-dest receive:
`SELECT outlet_id, version FROM content_versions ORDER BY updated_at DESC LIMIT 5;`
Expected: the destination outlet's `version` increments after receive; warehouse-only transfers leave all rows unchanged. (Flag as a gap if you cannot reach a DB console — note it for the user.)

- [ ] **Step 5: Clean up + commit nothing for the throwaway**

Run: `rm backend/verify_transfer.py`
(The script is throwaway — do not commit it. No commit in this task; the deploy is the artifact.)

---

## Phase C — TypeScript client

### Task 11: `@mandalika/api` client methods + types

**Files:**
- Modify: `packages/api/src/client.ts` (type exports ~line 29 after `WarehouseStockRow`; `Api` interface methods ~line 160 after `adjustWarehouseStock`; implementation ~line 365 after `adjustWarehouseStock`)

- [ ] **Step 1: Add type exports** (after `export type WarehouseStockRow = S['WarehouseStockRow']`)

```ts
export type Transfer = S['Transfer']
export type TransferItem = S['TransferItem']
export type TransferLocation = S['TransferLocation']
export type TransferCreateInput = S['TransferCreateInput']
export type TransferReceiveInput = S['TransferReceiveInput']
```

- [ ] **Step 2: Add `Api` interface members** (after `adjustWarehouseStock: (...) => Promise<void>`)

```ts
  // transfers (SP2)
  listTransfers: (status?: string, page?: number, limit?: number) => Promise<ListResult<Transfer>>
  getTransfer: (id: string) => Promise<Transfer>
  getTransferLocationStock: (kind: string, id: string) => Promise<WarehouseStockRow[]>
  createTransfer: (input: TransferCreateInput) => Promise<{ id: string }>
  updateTransfer: (id: string, input: TransferCreateInput) => Promise<void>
  sendTransfer: (id: string) => Promise<void>
  receiveTransfer: (id: string, input: TransferReceiveInput) => Promise<void>
  cancelTransfer: (id: string) => Promise<void>
```

- [ ] **Step 3: Add implementations** (in the returned object, after the `adjustWarehouseStock` impl)

```ts
    listTransfers: (status, page = 1, limit = 50) =>
      list<Transfer>(`${API}/transfers`, { ...(status ? { status } : {}), page, limit }),
    getTransfer: (id) => data<Transfer>('GET', `${API}/transfers/${id}`),
    getTransferLocationStock: (kind, id) =>
      data<WarehouseStockRow[]>('GET', `${API}/transfers/location-stock?kind=${kind}&id=${id}`),
    createTransfer: (input) => data<{ id: string }>('POST', `${API}/transfers`, input),
    updateTransfer: async (id, input) => {
      await request('PUT', `${API}/transfers/${id}`, input)
    },
    sendTransfer: async (id) => {
      await request('POST', `${API}/transfers/${id}/send`)
    },
    receiveTransfer: async (id, input) => {
      await request('POST', `${API}/transfers/${id}/receive`, input)
    },
    cancelTransfer: async (id) => {
      await request('POST', `${API}/transfers/${id}/cancel`)
    },
```

- [ ] **Step 4: Typecheck the package**

Run: `pnpm --filter @mandalika/api exec tsc --noEmit`
Expected: no type errors. (If `ListResult` is unresolved, confirm its name in `client.ts` — it is the return type of the existing `list<T>` helper.)

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/client.ts
git commit -m "feat(api): SP2 transfer client methods + types"
```

---

## Phase D — Backoffice UI (Gudang → Transfer tab)

> All UI reuses `apps/backoffice/src/ui/` primitives, gold tokens, semantic-only colors. Status → tone: `draft`=neutral, `in_transit`=warning, `completed`=success, `cancelled`=neutral. Status → label (id): Draf / Dikirim / Selesai / Dibatalkan.

### Task 12: `TransferForm` (create / edit draft)

**Files:**
- Create: `apps/backoffice/src/screens/transfers/TransferForm.tsx`

- [ ] **Step 1: Write the form component**

```tsx
import { useEffect, useMemo, useState } from 'react'
import type {
  Outlet,
  Warehouse,
  WarehouseStockRow,
  TransferCreateInput,
} from '@mandalika/api'
import { ArrowLeft, Save } from 'lucide-react'
import { api } from '../../api'
import { Button, Card, Select, Textarea, PageHeader, fieldClass } from '../../ui'

type LocKind = 'outlet' | 'warehouse'
interface LocPick {
  kind: LocKind
  id: string
}
const lineKey = (productId: string, variantSize: string) => `${productId}|${variantSize}`

interface TransferFormProps {
  outlets: Outlet[]
  warehouses: Warehouse[]
  onCancel: () => void
  /** Called with the new transfer id after a successful create. */
  onCreated: (id: string) => void
}

/** Create a draft transfer: pick source + dest (mesh), then qty per source
 *  variant (live on-hand shown so you cannot over-send). */
export function TransferForm({ outlets, warehouses, onCancel, onCreated }: TransferFormProps) {
  const [source, setSource] = useState<LocPick | null>(null)
  const [dest, setDest] = useState<LocPick | null>(null)
  const [note, setNote] = useState('')
  const [qty, setQty] = useState<Record<string, string>>({})
  const [srcRows, setSrcRows] = useState<WarehouseStockRow[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // Options as "kind:id" so a single <select> spans both warehouses + outlets.
  const options = useMemo(
    () => [
      ...warehouses.map((w) => ({ value: `warehouse:${w.id}`, label: `Gudang · ${w.name}` })),
      ...outlets.map((o) => ({ value: `outlet:${o.id}`, label: `Outlet · ${o.name}` })),
    ],
    [warehouses, outlets],
  )

  const parse = (v: string): LocPick | null => {
    if (!v) return null
    const [kind, id] = v.split(':')
    return { kind: kind as LocKind, id }
  }

  // Load source on-hand whenever the source changes.
  useEffect(() => {
    if (!source) {
      setSrcRows([])
      return
    }
    let alive = true
    api
      .getTransferLocationStock(source.kind, source.id)
      .then((rows) => alive && setSrcRows(rows))
      .catch(() => alive && setSrcRows([]))
    return () => {
      alive = false
    }
  }, [source])

  const onHand = (r: WarehouseStockRow) => r.stock

  const submit = async () => {
    if (!source || !dest) {
      setErr('Pilih sumber dan tujuan.')
      return
    }
    if (source.kind === dest.kind && source.id === dest.id) {
      setErr('Sumber dan tujuan tidak boleh sama.')
      return
    }
    const items = srcRows
      .map((r) => {
        const n = Number(qty[lineKey(r.productId, r.variantSize)] ?? '')
        if (!n || n <= 0) return null
        return { productId: r.productId, variantSize: r.variantSize, qty: n }
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
    if (items.length === 0) {
      setErr('Isi qty minimal satu baris.')
      return
    }
    const over = items.find((it) => {
      const row = srcRows.find(
        (r) => r.productId === it.productId && r.variantSize === it.variantSize,
      )
      return row ? it.qty > row.stock : false
    })
    if (over) {
      setErr('Qty melebihi stok sumber.')
      return
    }
    setBusy(true)
    setErr(null)
    try {
      const body: TransferCreateInput = { source, dest, note: note.trim() || null, items }
      const { id } = await api.createTransfer(body)
      onCreated(id)
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Gagal membuat transfer.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Transfer Baru"
        subtitle="Pindahkan stok antar gudang / outlet"
        actions={
          <>
            <Button variant="secondary" icon={<ArrowLeft className="w-4 h-4" />} onClick={onCancel}>
              Kembali
            </Button>
            <Button icon={<Save className="w-4 h-4" />} onClick={submit} loading={busy}>
              {busy ? 'Menyimpan...' : 'Simpan Draft'}
            </Button>
          </>
        }
      />

      <Card className="p-5 space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <Select
            label="Sumber"
            value={source ? `${source.kind}:${source.id}` : ''}
            onChange={(e) => setSource(parse(e.target.value))}
          >
            <option value="">Pilih sumber…</option>
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
          <Select
            label="Tujuan"
            value={dest ? `${dest.kind}:${dest.id}` : ''}
            onChange={(e) => setDest(parse(e.target.value))}
          >
            <option value="">Pilih tujuan…</option>
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </div>
        <Textarea
          label="Catatan"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          placeholder="Opsional"
        />
      </Card>

      <Card className="p-5">
        {!source ? (
          <p className="text-sm text-gray-400">Pilih sumber untuk melihat stok.</p>
        ) : srcRows.length === 0 ? (
          <p className="text-sm text-gray-400">Tidak ada stok di sumber ini.</p>
        ) : (
          <div>
            <div className="grid grid-cols-12 gap-2 px-1 mb-2">
              <span className="col-span-5 text-[11px] font-bold text-gray-400">Produk</span>
              <span className="col-span-2 text-[11px] font-bold text-gray-400">Ukuran</span>
              <span className="col-span-2 text-[11px] font-bold text-gray-400">Stok</span>
              <span className="col-span-3 text-[11px] font-bold text-gray-400">Qty Kirim</span>
            </div>
            <div className="space-y-2 max-h-96 overflow-y-auto">
              {srcRows.map((r) => {
                const key = lineKey(r.productId, r.variantSize)
                return (
                  <div key={key} className="grid grid-cols-12 gap-2 items-center">
                    <span className="col-span-5 text-xs text-gray-600 truncate">{r.productName}</span>
                    <span className="col-span-2 text-xs text-gray-500">{r.variantSize}</span>
                    <span className="col-span-2 text-xs text-gray-500">{onHand(r)}</span>
                    <input
                      type="number"
                      min={0}
                      max={r.stock}
                      value={qty[key] ?? ''}
                      onChange={(e) => setQty((m) => ({ ...m, [key]: e.target.value }))}
                      placeholder="0"
                      className={`${fieldClass} col-span-3 py-1.5`}
                    />
                  </div>
                )
              })}
            </div>
            <p className="text-[11px] text-gray-400 mt-2">
              Hanya baris dengan qty &gt; 0 yang dikirim. Qty tidak boleh melebihi stok.
            </p>
          </div>
        )}
        {err && <p className="text-sm text-red-600 mt-3">{err}</p>}
      </Card>
    </div>
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @mandalika/backoffice exec tsc -b --noEmit`
Expected: no errors. (If `Outlet.name`/`Warehouse.name` shapes differ, fix per the generated types.)

- [ ] **Step 3: Commit**

```bash
git add apps/backoffice/src/screens/transfers/TransferForm.tsx
git commit -m "feat(backoffice): SP2 TransferForm — create draft with mesh source/dest + live on-hand"
```

---

### Task 13: `ReceiveModal` (enter actual qty + discrepancy reason)

**Files:**
- Create: `apps/backoffice/src/screens/transfers/ReceiveModal.tsx`

- [ ] **Step 1: Write the modal**

```tsx
import { useMemo, useState } from 'react'
import type { Transfer, TransferReceiveInput } from '@mandalika/api'
import { api } from '../../api'
import { Button, Modal, Textarea, fieldClass } from '../../ui'

const lineKey = (productId: string, variantSize: string) => `${productId}|${variantSize}`

interface ReceiveModalProps {
  transfer: Transfer
  onClose: () => void
  onDone: () => void | Promise<void>
}

/** Receive an in-transit transfer: actual qty per line (defaults to sent). A
 *  discrepancy reason becomes required once any line differs from its sent qty. */
export function ReceiveModal({ transfer, onClose, onDone }: ReceiveModalProps) {
  const [actual, setActual] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      transfer.items.map((it) => [lineKey(it.productId, it.variantSize), String(it.sentQty)]),
    ),
  )
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const anyDiff = useMemo(
    () =>
      transfer.items.some((it) => {
        const v = actual[lineKey(it.productId, it.variantSize)]
        return Number(v ?? it.sentQty) !== it.sentQty
      }),
    [actual, transfer.items],
  )

  const submit = async () => {
    if (anyDiff && !reason.trim()) {
      setErr('Alasan selisih wajib diisi.')
      return
    }
    const items = transfer.items.map((it) => {
      const v = actual[lineKey(it.productId, it.variantSize)]
      const n = Number(v ?? it.sentQty)
      return {
        productId: it.productId,
        variantSize: it.variantSize,
        receivedQty: Number.isFinite(n) && n >= 0 ? n : 0,
      }
    })
    setBusy(true)
    setErr(null)
    try {
      const body: TransferReceiveInput = {
        items,
        discrepancyReason: reason.trim() || null,
      }
      await api.receiveTransfer(transfer.id, body)
      onClose()
      await onDone()
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Gagal menerima transfer.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      title="Terima Transfer"
      subtitle={`${transfer.transferNo} · ${transfer.source.name} → ${transfer.dest.name}`}
      footer={
        <>
          <Button variant="secondary" className="flex-1" onClick={onClose}>
            Batal
          </Button>
          <Button className="flex-1" onClick={submit} loading={busy}>
            {busy ? 'Menyimpan...' : 'Konfirmasi Terima'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-12 gap-2 px-1">
          <span className="col-span-5 text-[11px] font-bold text-gray-400">Produk</span>
          <span className="col-span-2 text-[11px] font-bold text-gray-400">Ukuran</span>
          <span className="col-span-2 text-[11px] font-bold text-gray-400">Dikirim</span>
          <span className="col-span-3 text-[11px] font-bold text-gray-400">Diterima</span>
        </div>
        <div className="space-y-2 max-h-80 overflow-y-auto">
          {transfer.items.map((it) => {
            const key = lineKey(it.productId, it.variantSize)
            const got = Number(actual[key] ?? it.sentQty)
            const diff = got - it.sentQty
            return (
              <div key={key} className="grid grid-cols-12 gap-2 items-center">
                <span className="col-span-5 text-xs text-gray-600 truncate">{it.productName}</span>
                <span className="col-span-2 text-xs text-gray-500">{it.variantSize}</span>
                <span className="col-span-2 text-xs text-gray-500">{it.sentQty}</span>
                <div className="col-span-3 flex items-center gap-2">
                  <input
                    type="number"
                    min={0}
                    value={actual[key] ?? ''}
                    onChange={(e) => setActual((m) => ({ ...m, [key]: e.target.value }))}
                    className={`${fieldClass} py-1.5`}
                  />
                  {diff !== 0 && (
                    <span className={`text-[11px] font-bold ${diff < 0 ? 'text-red-600' : 'text-green-600'}`}>
                      {diff > 0 ? `+${diff}` : diff}
                    </span>
                  )}
                </div>
              </div>
            )
          })}
        </div>
        {anyDiff && (
          <Textarea
            label="Alasan Selisih *"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            placeholder="mis. 2 unit rusak / hilang di perjalanan"
          />
        )}
        {err && <p className="text-sm text-red-600">{err}</p>}
      </div>
    </Modal>
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @mandalika/backoffice exec tsc -b --noEmit`
Expected: no errors. (Confirm `Modal` accepts `subtitle` + `size="xl"` — it does, per `GoodsInModal` usage.)

- [ ] **Step 3: Commit**

```bash
git add apps/backoffice/src/screens/transfers/ReceiveModal.tsx
git commit -m "feat(backoffice): SP2 ReceiveModal — actual qty per line + required discrepancy reason"
```

---

### Task 14: `Transfers` surface (list + detail + send/cancel)

**Files:**
- Create: `apps/backoffice/src/screens/transfers/Transfers.tsx`

- [ ] **Step 1: Write the surface**

```tsx
import { useState } from 'react'
import type { Outlet, Transfer, Warehouse } from '@mandalika/api'
import { Plus, ArrowLeft, Send, Ban, PackageCheck } from 'lucide-react'
import { api } from '../../api'
import { usePolledQuery } from '../../hooks/usePolledQuery'
import { TableSkeleton } from '../../components/Skeleton'
import { Button, Card, Badge, EmptyState, PageHeader } from '../../ui'
import { TransferForm } from './TransferForm'
import { ReceiveModal } from './ReceiveModal'

type View = { kind: 'list' } | { kind: 'create' } | { kind: 'detail'; id: string }

const STATUS: Record<string, { label: string; tone: 'neutral' | 'warning' | 'success' }> = {
  draft: { label: 'Draf', tone: 'neutral' },
  in_transit: { label: 'Dikirim', tone: 'warning' },
  completed: { label: 'Selesai', tone: 'success' },
  cancelled: { label: 'Dibatalkan', tone: 'neutral' },
}

const fmtDate = (s?: string | null) =>
  s ? new Date(s).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'

export function Transfers() {
  const [view, setView] = useState<View>({ kind: 'list' })
  // Locations for the create form (loaded once at this level).
  const oq = usePolledQuery<Outlet[]>(() => api.listOutlets(), [])
  const wq = usePolledQuery<Warehouse[]>(() => api.listWarehouses(), [])

  if (view.kind === 'create') {
    return (
      <TransferForm
        outlets={oq.data ?? []}
        warehouses={wq.data ?? []}
        onCancel={() => setView({ kind: 'list' })}
        onCreated={(id) => setView({ kind: 'detail', id })}
      />
    )
  }
  if (view.kind === 'detail') {
    return <TransferDetail id={view.id} onBack={() => setView({ kind: 'list' })} />
  }
  return <TransferList onCreate={() => setView({ kind: 'create' })} onOpen={(id) => setView({ kind: 'detail', id })} />
}

function TransferList({ onCreate, onOpen }: { onCreate: () => void; onOpen: (id: string) => void }) {
  const q = usePolledQuery(() => api.listTransfers(), [])
  const rows = q.data?.data ?? []
  return (
    <div className="space-y-5">
      <PageHeader
        title="Transfer Stok"
        subtitle={`${rows.length} transfer`}
        actions={
          <Button onClick={onCreate} icon={<Plus className="w-4 h-4" />}>
            Transfer Baru
          </Button>
        }
      />
      <Card className="overflow-hidden">
        {q.loading ? (
          <TableSkeleton />
        ) : rows.length === 0 ? (
          <EmptyState icon={<PackageCheck />} title="Belum ada transfer" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50">
                  {['No', 'Sumber', 'Tujuan', 'Status', 'Dibuat'].map((h) => (
                    <th
                      key={h}
                      className="text-left px-5 py-3 text-xs font-black text-gray-400 uppercase tracking-wider"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {rows.map((t) => {
                  const s = STATUS[t.status] ?? STATUS.draft
                  return (
                    <tr
                      key={t.id}
                      onClick={() => onOpen(t.id)}
                      className="hover:bg-gray-50 cursor-pointer"
                    >
                      <td className="px-5 py-3 font-mono text-sm text-gray-900">{t.transferNo}</td>
                      <td className="px-5 py-3 text-sm text-gray-500">{t.source.name}</td>
                      <td className="px-5 py-3 text-sm text-gray-500">{t.dest.name}</td>
                      <td className="px-5 py-3">
                        <Badge tone={s.tone}>{s.label}</Badge>
                      </td>
                      <td className="px-5 py-3 text-sm text-gray-500">{fmtDate(t.createdAt)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}

function TransferDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const q = usePolledQuery<Transfer>(() => api.getTransfer(id), [id])
  const t = q.data
  const [receiving, setReceiving] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const act = async (fn: () => Promise<void>) => {
    setBusy(true)
    setErr(null)
    try {
      await fn()
      await q.refetch()
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Aksi gagal.')
    } finally {
      setBusy(false)
    }
  }

  if (!t) {
    return (
      <div className="space-y-5">
        <PageHeader title="Transfer" actions={<Button variant="secondary" icon={<ArrowLeft className="w-4 h-4" />} onClick={onBack}>Kembali</Button>} />
        <Card className="p-8"><TableSkeleton /></Card>
      </div>
    )
  }
  const s = STATUS[t.status] ?? STATUS.draft

  return (
    <div className="space-y-5">
      <PageHeader
        title={t.transferNo}
        subtitle={`${t.source.name} → ${t.dest.name}`}
        actions={
          <>
            <Button variant="secondary" icon={<ArrowLeft className="w-4 h-4" />} onClick={onBack}>
              Kembali
            </Button>
            {t.status === 'draft' && (
              <Button icon={<Send className="w-4 h-4" />} loading={busy} onClick={() => act(() => api.sendTransfer(t.id))}>
                Kirim
              </Button>
            )}
            {t.status === 'in_transit' && (
              <Button icon={<PackageCheck className="w-4 h-4" />} onClick={() => setReceiving(true)}>
                Terima
              </Button>
            )}
            {(t.status === 'draft' || t.status === 'in_transit') && (
              <Button variant="danger" icon={<Ban className="w-4 h-4" />} loading={busy} onClick={() => act(() => api.cancelTransfer(t.id))}>
                Batalkan
              </Button>
            )}
          </>
        }
      />

      <Card className="p-5">
        <div className="flex items-center gap-3 mb-4">
          <Badge tone={s.tone}>{s.label}</Badge>
          {t.note && <span className="text-sm text-gray-500">{t.note}</span>}
        </div>
        {t.discrepancyReason && (
          <p className="text-sm text-amber-700 mb-3">Selisih: {t.discrepancyReason}</p>
        )}
        <table className="w-full">
          <thead>
            <tr className="border-b border-gray-100 bg-gray-50">
              {['Produk', 'Ukuran', 'Dikirim', 'Diterima', 'Selisih'].map((h) => (
                <th key={h} className="text-left px-4 py-2 text-xs font-black text-gray-400 uppercase tracking-wider">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {t.items.map((it) => (
              <tr key={`${it.productId}|${it.variantSize}`}>
                <td className="px-4 py-2 text-sm font-bold text-gray-900">{it.productName}</td>
                <td className="px-4 py-2 text-sm text-gray-500">{it.variantSize}</td>
                <td className="px-4 py-2 text-sm text-gray-500">{it.sentQty}</td>
                <td className="px-4 py-2 text-sm text-gray-500">{it.receivedQty ?? '—'}</td>
                <td className="px-4 py-2 text-sm">
                  {it.difference == null ? (
                    '—'
                  ) : (
                    <span className={it.difference < 0 ? 'text-red-600' : it.difference > 0 ? 'text-green-600' : 'text-gray-400'}>
                      {it.difference > 0 ? `+${it.difference}` : it.difference}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {err && <p className="text-sm text-red-600 mt-3">{err}</p>}
      </Card>

      {receiving && (
        <ReceiveModal
          transfer={t}
          onClose={() => setReceiving(false)}
          onDone={() => q.refetch()}
        />
      )}
    </div>
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @mandalika/backoffice exec tsc -b --noEmit`
Expected: no errors. (`api.listTransfers()` returns `ListResult<Transfer>` → use `.data`. `Button` supports `variant="danger"`, `loading`, `icon` — per existing usage.)

- [ ] **Step 3: Commit**

```bash
git add apps/backoffice/src/screens/transfers/Transfers.tsx
git commit -m "feat(backoffice): SP2 Transfers surface — list + detail + send/cancel/receive"
```

---

### Task 15: Wire the Gudang Tabs shell + ship

**Files:**
- Modify: `apps/backoffice/src/screens/Warehouses.tsx`

- [ ] **Step 1: Add imports** (extend the existing `../ui` import to include `Tabs`, and import `Transfers`)

In the `import { ... } from '../ui'` block, add `Tabs`. After the `AdjustModal` import line, add:

```tsx
import { Transfers } from './transfers/Transfers'
```

And ensure `Tabs` is in the ui import list:

```tsx
import {
  Button,
  Card,
  Badge,
  Modal,
  Input,
  Textarea,
  IconButton,
  EmptyState,
  PageHeader,
  Tabs,
  fieldClass,
} from '../ui'
```

- [ ] **Step 2: Rename the current default export to `WarehouseList`**

Change the line `export default function Warehouses() {` to:

```tsx
function WarehouseList() {
```

(Leave the entire body unchanged — including the `if (selected) return <StockView .../>` branch.)

- [ ] **Step 3: Add the tabbed default export** (insert directly above the `function WarehouseList()` line, or at the bottom of the file — place it above `WarehouseList`)

```tsx
const GUDANG_TABS = [
  { id: 'gudang', label: 'Gudang' },
  { id: 'transfer', label: 'Transfer' },
] as const
type GudangTab = (typeof GUDANG_TABS)[number]['id']

export default function Gudang() {
  const [tab, setTab] = useState<GudangTab>('gudang')
  return (
    <div>
      <div className="px-6 pt-6">
        <Tabs value={tab} onChange={setTab} tabs={GUDANG_TABS} />
      </div>
      {tab === 'gudang' ? (
        <WarehouseList />
      ) : (
        <div className="px-6 pb-6 pt-2">
          <Transfers />
        </div>
      )}
    </div>
  )
}
```

(`App.tsx` imports the default export as `Warehouses` — the default is now `Gudang`, which is fine; no `App.tsx` change needed.)

- [ ] **Step 4: Typecheck + full build**

Run: `pnpm --filter @mandalika/backoffice exec tsc -b --noEmit && pnpm --filter @mandalika/backoffice build`
Expected: typecheck clean; Vite build succeeds.

- [ ] **Step 5: Commit + push (auto-deploys backoffice)**

```bash
git add apps/backoffice/src/screens/Warehouses.tsx
git commit -m "feat(backoffice): SP2 Gudang tabs — Gudang | Transfer surface"
```
Then: `git push`

- [ ] **Step 6: Backoffice smoke (live, after Cloudflare deploys)**

On `https://mandalika-pos.pages.dev` (admin login): open **Gudang → Transfer** tab → create a transfer (warehouse → outlet) → on detail, **Kirim** → confirm status `Dikirim` → **Terima** with one line short + reason → confirm `Selesai`, the difference shows red, and the destination outlet's stock rose by the actual received qty (check Produk → that outlet). Create another, **Kirim**, then **Batalkan** → confirm source stock restored. Report results to the user (rule 5/6); note anything not verifiable.

---

## Self-review notes (author)

- **Spec coverage:** mesh polymorphic source/dest (Tasks 1,5 + read 4), draft→send→receive→discrepancy→completed (Tasks 5–7), cancel draft + in-transit-restore (Task 8), per-outlet-leg `content_version` bump (Tasks 6–8 via `bumpVersionOutlets`, verified Task 10 step 4), `manage_inventory` gate (Task 9), `{kind,id}` wire shape (Tasks 2,5,12), one transfer-level discrepancy reason (Tasks 7,13), Transfer tab in Gudang (Task 15), live verification matrix (Task 10) — all covered.
- **Out of scope kept out:** no PIN/POS receive (SP3), no documents/print/WhatsApp (SP4), no valuation, no stock-movement ledger.
- **Type consistency:** Go `TransferLoc`/`TransferCreate`/`TransferReceive` ↔ OpenAPI `TransferLocationInput`/`TransferCreateInput`/`TransferReceiveInput` ↔ TS `TransferCreateInput`/`TransferReceiveInput`; read JSON keys (`transferNo`,`sentQty`,`receivedQty`,`difference`,`source.name`,`dest.name`) match the `Transfer`/`TransferItem`/`TransferLocation` schema; handler method names match `server.go` route registrations.
- **Known assumptions to verify at impl (flagged):** product list JSON uses `variants[].size` vs `variantSize` (verify script handles both; UI uses `WarehouseStockRow.variantSize` which is server-controlled); admin login email `.test` vs `.local`; `Modal` `subtitle`/`size` props (confirmed via `GoodsInModal`).
