# SP4 — Transfer Documents & Sharing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **The 6 working rules (user-required, every task):** 1) Ask, don't assume · 2) Don't touch unrelated · 3) Flag uncertainty · 4) Verify on failure (never fake success) · 5) Show changes · 6) Admit gaps.

**Goal:** Let the admin produce a printable / shareable **surat jalan** PNG+PDF in the backoffice at send (Web Share API → WhatsApp/OS share-sheet), and let the destination POS thermal-print a **tanda terima** on the existing BLE printer immediately after a successful SP3 receive.

**Architecture:** Backoffice (web) renders an L2 surat-jalan React component into a PNG via `html-to-image` and wraps that PNG into a single-page A4 PDF via `jsPDF`; the rendered PNG goes through `navigator.share({files:[png]})` with a download-anchor fallback. The POS reuses `@mandalika/printer`'s 32-col ESC/POS `Buf` builder to add a `buildTandaTerima` that prints over BLE; the engine surfaces `onReceiveAccepted(transfer)` carrying the assigned TT number, the POS shows an auto-prompt modal. The backend assigns `SJ-yyyy-NNNNN` at send and `TT-yyyy-NNNNN` at receive via a per-year `doc_sequences` counter table; brand-level letterhead lives on `app_settings.documents` with per-warehouse / per-outlet override; the server resolves the letterhead and ships it on every `Transfer` DTO so both clients consume one source of truth.

**Tech Stack:** Go (chi, pgx) + OpenAPI/oapi-codegen + Postgres (Neon); TypeScript + React + Vitest; `@mandalika/printer` (ESC/POS over BLE); new browser deps `html-to-image` + `jspdf` (backoffice only); existing `@mandalika/sync` engine + `@mandalika/api`; Cloud Run backend + Cloudflare Pages backoffice + GH Actions APK.

---

## Source spec

`docs/superpowers/specs/2026-05-26-inventory-sp4-transfer-documents-design.md` (11 locked decisions). Read it before starting.

## Refinement vs spec (one server-side change)

The spec lists `apps/backoffice/src/lib/letterhead.ts` as a **client-side** resolver. This plan instead resolves letterheads **server-side** inside the existing `Transfer` DTO assembly (`transferObj` in `backend/internal/read/repo.go`) and ships `senderLetterhead` + `receiverLetterhead` as new DTO fields. Reason: the POS needs the receiver letterhead too — duplicating the resolver in two TS apps drifts, and the existing SQL `json_build_object` pattern handles the COALESCE chain trivially. The end-user behaviour is identical; both clients consume `transfer.senderLetterhead` / `transfer.receiverLetterhead` directly. **Flagged for user review.**

## Verified current-state anchors (do not re-discover)

- **Migrations** live at `backend/internal/db/migrations/`. Last applied = `0017_receive_pin.sql`. **Next number = `0018`.** The migration runner tracks by full filename — never rename.
- **`backend/internal/write/transfer.go`** holds `SendTransfer` (line ~225) and `ReceiveTransfer` (line ~276). Both wrap everything in a single `tx`. The existing `transferNo` uses a Postgres SEQUENCE `transfer_no_seq` with a `DEFAULT` expression (migration `0016`). The SJ/TT sequences MUST be per-year, so they use a separate `doc_sequences` counter table (the `0016` pattern can't reset per year).
- **`backend/internal/sync/sync.go:314`** — the `transfer_receive` case in `ProcessItem` ends with `r.Status, r.OrderID = "ok", p.TransferID`. The `ItemResult` struct (line 141) carries `Status` + `OrderID`; SP4 adds `TandaTerimaNo` as an optional field on the same struct (no new endpoint).
- **`backend/internal/read/repo.go:560`** — `transferObj` is the canonical `json_build_object(...)` that fills the `Transfer` DTO; the `transferFrom` block (line ~582) joins `outlets so/do2` + `warehouses sw/dw`. SP4 adds `surat_jalan_no`, `tanda_terima_no`, and the two resolved letterhead JSON sub-objects to `transferObj`. A new join on `app_settings` (single row) supplies brand-level fallback.
- **`packages/sync/src/engine.ts:55`** — `onReceiveRejected` callback already exists in `engine.events`. SP4 adds the symmetric `onReceiveAccepted(transfer: Transfer)` callback fired from the same ack-handling block (`engine.ts:288–293`).
- **`packages/printer/src/escpos.ts`** — already exposes `buildReceipt` + `buildRecap`, the `Buf` chain helper, and `pad`/`center`/`money`/`COLS=32`/all ESC/POS control codes. SP4 adds `buildTandaTerima` in the same file. `print.ts` already exposes `printReceipt` + `printRecap`; SP4 adds `printTandaTerima` mirroring `printRecap`.
- **`apps/pos/src/printer.tsx`** — `PrinterProvider` exposes `print`/`printRecap`/`testPrint`/`isPaired`/`pair`/`unpair`. SP4 adds `printTandaTerima` to the context.
- **`apps/backoffice/src/screens/transfers/Transfers.tsx`** — `TransferDetail` is where the SuratJalanPanel will mount, directly under the `<PageHeader>`. The `act(() => api.sendTransfer(t.id))` button is the trigger point.
- **No PDF/image libs are installed** anywhere — `pnpm --filter @mandalika/backoffice add html-to-image jspdf` adds them to backoffice only.
- **Permissions** — `manage_inventory` and `manage_settings` are both already wired in `backend/internal/server/server.go:170/187`. SP4 introduces no new perm.

---

## Phase A — Backend foundations

> Goal of phase A: every backend touchpoint (schema, DTO, sequences, sync ack) is in place so both client surfaces can integrate against a stable contract.

### Task A1 — Migration 0018: documents schema & doc_sequences

**Files:**
- Create: `backend/internal/db/migrations/0018_transfer_documents.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 0018_transfer_documents.sql
-- SP4: surat jalan + tanda terima.

-- Brand-level document defaults (single-row app_settings table).
ALTER TABLE app_settings ADD COLUMN documents_logo_url      text;
ALTER TABLE app_settings ADD COLUMN documents_brand_name    text;
ALTER TABLE app_settings ADD COLUMN documents_address_lines text;
ALTER TABLE app_settings ADD COLUMN documents_phone         text;
ALTER TABLE app_settings ADD COLUMN documents_npwp          text;

-- Per-location overrides; NULL ⇒ fall back to brand.
ALTER TABLE warehouses ADD COLUMN address_lines text;
ALTER TABLE warehouses ADD COLUMN phone         text;
ALTER TABLE warehouses ADD COLUMN logo_url      text;

ALTER TABLE outlets    ADD COLUMN address_lines text;
ALTER TABLE outlets    ADD COLUMN phone         text;
ALTER TABLE outlets    ADD COLUMN logo_url      text;

-- Doc numbers assigned at status transition (NULL for pre-SP4 transfers).
ALTER TABLE transfers ADD COLUMN surat_jalan_no  text UNIQUE;
ALTER TABLE transfers ADD COLUMN tanda_terima_no text UNIQUE;

-- Per-year counter rows. UPSERT-with-increment yields the next number atomically.
CREATE TABLE doc_sequences (
  kind     text   NOT NULL,
  year     int    NOT NULL,
  next_seq bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (kind, year)
);
```

- [ ] **Step 2: Verify migration applies cleanly locally (or against a scratch DB)**

```bash
cd backend && go run ./cmd/server   # boots and applies migrations
# Expected log: "applied 0018_transfer_documents.sql"; no error.
# Ctrl-C after startup.
```

If you don't have a local DB, skip — Task A2's tests will exercise the schema against the real Neon DB at deploy time (Task A9). Flag in your commit message if you skipped.

- [ ] **Step 3: Commit**

```bash
git add backend/internal/db/migrations/0018_transfer_documents.sql
git commit -m "feat(backend): SP4 migration 0018 — documents brand/location + doc_sequences"
```

---

### Task A2 — `nextDocNo` Go helper + concurrent test

**Files:**
- Create: `backend/internal/write/doc_sequences.go`
- Create: `backend/internal/write/doc_sequences_test.go`

- [ ] **Step 1: Write the failing test**

```go
// backend/internal/write/doc_sequences_test.go
package write

import (
	"context"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// testPool is provided by repo_test.go's setup helper (see existing tests).
// If absent, follow the same pattern as repo_test.go (skip on no DB).

func TestNextDocNo_FirstCallReturnsOne(t *testing.T) {
	if testPool == nil { t.Skip("no DB") }
	ctx := context.Background()
	tx, _ := testPool.Begin(ctx)
	defer tx.Rollback(ctx)

	n, err := nextDocNo(ctx, tx, "SJ", 2027) // unused year → fresh row
	if err != nil { t.Fatal(err) }
	if n != "SJ-2027-00001" { t.Fatalf("got %q, want SJ-2027-00001", n) }
}

func TestNextDocNo_IncrementsWithinYear(t *testing.T) {
	if testPool == nil { t.Skip("no DB") }
	ctx := context.Background()
	tx, _ := testPool.Begin(ctx)
	defer tx.Rollback(ctx)

	a, _ := nextDocNo(ctx, tx, "TT", 2027)
	b, _ := nextDocNo(ctx, tx, "TT", 2027)
	if a != "TT-2027-00001" || b != "TT-2027-00002" {
		t.Fatalf("got %q, %q", a, b)
	}
}

func TestNextDocNo_IndependentPerKindAndYear(t *testing.T) {
	if testPool == nil { t.Skip("no DB") }
	ctx := context.Background()
	tx, _ := testPool.Begin(ctx)
	defer tx.Rollback(ctx)

	sj27a, _ := nextDocNo(ctx, tx, "SJ", 2027)
	tt27a, _ := nextDocNo(ctx, tx, "TT", 2027)
	sj28a, _ := nextDocNo(ctx, tx, "SJ", 2028)
	if sj27a != "SJ-2027-00001" || tt27a != "TT-2027-00001" || sj28a != "SJ-2028-00001" {
		t.Fatalf("got %q %q %q", sj27a, tt27a, sj28a)
	}
}

func TestNextDocNo_ConcurrentCallsGetDistinct(t *testing.T) {
	if testPool == nil { t.Skip("no DB") }
	ctx := context.Background()

	const N = 10
	out := make(chan string, N)
	wg := sync.WaitGroup{}
	for i := 0; i < N; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			tx, _ := testPool.Begin(ctx)
			defer tx.Rollback(ctx)
			n, _ := nextDocNo(ctx, tx, "SJ", 2029) // fresh year
			out <- n
			tx.Commit(ctx)
		}()
	}
	wg.Wait()
	close(out)
	seen := map[string]bool{}
	for n := range out {
		if seen[n] { t.Fatalf("duplicate %q", n) }
		seen[n] = true
	}
	if len(seen) != N { t.Fatalf("got %d distinct, want %d", len(seen), N) }
}

var testPool *pgxpool.Pool // wired by existing TestMain in repo_test.go
```

If `repo_test.go` doesn't already wire `testPool`, lift its existing connection pattern into a shared `setup_test.go` helper used by all `write` tests — that is in-scope cleanup.

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd backend && go test ./internal/write/ -run TestNextDocNo -v
# Expected: FAIL — "nextDocNo undefined"
```

- [ ] **Step 3: Implement `nextDocNo`**

```go
// backend/internal/write/doc_sequences.go
package write

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// nextDocNo atomically allocates the next per-year sequence number for `kind`
// ("SJ" or "TT"), formats it as "<KIND>-<YEAR>-<5-DIGIT>", and returns it.
//
// Uses an UPSERT-with-increment so two concurrent callers on the same row
// serialize on a row-level lock — each gets a distinct number with no holes.
//
// next_seq IS the assigned number (not the "next one to use"). On first INSERT
// the row lands with next_seq=1 and returns 1; subsequent UPDATEs increment
// then return the new value.
func nextDocNo(ctx context.Context, tx pgx.Tx, kind string, year int) (string, error) {
	var n int64
	err := tx.QueryRow(ctx,
		`INSERT INTO doc_sequences (kind, year, next_seq) VALUES ($1, $2, 1)
		 ON CONFLICT (kind, year) DO UPDATE SET next_seq = doc_sequences.next_seq + 1
		 RETURNING next_seq`,
		kind, year,
	).Scan(&n)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%s-%d-%05d", kind, year, n), nil
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd backend && go test ./internal/write/ -run TestNextDocNo -v
# Expected: PASS (or SKIP if no DB)
```

- [ ] **Step 5: Commit**

```bash
git add backend/internal/write/doc_sequences.go backend/internal/write/doc_sequences_test.go
git commit -m "feat(backend): nextDocNo per-year sequence helper for SP4 docs"
```

---

### Task A3 — Wire SJ assignment into `SendTransfer`

**Files:**
- Modify: `backend/internal/write/transfer.go` (inside `SendTransfer`, before final `tx.Commit`)
- Modify: `backend/internal/write/transfer_test.go` (add coverage)

- [ ] **Step 1: Write the failing test**

```go
// in backend/internal/write/transfer_test.go
func TestSendTransfer_AssignsSuratJalanNo(t *testing.T) {
	if testPool == nil { t.Skip("no DB") }
	ctx := context.Background()
	repo := &Repo{Pool: testPool}

	// Arrange — minimal warehouse → outlet draft via the existing test helpers
	srcWh := insertTestWarehouse(t, "SP4 SJ Src")
	dstOut := insertTestOutlet(t, "SP4 SJ Dst")
	pid, vs := insertStockedProduct(t, srcWh, /*size*/"50ml", /*qty*/3)
	id, err := repo.CreateTransfer(ctx, "test-admin", TransferCreate{
		Source: TransferLoc{Kind: "warehouse", ID: srcWh},
		Dest:   TransferLoc{Kind: "outlet",    ID: dstOut},
		Items:  []TransferItemInput{{ProductID: pid, VariantSize: vs, Qty: 2}},
	})
	if err != nil { t.Fatal(err) }

	// Act
	if err := repo.SendTransfer(ctx, id); err != nil { t.Fatal(err) }

	// Assert
	var no string
	_ = testPool.QueryRow(ctx, `SELECT surat_jalan_no FROM transfers WHERE id=$1`, id).Scan(&no)
	if !strings.HasPrefix(no, "SJ-") || len(no) < 13 {
		t.Fatalf("got surat_jalan_no=%q, want SJ-YYYY-NNNNN", no)
	}
}
```

If `insertTestWarehouse` / `insertTestOutlet` / `insertStockedProduct` don't exist, reuse whatever helpers `transfer_test.go` already uses for SP2 tests. **Do not** invent new fixtures unrelated to this task.

- [ ] **Step 2: Run test to verify it fails**

```bash
cd backend && go test ./internal/write/ -run TestSendTransfer_AssignsSuratJalanNo -v
# Expected: FAIL — surat_jalan_no IS NULL
```

- [ ] **Step 3: Insert SJ assignment into `SendTransfer`**

Locate the existing block in `SendTransfer` (~line 262) just before `return tx.Commit(ctx)`:

```go
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
```

Change to:

```go
	if _, e := tx.Exec(ctx,
		`UPDATE transfers SET status='in_transit', sent_at=now() WHERE id=$1`, id); e != nil {
		return e
	}
	// SP4: stamp the surat jalan number now that the transfer is in_transit.
	// next_seq is per-year; receive year may differ for cross-year TT (see SP4 spec).
	sjNo, e := nextDocNo(ctx, tx, "SJ", time.Now().Year())
	if e != nil {
		return e
	}
	if _, e := tx.Exec(ctx,
		`UPDATE transfers SET surat_jalan_no=$1 WHERE id=$2`, sjNo, id); e != nil {
		return e
	}
	if t.srcOutlet != nil {
		if e := bumpVersionOutlets(ctx, tx, "products", []string{*t.srcOutlet}); e != nil {
			return e
		}
	}
	return tx.Commit(ctx)
```

Add `"time"` to the imports if not already present.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd backend && go test ./internal/write/ -v
# Expected: PASS for the new test + ALL existing transfer tests (no regression)
```

- [ ] **Step 5: Commit**

```bash
git add backend/internal/write/transfer.go backend/internal/write/transfer_test.go
git commit -m "feat(backend): SendTransfer stamps SJ-YYYY-NNNNN at in_transit"
```

---

### Task A4 — Wire TT assignment into `ReceiveTransfer` (skip on idempotent re-ack)

**Files:**
- Modify: `backend/internal/write/transfer.go` (inside `ReceiveTransfer`)
- Modify: `backend/internal/write/transfer_test.go`

- [ ] **Step 1: Write the failing tests**

```go
func TestReceiveTransfer_AssignsTandaTerimaNo(t *testing.T) {
	if testPool == nil { t.Skip("no DB") }
	ctx := context.Background()
	repo := &Repo{Pool: testPool}
	id := setupInTransitTransfer(t)   // arrange helper: wh→outlet, sent, status=in_transit

	err := repo.ReceiveTransfer(ctx, id,
		TransferReceive{Items: nil, DiscrepancyReason: ""},
		ReceiveMeta{ReceivedBy: "test-mgr", ReceivedVia: "pos", IdempotencyKey: "k-1"})
	if err != nil { t.Fatal(err) }

	var no string
	_ = testPool.QueryRow(ctx, `SELECT tanda_terima_no FROM transfers WHERE id=$1`, id).Scan(&no)
	if !strings.HasPrefix(no, "TT-") || len(no) < 13 {
		t.Fatalf("got tanda_terima_no=%q, want TT-YYYY-NNNNN", no)
	}
}

func TestReceiveTransfer_IdempotentReplayDoesNotReassignTT(t *testing.T) {
	if testPool == nil { t.Skip("no DB") }
	ctx := context.Background()
	repo := &Repo{Pool: testPool}
	id := setupInTransitTransfer(t)
	meta := ReceiveMeta{ReceivedBy: "test-mgr", ReceivedVia: "pos", IdempotencyKey: "k-replay"}

	_ = repo.ReceiveTransfer(ctx, id, TransferReceive{}, meta)
	var first string
	_ = testPool.QueryRow(ctx, `SELECT tanda_terima_no FROM transfers WHERE id=$1`, id).Scan(&first)

	// Idempotent re-ack: must succeed without re-assigning TT.
	if err := repo.ReceiveTransfer(ctx, id, TransferReceive{}, meta); err != nil { t.Fatal(err) }
	var second string
	_ = testPool.QueryRow(ctx, `SELECT tanda_terima_no FROM transfers WHERE id=$1`, id).Scan(&second)

	if first != second {
		t.Fatalf("idempotent replay reassigned TT: %q → %q", first, second)
	}
}
```

`setupInTransitTransfer` = inline arrange helper that creates a draft, calls `SendTransfer`, returns the id. Reuse `insertTestWarehouse`/`insertTestOutlet`/`insertStockedProduct` from Task A3.

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd backend && go test ./internal/write/ -run TestReceiveTransfer -v
# Expected: FAIL — tanda_terima_no IS NULL
```

- [ ] **Step 3: Insert TT assignment into `ReceiveTransfer`**

Locate the existing block in `ReceiveTransfer` that runs **after** the idempotent-replay early-return and after the existing receive logic, just before `tx.Commit(ctx)`. The early-return path (around line ~295) MUST remain untouched so a re-ack does not assign a new TT.

Add — directly before the final `tx.Commit(ctx)` (which lives at the end of the function, ~line 358):

```go
	// SP4: stamp the tanda terima number. Idempotent retries return early above,
	// so this runs only on the actual completion transition.
	ttNo, e := nextDocNo(ctx, tx, "TT", time.Now().Year())
	if e != nil {
		return e
	}
	if _, e := tx.Exec(ctx,
		`UPDATE transfers SET tanda_terima_no=$1 WHERE id=$2`, ttNo, id); e != nil {
		return e
	}
```

Make sure `"time"` is imported.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd backend && go test ./internal/write/ -v
# Expected: PASS for new tests + ALL existing SP1/SP2/SP3 tests still green.
```

- [ ] **Step 5: Commit**

```bash
git add backend/internal/write/transfer.go backend/internal/write/transfer_test.go
git commit -m "feat(backend): ReceiveTransfer stamps TT-YYYY-NNNNN on completion (idempotent-safe)"
```

---

### Task A5 — Extend OpenAPI: `Transfer.suratJalanNo` + `tandaTerimaNo` + letterheads; `AppSettings.documents`; warehouse/outlet override fields

**Files:**
- Modify: `backend/api/openapi.yaml`
- Regenerate: `backend/internal/api/api.gen.go` + `packages/api`

- [ ] **Step 1: Edit `openapi.yaml`**

Find the existing `Transfer` schema (around line 223) and add the new fields:

```yaml
    Transfer:
      type: object
      required: [id, transferNo, status, source, dest, createdAt, items]
      properties:
        id:               { type: string }
        transferNo:       { type: string }
        suratJalanNo:     { type: string, nullable: true }
        tandaTerimaNo:    { type: string, nullable: true }
        status:           { $ref: '#/components/schemas/TransferStatus' }
        source:           { $ref: '#/components/schemas/TransferLoc' }
        dest:             { $ref: '#/components/schemas/TransferLoc' }
        senderLetterhead:   { $ref: '#/components/schemas/Letterhead', nullable: true }
        receiverLetterhead: { $ref: '#/components/schemas/Letterhead', nullable: true }
        # (leave the rest unchanged)
```

Add the new `Letterhead` schema near `TransferLoc`:

```yaml
    Letterhead:
      type: object
      required: [locationName, addressLines]
      properties:
        locationName: { type: string }
        brandName:    { type: string, nullable: true }
        logoUrl:      { type: string, nullable: true }
        addressLines:
          type: array
          items: { type: string }
        phone:        { type: string, nullable: true }
        npwp:         { type: string, nullable: true }
```

Add the new `DocumentSettings` block to `AppSettings` (find the `AppSettings` schema; add inside `properties:`):

```yaml
        documents:
          $ref: '#/components/schemas/DocumentSettings'
```

Add the `DocumentSettings` schema:

```yaml
    DocumentSettings:
      type: object
      properties:
        logoUrl:      { type: string, nullable: true }
        brandName:    { type: string, nullable: true }
        addressLines: { type: string, nullable: true }   # multiline; newline-separated
        phone:        { type: string, nullable: true }
        npwp:         { type: string, nullable: true }
```

Add optional override fields to the existing `Warehouse` and `Outlet` schemas (inside their `properties:`):

```yaml
        addressLines: { type: string, nullable: true }
        phone:        { type: string, nullable: true }
        logoUrl:      { type: string, nullable: true }
```

For the sync ack — find the `BatchItemResult` (or equivalent) schema and add:

```yaml
        tandaTerimaNo: { type: string, nullable: true }   # set on transfer_receive ok
        transfer:                                          # set on transfer_receive ok: full completed snapshot
          $ref: '#/components/schemas/Transfer'
          nullable: true
```

Shipping the full `Transfer` in the ack is required because (a) the existing
inbound-list endpoint only returns `in_transit` transfers, so the POS can't
re-fetch the just-completed one from there, and (b) the cashier role doesn't
have access to the admin-perm `GET /transfers/{id}`. The ack-shipped snapshot
avoids a new endpoint (spec rule "no new endpoint") and gives the POS everything
it needs for the prompt.

- [ ] **Step 2: Regenerate codegen**

```bash
cd backend && go tool oapi-codegen -config api/oapi-codegen.yaml api/openapi.yaml
cd .. && corepack pnpm --filter @mandalika/api gen
```

- [ ] **Step 3: Verify it compiles**

```bash
cd backend && go build ./...
cd .. && corepack pnpm -r typecheck
# Both expected: clean.
```

- [ ] **Step 4: Commit (regenerated files are intentional)**

```bash
git add backend/api/openapi.yaml backend/internal/api/api.gen.go packages/api/
git commit -m "feat(api): SP4 — Transfer.suratJalanNo/tandaTerimaNo + Letterhead + DocumentSettings + ack.tandaTerimaNo"
```

---

### Task A6 — Extend `transferObj` to emit doc numbers + resolved letterheads

**Files:**
- Modify: `backend/internal/read/repo.go` (`transferObj`, `transferFrom`)

- [ ] **Step 1: Update `transferObj` and `transferFrom`**

In `backend/internal/read/repo.go` (around line 560), the existing `transferObj` builds the JSON. Extend it with the new fields. `transferFrom` already joins source/dest outlets+warehouses — add a single LEFT JOIN on `app_settings` for the brand fallback.

```go
const transferObj = `json_build_object(
  'id', t.id, 'transferNo', t.transfer_no, 'status', t.status,
  'suratJalanNo', t.surat_jalan_no, 'tandaTerimaNo', t.tanda_terima_no,
  'source', json_build_object(
    'kind', CASE WHEN t.source_outlet_id IS NOT NULL THEN 'outlet' ELSE 'warehouse' END,
    'id',   COALESCE(t.source_outlet_id, t.source_warehouse_id),
    'name', COALESCE(so.name, sw.name)),
  'dest', json_build_object(
    'kind', CASE WHEN t.dest_outlet_id IS NOT NULL THEN 'outlet' ELSE 'warehouse' END,
    'id',   COALESCE(t.dest_outlet_id, t.dest_warehouse_id),
    'name', COALESCE(do2.name, dw.name)),
  'senderLetterhead', json_build_object(
    'locationName', COALESCE(so.name, sw.name),
    'brandName',    s.documents_brand_name,
    'logoUrl',      COALESCE(so.logo_url, sw.logo_url, s.documents_logo_url),
    'addressLines', string_to_array(
                      COALESCE(NULLIF(COALESCE(so.address_lines, sw.address_lines), ''),
                               s.documents_address_lines, ''), E'\n'),
    'phone',        COALESCE(so.phone, sw.phone, s.documents_phone),
    'npwp',         s.documents_npwp),
  'receiverLetterhead', json_build_object(
    'locationName', COALESCE(do2.name, dw.name),
    'brandName',    s.documents_brand_name,
    'logoUrl',      COALESCE(do2.logo_url, dw.logo_url, s.documents_logo_url),
    'addressLines', string_to_array(
                      COALESCE(NULLIF(COALESCE(do2.address_lines, dw.address_lines), ''),
                               s.documents_address_lines, ''), E'\n'),
    'phone',        COALESCE(do2.phone, dw.phone, s.documents_phone),
    'npwp',         s.documents_npwp),
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

const transferFrom = `FROM transfers t
  LEFT JOIN outlets    so  ON so.id  = t.source_outlet_id
  LEFT JOIN warehouses sw  ON sw.id  = t.source_warehouse_id
  LEFT JOIN outlets    do2 ON do2.id = t.dest_outlet_id
  LEFT JOIN warehouses dw  ON dw.id  = t.dest_warehouse_id
  LEFT JOIN app_settings s ON true`
```

Note: `LEFT JOIN app_settings s ON true` works because `app_settings` is a single-row table. Verify with `SELECT COUNT(*) FROM app_settings;` against the live DB if uncertain (must be 0 or 1). If it can have multiple rows, fix to `LEFT JOIN LATERAL (SELECT * FROM app_settings LIMIT 1) s ON true`.

The `string_to_array(..., E'\n')` splits multiline `address_lines` into the array shape the OpenAPI `Letterhead.addressLines` declares. Empty string ⇒ array with one empty element; that's fine for the renderer to filter.

- [ ] **Step 2: Add a read-back test**

```go
// in backend/internal/read/repo_test.go (or wherever existing transfer read tests live)
func TestTransfer_EmitsLetterheadsAndDocNos(t *testing.T) {
	if testPool == nil { t.Skip("no DB") }
	// Arrange — brand defaults + a sent transfer wh→outlet
	setAppSettingsDocuments(t, "Acme", "logo.png", "Jl. A\nJl. B", "0812", "12.345")
	id := setupSentTransfer(t)   // wraps Create + Send; returns id

	repo := &ReadRepo{Pool: testPool}
	tr, err := repo.Transfer(context.Background(), id)
	if err != nil { t.Fatal(err) }

	if tr.SuratJalanNo == nil || !strings.HasPrefix(*tr.SuratJalanNo, "SJ-") {
		t.Fatalf("suratJalanNo not emitted: %v", tr.SuratJalanNo)
	}
	if tr.SenderLetterhead == nil || tr.SenderLetterhead.BrandName == nil ||
		*tr.SenderLetterhead.BrandName != "Acme" {
		t.Fatalf("senderLetterhead brand fallback failed: %+v", tr.SenderLetterhead)
	}
	if len(tr.SenderLetterhead.AddressLines) != 2 {
		t.Fatalf("addressLines split failed: %v", tr.SenderLetterhead.AddressLines)
	}
}
```

`setAppSettingsDocuments` = small inline helper that PUTs the 5 new app_settings columns. `setupSentTransfer` reuses A3/A4 fixtures.

- [ ] **Step 3: Run and commit**

```bash
cd backend && go test ./internal/read/ ./internal/write/ -v
git add backend/internal/read/repo.go backend/internal/read/repo_test.go
git commit -m "feat(backend): transferObj emits doc numbers + resolved sender/receiver letterheads"
```

---

### Task A7 — Wire `documents` block into `app_settings` read + write

**Files:**
- Modify: `backend/internal/read/repo.go` (the existing `AppSettings` read)
- Modify: `backend/internal/write/repo.go` (the existing `UpdateAppSettings`)

- [ ] **Step 1: Find the existing read + write paths**

```bash
grep -n "AppSettings\|app_settings" backend/internal/read/repo.go backend/internal/write/repo.go | head -20
```

- [ ] **Step 2: Extend the read SELECT**

Add the 5 new `documents_*` columns to the SELECT and wire them into a `Documents *api.DocumentSettings` sub-object on the DTO. If the existing code uses a hand-rolled struct→json mapping, mirror its style (pointer fields for nullable).

- [ ] **Step 3: Extend the write UPDATE**

Accept the 5 new fields from the request DTO; `UPDATE app_settings SET documents_logo_url=$1, documents_brand_name=$2, …`. Use `pgx.NullString` (or whatever pattern the existing receipt-settings code uses) for nulls.

- [ ] **Step 4: Add a round-trip test**

```go
func TestAppSettings_DocumentsRoundTrip(t *testing.T) {
	if testPool == nil { t.Skip("no DB") }
	r := &Repo{Pool: testPool}
	rr := &ReadRepo{Pool: testPool}
	brand := "Acme"; addr := "Jl. A\nJl. B"; phone := "0812"
	err := r.UpdateAppSettings(context.Background(), api.AppSettings{
		Documents: &api.DocumentSettings{
			BrandName: &brand, AddressLines: &addr, Phone: &phone,
		},
	})
	if err != nil { t.Fatal(err) }
	got, _ := rr.AppSettings(context.Background())
	if got.Documents == nil || got.Documents.BrandName == nil || *got.Documents.BrandName != "Acme" {
		t.Fatalf("documents round-trip failed: %+v", got.Documents)
	}
}
```

- [ ] **Step 5: Run, commit**

```bash
cd backend && go test ./internal/... -v
git add backend/internal/read/repo.go backend/internal/write/repo.go backend/internal/read/repo_test.go
git commit -m "feat(backend): app_settings.documents read+write round-trip"
```

---

### Task A8 — Wire warehouse/outlet letterhead overrides into read+write

**Files:**
- Modify: `backend/internal/read/repo.go` (the existing `Warehouses` + `Outlets` list/get)
- Modify: `backend/internal/write/warehouse.go` + the outlets write path (find via `grep -n "func.*Outlet"`)

- [ ] **Step 1: Add `address_lines`, `phone`, `logo_url` to the existing SELECT/INSERT/UPDATE for both tables**

Follow the same pattern as `Task A7` (pointer-nullable). Keep edits surgical — do NOT refactor unrelated columns.

- [ ] **Step 2: Add a round-trip test for both**

```go
func TestWarehouse_LetterheadOverrideRoundTrip(t *testing.T) {
	// arrange: insert warehouse with override fields → fetch → assert
}
func TestOutlet_LetterheadOverrideRoundTrip(t *testing.T) {
	// same pattern
}
```

- [ ] **Step 3: Run, commit**

```bash
cd backend && go test ./internal/... -v
git add backend/internal/read/repo.go backend/internal/write/warehouse.go backend/internal/write/repo.go backend/internal/read/repo_test.go
git commit -m "feat(backend): warehouses+outlets carry optional letterhead override (address/phone/logo)"
```

---

### Task A9 — Surface `tandaTerimaNo` on the `transfer_receive` sync ack + fire `onReceiveAccepted`

**Files:**
- Modify: `backend/internal/sync/sync.go` (the `transfer_receive` case)
- Modify: `packages/sync/src/engine.ts` (`SyncEvents` + ack handling)

- [ ] **Step 1: Backend — ship `tandaTerimaNo` + full `Transfer` snapshot on the OK result**

Find `backend/internal/sync/sync.go:314` (the `transfer_receive` case). After the `ReceiveTransfer` call succeeds, fetch the full completed transfer (already includes the freshly-assigned TT number from Task A4 + the resolved letterheads from Task A6):

```go
if err := e.Write.ReceiveTransfer(ctx, p.TransferID, /* … */); err != nil {
    return fail(err)
}
tr, terr := e.Read.Transfer(ctx, p.TransferID)
if terr != nil {
    // Soft-fail: receive succeeded; we just couldn't read it back. POS prompt
    // will not appear for this transfer — acceptable (reprint button still works
    // if the cashier opens the completed detail manually).
    r.Status, r.OrderID = "ok", p.TransferID
    return r
}
r.Status, r.OrderID = "ok", p.TransferID
r.Transfer = &tr
if tr.TandaTerimaNo != nil {
    r.TandaTerimaNo = *tr.TandaTerimaNo
}
return r
```

Add to the `ItemResult` struct (around line 141):

```go
TandaTerimaNo string         `json:"tandaTerimaNo,omitempty"`
Transfer      *api.Transfer  `json:"transfer,omitempty"`
```

(Add `api "<...>/internal/api"` to imports if not already present.)

- [ ] **Step 2: Engine — declare `onReceiveAccepted` callback**

In `packages/sync/src/engine.ts`, find the `SyncEvents` interface (around line 50) and add:

```ts
/** Fired when a transfer_receive is accepted by the server. Carries the full
 *  completed Transfer snapshot (with the freshly-assigned tandaTerimaNo and
 *  resolved receiver letterhead) so the UI can render the post-receive slip
 *  without a second roundtrip. */
onReceiveAccepted?: (transfer: Transfer) => void
```

Make sure `Transfer` is imported from `@mandalika/api` at the top of the file.

- [ ] **Step 3: Engine — fire it from the ack-handling loop**

In `engine.ts` near line 290 (`for (const res of r.data.results)`), in the `if (res.status === 'ok' || res.status === 'duplicate')` branch:

```ts
if (res.status === 'ok' || res.status === 'duplicate') {
  this.outbox.ack(res.idempotencyKey)
  this.pending.stampAck(res.idempotencyKey, r.data.version ?? 0)
  if (typeByKey.get(res.idempotencyKey) === 'transfer_receive'
      && res.status === 'ok'
      && res.transfer) {
    this.events.onReceiveAccepted?.(res.transfer)
  }
}
```

Note: only fire on `'ok'`, not `'duplicate'` — a duplicate means the cashier already saw the prompt for this receive (replay). Acceptable to skip the second modal.

- [ ] **Step 4: Vitest for the new callback**

Add `packages/sync/src/engine.receive-accepted.test.ts` with a test that mocks the API to return a `transfer_receive` ack like:

```ts
{
  status: 'ok',
  idempotencyKey: 'k1',
  orderId: 't1',
  tandaTerimaNo: 'TT-2026-00001',
  transfer: { id: 't1', tandaTerimaNo: 'TT-2026-00001', /* …full Transfer fixture… */ },
}
```

and asserts `onReceiveAccepted` fires once with the `Transfer` argument (and that it does NOT fire on `status: 'duplicate'`).

- [ ] **Step 5: Run, commit**

```bash
cd backend && go build ./... && go test ./internal/sync/ -v
cd .. && corepack pnpm --filter @mandalika/sync test
git add backend/internal/sync/sync.go packages/sync/src/
git commit -m "feat(sync): transfer_receive ack carries tandaTerimaNo + onReceiveAccepted callback"
```

---

### Task A10 — Backend deploy + live verify

**Files:** none.

- [ ] **Step 1: Deploy**

```bash
gcloud run deploy mandalika-pos --source backend --region asia-southeast2 --quiet
```

(Run in background; ~4–6 min. Migration 0018 auto-applies on boot.)

- [ ] **Step 2: Verify `/readyz`**

```bash
curl -sS https://mandalika-pos-538849926142.asia-southeast2.run.app/readyz
# Expected: 200 ok
```

- [ ] **Step 3: Smoke via authed API**

Use the existing admin login pattern from prior SP runbooks (test creds in `SESSION_HANDOFF.md`). Spot-checks:

```bash
# PUT app_settings.documents
TOKEN=$(login as admin@mandalika.test)
curl -sS -X PUT https://…/api/v1/app-settings -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"documents":{"brandName":"Mandalika POS","addressLines":"Jl. A\nJl. B","phone":"0812-0000-0000"}}'

# Create + Send a transfer, then GET it and look for suratJalanNo + senderLetterhead.brandName
curl -sS https://…/api/v1/transfers/<id> -H "Authorization: Bearer $TOKEN" | jq '.suratJalanNo, .senderLetterhead'
# Expected: "SJ-2026-00001" + Letterhead with brandName="Mandalika POS"
```

- [ ] **Step 4: Note the live rev in commit message**

```bash
git commit --allow-empty -m "ops: SP4 backend rev <NEW_REV> live (verified suratJalanNo + letterheads)"
```

---

## Phase B — Backoffice settings, location overrides, deps

> Goal of phase B: the brand block and per-location letterhead override fields are editable in the backoffice and persist correctly. PDF/PNG libs are installed; render pipeline lives in its own files.

### Task B1 — Install browser deps

**Files:**
- Modify: `apps/backoffice/package.json`

- [ ] **Step 1: Install**

```bash
corepack pnpm --filter @mandalika/backoffice add html-to-image jspdf
```

- [ ] **Step 2: Verify versions and typecheck**

```bash
cd apps/backoffice && cat package.json | grep -E "html-to-image|jspdf"
corepack pnpm --filter @mandalika/backoffice exec tsc --noEmit
# Both expected: clean.
```

- [ ] **Step 3: Commit**

```bash
git add apps/backoffice/package.json pnpm-lock.yaml
git commit -m "build(backoffice): add html-to-image + jspdf for SP4 surat-jalan render"
```

---

### Task B2 — Settings → "Dokumen" section (brand block editor)

**Files:**
- Modify: `apps/backoffice/src/screens/Settings.tsx` (the existing settings screen)
- (the `apps/backoffice/src/api.ts` types are already updated by Task A5's codegen)

- [ ] **Step 1: Find the existing structure**

```bash
grep -n "headerText\|footerText\|receipt\|AppSettings" apps/backoffice/src/screens/Settings.tsx | head
```

The existing screen already edits `app_settings.receipt`. The pattern is reusable for `documents`.

- [ ] **Step 2: Add a "Dokumen" section**

Below the existing Receipt section, add a new `<Card>` with the 5 fields:

```tsx
// Inside the existing Settings component
<Card className="p-5 space-y-4">
  <h3 className="text-lg font-bold">Dokumen Pengiriman</h3>
  <p className="text-sm text-gray-500">
    Identitas merek yang muncul di surat jalan dan tanda terima.
    Bisa diganti per gudang / outlet (opsional, di halaman masing-masing).
  </p>
  <Input label="Nama Merek" value={form.documents?.brandName ?? ''}
    onChange={(v) => setField('documents.brandName', v)} />
  <ImageUpload label="Logo (PNG/JPG)" value={form.documents?.logoUrl ?? null}
    onChange={(v) => setField('documents.logoUrl', v)} />
  <Textarea label="Alamat (multi-baris)" rows={3}
    value={form.documents?.addressLines ?? ''}
    onChange={(v) => setField('documents.addressLines', v)} />
  <Input label="Telepon" value={form.documents?.phone ?? ''}
    onChange={(v) => setField('documents.phone', v)} />
  <Input label="NPWP" value={form.documents?.npwp ?? ''}
    onChange={(v) => setField('documents.npwp', v)} />
</Card>
```

Reuse the existing `<Input>`, `<Textarea>`, `<Card>` primitives from `apps/backoffice/src/ui/`. For `ImageUpload`, reuse whatever product-images use (find via `grep -rn "ImageUpload\|signed-upload" apps/backoffice/src`). If no reusable component exists, use a minimal `<input type="file">` + the existing Cloudinary signer endpoint — this is in scope.

Wire `setField` to update the existing form state in immutable fashion (the existing receipt section does this — mirror it).

- [ ] **Step 3: Smoke test manually after deploy (Cloudflare auto-deploys)**

Log in as admin → Settings → fill Documents block → Save → reload → verify persistence.

- [ ] **Step 4: Commit**

```bash
git add apps/backoffice/src/screens/Settings.tsx
git commit -m "feat(backoffice): Settings — Dokumen section for SP4 brand letterhead"
```

---

### Task B3 — Per-warehouse / per-outlet override fields in edit modals

**Files:**
- Modify: the warehouse edit modal (find: `apps/backoffice/src/screens/warehouses/`)
- Modify: the outlet edit modal (find: `apps/backoffice/src/screens/Outlets.tsx`)

- [ ] **Step 1: Locate**

```bash
grep -rn "name.*addressLines\|export function.*WarehouseForm\|OutletEdit" apps/backoffice/src/screens/
```

- [ ] **Step 2: Add the 3 optional fields to each edit modal**

```tsx
<Textarea label="Alamat (opsional, override merek)" rows={2}
  value={form.addressLines ?? ''}
  onChange={(v) => setForm({ ...form, addressLines: v || null })} />
<Input label="Telepon (opsional)" value={form.phone ?? ''}
  onChange={(v) => setForm({ ...form, phone: v || null })} />
<ImageUpload label="Logo (opsional, override merek)" value={form.logoUrl ?? null}
  onChange={(v) => setForm({ ...form, logoUrl: v })} />
```

Help text: "Kosongkan untuk pakai pengaturan merek di halaman Pengaturan."

- [ ] **Step 3: Manual verification after deploy**

Edit a warehouse → enter a different address → save → in the Transfers detail, send a new transfer FROM that warehouse → verify the eventual surat jalan shows the warehouse's address (not the brand default).

- [ ] **Step 4: Commit**

```bash
git add apps/backoffice/src/screens/warehouses/ apps/backoffice/src/screens/Outlets.tsx
git commit -m "feat(backoffice): per-warehouse/outlet letterhead override fields (address/phone/logo)"
```

---

## Phase C — Backoffice surat-jalan render & inline panel

> Goal of phase C: a real PNG+PDF surat jalan renders client-side from a pure React component using letterheads shipped by the server; an inline panel exposes Bagikan/Unduh PDF/Unduh PNG/Lihat; Bagikan auto-opens the Web Share API.

### Task C1 — Pure render component `SuratJalanDoc.tsx` (L2 layout) + tests

**Files:**
- Create: `apps/backoffice/src/screens/transfers/docs/SuratJalanDoc.tsx`
- Create: `apps/backoffice/src/screens/transfers/docs/SuratJalanDoc.test.tsx`

- [ ] **Step 1: Write the failing test (render snapshot)**

```tsx
// SuratJalanDoc.test.tsx
import { render } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { SuratJalanDoc } from './SuratJalanDoc'
import type { Transfer } from '@mandalika/api'

const fix: Transfer = {
  id: 't1', transferNo: 'TRF-00005', suratJalanNo: 'SJ-2026-00001', status: 'in_transit',
  source: { kind: 'warehouse', id: 'w1', name: 'Gudang Pusat' },
  dest:   { kind: 'outlet',    id: 'o1', name: 'Mandalika PMS' },
  senderLetterhead: {
    locationName: 'Gudang Pusat', brandName: 'Mandalika POS',
    logoUrl: 'https://cdn.example/logo.png',
    addressLines: ['Jl. Industri Raya 12', 'Denpasar'],
    phone: '0812-xxxx', npwp: '12.345.678',
  },
  createdAt: '2026-05-26T07:30:00Z',
  items: [
    { productId: 'p1', productName: 'Parfum Bunga', variantSize: '50ml', sku: 'PF-1', sentQty: 10, receivedQty: null, difference: null },
    { productId: 'p2', productName: 'Parfum Kayu',  variantSize: '100ml', sku: 'PF-2', sentQty: 5,  receivedQty: null, difference: null },
  ],
  // other Transfer fields…
} as any

describe('SuratJalanDoc', () => {
  it('renders L2 elements: brand, doc title, Dari/Untuk blocks, item table, 2 signature lines', () => {
    const { getByText, queryByText } = render(<SuratJalanDoc transfer={fix} />)
    expect(getByText('Mandalika POS')).toBeTruthy()
    expect(getByText('SURAT JALAN')).toBeTruthy()
    expect(getByText('SJ-2026-00001')).toBeTruthy()
    expect(getByText(/Dari/i)).toBeTruthy()
    expect(getByText(/Untuk/i)).toBeTruthy()
    expect(getByText('Parfum Bunga')).toBeTruthy()
    expect(getByText('Pengirim')).toBeTruthy()
    expect(getByText('Penerima')).toBeTruthy()
    expect(queryByText(/Sopir/i)).toBeNull()   // L2: no Sopir line
  })
})
```

- [ ] **Step 2: Run, expect FAIL**

```bash
corepack pnpm --filter @mandalika/backoffice test -- SuratJalanDoc
# Expected: cannot find module
```

- [ ] **Step 3: Implement `SuratJalanDoc.tsx`**

```tsx
// apps/backoffice/src/screens/transfers/docs/SuratJalanDoc.tsx
import type { Transfer } from '@mandalika/api'

// All inline styles — html-to-image needs to inline + serialize them without
// relying on Tailwind's runtime-generated CSS. System fonts only (no web fonts
// — see spec §Open risks). Fixed pixel dimensions = predictable canvas.

const PAGE_W = 794   // A4 @ 96dpi (210mm × 96/25.4)
const PAGE_H = 1123  // A4 @ 96dpi

interface Props { transfer: Transfer }

export function SuratJalanDoc({ transfer: t }: Props) {
  const lh = t.senderLetterhead
  const addr = lh?.addressLines?.filter((s) => s && s.trim().length > 0) ?? []
  const date = new Date(t.sentAt ?? t.createdAt).toLocaleDateString('id-ID', {
    day: '2-digit', month: 'long', year: 'numeric',
  })
  return (
    <div style={{
      width: PAGE_W, minHeight: PAGE_H, background: '#fff', color: '#1a1a1a',
      padding: 48, fontFamily: 'ui-sans-serif, system-ui, -apple-system, sans-serif',
      fontSize: 13, lineHeight: 1.5,
    }}>
      {/* Header */}
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
        {lh?.logoUrl ? (
          <img src={lh.logoUrl} alt="" style={{ width: 56, height: 56, borderRadius: 8, objectFit: 'cover' }} />
        ) : null}
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 800, fontSize: 18 }}>{lh?.brandName ?? lh?.locationName ?? ''}</div>
          {addr.length > 0 && <div style={{ color: '#666', fontSize: 12 }}>{addr.join(' · ')}</div>}
          {lh?.phone && <div style={{ color: '#666', fontSize: 12 }}>{lh.phone}{lh.npwp ? ` · NPWP ${lh.npwp}` : ''}</div>}
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontWeight: 800, letterSpacing: '0.15em', fontSize: 16 }}>SURAT JALAN</div>
          <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 13 }}>{t.suratJalanNo ?? ''}</div>
          <div style={{ color: '#666', fontSize: 12 }}>{date}</div>
        </div>
      </div>
      <hr style={{ borderTop: '2px solid #8a6a1f', marginTop: 16, marginBottom: 16 }} />

      {/* Dari / Untuk */}
      <div style={{ display: 'flex', gap: 24, marginBottom: 16 }}>
        <Block label="Dari" name={t.source.name} addr={addr} />
        <Block label="Untuk" name={t.dest.name} addr={[/* dest addr would need a 2nd letterhead — surat jalan only carries sender; dest name only */]} />
      </div>

      {/* Items */}
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <Th>Nama</Th><Th>Ukuran</Th><Th right>Qty</Th>
          </tr>
        </thead>
        <tbody>
          {t.items.map((it) => (
            <tr key={`${it.productId}|${it.variantSize}`}>
              <Td>{it.productName}</Td>
              <Td>{it.variantSize}</Td>
              <Td right>{it.sentQty}</Td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <Td colSpan={2} right bold style={{ borderTop: '1px solid #444' }}>Total</Td>
            <Td right bold style={{ borderTop: '1px solid #444' }}>
              {t.items.reduce((s, x) => s + x.sentQty, 0)} pcs
            </Td>
          </tr>
        </tfoot>
      </table>

      {t.note && (
        <div style={{ marginTop: 16, fontSize: 12, color: '#444' }}>
          <b>Catatan:</b> {t.note}
        </div>
      )}

      {/* Signatures pinned near bottom */}
      <div style={{ display: 'flex', gap: 32, marginTop: 80 }}>
        <Sig label="Pengirim" />
        <Sig label="Penerima" />
      </div>
    </div>
  )
}

function Block({ label, name, addr }: { label: string; name: string; addr: string[] }) {
  return (
    <div style={{ flex: 1 }}>
      <div style={{ fontSize: 10.5, letterSpacing: '0.15em', color: '#888', textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontWeight: 700 }}>{name}</div>
      {addr.length > 0 && <div style={{ color: '#666', fontSize: 12 }}>{addr.join(', ')}</div>}
    </div>
  )
}
function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return <th style={{ textAlign: right ? 'right' : 'left', background: '#f3f0e8', color: '#555', fontSize: 11, padding: '6px 8px', borderBottom: '1px solid #ddd', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{children}</th>
}
function Td({ children, right, bold, colSpan, style }: { children: React.ReactNode; right?: boolean; bold?: boolean; colSpan?: number; style?: React.CSSProperties }) {
  return <td colSpan={colSpan} style={{ textAlign: right ? 'right' : 'left', padding: '6px 8px', borderBottom: '1px solid #eee', fontWeight: bold ? 700 : 400, ...style }}>{children}</td>
}
function Sig({ label }: { label: string }) {
  return (
    <div style={{ flex: 1 }}>
      <div style={{ borderTop: '1px solid #444', marginTop: 32, paddingTop: 4, textAlign: 'center', fontSize: 11, color: '#555' }}>{label}</div>
    </div>
  )
}
```

> NOTE on the "Untuk" block: surat jalan only carries the SENDER letterhead per spec decision #3. The dest name is shown, but its address is not (we don't ship `dest` location overrides to the surat jalan). That matches "letterhead = sender" — verify with the user if this feels too sparse; if the dest address would help the courier, we can ship `receiverLetterhead` as an inline block too (the data is already available on the DTO from Task A6). **Flag in the implementation PR.**

- [ ] **Step 4: Run tests to verify they pass**

```bash
corepack pnpm --filter @mandalika/backoffice test -- SuratJalanDoc
# Expected: PASS
```

- [ ] **Step 5: Commit**

```bash
git add apps/backoffice/src/screens/transfers/docs/
git commit -m "feat(backoffice): SuratJalanDoc pure component (L2 layout) + render test"
```

---

### Task C2 — `render.ts`: HTML → PNG → PDF + Web-Share-with-fallback

**Files:**
- Create: `apps/backoffice/src/screens/transfers/docs/render.ts`
- Create: `apps/backoffice/src/screens/transfers/docs/render.test.ts`

- [ ] **Step 1: Write the failing test (fallback path)**

```ts
// render.test.ts
import { describe, it, expect, vi } from 'vitest'
import { shareSuratJalan } from './render'

describe('shareSuratJalan', () => {
  it('falls back to anchor-download when navigator.share is unavailable', async () => {
    // jsdom default: no navigator.share
    const blob = new Blob(['fake'], { type: 'image/png' })
    const click = vi.fn()
    const a: any = { click, set href(_: string){}, set download(_: string){} }
    vi.spyOn(document, 'createElement').mockReturnValueOnce(a)
    await shareSuratJalan(blob, 'sj.png')
    expect(click).toHaveBeenCalledOnce()
  })

  it('calls navigator.share when canShare returns true', async () => {
    const share = vi.fn().mockResolvedValue(undefined)
    ;(navigator as any).share = share
    ;(navigator as any).canShare = () => true
    const blob = new Blob(['x'], { type: 'image/png' })
    await shareSuratJalan(blob, 'sj.png')
    expect(share).toHaveBeenCalledOnce()
  })
})
```

- [ ] **Step 2: Run to fail**

```bash
corepack pnpm --filter @mandalika/backoffice test -- render
# Expected: cannot find module
```

- [ ] **Step 3: Implement `render.ts`**

```ts
// apps/backoffice/src/screens/transfers/docs/render.ts
import { toPng } from 'html-to-image'
import jsPDF from 'jspdf'

/**
 * Render a DOM node to a PNG blob. The node should be the off-screen-mounted
 * <SuratJalanDoc/> root. Width/height are read from the node's bounding rect.
 */
export async function renderNodeToPng(node: HTMLElement): Promise<Blob> {
  const dataUrl = await toPng(node, {
    cacheBust: true,
    pixelRatio: 2,
    backgroundColor: '#ffffff',
  })
  const r = await fetch(dataUrl)
  return await r.blob()
}

/**
 * Wrap a PNG blob into a single-page A4 PDF (portrait). Scaling preserves the
 * 794×1123 source from <SuratJalanDoc/>.
 */
export async function pngBlobToPdf(png: Blob, filename: string): Promise<Blob> {
  const dataUrl = await blobToDataUrl(png)
  const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' })
  // A4 = 210 × 297 mm. Image fills the page with 0 margin (the React doc has its own padding).
  pdf.addImage(dataUrl, 'PNG', 0, 0, 210, 297, undefined, 'FAST')
  return pdf.output('blob')
}

function blobToDataUrl(b: Blob): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader()
    r.onload = () => res(r.result as string)
    r.onerror = () => rej(r.error)
    r.readAsDataURL(b)
  })
}

/**
 * Open the OS share-sheet with the PNG file. Falls back to triggering a
 * download anchor when the Web Share API isn't supported (e.g. desktop Firefox).
 * Callers should show a small toast on the fallback path.
 */
export async function shareSuratJalan(png: Blob, filename: string): Promise<'shared' | 'downloaded'> {
  const file = new File([png], filename, { type: 'image/png' })
  const nav = navigator as any
  if (typeof nav.share === 'function' && typeof nav.canShare === 'function' && nav.canShare({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: filename })
      return 'shared'
    } catch (err) {
      // user aborted — don't fall back, just return
      return 'shared'
    }
  }
  triggerDownload(png, filename)
  return 'downloaded'
}

/** Force a file download via a transient anchor. */
export function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
corepack pnpm --filter @mandalika/backoffice test -- render
# Expected: PASS both cases
```

- [ ] **Step 5: Commit**

```bash
git add apps/backoffice/src/screens/transfers/docs/render.ts apps/backoffice/src/screens/transfers/docs/render.test.ts
git commit -m "feat(backoffice): render — html-to-image + jsPDF + Web Share with anchor fallback"
```

---

### Task C3 — Inline `SuratJalanPanel.tsx` mounted into `TransferDetail`

**Files:**
- Create: `apps/backoffice/src/screens/transfers/SuratJalanPanel.tsx`
- Modify: `apps/backoffice/src/screens/transfers/Transfers.tsx` (TransferDetail)

- [ ] **Step 1: Write the panel**

```tsx
// apps/backoffice/src/screens/transfers/SuratJalanPanel.tsx
import { useRef, useState } from 'react'
import { Share2, Download, FileText, Eye } from 'lucide-react'
import type { Transfer } from '@mandalika/api'
import { Card, Button, Modal } from '../../ui'
import { SuratJalanDoc } from './docs/SuratJalanDoc'
import { renderNodeToPng, pngBlobToPdf, shareSuratJalan, triggerDownload } from './docs/render'
import { useToast } from '../../hooks/useToast'   // existing toast hook; verify name via grep

interface Props { transfer: Transfer }

export function SuratJalanPanel({ transfer }: Props) {
  const docRef = useRef<HTMLDivElement>(null)
  const [busy, setBusy] = useState(false)
  const [showPreview, setShowPreview] = useState(false)
  const toast = useToast()

  if (!transfer.suratJalanNo) return null  // only when status ∈ {in_transit, completed}

  const baseName = `suratjalan-${transfer.suratJalanNo}`

  const withDoc = async <T,>(fn: (node: HTMLElement) => Promise<T>): Promise<T> => {
    if (!docRef.current) throw new Error('doc not mounted')
    return fn(docRef.current)
  }

  const onShare = async () => {
    setBusy(true)
    try {
      const png = await withDoc(renderNodeToPng)
      const r = await shareSuratJalan(png, `${baseName}.png`)
      if (r === 'downloaded') toast('Share API tidak tersedia — file diunduh, bagikan manual.')
    } finally { setBusy(false) }
  }
  const onPdf = async () => {
    setBusy(true)
    try {
      const png = await withDoc(renderNodeToPng)
      const pdf = await pngBlobToPdf(png, `${baseName}.pdf`)
      triggerDownload(pdf, `${baseName}.pdf`)
    } finally { setBusy(false) }
  }
  const onPng = async () => {
    setBusy(true)
    try {
      const png = await withDoc(renderNodeToPng)
      triggerDownload(png, `${baseName}.png`)
    } finally { setBusy(false) }
  }

  return (
    <>
      <Card className="p-4 bg-gold-50 border border-gold-200">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="font-bold">Surat jalan siap.</div>
            <div className="text-sm text-gray-600">No. {transfer.suratJalanNo}</div>
          </div>
          <div className="flex gap-2">
            <Button onClick={onShare} loading={busy} icon={<Share2 className="w-4 h-4" />}>Bagikan</Button>
            <Button variant="secondary" onClick={onPdf} icon={<FileText className="w-4 h-4" />}>Unduh PDF</Button>
            <Button variant="secondary" onClick={onPng} icon={<Download className="w-4 h-4" />}>Unduh PNG</Button>
            <Button variant="secondary" onClick={() => setShowPreview(true)} icon={<Eye className="w-4 h-4" />}>Lihat</Button>
          </div>
        </div>
      </Card>

      {/* Off-screen, mounted permanently so refs are stable. -9999px keeps it
          off-flow without display:none (which html-to-image can't measure). */}
      <div style={{ position: 'fixed', left: -9999, top: 0, pointerEvents: 'none' }} aria-hidden="true">
        <div ref={docRef}><SuratJalanDoc transfer={transfer} /></div>
      </div>

      {showPreview && (
        <Modal onClose={() => setShowPreview(false)} title={`Pratinjau · ${transfer.suratJalanNo}`} wide>
          <div style={{ transform: 'scale(0.85)', transformOrigin: 'top center' }}>
            <SuratJalanDoc transfer={transfer} />
          </div>
        </Modal>
      )}
    </>
  )
}
```

If `Modal` doesn't accept `wide` or the import paths differ, mirror what other backoffice screens do (the existing per-outlet edit modal is a reference).

- [ ] **Step 2: Mount in `TransferDetail`**

Find `apps/backoffice/src/screens/transfers/Transfers.tsx`, in the `TransferDetail` function. Below the `<PageHeader …/>` and above the existing `<Card className="p-5">`:

```tsx
import { SuratJalanPanel } from './SuratJalanPanel'

// …inside TransferDetail JSX, immediately after PageHeader:
{t.suratJalanNo && <SuratJalanPanel transfer={t} />}
```

- [ ] **Step 3: Manual verification after deploy**

In the live backoffice, send a transfer → confirm panel appears → click Bagikan in a mobile browser → confirm OS share-sheet opens with the PNG attached. Click Unduh PDF → verify file downloads and opens correctly.

- [ ] **Step 4: Commit**

```bash
git add apps/backoffice/src/screens/transfers/
git commit -m "feat(backoffice): SuratJalanPanel inline + mounted in TransferDetail"
```

---

## Phase D — POS tanda terima & auto-prompt

> Goal of phase D: the POS thermal-prints a clean 32-col tanda terima with the receiver letterhead immediately after a server-acknowledged receive, and a persistent reprint button stays on the completed transfer detail.

### Task D1 — `buildTandaTerima` ESC/POS builder + Vitest snapshot

**Files:**
- Modify: `packages/printer/src/escpos.ts` (add `TandaTerimaData`, `TandaTerimaLine`, `buildTandaTerima`)
- Modify: `packages/printer/src/index.ts` (re-export)
- Create: `packages/printer/src/escpos.tanda-terima.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/printer/src/escpos.tanda-terima.test.ts
import { describe, it, expect } from 'vitest'
import { buildTandaTerima, type TandaTerimaData } from './escpos'

const fix: TandaTerimaData = {
  tandaTerimaNo: 'TT-2026-00001',
  transferNo: 'TRF-00005',
  receivedAt: new Date('2026-05-26T07:45:00Z'),
  receiverHeaderLines: ['MANDALIKA PMS', 'Jl. Sunset Road 88, Kuta'],
  senderName: 'Gudang Pusat',
  items: [
    { productName: 'Parfum Bunga', variant: '50ml',  sentQty: 10, receivedQty: 10, difference: 0 },
    { productName: 'Parfum Kayu',  variant: '100ml', sentQty: 5,  receivedQty: 4,  difference: -1 },
  ],
  discrepancyReason: 'Barang rusak 1 pc',
  receivedByName: 'Kasir Ani',
}
const settings = { headerText: '', footerText: '' } as any

describe('buildTandaTerima', () => {
  it('produces a 32-col layout with K/T/S columns and discrepancy reason', () => {
    const bytes = buildTandaTerima(fix, settings)
    const text = new TextDecoder('latin1').decode(bytes)
    expect(text).toContain('MANDALIKA PMS')
    expect(text).toContain('TANDA TERIMA')
    expect(text).toContain('TT-2026-00001')
    expect(text).toContain('TRF-00005')
    expect(text).toContain('Dari')
    expect(text).toContain('Gudang Pusat')
    expect(text).toContain('Krm')
    expect(text).toContain('Trm')
    expect(text).toContain('Sel')
    expect(text).toContain('Parfum Bunga')
    expect(text).toContain('Selisih')
    expect(text).toContain('Barang rusak 1 pc')
    expect(text).toContain('Kasir Ani')
  })

  it('omits the Selisih block when discrepancyReason is null', () => {
    const noDiff = { ...fix, discrepancyReason: null,
      items: fix.items.map((i) => ({ ...i, receivedQty: i.sentQty, difference: 0 })) }
    const text = new TextDecoder('latin1').decode(buildTandaTerima(noDiff, settings))
    expect(text).not.toContain('Selisih')
  })

  it('renders the K/T/S header line at exactly 32 chars', () => {
    const text = new TextDecoder('latin1').decode(buildTandaTerima(fix, settings))
    // header line: 19 spaces + "Krm" + "  " + "Trm" + "  " + "Sel" = 32
    expect(text).toContain(' '.repeat(19) + 'Krm' + '  ' + 'Trm' + '  ' + 'Sel')
  })
})
```

- [ ] **Step 2: Run to fail**

```bash
corepack pnpm --filter @mandalika/printer test -- tanda-terima
# Expected: cannot find buildTandaTerima
```

- [ ] **Step 3: Implement `buildTandaTerima` in `escpos.ts`**

Add at the bottom of `escpos.ts`, after `buildRecap`:

```ts
// ── Tanda terima slip (SP4) ──────────────────────────────

export interface TandaTerimaLine {
  productName: string
  variant: string
  sentQty: number
  receivedQty: number
  difference: number   // receivedQty - sentQty
}

export interface TandaTerimaData {
  tandaTerimaNo: string         // 'TT-2026-00001'
  transferNo: string            // 'TRF-00005'
  receivedAt: Date
  /** Resolved letterhead lines (brand or receiver-override) — first line is the
   *  name, the rest is address/phone, all centered + normal weight. */
  receiverHeaderLines: string[]
  senderName: string
  items: TandaTerimaLine[]
  discrepancyReason: string | null
  receivedByName: string
}

/** Build the ESC/POS payload for a tanda terima (one copy). */
export function buildTandaTerima(
  data: TandaTerimaData,
  settings: ReceiptSettings,
): Uint8Array {
  const b = new Buf().raw(INIT)
  const dt = (d: Date) =>
    d.toLocaleString('id-ID', {
      day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit',
    })

  // Letterhead (centered). First non-empty line bold; rest normal.
  const head = data.receiverHeaderLines.filter((l) => l && l.trim().length > 0)
  if (head.length > 0) {
    b.raw(ALIGN_CENTER)
    b.raw(BOLD_ON).line(head[0].slice(0, COLS)).raw(BOLD_OFF)
    for (const l of head.slice(1)) b.line(l.slice(0, COLS))
  }
  b.divider()
  b.raw(BOLD_ON).line(center('TANDA TERIMA')).raw(BOLD_OFF)
  b.divider()
  b.raw(ALIGN_LEFT)

  b.line(pad('No', data.tandaTerimaNo))
  b.line(pad('Ref', data.transferNo))
  b.line(pad('Tgl', dt(data.receivedAt)))
  b.line(pad('Dari', data.senderName))
  b.divider()

  // K/T/S header — 19 spaces + 'Krm' + '  ' + 'Trm' + '  ' + 'Sel' = 32.
  b.line(' '.repeat(19) + 'Krm' + '  ' + 'Trm' + '  ' + 'Sel')

  for (const it of data.items) {
    b.line(it.productName.slice(0, COLS))
    // '  ' (indent 2) + variant.padEnd(17) + krm(3) + '  ' + trm(3) + '  ' + sel(3) = 32
    const krm = String(it.sentQty).padStart(3)
    const trm = String(it.receivedQty).padStart(3)
    const sel = (it.difference > 0 ? '+' : '') + String(it.difference)
    b.line('  ' + it.variant.padEnd(17).slice(0, 17) + krm + '  ' + trm + '  ' + sel.padStart(3))
  }
  b.divider()

  if (data.discrepancyReason && data.discrepancyReason.trim().length > 0) {
    b.line('Selisih: ' + data.discrepancyReason)
    b.divider()
  }

  b.line('Diterima oleh: ' + data.receivedByName)
  b.line()
  b.line()
  b.line('_'.repeat(COLS))
  b.line(center('Tanda Tangan'))
  b.line()

  b.raw(ALIGN_CENTER).line('Dicetak ' + dt(new Date()))
  if (settings.footerText) b.line().line(settings.footerText.slice(0, COLS))
  b.raw(ALIGN_LEFT).raw(FEED_3).raw(CUT)
  return b.done()
}
```

- [ ] **Step 4: Re-export from `index.ts`**

```ts
export { buildReceipt, buildRecap, buildTandaTerima, COLS } from './escpos'
export type { ReceiptData, ReceiptLine, RecapData, RecapMethodRow,
              TandaTerimaData, TandaTerimaLine } from './escpos'
```

- [ ] **Step 5: Run to pass**

```bash
corepack pnpm --filter @mandalika/printer test
# Expected: PASS all 3 cases
```

- [ ] **Step 6: Commit**

```bash
git add packages/printer/src/escpos.ts packages/printer/src/escpos.tanda-terima.test.ts packages/printer/src/index.ts
git commit -m "feat(printer): buildTandaTerima ESC/POS builder with K/T/S layout + tests"
```

---

### Task D2 — `printTandaTerima` job + `PrinterProvider` wiring

**Files:**
- Modify: `packages/printer/src/print.ts`
- Modify: `packages/printer/src/index.ts`
- Modify: `apps/pos/src/printer.tsx`

- [ ] **Step 1: Add `printTandaTerima` to `print.ts`**

Append, mirroring `printRecap`:

```ts
import { buildReceipt, buildRecap, buildTandaTerima,
         type ReceiptData, type RecapData, type TandaTerimaData } from './escpos'

// …existing PrintJob + printReceipt + RecapJob + printRecap unchanged…

export interface TandaTerimaJob {
  transport: PrinterTransport
  deviceId: string | null
  data: TandaTerimaData
  settings: ReceiptSettings
}

/** Connect if needed and print a single tanda terima slip. Throws on failure. */
export async function printTandaTerima(job: TandaTerimaJob): Promise<void> {
  if (!job.deviceId) throw new Error('Printer belum dipilih')
  const payload = buildTandaTerima(job.data, job.settings)
  await job.transport.connect(job.deviceId)
  try {
    await job.transport.write(payload)
  } finally {
    await job.transport.disconnect().catch(() => {})
  }
}
```

- [ ] **Step 2: Re-export**

```ts
// packages/printer/src/index.ts
export { createTransport, printReceipt, printRecap, printTandaTerima } from './print'
export type { PrintJob, RecapJob, TandaTerimaJob } from './print'
```

- [ ] **Step 3: Extend `PrinterProvider`**

In `apps/pos/src/printer.tsx`, add to the imports:

```ts
import {
  createTransport, printReceipt, printRecap, printTandaTerima,
  type PrinterTransport, type ReceiptData, type RecapData, type TandaTerimaData,
} from '@mandalika/printer'
```

Extend `PrinterState`:

```ts
printTandaTerima: (data: TandaTerimaData, settings: ReceiptSettings) => Promise<void>
```

Add the implementation alongside `doPrintRecap`:

```ts
const doPrintTandaTerima = useCallback(
  async (data: TandaTerimaData, settings: ReceiptSettings) => {
    await printTandaTerima({
      transport: transportRef.current,
      deviceId: pairedId,
      data,
      settings,
    })
  },
  [pairedId],
)
```

…and include it in the memoized value.

- [ ] **Step 4: Typecheck**

```bash
corepack pnpm --filter @mandalika/pos exec tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add packages/printer/src/print.ts packages/printer/src/index.ts apps/pos/src/printer.tsx
git commit -m "feat(printer): printTandaTerima job + PrinterProvider context method"
```

---

### Task D3 — `TandaTerimaPrompt` modal + trigger wiring + reprint button

**Files:**
- Create: `apps/pos/src/cashier/transfers/TandaTerimaPrompt.tsx`
- Create: `apps/pos/src/cashier/transfers/buildTandaTerimaData.ts` (pure mapper, easy to test)
- Create: `apps/pos/src/cashier/transfers/buildTandaTerimaData.test.ts`
- Modify: wherever the existing inbound-list / receive flow lives (find via `grep -rn "Terima Transfer\|inboundTransfers\|onReceiveRejected" apps/pos/src/`)
- Modify: `apps/pos/src/cashier/SyncProvider.tsx` — wire `onReceiveAccepted` into a React state piece that the prompt consumes

- [ ] **Step 1: Write the failing mapper test**

```ts
// buildTandaTerimaData.test.ts
import { describe, it, expect } from 'vitest'
import type { Transfer } from '@mandalika/api'
import { buildTandaTerimaData } from './buildTandaTerimaData'

const t: Transfer = {
  id: 't1', transferNo: 'TRF-00005',
  suratJalanNo: 'SJ-2026-00001', tandaTerimaNo: 'TT-2026-00001',
  status: 'completed',
  source: { kind: 'warehouse', id: 'w', name: 'Gudang Pusat' },
  dest:   { kind: 'outlet',    id: 'o', name: 'Mandalika PMS' },
  receiverLetterhead: {
    locationName: 'Mandalika PMS', brandName: 'Mandalika POS',
    addressLines: ['Jl. Sunset 88'], phone: '0812', npwp: null, logoUrl: null,
  },
  items: [
    { productId: 'p', productName: 'Parfum', variantSize: '50ml', sku: 'S', sentQty: 10, receivedQty: 8, difference: -2 },
  ],
  discrepancyReason: 'rusak', receivedAt: '2026-05-26T07:45:00Z',
  createdAt: '2026-05-26T07:30:00Z',
} as any

describe('buildTandaTerimaData', () => {
  it('maps Transfer + receivedByName → TandaTerimaData with K/T/S items', () => {
    const d = buildTandaTerimaData(t, 'Kasir Ani')
    expect(d.tandaTerimaNo).toBe('TT-2026-00001')
    expect(d.transferNo).toBe('TRF-00005')
    expect(d.senderName).toBe('Gudang Pusat')
    expect(d.items[0]).toEqual({ productName: 'Parfum', variant: '50ml', sentQty: 10, receivedQty: 8, difference: -2 })
    expect(d.discrepancyReason).toBe('rusak')
    expect(d.receivedByName).toBe('Kasir Ani')
    expect(d.receiverHeaderLines.length).toBeGreaterThanOrEqual(2)
  })

  it('falls back to brand name when location override is absent', () => {
    const t2 = { ...t, receiverLetterhead: { ...t.receiverLetterhead, brandName: null } } as any
    const d = buildTandaTerimaData(t2, 'X')
    expect(d.receiverHeaderLines[0]).toBe('Mandalika PMS')   // locationName fallback
  })
})
```

- [ ] **Step 2: Implement the mapper**

```ts
// apps/pos/src/cashier/transfers/buildTandaTerimaData.ts
import type { Transfer } from '@mandalika/api'
import type { TandaTerimaData } from '@mandalika/printer'

export function buildTandaTerimaData(t: Transfer, receivedByName: string): TandaTerimaData {
  const lh = t.receiverLetterhead
  const head: string[] = []
  head.push(lh?.brandName ?? lh?.locationName ?? t.dest.name)
  for (const a of lh?.addressLines ?? []) if (a && a.trim()) head.push(a)
  if (lh?.phone) head.push(lh.phone)

  return {
    tandaTerimaNo: t.tandaTerimaNo ?? '',
    transferNo:    t.transferNo,
    receivedAt:    new Date(t.receivedAt ?? Date.now()),
    receiverHeaderLines: head,
    senderName:    t.source.name,
    items: t.items.map((it) => ({
      productName: it.productName,
      variant:     it.variantSize,
      sentQty:     it.sentQty,
      receivedQty: it.receivedQty ?? it.sentQty,
      difference:  it.difference ?? 0,
    })),
    discrepancyReason: t.discrepancyReason?.trim() ? t.discrepancyReason : null,
    receivedByName,
  }
}
```

- [ ] **Step 3: Run mapper tests**

```bash
corepack pnpm --filter @mandalika/pos test -- buildTandaTerimaData
# Expected: PASS
```

- [ ] **Step 4: Implement the prompt modal**

```tsx
// apps/pos/src/cashier/transfers/TandaTerimaPrompt.tsx
import { useState } from 'react'
import type { Transfer } from '@mandalika/api'
import { usePrinter } from '../../printer'
import { useAuth } from '../../auth'
import { useReceiptSettings } from '../../settings'    // verify hook name via grep
import { buildTandaTerimaData } from './buildTandaTerimaData'

interface Props { transfer: Transfer; onClose: () => void }

export function TandaTerimaPrompt({ transfer, onClose }: Props) {
  const printer = usePrinter()
  const auth = useAuth()
  const settings = useReceiptSettings()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const onPrint = async () => {
    setBusy(true); setErr(null)
    try {
      const data = buildTandaTerimaData(transfer, auth.user?.name ?? 'Kasir')
      await printer.printTandaTerima(data, settings)
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Cetak gagal')
    } finally { setBusy(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40">
      <div className="bg-white rounded-t-2xl sm:rounded-2xl p-5 w-full sm:max-w-sm shadow-xl">
        <div className="text-lg font-bold">Tanda terima siap</div>
        <div className="text-sm text-gray-500 mt-1">{transfer.tandaTerimaNo} · dari {transfer.source.name}</div>
        {err && <div className="text-sm text-red-600 mt-2">{err}</div>}
        {!printer.isPaired && (
          <div className="text-xs text-amber-600 mt-2">Pasangkan printer di Pengaturan untuk cetak.</div>
        )}
        <div className="flex gap-2 mt-4">
          <button className="flex-1 px-4 py-3 rounded-xl bg-gold-600 text-white font-bold disabled:opacity-50"
                  disabled={!printer.isPaired || busy} onClick={onPrint}>
            {busy ? 'Mencetak…' : 'Cetak'}
          </button>
          <button className="px-4 py-3 rounded-xl border" onClick={onClose}>Lewati</button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 5: Wire `onReceiveAccepted` → push the prompt**

Find where the SyncProvider is configured (the existing `SyncProvider.tsx`). It already wires `onReceiveRejected`. Mirror the pattern: hold a small state piece `pendingTandaTerima: Transfer | null`, set it directly from the callback (the engine ships the full `Transfer` snapshot — see Task A9):

```tsx
// inside SyncProvider.tsx (or a sibling component that hosts the modal)
const [pendingTT, setPendingTT] = useState<Transfer | null>(null)

// when constructing the engine:
const engine = useMemo(() => createEngine({
  // …existing events…
  onReceiveAccepted: (transfer) => setPendingTT(transfer),
}), [/* deps */])

// …render at the root of the cashier shell:
{pendingTT && <TandaTerimaPrompt transfer={pendingTT} onClose={() => setPendingTT(null)} />}
```

No second roundtrip — the engine's `onReceiveAccepted(transfer: Transfer)` callback already carries the completed snapshot with `tandaTerimaNo` and resolved `receiverLetterhead`.

- [ ] **Step 6: Add a persistent "Cetak Ulang" button to the completed transfer detail**

Find the POS-side transfer detail screen. Add (visible only when `transfer.tandaTerimaNo` and `status === 'completed'`):

```tsx
<button onClick={() => setPendingTT(transfer)}>Cetak Ulang Tanda Terima</button>
```

Reuse the same prompt component (it accepts any Transfer).

- [ ] **Step 7: Manual verification on device (after APK build)**

- Receive a transfer → on server-ack, modal pops with TT no + sender name.
- Click Cetak (with paired printer) → slip prints.
- Click Lewati → modal closes; reprint button appears on completed detail.
- Trigger an FU-2 (force-receive collision) → onReceiveRejected fires the existing toast; **no** Tanda Terima modal appears (mediated by acking only on `'ok'`).

- [ ] **Step 8: Commit**

```bash
git add apps/pos/src/cashier/transfers/ apps/pos/src/cashier/SyncProvider.tsx
git commit -m "feat(pos): tanda terima prompt + onReceiveAccepted wiring + reprint button"
```

---

## Phase E — Deploy, APK, E2E, handoff

### Task E1 — Backoffice push (auto-deploys via Cloudflare)

- [ ] **Step 1:** `git push origin prod-hardening`. Cloudflare Pages auto-deploys.
- [ ] **Step 2:** Run the manual smokes from B2, B3, C3 against the live URL.
- [ ] **Step 3:** Commit-empty a note with the timestamp Cloudflare reported.

### Task E2 — Dispatch & verify signed APK

```bash
TOKEN=$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill 2>/dev/null | sed -n 's/^password=//p')
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/Epheyy/mandalika-pos/actions/workflows/android-release.yml/dispatches \
  -d '{"ref":"prod-hardening","inputs":{"api_url":"https://mandalika-pos-538849926142.asia-southeast2.run.app"}}'
```

Poll the run; download the artifact; install; verify D3 Step 7 on device.

### Task E3 — Update `SESSION_HANDOFF.md`

Promote SP4 from "NEXT" to "DONE", record the new backend rev and any open follow-ups (e.g. on-device verify items, dest-letterhead inclusion question from C1 Step 3). Keep the existing SP3 on-device-retest item — that's still pending and orthogonal.

```bash
git add SESSION_HANDOFF.md
git commit -m "docs: SP4 (transfer documents) DONE; SP3 on-device re-test still pending"
git push
```

### Task E4 — Memory hygiene

If anything in `~/.claude/projects/.../memory/MEMORY.md` references SP4 as "next" — update it to "done". Add a one-line memory if a new pattern was learned worth carrying forward.

---

## Files at a glance

**Backend (Go)**
- `backend/internal/db/migrations/0018_transfer_documents.sql` (new)
- `backend/internal/write/doc_sequences.go` + `_test.go` (new)
- `backend/internal/write/transfer.go` (modified: SJ/TT assignment)
- `backend/internal/write/transfer_test.go` (modified: SJ/TT tests)
- `backend/internal/read/repo.go` (modified: transferObj + transferFrom; AppSettings docs block; warehouse/outlet override)
- `backend/internal/read/repo_test.go` (modified: letterhead read-back)
- `backend/internal/write/repo.go` (modified: app_settings.documents write)
- `backend/internal/write/warehouse.go` + outlet write path (modified: override fields)
- `backend/internal/sync/sync.go` (modified: ack ships TandaTerimaNo / optionally Transfer)
- `backend/api/openapi.yaml` (modified: Letterhead, DocumentSettings, doc-number fields, ack field)

**Sync engine**
- `packages/sync/src/engine.ts` (modified: onReceiveAccepted event)
- `packages/sync/src/engine.receive-accepted.test.ts` (new)

**Printer**
- `packages/printer/src/escpos.ts` (modified: buildTandaTerima + types)
- `packages/printer/src/escpos.tanda-terima.test.ts` (new)
- `packages/printer/src/print.ts` (modified: printTandaTerima + TandaTerimaJob)
- `packages/printer/src/index.ts` (modified: re-exports)

**Backoffice**
- `apps/backoffice/package.json` (modified: html-to-image + jspdf)
- `apps/backoffice/src/screens/Settings.tsx` (modified: Dokumen section)
- `apps/backoffice/src/screens/warehouses/...` (modified: override fields)
- `apps/backoffice/src/screens/Outlets.tsx` (modified: override fields)
- `apps/backoffice/src/screens/transfers/docs/SuratJalanDoc.tsx` (new) + test (new)
- `apps/backoffice/src/screens/transfers/docs/render.ts` (new) + test (new)
- `apps/backoffice/src/screens/transfers/SuratJalanPanel.tsx` (new)
- `apps/backoffice/src/screens/transfers/Transfers.tsx` (modified: mount panel)

**POS**
- `apps/pos/src/printer.tsx` (modified: printTandaTerima context method)
- `apps/pos/src/cashier/transfers/buildTandaTerimaData.ts` + `_test.ts` (new)
- `apps/pos/src/cashier/transfers/TandaTerimaPrompt.tsx` (new)
- `apps/pos/src/cashier/SyncProvider.tsx` (modified: onReceiveAccepted wiring)
- POS-side completed-transfer detail (modified: reprint button)

---

## Acceptance criteria (from spec)

Each task or task group implements one or more of the spec's AC1–AC9. The agent should mentally tick them off:

- **AC1** Backoffice edits brand block + per-location overrides → **B2 + B3**.
- **AC2** Send → SuratJalanPanel appears → Bagikan / Unduh PDF / Unduh PNG / Lihat → **C1 + C2 + C3** (Web Share fallback covered).
- **AC3** Re-open completed transfer → panel still works → **C3** (panel persists by checking `suratJalanNo` only).
- **AC4** POS receive → prompt appears on server-ack → **D3** + **A9**.
- **AC5** Thermal slip content correct → **D1** (golden test).
- **AC6** Reprint via persistent button → **D3 Step 6**.
- **AC7** SJ/TT assigned exactly once, per-year, no duplicates → **A2 + A3 + A4** (test).
- **AC8** Cancellation never assigns → SJ at send sticks on cancelled-in-transit → covered implicitly (cancel doesn't call `nextDocNo`); add an explicit test in A3 if you want belt + braces.
- **AC9** No new endpoint/perm → respected throughout.
